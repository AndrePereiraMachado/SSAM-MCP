using Anvil.Core;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>Package 3 integration: the agent op of the Codex branch is preflighted like the other compact languages
/// (spec, html, logic): its refusal is collected with the other problems under the pointer of its data.</summary>
public class Pa3IntegracaoOdcTests
{
    [Fact]
    public void AnInvalidAgentOpIsOneProblemAtItsData()
    {
        var job = JsonNode.Parse("""{"ops":[{"op":"agent","data":{"name":"Support"}}]}""")!.AsObject();
        var result = JobPreflight.Analyze(job["ops"]!.AsArray(), job);
        Assert.False(result["valid"]!.GetValue<bool>());
        var agent = Assert.Single(result["problems"]!.AsArray().Select(p => p!.AsObject()), p => p["op"]?.GetValue<int>() == 0);
        Assert.Equal("AGENT_INVALID", agent["code"]!.ToString());
        Assert.Equal("/ops/0/data", agent["pointer"]!.ToString());
    }

    /// <summary>The battery found it on the Codex job kernel/tests/jobs-live/odc-agents-example.json: the Agent of a Call
    /// Agent node is a model reference ("IAgent:Support"), and the expression rules read it as an expression and refused
    /// 'IAgent' and 'Support' as unknown identifiers (EXPR_UNKNOWN_IDENTIFIER). Only a property the node declares as an
    /// expression (LogicNodes.Shapes) is an expression; the expression properties are still judged.</summary>
    [Fact]
    public void ANodeReferenceIsNotAnExpressionAndANodeExpressionStillIs()
    {
        const string callee = """{"name":"Lookup","inputs":[{"name":"TicketId","type":"Text"}],"outputs":[{"name":"Status","type":"Text"}],"steps":[{"assign":{"Status":"TicketId"}}]}""";
        static JsonObject Job(string steps) => JsonNode.Parse($$$"""
            {"ops":[{"op":"agent","data":{"name":"Support","model":"IReference:TrialModel/CallTrialModel"}},
              {"op":"logic","data":{"actions":[{{{callee}}},{"name":"Ask","outputs":[{"name":"Response","type":"Text"}],"steps":{{{steps}}} }]}}]}
            """)!.AsObject();
        static IEnumerable<JsonObject> Unknown(JsonObject job) => JobPreflight.Analyze(job["ops"]!.AsArray(), job)["problems"]!.AsArray()
            .Select(p => p!.AsObject()).Where(p => p["code"]!.ToString() == "EXPR_UNKNOWN_IDENTIFIER");

        var agent = Job("""[{"call":"Lookup","as":"Find","args":{"TicketId":"\"1\""}},{"node":"ICallAgentNode","as":"RunAgent","properties":{"Agent":"IAgent:Support"}},{"assign":{"Response":"Find.Status"}}]""");
        Assert.Empty(Unknown(agent));

        var json = Job("""[{"call":"Lookup","as":"Find","args":{"TicketId":"\"1\""}},{"node":"IJSONSerializeNode","as":"Json","properties":{"Data":"Find.List"}},{"assign":{"Response":"Json.JSON"}}]""");
        var problem = Assert.Single(Unknown(json));
        Assert.EndsWith("/properties/Data", problem["pointer"]!.ToString());
    }
}
