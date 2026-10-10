using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Linked into both test projects: QUERY_IN_LOOP (refusal) and AGGREGATES_MERGEABLE (HIGH warning) decided on the candidate
/// model by ModelSession.Apply (QueryInLoopRule.cs, AggregateConsolidationRule.cs), the same on O11 and ODC. Each scenario
/// applies a real job to the lane's blank fixture through JobRunner (spec + logic, no Studio window): an Aggregate or a
/// SQL in a ForEach and an aggregate in a `while` cycle (an If back-edge) are refused with the op, the loop, the query and
/// the fix; `allowQueryInLoop` with a why is accepted and recorded; a loop the job did not create or change is a HIGH
/// warning; two related aggregates used together are a HIGH warning with the merged aggregate; unrelated ones are not.
/// </summary>
public static class QueryRulesScenarios
{
    private const string Spec = """
        {"op":"spec","data":{"entities":[
          {"name":"QrOrder","attributes":[{"name":"Title","type":"Text","length":50}]},
          {"name":"QrLine","attributes":[{"name":"OrderId","type":"QrOrder Identifier","mandatory":true},{"name":"Qty","type":"Integer"}]},
          {"name":"QrNote","attributes":[{"name":"Body","type":"Text","length":200}]}]}}
        """;

    private static string LoopAction(string name, string inner, string extra = "") => $$$"""
        {"op":"logic"{{{extra}}},"data":{"actions":[{"name":"{{{name}}}","outputs":[{"name":"Total","type":"Long Integer"}],"steps":[
          {"get":"QrOrder","as":"GetOrders"},
          {"foreach":"GetOrders.List","do":[{{{inner}}},{"assign":{"Total":"Total + 1"}}]}]}]}}
        """;

    private const string AggregateInLoop = """{"get":"QrLine","as":"GetLines","where":"QrLine.OrderId = GetOrders.List.Current.QrOrder.Id"}""";

