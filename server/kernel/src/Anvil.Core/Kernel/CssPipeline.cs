using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// T18: the one pipeline of every stylesheet SSAM writes, on both lanes. Two halves, both pure (no model, no I/O):
/// <list type="bullet">
/// <item><see cref="Normalize"/>: what every write of a theme, screen or block stylesheet passes through before it lands
/// (ThemeCss.Settle). The owner's rule: a normalization never changes what the CSS selects nor the order of the cascade; it
/// changes bytes only where the meaning is provably the same, and otherwise leaves the text and at most warns. So it does two
/// things, each reported: an @import written after a rule (which the browser ignores) goes up to the place the browser reads it,
/// keeping the order of every import, and never across an @layer (<see cref="TopImports"/>); and, only when the caller asks
/// (a theme with Theme Editor CSS of a reactive module, where the platform's own composition did it before), a selector
/// <c>#reactContainer X</c> with a descendant combinator also selects in the Studio canvas. Then every registered stage.</item>
/// <item><see cref="Lint"/>: the hygiene findings of one CSS text, one per offender, the same verdict whatever path carries it.
/// <see cref="Introduced"/> tells the offenders a write brings from the ones the element already had: an existing offender
/// is never an error.</item>
/// </list>
/// The extension point (<see cref="Register"/>) is where T5 (CSS against the predicted runtime DOM) and T10 (the Traditional
/// vocabulary translated) add their stages: a stage that throws is skipped, never a failed write.
/// </summary>
public static class CssPipeline
{
    /// <summary>Where a CSS text is written: a short label of the path (for messages) and its owner kind.</summary>
    public sealed record Context(string Path, string Owner = "");

    /// <summary>One offender: the line of the text it was found in (1-based), the offender itself (<see cref="Subject"/>: the url,
    /// the selector, the property; what tells two offenders apart, never their place) and, when the fix is mechanical,
    /// <see cref="Replacement"/> (the whole text fixed).</summary>
    public sealed record Finding(string Code, string Severity, int Line, string Subject, string Message, string Fix)
    {
        public string? Replacement { get; init; }
        /// <summary>The offender's own fix, applied alone (the url without its host): merged with the others of a text.</summary>
        public (string Find, string With)? Edit { get; init; }
    }

    /// <summary>What a normalization did: the text and each change.</summary>
    public sealed record Outcome(string Css, IReadOnlyList<CssCompat.Import> ImportsHoisted, int ImportsMerged, IReadOnlyList<CssCompat.SelectorRewrite> CanvasRewrites, IReadOnlyList<JsonObject> StageChanges)
    {
        public bool Changed { get; init; }
        /// <summary>Why an @import after a rule stayed where it is (an @layer in the sheet: moving it would reorder the layers).</summary>
        public string? ImportsKept { get; init; }
    }

    /// <summary>A stage of the normalization: the new text (null: unchanged); it may add {stage, ...} entries to the changes.</summary>
    public delegate string? Normalizer(string css, Context context, List<JsonObject> changes);
    /// <summary>A stage of the lint: findings of the text (one per offender).</summary>
    public delegate IEnumerable<Finding> Linter(string css, Context context);

    private static readonly object Gate = new();
    private static List<(string Name, Normalizer? Normalize, Linter? Lint)> _stages = [];

    /// <summary>The extension point: a named stage (registering the same name again replaces it).</summary>
    public static void Register(string name, Normalizer? normalize = null, Linter? lint = null)
    {
        lock (Gate) _stages = _stages.Where(s => s.Name != name).Append((name, normalize, lint)).ToList();
    }

    /// <summary>Removes a registered stage (tests).</summary>
    public static void Unregister(string name) { lock (Gate) _stages = _stages.Where(s => s.Name != name).ToList(); }

    public static IReadOnlyList<string> Stages => _stages.Select(s => s.Name).ToList();

    // ---- normalization ------------------------------------------------------------------------------------------------

