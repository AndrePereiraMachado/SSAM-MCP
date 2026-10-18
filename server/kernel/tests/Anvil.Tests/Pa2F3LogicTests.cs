using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Lane F3 of the atritos 2 package, A07: grammar rules that only SSAM had. The logic compiler names what the Studio would
/// name (call without 'as', End and End2), keys actions by (owner, name), never throws while ordering, reads the sort forms
/// people write, rewrites the record path a list really has, maps 'Long Text', and reports every problem of the spec in one
/// coded refusal with pointers relative to the data it was given (I4). Pure: no Studio, no module.
/// </summary>
public sealed class Pa2F3LogicTests
{
    private static JsonObject Spec(string json) => JsonNode.Parse(json)!.AsObject();
    private static List<JsonObject> Expand(string json, Func<string[], string?>? tryRef = null) => LogicExpander.Expand(Spec(json), tryRef);
    private static IEnumerable<JsonObject> Creates(IEnumerable<JsonObject> ops, string type) => ops.Where(o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == type);
    private static string? SetValue(IEnumerable<JsonObject> ops, string target, string prop) =>
        ops.LastOrDefault(o => o["op"]?.ToString() == "set" && o["target"]?.ToString() == target && o["prop"]?.ToString() == prop)?["value"]?.ToString();

    // ---- 'as' of a call --------------------------------------------------------------------------------------------

    [Fact]
    public void ACallWithoutAsIsNamedAfterItsActionAndNumberedFromTheSecond()
    {
        // The Cardapio BackOffice answered 170 "'as' e obrigatorio" in one preflight round (2026-10-06 13:31).
        var ops = Expand("""
            {"actions":[
              {"name":"Event_Write","inputs":[{"name":"Note","type":"Text"}],"steps":[{"assign":{"Note2":"Note"}}]},
              {"name":"Ticket_Close","inputs":[{"name":"Event_Write","type":"Text"}],"steps":[
                {"call":"Event_Write","args":{"Note":"\"a\""}},
                {"call":"Event_Write","args":{"Note":"\"b\""}},
                {"call":"@abc123"},
                {"assign":{"X":"Event_Write"}}]}]}
            """);
        var calls = Creates(ops, "IExecuteServerActionNode").Select(o => o["name"]!.ToString()).ToArray();
        // A parameter named like the action keeps its name: the node is numbered; a reference by key has no name to read.
        Assert.Equal(["Event_Write2", "Event_Write3", "Call1"], calls);
    }

    [Fact]
    public void ANativeNodeWithoutAsTakesItsKindNumberedAsTheStudioNamesIt()
    {
        // The Cardapio BackOffice replay (2026-10-06) still answered 82 "'as' e obrigatorio", all on native node steps
        // (IDestinationNode): the same rule as a call, the kind without its I and Node suffix, numbered.
        var ops = Expand("""
            {"actions":[{"name":"Go","kind":"screen","owner":"IMobileScreen:Home","steps":[
              {"node":"IJSONSerializeNode","properties":{"Data":"1","DateFormat":"ISO","SerializeDefaultValues":false}},
              {"node":"IJSONSerializeNode","properties":{"Data":"2","DateFormat":"ISO","SerializeDefaultValues":false},"as":"Encoded"},
              {"node":"IDestinationNode","properties":{"Destination":"IMobileScreen:Home"}}]}]}
            """, _ => "@key");
        Assert.Equal(["JSONSerialize1", "Encoded"], Creates(ops, "OutSystems.Model.Logic.Nodes.IJSONSerializeNode").Select(o => o["name"]!.ToString()));
        Assert.Equal("Destination1", Assert.Single(Creates(ops, "OutSystems.Model.Logic.Nodes.IDestinationNode"))["name"]!.ToString());
    }

    // ---- repeated node names --------------------------------------------------------------------------------------

