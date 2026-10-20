using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core;

/// <summary>
/// The native look of the document form of the html op (CX17, the families of the owner's DemoLATAM test of 2026-10-13/14): what
/// the engine decides for a widget the document creates is born right (F2 the class the widget is born with, F1 a List that is
/// part of a table or a grid renders every row, F3/F6 the native layout block of the theme), each write listed in normalized
/// with its code; what is the author's comes as a warning with its checked patch. F2 is one rule in the forms of the language
/// that create a widget (StudioClassOf: the document, the edit forms, the fragment, not the page form; the owner's decision D1
/// of 2026-10-17). One rule per tag, widget type, CSS and runtime table row; nothing keyed on an app, a screen or a class of
/// the author. Every value is deterministic (no layout, no network).
/// </summary>
public static partial class ScreenVisual
{
    // ---- normalized codes (what the engine writes) ----------------------------------------------------------------------
    /// <summary>F2: a new widget without class keeps the class the Studio gives the widget it creates (a control OutSystems UI
    /// styles); the reset to the reading's empty default would publish that class between quotes.</summary>
    public const string StudioClassKept = "STYLE_STUDIO_CLASS_KEPT";
    /// <summary>F2: a new container without class gets the Studio's class without its ornament (a card, a list group's own box):
    /// the class the OutSystems UI rules of the rhythm and of the patterns read stays.</summary>
    public const string StudioClassTrimmed = "STYLE_STUDIO_CLASS_TRIMMED";
    /// <summary>F1: a List that is part of a table (thead, tbody, tfoot), of a list (ul, ol) or of a grid/flex container renders
    /// every row (disable-virtualization True): no virtualization sentinels among its rows.</summary>
    public const string ListRendersAllRows = "LIST_RENDERS_ALL_ROWS";
    /// <summary>F3/F6: the module theme carries the native layout block (between its own markers, once, versioned).</summary>
    public const string ThemeNativeLayout = "THEME_NATIVE_LAYOUT";
    /// <summary>F3 (review 1, A1/M1; review 2, M5): a new link, button or form in a parent that already spaces its items side by
    /// side (a flex or grid parent whose column gap is not 0: SpacingReader) is marked data-ssam-gap: the block zeroes the
    /// runtime's gutter on it only.</summary>
    public const string GutterZeroedInGap = "GUTTER_ZEROED_IN_GAP";
    /// <summary>F3 (review 1, M1): a new link, button or form after a neighbor in a parent with no gap keeps the runtime's
    /// gutter (the only spacing between them, as in the gen-screen's display-flex row of buttons).</summary>
    public const string GutterKept = "GUTTER_KEPT";
    /// <summary>F6 (review 1, A1): the element at the top of a screen the op creates carries data-ssam-page (never one of a block:
    /// a block goes on pages the op did not create).</summary>
    public const string PageMarked = "PAGE_MARKED_FOR_LAYOUT";

    // ---- warnings (what is the author's: one per family per job, with the checked patch) -------------------------------
    public const string SelectorMissesRuntime = "HTML_SELECTOR_MISSES_RUNTIME";
    public const string ThemeTokenScoped = "HTML_THEME_TOKEN_SCOPED";
    public const string TextJoined = "HTML_TEXT_JOINED";
    public const string ListNotLayoutContainer = "HTML_LIST_NOT_LAYOUT_CONTAINER";

    // ---- F2: the class of a widget the document creates without class -----------------------------------------------------

    public enum ClassRule { Kept, Trimmed }

    /// <summary>One widget type of <see cref="PrototypeWidgetDefaults.Table"/> with a class: the class the Studio gives it, the
    /// rule for a new one without class (<see cref="Written"/>: the literal written when the rule trims the Studio's class), and
    /// why (the OutSystems UI rules each class meets, read in the theme of the fixture outsystems-ui.oml, OutSystems UI 2.28.1).</summary>
    public sealed record ClassDecision(string Widget, string StudioClass, ClassRule Rule, string? Written, string Why);