    /// <summary>The one normalization. <paramref name="canvas"/>: the caller writes the author half of a theme with Theme Editor
    /// CSS of a reactive module (the only place the platform's composition rewrote #reactContainer before); never a Traditional
    /// sheet, a screen or block of its own, a native-widget install or a verbatim write.</summary>
    public static Outcome Normalize(string css, Context context, bool canvas = false)
    {
        css ??= "";
        var (text, hoisted, merged, kept) = TopImports(css);
        IReadOnlyList<CssCompat.SelectorRewrite> rewrites = [];
        if (canvas) (text, rewrites) = CssCompat.CanvasSelectors(text, descendantOnly: true);
        var changes = new List<JsonObject>();
        foreach (var (name, normalize, _) in _stages)
        {
            if (normalize == null) continue;
            // A stage that fails is said by name only: its exception text is not the user's business.
            try { if (normalize(text, context, changes) is { } next) text = next; }
            catch (Exception) { changes.Add(new JsonObject { ["stage"] = name, ["skipped"] = true }); }
        }
        return new Outcome(text, hoisted, merged, rewrites, changes) { Changed = text != css, ImportsKept = kept };
    }

    /// <summary>The @import statements where the browser reads them. Only when one comes after a rule (the browser ignores it,
    /// so moving it up restores what the author wrote) or the same statement is written twice: every import keeps its order
    /// relative to the others, and of two identical ones the LAST stays (its rules, applied last, are the ones that won). Never in
    /// a sheet with @layer (an import before or after a layer statement orders the layers) and never a duplicate with layer():
    /// those stay as written, and <c>Kept</c> says why. The text itself when nothing moves.</summary>
    public static (string Css, IReadOnlyList<CssCompat.Import> Hoisted, int Merged, string? Kept) TopImports(string css)
    {
        var (imports, rest) = CssCompat.Imports(css);
        if (imports.Count == 0) return (css, [], 0, null);
        var after = imports.Where(x => x.AfterRule).ToList();
        var statements = imports.Select(x => x.Statement).ToList();
        var layered = Regex.IsMatch(Uncommented(css), @"@layer\b|\blayer\s*(\(|;|$)", RegexOptions.IgnoreCase);
        var last = layered ? statements : statements.Where((s, k) => statements.LastIndexOf(s) == k).ToList();
        if (after.Count == 0 && last.Count == statements.Count) return (css, [], 0, null);
        if (layered)
            return (css, [], 0, after.Count > 0 ? $"{after.Count} @import after a rule stay where they are: the sheet has @layer, and moving an import would reorder the layers" : null);
        var body = rest.TrimStart().TrimStart('﻿').TrimStart();
        var charset = "";
        if (body.StartsWith("@charset", StringComparison.OrdinalIgnoreCase) && body.IndexOf(';') is var semi and > 0)
        { charset = body[..(semi + 1)] + "\n"; body = body[(semi + 1)..].TrimStart(); }
        return (charset + string.Join("\n", last) + "\n" + body, after, statements.Count - last.Count, null);
    }

    // ---- hygiene lints ------------------------------------------------------------------------------------------------

    public const string EnvUrl = "CSS_ENV_URL";
    public const string GeneratedIdSelector = "CSS_GENERATED_ID_SELECTOR";
    public const string ImportantFlood = "CSS_IMPORTANT_FLOOD";
    public const string DisplayContents = "CSS_DISPLAY_CONTENTS";
    public const string DeadSelector = "CSS_DEAD_SELECTOR";
    public const string DuplicateRule = "CSS_DUPLICATE_RULE";
    public const string VarRedefined = "CSS_VAR_REDEFINED";

