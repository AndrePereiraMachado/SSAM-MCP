using System.Diagnostics;
using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// CX17: the engine's visual rules in the document form of the html op (ScreenVisual). On every widget the document creates
/// (no k of a reading): the class it is born with (F2) and the rows of a List that is part of a table or a layout (F1). After a
/// compile that created at least one element: the native layout block of the module theme (F3/F6). Every write is listed in
/// normalized with its code; an element of the reading keeps what it had.
/// </summary>
public sealed partial class ModelSession
{
    private sealed partial class DocumentCompiler
    {
        private int newWidgets;                                                     // widgets of the document without k of the reading
        private Dictionary<ScreenHtml.Node, DomNode>? authorMap;                    // the document as the author's DOM (lazy)
        private List<CssRule>? pageRules;                                           // the rules of the page, the document's theme parts and the module theme
        private readonly Dictionary<string, JsonObject> visualNotes = new(StringComparer.Ordinal);   // normalized, one per code and kind

        /// <summary>The element of the author's DOM written by a node of the document.</summary>
        private DomNode? AuthorElement(ScreenHtml.Node node)
        {
            if (authorMap == null)
            {
                authorMap = new Dictionary<ScreenHtml.Node, DomNode>(ReferenceEqualityComparer.Instance);
                var top = document.Children.First(c => !c.IsText && c.Tag is "screen" or "block");
                ScreenVisual.AuthorDom(top, authorMap);
            }
            return authorMap.TryGetValue(node, out var element) ? element : null;
        }

        /// <summary>The style rules that reach this page: its own &lt;style&gt; blocks (theme parts included), data.css and the
        /// author CSS of the themes the page shows (review 3, M7: its flow's, else the module's default, and their bases).</summary>
        private List<CssRule> PageRules() =>
            pageRules ??= ScreenVisual.RulesOf(styles.Select(b => b.Css).Append(options.Css).Concat(Theme().Css));

        // The theme the page shows (ModelSession.PageThemeOf, review 3, M7; a block: the themes of the screens that show it,
        // RootThemeOf, review 4, N1), read once per compile.
        private ScreenVisual.PageTheme Theme() => pageTheme ??= s.RootThemeOf(root);
        private ScreenVisual.PageTheme? pageTheme;

        // Review 3, M6: the markers are derived state. The compile decides them on every widget it creates, with or without k,
        // except in the recreation of a root that carries none (a screen made in the Studio, recreated to prove the reading:
        // nothing is marked there, review 1, A1).
        private bool DecidesRead() => decidesRead ??= options.Exclude == null
            || ScreenVisual.ReachedRoots(r, [options.Exclude], Array.Empty<IObjectSignature>()).Count > 0;
        private bool? decidesRead;
        // Whether the compile decides the markers of this element: a new one, or one with k where DecidesRead.
        private bool DecidesMarkers(ScreenHtml.Node node) => !Read(node) || DecidesRead();
        private JsonObject? decidedNote;

