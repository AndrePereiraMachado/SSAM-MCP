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
                // primeira-certa A4: the inputs no arg names yet; an unknown arg that can mean only one of them is moved to it.
                var free = inputs.Where(i => !args.Any(a => string.Equals(a.Key, i.Name, StringComparison.OrdinalIgnoreCase))).Select(i => i.Name).ToList();
                var unknown = args.Where(a => !inputs.Any(i => string.Equals(i.Name, a.Key, StringComparison.OrdinalIgnoreCase))).Select(a => a.Key).ToList();
                foreach (var key in unknown)
                {
                    var close = NameSuggestions.Closest(key, inputs.Select(i => i.Name));
                    var argPointer = at == null ? null : $"{at}{call.Pointer}/args/{Escape(key)}";
                    // Moved only when this arg is the only unknown one that can mean that input.
                    var meant = free.Count > 0 ? NameSuggestions.OnlyMatch(key, free) : null;
                    if (meant != null && unknown.Count(k => NameSuggestions.OnlyMatch(k, free) == meant) > 1) meant = null;
                    var patch = meant == null || argPointer == null ? null : new JsonArray(
                        new JsonObject { ["op"] = "add", ["path"] = $"{at}{call.Pointer}/args/{Escape(meant)}", ["value"] = args[key]?.DeepClone() },
                        new JsonObject { ["op"] = "remove", ["path"] = argPointer });
                    problems.Add(JobPreflight.Problem(action.Op, argPointer, "ARGUMENT_UNKNOWN", "error",
                        $"'{key}' is not an input of {callee}" + (inputs.Count == 0 ? ", which has no inputs" : $"; its inputs: {string.Join(", ", inputs.Select(i => i.Name))}"),
                        inputs.Count == 0 ? $"remove \"{key}\" from args" : meant != null ? $"write the arg as \"{meant}\" (the input of {callee} it means)"
                            : $"name the input exactly ({string.Join(", ", close)}), or remove \"{key}\" from args", patch, "logic"));
                }
                foreach (var input in inputs.Where(i => i.Mandatory && !args.Any(a => string.Equals(a.Key, i.Name, StringComparison.OrdinalIgnoreCase))))
                {
                    problems.Add(JobPreflight.Problem(action.Op, at == null ? null : at + call.Pointer, "REQUIRED_ARGUMENT", "error",
                        $"the call to {callee} does not pass the mandatory input '{input.Name}'" + (input.Type is { Length: > 0 } type ? $" ({type})" : ""),
                        $"\"args\": {{\"{input.Name}\": \"<expression>\"}}, or declare '{input.Name}' with \"mandatory\": false in {callee}", null, "logic"));
                }
            }
        }
        return problems;
    }

    private static string Escape(string key) => key.Replace("~", "~0").Replace("/", "~1");
}
