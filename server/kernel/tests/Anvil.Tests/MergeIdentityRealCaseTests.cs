using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model;
using ServiceStudio.Model;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// The false MERGE_CONTENT_PREVIEW_REFUSED of 2026-10-22 (O11): a job rewrote the flow of an existing server action with
/// unanchored nodes (If, RaiseException, Assign, End: no @n ids), and the disposable native merge gave each of them a new
/// key. The proof before ssam-merge-identity/2 identified those nodes by their local key, so it reported each as missing
/// under the candidate's key and unexpected under the merge's key, with the same kind and content (117 differences). The
/// new identity rule must accept that merge, and still refuse one real value change in the same flow, naming the element.
/// </summary>
public class MergeIdentityRealCaseTests(ITestOutputHelper output)
{
    /// <summary>The real case, run as the delivery runs it (NativeMergePreview: MergeContentProof.Check(host, candidate,
    /// preview)): expected = the module the job built (foreign.oml), actual = the native merge result
    /// (merge-content-preview.oml). The files are a customer module: they live only outside the repository, in the folder
    /// SSAM_MERGE_REAL_CASE names (base.oml, foreign.oml, merge-content-preview.oml). Without it the test does nothing.</summary>
    [Fact]
    public void TheCapturedNativeMergeOfAnUnanchoredFlowIsAccepted()
    {
        var folder = Environment.GetEnvironmentVariable("SSAM_MERGE_REAL_CASE");
        if (string.IsNullOrEmpty(folder) || !File.Exists(Path.Combine(folder, "foreign.oml")) || !File.Exists(Path.Combine(folder, "merge-content-preview.oml")))
        {
            output.WriteLine("inconclusive: SSAM_MERGE_REAL_CASE does not name a folder with foreign.oml and merge-content-preview.oml");
            return;
        }
        if (!StudioAvailable()) { output.WriteLine("inconclusive: no Service Studio assemblies"); return; }
        RunRealCase(folder);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void RunRealCase(string folder)
    {
        var work = Path.Combine(Path.GetTempPath(), "merge-real-case-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work);
        try
        {
            var proof = MergeContentProof.Check(new ModelHost(Path.Combine(work, "model")),
                Path.Combine(folder, "foreign.oml"), Path.Combine(folder, "merge-content-preview.oml"));
            // The whole proof, when asked, goes to a file outside the repository (it names the customer's elements).
            if (Environment.GetEnvironmentVariable("SSAM_MERGE_REAL_CASE_OUT") is { Length: > 0 } dump) File.WriteAllText(dump, proof.ToJsonString());
            var differences = proof["differences"]!.AsArray();
            output.WriteLine($"identity={proof["coverage"]?["identity"]} accepted={proof["accepted"]} checked={proof["checked"]} differences={differences.Count}");
            foreach (var difference in differences.Take(40)) output.WriteLine(difference!.ToJsonString());
            Assert.True(differences.Count == 0, differences.Count + " difference(s): " + MergeIdentitySweep.Clip(new JsonArray(differences.Take(12).Select(d => d!.DeepClone()).ToArray()).ToJsonString(), 4000));
            Assert.True(proof["accepted"]!.GetValue<bool>());
        }
        finally { try { Directory.Delete(work, true); } catch { } }
    }

    /// <summary>The same shape on a repository fixture, committed: an existing server action whose flow a job replaces with
    /// unanchored nodes (If, RaiseException, Assign, End), merged natively over its base (MergeProbe.ThreeWay, the Studio's
    /// merge). The merge gives the new nodes keys of their own (asserted); the proof accepts it with zero differences.
    /// Then one real value change in that flow (the If condition) over the merge refuses, naming the If node.</summary>
    [Fact]
    public void AnUnanchoredFlowReKeyedByTheNativeMergeIsAcceptedAndARealChangeInItRefuses()
    {
        if (!StudioAvailable()) { output.WriteLine("inconclusive: no Service Studio assemblies"); return; }
        RunSynthetic();
    }

    private static readonly string[] FlowKinds = ["IIfNode", "IRaiseExceptionNode", "IAssignNode", "IEndNode"];

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void RunSynthetic()
    {
        var root = MergeIdentitySweep.Root;
        var work = Path.Combine(Path.GetTempPath(), "merge-unanchored-flow-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work);
        try
        {
            // The base: an exception and a server action whose flow is one Assign.
            var baseJob = Path.Combine(work, "base.json");
            File.WriteAllText(baseJob, new JsonObject
            {
                ["base"] = Path.Combine(root, "tests", "fixtures", "blank-service.oml"), ["expectValid"] = true,
                ["ops"] = JsonNode.Parse("""
                    [{"op":"create","parent":"@espace","type":"IUserException","name":"MiSchemaError"},
                     {"op":"logic","data":{"actions":[{"name":"MiBuildSchema","inputs":[{"name":"ContextText","type":"Text"}],
                       "outputs":[{"name":"SchemaJson","type":"Text"}],"steps":[{"assign":{"SchemaJson":"\"\""}}]}]}}]
                    """)
            }.ToJsonString());
            var basis = MergeIdentitySweep.Build(baseJob, Path.Combine(work, "base", "base.oml"), null);
            Assert.True(basis.Error == null, basis.Error);

            // The candidate: the same action, its flow replaced by unanchored If / RaiseException / Assign / End. The built
            // base is bound on the command (--base), as the delivery binds the module's snapshot.
            var candidateJob = Path.Combine(work, "candidate.json");
            File.WriteAllText(candidateJob, new JsonObject
            {
                ["expectValid"] = true,
                ["ops"] = JsonNode.Parse("""
                    [{"op":"logic","data":{"actions":[{"name":"MiBuildSchema","replace":true,"inputs":[{"name":"ContextText","type":"Text"}],
                       "outputs":[{"name":"SchemaJson","type":"Text"}],"steps":[
                         {"if":"Index(ContextText, \"ALLOWLIST_BEGIN\") < 0","then":[{"raise":"MiSchemaError","message":"\"The allowlist is unavailable.\""}]},
                         {"assign":{"SchemaJson":"\"{\"\"type\"\":\"\"object\"\"}\""}}]}]}}]
                    """)
            }.ToJsonString());
            var candidate = BuildOver(basis.Path!, candidateJob, Path.Combine(work, "candidate", "candidate.oml"));
            Assert.True(candidate.Error == null, candidate.Error);

            var merged = Path.Combine(work, "merged.oml");
            var merge = MergeProbe.ThreeWay(new ModelHost(Path.Combine(work, "merge-model")), File.ReadAllBytes(basis.Path!), File.ReadAllBytes(candidate.Path!), merged);
            Assert.True(File.Exists(merged), "no merged module (valid=" + merge.LocalIsValid + ")");
            Assert.False(merge.HasConflicts);

            var host = new ModelHost(Path.Combine(work, "proof-model"));
            // The precondition: the native merge gave the unanchored flow nodes new keys.
            var candidateKeys = FlowNodeKeys(host, candidate.Path!);
            var mergedKeys = FlowNodeKeys(host, merged);
            output.WriteLine("candidate flow: " + string.Join(", ", candidateKeys.Select(k => k.Kind + "@" + k.Key)));
            output.WriteLine("merged flow:    " + string.Join(", ", mergedKeys.Select(k => k.Kind + "@" + k.Key)));
            Assert.Equal(candidateKeys.Select(k => k.Kind).Order(), mergedKeys.Select(k => k.Kind).Order());
            Assert.True(FlowKinds.All(kind => candidateKeys.Any(k => k.Kind == kind)), "the candidate flow lacks a node kind");
            var rekeyed = mergedKeys.Where(m => !candidateKeys.Any(c => c.Key == m.Key)).ToList();
            Assert.True(rekeyed.Count > 0, "the native merge kept every flow node's key: the case is not reproduced");

            var same = MergeContentProof.Check(host, candidate.Path!, merged);
            var differences = same["differences"]!.AsArray();
            Assert.True(differences.Count == 0 && same["accepted"]!.GetValue<bool>(), MergeIdentitySweep.Summary(differences).ToJsonString());

            // One real change in the re-keyed flow: the If condition.
            var expectedLabels = new Dictionary<string, string>(StringComparer.Ordinal);
            var expectedModel = host.Load(File.ReadAllBytes(candidate.Path!));
            Dictionary<(string Key, string Property), string> expected;
            try { expected = MergeContentProof.Read(expectedModel, null, expectedLabels); }
            finally { ModelHost.Release(expectedModel); }
            var model = host.Load(File.ReadAllBytes(merged));
            try
            {
                var ifKey = FlowNodes(model).Single(n => MergeIdentitySweep.Kind(n) == "IIfNode").ObjectKey!.ToString()!;
                new ModelSession(model).Apply(new JsonArray(new JsonObject
                {
                    ["op"] = "set", ["target"] = "@" + ifKey, ["prop"] = "Condition", ["value"] = "Index(ContextText, \"ALLOWLIST_END\") < 0"
                }));
                var labels = new Dictionary<string, string>(StringComparer.Ordinal);
                var changed = MergeContentProof.Compare(expected, MergeContentProof.Read(model, null, labels), expectedLabels, labels);
                var changedDifferences = changed["differences"]!.AsArray().OfType<JsonObject>().ToList();
                output.WriteLine("changed: " + MergeIdentitySweep.Summary(changed["differences"]!.AsArray()).ToJsonString());
                Assert.False(changed["accepted"]!.GetValue<bool>(), "a changed If condition was accepted");
                Assert.True(changedDifferences.Any(d => d["element"]!.ToString().Contains("IfNode", StringComparison.Ordinal)),
                    "the refusal does not name the If node: " + MergeIdentitySweep.Summary(changed["differences"]!.AsArray()).ToJsonString());
                Assert.DoesNotContain(changedDifferences, d => d["missing"]?.GetValue<bool>() == true || d["unexpected"]?.GetValue<bool>() == true);
            }
            finally { ModelHost.Release(model); }
        }
        finally { try { Directory.Delete(work, true); } catch { } }
    }

    private static MergeIdentitySweep.Built BuildOver(string basePath, string jobPath, string outPath)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
            var result = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(Path.GetDirectoryName(outPath)!, "model")), basePath, jobPath, outPath))!;
            return result["accepted"]?.GetValue<bool>() == true && File.Exists(outPath) ? new(outPath, null)
                : new(null, "not accepted: " + MergeIdentitySweep.Clip(result.ToJsonString()));
        }
        catch (Exception error) { return new(null, (Errors.FindCoded(error)?.Code ?? error.GetType().Name) + ": " + MergeIdentitySweep.Clip(Errors.Text(error))); }
    }

    private static IEnumerable<IObjectSignature> FlowNodes(ESpace model)
    {
        var action = MergeIdentitySweep.Walk(model).Single(n => MergeIdentitySweep.Kind(n) == "IServerAction" && ModelHost.Prop(n, "Name")?.ToString() == "MiBuildSchema");
        return MergeIdentitySweep.Walk(action).Where(n => FlowKinds.Contains(MergeIdentitySweep.Kind(n)));
    }

    private static List<(string Kind, string Key)> FlowNodeKeys(ModelHost host, string path)
    {
        var model = host.Load(File.ReadAllBytes(path));
        try { return FlowNodes(model).Select(n => (MergeIdentitySweep.Kind(n), n.ObjectKey!.ToString()!)).ToList(); }
        finally { ModelHost.Release(model); }
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }
}
