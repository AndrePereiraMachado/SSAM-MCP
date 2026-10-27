using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using OutSystems.Model;
using ServiceStudio.Model;
using ServiceStudio.Model.Interfaces;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The merge proof of an O11 delivery (findings 1 and 4 of the kernel review of 3ab12209), end to end: Delivery.Run, the real
/// job apply, the real planner and content proof, and a bridge whose merge_from_oml is the Service Studio's own MatchTree run
/// headless (MergeProbe.Replay). Only the Studio process is faked.
/// Finding 1: (a) an open module equal to the delivery's base (list_open_modules {model_sha256_of}) is merged without the
/// disposable preview and proved once, after the merge: a three-way merge over an unchanged module takes the candidate as
/// is (proven below on the fixtures, a deferred default included); (b) a preview whose model the delivered module holds is
/// the verdict, reused instead of a second proof; (c) anything else is proved again.
/// Finding 4: each content-proof difference is matched to a known loss of the merge order by its element's name, never by a
/// count and never by a local key; "nothing else differs" only when every difference matched.
/// </summary>
public class DeliveryMergeContentRuleTests
{
    private const string Fingerprint = "list_open_modules:model_sha256";

    private const string PetJob = """
    {"ops":[
     {"op":"spec","data":{"static":[{"name":"Species","public":true,"records":[{"name":"Dog","id":1},{"name":"Cat","id":2}]},
                                    {"name":"Stage","public":true,"records":[{"name":"Egg","id":1}]}],
       "entities":[{"name":"Pet","public":true,"attributes":[{"name":"Name","type":"Text","length":30},
         {"name":"SpeciesId","type":"Species Identifier","mandatory":true,"default":"Entities.Species.Dog"DELETE_RULE},
         {"name":"StageId","type":"Stage Identifier","mandatory":true,"default":"Entities.Stage.Egg"}]}]}},
     {"op":"logic","data":{"actions":[{"name":"Adopt","kind":"server","public":true,
       "inputs":[{"name":"SpeciesId","type":"Species Identifier","default":"Entities.Species.Cat"}],"outputs":[{"name":"Out","type":"Species Identifier"}],
       "steps":[{"assign":{"Out":"SpeciesId"}}]}]}}]}
    """;

    /// <summary>The static entities the logic job below uses, in the base: the logic job then has no data assertion, so
    /// the merge order and the content proof alone decide.</summary>
    private const string StaticJob = """
    {"ops":[{"op":"spec","data":{"static":[{"name":"Species","public":true,"records":[{"name":"Dog","id":1},{"name":"Cat","id":2}]}]}}]}
    """;

    private const string LogicJob = """
    {"ops":[{"op":"logic","data":{"actions":[
      {"name":"Adopt","kind":"server","public":true,"inputs":[{"name":"SpeciesId","type":"Species Identifier","default":"Entities.Species.Cat"}],
       "outputs":[{"name":"Out","type":"Species Identifier"}],"steps":[{"assign":{"Out":"SpeciesId"}}]},
      {"name":"Hatch","kind":"server","public":true,"inputs":[{"name":"SpeciesId","type":"Species Identifier","default":"Entities.Species.Dog"}],
       "outputs":[{"name":"Out","type":"Species Identifier"}],"steps":[{"assign":{"Out":"SpeciesId"}}]}]}}]}
    """;

    /// <summary>A job that adds one valid server action.</summary>
    private static string Action(string name) => """{"ops":[{"op":"logic","data":{"actions":[{"name":"NAME","kind":"server","outputs":[{"name":"Out","type":"Integer"}],"steps":[{"assign":{"Out":"1"}}]}]}}]}""".Replace("NAME", name);

