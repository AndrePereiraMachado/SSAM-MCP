using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The kernel review of the Traditional html port (findings 3 and 5), on both lanes, without a Studio model: an html edit
/// (the whole document with screen and basedOn) is judged DEFAULT_NOT_LITERAL against the reading the store keeps (a
/// default new or changed from the reading and no literal is refused; one the reading had is kept; a Traditional root takes
/// expression defaults), and data.css on an edit follows the page's &lt;style&gt; in its style sheet, as on a create
/// (docs/SSAM-HTML.md, Fidelity, CSS). Synthetic names.
/// </summary>
public sealed class ScreenHtmlEditReviewTests
{
    private static string Lane => typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc") != null ? "odc" : "o11";

    private const string Reading = """
        <screen name="ReviewDefaults" actions="Save">
        <input k="w1" name="Since" type="Date" default="CurrDate()"/>
        <var k="w2" name="Busy" type="Boolean"/>
        <var k="w3" name="Count" type="Integer" default="3"/>
        <div k="w4" class="page">{{ Count }}</div>
        </screen>
        """;

    /// <summary>A store of the test's own (a temporary root, the default of this flow of execution only) keeping the reading.</summary>
    private sealed class OwnStore : IDisposable
    {
        public readonly ModuleIndexStore Store;
        private readonly IDisposable scope;
        public OwnStore()
        {
            Store = new ModuleIndexStore(Path.Combine(Path.GetTempPath(), "review-store-" + Guid.NewGuid().ToString("N")), Lane, "kernel");
            scope = ModuleIndexStore.Use(Store);
        }
        public void Keep(string capture, string htmlSha, string rootKind, string html)
        {
            var file = Store.HtmlKeysPathOf(capture, htmlSha);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, new JsonObject {
                ["schema"] = ScreenHtml.Schema, ["extractor"] = ScreenHtml.Extractor, ["lane"] = Lane, ["sourceSha256"] = capture, ["root"] = "ReviewDefaults",
                ["rootKey"] = "k0", ["rootKind"] = rootKind, ["htmlSha256"] = htmlSha, ["keys"] = new JsonObject(), ["html"] = html }.ToJsonString());
        }
        public void Dispose()
        {
            scope.Dispose();
            try { if (Directory.Exists(Store.Root)) Directory.Delete(Store.Root, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    private static readonly string Capture = new('c', 64), HtmlSha = new('d', 64);

    private static JsonArray EditOps(string html, string capture) => new(new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
        ["screen"] = "ReviewDefaults", ["basedOn"] = new JsonObject { ["capture"] = capture, ["html"] = HtmlSha }, ["html"] = html } });

    private static List<JsonObject> Defaults(string html, string capture = "")
        => HtmlDocumentRules.Check(EditOps(html, capture.Length == 0 ? Capture : capture), "/ops", Lane).Where(p => p["code"]?.ToString() == "DEFAULT_NOT_LITERAL").ToList();

    [Fact]
    public void AnEditIsRefusedANewOrChangedDefaultThatIsNoLiteralAndKeepsTheReadingsOwn()
    {
        using var store = new OwnStore();
        store.Keep(Capture, HtmlSha, "MobileScreen", Reading);
        // The reading as it is (its input keeps CurrDate(), the runtime accepted it): nothing to say.
        Assert.Empty(Defaults(Reading));
        // A default the edit writes on a variable that had none, one it changes, one on a new variable: each refused, named.
        var edited = Reading.Replace("name=\"Busy\" type=\"Boolean\"", "name=\"Busy\" type=\"Boolean\" default=\"Count &gt; 2\"")
            .Replace("default=\"CurrDate()\"", "default=\"AddDays(CurrDate(), 1)\"")
            .Replace("<div k=\"w4\"", "<var name=\"Extra\" type=\"Integer\" default=\"Count + 1\"/>\n<div k=\"w4\"");
        var refused = Defaults(edited);
        Assert.Equal(3, refused.Count);
        Assert.Contains(refused, p => p["message"]!.ToString().Contains("variable Busy of ReviewDefaults is 'Count > 2' (the reading has none)", StringComparison.Ordinal));
        Assert.Contains(refused, p => p["message"]!.ToString().Contains("input Since of ReviewDefaults is 'AddDays(CurrDate(), 1)' (the reading has 'CurrDate()')", StringComparison.Ordinal));
        Assert.Contains(refused, p => p["message"]!.ToString().Contains("variable Extra", StringComparison.Ordinal));
        Assert.All(refused, p => Assert.Equal("/ops/0/data/html", p["pointer"]!.ToString()));
        Assert.All(refused, p => Assert.Contains("OnInitialize", p["fix"]!.ToString(), StringComparison.Ordinal));
        // A literal default is never refused, new or changed.
        Assert.Empty(Defaults(Reading.Replace("name=\"Busy\" type=\"Boolean\"", "name=\"Busy\" type=\"Boolean\" default=\"True\"").Replace("default=\"3\"", "default=\"4\"")));
        // The same edit of a Traditional root: its runtime takes expression defaults.
        using (var traditional = new OwnStore()) {
            traditional.Keep(Capture, HtmlSha, "WebScreen", Reading);
            Assert.Empty(Defaults(edited));
        }
        // The reading not kept here: the edit plan judges it at apply (with the reading of the module), not the preflight.
        Assert.Empty(Defaults(edited, new string('e', 64)));
    }

    [Fact]
    public void DataCssOnAnEditFollowsThePagesStyleAsOnACreate()
    {
        const string css = ".probe-b { color: blue; }";
        // The whole document: its <style> first, then data.css (never one in place of the other).
        var whole = ScreenHtmlEdit.WithCss(["<screen name=\"Page\">\n<style>.probe-a { color: red; }</style>\n<div k=\"w1\"/>\n</screen>\n"], css);
        Assert.Equal(".probe-a { color: red; }\n" + css, Sheet(whole[0]));
        // A <style> edit beside element edits: the same.
        var styleEdit = ScreenHtmlEdit.WithCss(["<div k=\"w1\" class=\"x\"/>", "<style>.probe-a { color: red; }\n</style>"], css);
        Assert.Equal(2, styleEdit.Count);
        Assert.Equal(".probe-a { color: red; }\n" + css, Sheet(styleEdit[1]));
        // Element edits alone: the reading's <style> stays, data.css after it.
        var elements = ScreenHtmlEdit.WithCss(["<div k=\"w1\" class=\"x\"/>"], css, "<screen name=\"Page\">\n<style>.read { margin: 0; }</style>\n<div k=\"w1\"/>\n</screen>\n");
        Assert.Equal(2, elements.Count);
        Assert.Equal(".read { margin: 0; }\n" + css, Sheet(elements[1]));
        // No <style> anywhere: data.css alone (the create's rule, ScreenDocument.OwnSheet).
        Assert.Equal(css, Sheet(ScreenHtmlEdit.WithCss(["<screen name=\"Page\"><div k=\"w1\"/></screen>"], css)[0]));
        Assert.Equal(css, Sheet(ScreenHtmlEdit.WithCss(["<div k=\"w1\"/>"], css, "<screen name=\"Page\"><div k=\"w1\"/></screen>")[1]));
        // A theme-scoped <style> is not the page's sheet.
        var theme = ScreenHtmlEdit.WithCss(["<screen name=\"Page\"><style scope=\"theme\">.t{}</style><div k=\"w1\"/></screen>"], css);
        Assert.Contains("<style scope=\"theme\">.t{}</style>", theme[0]);
        Assert.Equal(css, Sheet(theme[0]));
        Assert.Throws<FormatException>(() => ScreenHtmlEdit.WithCss(["<div k=\"w1\"/>"], ".a{}</style>"));
    }

    public static IEnumerable<object[]> Fixtures()
    {
        if (Lane == "odc") yield return ["odc/insurance-reactive-r8.oml", "AppRole:InsuranceApp"];
        else yield return ["reactive-ui.oml", "Registered"];
    }

    // The edit plan says it with the reading of the module, on each runtime, when no store keeps the reading (a job run
    // outside SSAM's reading, the reviewer's html-default-edit): the html op is refused, nothing is written.
    [Theory]
    [MemberData(nameof(Fixtures))]
    public void ANonLiteralDefaultWrittenByAnEditIsRefusedByThePlanOnEveryRuntime(string fixture, string role)
    {
        var binder = typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc") ?? typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var bind = binder.GetMethods().First(m => m.Name == "Bind");
        bind.Invoke(null, bind.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenHtmlEditReviewTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "screen-html-edit-review", fixture.Replace('/', '-'), Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        using var empty = new OwnStore();
        JsonObject Run(string source, JsonObject job, string name)
        {
            var path = Path.Combine(work, name + ".json");
            File.WriteAllText(path, job.ToJsonString());
            try { return JsonSerializer.SerializeToNode(JobRunner.Run(host, source, path, Path.Combine(work, name + ".oml")))!.AsObject(); }
            catch (Exception error) { var coded = Errors.FindCoded(error); return new JsonObject { ["accepted"] = false, ["text"] = Errors.Text(error), ["problems"] = coded?.Problems?.DeepClone() }; }
        }
        var created = Run(Path.Combine(root, "tests", "fixtures", fixture), new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
            ["html"] = $"<screen name=\"ReviewDefaults\" roles=\"{role}\">\n<var name=\"Busy\" type=\"Boolean\"/>\n<var name=\"Count\" type=\"Integer\" default=\"3\"/>\n<div class=\"page\">{{{{ Count }}}}</div>\n</screen>" } }) }, "created");
        Assert.True(created["accepted"]?.GetValue<bool>() == true, created.ToJsonString());
        var source = Path.Combine(work, "created.oml");
        var bytes = File.ReadAllBytes(source);
        var document = host.HtmlRead(bytes, "ReviewDefaults", withKeys: true)["documents"]![0]!;
        var html = document["html"]!.ToString();
        JsonObject Edit(string value, string name)
        {
            var tree = ScreenHtml.Parse(html);
            var busy = ScreenHtmlText.Elements(tree).First(x => x.Node.Get("name") == "Busy").Node;
            busy.Attributes.Add(new("default", value));
            return Run(source, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
                ["screen"] = "ReviewDefaults", ["html"] = ScreenHtmlText.Write(tree),
                ["basedOn"] = new JsonObject { ["capture"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), ["html"] = document["htmlSha256"]!.DeepClone() } } }) }, name);
        }
        var refused = Edit("Count > 2", "edited");
        Assert.False(refused["accepted"]?.GetValue<bool>() == true, refused.ToJsonString());
        var problem = Assert.Single((refused["problems"] as JsonArray ?? new JsonArray()).OfType<JsonObject>(), p => p["code"]?.ToString() == "DEFAULT_NOT_LITERAL");
        Assert.Contains("variable Busy of ReviewDefaults is 'Count > 2' (the reading has none)", problem["message"]!.ToString(), StringComparison.Ordinal);
        Assert.True(Edit("True", "literal")["accepted"]?.GetValue<bool>() == true);
    }

    // The CSS of the page's own <style> (the first without scope) of an edit text.
    private static string Sheet(string edit)
    {
        var tree = ScreenHtml.Parse(edit);
        var top = tree.Children.First(n => !n.IsText);
        var style = top.Tag == "style" ? top : top.Children.First(n => !n.IsText && n.Tag == "style" && n.Get("scope") == null);
        return string.Concat(style.Children.Select(c => c.Text));
    }
}
