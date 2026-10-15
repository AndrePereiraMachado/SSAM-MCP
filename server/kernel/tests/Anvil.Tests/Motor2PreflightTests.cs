using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// motor2 (2026-10-12): the classes of refusals the owner's sessions met only at apply or at the Verify, one round each
/// (FolhaPonto_UI: six deliveries for one job), are decided in the same preflight pass now. What has one reading is
/// normalized and listed (normalizations: PROPERTY_ALIASED, ICON_NAME_NORMALIZED, ICON_WEIGHT_DROPPED, LIST_ALIAS_REWRITTEN,
/// SCREEN_TITLE_QUOTED, DEFAULT_MOVED_TO_INITIALIZE, DEFAULT_MOVED_TO_ASSIGN, PARAMETER_RENAMED); what does not is refused
/// with the rest, with the patch when one correction is certain (ICON_UNKNOWN, DEFAULT_NOT_LITERAL, NAME_COLLISION,
/// NODE_NOT_ALLOWED). Each class: the case it fixes, the case it leaves alone, the ambiguous case. Synthetic names.
/// </summary>
public sealed class Motor2PreflightTests
{
    public Motor2PreflightTests() { try { StudioAssemblies.Bind(); } catch { /* no Studio: the checked-in catalogs answer */ } }

    private static (JsonNode Job, JsonObject Result) Analyze(string json)
    {
        var job = JsonNode.Parse(json)!;
        return (job, JobPreflight.Analyze(job["ops"]!.AsArray(), job, []));
    }

    private static JsonObject[] Problems(JsonObject result, string code)
        => result["problems"]!.AsArray().OfType<JsonObject>().Where(p => p["code"]!.GetValue<string>() == code).ToArray();

    private static JsonObject[] Normalizations(JsonNode? result, string rule)
        => (result?["normalizations"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .Where(n => n["rule"]!.GetValue<string>().Split('+').Contains(rule)).ToArray();

    private static string Html(JsonNode job, int op) => job["ops"]![op]!["data"]!["html"]!.GetValue<string>();

    private static string Ops(params string[] ops) => "{\"ops\":[" + string.Join(",", ops) + "]}";

    private static string HtmlOp(string html) => new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } }.ToJsonString();

    private static string LogicOp(params string[] actions) => "{\"op\":\"logic\",\"data\":{\"actions\":[" + string.Join(",", actions) + "]}}";

    private static readonly IconNames.Catalog Icons = IconNames.FromJson("FontAwesome 4.7 (test)", """
        [{"name":"home","id":"home","filter":["main","house"]},{"name":"calendar","id":"calendar","filter":["date","time","when","event"]},
         {"name":"clock","id":"clock-o","filter":["watch","timer","late","timestamp"]},{"name":"times","id":"times","aliases":["remove","close"],"filter":["close","exit","x","cross"]},
         {"name":"trash","id":"trash","filter":["garbage","delete","remove"]},{"name":"user","id":"user","filter":["person","man","head","profile"]}]
        """);

    // ---- PROPERTY_ALIASED ---------------------------------------------------------------------------------------------------

    [Fact]
    public void HandlerOnALifecycleEventIsItsDestination()
    {
        // FolhaPonto_UI 13:59:19: three `set Handler` on OnAfterFetch refused one round after the rest.
        var (job, result) = Analyze(Ops("""{"op":"set","target":"IDataAction:M2Carregar/OnAfterFetch","prop":"Handler","value":"IMobileScreen:M2Tela/M2Aplicar"}"""));
        if (ModelTypes.Of("IUILifeCycleEvent", "o11") == null) { Assert.Null(Environment.GetEnvironmentVariable("ANVIL_STUDIO_DIR")); return; }   // no Model API in this host: the apply decides (Verbs.Set)
        var entry = Assert.Single(Normalizations(result, PropertyAliases.Rule));
        Assert.Equal("/ops/0/prop", entry["path"]!.GetValue<string>());
        Assert.Equal("Destination", job["ops"]![0]!["prop"]!.GetValue<string>());
        Assert.Empty(Problems(result, "PROPERTY_NOT_WRITABLE"));
    }

    [Fact]
    public void APropertyTheElementHasIsNeverAliasedAndAnUntypedTargetIsLeftToTheApply()
    {
        // A widget event writes Handler: it stays.
        var (kept, keptResult) = Analyze(Ops("""{"op":"create","parent":"IButton:M2Botao","type":"IEvent","as":"$ev"}""", """{"op":"set","target":"$ev","prop":"Handler","value":"IMobileScreen:M2Tela/M2Aplicar"}"""));
        Assert.Empty(Normalizations(keptResult, PropertyAliases.Rule));
        Assert.Equal("Handler", kept["ops"]![1]!["prop"]!.GetValue<string>());
        // An @key names no type the job knows: nothing is rewritten here (the apply knows the element).
        var (untyped, untypedResult) = Analyze(Ops("""{"op":"set","target":"@AbCdEfGhIjKlMnOpQrStUv","prop":"Handler","value":"IMobileScreen:M2Tela/M2Aplicar"}"""));
        Assert.Empty(Normalizations(untypedResult, PropertyAliases.Rule));
        Assert.Equal("Handler", untyped["ops"]![0]!["prop"]!.GetValue<string>());
        // The table: only the pairs it names, on the types it names.
        Assert.Equal("Destination", PropertyAliases.Meant(["IObject", "IUILifeCycleEvent"], "Handler"));
        Assert.Equal("Property", PropertyAliases.Meant(["IExtendedProperty"], "Name"));
        Assert.Null(PropertyAliases.Meant(["IEvent"], "Handler"));
        Assert.Null(PropertyAliases.Meant(["IUILifeCycleEvent"], "Action"));
    }

    // ---- icons ------------------------------------------------------------------------------------------------------------------

    private const string Screen = """<screen name="M2Tela" flow="MainFlow" title="&quot;Tela&quot;" roles="Registered" actions="M2Ir"><var name="M2Texto" type="Text"/><Block name="LayoutBlank"><slot name="Content">""";
    private const string End = "</slot></Block></screen>";

    [Fact]
    public void AnIconInAnotherSpellingIsTheCatalogsAndAnUnknownOneIsRefusedWithTheClosest()
    {
        IconNames.Override = Icons;
        try
        {
            var (job, result) = Analyze(Ops(HtmlOp(Screen + """<button onclick="M2Ir"><i icon="Home"></i><i icon="fa-calendar"></i><i icon="clock"></i><i icon="user"></i></button>""" + End)));
            var entries = Normalizations(result, HtmlDocumentRules.IconName);
            Assert.Equal(3, entries.Length);
            var html = Html(job, 0);
            Assert.Contains("icon=\"home\"", html);
            Assert.Contains("icon=\"calendar\"", html);
            Assert.Contains("icon=\"clock-o\"", html);
            Assert.Contains("icon=\"user\"", html);
            Assert.Empty(Problems(result, "ICON_UNKNOWN"));
            // Unknown by spelling only: refused with the closest as options, and no patch (spelling is no meaning).
            var (_, unknown) = Analyze(Ops(HtmlOp(Screen + """<i icon="person-x"></i>""" + End)));
            var problem = Assert.Single(Problems(unknown, "ICON_UNKNOWN"));
            Assert.Equal("/ops/0/data/html", problem["pointer"]!.GetValue<string>());
            Assert.Null(problem["patch"]);
            // A name the search words or the table give: the patch writes it.
            var (_, meant) = Analyze(Ops(HtmlOp(Screen + """<i icon="event"></i>""" + End)));
            var patch = Assert.Single(Assert.Single(Problems(meant, "ICON_UNKNOWN"))["patch"]!.AsArray()).AsObject();
            Assert.Equal("replace", patch["op"]!.GetValue<string>());
            Assert.Contains("icon=\"calendar\"", patch["value"]!.GetValue<string>());
            // The fragment form is judged too.
            var (_, fragment) = Analyze(Ops("""{"op":"html","parent":"IMobileScreen:M2Tela","html":"<i icon=\"banana\" weight=\"Regular\"></i>"}"""));
            Assert.Single(Problems(fragment, "ICON_UNKNOWN"));
        }
        finally { IconNames.Override = null; }
    }

    [Fact]
    public void TheWeightOfAnO11IconIsDroppedOnlyInTheDocumentForm()
    {
        IconNames.Override = Icons;
        try
        {
            var (job, result) = Analyze(Ops(HtmlOp(Screen + """<button onclick="M2Ir"><i icon="home" weight="Regular"></i>Ir</button>""" + End)));
            if (MessageExpectations.Lane != "o11") return;
            Assert.Single(Normalizations(result, HtmlDocumentRules.IconWeight));
            Assert.Contains("<i icon=\"home\"></i>", Html(job, 0));
            // The fragment form needs the weight (HtmlVisual drops it for O11 itself): never touched.
            var (fragment, fragmentResult) = Analyze(Ops("""{"op":"html","parent":"IMobileScreen:M2Tela","html":"<i icon=\"home\" weight=\"Regular\"></i>"}"""));
            Assert.Empty(Normalizations(fragmentResult, HtmlDocumentRules.IconWeight));
            Assert.Contains("weight=", fragment["ops"]![0]!["html"]!.GetValue<string>());
        }
        finally { IconNames.Override = null; }
    }

