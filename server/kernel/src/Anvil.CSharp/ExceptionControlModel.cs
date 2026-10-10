using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed class ExceptionControlFrame(MethodDeclaration method, string type, string arena)
{
    internal MethodDeclaration Method { get; } = method;
    internal string Type { get; } = type;
    internal string Arena { get; } = arena;
    internal JsonArray Fields { get; } = [];
    internal Dictionary<ISymbol, string> Slots { get; } = new(SymbolEqualityComparer.Default);
    internal Dictionary<int, ExceptionControlRegion> Regions { get; } = [];
    internal Dictionary<ILabelSymbol, int> Labels { get; } = new(SymbolEqualityComparer.Default);
    internal HashSet<ILabelSymbol> ContinueLabels { get; } = new(SymbolEqualityComparer.Default);
}

internal sealed record ExceptionControlRegion(int Id, ITryOperation Operation, ExceptionControlFrame Frame, string Name)
{
    internal string BodyName => Name + "Body";
    internal string FinallyName => Name + "Finally";
    internal string CatchName(int index) => Name + "Catch" + index;
    internal string FilterName(int index) => Name + "Filter" + index;
}

internal sealed record ExceptionControlPart(ExceptionControlRegion Region, IOperation Operation, string Name, bool Filter = false, ICatchClauseOperation? Catch = null);

/// <summary>Fixed compiled regions and typed activation slots; never source instructions.</summary>
internal sealed class ExceptionControlModel
{
    private readonly LogicModel model;
    private readonly Dictionary<IMethodSymbol, ExceptionControlFrame> frames = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<IMethodSymbol, IOperation> bodies = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<string, List<(int Id, MethodDeclaration Method)>> closureTargets = new(StringComparer.Ordinal);
    internal bool Enabled => frames.Count != 0;
    internal string RegionType { get; }
    internal string SearchName { get; }
    internal ExceptionControlFrame? Frame(IMethodSymbol method) => frames.GetValueOrDefault(method);
    internal IOperation Body(IMethodSymbol method) => bodies[method];
    internal IReadOnlyList<(int Id, MethodDeclaration Method)> Closures(ValueType type) => closureTargets.GetValueOrDefault(type.Native) ?? [];

    internal ExceptionControlModel(LogicModel model, IEnumerable<MethodDeclaration> declarations)
    {
        this.model = model;
        var methods = declarations.ToArray();
        var typeNames = model.Data.Types.Select(type => type.Name).Append(model.References.ContextType)
            .Append(model.References.ExceptionType).Append(model.References.CompletionType).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var actionNames = methods.SelectMany(method => new[] { method.Name, method.CallName, model.References.MethodName(method) }).ToHashSet(StringComparer.OrdinalIgnoreCase);
        string TypeName(string name) { var allocated = SymbolNames.Allocate(name, typeNames.Contains); typeNames.Add(allocated); return allocated; }
        string ActionName(string name) { var allocated = SymbolNames.Allocate(name, actionNames.Contains); actionNames.Add(allocated); return allocated; }
        RegionType = TypeName("AvActiveExceptionRegion"); SearchName = ActionName("AvSearchException");
        var ordinal = 0;
        foreach (var method in methods)
        {
            var syntax = method.Symbol.DeclaringSyntaxReferences.Single().GetSyntax();
            var operation = method.BoundBody ?? model.Program.Model(syntax).GetOperation(syntax);
            var body = operation is ILocalFunctionOperation local ? local.Body : operation;
            if (body == null) throw SourceProgram.Error("AVCS305", "Method body could not be bound", syntax);
            bodies.Add(method.Symbol, body);
            var operations = Walk(body).ToArray();
            var regions = operations.OfType<ITryOperation>().ToArray();
            foreach (var creation in operations.OfType<IDelegateCreationOperation>())
            {
                if (LogicModel.InlineQueryLambda(creation)) continue;
                var target = creation.Target switch { IAnonymousFunctionOperation anonymous => anonymous.Symbol, IMethodReferenceOperation reference => reference.Method, _ => null };
                if (target == null || !model.HasMethod(target)) throw SourceProgram.Error("AVCS348", "Delegate target requires a statically bound source method", creation.Syntax);
                var type = model.Data.Type(creation.Type!, method.Symbol);
                if (!closureTargets.TryGetValue(type.Native, out var targets)) closureTargets.Add(type.Native, targets = []);
                if (!targets.Any(item => SymbolEqualityComparer.Default.Equals(item.Method.Symbol, target))) targets.Add((targets.Count + 1, model.Method(target)));
            }
            if (regions.Length == 0 && !operations.Any(node => node is ILocalFunctionOperation || node is IAnonymousFunctionOperation or IDelegateCreationOperation && !LogicModel.InlineQueryLambda(node)) && method.Symbol.MethodKind is not (MethodKind.LocalFunction or MethodKind.AnonymousFunction)) continue;
            var key = SymbolNames.Digest(method.Symbol.ToDisplayString() + (method.Symbol.MethodKind == MethodKind.Ordinary ? "" : "|" + method.Name));
            var frame = new ExceptionControlFrame(method, TypeName("AvFrame_" + key), "Frames_" + key);
            frames.Add(method.Symbol, frame);
            model.Data.AddRuntimeStructure(Structure(frame.Type, frame.Fields));
            model.References.ControlArena(frame.Arena, frame.Type + " List");
            if (!method.Symbol.ReturnsVoid) frame.Fields.Add(Field("Result", model.Data.Transport(model.References.Runtime(model.Data.Type(method.Symbol.ReturnType, method.Symbol)))));
            if (method.HasReceiver) Slot(frame, method.Symbol.ContainingType, method.Symbol.ContainingType, "This");
            if (method.Symbol.ContainingSymbol is IMethodSymbol) frame.Fields.Add(Field("ParentFrame", "Integer"));
            foreach (var parameter in method.Symbol.Parameters.Where(p => !LogicModel.DataDependency(p.Type))) Slot(frame, parameter, parameter.Type, method.Parameter(parameter));
            foreach (var region in regions)
                frame.Regions.Add(region.Syntax.SpanStart, new(++ordinal, region, frame, "AvRegion_" + key + "_" + region.Syntax.SpanStart + "_"));
            foreach (var loop in operations.OfType<ILoopOperation>())
            { frame.Labels.TryAdd(loop.ExitLabel, frame.Labels.Count + 1); frame.Labels.TryAdd(loop.ContinueLabel, frame.Labels.Count + 1); frame.ContinueLabels.Add(loop.ContinueLabel); }
            foreach (var selection in operations.OfType<ISwitchOperation>()) frame.Labels.TryAdd(selection.ExitLabel, frame.Labels.Count + 1);
        }
        if (!Enabled) return;
        model.Data.AddRuntimeStructure(Structure(RegionType, new JsonArray(Field("Region", "Integer"), Field("Frame", "Integer"), Field("Activation", "Integer"))));
        model.References.ControlArena("ActiveRegions", RegionType + " List");
        model.References.ControlArena("NextRegion", "Integer");
        model.References.ControlCompletion("TargetRegion"); model.References.ControlCompletion("Handler"); model.References.ControlCompletion("Target");
    }

