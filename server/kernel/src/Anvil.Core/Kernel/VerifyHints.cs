using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

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
    public const string UnusedFix = "Remove the element or use it.";

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
            warning["detail"] = OneLine(ShortText(verdict["detail"]?.ToString()), 200);
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

    /// <summary>Machine text inside a warning cut to its head with its original size, so the sentence around it is read
    /// (FarmaVirtual session, 2026-10-10): the Studio quotes a data: URL whole in each InvalidResourceURL_Offline, so the detail
    /// cut at 200 characters ended inside the URL before it said what was wrong. A data: URL keeps its media type
    /// ("data:image/svg+xml,…(435 chars)"), a base64 run (mixed case and digits) its first 12 characters; a run with a "/" is
    /// base64 only with a "+" or the "=" padding too, which a slash path ("Theme/Resources/Icons2024/...") never has, so a path
    /// is never cut. A short data: URL, words and a run of one letter stay. The facade cuts the same way (delivery-warnings.mjs
    /// shortText).</summary>
    public static string ShortText(string? text)
    {
        var s = text ?? "";
        if (!s.Contains("data:", StringComparison.Ordinal) && !Base64Run.IsMatch(s)) return s;
        s = DataUrl.Replace(s, m => m.Groups[2].Length > DataKeep ? Sized("data:" + m.Groups[1].Value + ",", m.Value) : m.Value);
        return Base64Run.Replace(s, m => IsBase64(m.Value) ? Sized(m.Value[..12], m.Value) : m.Value);
    }
    private static bool IsBase64(string run) => run.Any(char.IsAsciiLetterLower) && run.Any(char.IsAsciiLetterUpper) && run.Any(char.IsAsciiDigit)
        && (!run.Contains('/') || run.IndexOfAny(['+', '=']) >= 0);
    private const int DataKeep = 24;
    private static readonly Regex DataUrl = new(@"data:((?:[A-Za-z0-9_.+\-/;=]|\\u[0-9A-Fa-f]{4}){0,100}),((?:[^\s'""<>\\)]|\\u[0-9A-Fa-f]{4})*)",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex Base64Run = new("[A-Za-z0-9+/]{80,}={0,2}", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex JsonEscape = new(@"\\u[0-9A-Fa-f]{4}", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    // The size in characters of the text (a JSON escape \uXXXX is one).
    private static string Sized(string head, string text) => head + "…(" + JsonEscape.Replace(text, "_").Length + " chars)";
}
