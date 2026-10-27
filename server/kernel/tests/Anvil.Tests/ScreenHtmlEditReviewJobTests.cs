using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// The kernel review of the Traditional html port on the O11 fixtures, through the job (the apply a delivery runs):
/// finding 3, DEFAULT_NOT_LITERAL on an html edit (refused by the preflight when the store keeps the reading, by the edit
/// plan when it does not; a literal default and a Traditional root are not affected); finding 5, data.css on an edit
/// follows the page's &lt;style&gt; as on a create; finding 9a, the page marker is decided again only on a widget the edit
/// moves. Synthetic names; needs the Service Studio.
/// </summary>
public class ScreenHtmlEditReviewJobTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenHtmlEditReviewJobTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "screen-html-edit-review");
    private static string Fixture(string name) => Path.Combine(Root, "tests", "fixtures", name);

    [Fact]
    public void ANonLiteralDefaultWrittenByAnEditIsRefusedWithOrWithoutTheKeptReading()
    {
        var host = Host("defaults");
        var source = Fixture("reactive-ui.oml");
        var (read, html, sha) = Read(host, source, "Login", keys: true);
        string WithDefault(string value) { var tree = ScreenHtml.Parse(html); Attribute(Element(tree, "w3"), "default", value); return ScreenHtmlText.Write(tree); }
        var edited = WithDefault("Username <> \"\"");
        // The reviewer's job (html-default-edit): the reading is not kept here, so the edit plan says it with the module's reading.
        using (var empty = new OwnStore()) {
            var refused = Run(host, source, WholeDocument(sha, read, "Login", edited), "default-plan");
            Assert.False(refused["accepted"]!.GetValue<bool>(), refused.ToJsonString());
            var problem = Assert.Single(Problems(refused), p => p!["code"]?.ToString() == "DEFAULT_NOT_LITERAL");
            Assert.Contains("variable IsExecuting of Login is 'Username <> \"\"'", problem!["message"]!.ToString(), StringComparison.Ordinal);
        }
        // The reading kept (what ssam_map view html writes): the preflight says it, before any Studio step.
        using (var store = new OwnStore()) {
            Keep(store.Store, sha, read, html);
            var refused = Run(host, source, WholeDocument(sha, read, "Login", edited), "default-preflight");
            Assert.False(refused["accepted"]!.GetValue<bool>(), refused.ToJsonString());
            var problem = Assert.Single(Problems(refused), p => p!["code"]?.ToString() == "DEFAULT_NOT_LITERAL");
            Assert.Equal("/ops/0/data/html", problem!["pointer"]?.ToString());
            // A literal default, and the reading as it is: accepted.
            Assert.True(Run(host, source, WholeDocument(sha, read, "Login", WithDefault("False")), "default-literal")["accepted"]!.GetValue<bool>());
            Assert.True(Run(host, source, WholeDocument(sha, read, "Login", html), "default-unchanged")["accepted"]!.GetValue<bool>());
        }
    }

    [Fact]
    public void ATraditionalEditIsNotJudgedDefaultNotLiteral()
    {
        var host = Host("defaults-traditional");
        var source = Fixture("traditional-ui.oml");
        var (read, html, sha) = Read(host, source, "Login", keys: true);
        Assert.Equal("WebScreen", read["documents"]![0]!["rootKind"]?.ToString());
        var tree = ScreenHtml.Parse(html);
        Attribute(Element(tree, "w3"), "default", "ToUpper(\"guest\")");
        foreach (var keep in new[] { false, true }) {
            using var store = new OwnStore();
            if (keep) Keep(store.Store, sha, read, html);
            var result = Run(host, source, WholeDocument(sha, read, "Login", ScreenHtmlText.Write(tree)), "traditional-" + keep);
            output.WriteLine("traditional, reading kept " + keep + ": accepted " + result["accepted"]);
            Assert.DoesNotContain(Problems(result), p => p!["code"]?.ToString() == "DEFAULT_NOT_LITERAL");
        }
    }

    [Fact]
    public void DataCssOnAnEditKeepsTheEditedStyleAndFollowsItAsOnACreate()
    {
        var host = Host("css");
        var source = Fixture("reactive-ui.oml");
        var (read, html, sha) = Read(host, source, "Login");
        const string own = ".probe-a { color: red; }", css = ".probe-b { color: blue; }";
        // The reviewer's o11-style-css: an edited <style> and data.css in one edit.
        var tree = ScreenHtml.Parse(html);
        var top = tree.Children.First(n => !n.IsText);
        var style = new ScreenHtml.Node { Tag = "style" }; style.Children.Add(new ScreenHtml.Node { Text = own });
        top.Children.Insert(0, style);
        var job = WholeDocument(sha, read, "Login", ScreenHtmlText.Write(tree));
        job["ops"]![0]!["data"]!["css"] = css;
        var result = Run(host, source, job, "css-edit");
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var edited = Sheet(Read(host, Path.Combine(host.WorkDirectory, "css-edit.oml"), "Login").Html);
        Assert.Contains(own, edited);
        Assert.Contains(css, edited);
        Assert.True(edited.IndexOf(own, StringComparison.Ordinal) < edited.IndexOf(css, StringComparison.Ordinal), edited);
        // The same <style> and data.css on a new screen: the same sheet.
        var create = new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
            ["html"] = "<screen name=\"ReviewCss\" roles=\"Registered\">\n<style>" + own + "</style>\n<div class=\"x\">x</div>\n</screen>", ["css"] = css } }) };
        var created = Run(host, source, create, "css-create");
        Assert.True(created["accepted"]!.GetValue<bool>(), created.ToJsonString());
        Assert.Equal(Sheet(Read(host, Path.Combine(host.WorkDirectory, "css-create.oml"), "ReviewCss").Html), edited);
        // Element edits with data.css: the reading's <style> stays, data.css after it.
        var (read2, html2, sha2) = Read(host, Path.Combine(host.WorkDirectory, "css-edit.oml"), "Login");
        var w8 = Element(ScreenHtml.Parse(html2), "w8");
        Attribute(w8, "class", "login-logo review");
        var elements = EditJob(sha2, read2, "Login", [ScreenHtmlText.Write(w8)]);
        elements["ops"]![0]!["data"]!["css"] = ".probe-c { color: green; }";
        var again = Run(host, Path.Combine(host.WorkDirectory, "css-edit.oml"), elements, "css-elements");
        Assert.True(again["accepted"]!.GetValue<bool>(), again.ToJsonString());
        var after = Sheet(Read(host, Path.Combine(host.WorkDirectory, "css-elements.oml"), "Login").Html);
        Assert.Contains(own, after);
        Assert.Contains(css, after);
        Assert.EndsWith(".probe-c { color: green; }", after.TrimEnd());
    }

    [Fact]
    public void ThePageMarkerIsDecidedOnlyOnAWidgetTheEditMoves()
    {
        var host = Host("marks");
        var source = Fixture("reactive-ui.oml");
        var create = new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
            ["html"] = "<screen name=\"ReviewMarks\" roles=\"Registered\">\n<div id=\"TopA\" class=\"top-a\"><span id=\"Inner\">Inner</span></div>\n<div id=\"TopB\" class=\"top-b\">B</div>\n</screen>" } }) };
        Assert.True(Run(host, source, create, "marks-created")["accepted"]!.GetValue<bool>());
        var created = Path.Combine(host.WorkDirectory, "marks-created.oml");
        var (read0, html0, sha0) = Read(host, created, "ReviewMarks");
        output.WriteLine(html0);
        Assert.Contains("data-ssam-page=\"1\"", html0);
        // Edit 1: a new widget at the top of the page (written by the edit, without k).
        var tree0 = ScreenHtml.Parse(html0);
        tree0.Children.First(n => !n.IsText).Children.Add(ScreenHtml.Parse("<div class=\"added\">Added</div>").Children[0]);
        Assert.True(Run(host, created, WholeDocument(sha0, read0, "ReviewMarks", ScreenHtmlText.Write(tree0)), "marks-added")["accepted"]!.GetValue<bool>());
        var added = Path.Combine(host.WorkDirectory, "marks-added.oml");
        var (read1, html1, sha1) = Read(host, added, "ReviewMarks");
        output.WriteLine(html1);
        var marks1 = Marked(html1);
        // Edit 2 moves nothing (a class of TopB): no widget gains or loses the page marker.
        var tree1 = ScreenHtml.Parse(html1);
        var topB = ScreenHtmlText.Elements(tree1).First(x => x.Node.Get("id") == "TopB").Node;
        Attribute(topB, "class", "top-b changed");
        var unmoved = Run(host, added, WholeDocument(sha1, read1, "ReviewMarks", ScreenHtmlText.Write(tree1)), "marks-unmoved");
        Assert.True(unmoved["accepted"]!.GetValue<bool>(), unmoved.ToJsonString());
        var html2 = Read(host, Path.Combine(host.WorkDirectory, "marks-unmoved.oml"), "ReviewMarks").Html;
        output.WriteLine(html2);
        Assert.Equal(marks1, Marked(html2));
        // Edit 3 moves Inner to the top: only Inner is decided again (marked, at the top of the page).
        var tree3 = ScreenHtml.Parse(html1);
        var inner = ScreenHtmlText.Elements(tree3).First(x => x.Node.Get("id") == "Inner");
        inner.Parent!.Children.Remove(inner.Node);
        tree3.Children.First(n => !n.IsText).Children.Add(inner.Node);
        var moved = Run(host, added, WholeDocument(sha1, read1, "ReviewMarks", ScreenHtmlText.Write(tree3)), "marks-moved");
        Assert.True(moved["accepted"]!.GetValue<bool>(), moved.ToJsonString());
        var html3 = Read(host, Path.Combine(host.WorkDirectory, "marks-moved.oml"), "ReviewMarks").Html;
        output.WriteLine(html3);
        var expected = new SortedSet<string>(marks1, StringComparer.Ordinal) { "Inner" };
        Assert.Equal(expected, Marked(html3));
    }

    // The widgets of a reading that carry the page marker (by id, or the class of one without id).
    private static SortedSet<string> Marked(string html) => new(ScreenHtmlText.Elements(ScreenHtml.Parse(html))
        .Where(x => x.Node.Get(ScreenVisual.PageMarker) != null).Select(x => x.Node.Get("id") ?? "." + x.Node.Get("class")), StringComparer.Ordinal);

    // The page's own style sheet in a reading.
    private static string Sheet(string html)
    {
        var top = ScreenHtml.Parse(html).Children.First(n => !n.IsText);
        return top.Children.FirstOrDefault(n => !n.IsText && n.Tag == "style") is { } style ? string.Concat(style.Children.Select(c => c.Text)) : "";
    }

    // ---- helpers (as ScreenHtmlEditJobTests) -----------------------------------------------------------------------------
    private sealed class OwnStore : IDisposable
    {
        public readonly ModuleIndexStore Store;
        private readonly IDisposable scope;
        public OwnStore()
        {
            Store = new ModuleIndexStore(Path.Combine(Path.GetTempPath(), "review-job-store-" + Guid.NewGuid().ToString("N")), "o11", "kernel");
            scope = ModuleIndexStore.Use(Store);
        }
        public void Dispose()
        {
            scope.Dispose();
            try { if (Directory.Exists(Store.Root)) Directory.Delete(Store.Root, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    private static void Keep(ModuleIndexStore store, string sha, JsonObject read, string html)
    {
        var document = read["documents"]![0]!;
        var file = store.HtmlKeysPathOf(sha, document["htmlSha256"]!.ToString());
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, new JsonObject {
            ["schema"] = ScreenHtml.Schema, ["extractor"] = ScreenHtml.Extractor, ["lane"] = store.Lane, ["sourceSha256"] = sha, ["root"] = document["root"]?.DeepClone(),
            ["rootKey"] = document["rootKey"]!.DeepClone(), ["rootKind"] = document["rootKind"]!.DeepClone(), ["htmlSha256"] = document["htmlSha256"]!.DeepClone(),
            ["keys"] = document["keys"]!.DeepClone(), ["html"] = html }.ToJsonString());
    }

    private ModelHost Host(string name) { var dir = Path.Combine(Work, name, Guid.NewGuid().ToString("N")[..8]); Directory.CreateDirectory(dir); return new ModelHost(dir); }

    private static (JsonObject Read, string Html, string Sha) Read(ModelHost host, string oml, string screen, bool keys = false)
    {
        var bytes = File.ReadAllBytes(oml);
        var read = host.HtmlRead(bytes, screen, withKeys: keys);
        return (read, read["documents"]![0]!["html"]!.ToString(), Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
    }

    private static JsonObject BasedOn(string sha, JsonObject read) => new() { ["capture"] = sha, ["html"] = read["documents"]![0]!["htmlSha256"]!.DeepClone() };
    private static JsonObject WholeDocument(string sha, JsonObject read, string screen, string html) => new() { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html",
        ["data"] = new JsonObject { ["screen"] = screen, ["basedOn"] = BasedOn(sha, read), ["html"] = html } }) };
    private static JsonObject EditJob(string sha, JsonObject read, string screen, IEnumerable<string> edits) => new() { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html",
        ["data"] = new JsonObject { ["screen"] = screen, ["basedOn"] = BasedOn(sha, read), ["edit"] = new JsonArray(edits.Select(e => (JsonNode)e).ToArray()) } }) };

    private JsonObject Run(ModelHost host, string basePath, JsonObject job, string name)
    {
        var dir = host.WorkDirectory;
        var jobPath = Path.Combine(dir, name + ".json"); File.WriteAllText(jobPath, job.ToJsonString());
        try { return JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, Path.Combine(dir, name + ".oml")))!.AsObject(); }
        catch (Exception error) {
            var coded = Errors.FindCoded(error);
            output.WriteLine(name + " refused: " + Errors.Text(error)[..Math.Min(2000, Errors.Text(error).Length)]);
            return new JsonObject { ["accepted"] = false, ["code"] = coded?.Code, ["problems"] = coded?.Problems?.DeepClone() };
        }
    }

    private static JsonArray Problems(JsonObject result) => result["problems"] as JsonArray ?? new JsonArray();
    private static ScreenHtml.Node Element(ScreenHtml.Node tree, string k) => ScreenHtmlText.Elements(tree).First(x => x.Node.Get("k") == k).Node;
    private static void Attribute(ScreenHtml.Node node, string name, string value)
    {
        var i = node.Attributes.FindIndex(a => a.Key == name);
        if (i >= 0) node.Attributes[i] = new(name, value); else node.Attributes.Add(new(name, value));
    }
}
