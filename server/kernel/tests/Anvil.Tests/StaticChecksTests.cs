using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>CX16 W5: the static check (StaticChecks = DocumentNameRules + WithModule + WithBase over IndexBaseFacts) on jobs
/// written here and module indexes built in memory (the pattern of ModuleIndexTests): each class S1-S7 and L1-L3 with a case
/// that refuses and one that passes; a name the job creates, a generator's name and an imported name are never problems;
/// REFERENCE_MISSING with its patch; a base that is not fresh gives warnings only; a catalog of an unknown version gives
/// warnings; WithBase runs for a job with a reference op; nothing of the pure preflight is said twice. Pure: no Studio.</summary>
public class StaticChecksTests
{
    // ---- an index in memory ------------------------------------------------------------------------------------------------
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
    private static ModuleIndex Index(string name, Action<Node> build)
    {
        var root = new Node("root" + (++keys), "ESpace", name);
        build(root);
        return ModuleIndex.Build(root, new Reader(), name, "o11", "kernel", new string('a', 63) + (keys % 10), 1000);
    }

    // The module of the cases: a flow with the template's Login screen (a variable), a role, a block, a site property.
    private static ModuleIndex Module() => Index("App_UI", root => {
        var flow = root.Add(new("flow", "MobileFlow", "MainFlow"));
        var login = flow.Add(new("login", "MobileScreen", "Login"));
        login.Add(new("login.user", "LocalVariable", "Username", "Text"));
        login.Add(new("login.do", "ScreenAction", "DoLogin"));
        flow.Add(new("header", "MobileBlock", "Header"));
        root.Add(new("role", "Role", "Manager"));
        root.Add(new("site", "SiteProperty", "ApiUrl", "Text"));
    });

    // The producer: entities Station, Rental (attributes) and Payment, a role.
    private static ModuleIndex Producer() => Index("App_CS", root => {
        var station = root.Add(new("st", "Entity", "Station"));
        station.Add(new("st.id", "EntityAttribute", "Id", "Long Integer"));
        station.Add(new("st.name", "EntityAttribute", "Name", "Text"));
        var rental = root.Add(new("re", "Entity", "Rental"));
        rental.Add(new("re.id", "EntityAttribute", "Id", "Long Integer"));
        rental.Add(new("re.start", "EntityAttribute", "StartedAt", "Date Time"));
        root.Add(new("pay", "Entity", "Payment")).Add(new("pay.id", "EntityAttribute", "Id", "Long Integer"));
        root.Add(new("admin", "Role", "BikeAdministrator"));
    });

    private static StaticBasis Basis(bool fresh = true, bool producer = true, bool module = true, params UiCatalogBasis[] catalogs) => new() {
        Lane = "o11", Module = module ? Module() : null, Fresh = fresh,
        Producers = producer ? [new ProducerBasis("App_CS", "App_CS.kernel.json", null, Producer(), null)] : [],
        UiCatalogs = [.. catalogs] };

