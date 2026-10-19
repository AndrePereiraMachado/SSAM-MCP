using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core;

/// <summary>
/// What a document says is what the page holds (the owner's report of 2026-10-12, FolhaPonto_UI: a delivered screen without its
/// styles, "Hoje · {{ ... }}" as literal text). The module-free half: where every &lt;style&gt; of a document goes (the
/// screen's or block's own style sheet, wherever the element is; the theme only when it says scope="theme"), the CSS the
/// OutSystems theme does not render (CssCompat, as data.css and set StyleSheet), the bindings of the text that are not
/// bindings (a {{ that never closes, a }} with no {{, {{ }} with no expression), the classes a document uses and the classes
/// a stylesheet defines. What cannot be placed is refused with the checked patch (the CSS moved to data.css). The compile
/// (ModelSession.DocumentCompiler) runs the same checks and then checks the model it wrote, in the same apply.
/// </summary>
public static partial class ScreenDocument
{
    public const string StyleUnplaced = "HTML_STYLE_UNPLACED";
    public const string StyleDropped = "HTML_STYLE_DROPPED";
    public const string BindingInvalid = "HTML_BINDING_INVALID";
    public const string BindingLeft = "HTML_BINDING_LEFT";
    public const string ExpressionEmpty = "HTML_EXPRESSION_EMPTY";
    public const string ClassNoRule = "HTML_CLASS_NO_RULE";
    public const string BindingLiteral = "HTML_BINDING_LITERAL";

    /// <summary>One &lt;style&gt; of a document and where its CSS goes: the root's own style sheet (in the order of the
    /// document, wherever the element is: a style element applies to the whole page), or the theme (scope="theme").</summary>
    internal sealed record StyleBlock(ScreenHtml.Node Node, string Css, bool Theme, bool Nested, string? Id);

    // What a <style> may say beside its CSS and still be placed as it is.
    private static bool Harmless(string attribute, string value) =>
        attribute is "id" or "nonce" || attribute == "type" && value.Trim().Equals("text/css", StringComparison.OrdinalIgnoreCase);

    /// <summary>The &lt;style&gt; elements of the document that can be placed, in the order of the document (the ones that
    /// cannot are FidelityProblems).</summary>
    internal static List<StyleBlock> Styles(ScreenHtml.Node top)
    {
        var blocks = new List<StyleBlock>();
        foreach (var (node, nested) in StyleElements(top))
        {
            if (Placement(node, top.Tag) is not { } theme) continue;
            blocks.Add(new(node, string.Concat(node.Children.Select(c => c.Text)), theme, nested, node.Get("id")));
        }
        return blocks;
    }

    // Every <style> under the root, in document order, and whether it is nested (not a child of the root).
    private static IEnumerable<(ScreenHtml.Node Node, bool Nested)> StyleElements(ScreenHtml.Node top)
    {
        IEnumerable<(ScreenHtml.Node, bool)> Walk(ScreenHtml.Node node, bool nested)
        {
            foreach (var child in node.Children)
            {
                if (child.IsText) continue;
                if (child.Tag == "style") { yield return (child, nested); continue; }
                if (child.Tag is "os-opaque" or "text") continue;
                foreach (var inner in Walk(child, true)) yield return inner;
            }
        }
        return Walk(top, false);
    }

    // Where a <style> goes: false its root's sheet, true the theme, null when it cannot be placed as written.
    private static bool? Placement(ScreenHtml.Node style, string rootTag)
    {
        bool? theme = false;
        foreach (var (name, value) in style.Attributes)
        {
            if (Harmless(name, value)) continue;
            if (name == "scope" && value.Trim().Equals("theme", StringComparison.OrdinalIgnoreCase)) { theme = true; continue; }
            if (name == "scope" && value.Trim().Equals(rootTag, StringComparison.OrdinalIgnoreCase)) continue;
            return null;
        }
        return theme;
    }

