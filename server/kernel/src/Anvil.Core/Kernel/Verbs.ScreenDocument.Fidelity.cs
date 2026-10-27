using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// The document form writes what the document says (the owner's report of 2026-10-12, FolhaPonto_UI): every &lt;style&gt; and
/// data.css land in the root's own style sheet as written (the theme with scope="theme"), a line of text with bindings is one
/// Expression, and the model the compile wrote is read again in the same apply before anything is reported: the style sheet
/// is that CSS, no text keeps a brace pair, no new Expression is empty. Any failure: nothing is written (the root goes, the
/// theme is put back) and the refusal has every problem. The classes the page uses without a rule come as a warning.
/// </summary>
public sealed partial class ModelSession
{
    private sealed record WebStyleSheetBackup(ServiceStudio.Model.WebStyleSheet? Sheet, string Author);

    internal const string IconThemeNote = "the theme's svg and span selectors also match the icon spans (:is(svg, :where(.ssam-icon)), span:not(:where(.ssam-icon))): its rules for the svg icons style them";

    /// <summary>The theme a screen or block shows (its flow's, else the module's default), when it is of this module, with its svg
    /// and span selectors widened to the icon spans of ScreenHtmlNative (idempotent): the report, and the theme with its author CSS
    /// before (to put back), when it changed. A theme of another module is said, never touched.</summary>
    private (JsonObject? Report, object? Theme, WebStyleSheetBackup? Before) WidenIconTheme(IObjectSignature root)
    {
        try
        {
            var shown = (root.Parent is IObjectSignature flow ? PrototypeBuilder.Prop(flow, "Theme") as IObjectSignature : null) ?? _es.DefaultMobileTheme as IObjectSignature;
            if (shown == null) return (null, null, null);
            var theme = _es.MobileThemes.FirstOrDefault(t => t.ObjectKey?.ToString() == shown.ObjectKey?.ToString());
            if (theme == null) return (new JsonObject { ["theme"] = TypeResolver.Name(shown), ["widened"] = false, ["why"] = "the theme is of another module: its svg selectors are not rewritten" }, null, null);
            var sheet = ThemeCss.Of(theme);
            var author = sheet != null ? ThemeCss.Author(sheet) : theme.StyleSheet ?? "";
            var widened = ScreenHtmlNative.WidenIconSelectors(author);
            if (widened == author) return (null, null, null);
            if (sheet != null) ThemeCss.WriteAuthor(sheet, widened); else theme.StyleSheet = widened;
            return (new JsonObject { ["theme"] = TypeResolver.Name(theme), ["widened"] = true }, theme, new WebStyleSheetBackup(sheet, author));
        }
        catch (Exception error) { return (new JsonObject { ["widened"] = false, ["why"] = Unwrap(error) }, null, null); }
    }

    /// <summary>The author CSS of the module's default theme when it is of this module (null otherwise or when it cannot be read):
    /// what ScreenHtmlNative reads for the rules of the inside of an svg.</summary>
    internal string? DefaultThemeCss()
    {
        try
        {
            if (_es.DefaultMobileTheme is not IObjectSignature shown) return null;
            var theme = _es.MobileThemes.FirstOrDefault(t => t.ObjectKey?.ToString() == shown.ObjectKey?.ToString());
            if (theme == null) return null;
            var sheet = ThemeCss.Of(theme);
            return sheet != null ? ThemeCss.Author(sheet) : theme.StyleSheet;
        }
        catch (Exception) { return null; }
    }

    private sealed partial class DocumentCompiler
    {
        private List<ScreenDocument.StyleBlock> styles = [];
        private string? ownSheet;
        private int joined;                                                     // lines of text with bindings joined in one Expression
        private int spaced;                                                     // runs that keep the whitespace beside an inline element
        private readonly JsonArray normalized = [];                             // what the compile wrote in the one form a value has (ScreenHtmlNative)
        private List<string> iconRules = [];                                    // the mask rules of the svg icons, for the root's own sheet
        private bool iconsConverted;                                            // an inline svg became an icon span
        private bool suspectExpressions;                                        // an attribute that takes an expression holds prose
        private readonly List<(IObjectSignature Run, bool Expression, (int Line, int Column) At, bool Read)> madeRuns = [];
        private readonly List<(IObjectSignature Widget, ScreenHtml.Node Node, bool Read)> madeExpressions = [];
        private HashSet<(int Line, int Column)> reported = [];                  // where the module-free checks already found a problem
        private object? themeWritten;                                           // the theme this compile wrote, and its author CSS before
        private WebStyleSheetBackup? themeBefore;


