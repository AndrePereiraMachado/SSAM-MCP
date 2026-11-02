using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>F10 over the reactive fixture with the Service Studio (skipped without it), the reviewer's jobs J1 and J2b of
/// REVISAO-W3-EDIT: a declaration without k named like one the screen has is the edit of that one (the Studio renamed the new
/// one Username2 after the build, "nothing was kept"); and the input an edit of another page declares is there before the
/// page that passes it (HTML_DECLARATIONS_FIRST in the apply, not only in the pure normalizer).</summary>
public sealed class ScreenHtmlEditDeclarationJobTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenHtmlEditDeclarationJobTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "screen-html-edit-declarations");

    private static (JsonObject Read, string Html, string Sha) Read(ModelHost host, string oml, string screen)
    {
        var bytes = File.ReadAllBytes(oml);
        var read = host.HtmlRead(bytes, screen, withKeys: false);
        return (read, read["documents"]![0]!["html"]!.ToString(), Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
    }

    private static JsonObject EditOp(string sha, JsonObject read, string screen, IEnumerable<string> edits) => new()
    {
        ["op"] = "html", ["data"] = new JsonObject { ["screen"] = screen,
            ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = read["documents"]![0]!["htmlSha256"]!.DeepClone() },
            ["edit"] = new JsonArray(edits.Select(e => (JsonNode)e).ToArray()) },
    };

    private JsonObject Run(ModelHost host, string basePath, JsonObject job, string name)
    {
        var jobPath = Path.Combine(host.WorkDirectory, name + ".json");
        File.WriteAllText(jobPath, job.ToJsonString());
        JsonObject result;
        try { result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, Path.Combine(host.WorkDirectory, name + ".oml")))!.AsObject(); }
        catch (Exception error)
        {
            var coded = Errors.FindCoded(error);
            result = new JsonObject { ["accepted"] = false, ["code"] = coded?.Code, ["problems"] = coded?.Problems?.DeepClone(), ["text"] = Errors.Text(error) };
        }
        var text = result.ToJsonString();
        output.WriteLine(name + ": " + text[..Math.Min(3000, text.Length)]);
        return result;
    }

    private static ScreenHtml.Node Element(ScreenHtml.Node tree, string k) => ScreenHtmlText.Elements(tree).First(x => x.Node.Get("k") == k).Node;
    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }

    [Fact]
    public void AVariableWithoutKNamedLikeOneOfTheScreenIsItsEditNeverASecondOneTheStudioRenames()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        var dir = Path.Combine(Work, "j2b"); Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        var source = Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml");
        var (read, html, sha) = Read(host, source, "Login");
        Assert.Contains("name=\"Username\" type=\"Text\"", html);
        var tree = ScreenHtml.Parse(html);
        var logo = Element(tree, "w8");
        var i = logo.Attributes.FindIndex(a => a.Key == "class");
        logo.Attributes[i] = new("class", logo.Attributes[i].Value + " w3-probe");
        var result = Run(host, source, new JsonObject { ["ops"] = new JsonArray(EditOp(sha, read, "Login", ["<var name=\"Username\" type=\"Text\"/>\n" + ScreenHtmlText.Write(logo)])) }, "j2b");
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        Assert.Contains("HTML_DECLARATION_KEYED", result.ToJsonString());
        var (_, after, _) = Read(host, Path.Combine(dir, "j2b.oml"), "Login");
        Assert.Single(after.Split('\n'), l => l.Contains("name=\"Username\"", StringComparison.Ordinal) && l.TrimStart().StartsWith("<var", StringComparison.Ordinal));
        Assert.DoesNotContain("Username2", after);
        Assert.Contains("w3-probe", after);
    }

    [Fact]
    public void TheInputAnEditOfAnotherPageDeclaresIsThereBeforeThePageThatPassesIt()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        var dir = Path.Combine(Work, "j1"); Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        var source = Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml");
        var (readA, htmlA, sha) = Read(host, source, "Login");
        var (readB, htmlB, _) = Read(host, source, "InvalidPermissions");
        var tree = ScreenHtml.Parse(htmlA);
        var form = Element(tree, "w7");
        form.Children.Add(ScreenHtml.Parse("<a onclick=\"InvalidPermissions(ProbeIn = 1)\">Probe</a>").Children[0]);
        var treeB = ScreenHtml.Parse(htmlB);
        var first = ScreenHtmlText.Elements(treeB).Select(x => x.Node).First(n => n.Get("k") != null && n.Tag is "div" && n.Get("class") != null);
        var c = first.Attributes.FindIndex(a => a.Key == "class");
        first.Attributes[c] = new("class", first.Attributes[c].Value + " w3-probe");
        var job = new JsonObject { ["ops"] = new JsonArray(EditOp(sha, readA, "Login", [ScreenHtmlText.Write(form)]),
            EditOp(sha, readB, "InvalidPermissions", ["<input name=\"ProbeIn\" type=\"Integer\"/>\n" + ScreenHtmlText.Write(first)])) };
        var result = Run(host, source, job, "j1");
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        Assert.Contains(HtmlDocumentRulesCode, result.ToJsonString());
        var (_, afterB, _) = Read(host, Path.Combine(dir, "j1.oml"), "InvalidPermissions");
        var (_, afterA, _) = Read(host, Path.Combine(dir, "j1.oml"), "Login");
        Assert.Contains("name=\"ProbeIn\"", afterB);
        Assert.Contains("w3-probe", afterB);
        Assert.Contains("onclick=\"InvalidPermissions(ProbeIn = 1)\"", afterA);
    }

    private const string HtmlDocumentRulesCode = "HTML_DECLARATIONS_FIRST";
}
