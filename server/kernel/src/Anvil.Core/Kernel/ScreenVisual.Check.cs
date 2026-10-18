using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core;

/// <summary>
/// CX17 7.5/7.6 (F8): the cheap visual check of a page, deterministic (no layout): the DOM the author wrote, the DOM the runtime
/// will publish (ScreenVisual.Predict) and the CSS that reaches the page. A static function with its own test, so the edit form
/// (CX16) calls the same check. Findings by family:
/// <list type="bullet">
/// <item>F4 <see cref="SelectorMissesRuntime"/>: a selector that matches an element of the author and not its runtime element
/// (a wrapper between), that also matches a runtime element the author never wrote (the span of a {{ }}), that lays out an element
/// whose layout item is the runtime's wrapper, that styles a control OutSystems UI styles with a more specific rule, or that
/// sizes a control OutSystems UI draws with pseudo-elements;</item>
/// <item>F5 <see cref="ThemeTokenScoped"/>: a token of OutSystems UI declared in a selector that is not :root/html;</item>
/// <item>F7 <see cref="TextJoined"/>: two inline siblings with visible text and no space between, or }} glued to a word;</item>
/// <item>F1 <see cref="ListNotLayoutContainer"/>: a List that is the only element of a grid or flex container.</item>
/// </list>
/// Each finding has the selector or text that is the author's, the right one when it is unique and checked against the
/// predicted DOM, and a patch as text edits of the op that holds it when it is certain.
/// </summary>
public static partial class ScreenVisual
{
    /// <summary>One finding of the check.</summary>
    public sealed record Finding(string Code, string Root, int Line, string Subject, string? Right, string Why, string Kind)
    {
        /// <summary>Text edits of the html of the op that holds the CSS or the element: {find, replace} (each find occurs once).</summary>
        public List<(string Find, string Replace)> Edits { get; init; } = [];
        /// <summary>The selectors that may be right when none is certain.</summary>
        public List<string> Candidates { get; init; } = [];
        /// <summary>Where the CSS of the finding is written: "page" (this document), "theme" (a theme part), null for the HTML.</summary>
        public string? Sheet { get; init; }
        /// <summary>The rule as written in its sheet (prelude and block): the patch rewrites <see cref="Subject"/> to <see cref="Right"/>
        /// in its selector list, or appends <see cref="Append"/> after it.</summary>
        public string? RuleText { get; init; }
        /// <summary>A rule to write right after <see cref="RuleText"/> (the layout item on the runtime wrapper).</summary>
        public string? Append { get; init; }
        /// <summary><see cref="Right"/> goes beside <see cref="Subject"/> in its selector list (the original keeps the other elements it styles).</summary>
        public bool AddSelector { get; init; }
    }

    /// <summary>One CSS text that reaches the page, and where it is written ("page", "theme").</summary>
    public sealed record Sheet(string Css, string Where);

    /// <summary>What the check reads: the author's DOM (with each element's document node), the predicted runtime DOM and the
    /// map from an author element to its runtime element, the CSS of the page, the document text (for the patches).</summary>
    public sealed record CheckInput(string Root, DomNode Author, IReadOnlyDictionary<DomNode, ScreenHtml.Node> AuthorNodes, Prediction Predicted,
        IReadOnlyDictionary<DomNode, DomNode> Counterparts, IReadOnlyList<Sheet> Sheets, string Platform, string Document);

