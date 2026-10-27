using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// L3c (scope-odc, 2026-10-24): the refusals of the ODC platform the scope phase says before the first op (OdcScopeRules),
/// each with the code the apply would have answered (predicts) and, when the fix is mechanical, its patch. The same module
/// index in memory as ScopePhaseOdcTests, with the module type of an app or of a library in its digest. Pure: no Studio.
/// </summary>
public class ScopeOdcPlatformTests
{
    private sealed class Node(string key, string kind, string name = "")
    {
        public string Key = key, Kind = kind, Name = name;
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
        protected override IEnumerable<(string Name, Func<object?> Read)> Properties(Node n) { yield return ("Name", () => n.Name); }
    }

    private static int keys;
    private const string Lane = "odc";

    private static IndexBaseFacts Facts(JsonArray ops, string moduleType)
    {
        var root = new Node("root" + (++keys), "ESpace", "App_UI");
        root.Add(new("flow", "MobileFlow", "MainFlow")).Add(new("home", "MobileScreen", "Home"));
        root.Add(new("get", "ServerAction", "GetOrders"));
        root.Add(new("img", "Image", "Logo"));
        var index = ModuleIndex.Build(root, new Reader(), "App_UI", Lane, "kernel", new string('e', 63) + (keys % 10), 1000);
        var digest = new JsonObject { ["module"] = new JsonObject { ["name"] = "App_UI", ["kind"] = moduleType } };
        return new IndexBaseFacts(new StaticBasis { Lane = Lane, Module = index, Digest = digest, Fresh = true }, ops);
    }

    private static ScopePhase.Result Run(JsonArray ops, string moduleType = "CrossDevice", string lane = Lane)
        => ScopePhase.Run(ops, "/ops", lane, Facts(ops, moduleType), new JsonObject { ["problems"] = new JsonArray() });