        /// <summary>CX17 F2 and F1 on a widget the document creates (called before its Reset runs: the Reset skips what is in
        /// <paramref name="written"/>).</summary>
        private void NativeVisual(IObjectSignature widget, string kind, ScreenHtml.Node node, string tagText, HashSet<string> written)
        {
            var read = Read(node);
            if (read && !DecidesRead()) return;
            newWidgets++;
            var theme = Theme();
            var marked = new HashSet<string>(StringComparer.Ordinal);   // the markers decided on this widget
            var why = new Dictionary<string, string>(StringComparer.Ordinal);
            // F2: the class of a widget the document creates without class (the author's class always wins); a k keeps its class.
            // The one rule of the forms that create a widget (ScreenVisual.StudioClassOf, the owner's decision D1 of 2026-10-17).
            if (!read && !written.Contains("Style") && FindProperty(widget, "Style") is { } style
                && ScreenVisual.StudioClassOf(kind, Text(SafeGet(style, widget))) is { } studio)
            {
                try
                {
                    // A kept class is not written: the Reset leaves the class the Studio gave the widget it created.
                    if (studio.Writes) WriteExpression(widget, "Style", studio.Expression);
                    written.Add("Style");
                    ScreenVisual.CountStudioClass(visualNotes, studio, node.Line);
                }
                catch (Exception error) { Problem(ScreenDocument.Invalid, node, $"the class of the new {kind} could not be written: {Unwrap(error)}"); }
            }
            // F2 for the rows of a new native Table: a header row or a template row without class keeps the class the Studio gives
            // it (the Reset leaves it), as the Table keeps its own (ScreenVisual.ClassDecisions).
            if (!read && kind == "TableRecords")
                foreach (var property in new[] { "StyleHeader", "StyleRow" })
                    if (!written.Contains(property) && FindProperty(widget, property) is { } rowStyle && Text(SafeGet(rowStyle, widget)) is { Length: > 0 }) written.Add(property);
            // F1: a List that is part of a table, a list or a layout container renders every row; its marker lets the block lay
            // out its rows (a List the document writes with its own disable-virtualization, as the gen-screen does, gets the marker).
            var element = AuthorElement(node);
            if (kind == "List" && node.Get("list") != null && ScreenVisual.AllRowsReason(tagText, element, PageRules()) is { } reason)
            {
                var wrote = false;
                if (!node.Attributes.Any(a => a.Key is "disable-virtualization" or "ext:disable-virtualization"))
                    wrote |= Marker(widget, node, "disable-virtualization", "True", "disable-virtualization on the new List");
                // The rows marker only where the block reaches the page (review 3, M7).
                if (theme.Reachable && Marker(widget, node, ScreenVisual.RowsMarker, ScreenVisual.MarkerValue, "the rows marker of the new List")) { wrote = true; marked.Add(ScreenVisual.RowsMarker); }
                why[ScreenVisual.RowsMarker] = theme.Reachable ? reason : $"the theme the page shows carries no native layout block: {theme.Why}";
                if (wrote) VisualNote(ScreenVisual.ListRendersAllRows, "List", node, tagText, theme.Reachable ? reason : reason + "; the rows marker is not written: " + theme.Why);
            }
            else why[ScreenVisual.RowsMarker] = "the List is not part of a table, a list or a layout container";
            // F3 (review 1, A1/M1; review 2, M5): the runtime's gutter is zeroed only on a link, button or form whose parent already
            // spaces its items side by side (a column gap that is not zero in a flex or grid parent, read by the cascade of the
            // rules without a condition: ScreenVisual.SpacingReader); elsewhere it is the only spacing between neighbors and stays.
            // A condition (@media, @supports) under which the parent spaces them otherwise is said in the note. Said in every job,
            // counted per gutter: the first item of its parent has none (the runtime gives it after a neighbor only). Review 3: the
            // decision is made on every widget the compile creates, k or not (the marker its text carries is not written: M6), and
            // only where the theme the page shows carries the block (M7: else the gap and the gutter add up, said).
            if (kind is "Link" or "Button" or "Form" && element != null)
            {
                var gap = ScreenVisual.GapDecision(element, SpacingOf, theme);
                if (gap?.Diverge is { } pages)
                    Problem(ScreenVisual.BlockPagesDiverge, node, ScreenVisual.DivergeMessage(kind, TypeResolver.Name(root!) ?? "", pages), ScreenVisual.DivergeFix);
                if (gap is { } d)
                {
                    var code = ScreenVisual.GutterCode(d);
                    if (d.Marked && !Marker(widget, node, ScreenVisual.GapMarker, ScreenVisual.MarkerValue, "the gap marker of the " + kind)) code = "";
                    if (d.Marked && code.Length > 0) marked.Add(ScreenVisual.GapMarker);
                    if (code.Length > 0) VisualNote(code, kind, node, "", "", spacing: d.Spacing);
                }
                why[ScreenVisual.GapMarker] = ScreenVisual.GapWhy(gap, theme);
            }
            else why[ScreenVisual.GapMarker] = "only a link, a button or a form takes it";
            // F6 (review 1, A1): an element at the top of a screen of the op carries the page marker, so the layout chain of this
            // page (and of no other) gets min-width 0. Never in a block: a block goes on pages the op did not create. Review 3, M7:
            // only where the theme the page shows carries the block.
            var atTop = element?.ParentElement is { } top && IsPageTop(top) && PrototypeBuilder.FindMethod(widget, "CreateExtendedProperty") != null;
            if (atTop && theme.Reachable && Marker(widget, node, ScreenVisual.PageMarker, ScreenVisual.MarkerValue, "the page marker"))
            {
                marked.Add(ScreenVisual.PageMarker);
                VisualNote(ScreenVisual.PageMarked, kind, node, "", "");
            }
            why[ScreenVisual.PageMarker] = !atTop ? "it is not at the top of a screen of the op" : theme.Reachable ? "it is at the top of a screen of the op" : $"the theme the page shows carries no native layout block: {theme.Why}";
            // Review 3, M6: an element of the reading whose text carries another marker than the one decided is said (never kept
            // nor dropped in silence).
            if (!read) return;
            foreach (var marker in ScreenVisual.EngineMarkers)
                if (ScreenVisual.CarriesMarker(node, marker) != marked.Contains(marker))
                {
                    if (decidedNote == null) { decidedNote = ScreenVisual.MarkerDecidedNote(); visualNotes[ScreenVisual.MarkerDecided] = decidedNote; }
                    ScreenVisual.AddDecided(decidedNote, $"line {node.Line} k=\"{node.Get("k")}\"", marker, marked.Contains(marker), why.GetValueOrDefault(marker, ""));
                }
        }

        // An extended property the op writes on a widget it creates (an attribute at runtime); false when the widget takes none.
        private bool Marker(IObjectSignature widget, ScreenHtml.Node node, string name, string expression, string what)
        {
            try
            {
                var create = PrototypeBuilder.FindMethod(widget, "CreateExtendedProperty") ?? throw new InvalidOperationException($"{ShortType(widget)} takes no attributes (extended properties)");
                var ep = create.Invoke(widget, create.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray())!;
                PrototypeBuilder.SetProperty(ep, "Property", name);
                WriteExpression(ep, "Value", expression);
                extendedProperties++;
                return true;
            }
            catch (Exception error) { Problem(ScreenDocument.Invalid, node, $"{what}: {Unwrap(error)}"); return false; }
        }

