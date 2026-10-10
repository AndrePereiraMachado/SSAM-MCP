using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// A02 item 4 and A04 REQUIRED_ARGUMENT: the args of a `call` against the callee's signature. A callee declared in the job
/// is read from its declaration (pure preflight); a callee of the base from the module (JobRunner.CheckAgainstBase).
/// ARGUMENT_UNKNOWN: an arg that is no input of the callee (the apply would fail on `&lt;node&gt;/&lt;arg&gt;`, or the Studio
/// would keep an UnusedArgument). REQUIRED_ARGUMENT: a mandatory input the call does not pass (ArgumentRequiredExpression).
/// A callee that does not resolve, or resolves to more than one action, is left to the expansion and the Verify.
/// </summary>
public static class CallRules
{
    public static List<JsonObject> Check(JsonArray ops, string? prefix, JobFacts job, IBaseFacts? model)
    {
        var problems = new List<JsonObject>();
        foreach (var action in job.Actions)
        {
            var at = prefix == null ? null : $"{prefix}/{action.Op}/data/actions/{action.Index}";
            foreach (var call in LogicScan.Of(action.Declaration).Calls)
            {
                IReadOnlyList<ParamFact>? inputs; string callee;
                if (job.Callee(call.Target, action) is { } declared) { inputs = declared.Inputs; callee = declared.Name; }
                else if (model?.Callee(call.Target, action.Declaration) is { } existing) { inputs = existing.Inputs; callee = existing.Reference; }
                else continue;
                var args = call.Step["args"] as JsonObject ?? new JsonObject();
                foreach (var (key, _) in args)
                {
                    if (inputs.Any(i => string.Equals(i.Name, key, StringComparison.OrdinalIgnoreCase))) continue;
                    var close = NameSuggestions.Closest(key, inputs.Select(i => i.Name));
                    problems.Add(JobPreflight.Problem(action.Op, at == null ? null : $"{at}{call.Pointer}/args/{key.Replace("~", "~0").Replace("/", "~1")}", "ARGUMENT_UNKNOWN", "error",
                        $"'{key}' is not an input of {callee}" + (inputs.Count == 0 ? ", which has no inputs" : $"; its inputs: {string.Join(", ", inputs.Select(i => i.Name))}"),
                        inputs.Count == 0 ? $"remove \"{key}\" from args" : $"name the input exactly ({string.Join(", ", close)}), or remove \"{key}\" from args", null, "logic"));
                }
                foreach (var input in inputs.Where(i => i.Mandatory && !args.Any(a => string.Equals(a.Key, i.Name, StringComparison.OrdinalIgnoreCase))))
                    problems.Add(JobPreflight.Problem(action.Op, at == null ? null : at + call.Pointer, "REQUIRED_ARGUMENT", "error",
                        $"the call to {callee} does not pass the mandatory input '{input.Name}'" + (input.Type is { Length: > 0 } type ? $" ({type})" : ""),
                        $"\"args\": {{\"{input.Name}\": \"<expression>\"}}, or declare '{input.Name}' with \"mandatory\": false in {callee}", null, "logic"));
            }
        }
        return problems;
    }
}
