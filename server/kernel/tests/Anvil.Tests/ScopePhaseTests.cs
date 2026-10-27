using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R1 (escopo-kernel, 2026-10-24): the scope phase over a module index built in memory (the pattern of StaticChecksTests),
/// lane o11. Each rule with the case it refuses (code, phase scope, pointer, fix with candidates, patch when one correction
/// is certain) and the cases it leaves alone (a name the job declares, an element a reference op imports by key, a generator
/// op). The ODC mirror is ScopePhaseOdcTests. Pure: no Studio.
/// </summary>
public class ScopePhaseTests
{
    internal sealed class Node(string key, string kind, string name = "", string? dataType = null)
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

    /// <summary>A Reactive module: a screen Home (a variable, a screen action Save), a block Card, a server action GetOrders,
    /// an entity Order, and the references OutSystemsUI (block LayoutBlank) and Orders_CS (server action ListOrders).</summary>
    internal static IndexBaseFacts Facts(JsonArray ops, string lane)
    {
        var root = new Node("root" + (++keys), "ESpace", "App_UI");
        var flow = root.Add(new("flow", "MobileFlow", "MainFlow"));
        var home = flow.Add(new("home", "MobileScreen", "Home"));
        home.Add(new("home.v", "LocalVariable", "Filter", "Text"));
        home.Add(new("home.save", "ScreenAction", "Save"));
        flow.Add(new("card", "MobileBlock", "Card"));
        root.Add(new("get", "ServerAction", "GetOrders"));
        var order = root.Add(new("order", "Entity", "Order"));
        order.Add(new("order.id", "EntityAttribute", "Id", "Long Integer"));
        root.Add(new("osui", "Reference", "OutSystemsUI")).Add(new("osui.layout", "MobileBlockSignature", "LayoutBlank"));
        root.Add(new("cs", "Reference", "Orders_CS")).Add(new("cs.list", "ServerActionSignature", "ListOrders"));
        var index = ModuleIndex.Build(root, new Reader(), "App_UI", lane, "kernel", new string('c', 63) + (keys % 10), 1000);
        return new IndexBaseFacts(new StaticBasis { Lane = lane, Module = index, Fresh = true }, ops);
    }

    internal static ScopePhase.Result Run(string lane, JsonArray ops, JsonObject? preflight = null)
        => ScopePhase.Run(ops, "/ops", lane, Facts(ops, lane), preflight ?? new JsonObject { ["problems"] = new JsonArray() });

