using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects. F8 (the owner's report of 2026-10-25: in every screen with a table the header spreads over the
// table and the rows are packed at the left): a List of a table part renders as that part in every form that writes it. Here the
// edit forms over the reader contract and the reading's note for a table List that renders as a div. A data table (one header row
// of <th>, one template row of <td> over a list) is the native Table of the line (ScreenHtmlTables.NativeTable) and is not this
// rule: these tables are HTML Elements of a reading (their parts keyed) or have no header row.
public sealed partial class ScreenHtmlEditTests
{
    // A screen with two tables of the reading whose Lists render wrong (Tag tbody, Mode Default, virtualization on), as the
    // deliveries of 2026-10-25 left them, and a container outside them.
    private static Node TablesModule()
    {
        keys = 0;
        var module = N("ESpace", "Shop");
        var screen = module.Add(N("MobileFlow", "MainFlow")).Add(N("MobileScreen", "Clients"));
        screen.Add(W("Container", "Intro")).Set("Style", new Code("\"intro\""));
        foreach (var name in new[] { "Clients", "Orders" }) {
            var table = screen.Add(W("AdvancedHtml")).Set("Tag", "table");
            var head = table.Add(W("AdvancedHtml")).Set("Tag", "thead").Add(W("AdvancedHtml")).Set("Tag", "tr");
            head.Add(W("AdvancedHtml")).Set("Tag", "th").Add(W("TextWidget")).Set("Text", "Name");
            var rows = table.Add(W("List", name + "List")).Set("Tag", "tbody").Set("Style", new Code("\"list\"")).Set("Source", new Code("Get" + name + ".List"));
            rows.Add(W("AdvancedHtml")).Set("Tag", "tr").Add(W("AdvancedHtml")).Set("Tag", "td").Add(W("Expression")).Set("Value", new Code("Get" + name + ".List.Current.Name"));
        }
        return module;
    }

    private static readonly ScreenVisual.PageTheme ThemeOfThisModule = new("ShopTheme", true, null, []);
    private static readonly ScreenVisual.PageTheme ThemeOfAnotherModule = new("OutSystemsUI", false, "OutSystemsUI (the module's default theme), a theme of another module", []);

    private static (ScreenHtmlEditResult Result, string After) ApplyWith(Node module, IReadOnlyList<string> edits, ScreenVisual.PageTheme theme, string target = "Clients")
    {
        var (reading, document) = Read(module, target);
        var plan = reading.Edit(document, edits, "/edit", theme);
        if (!plan.Refused) plan.Apply(new Writer());
        if (!plan.Refused) plan.Verify(reading.Refresh(document.RootKey).Read(target));
        return (plan.Result, ScreenHtml.Module(module, new Reader()).Read(target).Html);
    }

    private static string TableOf(string html, int index)
    {
        var lines = html.Split('\n');
        var starts = lines.Select((l, i) => (l, i)).Where(x => x.l.TrimStart().StartsWith("<table", StringComparison.Ordinal)).Select(x => x.i).ToList();
        var from = starts[index];
        var to = Array.FindIndex(lines, from, l => l.TrimStart().StartsWith("</table>", StringComparison.Ordinal));
        return string.Join("\n", lines[from..(to + 1)].Select(l => l.Trim())) + "\n";
    }

    private static JsonArray NotesOf(ScreenHtmlDocument document) => document.Json()["notes"]?.AsArray() ?? [];
    private static JsonArray TablesOf(ScreenHtmlEditResult result) => result.Json()["visual"]?["tables"]?.AsArray() ?? [];

    [Fact]
    public void TheReadingSaysEveryTableListThatRendersAsADivWithTheEditThatRepairsIt()
    {
        var (_, document) = Read(TablesModule(), "Clients");
        var notes = NotesOf(document);
        Assert.Equal(2, notes.Count);
        foreach (var note in notes) {
            Assert.Equal("HTML_TABLE_LIST_VIRTUALIZED", note!["code"]!.ToString());
            Assert.Equal("tbody", note["tag"]!.ToString());
            Assert.Contains("Mode Default", note["message"]!.ToString());
            var set = note["edit"]!["edits"]![0]!.AsObject();
            Assert.Equal(note["k"]!.ToString(), set["set"]!.ToString());
            Assert.Equal("Custom", set["attributes"]!["os-Mode"]!.ToString());
            Assert.Equal("{{ True }}", set["attributes"]!["disable-virtualization"]!.ToString());
        }
    }

    [Fact]
    public void ANewTableBodyOfAnEditIsModeCustomRendersEveryRowAndCarriesTheRowsMarkerWhereTheThemeIsThisModules()
    {
        // The table of the reading with a <tbody list> written new (no header row: an HTML table, not the native Table).
        var module = TablesModule();
        var (_, document) = Read(module, "Clients");
        var table = TableOf(document.Html, 0);
        var k = table.Split('\n')[0].Split('"')[1];
        var edited = "<table k=\"" + k + "\" class=\"\">\n"
            + "<tbody list=\"GetClients.List\"><tr><td>{{ GetClients.List.Current.Name }}</td><td>{{ GetClients.List.Current.Mail }}</td></tr></tbody>\n</table>\n";
        var (result, after) = ApplyWith(module, [edited], ThemeOfThisModule);
        Assert.False(result.Refused, Codes(result));
        var body = after.Split('\n').Single(l => l.Contains("<tbody", StringComparison.Ordinal) && l.Contains("GetClients", StringComparison.Ordinal)).Trim();
        Assert.Contains("os-Mode=\"Custom\"", body);
        Assert.Contains("disable-virtualization=\"{{ True }}\"", body);
        Assert.Contains("data-ssam-rows=\"1\"", body);
        Assert.Contains("class=\"\"", body);                       // F2: no .list on a table part (the decision of TableListClass)
        Assert.DoesNotContain("ext:style", body);
        Assert.Contains(result.Normalized, n => n["code"]?.ToString() == "LIST_MODE_CUSTOM");
        Assert.Contains(result.Normalized, n => n["code"]?.ToString() == "LIST_RENDERS_ALL_ROWS");
        var entry = Assert.Single(TablesOf(result))!;
        Assert.Equal("tbody", entry["tag"]!.ToString());
        Assert.Equal("data-ssam-rows", entry["markers"]![0]!.ToString());
        Assert.Contains("native layout block", entry["rule"]!.ToString());
        // The other table is not touched by the edit: it keeps what it had (and its note).
        var (_, again) = Read(module, "Clients");
        Assert.Single(NotesOf(again));
        // The edited text reads back (the plan's own check passed) and a second edit of the same text changes nothing.
        var (second, _) = ApplyWith(module, [TableOf(again.Html, 0)], ThemeOfThisModule);
        Assert.False(second.Refused, Codes(second));
        Assert.Empty(TablesOf(second));
    }

    [Fact]
    public void WhereTheThemeIsAnotherModulesTheTableBodyGetsItsDisplayInline()
    {
        var module = TablesModule();
        var (_, document) = Read(module, "Clients");
        var k = TableOf(document.Html, 0).Split('\n')[0].Split('"')[1];
        var edited = "<table k=\"" + k + "\">\n<tbody list=\"GetClients.List\"><tr><td>{{ GetClients.List.Current.Name }}</td></tr></tbody>\n</table>\n";
        var (result, after) = ApplyWith(module, [edited], ThemeOfAnotherModule);
        Assert.False(result.Refused, Codes(result));
        var body = after.Split('\n').Single(l => l.Contains("<tbody", StringComparison.Ordinal) && l.Contains("GetClients", StringComparison.Ordinal)).Trim();
        Assert.Contains("os-Mode=\"Custom\"", body);
        Assert.Contains("disable-virtualization=\"{{ True }}\"", body);
        Assert.Contains("ext:style=\"display:table-row-group\"", body);
        Assert.DoesNotContain("data-ssam-rows", body);             // no block reaches this page: no marker without effect
        var entry = Assert.Single(TablesOf(result))!;
        Assert.Empty(entry["markers"]!.AsArray());
        Assert.Contains("inline style", entry["rule"]!.ToString());
    }

    [Fact]
    public void AnEditThatTouchesATableRepairsItsListAndSaysItAnEditElsewhereLeavesTheListsAsTheyAre()
    {
        var module = TablesModule();
        var (_, document) = Read(module, "Clients");
        // Only the header cell of the second table changes.
        var th = document.Html.Split('\n').Where(l => l.TrimStart().StartsWith("<th ", StringComparison.Ordinal)).ElementAt(1).Trim();
        var (result, after) = ApplyWith(module, [th.Replace(">Name<", ">Order<", StringComparison.Ordinal)], ThemeOfThisModule);
        Assert.False(result.Refused, Codes(result));
        var repaired = Assert.Single(result.Normalized, n => n["code"]?.ToString() == "TABLE_LIST_REPAIRED");
        Assert.Equal(1, repaired["count"]!.GetValue<int>());
        var orders = TableOf(after, 1);
        Assert.True(orders.Contains("os-Mode=\"Custom\"", StringComparison.Ordinal), after);
        Assert.Contains("data-ssam-rows=\"1\"", orders);
        Assert.Contains("class=\"list\"", orders, StringComparison.Ordinal);   // an element of the reading keeps its class
        Assert.DoesNotContain("os-Mode", TableOf(after, 0));        // the table the edit did not touch keeps what it had
        Assert.Single(NotesOf(Read(module, "Clients").Document));
        // An edit of the container outside the tables repairs nothing.
        var (_, now) = Read(module, "Clients");
        var intro = now.Html.Split('\n').First(l => l.Contains("class=\"intro\"", StringComparison.Ordinal)).Trim();
        var (outside, _) = ApplyWith(module, [intro.Replace("intro", "intro wide", StringComparison.Ordinal)], ThemeOfThisModule);
        Assert.False(outside.Refused, Codes(outside));
        Assert.Empty(TablesOf(outside));
        Assert.DoesNotContain(outside.Normalized, n => n["code"]?.ToString() == "TABLE_LIST_REPAIRED");
    }

    [Fact]
    public void ANewListOfAnyElementButADivIsModeCustom()
    {
        // F8: a List renders its Tag only in Mode Custom (both Studios: "Default mode sets tag as div"); a <ul list> written new
        // in an edit is Mode Custom, a <div list> keeps Mode Default.
        var module = TablesModule();
        var (_, document) = Read(module, "Clients");
        var intro = document.Html.Split('\n').First(l => l.Contains("class=\"intro\"", StringComparison.Ordinal)).Trim();
        var edited = intro.Replace("/>", "><ul list=\"GetClients.List\"><li>{{ GetClients.List.Current.Name }}</li></ul><div list=\"GetClients.List\"><span>{{ GetClients.List.Current.Name }}</span></div></div>", StringComparison.Ordinal);
        Assert.NotEqual(intro, edited);
        var (result, after) = ApplyWith(module, [edited], ThemeOfThisModule);
        Assert.False(result.Refused, Codes(result));
        var ul = after.Split('\n').Single(l => l.TrimStart().StartsWith("<ul", StringComparison.Ordinal)).Trim();
        Assert.Contains("os-Mode=\"Custom\"", ul);
        var div = after.Split('\n').Single(l => l.TrimStart().StartsWith("<div", StringComparison.Ordinal) && l.Contains("list=", StringComparison.Ordinal)).Trim();
        Assert.DoesNotContain("os-Mode", div);
        Assert.Contains(result.Normalized, n => n["code"]?.ToString() == "LIST_MODE_CUSTOM");
    }
}

public sealed partial class ScreenHtmlEditTests
{
    // The delivery of 2026-10-25 (task 309723dc, Clientes): <tbody><tr list> with the cells of a record, Tag tr and Mode Default.
    private static Node RowListModule()
    {
        keys = 0;
        var module = N("ESpace", "Shop");
        var screen = module.Add(N("MobileFlow", "MainFlow")).Add(N("MobileScreen", "Clients"));
        var table = screen.Add(W("AdvancedHtml")).Set("Tag", "table");
        table.Add(W("AdvancedHtml")).Set("Tag", "thead").Add(W("AdvancedHtml")).Set("Tag", "tr").Add(W("AdvancedHtml")).Set("Tag", "th").Add(W("TextWidget")).Set("Text", "Name");
        var body = table.Add(W("AdvancedHtml")).Set("Tag", "tbody");
        var rows = body.Add(W("List", "ClientsList")).Set("Tag", "tr").Set("Style", new Code("\"list\"")).Set("Source", new Code("GetClients.List"));
        rows.Add(W("AdvancedHtml")).Set("Tag", "td").Add(W("Expression")).Set("Value", new Code("GetClients.List.Current.Name"));
        return module;
    }

    [Fact]
    public void ATrListOfCellsInATableTheEditTouchesBecomesTheListOfItsRowGroupAndKeepsItsKey()
    {
        var module = RowListModule();
        var list = AllNodes(module).Single(n => n.Kind == "List");
        var (_, document) = Read(module, "Clients");
        var th = document.Html.Split('\n').First(l => l.TrimStart().StartsWith("<th ", StringComparison.Ordinal)).Trim();
        var (result, after) = ApplyWith(module, [th.Replace(">Name<", ">Client<", StringComparison.Ordinal)], ThemeOfThisModule);
        Assert.False(result.Refused, Codes(result));
        Assert.Contains(result.Normalized, n => n["code"]?.ToString() == "TABLE_ROW_LIST_LIFTED");
        // The List is the same object, now the row group: Tag tbody, Mode Custom, every row; the row is an element inside it.
        Assert.Same(list, AllNodes(module).Single(n => n.Kind == "List"));
        Assert.Equal("tbody", list.Props["Tag"]);
        Assert.Contains("Custom", list.Props["Mode"]?.ToString());   // the test model keeps it as an expression
        var lines = after.Split('\n').Select(l => l.Trim()).ToList();
        var bodyAt = lines.FindIndex(l => l.StartsWith("<tbody", StringComparison.Ordinal));
        Assert.Contains("list=\"GetClients.List\"", lines[bodyAt]);
        Assert.Contains("data-ssam-rows=\"1\"", lines[bodyAt]);
        Assert.StartsWith("<tr", lines[bodyAt + 1]);
        Assert.DoesNotContain("list=", lines[bodyAt + 1]);
        // Review W3-EDIT, 3: the Studio's class of the List (list) is not carried to each row, and the note says it.
        Assert.DoesNotContain("class=\"list\"", lines[bodyAt + 1]);
        Assert.Contains(result.Normalized, n => n["code"]?.ToString() == "TABLE_ROW_LIST_LIFTED" && n["classDropped"] is JsonArray { Count: 1 });
        Assert.StartsWith("<td", lines[bodyAt + 2]);
        Assert.Empty(NotesOf(Read(module, "Clients").Document));
    }

    private static IEnumerable<Node> AllNodes(Node node) { foreach (var c in node.Children) { yield return c; foreach (var d in AllNodes(c)) yield return d; } }
}