        // The space a parent puts between its items (review 2, M5), read one way: ScreenVisual.SpacingReader over the cascade of
        // OutSystems UI's layout utilities, the themes the page shows (review 3, M7) and the page (its <style> blocks and
        // data.css), in that order, parsed once per compile and theme and read once per parent, under each theme the page is
        // shown with (a block: each theme of the screens that show it, review 4, N1).
        private ScreenVisual.Spacing SpacingOf(ScreenVisual.PageTheme theme, DomNode parent)
        {
            if (!spacingOf.TryGetValue(theme, out var ofTheme)) spacingOf[theme] = ofTheme = new(ReferenceEqualityComparer.Instance);
            if (ofTheme.TryGetValue(parent, out var known)) return known;
            if (!spacingReaders.TryGetValue(theme, out var reader))
                spacingReaders[theme] = reader = ScreenVisual.PageSpacing(theme, styles.Select(b => (string?)b.Css).Append(options.Css));
            return ofTheme[parent] = reader.Of(parent);
        }
        private readonly Dictionary<ScreenVisual.PageTheme, ScreenVisual.SpacingReader> spacingReaders = new(ReferenceEqualityComparer.Instance);
        private readonly Dictionary<ScreenVisual.PageTheme, Dictionary<DomNode, ScreenVisual.Spacing>> spacingOf = new(ReferenceEqualityComparer.Instance);

        // The element of the reading with that k (null without the reading's text): what an element with k was read with.
        private ScreenHtml.Node? ReadNode(string k)
        {
            if (options.ReadHtml == null) return null;
            if (readNodes == null)
            {
                readNodes = new Dictionary<string, ScreenHtml.Node>(StringComparer.Ordinal);
                try { foreach (var (node, _) in ScreenHtmlText.Elements(ScreenHtml.Parse(options.ReadHtml))) if (node.Get("k") is { } key) readNodes.TryAdd(key, node); }
                catch (FormatException) { /* a reading that does not parse: every element with k is its own reading */ }
            }
            return readNodes.GetValueOrDefault(k);
        }
        private Dictionary<string, ScreenHtml.Node>? readNodes;
        // The top of the page: the root of a screen document, or a slot of a block instance that is a child of that root (the
        // layout block). A block document has no page top (review 1, A1).
        private bool IsPageTop(DomNode parent)
        {
            var top = document.Children.First(c => !c.IsText && c.Tag is "screen" or "block");
            if (top.Tag != "screen") return false;
            var root = AuthorElement(top);
            if (ReferenceEquals(parent, root)) return true;
            return parent.Tag == "slot" && parent.ParentElement is { } block && ReferenceEquals(block.ParentElement, root);
        }
        /// <summary>One normalized entry per code and kind, with the count and the first lines; a gutter note also says where the
        /// parent's gap comes from and each condition under which the parent spaces its items otherwise (review 2, M5).</summary>
        private void VisualNote(string code, string kind, ScreenHtml.Node node, string value, string why, ScreenVisual.Spacing? spacing = null)
        {
            VisualNoteCore(code, kind, node, value, why);
            if (spacing == null) return;
            var note = visualNotes[code + "|" + kind];
            void Add(string field, string text)
            {
                if (note[field] is not JsonArray list) note[field] = list = new JsonArray();
                if (list.Count < 10 && !list.Any(x => x!.ToString() == text)) list.Add(text);
            }
            if (spacing.Always.Horizontal) Add("gaps", $"line {node.Line}: {spacing.Always.Describe()}");
            foreach (var (condition, there) in spacing.Conditional)
                Add("conditions", $"line {node.Line}: under {condition} " + (there.Horizontal
                    ? $"the parent spaces its items side by side ({there.Describe()}): there the gap and the runtime's gutter add up"
                    : $"the parent has no column gap ({there.Describe()}): there the gutter is zeroed and the items touch"));
        }

        // The notes of F1, F3 and F6 (F2's are ScreenVisual.CountStudioClass, the same in each form that applies F2).
        private void VisualNoteCore(string code, string kind, ScreenHtml.Node node, string value, string why)
        {
            var key = code + "|" + kind;
            if (!visualNotes.TryGetValue(key, out var note))
            {
                note = new JsonObject
                {
                    ["code"] = code, ["element"] = kind, ["count"] = 0, ["lines"] = new JsonArray(),
                    ["note"] = code switch
                    {
                        ScreenVisual.GutterZeroedInGap or ScreenVisual.GutterKept or ScreenVisual.GutterAddsToGap => ScreenVisual.GutterNote(code, kind, Theme().Name),
                        ScreenVisual.PageMarked => $"the {kind} at the top of the page is marked {ScreenVisual.PageMarker}: the native layout block gives min-width 0 to the layout chain of this page only",
                        _ => ScreenVisual.AllRowsNote(why),
                    },
                };
                visualNotes[key] = note;
                // Review 4, N1: a marker of a block shown on pages without the native layout block, or on no page yet, says it.
                if (code is ScreenVisual.GutterZeroedInGap or ScreenVisual.ListRendersAllRows) ScreenVisual.Caveat(note, Theme());
            }
            note["count"] = note["count"]!.GetValue<int>() + 1;
            if (note["lines"]!.AsArray().Count < 10) note["lines"]!.AsArray().Add(node.Line);
        }

