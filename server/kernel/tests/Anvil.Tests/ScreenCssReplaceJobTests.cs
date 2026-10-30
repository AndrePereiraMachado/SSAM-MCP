using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// R2-D through the job on the O11 fixture (the apply a delivery runs): an html edit with only data.css writes that sheet
/// whole and says it (styleSheet: bytes before and after, rules added and removed); the same sheet sent again is the same
/// sheet; a rule or a property left out is gone; an inflated sheet is cleaned at its next write (cssStages, shadowed); a
/// base64 data: image of the CSS becomes an image of the module named by its URL, reused when sent again. Synthetic names;
/// needs the Service Studio.
/// </summary>
public class ScreenCssReplaceJobTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenCssReplaceJobTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "screen-css-replace");
    private static string Fixture(string name) => Path.Combine(Root, "tests", "fixtures", name);
    // A 1x1 PNG.
    private const string Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    [Fact]
    public void AnEditWithOnlyCssWritesTheWholeSheetAndSaysWhatItDid()
    {
        var host = Host("css-only");
        var oml = Fixture("reactive-ui.oml");
        const string first = ".probe-card { padding: 8px; margin: 0; }\n.probe-title { font-weight: 600; }\n@media (max-width: 600px) { .probe-card { padding: 4px; } }";
        var (read, _, sha) = Read(host, oml, "Login");
        var one = Run(host, oml, CssJob(sha, read, first), "one");
        Assert.True(one["accepted"]?.GetValue<bool>() == true, one.ToJsonString());
        var sheet1 = Sheet(Read(host, Out(host, "one"), "Login").Html);
        Assert.Equal(Squeeze(first), Squeeze(sheet1));
        var said = Answer(one)!["styleSheet"]!.AsObject();
        output.WriteLine(said.ToJsonString());
        Assert.Equal(System.Text.Encoding.UTF8.GetByteCount(sheet1), said["bytesAfter"]!.GetValue<int>());
        Assert.Equal(3, said["rulesAdded"]!.GetValue<int>());
        // The same sheet sent again: the same sheet (idempotent), nothing added or removed.
        var (read2, _, sha2) = Read(host, Out(host, "one"), "Login");
        var two = Run(host, Out(host, "one"), CssJob(sha2, read2, first), "two");
        Assert.True(two["accepted"]?.GetValue<bool>() == true, two.ToJsonString());
        Assert.Equal(sheet1, Sheet(Read(host, Out(host, "two"), "Login").Html));
        Assert.Equal(0, Answer(two)!["styleSheet"]!["rulesAdded"]!.GetValue<int>());
        Assert.Equal(0, Answer(two)!["styleSheet"]!["rulesRemoved"]!.GetValue<int>());
        // A property and a rule left out: gone, and said.
        var (read3, _, sha3) = Read(host, Out(host, "two"), "Login");
        var three = Run(host, Out(host, "two"), CssJob(sha3, read3, ".probe-card { padding: 8px; }"), "three");
        Assert.True(three["accepted"]?.GetValue<bool>() == true, three.ToJsonString());
        var sheet3 = Sheet(Read(host, Out(host, "three"), "Login").Html);
        Assert.DoesNotContain("margin", sheet3);
        Assert.DoesNotContain("probe-title", sheet3);
        Assert.Equal(3, Answer(three)!["styleSheet"]!["rulesRemoved"]!.GetValue<int>());
        // An inflated sheet (the reading's sheet, then itself again: what the append wrote before) is cleaned at this write.
        var (read4, _, sha4) = Read(host, Out(host, "three"), "Login");
        var four = Run(host, Out(host, "three"), CssJob(sha4, read4, first + "\n" + first), "four");
        Assert.True(four["accepted"]?.GetValue<bool>() == true, four.ToJsonString());
        Assert.Equal(Squeeze(first), Squeeze(Sheet(Read(host, Out(host, "four"), "Login").Html)));
        Assert.Contains(Answer(four)!["styleSheet"]!["cssStages"]!.AsArray(), c => c!["stage"]?.ToString() == "shadowed" && c["removed"]!.GetValue<int>() == 3);
    }

    [Fact]
    public void ABase64DataImageOfTheCssBecomesAModuleImageNamedByItsUrl()
    {
        var host = Host("css-image");
        var oml = Fixture("reactive-ui.oml");
        var css = ".probe-logo { width: 1px; background: url(\"data:image/png;base64," + Png + "\") no-repeat; }";
        var (read, _, sha) = Read(host, oml, "Login");
        var one = Run(host, oml, CssJob(sha, read, css), "image");
        Assert.True(one["accepted"]?.GetValue<bool>() == true, one.ToJsonString());
        var sheet = Sheet(Read(host, Out(host, "image"), "Login").Html);
        output.WriteLine(sheet);
        Assert.DoesNotContain("data:image", sheet);
        var image = Assert.Single(Answer(one)!["styleSheet"]!["images"]!.AsArray())!.AsObject();
        Assert.True(image["created"]!.GetValue<bool>());
        var url = image["url"]!.ToString();
        Assert.Matches(@"^/[A-Za-z0-9_]+/img/[A-Za-z0-9_]+\.LoginImage[0-9a-f]{8}\.png$", url);
        Assert.Contains("url(\"" + url + "\")", sheet);
        // The same sheet sent again: the same image, reused.
        var (read2, _, sha2) = Read(host, Out(host, "image"), "Login");
        var two = Run(host, Out(host, "image"), CssJob(sha2, read2, css), "image-again");
        Assert.True(two["accepted"]?.GetValue<bool>() == true, two.ToJsonString());
        var again = Assert.Single(Answer(two)!["styleSheet"]!["images"]!.AsArray())!.AsObject();
        Assert.False(again["created"]!.GetValue<bool>());
        Assert.Equal(url, again["url"]!.ToString());
        Assert.Equal(sheet, Sheet(Read(host, Out(host, "image-again"), "Login").Html));
    }

    // ---- helpers -----------------------------------------------------------------------------------------------------------
    private ModelHost Host(string name) { var dir = Path.Combine(Work, name, Guid.NewGuid().ToString("N")[..8]); Directory.CreateDirectory(dir); return new ModelHost(dir); }
    private static string Out(ModelHost host, string name) => Path.Combine(host.WorkDirectory, name + ".oml");

    private static (JsonObject Read, string Html, string Sha) Read(ModelHost host, string oml, string screen)
    {
        var bytes = File.ReadAllBytes(oml);
        var read = host.HtmlRead(bytes, screen, withKeys: false);
        return (read, read["documents"]![0]!["html"]!.ToString(), Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
    }

    // An html edit with only data.css (no element to edit).
    private static JsonObject CssJob(string sha, JsonObject read, string css) => new() { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html",
        ["data"] = new JsonObject { ["screen"] = "Login", ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = read["documents"]![0]!["htmlSha256"]!.DeepClone() }, ["css"] = css } }) };

    private JsonObject Run(ModelHost host, string basePath, JsonObject job, string name)
    {
        var jobPath = Path.Combine(host.WorkDirectory, name + ".json"); File.WriteAllText(jobPath, job.ToJsonString());
        try { return JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, Out(host, name)))!.AsObject(); }
        catch (Exception error) {
            var coded = Errors.FindCoded(error);
            output.WriteLine(name + " refused: " + Errors.Text(error)[..Math.Min(2000, Errors.Text(error).Length)]);
            return new JsonObject { ["accepted"] = false, ["code"] = coded?.Code, ["problems"] = coded?.Problems?.DeepClone() };
        }
    }

    // The answer of the job's last op (the html op's).
    private static JsonObject? Answer(JsonObject result) => (result["results"] as JsonArray)?.Select(r => r?["result"]).OfType<JsonObject>().LastOrDefault();

    private static string Squeeze(string text) => new(text.Where(c => !char.IsWhiteSpace(c)).ToArray());

    // The page's own style sheet in a reading.
    private static string Sheet(string html)
    {
        var top = ScreenHtml.Parse(html).Children.First(n => !n.IsText);
        return top.Children.FirstOrDefault(n => !n.IsText && n.Tag == "style") is { } style ? string.Concat(style.Children.Select(c => c.Text)) : "";
    }
}