    // OutSystems UI 2.28.1 (the theme of the fixture outsystems-ui.oml, read headless, 2026-10-15): the custom properties of :root.
    private const string OutSystemsUiTokenNames = "border-radius-circle border-radius-none border-radius-rounded border-radius-soft border-size-l border-size-m border-size-none border-size-s bottom-bar-size color-background-body color-background-login color-blue color-blue-dark color-blue-darker color-blue-darkest color-blue-light color-blue-lighter color-blue-lightest color-cyan color-cyan-dark color-cyan-darker color-cyan-darkest color-cyan-light color-cyan-lighter color-cyan-lightest color-error color-error-light color-focus-inner color-focus-outer color-grape color-grape-dark color-grape-darker color-grape-darkest color-grape-light color-grape-lighter color-grape-lightest color-green color-green-dark color-green-darker color-green-darkest color-green-light color-green-lighter color-green-lightest color-indigo color-indigo-dark color-indigo-darker color-indigo-darkest color-indigo-light color-indigo-lighter color-indigo-lightest color-info color-info-light color-lime color-lime-dark color-lime-darker color-lime-darkest color-lime-light color-lime-lighter color-lime-lightest color-neutral-0 color-neutral-1 color-neutral-10 color-neutral-2 color-neutral-3 color-neutral-4 color-neutral-5 color-neutral-6 color-neutral-7 color-neutral-8 color-neutral-9 color-orange color-orange-dark color-orange-darker color-orange-darkest color-orange-light color-orange-lighter color-orange-lightest color-pink color-pink-dark color-pink-darker color-pink-darkest color-pink-light color-pink-lighter color-pink-lightest color-primary color-primary-hover color-primary-lightest color-primary-selected color-red color-red-dark color-red-darker color-red-darkest color-red-light color-red-lighter color-red-lightest color-secondary color-success color-success-light color-teal color-teal-dark color-teal-darker color-teal-darkest color-teal-light color-teal-lighter color-teal-lightest color-violet color-violet-dark color-violet-darker color-violet-darkest color-violet-light color-violet-lighter color-violet-lightest color-warning color-warning-light color-yellow color-yellow-dark color-yellow-darker color-yellow-darkest color-yellow-light color-yellow-lighter color-yellow-lightest font-bold font-light font-regular font-semi-bold font-size-base font-size-display font-size-h1 font-size-h2 font-size-h3 font-size-h4 font-size-h5 font-size-h6 font-size-label font-size-s font-size-xs footer-height header-color header-size header-size-content layer-above layer-below layer-global-auto layer-global-elevated layer-global-instant-interaction layer-global-navigation layer-global-negative layer-global-off-canvas layer-global-screen layer-local-tier-1 layer-local-tier-2 layer-local-tier-3 layer-local-tier-4 layer-local-tier-5 layer-system-scale os-safe-area-bottom os-safe-area-left os-safe-area-right os-safe-area-top osui-bottom-sheet-layer osui-menu-layer osui-notification-layer osui-popup-layer osui-sidebar-layer overlay-background shadow-l shadow-m shadow-none shadow-s shadow-xl shadow-xs side-menu-size space-base space-l space-m space-none space-s space-xl space-xs space-xxl";

    /// <summary>The custom properties OutSystems UI declares in :root (180 names).</summary>
    public static readonly IReadOnlySet<string> OutSystemsUiTokens = OutSystemsUiTokenNames.Split(' ').Select(n => "--" + n).ToHashSet(StringComparer.Ordinal);

    /// <summary>A rule of OutSystems UI that draws a runtime control (the same fixture), with the properties it sets: an author rule
    /// on that control with a lower specificity loses those properties.</summary>
    public sealed record ControlRule(string Widget, string Selector, IReadOnlySet<string> Properties);

    public static readonly IReadOnlyList<ControlRule> OutSystemsUiControlRules =
    [
        new("IDropdown", ".dropdown-container > select.dropdown-display", Set("align-items background background-color border border-color border-radius color cursor display font-size height padding padding-left padding-right width")),
        new("IInput", ".form-control[data-input]", Set("background background-color border border-color border-radius color font-size height padding padding-left padding-right")),
        new("ITextArea", ".form-control[data-textarea]", Set("background background-color border border-color border-radius color font-size padding")),
    ];

    /// <summary>A control OutSystems UI draws with pseudo-elements: the size and accent of the element do not draw it.</summary>
    public sealed record DrawnControl(string Widget, string Box, string Mark, IReadOnlySet<string> Properties);

    public static readonly IReadOnlyList<DrawnControl> OutSystemsUiDrawnControls =
    [
        new("ICheckbox", "::before", ":checked::after", Set("accent-color appearance width height border border-radius background background-color")),
    ];

    private static IReadOnlySet<string> Set(string words) => words.Split(' ').ToHashSet(StringComparer.Ordinal);

    /// <summary>The properties that lay an element out as an item of its parent's flex or grid.</summary>
    private static readonly IReadOnlySet<string> ItemProperties = Set("flex flex-grow flex-shrink flex-basis align-self justify-self order grid-column grid-row grid-area width min-width max-width");

    private static readonly HashSet<string> InlineTags = new(StringComparer.Ordinal) { "span", "strong", "b", "em", "i", "small", "a", "code", "abbr", "mark", "sub", "sup", "s", "u", "label", "time", "cite", "q" };

