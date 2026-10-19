using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked into both test projects: a data table (a <table> with one header row of <th> and one template row of <td> over a list)
// is the native Table widget in O11 and ODC, one column per field, its header cell and its row cell in the same column; a list
// that is no table (cards) stays a List; the reading gives back the <table> and the fixed point holds (the owner's VpBookings
// bug of 2026-10-18: a loose header row plus a List of side-by-side fields).
public static class DataTableNativeCases
{
    public static readonly string[] Headers = ["Activity", "Contact", "People", "Hours", "Cost", "State", "Actions"];

    // Two data tables, one per form the documents use (the repeated rows on the <tbody>, the gen-screen's and the feature
    // generator's form with the List's own attributes; the repeated row on the <tr>), and a card list.
    public const string Document = "<screen name=\"DataTables\" actions=\"Choose\">\n<var name=\"Rows\" type=\"Text List\"/>\n<var name=\"Picked\" type=\"Text\"/>\n"
        + "<table class=\"dt-table\"><thead><tr><th>Activity</th><th>Contact</th><th>People</th><th>Hours</th><th>Cost</th><th>State</th><th>Actions</th></tr></thead>\n"
        + "<tbody list=\"Rows\" os-Mode=\"Custom\" disable-virtualization=\"{{ True }}\"><tr><td>{{ Rows.Current }}</td><td>{{ ToUpper(Rows.Current) }}</td><td>{{ Length(Rows.Current) }}</td>"
        + "<td>{{ Length(Rows.Current) * 2 }}</td><td>{{ Length(Rows.Current) * 30 }}</td><td>{{ If(Length(Rows.Current) > 3, \"Long\", \"Short\") }}</td>"
        + "<td><button onclick=\"Choose(Item = Rows.Current)\">Select</button></td></tr></tbody></table>\n"
        + "<table><thead><tr class=\"dt-head\"><th>Activity</th><th>Contact</th><th>People</th><th>Hours</th><th>Cost</th><th>State</th><th>Actions</th></tr></thead>\n"
        + "<tbody><tr list=\"Rows\"><td>{{ Rows.Current }}</td><td>{{ ToUpper(Rows.Current) }}</td><td>{{ Length(Rows.Current) }}</td>"
        + "<td>{{ Length(Rows.Current) * 2 }}</td><td>{{ Length(Rows.Current) * 30 }}</td><td>{{ If(Length(Rows.Current) > 3, \"Long\", \"Short\") }}</td>"
        + "<td><button onclick=\"Choose(Item = Rows.Current)\">Select</button></td></tr></tbody></table>\n"
        + "<div class=\"dt-cards\" list=\"Rows\"><article class=\"dt-card\"><h3>{{ Rows.Current }}</h3><button onclick=\"Choose(Item = Rows.Current)\">Open</button></article></div>\n"
        + "</screen>";

