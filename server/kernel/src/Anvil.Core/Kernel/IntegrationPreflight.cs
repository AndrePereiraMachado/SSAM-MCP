using System.Text.Json.Nodes;

namespace Anvil.Core.PreflightRules;

/// <summary>
/// The integration ops (`rest`, `rest-expose`, `soap`) in the whole-job preflight (rule I1 of JobPreflight): every problem
/// their data alone shows, of every op, in one refusal before the base is loaded or the Studio is touched. The handlers
/// run the same pure checks again (a job applied op by op never skips them) plus what only the module answers.
/// </summary>
public static class IntegrationOps
{
    public static IEnumerable<JsonObject> Check(JsonArray ops, string lane)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["data"] is not JsonObject data) continue;
            IEnumerable<IntegrationProblem> problems = op["op"]?.ToString() switch
            {
                "rest" => RestExpander.Validate(data, lane),
                "rest-consume" => RestConsume.Validate(data, lane),
                "rest-expose" => RestExposeExpander.Validate(data),
                "soap" when lane == "odc" => [new IntegrationProblem("SOAP_LANE_UNSUPPORTED", "/data", "soap: SOAP is not available on ODC (the platform consumes REST only)",
                    "consume the service through a REST facade (op rest), or an External Library that calls it")],
                "soap" => SoapPlan.Plan(data).Problems,
                _ => [],
            };
            foreach (var problem in problems) yield return problem.ToJson(i);
        }
    }
}
