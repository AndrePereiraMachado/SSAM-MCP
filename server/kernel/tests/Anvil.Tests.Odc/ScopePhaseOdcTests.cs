using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// R1 (escopo-kernel, 2026-10-24): the mirror on the ODC lane of ScopePhaseTests (the scope phase is shared source): the
/// same module index in memory, the rules that read only the job and the index (CALL_UNKNOWN, SCOPE_BLOCKED_BY_REFUSED_OP,
/// OWNER_CHILD_EXISTS, WIDGET_REQUIRED_PROPERTY) answer the same on lane odc. Pure: no Studio.
/// </summary>
public class ScopePhaseOdcTests
{
    private sealed class Node(string key, string kind, string name = "", string? dataType = null)
    {
        public string Key = key, Kind = kind, Name = name; public string? DataType = dataType;
        public Node? Parent; public List<Node> Children = [];
        public Node Add(Node child) { child.Parent = this; Children.Add(child); return child; }
    }

    private sealed class Reader : ModelReader<Node>
    {
        protected override IEnumerable<Node> Referrers(Node n) => [];
        protected override IEnumerable<Node> Children(Node n) => n.Children;
        protected override Node? Parent(Node n) => n.Parent;
        protected override string Key(Node n) => n.Key;
        protected override string Kind(Node n) => n.Kind;
        protected override string Name(Node n) => n.Name;
        protected override string? Label(Node n) => null;
        protected override IReadOnlySet<string> KindNames(Node n) => new HashSet<string> { "I" + n.Kind };
        protected override string? Expression(object value) => null;
        protected override IEnumerable<(string Name, Func<object?> Read)> Properties(Node n)
        {
            yield return ("Name", () => n.Name);
            if (n.DataType != null) yield return ("DataType", () => n.DataType);
        }
    }

    private static int keys;
    private const string Lane = "odc";

    private static IndexBaseFacts Facts(JsonArray ops)
    {
        var root = new Node("root" + (++keys), "ESpace", "App_UI");
        var flow = root.Add(new("flow", "MobileFlow", "MainFlow"));
        var home = flow.Add(new("home", "MobileScreen", "Home"));
        home.Add(new("home.save", "ScreenAction", "Save"));
        root.Add(new("get", "ServerAction", "GetOrders"));
        root.Add(new("order", "Entity", "Order")).Add(new("order.id", "EntityAttribute", "Id", "Long Integer"));
        root.Add(new("cs", "Reference", "Orders_CS")).Add(new("cs.list", "ServerActionSignature", "ListOrders"));
        var index = ModuleIndex.Build(root, new Reader(), "App_UI", Lane, "kernel", new string('d', 63) + (keys % 10), 1000);
        return new IndexBaseFacts(new StaticBasis { Lane = Lane, Module = index, Fresh = true }, ops);
    }

    private static ScopePhase.Result Run(JsonArray ops, JsonObject? preflight = null)
        => ScopePhase.Run(ops, "/ops", Lane, Facts(ops), preflight ?? new JsonObject { ["problems"] = new JsonArray() });

    private static JsonArray Ops(params string[] ops) => new(ops.Select(o => JsonNode.Parse(o)).ToArray());
    private static string Logic(string text) => new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(text) } }.ToJsonString();
    private static List<JsonObject> Code(ScopePhase.Result r, string code) => r.Problems.Where(p => p["code"]!.ToString() == code).ToList();

    [Fact]
    public void CallsResolveAndAnUnknownElementIsRefusedWithThePatch()
    {
        Assert.Empty(Code(Run(Ops(Logic("server action Report\n  Orders = GetOrders()\n  Listed = Orders_CS.ListOrders()\n  end\n"))), "CALL_UNKNOWN"));
        var typo = Assert.Single(Code(Run(Ops(Logic("server action Report\n  Listed = Orders_CS.ListOrder()\n  end\n"))), "CALL_UNKNOWN"));
        Assert.Equal("scope", typo["phase"]!.ToString());
        Assert.Contains("Orders_CS.ListOrders()", typo["patch"]![0]!["value"]!.ToString());
        Assert.Single(Code(Run(Ops(Logic("server action Report\n  Message = Unreferenced_CS.Notify()\n  end\n"))), "CALL_UNKNOWN"));
    }

    [Fact]
    public void AButtonWithoutDestinationAndALinkWithoutItsTextChild()
    {
        var bare = Ops("""{"op":"create","parent":"IMobileScreen:Home","type":"IButton","as":"$b"}""");
        Assert.Single(Code(Run(bare), "WIDGET_REQUIRED_PROPERTY"));
        Assert.Empty(Code(Run(Ops("""{"op":"create","parent":"IMobileScreen:Home","type":"IButton","as":"$b"}""",
            """{"op":"set","target":"$b/OnClick","prop":"Destination","value":"IMobileScreen:Home/IScreenAction:Save"}""")), "WIDGET_REQUIRED_PROPERTY"));
        var link = Ops("""{"op":"create","parent":"IWebScreen:Home","type":"ILinkWidget","as":"$l"}""", """{"op":"set","target":"$l/#ITextWidget","prop":"Text","value":"Abrir"}""");
        Assert.Single(ScopePhase.Normalize(link, "/ops", Lane, Facts(link)));
        Assert.Equal("ITextWidget", link[1]!["type"]!.ToString());
    }

    [Fact]
    public void TheCreationMapsOfTheO11StudioDoNotJudgeAnOdcModule()
    {
        // widget-placeholder-minimal, block-reuse, delete-block: a placeholder of a block under a container of that block.
        var ops = Ops("""{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileBlock","name":"Card","as":"$card"}""",
            """{"op":"create","parent":"$card","type":"IContainer","as":"$box"}""",
            """{"op":"create","parent":"$box","type":"IPlaceholderWidget","name":"Content","as":"$ph"}""");
        Assert.Empty(Code(Run(ops), "ACTION_KIND_NODE"));
    }

    [Fact]
    public void ARefusedOpBlocksWhatNeedsItsDeclarations()
    {
        var ops = Ops(
            """{"op":"create","parent":"IMobileScreen:Home","type":"IButton","as":"$b"}""",
            Logic("action Home.Approve\n  end\n"),
            """{"op":"set","target":"$b/OnClick","prop":"Destination","value":"IMobileScreen:Home/IScreenAction:Approve"}""");
        var preflight = new JsonObject { ["problems"] = new JsonArray(new JsonObject { ["op"] = 1, ["code"] = "FLOW_SYNTAX", ["severity"] = "error" }) };
        var blocked = Assert.Single(Code(Run(ops, preflight), ScopePhase.Blocked));
        Assert.Equal([0, 2], blocked["blockedOps"]!.AsArray().Select(o => o!.GetValue<int>()).Order().ToList());
    }
}