    public static JsonArray Ops() => new(
        new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = Document } },
        new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("action DataTables.Choose\n  in Item: Text\n  assign\n    Picked = Item\n  end\n") } });

    /// <summary>The shape rules, without a module: the three forms of a data table are the native Table, their cells its header
    /// and row cells; a table without a header row, an HTML table without a list and a card list are not.</summary>
    public static void Shapes()
    {
        var top = ScreenHtml.Parse(Document).Children.First(c => !c.IsText);
        var tables = Elements(top).Where(n => n.Tag == "table").ToList();
        Assert.Equal(2, tables.Count);
        foreach (var table in tables)
        {
            Assert.Equal("TableRecords", ScreenHtmlTables.KindOf(table, out _));
            Assert.All(Elements(table).Where(n => n.Tag == "th"), th => Assert.Equal("HeaderCell", ScreenHtmlTables.KindOf(th, out _)));
            Assert.All(Elements(table).Where(n => n.Tag == "td"), td => Assert.Equal("RowCell", ScreenHtmlTables.KindOf(td, out _)));
            Assert.Equal(7, Elements(table).Count(n => n.Tag == "th"));
            Assert.Equal(7, Elements(table).Count(n => n.Tag == "td"));
        }
        Assert.Equal("List", ScreenHtmlTables.KindOf(Elements(top).Single(n => n.Tag == "div" && n.Get("list") != null), out _));
        // The list on the table itself (the reading's form) is the same Table.
        var reading = ScreenHtml.Parse("<screen name=\"S\"><table list=\"Rows\"><thead><tr><th>A</th></tr></thead><tbody><tr><td>{{ Rows.Current }}</td></tr></tbody></table></screen>");
        Assert.Equal("TableRecords", ScreenHtmlTables.KindOf(Elements(reading).Single(n => n.Tag == "table"), out _));
        // Not data tables: no header row (the rows of a table body, F1), no list (an HTML table), an HTML table of a reading
        // (its parts carry their own k).
        foreach (var html in new[] {
            "<screen name=\"S\"><table><tbody list=\"Rows\"><tr><td>{{ Rows.Current }}</td></tr></tbody></table></screen>",
            "<screen name=\"S\"><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>a</td></tr></tbody></table></screen>",
            "<screen name=\"S\"><table k=\"w1\"><thead k=\"w2\"><tr k=\"w3\"><th k=\"w4\">A</th></tr></thead><tbody k=\"w5\" list=\"Rows\"><tr k=\"w6\"><td k=\"w7\">a</td></tr></tbody></table></screen>" })
        {
            var doc = ScreenHtml.Parse(html);
            Assert.Equal("AdvancedHtml", ScreenHtmlTables.KindOf(Elements(doc).Single(n => n.Tag == "table"), out _));
            Assert.All(Elements(doc).Where(n => n.Tag is "th" or "td"), cell => Assert.Equal("AdvancedHtml", ScreenHtmlTables.KindOf(cell, out _)));
        }
    }

    // A screen with the old form of a data table (HTML Elements and a List, as be5d1d89 compiled it: <table html> keeps the HTML
    // Element), inside a container, and a box beside it.
    private const string OldDocument = "<screen name=\"DataTables\" actions=\"Choose\">\n<var name=\"Rows\" type=\"Text List\"/>\n<var name=\"Picked\" type=\"Text\"/>\n"
        + "<div class=\"wrap\"><table html=\"\" class=\"old\"><thead html=\"\"><tr html=\"\"><th html=\"\">Activity</th><th html=\"\">Contact</th></tr></thead>"
        + "<tbody list=\"Rows\" disable-virtualization=\"{{ True }}\"><tr html=\"\"><td html=\"\">{{ Rows.Current }}</td><td html=\"\">{{ ToUpper(Rows.Current) }}</td></tr></tbody></table></div>\n"
        + "<div class=\"box\"><p>Box</p></div>\n</screen>";
    private const string NewTable = "<table class=\"added\"><thead><tr><th>Item</th><th>Size</th></tr></thead><tbody list=\"Rows\"><tr><td>{{ Rows.Current }}</td><td>{{ Length(Rows.Current) }}</td></tr></tbody></table>";

    private static JsonObject Run(ModelHost host, string? basePath, string fixture, JsonArray ops, JsonArray? expected, string dir, out string outPath)
    {
        Directory.CreateDirectory(dir);
        var job = new JsonObject { ["ops"] = ops };
        if (basePath == null) job["base"] = fixture;
        if (expected != null) job["expectedMessages"] = expected.DeepClone();
        var jobPath = Path.Combine(dir, "job.json");
        File.WriteAllText(jobPath, job.ToJsonString());
        outPath = Path.Combine(dir, "out.oml");
        try { return JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, outPath))!.AsObject(); }
        catch (Exception error) { return new JsonObject { ["accepted"] = false, ["error"] = Errors.Text(error), ["problems"] = Errors.FindCoded(error)?.Problems?.DeepClone() }; }
    }

    private static int Count(ModelHost host, string oml, string kind)
    {
        var screen = host.ReadModel(oml, "/", new ReadingOptions(Kind: "MobileScreen", Name: "DataTables", Max: 5))["entries"]!.AsArray().Single()!["reference"]!.ToString();
        return host.ReadModel(oml, screen, new ReadingOptions(Kind: kind, Max: 1))["count"]!.GetValue<int>();
    }

    private static void StripKeys(ScreenHtml.Node node)
    {
        node.Attributes.RemoveAll(a => a.Key == "k" || a.Key.StartsWith("data-ssam-", StringComparison.Ordinal));
        foreach (var child in node.Children) if (!child.IsText) StripKeys(child);
    }

    /// <summary>B1 of the review of round 1, over a fixture: an edit of an existing screen writes a new data table (the native
    /// Table, its rows kept); and the old form of a table (HTML Elements and a List), rewritten without its k and with the class
    /// the Studio gave its List, becomes the native Table (the repair of VpBookings). Each reads back at the fixed point.</summary>
    public static void Edits(ITestOutputHelper output, string fixture, JsonArray? expected, string work)
    {
        var host = new ModelHost(Path.Combine(work, "host"));
        var compiled = Run(host, null, fixture, new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = OldDocument } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("action DataTables.Choose\n  end\n") } }), expected, Path.Combine(work, "base"), out var basePath);
        Assert.True(compiled["accepted"]!.GetValue<bool>(), compiled.ToJsonString()[..Math.Min(3000, compiled.ToJsonString().Length)]);
        Assert.Equal(0, Count(host, basePath, "TableRecords"));
        Assert.Equal(1, Count(host, basePath, "List"));
        var bytes = File.ReadAllBytes(basePath);
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        var read = host.HtmlRead(bytes, "MobileScreen:DataTables", withKeys: false)["documents"]![0]!;
        var html = read["html"]!.ToString();
        output.WriteLine(html);
        JsonObject Edit(string name, ScreenHtml.Node element, out string outPath) => Run(host, basePath, fixture, new JsonArray(new JsonObject
        {
            ["op"] = "html", ["data"] = new JsonObject
            {
                ["screen"] = "DataTables", ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = read["htmlSha256"]!.DeepClone() },
                ["edit"] = new JsonArray(ScreenHtmlText.Write(element)),
            },
        }), expected, Path.Combine(work, name), out outPath);
        void ReadsBack(string oml, int tables)
        {
            var text = host.HtmlRead(File.ReadAllBytes(oml), "MobileScreen:DataTables", withKeys: false)["documents"]![0]!["html"]!.ToString();
            output.WriteLine(text);
            Assert.Equal(tables, Elements(ScreenHtml.Parse(text)).Count(n => n.Tag == "table" && n.Get("list") != null));
            var check = host.HtmlCheck(File.ReadAllBytes(oml))["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == "DataTables")!;
            Assert.Equal(0, check["problemCount"]!.GetValue<int>());
            Assert.Equal(0, check["ops"]!.GetValue<int>());
        }
        // 1: a new data table in the box.
        {
            var tree = ScreenHtml.Parse(html);
            var box = Elements(tree).Single(n => n.Tag == "div" && n.Get("class") == "box");
            box.Children.Add(ScreenHtml.Parse(NewTable).Children[0]);
            var result = Edit("edit-new-table", box, out var outPath);
            Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString()[..Math.Min(3000, result.ToJsonString().Length)]);
            Assert.Equal(1, Count(host, outPath, "TableRecords"));
            Assert.Equal(2, Count(host, outPath, "HeaderCell"));
            Assert.Equal(2, Count(host, outPath, "RowCell"));
            ReadsBack(outPath, 1);
        }
        // 2: the old table rewritten without its k (and the engine's markers), the List's class left on its tbody.
        {
            var tree = ScreenHtml.Parse(html);
            var wrap = Elements(tree).Single(n => n.Tag == "div" && n.Get("class") == "wrap");
            foreach (var child in wrap.Children.Where(c => !c.IsText)) StripKeys(child);
            var table = Elements(wrap).Single(n => n.Tag == "table");
            table.Attributes.RemoveAll(a => a.Key == "html");
            foreach (var part in Elements(table)) part.Attributes.RemoveAll(a => a.Key == "html");
            Assert.Contains(Elements(table), n => n.Tag == "tbody" && n.Get("class") == "list");
            var result = Edit("edit-old-table", wrap, out var outPath);
            Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString()[..Math.Min(3000, result.ToJsonString().Length)]);
            Assert.Equal(1, Count(host, outPath, "TableRecords"));
            Assert.Equal(0, Count(host, outPath, "List"));
            ReadsBack(outPath, 1);
            // L1 of the review of round 2: what the List of the old form wrote and the Table leaves out is said, never in silence.
            var edit = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().First(r => r["mode"]?.ToString() == "edit");
            var note = Assert.Single((edit["normalized"] as JsonArray ?? []).OfType<JsonObject>(), n => n["code"]?.ToString() == "TABLE_NATIVE");
            Assert.Contains("class list", note["note"]!.ToString());
            Assert.Contains("disable-virtualization", note["note"]!.ToString());
            Assert.Contains("of the List left out", note["note"]!.ToString());
        }
    }

    // A screen with a native Table of three columns and two boxes beside it (the base of the review of round 2).
    private const string RulesDocument = "<screen name=\"DataTables\" actions=\"Choose\">\n<var name=\"Rows\" type=\"Text List\"/>\n<var name=\"Picked\" type=\"Text\"/>\n"
        + "<table class=\"dt-table\"><thead><tr><th>Activity</th><th>Contact</th><th>People</th></tr></thead>\n"
        + "<tbody list=\"Rows\"><tr><td>{{ Rows.Current }}</td><td>{{ ToUpper(Rows.Current) }}</td><td><button onclick=\"Choose(Item = Rows.Current)\">Select</button></td></tr></tbody></table>\n"
        + "<div class=\"box\"><p>Box</p></div>\n<div class=\"other\"><p>Other</p></div>\n</screen>";
    private const string StaticTable = "<table class=\"second-op\"><tbody><tr><th>Name</th><td>{{ Picked }}</td></tr><tr><th>Size</th><td>{{ Length(Picked) }}</td></tr></tbody></table>";

    // Every refusal of a job's answer (objects with a code and a message, nested or not).
    private static List<JsonObject> Problems(JsonObject result)
    {
        var list = new List<JsonObject>();
        void Walk(JsonNode? n)
        {
            if (n is JsonObject o) { if (o["code"] is JsonValue && o["message"] != null && (o["severity"] != null || o["fix"] != null)) list.Add(o); foreach (var (_, v) in o) Walk(v); }
            else if (n is JsonArray a) foreach (var x in a) Walk(x);
        }
        Walk(result["problems"]);
        return list;
    }

    // The job with a refusal's patch applied (its replace of the op's edit list).
    private static JsonArray Patched(JsonArray ops, JsonObject problem)
    {
        var copy = ops.DeepClone().AsArray();
        foreach (var step in problem["patch"]!.AsArray().OfType<JsonObject>())
        {
            Assert.Equal("replace", step["op"]!.ToString());
            var path = step["path"]!.ToString().Split('/').Skip(1).ToList();   // /ops/<i>/data/<form>
            Assert.Equal("ops", path[0]);
            copy[int.Parse(path[1], CultureInfo.InvariantCulture)]![path[2]]![path[3]] = step["value"]!.DeepClone();
        }
        return copy;
    }

    /// <summary>The review of round 2 over a fixture. B1: two html ops of one job on one screen, the second writing a static table of
    /// two rows (the whole document, or the edits form), both written on the job's capture: the change of the first stays (the three-way
    /// merge took the two new rows for one element and the second op's whole text replaced the screen). M-A: colspan in an edit, one
    /// refusal whose patch writes the column it spanned as an empty cell (the column's own, with its k) and passes: three columns,
    /// aligned. M-B: an attribute of a &lt;tbody&gt;, one refusal with the Table's k and the patch that passes. L1: the class of a
    /// &lt;thead&gt; is the header row's, said in normalized. Each accepted one reads back at the fixed point.</summary>
    public static void EditRules(ITestOutputHelper output, string fixture, JsonArray? expected, string work)
    {
        var host = new ModelHost(Path.Combine(work, "host"));
        var compiled = Run(host, null, fixture, new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = RulesDocument } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("action DataTables.Choose\n  in Item: Text\n  assign\n    Picked = Item\n  end\n") } }), expected, Path.Combine(work, "base"), out var basePath);
        Assert.True(compiled["accepted"]!.GetValue<bool>(), compiled.ToJsonString()[..Math.Min(3000, compiled.ToJsonString().Length)]);
        var bytes = File.ReadAllBytes(basePath);
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        var read = host.HtmlRead(bytes, "MobileScreen:DataTables", withKeys: false)["documents"]![0]!;
        var html = read["html"]!.ToString();
        output.WriteLine(html);
        JsonObject Op(string form, JsonNode value) => new()
        {
            ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "DataTables", ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = read["htmlSha256"]!.DeepClone() }, [form] = value },
        };
        JsonObject Job(string name, JsonArray ops, out string outPath)
        {
            var result = Run(host, basePath, fixture, ops, expected, Path.Combine(work, name), out outPath);
            output.WriteLine(name + ": " + result.ToJsonString()[..Math.Min(2500, result.ToJsonString().Length)]);
            return result;
        }
        string Reading(string oml) => host.HtmlRead(File.ReadAllBytes(oml), "MobileScreen:DataTables", withKeys: false)["documents"]![0]!["html"]!.ToString();
        void FixedPoint(string oml)
        {
            var check = host.HtmlCheck(File.ReadAllBytes(oml))["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == "DataTables")!;
            Assert.Equal(0, check["problemCount"]!.GetValue<int>());
            Assert.Equal(0, check["ops"]!.GetValue<int>());
        }
        ScreenHtml.Node Table(ScreenHtml.Node tree) => Elements(tree).Single(n => n.Tag == "table");
        ScreenHtml.Node Box(ScreenHtml.Node tree, string cls) => Elements(tree).Single(n => n.Tag == "div" && n.Get("class") == cls);
        var tableK = Table(ScreenHtml.Parse(html)).Get("k")!;

        // B1: two html ops on one screen in one job.
        {
            var first = ScreenHtml.Parse(html); var box = Box(first, "box");
            box.Attributes.RemoveAll(a => a.Key == "class"); box.Attributes.Add(new("class", "box first-op"));
            var op1 = Op("edit", new JsonArray(ScreenHtmlText.Write(box)));
            var whole = ScreenHtml.Parse(html); Box(whole, "other").Children.Add(ScreenHtml.Parse(StaticTable).Children[0]);
            var forms = new (string Name, JsonObject Op)[] {
                ("two-ops-html", Op("html", ScreenHtmlText.Write(whole))),
                ("two-ops-edits", Op("edits", new JsonArray(new JsonObject { ["into"] = Box(ScreenHtml.Parse(html), "other").Get("k"), ["insert"] = StaticTable }))) };
            foreach (var (name, op2) in forms)
            {
                var result = Job(name, new JsonArray(op1.DeepClone(), op2), out var outPath);
                Assert.True(result["accepted"]!.GetValue<bool>(), name);
                var text = Reading(outPath);
                output.WriteLine(text);
                Assert.Contains("first-op", text);
                Assert.Contains("second-op", text);
                FixedPoint(outPath);
            }
        }
        // M-A: colspan="2" on the first header cell, the second one left out.
        {
            var tree = ScreenHtml.Parse(html); var table = Table(tree);
            var ths = Elements(table).Where(n => n.Tag == "th").ToList();
            var contact = ths[1].Get("k");
            ths[0].Attributes.Add(new("colspan", "2"));
            Elements(table).Single(n => n.Tag == "tr" && n.Children.Contains(ths[1])).Children.Remove(ths[1]);
            var ops = new JsonArray(Op("edit", new JsonArray(ScreenHtmlText.Write(table))));
            var refused = Job("colspan", ops, out _);
            Assert.False(refused["accepted"]!.GetValue<bool>());
            var problem = Assert.Single(Problems(refused));
            Assert.Equal("HTML_TABLE_COLSPAN", problem["code"]!.ToString());
            Assert.Equal(tableK, problem["k"]!.ToString());
            Assert.Contains("k=\"" + contact + "\"", problem["fix"]!.ToString());
            var result = Job("colspan-patched", Patched(ops, problem), out var outPath);
            Assert.True(result["accepted"]!.GetValue<bool>(), "the patch passes");
            var text = Reading(outPath);
            output.WriteLine(text);
            var after = Table(ScreenHtml.Parse(text));
            Assert.Equal(3, Elements(after).Count(n => n.Tag == "th"));
            Assert.Equal(3, Elements(after).Count(n => n.Tag == "td"));
            Assert.DoesNotContain("colspan", text);
            Assert.Contains("ToUpper(Rows.Current)", text);   // the column of data stays
            FixedPoint(outPath);
        }
        // A cell of a column written again without its k, the other cell kept (probes C1 and C3 of round 3): one refusal whose patch
        // keeps the column (the platform deletes the whole column with either of its cells).
        foreach (var (tag, text, shown) in new[] { ("th", "<th>Contact person</th>", "Contact person"), ("td", "<td>{{ Length(Rows.Current) }}</td>", "Length(Rows.Current)") })
        {
            var tree = ScreenHtml.Parse(html); var table = Table(tree);
            var cells = Elements(table).Where(n => n.Tag == tag).ToList();
            var own = cells[1].Get("k");
            var row = Elements(table).Single(n => n.Tag == "tr" && n.Children.Contains(cells[1]));
            row.Children[row.Children.IndexOf(cells[1])] = ScreenHtml.Parse(text).Children[0];
            var ops = new JsonArray(Op("edit", new JsonArray(ScreenHtmlText.Write(table))));
            var refused = Job("cell-without-k-" + tag, ops, out _);
            Assert.False(refused["accepted"]!.GetValue<bool>());
            var problem = Assert.Single(Problems(refused));
            Assert.Equal("HTML_TABLE_COLUMN", problem["code"]!.ToString());
            Assert.Contains("k=\"" + own + "\"", problem["fix"]!.ToString());
            var result = Job("cell-without-k-" + tag + "-patched", Patched(ops, problem), out var outPath);
            Assert.True(result["accepted"]!.GetValue<bool>(), "the patch passes");
            var readBack = Reading(outPath);
            output.WriteLine(readBack);
            var after = Table(ScreenHtml.Parse(readBack));
            Assert.Equal(3, Elements(after).Count(n => n.Tag == "th"));
            Assert.Equal(3, Elements(after).Count(n => n.Tag == "td"));
            Assert.Contains(shown, readBack);
            FixedPoint(outPath);
        }
        // M-B: an attribute of the <tbody>.
        {
            var tree = ScreenHtml.Parse(html); var table = Table(tree);
            Elements(table).Single(n => n.Tag == "tbody").Attributes.Add(new("data-x", "1"));
            var ops = new JsonArray(Op("edit", new JsonArray(ScreenHtmlText.Write(table))));
            var refused = Job("tbody-attribute", ops, out _);
            Assert.False(refused["accepted"]!.GetValue<bool>());
            var problem = Assert.Single(Problems(refused));
            Assert.Equal("HTML_TABLE_PART", problem["code"]!.ToString());
            Assert.Equal(tableK, problem["k"]!.ToString());
            Assert.False(string.IsNullOrEmpty(problem["pointer"]?.ToString()));
            var result = Job("tbody-attribute-patched", Patched(ops, problem), out var outPath);
            Assert.True(result["accepted"]!.GetValue<bool>(), "the patch passes");
            Assert.Equal(html, Reading(outPath));
            FixedPoint(outPath);
        }
        // L1: the class of the <thead>, the header row's, said.
        {
            var tree = ScreenHtml.Parse(html); var table = Table(tree);
            Elements(table).Single(n => n.Tag == "thead").Attributes.Add(new("class", "dark"));
            var result = Job("thead-class", new JsonArray(Op("edit", new JsonArray(ScreenHtmlText.Write(table)))), out var outPath);
            Assert.True(result["accepted"]!.GetValue<bool>());
            var edit = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().First(r => r["mode"]?.ToString() == "edit");
            Assert.Contains((edit["normalized"] as JsonArray ?? []).OfType<JsonObject>(), n => n["code"]?.ToString() == "TABLE_NATIVE" && n["note"]!.ToString().Contains("<thead class> joins the class of its <tr> (StyleHeader)", StringComparison.Ordinal));
            Assert.Contains("dark", Elements(Table(ScreenHtml.Parse(Reading(outPath)))).First(n => n.Tag == "tr").Get("class") ?? "");
            FixedPoint(outPath);
        }
    }

    /// <summary>M2 of the review of round 1, without a module: what a document writes on the parts of a data table. The class of a
    /// &lt;thead&gt; or &lt;tbody&gt; joins its row's and the List's own classes and attributes beside the list are left out (no
    /// refusal); colspan is one refusal with the patch that writes the columns it spanned; another attribute of a part is one
    /// refusal with the patch that removes it. Each patched document passes.</summary>
    public static void DocumentRules()
    {
        const string head = "<screen name=\"DataTables\">\n<var name=\"Rows\" type=\"Text List\"/>\n";
        ScreenDocument.Preflight(head + "<table><thead class=\"h\"><tr><th>A</th></tr></thead><tbody class=\"list b\" list=\"Rows\" os-Mode=\"Custom\" disable-virtualization=\"{{ True }}\"><tr class=\"r\"><td>a</td></tr></tbody></table>\n</screen>", "/ops/0/data/html");
        foreach (var (html, code, expected) in new[]
        {
            (head + "<table><thead><tr><th colspan=\"2\">Name</th><th>Actions</th></tr></thead><tbody list=\"Rows\"><tr><td>{{ Rows.Current }}</td><td>{{ Length(Rows.Current) }}</td><td>x</td></tr></tbody></table>\n</screen>",
                "HTML_TABLE_COLSPAN", "<th>Name</th><th></th><th>Actions</th>"),
            (head + "<table><thead><tr><th>A</th></tr></thead><tbody list=\"Rows\" data-x=\"1\"><tr><td>a</td></tr></tbody></table>\n</screen>",
                "HTML_TABLE_PART", "<tbody list=\"Rows\"><tr><td>a</td></tr></tbody>"),
        })
        {
            var error = Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(html, "/ops/0/data/html"));
            var problems = Errors.FindCoded(error)!.Problems!.AsArray().Select(p => p!.AsObject()).ToList();
            var problem = Assert.Single(problems);
            Assert.Equal(code, problem["code"]!.ToString());
            var patched = problem["patch"]![0]!["value"]!.ToString();
            Assert.Contains(expected, patched);
            ScreenDocument.Preflight(patched, "/ops/0/data/html");
        }
        // Half a column colspan does not explain: one refusal, no patch (which cell is missing is the author's).
        var columns = Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(head + "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody list=\"Rows\"><tr><td>a</td></tr></tbody></table>\n</screen>", "/ops/0/data/html"));
        Assert.Equal("HTML_TABLE_COLUMNS", Assert.Single(Errors.FindCoded(columns)!.Problems!.AsArray())!["code"]!.ToString());
    }

    // A data table of a document: its header cells and its row cells, over the list Rows.
    private const string SpanHead = "<screen name=\"SpanTables\">\n<var name=\"Rows\" type=\"Text List\"/>\n";
    private static string SpanTable(string header, string row, string body = "") =>
        "<table><thead><tr>" + header + "</tr></thead><tbody" + body + " list=\"Rows\"><tr>" + row + "</tr></tbody></table>\n";

    // Every problem of a refusal of the document form (no module).
    private static List<JsonObject> DocumentProblems(string html)
    {
        var error = Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(html, "/ops/0/data/html"));
        return Errors.FindCoded(error)!.Problems!.AsArray().Select(p => p!.AsObject()).ToList();
    }

    /// <summary>The owner's decision of 2026-10-19 (round 4), without a module: a cell of a native Table spans one column and one row.
    /// colspan with the rows as many cells (the header one column wider than the rows), colspan on the one column of a table, and
    /// rowspan (the template row repeats once per record: it pushes the next record's row; the header row too) are refused
    /// (HTML_TABLE_COLSPAN) with the patch that removes the attribute; colspan that explains half a column keeps its patch (the
    /// columns it spanned written as empty cells). Every cell of every table comes in one refusal with the other rules of a table,
    /// one patch for all, and the patched document passes. A cell of the reading (its k) keeps what it has.</summary>
    public static void DocumentSpans()
    {
        foreach (var (html, count, expected) in new[]
        {
            (SpanHead + SpanTable("<th colspan=\"2\">A</th><th>B</th>", "<td>a</td><td>b</td>") + "</screen>", 1, "<th>A</th><th>B</th>"),
            (SpanHead + SpanTable("<th>A</th><th>B</th><th>C</th>", "<td colspan=\"3\">a</td><td>b</td><td>c</td>") + "</screen>", 1, "<td>a</td><td>b</td><td>c</td>"),
            (SpanHead + SpanTable("<th colspan=\"2\">A</th>", "<td colspan=\"2\">a</td>") + "</screen>", 2, "<th>A</th></tr></thead><tbody list=\"Rows\"><tr><td>a</td>"),
            (SpanHead + SpanTable("<th rowspan=\"2\">A</th><th>B</th>", "<td>a</td><td rowspan=\"2\">b</td>") + "</screen>", 2, "<th>A</th><th>B</th></tr></thead><tbody list=\"Rows\"><tr><td>a</td><td>b</td>"),
            (SpanHead + SpanTable("<th ROWSPAN=\"2\">A</th><th>B</th>", "<td>a</td><td ext:colspan=\"2\">b</td>") + "</screen>", 2, "<th>A</th><th>B</th></tr></thead><tbody list=\"Rows\"><tr><td>a</td><td>b</td>"),
        })
        {
            var problems = DocumentProblems(html);
            Assert.Equal(count, problems.Count);
            Assert.All(problems, p => Assert.Equal("HTML_TABLE_COLSPAN", p["code"]!.ToString()));
            var patched = problems[0]["patch"]![0]!["value"]!.ToString();
            Assert.All(problems, p => Assert.Equal(patched, p["patch"]![0]!["value"]!.ToString()));
            Assert.Contains(expected, patched);
            Assert.DoesNotContain("span=", patched, StringComparison.OrdinalIgnoreCase);
            ScreenDocument.Preflight(patched, "/ops/0/data/html");
        }
        // Every cell of every table in one refusal, with an attribute of a <tbody>: a table with colspan (the rows as many) and rowspan,
        // and a table whose colspan explains half a column, with rowspan on another cell.
        {
            var html = SpanHead + SpanTable("<th colspan=\"2\">A</th><th>B</th>", "<td rowspan=\"2\">a</td><td>b</td>", " data-x=\"1\"")
                + SpanTable("<th colspan=\"2\">Name</th><th rowspan=\"3\">Actions</th>", "<td>{{ Rows.Current }}</td><td>x</td><td>y</td>") + "</screen>";
            var problems = DocumentProblems(html);
            Assert.Equal(["HTML_TABLE_COLSPAN", "HTML_TABLE_COLSPAN", "HTML_TABLE_COLSPAN", "HTML_TABLE_COLSPAN", "HTML_TABLE_PART"],
                problems.Select(p => p["code"]!.ToString()).Order(StringComparer.Ordinal));
            var patched = Assert.Single(problems.Select(p => p["patch"]![0]!["value"]!.ToString()).Distinct());
            Assert.Contains("<th>A</th><th>B</th>", patched);
            Assert.Contains("<th>Name</th><th></th><th>Actions</th>", patched);
            Assert.DoesNotContain("span=", patched, StringComparison.Ordinal);
            Assert.DoesNotContain("data-x", patched, StringComparison.Ordinal);
            ScreenDocument.Preflight(patched, "/ops/0/data/html");
        }
        // Half a column colspan does not explain, with colspan: the half a column has no patch (which cell is missing is the
        // author's), the colspan its own; the patched document says the half a column alone.
        {
            var problems = DocumentProblems(SpanHead + SpanTable("<th colspan=\"3\">A</th><th>B</th>", "<td>a</td><td>b</td><td>c</td>") + "</screen>");
            Assert.Equal(["HTML_TABLE_COLSPAN", "HTML_TABLE_COLUMNS"], problems.Select(p => p["code"]!.ToString()).Order(StringComparer.Ordinal));
            var patched = problems.Single(p => p["code"]!.ToString() == "HTML_TABLE_COLSPAN")["patch"]![0]!["value"]!.ToString();
            Assert.DoesNotContain("colspan", patched);
            Assert.Equal("HTML_TABLE_COLUMNS", Assert.Single(DocumentProblems(patched))["code"]!.ToString());
        }
        // A cell of the reading the document is based on (its k) keeps its colspan and rowspan.
        ScreenDocument.Preflight(SpanHead + "<table k=\"w1\" list=\"Rows\"><thead><tr><th k=\"w2\" colspan=\"2\">A</th><th k=\"w3\">B</th></tr></thead>"
            + "<tbody><tr><td k=\"w4\" rowspan=\"2\">a</td><td k=\"w5\">b</td></tr></tbody></table>\n</screen>", "/ops/0/data/html");
    }

    // The job with the patch of a refusal applied: its JSON patch over the ops (replace, add and remove of /ops/<i>/data/<form>).
    private static JsonArray WithPatch(JsonArray ops, JsonObject problem)
    {
        var copy = ops.DeepClone().AsArray();
        foreach (var step in problem["patch"]!.AsArray().OfType<JsonObject>())
        {
            var path = step["path"]!.ToString().Split('/').Skip(1).ToList();   // /ops/<i>/data/<form>
            Assert.Equal(["ops", "data"], new[] { path[0], path[2] });
            var data = copy[int.Parse(path[1], CultureInfo.InvariantCulture)]!["data"]!.AsObject();
            if (step["op"]!.ToString() == "remove") data.Remove(path[3]);
            else data[path[3]] = step["value"]!.DeepClone();
        }
        return copy;
    }

    /// <summary>The owner's decision of 2026-10-19 (round 4) over a fixture: a cell of a native Table spans one column and one row,
    /// in the document and in each form of the edit (edit, edits, html). Each refusal brings every cell of the op at once with one
    /// patch, which passes: aligned tables without colspan or rowspan, at the fixed point. A Table whose cells have colspan and rowspan
    /// in the model (extended properties) reads with them, and an edit that keeps them (edit, html) passes and reads back at the
    /// fixed point.</summary>
    public static void SpanRules(ITestOutputHelper output, string fixture, JsonArray? expected, string work)
    {
        var host = new ModelHost(Path.Combine(work, "host"));
        JsonObject Job(string? basePath, string name, JsonArray ops, out string outPath)
        {
            var result = Run(host, basePath, fixture, ops, expected, Path.Combine(work, name), out outPath);
            output.WriteLine(name + ": " + result.ToJsonString()[..Math.Min(2500, result.ToJsonString().Length)]);
            return result;
        }
        var compiled = Job(null, "base", new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = RulesDocument } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("action DataTables.Choose\n  in Item: Text\n  assign\n    Picked = Item\n  end\n") } }), out var basePath);
        Assert.True(compiled["accepted"]!.GetValue<bool>(), "the base compiles");
        (string Sha, JsonObject Read) ReadOf(string oml, string screen = "DataTables")
        {
            var bytes = File.ReadAllBytes(oml);
            return (Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant(), host.HtmlRead(bytes, "MobileScreen:" + screen, withKeys: true)["documents"]![0]!.AsObject());
        }
        JsonObject Op(string sha, JsonObject read, string form, JsonNode value) => new()
        {
            ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "DataTables", ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = read["htmlSha256"]!.DeepClone() }, [form] = value },
        };
        void FixedPoint(string oml, string screen = "DataTables")
        {
            var check = host.HtmlCheck(File.ReadAllBytes(oml))["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == screen)!;
            Assert.Equal(0, check["problemCount"]!.GetValue<int>());
            Assert.Equal(0, check["ops"]!.GetValue<int>());
        }
        // Refused once, every problem a HTML_TABLE_COLSPAN or HTML_TABLE_PART with one patch; the patched job passes. Its reading.
        string RefusedThenPatched(string? from, string name, JsonArray ops, int colspans, int parts, string screen = "DataTables")
        {
            var refused = Job(from, name, ops, out _);
            Assert.False(refused["accepted"]!.GetValue<bool>(), name);
            var problems = Problems(refused).Where(p => p["severity"]?.ToString() != "warning").ToList();
            Assert.Equal(colspans, problems.Count(p => p["code"]!.ToString() == "HTML_TABLE_COLSPAN"));
            Assert.Equal(parts, problems.Count(p => p["code"]!.ToString() == "HTML_TABLE_PART"));
            Assert.Equal(colspans + parts, problems.Count);
            Assert.Single(problems.Select(p => p["patch"]!.ToJsonString()).Distinct());
            var result = Job(from, name + "-patched", WithPatch(ops, problems[0]), out var outPath);
            Assert.True(result["accepted"]!.GetValue<bool>(), name + ": the patch passes");
            var text = host.HtmlRead(File.ReadAllBytes(outPath), "MobileScreen:" + screen, withKeys: false)["documents"]![0]!["html"]!.ToString();
            output.WriteLine(text);
            Assert.DoesNotContain("span=", text, StringComparison.OrdinalIgnoreCase);
            foreach (var table in Elements(ScreenHtml.Parse(text)).Where(n => n.Tag == "table"))
                Assert.Equal(Elements(table).Count(n => n.Tag == "th"), Elements(table).Count(n => n.Tag == "td"));
            FixedPoint(outPath, screen);
            return text;
        }
        var (sha, read) = ReadOf(basePath);
        var html = read["html"]!.ToString();
        output.WriteLine(html);
        ScreenHtml.Node Table(ScreenHtml.Node tree) => Elements(tree).Single(n => n.Tag == "table");

        // The document: a new screen with two data tables, colspan with the rows as many and rowspan on the template row, a <tbody>
        // attribute; colspan that explains half a column and rowspan on the header.
        RefusedThenPatched(basePath, "document", new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] =
            SpanHead + SpanTable("<th colspan=\"2\">A</th><th>B</th>", "<td>{{ Rows.Current }}</td><td rowspan=\"2\">{{ Length(Rows.Current) }}</td>", " data-x=\"1\"")
            + SpanTable("<th colspan=\"2\">Name</th><th rowspan=\"2\">Size</th>", "<td>{{ Rows.Current }}</td><td>{{ ToUpper(Rows.Current) }}</td><td>{{ Length(Rows.Current) }}</td>") + "</screen>" } }),
            colspans: 4, parts: 1, screen: "SpanTables");
        // edit: colspan="2" on the first header cell (the rows as many) and rowspan="2" on the second row cell.
        {
            var tree = ScreenHtml.Parse(html); var table = Table(tree);
            Elements(table).Where(n => n.Tag == "th").First().Attributes.Add(new("colspan", "2"));
            Elements(table).Where(n => n.Tag == "td").ElementAt(1).Attributes.Add(new("rowspan", "2"));
            var text = RefusedThenPatched(basePath, "edit", new JsonArray(Op(sha, read, "edit", new JsonArray(ScreenHtmlText.Write(table)))), colspans: 2, parts: 0);
            Assert.Equal(html, text);
        }
        // edits: a new data table into the box, colspan="3" on its header (the rows as many) and rowspan on its template row.
        {
            var box = Elements(ScreenHtml.Parse(html)).Single(n => n.Tag == "div" && n.Get("class") == "box").Get("k");
            var inserted = "<table class=\"spans\"><thead><tr><th colspan=\"3\">Item</th><th>Size</th><th>Upper</th></tr></thead><tbody list=\"Rows\"><tr><td>{{ Rows.Current }}</td>"
                + "<td rowspan=\"2\">{{ Length(Rows.Current) }}</td><td>{{ ToUpper(Rows.Current) }}</td></tr></tbody></table>";
            var text = RefusedThenPatched(basePath, "edits", new JsonArray(Op(sha, read, "edits", new JsonArray(new JsonObject { ["into"] = box, ["insert"] = inserted }))), colspans: 2, parts: 0);
            Assert.Contains("spans", text);
        }
        // html: the whole document, rowspan on the last header cell and colspan="2" on the last row cell.
        {
            var tree = ScreenHtml.Parse(html); var table = Table(tree);
            Elements(table).Where(n => n.Tag == "th").Last().Attributes.Add(new("rowspan", "2"));
            Elements(table).Where(n => n.Tag == "td").Last().Attributes.Add(new("colspan", "2"));
            var text = RefusedThenPatched(basePath, "html", new JsonArray(Op(sha, read, "html", ScreenHtmlText.Write(tree))), colspans: 2, parts: 0);
            Assert.Equal(html, text);
        }

        // A Table whose cells have colspan and rowspan in the model (extended properties, written by the native ops): the reading
        // writes them, and an edit that keeps them passes and reads back at the fixed point.
        var keys = read["keys"]!.AsObject();
        var cells = Elements(Table(ScreenHtml.Parse(html))).Where(n => n.Tag is "th" or "td").ToList();
        var header = keys[cells.First(n => n.Tag == "th").Get("k")!]!.ToString();
        var row = keys[cells.Last(n => n.Tag == "td").Get("k")!]!.ToString();
        var spanned = Job(basePath, "spanned", new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = "@" + header, ["type"] = "IExtendedProperty", ["as"] = "$colspan" },
            new JsonObject { ["op"] = "set", ["target"] = "$colspan", ["prop"] = "Property", ["value"] = "colspan" },
            new JsonObject { ["op"] = "set", ["target"] = "$colspan", ["prop"] = "Value", ["value"] = "\"2\"" },
            new JsonObject { ["op"] = "create", ["parent"] = "@" + row, ["type"] = "IExtendedProperty", ["as"] = "$rowspan" },
            new JsonObject { ["op"] = "set", ["target"] = "$rowspan", ["prop"] = "Property", ["value"] = "rowspan" },
            new JsonObject { ["op"] = "set", ["target"] = "$rowspan", ["prop"] = "Value", ["value"] = "\"2\"" }), out var spannedPath);
        Assert.True(spanned["accepted"]!.GetValue<bool>(), "the native ops write the spans");
        var (spannedSha, spannedRead) = ReadOf(spannedPath);
        var spannedHtml = spannedRead["html"]!.ToString();
        output.WriteLine(spannedHtml);
        Assert.Contains("colspan=\"2\"", spannedHtml);
        Assert.Contains("rowspan=\"2\"", spannedHtml);
        FixedPoint(spannedPath);
        foreach (var form in new[] { "edit", "html" })
        {
            var tree = ScreenHtml.Parse(spannedHtml); var table = Table(tree);
            var contact = Elements(table).Where(n => n.Tag == "th").ElementAt(1);
            contact.Children.Clear(); contact.Children.Add(new ScreenHtml.Node { Text = "Contact person" });
            var result = Job(spannedPath, "kept-" + form, new JsonArray(Op(spannedSha, spannedRead, form, form == "edit" ? new JsonArray(ScreenHtmlText.Write(table)) : ScreenHtmlText.Write(tree))), out var outPath);
            Assert.True(result["accepted"]!.GetValue<bool>(), form + ": what the reading has stays");
            var text = host.HtmlRead(File.ReadAllBytes(outPath), "MobileScreen:DataTables", withKeys: false)["documents"]![0]!["html"]!.ToString();
            output.WriteLine(text);
            Assert.Contains("colspan=\"2\"", text);
            Assert.Contains("rowspan=\"2\"", text);
            Assert.Contains("Contact person", text);
            FixedPoint(outPath);
        }
    }

    /// <summary>The document over a fixture: accepted, two native Tables of seven aligned columns (the header cell and the row
    /// cell of column i in the same column of the widget), the card list a List, the reading a &lt;table list&gt; with its
    /// &lt;thead&gt; and &lt;tbody&gt;, read again as it was written (0 ops, 0 problems).</summary>
    public static void Compiled(ITestOutputHelper output, ModelHost host, string outPath, JsonObject result)
    {
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString() ?? result.ToJsonString()[..Math.Min(4000, result.ToJsonString().Length)]);
        var report = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().First(r => r["form"]?.ToString() == "document");
        var normalized = (report["normalized"] as JsonArray ?? []).Select(n => n!.AsObject()).ToList();
        output.WriteLine(new JsonArray(normalized.Select(n => (JsonNode)n.DeepClone()).ToArray()).ToJsonString());
        var bytes = File.ReadAllBytes(outPath);
        var text = host.HtmlRead(bytes, "MobileScreen:DataTables", withKeys: false)["documents"]![0]!["html"]!.ToString();
        output.WriteLine(text);
        // The model: two Tables, each with seven header cells and seven row cells; the card list is the one List of the screen.
        var screen = host.ReadModel(outPath, "/", new ReadingOptions(Kind: "MobileScreen", Name: "DataTables", Max: 5))["entries"]!.AsArray().Single()!["reference"]!.ToString();
        int Count(string kind) => host.ReadModel(outPath, screen, new ReadingOptions(Kind: kind, Max: 1))["count"]!.GetValue<int>();
        Assert.Equal(2, Count("TableRecords"));
        Assert.Equal(14, Count("HeaderCell"));
        Assert.Equal(14, Count("RowCell"));
        Assert.Equal(1, Count("List"));
        // The reading: the <table> of the language, its list on the table, one header row and one template row each.
        var doc = ScreenHtml.Parse(text);
        var read = Elements(doc).Where(n => n.Tag == "table").ToList();
        Assert.Equal(2, read.Count);
        foreach (var table in read)
        {
            Assert.Equal("Rows", table.Get("list"));
            Assert.Equal(Headers, Elements(table).Where(n => n.Tag == "th").Select(th => string.Concat(th.Children.Where(c => c.IsText).Select(c => c.Text)).Trim()));
            Assert.Equal(7, Elements(table).Count(n => n.Tag == "td"));
            Assert.All(Elements(table).Where(n => n.Tag is "thead" or "tbody" or "tr"), part => Assert.Null(part.Get("list")));
        }
        Assert.DoesNotContain("os-opaque", text);
        Assert.Contains("class=\"dt-head\"", text);   // the header row's class is the Table's StyleHeader
        Assert.Matches("<div[^>]*list=\"Rows\"", text);
        // The fixed point.
        var check = host.HtmlCheck(bytes)["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == "DataTables")!;
        Assert.Equal(0, check["problemCount"]!.GetValue<int>());
        Assert.Equal(0, check["ops"]!.GetValue<int>());
        Assert.Equal(0, check["opaqueWidgets"]!.GetValue<int>());
    }

    /// <summary>The prototype importer's plan: every table of FarmaVirtual (a header row and a body whose rows repeat over a
    /// collection) is one native Table whose header cells and row cells pair up column by column, bound to the list.</summary>
    public static void Prototype(IEnumerable<(WidgetNode Node, string Owner)> widgets)
    {
        var all = widgets.ToList();
        var tables = all.Where(w => w.Node.W == "ITableRecords").ToList();
        Assert.Equal(["GestaoPedidos", "GestaoProdutos", "MeusPedidos"], tables.Select(t => t.Owner).Order(StringComparer.Ordinal));
        foreach (var (table, owner) in tables)
        {
            var header = table.Children.Where(c => c.W == "IHeaderCell").ToList();
            var row = table.Children.Where(c => c.W == "IRowCell").ToList();
            Assert.Equal(owner == "MeusPedidos" ? 6 : 7, header.Count);
            Assert.Equal(header.Count, row.Count);
            Assert.Equal(table.Children.Count, header.Count + row.Count);
        }
        // No List is a table body any more, and no HTML element is a table part.
        Assert.DoesNotContain(all, w => w.Node.W == "IList" && w.Node.Tag is "tbody" or "tr");
        Assert.DoesNotContain(all, w => w.Node.W == "IAdvancedHtml" && w.Node.Tag is "table" or "thead" or "tbody" or "th" or "td");
    }

    // The table of a view of a capture (its first <table>).
    private static JsonObject ViewTable(JsonObject capture, string view)
    {
        JsonObject? Find(JsonNode? n)
        {
            if (n is not JsonObject o) return null;
            if (o["t"]?.ToString() == "table") return o;
            foreach (var c in o["c"] as JsonArray ?? []) if (Find(c) is { } hit) return hit;
            return Find(o["list"]?["template"]);
        }
        var root = capture["views"]!.AsArray().OfType<JsonObject>().Single(v => (v["name"] ?? v["key"])?.ToString() == view)["root"];
        return Find(root)!;
    }

    /// <summary>M3 of the review of round 1: FarmaVirtual with a class and a data attribute on the thead of MeusPedidos and a
    /// computed title on a header cell of GestaoPedidos (a sortable header).</summary>
    public static void PrepareDegraded(string capturePath)
    {
        var capture = JsonNode.Parse(File.ReadAllText(capturePath))!.AsObject();
        var head = ViewTable(capture, "MeusPedidos")["c"]!.AsArray().OfType<JsonObject>().First(c => c["t"]?.ToString() == "thead");
        var attributes = head["a"] as JsonArray ?? new JsonArray();
        attributes.Add(new JsonArray("class", "heads")); attributes.Add(new JsonArray("data-x", "1"));
        head["a"] = attributes;
        var gestao = ViewTable(capture, "GestaoPedidos")["c"]!.AsArray().OfType<JsonObject>().First(c => c["t"]?.ToString() == "thead");
        var th = gestao["c"]!.AsArray().OfType<JsonObject>().First(c => c["t"]?.ToString() == "tr")["c"]!.AsArray().OfType<JsonObject>().First(c => c["t"]?.ToString() == "th");
        th["attrExpr"] = new JsonObject { ["title"] = new JsonObject { ["expr"] = new JsonObject { ["fmt"] = "text", ["value"] = new JsonObject { ["lit"] = "Sort" } } } };
        File.WriteAllText(capturePath, capture.ToJsonString());
    }

    /// <summary>The section's class joins its row's (StyleHeader), its data attribute is left out and said; the table with a
    /// sortable header stays the old form and says why; the other table is still the native Table.</summary>
    public static void AssertDegraded(PrototypePlan plan, IEnumerable<(WidgetNode Node, PrototypeWidgetSpec Spec, string Owner)> widgets)
    {
        var degraded = plan.Report["degraded"]!.AsArray().OfType<JsonObject>().ToList();
        Assert.Contains(degraded, d => d["code"]?.ToString() == "TABLE_SECTION_ATTRIBUTE" && d["message"]!.ToString().Contains("data-x", StringComparison.Ordinal));
        Assert.Contains(degraded, d => d["code"]?.ToString() == "TABLE_NOT_NATIVE" && d["message"]!.ToString().Contains("<th>", StringComparison.Ordinal));
        var all = widgets.ToList();
        var meus = Assert.Single(all, w => w.Node.W == "ITableRecords" && w.Owner == "MeusPedidos");
        Assert.Equal("\"heads\"", meus.Spec.Properties.Last(p => p.Property == "StyleHeader").Value);
        Assert.DoesNotContain(all, w => w.Node.W == "ITableRecords" && w.Owner == "GestaoPedidos");
        Assert.Single(all, w => w.Node.W == "ITableRecords" && w.Owner == "GestaoProdutos");
    }

    /// <summary>A private copy of the prototype fixtures (the capture and its bundle folders) in <paramref name="work"/>; returns
    /// the copy of FarmaVirtual's capture.</summary>
    public static string FarmaVirtualCopy(string fixtures, string work)
    {
        if (Directory.Exists(work)) Directory.Delete(work, true);
        foreach (var file in Directory.GetFiles(fixtures, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(work, Path.GetRelativePath(fixtures, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, true);
        }
        return Path.Combine(work, "farmavirtual.capture.json");
    }

    private static JsonObject Part(JsonObject node, string tag) => node["c"]!.AsArray().OfType<JsonObject>().First(c => c["t"]?.ToString() == tag);
    private static JsonObject HeaderRowOf(JsonObject table) => Part(Part(table, "thead"), "tr");
    private static JsonObject TemplateRowOf(JsonObject table) => Part(table, "tbody")["list"]!["template"]!.AsObject();
    private static List<JsonObject> CellsOf(JsonObject row) => row["c"]!.AsArray().OfType<JsonObject>().Where(c => c["t"]?.ToString() is "th" or "td").ToList();
    private static void SetAttribute(JsonObject node, string name, string value)
    {
        var attributes = node["a"] as JsonArray ?? new JsonArray();
        attributes.Add(new JsonArray(name, value));
        node["a"] = attributes;
    }

    /// <summary>The owner's rule of 2026-10-19 in the prototype importer (round 5): FarmaVirtual's data tables with static spans.
    /// Variant 1: colspan="2" on a header cell of MeusPedidos (its rows still hold as many cells), rowspan="2" on a cell of the
    /// template row of GestaoProdutos; GestaoPedidos spans none. Variant 2: colspan="2" on a header cell and rowspan="2" on a row
    /// cell of MeusPedidos; colspan="1" and rowspan="1" on GestaoProdutos (a cell of one column and one row); the last two header
    /// cells of GestaoPedidos written as one with colspan="2" (the span explains its shorter header row). Variant 3: the last two
    /// header cells of GestaoPedidos written as one with colspan="3" (a header of 8 columns over a template row of 7: the span
    /// explains nothing).</summary>
    public static void PrepareSpans(string capturePath, int variant)
    {
        var capture = JsonNode.Parse(File.ReadAllText(capturePath))!.AsObject();
        var meus = ViewTable(capture, "MeusPedidos");
        var produtos = ViewTable(capture, "GestaoProdutos");
        var pedidos = ViewTable(capture, "GestaoPedidos");
        void Merged(string colspan)
        {
            var header = HeaderRowOf(pedidos);
            header["c"]!.AsArray().Remove(CellsOf(header)[^1]);
            SetAttribute(CellsOf(header)[^1], "colspan", colspan);
        }
        if (variant == 1)
        {
            SetAttribute(CellsOf(HeaderRowOf(meus))[1], "colspan", "2");
            SetAttribute(CellsOf(TemplateRowOf(produtos))[0], "rowspan", "2");
        }
        else if (variant == 2)
        {
            SetAttribute(CellsOf(HeaderRowOf(meus))[1], "colspan", "2");
            SetAttribute(CellsOf(TemplateRowOf(meus))[2], "rowspan", "2");
            SetAttribute(CellsOf(HeaderRowOf(produtos))[0], "colspan", "1");
            SetAttribute(CellsOf(TemplateRowOf(produtos))[0], "rowspan", "1");
            Merged("2");
        }
        else Merged("3");
        File.WriteAllText(capturePath, capture.ToJsonString());
    }

    /// <summary>A data table whose cell spans is the native Table of cells that span one column and one row, never a native Table
    /// with the span on its cell: the html op's patch applied (round 4) and said in degraded (TABLE_CELL_SPAN, the cell's k, the span
    /// named): a colspan that explains the shorter row becomes the cell and one empty cell per column it covered (the prototype's
    /// columns kept), any other colspan and every rowspan are left out (the cells pair one by one). Each prototype cell keeps its
    /// order and its key; a span of 1 is no span. A colspan that leaves the rows of different widths keeps the old form, said
    /// (TABLE_NOT_NATIVE, its spans named), as a different count always did.</summary>
    public static void AssertSpans(string capturePath, PrototypePlan plan, IEnumerable<(WidgetNode Node, string Owner)> widgets, int variant)
    {
        var capture = JsonNode.Parse(File.ReadAllText(capturePath))!.AsObject();
        var degraded = plan.Report["degraded"]!.AsArray().OfType<JsonObject>().ToList();
        var all = widgets.ToList();
        static bool Spans(WidgetNode cell) => cell.Attributes.Any(a => a.Name.ToLowerInvariant() is "colspan" or "rowspan" && a.Value.Trim('"').Trim() != "1");
        // the native Table of a view: its header cells and row cells in pairs, none with a span, the prototype's cells in their order
        // (an empty cell, no key, where a colspan covered a column), and the notes of its spans
        void Native(string owner, int columns, int emptyHeaderAt = -1, params string[] notes)
        {
            var source = ViewTable(capture, owner);
            var table = Assert.Single(all, w => w.Node.W == "ITableRecords" && w.Owner == owner).Node;
            var header = table.Children.Where(c => c.W == "IHeaderCell").ToList();
            var row = table.Children.Where(c => c.W == "IRowCell").ToList();
            Assert.Equal(columns, header.Count);
            Assert.Equal(columns, row.Count);
            Assert.DoesNotContain(table.Children, Spans);
            Assert.Equal(CellsOf(HeaderRowOf(source)).Select(c => c["k"]!.ToString()), header.Where((_, i) => i != emptyHeaderAt).Select(c => c.K));
            Assert.Equal(CellsOf(TemplateRowOf(source)).Select(c => c["k"]!.ToString()), row.Select(c => c.K));
            if (emptyHeaderAt >= 0) { Assert.Null(header[emptyHeaderAt].K); Assert.Empty(header[emptyHeaderAt].Children); Assert.Equal("th", header[emptyHeaderAt].Tag); }
            Assert.DoesNotContain(degraded, d => d["code"]?.ToString() == "TABLE_NOT_NATIVE" && d["k"]?.ToString() == source["k"]!.ToString());
            var keys = CellsOf(HeaderRowOf(source)).Concat(CellsOf(TemplateRowOf(source))).Select(c => c["k"]!.ToString()).ToHashSet();
            var said = degraded.Where(d => d["code"]?.ToString() == "TABLE_CELL_SPAN" && keys.Contains(d["k"]?.ToString() ?? "")).ToList();
            Assert.Equal(notes.Length, said.Count);
            foreach (var note in notes)
                Assert.Contains(said, d => d["message"]!.ToString().Contains(note, StringComparison.Ordinal) && d["done"]!.ToString().StartsWith("left out", StringComparison.Ordinal));
        }
        if (variant == 1)
        {
            Native("MeusPedidos", 6, -1, "colspan=\"2\" on a <th>");
            Native("GestaoProdutos", 7, -1, "rowspan=\"2\" on a <td>");
            Native("GestaoPedidos", 7);
        }
        else if (variant == 2)
        {
            Native("MeusPedidos", 6, -1, "colspan=\"2\" on a <th>", "rowspan=\"2\" on a <td>");
            Native("GestaoProdutos", 7);
            Native("GestaoPedidos", 7, 6, "colspan=\"2\" on a <th>");
            Assert.Contains(degraded, d => d["code"]?.ToString() == "TABLE_CELL_SPAN" && d["done"]!.ToString().Contains("1 empty <th>", StringComparison.Ordinal));
        }
        else
        {
            Native("MeusPedidos", 6);
            Native("GestaoProdutos", 7);
            // the old form, said: the prototype's cells HTML elements (the span as it was), the rows the List of the tbody
            var k = ViewTable(capture, "GestaoPedidos")["k"]!.ToString();
            Assert.DoesNotContain(all, w => w.Node.W == "ITableRecords" && w.Owner == "GestaoPedidos");
            var note = Assert.Single(degraded, d => d["code"]?.ToString() == "TABLE_NOT_NATIVE" && d["k"]?.ToString() == k)["message"]!.ToString();
            Assert.Contains("its header row has 6 cells and its template row 7", note);
            Assert.Contains("colspan=\"3\" on a <th>", note);
            var mine = all.Where(w => w.Owner == "GestaoPedidos").Select(w => w.Node).ToList();
            Assert.Contains(mine, n => n.W == "IAdvancedHtml" && n.Tag == "th" && n.Attributes.Any(a => a.Name == "colspan" && a.Value == "\"3\""));
            Assert.Contains(mine, n => n.W == "IList" && n.Tag == "tbody");
        }
    }

    public static IEnumerable<ScreenHtml.Node> Elements(ScreenHtml.Node node)
    {
        foreach (var child in node.Children)
        {
            if (child.IsText) continue;
            yield return child;
            foreach (var inner in Elements(child)) yield return inner;
        }
    }
}
