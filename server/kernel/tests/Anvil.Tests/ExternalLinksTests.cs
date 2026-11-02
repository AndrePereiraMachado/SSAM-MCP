using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>C-23 (F-AiChatbot-03, 27/10), Reactive and Mobile: the href of an &lt;a&gt; was an extended property the runtime
/// drops (the Verify asked "On Click must be set"). A link to a URL is its On Click through the module's external site
/// (RedirectToURL), in a new document and in an edit; what cannot be written so is refused with its fix (and the patch when
/// certain). Traditional: ExternalURL, and the #anchor of an element of the document.</summary>
public sealed class ExternalLinksTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ExternalLinksTests).Assembly.Location)!)!;

    // ---- the normalization alone (no module) ----------------------------------------------------------------------------

    [Fact]
    public void AReactiveHrefIsRewrittenAsTheOnClickOfTheExternalSiteAndWhatStaysIsLeftForTheCompiler()
    {
        var ops = new JsonArray(Html("""
            <screen name="Links">
             <a class="social" href="https://example.test/a?b=1&amp;c=2" target="_blank">Site</a>
             <a href="{{ Url }}">Bound</a>
             <a href="#" onclick="Save">Save</a>
             <a href="#Services">Anchor</a>
             <a href="https://example.test" onclick="Save">Both</a>
            </screen>
            """));
        var done = new List<JsonObject>();
        ExternalLinks.Normalize(ops, "/ops", "Reactive", done);
        var html = ops[0]!["data"]!["html"]!.ToString();
        output.WriteLine(html);
        Assert.Contains("onclick='RedirectToURL(URL = \"https://example.test/a?b=1&amp;c=2\")' target=\"_blank\"", html);
        Assert.Contains("onclick=\"RedirectToURL(URL = Url)\"", html);
        Assert.Contains("<a onclick=\"Save\">Save</a>", html);
        Assert.Contains("<a href=\"#Services\">Anchor</a>", html);
        Assert.Contains("<a href=\"https://example.test\" onclick=\"Save\">Both</a>", html);
        Assert.Equal(3, done.Count(d => d["code"]?.ToString() == ExternalLinks.Rewritten || d["rule"]?.ToString() == ExternalLinks.Rewritten));
    }

    /// <summary>C-23, the Traditional half (proto e699810c): a URL is the On Click of the template's external site ExternalURL
    /// (target stays), and an anchor of an element of the same document (#Services with id="Services") is ExternalURL(URL =
    /// "#" + Services.Id); an anchor of no element and an href beside an onclick stay, for the compiler to refuse.</summary>
    [Fact]
    public void ATraditionalHrefIsTheOnClickOfExternalUrlAndAnAnchorNamesItsElement()
    {
        var ops = new JsonArray(Html("""
            <screen name="Links">
             <div id="Services">Services</div>
             <a class="social" href="https://example.test/a" target="_blank">Site</a>
             <a href="#Services">Go</a>
             <a href="#Nowhere">Lost</a>
             <a href="https://example.test" onclick="Save">Both</a>
            </screen>
            """));
        var done = new List<JsonObject>();
        ExternalLinks.Normalize(ops, "/ops", "WebResponsive", done);
        var html = ops[0]!["data"]!["html"]!.ToString();
        output.WriteLine(html);
        Assert.Contains("<a class=\"social\" onclick='ExternalURL(URL = \"https://example.test/a\")' target=\"_blank\">Site</a>", html);
        Assert.Contains("<a onclick='ExternalURL(URL = \"#\" + Services.Id)'>Go</a>", html);
        Assert.Contains("<a href=\"#Nowhere\">Lost</a>", html);
        Assert.Contains("<a href=\"https://example.test\" onclick=\"Save\">Both</a>", html);
        Assert.Equal(2, done.Count(d => d["rule"]?.ToString() == ExternalLinks.Rewritten));
        Assert.Contains(done, d => d["message"]!.ToString().Contains("ExternalURL", StringComparison.Ordinal));
    }

    // ---- with the Studio: a new document and an edit, accepted and read back --------------------------------------------

    [Fact]
    public void AReactiveLinkToAUrlIsItsOnClickInANewDocumentAndInAnEdit()
    {
        StudioAssemblies.Bind();
        var work = Path.Combine(Root, ".local", "external-links-tests", "reactive-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work); output.WriteLine(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var html = """
            <screen name="LinksPage" roles="Registered">
            <var name="Url" type="Text" default="&quot;https://example.test/social&quot;"/>
            <div class="footer">
             <a class="social" href="https://example.test/a?b=1&amp;c=2" target="_blank">Site</a>
             <a class="social" href="{{ Url }}" target="_blank">Social</a>
            </div>
            </screen>
            """;
        var created = Run(host, work, Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml"), new JsonArray(Html(html)), "create");
        Assert.Contains(ExternalLinks.Rewritten, created.ToJsonString());
        var bytes = File.ReadAllBytes(Path.Combine(work, "create.oml"));
        var document = host.HtmlRead(bytes, "MobileScreen:LinksPage", withKeys: true)["documents"]![0]!;
        var read = document["html"]!.ToString();
        File.WriteAllText(Path.Combine(work, "read.html"), read);
        Assert.Contains("onclick='RedirectToURL(URL = \"https://example.test/a?b=1&amp;c=2\")'", read);
        Assert.Contains("onclick=\"RedirectToURL(URL = Url)\"", read);
        Assert.Equal(2, System.Text.RegularExpressions.Regex.Matches(read, "target=\"_blank\"").Count);
        Assert.DoesNotContain("href=", read);

        // The edit form: a new link with href in the read page is written the same way.
        var tree = ScreenHtml.Parse(read);
        var footer = ScreenHtmlText.Elements(tree).First(n => n.Node.Get("class") == "footer").Node;
        footer.Children.Add(new ScreenHtml.Node { Tag = "a", Attributes = [new("class", "social"), new("href", "https://example.test/new")], Children = [new ScreenHtml.Node { Text = "New" }] });
        var edited = Run(host, work, Path.Combine(work, "create.oml"), new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
            ["screen"] = "LinksPage", ["html"] = ScreenHtmlText.Write(tree),
            ["basedOn"] = new JsonObject { ["capture"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), ["html"] = document["htmlSha256"]!.DeepClone() } } }), "edit");
        Assert.Contains(ExternalLinks.Rewritten, edited.ToJsonString());
        var after = host.HtmlRead(File.ReadAllBytes(Path.Combine(work, "edit.oml")), "MobileScreen:LinksPage")["documents"]![0]!["html"]!.ToString();
        File.WriteAllText(Path.Combine(work, "after.html"), after);
        Assert.Contains("onclick='RedirectToURL(URL = \"https://example.test/new\")'", after);
    }

    [Fact]
    public void AReactiveHrefBesideAnOnclickOrAnAnchorIsRefusedNeverDropped()
    {
        StudioAssemblies.Bind();
        var work = Path.Combine(Root, ".local", "external-links-tests", "refused-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work); output.WriteLine(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var html = """
            <screen name="LinksRefused" roles="Registered" actions="Save">
            <div id="Services">Services</div>
            <a href="https://example.test" onclick="Save">Both</a>
            <a href="#Services">Anchor</a>
            </screen>
            """;
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(Html(html),
            JsonNode.Parse("""{"op":"logic","data":{"flow":"action LinksRefused.Save\n  end"}}""")) }.ToJsonString());
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml"), job, Path.Combine(work, "out.oml")));
        var problems = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).Select(p => p!.AsObject()).Where(p => p["code"]!.ToString() == ExternalLinks.Unsupported).ToList();
        output.WriteLine(string.Join("\n", problems.Select(p => p.ToJsonString())));
        Assert.Equal(2, problems.Count);
        Assert.Contains(problems, p => p["fix"]!.ToString().Contains("ScrollToElement", StringComparison.Ordinal));
        var both = problems.Single(p => p["message"]!.ToString().Contains("onclick", StringComparison.Ordinal));
        Assert.Contains("<a onclick=\"Save\">Both</a>", both["patch"]![0]!["value"]!.ToString());
    }

    [Fact]
    public void ATraditionalLinkToAUrlOrAnAnchorOpensItThroughExternalUrl()
    {
        StudioAssemblies.Bind();
        var work = Path.Combine(Root, ".local", "external-links-tests", "traditional-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work); output.WriteLine(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var html = """
            <screen name="TradLinks" roles="Registered">
             <div id="Services">Services</div>
             <a class="social" href="https://example.test/a" target="_blank">Site</a>
             <a href="#Services">Go</a>
             <a onclick='ExternalURL(URL = "https://example.test/b")'>Direct</a>
            </screen>
            """;
        var created = Run(host, work, Path.Combine(Root, "tests", "fixtures", "traditional-ui.oml"), new JsonArray(Html(html)), "create");
        Assert.Equal(2, (created["normalizations"] as JsonArray ?? []).Count(n => n?["rule"]?.ToString() == ExternalLinks.Rewritten));
        var read = host.HtmlRead(File.ReadAllBytes(Path.Combine(work, "create.oml")), "TradLinks")["documents"]![0]!["html"]!.ToString();
        File.WriteAllText(Path.Combine(work, "read.html"), read);
        Assert.Contains("onclick='ExternalURL(URL = \"https://example.test/a\")'", read);
        Assert.Contains("onclick='ExternalURL(URL = \"#\" + Services.Id)'", read);
        Assert.Contains("onclick='ExternalURL(URL = \"https://example.test/b\")'", read);
        Assert.Contains("target=\"_blank\"", read);
        Assert.DoesNotContain("href=", read);
    }

    /// <summary>C-23, Traditional: what the normalization leaves (an href beside an onclick, an anchor of no element) was an
    /// extended property the runtime drops; it is HTML_HREF_UNSUPPORTED with the Traditional fix, and the patch that drops the
    /// href beside an onclick.</summary>
    [Fact]
    public void ATraditionalHrefBesideAnOnclickOrAnAnchorOfNoElementIsRefusedNeverDropped()
    {
        StudioAssemblies.Bind();
        var work = Path.Combine(Root, ".local", "external-links-tests", "trad-refused-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work); output.WriteLine(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var html = """
            <screen name="TradRefused" roles="Registered">
             <a href="https://example.test" onclick="Save">Both</a>
             <a href="#Nowhere">Lost</a>
            </screen>
            """;
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(Html(html),
            JsonNode.Parse("""{"op":"logic","data":{"flow":"action TradRefused.Save\n  end"}}""")) }.ToJsonString());
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, Path.Combine(Root, "tests", "fixtures", "traditional-ui.oml"), job, Path.Combine(work, "out.oml")));
        var problems = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).Select(p => p!.AsObject()).Where(p => p["code"]!.ToString() == ExternalLinks.Unsupported).ToList();
        output.WriteLine(Errors.Text(error) + "\n" + string.Join("\n", problems.Select(p => p.ToJsonString())));
        Assert.Equal(2, problems.Count);
        Assert.Contains(problems, p => p["fix"]!.ToString().Contains("Services.Id", StringComparison.Ordinal));
        var both = problems.Single(p => p["message"]!.ToString().Contains("onclick", StringComparison.Ordinal));
        Assert.Contains("<a onclick=\"Save\">Both</a>", both["patch"]![0]!["value"]!.ToString());
    }

    private static JsonObject Html(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };

    private JsonNode Run(ModelHost host, string work, string source, JsonArray ops, string name)
    {
        var job = Path.Combine(work, name + ".json");
        File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, source, job, Path.Combine(work, name + ".oml")))!;
        File.WriteAllText(Path.Combine(work, name + "-result.json"), result.ToJsonString());
        Assert.True(result["accepted"]?.GetValue<bool>() == true, work + "\n" + result);
        return result;
    }
}