    /// <summary>Every code of <see cref="Lint"/> with its severity. The only error: an absolute url to an OutSystems environment
    /// host, and only when the write brings it (<see cref="Introduced"/>); every other code is a warning.</summary>
    public static readonly IReadOnlyDictionary<string, string> Codes = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [EnvUrl] = "error", [GeneratedIdSelector] = "warning", [ImportantFlood] = "warning", [DisplayContents] = "warning",
        [DeadSelector] = "warning", [DuplicateRule] = "warning", [VarRedefined] = "warning",
    };

    /// <summary>The !important declarations from which a stylesheet is a flood (with no global rule among them).</summary>
    public const int ImportantFloodAt = 25;

    // An OutSystems environment host: a url there ties the stylesheet to one environment (the module is deployed to others).
    private static readonly Regex OutSystemsHost = new(@"(^|\.)(outsystemscloud\.com|outsystems\.app|outsystems\.dev|outsystems\.net|outsystemsenterprise\.com)$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex UrlPattern = new(@"url\(\s*(?<q>['""]?)(?<u>[^'"")\s]+)\k<q>\s*\)|@import\s+(?<q2>['""])(?<u2>[^'""]+)\k<q2>", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    // The names the Studio gives a widget it names itself (kind + number). A developer may keep such a name on purpose, so a
    // selector on one is a warning: the name changes when the Studio renames the widget (a copy, a new widget before it).
    private static readonly Regex GeneratedName = new(@"^(Div|Container|Text|Label|Link|Button|ButtonGroup|Icon|Image|Span|Expression|Input|TextArea|Dropdown|Checkbox|Switch|RadioButton|RadioGroup|List|ListItem|Block|Column|Columns|Row|Cell|Table|TableRecords|Form|Upload|Html|HtmlElement|Paragraph|Heading|Title|Placeholder|If|ListRecords|EditRecord|Popup|Tab|Tabs|Card|Section|Wrapper|Content|Spacer|Separator|Badge|Tag|Alert|Tooltip|DatePicker|Search|Wizard|Accordion|AccordionItem|Carousel|Gallery|Sidebar|Pagination|Counter|ProgressBar|Rating|FloatingActions|Submenu|Notification|BlankSlate|DropdownSearch|DropdownTags)\d+$", RegexOptions.Compiled);
    private static readonly Regex IdAttribute = new(@"\[\s*id\s*(?<op>[$*^~|]?=)\s*(?<q>['""]?)(?<v>[^'""\]\s]+)\k<q>\s*(i\s*)?\]", RegexOptions.Compiled);
    private static readonly Regex IdHash = new(@"#(?<v>-?[A-Za-z_][A-Za-z0-9_-]*)", RegexOptions.Compiled);
    // The runtime structure a display:contents erases: the wrappers the runtime renders and the layout/pattern classes of
    // OutSystems UI (their box carries the layout, the gutter and the role).
    private static readonly HashSet<string> StructuralClasses = new(StringComparer.Ordinal)
    {
        "layout", "main", "main-content", "content", "content-middle", "content-top", "content-bottom", "header", "header-top", "header-content",
        "footer", "app-menu-content", "app-menu-links", "app-login-info", "application-name", "menu", "columns", "columns-item", "card", "list", "table",
        "OSBlockWidget", "OSInline", "OSFillParent", "ThemeGrid_Wrapper", "ThemeGrid_Container", "MainContent", "Header", "Footer",
    };
    private static readonly HashSet<string> StructuralTags = new(StringComparer.Ordinal) { "div", "span", "section", "main", "header", "footer", "nav", "form" };

    /// <summary>The hygiene findings of one CSS text, one per offender (the same for every path that carries it), then the
    /// registered stages'. <paramref name="idHashes"/> false: a #id selector is not judged here (the html op refuses every #id
    /// selector itself, the most specific finding). A text the lenient parser cannot read gives the url findings only.</summary>
    public static List<Finding> Lint(string css, Context context, bool idHashes = true)
    {
        var findings = new List<Finding>();
        if (string.IsNullOrWhiteSpace(css)) return findings;
        findings.AddRange(Urls(css));
        CssStylesheet? sheet = null;
        try { sheet = CssStylesheet.Parse(css, lenient: true); } catch (InvalidOperationException) { }
        if (sheet != null)
        {
            findings.AddRange(GeneratedIds(sheet, idHashes));
            findings.AddRange(Important(sheet));
            findings.AddRange(Contents(sheet));
            findings.AddRange(DeadAndDuplicate(sheet));
            findings.AddRange(Redefined(sheet));
        }
        foreach (var (_, _, lint) in _stages)
        {
            if (lint == null) continue;
            try { findings.AddRange(lint(css, context)); }
            catch (Exception) { /* a stage that throws says nothing; the write never fails for it */ }
        }
        return findings;
    }

    /// <summary>The offenders of <paramref name="after"/> that <paramref name="before"/> did not have (by code and offender, as
    /// many times as they are new): what a write brings. Only these can be errors.</summary>
    public static List<Finding> Introduced(IEnumerable<Finding> before, IEnumerable<Finding> after)
    {
        var left = before.GroupBy(Key).ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
        var added = new List<Finding>();
        foreach (var f in after)
        {
            if (left.TryGetValue(Key(f), out var n) && n > 0) { left[Key(f)] = n - 1; continue; }
            added.Add(f);
        }
        return added;
    }

    /// <summary>The offenders a write of <paramref name="after"/> over <paramref name="before"/> brings.</summary>
    public static List<Finding> Introduced(string before, string after, Context context, bool idHashes = true) =>
        Introduced(Lint(before ?? "", context, idHashes), Lint(after ?? "", context, idHashes));

    private static string Key(Finding f) => f.Code + "\u0001" + f.Subject;

    /// <summary>The findings of one code as one sentence: how many offenders and the first ones with their lines.</summary>
    public static string Summary(string code, IReadOnlyList<Finding> offenders, int lineOffset = 0)
    {
        var first = offenders.Take(4).Select(f => $"line {f.Line + lineOffset}: {Clip(f.Subject, 90)}");
        var what = code switch
        {
            EnvUrl => "url(s) to an OutSystems environment host: the stylesheet then loads them from that environment wherever the module is deployed",
            GeneratedIdSelector => "selector(s) on a widget name of the form the Studio generates (Div14, Container5): the rule follows that name, and the Studio changes it when the widget is copied or renamed",
            ImportantFlood => "!important override(s) on a global selector or in a flood: !important beats every rule of OutSystems UI, of the widgets and of later fixes",
            DisplayContents => "display:contents on a structural wrapper: its box goes, with its padding, gap, background, events and role, and the layout of OutSystems UI reads that box",
            DeadSelector => "rule(s) that style nothing",
            DuplicateRule => "selector(s) written in more than one rule: the later rule wins property by property, so contradictory values accumulate",
            VarRedefined => "custom propert(ies) defined in :root with different values: only the last definition counts",
            _ => "finding(s)",
        };
        return $"{offenders.Count} {what} ({string.Join("; ", first)}{(offenders.Count > 4 ? "; ..." : "")})";
    }

    private static IEnumerable<Finding> Urls(string css)
    {
        foreach (Match m in UrlPattern.Matches(Uncommented(css)))
        {
            var url = m.Groups["u"].Success && m.Groups["u"].Length > 0 ? m.Groups["u"].Value : m.Groups["u2"].Value;
            if (!Uri.TryCreate(url.StartsWith("//", StringComparison.Ordinal) ? "https:" + url : url, UriKind.Absolute, out var uri)
                || uri.Scheme is not ("http" or "https") || !OutSystemsHost.IsMatch(uri.Host)) continue;
            // A path of the module itself (/<Module>/...) is never flagged; only the host goes.
            var relative = uri.PathAndQuery + uri.Fragment;
            yield return new Finding(EnvUrl, "error", LineAt(css, m.Index), url,
                $"url {Clip(url, 100)} names the OutSystems environment host {uri.Host}: the stylesheet loads it from that environment wherever the module is deployed",
                $"write it without the host: url(\"{relative}\") resolves in the environment the app runs in (the patch); for another module's file, add it as a resource of this module")
            { Edit = (url, relative) };
        }
    }

    /// <summary>The text with every url of the findings written without its host (each offender's own edit).</summary>
    public static string WithoutHosts(string css, IEnumerable<Finding> findings)
    {
        foreach (var (find, with) in findings.Where(f => f.Code == EnvUrl && f.Edit != null).Select(f => f.Edit!.Value).Distinct())
            css = css.Replace(find, with, StringComparison.Ordinal);
        return css;
    }

    private static IEnumerable<Finding> GeneratedIds(CssStylesheet sheet, bool idHashes)
    {
        foreach (var rule in sheet.Rules)
        {
            var names = IdAttribute.Matches(rule.Selector).Select(m => m.Groups["v"].Value)
                .Concat(idHashes ? IdHash.Matches(WithoutStringsAndAttributes(rule.Selector)).Select(m => m.Groups["v"].Value) : []);
            foreach (var name in names.Select(Generated).OfType<string>().Distinct())
                yield return new Finding(GeneratedIdSelector, "warning", rule.Line, Normal(rule.Selector),
                    $"{Clip(rule.Selector, 90)} selects by the widget name {name}, of the form the Studio generates: if it is not a name the developer keeps, the rule follows the Studio's renames",
                    "give the widget a style class (Style Classes, or class= in its html) and select that class; keep the name if it is the developer's own");
        }
    }

    // The widget name an id value ends with, when it has the form the Studio generates (Div14, b3-Container5, $b3-Text2).
    private static string? Generated(string id)
    {
        var name = id.TrimStart('$');
        var dash = name.LastIndexOf('-');
        if (dash >= 0) name = name[(dash + 1)..];
        return name != CssStylesheet.ReactContainer && GeneratedName.IsMatch(name) ? name : null;
    }

    private static IEnumerable<Finding> Important(CssStylesheet sheet)
    {
        var count = 0;
        foreach (var rule in sheet.Rules)
        {
            var important = rule.Declarations.Count(d => d.Important);
            if (important == 0) continue;
            count += important;
            // A rule none of whose selectors names a class or an id: it wins over every rule of OutSystems UI and of the widgets.
            if (CssStylesheet.SplitSelectors(rule.Selector).All(s => !CssStylesheet.Classes(s).Any() && !CssStylesheet.Ids(s).Any()))
                yield return new Finding(ImportantFlood, "warning", rule.Line, Normal(rule.Selector),
                    $"{Clip(rule.Selector, 80)} sets !important on a global selector: it wins over every rule of OutSystems UI and of the widgets",
                    "scope the rule to the class of the element it is for, with the specificity it needs, instead of !important");
        }
        if (count >= ImportantFloodAt)
            yield return new Finding(ImportantFlood, "warning", sheet.Rules.First(r => r.Declarations.Any(d => d.Important)).Line, "!important flood",
                $"{count} !important declarations: each override then needs another one",
                "give the rules the specificity they need (a class of the screen or block) instead of !important");
    }

    private static IEnumerable<Finding> Contents(CssStylesheet sheet)
    {
        foreach (var rule in sheet.Rules)
        {
            if (!rule.Declarations.Any(d => d.Property.Equals("display", StringComparison.OrdinalIgnoreCase) && d.Value.Trim().StartsWith("contents", StringComparison.OrdinalIgnoreCase))) continue;
            foreach (var selector in CssStylesheet.SplitSelectors(rule.Selector).Where(Structural))
                yield return new Finding(DisplayContents, "warning", rule.Line, Normal(selector),
                    $"display:contents on {Clip(selector, 80)}: the box of a runtime wrapper or of an OutSystems UI layout element goes, with its padding, gap, background, events and role",
                    "lay out the wrapper itself (display:flex or grid on its own class) or style its children; keep display:contents off the runtime's wrappers");
        }
    }

    // The subject compound of a selector names a runtime wrapper (data-block, data-container, data-list, an id), a bare
    // structural tag, or a layout or pattern class of OutSystems UI.
    private static bool Structural(string selector)
    {
        var subject = Subject(selector);
        if (subject.Contains("[data-block", StringComparison.Ordinal) || subject.Contains("[data-container", StringComparison.Ordinal)
            || subject.Contains("[data-list", StringComparison.Ordinal) || subject.Contains("[id", StringComparison.Ordinal) || subject.StartsWith('#')) return true;
        var classes = CssStylesheet.Classes(subject).ToList();
        if (classes.Any(StructuralClasses.Contains)) return true;
        var tag = Regex.Match(subject, @"^[a-zA-Z][a-zA-Z0-9]*").Value.ToLowerInvariant();
        return classes.Count == 0 && StructuralTags.Contains(tag);
    }

    private static string Subject(string selector)
    {
        var text = WithoutStringsAndAttributes(selector, keepAttributes: true).Trim();
        var depth = 0; var start = 0;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (c is '(' or '[') depth++;
            else if (c is ')' or ']') depth--;
            else if (depth == 0 && (c is '>' or '+' or '~' || char.IsWhiteSpace(c))) start = i + 1;
        }
        return text[start..].Trim();
    }

    private static IEnumerable<Finding> DeadAndDuplicate(CssStylesheet sheet)
    {
        foreach (var rule in sheet.Rules)
        {
            if (rule.Declarations.Count == 0)
                yield return new Finding(DeadSelector, "warning", rule.Line, Normal(rule.Selector) + " {}", $"{Clip(rule.Selector, 70)} has no declarations", "remove the rule (the css op: {\"deleteRule\":\"<selector>\"})");
            var list = CssStylesheet.SplitSelectors(rule.Selector).ToList();
            if (list.Count > 1 && list.Any(s => Regex.IsMatch(s, @"::?-(webkit|moz|ms|o)-")))
                yield return new Finding(DeadSelector, "warning", rule.Line, Normal(rule.Selector) + " vendor",
                    $"{Clip(rule.Selector, 70)} lists a vendor-prefixed pseudo with other selectors: an engine that does not know it drops the whole rule",
                    "write the vendor pseudo in a rule of its own");
        }
        foreach (var group in sheet.Rules.GroupBy(r => string.Join(" ", r.EnclosingRules.Select(Collapse)) + "\u0001" + Normal(r.Selector)).Where(g => g.Count() > 1))
        {
            var rules = group.ToList();
            var overridden = new List<string>();
            for (var k = 0; k < rules.Count - 1; k++)
            {
                var later = rules.Skip(k + 1).SelectMany(r => r.Declarations).ToList();
                var lost = rules[k].Declarations.Where(d => later.Any(l => l.Property.Equals(d.Property, StringComparison.OrdinalIgnoreCase) && (l.Important || !d.Important))).Select(d => d.Property).ToList();
                overridden.AddRange(lost);
                if (rules[k].Declarations.Count > 0 && lost.Count == rules[k].Declarations.Count)
                    yield return new Finding(DeadSelector, "warning", rules[k].Line, Normal(rules[k].Selector) + $" #{k + 1}",
                        $"{Clip(rules[k].Selector, 70)} at line {rules[k].Line}: every declaration is redeclared by the same selector at line {rules[^1].Line}",
                        "remove it (the css op: {\"deleteRule\":\"<selector>\",\"nth\":" + (k + 1) + "})");
            }
            yield return new Finding(DuplicateRule, "warning", rules[0].Line, group.Key.Replace("\u0001", " "),
                $"{Clip(rules[0].Selector, 70)} is written in {rules.Count} rules (lines {string.Join(", ", rules.Select(r => r.Line))})"
                + (overridden.Count > 0 ? $"; overridden: {string.Join(", ", overridden.Distinct(StringComparer.OrdinalIgnoreCase).Take(6))}" : ""),
                "keep one rule per selector: the css op edits one of them by place ({\"replaceRule\":\"<selector>\",\"nth\":<n>,\"body\":\"...\"} or {\"deleteRule\":\"<selector>\",\"nth\":<n>})");
        }
    }

    private static IEnumerable<Finding> Redefined(CssStylesheet sheet)
    {
        var values = new Dictionary<string, List<(int Line, string Value)>>(StringComparer.Ordinal);
        foreach (var rule in sheet.Rules)
        {
            if (rule.EnclosingRules.Count > 0 || !CssStylesheet.SplitSelectors(rule.Selector).All(s => s.Trim() is ":root" or "html")) continue;
            foreach (var d in rule.Declarations.Where(d => d.Property.StartsWith("--", StringComparison.Ordinal)))
                (values.TryGetValue(d.Property, out var list) ? list : values[d.Property] = []).Add((rule.Line, Collapse(d.Value)));
        }
        foreach (var (name, defs) in values.Where(v => v.Value.Select(x => x.Value).Distinct(StringComparer.Ordinal).Count() > 1))
            yield return new Finding(VarRedefined, "warning", defs[0].Line, name,
                $"{name} is defined in :root with {defs.Count} values ({string.Join(" / ", defs.Select(v => $"{Clip(v.Value, 30)} at line {v.Line}"))}): only the last counts",
                "keep one definition of each token in :root (the css op: {\"find\":\"<old declaration>\",\"with\":\"\"} for the one that loses)");
    }

    // ---- helpers ------------------------------------------------------------------------------------------------------

    /// <summary>A selector list compared as the browser reads it: comments out, spaces collapsed, around combinators and commas
    /// removed.</summary>
    public static string Normal(string selector)
    {
        var text = Collapse(Uncommented(selector));
        text = Regex.Replace(text, @"\s*([>+~,])\s*", "$1");
        return string.Join(",", CssStylesheet.SplitSelectors(text).Select(s => s.Trim()));
    }

    private static string Collapse(string text) => Regex.Replace(text ?? "", @"\s+", " ").Trim();

    internal static int LineAt(string text, int index) => 1 + text.AsSpan(0, Math.Min(index, text.Length)).Count('\n');

    private static string Clip(string text, int max)
    {
        var one = Collapse(text);
        return one.Length > max ? one[..(max - 1)] + "…" : one;
    }

    // Comments out (the same length in spaces, so positions and lines keep their numbers).
    internal static string Uncommented(string css)
    {
        if (css.IndexOf("/*", StringComparison.Ordinal) < 0) return css;
        var chars = css.ToCharArray();
        for (var i = 0; i + 1 < chars.Length; i++)
        {
            if (chars[i] != '/' || chars[i + 1] != '*') continue;
            var end = css.IndexOf("*/", i + 2, StringComparison.Ordinal);
            var stop = end < 0 ? chars.Length : end + 2;
            for (var k = i; k < stop; k++) if (chars[k] != '\n') chars[k] = ' ';
            i = stop - 1;
        }
        return new string(chars);
    }

    // The selector without its strings (and attribute selectors unless kept), so '#' inside them is never an id.
    private static string WithoutStringsAndAttributes(string selector, bool keepAttributes = false)
    {
        var sb = new StringBuilder(selector.Length);
        char? quote = null; var bracket = 0;
        foreach (var c in selector)
        {
            if (quote != null) { if (c == quote) quote = null; sb.Append(keepAttributes ? c : ' '); continue; }
            if (c is '"' or '\'') { quote = c; sb.Append(keepAttributes ? c : ' '); continue; }
            if (c == '[') bracket++;
            sb.Append(bracket > 0 && !keepAttributes ? ' ' : c);
            if (c == ']') bracket = Math.Max(0, bracket - 1);
        }
        return sb.ToString();
    }
}