        /// <summary>What the model holds after the compile, against what the document says (before any report): the root's own
        /// style sheet is the CSS of its &lt;style&gt; blocks and data.css; no text widget made from a line of the document
        /// keeps {{ or }}; no new Expression is empty. Each failure is a problem of the document (one refusal).</summary>
        private void PostChecks()
        {
            var top = document.Children.First(c => !c.IsText && c.Tag is "screen" or "block");
            var sheet = SheetOf(root);
            if ((ownSheet ?? "") != sheet)
                problems.Add(new(ScreenDocument.StyleDropped, top.Line, top.Column,
                    $"the {top.Tag}'s style sheet holds {sheet.Length} characters, the document's CSS ({styles.Count(b => !b.Theme)} <style> block(s){(options.Css != null ? " and data.css" : "")}) {(ownSheet ?? "").Length}: the CSS was not written as it is",
                    "nothing was written; send the document again (a defect of the engine if it repeats: the CSS is written as given)"));
            foreach (var (run, expression, at, read) in madeRuns)
            {
                if (reported.Contains(at)) continue;
                if (expression)
                {
                    if (!read && (Text(ApiValue(run, "Value")) ?? "").Trim().Length == 0)
                        problems.Add(new(ScreenDocument.ExpressionEmpty, at.Line, at.Column, "an Expression of the text has no value: the page would show an empty Expression", "write the expression inside {{ }}, or remove the braces"));
                }
                else if (ApiValue(run, "Text") is string text && (text.Contains("{{", StringComparison.Ordinal) || text.Contains("}}", StringComparison.Ordinal)))
                    problems.Add(new(ScreenDocument.BindingLeft, at.Line, at.Column, $"the text \"{ScreenDocument.ClipText(text)}\" keeps a brace pair of a binding: the page would show it as text",
                        "a binding is {{ expression }} (text around it is joined: \"Hoje · {{ X }}\"); literal braces go in <text>...</text>"));
            }
            foreach (var (widget, node, read) in madeExpressions)
                if (!read && !reported.Contains((node.Line, node.Column)) && (Text(ApiValue(widget, "Value")) ?? "").Trim().Length == 0)
                    problems.Add(new(ScreenDocument.ExpressionEmpty, node.Line, node.Column, "<expr> has no value: the page would show an empty Expression", "<expr value=\"<expression>\"/>, or {{ expression }} in the text"));
        }

        // Whether a widget is a Popup or sits inside one (up to the root): its events default to the Popup's Transition.
        private bool InPopup(IObjectSignature element)
        {
            for (var o = element; o != null && !ReferenceEquals(o, root); o = o.Parent as IObjectSignature)
                if (Is(o, "IPopup")) return true;
            return false;
        }

        // The CSS of a screen's or block's own style sheet ("" without one).
        private static string SheetOf(object element) => ApiValue(element, "StyleSheet") switch { string text => text, IExpression e => e.Text ?? "", _ => "" };

        // A property as the Model API answers it (the interface's, not the concrete class's: a style sheet is its CSS text there).
        private static object? ApiValue(object element, string property) => FindProperty(element, property) is { } pi ? SafeGet(pi, element) : null;

        /// <summary>The theme's part of the document (its &lt;style scope="theme"&gt; blocks) in the module's default theme, as
        /// written, between each named part's markers or the root's markers for unnamed blocks (a second compile replaces
        /// the same part), read again: every part is that CSS. Null without such a block.</summary>
        private JsonObject? InstallTheme(ScreenHtml.Node top)
        {
            var key = TypeResolver.Name(root) ?? top.Get("name") ?? "";
            var parts = ScreenDocument.ThemeParts(styles, key);
            if (parts.Count == 0) return null;
            var report = new JsonObject();
            try
            {
                var defaultTheme = s._es.DefaultMobileTheme;
                var theme = defaultTheme == null ? null : s._es.MobileThemes.FirstOrDefault(t => t.ObjectKey?.ToString() == defaultTheme.ObjectKey?.ToString());
                if (theme == null)
                {
                    problems.Add(new(ScreenDocument.StyleUnplaced, top.Line, top.Column, defaultTheme == null
                            ? "<style scope=\"theme\">: the module has no default theme to take the CSS"
                            : $"<style scope=\"theme\">: the default theme {TypeResolver.Name(defaultTheme)} belongs to another module; the CSS needs a theme of this module",
                        "write <style> without scope (the CSS goes to this page's style sheet), or give the module a theme of its own"));
                    return null;
                }
                var sheet = ThemeCss.Of(theme);
                themeBefore = new(sheet, sheet != null ? ThemeCss.Author(sheet) : theme.StyleSheet ?? "");
                themeWritten = theme;
                var installed = new JsonArray();
                foreach (var part in parts)
                {
                    report["theme"] = s.InstallStylesheet(part.Key, part.Css, report, format: false);
                    installed.Add(new JsonObject { ["key"] = part.Key, ["chars"] = part.Css.Length, ["marker"] = $"/* anvil:html {part.Key} */" });
                    if (part.Key == key)
                    {
                        report["chars"] = part.Css.Length;
                        report["marker"] = $"/* anvil:html {key} */";
                    }
                }
                var after = sheet != null ? ThemeCss.Author(sheet) : theme.StyleSheet ?? "";
                foreach (var part in parts)
                    if (!SameCss(Block(after, part.Key), part.Css))
                    {
                        problems.Add(new(ScreenDocument.StyleDropped, top.Line, top.Column, $"the theme {TypeResolver.Name(theme)} does not hold the CSS of <style scope=\"theme\"> part {part.Key} as written",
                            "nothing was written; send the document again (a defect of the engine if it repeats)"));
                        RestoreTheme();
                        return null;
                    }
                report["parts"] = installed;
                return report;
            }
            catch (Exception error)
            {
                problems.Add(new(ScreenDocument.StyleDropped, top.Line, top.Column, $"<style scope=\"theme\">: the theme could not take the CSS: {Unwrap(error)}", "nothing was written; write <style> without scope to put the CSS in this page's style sheet"));
                RestoreTheme();
                return null;
            }
        }

