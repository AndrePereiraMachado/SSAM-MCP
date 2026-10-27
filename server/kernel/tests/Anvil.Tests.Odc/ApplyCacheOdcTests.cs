using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>S12 (índices do apply), the ODC lane of ApplyCacheTests: the same job with the caches of the apply on and off
/// writes the same candidate. Needs the ODC Studio installed; without it the tests return at once.</summary>
public sealed class ApplyCacheOdcTests(ITestOutputHelper output)
{
    private static readonly string Root = FindRoot();

    /// <summary>The ODC jobs whose logic goes through the text form (entity-actions writes its actions as texts of one logic
    /// op) and a few of the logic spec, the SQL node, a reparent and a service action.</summary>
    public static IEnumerable<object[]> EquivalenceJobs() =>
        new[] { "entity-actions", "logic-action", "logic-sql", "refactor-reparent", "service-action" }.Select(j => new object[] { j });

    [Theory]
    [MemberData(nameof(EquivalenceJobs))]
    public void TheCachesWriteTheSameCandidate(string name)
    {
        if (!StudioAvailable()) return;
        var work = Path.Combine(Root, ".local", "lane-odc", "apply-cache-equivalence", name + "-" + Guid.NewGuid().ToString("N")[..8]);
        var job = Path.Combine(Root, "tests", "jobs-odc", name + ".json");
        // The capture under the chain of `job:` bases: every key not in it is the apply's (ApplyCacheEquivalence).
        var basePath = JsonNode.Parse(File.ReadAllText(job))!["base"]!.GetValue<string>();
        while (basePath.StartsWith("job:", StringComparison.Ordinal))
            basePath = JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "tests", "jobs-odc", basePath[4..] + ".json")))!["base"]!.GetValue<string>();
        var basis = File.Exists(Path.Combine(Root, basePath)) ? Path.Combine(Root, basePath) : Path.Combine(Root, "tests", "fixtures", "odc", basePath);
        var off = Apply(job, basis, Path.Combine(work, "off"), caches: false);
        var on = Apply(job, basis, Path.Combine(work, "on"), caches: true);
        Assert.True(off.Result["accepted"]?.GetValue<bool>() == true, name + " (caches off): " + off.Result.ToJsonString()[..Math.Min(4000, off.Result.ToJsonString().Length)]);
        foreach (var field in new[] { "accepted", "isValid", "expectedValid" })
            Assert.Equal(off.Result[field]?.ToJsonString(), on.Result[field]?.ToJsonString());
        Assert.Equal(off.Reading.Messages(off.Result["validation"]), on.Reading.Messages(on.Result["validation"]));
        Assert.Equal(off.Reading.NewElements, on.Reading.NewElements);
        var differences = ApplyCacheEquivalence.Differences(off.Reading, on.Reading);
        Assert.True(differences.Count == 0, name + ": the candidates differ:\n" + string.Join("\n", differences));
        Assert.Equal(0, off.Phases.GetValueOrDefault("lookup.moduleAction.written")?.Calls ?? 0);
        if (name == "entity-actions") Assert.True((on.Phases.GetValueOrDefault("lookup.moduleAction.written")?.Calls ?? 0) > 0);
        output.WriteLine($"{name}: {off.Reading.Values.Count} values, {off.Reading.NewElements} new elements, text {off.Reading.Text.Length} chars: equal");
    }

    private static (JsonObject Result, ApplyCacheEquivalence.Reading Reading, IReadOnlyDictionary<string, NativePerformanceMetric> Phases) Apply(string job, string basis, string dir, bool caches)
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

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ApplyCacheOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
