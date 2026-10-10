using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal abstract record Place(ValueType Type);
internal sealed record NativePlace(string Path, ValueType ValueType) : Place(ValueType);
internal sealed record ObjectFieldPlace(SourceValue Receiver, ISymbol Property, ValueType ValueType) : Place(ValueType);
internal sealed record CollectionElementPlace(SourceValue Receiver, SourceValue Index, ValueType ValueType) : Place(ValueType);

internal sealed partial class MethodCompiler
{
    private bool Managed => model.References.UsesContext(method.Symbol);
    private const string Context = "AvContext";
    private ValueType NativeType(string name) => model.References.Native(name);
    private string Arena(ValueType type) => Context + "." + model.References.Layout(type).Arena;
    private string CellPath(SourceValue value) => Arena(value.Type) + "[" + value.Text + ".Index - 1]";
    private SourceValue CaptureReference(SourceValue value, JsonArray steps) => Snapshot(value, steps);
    private void CheckReference(SourceValue value, JsonArray steps)
    {
        if (value.Type.IsReadOnlyListReference) { CheckReadOnlyReference(value, steps); return; }
        Guard(steps, value.Text + ".Index = 0", "NullReferenceException", "Object reference not set to an instance of an object.");
        Guard(steps, value.Text + ".Index < 0 or " + value.Text + ".Index > " + Arena(value.Type) + ".Length",
            "InvalidOperationException", "Reference does not belong to this invocation.");
    }
    private SourceValue ReadCell(SourceValue value, JsonArray steps)
    {
        if (value.Type.IsReadOnlyListReference) return ReadReadOnlyCell(value, steps);
        CheckReference(value, steps);
        var cell = Temp(NativeType(model.References.Layout(value.Type).Cell));
        Assign(steps, cell.Text, CellPath(value)); return cell;
    }
    private SourceValue ReadPlace(Place place, JsonArray steps)
    {
        if (place is NativePlace native) return new(native.Path, native.Type);
        if (place is ObjectFieldPlace field)
        {
            var cell = ReadCell(field.Receiver, steps);
            return new(cell.Text + "." + field.Receiver.Type.Declaration!.Properties[field.Property], field.Type);
        }
        var element = (CollectionElementPlace)place;
        var list = ReadCell(element.Receiver, steps);
        CheckIndex(element, list, steps);
        return new(list.Text + ".Items[" + element.Index.Text + "]", element.Type);
    }
    private SourceValue LoadTarget(SourceValue target, JsonArray steps) => target.Location == null ? target : ReadPlace(target.Location, steps);
    private void WritePlace(Place place, SourceValue value, JsonArray steps)
    {
        if (place is NativePlace native) { Assign(steps, native.Path, value.Text); return; }
        if (place is ObjectFieldPlace field)
        {
            // The RHS may have returned a newer context. Reload now, then replace only
            // this field, so another field/list changed by the RHS cannot be lost.
            var cell = ReadCell(field.Receiver, steps);
            Assign(steps, cell.Text + "." + field.Receiver.Type.Declaration!.Properties[field.Property], value.Text);
            Assign(steps, CellPath(field.Receiver), cell.Text); return;
        }
        var element = (CollectionElementPlace)place;
        var list = ReadCell(element.Receiver, steps); CheckIndex(element, list, steps);
        Assign(steps, list.Text + ".Items[" + element.Index.Text + "]", value.Text);
        AdvanceListVersion(element.Receiver, list, steps);
        Assign(steps, CellPath(element.Receiver), list.Text);
    }
    private void CheckIndex(CollectionElementPlace element, SourceValue cell, JsonArray steps)
    {
        var array = element.Receiver.Type.Source is IArrayTypeSymbol;
        var kind = array ? "IndexOutOfRangeException" : "ArgumentOutOfRangeException";
        var message = array ? "Index was outside the bounds of the array."
            : "Index was out of range. Must be non-negative and less than the size of the collection. (Parameter 'index')";
        var failed = new JsonArray();
        EmitReferenceThrow(failed, "System." + kind, kind, DataModel.Constant(message),
            DataModel.Constant(array ? "" : "index"), array ? "False" : "True");
        steps.Add(new JsonObject { ["if"] = element.Index.Text + " < 0 or " + element.Index.Text + " >= " + cell.Text + ".Items.Length", ["then"] = failed });
    }