    /// <summary>The decision per widget type (CX17 W2; the evidence is in the report): a control keeps the Studio's class (what a
    /// dragged widget is: the OutSystems UI rules of the control and of the form's rhythm read it); a container keeps the class
    /// the OutSystems UI rules of rhythm and patterns read and loses the ornament the document did not write (.card: a box with
    /// background, border, radius and padding; .list.list-group: overflow hidden and position relative around the rows, which
    /// clips their shadows and makes a box of a table body). The test compares it with PrototypeWidgetDefaults.Table.</summary>
    public static readonly IReadOnlyList<ClassDecision> ClassDecisions =
    [
        new("IButton", "\"btn btn-primary\"", ClassRule.Trimmed, "\"btn\"", ".btn is the button control (display inline-flex, height, border, radius); .btn-primary is the emphasis of the page's main action, which a bare <button> did not ask for (DemoLATAM: the header's Sair took the author's .btn-primary look)"),
        new("IInput", "\"form-control\"", ClassRule.Kept, null, ".form-control[data-input] is the input box (height 40px, padding, border, radius, hover and focus)"),
        new("ITextArea", "\"form-control\"", ClassRule.Kept, null, ".form-control[data-textarea] is the text area box (padding, border, radius)"),
        new("ICheckbox", "\"checkbox\"", ClassRule.Kept, null, "[data-checkbox] and its :before/:after draw the check box whatever its class; the class is the Studio's"),
        new("IDropdown", "\"dropdown\"", ClassRule.Kept, null, ".form .dropdown is the field's rhythm in a form (margin-bottom); the box is .dropdown-container > select.dropdown-display"),
        new("IRadioGroup", "\"radio-group\"", ClassRule.Kept, null, ".radio-group is the group of radio buttons (.form .radio-group)"),
        new("IPopup", "\"popup-dialog\"", ClassRule.Kept, null, ".popup-dialog is the dialog's box (radius, shadow, padding, max-width 500px): without it the popup has no box"),
        new("IForm", "\"form card\"", ClassRule.Trimmed, "\"form\"", ".form is the fields' rhythm (.form label margin-bottom, .form input[data-input]/.dropdown/textarea margin-bottom); .card is a card (background, border, radius, padding) the document did not write"),
        new("ITableRecords", "\"table\"", ClassRule.Kept, null, ".table is the OutSystems UI table (its borders, the cells' padding, the header's weight); a new native Table without class keeps it, and its header and template rows the Studio's classes, as a dragged Table does"),
        new("IList", "\"list list-group\"", ClassRule.Trimmed, "\"list\"", ".list is the hook of the OutSystems UI patterns (gallery, accordion, carousel) and of the author's CSS; .list.list-group is overflow hidden and position relative around the rows, a box of its own in a table body or a grid"),
    ];

    /// <summary>The decision for a widget kind ("Input" or "IInput"), null when the type is born without class.</summary>
    public static ClassDecision? DecisionFor(string kind)
    {
        var type = kind.StartsWith('I') && kind.Length > 1 && char.IsUpper(kind[1]) ? kind : "I" + kind;
        foreach (var d in ClassDecisions) if (d.Widget == type) return d;
        return null;
    }

    /// <summary>What F2 gives one new widget: its code (kept or trimmed), its kind ("Button"), the class expression it reads
    /// with, whether the form writes it (a trim; a kept class is the one the Studio gave the widget it created, nothing to
    /// write) and the note of normalized.</summary>
    public sealed record StudioClass(string Code, string Kind, string Expression, bool Writes, string Note);

