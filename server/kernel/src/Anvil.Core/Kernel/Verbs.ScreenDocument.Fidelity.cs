using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// The document form writes what the document says (the owner's report of 2026-10-12, FolhaPonto_UI): every &lt;style&gt;, or
/// data.css in their place (R2-D), lands in the root's own style sheet as written (the theme with scope="theme"), a line of text with bindings is one
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
            var report = new JsonObject { ["theme"] = TypeResolver.Name(theme), ["widened"] = true };
            // R2-D: the theme's write took the one normalization (shadowed rules, imports): what it changed is said here.
            ThemeCss.SayChanged(sheet, report);
            return (report, theme, new WebStyleSheetBackup(sheet, author));
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
        private readonly JsonArray importsMoved = [];                           // C-05: the @import of the theme's part put first in the root's sheet
        private string sheetBefore = "";                                        // R2-D: the root's own sheet before this compile
        private JsonObject? sheetSaid;                                          // R2-D: what the write of the sheet said (replaced, cssStages, images)
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
                    $"the {top.Tag}'s style sheet holds {sheet.Length} characters, the document's CSS ({styles.Count(b => !b.Theme)} <style> block(s){(Anvil.Reading.ScreenHtmlEdit.DataCss(options.Css) != null ? " (data.css in their place)" : "")}) {(ownSheet ?? "").Length}: the CSS was not written as it is",
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
            DeclaredPropertiesKept();
        }

        // Every property the document declares (os-<Property>, os-on<event>.<Property>, and a boolean or a number of the table) and
        // what it wrote, read back when the element is finished. A property that does not reach the model is never silence.
        private readonly List<(IObjectSignature Target, string Kind, string Property, string Value, string AsWritten, ScreenHtml.Node Node, string Attribute)> declaredFacts = [];
        private int declaredChecked;
        // What Assign handed the model, in the model's terms (the word of the language, a constant binding, a number as a number): what
        // a declared property is compared with, never the text of the attribute. Null: nothing was handed as a fact (a reference).
        private string? assignedFact;

        private void Declared(IObjectSignature target, string kind, string property, string value, ScreenHtml.Node node, string attribute)
        {
            var pi = FindProperty(target, property);
            if (pi == null) return;
            var now = SafeGet(pi, target);
            // An attribute of the table with a text or an expression goes through its sugar (class, the literal of prose): os- only.
            if (!attribute.StartsWith("os-", StringComparison.Ordinal) && now is not (bool or IFormattable)) return;
            // An expression with a binding is its concatenation, and prose is its literal: what the write left is what must stay.
            var asWritten = (now is IExpression || pi.PropertyType == typeof(IExpression) ? FactText(now) : assignedFact) ?? value;
            declaredFacts.Add((target, kind, property, value, asWritten, node, attribute));
        }

        private void DeclaredPropertiesKept()
        {
            foreach (var (target, kind, property, value, asWritten, node, attribute) in declaredFacts)
            {
                if (target.WasDeleted || FindProperty(target, property) is not { } pi) continue;
                var now = SafeGet(pi, target);
                if (now != null && FactText(now) == null) continue;
                var text = FactText(now) ?? "";
                declaredChecked++;
                if (SameFact(text, asWritten)) continue;
                var name = TypeResolver.Name(target);
                var message = $"{attribute}=\"{Clip(value)}\" did not reach {kind}{(name is { Length: > 0 } ? " " + name : "")}: its {property} holds \"{Clip(text)}\" after the compile";
                // What the platform itself rewrites, and an element of the reading, which keeps what it has (the same rule as Visible
                // and JavaScript): said, never refused.
                if (Read(node) && !options.ProveDeclared || ScreenHtmlTables.PlatformRewrites(kind, property))
                    normalized.Add(new JsonObject { ["code"] = Anvil.Reading.ScreenHtmlEdit.PropertyNotKept, ["line"] = node.Line, ["column"] = node.Column, ["element"] = node.Tag, ["attribute"] = attribute,
                        ["from"] = ScreenDocument.ClipText(value), ["to"] = ScreenDocument.ClipText(text), ["note"] = message });
                else if (!reported.Contains((node.Line, node.Column)))
                    problems.Add(new(Anvil.Reading.ScreenHtmlEdit.PropertyNotKept, node.Line, node.Column, message,
                        property == "MarginTop" ? TopMarginFix(node, attribute, value) : $"the platform decides {property} here, or another property of the element changed it: leave {attribute} out, or write what {kind} takes"));
            }
        }

        // The exact way out of a top margin that does not survive the compile of a new widget, in each form the element has: no style (the
        // attribute is replaced), a style of text (added to it: a second style= is a duplicate attribute), a style with an expression
        // (added to its text), a length no style can say (3 col).
        private static string TopMarginFix(ScreenHtml.Node node, string attribute, string value)
        {
            var length = System.Text.RegularExpressions.Regex.Match(value.Trim(), @"^(\d+(?:\.\d+)?)\s*(px|%)?$");
            if (!length.Success) return $"remove {attribute}=\"{value}\": a style has no such length; write the top margin you mean as margin-top in style=";
            var margin = "margin-top:" + length.Groups[1].Value + (length.Groups[2].Success ? length.Groups[2].Value : "px");
            if ((node.Get("style") ?? node.Get("ext:style")) is not { Length: > 0 } style) return $"replace {attribute}=\"{value}\" with style=\"{margin}\"";
            return ScreenHtml.HoldsBraces(style) ? $"remove {attribute}=\"{value}\" and add {margin} to the text of the style this element has, style=\"{style}\""
                : $"remove {attribute}=\"{value}\" and add {margin} to the style this element has: style=\"{style.TrimEnd().TrimEnd(';')};{margin}\"";
        }

        // The same fact: a boolean or a member of an enumeration in any case, a number by its value, a text with any line ending.
        private static bool SameFact(string now, string declared)
        {
            if (string.Equals(now.ReplaceLineEndings("\n"), declared.ReplaceLineEndings("\n"), StringComparison.Ordinal)) return true;
            if (string.Equals(now, declared, StringComparison.OrdinalIgnoreCase) && now.All(c => char.IsLetterOrDigit(c) || c == '_')) return true;
            return decimal.TryParse(now, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var a) && decimal.TryParse(declared, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var b) && a == b;
        }

        // Whether a widget is a Popup or sits inside one (up to the root): its events default to the Popup's Transition.
        private bool InPopup(IObjectSignature element)
        {
            for (var o = element; o != null && !ReferenceEquals(o, root); o = o.Parent as IObjectSignature)
                if (Is(o, "IPopup")) return true;
            return false;
        }

        // C-02: whether a widget is a Button or a Link with a Form among its ancestors (up to the root): its click validates the
        // Form by default (ScreenDefaults.FormDefault), as the Studio creates it there.
        private bool InForm(IObjectSignature element, string kind)
        {
            if (!ScreenDefaults.ValidatesInForm(kind)) return false;
            for (var o = element.Parent as IObjectSignature; o != null && !ReferenceEquals(o, root); o = o.Parent as IObjectSignature)
                if (Is(o, "IForm")) return true;
            return false;
        }

        // The CSS of a screen's or block's own style sheet ("" without one).
        private static string SheetOf(object element) => ApiValue(element, "StyleSheet") switch { string text => text, IExpression e => e.Text ?? "", _ => "" };

        // A property as the Model API answers it (the interface's, not the concrete class's: a style sheet is its CSS text there).
        private static object? ApiValue(object element, string property) => FindProperty(element, property) is { } pi ? SafeGet(pi, element) : null;

        /// <summary>C-05 (F-FigmaMobile-02, F-FigmaReactive-02): the @import statements of the document's &lt;style scope="theme"&gt;
        /// blocks when the module's default theme has Theme Editor CSS. The platform serves such a theme as the Theme Editor's CSS
        /// (its :root{...} first) and then the author's (ThemeCss: generated + author, recomputed when it saves and publishes), so
        /// an @import in the author's half comes after rules and the browser ignores it: the fonts never loaded, silently, while
        /// the receipt said cssImportsHoisted. They are taken out of the theme's part and put first in the root's own style sheet,
        /// whose served CSS starts with them; each one is said in cssImportsMoved and normalized (CSS_IMPORT_MOVED), with where it
        /// now loads. A theme without Theme Editor CSS serves the author's half alone: its @import stay in the theme, at its top.
        /// Returns the statements moved, in order, each once.</summary>
        private List<string> ThemeImportsToOwnSheet()
        {
            var moved = new List<string>();
            if (!styles.Any(b => b.Theme && b.Css.Contains("@import", StringComparison.OrdinalIgnoreCase))) return moved;
            try
            {
                var defaultTheme = s._es.DefaultMobileTheme;
                var theme = defaultTheme == null ? null : s._es.MobileThemes.FirstOrDefault(t => t.ObjectKey?.ToString() == defaultTheme.ObjectKey?.ToString());
                // No theme of this module: InstallTheme refuses the theme's part (HTML_STYLE_UNPLACED) with every other problem.
                if (theme == null || ThemeCss.Of(theme) is not { } sheet || !ThemeCss.IsSplit(sheet)) return moved;
            }
            catch (Exception) { return moved; }
            var where = rootKind.EndsWith("Screen", StringComparison.Ordinal)
                ? $"the browser loads it with the screen {TypeResolver.Name(root)}"
                : $"the browser loads it on the pages that place the block {TypeResolver.Name(root)} (a block placed on no page loads nothing)";
            for (var i = 0; i < styles.Count; i++)
            {
                var block = styles[i];
                if (!block.Theme) continue;
                var (imports, rest) = CssCompat.Imports(block.Css);
                if (imports.Count == 0) continue;
                styles[i] = block with { Css = rest };
                foreach (var import in imports)
                {
                    if (moved.Contains(import.Statement, StringComparer.Ordinal)) continue;
                    moved.Add(import.Statement);
                    var note = new JsonObject
                    {
                        ["code"] = ScreenDocument.ImportMoved, ["line"] = block.Node.Line + import.Line - 1, ["column"] = block.Node.Column, ["element"] = "style",
                        ["from"] = import.Statement + " in <style scope=\"theme\">" + (block.Id != null ? " id=\"" + block.Id + "\"" : ""),
                        ["to"] = $"the first line(s) of the style sheet of {TypeResolver.Name(root)}",
                        ["note"] = "the module's theme has Theme Editor CSS, served first (its :root{...}): an @import after it is ignored by the browser; " + where,
                    };
                    importsMoved.Add(note.DeepClone());
                    normalized.Add(note);
                }
            }
            return moved;
        }

        // The root's own style sheet with the @import statements of the theme's part first (after an @charset), each once.
        private static string WithImportsFirst(string? sheet, IReadOnlyList<string> imports)
        {
            var own = sheet ?? "";
            var already = CssCompat.Imports(own).Imports.Select(x => x.Statement).ToHashSet(StringComparer.Ordinal);
            var head = string.Join("\n", imports.Where(x => !already.Contains(x)));
            if (head.Length == 0) return own;
            var body = own.TrimStart((char)0xFEFF);
            if (body.TrimStart().StartsWith("@charset", StringComparison.OrdinalIgnoreCase) && body.IndexOf(';') is var semi and > 0)
                return body[..(semi + 1)] + "\n" + head + "\n" + body[(semi + 1)..].TrimStart('\r', '\n');
            return head + (own.Length > 0 ? "\n" + own : "\n");
        }

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
                    // C-14: a named part records this root as its owner (the reading of the root prints it).
                    report["theme"] = s.InstallStylesheet(part.Key, part.Css, report, format: false, owner: part.Key.StartsWith("style:", StringComparison.Ordinal) ? key : null);
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

        // The text between the markers of a key in a theme's author CSS ("" without them), without the owner a named part records.
        private static string Block(string css, string key) => ThemeParts.Find(css, key)?.Css ?? "";

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
                    // Put back as it was: no stage removes a rule of the theme a refused document never changed.
                    if (iconThemeBefore.Sheet != null) ThemeCss.WriteAuthor(iconThemeBefore.Sheet, iconThemeBefore.Author, canvas: false, keepRules: true);
                    else if (iconTheme is OutSystems.Model.UI.ITheme widenedTheme) widenedTheme.StyleSheet = iconThemeBefore.Author;
                }
                catch (Exception) { /* the apply refuses anyway; the candidate is never saved */ }
                iconTheme = null; iconThemeBefore = null;
            }
            if (themeWritten == null || themeBefore == null) return;
            try
            {
                if (themeBefore.Sheet != null) ThemeCss.WriteAuthor(themeBefore.Sheet, themeBefore.Author, canvas: false, keepRules: true);
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
                ["blocks"] = styles.Count(b => !b.Theme), ["nested"] = styles.Count(b => b.Nested && !b.Theme), ["dataCss"] = Anvil.Reading.ScreenHtmlEdit.DataCss(options.Css) != null,
                ["chars"] = ownSheet?.Length ?? 0,
            };
            // R2-D: bytes before and after, the rules added and removed, and what the write said.
            foreach (var (key, value) in StyleSheetReport(sheetBefore, root == null ? ownSheet ?? "" : SheetOf(root), sheetSaid)) report[key] = value?.DeepClone();
            if (theme != null) report["theme"] = theme;
            if (importsMoved.Count > 0) report["cssImportsMoved"] = importsMoved.DeepClone();
            return report;
        }

        /// <summary>The classes the document uses that no rule defines where this page reads CSS: its own style sheet, the
        /// themes of the module and of its chain, OutSystems UI. Each with the element that uses it; where else the module writes it
        /// (another screen's or block's own style sheet, which that page alone loads); and a theme of another module whose CSS the
        /// capture has no copy of. Null when every class has its rule.</summary>
        internal JsonObject? ClassesWithoutRule()
        {
            if (root == null) return null;
            var top = document.Children.FirstOrDefault(c => !c.IsText && c.Tag is "screen" or "block");
            if (top == null) return null;
            var used = ScreenDocument.UsedClasses(top);
            if (used.Count == 0) return null;
            var defined = ScreenDocument.CssClasses(SheetOf(root));
            // C-17 (F-FigmaMobile-12: 16 classes of the BottomNav "without rule" that the same job writes in the theme): the parts
            // of the theme the documents of this job write (<style scope="theme">, a later op's too) are rules of the module.
            foreach (var css in JobThemeParts()) defined.UnionWith(ScreenDocument.CssClasses(css));
            string? themeElsewhere = null;
            try
            {
                var own = new HashSet<string>(s._es.MobileThemes.Select(t => t.ObjectKey?.ToString() ?? ""), StringComparer.Ordinal);
                foreach (var theme in s._es.MobileThemes) defined.UnionWith(ScreenDocument.CssClasses(ApiValue(theme, "StyleSheet") as string));
                // Goal list of 2026-10-20, item 12 (report 90a697c3: six screens warned of classes a producer theme
                // defines): the theme the page shows and every theme of the module are followed through BaseTheme; the first
                // one of another module (its CSS is not in this capture) is named, and the warning says the classes may be its.
                var shown = (root.Parent is IObjectSignature flow ? PrototypeBuilder.Prop(flow, "Theme") as IObjectSignature : null) ?? s._es.DefaultMobileTheme as IObjectSignature;
                // B4 (the proto line's 0abbad00): a theme of another module is read too, through the signature the capture keeps
                // (its StyleSheet is the producer's CSS at the reference's version, ThemeCss.Chain); only one with no readable CSS
                // is named, and the chain goes on through its BaseTheme.
                foreach (var start in new[] { shown }.Concat(s._es.MobileThemes.OfType<IObjectSignature>()))
                    foreach (var link in ThemeCss.Chain(start))
                    {
                        if (own.Contains(link.Theme.ObjectKey?.ToString() ?? "")) continue;
                        // The theme of OutSystems UI is the base of every theme and its classes are the allowlist already
                        // (OutSystemsUiClass): only another producer's theme may hold the rules this capture cannot read.
                        if (link.Producer is "OutSystemsUI" or "OutSystemsUIWeb") continue;
                        if (link.Css != null) defined.UnionWith(ScreenDocument.CssClasses(link.Css));
                        else themeElsewhere ??= (link.Producer != null ? link.Producer + "." : "") + link.Name;
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

        // C-17, C-12: the CSS of every <style scope="theme"> of the html documents of this job (the parts of the theme they write,
        // whatever the order of the ops): rules of the module for the classes without a rule and for the layout of a List.
        private List<string>? jobThemeParts;
        private IEnumerable<string> JobThemeParts()
        {
            if (jobThemeParts != null) return jobThemeParts;
            jobThemeParts = [];
            foreach (var op in (s._applyOps ?? []).OfType<JsonObject>())
            {
                if (op["op"]?.ToString() != "html" || op["data"]?["html"] is not JsonValue value || !value.TryGetValue<string>(out var html) || !html.Contains("scope", StringComparison.Ordinal)) continue;
                ScreenHtml.Node parsed;
                try { parsed = ScreenHtml.Parse(html); } catch (FormatException) { continue; }
                foreach (var (node, _) in ScreenHtmlText.Elements(parsed))
                    if (Anvil.Reading.ScreenHtmlEdit.IsThemeStyle(node)) jobThemeParts.Add(string.Concat(node.Children.Select(c => c.Text)));
            }
            return jobThemeParts;
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