    private static JsonArray Ops(params string[] ops) => new(ops.Select(o => JsonNode.Parse(o)).ToArray());
    private static string Html(string document) => new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = document } }.ToJsonString();
    private static string Logic(string text) => new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(text) } }.ToJsonString();
    private const string Reference = """{"op":"reference","producer":"App_CS","elements":["IServerEntity:Station","IServerEntity:Rental","IRole:BikeAdministrator"]}""";

    private static StaticChecks.Result Run(StaticBasis basis, JsonArray ops) => StaticChecks.Run(ops, "/ops", "o11", basis);
    private static List<JsonObject> Errors(StaticChecks.Result r, string code) => r.Problems.Where(p => p["code"]!.ToString() == code).ToList();

    // ---- S4: actions= and data-actions= --------------------------------------------------------------------------------------
    [Fact]
    public void AScreenActionListedButNotWrittenIsUnknownAndOneWrittenPasses()
    {
        var r = Run(Basis(), Ops(Html("<screen name=\"SignIn\" actions=\"ForgotPassword, Enter\" data-actions=\"LoadUser\"><div class=\"x\"/></screen>"),
            Logic("action SignIn.Enter\n  assign\n    Done = True\n  end\n")));
        var problems = Errors(r, ScreenHtmlEdit.NameUnknown);
        Assert.Equal(2, problems.Count);
        Assert.Contains(problems, p => p["message"]!.ToString().Contains("'ForgotPassword'"));
        Assert.Contains(problems, p => p["message"]!.ToString().Contains("data action 'LoadUser'"));
        Assert.All(problems, p => { Assert.Equal("static", p["phase"]!.ToString()); Assert.Equal("/ops/0/data/html", p["pointer"]!.ToString()); Assert.NotNull(p["element"]); });
        Assert.DoesNotContain(problems, p => p["message"]!.ToString().Contains("'Enter'"));
    }

    // ---- S5: a type used as a value, a path over an entity list, an unknown root ----------------------------------------------
    [Fact]
    public void ATypeUsedAsAValueIsRefusedWithTheRowOfItsListAsTheEdit()
    {
        var r = Run(Basis(), Ops(Reference,
            Html("<screen name=\"Fleet\" data-actions=\"LoadOptions\"><select k=\"\" options=\"LoadOptions.Stations\" value=\"Station.Id\" label=\"Station.Name\" bind=\"Picked\"/><var name=\"Picked\" type=\"Station Identifier\"/></screen>"
                .Replace(" k=\"\"", "")),
            Logic("data action Fleet.LoadOptions\n  out Stations: Station List\n  Result = App_CS.GetStations()\n")));
        var problems = Errors(r, ScreenHtmlEdit.NameUnknown).Where(p => p["message"]!.ToString().Contains("is a type")).ToList();
        Assert.Equal(2, problems.Count);
        var value = problems.Single(p => p["message"]!.ToString().StartsWith("screen Fleet: value:", StringComparison.Ordinal));
        Assert.Equal("error", value["severity"]!.ToString());
        Assert.Equal("Fleet", value["edit"]!["element"]!.ToString());
        Assert.Equal("value=\"Station.Id\"", value["edit"]!["find"]!.ToString());
        Assert.Equal("value=\"LoadOptions.Stations.Current.Id\"", value["edit"]!["with"]!.ToString());
        // The row of the list: right.
        var right = Run(Basis(), Ops(Reference,
            Html("<screen name=\"Fleet\" data-actions=\"LoadOptions\"><select options=\"LoadOptions.Stations\" value=\"LoadOptions.Stations.Current.Id\" label=\"LoadOptions.Stations.Current.Name\" bind=\"Picked\"/><var name=\"Picked\" type=\"Station Identifier\"/></screen>"),
            Logic("data action Fleet.LoadOptions\n  out Stations: Station List\n")));
        Assert.Empty(right.Problems);
        // The value and label of a dropdown are read on its row: bare attributes of an Entity List, Entity.Attr of an
        // aggregate's row (its sources), and a source this check cannot type is left to the apply (the accepted DemoLATAM job).
        Assert.Empty(Run(Basis(), Ops(Reference,
            Html("<screen name=\"Fleet\" data-actions=\"LoadOptions\"><aggregate name=\"GetStations\" from=\"Station\"/><select options=\"LoadOptions.Stations\" value=\"Id\" label=\"Name\" bind=\"Picked\"/>"
                + "<select options=\"GetStations.List\" value=\"Station.Id\" label=\"Station.Name\" bind=\"Picked\"/><var name=\"Picked\" type=\"Station Identifier\"/><span>{{ Picked }}</span></screen>"),
            Logic("data action Fleet.LoadOptions\n  out Stations: Station List\n"))).Problems);
    }

    [Fact]
    public void AnEntityListRowIsTheEntity()
    {
        var r = Run(Basis(), Ops(Reference,
            Html("<screen name=\"History\" data-actions=\"LoadRentals\"><div list=\"LoadRentals.Rentals\"><span>{{ LoadRentals.Rentals.Current.Rental.StartedAt }}</span></div></screen>"),
            Logic("data action History.LoadRentals\n  out Rentals: Rental List\n")));
        var problem = Assert.Single(Errors(r, ScreenHtmlEdit.NameUnknown));
        Assert.Contains("the row of LoadRentals.Rentals is a Rental", problem["message"]!.ToString());
        Assert.Equal("<span>{{ LoadRentals.Rentals.Current.Rental.StartedAt }}</span>", problem["edit"]!["find"]!.ToString());
        Assert.Equal("<span>{{ LoadRentals.Rentals.Current.StartedAt }}</span>", problem["edit"]!["with"]!.ToString());
        Assert.Empty(Run(Basis(), Ops(Reference,
            Html("<screen name=\"History\" data-actions=\"LoadRentals\"><div list=\"LoadRentals.Rentals\"><span>{{ LoadRentals.Rentals.Current.StartedAt }}</span></div></screen>"),
            Logic("data action History.LoadRentals\n  out Rentals: Rental List\n"))).Problems);
    }

    [Fact]
    public void AnUnknownRootIsAnErrorOnAFreshIndexAWarningOnAnOtherAndNothingWhenTheJobCreatesIt()
    {
        const string page = "<screen name=\"Profile\"><var name=\"Email\" type=\"Text\"/><input k=\"\" bind=\"Usernme\"/><span>{{ Email + Site.ApiUrl }}</span></screen>";
        var doc = Html(page.Replace(" k=\"\"", ""));
        var fresh = Run(Basis(), Ops(doc));
        var problem = Assert.Single(Errors(fresh, ScreenHtmlEdit.NameUnknown));
        Assert.Contains("'Usernme'", problem["message"]!.ToString());
        var stale = Run(Basis(fresh: false), Ops(doc));
        Assert.Empty(stale.Problems);
        Assert.Contains(stale.Warnings, w => w["message"]!.ToString().Contains("'Usernme'"));
        // A variable of ANOTHER screen of the module is not visible here; one the job creates (a client variable) never is a problem.
        Assert.Single(Errors(Run(Basis(), Ops(Html("<screen name=\"Profile\"><input bind=\"Username\"/></screen>"))), ScreenHtmlEdit.NameUnknown));
        Assert.Empty(Run(Basis(), Ops("""{"op":"create","parent":"@espace","type":"IClientVariable","name":"Usernme"}""", doc)).Problems);
        // A screen generator writes names this check does not plan: an absent name is a warning in that job.
        var generated = Run(Basis(), Ops("""{"op":"screen","data":{"entity":"Station"}}""", doc));
        Assert.Empty(generated.Problems);
        Assert.Contains(generated.Warnings, w => w["message"]!.ToString().Contains("'Usernme'"));
        Assert.Contains(generated.Skipped, s => s!["class"]!.ToString() == "absence");
    }

    // ---- S1, S2: blocks ------------------------------------------------------------------------------------------------------
    [Fact]
    public void ABlockMustExistAndItsContractHolds()
    {
        const string block = "<block name=\"Card\"><input name=\"Title\" type=\"Text\" mandatory=\"True\"/><div><placeholder name=\"Body\"/></div></block>";
        var r = Run(Basis(), Ops(Html(block), Html("<screen name=\"Home\"><Block name=\"Cardd\"/><Block name=\"Card\" :Titel='\"x\"'><slot name=\"Bdy\"><p>x</p></slot></Block><Block name=\"Header\"/></screen>")));
        var unknown = Errors(r, ScreenHtmlEdit.NameUnknown).Single(p => p["message"]!.ToString().Contains("block 'Cardd'"));
        Assert.Equal("name=\"Cardd\"", unknown["edit"]!["find"]!.ToString());
        Assert.Equal("name=\"Card\"", unknown["edit"]!["with"]!.ToString());
        Assert.Single(Errors(r, "ARGUMENT_UNKNOWN"));
        Assert.Single(Errors(r, "REQUIRED_ARGUMENT"));
        Assert.Single(Errors(r, ScreenHtmlEdit.SlotUnknown));
        var right = Run(Basis(), Ops(Html(block), Html("<screen name=\"Home\"><Block name=\"Card\" :Title='\"x\"'><slot name=\"Body\"><p>x</p></slot></Block><Block name=\"Header\"/></screen>")));
        Assert.Empty(right.Problems);
    }

    [Fact]
    public void ACatalogOfAnUnknownVersionGivesWarnings()
    {
        var catalog = new UiModule("OutSystemsUI", "ReactiveLibrary", "2.28.1", null, "k", "", "",
            [new UiBlock("Tag", "OutSystemsUI", "Reactive", "Content", true, null, [new UiParam("Color", "Integer", true, null, null)], [], [new UiPlaceholder("Content", null, "", [])],
                [], [], [], [], [], null, [], [], null, [], [], 0)], [], [], [], [], [], []);
        var basis = Basis(catalogs: new UiCatalogBasis("OutSystemsUI-2.28.1.json", "OutSystemsUI", "2.28.1", false, catalog));
        var r = Run(basis, Ops(Html("<screen name=\"Home\"><Block name=\"Tag\"><slot name=\"Contents\"><p>x</p></slot></Block></screen>")));
        Assert.Empty(r.Problems);
        Assert.Contains(r.Warnings, w => w["code"]!.ToString() == "REQUIRED_ARGUMENT");
        Assert.Contains(r.Warnings, w => w["code"]!.ToString() == ScreenHtmlEdit.SlotUnknown);
    }

    // ---- S3: event destinations ----------------------------------------------------------------------------------------------
    [Fact]
    public void AnEventNamesAScreenActionOfTheDocumentOrAScreen()
    {
        var r = Run(Basis(), Ops(Html("<screen name=\"Edit\" actions=\"Save\"><button onclick=\"Sav\">Go</button><a onclick=\"Login\">Back</a></screen>"), Logic("action Edit.Save\n")));
        var problem = Assert.Single(Errors(r, ScreenHtmlEdit.NameUnknown));
        Assert.Equal("onclick=\"Sav\"", problem["edit"]!["find"]!.ToString());
        Assert.Equal("onclick=\"Save\"", problem["edit"]!["with"]!.ToString());
    }

    // ---- S6, S7 -------------------------------------------------------------------------------------------------------------
    [Fact]
    public void RolesComeFromTheModuleTheJobOrTheReferenceAndANewScreenNeedsANewName()
    {
        Assert.Single(Errors(Run(Basis(), Ops(Html("<screen name=\"Admin\" roles=\"Supervisor\"/>"))), ScreenHtmlEdit.NameUnknown));
        Assert.Empty(Run(Basis(), Ops(Html("<screen name=\"Admin\" roles=\"Manager, Registered\"/>"))).Problems);
        Assert.Empty(Run(Basis(), Ops(Reference, Html("<screen name=\"Admin\" roles=\"BikeAdministrator\"/>"))).Problems);
        var exists = Assert.Single(Errors(Run(Basis(), Ops(Html("<screen name=\"Login\"/>"))), ScreenDocument.RootExists));
        Assert.Equal("error", exists["severity"]!.ToString());
        Assert.Empty(Run(Basis(), Ops(Html("<screen name=\"Login2Fa\"/>"))).Problems);
    }

    // ---- L1-L3 -------------------------------------------------------------------------------------------------------------
    [Fact]
    public void ADataActionDoesNotSeeTheScreenVariablesAndNamesDoNotCollide()
    {
        var r = Run(Basis(), Ops(
            Html("<screen name=\"Fleet\" actions=\"Pick\" data-actions=\"LoadBikes\"><input name=\"StationId\" type=\"Long Integer\"/><var name=\"ErrorMessage\" type=\"Text\"/><var name=\"ErrorText\" type=\"Text\"/></screen>"),
            Logic("data action Fleet.LoadBikes\n  out Total: Integer\n  out ErrorText: Text\n  assign\n    Total = 1\n  end\n  on exception All Exceptions:\n    assign\n      ErrorMessage = \"x\"\n    end\n"
                + "\naction Fleet.Pick\n  in StationId: Long Integer\n  assign ErrorMessage = \"\"\n  end\n")));
        Assert.Contains("ErrorMessage", Assert.Single(Errors(r, "EXPR_UNKNOWN_IDENTIFIER"))["message"]!.ToString());
        var collisions = Errors(r, "NAME_COLLISION");
        Assert.Equal(2, collisions.Count);
        Assert.Contains(collisions, p => p["message"]!.ToString().Contains("output 'ErrorText'"));
        Assert.Contains(collisions, p => p["message"]!.ToString().Contains("input 'StationId'"));
        Assert.All(collisions, p => Assert.Equal("/ops/1/data/flow/0", p["pointer"]!.ToString()));
        // The same in the JSON form of a logic op: the output of a data action named like a variable of its screen.
        var json = Run(Basis(), Ops(Html("<screen name=\"Ponto\" data-actions=\"Carregar\"><var name=\"Resumo\" type=\"Text\"/></screen>"),
            """{"op":"logic","data":{"actions":[{"name":"Carregar","kind":"data","owner":"IMobileScreen:Ponto","outputs":[{"name":"Resumo","type":"Text"}],"steps":[]}]}}"""));
        Assert.Equal("/ops/1/data/actions/0", Assert.Single(Errors(json, "NAME_COLLISION"))["pointer"]!.ToString());
    }

    // ---- REFERENCE_MISSING --------------------------------------------------------------------------------------------------
    [Fact]
    public void ATypeOfAReferencedProducerTheReferenceDoesNotImportIsReferenceMissingWithItsPatch()
    {
        var r = Run(Basis(), Ops(Reference, Logic("data action Pay.LoadPayments\n  out Payments: Payment List\n")));
        var problem = Assert.Single(Errors(r, DocumentNameRules.ReferenceMissing));
        Assert.Equal("add", problem["patch"]![0]!["op"]!.ToString());
        Assert.Equal("/ops/0/elements/-", problem["patch"]![0]!["path"]!.ToString());
        Assert.Equal("IServerEntity:Payment", problem["patch"]![0]!["value"]!.ToString());
        Assert.Empty(Errors(Run(Basis(), Ops(Reference.Replace("\"IRole:BikeAdministrator\"", "\"IRole:BikeAdministrator\",\"IServerEntity:Payment\""),
            Logic("data action Pay.LoadPayments\n  out Payments: Payment List\n"))), DocumentNameRules.ReferenceMissing));
        // Without a fresh index: a warning.
        Assert.Contains(Run(Basis(fresh: false), Ops(Reference, Logic("data action Pay.LoadPayments\n  out Payments: Payment List\n"))).Warnings,
            w => w["code"]!.ToString() == DocumentNameRules.ReferenceMissing);
    }

    // ---- WithBase with a reference op; once; generators --------------------------------------------------------------------
    [Fact]
    public void WithBaseRunsForAJobWithAReferenceOpAndAGeneratorsNamesAreNeverProblems()
    {
        var logic = """{"op":"logic","data":{"actions":[{"name":"Check","outputs":[{"name":"Ok","type":"Boolean"}],"steps":[{"assign":{"Ok":"Mystery.Value > 0"}}]}]}}""";
        var r = Run(Basis(), Ops(Reference, logic));
        Assert.Contains(r.Problems, p => p["code"]!.ToString() == "EXPR_UNKNOWN_IDENTIFIER" && p["message"]!.ToString().Contains("Mystery"));
        // A name an entity-actions generator writes (CreateOrUpdateStation of Station) in an event: never a problem.
        Assert.Empty(Run(Basis(), Ops(Reference, Html("<screen name=\"S\" actions=\"Save\"><button onclick=\"Save\">ok</button></screen>"), Logic("action S.Save\n  CreateOrUpdateStation(Source = X)\n"))).Problems
            .Where(p => p["message"]!.ToString().Contains("CreateOrUpdateStation")));
    }

    [Fact]
    public void NothingThePreflightSaidIsSaidTwiceAndAJobWithoutDocumentsPaysNothing()
    {
        var ops = Ops(Html("<screen name=\"SignIn\" actions=\"Forgot\"/>"));
        var first = Run(Basis(), ops);
        var problem = Assert.Single(first.Problems);
        var again = StaticChecks.Run(ops, "/ops", "o11", Basis(), [problem]);
        Assert.Empty(again.Problems);
        var plain = Run(Basis(), Ops("""{"op":"set","target":"@espace","prop":"Description","value":"x"}"""));
        Assert.Empty(plain.Problems); Assert.Empty(plain.Warnings);
    }

    [Fact]
    public void WithoutAnIndexTheModuleClassesAreSkippedAndListed()
    {
        var r = Run(Basis(fresh: false, producer: false, module: false), Ops(Html("<screen name=\"P\"><input bind=\"Nope\"/></screen>")));
        Assert.Empty(r.Problems);
        Assert.Contains(r.Skipped, s => s!["class"]!.ToString() == "module-index");
        Assert.Contains(r.Warnings, w => w["message"]!.ToString().Contains("'Nope'"));
    }

    // ---- CX16 r2 -----------------------------------------------------------------------------------------------------------
    // A1: what the module imports is in its own index (role reference, kind <Kind>Signature), with no digest and no UI catalog:
    // the blocks of a library it references are known to S1, a screen it references to S3; a block of a producer index too.
    private static ModuleIndex Imports() => Index("App_UI", root => {
        root.Add(new("flow", "MobileFlow", "MainFlow")).Add(new("login", "MobileScreen", "Login"));
        var osui = root.Add(new("osui", "Reference", "OutSystemsUI"));
        osui.Add(new("osui.layout", "MobileBlockSignature", "LayoutBlank"));
        osui.Add(new("osui.columns", "MobileBlockSignature", "Columns2"));
        root.Add(new("common", "Reference", "App_Common")).Add(new("common.home", "MobileScreenSignature", "Dashboard"));
    });

    [Fact]
    public void ABlockOrAScreenTheModuleImportsIsKnownFromItsIndexAlone()
    {
        var basis = new StaticBasis { Lane = "o11", Module = Imports(), Fresh = true };
        var r = Run(basis, Ops(Html("<screen name=\"Home\"><Block name=\"LayoutBlank\"><slot name=\"Content\"><Block name=\"Columns2\"/><a onclick=\"Dashboard\">Home</a></slot></Block></screen>")));
        Assert.True(Errors(r, ScreenHtmlEdit.NameUnknown).Count == 0, string.Join(" | ", r.Problems.Select(p => p.ToJsonString())));
        // A block nothing has is still unknown.
        var wrong = Run(basis, Ops(Html("<screen name=\"Home\"><Block name=\"Columns9\"/><a onclick=\"Dashbord\">x</a></screen>")));
        Assert.Contains(Errors(wrong, ScreenHtmlEdit.NameUnknown), p => p["message"]!.ToString().Contains("'Columns9'"));
        Assert.Contains(Errors(wrong, ScreenHtmlEdit.NameUnknown), p => p["message"]!.ToString().Contains("'Dashbord'"));
        // A block of a producer's index (the job's reference op may bring it).
        var theme = Index("App_Theme", root => root.Add(new("tf", "MobileFlow", "Common")).Add(new("tf.card", "MobileBlock", "TrailCard")));
        var withProducer = new StaticBasis { Lane = "o11", Module = Imports(), Fresh = true, Producers = [new ProducerBasis("App_Theme", "t.json", null, theme, null)] };
        Assert.Empty(Errors(Run(withProducer, Ops(Html("<screen name=\"Home\"><Block name=\"TrailCard\"/></screen>"))), ScreenHtmlEdit.NameUnknown));
    }

    // A2: the whole document with screen and basedOn is the edit of that screen (ScreenHtmlEdit.IsEdit, the rule of the apply),
    // never a new root; without screen and basedOn the same document is a new screen, and its name is taken.
    [Fact]
    public void TheWholeDocumentWithScreenAndBasedOnEditsTheScreenAndIsNoNewRoot()
    {
        const string login = "<screen name=\"Login\" actions=\"DoLogin\"><var k=\"w1\" name=\"Username\" type=\"Text\"/><input k=\"w2\" bind=\"Username\" class=\"wide\"/></screen>";
        var edit = new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "Login",
            ["basedOn"] = new JsonObject { ["capture"] = new string('c', 64), ["html"] = new string('d', 64) }, ["html"] = login } }.ToJsonString();
        var r = Run(Basis(), Ops(edit));
        Assert.Empty(Errors(r, ScreenDocument.RootExists));
        Assert.Single(Errors(Run(Basis(), Ops(Html(login))), ScreenDocument.RootExists));
    }

    // M3 (provisional): FUNCTION_UNKNOWN of the base phase, decided here without the Studio (the built-ins of the lane, the
    // index, the job): an unknown call is an error on a fresh index and a warning on another; a built-in, an element of the
    // module or of a reference and an action of the job are never problems; a job that expects an invalid module skips it.
    [Fact]
    public void AnUnknownFunctionIsDecidedWithoutTheStudio()
    {
        Assert.NotNull(Builtins.For("o11"));
        var module = Index("App_UI", root => {
            root.Add(new("fmt", "ServerAction", "FormatMoney"));
            root.Add(new("ref", "Reference", "App_Common")).Add(new("ref.f", "ServerActionSignature", "CommonFormat"));
        });
        var logic = """{"op":"logic","data":{"actions":[{"name":"Check","outputs":[{"name":"Ok","type":"Text"}],"steps":[{"assign":{"Ok":"Lowr(\"A\") + ToLower(\"B\") + FormatMoney(1) + CommonFormat(2) + Check2(3)"}}]},{"name":"Check2","outputs":[{"name":"Out","type":"Text"}],"steps":[]}]}}""";
        var html = Html("<screen name=\"Home\"><div>{{ Uper(\"x\") }}</div></screen>");
        var fresh = Run(new StaticBasis { Lane = "o11", Module = module, Fresh = true }, Ops(logic, html));
        var unknown = Errors(fresh, "FUNCTION_UNKNOWN");
        Assert.Equal(["'Lowr('", "'Uper('"], unknown.Select(p => p["message"]!.ToString()[..p["message"]!.ToString().IndexOf(' ')]).Order(StringComparer.Ordinal));
        Assert.Equal(["/ops/0", "/ops/1/data/html"], unknown.Select(p => p["pointer"]!.ToString()).Order(StringComparer.Ordinal));
        Assert.Contains(fresh.Checked, c => c!.ToString() == "functions");
        var stale = Run(new StaticBasis { Lane = "o11", Module = module, Fresh = false }, Ops(logic, html));
        Assert.Empty(Errors(stale, "FUNCTION_UNKNOWN"));
        Assert.Equal(2, stale.Warnings.Count(w => w["code"]!.ToString() == "FUNCTION_UNKNOWN"));
    }
}