    [Fact]
    public void ARepeatedNodeNameIsNumberedAsTheStudioDoesAndTheGivenNameIsANote()
    {
        var spec = """
            {"actions":[{"name":"A","outputs":[{"name":"X","type":"Integer"}],"steps":[
              {"assign":{"X":"1"},"as":"End"},
              {"assign":{"X":"2"},"as":"S"},
              {"assign":{"X":"3"},"as":"S"}]}]}
            """;
        var ops = Expand(spec);
        Assert.Equal(["End", "S", "S2"], Creates(ops, "IAssignNode").Select(o => o["name"]!.ToString()));
        // The generated End meets the step called End: it is End2, linked from the last step.
        var end = Assert.Single(Creates(ops, "IEndNode"));
        Assert.Equal("End2", end["name"]!.ToString());
        Assert.Contains(ops, o => o["op"]?.ToString() == "link" && o["from"]?.ToString() == "$A.S2" && o["to"]?.ToString() == "$A.End2");
        var notes = LogicExpander.Notes(Spec(spec));
        Assert.Contains(notes, n => n.Code == "LOGIC_NODE_RENAMED" && n.Pointer == "/actions/0/steps/2" && n.Message.Contains("'S2'"));
        Assert.Contains(notes, n => n.Code == "LOGIC_NODE_RENAMED" && n.Pointer == "/actions/0" && n.Message.Contains("'End2'"));
    }

    [Fact]
    public void ThePreflightReturnsTheGivenNameAsANonBlockingWarning()
    {
        var job = JsonNode.Parse("""
            [{"op":"logic","data":{"actions":[{"name":"A","outputs":[{"name":"X","type":"Integer"}],"steps":[
              {"assign":{"X":"1"},"as":"S"},{"assign":{"X":"2"},"as":"S"}]}]}}]
            """)!.AsArray();
        var warnings = LogicLint.Check(job, "o11").ToList();
        var renamed = Assert.Single(warnings, w => w["code"]?.ToString() == "LOGIC_NODE_RENAMED");
        Assert.Equal("warning", renamed["severity"]!.ToString());
        Assert.Equal("/ops/0/data/actions/0/steps/1", renamed["pointer"]!.ToString());
    }

    // ---- actions keyed by (owner, name) -----------------------------------------------------------------------------

    private const string TwoScreens = """
        {"actions":[
          {"name":"OnSave","kind":"screen","owner":"IMobileScreen:Detail","vars":[{"name":"Done","type":"Boolean"}],"steps":[{"assign":{"Done":"True"}}]},
          {"name":"OnSave","kind":"screen","owner":"IMobileScreen:Edit","vars":[{"name":"Done","type":"Boolean"}],"steps":[{"assign":{"Done":"True"}}]},
          {"name":"Refresh","kind":"screen","owner":"IMobileScreen:Edit","steps":[{"call":"OnSave"}]}]}
        """;

    [Fact]
    public void TheSameScreenActionOnTwoScreensIsTwoActions()
    {
        // The Cardapio BackOffice's first preflight round refused one screen action name used on several screens.
        var ops = Expand(TwoScreens);
        var screenActions = Creates(ops, "OutSystems.Model.UI.Mobile.IScreenAction").ToList();
        Assert.Equal(["IMobileScreen:Detail", "IMobileScreen:Edit", "IMobileScreen:Edit"], screenActions.Select(o => o["parent"]!.ToString()).OrderBy(p => p, StringComparer.Ordinal));
        var handles = screenActions.Select(o => o["as"]!.ToString()).ToArray();
        Assert.Equal(handles.Length, handles.Distinct(StringComparer.OrdinalIgnoreCase).Count());
        // Refresh calls the OnSave of its own screen, which is ordered before it.
        Assert.Equal("IMobileScreen:Edit/OnSave", SetValue(ops, "$Refresh.OnSave", "Action"));
        var order = LogicOrder.Sort(Spec(TwoScreens)["actions"]!.AsArray()).Select(a => a["owner"] + "/" + a["name"]).ToList();
        Assert.True(order.IndexOf("IMobileScreen:Edit/OnSave") < order.IndexOf("IMobileScreen:Edit/Refresh"), string.Join(", ", order));
        Assert.Equal(3, order.Count);
    }

