using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>R3-A: the private store of the platform's real stylesheets (RuntimeCss). The sheets here are small samples written by
/// the test (never the OutSystems files): the extractor from a bundle file and from a published page, the index with its
/// sha256, the version folder a Studio version is served from, and the refusal of a store inside a Git working tree.</summary>
public sealed class RuntimeCssTests
{
    private static string TempRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), "ssam-runtime-css-test-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(root);
        return root;
    }

    private const string Osui = "/* OutSystems UI 2.28.1 (sample) */\n.app-menu-content{position:fixed;width:300px}\n";
    private const string Runtime = "/* runtime sample */\n[data-input]:empty{height:32px}\n";

    [Fact]
    public void TheExtractorWritesTheVersionFolderAndItsIndexAndTheStoreServesItInTheRuntimeOrder()
    {
        var root = TempRoot();
        try
        {
            var osuiFile = Path.Combine(root, "osui-sample.css"); File.WriteAllText(osuiFile, Osui);
            var runtimeFile = Path.Combine(root, "runtime-sample.css"); File.WriteAllText(runtimeFile, Runtime);
            var store = Path.Combine(root, "store");
            var written = RuntimeCss.Write(store, "o11", "11.55.92", [RuntimeCss.FromFile("osui", osuiFile), RuntimeCss.FromFile("runtime", runtimeFile)],
                new Dictionary<string, string> { ["osui"] = "file:osui-sample.css", ["runtime"] = "file:runtime-sample.css" });
            Assert.Equal("present", written["status"]!.ToString());
            var index = JsonNode.Parse(File.ReadAllText(Path.Combine(store, "o11-11.55.92", RuntimeCss.IndexFile)))!.AsObject();
            Assert.Equal(RuntimeCss.Schema, index["schema"]!.ToString());
            Assert.Equal("2.28.1", index["osui"]!.ToString());
            Assert.Equal(["runtime", "osui"], index["sheets"]!.AsArray().Select(s => s!["id"]!.ToString()));
            // a build of the same Studio version is served by the folder of its dotted prefix; the order is the runtime's
            var loaded = RuntimeCss.Load("o11", "11.55.92.63120", store);
            Assert.Equal("present", loaded.Status);
            Assert.Equal(["runtime", "osui"], loaded.Sheets.Select(s => s.Id));
            Assert.Equal("OutSystemsUI.OutSystemsUI.css", loaded.Sheets[1].File);
            Assert.Equal("osui@2.28.1", loaded.Sheets[1].Origin);
            Assert.Equal(RuntimeCss.Sha(Osui), loaded.Sheets[1].Sha256);
            // another lane or version is said missing, with the folders the store has
            var other = RuntimeCss.Load("odc", "1.6.2", store);
            Assert.Equal("missing", other.Status);
            Assert.Equal("missing", other.Describe()["sheets"]!.ToString());
            Assert.Equal("missing", RuntimeCss.Load("o11", "11.54.1", store).Status);
            // a sheet whose bytes changed after the index is left out and named
            File.AppendAllText(Path.Combine(store, "o11-11.55.92", "osui.css"), ".x{}");
            File.SetLastWriteTimeUtc(Path.Combine(store, "o11-11.55.92", RuntimeCss.IndexFile), DateTime.UtcNow.AddSeconds(5));
            var tampered = RuntimeCss.Load("o11", "11.55.92", store);
            Assert.Equal("partial", tampered.Status);
            Assert.Contains("osui", tampered.Missing);
            Assert.Contains("sha256", tampered.Why);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public void FromAPublishedPageOnlyThePlatformSheetsAreFetched()
    {
        var page = new Uri("https://env.example.test/App/Home");
        var html = "<html><head><link rel=\"stylesheet\" href=\"/App/css/OutSystemsReactWidgets.css?a1\">"
            + "<link rel=\"stylesheet\" href=\"css/OutSystemsUI.OutSystemsUI.css?b2\"><link rel=\"stylesheet\" href=\"css/App.Theme.css?c3\">"
            + "<link rel=\"icon\" href=\"favicon.png\"></head></html>";
        var fetched = new List<string>();
        string Fetch(Uri u) { fetched.Add(u.AbsolutePath); return u.AbsolutePath.Contains("OutSystemsUI", StringComparison.Ordinal) ? Osui : Runtime; }
        var sheets = RuntimeCss.FromPage(html, page, Fetch, "11.55.92");
        Assert.Equal(["/App/css/OutSystemsReactWidgets.css", "/App/css/OutSystemsUI.OutSystemsUI.css"], fetched);
        Assert.Equal(["runtime", "osui"], sheets.Select(s => s.Id));
        Assert.Equal("platform:reactive-runtime@11.55.92", sheets[0].Origin);
        Assert.Equal("osui@2.28.1", sheets[1].Origin);
    }

    [Fact]
    public void TheStoreIsRefusedInsideAGitWorkingTree()
    {
        var root = TempRoot();
        try
        {
            Directory.CreateDirectory(Path.Combine(root, ".git"));
            var sample = Path.Combine(root, "s.css"); File.WriteAllText(sample, Runtime);
            var error = Assert.Throws<InvalidOperationException>(() => RuntimeCss.Write(Path.Combine(root, "inside"), "o11", "11.55.92", [RuntimeCss.FromFile("runtime", sample)], new Dictionary<string, string>()));
            Assert.Contains("never enter Git", error.Message);
            Assert.Throws<ArgumentException>(() => RuntimeCss.FromFile("theme", sample));
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
