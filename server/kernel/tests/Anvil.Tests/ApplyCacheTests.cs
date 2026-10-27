using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>S12 (índices do apply): the profile of the apply per phase, with the native lookups it repeats (name → element,
/// key → element, Kind:Name, callee, the types a text needs). Explicit maintenance profiling, like BatchApplyProfileTests:
/// returns at once unless SSAM_PROFILE_JOB names a job.</summary>
public sealed class ApplyCacheTests(ITestOutputHelper output)
{
    /// <summary>SSAM_PROFILE_JOB: one job or several separated by ';'. SSAM_PROFILE_BASE: the capture (else the job's base).
    /// SSAM_PROFILE_ALL=1 keeps every phase (the native writes by type and property too). SSAM_PROFILE_REPEAT (default 3): runs
    /// per job, each on a new copy of the capture in its own host; the first run of the
    /// process pays the JIT and is reported apart. The median of the others per phase goes to the output and to
    /// SSAM_PROFILE_OUT (or .local/apply-cache-profile/&lt;run&gt;/profile.json).</summary>
    [Fact]
    public void ProfileApplyPhasesAndLookups()
    {
        var jobs = Environment.GetEnvironmentVariable("SSAM_PROFILE_JOB");
        if (string.IsNullOrEmpty(jobs)) return;
        var root = PacoteBPolicyTests.FindRoot();
        var basis = Environment.GetEnvironmentVariable("SSAM_PROFILE_BASE") is { Length: > 0 } b ? b : null;
        var repeat = int.TryParse(Environment.GetEnvironmentVariable("SSAM_PROFILE_REPEAT"), out var r) && r > 0 ? r : 3;
        var work = Path.Combine(root, ".local", "apply-cache-profile", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var report = new JsonArray();
        var warmed = false;
        foreach (var job in jobs.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var runs = new List<(JsonObject Timings, IReadOnlyDictionary<string, NativePerformanceMetric> Phases)>();
            for (var i = warmed ? 1 : 0; i <= repeat; i++)
            {
                var name = Path.GetFileNameWithoutExtension(job) + "-" + i;
                string? copy = null;
                if (basis != null) { copy = Path.Combine(work, name + "-base.oml"); File.Copy(basis, copy); }
                var host = new ModelHost(Path.Combine(work, name));
                using var metrics = NativePerformanceCapture.Begin();
                var result = BaseModelCache.Scoped(null, () => JsonSerializer.SerializeToNode(JobRunner.Run(host, copy, job, Path.Combine(work, name + "-candidate.oml")))!.AsObject());
                Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString()[..Math.Min(4000, result.ToJsonString().Length)]);
                if (i == 0) { warmed = true; continue; }
                runs.Add((result["timings"]!.AsObject(), metrics.Snapshot().Phases));
            }
            static double Median(IEnumerable<double> values) { var s = values.OrderBy(v => v).ToList(); return s.Count == 0 ? 0 : s.Count % 2 == 1 ? s[s.Count / 2] : (s[s.Count / 2 - 1] + s[s.Count / 2]) / 2; }
            var timings = new JsonObject();
            foreach (var key in runs[0].Timings.Select(p => p.Key))
                if (runs.All(x => x.Timings[key] is JsonValue v && v.TryGetValue<long>(out _)))
                    timings[key] = Median(runs.Select(x => (double)x.Timings[key]!.GetValue<long>()));
            var phases = new JsonObject();
            foreach (var key in runs.SelectMany(x => x.Phases.Keys).Distinct().Order(StringComparer.Ordinal))
                if (Environment.GetEnvironmentVariable("SSAM_PROFILE_ALL") == "1" || key.StartsWith("lookup.", StringComparison.Ordinal) || key.StartsWith("flow.", StringComparison.Ordinal) || key.StartsWith("verb.", StringComparison.Ordinal)
                    || key.StartsWith("apply.", StringComparison.Ordinal) || key.StartsWith("logic.", StringComparison.Ordinal) || key.StartsWith("ddl.", StringComparison.Ordinal)
                    || key.StartsWith("create.", StringComparison.Ordinal) || key.StartsWith("watch.", StringComparison.Ordinal) || key == "set.prepare")
                    phases[key] = new JsonObject {
                        ["ms"] = Math.Round(Median(runs.Select(x => x.Phases.GetValueOrDefault(key)?.WallMs ?? 0)), 1),
                        ["calls"] = Median(runs.Select(x => (double)(x.Phases.GetValueOrDefault(key)?.Calls ?? 0))) };
            var row = new JsonObject { ["job"] = Path.GetFileName(job), ["base"] = basis != null ? Path.GetFileName(basis) : null, ["runs"] = runs.Count,
                ["caches"] = Environment.GetEnvironmentVariable("ANVIL_APPLY_CACHES") ?? "on", ["timings"] = timings, ["phases"] = phases };
            report.Add(row);
            output.WriteLine(row.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        }
        var file = Environment.GetEnvironmentVariable("SSAM_PROFILE_OUT") is { Length: > 0 } o ? o : Path.Combine(work, "profile.json");
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file))!);
        File.WriteAllText(file, report.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        output.WriteLine("profile: " + file);
    }

    /// <summary>The jobs of tests/jobs whose logic is text (the op the caches serve) and the two 100-action corpora of the cold
    /// bench (platforms/odc/facade/tests/fixtures/bench-frio, as one job: raw ops, data, logic), on blank-service.</summary>
    public static IEnumerable<object[]> EquivalenceJobs() =>
        new[] { "entity-actions", "traditional-ajax-navigation", "traditional-html-frontend", "bench:portuario", "bench:naval-2" }
            .Select(j => new object[] { j });

    /// <summary>The same job with the caches of the apply on and off (ANVIL_APPLY_CACHES=off, here through the in-process
    /// override) writes the same candidate: every value and connector of every element, the module read back as text, the
    /// verdict and the Verify's messages. Equal apart from the keys each apply drew (ApplyCacheEquivalence).</summary>
    [Theory]
    [MemberData(nameof(EquivalenceJobs))]
    public void TheCachesWriteTheSameCandidate(string name)
    {
        var root = PacoteBPolicyTests.FindRoot();
        var work = Path.Combine(root, ".local", "apply-cache-equivalence", name.Replace(':', '-') + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work);
        var job = name.StartsWith("bench:", StringComparison.Ordinal) ? BenchJob(root, name[6..], work) : Path.Combine(root, "tests", "jobs", name + ".json");
        var basis = JobBase(root, job);
        var off = ApplyJob(job, basis, Path.Combine(work, "off"), caches: false);
        var on = ApplyJob(job, basis, Path.Combine(work, "on"), caches: true);
        Assert.True(off.Result["accepted"]?.GetValue<bool>() == true, name + " (caches off): " + Head(off.Result));
        Assert.Equal(off.Result["accepted"]?.ToJsonString(), on.Result["accepted"]?.ToJsonString());
        Assert.Equal(off.Result["isValid"]?.ToJsonString(), on.Result["isValid"]?.ToJsonString());
        Assert.Equal(off.Result["expectedValid"]?.ToJsonString(), on.Result["expectedValid"]?.ToJsonString());
        Assert.Equal(off.Reading.Messages(off.Result["validation"]), on.Reading.Messages(on.Result["validation"]));
        Assert.Equal(off.Reading.NewElements, on.Reading.NewElements);
        var differences = ApplyCacheEquivalence.Differences(off.Reading, on.Reading);
        Assert.True(differences.Count == 0, name + ": the candidates differ:\n" + string.Join("\n", differences));
        // The override reached the apply: off never answers from the index of the write, on does whenever a text creates a
        // module action.
        Assert.Equal(0, off.Phases.GetValueOrDefault("lookup.moduleAction.written")?.Calls ?? 0);
        if (name.StartsWith("bench:", StringComparison.Ordinal)) Assert.True((on.Phases.GetValueOrDefault("lookup.moduleAction.written")?.Calls ?? 0) > 0);
        output.WriteLine($"{name}: {off.Reading.Values.Count} values, {off.Reading.NewElements} new elements, text {off.Reading.Text.Length} chars: equal");
    }

    /// <summary>The comparison sees a change: the corpus with one literal of one action changed differs from it exactly there.
    /// Without this, a comparison that names everything alike would pass any pair.</summary>
    [Fact]
    public void TheComparisonSeesOneChangedValue()
    {
        var root = PacoteBPolicyTests.FindRoot();
        var work = Path.Combine(root, ".local", "apply-cache-equivalence", "control-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work);
        var job = BenchJob(root, "portuario", work);
        var changed = BenchJob(root, "portuario", work, "portuario-changed", text => {
            var at = text.IndexOf("\"Authentication required\"", StringComparison.Ordinal);
            return text[..at] + "\"Authentication is required\"" + text[(at + "\"Authentication required\"".Length)..];
        });
        var basis = JobBase(root, job);
        var one = ApplyJob(job, basis, Path.Combine(work, "one"), caches: false);
        var other = ApplyJob(changed, basis, Path.Combine(work, "other"), caches: false);
        var differences = ApplyCacheEquivalence.Differences(one.Reading, other.Reading, 200);
        Assert.Contains(differences, d => d.StartsWith("only before: ", StringComparison.Ordinal) && d.Contains("\"Authentication required\"", StringComparison.Ordinal));
        Assert.Contains(differences, d => d.StartsWith("only after: ", StringComparison.Ordinal) && d.Contains("\"Authentication is required\"", StringComparison.Ordinal));
        // Only the node that holds the changed text: the rest of the corpus reads alike. integ/proto-into-product: the candidate's
        // MergeContentProof (merge-identity) names an unnamed flow node by a hash of its content, so the node whose literal
        // changed is another node in each reading, with every value of it and of its expression (the proto's identities kept
        // the node and differed in the expression's two values alone: 4 lines).
        var only = differences.Where(d => d.StartsWith("only ", StringComparison.Ordinal)).ToList();
        string Owner(string line, string text) => line[(line.IndexOf(": ", StringComparison.Ordinal) + 2)..line.IndexOf("/IExpression[ExceptionMessage]", StringComparison.Ordinal)];
        var before = Owner(only.First(d => d.StartsWith("only before: ", StringComparison.Ordinal) && d.Contains("\"Authentication required\"", StringComparison.Ordinal)), "before");
        var after = Owner(only.First(d => d.StartsWith("only after: ", StringComparison.Ordinal) && d.Contains("\"Authentication is required\"", StringComparison.Ordinal)), "after");
        Assert.True(only.All(d => d.Contains(before, StringComparison.Ordinal) || d.Contains(after, StringComparison.Ordinal)), only.Count + " lines differ:\n" + string.Join("\n", only));
        Assert.Equal(only.Count(d => d.StartsWith("only before: ", StringComparison.Ordinal)), only.Count(d => d.StartsWith("only after: ", StringComparison.Ordinal)));
    }

    private static string Head(JsonObject result) { var text = result.ToJsonString(); return text[..Math.Min(4000, text.Length)]; }

    private static (JsonObject Result, ApplyCacheEquivalence.Reading Reading, IReadOnlyDictionary<string, NativePerformanceMetric> Phases) ApplyJob(string job, string basis, string dir, bool caches)
    {
        ModelSession.ApplyCachesOverride.Value = caches;
        try {
            Directory.CreateDirectory(dir);
            var host = new ModelHost(dir);
            var candidate = Path.Combine(dir, "candidate.oml");
            using var metrics = NativePerformanceCapture.Begin();
            var result = BaseModelCache.Scoped(null, () => JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, candidate))!.AsObject());
            var phases = metrics.Snapshot().Phases;
            return (result, ApplyCacheEquivalence.Read(host, candidate, basis), phases);
        }
        finally { ModelSession.ApplyCachesOverride.Value = null; }
    }

    // The capture a job names (a fixture of tests/fixtures by name or by its path under the kernel).
    private static string JobBase(string root, string job)
    {
        var name = JsonNode.Parse(File.ReadAllText(job))!["base"]!.GetValue<string>();
        return File.Exists(Path.Combine(root, name)) ? Path.Combine(root, name) : Path.Combine(root, "tests", "fixtures", name);
    }

    // A corpus of the cold bench as one job, in the order of the lab's job: raw ops (exceptions, roles), the data, the logic
    // (one text per action: a header at column 0 starts one, with the /// lines above it).
    private static string BenchJob(string root, string corpus, string work, string? name = null, Func<string, string>? edit = null)
    {
        var dir = Path.Combine(root, "..", "platforms", "odc", "facade", "tests", "fixtures", "bench-frio", corpus);
        var raw = JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "ops.json")))!;
        var ops = raw is JsonArray list ? list : raw["ops"]!.AsArray();
        var lines = (edit ?? (text => text))(File.ReadAllText(Path.Combine(dir, "logica.flow")).Replace("\r\n", "\n")).Split('\n');
        var header = new System.Text.RegularExpressions.Regex(@"^(?:server action|service action|client action|data action|action|preparation)[ \t]+\S");
        var starts = new List<int>();
        for (var i = 0; i < lines.Length; i++) {
            if (!header.IsMatch(lines[i])) continue;
            var start = i;
            while (start > 0 && (lines[start - 1].StartsWith("/// ", StringComparison.Ordinal) || lines[start - 1] == "///" || lines[start - 1].Trim().Length == 0)) start--;
            while (lines[start].Trim().Length == 0) start++;
            starts.Add(start);
        }
        var texts = new JsonArray(starts.Select((start, i) => (JsonNode)(string.Join("\n", lines[(i == 0 ? 0 : start)..(i + 1 < starts.Count ? starts[i + 1] : lines.Length)]).Trim('\n').TrimEnd() + "\n")).ToArray());
        var job = new JsonObject {
            ["description"] = "S12 equivalence: the cold bench corpus " + corpus, ["base"] = "tests/fixtures/blank-service.oml", ["expectValid"] = true,
            ["ops"] = new JsonArray([.. ops.Select(o => o!.DeepClone()),
                new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = File.ReadAllText(Path.Combine(dir, "dados.ddl")).Replace("\r\n", "\n") } },
                new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = texts } }]) };
        var path = Path.Combine(work, (name ?? corpus) + ".json");
        File.WriteAllText(path, job.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        return path;
    }
}
