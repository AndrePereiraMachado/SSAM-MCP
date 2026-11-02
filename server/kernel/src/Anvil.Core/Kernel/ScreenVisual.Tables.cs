using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core;

/// <summary>
/// F8 (the owner's report of 2026-10-25, "in every screen with a table, the header spreads over the table and the rows are
/// packed at the left"): a List that is a part of a table (thead, tbody, tfoot, tr) renders as that part, whatever form of the
/// html op wrote it and whatever theme the page shows. One rule, in one place, that the document form, the edit forms (html,
/// edit, edits), the fragment and the reading call:
/// <list type="bullet">
/// <item>Mode = Custom: the List renders its Tag only in Mode Custom (the ListDescriptor of both Studios: "Set to Custom to define
/// a custom HTML tag to be used by the widget in runtime. Default mode sets tag as div", and Tag is read-only in Default). In
/// Mode Default the runtime publishes &lt;div data-list&gt; inside the &lt;table&gt;: the browser boxes the div in an anonymous
/// cell of the first column, so the rows lay out in a table of their own inside that cell, and the header's first column
/// takes all their width (the deliveries of 2026-10-25: every SSAM List of a table had Tag tbody or tr and Mode Default; the
/// DemoLATAM tables, imported with Mode Custom, published &lt;tbody data-list&gt;);</item>
/// <item>disable-virtualization = True (F1): no virtualization sentinels and no measured positions among the rows;</item>
/// <item>the display of the table part reaches the page: the native layout block of the theme the page shows (data-ssam-rows,
/// a selector that wins over one or two classes of an imported theme, .list{display:flex} of the Atlas prototype included),
/// or, where that theme is not this module's (the op never writes it), the List's own inline style;</item>
/// <item>no class "list" (F2): .list is the hook of the OutSystems UI patterns (gallery, accordion, carousel, wizard: none is a
/// table part) and of the lists of an author's CSS, which a table body is not.</item>
/// </list>
/// </summary>
public static partial class ScreenVisual
{
    /// <summary>normalized: a List of a table part (or of any element but a div) is Mode Custom, so the runtime renders its Tag.</summary>
    public const string ListModeCustom = "LIST_MODE_CUSTOM";
    /// <summary>normalized: an element of a reading that is a List of a table part, repaired by an edit that touches its table.</summary>
    public const string TableListRepaired = "TABLE_LIST_REPAIRED";
    /// <summary>The note of a reading: a List of a table part that renders as a div or with virtualization (an edit repairs it).</summary>
    public const string TableListVirtualized = ScreenHtmlTableLists.Note;

    /// <summary>The attribute of the List's Mode in the text (the reading writes os-Mode="Custom"; Default is not written).</summary>
    public const string ModeAttribute = ScreenHtmlTableLists.ModeAttribute;
    public const string CustomMode = ScreenHtmlTableLists.CustomMode;
    public const string VirtualizationAttribute = ScreenHtmlTableLists.VirtualizationAttribute;
    /// <summary>The inline style of a List in the text: its extended property style (the style attribute is CustomStyle, which a
    /// List does not have).</summary>
    public const string InlineStyleAttribute = "ext:style";

    /// <summary>The tags of a List that is a part of a table.</summary>
    public static IReadOnlySet<string> TablePartTags => ScreenHtmlTableLists.Tags;

    public static bool IsTablePart(string? tag) => ScreenHtmlTableLists.IsTablePart(tag);

    /// <summary>The display a table part has in the browser's own sheet (what the block and the inline style give it back).</summary>
    public static string? TableDisplayOf(string? tag) => tag switch
    {
        "thead" => "table-header-group",
        "tbody" => "table-row-group",
        "tfoot" => "table-footer-group",
        "tr" => "table-row",
        _ => null,
    };

    /// <summary>The class a new List of a table part is born with (F2): none, the empty literal (never the reset to the empty
    /// default, which publishes the Studio's class between quotes).</summary>
    public const string TableListClass = "\"\"";
    public const string TableListClassWhy = ".list is the hook of the OutSystems UI patterns (gallery, accordion, carousel, wizard), none of them a table part, and of the lists of an author's CSS (the Atlas prototype: .list{display:flex;flex-direction:column}), which would lay the rows out as a column of boxes; .list.list-group makes a box of the table body";

