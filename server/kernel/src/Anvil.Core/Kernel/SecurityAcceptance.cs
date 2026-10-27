using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// T12: the structured acceptance of a blocking security warning (SecurityWarnings.Fix names the fix and this way out). The
/// patch declares the message in the job's expectedMessages with the last two levels of the message path as its element and
/// the marker of the user's words as why. A job that already lists expectations gets "add /expectedMessages/-" with its
/// entry; a job without any gets "add /expectedMessages" with the whole list of this refusal's acceptances (the same patch
/// on each of them, so applying any or all of them gives one list). Its rule (SECURITY_ACCEPTANCE) is never certain, so
/// nothing applies it by itself, and MessageExpectations refuses a security declaration whose why is still a placeholder.
/// </summary>
public static class SecurityAcceptance
{
    public const string PatchRule = "SECURITY_ACCEPTANCE";
    /// <summary>The one marker of the user's words (the facade's WORDS_MARKER, o11-cycle.mjs).</summary>
    public const string WordsMarker = "<the user's own words>";

    /// <summary>The element an acceptance declares: the last two levels of the message path.</summary>
    public static string ElementOf(string path)
    {
        var levels = (path ?? "").Split(" / ");
        return string.Join(" / ", levels.Skip(Math.Max(0, levels.Length - 2)));
    }

    /// <summary>One declaration of <paramref name="count"/> messages of the id at that element.</summary>
    public static JsonObject Entry(string id, string element, int count = 1)
    {
        var entry = new JsonObject { ["id"] = id, ["element"] = element, ["why"] = WordsMarker };
        if (count > 1) entry["count"] = count;
        return entry;
    }

    /// <summary>The patch over an {ops} job that already lists expectedMessages: one entry appended.</summary>
    public static JsonArray Patch(string id, string path)
        => new(new JsonObject { ["op"] = "add", ["path"] = "/expectedMessages/-", ["value"] = Entry(id, ElementOf(path)) });

    /// <summary>The patch over an {ops} job without expectedMessages: the member, with every entry of the refusal.</summary>
    public static JsonArray ListPatch(IEnumerable<JsonObject> entries)
        => new(new JsonObject { ["op"] = "add", ["path"] = "/expectedMessages", ["value"] = new JsonArray(entries.Select(e => (JsonNode)e.DeepClone()).ToArray()) });

    /// <summary>Whether a why stands for no words of the user: blank, a placeholder such as the marker ("&lt;...&gt;"), or
    /// an ellipsis ("...", "…").</summary>
    public static bool IsPlaceholder(string? why)
    {
        var text = (why ?? "").Trim();
        return text.Length == 0 || text.StartsWith('<') && text.EndsWith('>') || text.All(c => c is '.' or '…' or ' ' or '-' or '_' or '?');
    }
}