    private static JsonNode Run(string dir, string name, string job)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, Path.Combine(dir, name + ".oml")))!;
    }

    private static JsonArray Refused(string dir, string name, string job)
    {
        var error = Assert.ThrowsAny<Exception>(() => Run(dir, name, job));
        var coded = Errors.FindCoded(error);
        Assert.True(coded != null, Errors.Text(error));
        // The refusal as the answer carries it, next to the job (evidence of a failing assertion).
        File.WriteAllText(Path.Combine(dir, name + ".refusal.json"), coded!.Problems?.ToJsonString() + Environment.NewLine + Errors.Text(error));
        return coded.Problems!;
    }

    private static JsonArray High(JsonNode result) => result["highWarnings"] as JsonArray ?? new JsonArray();

    public static void AnAggregateInAForEachIsRefused(string dir, string fixture)
    {
        var problems = Refused(dir, "qr-aggregate-in-foreach", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{LoopAction("QrTotals", AggregateInLoop)}}}]}""");
        var problem = Assert.Single(problems, p => p!["code"]!.GetValue<string>() == QueryInLoopRule.Code)!;
        Assert.Equal(1, problem["op"]!.GetValue<int>());
        Assert.Equal("/ops/1/data/actions/0/steps/1/do/0", problem["pointer"]!.GetValue<string>());
        Assert.Equal("GetLines", problem["query"]!.GetValue<string>());
        Assert.Equal("QrTotals", problem["flow"]!.GetValue<string>());
        Assert.Equal("apply", problem["phase"]!.GetValue<string>());
        Assert.Contains("ListFilter", problem["fix"]!.GetValue<string>());
        // The ready ops: one aggregate before the loop, joined on the reference attribute, and the lookup inside it.
        var suggestion = problem["suggestion"]!;
        Assert.Equal("QrLine.OrderId -> QrOrder", suggestion["relation"]!.GetValue<string>());
        Assert.Equal("QrOrder", suggestion["before"]!["get"]!.GetValue<string>());
        Assert.Equal("QrLine", suggestion["before"]!["sources"]![0]!.GetValue<string>());
        Assert.Equal("QrLine.OrderId = QrOrder.Id", suggestion["before"]!["joins"]![0]!["condition"]!.GetValue<string>());
        Assert.Contains("ListFilter(GetOrdersWithQrLine.List, QrLine.OrderId = GetOrders.List.Current.QrOrder.Id)", suggestion["inside"]!.GetValue<string>());
    }

    public static void ASqlInAForEachIsRefused(string dir, string fixture)
    {
        const string sql = """{"get":"QrLine","as":"GetLinesSql","sql":true,"statement":"SELECT {QrLine}.* FROM {QrLine} WHERE {QrLine}.[OrderId] = @OrderId","params":{"OrderId":{"type":"QrOrder Identifier","value":"GetOrders.List.Current.QrOrder.Id"}}}""";
        var problems = Refused(dir, "qr-sql-in-foreach", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{LoopAction("QrTotalsSql", sql)}}}]}""");
        var problem = Assert.Single(problems, p => p!["code"]!.GetValue<string>() == QueryInLoopRule.Code)!;
        Assert.Equal("sql", problem["queryKind"]!.GetValue<string>());
        Assert.Equal("GetLinesSql", problem["query"]!.GetValue<string>());
        Assert.Contains("IN/JOIN", problem["fix"]!.GetValue<string>());
    }

    public static void AnAggregateInAWhileCycleIsRefused(string dir, string fixture)
    {
        var job = $$$"""
            {"base":"{{{fixture}}}","ops":[{{{Spec}}},
             {"op":"logic","data":{"actions":[{"name":"QrCycle","outputs":[{"name":"Total","type":"Long Integer"}],"vars":[{"name":"I","type":"Integer"}],"steps":[
               {"while":"I < 3","do":[{"get":"QrLine","as":"GetLinesW","where":"QrLine.Qty > I"},{"assign":{"I":"I + 1","Total":"Total + GetLinesW.Count"}}]}]}]}}]}
            """;
        var problems = Refused(dir, "qr-while-cycle", job);
        var problem = Assert.Single(problems, p => p!["code"]!.GetValue<string>() == QueryInLoopRule.Code)!;
        Assert.Equal("GetLinesW", problem["query"]!.GetValue<string>());
        Assert.Null(problem["suggestion"]);
    }

    /// <summary>Two refusals and an unrelated failure come back in ONE refusal (collect-all).</summary>
    public static void EveryRefusalComesBackAtOnce(string dir, string fixture)
    {
        var job = $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{LoopAction("QrTotalsA", AggregateInLoop)}}},{{{LoopAction("QrTotalsB", AggregateInLoop)}}},{"op":"set","target":"IServerEntity:QrNote/Nope","prop":"Description","value":"x"}]}""";
        var error = Assert.ThrowsAny<Exception>(() => Run(dir, "qr-collect-all", job));
        var problems = Errors.FindCoded(error)!.Problems!;
        Assert.Equal(2, problems.Count(p => p!["code"]!.GetValue<string>() == QueryInLoopRule.Code));
        Assert.Contains(problems, p => p!["code"]!.GetValue<string>() != QueryInLoopRule.Code);
    }

    public static void TheEscapeWithAWhyIsAcceptedAndRecorded(string dir, string fixture)
    {
        var flag = ""","allowQueryInLoop":{"why":"at most three orders per call, bounded by the caller"}""";
        var result = Run(dir, "qr-allowed", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{LoopAction("QrTotalsAllowed", AggregateInLoop, flag)}}}]}""");
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var allowed = Assert.Single(High(result), w => w!["code"]!.GetValue<string>() == QueryInLoopRule.AllowedCode)!;
        Assert.Equal("high", allowed["severity"]!.GetValue<string>());
        Assert.Equal("at most three orders per call, bounded by the caller", allowed["why"]!.GetValue<string>());
        // A why shorter than the minimum is no escape.
        var shortFlag = ""","allowQueryInLoop":{"why":"fine"}""";
        var problems = Refused(dir, "qr-allowed-short", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{LoopAction("QrTotalsShort", AggregateInLoop, shortFlag)}}}]}""");
        Assert.Contains("why", Assert.Single(problems, p => p!["code"]!.GetValue<string>() == QueryInLoopRule.Code)!["message"]!.GetValue<string>());
    }

    public static void ALegacyLoopIsAHighWarningNotARefusal(string dir, string fixture)
    {
        var flag = ""","allowQueryInLoop":{"why":"legacy module built before the rule existed"}""";
        File.WriteAllText(Path.Combine(dir, "qr-legacy-base.json"), $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{LoopAction("QrLegacy", AggregateInLoop, flag)}}}]}""");
        // The job touches the flow (the aggregate before the loop), never the loop or the query inside it.
        var result = Run(dir, "qr-legacy", """{"base":"job:qr-legacy-base","ops":[{"op":"set","target":"IServerAction:QrLegacy/GetOrders","prop":"MaxRecords","value":"100"}]}""");
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var legacy = Assert.Single(High(result), w => w!["code"]!.GetValue<string>() == QueryInLoopRule.Code)!;
        Assert.True(legacy["legacy"]!.GetValue<bool>());
        Assert.Equal("high", legacy["severity"]!.GetValue<string>());
        Assert.Equal("GetLines", legacy["query"]!.GetValue<string>());
    }

    public static void RelatedAggregatesUsedTogetherAreAHighWarning(string dir, string fixture)
    {
        var job = $$$"""
            {"base":"{{{fixture}}}","ops":[{{{Spec}}},
             {"op":"logic","data":{"actions":[{"name":"QrSummary","inputs":[{"name":"OrderId","type":"QrOrder Identifier"}],
               "outputs":[{"name":"Title","type":"Text"},{"name":"Lines","type":"Long Integer"}],"steps":[
               {"get":"QrOrder","as":"GetOrder","where":"QrOrder.Id = OrderId"},
               {"get":"QrLine","as":"GetOrderLines","where":"QrLine.OrderId = OrderId"},
               {"assign":{"Title":"If(GetOrder.List.Empty, \"\", GetOrder.List.Current.QrOrder.Title)","Lines":"GetOrderLines.Count"}}]}]}}]}
            """;
        var result = Run(dir, "qr-mergeable", job);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var warning = Assert.Single(High(result), w => w!["code"]!.GetValue<string>() == AggregateConsolidationRule.Code)!;
        Assert.Equal("high", warning["severity"]!.GetValue<string>());
        Assert.Equal(new[] { "GetOrder", "GetOrderLines" }, warning["aggregates"]!.AsArray().Select(a => a!.GetValue<string>()).Order());
        Assert.Contains("QrLine.OrderId -> QrOrder", warning["relations"]!.AsArray().Select(r => r!.GetValue<string>()));
        var suggestion = warning["suggestion"]!;
        Assert.Equal("QrOrder", suggestion["get"]!.GetValue<string>());
        Assert.Equal("QrLine", suggestion["sources"]![0]!.GetValue<string>());
        Assert.Equal("QrLine.OrderId = QrOrder.Id", suggestion["joins"]![0]!["condition"]!.GetValue<string>());
        Assert.Contains("QrOrder.Id = OrderId", suggestion["where"]!.AsArray().Select(w => w!.GetValue<string>()));
        Assert.Equal(1, warning["op"]!.GetValue<int>());
    }

    public static void UnrelatedAggregatesAreNotAWarning(string dir, string fixture)
    {
        var job = $$$"""
            {"base":"{{{fixture}}}","ops":[{{{Spec}}},
             {"op":"logic","data":{"actions":[{"name":"QrUnrelated","inputs":[{"name":"OrderId","type":"QrOrder Identifier"}],
               "outputs":[{"name":"Title","type":"Text"},{"name":"Notes","type":"Long Integer"}],"steps":[
               {"get":"QrOrder","as":"GetOrder","where":"QrOrder.Id = OrderId"},
               {"get":"QrNote","as":"GetNotes"},
               {"assign":{"Title":"If(GetOrder.List.Empty, \"\", GetOrder.List.Current.QrOrder.Title)","Notes":"GetNotes.Count"}}]}]}}]}
            """;
        var result = Run(dir, "qr-unrelated", job);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        Assert.DoesNotContain(High(result), w => w!["code"]!.GetValue<string>() == AggregateConsolidationRule.Code);
        Assert.DoesNotContain(High(result), w => w!["code"]!.GetValue<string>() == QueryInLoopRule.Code);
    }
}
