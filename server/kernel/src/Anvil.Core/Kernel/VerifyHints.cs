using System.Text.Json.Nodes;

namespace Anvil.Core;

public sealed record VerifyHint(string Id, string Hint, string Origin);

/// <summary>Only our curated advice; optional when the bridge runs outside the repository.</summary>
public static class VerifyHints
{
    public static IReadOnlyDictionary<string, VerifyHint> Read(string? root = null)
    {
        root ??= JobRunner.RepoRoot(Directory.GetCurrentDirectory())
            ?? JobRunner.RepoRoot(Path.GetDirectoryName(typeof(VerifyHints).Assembly.Location)!);
        if (root == null) return new Dictionary<string, VerifyHint>();
        var result = new Dictionary<string, VerifyHint>(StringComparer.Ordinal);
        foreach (var file in Directory.GetFiles(Path.Combine(root, "catalog"), "verify-hints-*.json").OrderBy(f => f, StringComparer.Ordinal))
            foreach (var item in JsonNode.Parse(File.ReadAllText(file))!.AsArray())
            {
                var id = item!["id"]!.GetValue<string>();
                result[id] = new(id, item["hint"]!.GetValue<string>(), item["origin"]!.GetValue<string>());
            }
        return result;
    }

    /// <summary>The hints, or none when the catalog cannot be read: a hint never changes a delivery.</summary>
    public static IReadOnlyDictionary<string, VerifyHint> TryRead(string? root = null)
    {
        try { return Read(root); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException or NullReferenceException)
        { return new Dictionary<string, VerifyHint>(); }
    }

    public static IEnumerable<string> Inline(IEnumerable<MessageInfo> messages, IReadOnlyDictionary<string, VerifyHint> hints)
        => messages.Select(m => m.Id).Distinct(StringComparer.Ordinal).Where(hints.ContainsKey)
            .Select(id => $"Hint {id}: {hints[id].Hint}");

    /// <summary>The suggested fix of a warning (A03, I9): the curated hint of its id, else one sentence per family
    /// (Unused*: remove the element or use it); null when there is neither.</summary>
    public static string? Fix(string id, IReadOnlyDictionary<string, VerifyHint>? hints)
    {
        if (hints != null && hints.TryGetValue(id, out var hint) && !string.IsNullOrWhiteSpace(hint.Hint)) return hint.Hint;
        if (id.StartsWith("Unused", StringComparison.Ordinal)) return UnusedFix;
        return null;
    }
    public const string UnusedFix = "Remova o elemento ou use-o.";

    /// <summary>A03, I9: the non-blocking warnings of a list of verdicts (the apply's K1 verdicts, or the live contract's
    /// entries), each {id, path, key?, detail (one line, at most 200 characters), fix}. Only verdicts "nonblocking"; key is the
    /// element's key (ownerKey) when known. Pure.</summary>
    public static JsonArray Warnings(IEnumerable<JsonNode?> verdicts, IReadOnlyDictionary<string, VerifyHint>? hints)
    {
        var result = new JsonArray();
        foreach (var verdict in verdicts.OfType<JsonObject>())
        {
            if (verdict["verdict"]?.ToString() != MessageExpectations.NonBlockingVerdict) continue;
            var id = verdict["id"]?.ToString() ?? "";
            var warning = new JsonObject { ["id"] = id, ["path"] = verdict["path"]?.ToString() ?? "" };
            if (verdict["ownerKey"]?.ToString() is { Length: > 0 } key) warning["key"] = key;
            warning["detail"] = OneLine(verdict["detail"]?.ToString(), 200);
            warning["fix"] = Fix(id, hints);
            result.Add(warning);
        }
        return result;
    }

    /// <summary>The text on one line (whitespace collapsed), cut at <paramref name="limit"/> characters with an ellipsis.</summary>
    public static string OneLine(string? text, int limit)
    {
        var line = string.Join(' ', (text ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return line.Length > limit ? line[..(limit - 1)] + "…" : line;
    }
}