    [Fact]
    public void SortNeverThrowsAndKeepsEveryDeclarationOnce()
    {
        var actions = JsonNode.Parse("""
            [{"steps":[]},
             {"name":"NoOwner","kind":"screen","steps":[]},
             "not an action",
             {"name":"BadCall","steps":[{"call":5},{"switch":"x"}]},
             {"name":"Twice","steps":[]},
             {"name":"Unknown","kind":"weird","steps":[{"call":"Twice"}]},
             {"name":"Twice","steps":[]}]
            """)!.AsArray();
        var sorted = LogicOrder.Sort(actions);
        Assert.Equal(6, sorted.Count);
        // A real repetition (same owner and name) comes right after its first declaration.
        var twice = sorted.Select((a, i) => (a, i)).Where(x => x.a["name"]?.ToString() == "Twice").Select(x => x.i).ToArray();
        Assert.Equal(2, twice.Length);
        Assert.Equal(twice[0] + 1, twice[1]);
    }

    [Fact]
    public void MalformedAndRepeatedActionsAreCodedProblemsOfTheExpansion()
    {
        var spec = Spec("""
            {"actions":[{"name":"A","steps":[]},{"name":"A","steps":[]},{"name":"S","kind":"screen","steps":[]},"x"]}
            """);
        var ex = Assert.Throws<KernelRefusalException>(() => LogicExpander.Expand(spec));
        Assert.Equal("LOGIC_INVALID", ex.Code);
        var problems = ex.Problems!.Select(p => (p!["pointer"]!.ToString(), p["code"]!.ToString())).ToList();
        Assert.Contains(("/actions/1", "LOGIC_DUPLICATE_ACTION"), problems);
        Assert.Contains(("/actions/2", "LOGIC_INVALID"), problems);
        Assert.Contains(("/actions/3", "LOGIC_INVALID"), problems);
    }

    // ---- sort ---------------------------------------------------------------------------------------------------

    private static List<(string Attribute, string Direction)> Sorts(JsonNode sort)
    {
        var get = new JsonObject { ["get"] = "Pedido", ["as"] = "Dados", ["sort"] = sort };
        var ops = LogicExpander.Expand(new JsonObject { ["actions"] = new JsonArray(new JsonObject { ["name"] = "A", ["steps"] = new JsonArray(get) }) });
        return Creates(ops, "ISort").Select(s => (SetValue(ops, s["as"]!.ToString(), "Attribute")!, SetValue(ops, s["as"]!.ToString(), "SortDirection")!)).ToList();
    }

    [Theory]
    [InlineData("\"Pedido.Id DESC\"", "Pedido.Id", "Descending")]   // Cardapio CS 13:04 "unexpected 'DESC'"
    [InlineData("\"-Pedido.Id\"", "Pedido.Id", "Descending")]       // Cardapio CS 13:06 "Operator '-' cannot be applied"
    [InlineData("\"Pedido.Id asc\"", "Pedido.Id", "Ascending")]
    [InlineData("[\"Pedido.Id\",\"Descending\"]", "Pedido.Id", "Descending")]
    [InlineData("[{\"by\":\"Pedido.Id\",\"desc\":true}]", "Pedido.Id", "Descending")]
    [InlineData("\"Pedido.Id\"", "Pedido.Id", "Ascending")]
    public void EverySortFormReadsOneKey(string sort, string attribute, string direction)
        => Assert.Equal([(attribute, direction)], Sorts(JsonNode.Parse(sort)!));

