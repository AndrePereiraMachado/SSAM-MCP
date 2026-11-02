using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked into both test projects. F8: the rule of a List of a table part (ScreenVisual.Tables) without a module, and the proof by
// the cascade of the kernel (ScreenVisual.SpacingReader, CssSelectors) that the table body of the runtime's DOM is a row group
// under the sheets of the delivery of 2026-10-25 (OutSystems UI 2.30.0, the Atlas theme imported from the prototype, the
// prototype's own sheet with .list{display:flex}). The real sheets are read from SSAM_F8_SHEETS_DIR (osui.css, atlas-theme.css,
// prototype.css: copies outside the repository); without it the rules of those sheets that reach a table are given inline.
public sealed class ScreenVisualTableTests(ITestOutputHelper output)
{
    // The rules of the three sheets that reach a table, a list or the List's element (verbatim).
    private const string OsuiRules = ".list.list-group{overflow:hidden;position:relative}"
        + ".phone .layout:not(.layout-native) .table:not(.table-no-responsive) tbody,.tablet .layout:not(.layout-native) .table:not(.table-no-responsive) tbody{display:block}";
    private const string AtlasThemeRules = "table{width:100%;border-collapse:collapse;white-space:nowrap}th{text-align:left}td{padding:14px 22px}";
    private const string PrototypeRules = ".list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.5rem}.list li{display:flex}";

    [Fact]
    public void AListOfATablePartIsBornWithoutTheListClassAnyOtherListKeepsTheTrim()
    {
        var table = ScreenVisual.StudioClassOf("List", "\"list list-group\"", "tbody")!;
        Assert.Equal(ScreenVisual.TableListClass, table.Expression);
        Assert.Equal("\"\"", table.Expression);
        Assert.True(table.Writes);
        // The decision (TableListClassWhy): .list is the hook of patterns that are never a table part, and of the lists of an
        // author's CSS that would lay the rows out as a column (the Atlas prototype); a div, a ul keep the trimmed "list".
        Assert.Equal("\"list\"", ScreenVisual.StudioClassOf("List", "\"list list-group\"", "div")!.Expression);
        Assert.Equal("\"list\"", ScreenVisual.StudioClassOf("List", "\"list list-group\"", "ul")!.Expression);
        Assert.Equal("\"list\"", ScreenVisual.StudioClassOf("List", "\"list list-group\"")!.Expression);
        foreach (var tag in new[] { "thead", "tbody", "tfoot", "tr" }) Assert.True(ScreenVisual.IsTablePart(tag));
        Assert.False(ScreenVisual.NeedsCustomMode("div"));
        Assert.True(ScreenVisual.NeedsCustomMode("tbody"));
        Assert.True(ScreenVisual.NeedsCustomMode("ul"));
    }

    [Fact]
    public void WhatATableListNeedsIsModeCustomAllItsRowsAndItsDisplayByTheBlockOrInline()
    {
        ScreenHtml.Node Element(string html) => ScreenHtml.Parse(html).Children.First(c => !c.IsText);
        var bare = ScreenVisual.TableListOf(Element("<tbody list=\"R\"></tbody>"), reachable: true)!;
        Assert.Equal(["list", "os-Mode", "disable-virtualization", "data-ssam-rows"], bare.Attributes.Select(a => a.Key));
        Assert.Equal(["R", "Custom", "{{ True }}", "1"], bare.Attributes.Select(a => a.Value));
        Assert.Equal("theme", bare.Rule);
        var foreign = ScreenVisual.TableListOf(Element("<tbody list=\"R\"></tbody>"), reachable: false)!;
        Assert.Equal(["list", "os-Mode", "disable-virtualization", "ext:style"], foreign.Attributes.Select(a => a.Key));
        Assert.Equal("display:table-row-group", foreign.Attributes.Last().Value);
        Assert.Equal("inline", foreign.Rule);
        // The author's inline style is kept, the display after it; one that says a display wins.
        Assert.Equal("color:red;display:table-row", ScreenVisual.TableListOf(Element("<tr list=\"R\" ext:style=\"color:red;\"></tr>"), false)!.Attributes.Single(a => a.Key == "ext:style").Value);
        var author = ScreenVisual.TableListOf(Element("<tbody list=\"R\" ext:style=\"display:block\"></tbody>"), false)!;
        Assert.Equal("author", author.Rule);
        Assert.Equal("display:block", author.Attributes.Single(a => a.Key == "ext:style").Value);
        // Nothing missing: nothing to write; not a table part, or not a List: not this rule.
        Assert.Null(ScreenVisual.TableListOf(Element("<tbody list=\"R\" os-Mode=\"Custom\" disable-virtualization=\"{{ True }}\" data-ssam-rows=\"1\"></tbody>"), true));
        Assert.Null(ScreenVisual.TableListOf(Element("<ul list=\"R\"></ul>"), true));
        Assert.Null(ScreenVisual.TableListOf(Element("<tbody></tbody>"), true));
        // <list tag="tbody">: the same List.
        Assert.Equal("tbody", ScreenVisual.TableListOf(Element("<list list=\"R\" tag=\"tbody\"></list>"), true)!.Tag);
    }

