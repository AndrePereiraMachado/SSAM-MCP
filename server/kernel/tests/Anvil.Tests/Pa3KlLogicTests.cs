using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Atritos 3, lane kl, C18: the logic grammar is as wide as the Studio. `label` on any step (lab 01: "passo #1 (assign):
/// chave(s) desconhecida(s) 'label'"; DCIPS: switch), `record` given as its fields (labs 11 and 12: 17x "'record' e
/// obrigatorio (texto)"), the join kinds the Studio shows (DCIPS: "Unknown JoinType: Only With" 5x), the same entity twice as
/// a self-join (3x "Repeated aggregate source"), DateFormat ISO when left out (7x), and an unused declaration is the Verify's
/// warning, never a refusal (6x "vars never used"). Pure: no Studio.
/// </summary>
public sealed class Pa3KlLogicTests
{
    private static JsonObject Spec(string json) => JsonNode.Parse(json)!.AsObject();
    private static List<JsonObject> Expand(string json) => LogicExpander.Expand(Spec(json));
    private static IEnumerable<JsonObject> Creates(IEnumerable<JsonObject> ops, string type) => ops.Where(o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == type);
    private static string? SetValue(IEnumerable<JsonObject> ops, string target, string prop) =>
        ops.LastOrDefault(o => o["op"]?.ToString() == "set" && o["target"]?.ToString() == target && o["prop"]?.ToString() == prop)?["value"]?.ToString();

    [Fact]
    public void AssignAndSwitchTakeALabel()
    {
        var ops = Expand("""
            {"actions":[{"name":"Total","inputs":[{"name":"N","type":"Integer"}],"outputs":[{"name":"T","type":"Integer"}],"steps":[
              {"assign":{"T":"N * 2"},"label":"Calcula o total"},
              {"switch":[{"when":"N > 10","steps":[{"assign":{"T":"0"}}]}],"label":"Faixa de valor"}]}]}
            """);
        var assign = Assert.Single(Creates(ops, "IAssignNode"), o => SetValue(ops, o["as"]!.ToString(), "Label") == "Calcula o total");
        Assert.Equal("Assign1", assign["name"]!.ToString());
        Assert.Equal("Faixa de valor", SetValue(ops, Assert.Single(Creates(ops, "ISwitchNode"))["as"]!.ToString(), "Label"));
    }

    [Fact]
    public void ALabelNamesANodeThatHasNoLabel()
    {
        var spec = """
            {"actions":[{"name":"Save","steps":[
              {"call":"Event_Write","label":"GravarEvento"},
              {"call":"Event_Write","label":"Gravar o evento"}]},
             {"name":"Event_Write","steps":[]}]}
            """;
        var ops = Expand(spec);
        var calls = Creates(ops, "IExecuteServerActionNode").Select(o => o["name"]!.ToString()).ToArray();
        Assert.Contains("GravarEvento", calls);
        // A label that is no identifier cannot be a name: the default name stays and a note says so.
        Assert.Contains(LogicExpander.Notes(Spec(spec)), n => n.Code == "LOGIC_LABEL_NOT_WRITTEN" && n.Pointer == "/actions/0/steps/1");
    }

    [Fact]
    public void ARecordGivenAsFieldsIsALocalAnAssignAndTheEntityAction()
    {
        var spec = """
            {"actions":[{"name":"Product_Add","inputs":[{"name":"Name","type":"Text"}],"outputs":[{"name":"Id","type":"Product Identifier"}],"steps":[
              {"create":"Product","record":{"Name":"Name","Price":"10"},"as":"NewProduct"},
              {"assign":{"Id":"NewProduct.Id"}}]}]}
            """;
        var ops = Expand(spec);
        var local = Assert.Single(Creates(ops, "ILocalVariable"));
        Assert.Equal("ProductRecord", local["name"]!.ToString());
        Assert.Equal("Product", SetValue(ops, local["as"]!.ToString(), "DataType"));
        var assignments = ops.Where(o => o["op"]?.ToString() == "set" && o["prop"]?.ToString() == "Variable").Select(o => o["value"]!.ToString()).ToArray();
        Assert.Contains("ProductRecord.Name", assignments);
        Assert.Contains("ProductRecord.Price", assignments);
        var call = Assert.Single(Creates(ops, "IExecuteServerActionNode"));
        Assert.Equal("ProductRecord", SetValue(ops, call["as"] + "/Source", "Value"));
        // The Assign that fills the record runs right before the entity action.
        var head = Creates(ops, "IAssignNode").First()["as"]!.ToString();
        Assert.Contains(ops, o => o["op"]?.ToString() == "link" && o["from"]?.ToString() == head && o["to"]?.ToString() == call["as"]!.ToString());
        // The module-specification proof names the same local (RecordVariables), so it never sees an extra var.
        var records = LogicExpander.RecordVariables(Spec(spec)["actions"]![0]!.AsObject());
        Assert.Equal("ProductRecord", Assert.Single(records.Values).Variable);
    }

    [Theory]
    [InlineData("Only With", "Inner")]
    [InlineData("OnlyWith", "Inner")]
    [InlineData("sideways", null)]
    [InlineData("only  with", "Inner")]
    [InlineData("inner", "Inner")]
    [InlineData("With or Without", "Left")]
    [InlineData("left", "Left")]
    [InlineData("With", "Full")]
    [InlineData("FULL", "Full")]
    [InlineData("Right", "Right")]
    public void JoinKindsAsTheStudioShowsThem(string written, string? stored) => Assert.Equal(stored, LogicExpander.JoinKind(written));

    [Fact]
    public void AJoinWrittenAsTheStudioShowsItCompiles()
    {
        var ops = Expand("""
            {"actions":[{"name":"A","outputs":[{"name":"N","type":"Long Integer"}],"steps":[
              {"get":"Order","as":"Orders","sources":["Customer"],"joins":[{"left":"Order","right":"Customer","kind":"Only With","condition":"Order.CustomerId = Customer.Id"}]},
              {"assign":{"N":"Orders.Count"}}]}]}
            """);
        Assert.Equal("Inner", ops.Single(o => o["prop"]?.ToString() == "JoinType")["value"]!.ToString());
    }

    [Fact]
    public void TheSameEntityTwiceIsASelfJoinNamedAsTheStudioNamesIt()
    {
        var spec = """
            {"actions":[{"name":"Managers","outputs":[{"name":"N","type":"Long Integer"}],"steps":[
              {"get":"Employee","as":"Pairs","sources":["Employee"],"joins":[{"left":"Employee","right":"Employee2","kind":"With or Without","condition":"Employee.ManagerId = Employee2.Id"}]},
              {"assign":{"N":"Pairs.Count"}}]}]}
            """;
        var ops = Expand(spec);
        Assert.Equal(["Employee", "Employee2"], Creates(ops, "IAliasedSource").Select(o => o["name"]!.ToString()));
        Assert.Equal("Left", ops.Single(o => o["prop"]?.ToString() == "JoinType")["value"]!.ToString());
        Assert.Contains(LogicExpander.Notes(Spec(spec)), n => n.Code == "LOGIC_SOURCE_RENAMED" && n.Pointer == "/actions/0/steps/0/sources/0");
        Assert.Equal([("Employee", "Employee"), ("Employee2", "Employee")], LogicExpander.SourceNames(["Employee", "Employee"]));
    }

    [Fact]
    public void DateFormatLeftOutIsIso()
    {
        var ops = Expand("""
            {"actions":[{"name":"Encode","inputs":[{"name":"V","type":"Text"}],"outputs":[{"name":"J","type":"Text"}],"steps":[
              {"node":"IJSONSerializeNode","as":"Json","properties":{"Data":"V","SerializeDefaultValues":false}},
              {"assign":{"J":"Json.JSON"}}]}]}
            """);
        Assert.Equal("ISO", ops.Single(o => o["prop"]?.ToString() == "DateFormat")["value"]!.ToString());
    }

    [Fact]
    public void AnUnusedDeclarationIsANoteNeverARefusal()
    {
        var spec = """{"actions":[{"name":"UsageProbe","inputs":[{"name":"A","type":"Text"},{"name":"B","type":"Text"}],"outputs":[{"name":"Ok","type":"Boolean"}],"vars":[{"name":"V","type":"Text"}],"steps":[{"assign":{"Ok":"A <> \"B V\""}}]}]}""";
        Assert.NotEmpty(Expand(spec));
        var note = Assert.Single(LogicExpander.Notes(Spec(spec)), n => n.Code == "LOGIC_UNUSED");
        Assert.Contains("inputs declared and never used: B", note.Message);
        Assert.Contains("vars never used: V", note.Message);
        // The preflight returns it as a warning, never an error.
        var job = JsonNode.Parse("[{\"op\":\"logic\",\"data\":" + spec + "}]")!.AsArray();
        var result = JobPreflight.Analyze(job, job, []);
        Assert.True(result["valid"]!.GetValue<bool>(), result["errors"]!.ToJsonString());
        Assert.Contains(result["warnings"]!.AsArray(), w => w!["code"]!.GetValue<string>() == "LOGIC_UNUSED");
    }
}
