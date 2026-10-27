using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// T18 correction round on ODC (finding 1): the document form writes its own &lt;style&gt; as given (#reactContainer selectors
/// kept, an @import after a rule moved up and reported), and the reading of that screen, sent back whole on its basedOn, is
/// accepted with the same reading. Before the round the root's sheet was normalized after the compile compared it, and every
/// one of these documents was refused HTML_STYLE_DROPPED.
/// </summary>
public sealed class CssPathReviewOdcTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "test-work", "t18-review");
    private const string Fixture = "tests/fixtures/odc/insurance-reactive-r8.oml";
    private const string Font = "@import url(\"https://fonts.googleapis.com/css2?family=Inter\");";

    public static TheoryData<string, string> OwnStyles => new()
    {
        { "rc", "#reactContainer .rv-x{color:red}" },
        { "rcchild", "#reactContainer > div{min-height:10px}\n.rv-x{color:red}" },
        { "imp", ".rv-x{color:red}\n" + Font },
        { "dupimp", Font + "\n.rv-x{color:red}\n" + Font },
    };

    [Theory]
    [MemberData(nameof(OwnStyles))]
    public void TheDocumentFormWritesItsStyleAndTheReadingComesBackAccepted(string name, string css)
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(Work, name + "-" + Guid.NewGuid().ToString("N")[..6]);
        Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        var screen = "T18Own" + char.ToUpperInvariant(name[0]) + name[1..];
        var document = $"<screen name=\"{screen}\">\n<style>\n{css}\n</style>\n<div class=\"rv-x\">x</div>\n</screen>";
        var output = Path.Combine(dir, "out.oml");
        var result = Run(host, Path.Combine(Root, Fixture), new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = document } }, output);
        Assert.True(result["accepted"]!.GetValue<bool>(), Clip(result));
        var bytes = File.ReadAllBytes(output);
        var read = host.HtmlRead(bytes, "MobileScreen:" + screen, withKeys: false)["documents"]![0]!["html"]!.ToString();
        if (css.Contains("#reactContainer", StringComparison.Ordinal)) Assert.Contains("#reactContainer", read);
        Assert.DoesNotContain(":is(#reactContainer, body)", read);

        // read -> resend whole on its basedOn -> accepted, the same reading.
        var store = new ModuleIndexStore(Path.Combine(dir, "index"), "odc", "kernel");
        using var scope = ModuleIndexStore.Use(store);
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        var reading = host.HtmlRead(bytes, "MobileScreen:" + screen, withKeys: true)["documents"]![0]!;
        var keys = store.HtmlKeysPathOf(sha, reading["htmlSha256"]!.ToString());
        Directory.CreateDirectory(Path.GetDirectoryName(keys)!);
        File.WriteAllText(keys, new JsonObject { ["schema"] = ScreenHtml.Schema, ["extractor"] = ScreenHtml.Extractor, ["lane"] = store.Lane, ["sourceSha256"] = sha, ["root"] = screen,
            ["rootKey"] = reading["rootKey"]!.DeepClone(), ["rootKind"] = reading["rootKind"]!.DeepClone(), ["htmlSha256"] = reading["htmlSha256"]!.DeepClone(),
            ["keys"] = reading["keys"]!.DeepClone(), ["html"] = reading["html"]!.DeepClone() }.ToJsonString());
        var again = Path.Combine(dir, "again.oml");
        var resent = Run(host, output, new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = screen,
            ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = reading["htmlSha256"]!.DeepClone() }, ["html"] = reading["html"]!.DeepClone() } }, again);
        Assert.True(resent["accepted"]!.GetValue<bool>(), Clip(resent));
        Assert.Equal(read, host.HtmlRead(File.ReadAllBytes(again), "MobileScreen:" + screen, withKeys: false)["documents"]![0]!["html"]!.ToString());
    }

    private static JsonObject Run(ModelHost host, string basis, JsonObject op, string output)
    {
        var job = output + ".job.json";
        File.WriteAllText(job, new JsonObject
        {
            ["expectedMessages"] = new JsonArray(new JsonObject { ["id"] = "AnonymousAccess_NoPermissions", ["all"] = true, ["why"] = "a test screen without a role" }),
            ["ops"] = new JsonArray(op),
        }.ToJsonString());
        return JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, output))!.AsObject();
    }

    private static string Clip(JsonObject result) { var s = result.ToJsonString(); return s[..Math.Min(4000, s.Length)]; }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(CssPathReviewOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
