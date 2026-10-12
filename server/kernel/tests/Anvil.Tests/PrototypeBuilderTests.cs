using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// The compile lane applied headless (docs/PROTOTIPO-NATIVO.md 7.2, tests 6, 8-11): the captures over copies of the Haiku_UI
/// captures of 2026-10-10 and over the Reactive fixture, through JobRunner (the same anvil apply the delivery runs), with the other
/// lanes' seams as fakes (the read-back of PrototypeBuilder stands for the css lane's renderer). Needs the Service Studio assemblies
/// (ANVIL_STUDIO_DIR); skipped without them. The replay captures (SSAM_PROTOTYPE_REPLAY, default the ui-mockup session's replay
/// folder) are read only: each test works on its own copy.
/// </summary>
public class PrototypeBuilderTests(ITestOutputHelper output)
{
    private static readonly string Work = Path.Combine(Path.GetTempPath(), "proto-builder-tests");
    private static readonly string ReplayRoot = Environment.GetEnvironmentVariable("SSAM_PROTOTYPE_REPLAY")
        ?? @"C:\Users\andre\AppData\Local\Temp\claude\C--Users-andre-SSAM-Hybrid-integracao-wt-ui-mockup\a67c1e7c-769c-40b3-8471-cccb151c5834\scratchpad\replay";
    private static string? Replay(string relative) => Path.Combine(ReplayRoot, relative) is var p && File.Exists(p) ? p : null;
    private const string Base105 = @"captures\Haiku_UI-20261010203638-cabaa3f0.oml";
    private const string Job105 = @"jobs\cfb79d98-8d22-42fe-973e-d5d18e5fbf5b.json";
    private const string Base202559 = @"captures\Haiku_UI-20261010202559.oml";

    /// <summary>Applies the ops over a private copy of <paramref name="baseOml"/> (bound on the command, as the delivery binds its
    /// capture), or over tests/fixtures/reactive-ui.oml.</summary>
    internal static JsonObject Run(string name, string? baseOml, JsonArray ops, out string candidate, PrototypeExpander.Seams? seams = null, string? jobPath = null)
    {
        var dir = Path.Combine(Work, name);
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        Directory.CreateDirectory(dir);
        string? bound = null;
        if (baseOml != null)
        {
            bound = Path.Combine(dir, "base.oml");
            File.Copy(baseOml, bound, true);
        }
        if (jobPath != null)
        {
            // a job of another session's replay: read only, applied from a private copy
            var copy = Path.Combine(dir, "job.json");
            File.Copy(jobPath, copy, true);
            jobPath = copy;
        }
        else
        {
            var job = new JsonObject { ["description"] = "prototype compile lane test " + name, ["expectValid"] = true, ["ops"] = ops };
            if (bound == null) job["base"] = Path.Combine(PrototypeFakes.Root, "tests", "fixtures", "reactive-ui.oml");
            jobPath = Path.Combine(dir, "job.json");
            File.WriteAllText(jobPath, job.ToJsonString());
        }
        candidate = Path.Combine(dir, "candidate.oml");
        var host = new ModelHost(dir);
        var outPath = candidate;
        var path = jobPath;
        var result = PrototypeExpander.WithSeams(seams ?? PrototypeFakes.Seams, () => JsonSerializer.SerializeToNode(JobRunner.Run(host, bound, path, outPath))!.AsObject());
        File.WriteAllText(Path.Combine(dir, "result.json"), result.ToJsonString(PrototypeFakes.Indented)); // the receipt, for a failure's diagnosis
        return result;
    }

