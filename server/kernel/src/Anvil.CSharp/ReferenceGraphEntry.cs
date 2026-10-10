using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;

namespace Anvil.CSharp;

internal sealed partial class ReferenceModel
{
    private readonly Dictionary<string, string> graphSchemas = new(StringComparer.Ordinal);
    private string? graphCompletionType;

    private JsonObject GraphEntry(MethodDeclaration method, JsonObject implementation, MethodCompiler defaults)
    {
        var boundary = Boundary(method.Symbol);
        var abiVersion = ReferenceSourceAbi.VersionFor(boundary, data);
        var exceptionGraph = abiVersion >= 3;
        var exceptionValue = exceptionGraph ? data.Type(ExceptionTypes.Root(program.Compilation), method.Symbol) : null;
        var exceptionLayout = exceptionValue == null ? null : new ReferenceLayout(exceptionValue.Native, ExceptionType, "Exceptions", exceptionValue);
        ReferenceLayout GraphLayout(ValueType type) => type.IsExceptionReference ? exceptionLayout! : Layout(type);
        IEnumerable<ReferenceLayout> Layouts(ValueType type)
        {
            if (type.IsReadOnlyListReference)
            {
                data.ExportRuntimeType(type.Native);
                var view = ReadOnlyLayout(type);
                return [Layout(view.List), Layout(view.Array)];
            }
            return [type.IsArenaReference ? Layout(type) : throw SourceProgram.Error("AVCS343", "Native graph layout is not connected for this source reference type", type.Source)];
        }
        var selected = boundary.Types.Where(t => t.HasIdentity && !data.IsException(t.Symbol))
            .Select(t => Runtime(data.Type(t.Symbol, method.Symbol)))
            .SelectMany(Layouts)
            .Concat(exceptionLayout == null ? [] : new[] { exceptionLayout })
            .DistinctBy(l => l.Arena).OrderBy(l => l.Arena, StringComparer.Ordinal).ToArray();
        foreach (var layout in selected)
        {
            if (layout.Value.Declaration is { Kind: DataKind.Structure } declaration) data.RepresentByGraph(declaration);
            data.ExportRuntimeType(layout.Handle); data.ExportRuntimeType(layout.Cell);
        }
        foreach (var item in boundary.Types.Where(t => t.Kind == BoundaryTypeKind.Value))
        {
            var type = Runtime(data.Type(item.Symbol, method.Symbol));
            if (type.Declaration is not { Kind: DataKind.Structure } declaration) continue;
            data.RepresentByGraph(declaration); data.ExportRuntimeType(data.Transport(type));
        }
        var schemaKey = string.Join(";", selected.Select(l => l.Arena));
        if (!graphSchemas.TryGetValue(schemaKey, out var graphType))
        {
            graphType = Unique("AvGraph_" + SymbolNames.Digest(schemaKey)); graphSchemas.Add(schemaKey, graphType);
            data.AddRuntimeStructure(Structure(graphType, new JsonArray(selected.Select(l => (JsonNode)Field(l.Arena, l.Cell + " List")).ToArray())));
            data.ExportRuntimeType(graphType);
        }
        var wireCompletion = CompletionType;
        if (exceptionGraph || completionFields.Count > 2)
        {
            if (graphCompletionType == null)
            {
                graphCompletionType = Unique("AvGraphCompletion");
                data.AddRuntimeStructure(Structure(graphCompletionType, new JsonArray(Field("Kind", "Integer"), Field("ExceptionRef", "Integer"))));
            }
            wireCompletion = graphCompletionType;
        }
        data.ExportRuntimeType(wireCompletion); data.ExportRuntimeType(ExceptionType);
        var inputs = new JsonArray(implementation["inputs"]!.AsArray().Where(p => p!["name"]!.ToString() != "AvContextIn").Select(p => p!.DeepClone()).ToArray());
        inputs.Add(Field("AvGraphIn", graphType));
        if (exceptionGraph) inputs.Add(Field("AvGraphAbiIn", "Integer"));
        var outputs = new JsonArray(implementation["outputs"]!.AsArray().Where(p => p!["name"]!.ToString() == method.Result).Select(p => p!.DeepClone()).ToArray());
        outputs.Add(Field("AvGraphOut", graphType)); outputs.Add(Field("AvCompletion", wireCompletion));
        outputs.Add(exceptionGraph ? Field("AvGraphAbiOut", "Integer") : Field("AvErrors", ExceptionType + " List"));
        var vars = new JsonArray(Field("AvInitialContext", ContextType)); var steps = new JsonArray();
        var args = new JsonObject { ["AvContextIn"] = "AvInitialContext" }; var counter = 0;
        string Var(string type) { var n = "AvGraphTemp" + ++counter; vars.Add(Field(n, type)); return n; }
        static JsonObject Set(string target, string value) => new() { ["assign"] = new JsonObject { [target] = value } };
        JsonObject Append(string list, string element) => new() { ["call"] = "ListAppend", ["as"] = "AvGraphAppend" + ++counter,
            ["args"] = new JsonObject { ["List"] = list, ["Element"] = element } };
        static JsonObject When(string condition, JsonArray yes) => new() { ["if"] = condition, ["then"] = yes };
        void Guard(JsonArray target, string invalid) => target.Add(When(invalid, new JsonArray(new JsonObject {
            ["raise"] = "InvalidOperationException", ["message"] = DataModel.Constant("Invalid C# reference graph.") })));
        void Loop(JsonArray target, string count, Action<JsonArray, string> body)
        {
            var index = Var("Integer"); var repeated = new JsonArray(); body(repeated, index);
            if (repeated.Count == 0)
            {
                var unused = vars.OfType<JsonObject>().Single(v => v["name"]!.ToString() == index); vars.Remove(unused); return;
            }
            target.Add(Set(index, "0"));
            target.Add(new JsonObject { ["while"] = index + " < " + count, ["do"] = repeated, ["next"] = new JsonArray(Set(index, index + " + 1")) });
        }
        IEnumerable<(string Name, ValueType Type)> Fields(ReferenceLayout layout)
            => SourceMember.Of(layout.Value.Declaration!.Symbol).Select(m => (layout.Value.Declaration.Properties[m.Symbol], Runtime(data.Type(m.Type, m.Symbol))));
        void CheckEmpty(JsonArray target, string path, ValueType type)
        {
            if (type.Nullable)
            {
                Guard(target, path + ".HasValue"); CheckEmpty(target, path + ".Value", type with { Nullable = false });
            }
            else if (type.IsReadOnlyListReference) Guard(target, path + ".Kind <> 0 or " + path + ".Index <> 0");
            else if (type.IsArenaReference || type.IsExceptionReference) Guard(target, path + ".Index <> 0");
            else if (type.Temporal != TemporalKind.None)
            {
                Guard(target, path + "." + TemporalModel.Field(type.Temporal) + " <> 0");
                if (type.Temporal == TemporalKind.DateTime) Guard(target, path + ".Kind <> 0");
                if (type.Temporal == TemporalKind.DateTimeOffset) Guard(target, path + ".OffsetMinutes <> 0");
            }
            else if (type.Declaration is { Kind: DataKind.Structure } declaration)
                foreach (var member in SourceMember.Of(declaration.Symbol))
                    CheckEmpty(target, path + "." + declaration.Properties[member.Symbol], Runtime(data.Type(member.Type, member.Symbol)));
            else Guard(target, path + " <> " + Var(data.Transport(type)));
        }
        void CheckValue(JsonArray target, string path, ValueType type)
        {
            if (type.Nullable)
            {
                var present = new JsonArray(); CheckValue(present, path + ".Value", type with { Nullable = false });
                if (present.Count > 0) target.Add(When(path + ".HasValue", present));
                if (exceptionGraph)
                {
                    var absent = new JsonArray(); CheckEmpty(absent, path + ".Value", type with { Nullable = false });
                    target.Add(When("not " + path + ".HasValue", absent));
                }
                return;
            }
            if (type.IsIdentity)
            {
                if (data.IdentityBits(type) == 32)
                    Guard(target, "IdentifierToLongInteger(" + path + ") < -2147483648 or IdentifierToLongInteger(" + path + ") > 2147483647");
                return;
            }
            if (MethodCompiler.Range(type.Source) is { } integer && type.Native switch {
                "Integer" => integer.Minimum > int.MinValue || integer.Maximum < int.MaxValue,
                "Long Integer" => integer.Minimum > long.MinValue || integer.Maximum < long.MaxValue,
                _ => true })
            {
                Guard(target, path + " < " + integer.Min + " or " + path + " > " + integer.Max);
                return;
            }
            if (abiVersion >= 4 && type.Temporal != TemporalKind.None)
            {
                var value = path + "." + TemporalModel.Field(type.Temporal);
                Guard(target, "Mod((" + value + " + 0.0), 1.0) <> 0");
                if (type.Temporal == TemporalKind.DateOnly) Guard(target, value + " < 0 or " + value + " > " + TemporalModel.MaximumDayNumber);
                else if (type.Temporal == TemporalKind.TimeOnly) Guard(target, value + " < 0 or " + value + " >= " + TemporalModel.TicksPerDay);
                else if (type.Temporal == TemporalKind.TimeSpan) Guard(target, value + " < -9223372036854775808.0 or " + value + " > 9223372036854775807.0");
                else Guard(target, value + " < 0 or " + value + " > " + TemporalModel.MaximumDateTimeTicks);
                if (type.Temporal == TemporalKind.DateTime)
                    Guard(target, path + ".Kind < 0 or " + path + ".Kind > 2 or Mod(" + path + ".Kind, 1) <> 0");
                if (type.Temporal == TemporalKind.DateTimeOffset)
                {
                    Guard(target, path + ".OffsetMinutes < -840 or " + path + ".OffsetMinutes > 840 or Mod(" + path + ".OffsetMinutes, 1) <> 0");
                    var civil = "((" + value + " + 0.0) + " + path + ".OffsetMinutes * 600000000.0)";
                    Guard(target, civil + " < 0 or " + civil + " > " + TemporalModel.MaximumDateTimeTicks);
                }
                return;
            }
            if (type.IsReadOnlyListReference)
            {
                Guard(target, ReadOnlyListTypes.InvalidHandle(path));
                var view = ReadOnlyLayout(type);
                foreach (var (kind, concrete) in new[] { (1, view.List), (2, view.Array) })
                {
                    var branch = new JsonArray(); CheckValue(branch, path, concrete);
                    target.Add(When(path + ".Kind = " + kind, branch));
                }
                return;
            }
            if (type.IsArenaReference || type.IsExceptionReference)
            {
                var arena = GraphLayout(type).Arena;
                if (!selected.Any(s => s.Arena == arena)) throw SourceProgram.Error("AVCS343", "Incomplete native graph type closure", method.Symbol);
                Guard(target, path + ".Index < 0 or " + path + ".Index > AvGraphIn." + arena + ".Length");
                if (type.IsExceptionReference)
                {
                    var accepted = ExceptionTypes.Builtins.Keys.Where(name => ExceptionTypes.DerivesFrom(
                        program.Compilation.GetSpecialType(SpecialType.System_Object).ContainingAssembly.GetTypeByMetadataName(name)!, type.Source)).ToArray();
                    if (accepted.Length == 0) throw SourceProgram.Error("AVCS347", "Exception boundary requires a supported exact BCL type", type.Source);
                    var present = new JsonArray();
                    Guard(present, "not (" + string.Join(" or ", accepted.Select(name => "AvGraphIn.Exceptions[" + path + ".Index - 1].TypeName = " + DataModel.Constant(name))) + ")");
                    target.Add(When(path + ".Index > 0", present));
                }
            }
            else if (type.Declaration is { Kind: DataKind.Structure } declaration)
            {
                foreach (var member in SourceMember.Of(declaration.Symbol))
                    CheckValue(target, path + "." + declaration.Properties[member.Symbol], Runtime(data.Type(member.Type, member.Symbol)));
            }
        }
        if (exceptionGraph)
        {
            Guard(steps, "AvGraphAbiIn <> " + abiVersion);
            steps.Add(Set("AvGraphAbiOut", abiVersion.ToString()));
            ValidateExceptionGraph(steps, Var, Set, Guard, Loop);
        }
        foreach (var parameter in method.Symbol.Parameters.Where(p => !LogicModel.DataDependency(p.Type)))
        {
            var name = method.Parameter(parameter); var type = Runtime(data.Type(parameter.Type, parameter));
            if (!parameter.HasExplicitDefaultValue)
            {
                CheckValue(steps, name, type); args[name] = name; continue;
            }
            var input = inputs.OfType<JsonObject>().Single(item => item["name"]!.ToString() == name);
            input["type"] = OptionalArgument(data.Transport(type)); input["mandatory"] = false; input.Remove("default");
            var selectedValue = Var(data.Transport(type)); var supplied = new JsonArray(); var omitted = new JsonArray();
            CheckValue(supplied, name + ".Value", type); supplied.Add(Set(selectedValue, name + ".Value"));
            CheckEmpty(omitted, name + ".Value", type);
            defaults.DefaultArgument(parameter, selectedValue, omitted, vars);
            steps.Add(new JsonObject { ["if"] = name + ".IsSpecified", ["then"] = supplied, ["else"] = omitted });
            args[name] = selectedValue;
        }
        foreach (var layout in selected)
        {
            var input = "AvGraphIn." + layout.Arena;
            Loop(steps, input + ".Length", (body, index) => {
                if (layout.Value.IsExceptionReference) return;
                if (layout.Value.IsList)
                {
                    if (layout.Value.Source is not IArrayTypeSymbol)
                        Guard(body, input + "[" + index + "].Capacity < " + input + "[" + index + "].Items.Length");
                    Loop(body, input + "[" + index + "].Items.Length", (items, item) => CheckValue(items, input + "[" + index + "].Items[" + item + "]", Runtime(layout.Value.Element!)));
                }
                else foreach (var field in Fields(layout)) CheckValue(body, input + "[" + index + "]." + field.Name, field.Type);
            });
            steps.Add(Set("AvInitialContext." + layout.Arena, input));
        }
        // Native record assignments can share list storage with the input graph.
        // Snapshot the identity frontier before source execution; reading input
        // lengths afterwards can mistake newly allocated garbage for caller roots.
        var originalCounts = selected.ToDictionary(layout => layout.Arena, _ => Var("Integer"), StringComparer.Ordinal);
        foreach (var layout in selected) steps.Add(Set(originalCounts[layout.Arena], "AvGraphIn." + layout.Arena + ".Length"));
        steps.Add(new JsonObject { ["call"] = MethodName(method), ["as"] = "AvInvocation", ["args"] = args });
        steps.Add(Set("AvCompletion.Kind", "AvInvocation.AvCompletion.Kind"));

        // Dense native-index -> wire-index maps. All original identities retain their
        // input indices, even when the business method detaches/rebinds a parameter.
        var maps = selected.ToDictionary(l => l.Arena, _ => Var("Integer List"), StringComparer.Ordinal);
        var queues = selected.ToDictionary(l => l.Arena, _ => Var("Integer List"), StringComparer.Ordinal);
        var positions = selected.ToDictionary(l => l.Arena, _ => Var("Integer"), StringComparer.Ordinal);
        foreach (var layout in selected)
        {
            Loop(steps, "AvInvocation.AvContextOut." + layout.Arena + ".Length", (body, _) => body.Add(Append(maps[layout.Arena], "0")));
            Loop(steps, originalCounts[layout.Arena], (body, index) => {
                body.Add(Append(queues[layout.Arena], index + " + 1")); body.Add(Set(maps[layout.Arena] + "[" + index + "]", index + " + 1"));
            });
        }
        void Touch(JsonArray target, string source, string destination, ValueType type)
        {
            if (type.IsReadOnlyListReference)
            {
                Guard(target, ReadOnlyListTypes.InvalidHandle(source));
                if (source != destination) target.Add(Set(destination + ".Kind", source + ".Kind"));
                var view = ReadOnlyLayout(type);
                foreach (var (kind, concrete) in new[] { (1, view.List), (2, view.Array) })
                {
                    var branch = new JsonArray(); Touch(branch, source, destination, concrete);
                    target.Add(When(source + ".Kind = " + kind, branch));
                }
                target.Add(When(source + ".Kind = 0", new JsonArray(Set(destination + ".Index", "0"))));
                return;
            }
            if (type.Nullable)
            {
                var valueType = type with { Nullable = false }; var optionalPresent = new JsonArray();
                Touch(optionalPresent, source + ".Value", destination + ".Value", valueType);
                var empty = Var(data.Transport(valueType)); // Unassigned native local is the default payload.
                if (source != destination) target.Add(Set(destination + ".HasValue", source + ".HasValue"));
                target.Add(new JsonObject { ["if"] = source + ".HasValue", ["then"] = optionalPresent,
                    ["else"] = new JsonArray(Set(destination + ".Value", empty)) });
                return;
            }
            if (!type.IsArenaReference && !type.IsExceptionReference && type.Declaration is { Kind: DataKind.Structure } declaration)
            {
                foreach (var member in SourceMember.Of(declaration.Symbol))
                {
                    var field = "." + declaration.Properties[member.Symbol];
                    Touch(target, source + field, destination + field, Runtime(data.Type(member.Type, member.Symbol)));
                }
                return;
            }
            if (!type.IsArenaReference && !type.IsExceptionReference) { if (destination != source) target.Add(Set(destination, source)); return; }
            var layout = GraphLayout(type); var map = maps[layout.Arena]; var queue = queues[layout.Arena];
            var index = Var("Integer"); target.Add(Set(index, source + ".Index"));
            Guard(target, index + " < 0 or " + index + " > " + map + ".Length");
            var present = new JsonArray();
            present.Add(When(map + "[" + index + " - 1] = 0", new JsonArray(Append(queue, index), Set(map + "[" + index + " - 1]", queue + ".Length"))));
            present.Add(Set(destination + ".Index", map + "[" + index + " - 1]"));
            target.Add(new JsonObject { ["if"] = index + " > 0", ["then"] = present, ["else"] = new JsonArray(Set(destination + ".Index", "0")) });
        }
        if (!method.Symbol.ReturnsVoid)
        {
            var result = new JsonArray(); Touch(result, "AvInvocation." + method.Result, method.Result, Runtime(data.Type(method.Symbol.ReturnType, method.Symbol)));
            steps.Add(When("AvCompletion.Kind <> 2", result));
        }
        if (exceptionGraph)
        {
            var failure = new JsonArray(); var handle = Var(exceptionValue!.Native);
            failure.Add(Set(handle + ".Index", "AvInvocation.AvCompletion.ExceptionRef"));
            Guard(failure, handle + ".Index <= 0");
            Touch(failure, handle, handle, exceptionValue);
            failure.Add(Set("AvCompletion.ExceptionRef", handle + ".Index"));
            steps.Add(When("AvCompletion.Kind = 2", failure));
        }
        var remaining = string.Join(" or ", selected.Select(l => positions[l.Arena] + " < " + queues[l.Arena] + ".Length"));
        var visit = new JsonArray();
        foreach (var layout in selected)
        {
            var position = positions[layout.Arena]; var queue = queues[layout.Arena];
            var body = new JsonArray(); var cell = Var(layout.Cell);
            body.Add(Set(cell, "AvInvocation.AvContextOut." + layout.Arena + "[" + queue + "[" + position + "] - 1]"));
            if (layout.Value.IsExceptionReference)
            {
                var inner = Var(exceptionValue!.Native); body.Add(Set(inner + ".Index", cell + ".InnerRef"));
                Touch(body, inner, inner, exceptionValue); body.Add(Set(cell + ".InnerRef", inner + ".Index"));
            }
            else if (layout.Value.IsList)
                Loop(body, cell + ".Items.Length", (items, index) => Touch(items, cell + ".Items[" + index + "]", cell + ".Items[" + index + "]", Runtime(layout.Value.Element!)));
            else foreach (var field in Fields(layout)) Touch(body, cell + "." + field.Name, cell + "." + field.Name, field.Type);
            body.Add(Append("AvGraphOut." + layout.Arena, cell));
            visit.Add(new JsonObject { ["while"] = position + " < " + queue + ".Length", ["do"] = body, ["next"] = new JsonArray(Set(position, position + " + 1")) });
        }
        steps.Add(new JsonObject { ["while"] = remaining, ["do"] = visit });

        // Only the actual failure chain is returned, never the complete internal context.
        if (!exceptionGraph)
        {
        var failure = new JsonArray(); var errorIndex = Var("Integer"); var errorCell = Var(ExceptionType); var nextError = Var("Integer");
        failure.Add(Set(errorIndex, "AvInvocation.AvCompletion.ExceptionRef")); failure.Add(Set("AvCompletion.ExceptionRef", "1"));
        Guard(failure, errorIndex + " <= 0"); var errorBody = new JsonArray();
        Guard(errorBody, errorIndex + " > AvInvocation.AvContextOut.Exceptions.Length or AvErrors.Length >= AvInvocation.AvContextOut.Exceptions.Length");
        errorBody.Add(Set(errorCell, "AvInvocation.AvContextOut.Exceptions[" + errorIndex + " - 1]"));
        errorBody.Add(Set(nextError, errorCell + ".InnerRef"));
        errorBody.Add(new JsonObject { ["if"] = nextError + " > 0", ["then"] = new JsonArray(Set(errorCell + ".InnerRef", "AvErrors.Length + 2")), ["else"] = new JsonArray(Set(errorCell + ".InnerRef", "0")) });
        errorBody.Add(Append("AvErrors", errorCell)); errorBody.Add(Set(errorIndex, nextError));
        failure.Add(new JsonObject { ["while"] = errorIndex + " > 0", ["do"] = errorBody });
        steps.Add(When("AvCompletion.Kind = 2", failure));
        }
        return new JsonObject { ["name"] = method.Name, ["inputs"] = inputs, ["outputs"] = outputs, ["vars"] = vars, ["steps"] = steps,
            ["description"] = "Generated C# graph boundary: validate/import, execute, dense caller/result export, then completion. Staged ABI; caller integration required." };
    }
}
