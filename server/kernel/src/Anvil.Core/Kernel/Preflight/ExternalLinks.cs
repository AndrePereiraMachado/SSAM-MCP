using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>
/// C-23 (F-AiChatbot-03, F-FT-14, 27/10): the href of an &lt;a&gt; is where the Link goes. A Link has no href property: the
/// page's href was an extended property the runtime overrides, so the link to a URL kept no function and the Verify asked
/// "On Click must be set". A URL is opened by the destination the platform gives it, the external site with its URL input:
/// RedirectToURL in a Reactive or Mobile module (MobileFlow Common of the templates; the System's in ODC), ExternalURL in a
/// Traditional one. LINK_HREF_REWRITTEN (JobNormalizer.WithBase, which knows the module type): the href of an &lt;a&gt; without
/// onclick is written as onclick="RedirectToURL(URL = &lt;the href as an expression&gt;)" (ExternalURL in Traditional, where an
/// anchor #Name of an element of the same document is ExternalURL(URL = "#" + Name.Id)), in a new document and in the elements
/// of an edit, listed in the answer; target and every other attribute stay (an extended property: target="_blank" opens the
/// URL in a new tab). A placeholder href ("#" or empty) beside an onclick is dropped (the click decides). What stays (an href
/// beside an onclick, an anchor, a placeholder with no onclick) is refused by the document compiler: HTML_HREF_UNSUPPORTED with
/// its fix (and the patch when the correction is certain), never written as an attribute the runtime drops.
/// The Traditional half (review B1 round 3, proto e699810c): the same normalization with the template's ExternalURL; the
/// Traditional compiler resolves ExternalURL as the module's external site and refuses what stays with the same
/// <see cref="Message"/> and <see cref="Fix"/>, so both forms say the same.
/// </summary>
public static class ExternalLinks
{
    public const string Rewritten = "LINK_HREF_REWRITTEN";
    public const string Unsupported = "HTML_HREF_UNSUPPORTED";

    /// <summary>The external site of the Traditional templates (WebFlow Common).</summary>
    public const string TraditionalSite = "ExternalURL";
    /// <summary>The external site of the Reactive and Mobile templates (MobileFlow Common) and of the ODC System.</summary>
    public const string ReactiveSite = "RedirectToURL";

    public static bool IsTraditional(string? moduleType) => moduleType is "WebResponsive" or "WebResponsiveLibrary";

    /// <summary>The external site the templates give a module of this type (the name the onclick names).</summary>
    public static string Site(string? moduleType) => IsTraditional(moduleType) ? TraditionalSite : ReactiveSite;

    public enum Form { Placeholder, Script, Anchor, Url }

    private static readonly Regex Identifier = new(@"^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>What an href says, decoded and trimmed.</summary>
    public static Form Of(string href)
    {
        var value = href.Trim();
        if (value.Length == 0 || value == "#") return Form.Placeholder;
        if (value.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase)) return Form.Script;
        if (value.StartsWith('#') && !value.Contains("{{", StringComparison.Ordinal)) return Form.Anchor;
        return Form.Url;
    }

    /// <summary>The onclick an href is written as, or null when it stays for the compiler to refuse: a URL (literal, a binding,
    /// or text with bindings: their concatenation) is <paramref name="site"/>(URL = ...); an anchor only in a Traditional page,
    /// naming an element of the same document (<paramref name="ids"/>).</summary>
    public static string? Call(string href, string site, bool traditional, IReadOnlySet<string> ids)
    {
        var value = href.Trim();
        switch (Of(value)) {
            case Form.Url:
                if (ScreenHtml.BindingFault(value) != null) return null;   // the binding rule refuses it with its own fix
                return site + "(URL = " + ScreenHtml.Unsugar(value) + ")";
            case Form.Anchor:
                var id = value[1..];
                return traditional && Identifier.IsMatch(id) && ids.Contains(id) ? site + "(URL = \"#\" + " + id + ".Id)" : null;
            default:
                return null;
        }
    }

    /// <summary>The fix of an href the normalization left (HTML_HREF_UNSUPPORTED), by its form.</summary>
    public static string Fix(string href, bool onclick, bool traditional, string site)
    {
        var form = Of(href);
        if (onclick && form != Form.Placeholder)
            return "a Link has one On Click: keep onclick and drop href (the patch), or drop onclick and keep href (written as onclick=\"" + site + "(URL = ...)\")";
        return form switch {
            Form.Placeholder => "name the destination: onclick=\"Action\" (a screen action of actions=), onclick=\"Screen(...)\", or href=\"https://...\" (a URL)",
            Form.Anchor when traditional => "an anchor names an element of this document by its id (href=\"#Services\" with id=\"Services\" on the element): it is written as onclick='" + site + "(URL = \"#\" + Services.Id)'",
            Form.Anchor => "a Reactive or Mobile page scrolls to an element with a screen action: onclick=\"GoToServices\" with `action <Screen>.GoToServices` calling OutSystemsUI ScrollToElement(WidgetId = Services.Id) in a logic text of this job",
            Form.Script => "an event names its destination: onclick=\"Save\" or onclick=\"Open(Id = Row.Id)\"; JavaScript is not written in the page",
            _ => "write the URL as href=\"https://...\" or href=\"{{ Expression }}\" (a Text)",
        };
    }

