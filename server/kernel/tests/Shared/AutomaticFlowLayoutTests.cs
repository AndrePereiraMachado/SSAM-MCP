using System.Collections;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class AutomaticFlowLayoutTests
{
    [Theory]
    [InlineData("server action", "IServerAction", true)]
    [InlineData("server action", "IServerAction", false)]
    [InlineData("client action", "IClientAction", true)]
    [InlineData("action LayoutProbeScreen.", "IScreenAction", true)]
    [InlineData("action LayoutProbeBlock.", "IScreenAction", true)]
    [InlineData("data action LayoutProbeScreen.", "IDataAction", true)]
    public void TextAuthoringLayoutsStructuralChangesAndPreservesValueOnlyEdits(string header, string actionType, bool namedDecision)
    {
        var assembly = typeof(ModelHost).Assembly;
        var binder = assembly.GetType("Anvil.Core.StudioAssembliesOdc") ?? assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var bind = binder.GetMethod("Bind")!;
        bind.Invoke(null, bind.GetParameters().Select(_ => (object?)null).ToArray());
        var root = Path.GetDirectoryName(typeof(AutomaticFlowLayoutTests).Assembly.Location)!;
        while (!File.Exists(Path.Combine(root, "MANIFESTO.md"))) root = Path.GetDirectoryName(root)!;
        var lane = StudioAdapter.Runtime.Platform;
        var fixture = lane == "odc" ? "odc/blank-mobile.oml" : "reactive-ui.oml";
        var work = Path.Combine(root, ".local/automatic-layout-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var basis = Path.Combine(root, "tests/fixtures", fixture);
        JsonNode Run(string source, JsonArray operations, string name)
        {
            var job = Path.Combine(work, name + ".json");
            File.WriteAllText(job, new JsonObject { ["ops"] = operations }.ToJsonString());
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, source, job, Path.Combine(work, name + ".oml")))!;
            Assert.True(result["isValid"]!.GetValue<bool>(), result.ToJsonString());
            return result;
        }
        JsonArray Text(string text, string? basedOn = null) => new(new JsonObject {
            ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = text, ["basedOn"] = basedOn }
        });
        Run(basis, JsonNode.Parse("""
        [
          {"op":"create","parent":"@espace","type":"IMobileFlow","name":"LayoutProbeFlow","as":"$flow"},
          {"op":"create","parent":"$flow","type":"IMobileScreen","name":"LayoutProbeScreen"},
          {"op":"create","parent":"$flow","type":"IMobileBlock","name":"LayoutProbeBlock"}
        ]
        """)!.AsArray(), "owners");
        var text = header + (header.EndsWith('.') ? "" : " ") + "TextLayoutProbe\n"
            + (actionType == "IDataAction" ? "  local Flag: Boolean\n" : "  in Flag: Boolean\n")
            + (actionType == "IScreenAction" ? "  local Result: Boolean\n" : "  out Result: Boolean\n")
            + "  if Flag:" + (namedDecision ? "  # Flag enabled?" : "") + "\n    assign Result = True\n    end\n"
            + "  assign Result = False\n  end\n";
        var created = Run(Path.Combine(work, "owners.oml"), Text(text), "created");
        Assert.Equal(FlowLayout.EngineRevision, created["flowLayoutEngine"]!.ToString());
        Assert.Single(created["automaticLayouts"]!.AsArray());
        var owner = actionType + ":TextLayoutProbe";
        if (header.Contains('.')) owner = (header.Contains("Block") ? "IMobileBlock:LayoutProbeBlock/" : "IMobileScreen:LayoutProbeScreen/") + owner;
        var first = Read(host, Path.Combine(work, "created.oml"), owner);
        Assert.Equal(first.Length, first.Select(n => (n.X, n.Y)).Distinct().Count());
        Anvil.Reading.FlowEntry ReadText(string name) => host.BuildFlow(File.ReadAllBytes(Path.Combine(work, name + ".oml")), "", lane).Actions.Single(a => a.Name == "TextLayoutProbe" || a.Name.EndsWith("/TextLayoutProbe"));
        var entry = ReadText("created");
        Assert.Equal(entry.TextSha, created["results"]![0]!["result"]!["flow"]![0]!["textSha"]!.ToString());
        var valueOnly = Run(Path.Combine(work, "created.oml"), Text(entry.Text.Replace("Result = True", "Result = not Flag"), entry.TextSha), "value-only");
        Assert.Empty(valueOnly["automaticLayouts"]!.AsArray());
        Assert.Equal(first, Read(host, Path.Combine(work, "value-only.oml"), owner));
        entry = ReadText("value-only");
        var assignment = entry.Text.Split('\n').First(l => l.TrimStart().StartsWith("assign "));
        var insertion = new string(' ', assignment.Length - assignment.TrimStart().Length) + "assign Result = Flag\n";
        var inserted = Run(Path.Combine(work, "value-only.oml"), Text(entry.Text.Replace(assignment + "\n", insertion + assignment + "\n"), entry.TextSha), "inserted");
        Assert.Single(inserted["automaticLayouts"]!.AsArray());
        var withNewNode = Read(host, Path.Combine(work, "inserted.oml"), owner);
        Assert.Equal(first.Length + 1, withNewNode.Length);
        Assert.Equal(withNewNode.Length, withNewNode.Select(n => (n.X, n.Y)).Distinct().Count());
        var repeated = Run(Path.Combine(work, "inserted.oml"), new JsonArray(new JsonObject { ["op"] = "layout", ["target"] = owner }), "repeated");
        Assert.Equal(0, repeated["results"]![0]!["result"]!["moved"]!.GetValue<int>());
        entry = ReadText("repeated");
        var added = entry.Text.Split('\n').Single(l => l.Contains("assign Result = Flag @"));
        var removed = Run(Path.Combine(work, "repeated.oml"), Text(entry.Text.Replace(added + "\n", ""), entry.TextSha), "removed");
        Assert.Single(removed["automaticLayouts"]!.AsArray());
        Assert.Equal(first, Read(host, Path.Combine(work, "removed.oml"), owner));
    }

    [Theory]
    [InlineData("IServerAction")]
    [InlineData("IClientAction")]
    [InlineData("IScreenAction")]
    public void RawAuthoringSeparatesOptionalBranchAndEndsWithoutLayoutOp(string actionType)
    {
        var assembly = typeof(ModelHost).Assembly;
        var binder = assembly.GetType("Anvil.Core.StudioAssembliesOdc") ?? assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var bind = binder.GetMethod("Bind")!;
        bind.Invoke(null, bind.GetParameters().Select(_ => (object?)null).ToArray());
        var root = Path.GetDirectoryName(typeof(AutomaticFlowLayoutTests).Assembly.Location)!;
        while (!File.Exists(Path.Combine(root, "MANIFESTO.md"))) root = Path.GetDirectoryName(root)!;
        var fixture = StudioAdapter.Runtime.Platform == "odc" ? "odc/insurance-reactive-r8.oml" : "reactive-ui.oml";
        var work = Path.Combine(root, ".local/automatic-layout-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var basis = Path.Combine(root, "tests/fixtures", fixture);
        var output = Path.Combine(work, "created.oml");
        var ops = JsonNode.Parse("""
        [
          {"op":"create","parent":"@espace","type":"IServerAction","name":"AutomaticLayoutProbe","as":"$action"},
          {"op":"create","parent":"$action","type":"IInputParameter","name":"Flag","as":"$flag"},
          {"op":"set","target":"$flag","prop":"DataType","value":"Boolean"},
          {"op":"create","parent":"$action","type":"ILocalVariable","name":"Result","as":"$result"},
          {"op":"set","target":"$result","prop":"DataType","value":"Boolean"},
          {"op":"create","parent":"$action","type":"IStartNode","as":"$start"},
          {"op":"create","parent":"$action","type":"IIfNode","as":"$if"},
          {"op":"set","target":"$if","prop":"Condition","value":"Flag"},
          {"op":"create","parent":"$action","type":"IAssignNode","as":"$assign"},
          {"op":"create","parent":"$assign","type":"IAssignment","as":"$assignment"},
          {"op":"set","target":"$assignment","prop":"Variable","value":"Result"},
          {"op":"set","target":"$assignment","prop":"Value","value":"True"},
          {"op":"create","parent":"$action","type":"IEndNode","as":"$end"},
          {"op":"link","from":"$start","to":"$if"},
          {"op":"link","from":"$if","connector":"TrueTarget","to":"$assign"},
          {"op":"link","from":"$if","connector":"FalseTarget","to":"$end"},
          {"op":"link","from":"$assign","to":"$end"}
        ]
        """)!.AsArray();
        ops[0]!["type"] = actionType;
        if (actionType == "IScreenAction")
        {
            ops[0]!["parent"] = "$screen";
            ops.Insert(0, JsonNode.Parse("""{"op":"create","parent":"$flow","type":"IMobileScreen","name":"LayoutProbeScreen","as":"$screen"}"""));
            ops.Insert(0, JsonNode.Parse("""{"op":"create","parent":"@espace","type":"IMobileFlow","name":"LayoutProbeFlow","as":"$flow"}"""));
        }
        JsonNode Run(string source, JsonArray operations, string destination)
        {
            var job = Path.Combine(work, Guid.NewGuid().ToString("N") + ".json");
            File.WriteAllText(job, new JsonObject { ["ops"] = operations }.ToJsonString());
            return JsonSerializer.SerializeToNode(JobRunner.Run(host, source, job, destination))!;
        }
        var result = Run(basis, ops, output);
        Assert.True(result["isValid"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Equal(FlowLayout.EngineRevision, result["flowLayoutEngine"]!.ToString());
        Assert.NotEmpty(result["automaticLayouts"]!.AsArray());
        var owner = actionType + ":AutomaticLayoutProbe";
        var first = Read(host, output, owner);
        var decision = first.Single(n => n.Type == "IIfNode");
        var body = first.Single(n => n.Key == decision.True);
        var otherwise = first.Single(n => n.Key == decision.False);
        Assert.Equal("IEndNode", otherwise.Type);
        Assert.NotEqual(body.X, otherwise.X);
        Assert.NotEqual(body.Target, otherwise.Key);
        Assert.Equal(2, first.Count(n => n.Type == "IEndNode"));
        Assert.Equal(first.Length, first.Select(n => (n.X, n.Y)).Distinct().Count());

        // Read-only jobs and unrelated edits preserve a manually positioned flow.
        var readOnly = Path.Combine(work, "read-only.oml");
        var read = Run(output, new JsonArray(new JsonObject { ["op"] = "get", ["target"] = owner }), readOnly);
        Assert.Empty(read["automaticLayouts"]!.AsArray());
        Assert.Equal(first, Read(host, readOnly, owner));
        var unrelated = Path.Combine(work, "unrelated.oml");
        var other = Run(readOnly, new JsonArray(new JsonObject { ["op"] = "set", ["target"] = owner, ["prop"] = "Description", ["value"] = "Unrelated metadata" }), unrelated);
        Assert.Empty(other["automaticLayouts"]!.AsArray());
        Assert.Equal(first, Read(host, unrelated, owner));

        // Coordinates changed through raw maintenance are normalized on completion.
        var moved = Path.Combine(work, "moved.oml");
        var repaired = Run(unrelated, new JsonArray(new JsonObject { ["op"] = "move", ["target"] = "@" + body.Key, ["x"] = 0, ["y"] = 0 }), moved);
        Assert.NotEmpty(repaired["automaticLayouts"]!.AsArray());
        Assert.Equal(first, Read(host, moved, owner));
        var again = Path.Combine(work, "again.oml");
        var repeated = Run(moved, new JsonArray(new JsonObject { ["op"] = "layout", ["target"] = owner }), again);
        Assert.Equal(0, repeated["results"]![0]!["result"]!["moved"]!.GetValue<int>());
        Assert.Equal(0, repeated["results"]![0]!["result"]!["separatedEnds"]!.GetValue<int>());
    }

    private record Node(string Key, string Type, int X, int Y, string Target, string True, string False);
    private static Node[] Read(ModelHost host, string path, string action)
    {
        var model = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [path])!;
        try
        {
            var session = Activator.CreateInstance(typeof(ModelSession), model)!;
            var owner = typeof(ModelSession).GetMethod("Resolve")!.Invoke(session, [action])!;
            return ((IEnumerable)ModelHost.Prop(owner, "Nodes")!).Cast<object>().Select(n =>
            {
                string K(string p) => ModelHost.Prop(ModelHost.Prop(n, p) ?? new object(), "ObjectKey")?.ToString() ?? "";
                var type = new[] { "IStartNode", "IEndNode", "IIfNode", "IAssignNode" }.First(t => n.GetType().GetInterfaces().Any(i => i.Name == t));
                return new Node(ModelHost.Prop(n, "ObjectKey")!.ToString()!, type,
                    (int)ModelHost.Prop(n, "HorizontalPosition")!, (int)ModelHost.Prop(n, "VerticalPosition")!, K("Target"), K("TrueTarget"), K("FalseTarget"));
            }).OrderBy(n => n.Key).ToArray();
        }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [model]); }
    }
}