    internal static JsonArray Ops(params string[] ops) => new(ops.Select(o => JsonNode.Parse(o)).ToArray());
    internal static string Logic(string text) => new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(text) } }.ToJsonString();
    internal static List<JsonObject> Code(ScopePhase.Result r, string code) => r.Problems.Where(p => p["code"]!.ToString() == code).ToList();
    private const string Lane = "o11";

    // ---- CALL_UNKNOWN -----------------------------------------------------------------------------------------------------

    [Fact]
    public void ACallOfAModuleAReferenceOrTheJobResolves()
    {
        var r = Run(Lane, Ops(Logic("server action Report\n  out Total: Integer\n  Orders = GetOrders()\n  Listed = Orders_CS.ListOrders()\n  Done = Helper()\n  end\n"),
            Logic("server action Helper\n  end\n")));
        Assert.Empty(Code(r, ScopeRules.CallUnknown));
    }

    [Fact]
    public void AnElementAReferenceDoesNotHaveIsRefusedWithItsNamesAndTheCertainPatch()
    {
        // Names are compared as the platform compares them (case-insensitive): listorders is ListOrders.
        Assert.Empty(Code(Run(Lane, Ops(Logic("server action Report\n  Listed = Orders_CS.listorders()\n  end\n"))), ScopeRules.CallUnknown));
        var r = Run(Lane, Ops(Logic("server action Report\n  Listed = Orders_CS.ListOrder()\n  Other = Orders_CS.ArchiveOrders()\n  end\n")));
        var problems = Code(r, ScopeRules.CallUnknown);
        // ListOrder can mean only ListOrders: refused with the patch that writes it in the text of the action.
        var typo = Assert.Single(problems, p => p["message"]!.ToString().Contains("Orders_CS.ListOrder("));
        Assert.Equal("scope", typo["phase"]!.ToString());
        Assert.Equal("/ops/0/data/flow/0", typo["pointer"]!.ToString());
        Assert.Contains("Orders_CS.ListOrders()", typo["patch"]![0]!["value"]!.ToString());
        Assert.Contains("Orders_CS.ArchiveOrders()", typo["patch"]![0]!["value"]!.ToString());
        Assert.Equal("FLOW_NAME_UNKNOWN", typo["predicts"]!.ToString());
        // ArchiveOrders is no spelling of ListOrders: the candidates, no patch.
        var unknown = Assert.Single(problems, p => p["message"]!.ToString().Contains("ArchiveOrders"));
        Assert.Contains("ListOrders", unknown["fix"]!.ToString());
        Assert.Null(unknown["patch"]);
    }

    [Fact]
    public void AModuleTheBaseAndTheJobDoNotReferenceIsRefused()
    {
        var r = Run(Lane, Ops(Logic("server action Report\n  Message = RichWidgets.Feedback_Message(MessageText=\"x\")\n  end\n")));
        var problem = Assert.Single(Code(r, ScopeRules.CallUnknown));
        Assert.Contains("'RichWidgets' is no module this module references", problem["message"]!.ToString());
        // A reference op of the job that imports it settles it; one that imports by key leaves the producer open.
        Assert.Empty(Code(Run(Lane, Ops("""{"op":"reference","producer":"RichWidgets","elements":["IServerActionSignature:Feedback_Message"]}""",
            Logic("server action Report\n  Message = RichWidgets.Feedback_Message(MessageText=\"x\")\n  end\n"))), ScopeRules.CallUnknown));
        Assert.Empty(Code(Run(Lane, Ops("""{"op":"reference","producer":"Orders_CS","elements":["IServerActionSignature:@AbCdEfGhIjKlMnOpQrStUv"]}""",
            Logic("server action Report\n  Other = Orders_CS.ArchiveOrders()\n  end\n"))), ScopeRules.CallUnknown));
    }

    [Fact]
    public void AScreenActionOfAnOwnerAndANavigateResolveAgainstTheOwner()
    {
        Assert.Empty(Code(Run(Lane, Ops(Logic("action Home.Refresh\n  Home.Save()\n  navigate Home()\n"))), ScopeRules.CallUnknown));
        var r = Run(Lane, Ops(Logic("action Home.Refresh\n  Home.Saev()\n  navigate Hoem()\n")));
        var problems = Code(r, ScopeRules.CallUnknown);
        Assert.Contains(problems, p => p["message"]!.ToString().Contains("'Home' has no screen action or data action 'Saev'") && p["fix"]!.ToString().Contains("Save"));
        Assert.Contains(problems, p => p["message"]!.ToString().Contains("no screen of the module or of this job is named 'Hoem'"));
    }

    [Fact]
    public void ABareNameIsNotJudgedWhenAGeneratorOrAnOpenProducerMayMakeIt()
    {
        var refused = Run(Lane, Ops(Logic("server action Report\n  Done = FetchAddress()\n  end\n")));
        Assert.Single(Code(refused, ScopeRules.CallUnknown));
        Assert.Empty(Code(Run(Lane, Ops("""{"op":"rest-consume","data":{"url":"https://example.test/openapi.json"}}""",
            Logic("server action Report\n  Done = FetchAddress()\n  end\n"))), ScopeRules.CallUnknown));
        // Entity actions of a known entity and the System's list actions are callees too.
        Assert.Empty(Code(Run(Lane, Ops(Logic("server action Report\n  Created = CreateOrder(Source=Rec)\n  ListAppend(List=Items, Element=1)\n  end\n"))), ScopeRules.CallUnknown));
    }

    // ---- OWNER_CHILD_CREATED / OWNER_CHILD_EXISTS ---------------------------------------------------------------------------

    [Fact]
    public void AChildAWidgetIsNotBornWithIsCreatedBeforeItsFirstUse()
    {
        // Demandas_TW (4378014a, 61 refusals): `set $link/#ITextWidget Text` on a Traditional link the job creates.
        var ops = Ops("""{"op":"create","parent":"IWebScreen:Home","type":"ILinkWidget","as":"$l"}""",
            """{"op":"set","target":"$l/#ITextWidget","prop":"Text","value":"Abrir"}""",
            """{"op":"set","target":"$l/#ITextWidget","prop":"Style","value":"\"x\""}""");
        var done = ScopePhase.Normalize(ops, "/ops", Lane, Facts(ops, Lane));
        var entry = Assert.Single(done);
        Assert.Equal(ScopePhase.ChildCreated, entry["rule"]!.ToString());
        Assert.Equal(4, ops.Count);
        Assert.Equal("create", ops[1]!["op"]!.ToString());
        Assert.Equal("$l", ops[1]!["parent"]!.ToString());
        Assert.Equal("ITextWidget", ops[1]!["type"]!.ToString());
        // Idempotent, and a child the job creates itself (or a type born with it) is left alone.
        Assert.Empty(ScopePhase.Normalize(ops, "/ops", Lane, Facts(ops, Lane)));
        var button = Ops("""{"op":"create","parent":"IMobileScreen:Home","type":"IButton","as":"$b"}""",
            """{"op":"set","target":"$b/#ITextWidget","prop":"Text","value":"Ok"}""");
        Assert.Empty(ScopePhase.Normalize(button, "/ops", Lane, Facts(button, Lane)));
        Assert.Equal(2, button.Count);
    }

    // ---- IF_CLASS_MOVED -----------------------------------------------------------------------------------------------------

    [Fact]
    public void TheClassOfAnIfGoesOnAContainerOfWhatItShows()
    {
        // Two Reactive apps (24 refusals: "IIfWidget.Style takes no expression here").
        const string html = "<screen name=\"Home\"><div if=\"IsLoading\" class=\"loading\"><span>Wait</span></div><div else class=\"ready\">Ok</div><div class=\"plain\">x</div></screen>";
        var moved = ScopePhase.IfClassMoved(html);
        Assert.NotNull(moved);
        Assert.Equal(2, moved!.Value.Count);
        Assert.Equal("<screen name=\"Home\"><div if=\"IsLoading\"><div class=\"loading\"><span>Wait</span></div></div><div else><div class=\"ready\">Ok</div></div><div class=\"plain\">x</div></screen>", moved.Value.Html);
        Assert.Null(ScopePhase.IfClassMoved(moved.Value.Html));
        // A self-closed element and a tag that is no container are left to the compiler.
        Assert.Null(ScopePhase.IfClassMoved("<screen name=\"Home\"><div if=\"X\" class=\"k\"/><a if=\"X\" class=\"k\" onclick=\"Save\">s</a></screen>"));
    }

    // ---- WIDGET_REQUIRED_PROPERTY -------------------------------------------------------------------------------------------

    [Fact]
    public void AButtonWithoutDestinationIsRefusedAtItsCreate()
    {
        var bare = Ops("""{"op":"create","parent":"IMobileScreen:Home","type":"IButton","as":"$b"}""", """{"op":"set","target":"$b","prop":"Style","value":"\"btn\""}""");
        var problem = Assert.Single(Code(Run(Lane, bare), ScopeRules.Required));
        Assert.Equal("/ops/0", problem["pointer"]!.ToString());
        Assert.Equal("RequiredPropertyValue_Property", problem["predicts"]!.ToString());
        Assert.Contains("$b/OnClick", problem["fix"]!.ToString());
        var linked = Ops("""{"op":"create","parent":"IMobileScreen:Home","type":"IButton","as":"$b"}""",
            """{"op":"set","target":"$b/OnClick","prop":"Destination","value":"IMobileScreen:Home/IScreenAction:Save"}""");
        Assert.Empty(Code(Run(Lane, linked), ScopeRules.Required));
        // A generator may write it: no evidence.
        var generated = Ops("""{"op":"screen","data":{"generate":"Order"}}""", """{"op":"create","parent":"IMobileScreen:Home","type":"IButton","as":"$b"}""");
        Assert.Empty(Code(Run(Lane, generated), ScopeRules.Required));
    }

    // ---- ACTION_KIND_NODE ---------------------------------------------------------------------------------------------------

    [Fact]
    public void AWidgetOfTheOtherFamilyOrAChildTheParentRefusesIsRefusedFromTheCreationMaps()
    {
        if (ScopeRules.MapFor("CrossDevice") == null) { Assert.Null(JobSources.KernelRoot()); return; }   // no kernel tree here
        var ops = Ops("""{"op":"create","parent":"IMobileScreen:Home","type":"IContainerWidget","as":"$c"}""");
        var problem = Assert.Single(ScopeRules.Kinds(ops, "/ops", ScopeJob.Of(ops), "CrossDevice").ToList());
        Assert.Equal(ScopeRules.KindNode, problem["code"]!.ToString());
        Assert.Equal("IContainer", problem["patch"]![0]!["value"]!.ToString());
        Assert.Equal("/ops/0/type", problem["pointer"]!.ToString());
        Assert.Empty(ScopeRules.Kinds(ops, "/ops", ScopeJob.Of(ops), "WebResponsive"));
        // A Traditional portal: a Container in an Email.
        var email = Ops("""{"op":"create","parent":"IWebFlow:Mails","type":"IWebEmail","name":"Approved","as":"$e"}""",
            """{"op":"create","parent":"$e","type":"IContainerWidget","as":"$c"}""");
        var child = Assert.Single(ScopeRules.Kinds(email, "/ops", ScopeJob.Of(email), "WebResponsive").ToList());
        Assert.Contains("can't be children of Email", child["message"]!.ToString());
        Assert.Equal("/ops/1/parent", child["pointer"]!.ToString());
    }

    // ---- WIDGET_PROPERTY_VOCABULARY -----------------------------------------------------------------------------------------

    private sealed class Settables(IndexBaseFacts inner) : IBaseFacts
    {
        public IReadOnlyDictionary<string, string>? Attributes(string record) => inner.Attributes(record);
        public bool IsClientEntity(string name) => inner.IsClientEntity(name);
        public CalleeFact? Callee(string target, JsonObject caller) => null;
        public bool HasName(string name) => inner.HasName(name);
        public bool NamesOnlyTypes(string name) => inner.NamesOnlyTypes(name);
        public bool IsFunction(string name) => inner.IsFunction(name);
        public string? ModuleType => null;
        public RawExpressionFact? RawExpression(string target, string prop) => null;
        // The answer of an ICheckbox of the base (Morada_UI 20/10: 12 refusals of Mandatory).
        public SettableFact? Settable(string type, string prop) => type != "ICheckbox" ? null
            : prop is "Variable" or "Enabled" or "Style" ? new SettableFact(true, "", [], null)
            : new SettableFact(false, $"ICheckbox has no writable property or setter '{prop}'", ["Enabled", "Variable", "Visible"], null);
    }

    [Fact]
    public void APropertyTheTypeCannotWriteIsRefusedWithTheWritableNames()
    {
        var ops = Ops("""{"op":"create","parent":"IMobileScreen:Home","type":"ICheckbox","as":"$c"}""",
            """{"op":"set","target":"$c","prop":"Variable","value":"Filter"}""",
            """{"op":"set","target":"$c","prop":"Mandatory","value":"True"}""",
            """{"op":"set","target":"$c","prop":"visible","value":"True"}""");
        var facts = new Settables(Facts(ops, Lane));
        var problems = ScopeRules.Properties(ops, "/ops", ScopeJob.Of(ops), facts).ToList();
        Assert.Equal(2, problems.Count);
        var mandatory = Assert.Single(problems, p => p["pointer"]!.ToString() == "/ops/2/prop");
        Assert.Contains("Enabled, Variable, Visible", mandatory["fix"]!.ToString());
        Assert.Null(mandatory["patch"]);
        // One writable name contains it: the patch writes it.
        var visible = Assert.Single(problems, p => p["pointer"]!.ToString() == "/ops/3/prop");
        Assert.Equal("Visible", visible["patch"]![0]!["value"]!.ToString());
    }

    // ---- SCOPE_UNKNOWN_IDENTIFIER -------------------------------------------------------------------------------------------

    [Fact]
    public void ARootOfAWidgetExpressionIsANameOfItsOwner()
    {
        var ops = Ops("""{"op":"create","parent":"IMobileScreen:Home","type":"IExpression","as":"$e"}""",
            """{"op":"set","target":"$e","prop":"Value","value":"Filter + Fitler + Site.ApiUrl + \"Missing\""}""",
            """{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileBlock","name":"Panel","as":"$p"}""",
            """{"op":"create","parent":"$p","type":"ILocalVariable","name":"Total","as":"$t"}""",
            """{"op":"create","parent":"$p","type":"IExpression","as":"$x"}""",
            """{"op":"set","target":"$x","prop":"Value","value":"Total + Order"}""",
            """{"op":"create","parent":"$p","type":"IDataAction","name":"Load","as":"$da"}""",
            """{"op":"create","parent":"$da","type":"IAssignNode","as":"$an"}""",
            """{"op":"create","parent":"$an","type":"IAssignment","as":"$a"}""",
            """{"op":"set","target":"$a","prop":"Value","value":"OutputOfLoad"}""");
        var problems = Code(Run(Lane, ops), ScopeRules.UnknownIdentifier);
        // Fitler on the screen: the variable it means is the patch; Order in the block is a type, not a value.
        var typo = Assert.Single(problems, p => p["message"]!.ToString().Contains("'Fitler'"));
        Assert.Equal("/ops/1/value", typo["pointer"]!.ToString());
        Assert.Contains("of its screen Home", typo["message"]!.ToString());
        Assert.Equal("Filter + Filter + Site.ApiUrl + \"Missing\"", typo["patch"]![0]!["value"]!.ToString());
        Assert.Equal("ExpressionUnknownObject", typo["predicts"]!.ToString());
        var type = Assert.Single(problems, p => p["message"]!.ToString().Contains("'Order'"));
        Assert.Contains("a type and not a value of its block Panel", type["message"]!.ToString());
        // Filter, Site., the text literal, the block's own Total and what an assignment of a data action reads are not judged.
        Assert.Equal(2, problems.Count);
    }

    // The suite of the integration (24/10): what the canonical jobs write is never a scope problem.
    [Fact]
    public void WhatTheCanonicalJobsWriteIsNotJudged()
    {
        var ops = Ops(
            // A call by the key of a frozen producer's signature (NativeReference*, CSharp*): the apply resolves keys.
            """{"op":"logic","data":{"actions":[{"name":"UsesFrozen","steps":[{"call":"IServerActionSignature:@o9uDsS0atk6uDSTg_bZQcA/i5FAvgzI2UOEJ7U4bvKbRw"}]}]}}""",
            // An event's own parameter as the argument of its handler (osui-accordion: $b/Initialized/AccordionId).
            """{"op":"create","parent":"IMobileScreen:Home","type":"IMobileBlockInstanceWidget","as":"$acc"}""",
            """{"op":"set","target":"$acc/Initialized/AccordionId","prop":"Value","value":"AccordionId"}""",
            // A condition of a screen aggregate (crud-05-list): the aggregate's sources are its names.
            """{"op":"create","parent":"IMobileScreen:Home","type":"IScreenAggregate","name":"GetPage","as":"$agg"}""",
            """{"op":"create","parent":"$agg","type":"IFilter","as":"$f"}""",
            """{"op":"set","target":"$f","prop":"Condition","value":"Product.CategoryId = ProductCategory.Id"}""",
            // A screen action of an owner in the reference form.
            """{"op":"logic","data":{"actions":[{"name":"Go","kind":"screen","owner":"IMobileScreen:Home","steps":[{"call":"IMobileScreen:Home/IScreenAction:Save"}]}]}}""");
        var r = Run(Lane, ops);
        Assert.Empty(Code(r, ScopeRules.CallUnknown));
        Assert.Empty(Code(r, ScopeRules.UnknownIdentifier));
    }

    [Fact]
    public void AnAliasAPartOfACompositeJobDeclaresAgainIsReadAsItWasAtEachOp()
    {
        // crud-all: $agg, $form... of one part are other elements in the next; each set reads the alias of its own time.
        var ops = Ops(
            """{"op":"create","parent":"IMobileScreen:Home","type":"IExpression","as":"$x"}""",
            """{"op":"set","target":"$x","prop":"Value","value":"Filter"}""",
            """{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileBlock","name":"Other","as":"$o"}""",
            """{"op":"create","parent":"$o","type":"IExpression","as":"$x"}""",
            """{"op":"create","parent":"$o","type":"ILocalVariable","name":"Only","as":"$v"}""",
            """{"op":"set","target":"$x","prop":"Value","value":"Only"}""");
        Assert.Empty(Code(Run(Lane, ops), ScopeRules.UnknownIdentifier));
    }

    // ---- REFERENCE_ELEMENT_UNKNOWN / REFERENCE_NOT_PUBLIC -------------------------------------------------------------------

    private sealed class Producer(IndexBaseFacts inner) : IBaseFacts
    {
        public IReadOnlyDictionary<string, string>? Attributes(string record) => inner.Attributes(record);
        public bool IsClientEntity(string name) => false;
        public CalleeFact? Callee(string target, JsonObject caller) => null;
        public bool HasName(string name) => inner.HasName(name);
        public bool NamesOnlyTypes(string name) => inner.NamesOnlyTypes(name);
        public bool IsFunction(string name) => false;
        public string? ModuleType => null;
        public RawExpressionFact? RawExpression(string target, string prop) => null;
        // Demandas_CS of e033b46b: a role that is not Public, an action written with a typo.
        public ProducerElementFact? ProducerElement(string producer, string element) => element switch
        {
            "IRole:Administrador" => new ProducerElementFact(true, false, null, []),
            "IServerActionSignature:CriarDemand" => new ProducerElementFact(false, false, "no IServerAction named CriarDemand", ["CriarDemanda", "AtualizarDemanda"]),
            _ => new ProducerElementFact(true, true, null, []),
        };
    }

    [Fact]
    public void AnElementTheProducerDoesNotHaveOrDoesNotPublishFailsTheReferenceOpAndBlocksWhatItImports()
    {
        var ops = Ops("""{"op":"reference","producer":"C:\\caps\\Demandas_CS-20261019120000-ab12cd34.oml","elements":["IServerActionSignature:CriarDemand","IRole:Administrador","IServerActionSignature:ListarDemandas"]}""",
            Logic("server action Report\n  Listed = Demandas_CS.ListarDemandas()\n  end\n"));
        var r = ScopePhase.Run(ops, "/ops", Lane, new Producer(Facts(ops, Lane)), new JsonObject { ["problems"] = new JsonArray() });
        var unknown = Assert.Single(Code(r, "REFERENCE_ELEMENT_UNKNOWN"));
        Assert.Equal("/ops/0/elements/0", unknown["pointer"]!.ToString());
        Assert.Equal("IServerActionSignature:CriarDemanda", unknown["patch"]![0]!["value"]!.ToString());
        Assert.Single(Code(r, "REFERENCE_NOT_PUBLIC"));
        // The reference op is a root: the logic op that calls what it imports is blocked, not refused on its own.
        var blocked = Assert.Single(Code(r, ScopePhase.Blocked));
        Assert.Equal([1], blocked["blockedOps"]!.AsArray().Select(o => o!.GetValue<int>()).ToList());
        Assert.Empty(Code(r, ScopeRules.CallUnknown));
    }

    // ---- SCOPE_BLOCKED_BY_REFUSED_OP ----------------------------------------------------------------------------------------

    [Fact]
    public void WhatARefusedOpDeclaresBlocksTheOpsThatUseItAndTheWidgetWhoseEventTheyWrite()
    {
        var ops = Ops(
            """{"op":"create","parent":"IMobileScreen:Home","type":"IButton","as":"$b"}""",
            Logic("action Home.Approve\n  end\n"),
            """{"op":"set","target":"$b/OnClick","prop":"Destination","value":"IMobileScreen:Home/IScreenAction:Approve"}""",
            """{"op":"set","target":"$b/OnClick/Id","prop":"Value","value":"1"}""",
            """{"op":"set","target":"$b","prop":"Style","value":"\"btn\""}""");
        var preflight = new JsonObject { ["problems"] = new JsonArray(new JsonObject { ["op"] = 1, ["code"] = "FLOW_SYNTAX", ["severity"] = "error" }) };
        var r = Run(Lane, ops, preflight);
        var blocked = Assert.Single(Code(r, ScopePhase.Blocked));
        Assert.Equal(1, blocked["op"]!.GetValue<int>());
        var list = blocked["blockedOps"]!.AsArray().Select(o => o!.GetValue<int>()).ToList();
        // The set of the destination (it names Home.Approve), the argument after it, and the button whose On Click the Verify names.
        Assert.Equal([0, 2, 3], list.Order().ToList());
        Assert.Contains("Home.Approve", blocked["message"]!.ToString());
        // Without a refused op nothing is blocked.
        Assert.Empty(Code(Run(Lane, ops), ScopePhase.Blocked));
    }

    [Fact]
    public void TheCascadeGoesThroughWhatABlockedOpDeclares()
    {
        // Demandas_TW (e033b46b): the reference op fails, the logic op whose calls need it fails with it, and every set that
        // names a screen action of that logic op fails after them (CHILD_NOT_FOUND, RequiredPropertyValue at the Verify).
        var ops = Ops("""{"op":"reference","producer":"Orders_CS","elements":["IServerActionSignature:Archive"]}""",
            """{"op":"logic","data":{"actions":[{"name":"Paginate","kind":"screen","owner":"IMobileScreen:Home","steps":[{"call":"Orders_CS.Archive"}]}]}}""",
            """{"op":"create","parent":"IMobileScreen:Home","type":"IButton","as":"$b"}""",
            """{"op":"set","target":"$b/OnClick","prop":"Destination","value":"IMobileScreen:Home/IScreenAction:Paginate"}""");
        var preflight = new JsonObject { ["problems"] = new JsonArray(new JsonObject { ["op"] = 0, ["code"] = "REFERENCE_NOT_PUBLIC", ["severity"] = "error" }) };
        var blocked = Assert.Single(Code(Run(Lane, ops, preflight), ScopePhase.Blocked));
        Assert.Equal([1, 2, 3], blocked["blockedOps"]!.AsArray().Select(o => o!.GetValue<int>()).Order().ToList());
    }

    [Fact]
    public void AnOpThatDoesNotNeedTheRefusedOpIsNotBlocked()
    {
        var ops = Ops(
            Logic("action Home.Approve\n  end\n"),
            """{"op":"create","parent":"IMobileScreen:Home","type":"IButton","as":"$b"}""",
            """{"op":"set","target":"$b/OnClick","prop":"Destination","value":"IMobileScreen:Home/IScreenAction:Save"}""");
        var preflight = new JsonObject { ["problems"] = new JsonArray(new JsonObject { ["op"] = 0, ["code"] = "FLOW_SYNTAX", ["severity"] = "error" }) };
        Assert.Empty(Code(Run(Lane, ops, preflight), ScopePhase.Blocked));
    }
}