    /// <summary>The rules of the native layout block for the Lists of a table part (data-ssam-rows): each part its own display
    /// at auto width. The marker is written twice in each selector, (0,2,1): it wins over one or two classes of any theme
    /// (.list{display:flex}, .panel .list, .list.list-group) whatever the order, and loses to the OutSystems UI responsive table
    /// of a phone or a tablet (.phone .layout:not(.layout-native) .table:not(.table-no-responsive) tbody, (0,5,1)), the stacked
    /// table its author asked for with class="table".</summary>
    public static string TableRowsCss => string.Concat(TablePartTags.Order(StringComparer.Ordinal).Select(tag =>
        $"{tag}[{RowsMarker}][{RowsMarker}]{{display:{TableDisplayOf(tag)};width:auto}}\n"));

    /// <summary>Whether a List with this Tag needs Mode Custom to render it (any element but the runtime's div).</summary>
    public static bool NeedsCustomMode(string? tag) => !string.IsNullOrEmpty(tag) && !tag.Equals("div", StringComparison.OrdinalIgnoreCase);

    /// <summary>The List's tag as the text writes it: the element, or the tag of &lt;list tag&gt;.</summary>
    public static string ListTagOf(ScreenHtml.Node node) => node.Tag == "list" ? node.Get("tag") ?? "" : node.Tag;

    /// <summary>Whether a value of disable-virtualization is true ("{{ True }}", "True").</summary>
    public static bool IsTrue(string? value) => ScreenHtmlTableLists.IsTrue(value);