    [Fact]
    public void SeveralKeysAreOneISortEachInTheOrderWritten()
    {
        // "Invalid Sort value 'RestauranteHorario.HoraInicio'": the second key was read as the direction of the first.
        Assert.Equal([("Pedido.Data", "Ascending"), ("RestauranteHorario.HoraInicio", "Ascending")],
            Sorts(JsonNode.Parse("[\"Pedido.Data\",\"RestauranteHorario.HoraInicio\"]")!));
        Assert.Equal([("Contract.Name", "Ascending"), ("Contract.Id", "Descending")],
            Sorts(JsonNode.Parse("[\"Contract.Name\",\"Contract.Id DESC\"]")!));
        Assert.Equal([("A", "Descending"), ("B", "Ascending"), ("C", "Descending")],
            Sorts(JsonNode.Parse("[{\"by\":\"A\",\"desc\":true},{\"by\":\"B\"},\"C\",\"Descending\"]")!));
    }

    [Fact]
    public void ASortWithoutAnAttributeIsAProblemAtTheSortField()
    {
        var spec = Spec("""{"actions":[{"name":"A","steps":[{"get":"Pedido","as":"Dados","sort":["Descending"]}]}]}""");
        var ex = Assert.Throws<InvalidOperationException>(() => LogicExpander.Expand(spec));
        Assert.Contains("comes before any attribute", ex.Message);
        Assert.Equal("/actions/0/steps/0/sort", Errors.FindCoded(ex)!.Problems![0]!["pointer"]!.ToString());
    }

    // ---- List.Current.<Type>. --------------------------------------------------------------------------------------

    [Fact]
    public void TheTypeSegmentOfAListParameterRecordIsRewrittenOutsideStringsAndReported()
    {
        // Cardapio CS 13:05: "Can't identify 'RestauranteHorario'" in Horarios.Current.RestauranteHorario.DiaSemana.
        var spec = """
            {"actions":[{"name":"Restaurante_SalvarHorarios","inputs":[{"name":"Horarios","type":"RestauranteHorario List"}],
              "outputs":[{"name":"Dia","type":"Integer"},{"name":"Texto","type":"Text"}],"steps":[
                {"foreach":"Horarios","do":[
                  {"if":"Horarios.Current.RestauranteHorario.DiaSemana < 0","then":[{"assign":{"Dia":"Horarios.Current.RestauranteHorario.DiaSemana"}}]}]},
                {"assign":{"Texto":"\"Horarios.Current.RestauranteHorario.X\" + Horarios.List.Current.RestauranteHorario.Nome"}}]}]}
            """;
        var ops = Expand(spec);
        var expressions = ops.Where(o => o["op"]?.ToString() == "set").Select(o => o["value"]?.ToString() ?? "").ToList();
        Assert.Contains("Horarios.Current.DiaSemana < 0", expressions);
        Assert.Contains("Horarios.Current.DiaSemana", expressions);
        Assert.Contains("\"Horarios.Current.RestauranteHorario.X\" + Horarios.Current.Nome", expressions);
        var notes = LogicExpander.Notes(Spec(spec));
        Assert.Contains(notes, n => n.Code == "LOGIC_CURRENT_REWRITTEN" && n.Pointer == "/actions/0/steps/0/do/0/if");
        Assert.Contains(notes, n => n.Code == "LOGIC_CURRENT_REWRITTEN" && n.Pointer == "/actions/0/steps/1/assign/Texto");
    }

