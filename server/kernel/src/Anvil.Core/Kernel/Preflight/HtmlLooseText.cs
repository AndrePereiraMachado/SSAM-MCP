using System.Text;
using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// R2-C (normalizations, 2026-10-29): an '&amp;' or a '&lt;' written loose in the html of an html op has one reading. HTML reads
/// '&amp;' that no character reference can start (followed by a space, the end, or a character that is no letter, digit or #) and
/// '&lt;' that no tag, end tag or comment can start (followed by a space, the end, a digit, '=' or another character that is no
/// letter, '/', '!' or '?') as the character itself. The parsers of the html op (ssam-html/1 and the page form) are strict and
/// refused it at apply (HTML_INVALID "bare '&amp;': write &amp;amp;", "stray '&lt;'"), one round for a correction that is always
/// the same: the character written as its entity. Written so here, before the compilers read the text, and listed
/// (HTML_TEXT_ESCAPED): the text the page shows is the same.
/// <para>Never touched: the raw text of &lt;style&gt; and &lt;script&gt;, comments, unquoted attribute values, an '&amp;' a letter, digit or
/// # follows (R&amp;D could be a reference written without its ';': the parser's refusal names both forms) and a '&lt;' a letter, '/',
/// '!' or '?' follows (a tag the author may have meant). Every html of the op: data.html (document and page forms), html (the
/// fragment form), each text of data.edit and the insert and replace texts of data.edits (find is the reading's own text,
/// never changed). The with of a find lands where the find is in the reading: HtmlElementEdits writes it there, by the same
/// rule, only when that place is HTML (never inside the raw text of a &lt;style&gt;, a &lt;script&gt; or a comment).</para>
/// </summary>
public static class HtmlLooseText
{
    public const string Rule = "HTML_TEXT_ESCAPED";