    private static readonly Regex DisplayDeclaration = new(@"(^|;)\s*display\s*:", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>The inline style of a List of a table part whose page shows no native layout block: the author's style with the
    /// display of the part after it; null when the author's style already says a display (the author's wins) or the tag is not
    /// a table part. Inline, it wins over every rule of a theme that is not !important.</summary>
    public static string? InlineRowsStyle(string tag, string? author)
    {
        if (TableDisplayOf(tag) is not { } display) return null;
        var css = (author ?? "").Trim();
        if (DisplayDeclaration.IsMatch(css)) return null;
        return (css.Length > 0 ? css.TrimEnd(';').TrimEnd() + ";" : "") + "display:" + display;
    }

    /// <summary>What a List of a table part needs that its element in the text does not say: the attributes to write (name, value
    /// as the text writes it) and the words of each. The rows marker where the theme the page shows carries the native layout
    /// block (<paramref name="reachable"/>), else the inline style. Null: not a List of a table part, or nothing is missing.</summary>
    public sealed record TableListNeeds(string Tag, IReadOnlyList<KeyValuePair<string, string>> Attributes, IReadOnlyList<string> Says, string Rule);

    public static TableListNeeds? TableListOf(ScreenHtml.Node node, bool reachable)
    {
        if (node.IsText || node.Get("list") == null) return null;
        var tag = ListTagOf(node);
        if (!IsTablePart(tag)) return null;
        var attributes = new List<KeyValuePair<string, string>>(node.Attributes);
        var says = new List<string>();
        void Put(string name, string value, string why)
        {
            var at = attributes.FindIndex(a => a.Key.Equals(name, StringComparison.OrdinalIgnoreCase) || a.Key.Equals("ext:" + name, StringComparison.OrdinalIgnoreCase));
            if (at >= 0) attributes[at] = new(attributes[at].Key, value); else attributes.Add(new(name, value));
            says.Add(why);
        }
        if (node.Get(ModeAttribute) != CustomMode)
            Put(ModeAttribute, CustomMode, $"Mode Custom (in Mode {(node.Get(ModeAttribute) is { Length: > 0 } m ? m : "Default")} the runtime renders the List as a div inside the table, not as its <{tag}>)");
        var virtualization = node.Attributes.FirstOrDefault(a => a.Key is VirtualizationAttribute or "ext:" + VirtualizationAttribute);
        if (virtualization.Key == null || !IsTrue(virtualization.Value))
            Put(VirtualizationAttribute, "{{ True }}", "disable-virtualization True (no virtualization sentinels nor measured positions among the rows)");
        string rule;
        if (reachable)
        {
            rule = "theme";
            if (!CarriesMarker(node, RowsMarker)) Put(RowsMarker, "1", $"{RowsMarker} (the native layout block of the theme gives it display {TableDisplayOf(tag)})");
        }
        else
        {
            // The List has no CustomStyle: its inline style is the extended property style, which the text writes ext:style.
            var author = node.Get(InlineStyleAttribute);
            var inline = InlineRowsStyle(tag, author);
            rule = inline != null ? "inline" : author is { Length: > 0 } ? "author" : "inline";
            if (inline != null) Put(InlineStyleAttribute, inline, $"style display:{TableDisplayOf(tag)} (the theme the page shows is not this module's: no native layout block reaches the page)");
        }
        return says.Count == 0 ? null : new TableListNeeds(tag, attributes, says, rule);
    }

    /// <summary>The entry of a table List in the receipt (visual.tables[]): where it is, what it has and where the display rule is.</summary>
    public static JsonObject TableEntry(string root, string list, string tag, bool rowsMarker, string rule, string? theme, IEnumerable<string> says) => new()
    {
        ["screen"] = root, ["list"] = list, ["tag"] = tag, ["mode"] = CustomMode, ["virtualization"] = "disabled",
        ["markers"] = new JsonArray(rowsMarker ? [(JsonNode)RowsMarker] : []),
        ["display"] = TableDisplayOf(tag),
        ["rule"] = rule switch
        {
            "theme" => $"the native layout block of {theme ?? "the theme"} (version {NativeLayoutVersion})",
            "inline" => "the List's inline style (the theme the page shows is not this module's)",
            "author" => "the author's inline style (it says a display of its own)",
            _ => rule,
        },
        ["wrote"] = new JsonArray(says.Select(s => (JsonNode)s).ToArray()),
    };

    /// <summary>The note of a reading for a List of a table part that is not Mode Custom or renders with virtualization, with the
    /// element edit that repairs it (the edit forms then write what it misses, the rows marker or the inline style included).</summary>
    public static JsonObject TableListNote(string k, string tag, bool custom, bool allRows) => ScreenHtmlTableLists.NoteOf(k, tag, custom, allRows);

    /// <summary>The parts of the native Tables under <paramref name="root"/> (ScreenHtmlTables.NativeTable: a data table, one header
    /// row of &lt;th&gt; and one template row of &lt;td&gt; over a list on the table, its tbody or its row): the native Table renders every
    /// row as the platform's table, so its list is no List of a table part and this rule never touches it.</summary>
    public static HashSet<ScreenHtml.Node> NativeTableParts(ScreenHtml.Node root)
    {
        var parts = new HashSet<ScreenHtml.Node>(ReferenceEqualityComparer.Instance);
        foreach (var (node, _) in ScreenHtmlText.Elements(root))
            if (node.Tag == "table" && ScreenHtmlTables.NativeTable(node) is { } table)
                parts.UnionWith([table.Table, table.Head, table.HeadRow, table.Body, table.BodyRow]);
        return parts;
    }

    // ---- a <tr list> whose cells are the record's: the List is the row group ------------------------------------------------

    /// <summary>normalized: a &lt;tr list&gt; that is the only row of its &lt;tbody&gt; (or a row of the &lt;table&gt;), whose children are
    /// cells, written as the List of the row group: &lt;tbody list&gt;&lt;tr&gt;cells&lt;/tr&gt;&lt;/tbody&gt;. A List repeats its content inside its
    /// own element: a List of a tr is one row with the cells of every record, never a row per record (two of the three deliveries
    /// of 2026-10-25 wrote it; in Mode Default it was a div in the tbody, in Mode Custom one long row).</summary>
    public const string RowListLifted = "TABLE_ROW_LIST_LIFTED";

    /// <summary>The attributes of a &lt;tr list&gt; that are the List's (they go to the row group): its key, source and row name, its
    /// name, the properties written os-*, and what the engine writes on a table List; the rest (class, events) stay on the row.</summary>
    private static bool ListAttribute(string name) => name is "k" or "list" or "as" or "id" or "name" or VirtualizationAttribute or "ext:" + VirtualizationAttribute or InlineStyleAttribute
        || name.StartsWith("os-", StringComparison.Ordinal) || MarkerOf(name) != null;

    /// <summary>Lifts every &lt;tr list&gt; of <paramref name="root"/> that <paramref name="eligible"/> accepts, whose children are cells
    /// (td, th) and that is the only element of a &lt;tbody&gt; without list (the tbody becomes the List, with the row's key: the List
    /// keeps its ObjectKey, its Tag becomes tbody) or a row of the &lt;table&gt; itself (a new &lt;tbody&gt; becomes the List). Answers the
    /// rows lifted (the row, the row group that is now the List).</summary>
    public sealed record LiftedRow(ScreenHtml.Node Row, ScreenHtml.Node Body, string? ClassDropped, string? ClassOnRow);

    /// <summary>The classes the Studio gives a List (F2's decision, list and list-group): on a lifted &lt;tr&gt; of the reading they are
    /// the List's, never the row's (.list{display:flex} of an imported theme would make every row a column of boxes).</summary>
    private static readonly HashSet<string> StudioListClasses = new(StringComparer.Ordinal) { "list", "list-group" };

    public static List<LiftedRow> LiftRowLists(ScreenHtml.Node root, Func<ScreenHtml.Node, bool> eligible)
    {
        var lifted = new List<LiftedRow>();
        var native = NativeTableParts(root);
        foreach (var (row, parent) in ScreenHtmlText.Elements(root).ToList())
        {
            if (parent == null || row.Tag != "tr" || row.Get("list") == null || native.Contains(row) || !eligible(row)) continue;
            var elements = row.Children.Where(c => !c.IsText).ToList();
            if (elements.Count == 0 || elements.Any(c => c.Tag is not ("td" or "th"))) continue;
            ScreenHtml.Node body;
            if (parent.Tag == "tbody")
            {
                if (parent.Get("list") != null || parent.Children.Count(c => !c.IsText) != 1) continue;
                body = parent;
                body.Attributes.RemoveAll(a => a.Key == "k");   // the row group of the reading goes; the List keeps its key
            }
            else if (parent.Tag == "table")
            {
                body = new ScreenHtml.Node { Tag = "tbody", Line = row.Line, Column = row.Column };
                parent.Children[parent.Children.IndexOf(row)] = body;
                body.Children.Add(row);
            }
            else continue;
            var ofReading = row.Get("k") != null;   // the List of a reading (its key goes to the row group)
            var moved = row.Attributes.Where(a => ListAttribute(a.Key)).ToList();
            row.Attributes.RemoveAll(a => ListAttribute(a.Key));
            // Review W3-EDIT, 3: the class of the List of a reading is the List's: the Studio's (list, list-group) leaves the row and
            // the row group is a table part without class (TableListClass); the author's other classes stay on the row, said.
            string? dropped = null;
            if (ofReading && row.Get("class") is { } classes && !classes.Contains("{{", StringComparison.Ordinal))
            {
                var tokens = classes.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                var studio = tokens.Where(StudioListClasses.Contains).ToList();
                if (studio.Count > 0)
                {
                    dropped = string.Join(" ", studio);
                    var rest = tokens.Where(t => !StudioListClasses.Contains(t)).ToList();
                    row.Attributes.RemoveAll(a => a.Key == "class");
                    if (rest.Count > 0) row.Attributes.Add(new("class", string.Join(" ", rest)));
                    moved.Add(new("class", ""));
                }
            }
            body.Attributes.InsertRange(0, moved);
            lifted.Add(new LiftedRow(row, body, dropped, row.Get("class") is { Length: > 0 } onRow ? onRow : null));
        }
        return lifted;
    }

    /// <summary>What the lift did with the classes of a row (TABLE_ROW_LIST_LIFTED): the Studio's class of a List it dropped
    /// (classDropped, the row group then has class "") and the author's class that is the row's now (classMovedToRow).</summary>
    public static void SayLiftedClasses(JsonObject note, string where, string? dropped, string? onRow)
    {
        if (dropped != null)
            ((note["classDropped"] ??= new JsonArray()) as JsonArray)!.Add(where + ": " + dropped + " (the Studio's class of a List; the row group is a table part without class, TableListClass)");
        if (onRow != null)
            ((note["classMovedToRow"] ??= new JsonArray()) as JsonArray)!.Add(where + ": class=\"" + onRow + "\" stays on the <tr> of each record");
    }

    internal static string Line(ScreenHtml.Node node) => node.Line.ToString(CultureInfo.InvariantCulture);
}