    [Fact]
    public void IconVerdicts()
    {
        Assert.True(IconNames.Judge("home", Icons, "o11").Valid);
        Assert.True(IconNames.Judge("close", Icons, "o11").Valid);   // an alias of the catalog
        Assert.Equal("home", IconNames.Judge("fa fa-home", Icons, "o11").Certain);
        Assert.Equal("clock-o", IconNames.Judge("clock", Icons, "o11").Certain);
        Assert.Equal("calendar", IconNames.Judge("Calendar", Icons, "o11").Certain);
        // Ambiguous: no certain name, the closest by the search words first.
        var x = IconNames.Judge("x", Icons, "o11");
        Assert.Null(x.Certain);
        Assert.Equal("times", x.Closest[0]);
    }

    [Fact]
    public void TheO11CatalogIsReadFromTheStudiosOwnPlugin()
    {
        if (IconNames.For("o11") is not { } catalog) { Assert.Null(Environment.GetEnvironmentVariable("ANVIL_STUDIO_DIR")); return; }   // no Service Studio in this host
        Assert.True(catalog.Valid.Count > 500);
        Assert.Contains("home", catalog.Valid);
        Assert.Contains("clock-o", catalog.Valid);
        Assert.DoesNotContain("clock", catalog.Valid);
    }

    // ---- LIST_ALIAS_REWRITTEN ---------------------------------------------------------------------------------------------------

    [Fact]
    public void TheAliasOfAListIsItsCurrentRowInEveryExpressionInside()
    {
        // FolhaPonto_UI 13:57:17: 'etapa' and 'dia' unknown, 9 times, in the first round.
        var html = Screen + """<var name="M2Dia" type="M2DiaDTO"/><div list="M2Dia.Etapas" as="etapa" class="m2-rows"><div class="{{ If(etapa.Feita, &quot;m2 etapa.Feita&quot;, &quot;m2&quot;) }}"><span>{{ M2Rotulo(etapa.Tipo) }}</span><div if="etapa.Feita and not M2Texto = &quot;etapa&quot;">ok</div><button onclick="M2Abrir(Quando = etapa.Quando)">abrir</button></div></div>""" + End;
        var (job, result) = Analyze(Ops(HtmlOp(html)));
        var entry = Assert.Single(Normalizations(result, HtmlDocumentRules.ListAlias));
        Assert.Contains("M2Dia.Etapas.Current", entry["to"]!.GetValue<string>());
        var written = Html(job, 0);
        Assert.DoesNotContain(" as=\"etapa\"", written);
        Assert.Contains("If(M2Dia.Etapas.Current.Feita, &quot;m2 etapa.Feita&quot;", written);   // the literal keeps its text
        Assert.Contains("M2Rotulo(M2Dia.Etapas.Current.Tipo)", written);
        Assert.Contains("if=\"M2Dia.Etapas.Current.Feita and not M2Texto = &quot;etapa&quot;\"", written);
        Assert.Contains("M2Abrir(Quando = M2Dia.Etapas.Current.Quando)", written);
        Assert.Contains("class=\"m2-rows\"", written);
    }

    [Fact]
    public void AnAliasNothingReadsAndAnInnerAliasOfTheSameNameAreLeftAsTheyAre()
    {
        var unused = Screen + """<div list="M2Lista" as="item"><span>{{ M2Lista.Current.Nome }}</span></div>""" + End;
        var (job, result) = Analyze(Ops(HtmlOp(unused)));
        Assert.Empty(Normalizations(result, HtmlDocumentRules.ListAlias));
        Assert.Equal(unused, Html(job, 0));
        // An inner list that declares the same alias keeps its own row; the outer alias is the outer row.
        var nested = Screen + """<div list="M2Grupos" as="x"><span>{{ x.Nome }}</span><div list="x.Itens" as="x"><b>{{ x.Valor }}</b></div></div>""" + End;
        var (nestedJob, nestedResult) = Analyze(Ops(HtmlOp(nested)));
        Assert.Equal(2, Normalizations(nestedResult, HtmlDocumentRules.ListAlias).Length);
        var written = Html(nestedJob, 0);
        Assert.Contains("{{ M2Grupos.Current.Nome }}", written);
        Assert.Contains("list=\"M2Grupos.Current.Itens\"", written);
        Assert.Contains("{{ M2Grupos.Current.Itens.Current.Valor }}", written);
    }

    // ---- SCREEN_TITLE_QUOTED ----------------------------------------------------------------------------------------------------

    [Fact]
    public void ATitleThatIsNoExpressionOrNamesNothingIsItsText()
    {
        var (job, result) = Analyze(Ops(HtmlOp(Screen.Replace("title=\"&quot;Tela&quot;\"", "title=\"Bater Ponto\"") + End),
            HtmlOp(Screen.Replace("M2Tela", "M2Outra").Replace("title=\"&quot;Tela&quot;\"", "title=\"Espelho\"") + End)));
        Assert.Equal(2, Normalizations(result, HtmlDocumentRules.TitleQuoted).Length);
        Assert.Contains("title=\"&quot;Bater Ponto&quot;\"", Html(job, 0));
        Assert.Contains("title=\"&quot;Espelho&quot;\"", Html(job, 1));
        // A title that reads the page's data, or a text already, stays.
        var (kept, keptResult) = Analyze(Ops(HtmlOp(Screen.Replace("title=\"&quot;Tela&quot;\"", "title=\"M2Texto + &quot; - x&quot;\"") + End),
            HtmlOp(Screen.Replace("M2Tela", "M2Outra") + End)));
        Assert.Empty(Normalizations(keptResult, HtmlDocumentRules.TitleQuoted));
        Assert.Contains("title=\"M2Texto + &quot; - x&quot;\"", Html(kept, 0));
    }

    // ---- defaults -------------------------------------------------------------------------------------------------------------

    private const string Espelho = """<screen name="M2Espelho" flow="MainFlow" title="&quot;Espelho&quot;" actions="M2Mes"><var name="M2Ref" type="Date" default="NewDate(Year(CurrDate()),Month(CurrDate()),1)"/><var name="M2Fixo" type="Integer" default="3"/><Block name="LayoutBlank"><slot name="Content"><button onclick="M2Mes">{{ M2Ref }}</button></slot></Block></screen>""";
    private const string Mes = """{"name":"M2Mes","kind":"screen","owner":"IMobileScreen:M2Espelho","steps":[{"assign":{"M2Ref":"AddMonths(M2Ref, 1)"},"as":"Avancar"}]}""";

    [Fact]
    public void AVariableDefaultThatIsNoLiteralIsAssignedInTheScreensOnInitialize()
    {
        // FolhaPonto_UI 13:59:19 (Verify): 'Default Value' must be set to a 'Date' literal value (MesReferencia).
        var (job, result) = Analyze(Ops(HtmlOp(Espelho), LogicOp(Mes)));
        var entry = Assert.Single(Normalizations(result, HtmlDocumentRules.DefaultMoved));
        Assert.Contains("M2Ref", entry["to"]!.GetValue<string>());
        var html = Html(job, 0);
        Assert.DoesNotContain("default=\"NewDate", html);
        Assert.Contains("default=\"3\"", html);   // a literal stays
        Assert.Contains("oninitialize=\"OnInitialize\"", html);
        Assert.Contains("actions=\"M2Mes,OnInitialize\"", html);
        var actions = job["ops"]![1]!["data"]!["actions"]!.AsArray();
        var init = actions.OfType<JsonObject>().Single(a => a["name"]!.GetValue<string>() == "OnInitialize");
        Assert.Equal("IMobileScreen:M2Espelho", init["owner"]!.GetValue<string>());
        Assert.Equal("screen", init["kind"]!.GetValue<string>());
        Assert.Equal("NewDate(Year(CurrDate()),Month(CurrDate()),1)", init["steps"]![0]!["assign"]!["M2Ref"]!.GetValue<string>());
        Assert.Empty(Problems(result, "DEFAULT_NOT_LITERAL"));
        // Twice is once: the second pass finds nothing to move.
        var again = JobPreflight.Analyze(job["ops"]!.AsArray(), job, []);
        Assert.Empty(Normalizations(again, HtmlDocumentRules.DefaultMoved));
    }