        /// <summary>When the document turned inline svg into icon spans: the theme the root shows (its flow's, else the module's
        /// default), when it is of this module, has its svg and span selectors widened to the spans (ScreenHtmlNative.WidenIconSelectors,
        /// idempotent), so the author's rules for the svg icons style them. Put back with the rest when a later check refuses.</summary>
        private JsonObject? WidenThemeIcons()
        {
            var (report, theme, before) = s.WidenIconTheme(root);
            if (theme != null && before != null) { iconTheme = theme; iconThemeBefore = before; }
            if (report?["widened"]?.GetValue<bool>() == true) normalized.Add(new JsonObject { ["code"] = ScreenHtmlNative.SvgMask, ["element"] = "theme", ["attribute"] = report["theme"]?.ToString(), ["note"] = IconThemeNote });
            return report;
        }
        private object? iconTheme;
        private WebStyleSheetBackup? iconThemeBefore;

        // The text between the markers of a key in a theme's author CSS ("" without them).
        private static string Block(string css, string key)
        {
            var begin = $"/* anvil:html {key} */"; var end = $"/* /anvil:html {key} */";
            var i = css.IndexOf(begin, StringComparison.Ordinal);
            if (i < 0) return "";
            var j = css.IndexOf(end, i, StringComparison.Ordinal);
            return j < 0 ? "" : css[(i + begin.Length)..j];
        }

        // The same CSS but for what the theme does to every author block (an @import goes to the top, #reactContainer is written
        // :is(#reactContainer, body), the ends of lines): the rules as written.
        private static bool SameCss(string written, string css)
        {
            static string Rules(string text) => string.Join("\n", CssCompat.Imports(CssCompat.CanvasSelectors(text.Replace("\r\n", "\n", StringComparison.Ordinal)).Css).Others
                .Split('\n').Select(l => l.TrimEnd()).Where(l => l.Length > 0));
            return Rules(written) == Rules(css);
        }

        private void RestoreTheme()
        {
            if (iconTheme != null && iconThemeBefore != null)
            {
                try
                {
                    if (iconThemeBefore.Sheet != null) ThemeCss.WriteAuthor(iconThemeBefore.Sheet, iconThemeBefore.Author);
                    else if (iconTheme is OutSystems.Model.UI.ITheme widenedTheme) widenedTheme.StyleSheet = iconThemeBefore.Author;
                }
                catch (Exception) { /* the apply refuses anyway; the candidate is never saved */ }
                iconTheme = null; iconThemeBefore = null;
            }
            if (themeWritten == null || themeBefore == null) return;
            try
            {
                if (themeBefore.Sheet != null) ThemeCss.WriteAuthor(themeBefore.Sheet, themeBefore.Author);
                else if (themeWritten is OutSystems.Model.UI.ITheme theme) theme.StyleSheet = themeBefore.Author;
            }
            catch (Exception) { /* the apply refuses anyway; the candidate is never saved */ }
            themeWritten = null; themeBefore = null;
        }

        /// <summary>Where the CSS of the document went (the op's report).</summary>
        private JsonObject? StyleReport(JsonObject? theme)
        {
            if (styles.Count == 0 && options.Css == null) return null;
            var report = new JsonObject
            {
                ["placed"] = (rootKind == "MobileScreen" ? "screen" : "block") + " style sheet",
                ["blocks"] = styles.Count(b => !b.Theme), ["nested"] = styles.Count(b => b.Nested && !b.Theme), ["dataCss"] = options.Css != null,
                ["chars"] = ownSheet?.Length ?? 0,
            };
            if (theme != null) report["theme"] = theme;
            return report;
        }