    // ---- Finding 1 -------------------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("blank-service.oml")]
    [InlineData("reactive-ui.oml")]
    [InlineData("traditional-ui.oml")]
    public void AThreeWayMergeOverAnUnchangedModuleGivesTheCandidate(string fixture)
    {
        // Rule (a): local == base. The headless MatchTree with the delivery's merge order (a deferred default on each new
        // identifier attribute and input) gives the candidate's content, as the content proof reads it.
        StudioAssemblies.Bind();
        var work = Work();
        var host = new ModelHost(Path.Combine(work, "model"));
        var basis = Path.Combine(work, "base.oml"); File.Copy(Path.Combine(Root, "tests", "fixtures", fixture), basis);
        foreach (var (name, text) in new[] { ("pet", PetJob.Replace("DELETE_RULE", "")), ("trivial", Action("MergeRuleProbe")) })
        {
            var job = Path.Combine(work, name + ".json"); File.WriteAllText(job, text);
            var candidate = Path.Combine(work, name + "-candidate.oml");
            var applied = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(work, name + "-apply")), basis, job, candidate))!;
            Assert.True(applied["accepted"]!.GetValue<bool>(), fixture + " " + name + ": " + applied.ToJsonString());
            var (deferred, firstPass) = MergePlanner.Plan(host, File.ReadAllBytes(basis), File.ReadAllBytes(candidate));
            if (name == "pet") Assert.Contains(deferred, d => d.Element == "Pet.SpeciesId");
            var merged = Path.Combine(work, name + "-merged.oml");
            var probe = MergeProbe.Replay(host, File.ReadAllBytes(basis), File.ReadAllBytes(basis), File.ReadAllBytes(candidate), firstPass, merged);
            Assert.False(probe.HasConflicts, fixture + " " + name);
            var proof = MergeContentProof.Check(host, candidate, merged);
            Assert.True(proof["accepted"]!.GetValue<bool>(), fixture + " " + name + ": " + proof["differences"]!.ToJsonString());
        }
    }

    [Fact]
    public void AnOpenModuleEqualToTheBaseSkipsThePreviewAndIsProvedOnceAfterTheMerge()
    {
        var studio = Studio(Fixture("blank-service.oml"), fingerprint: true);
        var planner = new CountingPlanner();
        var result = Deliver(studio, PetJob.Replace("DELETE_RULE", ""), new FullPlanner(planner));
        Assert.True(result["delivered"]!.GetValue<bool>(), result["error"]?.ToString());
        Assert.Equal("a", result["mergeProof"]?["rule"]?.ToString());
        Assert.Contains("equals this delivery's base", result["mergeProof"]!["reason"]!.ToString());
        // No disposable merge: the planner was asked for the order only, and the deferred defaults still went in two merges.
        Assert.Null(result["mergeContentPreview"]);
        Assert.Equal(0, planner.FullPlans);
        Assert.NotNull(Assert.Single(studio.Merges)["first_pass_path"]);
        // The proof after the merge ran once, on the delivered module, and accepted it.
        Assert.Equal(1, planner.Proofs);
        Assert.True(result["contentProof"]!["accepted"]!.GetValue<bool>());
        Assert.Null(result["contentProof"]!["reused"]);
        Assert.NotNull(result["timings"]?["contentProofMs"]);
        Assert.NotNull(result["timings"]?["openModuleFingerprintMs"]);
        Assert.Null(result["timings"]?["previewMs"]);
    }

    [Fact]
    public void APreviewWhoseModelTheDeliveredModuleHoldsIsReusedInsteadOfASecondProof()
    {
        // A bridge without the fingerprint (rule c before the merge): the preview runs. The live merge gives the preview's
        // model (same inputs, the same native merge): its verdict is the delivered module's, so no second proof runs.
        var studio = Studio(Fixture("blank-service.oml"), fingerprint: false);
        studio.Merged = parameters =>
        {
            var preview = Path.Combine(Path.GetDirectoryName(parameters["foreign_path"]!.ToString())!, "merge-content-preview.oml");
            File.Copy(preview, studio.Live, true);
        };
        var planner = new CountingPlanner();
        var result = Deliver(studio, PetJob.Replace("DELETE_RULE", ""), planner);
        Assert.True(result["delivered"]!.GetValue<bool>(), result["error"]?.ToString());
        Assert.True(result["mergeContentPreview"]!["accepted"]!.GetValue<bool>());
        Assert.Equal("b", result["mergeProof"]?["rule"]?.ToString());
        Assert.True(result["mergeProof"]!["proofReused"]!.GetValue<bool>());
        Assert.Contains("does not offer " + Fingerprint, result["mergeProof"]!["reason"]!.ToString());
        Assert.Equal(0, planner.Proofs);
        Assert.Equal("mergeContentPreview", result["contentProof"]!["reused"]!["from"]!.ToString());
        Assert.True(result["contentProof"]!["accepted"]!.GetValue<bool>());
        Assert.NotNull(result["timings"]?["previewMs"]);
        Assert.Null(result["timings"]?["contentProofMs"]);
    }

    [Fact]
    public void AParallelEditBeforeTheMergeRunsThePreviewAndProvesTheDeliveredModuleAgain()
    {
        // The person edited the module in the Studio after the delivery's snapshot (local != base): the preview runs, the
        // delivered module is not the preview's, and the proof after the merge runs as before and names the other edit.
        var studio = Studio(Fixture("blank-service.oml"), fingerprint: true);
        studio.AfterBaseSnapshot = live => Apply(live, Action("ParallelEdit"));
        var planner = new CountingPlanner();
        var result = Deliver(studio, PetJob.Replace("DELETE_RULE", ""), planner);
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal("c", result["mergeProof"]?["rule"]?.ToString());
        Assert.Contains("differs from this delivery's base", result["mergeProof"]!["reason"]!.ToString());
        Assert.Contains("differs from the preview's result", result["mergeProof"]!["reason"]!.ToString());
        Assert.NotNull(result["mergeContentPreview"]);
        Assert.Equal(1, planner.FullPlans);
        Assert.Equal(1, planner.Proofs);
        Assert.Equal("MERGE_CONTENT_MISMATCH", result["code"]?.ToString());
        Assert.Contains(result["contentProof"]!["differences"]!.AsArray(), d => d!["element"]!.ToString().Contains("ParallelEdit", StringComparison.Ordinal));
    }

    // ---- Finding 4 -------------------------------------------------------------------------------------------------------

    [Fact]
    public void ALostDefaultOnAnElementTheMergeReKeyedIsRecognizedByName()
    {
        // The live merge rebuilt the module with new local keys and lost Adopt.SpeciesId's default (Hatch.SpeciesId kept
        // its own). The loss is found by the element's name: one default, repaired on the element's key in the module now.
        var (studio, liveKeyOf) = LogicStudio(rekeyed: true, lose: "Adopt.SpeciesId");
        var result = Deliver(studio, LogicJob, null);
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Null(result["code"]);
        var missing = result["mergeOrder"]!["missing"]!.AsArray();
        Assert.Equal("Adopt.SpeciesId", Assert.Single(missing)!["element"]!.ToString());
        var repair = Assert.Single(result["mergeOrder"]!["repair"]!["ops"]!.AsArray())!;
        Assert.Equal("@" + liveKeyOf("Adopt.SpeciesId"), repair["target"]!.ToString());
        var error = result["error"]!.ToString();
        Assert.StartsWith("Merge kept for review: the native merge did not keep 1 default value(s): Adopt.SpeciesId = Entities.Species.Cat; nothing else differs.", error);
    }

    [Theory]
    [InlineData(true, "default")]
    [InlineData(false, "default")]
    [InlineData(false, "description")]
    public void OneLostDefaultPlusAnUnrelatedDifferenceIsAContentMismatch(bool rekeyed, string unrelated)
    {
        // Adopt.SpeciesId lost its default and something the merge order did not lose differs too: Hatch.SpeciesId's default
        // changed (a default difference on another element) or Hatch's description. Neither is a known loss, whatever the
        // count of lost defaults: the merge is a content mismatch and the text never says that nothing else differs.
        var (studio, _) = LogicStudio(rekeyed, lose: "Adopt.SpeciesId", unrelated: unrelated);
        var result = Deliver(studio, LogicJob, null);
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal("MERGE_CONTENT_MISMATCH", result["code"]?.ToString());
        Assert.DoesNotContain("nothing else differs", result["error"]!.ToString());
        Assert.Contains(result["mergeOrder"]!["missing"]!.AsArray(), m => m!["element"]!.ToString() == "Adopt.SpeciesId");
    }

    [Fact]
    public void WithoutAContentProofALostDefaultNeverSaysNothingElseDiffers()
    {
        // A planner without a content proof: the lost default is named with its repair, but nothing proves the rest.
        var (studio, _) = LogicStudio(rekeyed: false, lose: "Adopt.SpeciesId");
        var result = Deliver(studio, LogicJob, new PlannerWithoutProof());
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Null(result["contentProof"]);
        var error = result["error"]!.ToString();
        Assert.StartsWith("Merge kept for review: the native merge did not keep 1 default value(s): Adopt.SpeciesId = Entities.Species.Cat.", error);
        Assert.DoesNotContain("nothing else differs", error);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AForcedDeleteRuleIgnoreIsAKnownLossWithItsDeclareJob(bool unrelated)
    {
        // The Studio set Delete Rule Ignore on Pet.SpeciesId (requested Protect) when the merge set its type: the data proof
        // names it and the content proof's api:DeleteRule difference is that same loss, by the element's name. With another
        // difference besides (Pet.Name's length), the merge is a content mismatch.
        var studio = Studio(Fixture("blank-service.oml"), fingerprint: true);
        studio.AfterMerge = live => Edit(live, model =>
        {
            var ops = new JsonArray(new JsonObject { ["op"] = "set", ["target"] = "@" + KeyOf(model, "Pet.SpeciesId"), ["prop"] = "DeleteRule", ["value"] = "Ignore" });
            if (unrelated) ops.Add(new JsonObject { ["op"] = "set", ["target"] = "@" + KeyOf(model, "Pet.Name"), ["prop"] = "Length", ["value"] = "40" });
            return ops;
        });
        var result = Deliver(studio, PetJob.Replace("DELETE_RULE", ",\"deleteRule\":\"Protect\""), null);
        Assert.False(result["delivered"]!.GetValue<bool>());
        var forced = Assert.Single(result["mergeOrder"]!["forcedDeleteRules"]!.AsArray())!;
        Assert.Equal("Pet.SpeciesId", forced["element"]!.ToString());
        var declare = Assert.Single(result["mergeOrder"]!["declare"]!["ops"]!.AsArray())!;
        Assert.Equal("DeleteRule", declare["prop"]!.ToString());
        Assert.Equal("Ignore", declare["value"]!.ToString());
        Assert.Contains(result["contentProof"]!["differences"]!.AsArray(), d => d!["property"]!.ToString() == "api:DeleteRule");
        var error = result["error"]!.ToString();
        Assert.Contains("the Studio set Delete Rule Ignore on Pet.SpeciesId (requested Protect)", error);
        if (unrelated)
        {
            Assert.Equal("MERGE_CONTENT_MISMATCH", result["code"]?.ToString());
            Assert.DoesNotContain("nothing else differs", error);
        }
        else
        {
            Assert.Null(result["code"]);
            Assert.Contains("nothing else differs", error);
        }
    }

    // ---- Timings (env-gated) ---------------------------------------------------------------------------------------------

    /// <summary>The cost of the merge proof per module, headless, through the code the delivery runs: SSAM_MERGE_PROOF_TIMING
    /// lists OML files (';'), SSAM_MERGE_PROOF_TIMING_OUT the JSON-lines report. Without them it does nothing. Per module: the
    /// components (the full plan with its disposable preview, the order alone, one content proof of the merged module), then
    /// a trivial delivery with an open module equal to its base (rule a), the same through a bridge without the fingerprint
    /// (b or c), and one with a parallel edit after the snapshot (c).</summary>
    [Fact]
    public void MergeProofTimingsPerModule()
    {
        if (Environment.GetEnvironmentVariable("SSAM_MERGE_PROOF_TIMING") is not { Length: > 0 } list) return;
        var output = Environment.GetEnvironmentVariable("SSAM_MERGE_PROOF_TIMING_OUT") ?? throw new InvalidOperationException("SSAM_MERGE_PROOF_TIMING_OUT is required");
        var scenarios = (Environment.GetEnvironmentVariable("SSAM_MERGE_PROOF_TIMING_SCENARIOS") ?? "components,a,b,c").Split(',');
        foreach (var (module, index) in list.Split(';', StringSplitOptions.RemoveEmptyEntries).Select((m, i) => (m, i)))
        {
            void Report(JsonObject line) { line["module"] = "module-" + index; line["bytes"] = new FileInfo(module).Length; File.AppendAllText(output, line.ToJsonString() + Environment.NewLine); }
            if (scenarios.Contains("components"))
            {
                StudioAssemblies.Bind();
                var work = Work();
                var basis = Path.Combine(work, "base.oml"); File.Copy(module, basis);
                var job = Path.Combine(work, "job.json"); File.WriteAllText(job, Action("SsamMergeProofProbe"));
                var candidate = Path.Combine(work, "candidate.oml");
                var clock = System.Diagnostics.Stopwatch.StartNew();
                var applied = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(work, "apply")), basis, job, candidate))!;
                var applyMs = clock.ElapsedMilliseconds;
                var planner = new MergePlanner(directory => new ModelHost(Path.Combine(directory, "order-model")));
                clock.Restart(); var full = planner.Plan(basis, candidate, Path.Combine(work, "first-pass.oml")); var fullMs = clock.ElapsedMilliseconds;
                clock.Restart(); typeof(MergePlanner).GetMethod("PlanOrder")?.Invoke(planner, [basis, candidate, Path.Combine(work, "first-pass-order.oml")]); var orderMs = clock.ElapsedMilliseconds;
                var preview = full["contentPreview"]?["path"]?.ToString();
                long? proofMs = null;
                if (preview != null) { clock.Restart(); planner.VerifyContent(candidate, preview); proofMs = clock.ElapsedMilliseconds; }
                clock.Restart(); var modelHash = PrebuiltCandidate.ModelSha256(basis); var hashMs = clock.ElapsedMilliseconds;
                Report(new JsonObject { ["scenario"] = "components", ["applyAccepted"] = applied["accepted"]?.DeepClone(), ["applyMs"] = applyMs,
                    ["planWithPreviewMs"] = fullMs, ["previewTimings"] = full["contentPreview"]?["timings"]?.DeepClone(), ["planOrderOnlyMs"] = orderMs,
                    ["oneContentProofMs"] = proofMs, ["modelHashMs"] = hashMs, ["previewAccepted"] = full["contentPreview"]?["accepted"]?.DeepClone(), ["contentPreviewError"] = full["contentPreviewError"]?.DeepClone() });
            }
            foreach (var scenario in scenarios.Where(s => s is "a" or "b" or "c"))
            {
                var studio = Studio(module, fingerprint: scenario != "b");
                long editMs = 0;
                if (scenario == "c") studio.AfterBaseSnapshot = live => { var c = System.Diagnostics.Stopwatch.StartNew(); Apply(live, Action("SsamParallelEdit")); editMs = c.ElapsedMilliseconds; };
                var result = Deliver(studio, Action("SsamMergeProofProbe"), null);
                Report(new JsonObject { ["scenario"] = scenario, ["delivered"] = result["delivered"]?.DeepClone(), ["code"] = result["code"]?.DeepClone(),
                    ["stage"] = result["stage"]?.DeepClone(), ["rule"] = result["mergeProof"]?["rule"]?.DeepClone(), ["reason"] = result["mergeProof"]?["reason"]?.DeepClone(),
                    ["elapsedMs"] = result["elapsedMs"]?.DeepClone(), ["parallelEditMs"] = editMs, ["applyMs"] = result["apply"]?["timings"]?["totalMs"]?.DeepClone(),
                    ["timings"] = result["timings"]?.DeepClone(), ["error"] = result["delivered"]?.GetValue<bool>() == true ? null : result["error"]?.ToString()[..Math.Min(300, result["error"]?.ToString().Length ?? 0)] });
            }
        }
    }

    // ---- Harness ---------------------------------------------------------------------------------------------------------

    private static string Root => JobRunner.RepoRoot(Path.GetDirectoryName(typeof(DeliveryMergeContentRuleTests).Assembly.Location)!)!;
    private static string Fixture(string name) => Path.Combine(Root, "tests", "fixtures", name);
    private static string Work()
    {
        var work = Path.Combine(Root, ".local", "delivery-merge-content-rule-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        return work;
    }

    private static FakeStudio Studio(string fixture, bool fingerprint)
    {
        StudioAssemblies.Bind();
        var work = Work();
        var live = Path.Combine(work, "live.oml"); File.Copy(fixture, live);
        var studio = new FakeStudio(new ModelHost(Path.Combine(work, "model")), live, work);
        if (fingerprint) studio.Capabilities.Add(Fingerprint);
        return studio;
    }

    /// <summary>A base with the static entities, the logic job delivered over it. The live merge is the headless MatchTree
    /// (rekeyed false) or an independent build of the job over the base, whose new elements have keys of their own
    /// (rekeyed true); then the element named by lose loses its default and the unrelated edit is made.</summary>
    private static (FakeStudio Studio, Func<string, string> LiveKeyOf) LogicStudio(bool rekeyed, string lose, string? unrelated = null)
    {
        var studio = Studio(Fixture("blank-service.oml"), fingerprint: true);
        Apply(studio.Live, StaticJob);
        var basis = Path.Combine(studio.Work, "logic-base.oml"); File.Copy(studio.Live, basis);
        studio.Rebuilt = rekeyed;
        if (rekeyed)
            studio.Merged = _ =>
            {
                var job = Path.Combine(studio.Work, "rebuild.json"); File.WriteAllText(job, LogicJob);
                var rebuilt = Path.Combine(studio.Work, "rebuilt.oml");
                var applied = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(studio.Work, "rebuild-model")), basis, job, rebuilt))!;
                Assert.True(applied["accepted"]!.GetValue<bool>(), applied.ToJsonString());
                File.Copy(rebuilt, studio.Live, true);
            };
        studio.AfterMerge = live =>
        {
            Edit(live, model =>
            {
                Default(model, lose).SetDefaultValue("");
                if (unrelated == "default") Default(model, "Hatch.SpeciesId").SetDefaultValue("Entities.Species.Cat");
                return new JsonArray();
            });
            if (unrelated == "description")
                Edit(live, model => new JsonArray(new JsonObject { ["op"] = "set", ["target"] = "@" + ActionKey(model, "Hatch.SpeciesId"), ["prop"] = "Description", ["value"] = "Changed in the Studio" }));
        };
        string LiveKeyOf(string element)
        {
            var model = studio.Host.Load(File.ReadAllBytes(studio.Live));
            try { return KeyOf(model, element); }
            finally { ModelHost.Release(model); }
        }
        return (studio, LiveKeyOf);
    }

    private static JsonObject Deliver(FakeStudio studio, string jobText, IMergePlanner? planner)
    {
        // The data proof anchors its assertions on the elements' ObjectKeys (DataAssertions), a rule of its own: over a
        // rebuilt module it answers KeyNotFound for every assertion. These tests are about the merge order and the content
        // proof, so a rebuilt module's data proof is left out (accepted, nothing asserted).
        Func<string, JsonArray, JsonObject> inspect = studio.Rebuilt
            ? (_, assertions) => new JsonObject { ["accepted"] = true, ["count"] = assertions.Count, ["differences"] = new JsonArray() }
            : (snapshot, assertions) => new ModelHost(Path.Combine(Path.GetDirectoryName(snapshot)!, "proof-model")).CheckDataContract(snapshot, assertions);
        var job = Path.Combine(studio.Work, "job-" + Guid.NewGuid().ToString("N")[..8] + ".json"); File.WriteAllText(job, jobText);
        studio.Job = job;
        var result = Delivery.Run(studio, new("Headless_CS", job, studio.Work, Array.Empty<string>()),
            (basePath, jobPath, output) => JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(Path.GetDirectoryName(output)!, "model")), basePath, jobPath, output))!.AsObject(),
            inspectData: inspect,
            mergePlanner: planner ?? new MergePlanner(directory => new ModelHost(Path.Combine(directory, "order-model"))));
        File.WriteAllText(Path.Combine(studio.Work, "delivery-result.json"), result.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        return result;
    }

    /// <summary>Applies a job to an OML in place (a person's edit in the Studio).</summary>
    private static void Apply(string path, string jobText)
    {
        var dir = Path.Combine(Path.GetDirectoryName(path)!, "edit-" + Guid.NewGuid().ToString("N")[..8]); Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "edit.json"); File.WriteAllText(job, jobText);
        var output = Path.Combine(dir, "edited.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "model")), path, job, output))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied.ToJsonString());
        File.Copy(output, path, true);
    }

    /// <summary>Edits an OML in place through the Model API: the mutation runs in one command, then the ops.</summary>
    private static void Edit(string path, Func<ESpace, JsonArray> edit)
    {
        var host = new ModelHost(Path.Combine(Path.GetDirectoryName(path)!, "edit-model"));
        var model = host.Load(File.ReadAllBytes(path));
        try
        {
            JsonArray ops = new();
            StudioAdapter.Runtime.Mutate(model, "test: an edit of the delivered module", _ => ops = edit(model));
            if (ops.Count > 0) new ModelSession(model).Apply(ops);
            File.WriteAllBytes(path, host.Save(model));
        }
        finally { ModelHost.Release(model); }
    }

    private static IObjectWithDefaultValue Default(ESpace model, string element)
        => Assert.Single(model.GetAllChildrenOfType<IObjectWithDefaultValue>(), o => Element((AbstractObject)o) == element);

    private static string KeyOf(ESpace model, string element) => ((IObjectSignature)Default(model, element)).ObjectKey!.ToString()!;

    /// <summary>The key of the action that holds the input of that element (Hatch.SpeciesId: Hatch).</summary>
    private static string ActionKey(ESpace model, string input)
        => ((IObjectSignature)((AbstractObject)Default(model, input)).GetParent()!).ObjectKey!.ToString()!;

    private static string Element(AbstractObject o)
    {
        var names = new List<string>();
        for (var x = o; x != null && x is not ESpace; x = x.GetParent()) if (!string.IsNullOrEmpty(x.Name)) names.Add(x.Name);
        names.Reverse();
        return string.Join(".", names);
    }

    /// <summary>The real planner and content proof, counted: FullPlans (with the disposable preview), Proofs (after the merge).</summary>
    private sealed class CountingPlanner : IMergePlanner, IMergeContentVerifier
    {
        private readonly MergePlanner planner = new(directory => new ModelHost(Path.Combine(directory, "order-model")));
        public int FullPlans; public int Proofs;
        public JsonObject Plan(string basePath, string foreignPath, string firstPassPath) { FullPlans++; return planner.Plan(basePath, foreignPath, firstPassPath); }
        public JsonArray Missing(string snapshotPath, JsonArray deferred) => planner.Missing(snapshotPath, deferred);
        public JsonObject VerifyContent(string expectedPath, string snapshotPath) { Proofs++; return planner.VerifyContent(expectedPath, snapshotPath); }
        public JsonObject Order(string basePath, string foreignPath, string firstPassPath)
            => (JsonObject)typeof(MergePlanner).GetMethod("PlanOrder")!.Invoke(planner, [basePath, foreignPath, firstPassPath])!;
    }

    /// <summary>The counted planner with its order-only plan (rule a): PlanOrder by name, so this file builds on a kernel
    /// without it (the order then comes from the full plan, as that kernel did).</summary>
    private sealed class FullPlanner(CountingPlanner inner) : IMergePlanner, IMergeContentVerifier
    {
        public JsonObject Plan(string basePath, string foreignPath, string firstPassPath) => inner.Plan(basePath, foreignPath, firstPassPath);
        public JsonArray Missing(string snapshotPath, JsonArray deferred) => inner.Missing(snapshotPath, deferred);
        public JsonObject VerifyContent(string expectedPath, string snapshotPath) => inner.VerifyContent(expectedPath, snapshotPath);
        public JsonObject PlanOrder(string basePath, string foreignPath, string firstPassPath)
            => typeof(MergePlanner).GetMethod("PlanOrder") != null ? inner.Order(basePath, foreignPath, firstPassPath) : inner.Plan(basePath, foreignPath, firstPassPath);
    }

    /// <summary>The real planner without a content proof.</summary>
    private sealed class PlannerWithoutProof : IMergePlanner
    {
        private readonly MergePlanner planner = new(directory => new ModelHost(Path.Combine(directory, "order-model")));
        public JsonObject Plan(string basePath, string foreignPath, string firstPassPath) => planner.Plan(basePath, foreignPath, firstPassPath);
        public JsonArray Missing(string snapshotPath, JsonArray deferred) => planner.Missing(snapshotPath, deferred);
    }

    /// <summary>The Studio boundary: the open module is a file. merge_from_oml runs the Studio's MatchTree headless (both
    /// merges of the merge order) unless Merged writes the delivered module; AfterMerge then edits it. AfterBaseSnapshot
    /// edits the open module once, right after the delivery's snapshot (a person's edit in the Studio). With the capability
    /// list_open_modules:model_sha256, list_open_modules {model_sha256_of} answers the open module's model fingerprint.</summary>
    private sealed class FakeStudio(ModelHost host, string live, string work) : IBridgeClient
    {
        public ModelHost Host { get; } = host;
        public string Live { get; } = live;
        public string Work { get; } = work;
        public string Job { get; set; } = "";
        public bool Rebuilt { get; set; }
        public List<string> Capabilities { get; } = ["publish_log", Delivery.MergeOrderCapability];
        public Action<string>? AfterBaseSnapshot { get; set; }
        public Action<JsonObject>? Merged { get; set; }
        public Action<string>? AfterMerge { get; set; }
        public List<JsonObject> Merges { get; } = new();
        private int snapshots;
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            switch (method)
            {
                case "bridge_manifest": return new() { ["protocolVersion"] = 2, ["capabilities"] = new JsonArray(Capabilities.Select(c => (JsonNode)c).ToArray()) };
                case "open_module": return new() { ["opened"] = true };
                case "get_active_module": return new() { ["name"] = "Headless_CS", ["key"] = "module" };
                case "list_open_modules":
                    var row = new JsonObject { ["name"] = "Headless_CS", ["key"] = "module", ["hasOpenedActiveESpace"] = true, ["serverSilentMode"] = false };
                    if (parameters?["model_sha256_of"] != null && Capabilities.Contains(Fingerprint)) row["modelSha256"] = PrebuiltCandidate.ModelSha256(Live);
                    return new() { ["modules"] = new JsonArray(row) };
                case "snapshot_module":
                    File.Copy(Live, parameters!["path"]!.ToString(), true);
                    if (snapshots++ == 0) AfterBaseSnapshot?.Invoke(Live);
                    return new() { ["key"] = "module", ["snapshot_id"] = Guid.NewGuid().ToString("N"), ["baseline"] = new JsonArray() };
                case "merge_from_oml":
                    Merges.Add(parameters!.DeepClone().AsObject());
                    var path = parameters["first_pass_path"]?.ToString();
                    if (Merged != null) Merged(parameters);
                    else MergeProbe.Replay(Host, File.ReadAllBytes(Live), File.ReadAllBytes(parameters["base_path"]!.ToString()),
                        File.ReadAllBytes(parameters["foreign_path"]!.ToString()), path == null ? null : File.ReadAllBytes(path), Live);
                    AfterMerge?.Invoke(Live);
                    return new() { ["merged"] = true, ["result"] = "Merge", ["hasConflicts"] = false, ["newErrors"] = 0,
                        ["mergeOrder"] = path != null ? new JsonObject { ["passes"] = 2 } : null, ["secondPass"] = path != null ? new JsonObject { ["merged"] = true } : null };
                case "get_errors": return new() { ["newErrors"] = 0, ["new"] = new JsonArray(), ["rawMessages"] = new JsonArray() };
                default: throw new InvalidOperationException("unexpected bridge call " + method);
            }
        }
    }
}