    [Fact]
    public void ASqlQueryRecordIsReadThroughItsOutputNamedList()
    {
        // Cardapio CS 13:05: "Can't identify 'FotoAnalise'" in Analise.List.Current.FotoAnalise.Tamanho; the SQL output this
        // compiler creates is named List, so the field is Analise.List.Current.List.Tamanho (kernel/AGENTS.md 2.1).
        var spec = """
            {"actions":[{"name":"Foto_Validar","inputs":[{"name":"Foto","type":"Binary Data"}],"outputs":[{"name":"Ok","type":"Boolean"},{"name":"Km","type":"Decimal"}],"steps":[
              {"get":"FotoAnalise","sql":true,"as":"Analise","statement":"SELECT DATALENGTH(@Foto), 2","params":{"Foto":{"type":"Binary Data","value":"Foto"}},"max":1},
              {"assign":{"Ok":"Analise.List.Current.FotoAnalise.Tamanho > 0 and Analise.List.Current.List.Assinatura <> \"\"","Km":"Analise.List.Current.Tamanho"}}]}]}
            """;
        var ops = Expand(spec);
        var values = ops.Where(o => o["prop"]?.ToString() == "Value").Select(o => o["value"]!.ToString()).ToList();
        Assert.Contains("Analise.List.Current.List.Tamanho > 0 and Analise.List.Current.List.Assinatura <> \"\"", values);
        // A path without the type segment is not this rule's to guess: the Verify's Hint Current names the wrapper.
        Assert.Contains("Analise.List.Current.Tamanho", values);
        var job = JsonNode.Parse("[{\"op\":\"logic\",\"data\":" + spec + "}]")!.AsArray();
        var rewritten = LogicLint.Check(job, "o11").Where(w => w["code"]?.ToString() == "LOGIC_CURRENT_REWRITTEN").Select(w => w["pointer"]!.ToString()).ToArray();
        Assert.Equal(["/ops/0/data/actions/0/steps/1/assign/Ok"], rewritten);
    }

    // ---- 'Long Text' ------------------------------------------------------------------------------------------------

    [Fact]
    public void LongTextIsDeclaredAsTextAndTheMappingIsReported()
    {
        var spec = """{"actions":[{"name":"A","inputs":[{"name":"Body","type":"Long Text"}],"outputs":[{"name":"Lines","type":"Long Text List"}],"steps":[{"assign":{"Lines":"Body"}}]}]}""";
        var ops = Expand(spec);
        Assert.Equal("Text", SetValue(ops, "$A.Body", "DataType"));
        Assert.Equal("Text List", SetValue(ops, "$A.Lines", "DataType"));
        var job = JsonNode.Parse("[{\"op\":\"logic\",\"data\":" + spec + "}]")!.AsArray();
        var mapped = LogicLint.Check(job, "o11").Where(w => w["code"]?.ToString() == "LOGIC_TYPE_MAPPED").Select(w => w["pointer"]!.ToString()).ToArray();
        Assert.Equal(["/ops/0/data/actions/0/inputs/0/type", "/ops/0/data/actions/0/outputs/0/type"], mapped);
    }

    // ---- every problem at once (I4) --------------------------------------------------------------------------------

    [Fact]
    public void ThreeInvalidStepsAreThreeProblemsWithPointersRelativeToTheData()
    {
        var spec = Spec("""
            {"actions":[{"name":"A","outputs":[{"name":"X","type":"Integer"}],"steps":[
              {"assign":{"X":"1"},"when":"now"},
              {"get":"Pedido","where":"Pedido.Id = 1"},
              {"if":"X > 0","then":[{"raise":"NotFound","message":"\"x\"","code":1}]},
              {"assign":{"X":"2"}}]}]}
            """);
        var ex = Assert.Throws<KernelRefusalException>(() => LogicExpander.Expand(spec));
        Assert.Equal("LOGIC_INVALID", ex.Code);
        var pointers = ex.Problems!.Select(p => p!["pointer"]!.ToString()).ToArray();
        Assert.Equal(["/actions/0/steps/0/when", "/actions/0/steps/1/as", "/actions/0/steps/2/then/0/code"], pointers);
        Assert.All(ex.Problems!, p => Assert.Null(p!["op"]));
        Assert.Contains("3 problems", ex.Message);
    }

    [Fact]
    public void OneProblemKeepsTheExceptionTheCallerAlwaysGotAndCarriesTheCodedProblem()
    {
        var spec = Spec("""{"actions":[{"name":"A","steps":[{"get":"Pedido"}]}]}""");
        var ex = Assert.Throws<InvalidOperationException>(() => LogicExpander.Expand(spec));
        Assert.Contains("get needs 'as'", ex.Message);
        var coded = Errors.FindCoded(ex)!;
        Assert.Equal("LOGIC_INVALID", coded.Code);
        Assert.Equal("/actions/0/steps/0/as", coded.Problems![0]!["pointer"]!.ToString());
    }
}
