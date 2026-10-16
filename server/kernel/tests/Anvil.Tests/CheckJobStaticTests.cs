using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>CX16 W6: `check-job` through CheckJobCommand (the one line of each Program.cs). Without the new flags the answer is
/// today's, field by field; with them it gains phases [preflight, static], static {basis, checked, skipped, elapsedMs} and
/// the static problems, valid false on an error; an index that does not read is listed, never a refusal. Pure: no Studio.</summary>
public class CheckJobStaticTests
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
    public void WithoutTheNewFlagsTheAnswerIsTodays()
    {
        var dir = Folder();
        foreach (var json in new[] { UiJob, """{"ops":[{"op":"set","target":"@espace","prop":"Description","value":"x"}]}""" }) {
            var job = Job(dir, json);
            var today = JobPreflight.Check(job); var now = Run("--job", job);
            today.Remove("elapsedMs"); now.Remove("elapsedMs");
            Assert.Equal(today.ToJsonString(), now.ToJsonString());
            Assert.Null(now["static"]); Assert.Null(now["phases"]);
        }
    }

    [Fact]
    public void WithTheFlagsTheStaticCheckJoinsTheAnswer()
    {
        var dir = Folder();
        var job = Job(dir, UiJob);
        var index = IndexFile(dir, "o11", "kernel");
        var r = Run("--job", job, "--module-index", index, "--basis-fresh", "true");
        Assert.False(r["valid"]!.GetValue<bool>());
        Assert.Equal(["preflight", "static"], r["phases"]!.AsArray().Select(p => p!.ToString()));
        var basis = r["static"]!["basis"]!["module"]!;
        Assert.Equal(new string('b', 64), basis["sha256"]!.ToString());
        Assert.True(basis["fresh"]!.GetValue<bool>());
        Assert.Equal("kernel", basis["adapter"]!.ToString());
        var statics = r["problems"]!.AsArray().Where(p => p!["phase"]?.ToString() == "static").Select(p => p!["code"]!.ToString()).ToList();
        // The new screen whose name the module has, the action nothing writes, the unknown bind.
        Assert.Contains(ScreenDocument.RootExists, statics);
        Assert.Equal(2, statics.Count(c => c == ScreenHtmlEdit.NameUnknown));
        Assert.Equal(r["problems"]!.AsArray().Count, r["errors"]!.AsArray().Count);
        Assert.True(r["static"]!["elapsedMs"]!.GetValue<long>() >= 0);
        Assert.NotEmpty(r["static"]!["checked"]!.AsArray());
        // Not fresh: the problems that rest on the index are warnings, and the job is valid.
        var stale = Run("--job", job, "--module-index", index, "--basis-fresh", "false");
        Assert.Contains(stale["warnings"]!.AsArray(), w => w!["code"]!.ToString() == ScreenDocument.RootExists);
        Assert.DoesNotContain(stale["problems"]!.AsArray(), p => p!["code"]!.ToString() == ScreenDocument.RootExists);
    }

    [Fact]
    public void AnIndexThatDoesNotReadIsListedNeverARefusal()
    {
        var dir = Folder();
        var job = Job(dir, """{"ops":[{"op":"set","target":"@espace","prop":"Description","value":"x"}]}""");
        var broken = Path.Combine(dir, new string('c', 64) + ".kernel.json"); File.WriteAllText(broken, "{}");
        var r = Run("--job", job, "--module-index", broken, "--producer-index", "App_CS=" + Path.Combine(dir, "missing.json"), "--basis-fresh", "true");
        Assert.True(r["valid"]!.GetValue<bool>());
        Assert.NotNull(r["static"]!["basis"]!["module"]!["error"]);
        Assert.False(r["static"]!["basis"]!["module"]!["fresh"]!.GetValue<bool>());
        Assert.NotNull(r["static"]!["basis"]!["producers"]![0]!["error"]);
        Assert.Contains(r["static"]!["skipped"]!.AsArray(), s => s!["class"]!.ToString() == "module-index");
    }

    // CX16 r2 M1: a job that expects an invalid module (expectValid false, its message declared) asks the Verify for that
    // verdict, as JobPreflight and JobRunner do: the static check judges nothing that predicts it and lists the classes in
    // static.skipped; check-job is valid (the kernel accepts the same job). The same job expecting a valid module is refused.
    [Fact]
    public void AJobThatExpectsAnInvalidModuleIsNotRefusedByTheStaticCheck()
    {
        var dir = Folder();
        try {
            var index = IndexFile(dir, "o11", "kernel");
            const string ops = """[{"op":"html","data":{"html":"<screen name=\"CxProbe\">\n<div>{{ NotDeclaredAnywhere }}</div>\n</screen>"}}]""";
            var invalid = Job(dir, """{"expectValid":false,"expectedMessages":[{"id":"ExpressionUnknownObject","element":"CxProbe","why":"the probe of a job that expects an invalid module"}],"ops":""" + ops + "}");
            var r = Run("--job", invalid, "--module-index", index, "--basis-fresh", "true");
            Assert.True(r["valid"]!.GetValue<bool>(), r.ToJsonString());
            Assert.DoesNotContain(r["problems"]!.AsArray(), p => p!["phase"]?.ToString() == "static");
            Assert.Contains(r["static"]!["skipped"]!.AsArray(), s => s!["class"]!.ToString().Contains("S1-S7"));
            var valid = Run("--job", Job(dir, """{"ops":""" + ops + "}"), "--module-index", index, "--basis-fresh", "true");
            Assert.False(valid["valid"]!.GetValue<bool>());
            Assert.Contains(valid["problems"]!.AsArray(), p => p!["phase"]?.ToString() == "static" && p["message"]!.ToString().Contains("'NotDeclaredAnywhere'"));
        } finally { Directory.Delete(dir, recursive: true); }
    }

    // CX16 r2 M3 (provisional): static.complete says whether the apply path (base check, apply, Verify) can add anything to
    // these problems. A job whose every op is refused whole by its shape is complete (nothing of it is applied); a job with
    // an op the apply runs is not, and static.rest names what is left (the base phase, the ops the apply and the Verify see).
    [Fact]
    public void CheckJobSaysWhetherTheApplyPathCanStillAddProblems()
    {
        var dir = Folder();
        try {
            var index = IndexFile(dir, "o11", "kernel");
            var r = Run("--job", Job(dir, UiJob), "--module-index", index, "--basis-fresh", "true");
            Assert.False(r["valid"]!.GetValue<bool>());
            Assert.False(r["static"]!["complete"]!.GetValue<bool>());
            var rest = r["static"]!["rest"]!.AsArray();
            Assert.Contains(rest, x => x!["phase"]!.ToString() == "base");
            Assert.Contains(rest, x => x!["phase"]!.ToString() == "apply+verify" && x["ops"]!.AsArray().Select(o => o!.GetValue<int>()).SequenceEqual([0]));
            var shapes = Run("--job", Job(dir, """{"ops":[7,"text"]}"""), "--module-index", index, "--basis-fresh", "true");
            Assert.False(shapes["valid"]!.GetValue<bool>());
            Assert.True(shapes["static"]!["complete"]!.GetValue<bool>(), shapes.ToJsonString());
            Assert.Empty(shapes["static"]!["rest"]!.AsArray());
        } finally { Directory.Delete(dir, recursive: true); }
    }
}