    /// <summary>The module-free checks of what the page will show: every &lt;style&gt; placed (else refused, with the patch
    /// that moves its CSS to data.css when its meaning is certain), the CSS the theme does not render (with the rendered
    /// stylesheet as the patch), and every binding of the text and of a class that is not one. <paramref name="read"/>: an
    /// element of the reading the document is based on (what it already has is kept: an empty expression); null reads k.</summary>
    internal static List<Problem> FidelityProblems(ScreenHtml.Node top, string? css, Func<ScreenHtml.Node, bool>? read)
    {
        read ??= node => node.Get("k") != null;
        var problems = new List<Problem>();
        foreach (var (style, _) in StyleElements(top))
        {
            var text = string.Concat(style.Children.Select(c => c.Text));
            if (Placement(style, top.Tag) is { } theme)
            {
                if (theme && style.Get("id") is { } id && !Regex.IsMatch(id, @"\A[A-Za-z0-9_-]{1,64}\z"))
                    problems.Add(new(StyleUnplaced, style.Line, style.Column,
                        $"<style scope=\"theme\" id=\"{id}\">: a named theme part needs an id of 1 to 64 ASCII letters, digits, underscores or hyphens",
                        "write id=\"name\" using [A-Za-z0-9_-]{1,64}, or remove id to use the root's theme part"));
                if (CssProblem(text, style.Line, style.Column, $"<style{(theme ? " scope=\"theme\"" : "")}>", false) is { } compat) problems.Add(compat);
                continue;
            }
            var odd = style.Attributes.Where(a => !Harmless(a.Key, a.Value) && a.Key != "scope").ToList();
            var scope = style.Get("scope");
            var media = style.Get("media");
            // A media attribute is a @media block of the same CSS: certain, so the patch moves it to data.css written so.
            var onlyMedia = odd.Count == 1 && odd[0].Key == "media" && media!.Trim().Length > 0 && (scope == null || scope.Trim().Equals(top.Tag, StringComparison.OrdinalIgnoreCase));
            var said = string.Join(" ", style.Attributes.Select(a => a.Key + "=\"" + a.Value + "\""));
            var why = scope != null && !scope.Equals("theme", StringComparison.OrdinalIgnoreCase) && !scope.Equals(top.Tag, StringComparison.OrdinalIgnoreCase)
                ? $"scope=\"{scope}\" is not a place of the CSS (the {top.Tag}'s own style sheet, or scope=\"theme\")"
                : $"{string.Join(", ", odd.Select(a => a.Key))} on a <style> is not a property of a style sheet: the CSS cannot go to the {top.Tag}'s style sheet as written";
            problems.Add(onlyMedia
                ? new(StyleUnplaced, style.Line, style.Column, $"<style {said}>: {why}",
                    $"the patch moves the CSS to data.css as @media {media!.Trim()} {{ ... }} (data.css goes to the {top.Tag}'s style sheet after the <style> blocks)",
                    Correct: new MoveStyle($"@media {media!.Trim()} {{\n{text.Trim('\r', '\n')}\n}}"))
                : new(StyleUnplaced, style.Line, style.Column, $"<style {said}>: {why}",
                    $"write <style> (the {top.Tag}'s own style sheet) or <style scope=\"theme\"> (the module theme), or move the CSS to data.css; a media query is a @media block inside the CSS"));
        }
        if (!string.IsNullOrEmpty(css) && CssProblem(css, 1, 1, "data.css", true) is { } inCss) problems.Add(inCss);
        // The bindings of the text: one run per line, the reading's own rule (ScreenHtml.Run).
        foreach (var (element, _) in ScreenHtmlText.Elements(top))
        {
            if (element.Tag is "style" or "text" or "os-opaque") continue;
            var elementRead = read(element);
            foreach (var run in ScreenHtml.Runs(element))
            {
                var line = run.Text.Trim(' ', '\t');
                var value = ScreenHtml.Run(run.Text, out var expression, out var fault);
                if (fault != null)
                    problems.Add(new(BindingInvalid, run.Line, run.Column, $"the text \"{Clip(line)}\" in <{element.Tag}>: {fault}",
                        "a binding is {{ expression }} (text around it is joined: \"Hoje · {{ X }}\"); literal braces go in <text>...</text>"));
                else if (expression && value.Trim().Length == 0 && !elementRead)
                    problems.Add(new(ExpressionEmpty, run.Line, run.Column, $"{{{{ }}}} in <{element.Tag}> has no expression: the page would show an empty Expression",
                        "write the expression inside the braces, or remove them"));
            }
            if (element.Get("class") is { } classes && AttributeBindingProblem(element, "class", classes) is { } classProblem)
                problems.Add(classProblem);
            if (element.Tag == "expr" && !elementRead && (element.Get("value") ?? "").Trim().Length == 0)
                problems.Add(new(ExpressionEmpty, element.Line, element.Column, "<expr> has no value: the page would show an empty Expression",
                    "<expr value=\"<expression>\"/>, or {{ expression }} in the text"));
        }
        // Every other attribute the compile writes as text with its bindings joined (an extended property, ExtendedName: the
        // compile's own rule): a brace pair that is no binding there is in this refusal too, with everything else (the class
        // was checked above, on every element).
        foreach (var (element, reverse, skip, widget) in FactElements(top))
            foreach (var (attribute, value) in element.Attributes)
                if (attribute != "class" && !skip.Contains(attribute) && ExtendedName(attribute, reverse, widget) != null
                    && AttributeBindingProblem(element, attribute, value) is { } attributeProblem && !problems.Contains(attributeProblem))
                    problems.Add(attributeProblem);
        return problems;
    }

