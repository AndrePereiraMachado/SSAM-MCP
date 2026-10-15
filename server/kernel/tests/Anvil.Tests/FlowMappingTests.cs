using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The O11 record mapping in ssam-flow/1: an assignment or an argument whose source type is not its target's keeps a native
/// TypeConversion (ServiceStudio.Model, beside the expression, never a child nor a Model API property), and the text reads
/// and writes it as ODC prints its mapping: "Source mapTo { Field: value, ... }". These tests run real O11 jobs on the blank
/// service fixture (JobRunner: apply, Verify, save): a mapping the text writes is the native one (the Verify accepts the
/// module; an unfilled conversion would be ExpressionMissingTypeConversion, a mapTo left in the expression
/// ParserUnexpectedElement), reads back as the text, and an edit writes only its fields. The pure parts (the reader's rules,
/// Compose and SameMapping) run without the Studio.
/// </summary>
public sealed class FlowMappingTests
{
    private const string Fixture = "blank-service.oml";

    private const string Spec = """
        {"op":"spec","data":{"structures":[
          {"name":"SrcRow","attributes":[{"name":"Code","type":"Text","length":50},{"name":"Amount","type":"Decimal"},{"name":"Note","type":"Text","length":50}]},
          {"name":"DstRow","attributes":[{"name":"Key","type":"Text","length":50},{"name":"Total","type":"Decimal"},{"name":"Label","type":"Text","length":50}]},
          {"name":"SubRow","attributes":[{"name":"Code","type":"Text","length":50},{"name":"Amount","type":"Decimal"}]}],
         "entities":[{"name":"MapOrder","attributes":[{"name":"Title","type":"Text","length":50},{"name":"Qty","type":"Integer"}]}]}}
        """;

    // Every kind of mapping the text writes: a list assigned to a list of another structure, a record to a record, and
    // ListAppendAll from a list of another structure and from an aggregate (its record of one entity, read relative to the item).
    private const string Action = """
        server action MapAll
          in Src: SrcRow List
          in SrcOne: SrcRow
          out Dst: DstRow List
          out One: DstRow
          local Rows: DstRow List
          assign Dst = Src mapTo { Key: Code, Total: Amount + 1 }
          assign One = SrcOne mapTo { Label: Note }
          GetOrders = aggregate FROM MapOrder WHERE (MapOrder.Qty > 0) MAX 10
          AppendSrc = (System).ListAppendAll(List=Rows, SourceList=Src mapTo { Key: Code })
          AppendOrders = (System).ListAppendAll(List=Rows, SourceList=GetOrders.List mapTo { Key: MapOrder.Title, Total: MapOrder.Qty })
          end

        """;

    private static string Scratch()
    {
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "flow-mapping-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir); return dir;
    }

