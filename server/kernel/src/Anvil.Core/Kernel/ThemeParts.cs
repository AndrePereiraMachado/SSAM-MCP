namespace Anvil.Core;

/// <summary>
/// C-14 (F-FigmaMobile-03, F-FitBody-07/16/31/44/51: the CSS of a theme could not be edited after its creation; the sessions
/// created 10 blocks that only carried CSS): the parts of the module theme that the screen documents write, between the markers
/// <c>/* anvil:html &lt;key&gt; */</c> and <c>/* /anvil:html &lt;key&gt; */</c> of the theme's author CSS. The key of the part of
/// <c>&lt;style scope="theme"&gt;</c> is its root's name; the key of a named part (<c>&lt;style scope="theme" id="x"&gt;</c>) is
/// <c>style:x</c>, and the root whose document (or edit) wrote it last is recorded right after the begin marker, on its line:
/// <c>/* anvil:html style:x */ /* anvil:owner Root */</c>. The reading of a root prints its own part and the named parts it
/// owns, so an edit has them with a basedOn; a named part written before the owner was recorded belongs to no root until an edit
/// sends it again (it is then replaced whole and owned by that root).
/// </summary>
public static class ThemeParts
{
    public static string Begin(string key) => $"/* anvil:html {key} */";
    public static string End(string key) => $"/* /anvil:html {key} */";
    private const string OwnerOpen = "/* anvil:owner ";
    public static string Owner(string root) => OwnerOpen + root + " */";
    /// <summary>The key of a part: the root's own (no id) or a named one.</summary>
    public static string Key(string root, string? id) => id == null ? root : "style:" + id;

    /// <summary>The text of a part as the reading prints it and the edit compares it: line ends \n, no blank lines before the
    /// first, no white space after the last character.</summary>
    public static string Canon(string css) => css.Replace("\r\n", "\n", StringComparison.Ordinal).TrimEnd().TrimStart('\n');

    /// <summary>One part of the author CSS: where its block starts and ends (both markers included), its CSS (canonical) and the
    /// root recorded as its owner (null: none).</summary>
    public readonly record struct Part(string Key, int Start, int End, string Css, string? Owner);

    /// <summary>The block of <paramref name="key"/> in the CSS, null without it (or without its end marker).</summary>
    public static Part? Find(string css, string key)
    {
        var begin = Begin(key); var end = End(key);
        var i = css.IndexOf(begin, StringComparison.Ordinal);
        if (i < 0) return null;
        var j = css.IndexOf(end, i + begin.Length, StringComparison.Ordinal);
        if (j < 0) return null;
        var content = css[(i + begin.Length)..j];
        string? owner = null;
        var trimmed = content.TrimStart(' ', '\t');
        if (trimmed.StartsWith(OwnerOpen, StringComparison.Ordinal) && trimmed.IndexOf("*/", OwnerOpen.Length, StringComparison.Ordinal) is var close and > 0)
        {
            owner = trimmed[OwnerOpen.Length..close].Trim();
            content = trimmed[(close + 2)..];
        }
        return new Part(key, i, j + end.Length, Canon(content), owner);
    }

    /// <summary>Every named part of the CSS (<c>style:*</c>), in the order of the CSS.</summary>
    public static List<Part> Named(string css)
    {
        var parts = new List<Part>();
        const string open = "/* anvil:html style:";
        for (var at = css.IndexOf(open, StringComparison.Ordinal); at >= 0; at = css.IndexOf(open, at + open.Length, StringComparison.Ordinal))
        {
            var close = css.IndexOf(" */", at + open.Length, StringComparison.Ordinal);
            if (close < 0) break;
            var key = "style:" + css[(at + open.Length)..close];
            if (key.Length <= 6 || key.Contains('\n') || parts.Any(p => p.Key == key)) continue;
            if (Find(css, key) is { } part && part.Start == at) parts.Add(part);
        }
        return parts;
    }

    /// <summary>The parts the reading of <paramref name="root"/> prints, in the order of the CSS: its own part (id null) and the
    /// named parts whose recorded owner is that root (id = the name).</summary>
    public static List<(string? Id, string Css, int At)> Owned(string css, string root)
    {
        var owned = new List<(string? Id, string Css, int At)>();
        if (root.Length == 0 || css.Length == 0) return owned;
        if (Find(css, root) is { } own) owned.Add((null, own.Css, own.Start));
        foreach (var part in Named(css))
            if (string.Equals(part.Owner, root, StringComparison.Ordinal)) owned.Add((part.Key[6..], part.Css, part.Start));
        owned.Sort((a, b) => a.At.CompareTo(b.At));
        return owned;
    }

    /// <summary>The CSS without the block of <paramref name="key"/> (and the blank line it leaves), or the CSS itself without it.</summary>
    public static string Without(string css, string key)
    {
        if (Find(css, key) is not { } part) return css;
        var before = css[..part.Start].TrimEnd(' ', '\t', '\r', '\n');
        var after = css[part.End..].TrimStart(' ', '\t', '\r', '\n');
        return before.Length == 0 ? after : after.Length == 0 ? before + "\n" : before + "\n\n" + after;
    }
}