        /// <summary>After a compile that is kept (no refusal after this point): the visual notes in normalized and the native
        /// layout block in the module theme when the document created at least one widget (never in a check of expressions).</summary>
        private void NativeVisualDone()
        {
            foreach (var note in visualNotes.Values) normalized.Add(note);
            if (options.CheckExpressions || newWidgets == 0) return;
            foreach (var layout in s.InstallNativeLayouts(root!)) normalized.Add(layout);
        }

        /// <summary>CX17 F8: the visual check of the page this compile wrote (ScreenVisual.Check over the author's DOM, the DOM the
        /// runtime will publish and the CSS that reaches the page), with its time and the counts of the prediction.</summary>
        internal (List<ScreenVisual.Finding> Findings, ScreenVisual.Prediction Prediction, long Ms)? VisualCheck()
        {
            if (root == null || root.WasDeleted || options.CheckExpressions) return null;
            var watch = Stopwatch.StartNew();
            try
            {
                var top = document.Children.First(c => !c.IsText && c.Tag is "screen" or "block");
                var platform = MessageExpectations.Lane;
                var prediction = ScreenVisual.Predict(r, root, platform);
                AuthorElement(top);
                var authorNodes = new Dictionary<DomNode, ScreenHtml.Node>(ReferenceEqualityComparer.Instance);
                foreach (var (node, element) in authorMap!) authorNodes[element] = node;
                var counterparts = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
                foreach (var (key, predicted) in prediction.ByKey)
                    if (nodeOf.TryGetValue(key, out var node) && authorMap.TryGetValue(node, out var authored) && !counterparts.ContainsKey(authored)) counterparts[authored] = predicted;
                var authorRoot = authorMap[top];
                var sheets = new List<ScreenVisual.Sheet>();
                if (ownSheet is { Length: > 0 } own) sheets.Add(new(own, "page"));
                // Review 3, M7: the themes the page shows, read now (with the theme part this compile wrote).
                var shown = s.RootThemeOf(root);
                foreach (var theme in shown.Css) if (theme.Length > 0) sheets.Add(new(theme, "theme"));
                var findings = ScreenVisual.Check(new ScreenVisual.CheckInput(TypeResolver.Name(root) ?? top.Get("name") ?? "", authorRoot, authorNodes, prediction, counterparts, sheets, platform, source)
                    { BaseRules = ScreenVisual.BaseRuleKeys(shown.Base) });
                return (findings, prediction, watch.ElapsedMilliseconds);
            }
            catch (Exception error) { s.Note("HTML_VISUAL_CHECK", $"the visual check of {TypeResolver.Name(root)} could not run: {Unwrap(error)}"); return null; }
        }
    }

    /// <summary>The visual check of a document op (HtmlDocument, after a compile that is kept): its counts and time in the op's
    /// report (visual), its findings in the job's warnings.</summary>
    private void VisualReport(JsonObject report, (List<ScreenVisual.Finding> Findings, ScreenVisual.Prediction Prediction, long Ms) visual, int? op)
    {
        var (findings, prediction, ms) = visual;
        report["visual"] = new JsonObject
        {
            ["checkMs"] = ms, ["quotedClasses"] = prediction.QuotedClasses, ["gutters"] = prediction.Gutters, ["listsWithSentinels"] = prediction.ListsWithSentinels,
            ["inferredWidgets"] = prediction.Inferred,
            ["findings"] = new JsonObject(findings.GroupBy(f => f.Code).Select(g => KeyValuePair.Create(g.Key, (JsonNode?)g.Count()))),
        };
        if (findings.Count > 0) ReportVisual(findings, op, report["root"]?.ToString() ?? "", RuntimeDomTable.IsOdc(MessageExpectations.Lane) ? "inferred" : "evidence");
    }

    /// <summary>The visual warnings of this job, one per family (code), in the order they were first found.</summary>
    private readonly Dictionary<string, JsonObject> _visualWarnings = new(StringComparer.Ordinal);
    private readonly HashSet<string> _visualSeen = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<(ScreenVisual.Finding Finding, int? Op)>> _visualFindings = new(StringComparer.Ordinal);