    internal string Slot(ExceptionControlFrame frame, ISymbol symbol, ITypeSymbol type, string? name = null)
    {
        if (frame.Slots.TryGetValue(symbol, out var existing)) return existing;
        name ??= SymbolNames.Normalize("Local" + (frame.Slots.Count + 1) + "_" + symbol.Name);
        frame.Slots.Add(symbol, name);
        frame.Fields.Add(Field(name, model.Data.Transport(model.References.Runtime(model.Data.Type(type, symbol)))));
        return name;
    }

    internal IEnumerable<JsonObject> Compile()
    {
        foreach (var frame in frames.Values)
            foreach (var region in frame.Regions.Values)
            {
                yield return new MethodCompiler(model, frame.Method, new(region, region.Operation.Body, region.BodyName)).CompileControlPart();
                for (var i = 0; i < region.Operation.Catches.Length; i++)
                {
                    var clause = region.Operation.Catches[i];
                    yield return new MethodCompiler(model, frame.Method, new(region, clause.Handler, region.CatchName(i), Catch: clause)).CompileControlPart();
                    if (clause.Filter != null)
                        yield return new MethodCompiler(model, frame.Method, new(region, clause.Filter, region.FilterName(i), Filter: true, Catch: clause)).CompileControlPart();
                }
                if (region.Operation.Finally != null)
                    yield return new MethodCompiler(model, frame.Method, new(region, region.Operation.Finally, region.FinallyName)).CompileControlPart();
            }
        if (Enabled) yield return Search();
    }