    /// <summary>F2, the one rule of the forms of the html op that create a widget (the owner's decision D1 of 2026-10-17: the
    /// document, the edit of a reading in its html, edit and element edits forms, the fragment into a parent; the old page form,
    /// data.screen with data.html and no &lt;screen&gt; root, keeps the class the Studio gives, unsaid): a new widget
    /// without k and without class is born with the class the Studio gives it (<paramref name="born"/>, the expression the
    /// widget the Studio created carries), or with its trimmed form (<see cref="DecisionFor"/>). Null: the kind is born without
    /// class, or the Studio gave this one none (nothing to keep). The caller asks only for a widget without k (an element of a
    /// reading keeps the class it has) whose text writes no class (the author's class always wins).</summary>
    public static StudioClass? StudioClassOf(string kind, string? born)
    {
        if (DecisionFor(kind) is not { } decision) return null;
        var name = decision.Widget[1..];
        var studio = born ?? "";
        if (decision.Rule == ClassRule.Kept)
            return studio.Length == 0 ? null : new(StudioClassKept, name, studio, false,
                $"a new {name} without class keeps the class the Studio gives it ({studio}; reset to the empty default the runtime publishes it between quotes): {decision.Why}; the reading writes it as class=\"{studio.Trim('"')}\"");
        return new(StudioClassTrimmed, name, decision.Written!, true,
            $"a new {name} without class gets {decision.Written} (the Studio gives it {studio}; reset to the empty default the runtime publishes it between quotes): {decision.Why}; the reading writes it as class=\"{decision.Written!.Trim('"')}\"");
    }

    /// <summary>The normalized entry of F2 in a form's answer, one per code and kind (the same in each form): <paramref name="line"/>
    /// counted on it (the first ten kept). Answers the entry when this call created it (the caller lists it once).</summary>
    public static JsonObject? CountStudioClass(IDictionary<string, JsonObject> notes, StudioClass outcome, JsonNode line)
    {
        var key = outcome.Code + "|" + outcome.Kind;
        JsonObject? created = null;
        if (!notes.TryGetValue(key, out var note))
            notes[key] = note = created = new JsonObject { ["code"] = outcome.Code, ["element"] = outcome.Kind, ["count"] = 0, ["lines"] = new JsonArray(), ["note"] = outcome.Note };
        note["count"] = note["count"]!.GetValue<int>() + 1;
        if (note["lines"]!.AsArray().Count < 10) note["lines"]!.AsArray().Add(line);
        return created;
    }

    // ---- F1: a List that is part of a table, a list or a layout container -------------------------------------------------

    /// <summary>The tags of a List that is a part of a table or of an HTML list: its rows are the table's or the list's rows.</summary>
    public static readonly IReadOnlySet<string> RowGroupTags = new HashSet<string>(StringComparer.Ordinal) { "thead", "tbody", "tfoot", "ul", "ol" };

    /// <summary>The tags of a List that is a part of a table: the native layout block lays it out as the table's row group
    /// (its rule is written from this list, <see cref="NativeLayoutCss"/>).</summary>
    public static readonly IReadOnlyList<string> TablePartTags = ["thead", "tbody", "tfoot"];

    /// <summary>The value of a marker of the native layout block (an extended property, an attribute at runtime).</summary>
    public const string MarkerValue = "\"1\"";

    /// <summary>F1 where no document is compiled (the prototype importer, round 6 of fix/data-table): why a List of this tag renders
    /// every row and carries the rows marker, the html op's reason (<see cref="AllRowsReason"/>), or null when the List is no part
    /// of a table. Only a table part: the block lays out nothing else, and an HTML list or a layout container of a prototype keeps
    /// the CSS its prototype gave it.</summary>
    public static string? TablePartReason(string tag) => TablePartTags.Contains(tag) ? AllRowsReason(tag, null, []) : null;

    /// <summary>The note of F1 (LIST_RENDERS_ALL_ROWS), the same in the html op and the importer.</summary>
    public static string AllRowsNote(string why) =>
        $"disable-virtualization = True and {RowsMarker}: the List renders every row, no virtualization sentinels among the rows; the native layout block lays a table part out as a row group ({why})";

    /// <summary>The display values that make the children of an element its layout items.</summary>
    private static readonly Regex LayoutDisplay = new(@"^\s*(inline-)?(grid|flex)\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>Whether a declaration value of display makes a grid or flex container.</summary>
    public static bool IsLayoutDisplay(string? value) => value != null && LayoutDisplay.IsMatch(value);

    /// <summary>Why a new List renders every row (F1), null when it does not: its tag is a row group or a list, or a rule of
    /// the page or the theme gives its own element display grid/flex (matched on the author's DOM).</summary>
    public static string? AllRowsReason(string tag, DomNode? authorElement, IReadOnlyList<CssRule> rules)
    {
        if (RowGroupTags.Contains(tag)) return $"<{tag} list>: its rows are the rows of the {(tag is "ul" or "ol" ? "list" : "table")}";
        if (authorElement == null) return null;
        foreach (var rule in rules)
        {
            if (!rule.Declarations.Any(d => d.Property.Equals("display", StringComparison.OrdinalIgnoreCase) && IsLayoutDisplay(d.Value))) continue;
            if (SafeMatches(authorElement, rule.Selector))
                return $"{rule.Selector} gives the List display {rule.Declarations.Last(d => d.Property.Equals("display", StringComparison.OrdinalIgnoreCase)).Value.Trim()}: its rows are the layout's items";
        }
        return null;
    }

    internal static bool SafeMatches(DomNode element, string selector)
    {
        try { return CssSelectors.Matches(element, selector); }
        catch (Exception) { return false; }
    }

    /// <summary>The style rules of CSS texts (lenient: what does not parse is left out), in order.</summary>
    public static List<CssRule> RulesOf(IEnumerable<string?> sheets)
    {
        var rules = new List<CssRule>();
        foreach (var css in sheets)
        {
            if (string.IsNullOrWhiteSpace(css)) continue;
            try { rules.AddRange(CssStylesheet.Parse(css, lenient: true).Rules); }
            catch (Exception) { /* a sheet the parser does not read: its rules are not judged */ }
        }
        return rules;
    }

    // ---- F3/F6: the native layout block of the theme -------------------------------------------------------------------------

    internal const string NativeLayoutBegin = "/* ssam:native-layout */", NativeLayoutEnd = "/* /ssam:native-layout */";

    /// <summary>The version of the block's content: a theme with another version gets this one (replaced, never duplicated).</summary>
    public const string NativeLayoutVersion = "3";

    /// <summary>The markers the html op writes on the elements it creates (extended properties, attributes at runtime); every
    /// rule of the block needs one, so a screen or block the op did not create keeps its CSS (review 1, A1). Only the engine writes
    /// them: an author's is refused (ScreenVisual.AuthorMarkers, review 2, M4). The prototype importer writes the rows marker on
    /// the List of a table part it creates, with the block in the import's theme (TablePartReason, round 6 of fix/data-table).</summary>
    public const string PageMarker = "data-ssam-page", GapMarker = "data-ssam-gap", RowsMarker = "data-ssam-rows";

    /// <summary>What the block does, for the note.</summary>
    public const string NativeLayoutSummary = "on the elements the html op marked only: the runtime's gutter zeroed on a new link, button or form whose parent already spaces its items (data-ssam-gap), min-width 0 on the layout chain of a screen the op created (data-ssam-page, never in a block), a table body List of the op laid out as a row group (data-ssam-rows)";

    /// <summary>The CSS of the native layout block (CX17 W4, review 1), measured on the OutSystems UI 2.28.1 theme of the fixture
    /// outsystems-ui.oml and on the DOM the runtime published (DemoLATAM_UI, 2026-10-14). Every selector needs a marker the html
    /// op wrote on an element it created, so the module's other screens (made in the Studio, imported, generated) keep their CSS:
    /// <list type="bullet">
    /// <item>F3: <c>ThemeGrid_MarginGutter</c> (the runtime's gutter on a link, button or form after a neighbor; no rule in OutSystems
    /// UI) zeroed only on a new widget whose parent already has a gap (<c>data-ssam-gap</c>); in a parent with no gap (the
    /// gen-screen's display-flex row of buttons) the gutter is the only spacing and stays (GUTTER_KEPT);</item>
    /// <item>F6: <c>.layout</c> is a row flex box whose items keep min-width auto; min-width 0 only on the chain of a page that holds
    /// an element of the op (<c>:has([data-ssam-page])</c>; a block of the op carries none, it goes on pages the op did not create);</item>
    /// <item>F1: a List of the op rendered as a table part is a row group again at auto width, and the sentinels of its disabled
    /// virtualization never lay out (their display is an inline style of the runtime: only !important passes)
    /// (<c>data-ssam-rows</c>).</item>
    /// </list></summary>
    public static string NativeLayoutCss => NativeLayoutBegin + "\n/* version " + NativeLayoutVersion + ", written by the html op (CX17); replaced whole, never by hand; every rule needs a data-ssam-* marker of the op */\n"
        + "[" + GapMarker + "].ThemeGrid_MarginGutter{margin-left:0}\n"
        + ".layout :is(.main,.content,.main-content):has([" + PageMarker + "]){min-width:0}\n"
        + ":is(" + string.Join(",", TablePartTags) + ")[" + RowsMarker + "]{display:table-row-group;width:auto}\n"
        + "[" + RowsMarker + "]>script{display:none!important}\n"
        + NativeLayoutEnd;
    /// <summary>The author CSS of a theme with the native layout block of this version: appended once ("added"), an older block
    /// replaced in place ("replaced"), or the CSS as it is ("present").</summary>
    public static string WithNativeLayout(string author, out string action)
    {
        var begin = author.IndexOf(NativeLayoutBegin, StringComparison.Ordinal);
        if (begin >= 0)
        {
            var end = author.IndexOf(NativeLayoutEnd, begin, StringComparison.Ordinal);
            if (end >= 0)
            {
                end += NativeLayoutEnd.Length;
                if (author[begin..end] == NativeLayoutCss) { action = "present"; return author; }
                action = "replaced";
                return author[..begin] + NativeLayoutCss + author[end..];
            }
        }
        action = "added";
        return (author.TrimEnd().Length > 0 ? author.TrimEnd() + "\n\n" : "") + NativeLayoutCss + "\n";
    }

    // ---- the author's DOM: the document as the browser of the author would build it ------------------------------------

    /// <summary>The document as a DOM of the author (tags and attributes as written, text as text), each element mapped to its
    /// node of the document. &lt;style&gt; and the data elements are left out.</summary>
    public static DomNode AuthorDom(ScreenHtml.Node top, Dictionary<ScreenHtml.Node, DomNode> map)
    {
        var fragment = DomNode.Fragment();
        void Walk(ScreenHtml.Node node, DomNode parent)
        {
            foreach (var child in node.Children)
            {
                if (child.IsText) { if (child.Text!.Length > 0) parent.Add(DomNode.TextNode(child.Text)); continue; }
                if (child.Tag is "style" or "var" or "input" && child.Get("name") != null && child.Get("type") != null && node == top) continue;
                if (child.Tag is "style" or "aggregate" or "data-action" or "event") continue;
                var element = DomNode.Element(child.Tag);
                foreach (var (name, value) in child.Attributes) element.Attributes.Add((name, value));
                parent.Add(element);
                map[child] = element;
                Walk(child, element);
            }
        }
        var root = fragment.Add(DomNode.Element(top.Tag));
        map[top] = root;
        Walk(top, root);
        return fragment;
    }
}