    // ---- attributes the compile writes as text -------------------------------------------------------------------------------

    /// <summary>The extended property an attribute writes, by the compile's rule (ModelSession.Facts): ext:&lt;name&gt; on any
    /// element; on a widget, also an attribute the table of its kind (<paramref name="reverse"/>) does not name that is no event
    /// (on...), argument (:), handler (@), HTML event (html:) or os- property. Null when the attribute writes something else.
    /// <paramref name="widget"/>: false for the root and the data elements, whose other attributes are their properties or a
    /// problem. The preflight checks the bindings of exactly these values (FidelityProblems), so one refusal has them all.</summary>
    internal static string? ExtendedName(string attribute, IReadOnlyDictionary<string, string> reverse, bool widget)
    {
        if (attribute.StartsWith(':') || attribute.StartsWith('@') || attribute.StartsWith("html:", StringComparison.Ordinal)) return null;
        if (attribute.StartsWith("os-on", StringComparison.Ordinal) && attribute.Contains('.')) return null;
        if (attribute.StartsWith("ext:", StringComparison.Ordinal)) return attribute[4..];
        if (reverse.ContainsKey(attribute) || attribute.StartsWith("os-", StringComparison.Ordinal) && attribute.Length > 3) return null;
        if (attribute.StartsWith("on", StringComparison.Ordinal) && attribute.Length > 2) return null;
        return widget ? attribute : null;
    }

    /// <summary>The problem of an attribute written as text with its bindings joined (ScreenHtml.Unsugar) whose brace pair is no
    /// binding ({{ that never closes, }} with no {{, {{ }}), or null. The preflight and the compile build the same one, so it is
    /// reported once.</summary>
    internal static Problem? AttributeBindingProblem(ScreenHtml.Node at, string attribute, string value) =>
        ScreenHtml.BindingFault(value) is not { } fault ? null
            : new(BindingInvalid, at.Line, at.Column, $"{attribute}=\"{Clip(value)}\" on <{at.Tag}>: {fault}",
                attribute == "class"
                    ? "class=\"a b\", class=\"{{ expression }}\" or class=\"a {{ expression }}\" (joined)"
                    : $"{attribute}=\"text\", {attribute}=\"{{{{ expression }}}}\" or {attribute}=\"text {{{{ expression }}}}\" (joined); literal braces go in <text>...</text>");

    /// <summary>A data element of a document (a variable, an input, an aggregate and its parts, an event, os-*): the compile writes
    /// it as data, not as a widget (ModelSession.Children).</summary>
    internal static bool DataElement(ScreenHtml.Node node) =>
        !node.IsText && (node.Tag is "var" or "aggregate" or "data-action" or "action" or "event" || node.Tag == "input" && node.Get("name") != null && node.Get("bind") == null
            || node.Tag.StartsWith("os-", StringComparison.Ordinal) && node.Tag != "os-opaque");