    /// <summary>The message of an href the normalization left.</summary>
    public static string Message(string href, bool onclick)
    {
        var form = Of(href);
        if (onclick && form != Form.Placeholder) return $"<a> has href=\"{Clip(href)}\" and onclick: a Link has one On Click, and its href is no property (the runtime drops it)";
        return form switch {
            Form.Placeholder => $"<a href=\"{Clip(href)}\"> goes nowhere: a Link needs its On Click (its href is no property)",
            Form.Anchor => $"<a href=\"{Clip(href)}\"> is an anchor the page cannot open as written",
            Form.Script => $"<a href=\"{Clip(href)}\"> is JavaScript",
            _ => $"<a href=\"{Clip(href)}\"> cannot be written as the On Click of the Link",
        };
    }

    private static string Clip(string text) => text.Length <= 80 ? text : text[..77] + "...";

    // ---- the normalization (JobNormalizer.WithBase) -------------------------------------------------------------------------

    /// <summary>LINK_HREF_REWRITTEN over the html ops of the job: the document of a new screen or block (data.html) and the
    /// elements of an edit (data.edit, data.edits, or the whole document of an edit), never a fragment (op parent) or the page
    /// form. A Traditional module: ExternalURL, and an anchor of an element of the same document.</summary>
    public static void Normalize(JsonArray ops, string? prefix, string? moduleType, List<JsonObject> done)
    {
        var traditional = IsTraditional(moduleType);
        var site = Site(moduleType);
        for (var i = 0; i < ops.Count; i++) {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "html" || op["parent"] != null || op["data"] is not JsonObject data) continue;
            if (data["html"] is JsonValue value && value.TryGetValue<string>(out var html) && HtmlText.IsDocument(html)
                && Rewrite(html, prefix == null ? null : $"{prefix}/{i}/data/html", site, traditional, done) is { } written && written != html) {
                SentJob.HtmlBefore(data, html);
                data["html"] = written;
            }
            foreach (var key in new[] { "edit", "edits" })
                if (data[key] is JsonArray edits)
                    for (var j = 0; j < edits.Count; j++)
                        if (edits[j] is JsonValue e && e.TryGetValue<string>(out var edit)
                            && Rewrite(edit, prefix == null ? null : $"{prefix}/{i}/data/{key}/{j}", site, traditional, done) is { } rewritten && rewritten != edit)
                            edits[j] = rewritten;
        }
    }

    /// <summary>The text with every href it can write as the Link's On Click written so (the entries in <paramref name="done"/>),
    /// or null when nothing changes.</summary>
    internal static string? Rewrite(string html, string? path, string site, bool traditional, List<JsonObject> done)
    {
        if (!html.Contains("href", StringComparison.OrdinalIgnoreCase)) return null;
        HtmlText text;
        try { text = HtmlText.Parse(html); } catch { return null; }
        var ids = new HashSet<string>(text.Elements().Select(e => e.Get("id")).OfType<string>().Select(v => v.Trim()), StringComparer.Ordinal);
        var edits = new List<HtmlText.Edit>();
        foreach (var a in text.Elements().Where(e => e.Tag.Equals("a", StringComparison.OrdinalIgnoreCase))) {
            if (a.Find("href") is not { } href) continue;
            var value = HtmlDocumentRules.Decode(href.Value).Trim();
            var onclick = a.Find("onclick") != null;
            var (line, column) = text.Position(href.Start);
            var where = $"line {line} col {column}";
            if (Of(value) == Form.Placeholder && onclick) {
                var start = href.Start;
                while (start > 0 && char.IsWhiteSpace(html[start - 1])) start--;
                edits.Add(new(start, href.End - start, ""));
                done.Add(JobNormalizer.Entry(Rewritten, path, $"href=\"{value}\"", null, $"{where}: a placeholder href beside onclick: the click is the Link's On Click, the href is dropped"));
                continue;
            }
            if (onclick || Call(value, site, traditional, ids) is not { } call) continue;   // the compiler refuses what stays
            edits.Add(new(href.Start, href.End - href.Start, "onclick=" + ScreenDocument.QuoteAttribute(call)));
            done.Add(JobNormalizer.Entry(Rewritten, path, $"href=\"{value}\"", $"onclick=\"{call}\"",
                $"{where}: a Link opens a URL through the module's external site {site} (its URL input): the href is its On Click; target and the other attributes stay"));
        }
        return edits.Count == 0 ? null : HtmlText.Apply(html, edits);
    }
}