    /// <summary>CX17 7.6: the findings of one document op folded into the job's warnings, one per family, before every other high
    /// warning (the facade keeps the first 10); counts per root, up to 5 examples and the checked patch inside suggestion (the
    /// only object the O11 receipt and the facade keep whole).</summary>
    private void ReportVisual(List<ScreenVisual.Finding> findings, int? op, string root, string runtime)
    {
        foreach (var family in findings.GroupBy(f => f.Code))
        {
            if (!_visualWarnings.TryGetValue(family.Key, out var warning))
            {
                warning = new JsonObject
                {
                    ["code"] = family.Key, ["severity"] = "high", ["op"] = op, ["owner"] = root, ["message"] = "",
                    ["fix"] = VisualFix(family.Key),
                    ["why"] = VisualWhy(family.Key),
                    ["suggestion"] = new JsonObject { ["runtime"] = runtime, ["count"] = 0, ["roots"] = new JsonObject(), ["examples"] = new JsonArray(), ["subjects"] = new JsonArray(), ["patch"] = new JsonArray() },
                };
                _visualWarnings[family.Key] = warning;
                if (!_receipt.TryGetValue("highWarnings", out var list)) _receipt["highWarnings"] = list = new JsonArray();
                list.Insert(_visualWarnings.Count - 1, warning);
            }
            var suggestion = warning["suggestion"]!.AsObject();
            if (runtime == "inferred") suggestion["runtime"] = "inferred";
            // A rule of the theme seen from every page is one finding: counted once, where it was first seen.
            var items = family.Where(f => _visualSeen.Add(f.Code + "|" + f.Kind + "|" + f.Subject + "|" + (f.Sheet == "theme" ? "theme" : f.Root + "|" + f.Line))).ToList();
            if (items.Count == 0) continue;
            suggestion["count"] = suggestion["count"]!.GetValue<int>() + items.Count;
            var roots = suggestion["roots"]!.AsObject();
            roots[root] = (roots[root]?.GetValue<int>() ?? 0) + items.Count;
            var examples = suggestion["examples"]!.AsArray();
            // T18: a rule of a theme names the op of this job that carries it and its real line there (carriedBy).
            foreach (var f in items.Where(f => examples.Count < 5))
                examples.Add(new JsonObject { ["root"] = f.Root, ["line"] = f.Line, ["kind"] = f.Kind, ["subject"] = f.Subject, ["right"] = f.Right, ["why"] = f.Why,
                    ["candidates"] = f.Candidates.Count > 0 ? new JsonArray(f.Candidates.Select(c => (JsonNode)c).ToArray()) : null,
                    ["carriedBy"] = f.Sheet == "theme" && f.RuleText != null && StyleSheetHolding(f.RuleText) is { } carrier
                        ? new JsonObject { ["op"] = carrier.Op, ["pointer"] = carrier.Pointer, ["line"] = carrier.Line } : null });
            // Every finding by its kind and subject (the examples show five with their why).
            var subjects = suggestion["subjects"]!.AsArray();
            foreach (var f in items.Where(_ => subjects.Count < 30)) subjects.Add(f.Kind + ": " + (f.Subject.Length > 90 ? f.Subject[..90] + "…" : f.Subject) + (f.Code is ScreenVisual.TextJoined or ScreenVisual.ListNotLayoutContainer ? $" ({f.Root}:{f.Line})" : ""));
            // The patch of the family again from every finding of the job so far: a rule found from two pages is written once
            // with every selector of both.
            if (!_visualFindings.TryGetValue(family.Key, out var all)) _visualFindings[family.Key] = all = [];
            all.AddRange(items.Select(f => (f, op)));
            var patch = new JsonArray();
            foreach (var edit in VisualEdits(all)) if (!patch.Any(p => p!["find"]?.ToString() == edit["find"]!.ToString() && p!["path"]?.ToString() == edit["path"]?.ToString())) patch.Add(edit);
            suggestion["patch"] = patch;
            var total = suggestion["count"]!.GetValue<int>();
            warning["message"] = VisualMessage(family.Key, total, roots.Count, examples);
        }
    }