    /// <summary>The check of one page: every finding by family.</summary>
    public static List<Finding> Check(CheckInput input)
    {
        var findings = new List<Finding>();
        var rules = new List<(CssRule Rule, Sheet Sheet, string Text, List<(string Text, ComplexSelector Complex)> Selectors)>();
        foreach (var sheet in input.Sheets)
        {
            var text = WithoutNativeLayout(sheet.Css);
            foreach (var (rule, selectors) in Parsed(text)) rules.Add((rule, sheet, text, selectors));
        }
        var layoutRules = rules.Where(r => r.Rule.Declarations.Any(d => d.Property.Equals("display", StringComparison.OrdinalIgnoreCase) && IsLayoutDisplay(d.Value))).ToList();
        var blockRules = rules.Where(r => r.Rule.Declarations.Any(d => d.Property.Equals("display", StringComparison.OrdinalIgnoreCase) && !d.Value.Trim().StartsWith("inline", StringComparison.OrdinalIgnoreCase) && d.Value.Trim() != "contents")).ToList();
        var authorElements = input.Author.Descendants(includeSelf: false).Where(n => n.IsElement).ToList();
        var predictedElements = input.Predicted.Root.Descendants(includeSelf: false).Where(n => n.IsElement).ToList();
        var predictedOf = input.Counterparts;
        var authorOf = predictedOf.ToDictionary(p => p.Value, p => p.Key, ReferenceEqualityComparer.Instance);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        bool Layout(DomNode element) => layoutRules.Any(r => r.Selectors.Any(x => M(element, x.Complex)));
        void Add(Finding f) { if (seen.Add(f.Code + "|" + f.Kind + "|" + f.Subject + (f.Code is TextJoined or ListNotLayoutContainer ? "|" + f.Line : ""))) findings.Add(f); }
        // The tokens :root already declares (with their value): a scoped copy of them is no news.
        var rootTokens = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (rule, _, _, _) in rules)
            if (CssStylesheet.SplitSelectors(rule.Selector).Select(x => x.Trim()).All(x => x is ":root" or "html"))
                foreach (var d in rule.Declarations) rootTokens.Add(d.Property + ":" + d.Value.Trim());