        /// <summary>The producer module of a referenced element: the name of the Reference it hangs from (null for an element
        /// of this module).</summary>
        private static string? ProducerOf(IObjectSignature element)
        {
            for (var up = element.Parent as IObjectSignature; up != null; up = up.Parent as IObjectSignature)
                if (up.GetType().Name.StartsWith("Reference", StringComparison.Ordinal) || up.GetType().GetInterfaces().Any(i => i.Name == "IReference"))
                    return TypeResolver.Name(up);
            return null;
        }

        /// <summary>The classes the document uses that no rule defines where this page reads CSS: its own style sheet, the
        /// themes of the module, OutSystems UI. Each with the element that uses it; where else the module writes it (another
        /// screen's or block's own style sheet, which that page alone loads); and the default theme when it is of another
        /// module (its CSS is not in this capture). Null when every class has its rule.</summary>
        internal JsonObject? ClassesWithoutRule()
        {
            if (root == null) return null;
            var top = document.Children.FirstOrDefault(c => !c.IsText && c.Tag is "screen" or "block");
            if (top == null) return null;
            var used = ScreenDocument.UsedClasses(top);
            if (used.Count == 0) return null;
            var defined = ScreenDocument.CssClasses(SheetOf(root));
            string? themeElsewhere = null;
            try
            {
                var own = new HashSet<string>(s._es.MobileThemes.Select(t => t.ObjectKey?.ToString() ?? ""), StringComparer.Ordinal);
                foreach (var theme in s._es.MobileThemes) defined.UnionWith(ScreenDocument.CssClasses(ApiValue(theme, "StyleSheet") as string));
                // Goal list of 2026-10-20, item 12 (report 90a697c3: six screens warned of classes a producer theme
                // defines): the theme the page shows and every theme of the module are followed through BaseTheme; the first
                // one of another module (its CSS is not in this capture) is named, and the warning says the classes may be its.
                var shown = (root.Parent is IObjectSignature flow ? PrototypeBuilder.Prop(flow, "Theme") as IObjectSignature : null) ?? s._es.DefaultMobileTheme as IObjectSignature;
                foreach (var start in new[] { shown }.Concat(s._es.MobileThemes.OfType<IObjectSignature>()))
                {
                    var seen = new HashSet<string>(StringComparer.Ordinal);
                    for (var at = start; at != null && seen.Add(at.ObjectKey?.ToString() ?? "") && themeElsewhere == null; )
                    {
                        if (!own.Contains(at.ObjectKey?.ToString() ?? ""))
                        {
                            // The theme of OutSystems UI is the base of every theme and its classes are the allowlist already
                            // (OutSystemsUiClass): only another producer's theme may hold the rules this capture cannot read.
                            var producer = ProducerOf(at);
                            if (producer is not ("OutSystemsUI" or "OutSystemsUIWeb")) themeElsewhere = (producer != null ? producer + "." : "") + TypeResolver.Name(at);
                            break;
                        }
                        at = PrototypeBuilder.Prop(at, "BaseTheme") as IObjectSignature;
                    }
                    if (themeElsewhere != null) break;
                }
            }
            catch (Exception) { /* a module without themes: only its own CSS and OutSystems UI */ }
            var missing = used.Where(u => !defined.Contains(u.Class) && !ScreenDocument.OutSystemsUiClass(u.Class)).ToList();
            if (missing.Count == 0) return null;
            var elsewhere = new JsonObject();
            foreach (var other in OtherRoots())
            {
                var classes = ScreenDocument.CssClasses(SheetOf(other));
                if (classes.Count == 0) continue;
                var hits = missing.Where(m => classes.Contains(m.Class)).Select(m => (JsonNode)m.Class).ToArray();
                if (hits.Length > 0) elsewhere[TypeResolver.Name(other) ?? other.ObjectKey?.ToString() ?? "?"] = new JsonArray(hits);
            }
            var result = new JsonObject
            {
                ["root"] = TypeResolver.Name(root),
                ["classes"] = new JsonArray(missing.Select(m => (JsonNode)new JsonObject { ["class"] = m.Class, ["line"] = m.Node.Line, ["element"] = m.Node.Tag }).ToArray()),
            };
            if (elsewhere.Count > 0) result["elsewhere"] = elsewhere;
            if (themeElsewhere != null) result["themeElsewhere"] = themeElsewhere;
            return result;
        }

        // The other screens and blocks of the module (every UI flow).
        private IEnumerable<IObjectSignature> OtherRoots()
        {
            foreach (var flow in ((IObjectSignature)s._espace).Children.OfType<IObjectSignature>().Where(c => Is(c, "IMobileFlow") || Is(c, "IWebFlow")))
                foreach (var element in flow.Children.OfType<IObjectSignature>())
                    if (!ReferenceEquals(element, root) && (Is(element, "IMobileScreen") || Is(element, "IMobileBlock"))) yield return element;
        }
    }
}