    public static void Normalize(JsonArray ops, string? prefix, List<JsonObject> done)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "html") continue;
            var at = prefix == null ? null : $"{prefix}/{i}";
            if (op["data"] is JsonObject data)
            {
                Slot(data, "html", at == null ? null : at + "/data/html", done, sent: true);
                if (data["edit"] is JsonArray edit)
                    for (var j = 0; j < edit.Count; j++)
                        if (edit[j] is JsonValue v && v.TryGetValue<string>(out var text) && Escape(text) is { } escaped)
                        {
                            edit[j] = escaped.Text;
                            done.Add(Entry(at == null ? null : $"{at}/data/edit/{j}", escaped));
                        }
                // Whole elements only (insert, and the with of a replace): their place is HTML. The with of a find lands where
                // the find is in the reading, which only HtmlElementEdits knows (it may be the raw text of a <style>): written
                // there (HtmlElementEdits.EscapedWith), never here.
                if (data["edits"] is JsonArray edits)
                    for (var j = 0; j < edits.Count; j++)
                        if (edits[j] is JsonObject e)
                            foreach (var key in new[] { "with", "insert" })
                                if (key == "insert" || e.ContainsKey("replace"))
                                    Slot(e, key, at == null ? null : $"{at}/data/edits/{j}/{key}", done, sent: false);
            }
            Slot(op, "html", at == null ? null : at + "/html", done, sent: true);
        }
    }

    private static void Slot(JsonObject holder, string key, string? path, List<JsonObject> done, bool sent)
    {
        if (holder[key] is not JsonValue v || !v.TryGetValue<string>(out var text) || Escape(text) is not { } escaped) return;
        // The html as sent is kept for the rules whose patch is written over it (ICON_UNKNOWN).
        if (sent && key == "html") SentJob.HtmlBefore(holder, text);
        holder[key] = escaped.Text;
        done.Add(Entry(path, escaped));
    }

    /// <summary>The entry of an escaped text (its path in the job, the places).</summary>
    public static JsonObject Entry(string? path, Escaped escaped)
    {
        var places = escaped.Places.Take(8).Select(p => $"line {p.Line} col {p.Column} ({p.Character})").ToList();
        var more = escaped.Places.Count > places.Count ? $" and {escaped.Places.Count - places.Count} more" : "";
        var first = escaped.Places[0];
        return JobNormalizer.Entry(Rule, path, first.Before, first.After,
            $"{escaped.Places.Count} loose character(s) that HTML reads as text, written as their entity (& is &amp;, < is &lt;): {string.Join(", ", places)}{more}; the text the page shows is the same");
    }

    /// <summary>One loose character: where it was, which, and the line around it before and after.</summary>
    public sealed record Place(int Line, int Column, char Character, string Before, string After);
    public sealed record Escaped(string Text, IReadOnlyList<Place> Places);

    /// <summary>The text with every loose '&amp;' and '&lt;' written as its entity, or null when it has none.</summary>
    public static Escaped? Escape(string text)
    {
        if (text.IndexOf('&') < 0 && text.IndexOf('<') < 0) return null;
        var output = new StringBuilder(text.Length + 16);
        var places = new List<(int Offset, char Character)>();
        var i = 0;
        while (i < text.Length)
        {
            var c = text[i];
            if (c == '<')
            {
                if (string.CompareOrdinal(text, i, "<!--", 0, 4) == 0)
                {
                    var end = text.IndexOf("-->", i + 4, StringComparison.Ordinal);
                    if (end < 0) { output.Append(text, i, text.Length - i); break; }   // the parser's refusal says where
                    output.Append(text, i, end + 3 - i); i = end + 3; continue;
                }
                var next = i + 1 < text.Length ? text[i + 1] : '\0';
                if (char.IsAsciiLetter(next) || next == '/')
                {
                    var (mark, found) = (output.Length, places.Count);
                    var stop = Tag(text, i, output, places);
                    if (stop < 0)
                    {
                        // A tag that never closes: the rest as written (the parser's refusal says where).
                        output.Length = mark; places.RemoveRange(found, places.Count - found);
                        output.Append(text, i, text.Length - i); break;
                    }
                    // The raw text of style and script, up to its end tag, as it is.
                    if (next != '/' && RawName(text, i + 1) is { } raw && !(stop >= 2 && text[stop - 2] == '/'))
                    {
                        var close = text.IndexOf("</" + raw, stop, StringComparison.OrdinalIgnoreCase);
                        var until = close < 0 ? text.Length : close;
                        output.Append(text, stop, until - stop);
                        i = until; continue;
                    }
                    i = stop; continue;
                }
                if (next is '!' or '?') { output.Append(c); i++; continue; }
                places.Add((i, c)); output.Append("&lt;"); i++; continue;
            }
            if (c == '&' && Loose(text, i)) { places.Add((i, c)); output.Append("&amp;"); i++; continue; }
            output.Append(c); i++;
        }
        if (places.Count == 0) return null;
        var written = output.ToString();
        return new Escaped(written, places.Select(p => Describe(text, written, p.Offset, p.Character)).ToList());
    }

    // An '&' no character reference starts: the end, a space, or a character that is no letter, digit or #.
    private static bool Loose(string text, int at) => at + 1 >= text.Length || !(char.IsAsciiLetterOrDigit(text[at + 1]) || text[at + 1] == '#');

    private static string? RawName(string text, int at)
    {
        foreach (var name in new[] { "style", "script" })
            if (string.Compare(text, at, name, 0, name.Length, StringComparison.OrdinalIgnoreCase) == 0
                && (at + name.Length >= text.Length || !char.IsAsciiLetterOrDigit(text[at + name.Length]) && text[at + name.Length] is not ('-' or '_' or ':' or '.')))
                return name;
        return null;
    }

    // Copies a tag from its '<' to its '>' (a quoted attribute value: its loose '&' escaped, a '>' inside it kept), and answers
    // where the text goes on; -1 when the tag never closes (the parser's refusal says where).
    private static int Tag(string text, int start, StringBuilder output, List<(int, char)> places)
    {
        var i = start;
        while (i < text.Length)
        {
            var c = text[i];
            if (c == '>') { output.Append(c); return i + 1; }
            if (c is '"' or '\'' && i > start && Previous(text, i) == '=')
            {
                output.Append(c); i++;
                while (i < text.Length && text[i] != c)
                {
                    if (text[i] == '&' && Loose(text, i)) { places.Add((i, '&')); output.Append("&amp;"); }
                    else output.Append(text[i]);
                    i++;
                }
                if (i >= text.Length) return -1;
                output.Append(c); i++; continue;
            }
            output.Append(c); i++;
        }
        return -1;
    }

    private static char Previous(string text, int at)
    {
        for (var j = at - 1; j >= 0; j--) if (!char.IsWhiteSpace(text[j])) return text[j];
        return '\0';
    }

    private static Place Describe(string text, string written, int offset, char character)
    {
        var line = 1; var lineStart = 0;
        for (var j = 0; j < offset; j++) if (text[j] == '\n') { line++; lineStart = j + 1; }
        var lineEnd = text.IndexOf('\n', offset); if (lineEnd < 0) lineEnd = text.Length;
        var before = text[lineStart..lineEnd].TrimEnd('\r');
        var writtenLines = written.Split('\n');
        var after = line - 1 < writtenLines.Length ? writtenLines[line - 1].TrimEnd('\r') : before;
        return new Place(line, offset - lineStart + 1, character, Clip(before, offset - lineStart), Clip(after, offset - lineStart));
    }

    // The part of a line around a column (a long line of a page is cut to its neighbourhood).
    private static string Clip(string line, int column)
    {
        if (line.Length <= 120) return line.Trim();
        var from = Math.Max(0, column - 50);
        var to = Math.Min(line.Length, from + 100);
        return (from > 0 ? "…" : "") + line[from..to].Trim() + (to < line.Length ? "…" : "");
    }
}