    [Fact]
    public void TheRowsRulesOfTheBlockWinOverTheClassesOfAThemeAndLeaveTheResponsiveTableOfOutSystemsUi()
    {
        var rules = ScreenVisual.RulesOf([ScreenVisual.NativeLayoutCss]);
        foreach (var tag in ScreenVisual.TablePartTags)
        {
            var rule = Assert.Single(rules, r => r.Selector.StartsWith(tag + "[", StringComparison.Ordinal));
            Assert.Contains(rule.Declarations, d => d.Property == "display" && d.Value.Trim() == ScreenVisual.TableDisplayOf(tag));
            var specificity = CssSelectors.Specificity(rule.Selector);
            Assert.Equal((0, 2, 1), specificity);
            foreach (var theirs in new[] { ".list", ".list.list-group", ".panel .list", ".table tbody", "table tbody" })
                Assert.True(specificity.CompareTo(CssSelectors.Specificity(theirs)) > 0, rule.Selector + " over " + theirs);
            Assert.True(specificity.CompareTo(CssSelectors.Specificity(".phone .layout:not(.layout-native) .table:not(.table-no-responsive) tbody")) < 0);
        }
        Assert.Contains("version " + ScreenVisual.NativeLayoutVersion, ScreenVisual.NativeLayoutCss);
        Assert.Equal("5", ScreenVisual.NativeLayoutVersion);   // the line's 4 was another block (the proto's 4 is this one): 5 tells them apart
    }

    // The DOM the runtime publishes for the table of Clientes: in Mode Custom a <tbody data-list> (DemoLATAM, 2026-10-14) with the
    // rows marker and its two sentinels (display flex inline), in Mode Default a <div data-list> in the table.
    private static (DomNode Body, DomNode Sentinel) RuntimeTable(bool custom, string classes, bool marker)
    {
        var fragment = DomNode.Fragment();
        var layout = fragment.Add(DomNode.Element("div"));
        layout.SetAttr("class", "layout layout-side");
        var content = layout.Add(DomNode.Element("div"));
        content.SetAttr("class", "main-content");
        var table = content.Add(DomNode.Element("table"));
        table.Add(DomNode.Element("thead")).Add(DomNode.Element("tr")).Add(DomNode.Element("th")).Add(DomNode.TextNode("Nome"));
        var body = table.Add(DomNode.Element(custom ? "tbody" : "div"));
        body.SetAttr("data-list", "");
        body.SetAttr("class", classes);
        if (marker) body.SetAttr(ScreenVisual.RowsMarker, "1");
        var sentinel = body.Add(DomNode.Element("script"));
        sentinel.SetAttr("style", "display: flex; height: 0px; width: 100%;");
        body.Add(DomNode.Element("tr")).Add(DomNode.Element("td")).Add(DomNode.TextNode("Cliente"));
        return (body, sentinel);
    }

    private IReadOnlyList<(string Where, string? Css)> Sheets(bool block)
    {
        var dir = Environment.GetEnvironmentVariable("SSAM_F8_SHEETS_DIR");
        string Of(string file, string fallback)
        {
            var path = dir is { Length: > 0 } ? Path.Combine(dir, file) : null;
            if (path != null && File.Exists(path)) { output.WriteLine($"{file}: {new FileInfo(path).Length} bytes from {dir}"); return File.ReadAllText(path); }
            return fallback;
        }
        var theme = Of("atlas-theme.css", AtlasThemeRules);
        return [("OutSystems UI", Of("osui.css", OsuiRules)), ("AtlasTheme", block ? ScreenVisual.WithNativeLayout(theme, out _) : theme), ("the prototype's sheet", Of("prototype.css", PrototypeRules))];
    }

