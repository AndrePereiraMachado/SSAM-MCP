using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

public class TraditionalHtmlControlsTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void DataControlsCreateReadEditAndMergeWithTheirHandlers(bool canonicalTags)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalHtmlControlsTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "traditional-html-controls", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work); output.WriteLine(work);
        var host = new ModelHost(work);
        var html = """
          <screen name="ControlAudit" roles="Registered" actions="Changed">
           <var name="EnabledChoice" type="Boolean" default="True"/>
           <var name="Secret" type="Text"/>
           <var name="Choice" type="Text" default='"A"'/>
           <var name="Person" type="User Identifier"/>
           <var name="Row" type="AuditRow"/>
           <var name="Changes" type="Integer"/>
           <form id="AuditForm" record="Row" editable="True">
            <input id="Check" type="checkbox" bind="EnabledChoice" onchange="Changed" enabled="True"/>
            <input id="SecretInput" type="password" bind="Secret" onchange="Changed" maxlength="60" os-Width="8 col"/>
            <input id="RadioA" type="radio" bind="Choice" value='"A"' onchange="Changed"/>
            <input id="RadioB" type="radio" bind="Choice" value='"B"' onchange="Changed" os-Visible="True" os-MarginLeft="Adaptive"/>
            <select bind="Person" source-entity="IEntitySignature:User" source-attribute="IEntitySignature:User/Name" required="False"/>
            <button onclick="Changed" method="Ajax">Apply</button>
            <div id="ControlResults"><span>{{ Changes }}</span></div>
           </form>
          </screen>
          """;
        if (canonicalTags) html = html.Replace("input id=\"Check\" type=\"checkbox\"", "checkbox-input id=\"Check\"")
            .Replace("input id=\"SecretInput\" type=\"password\"", "password-input id=\"SecretInput\"")
            .Replace("input id=\"RadioA\" type=\"radio\"", "radio-input id=\"RadioA\"")
            .Replace("input id=\"RadioB\" type=\"radio\"", "radio-input id=\"RadioB\"");
        string Run(string source, JsonArray ops, string name) {
            var job = Path.Combine(work, name + ".json"); var candidate = Path.Combine(work, name + ".oml");
            File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
            var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, source, job, candidate))!;
            File.WriteAllText(Path.Combine(work, name + "-result.json"), applied.ToJsonString());
            Assert.True(applied["accepted"]?.GetValue<bool>() == true, applied.ToJsonString());
            var mergeWork = Path.Combine(work, name + "-merge"); Directory.CreateDirectory(mergeWork);
            var plan = new MergePlanner(_ => host).Plan(source, candidate, Path.Combine(mergeWork, "first-pass.oml"));
            File.WriteAllText(Path.Combine(work, name + "-merge-proof.json"), plan.ToJsonString());
            Assert.True(plan["contentPreview"]!["accepted"]!.GetValue<bool>(), plan.ToJsonString());
            return plan["contentPreview"]!["path"]!.ToString();
        }
        var created = Run(Path.Combine(root, "tests", "fixtures", "traditional-ui.oml"), new JsonArray(
            JsonNode.Parse("""{"op":"spec","data":{"structures":[{"name":"AuditRow","attributes":[{"name":"Caption","type":"Text"}]}]}}"""),
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "action ControlAudit.Changed\n  assign Changes = Changes + 1\n  node AjaxRefreshNode()\n    @{WidgetOrWebBlock=&\"ControlResults\"}\n  end" } }), "create");
        var bytes = File.ReadAllBytes(created);
        var document = host.HtmlRead(bytes, "ControlAudit", withKeys: true)["documents"]![0]!;
        var before = document["html"]!.ToString(); File.WriteAllText(Path.Combine(work, "before.html"), before);
        Assert.DoesNotContain("os-opaque", before);
        Assert.Contains("radio-input", before); Assert.Contains("bind=\"Choice\"", before);
        Assert.Contains("onchange=\"Changed\"", before);
        var tree = ScreenHtml.Parse(before);
        var radio = ScreenHtmlText.Elements(tree).Single(n => n.Node.Get("id") == "RadioB").Node;
        var classIndex = radio.Attributes.FindIndex(a => a.Key == "class");
        Assert.True(classIndex >= 0); radio.Attributes[classIndex] = new("class", "audit-choice");
        var form = ScreenHtmlText.Elements(tree).Single(n => n.Node.Get("id") == "AuditForm").Node;
        form.Attributes.Add(new("class", "audit-form"));
        var edited = Run(created, new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
            ["screen"] = "ControlAudit", ["html"] = ScreenHtmlText.Write(tree),
            ["basedOn"] = new JsonObject { ["capture"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), ["html"] = document["htmlSha256"]!.DeepClone() }
        } }), "edit");
        var after = host.HtmlRead(File.ReadAllBytes(edited), "ControlAudit")["documents"]![0]!["html"]!.ToString();
        File.WriteAllText(Path.Combine(work, "after.html"), after);
        // Traditional Form stores class as an extended attribute; the canonical reader makes that explicit.
        var formClassIndex = form.Attributes.FindIndex(a => a.Key == "class");
        form.Attributes[formClassIndex] = new("ext:class", "audit-form");
        Assert.Equal(ScreenHtmlText.WithoutKeys(ScreenHtmlText.Write(tree)), ScreenHtmlText.WithoutKeys(after));
        var cloneHtml = ScreenHtmlText.WithoutKeys(after).Replace("name=\"ControlAudit\"", "name=\"ControlClone\"");
        var clone = Run(edited, new JsonArray(
            new JsonObject { ["op"]="html", ["data"]=new JsonObject { ["html"]=cloneHtml } },
            new JsonObject { ["op"]="logic", ["data"]=new JsonObject { ["flow"]="action ControlClone.Changed\n  assign Changes = Changes + 1\n  node AjaxRefreshNode()\n    @{WidgetOrWebBlock=&\"ControlResults\"}\n  end" } }),"recreate");
        var cloned = host.HtmlRead(File.ReadAllBytes(clone),"ControlClone")["documents"]![0]!["html"]!.ToString();
        File.WriteAllText(Path.Combine(work,"recreated.html"),cloned);
        Assert.Equal(cloneHtml,ScreenHtmlText.WithoutKeys(cloned));
    }

    // ---- wave 1 of the Figma apps (27/10): the defaults of the Traditional widgets the document wrote without a word -------
    private static string Root => JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalHtmlControlsTests).Assembly.Location)!)!;
    private static string Basis => Path.Combine(Root, "tests", "fixtures", "traditional-ui.oml");
    private static JsonNode Spec() => JsonNode.Parse("""{"op":"spec","data":{"structures":[{"name":"AuditRow","attributes":[{"name":"Caption","type":"Text"}]}]}}""")!;
    private static JsonObject Html(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };

    private (ModelHost Host, string Work) Workspace(string name)
    {
        StudioAssemblies.Bind();
        var work = Path.Combine(Root, ".local", "traditional-html-controls", name + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work); output.WriteLine(work);
        return (new ModelHost(Path.Combine(work, "model")), work);
    }

    private static JsonNode Apply(ModelHost host, string work, string basis, JsonArray ops, string name)
    {
        var job = Path.Combine(work, name + ".json");
        File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, Path.Combine(work, name + ".oml")))!;
        File.WriteAllText(Path.Combine(work, name + "-result.json"), result.ToJsonString());
        Assert.True(result["accepted"]?.GetValue<bool>() == true, work + "\n" + result);
        return result;
    }

    // The properties of the first element a target names in a module (a get op of the kernel).
    private static JsonObject Properties(ModelHost host, string work, string oml, string target)
    {
        var job = Path.Combine(work, "get-" + Guid.NewGuid().ToString("N")[..6] + ".json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "get", ["target"] = target }) }.ToJsonString());
        var read = JsonSerializer.SerializeToNode(JobRunner.Run(host, oml, job, Path.Combine(work, "get.oml")))!;
        return read["results"]![0]!["result"]!["properties"]!.AsObject();
    }

    private static string Read(ModelHost host, string oml, string root) => host.HtmlRead(File.ReadAllBytes(oml), root)["documents"]![0]!["html"]!.ToString();

    // The reading written again as a new document (another root name) reads the same.
    private void ReadsTheSameRecreated(ModelHost host, string work, string oml, string root, string read, JsonArray? also = null)
    {
        var copy = ScreenHtmlText.WithoutKeys(read).Replace("name=\"" + root + "\"", "name=\"" + root + "Copy\"");
        var ops = new JsonArray(Html(copy));
        foreach (var op in also ?? []) ops.Add(op!.DeepClone());
        Apply(host, work, oml, ops, "copy");
        var again = Read(host, Path.Combine(work, "copy.oml"), root + "Copy");
        File.WriteAllText(Path.Combine(work, "copy.html"), read + "\n" + again);
        Assert.Equal(copy, ScreenHtmlText.WithoutKeys(again));
    }

    /// <summary>C-07 (F-FT-06, FigmaTraditional 27/10): line-separator="None" on a list-records was an extended property: the
    /// runtime kept a &lt;br&gt; between the rows (the plans grid 2453 px wide instead of 740, 114 &lt;br&gt; in the AiChatbot)
    /// while the reading said line-separator="None". It is the list's Line Separator, and the reading says what the list has.</summary>
    [Fact]
    public void LineSeparatorIsTheListsOwnPropertyAndTheReadingSaysWhatTheListHas()
    {
        var (host, work) = Workspace("line-separator");
        var html = """
          <screen name="PlansGrid" roles="Registered">
           <var name="Plans" type="AuditRow List"/>
           <list-records id="PlansList" class="fm-plans-grid" source="Plans" line-separator="None">
            <div class="fm-plan">{{ Plans.Current.Caption }}</div>
           </list-records>
           <div list="Plans" line-separator="Bullets" class="fm-dots">{{ Plans.Current.Caption }}</div>
          </screen>
          """;
        Apply(host, work, Basis, new JsonArray(Spec(), Html(html)), "create");
        var oml = Path.Combine(work, "create.oml");
        var grid = Properties(host, work, oml, "IWebScreen:PlansGrid/**IListRecordsWidget[1]");
        Assert.Equal("None", grid["LineSeparator"]?.ToString());
        Assert.Equal("0", grid["ExtendedProperties"]?.ToString());
        Assert.Equal("Bullets", Properties(host, work, oml, "IWebScreen:PlansGrid/**IListRecordsWidget[2]")["LineSeparator"]?.ToString());
        var read = Read(host, oml, "PlansGrid");
        File.WriteAllText(Path.Combine(work, "read.html"), read);
        Assert.Contains("line-separator=\"None\"", read);
        Assert.Contains("line-separator=\"Bullets\"", read);
        Assert.DoesNotContain("ext:line-separator", read);
        ReadsTheSameRecreated(host, work, oml, "PlansGrid", read);
        // what no list has is refused before the build, with what to write
        var refused = TraditionalDocumentRules.Lint("<screen name='Refused'><var name='Plans' type='AuditRow List'/><list-records source='Plans' line-separator='Comma'><div>x</div></list-records><table-records source='Plans' line-separator='None'><tr><td>a</td></tr><tr><td>b</td></tr></table-records></screen>", out _);
        Assert.Contains(refused, p => p.Message.Contains("line-separator=\"Comma\"") && p.Fix!.Contains("None"));
        Assert.Contains(refused, p => p.Message.Contains("line-separator") && p.Message.Contains("<table-records>"));
    }

    /// <summary>C-08 (F-FT-08 Fitmaker and the AiChatbot steps, 27/10): every &lt;span&gt; was a Container with an inline
    /// style="display: inline;" that beat the display of its class (the steps' descriptions beside their titles, the logo's
    /// square gone, "Search" shown on the desktop), and the literal text beside it lost its spaces ("OurServices",
    /// "With Over5 Yearsof"). The class decides the display when the document's CSS gives it one; the whitespace beside an inline
    /// element on the same line is the page's, as the reading writes it.</summary>
    [Fact]
    public void ASpanKeepsTheDisplayOfItsClassAndTheTextBesideItKeepsItsSpaces()
    {
        var (host, work) = Workspace("span");
        var html = """
          <screen name="SpanAudit" roles="Registered">
           <style>.ac-step-desc { display: block; } .fm-logo-mark { display: inline-block; width: 24px; height: 24px; }</style>
           <div class="fm-title">Our <span class="fm-red">Services</span></div>
           <div class="fm-stats">With Over <span class="fm-num">5</span> Years of</div>
           <div class="fm-pair"><span class="fm-a">A</span> <span class="fm-b">B</span></div>
           <div class="ac-step"><span class="ac-step-title">Step one</span><span class="ac-step-desc">Describe the goal</span></div>
           <div class="fm-logo"><span class="fm-logo-mark"></span>
            Fitmaker
           </div>
          </screen>
          """;
        Apply(host, work, Basis, new JsonArray(Html(html)), "create");
        var oml = Path.Combine(work, "create.oml");
        var read = Read(host, oml, "SpanAudit");
        File.WriteAllText(Path.Combine(work, "read.html"), read);
        // the spaces beside an inline element on the same line, exactly (the reading writes them in <text>)
        Assert.Contains("<text>Our </text>", read);
        Assert.Contains("<text>With Over </text>", read);
        Assert.Contains("<text> Years of</text>", read);
        Assert.Contains("<text> </text>", read);
        // a line break and its indentation are layout, never text
        Assert.Matches(@"\n\s*Fitmaker\n", read);
        // a class with no display in the document's CSS keeps the span inline; one with a display is that display
        Assert.Matches("class=\"fm-red\" style=\"display: inline;\"", read);
        Assert.Matches("<div k=\"[^\"]+\" class=\"ac-step-desc\">", host.HtmlRead(File.ReadAllBytes(oml), "SpanAudit", withKeys: true)["documents"]![0]!["html"]!.ToString());
        Assert.DoesNotMatch("class=\"ac-step-desc\" style=", read);
        Assert.DoesNotMatch("class=\"fm-logo-mark\" style=", read);
        ReadsTheSameRecreated(host, work, oml, "SpanAudit", read);
    }

    /// <summary>C-09 (F-FT-23 AiChatbot newsletter and request dialog, F-FT-07 Fitmaker join form, 27/10): a Traditional input was
    /// written with what the Studio gives a fresh one, not with what its text said: the theme's grid width (ThemeGrid_Width4 beat
    /// the class: a 125 px e-mail field) and Max Length 50 (an e-mail cut at 50 characters, a textarea too), and its label the
    /// grid's ThemeGrid_Width2. An input has the width, mandatory and max length its text gives, and the reading says them.</summary>
    [Fact]
    public void AnInputHasOnlyTheWidthMandatoryAndMaxLengthItsTextGives()
    {
        var (host, work) = Workspace("input-defaults");
        var html = """
          <screen name="JoinAudit" roles="Registered">
           <var name="JoinName" type="Text"/>
           <var name="NewsletterEmail" type="Email"/>
           <var name="Message" type="Text"/>
           <var name="Secret" type="Text"/>
           <var name="Grid" type="Text"/>
           <label class="fm-label" for="JoinNameInput">Name</label>
           <input id="JoinNameInput" bind="JoinName" type="text" placeholder="Enter Your Name" required maxlength="100" class="fm-input"/>
           <input id="NewsletterEmailInput" bind="NewsletterEmail" type="email" placeholder="Enter your email" class="ac-news-input"/>
           <textarea id="MessageInput" bind="Message" class="ac-field-input"/>
           <input id="SecretInput" type="password" bind="Secret"/>
           <input id="GridInput" bind="Grid" os-Width="4 col" maxlength="50"/>
          </screen>
          """;
        Apply(host, work, Basis, new JsonArray(Html(html)), "create");
        var oml = Path.Combine(work, "create.oml");
        static string? Text(JsonObject p, string name) => p[name]?.ToString() is { Length: > 0 } v ? v : null;
        var name = Properties(host, work, oml, "IWebScreen:JoinAudit/**IInputWidget[1]");
        Assert.Equal("JoinNameInput", Text(name, "Name"));
        Assert.Null(Text(name, "Width"));
        Assert.Equal("True", Text(name, "Mandatory"));
        Assert.Equal("100", Text(name, "MaxLength"));
        var email = Properties(host, work, oml, "IWebScreen:JoinAudit/**IInputWidget[2]");
        Assert.Equal("NewsletterEmailInput", Text(email, "Name"));
        Assert.Null(Text(email, "Width"));
        Assert.Equal("False", Text(email, "Mandatory"));
        Assert.Null(Text(email, "MaxLength"));
        var message = Properties(host, work, oml, "IWebScreen:JoinAudit/**IInputWidget[3]");
        Assert.Equal("MessageInput", Text(message, "Name"));
        Assert.Null(Text(message, "Width"));
        Assert.Null(Text(message, "MaxLength"));
        var grid = Properties(host, work, oml, "IWebScreen:JoinAudit/**IInputWidget[4]");
        Assert.Equal("GridInput", Text(grid, "Name"));
        Assert.Equal("4 col", Text(grid, "Width"));
        Assert.Equal("50", Text(grid, "MaxLength"));
        var secret = Properties(host, work, oml, "IWebScreen:JoinAudit/**IInputPasswordWidget");
        Assert.Null(Text(secret, "Width"));
        Assert.Equal("False", Text(secret, "Mandatory"));
        Assert.Null(Text(Properties(host, work, oml, "IWebScreen:JoinAudit/**ILabel"), "Width"));
        var read = Read(host, oml, "JoinAudit");
        File.WriteAllText(Path.Combine(work, "read.html"), read);
        // the reading says what differs from the text that left it out: the grid width and the max length written
        string Tag(string id) => System.Text.RegularExpressions.Regex.Match(read, "<[a-z-]+ [^>]*id=\"" + id + "\"[^>]*>").Value;
        Assert.Contains("maxlength=\"50\"", Tag("GridInput"));
        Assert.Contains("os-Width=\"4 col\"", Tag("GridInput"));
        Assert.DoesNotMatch("maxlength|os-Width|required", Tag("NewsletterEmailInput"));
        Assert.DoesNotMatch("maxlength|os-Width", Tag("MessageInput"));
        Assert.Contains("maxlength=\"100\"", Tag("JoinNameInput"));
        Assert.Contains("required=\"True\"", Tag("JoinNameInput"));
        Assert.DoesNotContain("os-Width", Tag("JoinNameInput"));
        ReadsTheSameRecreated(host, work, oml, "JoinAudit", read);
    }

    /// <summary>C-30 (F-FT-05 Fitmaker, 27/10): &lt;img&gt; was written as IImageWidget, which no Traditional parent creates:
    /// APPLY_FAILED "IContainerWidget '' cannot create IImageWidget" with no line, after the build. The installed Model API has
    /// no image widget a Web container creates, so the document refuses &lt;img&gt; before the build, and the patch is the
    /// Expression with Escape Content off that renders it (every value through EncodeHtml, as the Verify asks).</summary>
    [Fact]
    public void AnImageIsRefusedBeforeTheBuildWithTheExpressionThatRendersItAsThePatch()
    {
        var (host, work) = Workspace("img");
        // the fact behind the decision: the Model API creates no image widget in a Web container
        var probe = Path.Combine(work, "probe.json");
        File.WriteAllText(probe, """{"ops":[{"op":"create","parent":"IWebFlow:MainFlow","type":"IWebScreen","name":"ImageProbe","as":"$s"},{"op":"create","parent":"$s","type":"IContainerWidget","as":"$c"},{"op":"create","parent":"$c","type":"IImageWidget"}]}""");
        Assert.Contains("cannot create IImageWidget", Errors.Text(Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, Basis, probe, Path.Combine(work, "probe.oml")))));
        var html = """
          <screen name="HeroAudit" roles="Registered">
           <var name="ImageBaseUrl" type="Text" default='"https://images.example.com/"'/>
           <var name="HeroFile" type="Text" default='"hero.jpg"'/>
           <div class="fm-hero-frame"><img class="fm-hero-photo" alt="FitMaker coach" src="{{ ImageBaseUrl + HeroFile }}"/></div>
           <img id="Badge" src="https://images.example.com/badge.png" alt="Badge &amp; seal" if="Length(HeroFile) > 0"/>
          </screen>
          """;
        var job = Path.Combine(work, "refuse.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(Html(html)) }.ToJsonString());
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, Basis, job, Path.Combine(work, "refuse.oml")));
        var problems = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).OfType<JsonObject>().ToList();
        File.WriteAllText(Path.Combine(work, "refuse-problems.json"), new JsonArray(problems.Select(p => (JsonNode)p.DeepClone()).ToArray()).ToJsonString());
        var images = problems.Where(p => p["code"]?.ToString() == ScreenDocument.Traditional && p["message"]!.ToString().Contains("<img>")).ToList();
        Assert.Equal(2, images.Count);
        Assert.All(images, p => Assert.Equal("base", p["phase"]?.ToString()));
        Assert.All(images, p => Assert.Contains("os-EscapeContent", p["fix"]!.ToString()));
        Assert.DoesNotContain(problems, p => p["message"]!.ToString().Contains("cannot create"));
        var patch = images[0]["patch"]!.AsArray().Single()!.AsObject();
        Assert.Equal("replace", patch["op"]!.ToString());
        Assert.EndsWith("/data/html", patch["path"]!.ToString());
        var patched = patch["value"]!.ToString();
        File.WriteAllText(Path.Combine(work, "patched.html"), patched);
        Assert.DoesNotContain(ScreenHtmlText.Elements(ScreenHtml.Parse(patched)), e => e.Node.Tag == "img");
        Assert.Contains("EncodeHtml(ImageBaseUrl + HeroFile)", patched);
        Assert.Contains("os-EscapeContent=\"False\"", patched);
        Assert.Empty(TraditionalDocumentRules.Lint(patched, out _));
        // the patch applied is accepted (the Verify of an Expression without escape: every value is encoded)
        Apply(host, work, Basis, new JsonArray(Html(patched)), "patched");
        var read = Read(host, Path.Combine(work, "patched.oml"), "HeroAudit");
        File.WriteAllText(Path.Combine(work, "read.html"), read);
        Assert.Equal(2, System.Text.RegularExpressions.Regex.Matches(read, "os-EscapeContent=\"False\"").Count);
        Assert.Contains("fm-hero-photo", read);
        Assert.Contains("seal", read);
        Assert.Matches("<div if=\"Length\\(HeroFile\\) &gt; 0\">|if=\"Length\\(HeroFile\\) > 0\"", read);
    }
}