    /// <summary>A private copy of the fixture bundles (the kernel writes prototype-dom.json and prototype-keys.json beside the
    /// capture); returns the copy of <paramref name="capture"/>.</summary>
    internal static string Bundle(string name, string capture = "farmavirtual.capture.json")
    {
        var dir = Path.Combine(Work, name + "-bundle");
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        Directory.CreateDirectory(dir);
        var source = PrototypeFakes.Fixtures;
        foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(dir, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, true);
        }
        return Path.Combine(dir, capture);
    }

    internal static JsonObject PrototypeOp(string capture, JsonObject? extra = null) => new() { ["op"] = "prototype", ["data"] = PrototypeFakes.Data(capture, null, extra) };

    private static JsonObject Report(JsonObject result) => result["results"]!.AsArray().OfType<JsonObject>().Single(r => r["op"]?.ToString() == "prototype")["result"]!["prototype"]!.AsObject();
    private static List<string> VerifyErrors(JsonObject result) => (result["details"] as JsonArray ?? []).Select(d => d!.ToString()).Where(d => d.StartsWith("Error", StringComparison.Ordinal)).ToList();

    private static void AssertApplied(JsonObject result)
    {
        Assert.True(result["isValid"]!.GetValue<bool>() && result["accepted"]!.GetValue<bool>(), "not valid: " + string.Join(" | ", VerifyErrors(result).Take(10)) + " " + result["policyMessages"]?.ToJsonString());
        Assert.Empty(VerifyErrors(result));
        var report = Report(result);
        Assert.Empty(report["builder"]!["problems"]!.AsArray());
    }

    private static Dictionary<string, string> Keys(string oml, params string[] references)
    {
        var host = new ModelHost(Path.Combine(Work, "keys-" + Guid.NewGuid().ToString("N")[..8]));
        return host.WithSession(oml, session => references.ToDictionary(r => r, r => session.Get(session.Resolve(r))["key"]!.ToString()));
    }

    // ---- 10 and 6: the minimal capture over the Reactive fixture, an HTML element's onclick, reimport in place ----------------

    [Fact]
    public void TheMinimalCaptureAppliesWithAnHtmlElementOnclickAndReimportsInPlaceKeepingKeys()
    {
        if (!PrototypeFakes.Studio()) return;
        MinimalApplyAndReimport();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void MinimalApplyAndReimport()
    {
        var capture = Bundle("minimal", "minimal.capture.json");
        var first = Run("minimal-1", null, new JsonArray(PrototypeOp(capture)), out var candidate1);
        AssertApplied(first);
        var report = Report(first);
        Assert.Empty(report["degraded"]!.AsArray());
        Assert.False(report["noChange"]!.GetValue<bool>());
        // 10: the clickable span of a list row is an HTML element with the extended event onclick -> its screen action; the
        // Verify accepted it (no error above) and the read-back finds the handler
        var dom = JsonNode.Parse(File.ReadAllText(report["nativeDom"]!["path"]!.ToString()))!.AsObject();
        var onclick = Find(dom, n => n["type"]?.ToString() == "IAdvancedHtml" && n["event"]?.ToString() == "onclick:AlternarTarefaFeita").ToList();
        Assert.NotEmpty(onclick);
        Assert.Equal(["m:nova-tarefa", "shell", "v:lista", "v:tarefa"], dom["roots"]!.AsObject().Select(p => p.Key).Order(StringComparer.Ordinal));
        var references = new[] { "IMobileFlow:Mini", "IMobileTheme:MiniTheme", "IMobileBlock:MiniShell", "IMobileScreen:Lista", "IMobileScreen:TarefaDetalhe", "IServerEntity:Tarefa", "IStaticEntity:Categoria", "IServerAction:CriarTarefa" };
        var keys1 = Keys(candidate1, references);
        // 6: the same capture over its own result is NO_CHANGE
        var again = Run("minimal-2", candidate1, new JsonArray(PrototypeOp(capture)), out _);
        Assert.True(again["isValid"]!.GetValue<bool>());
        Assert.True(Report(again)["noChange"]!.GetValue<bool>(), "the same capture again is NO_CHANGE");
        // a changed capture updates in place: the same keys, the new content
        var changed = JsonNode.Parse(File.ReadAllText(capture))!.AsObject();
        changed["views"]![0]!["root"]!["c"]![0]!["c"]![0]!["c"]![0]!["x"] = "Minhas tarefas";
        var changedPath = Path.Combine(Path.GetDirectoryName(capture)!, "minimal-changed.capture.json");
        File.WriteAllText(changedPath, changed.ToJsonString());
        var third = Run("minimal-3", candidate1, new JsonArray(PrototypeOp(changedPath)), out var candidate3);
        AssertApplied(third);
        Assert.False(Report(third)["noChange"]!.GetValue<bool>());
        Assert.Equal(keys1, Keys(candidate3, references));
        var dom3 = JsonNode.Parse(File.ReadAllText(Report(third)["nativeDom"]!["path"]!.ToString()))!.AsObject();
        Assert.NotEmpty(Find(dom3, n => n["text"]?.ToString() == "Minhas tarefas"));
        Assert.Empty(Find(dom3, n => n["text"]?.ToString() == "Tarefas"));
        // a view the capture no longer has: its marked screen goes (nothing outside the prefix uses it)
        var fewer = changed.DeepClone().AsObject();
        fewer["views"]!.AsArray().RemoveAt(1);
        var template = fewer["views"]![0]!["root"]!["c"]![0]!["c"]![4]!["list"]!["template"]!["c"]!.AsArray();
        template.RemoveAt(template.Count - 1);
        fewer["explored"]!.AsArray().RemoveAt(1);
        var fewerPath = Path.Combine(Path.GetDirectoryName(capture)!, "minimal-fewer.capture.json");
        File.WriteAllText(fewerPath, fewer.ToJsonString());
        var fourth = Run("minimal-4", candidate3, new JsonArray(PrototypeOp(fewerPath)), out var candidate4);
        AssertApplied(fourth);
        var removed = Report(fourth)["removed"]!.AsArray().Select(r => r!["name"]!.ToString()).ToList();
        Assert.Contains("TarefaDetalhe", removed);
        Assert.ThrowsAny<KeyNotFoundException>(() => Keys(candidate4, "IMobileScreen:TarefaDetalhe"));
        Assert.Equal(keys1["IMobileScreen:Lista"], Keys(candidate4, "IMobileScreen:Lista")["IMobileScreen:Lista"]);
        output.WriteLine($"minimal: first {first["applyMs"]} ms, NO_CHANGE {again["applyMs"]} ms, in place {third["applyMs"]} ms, vanished {fourth["applyMs"]} ms");
    }

    private static IEnumerable<JsonObject> Find(JsonNode? node, Func<JsonObject, bool> match)
    {
        if (node is JsonObject o)
        {
            if (match(o)) yield return o;
            foreach (var (_, v) in o) foreach (var x in Find(v, match)) yield return x;
        }
        else if (node is JsonArray a) foreach (var v in a) foreach (var x in Find(v, match)) yield return x;
    }

    // ---- 8: the direct builder within 15 s on the base of the replay of job 105, next to job 105's html op ---------------------

    [Fact]
    public void TheDirectBuilderAppliesFarmaVirtualOnTheBaseOfJob105WithinFifteenSecondsNextToTheHtmlOp()
    {
        if (!PrototypeFakes.Studio()) return;
        if (Replay(Base105) is not { } baseOml || Replay(Job105) is not { } job105)
        {
            output.WriteLine($"skipped: the replay of job 105 is not at {ReplayRoot} (SSAM_PROTOTYPE_REPLAY)");
            return;
        }
        Performance(baseOml, job105);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void Performance(string baseOml, string job105)
    {
        // the worker is a warm process: the JIT of the Model API is not the importer's cost (a cold CLI pays it once, ~4 s)
        Run("warmup", null, new JsonArray(PrototypeOp(Bundle("warmup", "minimal.capture.json"))), out _);
        var capture = Bundle("farmavirtual-105");
        var wall = Stopwatch.StartNew();
        JsonObject prototype;
        NativePerformanceSnapshot phases;
        using (var performance = NativePerformanceCapture.Begin())
        {
            prototype = Run("farmavirtual-105", baseOml, new JsonArray(PrototypeOp(capture)), out _);
            phases = performance.Snapshot();
        }
        var prototypeWall = wall.ElapsedMilliseconds;
        AssertApplied(prototype);
        var timings = prototype["timings"]!.AsObject();
        var applyMs = timings["sessionApplyMs"]!.GetValue<long>();
        var report = Report(prototype);
        File.WriteAllText(Path.Combine(Work, "farmavirtual-105-perf.json"), JsonSerializer.Serialize(phases, PrototypeFakes.Indented));
        // job 105 through today's path (the html op and 330 ops), on a copy of the same base
        wall.Restart();
        var html = Run("job-105", baseOml, [], out _, jobPath: job105);
        var htmlWall = wall.ElapsedMilliseconds;
        var htmlApplyMs = html["timings"]!["sessionApplyMs"]!.GetValue<long>();
        output.WriteLine($"prototype op (direct builder): apply {applyMs} ms (op {report["timings"]!["buildMs"]} ms: expand {report["timings"]!["expandMs"]}, ops {report["timings"]!["opsMs"]}, logic {report["timings"]!["logicMs"]}, widgets {report["timings"]!["widgetsMs"]}), job {prototypeWall} ms, {report["builder"]!["widgets"]} widgets");
        output.WriteLine($"job 105 html op (today's path): apply {htmlApplyMs} ms, job {htmlWall} ms, {html["ops"]} ops, valid {html["isValid"]}");
        File.WriteAllText(Path.Combine(Work, "performance-105.txt"), $"prototype apply {applyMs} ms (job {prototypeWall} ms)\njob 105 html apply {htmlApplyMs} ms (job {htmlWall} ms)\n");
        Assert.True(applyMs <= 15000, $"the direct builder applied in {applyMs} ms (budget 15 s, docs/PROTOTIPO-NATIVO.md 6); job 105 took {htmlApplyMs} ms");
        Assert.True(applyMs < htmlApplyMs, $"the direct builder ({applyMs} ms) is not faster than today's path ({htmlApplyMs} ms)");
    }

    // ---- 9: Haiku_UI-20261010202559: 0 Verify errors, the read-back of every explored state ------------------------------------

    [Fact]
    public void TheFarmaVirtualCaptureAppliesOnHaikuUiWithoutVerifyErrorsAndReadsBackEveryExploredState()
    {
        if (!PrototypeFakes.Studio()) return;
        if (Replay(Base202559) is not { } baseOml)
        {
            output.WriteLine($"skipped: {Base202559} is not at {ReplayRoot} (SSAM_PROTOTYPE_REPLAY)");
            return;
        }
        HaikuUi(baseOml);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void HaikuUi(string baseOml)
    {
        var capture = Bundle("farmavirtual-haiku");
        var result = Run("farmavirtual-haiku", baseOml, new JsonArray(PrototypeOp(capture)), out var candidate);
        AssertApplied(result);
        // no type mismatch in the generated expressions, nothing generated left unused
        var details = (result["details"] as JsonArray ?? []).Select(d => d!.ToString()).ToList();
        Assert.DoesNotContain(details, d => d.Contains("ExpressionComparingDifferentIdentifiers", StringComparison.Ordinal));
        Assert.DoesNotContain(details, d => d.Contains(": Unused", StringComparison.Ordinal) && d.Contains("FarmaVirtual", StringComparison.Ordinal));
        var report = Report(result);
        var ir = PrototypeFakes.Load(capture);
        // the read-back covers every explored state: the view of each, its modal, and the shell around them
        var dom = JsonNode.Parse(File.ReadAllText(report["nativeDom"]!["path"]!.ToString()))!.AsObject();
        var roots = dom["roots"]!.AsObject().Select(p => p.Key).ToHashSet();
        Assert.Contains("shell", roots);
        foreach (var state in (ir.Json["explored"] as JsonArray ?? []).OfType<JsonObject>())
        {
            Assert.Contains("v:" + state["view"], roots);
            if (state["modal"]?.ToString() is { } modal) Assert.Contains("m:" + modal, roots);
        }
        foreach (var root in roots) Assert.NotNull(dom["roots"]![root]!["children"]);
        // the acceptance numbers of 8.1 the build decides
        Assert.Equal(6, report["screens"]!.AsArray().Count);
        Assert.Equal(6, dom["roots"]!.AsObject().Where(r => r.Key.StartsWith("v:", StringComparison.Ordinal)).Sum(r => Find(r.Value, n => n["type"]?.ToString() == "IPopup").Count()));
        Assert.Empty(report["events"]!["notCompiled"]!.AsArray());
        var keys = Keys(candidate, "IMobileFlow:FarmaVirtual", "IMobileBlock:FarmaVirtualShell", "IServerAction:CriarPedido", "IServerEntity:Pedido", "IStaticEntity:Categoria");
        Assert.Equal(5, keys.Values.Distinct().Count());
        output.WriteLine($"Haiku_UI-20261010202559: apply {result["timings"]!["sessionApplyMs"]} ms, {report["builder"]!["widgets"]} widgets, {result["messages"]} messages (0 errors), roots {string.Join(", ", roots.Order(StringComparer.Ordinal))}");
    }

    // ---- 11: the defaults table equals the installed Model API ---------------------------------------------------------------

    [Fact]
    public void TheWidgetDefaultsTableEqualsWhatTheInstalledModelApiCreates()
    {
        if (!PrototypeFakes.Studio()) return;
        Defaults();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void Defaults()
    {
        var dir = Path.Combine(Work, "defaults");
        Directory.CreateDirectory(dir);
        var copy = Path.Combine(dir, "reactive-ui.oml");
        File.Copy(Path.Combine(PrototypeFakes.Root, "tests", "fixtures", "reactive-ui.oml"), copy, true);
        var observed = PrototypeWidgetDefaults.Observe(copy, dir, "o11");
        output.WriteLine(observed.ToJsonString(PrototypeFakes.Indented));
        var diff = PrototypeWidgetDefaults.Diff(observed, "o11");
        Assert.True(diff.Count == 0, "PrototypeWidgetDefaults differs from the installed Model API:\n" + string.Join("\n", diff));
    }
}