    private static JsonNode Run(string dir, string name, string job, string? basePath = null)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), basePath, path, Path.Combine(dir, name + ".oml")))!;
    }

    private static JsonArray Refused(string dir, string name, string job, string? basePath = null)
    {
        var error = Assert.ThrowsAny<Exception>(() => Run(dir, name, job, basePath));
        var coded = Errors.FindCoded(error);
        Assert.True(coded != null, Errors.Text(error));
        return coded!.Problems!;
    }

    private static FlowEntry Read(string dir, string name, string action)
    {
        var bytes = File.ReadAllBytes(Path.Combine(dir, name + ".oml"));
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        var entry = new ModelHost(Path.Combine(dir, "work")).BuildFlow(bytes, sha, "o11").Actions.Single(a => a.Name == action);
        Assert.True(entry.FixedPoint, string.Join("\n", entry.Problems));
        Assert.True(entry.Opaque is null or { Count: 0 }, string.Join("\n", entry.Opaque ?? []));
        return entry;
    }

    private static string Flow(string text, string? basedOn = null) => new JsonObject { ["op"] = "logic", ["data"] = new JsonObject {
        ["flow"] = new JsonArray(basedOn == null ? JsonValue.Create(text) : new JsonObject { ["text"] = text, ["basedOn"] = basedOn }) } }.ToJsonString();

    private static string Bare(string text) => Regex.Replace(text, @" @[A-Za-z0-9+/_=-]+$", "", RegexOptions.Multiline);

    private static void Accepted(JsonNode result) =>
        Assert.True(result["accepted"]!.GetValue<bool>() && result["isValid"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);

    private static string Base(string dir)
    {
        Accepted(Run(dir, "map-base", $$$"""{"base":"{{{Fixture}}}","ops":[{{{Spec}}},{{{Flow(Action)}}}]}"""));
        return Path.Combine(dir, "map-base.oml");
    }

    [Fact]
    public void TheTextWritesTheNativeMappingAndReadsItBack()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        Base(dir);
        // The Verify accepted the module: every conversion is filled (no ExpressionMissingTypeConversion) and no expression
        // holds mapTo (no ParserUnexpectedElement). The action reads as the text, mappings included.
        var read = Read(dir, "map-base", "MapAll");
        // A checkout with core.autocrlf writes this file (and so the raw literal) with CRLF; the text read is LF.
        Assert.Equal(Action.Replace("\r\n", "\n"), Bare(read.Text));
        // The same text again writes nothing.
        var again = Run(dir, "map-again", $$$"""{"ops":[{{{Flow(read.Text, read.TextSha)}}}]}""", Path.Combine(dir, "map-base.oml"));
        Accepted(again);
        Assert.Equal(0, again["results"]![0]!["result"]!["flow"]![0]!["ops"]!.AsObject().Count);
    }

    [Fact]
    public void AnEditOfAMappingWritesItsFieldsAndReadsBackInTheTargetsOrder()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var basePath = Base(dir);
        var read = Read(dir, "map-base", "MapAll");
        // Fields in another order, one dropped and one added; a value changed; the target of a mapped assignment changed with
        // a mapping for the new types (the conversion follows the Variable written after the Value).
        var text = read.Text
            .Replace("Dst = Src mapTo { Key: Code, Total: Amount + 1 }", "Dst = Src mapTo { Label: Note, Key: Code }")
            .Replace("Total: MapOrder.Qty }", "Total: MapOrder.Qty * 2 }")
            .Replace("  local Rows: DstRow List @l1\n", "  local Rows: DstRow List @l1\n  local Back: SrcRow\n")
            .Replace("assign One = SrcOne mapTo { Label: Note }", "assign Back = One mapTo { Note: Label, Code: Key }");
        var result = Run(dir, "map-edit", $$$"""{"ops":[{{{Flow(text, read.TextSha)}}}]}""", basePath);
        Accepted(result);
        var receipt = result["results"]![0]!["result"]!["flow"]![0]!;
        var after = Read(dir, "map-edit", "MapAll");
        Assert.Equal(receipt["textSha"]!.ToString(), after.TextSha);
        // The platform keeps the fields in the order of the target's attributes: the same mapping, read in that order.
        Assert.Contains("assign Dst = Src mapTo { Key: Code, Label: Note } @", after.Text);
        Assert.Contains("assign Back = One mapTo { Code: Key, Note: Label } @", after.Text);
        Assert.Contains("SourceList=GetOrders.List mapTo { Key: MapOrder.Title, Total: MapOrder.Qty * 2 })", after.Text);
        // Every element the edit kept keeps its key.
        Assert.All(read.Ids.Values, key => Assert.Contains(key, after.Ids.Values));
    }

    [Fact]
    public void AMappingTheTypesCannotTakeIsRefusedWithTheReason()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var basePath = Base(dir);
        var read = Read(dir, "map-base", "MapAll");
        // An attribute the target does not have: refused with the target's attributes, nothing kept.
        var unknown = Refused(dir, "map-unknown", $$$"""{"ops":[{{{Flow(read.Text.Replace("mapTo { Label: Note }", "mapTo { Caption: Note }"), read.TextSha)}}}]}""", basePath);
        var problem = Assert.Single(unknown);
        Assert.Equal("FLOW_MAPPING_TYPES", problem!["code"]!.ToString());
        Assert.Contains("has no attribute Caption (its attributes: Key, Total, Label)", problem["message"]!.ToString());
        // Two values of the same type need no mapping.
        var same = "server action MapSame\n  in A: DstRow\n  out B: DstRow\n  assign B = A mapTo { Key: Key }\n  end\n";
        var sameProblems = Refused(dir, "map-same", $$$"""{"ops":[{{{Flow(same)}}}]}""", basePath);
        Assert.Contains(sameProblems, p => p!["code"]!.ToString() == "FLOW_MAPPING_TYPES" && p["message"]!.ToString().Contains("no record conversion"));
        // A text that drops a mapping the types need: the conversion is left empty and the Verify refuses the module.
        var dropped = Run(dir, "map-dropped", $$$"""{"ops":[{{{Flow(read.Text.Replace("SrcOne mapTo { Label: Note }", "SrcOne"), read.TextSha)}}}]}""", basePath);
        Assert.False(dropped["isValid"]!.GetValue<bool>());
        Assert.Contains("ExpressionMissingTypeConversion", dropped.ToJsonString());
    }

    [Fact]
    public void AMappingOverARecordTheStudioMapsByItselfIsTheDevelopersUntilTheTextDropsIt()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var basePath = Base(dir);
        // SubRow has attributes of SrcRow under the same names: the Studio converts by itself (each from its namesake), an
        // automatic conversion the text does not write.
        var plain = "server action MapSub\n  in SrcOne: SrcRow\n  out Sub: SubRow\n  assign Sub = SrcOne\n  end\n";
        Accepted(Run(dir, "sub-base", $$$"""{"ops":[{{{Flow(plain)}}}]}""", basePath));
        var read = Read(dir, "sub-base", "MapSub");
        Assert.Equal(plain, Bare(read.Text));
        // A mapping written over it is the developer's: kept, valid, read back (the attribute left out stays empty).
        var mapped = read.Text.Replace("assign Sub = SrcOne", "assign Sub = SrcOne mapTo { Code: Note }");
        Accepted(Run(dir, "sub-mapped", $$$"""{"ops":[{{{Flow(mapped, read.TextSha)}}}]}""", Path.Combine(dir, "sub-base.oml")));
        var custom = Read(dir, "sub-mapped", "MapSub");
        Assert.Equal(Bare(mapped), Bare(custom.Text));
        // Dropped by the text: the Studio's own mapping comes back (valid, automatic again), not an empty one.
        Accepted(Run(dir, "sub-dropped", $$$"""{"ops":[{{{Flow(custom.Text.Replace(" mapTo { Code: Note }", ""), custom.TextSha)}}}]}""", Path.Combine(dir, "sub-mapped.oml")));
        Assert.Equal(plain, Bare(Read(dir, "sub-dropped", "MapSub").Text));
        // Written as the Studio's own mapping: accepted as the plain value, with the platform normalization listed.
        var same = Run(dir, "sub-default", $$$"""{"ops":[{{{Flow(read.Text.Replace("assign Sub = SrcOne", "assign Sub = SrcOne mapTo { Code: Code, Amount: Amount }"), read.TextSha)}}}]}""",
            Path.Combine(dir, "sub-base.oml"));
        Accepted(same);
        Assert.Contains(same["normalizations"]!.AsArray(), p => p!["rule"]!.ToString() == "FLOW_MAPPING_PLATFORM");
        Assert.Equal(plain, Bare(Read(dir, "sub-default", "MapSub").Text));
    }

    [Fact]
    public void ANewLoopThatOnlyMapsIsRefusedWithAMappingThatApplies()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var basePath = Base(dir);
        var loop = """
            server action MapLoop
              in Src: SrcRow List
              out Dst: DstRow List
              local Row: DstRow
              foreach Src:
                assign
                  Row.Key = Src.Current.Code
                  Row.Total = Src.Current.Amount
                (System).ListAppend(Element=Row, List=Dst)
                next
              end

            """;
        var problems = Refused(dir, "map-loop", $$$"""{"ops":[{{{Flow(loop)}}}]}""", basePath);
        var t2 = Assert.Single(problems, p => p!["code"]!.ToString() == "FLOW_FOREACH_LIST_ACTION")!;
        const string patch = "(System).ListAppendAll(List=Dst, SourceList=Src mapTo { Key: Code, Total: Amount })";
        Assert.True(t2["text"]?.ToString() == patch, problems.ToJsonString());
        // The patch in place of the loop: written as the native mapping, valid, read back as the text.
        var mapped = "server action MapLoop\n  in Src: SrcRow List\n  out Dst: DstRow List\n  " + patch + "\n  end\n";
        Accepted(Run(dir, "map-patched", $$$"""{"ops":[{{{Flow(mapped)}}}]}""", basePath));
        Assert.Equal(mapped, Bare(Read(dir, "map-patched", "MapLoop").Text));
    }

    // A mapping that leaves a mandatory attribute of the target empty (the Id of an entity) is what the Verify refuses
    // (AttributeMappingRequiredExpression): refused by the writer with the attributes and the value that fills them.
    [Fact]
    public void AMappingThatLeavesAMandatoryAttributeEmptyIsRefusedWithTheFix()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var basePath = Base(dir);
        var text = "server action MapRecord\n  in SrcOne: SrcRow\n  local Rec: MapOrder\n  assign Rec = SrcOne mapTo { Title: Code, Qty: 1 }\n  end\n";
        var problems = Refused(dir, "map-mandatory", $$$"""{"ops":[{{{Flow(text)}}}]}""", basePath);
        var problem = Assert.Single(problems, p => p!["code"]!.ToString() == "FLOW_MAPPING_TYPES")!;
        Assert.Contains("Id", problem["message"]!.ToString());
        Assert.Contains("Id: NullIdentifier()", problem["message"]!.ToString() + problem["fix"]);
        var filled = Flow(text.Replace("Qty: 1 }", "Qty: 1, Id: NullIdentifier() }"));
        Accepted(Run(dir, "map-mandatory-ok", $$$"""{"ops":[{{{filled}}}]}""", basePath));
    }

    // ---- without the Studio: the reader's rules over a synthetic action -------------------------------------------------

    private sealed class Node(string key, string kind, string name = "")
    {
        public readonly string Key = key, Kind = kind, Name = name;
        public Node? Parent;
        public readonly List<Node> Children = [];
        public readonly Dictionary<string, object?> Props = [];
        public NativeMapping? Mapping;
        public Node Add(Node child) { child.Parent = this; Children.Add(child); return child; }
        public Node Set(string property, object? value) { Props[property] = value; return this; }
    }
    private sealed record Code(string Text);

    private sealed class Reader(bool beside) : ModelReader<Node>
    {
        protected override IEnumerable<Node> Referrers(Node n) => [];
        protected override IEnumerable<Node> Children(Node n) => n.Children;
        protected override Node? Parent(Node n) => n.Parent;
        protected override string Key(Node n) => n.Key;
        protected override string Kind(Node n) => n.Kind;
        protected override string Name(Node n) => n.Name;
        protected override string? Label(Node n) => null;
        protected override IReadOnlySet<string> KindNames(Node n) => new HashSet<string> { n.Kind, "I" + n.Kind };
        protected override string? Expression(object value) => (value as Code)?.Text;
        protected override IEnumerable<(string Name, Func<object?> Read)> Properties(Node n) => n.Props.Select(p => (p.Key, (Func<object?>)(() => p.Value)));
        protected internal override NativeMapping? RecordMapping(Node node) => node.Mapping;
        protected internal override bool MappingsBeside => beside;
    }

    // An action with one assignment whose value is `value` and whose native mapping is `mapping`.
    private static (FlowItem Item, List<string> Problems, ModuleFlow Flow) ReadOne(string value, NativeMapping? mapping, bool beside = true)
    {
        var root = new Node("R", "ESpace", "M");
        var row = root.Add(new Node("T", "Structure", "Row"));
        var action = root.Add(new Node("A", "ServerAction", "Act"));
        var target = action.Add(new Node("L", "LocalVariable", "Target")).Set("DataType", row);
        action.Set("LocalVariables", new List<Node> { target });
        var start = action.Add(new Node("S", "StartNode")); var assign = action.Add(new Node("N", "AssignNode")); var end = action.Add(new Node("E", "EndNode"));
        start.Set("Target", assign); assign.Set("Target", end);
        var assignment = assign.Add(new Node("P", "Assignment")).Set("Variable", new Code("Target")).Set("Value", new Code(value));
        assignment.Mapping = mapping;
        assign.Set("Assignments", new List<Node> { assignment });
        var reader = new Reader(beside);
        var flow = ModuleFlow.Build(root, reader, "o11", "0", 0);
        var item = new FlowExtractor<Node>(reader, root).Action(action, out var problems);
        return (item, problems, flow);
    }

    [Fact]
    public void TheReaderWritesAnAuthoredMappingAsMapToAndLeavesTheAutomaticOneOut()
    {
        var (item, problems, flow) = ReadOne("Source", new(true, [("Key", "Code"), ("Total", "Amount + 1")]));
        Assert.Empty(problems);
        var entry = Assert.Single(flow.Actions);
        Assert.True(entry.FixedPoint, string.Join("; ", entry.Problems));
        Assert.Contains("  assign Target = Source mapTo { Key: Code, Total: Amount + 1 } @n1\n", entry.Text);
        // The automatic conversion (a SQL list wrapped in its structure, an aggregate record narrowed to its entity) is
        // derived from the two types: not written, counted.
        var (_, _, automatic) = ReadOne("Source", new(false, []));
        Assert.Contains("  assign Target = Source @n1\n", Assert.Single(automatic.Actions).Text);
        Assert.Equal(1, automatic.NotWritten["Assignment.ValueTypeConversion (automatic: the Studio derives it from the two types)"]);
        // A conversion whose attributes are all empty writes nothing (the Verify refuses it; the Studio recreates it empty).
        var (_, _, empty) = ReadOne("Source", new(true, []));
        Assert.Contains("  assign Target = Source @n1\n", Assert.Single(empty.Actions).Text);
    }

    [Fact]
    public void AMappingThatWouldNotReadBackWholeMakesItsNodeOpaque()
    {
        // A value with a space at its end would come back trimmed: the node is opaque (kept, never written).
        var (_, _, spaced) = ReadOne("Source", new(true, [("Key", "Code ")]));
        var entry = Assert.Single(spaced.Actions);
        Assert.Contains("opaque AssignNode", entry.Text);
        Assert.Contains(entry.Opaque!, p => p.Contains("is not text that reads back whole"));
        // O11: an expression whose own text holds mapTo is no mapping (its parser does not read it): opaque, never rewritten
        // into a native mapping. Where the mapping is the expression's text (ODC) it is read as it is.
        var (_, _, own) = ReadOne("Source mapTo { Key: Code }", null);
        Assert.Contains(Assert.Single(own.Actions).Opaque!, p => p.Contains("holds mapTo in its own expression text"));
        var (_, _, odc) = ReadOne("Source mapTo { Key: Code }", null, beside: false);
        Assert.Contains("  assign Target = Source mapTo { Key: Code } @n1\n", Assert.Single(odc.Actions).Text);
    }

    [Fact]
    public void ComposeAndSameMappingFollowTheGrammar()
    {
        Assert.Equal("S mapTo { A: x, B.C: If(a, b, c) }", FlowMapping.Compose("S", [("A", "x"), ("B.C", "If(a, b, c)")]));
        Assert.Null(FlowMapping.Compose("S", [("A", " x")]));
        Assert.Null(FlowMapping.Compose("S", [("A B", "x")]));
        Assert.Null(FlowMapping.Compose("", [("A", "x")]));
        Assert.Null(FlowMapping.Compose("S", []));
        Assert.True(FlowMapping.SameMapping("S mapTo { A: x, B: y }", "S mapTo { b: y, A: x }"));
        Assert.False(FlowMapping.SameMapping("S mapTo { A: x, B: y }", "S mapTo { A: x, B: z }"));
        Assert.False(FlowMapping.SameMapping("S mapTo { A: x }", "T mapTo { A: x }"));
        Assert.False(FlowMapping.SameMapping("S mapTo { A: x }", "S mapTo { A: x, B: y }"));
    }
}
