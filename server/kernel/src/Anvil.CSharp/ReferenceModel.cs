using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal enum RuntimeCategory { Value, NativeBuffer, ObjectReference, ListReference, ExceptionReference, TextReference, InlineValue, DelegateReference, ReadOnlyListReference }
internal sealed record ReferenceLayout(string Handle, string Cell, string Arena, ValueType Value);

/// <summary>Typed invocation-local memory, separate from DTO transport and entity storage.
/// Only call components with observable reference effects opt into this first vertical.</summary>
internal sealed partial class ReferenceModel
{
    private readonly SourceProgram program;
    private readonly DataModel data;
    private readonly HashSet<IMethodSymbol> managed = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<IMethodSymbol, ReferenceBoundary> boundaries = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<IMethodSymbol, string> names = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<string, ReferenceLayout> layouts = new(StringComparer.Ordinal);
    private readonly Dictionary<ITypeSymbol, string> inlineLayouts = new(SymbolEqualityComparer.Default);
    private readonly SortedDictionary<string, string> thrown = new(StringComparer.Ordinal);
    private readonly JsonArray arenas = [];
    private readonly JsonArray completionFields = [];
    internal bool GraphBoundaries { get; }
    internal string ContextType { get; }
    internal string CompletionType { get; }
    internal string ExceptionType { get; }
    internal IReadOnlyDictionary<string, string> Thrown => thrown;