        var runtimeOnly = predictedElements.Where(p => p.Runtime != null && !authorOf.ContainsKey(p)).ToList();
        foreach (var (rule, sheet, sheetText, ruleSelectors) in rules)
        {
            var ruleText = RuleSource(sheetText, rule);
            if (rule.Selector.Contains("::", StringComparison.Ordinal) && !rule.Selector.Contains("::before", StringComparison.Ordinal) && !rule.Selector.Contains("::after", StringComparison.Ordinal)) continue;
            var properties = rule.Declarations.Select(d => d.Property.ToLowerInvariant()).ToHashSet(StringComparer.Ordinal);
            foreach (var (selector, complex) in ruleSelectors)
            {
                var matched = authorElements.Where(a => predictedOf.ContainsKey(a) && M(a, complex)).ToList();
                // (a) a wrapper breaks a child or sibling combinator: the author's element is matched, its runtime element is not.
                var missed = matched.Where(a => !M(predictedOf[a], complex)).ToList();
                if (missed.Count > 0)
                {
                    var right = SeeThroughWrappers(selector, input);
                    var ok = right != null && missed.All(a => SafeMatches(predictedOf[a], right));
                    Add(new Finding(SelectorMissesRuntime, input.Root, Line(input, missed[0]), selector, ok ? right : null,
                        $"{selector} matches <{missed[0].Tag}> as written, not the runtime element: {RuntimePath(predictedOf[missed[0]])}", "wrapper")
                    { Sheet = sheet.Where, RuleText = ruleText, Candidates = ok ? [] : [RuntimePath(predictedOf[missed[0]])] });
                }
                // (b) the selector also matches an element only the runtime renders (the span of a {{ }}, a wrapper span).
                var extra = runtimeOnly.FirstOrDefault(p => M(p, complex));
                // A selector that names the runtime's structure (:has, data-*) means it.
                if (extra != null && complex.Parts[^1].Compound.Items.Any(s => s.Kind == SimpleKind.Type) && !selector.Contains(":has(", StringComparison.Ordinal) && !selector.Contains("[data-", StringComparison.Ordinal))
                {
                    var right = WithoutRuntimeSpans(selector, input.Platform);
                    var ok = right != null && !SafeMatches(extra, right) && matched.All(a => SafeMatches(predictedOf[a], right));
                    Add(new Finding(SelectorMissesRuntime, input.Root, Line(input, extra), selector, ok ? right : null,
                        $"{selector} also styles the runtime's {RuntimePath(extra)}, which the document never wrote" + (extra.Runtime == "IExpression" ? " (the element of a {{ }})" : ""), "runtime-element")
                    { Sheet = sheet.Where, RuleText = ruleText });
                }
                // (c) an item of a flex or grid laid out by a property of the element whose layout item is the runtime's wrapper.
                var item = properties.Intersect(ItemProperties).ToList();
                if (item.Count > 0)
                    foreach (var a in matched)
                    {
                        // A width is the layout item's only in a flex or grid container; flex, order, grid-* always are.
                        var sized = item.Where(x => !x.EndsWith("width", StringComparison.Ordinal) || a.ParentElement is { } up && Layout(up)).ToList();
                        if (sized.Count == 0) continue;
                        var p = predictedOf[a];
                        if (p.ParentElement is not { Runtime: not null } wrapper || authorOf.ContainsKey(wrapper)) continue;
                        // A rule of the page already lays the wrapper out (the patch applied): nothing to say.
                        if (rules.Any(o => o.Rule.Declarations.Any(d => item.Contains(d.Property.ToLowerInvariant())) && o.Selectors.Any(x => M(wrapper, x.Complex)))) continue;
                        var subject = selector[complex.Parts[^1].Compound.Start..complex.Parts[^1].Compound.End];
                        var prefix = selector[..complex.Parts[^1].Compound.Start];
                        var right = prefix + WrapperCompound(wrapper) + ":has(> " + subject + ")";
                        var ok = SafeMatches(wrapper, right);
                        var declarations = string.Join(";", rule.Declarations.Where(d => sized.Contains(d.Property.ToLowerInvariant())).Select(d => d.Property + ":" + d.Value.Trim() + (d.Important ? "!important" : "")));
                        Add(new Finding(SelectorMissesRuntime, input.Root, Line(input, a), selector, ok ? right : null,
                            $"{selector} sets {string.Join(", ", sized)} on <{a.Tag}>, but at runtime the item of its parent is the wrapper {RuntimePath(wrapper)}", "layout-item")
                        { Sheet = sheet.Where, RuleText = ruleText, Append = ok ? right + "{" + declarations + "}" + (sized.Any(x => x is "width" or "min-width" or "max-width" || x.StartsWith("flex", StringComparison.Ordinal))
                            // the control fills its box again (OSFillParent), over the width the rule gave the bare tag
                            ? "\n" + right + " > " + subject + "{width:100%;min-width:0;max-width:none;flex:none}" : "") : null });
                        break;
                    }
                // (d) a control OutSystems UI styles with a more specific rule.
                foreach (var a in matched)
                {
                    var p = predictedOf[a];
                    var control = OutSystemsUiControlRules.FirstOrDefault(c => c.Widget == p.Widget && SafeMatches(p, c.Selector));
                    if (control == null) continue;
                    // A layout property of a control inside a runtime wrapper belongs to the wrapper (c), never forced on the control.
                    var lost = properties.Intersect(control.Properties).Where(x => !(p.ParentElement is { Runtime: not null } && ItemProperties.Contains(x))).ToList();
                    var wins = CssSelectors.Specificity(control.Selector);
                    if (lost.Count == 0 || CssSelectors.Specificity(complex).CompareTo(wins) > 0) continue;
                    // Another selector of the page already styles that control over OutSystems UI (the patch applied).
                    if (rules.Any(o => o.Rule.Declarations.Any(d => lost.Contains(d.Property.ToLowerInvariant())) && o.Selectors.Any(x => CssSelectors.Specificity(x.Complex).CompareTo(wins) > 0 && M(p, x.Complex)))) continue;
                    var subjectCompound = complex.Parts[^1].Compound;
                    var pseudo = string.Concat(subjectCompound.Items.Where(s => s.Kind is SimpleKind.PseudoClass or SimpleKind.PseudoElement).Select(s => selector[s.Start..s.End]));
                    var own = string.Concat(subjectCompound.Items.Where(s => s.Kind is SimpleKind.Class or SimpleKind.Attribute or SimpleKind.Id).Select(s => selector[s.Start..s.End]));
                    var prefix = selector[..subjectCompound.Start];
                    var right = prefix + control.Selector + own + pseudo;
                    var ok = SafeMatches(p, prefix + control.Selector + own) && CssSelectors.Specificity(right).CompareTo(CssSelectors.Specificity(control.Selector)) > 0;
                    Add(new Finding(SelectorMissesRuntime, input.Root, Line(input, a), selector, ok ? right : null,
                        $"{selector} {SpecText(CssSelectors.Specificity(complex))} loses {string.Join(", ", lost)} to the OutSystems UI rule {control.Selector} {SpecText(CssSelectors.Specificity(control.Selector))} on the runtime {RuntimePath(p)}; the patch adds the selector that wins beside it", "specificity")
                    { Sheet = sheet.Where, RuleText = ruleText, AddSelector = true });
                    break;
                }
                // (e) a control OutSystems UI draws with pseudo-elements: its size and accent do not draw it.
                foreach (var a in matched)
                {
                    var p = predictedOf[a];
                    var drawn = OutSystemsUiDrawnControls.FirstOrDefault(c => c.Widget == p.Widget);
                    if (drawn == null || complex.Parts[^1].Compound.Items.Any(s => s.Kind == SimpleKind.PseudoElement)) continue;
                    var touched = properties.Intersect(drawn.Properties).ToList();
                    if (touched.Count == 0) continue;
                    Add(new Finding(SelectorMissesRuntime, input.Root, Line(input, a), selector, null,
                        $"{selector} sets {string.Join(", ", touched)} on the check box, which OutSystems UI draws with {drawn.Box} (the box) and {drawn.Mark} (the mark) on {RuntimePath(p)}", "drawn-control")
                    { Sheet = sheet.Where, RuleText = ruleText, Candidates = [selector + drawn.Box, selector + drawn.Mark] });
                    break;
                }
            }
            // F5: a token of OutSystems UI declared in a selector that is not :root/html.
            var tokens = rule.Declarations.Where(d => OutSystemsUiTokens.Contains(d.Property) && !rootTokens.Contains(d.Property + ":" + d.Value.Trim())).ToList();
            if (tokens.Count > 0 && rule.EnclosingRules.Count == 0 && !CssStylesheet.SplitSelectors(rule.Selector).Select(s => s.Trim()).All(s => s is ":root" or "html"))
            {
                var declarations = string.Join(";", tokens.Select(d => d.Property + ":" + d.Value.Trim()));
                Add(new Finding(ThemeTokenScoped, input.Root, rule.Line, rule.Selector, ":root",
                    $"{string.Join(", ", tokens.Select(t => t.Property))} declared in {rule.Selector}: the OutSystems UI widgets and the template's screens outside it keep the theme's {tokens[0].Property}", "token")
                { Sheet = sheet.Where, RuleText = ruleText, Append = ":root{" + declarations + "}" });
            }
        }

