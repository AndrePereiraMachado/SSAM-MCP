using System.Text.Json.Nodes;
using Anvil.Core.PreflightRules;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// Pacote D2, C16.2: the I1 rule for the Max. Records the ODC native merge normalizes. A Refresh Data whose explicit MaxRecords
/// differs from its aggregate's (declared in the same job) is refused with the fix and a removal patch; omitting it, or
/// giving the aggregate's own value, passes; an aggregate the job does not declare makes any explicit value a refusal; the
/// O11 lane is never checked. Pure: Check(ops, lane) over the ops as CollectOps returns them.
/// </summary>
public class PacoteD2RulesTests
{
    private static JsonArray Ops(string json) => JsonNode.Parse(json)!.AsArray();
    private static JsonObject[] Check(string json, string lane = "odc") => OdcMergeNormalizationRules.Check(Ops(json), lane).ToArray();

    private const string Screen = """
        {"op":"html","data":{"screen":"Board","sources":[{"as":"GetPeople","entity":"Person","max":50},{"as":"GetRules","entity":"Rule","max":100}]}}
        """;
    private static string Logic(string properties) => """
        {"op":"logic","data":{"actions":[{"name":"LoadWeek","parent":"IMobileScreen:Board","steps":[{"node":"IRefreshDataNode","properties":
        """ + properties + "}]}]}}";

    [Fact]
    public void AnExplicitMaxRecordsThatDiffersFromTheAggregateIsRefusedWithTheFix()
    {
        var problems = Check("[" + Screen + "," + Logic("""{"DataSource":"IMobileScreen:Board/GetPeople","MaxRecords":"200"}""") + "]");
        var problem = Assert.Single(problems);
        Assert.Equal("ODC_REFRESH_MAXRECORDS", problem["code"]!.ToString());
        Assert.Equal("error", problem["severity"]!.ToString());
        Assert.Equal(1, problem["op"]!.GetValue<int>());
        Assert.Equal("/ops/1/data/actions/0/steps/0/properties/MaxRecords", problem["pointer"]!.ToString());
        Assert.Contains("native merge normalizes it to the aggregate's Max. Records", problem["message"]!.ToString());
        Assert.Contains("50 in this job", problem["message"]!.ToString());
        Assert.StartsWith("Omit MaxRecords", problem["fix"]!.ToString());
        Assert.Equal("remove", problem["patch"]![0]!["op"]!.ToString());
        Assert.Equal(problem["pointer"]!.ToString(), problem["patch"]![0]!["path"]!.ToString());
    }

    [Fact]
    public void OmittingMaxRecordsOrGivingTheAggregatesValuePasses()
    {
        Assert.Empty(Check("[" + Screen + "," + Logic("""{"DataSource":"IMobileScreen:Board/GetPeople"}""") + "]"));
        Assert.Empty(Check("[" + Screen + "," + Logic("""{"DataSource":"IMobileScreen:Board/GetRules","MaxRecords":"100"}""") + "]"));
        // An aggregate declared without max has the default the merge keeps.
        Assert.Empty(Check("""[{"op":"html","data":{"sources":[{"as":"GetAll","entity":"Person"}]}},""" + Logic("""{"DataSource":"IMobileScreen:Board/GetAll","MaxRecords":"50"}""") + "]"));
        // An expression is compared as written: the aggregate's own expression passes, another one does not.
        var paged = """[{"op":"html","data":{"sources":[{"as":"GetPage","entity":"Person","max":"PageSize"}]}},""";
        Assert.Empty(Check(paged + Logic("""{"DataSource":"IMobileScreen:Board/GetPage","MaxRecords":" PageSize "}""") + "]"));
        Assert.Single(Check(paged + Logic("""{"DataSource":"IMobileScreen:Board/GetPage","MaxRecords":"50"}""") + "]"));
    }

    [Fact]
    public void AnAggregateOutsideTheJobRefusesAnyExplicitValue()
    {
        var problem = Assert.Single(Check("[" + Logic("""{"DataSource":"IMobileScreen:Board/GetPeople","MaxRecords":"50"}""") + "]"));
        Assert.Contains("not declared in this job", problem["message"]!.ToString());
    }

    [Fact]
    public void TheGenericVerbsAreCheckedToo()
    {
        var ops = """
            [{"op":"create","parent":"IMobileScreen:Board","type":"IScreenAggregate","name":"GetPeople","as":"$agg"},
             {"op":"set","target":"$agg","prop":"MaxRecords","value":"20"},
             {"op":"create","parent":"$action","type":"IRefreshDataNode","as":"$refresh","args":{"DataSource":"$agg"}},
             {"op":"set","target":"$refresh","prop":"MaxRecords","value":"200"}]
            """;
        var problem = Assert.Single(Check(ops));
        Assert.Equal(3, problem["op"]!.GetValue<int>());
        Assert.Equal("/ops/3", problem["pointer"]!.ToString());
        Assert.Contains("Refresh Data of GetPeople", problem["message"]!.ToString());
        Assert.Contains("20 in this job", problem["message"]!.ToString());
        Assert.Empty(Check(ops.Replace("\"value\":\"200\"", "\"value\":\"20\"")));
    }

    [Fact]
    public void TheO11LaneIsNeverChecked() =>
        Assert.Empty(Check("[" + Logic("""{"DataSource":"IWebScreen:Board/GetPeople","MaxRecords":"200"}""") + "]", "o11"));
}