    [Fact]
    public void AnOnInitializeOfTheJobGetsTheAssignmentFirstAndOneElsewhereIsARefusal()
    {
        var withInit = Espelho.Replace("actions=\"M2Mes\"", "oninitialize=\"M2Iniciar\" actions=\"M2Iniciar,M2Mes\"");
        var init = """{"name":"M2Iniciar","kind":"screen","owner":"IMobileScreen:M2Espelho","steps":[{"assign":{"M2Fixo":"4"},"as":"Fixar"}]}""";
        var (job, result) = Analyze(Ops(HtmlOp(withInit), LogicOp(Mes, init)));
        Assert.Single(Normalizations(result, HtmlDocumentRules.DefaultMoved));
        var steps = job["ops"]![1]!["data"]!["actions"]![1]!["steps"]!.AsArray();
        Assert.Equal(2, steps.Count);
        Assert.Equal("NewDate(Year(CurrDate()),Month(CurrDate()),1)", steps[0]!["assign"]!["M2Ref"]!.GetValue<string>());
        // The OnInitialize the root names is not declared by this job (the base has it): ambiguous, refused with the fix.
        var (kept, refused) = Analyze(Ops(HtmlOp(withInit), LogicOp(Mes)));
        Assert.Empty(Normalizations(refused, HtmlDocumentRules.DefaultMoved));
        var problem = Assert.Single(Problems(refused, "DEFAULT_NOT_LITERAL"));
        Assert.Contains("M2Iniciar", problem["message"]!.GetValue<string>());
        Assert.Contains("default=\"NewDate", Html(kept, 0));
        // An input's default is never moved (OnInitialize would overwrite what the caller passes).
        var (_, input) = Analyze(Ops(HtmlOp(Espelho.Replace("<var name=\"M2Ref\"", "<input name=\"M2Ref\"")), LogicOp(Mes)));
        Assert.Single(Problems(input, "DEFAULT_NOT_LITERAL"));
    }

    [Fact]
    public void ALocalDefaultThatIsNoLiteralIsTheFirstAssignmentOfItsAction()
    {
        var (job, result) = Analyze(Ops(LogicOp("""{"name":"M2Contar","kind":"client","inputs":[{"name":"De","type":"Date","default":"CurrDate()","mandatory":false}],"outputs":[{"name":"N","type":"Integer","default":"0"}],"vars":[{"name":"Hoje","type":"Date","default":"CurrDate()"}],"steps":[{"assign":{"N":"DiffDays(De, Hoje)"},"as":"Contar"}]}""")));
        var entry = Assert.Single(Normalizations(result, HtmlDocumentRules.DefaultAssigned));
        Assert.Equal("/ops/0/data/actions/0/vars/0/default", entry["path"]!.GetValue<string>());
        var action = job["ops"]![0]!["data"]!["actions"]![0]!;
        Assert.Null(action["vars"]![0]!["default"]);
        Assert.Equal("CurrDate()", action["steps"]![0]!["assign"]!["Hoje"]!.GetValue<string>());
        Assert.Equal("0", action["outputs"]![0]!["default"]!.GetValue<string>());   // a literal stays
        Assert.Equal("CurrDate()", action["inputs"]![0]!["default"]!.GetValue<string>());   // an input is never moved
    }

    [Fact]
    public void Literals()
    {
        foreach (var literal in new[] { "", "3", "-1.5", "\"texto\"", "True", "false", "#2026-10-12#", "NullDate()", "NullIdentifier()", "Entities.Status.Ativo" })
            Assert.True(HtmlDocumentRules.IsLiteral(literal), literal);
        foreach (var expression in new[] { "CurrDate()", "NewDate(2026, 1, 1)", "1 + 1", "Site.Limite", "M2Texto" })
            Assert.False(HtmlDocumentRules.IsLiteral(expression), expression);
        // A mistyped literal is JobPreflight.LiteralFix's (it writes the literal), never moved.
        Assert.False(HtmlDocumentRules.MovableDefault("synthetic", "Text"));
        Assert.True(HtmlDocumentRules.MovableDefault("CurrDate()", "Date"));
    }

    [Fact]
    public void AStaticTextValueThatIsNoExpressionIsItsTextAndAnExpressionStaysAsWritten()
    {
        // Haiku_CS: record Limpeza, Nome "Limpeza pos-obra": ParserUnexpectedElement 'pos' at the Verify.
        var ops = SpecExpander.Expand(JsonNode.Parse("""{"static":[{"name":"M2Categoria","attributes":[{"name":"Nome","type":"Text","length":60},{"name":"Peso","type":"Integer"}],"records":[{"name":"Limpeza","Nome":"Limpeza pos-obra","Peso":2},{"name":"Reformas","Nome":"Reformas pequenas","Peso":1},{"name":"Citada","Nome":"\"Já citada\"","Peso":3}]}]}""")!.AsObject());
        string Value(string record) => ops.Single(o => o["target"]?.ToString() == $"$M2Categoria.{record}/Nome")["value"]!.GetValue<string>();
        Assert.Equal("\"Limpeza pos-obra\"", Value("Limpeza"));
        Assert.Equal("\"Reformas pequenas\"", Value("Reformas"));
        Assert.Equal("\"Já citada\"", Value("Citada"));
        Assert.Null(SpecExpander.TextNoExpression("Text", "Site.Nome"));        // an expression: the Verify judges it
        Assert.Null(SpecExpander.TextNoExpression("Integer", "pos-obra"));      // not a text type
        Assert.Null(SpecExpander.TextNoExpression("Text", "\"a\" + b"));        // quotes of its own
        Assert.Equal("\"Limpeza pos-obra\"", SpecExpander.TextNoExpression("Text", "Limpeza pos-obra"));
        // The job's own value, listed (a bare word is LiteralFix's, as before; an expression stays).
        var (job, result) = Analyze(Ops("""{"op":"spec","data":{"static":[{"name":"M2Categoria","attributes":[{"name":"Nome","type":"Text","length":60}],"records":[{"name":"Limpeza","Nome":"Limpeza pos-obra"},{"name":"Reformas","Nome":"Reformas"},{"name":"Outra","Nome":"Site.Padrao"}]}],"entities":[{"name":"M2Nota","attributes":[{"name":"Texto","type":"Text","default":"a-b c"}]}]}}"""));
        var entries = Normalizations(result, SpecTexts.Rule);
        Assert.Equal(2, entries.Length);
        Assert.Contains(entries, e => e["path"]!.GetValue<string>() == "/ops/0/data/static/0/records/0/Nome");
        var records = job["ops"]![0]!["data"]!["static"]![0]!["records"]!;
        Assert.Equal("\"Limpeza pos-obra\"", records[0]!["Nome"]!.GetValue<string>());
        Assert.Equal("Reformas", records[1]!["Nome"]!.GetValue<string>());
        Assert.Equal("Site.Padrao", records[2]!["Nome"]!.GetValue<string>());
        Assert.Equal("\"a-b c\"", job["ops"]![0]!["data"]!["entities"]![0]!["attributes"]![0]!["default"]!.GetValue<string>());
    }

    // ---- PARAMETER_RENAMED / NAME_COLLISION ------------------------------------------------------------------------------------

    private const string Bater = """<screen name="M2Bater" flow="MainFlow" title="&quot;Bater&quot;" actions="M2Aplicar,M2Abrir" data-actions="M2Carregar"><var name="Resumo" type="M2ResumoDTO"/><var name="Alvo" type="Integer"/><Block name="LayoutBlank"><slot name="Content"><div>{{ Resumo.Nome }} {{ M2Carregar.Resumo.Nome }}</div><button onclick="M2Abrir(Alvo = 3)">x</button><button onclick="M2Abrir(2)">y</button></slot></Block></screen>""";
    private const string Carregar = """{"name":"M2Carregar","kind":"data","owner":"IMobileScreen:M2Bater","fetch":"AtStart","outputs":[{"name":"Resumo","type":"M2ResumoDTO"}],"steps":[{"call":"M2Obter","as":"Consultar"},{"assign":{"Resumo":"Consultar.Resumo"},"as":"Devolver"}]}""";
    private const string Aplicar = """{"name":"M2Aplicar","kind":"screen","owner":"IMobileScreen:M2Bater","steps":[{"assign":{"Resumo":"M2Carregar.Resumo"},"as":"Aplicar"}]}""";
    private const string Abrir = """{"name":"M2Abrir","kind":"screen","owner":"IMobileScreen:M2Bater","inputs":[{"name":"Alvo","type":"Integer"}],"steps":[{"assign":{"Alvo":"Alvo + 1"},"as":"Guardar"}]}""";

    [Fact]
    public void AnOutputOfADataActionNamedLikeAScreenVariableIsRenamedWithEveryReference()
    {
        // FolhaPonto_UI 13:58:12: create IOutputParameter 'Resumo' under IDataAction 'CarregarHoje' collides (Resumo2).
        var (job, result) = Analyze(Ops(HtmlOp(Bater), LogicOp(Carregar, Aplicar)));
        var entry = Assert.Single(Normalizations(result, ScopeRenames.Rule));
        Assert.Equal("/ops/1/data/actions/0/outputs/0/name", entry["path"]!.GetValue<string>());
        Assert.Equal("Resumo2", entry["to"]!.GetValue<string>());
        var actions = job["ops"]![1]!["data"]!["actions"]!.AsArray();
        Assert.Equal("Resumo2", actions[0]!["outputs"]![0]!["name"]!.GetValue<string>());
        Assert.Equal("Consultar.Resumo", actions[0]!["steps"]![1]!["assign"]!["Resumo2"]!.GetValue<string>());   // its own assignment
        Assert.Equal("M2Carregar.Resumo2", actions[1]!["steps"]![0]!["assign"]!["Resumo"]!.GetValue<string>());  // the screen's variable stays
        var html = Html(job, 0);
        Assert.Contains("{{ Resumo.Nome }} {{ M2Carregar.Resumo2.Nome }}", html);
        Assert.Empty(Problems(result, "NAME_COLLISION"));
    }