    /// <summary>The attributes a widget element spends on itself and are no property (its key, its name, its html flag, the else
    /// of an If, the tag of an HTML element or a list, the type of a checkbox): the compile skips them (ModelSession.Widget).</summary>
    internal static HashSet<string> WidgetSkip(ScreenHtml.Node node, string kind)
    {
        var skip = new HashSet<string>(StringComparer.Ordinal) { "k", ScreenHtmlTables.AttributeOf(kind, "Name", ScreenHtmlModuleMode.Widget, false), "html", "else" };
        if (node.Tag is "html-element" || node.Tag == "list" && kind == "List") skip.Add("tag");
        if (kind == "Checkbox") skip.Add("type");
        return skip;
    }

    private static readonly HashSet<string> RootSkip = new(StringComparer.Ordinal) { "name", "flow", "actions", "data-actions", "k" };
    private static readonly HashSet<string> DataSkip = new(StringComparer.Ordinal) { "k", "name" };
    private static readonly HashSet<string> SlotSkip = new(StringComparer.Ordinal) { "name" };

    /// <summary>Every element whose attributes the compile writes (ModelSession.Children, Widget, Slots, Data), in the order of the
    /// document: the attribute table of its kind, what it skips, and whether it is a widget. What the compile writes no attribute
    /// of (a &lt;style&gt;, a &lt;text&gt;, an os-opaque, a script, an action, the children of a text) is not here.</summary>
    internal static IEnumerable<(ScreenHtml.Node Node, IReadOnlyDictionary<string, string> Reverse, IReadOnlySet<string> Skip, bool Widget)> FactElements(ScreenHtml.Node top)
    {
        yield return (top, ScreenHtmlTables.Reverse(top.Tag == "screen" ? "MobileScreen" : "MobileBlock", ScreenHtmlModuleMode.Data), RootSkip, false);
        foreach (var fact in FactChildren(top)) yield return fact;
    }

    private static IEnumerable<(ScreenHtml.Node, IReadOnlyDictionary<string, string>, IReadOnlySet<string>, bool)> FactChildren(ScreenHtml.Node parent)
    {
        foreach (var node in parent.Children)
        {
            if (node.IsText || node.Tag == "text" && node.Get("k") == null) continue;
            if (node.Tag is "style" or "slot" or "os-opaque" or "script" or "foreach" or "for-each" or "for") continue;
            if (DataElement(node)) { foreach (var fact in FactData(node)) yield return fact; continue; }
            // The else of an If and the content of a widget: their children are compiled, they write no attribute.
            if (node.Tag == "content" || node.Tag == "div" && node.Attributes is [{ Key: "else" }]) { foreach (var fact in FactChildren(node)) yield return fact; continue; }
            var kind = ScreenHtmlTables.KindOf(node, out _);
            yield return (node, ScreenHtmlTables.Reverse(kind, ScreenHtmlModuleMode.Widget), WidgetSkip(node, kind), true);
            if (kind == "TextWidget") continue;
            // A native Table: its cells are its widgets (its thead, tbody and rows write no widget: ModelSession.Widget).
            if (kind == "TableRecords" && ScreenHtmlTables.NativeTable(node) is { } table)
            {
                foreach (var fact in FactChildren(table.HeadRow)) yield return fact;
                foreach (var fact in FactChildren(table.BodyRow)) yield return fact;
                continue;
            }
            if (kind == "MobileBlockInstanceWidget")
            {
                foreach (var slot in node.Children.Where(c => !c.IsText && c.Tag == "slot"))
                {
                    yield return (slot, ScreenHtmlTables.Reverse("PlaceholderContentWidget", ScreenHtmlModuleMode.Widget), SlotSkip, true);
                    foreach (var fact in FactChildren(slot)) yield return fact;
                }
                continue;
            }
            foreach (var fact in FactChildren(node)) yield return fact;
        }
    }

    private static IEnumerable<(ScreenHtml.Node, IReadOnlyDictionary<string, string>, IReadOnlySet<string>, bool)> FactData(ScreenHtml.Node node)
    {
        // An action is declared in a logic op (refused here); the parts the platform derives are never written.
        if (node.Tag is "action" or "data-action" or "os-AddSourceOperation" or "os-ImplicitParameter") yield break;
        // The short form of an aggregate: its parts come from from/join/where/sort (none is ext:); with children it is refused.
        if (node.Tag == "aggregate" && node.Get("from") != null)
        {
            if (!node.Children.Any(c => !c.IsText)) yield return (node, ScreenHtmlTables.Reverse("ScreenAggregate", ScreenHtmlModuleMode.Data), DataSkip, false);
            yield break;
        }
        // The table of every data element is the same one (ScreenHtmlTables.DataNamed).
        if (node.Tag != "os-CombineSourcesOperation") yield return (node, ScreenHtmlTables.Reverse("ScreenAggregate", ScreenHtmlModuleMode.Data), DataSkip, false);
        foreach (var child in node.Children.Where(c => !c.IsText))
            foreach (var fact in FactData(child)) yield return fact;
    }