    [Fact]
    public void ByTheCascadeTheTableBodyIsARowGroupUnderOutSystemsUiTheAtlasThemeAndThePrototypesListRule()
    {
        // After F8: Mode Custom (a tbody), the rows marker, the block in the theme. Even with the class "list" a List of the
        // reading still has (the prototype's .list{display:flex} reaches it) the block's rule wins; the sentinels never lay out.
        foreach (var classes in new[] { "OSFillParent", "list OSFillParent" })
        {
            var (body, sentinel) = RuntimeTable(custom: true, classes, marker: true);
            var reader = new ScreenVisual.SpacingReader(Sheets(block: true));
            var display = reader.Of(body).Always;
            output.WriteLine($"after, class=\"{classes}\": tbody {display.Describe()}; sentinel {reader.Of(sentinel).Always.Describe()}");
            Assert.Equal("table-row-group", display.Display);
            Assert.Equal("none", reader.Of(sentinel).Always.Display);
        }
        // Before F8 (the delivery of 2026-10-25): Mode Default, a div in the table, with the class "list": under the prototype's
        // sheet a column flex box, under the others a block. Either way not a part of the table: its rows lay out apart.
        var (before, _) = RuntimeTable(custom: false, "list OSFillParent", marker: false);
        var then = new ScreenVisual.SpacingReader(Sheets(block: false)).Of(before).Always;
        output.WriteLine($"before: <{before.Tag}> {then.Describe()}");
        Assert.Equal("div", before.Tag);
        Assert.NotEqual("table-row-group", then.Display);
        // A theme of another module (no block): the inline display of the List wins over the prototype's .list.
        var (inline, _) = RuntimeTable(custom: true, "list OSFillParent", marker: false);
        inline.SetAttr("style", ScreenVisual.InlineRowsStyle("tbody", null)!);
        Assert.Equal("table-row-group", new ScreenVisual.SpacingReader(Sheets(block: false)).Of(inline).Always.Display);
    }
}

public sealed class ScreenVisualRowListTests
{
    private static string Lift(string html, Func<ScreenHtml.Node, bool>? eligible = null)
    {
        var document = ScreenHtml.Parse(html);
        var lifted = ScreenVisual.LiftRowLists(document, eligible ?? (_ => true));
        return lifted.Count + ":" + ScreenHtmlText.Write(document).Replace("\n", "").Replace(" ", "");
    }

    [Fact]
    public void ATrListOfCellsIsTheListOfItsRowGroupOtherRowsAreNot()
    {
        // The only row of a tbody: the tbody is the List (the row's key, source and name go with it; its class stays on the row).
        Assert.Equal("1:<table><tbodyk=\"w2\"list=\"R\"id=\"Rows\"class=\"x\"><trclass=\"row\"><td>a</td></tr></tbody></table>",
            Lift("<table><tbody class=\"x\" k=\"w1\"><tr k=\"w2\" list=\"R\" id=\"Rows\" class=\"row\"><td>a</td></tr></tbody></table>"));
        // A row of the table itself: a new tbody is the List.
        Assert.Equal("1:<table><thead><tr><th>A</th></tr></thead><tbodylist=\"R\"><tr><td>a</td></tr></tbody></table>",
            Lift("<table><thead><tr><th>A</th></tr></thead><tr list=\"R\"><td>a</td></tr></table>"));
        // Not lifted: a header row of dynamic cells, a tbody with another row, a row with other content, one not eligible.
        Assert.StartsWith("0:", Lift("<table><thead><tr list=\"C\"><th>a</th></tr></thead></table>"));
        Assert.StartsWith("0:", Lift("<table><tbody><tr list=\"R\"><td>a</td></tr><tr><td>total</td></tr></tbody></table>"));
        Assert.StartsWith("0:", Lift("<table><tbody><tr list=\"R\"><td>a</td><div>x</div></tr></tbody></table>"));
        Assert.StartsWith("0:", Lift("<table><tbody><tr list=\"R\"><td>a</td></tr></tbody></table>", _ => false));
        Assert.StartsWith("0:", Lift("<table><tbody list=\"S\"><tr list=\"R\"><td>a</td></tr></tbody></table>"));
        // The native Table (a header row and one template row over the list) is no List: its row stays where the author put it.
        Assert.StartsWith("0:", Lift("<table><thead><tr><th>A</th></tr></thead><tbody><tr list=\"R\"><td>a</td></tr></tbody></table>"));
    }
}
