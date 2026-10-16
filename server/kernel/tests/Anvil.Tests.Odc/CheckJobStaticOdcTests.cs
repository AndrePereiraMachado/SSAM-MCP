using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>CX16 W6 on the ODC lane: `check-job` of anvil-odc through CheckJobCommand reads the index the ODC builder writes
/// (adapter builder) and the one the ODC kernel CLI writes (adapter kernel) by file, never through the store of its assembly;
/// without the ODC Studio there are no built-ins: the class of functions is skipped and listed. Without the flags, today's answer.</summary>
public class CheckJobStaticOdcTests
{
    private sealed class Node(string key, string kind, string name = "")
    {
        public string Key = key, Kind = kind, Name = name; public Node? Parent; public List<Node> Children = [];
        public Node Add(Node child) { child.Parent = this; Children.Add(child); return child; }
    }
    private sealed class Reader : ModelReader<Node>
    {
        protected override IEnumerable<Node> Referrers(Node n) => [];
        protected override IEnumerable<Node> Children(Node n) => n.Children;
        protected override Node? Parent(Node n) => n.Parent;
        protected override string Key(Node n) => n.Key;
        protected override string Kind(Node n) => n.Kind;
        protected override string Name(Node n) => n.Name;
        protected override string? Label(Node n) => null;
        protected override IReadOnlySet<string> KindNames(Node n) => new HashSet<string> { "I" + n.Kind };
        protected override string? Expression(object value) => null;
        protected override IEnumerable<(string Name, Func<object?> Read)> Properties(Node n) { yield return ("Name", () => n.Name); }
    }

    private static string Folder() { var dir = Path.Combine(Path.GetTempPath(), "cx16-check-job-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir); return dir; }

    // An index file as the store writes it: <sha>.<adapter>.json.
    private static string IndexFile(string dir, string lane, string adapter)
    {
        var root = new Node("root", "ESpace", "App_UI");
        root.Add(new("flow", "MobileFlow", "MainFlow")).Add(new("login", "MobileScreen", "Login"));
        var sha = new string('b', 64);
        var index = ModuleIndex.Build(root, new Reader(), "App_UI", lane, adapter, sha, 10);
        var file = Path.Combine(dir, sha + "." + adapter + ".json");
        File.WriteAllBytes(file, index.ToJson());
        return file;
    }

    private static string Job(string dir, string json) { var file = Path.Combine(dir, Guid.NewGuid().ToString("N") + ".json"); File.WriteAllText(file, json); return file; }
    private const string UiJob = """{"ops":[{"op":"html","data":{"html":"<screen name=\"Login\" actions=\"Forgot\"><input bind=\"Usernme\"/></screen>"}}]}""";

    private static JsonObject Run(params string[] args) => System.Text.Json.JsonSerializer.SerializeToNode(CheckJobCommand.Run(args))!.AsObject();

    [Fact]
    public void TheIndexOfTheBuilderAndOfTheKernelAreReadByFileAndTheFunctionsAreSkippedWithoutAStudio()
    {
        var dir = Folder();
        var job = Job(dir, UiJob);
        foreach (var adapter in new[] { "builder", "kernel" }) {
            var index = IndexFile(dir, "odc", adapter);
            var r = Run("--job", job, "--module-index", index, "--basis-fresh", "true");
            Assert.Equal(adapter, r["static"]!["basis"]!["module"]!["adapter"]!.ToString());
            Assert.Equal("odc", r["static"]!["basis"]!["module"]!["lane"]!.ToString());
            Assert.Contains(r["problems"]!.AsArray(), p => p!["phase"]?.ToString() == "static" && p["code"]!.ToString() == ScreenDocument.RootExists);
            Assert.False(r["valid"]!.GetValue<bool>());
            if (Anvil.Core.Preflight.Builtins.For("odc") == null)
                Assert.Contains(r["static"]!["skipped"]!.AsArray(), s => s!["class"]!.ToString() == "functions");
        }
        var today = JobPreflight.Check(job); var now = Run("--job", job);
        today.Remove("elapsedMs"); now.Remove("elapsedMs");
        Assert.Equal(today.ToJsonString(), now.ToJsonString());
    }
}