        // F7 and F1 on the author's DOM.
        bool Block(DomNode element) => blockRules.Any(r => r.Selectors.Any(x => M(element, x.Complex)));
        foreach (var parent in authorElements)
        {
            var children = parent.Children;
            for (var i = 0; i + 1 < children.Count; i++)
            {
                var (a, b) = (children[i], children[i + 1]);
                if (!a.IsElement || !b.IsElement || !InlineTags.Contains(a.Tag!) || !InlineTags.Contains(b.Tag!)) continue;
                if (!Visible(a) || !Visible(b) || Layout(parent) || Block(a) || Block(b)) continue;
                if (!input.AuthorNodes.TryGetValue(b, out var bNode)) continue;
                var edit = InsertBefore(input.Document, bNode, " ");
                Add(new Finding(TextJoined, input.Root, bNode.Line, $"</{a.Tag}><{b.Tag}>", $"</{a.Tag}> <{b.Tag}>",
                    $"\"{Clip(TextOf(a))}\" and \"{Clip(TextOf(b))}\" are inline siblings with no space between: the page shows them glued", "inline")
                { Edits = edit != null ? [edit.Value] : [] });
            }
            foreach (var text in children.Where(c => !c.IsElement && c.Text != null))
            {
                var m = Regex.Match(text.Text!, @"\}\}[\p{L}\p{N}]|[\p{L}\p{N}]\{\{");
                if (!m.Success || !input.AuthorNodes.TryGetValue(parent, out var pNode)) continue;
                var fixedText = Regex.Replace(text.Text!, @"\}\}(?=[\p{L}\p{N}])", "}} ");
                fixedText = Regex.Replace(fixedText, @"(?<=[\p{L}\p{N}])\{\{", " {{");
                Add(new Finding(TextJoined, input.Root, pNode.Line, text.Text!.Trim(), fixedText.Trim(), "a binding glued to a word: the value and the word show with no space between", "binding")
                { Edits = input.Document.Contains(text.Text!, StringComparison.Ordinal) && Occurrences(input.Document, text.Text!) == 1 ? [(text.Text!, fixedText)] : [] });
            }
            // F1: a List that is the only element of a grid or flex container: the container's items are the List and its sentinels.
            var elements = children.Where(c => c.IsElement).ToList();
            if (elements is [var only] && only.Attr("list") != null && Layout(parent) && input.AuthorNodes.TryGetValue(only, out var listNode) && input.AuthorNodes.TryGetValue(parent, out var parentNode))
            {
                var movable = only.Attributes.All(x => x.Name is "list" or "as") && parent.Attr("list") == null;
                var edits = movable ? MoveListUp(input.Document, parentNode, listNode) : null;
                Add(new Finding(ListNotLayoutContainer, input.Root, listNode.Line, $"<{parent.Tag}{ClassText(parent)}><{only.Tag} list=\"{only.Attr("list")}\">",
                    movable ? $"<{parent.Tag}{ClassText(parent)} list=\"{only.Attr("list")}\"{(only.Attr("as") is { } alias ? $" as=\"{alias}\"" : "")}><{only.Tag}>" : null,
                    $"the List is the only element of the {(Layout(parent) ? "grid/flex" : "")} container <{parent.Tag}{ClassText(parent)}>: the layout's items are the List (one) and not its rows", "container")
                { Edits = edits ?? [] });
            }
        }
        return findings;
    }

    // ---- helpers of the check -------------------------------------------------------------------------------------------------

    private static bool M(DomNode element, ComplexSelector selector)
    {
        try { return CssSelectors.Matches(element, selector); } catch (Exception) { return false; }
    }

    // The style rules of a sheet with their selectors parsed once (a theme read by every page of a job is parsed once).
    private static readonly Dictionary<string, List<(CssRule Rule, List<(string Text, ComplexSelector Complex)> Selectors)>> ParsedSheets = new(StringComparer.Ordinal);

    private static List<(CssRule Rule, List<(string Text, ComplexSelector Complex)> Selectors)> Parsed(string css)
    {
        lock (ParsedSheets)
            if (ParsedSheets.TryGetValue(css, out var cached)) return cached;
        var list = new List<(CssRule, List<(string, ComplexSelector)>)>();
        try
        {
            foreach (var rule in CssStylesheet.Parse(css, lenient: true).Rules)
            {
                if (rule.Selector.Contains("::", StringComparison.Ordinal) && !rule.Selector.Contains("::before", StringComparison.Ordinal) && !rule.Selector.Contains("::after", StringComparison.Ordinal)) continue;
                var selectors = new List<(string, ComplexSelector)>();
                foreach (var text in CssStylesheet.SplitSelectors(rule.Selector).Select(x => x.Trim()).Where(x => x.Length > 0))
                    try { if (CssSelectors.ParseList(text) is [var one]) selectors.Add((text, one)); } catch (Exception) { }
                list.Add((rule, selectors));
            }
        }
        catch (Exception) { }
        lock (ParsedSheets)
        {
            if (ParsedSheets.Count > 32) ParsedSheets.Clear();
            ParsedSheets[css] = list;
        }
        return list;
    }

    private static string WithoutNativeLayout(string css)
    {
        var begin = css.IndexOf(NativeLayoutBegin, StringComparison.Ordinal);
        if (begin < 0) return css;
        var end = css.IndexOf(NativeLayoutEnd, begin, StringComparison.Ordinal);
        return end < 0 ? css : css[..begin] + css[(end + NativeLayoutEnd.Length)..];
    }

    private static int Line(CheckInput input, DomNode element)
    {
        if (input.AuthorNodes.TryGetValue(element, out var node)) return node.Line;
        foreach (var (a, p) in input.Counterparts) if (ReferenceEquals(p, element) && input.AuthorNodes.TryGetValue(a, out var n)) return n.Line;
        for (var parent = element.ParentElement; parent != null; parent = parent.ParentElement)
            foreach (var (a, p) in input.Counterparts) if (ReferenceEquals(p, parent) && input.AuthorNodes.TryGetValue(a, out var n)) return n.Line;
        return 0;
    }

    /// <summary>tag.classes[data-*] of a runtime element and its runtime parents (up to the first element of the document).</summary>
    private static string RuntimePath(DomNode element)
    {
        var parts = new List<string>();
        for (var e = element; e != null && parts.Count < 3; e = e.ParentElement)
        {
            parts.Insert(0, Compact(e));
            if (e.Runtime == null && !ReferenceEquals(e, element)) break;
        }
        return string.Join(" > ", parts);
    }

    private static string Compact(DomNode e)
    {
        var sb = new StringBuilder(e.Tag);
        foreach (var c in e.Classes.Where(c => !c.Contains('"'))) sb.Append('.').Append(c);
        foreach (var (name, _) in e.Attributes.Where(a => a.Name.StartsWith("data-", StringComparison.Ordinal) && a.Name != "data-ssam-runtime")) sb.Append('[').Append(name).Append(']');
        return sb.ToString();
    }

    private static string WrapperCompound(DomNode wrapper)
    {
        var sb = new StringBuilder(wrapper.Tag);
        foreach (var c in wrapper.Classes.Where(c => !c.Contains('"') && !c.StartsWith("input-", StringComparison.Ordinal))) sb.Append('.').Append(c);
        foreach (var (name, _) in wrapper.Attributes.Where(a => a.Name.StartsWith("data-", StringComparison.Ordinal) && a.Name != "data-ssam-runtime")) sb.Append('[').Append(name).Append(']');
        return sb.ToString();
    }

    private static string SpecText((int A, int B, int C) s) => $"({s.A},{s.B},{s.C})";

    /// <summary>The importer's item 6 (wrapper-transparent combinators) with the wrappers of the predicted DOM.</summary>
    private static string? SeeThroughWrappers(string selector, CheckInput input)
    {
        try
        {
            var options = new RewriteOptions
            {
                Platform = input.Platform,
                Wrappers = (compound, _) =>
                {
                    var chains = new List<IReadOnlyList<string>>();
                    foreach (var p in input.Counterparts.Values)
                    {
                        if (!CssSelectors.MatchesCompound(p, compound)) continue;
                        var chain = new List<string>();
                        for (var w = p.ParentElement; w is { Runtime: not null } && !input.Counterparts.Values.Contains(w); w = w.ParentElement) chain.Insert(0, w.RuntimeSelector ?? Compact(w));
                        if (chain.Count > 0 && !chains.Any(c => c.SequenceEqual(chain))) chains.Add(chain);
                    }
                    return chains;
                },
            };
            var written = PrototypeRewrites.WrapperTransparent(selector, options.Wrappers);
            return written == selector ? null : written;
        }
        catch (Exception) { return null; }
    }

    /// <summary>Every span type selector of the selector without the runtime's spans (the importer's item 5, without the icons).</summary>
    private static string? WithoutRuntimeSpans(string selector, string platform)
    {
        try
        {
            var spans = RuntimeDomTable.RuntimeSpans(platform);
            var complex = CssSelectors.ParseComplex(selector);
            var edits = complex.Parts.SelectMany(p => p.Compound.Items).Where(s => s.Kind == SimpleKind.Type && s.Name == "span").Select(s => s.End).OrderByDescending(e => e).ToList();
            if (edits.Count == 0) return null;
            var text = selector;
            foreach (var at in edits) text = text[..at] + ":not(:where(" + string.Join(", ", spans) + "))" + text[at..];
            return text;
        }
        catch (Exception) { return null; }
    }

    /// <summary>The text of a rule as written in its sheet (from its line and column to the brace that closes its block); null
    /// when the position does not hold its selector.</summary>
    private static string? RuleSource(string css, CssRule rule)
    {
        var line = 1; var i = 0;
        while (line < rule.Line && i < css.Length) { if (css[i] == '\n') line++; i++; }
        var at = Math.Min(css.Length, i + Math.Max(0, rule.Column - 1));
        var open = css.IndexOf('{', at);
        if (open < 0) return null;
        var depth = 0;
        for (var j = open; j < css.Length; j++)
        {
            if (css[j] == '{') depth++;
            else if (css[j] == '}' && --depth == 0) return css[at..(j + 1)];
        }
        return null;
    }

    private static bool Visible(DomNode element) => element.Descendants(includeSelf: false).Any(n => !n.IsElement && n.Text is { } t && t.Trim().Length > 0);

    private static string TextOf(DomNode element) => string.Concat(element.Descendants(includeSelf: false).Where(n => !n.IsElement).Select(n => n.Text)).Trim();

    private static string Clip(string text) => text.Length > 40 ? text[..40] + "…" : text;

    private static string ClassText(DomNode element) => element.Attr("class") is { Length: > 0 } c ? $" class=\"{c}\"" : "";

    private static int Occurrences(string text, string part)
    {
        var count = 0;
        for (var i = text.IndexOf(part, StringComparison.Ordinal); i >= 0; i = text.IndexOf(part, i + part.Length, StringComparison.Ordinal)) count++;
        return count;
    }

    /// <summary>The offset of a node's start tag in the document (its line and column).</summary>
    private static int Offset(string document, ScreenHtml.Node node)
    {
        var line = 1; var i = 0;
        while (line < node.Line && i < document.Length) { if (document[i] == '\n') line++; i++; }
        return Math.Min(document.Length, i + Math.Max(0, node.Column - 1));
    }

    /// <summary>A text edit that inserts <paramref name="text"/> right before the start tag of a node: the find is the tail of the
    /// previous element's end tag plus the start of the node's tag, unique in the document; null when it is not unique.</summary>
    private static (string, string)? InsertBefore(string document, ScreenHtml.Node node, string text)
    {
        var at = Offset(document, node);
        if (at <= 0 || at >= document.Length || document[at] != '<') return null;
        for (var back = 8; back <= Math.Min(at, 120); back += 8)
        {
            var end = Math.Min(document.Length, at + 24);
            var find = document[(at - back)..end];
            if (Occurrences(document, find) == 1) return (find, document[(at - back)..at] + text + document[at..end]);
        }
        return null;
    }

    /// <summary>The edits that move list="..." (and as="...") from the only element of a layout container to the container.</summary>
    private static List<(string, string)>? MoveListUp(string document, ScreenHtml.Node parent, ScreenHtml.Node list)
    {
        var parentTag = StartTag(document, parent);
        var listTag = StartTag(document, list);
        if (parentTag == null || listTag == null || Occurrences(document, parentTag + listTag) != 1) return null;
        var moved = Regex.Matches(listTag, @"\s(?:list|as)=(""[^""]*""|'[^']*')").Select(m => m.Value).ToList();
        var bare = listTag;
        foreach (var attribute in moved) bare = bare.Replace(attribute, "", StringComparison.Ordinal);
        var close = parentTag.EndsWith("/>", StringComparison.Ordinal) ? parentTag.Length - 2 : parentTag.Length - 1;
        var parentWith = parentTag[..close] + string.Concat(moved) + parentTag[close..];
        var patched = document.Replace(parentTag + listTag, parentWith + bare, StringComparison.Ordinal);
        try
        {
            var top = ScreenHtml.Parse(patched);
            if (!ScreenDocument.Descendants(top).Any(n => n.Get("list") == list.Get("list") && n.Tag == parent.Tag)) return null;
        }
        catch (Exception) { return null; }
        return [(parentTag + listTag, parentWith + bare)];
    }

    // The start tag of a node as written (from its '<' to the '>' that closes it, outside quotes).
    private static string? StartTag(string document, ScreenHtml.Node node)
    {
        var at = Offset(document, node);
        if (at >= document.Length || document[at] != '<') return null;
        char quote = '\0';
        for (var i = at + 1; i < document.Length; i++)
        {
            var c = document[i];
            if (quote != '\0') { if (c == quote) quote = '\0'; continue; }
            if (c is '"' or '\'') { quote = c; continue; }
            if (c == '>') return document[at..(i + 1)];
        }
        return null;
    }
}