    /// <summary>The checked text edits of findings: each rule written once with every selector of it rewritten (and the rule it
    /// needs after it), in the op of this job whose html holds it once; the HTML edits in the document's own op.</summary>
    private IEnumerable<JsonObject> VisualEdits(List<(ScreenVisual.Finding Finding, int? Op)> pairs)
    {
        foreach (var group in pairs.Where(x => x.Finding.RuleText != null && (x.Finding.Right != null && x.Finding.Code == ScreenVisual.SelectorMissesRuntime || x.Finding.Append != null))
                     .GroupBy(x => (x.Finding.RuleText!, x.Finding.Sheet, x.Finding.Sheet == "page" ? x.Op : null)))
        {
            var rule = group.Select(x => x.Finding).ToList();
            var op = group.Key.Item3;
            var text = group.Key.Item1;
            var brace = text.IndexOf('{');
            if (brace < 0) continue;
            var selectors = CssStylesheet.SplitSelectors(text[..brace]).Select(x => x.Trim()).ToList();
            // Each selector of the list rewritten (wrapper, runtime span) or kept with the selector that wins beside it (specificity).
            var replaced = new string?[selectors.Count];
            var added = new List<string>?[selectors.Count];
            foreach (var f in rule.Where(f => f.Right != null && f.Code == ScreenVisual.SelectorMissesRuntime && f.Append == null))
            {
                var i = selectors.FindIndex(x => HtmlNode.CollapseSpaces(x) == HtmlNode.CollapseSpaces(f.Subject));
                if (i < 0) continue;
                if (f.AddSelector) (added[i] ??= []).Add(f.Right!); else replaced[i] ??= f.Right;
            }
            for (var i = 0; i < selectors.Count; i++) selectors[i] = (replaced[i] ?? selectors[i]) + (added[i] is { } extra ? "," + string.Join(",", extra) : "");
            var written = string.Join(",", selectors) + text[brace..];
            var tokens = rule.FirstOrDefault(f => f.Code == ScreenVisual.ThemeTokenScoped);
            foreach (var append in rule.Where(f => f.Append != null && f.Code == ScreenVisual.SelectorMissesRuntime).Select(f => f.Append!).Distinct(StringComparer.Ordinal)) written += "\n" + append;
            var (index, html) = group.Key.Sheet == "page" && op is int own && _applyOps?[own]?["data"]?["html"]?.ToString() is { } page && page.Contains(text, StringComparison.Ordinal) ? (own, page) : OpHolding(text);
            if (index == null)
            {
                // T18: the op of this job that carries the rule in a stylesheet text (a set StyleSheet, a css append): the patch
                // edits that text; the module theme of an earlier delivery gets the css op that changes the cascade. Never a
                // patch that rewrites a rule into itself.
                if (StyleSheetHolding(text) is { } carrier)
                {
                    var carried = tokens != null ? text + "\n" + tokens.Append : written;
                    if (carried != text) yield return new JsonObject { ["op"] = carrier.Op, ["path"] = carrier.Pointer, ["line"] = carrier.Line, ["find"] = text, ["replace"] = carried };
                }
                else if (tokens != null) yield return new JsonObject { ["where"] = "the module theme (an earlier delivery)", ["css"] = new JsonObject { ["edits"] = new JsonArray(new JsonObject { ["append"] = tokens.Append }) } };
                else if (written != text) yield return new JsonObject { ["where"] = "the module theme (an earlier delivery)", ["find"] = text, ["replace"] = written };
                continue;
            }
            if (tokens != null)
            {
                // F5: the declarations again in :root, as a named theme part of the document that declares them (nothing removed).
                var at = html!.IndexOf(text, StringComparison.Ordinal);
                var close = html.IndexOf("</style>", at, StringComparison.Ordinal);
                if (close < 0) continue;
                // The anchor is the end of that <style> (short and unique), the new part right after it.
                var from = close;
                while (from > at && Occurrences(html, html[from..(close + "</style>".Length)]) > 1) from = Math.Max(at, from - 24);
                from = Math.Max(at, from - 24);
                var find = html[from..(close + "</style>".Length)];
                var replace = find + "<style scope=\"theme\" id=\"brand-tokens\">" + tokens.Append + "</style>";
                if (PatchCompiles(html, find, replace, "style:brand-tokens"))
                    yield return new JsonObject { ["op"] = index, ["path"] = $"/ops/{index}/data/html", ["find"] = find, ["replace"] = replace };
            }
            if (written == text || !PatchCompiles(html!, text, written, null)) continue;
            yield return new JsonObject { ["op"] = index, ["path"] = $"/ops/{index}/data/html", ["find"] = text, ["replace"] = written };
        }
        foreach (var (f, at) in pairs.Where(x => x.Finding.Edits.Count > 0))
            if (at is int self && _applyOps?[self]?["data"]?["html"]?.ToString() is { } document)
                foreach (var (find, replace) in f.Edits)
                    if (PatchCompiles(document, find, replace, null))
                        yield return new JsonObject { ["op"] = self, ["path"] = $"/ops/{self}/data/html", ["find"] = find, ["replace"] = replace };
    }

    private static int Occurrences(string text, string part)
    {
        var count = 0;
        for (var i = text.IndexOf(part, StringComparison.Ordinal); i >= 0; i = text.IndexOf(part, i + 1, StringComparison.Ordinal)) count++;
        return count;
    }

    // T18: the op of this job whose stylesheet text (a set StyleSheet value, a css append) holds a rule once, with the pointer
    // of that text and the line of the rule in it.
    private (int Op, string Pointer, int Line)? StyleSheetHolding(string text)
    {
        if (_applyOps == null) return null;
        foreach (var (op, pointer, css) in PreflightRules.StyleSheetRules.Stylesheets(_applyOps))
            if (pointer.EndsWith("/value", StringComparison.Ordinal) || pointer.EndsWith("/append", StringComparison.Ordinal))
                if (css.IndexOf(text, StringComparison.Ordinal) is var at and >= 0 && css.IndexOf(text, at + 1, StringComparison.Ordinal) < 0)
                    return (op, pointer, CssPipeline.LineAt(css, at));
        return null;
    }

    // The op of this job whose html holds a text once (a theme part another document sent), with its html.
    private (int? Index, string? Html) OpHolding(string text)
    {
        if (_applyOps == null) return (null, null);
        for (var i = 0; i < _applyOps.Count; i++)
            if (_applyOps[i]?["data"]?["html"]?.ToString() is { } html && html.IndexOf(text, StringComparison.Ordinal) is var at and >= 0 && html.IndexOf(text, at + 1, StringComparison.Ordinal) < 0)
                return (i, html);
        return (null, null);
    }

    // A patch is offered only when the document it writes parses, keeps one root, and (for a theme part) carries that part.
    private static bool PatchCompiles(string html, string find, string replace, string? part)
    {
        var at = html.IndexOf(find, StringComparison.Ordinal);
        if (at < 0 || html.IndexOf(find, at + 1, StringComparison.Ordinal) >= 0) return false;
        try
        {
            var patched = html[..at] + replace + html[(at + find.Length)..];
            var top = ScreenHtml.Parse(patched).Children.Where(c => !c.IsText).ToList();
            if (top is not [var root] || root.Tag is not ("screen" or "block")) return false;
            if (part != null && !ScreenDocument.ThemeParts(ScreenDocument.Styles(root), root.Get("name") ?? "").Any(p => p.Key == part)) return false;
            return true;
        }
        catch (Exception) { return false; }
    }