    [Fact]
    public void AnInputOfAScreenActionNamedLikeAScreenVariableIsRenamedInItsReadsAndItsCalls()
    {
        var (job, result) = Analyze(Ops(HtmlOp(Bater), LogicOp(Carregar.Replace("\"Resumo\"", "\"Dados\"").Replace("{\"Dados\":\"Consultar.Resumo\"}", "{\"Dados\":\"Consultar.Resumo\"}"),
            Abrir, """{"name":"M2Outro","kind":"screen","owner":"IMobileScreen:M2Bater","steps":[{"call":"M2Abrir","as":"Chamar","args":{"Alvo":"5"}}]}""")));
        var entry = Assert.Single(Normalizations(result, ScopeRenames.Rule));
        Assert.Equal("Alvo2", entry["to"]!.GetValue<string>());
        var abrir = job["ops"]![1]!["data"]!["actions"]![1]!;
        Assert.Equal("Alvo2", abrir["inputs"]![0]!["name"]!.GetValue<string>());
        // An input is never assigned: the assignment is the screen's variable; what the body reads is the input.
        Assert.Equal("Alvo2 + 1", abrir["steps"]![0]!["assign"]!["Alvo"]!.GetValue<string>());
        Assert.Equal("5", job["ops"]![1]!["data"]!["actions"]![2]!["steps"]![0]!["args"]!["Alvo2"]!.GetValue<string>());
        var html = Html(job, 0);
        Assert.Contains("onclick=\"M2Abrir(Alvo2 = 3)\"", html);
        Assert.Contains("onclick=\"M2Abrir(2)\"", html);
    }

    [Fact]
    public void ADataActionThatAlsoReadsTheScreensNameIsRefusedWithTheRenameAsThePatchAndNoCollisionIsLeftAlone()
    {
        var reads = Carregar.Replace("\"Consultar.Resumo\"", "\"If(Resumo.Nome = &quot;&quot;, Consultar.Resumo, Resumo)\"".Replace("&quot;", "\\\""));
        var (job, result) = Analyze(Ops(HtmlOp(Bater), LogicOp(reads, Aplicar)));
        Assert.Empty(Normalizations(result, ScopeRenames.Rule));
        var problem = Assert.Single(Problems(result, "NAME_COLLISION"));
        Assert.Equal("/ops/1/data/actions/0/outputs/0/name", problem["pointer"]!.GetValue<string>());
        // No patch: renaming the declaration alone would leave the body's assignments writing the screen's variable.
        Assert.Null(problem["patch"]);
        Assert.Contains("Resumo2", problem["fix"]!.GetValue<string>());
        Assert.Equal("Resumo", job["ops"]![1]!["data"]!["actions"]![0]!["outputs"]![0]!["name"]!.GetValue<string>());
        // No name of the screen: nothing.
        var (_, clean) = Analyze(Ops(HtmlOp(Bater.Replace("name=\"Resumo\"", "name=\"Atual\"").Replace("{{ Resumo.Nome }}", "{{ Atual.Nome }}")), LogicOp(Carregar, Aplicar.Replace("{\"Resumo\":", "{\"Atual\":"))));
        Assert.Empty(Normalizations(clean, ScopeRenames.Rule));
        Assert.Empty(Problems(clean, "NAME_COLLISION"));
    }

    [Fact]
    public void AScreenOfTheBaseGivesItsNamesToo()
    {
        var ops = JsonNode.Parse(Ops(LogicOp(Carregar)))!["ops"]!.AsArray();
        var done = new List<JsonObject>();
        ScopeRenames.Normalize(ops, "/ops", "o11", owner => owner == "IMobileScreen:M2Bater" ? ["Resumo", "Filtro"] : null, done);
        var entry = Assert.Single(done);
        Assert.Equal("Resumo2", entry["to"]!.GetValue<string>());
        // A screen the base does not have and the job does not describe: nothing is known, nothing changes.
        var other = JsonNode.Parse(Ops(LogicOp(Carregar)))!["ops"]!.AsArray();
        var none = new List<JsonObject>();
        ScopeRenames.Normalize(other, "/ops", "o11", _ => null, none);
        Assert.Empty(none);
    }

    [Fact]
    public void AScreenTheJobCreatesWithRawOpsGivesItsNamesToo()
    {
        // DCIPS 30cb7c99: create IInputParameter 'CaseId' under IScreenAction 'CiPickCase' collides (the screen's input CaseId).
        var (job, result) = Analyze(Ops("""{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"M2Caso","as":"$scr"}""",
            """{"op":"create","parent":"$scr","type":"IInputParameter","name":"CaseId","as":"$in"}""",
            LogicOp("""{"name":"M2Escolher","kind":"screen","owner":"IMobileScreen:M2Caso","inputs":[{"name":"CaseId","type":"Integer"}],"steps":[{"node":"IDestinationNode","as":"Abrir","properties":{"Destination":"IMobileScreen:M2Caso"},"args":{"CaseId":"CaseId"}}]}""")));
        var entry = Assert.Single(Normalizations(result, ScopeRenames.Rule));
        Assert.Equal("CaseId2", entry["to"]!.GetValue<string>());
        var action = job["ops"]![2]!["data"]!["actions"]![0]!;
        Assert.Equal("CaseId2", action["inputs"]![0]!["name"]!.GetValue<string>());
        // The destination's input keeps its name; the value is the action's input.
        Assert.Equal("CaseId2", action["steps"]![0]!["args"]!["CaseId"]!.GetValue<string>());
    }

    [Fact]
    public void AnInputAnEventFillsByNameIsNeverRenamed()
    {
        // DCIPS 30cb7c99: @OnPick='CiPickCase' passes the block event's CaseId to the input CaseId; renamed CaseId2 it got nothing.
        var (job, result) = Analyze(Ops("""{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"M2Caso","as":"$scr"}""",
            """{"op":"create","parent":"$scr","type":"IInputParameter","name":"CaseId","as":"$in"}""",
            LogicOp("""{"name":"M2Escolher","kind":"screen","owner":"IMobileScreen:M2Caso","inputs":[{"name":"CaseId","type":"Integer"}],"steps":[{"node":"IDestinationNode","as":"Abrir","properties":{"Destination":"IMobileScreen:M2Caso"},"args":{"CaseId":"CaseId"}}]}"""),
            """{"op":"html","parent":"$scr/#IMobileBlockInstanceWidget/MainContent","html":"<Block id='Picker' name='M2Picker' @OnPick='M2Escolher'></Block>"}"""));
        Assert.Empty(Normalizations(result, ScopeRenames.Rule));
        var problem = Assert.Single(Problems(result, "NAME_COLLISION"));
        Assert.Contains("@OnPick", problem["message"]!.GetValue<string>());
        Assert.Equal("CaseId", job["ops"]![2]!["data"]!["actions"]![0]!["inputs"]![0]!["name"]!.GetValue<string>());
    }