    internal ReferenceModel(SourceProgram program, DataModel data, IEnumerable<MethodDeclaration> declarations, bool graphBoundaries = false)
    {
        this.program = program; this.data = data; GraphBoundaries = graphBoundaries;
        var methods = declarations.ToArray();
        var edges = new List<(IMethodSymbol Caller, IMethodSymbol Callee)>();
        foreach (var method in methods)
        {
            // Inventory signatures independently of effects; codec planning does not select the legacy ABI.
            var boundary = ReferenceBoundary.Analyze(method.Symbol);
            boundaries.Add(method.Symbol, boundary);
            if (!graphBoundaries && boundary.IsPublicEntry && boundary.Types.Any(type => ExceptionTypes.IsException(type.Symbol, program.Compilation)))
                throw SourceProgram.Error("AVCS347", "Exception identities in public inputs/results or their state require a complete source boundary codec", method.Symbol);
            if (boundary.IsPublicEntry && boundary.Types.Any(type => type.Symbol.TypeKind == TypeKind.Delegate))
                throw SourceProgram.Error("AVCS348", "Delegates are invocation-local compiled closures; public delegate transport is not defined", method.Symbol);
            if (boundary.Types.Any(type => ExceptionTypes.IsException(type.Symbol, program.Compilation))) managed.Add(method.Symbol);
            if (!method.Symbol.IsStatic || method.Symbol.MethodKind is MethodKind.LocalFunction or MethodKind.AnonymousFunction) managed.Add(method.Symbol);
            if (graphBoundaries && boundary.IsPublicEntry && boundary.RequiresSourceCodec) managed.Add(method.Symbol);
            var syntax = method.Symbol.DeclaringSyntaxReferences.Single().GetSyntax();
            var operation = program.Model(syntax).GetOperation(syntax);
            foreach (var node in Descendants(operation))
            {
                if (node is IInvocationOperation call && methods.Any(m => SymbolEqualityComparer.Default.Equals(m.Symbol, call.TargetMethod)))
                    edges.Add((method.Symbol, call.TargetMethod));
                if (node is IObjectCreationOperation { Type: INamedTypeSymbol constructed })
                    foreach (var initializerCall in InitializerCalls(constructed, new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default)))
                        if (methods.Any(m => SymbolEqualityComparer.Default.Equals(m.Symbol, initializerCall))) edges.Add((method.Symbol, initializerCall));
                if (NeedsReferences(node)) managed.Add(method.Symbol);
            }
        }
        // A shared context crosses the complete connected call component, including
        // scalar helpers whose throws must return earlier mutations to their caller.
        bool changed;
        do
        {
            changed = false;
            foreach (var (caller, callee) in edges)
                if (managed.Contains(caller) || managed.Contains(callee)) { changed |= managed.Add(caller); changed |= managed.Add(callee); }
        } while (changed);
        foreach (var method in methods.Where(m => managed.Contains(m.Symbol)))
        {
            var name = SymbolNames.Allocate("AvImpl_" + method.CallName,
                candidate => methods.Any(m => m.Name.Equals(candidate, StringComparison.OrdinalIgnoreCase) || m.CallName.Equals(candidate, StringComparison.OrdinalIgnoreCase))
                    || names.Values.Contains(candidate, StringComparer.OrdinalIgnoreCase));
            names.Add(method.Symbol, name);
        }
        ContextType = Unique("AvReferenceContext"); CompletionType = Unique("AvReferenceCompletion"); ExceptionType = Unique("AvReferenceException");
        if (managed.Count == 0) return;
        data.AddRuntimeStructure(Structure(ExceptionType, new JsonArray(Field("TypeName", "Text"), Field("Message", "Text"), Field("ParamName", "Text"), Field("HasParamName", "Boolean"), Field("InnerRef", "Integer"), Field("HasHResult", "Boolean"), Field("HResult", "Integer"),
            Field("HasActualValue", "Boolean"), Field("ActualValueType", "Text"), Field("ActualValueInteger", "Integer"),
            Field("ActualValueLong", "Long Integer"), Field("ActualValueText", "Text"), Field("ActualValueBoolean", "Boolean"))));
        completionFields.Add(Field("Kind", "Integer")); completionFields.Add(Field("ExceptionRef", "Integer"));
        data.AddRuntimeStructure(Structure(CompletionType, completionFields));
        arenas.Add(Field("Exceptions", ExceptionType + " List"));
        data.AddRuntimeStructure(Structure(ContextType, arenas));
    }
    internal bool UsesContext(IMethodSymbol method) => managed.Contains(method);
    internal void ControlArena(string name, string type) => arenas.Add(Field(name, type));
    internal void ControlCompletion(string name) => completionFields.Add(Field(name, "Integer"));
    internal ReferenceBoundary Boundary(IMethodSymbol method) => boundaries[method];
    internal string MethodName(MethodDeclaration method) => names.GetValueOrDefault(method.Symbol) ?? method.CallName;
    internal void Throws(string qualifiedType, string nativeType) => thrown.TryAdd(qualifiedType, nativeType);
    internal ReferenceLayout Layout(ValueType type) => layouts[type.Native];
    internal ValueType Native(string name) => new(name, false, program.Compilation.GetSpecialType(SpecialType.System_Object), Category: RuntimeCategory.NativeBuffer);

    internal ValueType Runtime(ValueType type)
    {
        // Binary Data is the persistence/legacy DTO representation. In managed C#
        // memory byte[] is an array identity, with the same alias/element semantics
        // as every other one-dimensional array.
        if (type.Native == "Binary Data" && type.Source is IArrayTypeSymbol { Rank: 1, ElementType.SpecialType: SpecialType.System_Byte } bytes)
        {
            var element = data.Type(bytes.ElementType, bytes.ElementType);
            type = type with { Native = data.Transport(element) + " List", Element = element };
        }
        if (GraphBoundaries && TemporalModel.Kind(type.Source) == TemporalKind.DateTime && type.Native == "Date Time")
            return data.TemporalType(type.Source, TemporalKind.DateTime, type.Nullable);
        if (type.Category != RuntimeCategory.Value || type.IsIdentity) return type;
        if (ReadOnlyListTypes.Is(type.Source)) return ReadOnlyRuntime(type);
        if (type.Source.IsValueType)
        {
            if (type.Declaration is { Kind: DataKind.Structure } value && ContainsReferences(value.Symbol, new HashSet<ITypeSymbol>(SymbolEqualityComparer.Default)))
            {
                if (ExceptionTypes.Contains(value.Symbol, program.Compilation) || GraphBoundaries) data.RepresentByGraph(value);
                var symbol = type.Source.WithNullableAnnotation(NullableAnnotation.NotAnnotated);
                if (!inlineLayouts.TryGetValue(symbol, out var name))
                {
                    name = Unique("AvValue_" + SymbolNames.Digest(symbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)));
                    inlineLayouts.Add(symbol, name);
                    // Reserve before member traversal: a struct can hold a class which
                    // contains another copy of that struct. Only the class has identity.
                    var inlineFields = new JsonArray(); data.AddRuntimeStructure(Structure(name, inlineFields));
                    foreach (var member in SourceMember.Of(value.Symbol))
                        inlineFields.Add(Field(value.Properties[member.Symbol], data.Transport(Runtime(data.Type(member.Type, member.Symbol)))));
                }
                return type with { Native = name, Category = RuntimeCategory.InlineValue };
            }
            return type;
        }
        if (type.Source.SpecialType == SpecialType.System_String)
            return type with { Nullable = true, Category = RuntimeCategory.TextReference };
        if (!type.IsList && type.Declaration is not { Symbol.IsReferenceType: true }) return type;
        if (!GraphBoundaries && type.Declaration is { Kind: DataKind.Entity or DataKind.Catalog })
            throw SourceProgram.Error("AVCS340", "Reference arenas do not replace entity storage; managed materialization/persistence codecs are not connected", type.Source);
        var key = type.Source.WithNullableAnnotation(NullableAnnotation.NotAnnotated).ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        var handle = Unique("AvRef_" + SymbolNames.Digest(key));
        if (layouts.TryGetValue(handle, out var known)) return ReferenceType(type, known.Handle);
        var layout = new ReferenceLayout(handle, Unique("AvCell_" + SymbolNames.Digest(key)), "Cells_" + SymbolNames.Digest(key), type);
        layouts.Add(handle, layout);
        data.AddRuntimeStructure(Structure(handle, new JsonArray(Field("Index", "Integer"))));
        var fields = new JsonArray(); data.AddRuntimeStructure(Structure(layout.Cell, fields));
        arenas.Add(Field(layout.Arena, layout.Cell + " List"));
        if (type.IsList)
        {
            fields.Add(Field("Items", data.Transport(Runtime(type.Element!)) + " List"));
            if (type.Source is not IArrayTypeSymbol)
            {
                fields.Add(Field("Version", "Integer")); fields.Add(Field("Capacity", "Integer"));
            }
        }
        else foreach (var property in SourceMember.Of(type.Declaration!.Symbol))
            fields.Add(Field(type.Declaration.Properties[property.Symbol], data.Transport(Runtime(data.Type(property.Type, property.Symbol)))));
        if (type.Declaration is { } local && ExceptionTypes.Contains(local.Symbol, program.Compilation)) data.RepresentByGraph(local);
        return ReferenceType(type, handle);
    }
    private ValueType ReferenceType(ValueType type, string handle) => type with {
        Native = handle, Nullable = false, Category = type.IsList ? RuntimeCategory.ListReference : RuntimeCategory.ObjectReference,
        Element = type.IsList ? Runtime(type.Element!) : null
    };
    private readonly Dictionary<string, string> optionalArguments = new(StringComparer.Ordinal);
    private string OptionalArgument(string valueType)
    {
        if (optionalArguments.TryGetValue(valueType, out var argument)) return argument;
        argument = Unique("AvArgument_" + SymbolNames.Digest(valueType));
        optionalArguments.Add(valueType, argument);
        // IsSpecified belongs to the call boundary; HasValue belongs to the string.
        // A default native record means omitted, never explicit null.
        var structure = Structure(argument, new JsonArray(Field("IsSpecified", "Boolean"), Field("Value", valueType)));
        structure["public"] = true;
        structure["description"] = "C# optional argument: IsSpecified distinguishes omission from an explicitly supplied value or null.";
        data.AddRuntimeStructure(structure);
        return argument;
    }
    internal JsonObject Entry(MethodDeclaration method, JsonObject implementation, MethodCompiler defaults)
    {
        if (GraphBoundaries && Boundary(method.Symbol).RequiresSourceCodec) return GraphEntry(method, implementation, defaults);
        var input = implementation["inputs"]!.AsArray().Where(p => p!["name"]!.ToString() != "AvContextIn").Select(p => p!.DeepClone()).ToArray();
        var output = implementation["outputs"]!.AsArray().Where(p => p!["name"]!.ToString() == method.Result).Select(p => p!.DeepClone()).ToArray();
        var args = new JsonObject { ["AvContextIn"] = "AvInitialContext" };
        var variables = new JsonArray(new JsonObject { ["name"] = "AvInitialContext", ["type"] = ContextType });
        var steps = new JsonArray();
        foreach (var parameter in input)
        {
            var name = parameter["name"]!.ToString();
            var source = method.Symbol.Parameters.Single(p => method.Parameter(p) == name);
            if (!source.HasExplicitDefaultValue || source.Type.SpecialType != SpecialType.System_String)
            {
                MethodCompiler.NativeParameterDefault(parameter.AsObject(), source);
                args[name] = name;
                continue;
            }
            var textType = parameter["type"]!.ToString();
            parameter["type"] = OptionalArgument(textType);
            parameter["mandatory"] = false;
            parameter.AsObject().Remove("default");
            var selected = "AvArgumentValue" + source.Ordinal;
            variables.Add(new JsonObject { ["name"] = selected, ["type"] = textType });
            var omitted = new JsonArray();
            defaults.DefaultArgument(source, selected, omitted, variables);
            steps.Add(new JsonObject { ["if"] = name + ".IsSpecified",
                ["then"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { [selected] = name + ".Value" } }),
                ["else"] = omitted });
            args[name] = selected;
        }
        steps.Add(new JsonObject { ["call"] = MethodName(method), ["as"] = "AvInvocation", ["args"] = args });
        var failed = new JsonArray();
        foreach (var (qualified, native) in thrown)
            failed.Add(new JsonObject { ["if"] = "AvInvocation.AvContextOut.Exceptions[AvInvocation.AvCompletion.ExceptionRef - 1].TypeName = " + DataModel.Constant(qualified),
                ["then"] = new JsonArray(new JsonObject { ["raise"] = native, ["message"] = "AvInvocation.AvContextOut.Exceptions[AvInvocation.AvCompletion.ExceptionRef - 1].Message" }) });
        if (failed.Count > 0) steps.Add(new JsonObject { ["if"] = "AvInvocation.AvCompletion.Kind = 2", ["then"] = failed });
        if (!method.Symbol.ReturnsVoid) steps.Add(new JsonObject { ["assign"] = new JsonObject { [method.Result] = "AvInvocation." + method.Result } });
        return new JsonObject { ["name"] = method.Name, ["inputs"] = new JsonArray(input), ["outputs"] = new JsonArray(output),
            ["vars"] = variables, ["steps"] = steps,
            ["description"] = "Generated scalar boundary for C# reference execution. Exceptions are raised after the internal context/completion returns; context outputs are not exposed by this boundary." };
    }
    private bool ContainsReferences(ITypeSymbol type, HashSet<ITypeSymbol> visited)
    {
        if (GraphBoundaries && type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } optional)
            return ContainsReferences(optional.TypeArguments[0], visited);
        if (GraphBoundaries && TemporalModel.Kind(type) == TemporalKind.DateTime) return true;
        if (type.IsReferenceType) return true;
        if (type is not INamedTypeSymbol named || !named.Locations.Any(l => l.IsInSource) || !visited.Add(type)) return false;
        return SourceMember.Of(named).Any(p => ContainsReferences(p.Type, visited));
    }
    private string Unique(string name)
    {
        return SymbolNames.Allocate(name, candidate => data.Types.Any(t => t.Name.Equals(candidate, StringComparison.OrdinalIgnoreCase)));
    }
    private static JsonObject Structure(string name, JsonArray fields) => new() { ["name"] = name, ["public"] = false,
        ["description"] = "anvil:csharp invocation-local reference representation", ["attributes"] = fields };
    private static JsonObject Field(string name, string type) => new() { ["name"] = name, ["type"] = type };
    private bool NeedsReferences(IOperation node)
    {
        if (node is IArrayCreationOperation { Initializer: null }) return true;
        if (node is ITryOperation or ILocalFunctionOperation) return true;
        if (node is IAnonymousFunctionOperation or IDelegateCreationOperation && !LogicModel.InlineQueryLambda(node)) return true;
        if (node is IVariableDeclaratorOperation variable && ExceptionTypes.Contains(variable.Symbol.Type, program.Compilation)) return true;
        if (node is not IObjectCreationOperation && ExceptionTypes.IsException(node.Type, program.Compilation))
        {
            IOperation use = node;
            while (use.Parent is IConversionOperation conversion) use = conversion;
            if (use.Parent is not IThrowOperation) return true;
        }
        if (node is IThrowOperation thrown)
        {
            var value = thrown.Exception;
            while (value is IConversionOperation conversion) value = conversion.Operand;
            if (value is not IObjectCreationOperation) return true;
        }
        if (node is IObjectCreationOperation creation && ExceptionTypes.IsException(creation.Type, program.Compilation))
        {
            IOperation use = creation;
            while (use.Parent is IConversionOperation conversion) use = conversion;
            // Preserve the established direct native-raise path when no exception value
            // escapes the throw expression; construction as a value needs shared identity.
            if (use.Parent is not IThrowOperation) return true;
        }
        if (node is IPropertyReferenceOperation { Property.Name: "Capacity" } capacity
            && capacity.Property.ContainingType.OriginalDefinition.ToDisplayString() == "System.Collections.Generic.List<T>") return true;
        if (node is IAssignmentOperation assignment && assignment.Parent is not (IObjectOrCollectionInitializerOperation or IAnonymousObjectCreationOperation) && assignment.Target is IPropertyReferenceOperation or IFieldReferenceOperation or IArrayElementReferenceOperation) return true;
        if (node is IIncrementOrDecrementOperation increment && increment.Target is IPropertyReferenceOperation or IFieldReferenceOperation or IArrayElementReferenceOperation) return true;
        if (node is IInvocationOperation call)
        {
            if (call.Parent is IObjectOrCollectionInitializerOperation) return false;
            var owner = call.TargetMethod.ContainingType;
            if (owner.Locations.Any(l => l.IsInSource)) return false;
            if (owner.SpecialType == SpecialType.System_Object && call.TargetMethod.Name == "ReferenceEquals") return true;
            if (owner.ToDisplayString() == "System.ArgumentNullException" && call.TargetMethod.Name == "ThrowIfNull") return true;
            if (owner.OriginalDefinition.ToDisplayString() == "System.Collections.Generic.List<T>" && call.TargetMethod.Name is "Add" or "Clear" or "Remove" or "RemoveAt" or "Insert") return true;
        }
        if (node is IObjectCreationOperation { Type.IsReferenceType: true } created && created.Type is INamedTypeSymbol named && named.Locations.Any(l => l.IsInSource))
            return SourceMember.Of(named).Any(p => p.Mutable || p.Initializer != null);
        return false;
    }
    private IEnumerable<IMethodSymbol> InitializerCalls(INamedTypeSymbol type, HashSet<INamedTypeSymbol> visited)
    {
        if (!type.Locations.Any(l => l.IsInSource) || !visited.Add(type)) yield break;
        foreach (var property in SourceMember.Of(type))
        {
            var expression = property.Initializer;
            if (expression == null) continue;
            foreach (var operation in Descendants(program.Model(expression).GetOperation(expression)))
            {
                if (operation is IInvocationOperation call) yield return call.TargetMethod;
                if (operation is IObjectCreationOperation { Type: INamedTypeSymbol nested })
                    foreach (var nestedCall in InitializerCalls(nested, visited)) yield return nestedCall;
            }
        }
    }
    private static IEnumerable<IOperation> Descendants(IOperation? operation)
    {
        if (operation == null) yield break;
        yield return operation;
        foreach (var child in operation.ChildOperations) foreach (var node in Descendants(child)) yield return node;
    }
}
