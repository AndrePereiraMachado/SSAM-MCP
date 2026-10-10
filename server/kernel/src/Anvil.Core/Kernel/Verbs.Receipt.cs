using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// What the kernel applied that the author did not write (atritos 3, section 5.1): each deterministic rule that changes a
/// value instead of refusing it records the change here, and the apply result carries it in its own field, only when it
/// has entries: iconConversions, expressionRewrites, nameTruncations, indexNoOps ([{path, from, to}]), notes ([{code,
/// message}]) and anonymousExposure ([{screen, actions}]), read from the verdicts of the message policy.
/// </summary>
public sealed partial class ModelSession
{
    private readonly Dictionary<string, JsonArray> _receipt = new(StringComparer.Ordinal);

    /// <summary>One entry of a receipt field (iconConversions, expressionRewrites, nameTruncations, indexNoOps, notes...).</summary>
    internal void Report(string field, JsonObject entry)
    {
        if (!_receipt.TryGetValue(field, out var list)) _receipt[field] = list = new JsonArray();
        if (list.Count < 200) list.Add(entry);
    }

    /// <summary>A change of a value, {path, from, to}.</summary>
    internal void Report(string field, string path, string? from, string? to)
        => Report(field, new JsonObject { ["path"] = path, ["from"] = from, ["to"] = to });

    /// <summary>A note of the receipt, {code, message}.</summary>
    internal void Note(string code, string message) => Report("notes", new JsonObject { ["code"] = code, ["message"] = message });

    /// <summary>The receipt fields of this apply, a fresh object (the caller moves them into the result).</summary>
    public JsonObject ReceiptFields(ExpectationResult? policy = null, JobFootprint? footprint = null)
    {
        var fields = new JsonObject();
        foreach (var (field, list) in _receipt.OrderBy(r => r.Key, StringComparer.Ordinal)) fields[field] = list.DeepClone();
        // C08: the screens the job declared open to anonymous users, with the server actions the Verify names on them.
        var exposure = (policy?.Verdicts ?? []).Where(v => v.Reason == MessageExpectations.AnonymousDeclaredReason)
            .GroupBy(v => ScreenOfPath(v.Path), StringComparer.Ordinal)
            .Select(g => (JsonNode)new JsonObject { ["screen"] = g.Key,
                ["actions"] = new JsonArray(g.Select(v => LastLevel(v.Path)).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).Select(a => (JsonNode)a).ToArray()) })
            .ToArray();
        if (exposure.Length > 0) fields["anonymousExposure"] = new JsonArray(exposure);
        return fields;
    }

    /// <summary>"M (ESpace) / Home (Screen) / GetX (DataAction)": the level that names the screen, else the parent level.</summary>
    private static string ScreenOfPath(string path)
    {
        var levels = path.Split(" / ");
        var screen = levels.LastOrDefault(l => l.EndsWith("Screen)", StringComparison.Ordinal));
        return Level(screen ?? (levels.Length > 1 ? levels[^2] : levels[0]));
    }

    private static string LastLevel(string path) => Level(path.Split(" / ")[^1]);

    private static string Level(string level)
    {
        var open = level.LastIndexOf(" (", StringComparison.Ordinal);
        return open > 0 && level.EndsWith(')') ? level[..open] : level;
    }
}