    [Fact]
    public void TwoDeclarationsOfOneNameInADocumentAreRefused()
    {
        var (_, result) = Analyze(Ops(HtmlOp(Bater.Replace("<var name=\"Alvo\" type=\"Integer\"/>", "<var name=\"Alvo\" type=\"Integer\"/><input name=\"alvo\" type=\"Integer\"/>"))));
        var problem = Assert.Single(Problems(result, "NAME_COLLISION"));
        Assert.Contains("alvo", problem["message"]!.GetValue<string>(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AnO11ParameterNamedRolesCollides()
    {
        var (_, o11) = Analyze(Ops(LogicOp("""{"name":"M2Enviar","inputs":[{"name":"Roles","type":"Text"}],"steps":[{"assign":{},"as":"Nada"}]}""")));
        if (MessageExpectations.Lane != "o11") return;
        Assert.Single(Problems(o11, "NAME_COLLISION"));
    }

    // ---- NODE_NOT_ALLOWED -------------------------------------------------------------------------------------------------------

    private sealed class Module(string type) : IBaseFacts
    {
        public IReadOnlyDictionary<string, string>? Attributes(string record) => null;
        public bool IsClientEntity(string name) => false;
        public CalleeFact? Callee(string target, JsonObject caller) => null;
        public bool HasName(string name) => true;
        public bool NamesOnlyTypes(string name) => false;
        public RawExpressionFact? RawExpression(string target, string prop) => null;
        public bool IsFunction(string name) => false;
        public string? ModuleType => type;
    }

    private const string Exportar = """{"name":"M2Exportar","kind":"screen","owner":"IMobileScreen:M2Espelho","steps":[{"call":"M2Gerar","as":"Gerar"},{"node":"IDownloadNode","as":"Baixar","properties":{"FileContent":"Gerar.Arquivo","FileName":"Gerar.Nome","MimeType":"\"application/pdf\"","SaveToDisk":true}}]}""";

    [Fact]
    public void ADownloadInAMobileModuleIsRefusedWithTheJavaScriptClientActionAsThePatch()
    {
        // FolhaPonto_UI 13:58:43: Nodes of type IDownloadNode are not allowed in IScreenAction or eSpaces of type Mobile.
        var job = JsonNode.Parse(Ops(LogicOp(Exportar)))!;
        var ops = job["ops"]!.AsArray();
        var found = PreflightChecks.WithModule(ops, "/ops", "o11", new Module("Mobile"));
        var problem = Assert.Single(found.Problems);
        Assert.Equal(NodeRules.Code, problem["code"]!.GetValue<string>());
        Assert.Equal("/ops/0/data/actions/0/steps/1", problem["pointer"]!.GetValue<string>());
        var patch = problem["patch"]!.AsArray();
        Assert.Equal(2, patch.Count);
        var call = patch[0]!["value"]!;
        Assert.Equal("DownloadFile", call["call"]!.GetValue<string>());
        Assert.Equal("Gerar.Arquivo", call["args"]!["FileContent"]!.GetValue<string>());
        Assert.Equal("/ops/0/data/actions/-", patch[1]!["path"]!.GetValue<string>());
        var helper = patch[1]!["value"]!;
        Assert.Equal("client", helper["kind"]!.GetValue<string>());
        Assert.Contains("atob(", helper["steps"]![0]!["properties"]!["JavaScript"]!.GetValue<string>());
        // The patch is a job the logic grammar compiles.
        var patched = ops.DeepClone().AsArray();
        patched[0]!["data"]!["actions"]![0]!["steps"]![1] = call.DeepClone();
        patched[0]!["data"]!["actions"]!.AsArray().Add(helper.DeepClone());
        foreach (var action in patched[0]!["data"]!["actions"]!.AsArray())
            LogicExpander.Expand(new JsonObject { ["actions"] = new JsonArray(action!.DeepClone()) });
        Assert.Empty(PreflightChecks.WithModule(patched, "/ops", "o11", new Module("Mobile")).Problems);
    }

    [Fact]
    public void ADownloadInAReactiveModuleIsItsOwnAndAnAjaxRefreshIsOnlyTraditional()
    {
        var ops = JsonNode.Parse(Ops(LogicOp(Exportar)))!["ops"]!.AsArray();
        Assert.Empty(PreflightChecks.WithModule(ops, "/ops", "o11", new Module("CrossDevice")).Problems);
        Assert.Empty(PreflightChecks.WithModule(ops, "/ops", "o11", new Module("WebResponsive")).Problems);
        // Unknown module type: nothing is judged.
        Assert.Empty(NodeRules.Check(ops, "/ops", JobFacts.From(ops), null));
        var ajax = JsonNode.Parse(Ops(LogicOp("""{"name":"M2Atualizar","kind":"screen","owner":"IMobileScreen:M2Espelho","steps":[{"node":"IAjaxRefreshNode","properties":{"WidgetOrWebBlock":"IContainer:M2Caixa"}}]}""")))!["ops"]!.AsArray();
        Assert.Single(NodeRules.Check(ajax, "/ops", JobFacts.From(ajax), "CrossDevice"));
        Assert.Empty(NodeRules.Check(ajax, "/ops", JobFacts.From(ajax), "WebResponsive"));
    }

    // ---- ARGUMENT_RENAMED (System list actions) ---------------------------------------------------------------------------------

    [Fact]
    public void TheListArgumentOfASystemListActionIsTheInputThatActionHas()
    {
        // DCIPS (34 rounds): IExecuteServerActionNode 'FilterModuleVersions' has no child 'List' (ListFilter reads SourceList).
        var (job, result) = Analyze(Ops(LogicOp("""{"name":"M2Filtrar","inputs":[{"name":"Itens","type":"Text List"}],"outputs":[{"name":"N","type":"Integer"}],"steps":[{"call":"ListFilter","as":"Filtrar","args":{"List":"Itens","Condition":"Itens.Current <> \"\""}},{"call":"ListIndexOf","as":"Achar","args":{"SourceList":"Itens","Condition":"Itens.Current = \"x\""}},{"call":"ListAppend","as":"Somar","args":{"List":"Itens","Element":"\"y\""}},{"assign":{"N":"Achar.Position"},"as":"Fim"}]}""")));
        if (MessageExpectations.Lane != "o11") return;
        var entries = Normalizations(result, SystemCalls.Rule);
        Assert.Equal(2, entries.Length);
        var steps = job["ops"]![0]!["data"]!["actions"]![0]!["steps"]!;
        Assert.Equal(new[] { "SourceList", "Condition" }, steps[0]!["args"]!.AsObject().Select(kv => kv.Key));   // the order kept
        Assert.Equal("List", steps[1]!["args"]!.AsObject().First().Key);
        Assert.Equal("List", steps[2]!["args"]!.AsObject().First().Key);   // already right: untouched
        Assert.Equal("/ops/0/data/actions/0/steps/0/args/List", entries[0]["path"]!.GetValue<string>());
    }

    [Fact]
    public void AnActionOfTheJobWithTheNameOfASystemListActionIsItsOwnCallee()
    {
        var (job, result) = Analyze(Ops(LogicOp("""{"name":"ListFilter","inputs":[{"name":"List","type":"Text List"}],"steps":[{"assign":{},"as":"Nada"}]}""",
            """{"name":"M2Usar","inputs":[{"name":"Itens","type":"Text List"}],"steps":[{"call":"ListFilter","as":"Filtrar","args":{"List":"Itens"}}]}""")));
        Assert.Empty(Normalizations(result, SystemCalls.Rule));
        Assert.Equal("List", job["ops"]![0]!["data"]!["actions"]![1]!["steps"]![0]!["args"]!.AsObject().First().Key);
        // Both names passed: ambiguous, left for the checks.
        var (both, bothResult) = Analyze(Ops(LogicOp("""{"name":"M2Usar","inputs":[{"name":"Itens","type":"Text List"}],"steps":[{"call":"ListFilter","as":"Filtrar","args":{"List":"Itens","SourceList":"Itens","Condition":"True"}}]}""")));
        Assert.Empty(Normalizations(bothResult, SystemCalls.Rule));
        Assert.Equal(3, both["ops"]![0]!["data"]!["actions"]![0]!["steps"]![0]!["args"]!.AsObject().Count);
    }

    // ---- the cascade of a failed op ----------------------------------------------------------------------------------------------

    [Fact]
    public void TheVerifyOfActionsAFailedOpDeclaresIsItsCascade()
    {
        var ops = JsonNode.Parse(Ops(HtmlOp(Espelho), LogicOp(Mes, Exportar)))!["ops"]!.AsArray();
        JsonObject Verify(string action) => new() { ["phase"] = "verify", ["op"] = 0, ["code"] = "InvalidFlow_NoStart",
            ["message"] = $"Error InvalidFlow_NoStart: Invalid Client Action Flow | Start is required in {action}. @ M2_UI (ESpace) / MainFlow (MobileFlow) / M2Espelho (MobileScreen) / {action} (ScreenAction)" };
        var verify = new[] { Verify("M2Mes"), Verify("M2Outra") };
        // The logic op failed whole: its actions are its cascade, another action is not.
        var whole = JobRunner.CascadeOfFailedOps(verify, [new JsonObject { ["phase"] = "apply", ["op"] = 1, ["pointer"] = "/ops/1", ["code"] = "APPLY_FAILED" }], ops, "/ops");
        Assert.Equal("M2Mes", Assert.Single(whole)["message"]!.GetValue<string>().Split("required in ")[1].Split('.')[0]);
        // One action failed: only that one.
        var one = JobRunner.CascadeOfFailedOps(verify, [new JsonObject { ["phase"] = "apply", ["op"] = 1, ["pointer"] = "/ops/1/data/actions/1", ["code"] = "APPLY_FAILED" }], ops, "/ops");
        Assert.Empty(one);
        // Nothing failed: nothing is a cascade.
        Assert.Empty(JobRunner.CascadeOfFailedOps(verify, [], ops, "/ops"));
    }

    // ---- motor2 review: the answer speaks of the job as sent ---------------------------------------------------------------------

    /// <summary>A JSON Patch (replace, add) applied as the facade's job-patch applies it to the job the model has.</summary>
    private static void ApplyPatch(JsonNode job, JsonArray patch)
    {
        foreach (var step in patch.OfType<JsonObject>())
        {
            var segments = step["path"]!.GetValue<string>().Split('/').Skip(1).Select(s => s.Replace("~1", "/").Replace("~0", "~")).ToArray();
            var node = job;
            foreach (var s in segments[..^1]) node = node is JsonArray a ? a[int.Parse(s)]! : node[s]!;
            var last = segments[^1];
            var value = step["value"]!.DeepClone();
            switch (node)
            {
                case JsonArray a when last == "-": a.Add(value); break;
                case JsonArray a when step["op"]!.GetValue<string>() == "add": a.Insert(int.Parse(last), value); break;
                case JsonArray a: a[int.Parse(last)] = value; break;
                default: node[last] = value; break;
            }
        }
    }

    // ExportarPDF of the review's variant of FolhaPonto's job 1: a local with a default that is no literal (a step is inserted
    // first), then the Download, then the assign that ends the export.
    private const string ExportarComInicio = """{"name":"M2Exportar","kind":"screen","owner":"IMobileScreen:M2Espelho","vars":[{"name":"Inicio","type":"Date Time","default":"CurrDateTime()"}],"steps":[{"call":"M2Gerar","as":"Gerar"},{"node":"IDownloadNode","as":"Baixar","properties":{"FileContent":"Gerar.Arquivo","FileName":"Gerar.Nome","MimeType":"\"application/pdf\""}},{"assign":{"M2Ocupado":"False"},"as":"ConcluirExportacao"}]}""";

    [Fact]
    public void APointerAndAPatchAfterAStepTheKernelInsertedAreTheOnesOfTheJobAsSent()
    {
        var sent = JsonNode.Parse(Ops(LogicOp(ExportarComInicio)))!;
        var job = sent.DeepClone();
        var ops = job["ops"]!.AsArray();
        var entries = JobNormalizer.Pure(ops, "/ops", "o11");
        Assert.Equal("SetInitialValues", ops[0]!["data"]!["actions"]![0]!["steps"]![0]!["as"]!.GetValue<string>());   // inserted first
        Assert.Contains(entries, e => e["path"]!.GetValue<string>() == "/ops/0/data/actions/0/vars/0/default");
        var found = PreflightChecks.WithModule(ops, "/ops", "o11", new Module("Mobile"));
        var problem = Assert.Single(found.Problems);
        Assert.Equal("/ops/0/data/actions/0/steps/2", problem["pointer"]!.GetValue<string>());   // the normalized job
        SentJob.TranslateAll(found.Problems, ops, "/ops");
        Assert.Equal("/ops/0/data/actions/0/steps/1", problem["pointer"]!.GetValue<string>());   // the job as sent
        // The patch, applied to the job the model has, replaces the Download and keeps ConcluirExportacao.
        ApplyPatch(sent, problem["patch"]!.AsArray());
        var steps = sent["ops"]![0]!["data"]!["actions"]![0]!["steps"]!.AsArray();
        Assert.Equal(3, steps.Count);
        Assert.Equal("DownloadFile", steps[1]!["call"]!.GetValue<string>());
        Assert.Equal("ConcluirExportacao", steps[2]!["as"]!.GetValue<string>());
        Assert.Equal("DownloadFile", sent["ops"]![0]!["data"]!["actions"]![1]!["name"]!.GetValue<string>());
        // A pointer into the inserted step is the default it came from; a patch into it has no place in the sent job.
        Assert.Equal(("/ops/0/data/actions/0/vars/0/default", false), SentJob.ToSent("/ops/0/data/actions/0/steps/0/assign/Inicio", ops, "/ops"));
        var inside = JobPreflight.Problem(0, "/ops/0/data/actions/0/steps/0/assign/Inicio", "X", "error", "m", "f",
            new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = "/ops/0/data/actions/0/steps/0/assign/Inicio", ["value"] = "1" }));
        SentJob.Translate(inside, ops, "/ops");
        Assert.Null(inside["patch"]);
        Assert.Equal("/ops/0/data/actions/0/vars/0/default", inside["pointer"]!.GetValue<string>());
    }

    [Fact]
    public void TheRefusalOfTheJobAlonePointsIntoTheJobAsSent()
    {
        // The pure preflight: a problem of a step after the inserted one points at the step the author wrote.
        var (_, result) = Analyze(Ops(LogicOp("""{"name":"M2Contar","kind":"client","vars":[{"name":"Hoje","type":"Date","default":"CurrDate()"}],"outputs":[{"name":"N","type":"Integer"}],"steps":[{"assign":{"N":"DiffDays(Hoje, Hoje) +"},"as":"Contar"}]}""")));
        var pointers = result["problems"]!.AsArray().Select(p => p!["pointer"]?.GetValue<string>()).OfType<string>().ToList();
        Assert.Contains(pointers, p => p.StartsWith("/ops/0/data/actions/0/steps/0/", StringComparison.Ordinal));
        Assert.All(pointers.Where(p => p.Contains("/steps/")), p => Assert.StartsWith("/ops/0/data/actions/0/steps/0", p));
        // The renamed key of an assignment is written as sent.
        var (job, renamed) = Analyze(Ops(HtmlOp(Bater), LogicOp(Carregar, Aplicar)));
        var ops = job["ops"]!.AsArray();
        Assert.Equal(("/ops/1/data/actions/0/steps/1/assign/Resumo", true), SentJob.ToSent("/ops/1/data/actions/0/steps/1/assign/Resumo2", ops, "/ops"));
        Assert.Single(Normalizations(renamed, ScopeRenames.Rule));
    }

    [Fact]
    public void ThePatchOfAnUnknownIconIsTheHtmlAsSentWithOnlyTheIconChanged()
    {
        // Review probe P16: the patch replaced the html with the normalized one (default dropped, OnInitialize named that no op declared).
        IconNames.Override = Icons;
        try
        {
            var espelho = Espelho.Replace("<button onclick=\"M2Mes\">", "<button onclick=\"M2Mes\"><i icon=\"schedule\"></i>");
            var sent = JsonNode.Parse(Ops(HtmlOp(espelho), LogicOp(Mes)))!;
            var (_, result) = Analyze(sent.ToJsonString());
            Assert.Single(Normalizations(result, HtmlDocumentRules.DefaultMoved));
            var problem = Assert.Single(Problems(result, "ICON_UNKNOWN"));
            var patch = problem["patch"]!.AsArray();
            var value = Assert.Single(patch)!["value"]!.GetValue<string>();
            Assert.Equal(espelho.Replace("icon=\"schedule\"", "icon=\"clock-o\""), value);
            ApplyPatch(sent, patch);
            var (again, second) = Analyze(sent.ToJsonString());
            Assert.Empty(Problems(second, "ICON_UNKNOWN"));
            Assert.Single(Normalizations(second, HtmlDocumentRules.DefaultMoved));   // the default is still there to move
            Assert.Contains(again["ops"]![1]!["data"]!["actions"]!.AsArray(), a => a!["name"]!.GetValue<string>() == "OnInitialize");
        }
        finally { IconNames.Override = null; }
    }

    [Fact]
    public void APatchThatWritesANormalizedDocumentCarriesTheOnInitializeItNames()
    {
        var job = JsonNode.Parse(Ops(HtmlOp(Espelho), LogicOp(Mes)))!;
        var ops = job["ops"]!.AsArray();
        JobNormalizer.Pure(ops, "/ops", "o11");
        var normalized = Html(job, 0);
        Assert.Contains("oninitialize=\"OnInitialize\"", normalized);
        // Any patch that writes this html whole (a correction of the compiler over it) brings the action it names.
        var problem = JobPreflight.Problem(0, "/ops/0/data/html", "HTML_X", "error", "m", "f",
            new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = "/ops/0/data/html", ["value"] = normalized }));
        SentJob.Translate(problem, ops, "/ops");
        var patch = problem["patch"]!.AsArray();
        Assert.Equal(2, patch.Count);
        Assert.Equal("/ops/1/data/actions/-", patch[1]!["path"]!.GetValue<string>());
        Assert.Equal("OnInitialize", patch[1]!["value"]!["name"]!.GetValue<string>());
        var sent = JsonNode.Parse(Ops(HtmlOp(Espelho), LogicOp(Mes)))!;
        ApplyPatch(sent, patch);
        var (_, after) = Analyze(sent.ToJsonString());
        Assert.Empty(Normalizations(after, HtmlDocumentRules.DefaultMoved));   // nothing left to move: the patched job is whole
        Assert.Empty(Problems(after, "DEFAULT_NOT_LITERAL"));
    }

    [Fact]
    public void TheAliasOfAListIsNeverTheNameOfAnEventsArgument()
    {
        // Review probe P01: alias 'item' and the input 'Item' of the screen action the event calls.
        var html = Screen + """<var name="M2Itens" type="Text List"/><div list="M2Itens" as="item"><button onclick="M2Ir(Item = item)">{{ item }}</button><button onclick="M2Ir(item)">x</button></div>""" + End;
        var (job, result) = Analyze(Ops(HtmlOp(html)));
        Assert.Single(Normalizations(result, HtmlDocumentRules.ListAlias));
        var written = Html(job, 0);
        Assert.Contains("onclick=\"M2Ir(Item = M2Itens.Current)\"", written);
        Assert.Contains("onclick=\"M2Ir(M2Itens.Current)\"", written);   // by position: the expression
        Assert.Contains("{{ M2Itens.Current }}", written);
    }

    [Fact]
    public void TheAliasOfAnAggregatesListNamesItsEntityAndAnAggregateWithoutSourcesIsRefused()
    {
        // Review probe P03: GetPedidos.List.Current.Numero lost the entity segment (the row of an aggregate names its source).
        var aggregate = Screen.Replace("<var name=\"M2Texto\" type=\"Text\"/>", "<var name=\"M2Texto\" type=\"Text\"/><aggregate name=\"GetPedidos\" from=\"Pedido\"/>")
            + """<div list="GetPedidos.List" as="p"><span>{{ p.Numero }}</span><span>{{ p.Pedido.Id }}</span></div>""" + End;
        var (job, result) = Analyze(Ops(HtmlOp(aggregate)));
        var entry = Assert.Single(Normalizations(result, HtmlDocumentRules.ListAlias));
        Assert.Contains("GetPedidos.List.Current.Pedido.X", entry["to"]!.GetValue<string>());
        var written = Html(job, 0);
        Assert.Contains("{{ GetPedidos.List.Current.Pedido.Numero }}", written);
        Assert.Contains("{{ GetPedidos.List.Current.Pedido.Id }}", written);   // the source named: kept as written
        // An aggregate whose sources the document does not write: the row is not certain, refused.
        var unknown = aggregate.Replace(" from=\"Pedido\"", "");
        var (kept, refused) = Analyze(Ops(HtmlOp(unknown)));
        Assert.Empty(Normalizations(refused, HtmlDocumentRules.ListAlias));
        Assert.Single(Problems(refused, HtmlDocumentRules.AliasAmbiguous));
        Assert.Contains(" as=\"p\"", Html(kept, 0));
    }

    [Fact]
    public void AnOutputRenameReachesEveryExpressionOfTheDocument()
    {
        // Review probe P13: if=, a title="{{ }}" and an event argument kept Carregar.Resumo (the quotes of the attributes were
        // taken for text literals); only the {{ }} of a text was renamed.
        var html = """<screen name="M2A" flow="MainFlow" title="&quot;A&quot;" roles="Registered" actions="M2Ir" data-actions="M2Carregar"><var name="Resumo" type="Text"/>"""
            + """<div if="M2Carregar.Resumo &lt;&gt; &quot;&quot;"><span title="{{ M2Carregar.Resumo }}">{{ M2Carregar.Resumo }}</span><button onclick="M2Ir(Texto = M2Carregar.Resumo)">Ir</button></div></screen>""";
        var (job, result) = Analyze(Ops(HtmlOp(html), LogicOp("""{"name":"M2Ir","kind":"screen","owner":"IMobileScreen:M2A","inputs":[{"name":"Texto","type":"Text"}],"steps":[]}""",
            """{"name":"M2Carregar","kind":"data","owner":"IMobileScreen:M2A","outputs":[{"name":"Resumo","type":"Text"}],"steps":[{"assign":{"Resumo":"\"a\""}}]}""")));
        var entry = Assert.Single(Normalizations(result, ScopeRenames.Rule));
        Assert.Contains("5 reference(s)", entry["message"]!.GetValue<string>());   // its own assignment and the four of the document
        var written = Html(job, 0);
        Assert.DoesNotContain("M2Carregar.Resumo ", written);
        Assert.DoesNotContain("M2Carregar.Resumo)", written);
        Assert.DoesNotContain("M2Carregar.Resumo }}", written);
        Assert.Contains("if=\"M2Carregar.Resumo2 &lt;&gt; &quot;&quot;\"", written);
        Assert.Contains("title=\"{{ M2Carregar.Resumo2 }}\"", written);
        Assert.Contains("M2Ir(Texto = M2Carregar.Resumo2)", written);
    }

    private const string TelaA = """<screen name="M2A" flow="MainFlow" title="&quot;A&quot;" roles="Registered" actions="M2Ir" data-actions="M2Carregar"><var name="Resumo" type="Text"/><span>{{ M2Carregar.Resumo }}</span></screen>""";
    private const string TelaB = """<screen name="M2B" flow="MainFlow" title="&quot;B&quot;" roles="Registered" actions="M2Ir" data-actions="M2Carregar"><span>{{ M2Carregar.Resumo }}</span></screen>""";
    private static string CarregarDe(string screen) => """{"name":"M2Carregar","kind":"data","owner":"IMobileScreen:SCREEN","outputs":[{"name":"Resumo","type":"Text"}],"steps":[{"assign":{"Resumo":"\"x\""}}]}""".Replace("SCREEN", screen);
    private static string IrDe(string screen) => """{"name":"M2Ir","kind":"screen","owner":"IMobileScreen:SCREEN","steps":[]}""".Replace("SCREEN", screen);

    [Fact]
    public void AnOutputRenameNeverTouchesASetOfAnotherScreenAndRefusesOneWhoseScreenIsNotSaid()
    {
        // Review probe P06: the set on B's label read B's M2Carregar.Resumo and was rewritten Resumo2.
        var (job, result) = Analyze(Ops(HtmlOp(TelaA), HtmlOp(TelaB), LogicOp(IrDe("M2A"), CarregarDe("M2A"), IrDe("M2B"), CarregarDe("M2B")),
            """{"op":"set","target":"IMobileScreen:M2B/Rotulo","prop":"Text","value":"M2Carregar.Resumo"}""",
            """{"op":"set","target":"IMobileScreen:M2A/Rotulo","prop":"Text","value":"M2Carregar.Resumo"}"""));
        Assert.Single(Normalizations(result, ScopeRenames.Rule));
        Assert.Equal("M2Carregar.Resumo", job["ops"]![3]!["value"]!.GetValue<string>());    // B's
        Assert.Equal("M2Carregar.Resumo2", job["ops"]![4]!["value"]!.GetValue<string>());   // A's
        Assert.Contains("{{ M2Carregar.Resumo }}", Html(job, 1));
        // A set on an element whose screen the job does not say: not certain, refused, nothing renamed.
        var (kept, refused) = Analyze(Ops(HtmlOp(TelaA), LogicOp(IrDe("M2A"), CarregarDe("M2A")),
            """{"op":"set","target":"@AbCdEfGhIjKlMnOpQrStUv","prop":"Text","value":"M2Carregar.Resumo"}"""));
        Assert.Empty(Normalizations(refused, ScopeRenames.Rule));
        var problem = Assert.Single(Problems(refused, "NAME_COLLISION"));
        Assert.Contains("op #2", problem["message"]!.GetValue<string>());
        Assert.Equal("Resumo", kept["ops"]![1]!["data"]!["actions"]![1]!["outputs"]![0]!["name"]!.GetValue<string>());
        // An alias the job creates under the screen says it.
        var (aliased, aliasedResult) = Analyze(Ops(HtmlOp(TelaA), LogicOp(IrDe("M2A"), CarregarDe("M2A")),
            """{"op":"create","parent":"IMobileScreen:M2A/MainContent","type":"IExpression","name":"Rotulo","as":"$rot"}""",
            """{"op":"set","target":"$rot","prop":"Value","value":"M2Carregar.Resumo"}"""));
        Assert.Single(Normalizations(aliasedResult, ScopeRenames.Rule));
        Assert.Equal("M2Carregar.Resumo2", aliased["ops"]![3]!["value"]!.GetValue<string>());
    }

    [Fact]
    public void AnInputRenameRenamesTheArgumentOfTheCallNeverAComparisonInsideIt()
    {
        // Review probe P07: Aplicar(Filtro = If(Filtro = "", "todos", Filtro)) became Aplicar(Filtro2 = If(Filtro2 = "", ...)).
        var html = """<screen name="M2F" flow="MainFlow" title="&quot;F&quot;" roles="Registered" actions="M2Aplicar"><var name="Filtro" type="Text"/>"""
            + """<button onclick="M2Aplicar(Filtro = If(Filtro = &quot;&quot;, &quot;todos&quot;, Filtro))">Ok</button></screen>""";
        var (job, result) = Analyze(Ops(HtmlOp(html), LogicOp("""{"name":"M2Aplicar","kind":"screen","owner":"IMobileScreen:M2F","inputs":[{"name":"Filtro","type":"Text"}],"steps":[{"assign":{"Filtro":"Filtro"}}]}""")));
        Assert.Single(Normalizations(result, ScopeRenames.Rule));
        Assert.Contains("onclick=\"M2Aplicar(Filtro2 = If(Filtro = &quot;&quot;, &quot;todos&quot;, Filtro))\"", Html(job, 0));
    }

    [Fact]
    public void ADefaultThatReadsDataTheScreenFetchesIsNeverMovedToOnInitialize()
    {
        // Review probe P05: moved before the fetch, Primeiro was "" and Total 1, in silence.
        var html = """<screen name="M2D" flow="MainFlow" title="&quot;D&quot;" roles="Registered" actions="M2Abrir" data-actions="M2Carregar"><aggregate name="GetNomes" from="Pessoa"/>"""
            + """<var name="Primeiro" type="Text" default="GetNomes.List.Current.Pessoa.Nome"/><var name="Total" type="Integer" default="M2Carregar.Quantidade + 1"/><var name="Hoje" type="Date" default="CurrDate()"/></screen>""";
        var (job, result) = Analyze(Ops(HtmlOp(html), LogicOp("""{"name":"M2Abrir","kind":"screen","owner":"IMobileScreen:M2D","steps":[]}""",
            """{"name":"M2Carregar","kind":"data","owner":"IMobileScreen:M2D","outputs":[{"name":"Quantidade","type":"Integer"}],"steps":[{"assign":{"Quantidade":"3"}}]}""")));
        var moved = Assert.Single(Normalizations(result, HtmlDocumentRules.DefaultMoved));   // only Hoje
        Assert.Contains("Hoje", moved["to"]!.GetValue<string>());
        var refused = Problems(result, "DEFAULT_NOT_LITERAL");
        Assert.Equal(2, refused.Length);
        Assert.Contains(refused, p => p["message"]!.GetValue<string>().Contains("GetNomes") && p["fix"]!.GetValue<string>().Contains("On After Fetch of GetNomes"));
        Assert.Contains(refused, p => p["message"]!.GetValue<string>().Contains("M2Carregar"));
        var written = Html(job, 0);
        Assert.Contains("default=\"GetNomes.List.Current.Pessoa.Nome\"", written);
        Assert.Contains("default=\"M2Carregar.Quantidade + 1\"", written);
        Assert.DoesNotContain("default=\"CurrDate()\"", written);
    }

    [Fact]
    public void ATitleThatIsAPathOrATypoOfADeclaredNameIsRefusedNeverShownAsText()
    {
        // Review probe P04d: title="Usuario.Nome" (Usuario undeclared) became the visible text "Usuario.Nome".
        foreach (var title in new[] { "Usuario.Nome", "M2Textp" })
        {
            var html = Screen.Replace("title=\"&quot;Tela&quot;\"", $"title=\"{title}\"") + End;
            var (job, result) = Analyze(Ops(HtmlOp(html)));
            Assert.Empty(Normalizations(result, HtmlDocumentRules.TitleQuoted));
            var problem = Assert.Single(Problems(result, HtmlDocumentRules.TitleUnresolved));
            Assert.Contains("M2Texto", problem["message"]!.GetValue<string>());   // the closest declared name
            Assert.Equal(html, Html(job, 0));
        }
    }

    [Fact]
    public void IconNamesOfOtherLibrariesAndExactSearchWordsGiveTheIconNeverTheSpelling()
    {
        Assert.Equal("home", IconNames.Judge("fa-solid fa-home", Icons, "o11").Certain);
        Assert.Equal("home", IconNames.Judge("fas fa-home fa-fw", Icons, "o11").Certain);
        var house = IconNames.Judge("fa-solid fa-house", Icons, "o11");
        Assert.Null(house.Certain);
        Assert.Equal("home", house.Suggested);
        Assert.Equal("clock-o", IconNames.Judge("schedule", Icons, "o11").Suggested);
        Assert.Equal("clock-o", IconNames.Judge("access_time", Icons, "o11").Suggested);
        Assert.Equal("user", IconNames.Judge("person", Icons, "o11").Suggested);
        Assert.Equal("trash", IconNames.Judge("delete", Icons, "o11").Suggested);
        Assert.Equal("times", IconNames.Judge("x", Icons, "o11").Suggested);   // one id has the word
        Assert.Null(IconNames.Judge("banana", Icons, "o11").Suggested);
        Assert.Null(IconNames.Judge("person-x", Icons, "o11").Suggested);
        // A table name whose target the catalog does not have gives nothing (more_vert: ellipsis-v is not in this catalog).
        Assert.Null(IconNames.Judge("more_vert", Icons, "o11").Suggested);
    }

    [Fact]
    public void TheDownloadPatchRunsInTheRefusedRoundsApplyAndSaysWhetherItWasProven()
    {
        // Review: the op of the Download was skipped whole in round 1 (three sets with it) and its patch went out unproven.
        var job = JsonNode.Parse(Ops(LogicOp(ExportarComInicio)))!;
        var ops = job["ops"]!.AsArray();
        JobNormalizer.Pure(ops, "/ops", "o11");
        var problems = PreflightChecks.WithModule(ops, "/ops", "o11", new Module("Mobile")).Problems;
        NodeRules.ApplyForDiagnosis(ops, problems, "/ops");
        var actions = ops[0]!["data"]!["actions"]!.AsArray();
        Assert.Equal("DownloadFile", actions[0]!["steps"]![2]!["call"]!.GetValue<string>());   // the op as the patch writes it
        Assert.Equal("DownloadFile", actions[1]!["name"]!.GetValue<string>());
        SentJob.TranslateAll(problems, ops, "/ops");
        var problem = Assert.Single(problems);
        Assert.Equal("/ops/0/data/actions/0/steps/1", problem["pointer"]!.GetValue<string>());
        // What the apply or the Verify finds in what the patch wrote is at the problem's place.
        Assert.Equal(("/ops/0/data/actions/0/steps/1", false), SentJob.ToSent("/ops/0/data/actions/1/steps/0", ops, "/ops"));
        Assert.Equal(("/ops/0/data/actions/0/steps/1", true), SentJob.ToSent("/ops/0/data/actions/0/steps/2", ops, "/ops"));
        Assert.Equal("/ops/0/data/actions/0/steps/2", SentJob.ToSent("/ops/0/data/actions/0/steps/3", ops, "/ops").Pointer);
        NodeRules.Proven(problems, [], [], "/ops");
        Assert.True(problem["patchProven"]!.GetValue<bool>());
        var verify = new JsonObject { ["phase"] = "verify", ["op"] = 0, ["pointer"] = "/ops/0/data/actions/0/steps/1", ["code"] = "X", ["message"] = "in DownloadFile" };
        var again = JsonNode.Parse(problem.ToJsonString())!.AsObject();
        NodeRules.Proven([again], [], [verify], "/ops");
        Assert.False(again["patchProven"]!.GetValue<bool>());
        // The union keeps what the Verify found at the place of a patch the round ran: a fault of the patched op.
        var union = JobRunner.Union([again, verify], "/ops");
        Assert.Equal(2, union.Count);
        Assert.Null(JobPreflight.PublicProblem(again)["_diagnosisPatch"]);
    }

    // ---- the first round of the FolhaPonto_UI session, synthetic --------------------------------------------------------------

    [Fact]
    public void TheFirstRoundOfTheSessionComesBackNormalizedWithOnlyTheDownloadToFix()
    {
        IconNames.Override = Icons;
        try
        {
            var bater = """<screen name="M2Bater" flow="MainFlow" title="Bater Ponto" actions="M2Ir" data-actions="M2Carregar"><var name="Resumo" type="M2ResumoDTO"/><Block name="LayoutBlank"><slot name="Content"><div list="Resumo.Etapas" as="etapa"><span>{{ etapa.Nome }}</span></div><button onclick="M2Ir"><i icon="home" weight="Regular"></i>Ir</button></slot></Block></screen>""";
            var job = JsonNode.Parse(Ops(HtmlOp(bater), HtmlOp(Espelho.Replace("title=\"&quot;Espelho&quot;\"", "title=\"Espelho\"")),
                LogicOp(Carregar.Replace("M2Obter", "M2Obter"), """{"name":"M2Ir","kind":"screen","owner":"IMobileScreen:M2Bater","steps":[{"assign":{"Resumo":"M2Carregar.Resumo"},"as":"Ir"}]}""", Mes, Exportar),
                """{"op":"set","target":"IDataAction:M2Carregar/OnAfterFetch","prop":"Handler","value":"IMobileScreen:M2Bater/M2Ir"}"""))!;
            var result = JobPreflight.Analyze(job["ops"]!.AsArray(), job, []);
            var rules = (result["normalizations"] as JsonArray ?? new JsonArray()).Select(n => n!["rule"]!.GetValue<string>()).ToHashSet();
            foreach (var rule in new[] { HtmlDocumentRules.ListAlias, HtmlDocumentRules.TitleQuoted, HtmlDocumentRules.DefaultMoved, ScopeRenames.Rule })
                Assert.Contains(rule, rules);
            if (MessageExpectations.Lane == "o11") Assert.Contains(HtmlDocumentRules.IconWeight, rules);
            foreach (var code in new[] { "ICON_UNKNOWN", "DEFAULT_NOT_LITERAL", "NAME_COLLISION", "PROPERTY_NOT_WRITABLE" })
                Assert.Empty(Problems(result, code));
            // With the module type, the one thing left is the Download, with its patch, in the same refusal.
            var module = PreflightChecks.WithModule(job["ops"]!.AsArray(), "/ops", "o11", new Module("Mobile"));
            var left = Assert.Single(module.Problems);
            Assert.Equal(NodeRules.Code, left["code"]!.GetValue<string>());
            Assert.NotNull(left["patch"]);
        }
        finally { IconNames.Override = null; }
    }
}
