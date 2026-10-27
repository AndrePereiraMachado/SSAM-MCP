using System.Reflection;
using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// R1 measurement (ScopeCorpusTests): a delivery's job against the base of its attempt, read as JobRunner reads it before its
/// first op (the preflight of the job, the normalizations, the base check with the scope phase), and nothing applied. The
/// report holds the problems of each phase and the time of each.
/// </summary>
internal static class ScopeCorpus
{
    private static readonly MethodInfo CheckAgainstBase = typeof(JobRunner).GetMethod("CheckAgainstBase", BindingFlags.NonPublic | BindingFlags.Static)!;

    public static void Measure(ModelHost host, string jobPath, string basePath, JsonObject report)
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var job = JobDocument.Parse(jobPath);
        var dir = Path.GetDirectoryName(jobPath)!;
        var preflight = JobPreflight.Analyze(JobRunner.CollectOps(job.DeepClone(), dir, null), job, null, jobPath);
        report["preflightMs"] = clock.ElapsedMilliseconds;
        var ops = JobRunner.CollectOps(job, dir, null);
        var pointer = JobPreflight.OpsPointer(job);
        var expectedValid = job is JsonObject obj && obj["expectValid"] is JsonValue ev && ev.TryGetValue<bool>(out var valid) ? valid : true;
        clock.Restart();
        var bytes = File.ReadAllBytes(basePath);
        var espace = host.Load(bytes);
        report["loadMs"] = clock.ElapsedMilliseconds;
        try
        {
            var session = new ModelSession(espace) { BaseSha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant() };
            var facts = new ModelBaseFacts(session, espace);
            clock.Restart();
            var normalizations = new JsonArray();
            if (expectedValid)
            {
                foreach (var n in JobNormalizer.Pure(ops, pointer, MessageExpectations.Lane)) normalizations.Add(n.DeepClone());
                foreach (var n in JobNormalizer.WithBase(ops, pointer, MessageExpectations.Lane, facts)) normalizations.Add(n.DeepClone());
            }
            report["normalizeMs"] = clock.ElapsedMilliseconds;
            clock.Restart();
            var check = CheckAgainstBase.Invoke(null, [session, espace, ops, preflight, pointer, expectedValid, null, facts])!;
            var problems = (List<JsonObject>)check.GetType().GetProperty("Problems")!.GetValue(check)!;
            SentJob.TranslateAll(problems, ops, pointer);
            report["baseMs"] = clock.ElapsedMilliseconds;
            report["scopeMs"] = ScopePhase.Measured(facts)?.Ms;
            report["preflight"] = (preflight["problems"] as JsonArray)?.DeepClone();
            report["base"] = new JsonArray(problems.Select(p => (JsonNode)p.DeepClone()).ToArray());
            report["normalizations"] = normalizations;
            if (ScopePhase.Measured(facts) is { } measured) report["scopeWarnings"] = new JsonArray(measured.Warnings.Select(w => (JsonNode)w.DeepClone()).ToArray());
        }
        finally { ModelHost.Release(espace); }
    }

    /// <summary>The job run whole by the kernel of this build (preflight, base and scope, apply, Verify) against the base of its
    /// attempt, its producers bound as given: the problems it answers today, each with its phase, and the time.</summary>
    public static void Replay(ModelHost host, string jobPath, string basePath, IReadOnlyDictionary<string, string> bindings, string outPath, JsonObject report)
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            var result = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, outPath, null, bindings)) as JsonObject;
            report["accepted"] = result?["accepted"]?.DeepClone();
            report["isValid"] = result?["isValid"]?.DeepClone();
            report["timings"] = result?["timings"]?.DeepClone();
            report["normalizations"] = result?["normalizations"]?.DeepClone();
            report["problems"] = new JsonArray();
        }
        catch (Exception ex)
        {
            report["accepted"] = false;
            report["refusal"] = Errors.Text(ex).Length > 400 ? Errors.Text(ex)[..400] : Errors.Text(ex);
            report["problems"] = (Errors.FindCoded(ex)?.Problems ?? new JsonArray()).DeepClone();
            report["normalizations"] = Errors.Normalizations(ex)?.DeepClone();
        }
        report["replayMs"] = clock.ElapsedMilliseconds;
    }
}