    private JsonObject Search()
    {
        var vars = new JsonArray(Field("AvContext", model.References.ContextType), Field("AvPosition", "Integer"),
            Field("AvRegion", RegionType), Field("AvBarrier", RegionType));
        var steps = new JsonArray(Set("AvContext", "AvContextIn"), Set("AvPosition", "AvContext.ActiveRegions.Length - 1"));
        var scan = new JsonArray(Set("AvRegion", "AvContext.ActiveRegions[AvPosition]"));
        // A filter failure may search its own nested helpers/regions, but cannot
        // observe the suspended original search below this activation barrier.
        scan.Add(new JsonObject { ["if"] = "AvRegion.Region = -1", ["then"] = new JsonArray(new JsonObject { ["break"] = true }) });
        var exceptionType = "AvContext.Exceptions[AvExceptionRef - 1].TypeName";
        foreach (var region in frames.Values.SelectMany(frame => frame.Regions.Values))
        {
            var clauses = new JsonArray();
            for (var i = 0; i < region.Operation.Catches.Length; i++)
            {
                var clause = region.Operation.Catches[i];
                var matches = clause.ExceptionType == null ? "True" : CatchCondition(clause.ExceptionType, exceptionType);
                var accepted = new JsonArray(Set("AvTargetRegion", "AvRegion.Activation"), Set("AvHandler", (i + 1).ToString()),
                    Set("AvContextOut", "AvContext"), new JsonObject { ["return"] = true });
                if (clause.Filter == null) clauses.Add(new JsonObject { ["if"] = matches, ["then"] = accepted });
                else
                {
                    var name = "AvFilter" + region.Id + "_" + i;
                    var filter = new JsonArray(Set("AvBarrier.Region", "-1"),
                        new JsonObject { ["call"] = "ListAppend", ["as"] = "AvBarrierPush" + name, ["args"] = new JsonObject { ["List"] = "AvContext.ActiveRegions", ["Element"] = "AvBarrier" } },
                        new JsonObject { ["call"] = region.FilterName(i), ["as"] = name,
                            ["args"] = new JsonObject { ["AvContextIn"] = "AvContext", ["AvFrame"] = "AvRegion.Frame", ["AvCaught"] = "AvExceptionRef" } },
                        Set("AvContext", name + ".AvContextOut"),
                        new JsonObject { ["call"] = "ListRemove", ["as"] = "AvBarrierPop" + name,
                            ["args"] = new JsonObject { ["List"] = "AvContext.ActiveRegions", ["Position"] = "AvContext.ActiveRegions.Length - 1" } },
                        new JsonObject { ["if"] = name + ".AvCompletion.Kind <> 2 and " + name + ".AvFilterResult", ["then"] = accepted });
                    clauses.Add(new JsonObject { ["if"] = matches, ["then"] = filter });
                }
            }
            if (clauses.Count > 0) scan.Add(new JsonObject { ["if"] = "AvRegion.Region = " + region.Id, ["then"] = clauses });
        }
        scan.Add(Set("AvPosition", "AvPosition - 1"));
        steps.Add(new JsonObject { ["while"] = "AvPosition >= 0", ["do"] = scan });
        steps.Add(Set("AvContextOut", "AvContext"));
        // Output zeros mean that the already-completed search found no handler.
        steps.Add(Set("AvTargetRegion", "0")); steps.Add(Set("AvHandler", "0"));
        return new() { ["name"] = SearchName, ["kind"] = "server", ["public"] = false,
            ["inputs"] = new JsonArray(Field("AvContextIn", model.References.ContextType), Field("AvExceptionRef", "Integer")),
            ["outputs"] = new JsonArray(Field("AvContextOut", model.References.ContextType), Field("AvTargetRegion", "Integer"), Field("AvHandler", "Integer")),
            ["vars"] = vars, ["steps"] = steps, ["description"] = "Compiled synchronous exception search; filters execute before any suspended finally is unwound." };
    }

    private string CatchCondition(ITypeSymbol type, string value)
    {
        if (!ExceptionTypes.IsException(type, model.Program.Compilation)) throw SourceProgram.Error("AVCS348", "Catch requires a represented BCL exception type", type);
        // A represented failure can arrive through an input or a captured member;
        // its concrete type need not be constructed anywhere in this source bundle.
        var bcl = model.Program.Compilation.GetSpecialType(SpecialType.System_Object).ContainingAssembly;
        var names = ExceptionTypes.Builtins.Keys.Select(name => bcl.GetTypeByMetadataName(name))
            .Where(candidate => candidate != null && ExceptionTypes.DerivesFrom(candidate, type)).Select(candidate => candidate!.ToDisplayString()).ToArray();
        return names.Length == 0 ? "False" : "(" + string.Join(" or ", names.Select(name => value + " = " + DataModel.Constant(name))) + ")";
    }

    private static IEnumerable<IOperation> Walk(IOperation? operation)
    { if (operation == null) yield break; yield return operation; if (operation is ILocalFunctionOperation or IAnonymousFunctionOperation) yield break; foreach (var child in operation.ChildOperations) foreach (var nested in Walk(child)) yield return nested; }
    private static JsonObject Field(string name, string type) => new() { ["name"] = name, ["type"] = type };
    private static JsonObject Structure(string name, JsonArray fields) => new() { ["name"] = name, ["public"] = false,
        ["description"] = "anvil:csharp invocation-local reference representation", ["attributes"] = fields };
    private static JsonObject Set(string target, string value) => new() { ["assign"] = new JsonObject { [target] = value } };
}
