using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core.Preflight;

/// <summary>
/// C-38 (F-FigmaReactive-06; the Integradora on review B1 round 3, S2): name= on a container or a text of a page
/// (&lt;div name="SectionFaq"&gt;) is no attribute of the language there: it was an extended property in silence, and every
/// SectionFaq.Id came back HTML_NAME_UNKNOWN (42 of them). The platform accepts it, so it is never refused: the Name of a
/// widget is id=, and name= of a new element (no k) without id= is written as id= before the checks, listed in the
/// answer (HTML_WIDGET_NAME_IS_ID), so it costs no round. An element with both keeps both, as written (its name= stays an
/// extended property). The elements that take name= (screen, block, var, input, aggregate, event, placeholder, the block of
/// &lt;Block&gt;, a form control) keep it. The tags are <see cref="ScreenDocument.IdNamedTags"/>.
/// Review B1 round 2, fix 4: only when that id is the name the Studio keeps, never a refusal the base did not give: the
/// value is a widget name (a letter, then letters, digits or _, as an id= must be) and no other id=, name= or rewrite of
/// the op's texts has it, compared as OutSystems compares names (case-insensitive). Otherwise (name="hero-1", "main hero",
/// two name="Card", a var and a div both named Title) name= stays the extended property it was, as at base.
/// </summary>
public static class WidgetNames
{
    private static readonly Regex Identifier = new("^[A-Za-z][A-Za-z0-9_]*$", RegexOptions.CultureInvariant);

    /// <summary>The html ops of the job: the document of a new screen or block (data.html), the elements of an edit
    /// (data.edit) and the html of data.edits (with, insert); never a fragment (op parent). The names of one op's texts are one
    /// scope. Review B1 round 3 (fix 5, S11): an op on an existing root (screen, block or basedOn, an edit, an element with k)
    /// also counts every name the root already holds (<paramref name="rootNames"/>, from the base); without the base (the job
    /// alone) or when the base does not have the root, its names stay as written, as at base.</summary>
    public static void Normalize(JsonArray ops, string? prefix, List<JsonObject> done, Func<string, IReadOnlyCollection<string>?>? rootNames = null)
    {
        for (var i = 0; i < ops.Count; i++) {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "html" || op["parent"] != null || op["data"] is not JsonObject data) continue;
            var html = data["html"] is JsonValue value && value.TryGetValue<string>(out var h) && HtmlText.IsDocument(h) ? h : null;
            // Each text with where it is written back and the path of its note.
            var texts = new List<(string Text, Action<string> Set, string Path)>();
            if (html != null) texts.Add((html, written => { SentJob.HtmlBefore(data, html); data["html"] = written; }, "html"));
            foreach (var key in new[] { "edit", "edits" })
                if (data[key] is JsonArray list)
                    for (var j = 0; j < list.Count; j++) {
                        var at = j;
                        if (list[j] is JsonValue e && e.TryGetValue<string>(out var edit)) texts.Add((edit, written => list[at] = written, $"{key}/{j}"));
                        else if (list[j] is JsonObject item)
                            foreach (var field in new[] { "with", "insert", "text" })
                                if (item[field] is JsonValue f && f.TryGetValue<string>(out var part)) texts.Add((part, written => item[field] = written, $"{key}/{j}/{field}"));
                    }
            if (texts.Count == 0) continue;
            IReadOnlyCollection<string>? held = null;
            if (data["screen"] != null || data["block"] != null || data["basedOn"] != null || data["edit"] != null || data["edits"] != null
                || texts.Any(t => KeyAttribute.IsMatch(t.Text)))
            {
                var root = data["screen"]?.ToString() ?? data["block"]?.ToString() ?? (html != null && RootName.Match(html) is { Success: true } m ? m.Groups[1].Value : null);
                if (rootNames == null || root == null || rootNames(root) is not { } names) continue;
                held = names;
            }
            var free = FreeNames(texts.Select(t => t.Text), held);
            foreach (var (text, set, path) in texts)
                if (Rewrite(text, prefix == null ? null : $"{prefix}/{i}/data/{path}", done, free) is { } written) set(written);
        }
    }

    private static readonly Regex KeyAttribute = new(@"<[A-Za-z][^>]*\sk\s*=", RegexOptions.CultureInvariant);
    private static readonly Regex RootName = new(@"^\s*<(?:screen|block)\b[^>]*\bname=""([^""]+)""", RegexOptions.CultureInvariant);

    /// <summary>The name= values of new widget elements that can be their id=: a widget name that no id=, no name= of an
    /// element that takes name=, no other such widget of these texts and no name the root already holds
    /// (<paramref name="held"/>) has (case-insensitive).</summary>
    internal static HashSet<string> FreeNames(IEnumerable<string> texts, IReadOnlyCollection<string>? held = null)
    {
        var taken = new HashSet<string>(held ?? [], StringComparer.OrdinalIgnoreCase);
        var wanted = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var html in texts) {
            if (!html.Contains("name", StringComparison.Ordinal)) continue;
            List<HtmlText.Element> elements;
            try { elements = HtmlText.Parse(html).Elements().ToList(); } catch { continue; }
            foreach (var element in elements) {
                if (element.Get("id") is { Length: > 0 } id) taken.Add(id);
                if (element.Attributes.FirstOrDefault(a => a.Name == "name") is not { Value.Length: > 0 } name) continue;
                if (!ScreenDocument.IdNamedTags.Contains(element.Tag)) taken.Add(name.Value);
                else if (element.Get("k") == null && element.Get("id") == null) wanted[name.Value] = wanted.GetValueOrDefault(name.Value) + 1;
            }
        }
        return wanted.Where(w => w.Value == 1 && Identifier.IsMatch(w.Key) && !taken.Contains(w.Key)).Select(w => w.Key).ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>The text with name= of every new widget element without id= written as id= (the entries in
    /// <paramref name="done"/>), or null when nothing changes. Only the names in <paramref name="free"/> (all of this text's
    /// own free names when null) are written.</summary>
    internal static string? Rewrite(string html, string? path, List<JsonObject> done, IReadOnlySet<string>? free = null)
    {
        if (!html.Contains("name", StringComparison.Ordinal)) return null;
        free ??= FreeNames([html]);
        if (free.Count == 0) return null;
        HtmlText text;
        try { text = HtmlText.Parse(html); } catch { return null; }
        var edits = new List<HtmlText.Edit>();
        foreach (var element in text.Elements()) {
            if (!ScreenDocument.IdNamedTags.Contains(element.Tag) || element.Get("k") != null || element.Get("id") != null) continue;
            if (element.Attributes.FirstOrDefault(a => a.Name == "name") is not { Value.Length: > 0 } name || !free.Contains(name.Value)) continue;
            edits.Add(new(name.Start, name.Name.Length, "id"));
            var (line, column) = text.Position(element.OpenStart);
            var value = name.Value.Length <= 80 ? name.Value : name.Value[..77] + "...";
            done.Add(JobNormalizer.Entry(ScreenDocument.WidgetName, path, $"name=\"{value}\"", $"id=\"{value}\"",
                $"line {line} col {column}: name=\"{value}\" on <{element.Tag}> is written as id=\"{value}\": the Name of a widget is id= (what {value}.Id and the other expressions name); name= names a screen, a block, a variable, an input, an aggregate, an event, a placeholder and the block of <Block>"));
        }
        return edits.Count == 0 ? null : HtmlText.Apply(html, edits);
    }
}
