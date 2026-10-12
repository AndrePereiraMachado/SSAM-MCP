using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// The static check of a prototype op before any module is loaded (docs/PROTOTIPO-NATIVO.md 7.2): the closed keys of data, the
/// whole capture (schema, references, bundle hashes) and a plan over an empty module, so every problem the capture can show comes
/// out in the one refusal of the preflight, never one per round. Registered as PrototypeSeams.Preflight; the html lane's
/// JobPreflight calls it for each op prototype. Pointers are relative to /ops/&lt;i&gt;/data.
/// </summary>
public static class PrototypePreflight
{
    public static IEnumerable<JsonObject> Analyze(JsonObject op, int index)
    {
        var at = $"/ops/{index}/data";
        if (op["data"] is not JsonObject data)
        {
            yield return JobPreflight.Problem(index, at, "INPUT_INVALID", "error", "prototype: data is required: {\"source\": \"<prototype folder>\"}", "\"data\": {\"source\": \"C:\\\\...\\\\prototype\"}");
            yield break;
        }
        if (data["source"] is not JsonValue sv || !sv.TryGetValue<string>(out var source) || source.Length == 0)
            yield return JobPreflight.Problem(index, at + "/source", "PROTOTYPE_SOURCE_INVALID", "error", "prototype: source is required (absolute path of the prototype folder or of an .html inside it)", null);
        var problems = new List<PrototypeCapture.Problem>();
        var capture = PrototypeCapture.Load(data, problems);
        if (capture != null && problems.Count == 0)
        {
            PrototypePlan? plan = null;
            try { plan = PrototypeExpander.Plan(capture, PrototypeModule.Empty(MessageExpectations.Lane), PrototypeExpander.Current); }
            catch (Exception ex) { problems.Add(new(PrototypeCapture.IrInvalid, "/capture", "prototype: the plan failed: " + ex.Message + " (" + (ex.StackTrace ?? "").Split('\n').FirstOrDefault()?.Trim() + ")", true, null)); }
            if (plan != null) problems.AddRange(plan.Problems);
        }
        foreach (var p in problems)
        {
            var patch = p.Patch == null ? null : new JsonArray(p.Patch.OfType<JsonObject>().Select(x => { var c = x.DeepClone().AsObject(); c["path"] = at + c["path"]; return (JsonNode)c; }).ToArray());
            var problem = JobPreflight.Problem(index, at + p.Pointer, p.Code, "error", p.Message, p.SsamDefect ? "a defect of the SSAM: the facade recaptures the prototype; nothing to change in the job" : null, patch);
            if (p.SsamDefect) problem["ssamDefect"] = true;
            if (p.IrPath != null) problem["irPath"] = p.IrPath;
            yield return problem;
        }
    }
}