    // The CSS the OutSystems theme does not render (A30: light-dark(), color-mix()), as data.css and set StyleSheet answer it:
    // one problem with what was found and, when every change is mechanical, the rendered stylesheet as the patch.
    private static Problem? CssProblem(string css, int line, int column, string where, bool inCss)
    {
        CssCompat.Result result;
        try { result = CssCompat.Rewrite(css); }
        catch (Exception) { return null; }
        if (result.Expanded == 0 && result.Problems.Count == 0) return null;
        var found = new List<string>();
        if (result.Expanded > 0) found.Add($"{result.Expanded} light-dark() value(s)");
        found.AddRange(result.Problems.Select(p => $"{p.Text} at line {p.Line} col {p.Column} of the CSS"));
        var fixes = new List<string>();
        if (result.Expanded > 0) fixes.Add("write the light value in the rule and the dark one in a @media (prefers-color-scheme: dark) block");
        fixes.AddRange(result.Problems.Select(p => p.Fix));
        Correction? correction = result.Mechanical == null ? null : inCss ? new RewriteDataCss(result.Mechanical) : new RewriteStyle(result.Mechanical);
        return new(CssCompat.Code, line, column, $"{where} carries CSS the OutSystems theme does not render: {string.Join("; ", found)}",
            string.Join("; ", fixes.Distinct()) + (correction != null ? "; the patch writes the rendered stylesheet" : ""), Correct: correction, InCss: inCss);
    }

    // ---- classes -----------------------------------------------------------------------------------------------------------