    private static string VisualFix(string code) => code switch
    {
        ScreenVisual.SelectorMissesRuntime => "style the runtime element (api --op html, key document.runtime): the suggestion's patch rewrites each selector to the one the predicted runtime DOM matches",
        ScreenVisual.ThemeTokenScoped => "declare the tokens in :root: the suggestion's patch adds <style scope=\"theme\" id=\"brand-tokens\">:root{...}</style> to the document that declares them (the original rule stays)",
        ScreenVisual.TextJoined => "write a space between the two (the space beside an inline element is kept): the suggestion's patch",
        _ => "put list= (and as=) on the grid or flex container itself, so its rows are the layout's items: the suggestion's patch",
    };

    private static string VisualWhy(string code) => code switch
    {
        ScreenVisual.SelectorMissesRuntime => "the runtime renders wrappers and classes the document does not write (span.input-<type>, div.dropdown-container, the span of {{ }}) and OutSystems UI styles its controls with its own selectors",
        ScreenVisual.ThemeTokenScoped => "OutSystems UI reads its tokens from :root; declared in another selector they reach only that subtree",
        ScreenVisual.TextJoined => "two inline elements with no space between show their texts glued",
        _ => "the List is one element between the container and its rows: a grid or flex container sees one item",
    };

    private static string VisualMessage(string code, int count, int roots, JsonArray examples)
    {
        var first = examples.FirstOrDefault()?["subject"]?.ToString() ?? "";
        return code switch
        {
            ScreenVisual.SelectorMissesRuntime => $"{count} selector(s) in {roots} page(s) do not reach the element the runtime publishes (first: {first})",
            ScreenVisual.ThemeTokenScoped => $"OutSystems UI tokens declared outside :root in {count} rule(s) (first: {first})",
            ScreenVisual.TextJoined => $"{count} text(s) in {roots} page(s) glued to their neighbor (first: {first})",
            _ => $"{count} List(s) in {roots} page(s) are the only element of a grid or flex container (first: {first})",
        };
    }

    private readonly HashSet<string> _nativeLayoutChecked = new(StringComparer.Ordinal);

    /// <summary>CX17 review 3, M7: the one resolver of the theme a screen or block shows (its flow's, else the module's default,
    /// the rule of WidenIconTheme): whether the native layout block can reach the page (the theme is of this module: the op
    /// writes the block there) and the author CSS of the chain of this module's themes the page loads, base first (what the
    /// SpacingReader, F1 and the checks of F8 read). A theme of another module is said, never touched.</summary>
    internal ScreenVisual.PageTheme PageThemeOf(IObjectSignature? flow)
    {
        try
        {
            var fromFlow = flow != null ? PrototypeBuilder.Prop(flow, "Theme") as IObjectSignature : null;
            var shown = fromFlow ?? _es.DefaultMobileTheme as IObjectSignature;
            if (shown == null) return ScreenVisual.PageTheme.None;
            var name = TypeResolver.Name(shown);
            var where = fromFlow != null ? $"the theme of the flow {TypeResolver.Name(flow!)}" : "the module's default theme";
            var chain = new List<string>();
            var generatedHalves = new List<string>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            object? local = null;
            for (var at = shown; at != null && seen.Add(at.ObjectKey?.ToString() ?? ""); )
            {
                var theme = _es.MobileThemes.FirstOrDefault(t => t.ObjectKey?.ToString() == at.ObjectKey?.ToString());
                if (theme == null) break;   // a theme of another module: its CSS is not in this capture
                local ??= theme;
                var sheet = ThemeCss.Of(theme);
                chain.Insert(0, (sheet != null ? ThemeCss.Author(sheet) : theme.StyleSheet) ?? "");
                // T18: the Theme Editor half is the installed base: its token rules are the base's own (HTML_THEME_TOKEN_SCOPED).
                if (sheet != null && ThemeCss.IsSplit(sheet)) generatedHalves.Insert(0, sheet.GeneratedEffectiveValue ?? "");
                at = PrototypeBuilder.Prop(theme, "BaseTheme") as IObjectSignature;
            }
            return local != null
                ? new ScreenVisual.PageTheme(name, true, null, chain) { Key = shown.ObjectKey?.ToString(), Base = generatedHalves }
                : new ScreenVisual.PageTheme(name, false, $"{name} ({where}), a theme of another module: the html op never writes it, so no rule of the native layout block reaches the page", chain) { Key = shown.ObjectKey?.ToString() };
        }
        catch (Exception error) { return new ScreenVisual.PageTheme(null, false, "the theme the page shows could not be read: " + Unwrap(error), []); }
    }

