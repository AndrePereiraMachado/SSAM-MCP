using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// R2-D after its review, through the job on the O11 fixture: a theme write of an html op (the icon selectors widened, the
/// native layout block) says what the one normalization removed from the theme; a data.css of whitespace never wipes a sheet;
/// a data: url in a comment or a string makes no image; a replacement by data.css emits no note about a set the author did
/// not send and no internal alias. Synthetic names; needs the Service Studio.
/// </summary>
public class ScreenCssCorrectionJobTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenCssCorrectionJobTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "screen-css-correction");
    private static string Fixture(string name) => Path.Combine(Root, "tests", "fixtures", name);
    private const string Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    // A theme with a rule a later one shadows and an svg selector (the icon widening rewrites it), written without the stage.
    private const string Seeded = "\nsvg.zz-probe{fill:red}\n.zz-dup{color:red}\n.zz-dup{color:red}\n";

    [Fact]
    public void AnIconEditThatWidensTheThemeSaysWhatTheStageRemovedFromIt()
    {
        var host = Host("theme-icon");
        var seed = Seed(host, Path.Combine(host.WorkDirectory, "seed.oml"));
        var (read, html, sha) = Read(host, seed, "Login");
        var tree = ScreenHtml.Parse(html);
        var parent = ScreenHtmlText.Elements(tree).First(x => x.Node.Tag == "div" && x.Node.Get("k") != null && x.Node.Children.Any(c => !c.IsText)).Node;
        parent.Children.Add(ScreenHtml.Parse("<svg viewBox=\"0 0 24 24\" fill=\"currentColor\" width=\"16\" height=\"16\"><path d=\"M0 0h24v24H0z\"/></svg>").Children.First(n => !n.IsText));
        var job = new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "Login",
            ["basedOn"] = BasedOn(sha, read), ["edit"] = new JsonArray((JsonNode)ScreenHtmlText.Write(parent)) } }) };
        var result = Run(host, seed, job, "icon");
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        var theme = CssPathModelTests.Elements(host, Out(host, "icon")).First(e => e.Kind == "theme").Author;
        Assert.Equal(1, Occurrences(theme, ".zz-dup{color:red}"));
        var answer = Answer(result)!.ToJsonString();
        output.WriteLine(answer);
        Assert.Contains("\"stage\":\"shadowed\"", answer);
        Assert.Contains("\".zz-dup\"", answer);
    }

    [Fact]
    public void ACreateThatWritesTheNativeLayoutBlockSaysWhatTheStageRemovedFromTheTheme()
    {
        var host = Host("theme-layout");
        var seed = Seed(host, Path.Combine(host.WorkDirectory, "seed.oml"));
        var create = new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
            ["html"] = "<screen name=\"ZzLayout\" roles=\"Registered\">\n<div class=\"zz-a\">x</div>\n</screen>" } }) };
        var result = Run(host, seed, create, "layout");
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        var theme = CssPathModelTests.Elements(host, Out(host, "layout")).First(e => e.Kind == "theme").Author;
        var answer = Answer(result)!;
        output.WriteLine(answer.ToJsonString());
        // Whatever wrote the theme in this op says what the stage removed from it.
        if (Occurrences(theme, ".zz-dup{color:red}") == 1)
            Assert.Contains((answer["normalized"] as JsonArray ?? []).OfType<JsonObject>(), n => n["code"]?.ToString() == ScreenVisual.ThemeNativeLayout
                && n["cssStages"]?.ToJsonString().Contains("\".zz-dup\"", StringComparison.Ordinal) == true);
        else Assert.Equal(2, Occurrences(theme, ".zz-dup{color:red}"));
    }

    [Fact]
    public void ADataCssOfWhitespaceNeverWipesASheet()
    {
        var host = Host("whitespace");
        var oml = Fixture("reactive-ui.oml");
        var (read, _, sha) = Read(host, oml, "Login");
        Assert.True(Run(host, oml, CssJob(sha, read, ".zz-keep{color:red}"), "sheet")["accepted"]?.GetValue<bool>() == true);
        var (read2, html2, sha2) = Read(host, Out(host, "sheet"), "Login");
        var result = Run(host, Out(host, "sheet"), CssJob(sha2, read2, " \n"), "blank");
        Assert.False(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        Assert.Contains("'css' (the whole style sheet) is required", result["message"]?.ToString() ?? "");
        Assert.False(File.Exists(Out(host, "blank")) && Sheet(Read(host, Out(host, "blank"), "Login").Html) != Sheet(html2));
    }

    [Fact]
    public void ADataUrlInACommentOrAStringMakesNoImage()
    {
        var host = Host("comment-url");
        var oml = Fixture("reactive-ui.oml");
        var (read, _, sha) = Read(host, oml, "Login");
        var css = "/* was: url(data:image/png;base64," + Png + ") */\n.zz-c{content:\"url(data:image/png;base64," + Png + ")\"}";
        var result = Run(host, oml, CssJob(sha, read, css), "comment");
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        Assert.Null(Answer(result)!["styleSheet"]?["images"]);
        var sheet = Sheet(Read(host, Out(host, "comment"), "Login").Html);
        Assert.Equal(2, Occurrences(sheet, "data:image/png;base64," + Png));
        Assert.DoesNotContain("/img/", sheet);
    }

    [Fact]
    public void AReplacementByDataCssSaysItInStyleSheetAndNamesNoInternalTarget()
    {
        var host = Host("replace-note");
        var oml = Fixture("reactive-ui.oml");
        var (read, _, sha) = Read(host, oml, "Login");
        Assert.True(Run(host, oml, CssJob(sha, read, ".zz-keep{color:red}\n.zz-also{margin:0}"), "two")["accepted"]?.GetValue<bool>() == true);
        var (read2, _, sha2) = Read(host, Out(host, "two"), "Login");
        var result = Run(host, Out(host, "two"), CssJob(sha2, read2, ".zz-new{color:blue}"), "one");
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        var said = Answer(result)!["styleSheet"]!;
        Assert.Equal(2, said["rulesRemoved"]!.GetValue<int>());
        Assert.Equal([".zz-keep", ".zz-also"], said["removedRules"]!.AsArray().Select(r => r!.ToString()));
        var text = result.ToJsonString();
        Assert.DoesNotContain("CSS_SET_WHOLE", text);
        Assert.DoesNotContain("$ssam.", text);
    }

    // ---- helpers -----------------------------------------------------------------------------------------------------------

    // The fixture with its default theme's author CSS followed by Seeded, written through the importer's verbatim path (the
    // shadowed stage does not run there), saved as an OML.
    private static string Seed(ModelHost host, string path)
    {
        var module = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [Fixture("reactive-ui.oml")])!;
        try
        {
            var theme = ModelHost.Prop(module, "DefaultMobileTheme")!;
            var css = (ThemeCss.AuthorOf(theme) ?? "").TrimEnd() + Seeded;
            typeof(IStudioRuntime).GetMethod("Mutate")!.Invoke(StudioAdapter.Runtime,
                [module, "seed a shadowed rule", (Action<object>)(_ => ThemeCss.WriteThemeVerbatim(theme, css))]);
            Assert.Equal(2, Occurrences(ThemeCss.AuthorOf(theme) ?? "", ".zz-dup{color:red}"));
            File.WriteAllBytes(path, (byte[])typeof(ModelHost).GetMethod("Save")!.Invoke(host, [module])!);
        }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]); }
        return path;
    }

    private static int Occurrences(string text, string what)
    {
        var n = 0;
        for (var i = text.IndexOf(what, StringComparison.Ordinal); i >= 0; i = text.IndexOf(what, i + what.Length, StringComparison.Ordinal)) n++;
        return n;
    }

    private ModelHost Host(string name) { var dir = Path.Combine(Work, name, Guid.NewGuid().ToString("N")[..8]); Directory.CreateDirectory(dir); return new ModelHost(dir); }
    private static string Out(ModelHost host, string name) => Path.Combine(host.WorkDirectory, name + ".oml");
    private static JsonObject BasedOn(string sha, JsonObject read) => new() { ["capture"] = sha, ["html"] = read["documents"]![0]!["htmlSha256"]!.DeepClone() };

    private static (JsonObject Read, string Html, string Sha) Read(ModelHost host, string oml, string screen)
    {
        var bytes = File.ReadAllBytes(oml);
        var read = host.HtmlRead(bytes, screen, withKeys: false);
        return (read, read["documents"]![0]!["html"]!.ToString(), Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
    }

    // An html edit of Login with only data.css.
    private static JsonObject CssJob(string sha, JsonObject read, string css) => new() { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html",
        ["data"] = new JsonObject { ["screen"] = "Login", ["basedOn"] = BasedOn(sha, read), ["css"] = css } }) };

    private JsonObject Run(ModelHost host, string basePath, JsonObject job, string name)
    {
        var jobPath = Path.Combine(host.WorkDirectory, name + ".json"); File.WriteAllText(jobPath, job.ToJsonString());
        try { return JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, Out(host, name)))!.AsObject(); }
        catch (Exception error)
        {
            var coded = Errors.FindCoded(error);
            output.WriteLine(name + " refused: " + Errors.Text(error)[..Math.Min(2000, Errors.Text(error).Length)]);
            return new JsonObject { ["accepted"] = false, ["code"] = coded?.Code, ["message"] = Errors.Text(error), ["problems"] = coded?.Problems?.DeepClone() };
        }
    }

    // The answer of the job's last op (the html op's).
    private static JsonObject? Answer(JsonObject result) => (result["results"] as JsonArray)?.Select(r => r?["result"]).OfType<JsonObject>().LastOrDefault();

    // The page's own style sheet in a reading.
    private static string Sheet(string html)
    {
        var top = ScreenHtml.Parse(html).Children.First(n => !n.IsText);
        return top.Children.FirstOrDefault(n => !n.IsText && n.Tag == "style") is { } style ? string.Concat(style.Children.Select(c => c.Text)) : "";
    }
}