    /// <summary>The classes a document uses, each with the first element that uses it: the words of class (its literal parts and
    /// the string literals of its expressions, as Style holds them) and of a block's ExtendedClass.</summary>
    internal static List<(string Class, ScreenHtml.Node Node)> UsedClasses(ScreenHtml.Node top)
    {
        var used = new List<(string, ScreenHtml.Node)>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (element, _) in ScreenHtmlText.Elements(top))
        {
            foreach (var (name, value) in element.Attributes)
            {
                if (name is not ("class" or ":ExtendedClass" or "os-ExtendedClass")) continue;
                var expression = name == "class" ? ScreenHtml.Unsugar(value) : value;
                foreach (var word in ClassWords(expression))
                    if (seen.Add(word)) used.Add((word, element));
            }
        }
        return used;
    }

    // The words of the string literals of an expression that can be class names. A word the literal shares with what a + joins
    // to it ("bb-" + ToLower(Branch): the literal ends inside the class) is part of a name the page computes: not a class.
    private static IEnumerable<string> ClassWords(string expression)
    {
        foreach (Match literal in Regex.Matches(expression, "\"((?:[^\"]|\"\")*)\""))
        {
            var text = literal.Groups[1].Value.Replace("\"\"", "\"", StringComparison.Ordinal);
            var words = text.Split([' ', '\t', '\r', '\n'], StringSplitOptions.RemoveEmptyEntries).ToList();
            if (words.Count == 0) continue;
            var before = expression[..literal.Index].TrimEnd();
            var after = expression[(literal.Index + literal.Length)..].TrimStart();
            if (after.StartsWith('+') && !char.IsWhiteSpace(text[^1])) words.RemoveAt(words.Count - 1);
            if (words.Count > 0 && before.EndsWith('+') && !char.IsWhiteSpace(text[0])) words.RemoveAt(0);
            foreach (var word in words)
                if (!word.Contains('{') && !word.Contains('}') && !word.Contains('"')) yield return word;
        }
    }

    private static readonly Regex ClassSelector = new(@"\.((?:-?[_a-zA-Z -￿]|\\.)(?:[_a-zA-Z0-9 -￿-]|\\.)*)", RegexOptions.Compiled);

    /// <summary>The class names the selectors of a stylesheet name (comments, strings, url() and declarations left out; an
    /// escaped character, .md\:flex, as the class holds it).</summary>
    internal static HashSet<string> CssClasses(string? css)
    {
        var classes = new HashSet<string>(StringComparer.Ordinal);
        if (string.IsNullOrEmpty(css)) return classes;
        var text = Regex.Replace(css, @"/\*.*?\*/", " ", RegexOptions.Singleline);
        text = Regex.Replace(text, "\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'", "\"\"");
        text = Regex.Replace(text, @"url\([^)]*\)", "url()", RegexOptions.IgnoreCase);
        text = Regex.Replace(text, @"\{[^{}]*\}", "{}");
        foreach (Match m in ClassSelector.Matches(text)) classes.Add(Regex.Replace(m.Groups[1].Value, @"\\(.)", "$1"));
        return classes;
    }

    private static HashSet<string>? outSystemsUi;

    /// <summary>A class the OutSystems UI theme or the platform defines (OutSystems UI 2.28.1, the classes of its selectors;
    /// the icon font's fa and fa-*), so a page that uses it has its rule.</summary>
    internal static bool OutSystemsUiClass(string name)
    {
        if (name == "fa" || name.StartsWith("fa-", StringComparison.Ordinal)) return true;
        if (outSystemsUi == null)
        {
            var set = new HashSet<string>(StringComparer.Ordinal);
            using var stream = typeof(ScreenDocument).Assembly.GetManifestResourceStream("Anvil.Core.Kernel.OutSystemsUiClasses.txt");
            if (stream != null)
            {
                using var reader = new StreamReader(stream, Encoding.UTF8);
                for (var line = reader.ReadLine(); line != null; line = reader.ReadLine())
                    if (line.Length > 0 && line[0] != '#') set.Add(line.Trim());
            }
            outSystemsUi = set;
        }
        return outSystemsUi.Contains(name);
    }

    /// <summary>The CSS of the root's own style sheet: its &lt;style&gt; blocks without scope="theme" in document order, then
    /// data.css, each as written (one block alone is exactly its text, the reading's &lt;style&gt;); null when there is none.</summary>
    internal static string? OwnSheet(IReadOnlyList<StyleBlock> blocks, string? css)
    {
        var parts = blocks.Where(b => !b.Theme).Select(b => b.Css).ToList();
        if (!string.IsNullOrEmpty(css)) parts.Add(css);
        parts = parts.Where(p => p.Length > 0).ToList();
        if (parts.Count == 0) return null;
        if (parts.Count == 1) return parts[0];
        var sb = new StringBuilder();
        foreach (var part in parts)
        {
            if (sb.Length > 0 && sb[^1] != '\n') sb.Append('\n');
            sb.Append(part);
        }
        return sb.ToString();
    }

    /// <summary>The CSS of the theme block of the document (its &lt;style scope="theme"&gt; blocks, in order), null when none.</summary>
    internal static string? ThemeSheet(IReadOnlyList<StyleBlock> blocks)
    {
        var parts = blocks.Where(b => b.Theme && b.Css.Trim().Length > 0).Select(b => b.Css.Trim('\r', '\n')).ToList();
        return parts.Count == 0 ? null : string.Join("\n", parts);
    }

    /// <summary>Named parts are shared by all documents; unnamed blocks retain their root's part. Repeated ids join in
    /// document order and the parts themselves retain their first appearance.</summary>
    internal static List<(string Key, string Css)> ThemeParts(IReadOnlyList<StyleBlock> blocks, string rootKey)
    {
        var parts = new List<(string Key, string Css)>();
        foreach (var block in blocks.Where(b => b.Theme && (b.Id != null || b.Css.Trim().Length > 0)))
        {
            var key = block.Id == null ? rootKey : "style:" + block.Id;
            var css = block.Css.Trim('\r', '\n');
            var index = parts.FindIndex(p => p.Key == key);
            if (index < 0) parts.Add((key, css));
            else parts[index] = (key, parts[index].Css + "\n" + css);
        }
        return parts;
    }

    internal static string ClipText(string text) => Clip(text);
}
