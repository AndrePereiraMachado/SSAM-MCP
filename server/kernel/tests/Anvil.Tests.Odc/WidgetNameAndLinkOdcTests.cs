using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>Review B1 round 2, S10: C-34 and C-38 on the ODC lane (the fixture insurance-reactive-r8), with the assertions of
/// the O11 tests in PreflightPatchTests (AWidgetWhoseEventOpensAScreenGoesInsideTheLinkByThePatch,
/// ANameThatIsNoFreeIdentifierStaysTheExtendedPropertyItIs, AFreeIdentifierNameStillBecomesTheIdItsExpressionNames).
/// Needs the ODC Studio.</summary>
public sealed class WidgetNameAndLinkOdcTests(ITestOutputHelper output)
{
    private const string Fixture = "tests/fixtures/odc/insurance-reactive-r8.oml";
    private static readonly JsonObject Target = Html("<screen name=\"CsContacts\">\n<div class=\"cs-list\">Contacts</div>\n</screen>");

    /// <summary>C-34: an &lt;img&gt; whose onclick opens a screen is refused with the patch that puts it inside the Link, and
    /// the patched document compiles with the image inside the Link that opens the screen.</summary>
    [Fact]
    public void AnImageWhoseEventOpensAScreenGoesInsideTheLinkByThePatchOnOdc()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var (result, _) = Run(Html("<screen name=\"CsWallet\">\n<img class=\"cs-logo\" src=\"https://example.com/a.png\" onclick=\"CsContacts\"/>\n</screen>"), Target);
        var problem = Assert.Single((result["problems"] as JsonArray ?? []).OfType<JsonObject>(), p => p["code"]?.ToString() == "HTML_EVENT_OPENS_SCREEN");
        Assert.Contains("line 2", problem["message"]!.ToString());
        Assert.Contains("inside an <a>", problem["fix"]!.ToString());
        var patched = Assert.IsType<JsonArray>(problem["patch"])[0]!["value"]!.ToString();
        Assert.Contains("<a onclick=\"CsContacts\"><img class=\"cs-logo\" src=\"https://example.com/a.png\"/></a>", patched);
        var (accepted, page) = Run(Html(patched), Target);
        Assert.True(accepted["accepted"]!.GetValue<bool>(), accepted.ToJsonString());
        Assert.Matches(@"<a [^>]*onclick=""CsContacts""[^>]*>\s*<img ", page);
    }

    /// <summary>C-38: a name that is no free identifier stays the extended property (accepted, no note); a free one becomes
    /// the id its expression names, and is said.</summary>
    [Fact]
    public void TheNameOfAWidgetBecomesItsIdOnlyWhenFreeOnOdc()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        foreach (var (body, name) in new[] {
            ("<div name=\"hero-1\" class=\"cs-hero\">Hi</div>", "hero-1"),
            ("<div name=\"main hero\" class=\"cs-hero\">Hi</div>", "main hero"),
            ("<div name=\"Card\" class=\"cs-a\">A</div>\n<div name=\"Card\" class=\"cs-b\">B</div>", "Card"),
            ("<var name=\"Title\" type=\"Text\"/>\n<div name=\"Title\" class=\"cs-a\">A</div>", "Title") })
        {
            var (result, page) = Run(Html($"<screen name=\"CsPlain\">\n{body}\n</screen>"));
            Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
            Assert.Contains($"ext:name=\"{name}\"", page);
            Assert.DoesNotContain(Notes(result), n => n["rule"]?.ToString() == "HTML_WIDGET_NAME_IS_ID");
        }
        var (hero, heroPage) = Run(Html("<screen name=\"CsPlain\">\n<div name=\"Hero\" class=\"cs-hero\">Hi</div>\n<div class=\"cs-x\">{{ Hero.Id }}</div>\n</screen>"));
        Assert.True(hero["accepted"]!.GetValue<bool>(), hero.ToJsonString());
        Assert.Contains("id=\"Hero\"", heroPage);
        Assert.Contains(Notes(hero), n => n["rule"]?.ToString() == "HTML_WIDGET_NAME_IS_ID" && n["message"]!.ToString().Contains("Hero"));
    }

    private static JsonObject Html(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };

    private static IEnumerable<JsonObject> Notes(JsonObject result) => (result["normalizations"] as JsonArray ?? []).OfType<JsonObject>();

    /// <summary>The answer of a job of these ops on the fixture, and the first screen's page read back when it is accepted.</summary>
    private static (JsonObject Result, string Page) Run(params JsonObject[] ops)
    {
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "widget-name-link", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var job = Path.Combine(dir, "job.json");
            File.WriteAllText(job, new JsonObject
            {
                ["base"] = Fixture,
                ["expectedMessages"] = new JsonArray(new JsonObject { ["id"] = "AnonymousAccess_NoPermissions", ["all"] = true, ["why"] = "a test screen without a role" }),
                ["ops"] = new JsonArray(ops.Select(o => (JsonNode)o.DeepClone()).ToArray()),
            }.ToJsonString());
            var outPath = Path.Combine(dir, "out.oml");
            var host = new ModelHost(Path.Combine(dir, "work"));
            JsonObject result;
            try { result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, outPath))!.AsObject(); }
            catch (Exception error) { return (Errors.Envelope("apply", error, 1), ""); }
            var screen = System.Text.RegularExpressions.Regex.Match(ops[0]["data"]!["html"]!.ToString(), "<screen name=\"([^\"]+)\"").Groups[1].Value;
            var page = result["accepted"]?.GetValue<bool>() == true
                ? host.HtmlRead(File.ReadAllBytes(outPath), "MobileScreen:" + screen, withKeys: false)["documents"]![0]!["html"]!.ToString() : "";
            return (result, page);
        }
        finally { try { Directory.Delete(dir, true); } catch { } }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(WidgetNameAndLinkOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }
}