    /// <summary>F3/F6: one theme a page shows (PageThemeOf; a block: one theme of the screens that show it, RootThemeOf) carries
    /// the native layout block once (ScreenVisual.NativeLayoutCss, between its own markers; an older version is replaced, never
    /// duplicated; a theme of this module it is based on that has this version already is enough). A theme of another module is
    /// said, never touched: no marker of this op is written for it, and the marked blocks the page places (review 4, N1) or the
    /// pages of the block are named, since their markers have no effect there. The note counts the screens and blocks of the
    /// module that no document of this job wrote (the theme reaches them too).</summary>
    internal JsonObject? InstallNativeLayout(IObjectSignature written, ScreenVisual.PageTheme page, IReadOnlyList<string> pages, IReadOnlyList<(string Name, IReadOnlyList<string> Markers)> blocks)
    {
        try
        {
            if (page.Name == null) return null;
            var key = page.Key ?? page.Name;
            var theme = page.Reachable ? _es.MobileThemes.FirstOrDefault(t => t.ObjectKey?.ToString() == key) : null;
            if (theme == null)
            {
                // Said once per theme, and once per root that carries markers there as a block or through the blocks it places.
                var isBlock = Implements(written, "IMobileBlock");
                if (!_nativeLayoutChecked.Add(key + (isBlock || blocks.Count > 0 ? "|" + written.ObjectKey : ""))) return null;
                var unreached = new JsonObject { ["code"] = ScreenVisual.ThemeNativeLayout, ["theme"] = page.Name, ["written"] = false };
                if (isBlock)
                {
                    unreached["pages"] = new JsonArray(pages.Select(p => (JsonNode)p).ToArray());
                    unreached["note"] = $"the page(s) {string.Join(", ", pages)} that show this block show {page.Why}; the native layout block is not written there and no rule of it reaches them: a marker of this block ({string.Join(", ", ScreenVisual.EngineMarkers)}) has no effect on those pages (its links, buttons and forms keep the runtime's gutter: where a parent has a gap, the gap and the gutter add up)";
                }
                else if (blocks.Count > 0)
                {
                    unreached["blocks"] = new JsonArray(blocks.Select(b => (JsonNode)(b.Name + " (" + string.Join(", ", b.Markers) + ")")).ToArray());
                    unreached["note"] = $"the theme the page shows is {page.Why}; the native layout block is not written and this op writes no marker of it on the page, but the block(s) it places carry markers of earlier html ops ({string.Join("; ", blocks.Select(b => b.Name + ": " + string.Join(", ", b.Markers)))}): they have no effect on this page (their links, buttons and forms keep the runtime's gutter: where a parent has a gap, the gap and the gutter add up)";
                }
                else unreached["note"] = $"the theme the page shows is {page.Why}; the native layout block is not written and no marker of it ({string.Join(", ", ScreenVisual.EngineMarkers)}) is written on the page (its links, buttons and forms keep the runtime's gutter, its layout chain the layout's min-width)";
                return unreached;
            }
            if (!_nativeLayoutChecked.Add(key)) return null;
            var sheet = ThemeCss.Of(theme);
            var author = sheet != null ? ThemeCss.Author(sheet) : theme.StyleSheet ?? "";
            // A theme of this module the shown one is based on that carries this version: the page loads it already.
            if (page.Css.Take(page.Css.Count - 1).Any(css => css.Contains(ScreenVisual.NativeLayoutCss, StringComparison.Ordinal))) return null;
            var css = ScreenVisual.WithNativeLayout(author, out var action);
            if (action == "present") return null;
            if (sheet != null) ThemeCss.WriteAuthor(sheet, css); else theme.StyleSheet = css;
            // Review 2, M4: what the block reaches in the other roots is measured on their markers (ScreenVisual.ReachedRoots: a
            // rule reaches only an element that carries a marker, or the layout chain of a page that holds one), never written.
            var roots = ModuleRoots();
            var others = roots.Where(r => !ReferenceEquals(r, written)).ToList();
            var reached = ScreenVisual.ReachedRoots(new KernelModelReader(), others, roots.Where(r => Implements(r, "IMobileBlock")));
            var note = new JsonObject
            {
                ["code"] = ScreenVisual.ThemeNativeLayout, ["theme"] = TypeResolver.Name(theme), ["written"] = true, ["action"] = action, ["version"] = ScreenVisual.NativeLayoutVersion,
                ["otherRoots"] = others.Count, ["otherRootsAffected"] = reached.Count,
                ["note"] = "the theme carries the native layout block (" + ScreenVisual.NativeLayoutSummary + ")"
                    + "; every rule needs a marker the html op writes on the elements it creates" + (reached.Count == 0
                        ? $", and none of the {others.Count} other screen(s)/block(s) of the module carries one (measured): they keep their CSS"
                        : $": {reached.Count} of the {others.Count} other screen(s)/block(s) of the module carry markers of earlier html ops (otherRootsReached), the block reaches those elements only; the others carry none (measured) and keep their CSS"),
            };
            if (reached.Count > 0) note["otherRootsReached"] = new JsonArray(reached.Take(10).Select(x => (JsonNode)x.ToString()).ToArray());
            return note;
        }
        catch (Exception error) { Note(ScreenVisual.ThemeNativeLayout, $"the native layout block could not be written: {Unwrap(error)}"); return null; }
    }

    // The screens and blocks of the module (every UI flow).
    private List<IObjectSignature> ModuleRoots()
    {
        var roots = new List<IObjectSignature>();
        foreach (var flow in ((IObjectSignature)_espace).Children.OfType<IObjectSignature>().Where(c => Implements(c, "IMobileFlow")))
            foreach (var element in flow.Children.OfType<IObjectSignature>())
                if (Implements(element, "IMobileScreen") || Implements(element, "IMobileBlock")) roots.Add(element);
        return roots;
    }
}