    private SourceValue ReferenceTarget(IOperation operation, JsonArray steps)
    {
        if (operation is IPropertyReferenceOperation property && property.Instance != null)
        {
            var receiver = CaptureReference(Value(property.Instance, steps), steps);
            if (!receiver.Type.IsArenaReference) throw Unsupported(operation, "Mutable value-type fields require a containing Place codec");
            if (property.Property.IsIndexer)
            {
                if (!receiver.Type.IsList || property.Arguments.Length != 1) throw Unsupported(operation);
                var index = Snapshot(Value(property.Arguments[0].Value, steps), steps);
                return new("", Type(property.Type!), Location: new CollectionElementPlace(receiver, index, Type(property.Type!)));
            }
            if (receiver.Type.IsList) throw Unsupported(operation, "Collection property assignment has no typed implementation: " + property.Property.Name);
            return new("", Type(property.Type!), Location: new ObjectFieldPlace(receiver, property.Property, Type(property.Type!)));
        }
        if (operation is IFieldReferenceOperation field && field.Instance != null)
        {
            var receiver = CaptureReference(Value(field.Instance, steps), steps);
            if (!receiver.Type.IsArenaReference) throw Unsupported(operation, "Mutable value-type members require a containing Place codec");
            return new("", Type(field.Type!), Location: new ObjectFieldPlace(receiver, field.Field, Type(field.Type!)));
        }
        if (operation is IArrayElementReferenceOperation array && array.Indices.Length == 1)
        {
            var receiver = CaptureReference(Value(array.ArrayReference, steps), steps);
            var index = Snapshot(Value(array.Indices[0], steps), steps);
            if (!receiver.Type.IsArenaReference) throw Unsupported(operation, "Array storage has no reference arena codec");
            return new("", Type(array.Type!), Location: new CollectionElementPlace(receiver, index, Type(array.Type!)));
        }
        throw Unsupported(operation, "Assignment has no typed reference Place");
    }
    private SourceValue AllocateReference(ValueType type, JsonArray steps)
    {
        var reference = Temp(type); var layout = model.References.Layout(type);
        var cell = Temp(NativeType(layout.Cell));
        Assign(steps, cell.Text, StorageDefault(cell.Type));
        if (type.IsList) steps.Add(new JsonObject { ["call"] = "ListClear", ["as"] = "AvListInit" + ++calls,
            ["args"] = new JsonObject { ["List"] = cell.Text + ".Items" } });
        steps.Add(new JsonObject { ["call"] = "ListAppend", ["as"] = "AvAllocate" + ++calls,
            ["args"] = new JsonObject { ["List"] = Arena(type), ["Element"] = cell.Text } });
        Assign(steps, reference.Text + ".Index", Arena(type) + ".Length"); return reference;
    }
    private readonly HashSet<INamedTypeSymbol> activeInitializers = new(SymbolEqualityComparer.Default);
    private SourceValue ConstructReference(IObjectCreationOperation creation, ValueType type, JsonArray steps)
    {
        if (type.IsList) return ConstructReferenceCore(creation, type, steps);
        var symbol = type.Declaration!.Symbol;
        if (!activeInitializers.Add(symbol)) throw Unsupported(creation, "Recursive instance initialization requires a runtime constructor call frame");
        try { return ConstructReferenceCore(creation, type, steps); }
        finally { activeInitializers.Remove(symbol); }
    }
    private SourceValue ConstructReferenceCore(IObjectCreationOperation creation, ValueType type, JsonArray steps)
    {
        if (type.IsList)
        {
            if (creation.Arguments.Length != 0)
            {
                if (creation.Arguments.Length != 1 || creation.Arguments[0].Parameter?.Name != "collection")
                    throw Unsupported(creation, "List constructor requires an explicitly represented collection source");
                var argument = creation.Arguments[0].Value;
                while (argument is IConversionOperation { IsImplicit: true } conversion) argument = conversion.Operand;
                var source = Snapshot(Value(argument, steps), steps);
                if (!source.Type.IsArenaReference || !source.Type.IsList)
                    throw Unsupported(creation, "List copy constructor requires a represented list or array; arbitrary enumeration is not inferred");
                var absent = new JsonArray();
                EmitReferenceThrow(absent, "System.ArgumentNullException", "ArgumentNullException",
                    DataModel.Constant("Value cannot be null. (Parameter 'collection')"), DataModel.Constant("collection"), "True");
                steps.Add(new JsonObject { ["if"] = source.Text + ".Index = 0", ["then"] = absent });
                var sourceCell = ReadCell(source, steps);
                var copy = AllocateReference(type, steps);
                var copiedCell = ReadCell(copy, steps);
                steps.Add(new JsonObject { ["call"] = "ListAppendAll", ["as"] = "AvCopyList" + ++calls,
                    ["args"] = new JsonObject { ["List"] = copiedCell.Text + ".Items", ["SourceList"] = sourceCell.Text + ".Items" } });
                Assign(steps, copiedCell.Text + ".Capacity", sourceCell.Text + ".Items.Length");
                Assign(steps, CellPath(copy), copiedCell.Text);
                foreach (var initial in creation.Initializer?.Initializers ?? [])
                {
                    if (initial is not IInvocationOperation { TargetMethod.Name: "Add", Arguments.Length: 1 } add) throw Unsupported(initial);
                    AppendReferenceList(copy, Coerce(Value(add.Arguments[0].Value, steps), type.Element!, false, steps, add), steps);
                }
                return copy;
            }
            var values = new List<IOperation>();
            foreach (var initial in creation.Initializer?.Initializers ?? [])
            {
                if (initial is not IInvocationOperation { TargetMethod.Name: "Add", Arguments.Length: 1 } add) throw Unsupported(initial);
                values.Add(add.Arguments[0].Value);
            }
            return NewReferenceList(type, values, steps);
        }
        var arguments = creation.Arguments.Select(a => (Argument: a, Value: Snapshot(Value(a.Value, steps), steps))).ToArray();
        var result = AllocateReference(type, steps); var declaration = type.Declaration!;

        foreach (var (argument, value) in arguments)
        {
            var property = DataModel.Properties(declaration.Symbol).SingleOrDefault(p => p.Name == argument.Parameter!.Name)
                ?? throw Unsupported(creation, "Constructor parameter has no generated record property");
            WritePlace(new ObjectFieldPlace(result, property, Type(property.Type)), Coerce(value, Type(property.Type), false, steps, argument), steps);
        }
        // These are source initializers, executed once per allocation, not storage defaults.
        var previous = new Dictionary<IParameterSymbol, SourceValue?>(SymbolEqualityComparer.Default);
        foreach (var (argument, value) in arguments)
        {
            previous[argument.Parameter!] = boundValues.GetValueOrDefault(argument.Parameter!);
            boundValues[argument.Parameter!] = value;
        }
        try
        {
            foreach (var (property, expression) in SourceMember.Initializers(declaration.Symbol, model.Program.Compilation))
            {
                var initial = model.Program.Model(expression).GetOperation(expression) ?? throw Unsupported(creation, "Property initializer has no semantic operation");
                var value = Coerce(Value(initial, steps), Type(property.Type), false, steps, initial);
                WritePlace(new ObjectFieldPlace(result, property.Symbol, Type(property.Type)), value, steps);
            }
        }
        finally
        {
            foreach (var (parameter, value) in previous) { if (value == null) boundValues.Remove(parameter); else boundValues[parameter] = value; }
        }
        if (creation.Initializer != null) InitializeReference(result, creation.Initializer, steps);
        return result;
    }
    private void InitializeReference(SourceValue reference, IObjectOrCollectionInitializerOperation initializer, JsonArray steps)
    {
        foreach (var operation in initializer.Initializers)
        {
            if (operation is not ISimpleAssignmentOperation assignment) throw Unsupported(operation);
            var member = assignment.Target switch {
                IPropertyReferenceOperation property => new SourceMember(property.Property),
                IFieldReferenceOperation field => new SourceMember(field.Field),
                _ => throw Unsupported(operation, "Initializer requires a bound field or property")
            };
            var value = Coerce(Value(assignment.Value, steps), Type(member.Type), false, steps, assignment);
            WritePlace(new ObjectFieldPlace(reference, member.Symbol, Type(member.Type)), value, steps);
        }
    }
    private SourceValue NewReferenceList(ValueType type, IEnumerable<IOperation> values, JsonArray steps)
    {
        var result = AllocateReference(type, steps);
        foreach (var operation in values)
        {
            var value = Coerce(Value(operation, steps), type.Element!, false, steps, operation);
            AppendReferenceList(result, value, steps);
        }
        return result;
    }
    private void AppendReferenceList(SourceValue reference, SourceValue value, JsonArray steps)
    {
        var cell = ReadCell(reference, steps);
        AdvanceListVersion(reference, cell, steps);
        if (reference.Type.Source is not IArrayTypeSymbol)
        {
            Assign(steps, CellPath(reference), cell.Text);
            var grow = new JsonArray();
            Assign(grow, cell.Text + ".Capacity", "If(" + cell.Text + ".Capacity = 0, 4, If(" + cell.Text + ".Capacity > 1073741795, 2147483591, " + cell.Text + ".Capacity * 2))");
            steps.Add(new JsonObject { ["if"] = cell.Text + ".Items.Length >= " + cell.Text + ".Capacity", ["then"] = grow });
        }
        steps.Add(new JsonObject { ["call"] = "ListAppend", ["as"] = "AvReferenceAppend" + ++calls,
            ["args"] = new JsonObject { ["List"] = cell.Text + ".Items", ["Element"] = value.Text } });
        Assign(steps, CellPath(reference), cell.Text);
    }
    private static void AdvanceListVersion(SourceValue reference, SourceValue cell, JsonArray steps)
    {
        if (reference.Type.Source is IArrayTypeSymbol) return;
        var next = new JsonArray(); var wrap = new JsonArray();
        Assign(next, cell.Text + ".Version", cell.Text + ".Version + 1");
        Assign(wrap, cell.Text + ".Version", "(-2147483647 - 1)");
        steps.Add(new JsonObject { ["if"] = cell.Text + ".Version = 2147483647", ["then"] = wrap, ["else"] = next });
    }
    private SourceValue? ReferenceInvocation(IInvocationOperation invocation, JsonArray steps)
    {
        if (!Managed || model.HasMethod(invocation.TargetMethod)) return null;
        var owner = invocation.TargetMethod.ContainingType; var name = invocation.TargetMethod.Name;
        if (owner.SpecialType == SpecialType.System_Object && name == "ReferenceEquals")
        {
            var left = ReferenceArgument(invocation.Arguments[0].Value, steps);
            var saved = Snapshot(left, steps); var right = ReferenceArgument(invocation.Arguments[1].Value, steps);
            if (!saved.Type.IsArenaReference || !right.Type.IsArenaReference) throw Unsupported(invocation, "ReferenceEquals requires represented object/collection identities; text interning is not represented");
            var equal = ReferenceIdentity(saved, right, steps, invocation);
            return new("(" + equal + ")", Type(invocation.Type!));
        }
        if (owner.ToDisplayString() == "System.ArgumentNullException" && name == "ThrowIfNull")
        {
            var arguments = new Dictionary<string, SourceValue>(StringComparer.Ordinal);
            // Evaluate in source order, then bind by parameter identity, including named arguments.
            foreach (var argument in invocation.Arguments)
            {
                var evaluated = argument.Parameter!.Name == "argument" ? ReferenceArgument(argument.Value, steps) : Value(argument.Value, steps);
                arguments.Add(argument.Parameter.Name, Snapshot(evaluated, steps));
            }
            var value = arguments["argument"];
            if (!value.Type.IsArenaReference && value.Type.Category != RuntimeCategory.TextReference) throw Unsupported(invocation, "ThrowIfNull requires a represented reference presence");
            var parameter = arguments.GetValueOrDefault("paramName");
            var present = parameter == null ? "False" : Present(parameter);
            var paramName = parameter == null ? "\"\"" : "If(" + present + ", " + Payload(parameter).Text + ", \"\")";
            var message = "If((" + present + ") and Length(" + paramName + ") > 0, \"Value cannot be null. (Parameter '\" + " + paramName + " + \"')\", \"Value cannot be null.\")";
            var branch = new JsonArray(); EmitReferenceThrow(branch, "System.ArgumentNullException", "ArgumentNullException", message, paramName, present);
            steps.Add(new JsonObject { ["if"] = "not (" + Present(value) + ")", ["then"] = branch });
            return new("False", Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Boolean)));
        }
        if (invocation.Instance != null && owner.OriginalDefinition.ToDisplayString() == "System.Collections.Generic.List<T>")
        {
            var reference = CaptureReference(Value(invocation.Instance, steps), steps);
            if (!reference.Type.IsArenaReference) return null;
            if (name == "Add" && invocation.Arguments.Length == 1)
            {
                var value = Coerce(Value(invocation.Arguments[0].Value, steps), reference.Type.Element!, false, steps, invocation);
                AppendReferenceList(reference, value, steps);
            }
            else if (name == "RemoveAt" && invocation.Arguments.Length == 1)
            {
                var position = Snapshot(Value(invocation.Arguments[0].Value, steps), steps);
                var cell = ReadCell(reference, steps);
                CheckIndex(new CollectionElementPlace(reference, position, reference.Type.Element!), cell, steps);
                steps.Add(new JsonObject { ["call"] = "ListRemove", ["as"] = "AvReferenceRemove" + ++calls,
                    ["args"] = new JsonObject { ["List"] = cell.Text + ".Items", ["Position"] = position.Text } });
                AdvanceListVersion(reference, cell, steps);
                Assign(steps, CellPath(reference), cell.Text);
            }
            else if (name == "Clear" && invocation.Arguments.Length == 0)
            {
                var cell = ReadCell(reference, steps);
                steps.Add(new JsonObject { ["call"] = "ListClear", ["as"] = "AvReferenceClear" + ++calls, ["args"] = new JsonObject { ["List"] = cell.Text + ".Items" } });
                AdvanceListVersion(reference, cell, steps);
                Assign(steps, CellPath(reference), cell.Text);
            }
            else throw Unsupported(invocation, "Collection member has no typed arena implementation: " + name);
            return new("False", Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Boolean)));
        }
        return null;
    }
    private SourceValue ReferenceArgument(IOperation operation, JsonArray steps)
    {
        while (operation is IConversionOperation { IsImplicit: true, Type.SpecialType: SpecialType.System_Object } conversion) operation = conversion.Operand;
        return Value(operation, steps);
    }
    private SourceValue ManagedText(string expression, JsonArray steps)
    {
        var result = Temp(Type(model.Program.Compilation.GetSpecialType(SpecialType.System_String)));
        Assign(steps, result.Text + ".HasValue", "True"); Assign(steps, result.Text + ".Value", expression); return result;
    }
    private string ConcatenatedText(SourceValue value, IOperation location)
    {
        if (value.Type.Native == "Text") return "If(" + Present(value) + ", " + Payload(value).Text + ", \"\")";
        var function = value.Type.Native switch { "Integer" => "IntegerToText", "Long Integer" => "LongIntegerToText", "Boolean" => "BooleanToText", _ => null };
        return function == null ? throw Unsupported(location, "Scalar string concatenation codec is not connected for " + value.Type.Native)
            : "If(" + Present(value) + ", " + function + "(" + Payload(value).Text + "), \"\")";
    }
    private void FinishReference(JsonArray steps, int kind)
    {
        if (kind == 2 && model.Control.Enabled) SearchException(steps);
        if (kind == 1 && ControlFrame != null && controlPart == null && !method.Symbol.ReturnsVoid)
            Assign(steps, method.Result, ReturnPath);
        Assign(steps, "AvContextOut", Context); Assign(steps, "AvCompletion.Kind", kind.ToString());
        steps.Add(new JsonObject { ["return"] = true });
    }
    private void EmitReferenceThrow(JsonArray steps, string qualified, string native, string message, string paramName = "\"\"", string hasParamName = "False", SourceValue? actualValue = null)
    {
        var exception = CreateReferenceException(steps, qualified, native, message, paramName, hasParamName, actualValue);
        AppendReferenceException(steps, exception);
    }
    private readonly JsonArray referencePrelude = [];
    private readonly Dictionary<(string Type, string Message), SourceValue> fixedReferenceErrors = [];
    private void EmitFixedReferenceThrow(JsonArray steps, string qualified, string native, string message)
    {
        // Only compiler-owned constant guard payloads take this path. Native value
        // records are copied by ListAppend, so every throw still gets a fresh index.
        // Source-evaluated messages/parameters remain at their original effect site.
        if (!fixedReferenceErrors.TryGetValue((qualified, message), out var exception))
        {
            exception = CreateReferenceException(referencePrelude, qualified, native, message, "\"\"", "False", null);
            fixedReferenceErrors.Add((qualified, message), exception);
        }
        AppendReferenceException(steps, exception);
    }
    private SourceValue CreateReferenceException(JsonArray steps, string qualified, string native, string message,
        string paramName, string hasParamName, SourceValue? actualValue)
    {
        model.References.Throws(qualified, model.Exception(native));
        var exception = Temp(NativeType(model.References.ExceptionType));
        Assign(steps, exception.Text, StorageDefault(exception.Type));
        Assign(steps, exception.Text + ".TypeName", DataModel.Constant(qualified)); Assign(steps, exception.Text + ".Message", message);
        Assign(steps, exception.Text + ".ParamName", paramName); Assign(steps, exception.Text + ".HasParamName", hasParamName);
        if (ExceptionHResult(qualified) is { } hresult)
        {
            Assign(steps, exception.Text + ".HasHResult", "True"); Assign(steps, exception.Text + ".HResult", DataModel.Constant(hresult));
        }
        if (actualValue != null)
        {
            var slot = actualValue.Type.Native switch { "Integer" => "Integer", "Long Integer" => "Long", "Text" => "Text", "Boolean" => "Boolean", _ => throw new InvalidOperationException() };
            Assign(steps, exception.Text + ".HasActualValue", Present(actualValue));
            var present = new JsonArray();
            Assign(present, exception.Text + ".ActualValueType", DataModel.Constant(actualValue.Type.Source.SpecialType.ToString().Replace("System_", "System.")));
            Assign(present, exception.Text + ".ActualValue" + slot, Payload(actualValue).Text);
            steps.Add(new JsonObject { ["if"] = Present(actualValue), ["then"] = present });
        }
        return exception;
    }
    private void AppendReferenceException(JsonArray steps, SourceValue exception)
    {
        steps.Add(new JsonObject { ["call"] = "ListAppend", ["as"] = "AvThrow" + ++calls,
            ["args"] = new JsonObject { ["List"] = Context + ".Exceptions", ["Element"] = exception.Text } });
        Assign(steps, "AvCompletion.ExceptionRef", Context + ".Exceptions.Length"); FinishReference(steps, 2);
    }
    private void NormalizeReferenceRaises(JsonArray steps)
    {
        // Shared scalar/temporal emitters may produce native raise steps directly.
        // Inside a managed component every such source failure must return its context.
        for (var index = 0; index < steps.Count; index++)
        {
            if (steps[index] is not JsonObject step) continue;
            if (step["raise"] is { } raised)
            {
                var kind = raised.ToString(); var replacement = new JsonArray();
                EmitReferenceThrow(replacement, "System." + kind, kind, step["message"]?.ToString() ?? DataModel.Constant(kind));
                steps.RemoveAt(index);
                for (var at = 0; at < replacement.Count; at++) steps.Insert(index + at, replacement[at]!.DeepClone());
                index += replacement.Count - 1; continue;
            }
            foreach (var key in new[] { "then", "else", "do", "next", "otherwise" })
                if (step[key] is JsonArray branch) NormalizeReferenceRaises(branch);
            foreach (var arm in step["switch"]?.AsArray().OfType<JsonObject>() ?? [])
                if (arm["steps"] is JsonArray branch) NormalizeReferenceRaises(branch);
        }
    }
    private void PropagateReferenceCall(string call, JsonArray steps)
    {
        Assign(steps, Context, call + ".AvContextOut");
        var failed = new JsonArray(); Assign(failed, "AvCompletion", call + ".AvCompletion");
        Assign(failed, "AvContextOut", Context); failed.Add(new JsonObject { ["return"] = true });
        steps.Add(new JsonObject { ["if"] = call + ".AvCompletion.Kind = 2", ["then"] = failed });
    }
}