    private static JsonArray Ops(params string[] ops) => new(ops.Select(o => JsonNode.Parse(o)).ToArray());
    private static string Logic(string text) => new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(text) } }.ToJsonString();
    private static string Ddl(string text) => new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = text } }.ToJsonString();
    private static List<JsonObject> Code(ScopePhase.Result r, string code) => r.Problems.Where(p => p["code"]!.ToString() == code).ToList();

    [Fact]
    public void APublicServerActionOfAnAppIsRefusedInEveryFormAndALibraryKeepsIt()
    {
        var ops = Ops("""{"op":"set","target":"IServerAction:GetOrders","prop":"Public","value":true}""",
            Logic("server action Report public\n  end\n"),
            """{"op":"logic","data":{"actions":[{"name":"Build","public":true,"steps":[]}]}}""",
            """{"op":"create","parent":"@espace","type":"IServerAction","name":"Made","as":"$made"}""",
            """{"op":"set","target":"$made","prop":"Public","value":"True"}""");
        var refused = Code(Run(ops), "ODC_SERVER_ACTION_PUBLIC");
        Assert.Equal(["/ops/0/value", "/ops/1/data/flow/0", "/ops/2/data/actions/0/public", "/ops/4/value"], refused.Select(p => p["pointer"]!.ToString()).ToList());
        Assert.All(refused, p =>
        {
            Assert.Equal("scope", p["phase"]!.ToString());
            Assert.Equal("APPLY_FAILED", p["predicts"]!.ToString());
            // The apply's own words (jobs-odc-negative/public-server-action-in-app.json reads them).
            Assert.Contains("ODC apps do not expose public server actions", p["message"]!.ToString());
            Assert.Contains("use a service action to serve other apps, or move it to a library", p["fix"]!.ToString());
        });
        Assert.Empty(Code(Run(ops, "ReactiveLibrary"), "ODC_SERVER_ACTION_PUBLIC"));
        // A service action is the API of the app: it stays public; Public false is no refusal.
        Assert.Empty(Code(Run(Ops(Logic("service action Report public\n  end\n"),
            """{"op":"set","target":"IServerAction:GetOrders","prop":"Public","value":false}""")), "ODC_SERVER_ACTION_PUBLIC"));
        // The same job on the O11 lane is not judged by these rules.
        Assert.Empty(Code(Run(ops, lane: "o11"), "ODC_SERVER_ACTION_PUBLIC"));
    }

    [Fact]
    public void ASessionVariableAndALocalizedImageDoNotExistInOdc()
    {
        var session = Assert.Single(Code(Run(Ops("""{"op":"create","parent":"@espace","type":"ISessionVariable","name":"Cart","as":"$sv"}""")), "ODC_SESSION_VARIABLE"));
        Assert.Contains("create Cart", session["message"]!.ToString());
        Assert.Contains("Session Variable objects can't be children of App objects", session["message"]!.ToString());
        Assert.Contains("Session Variable objects can't be children of Library objects",
            Assert.Single(Code(Run(Ops("""{"op":"create","parent":"@espace","type":"ISessionVariable","name":"Cart"}"""), "ReactiveLibrary"), "ODC_SESSION_VARIABLE"))["message"]!.ToString());
        var text = Assert.Single(Code(Run(Ops(Ddl("session variable Cart: Text\n"))), "ODC_SESSION_VARIABLE"));
        Assert.Equal("/ops/0/data/ddl", text["pointer"]!.ToString());
        Assert.Equal("DDL_APPLY_FAILED", text["predicts"]!.ToString());
        var image = Assert.Single(Code(Run(Ops("""{"op":"create","parent":"IImage:Logo","type":"ILocalizedImage","as":"$pt"}""")), "ODC_LOCALIZED_IMAGE"));
        Assert.Contains("Localized Image objects can't be children of Image objects", image["message"]!.ToString());
        Assert.Empty(Code(Run(Ops(Ddl("client variable Cart: Text\n"))), "ODC_SESSION_VARIABLE"));
    }

    [Fact]
    public void AReferenceToUserKeepsOnlyIgnoreAndTheDefaultIsIgnore()
    {
        var text = "create entity Hub (\n  Id Long Integer identifier auto required,\n  Owner User Identifier required references User on delete Protect,\n  Name Text(50)\n);\n";
        var forced = Assert.Single(Code(Run(Ops(Ddl(text))), "ODC_DELETE_RULE_FORCED"));
        Assert.Equal("ODC_DELETE_RULE_FORCED", forced["predicts"]!.ToString());
        Assert.Contains("Hub.Owner", forced["message"]!.ToString());
        var patch = forced["patch"]!.AsArray().Single()!.AsObject();
        Assert.Equal("/ops/0/data/ddl", patch["path"]!.ToString());
        Assert.Contains("references User on delete Ignore", patch["value"]!.ToString());
        Assert.DoesNotContain("Protect", patch["value"]!.ToString());
        // The bench a frio Naval (36 references to User with Protect): one problem for the text, one patch for every line.
        var two = "create entity Task (\n  Id Long Integer identifier auto required,\n  CreatedBy User Identifier references User on delete Protect,\n"
            + "  Assignee User Identifier required references User on delete Delete\n);\n";
        var both = Assert.Single(Code(Run(Ops(Ddl(two))), "ODC_DELETE_RULE_FORCED"));
        Assert.Contains("2 attribute(s)", both["message"]!.ToString());
        Assert.Contains("line 4 Task.Assignee (Delete)", both["message"]!.ToString());
        Assert.Equal(two.Replace("delete Protect", "delete Ignore").Replace("delete Delete", "delete Ignore"), both["patch"]![0]!["value"]!.ToString());
        // No rule written: the kernel writes Ignore (ODC_DELETE_RULE_IGNORE in the receipt), the accepted form of the lab.
        Assert.Empty(Code(Run(Ops(Ddl("create entity Hub (\n  Id Long Integer identifier auto required,\n  Owner User Identifier required\n);\n"))), "ODC_DELETE_RULE_FORCED"));
        Assert.Empty(Code(Run(Ops(Ddl(text.Replace("Protect", "Ignore")))), "ODC_DELETE_RULE_FORCED"));
        // An entity of the job named User is its own: Protect is its own rule.
        Assert.Empty(Code(Run(Ops(Ddl("create entity User (\n  Id Long Integer identifier auto required\n);\n" + text))), "ODC_DELETE_RULE_FORCED"));
    }

    /// <summary>The ODC Studio bound and its widget plugins loaded with a first model (as in a delivery, before Normalize and
    /// the scope phase); false without the Studio installed.</summary>
    private static bool OdcStudioLoaded()
    {
        try { StudioAssembliesOdc.Bind(null); } catch { return false; }
        if (!Directory.Exists(StudioAssembliesOdc.Directory)) return false;
        var root = Path.GetDirectoryName(typeof(ScopeOdcPlatformTests).Assembly.Location);
        while (root != null && !File.Exists(Path.Combine(root, "MANIFESTO.md"))) root = Path.GetDirectoryName(root);
        var host = new ModelHost(Path.Combine(root!, ".local", "lane-odc", "test-work", "scope-odc"));
        ModelHost.Release(host.Load(File.ReadAllBytes(Path.Combine(root!, "tests", "fixtures", "odc", "blank-mobile.oml"))));
        return true;
    }

    [Fact]
    public void ATraditionalWidgetHasNoClassInAnOdcModule()
    {
        // Lab 110 (a Reactive app): create IExpressionWidget, "Couldn't find any concrete class"; the twelve Traditional-only types
        // answer the same under a screen of insurance-reactive-r8 (24/10/2026), the ones with a Mobile interface are created.
        if (!OdcStudioLoaded()) return;
        var ops = Ops("""{"op":"create","parent":"IMobileScreen:Home","type":"IExpressionWidget","name":"Label","as":"$e"}""",
            """{"op":"create","parent":"IMobileScreen:Home","type":"IContainerWidget","as":"$c"}""",
            """{"op":"create","parent":"IMobileScreen:Home","type":"ITextWidget","as":"$t"}""",
            """{"op":"create","parent":"IMobileScreen:Home","type":"IIfWidget","as":"$if"}""",
            """{"op":"create","parent":"$c","type":"IPlaceholderWidget","as":"$ph"}""");
        var refused = Code(Run(ops), "ODC_TRADITIONAL_WIDGET");
        Assert.Equal(["/ops/0/type", "/ops/1/type"], refused.Select(p => p["pointer"]!.ToString()).ToList());
        Assert.Equal("IExpression", refused[0]["patch"]![0]!["value"]!.ToString());
        Assert.Equal("IContainer", refused[1]["patch"]![0]!["value"]!.ToString());
        Assert.All(refused, p => Assert.Equal("APPLY_FAILED", p["predicts"]!.ToString()));
        Assert.Empty(Code(Run(ops, "AIAgent"), "ODC_TRADITIONAL_WIDGET"));
    }

    [Fact]
    public void TheClassOfAnIfGoesOnAContainerOfWhatItShowsInOdcToo()
    {
        // Lab 103 (a Reactive app, 22/10/2026), replayed today: HTML_INVALID "IIfWidget.Style takes no expression here". The ODC
        // Model API is what says the If has no Style: without the ODC Studio bound nothing is judged.
        if (!OdcStudioLoaded()) return;
        var facts = Anvil.Core.Preflight.ModelTypes.Of("IIfWidget", Lane);
        Assert.NotNull(facts);
        Assert.False(facts!.Knows("Style"));
        var ops = Ops(new JsonObject { ["op"] = "html", ["parent"] = "IMobileFlow:MainFlow", ["data"] = new JsonObject
            { ["html"] = "<screen name=\"Home\"><div if=\"True\" class=\"card\"><span>x</span></div></screen>" } }.ToJsonString());
        var entry = Assert.Single(ScopePhase.Normalize(ops, "/ops", Lane, Facts(ops, "CrossDevice")));
        Assert.Equal("IF_CLASS_MOVED", entry["rule"]!.ToString());
        Assert.Equal("<screen name=\"Home\"><div if=\"True\"><div class=\"card\"><span>x</span></div></div></screen>", ops[0]!["data"]!["html"]!.ToString());
    }

    [Fact]
    public void ANavigateToRedirectToUrlIsTheSystemsDestination()
    {
        // Labs 228 and 242 (accepted): the module has no screen RedirectToURL and no reference to it; the apply binds the System's.
        var ops = Ops(Logic("action Home.Go\n  navigate RedirectToURL(URL=\"https://example.test\")\n"));
        Assert.Empty(Code(Run(ops), "CALL_UNKNOWN"));
        Assert.Single(Code(Run(Ops(Logic("action Home.Go\n  navigate Elsewhere()\n"))), "CALL_UNKNOWN"));
    }

    [Fact]
    public void ASettingKeepsNoSizeAndThePatchDropsIt()
    {
        // Labs 17 and 258 (an API contracts library, a reconciliation app): DDL_APPLY_FAILED "ISiteProperty has no writable Length".
        var text = "setting ApiBaseUrl: Text(250) = \"https://example.test\"\nsetting Limit: Decimal(18,2) = 1000.00\nsetting Pages: Integer = 100\n";
        // One problem for the op (the pointer is the text), naming both settings, with one patch.
        var sized = Assert.Single(Code(Run(Ops(Ddl(text))), "ODC_SETTING_SIZE"));
        Assert.Equal("DDL_APPLY_FAILED", sized["predicts"]!.ToString());
        Assert.Contains("line 1 ApiBaseUrl (Length 250)", sized["message"]!.ToString());
        Assert.Contains("line 2 Limit", sized["message"]!.ToString());
        var patched = sized["patch"]!.AsArray().Single()!["value"]!.ToString();
        Assert.Equal("setting ApiBaseUrl: Text = \"https://example.test\"\nsetting Limit: Decimal = 1000.00\nsetting Pages: Integer = 100\n", patched);
        Assert.Empty(Code(Run(Ops(Ddl(patched))), "ODC_SETTING_SIZE"));
        // An entity attribute keeps its Length.
        Assert.Empty(Code(Run(Ops(Ddl("create entity Hub (\n  Id Long Integer identifier auto required,\n  Name Text(50)\n);\n"))), "ODC_SETTING_SIZE"));
    }
}
