using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Family E (fam-deps, 2026-10-12, VisitaCerta_UI "conecte nas telas"): the producer references of a consumer are computed
/// and checked by the kernel. Pure rules (ReferenceClosure) and the delivery with a fake bridge, a fake producer authority
/// and a fake reference reader (nothing live, no Studio): R5 keeps an owner the base already references out of the apply,
/// the candidate is checked before the merge (collateral signature change refused once, named), a merge rolled back names
/// the exact references and the stage, a dialog only the person answers comes back as one question, and the merged module
/// is checked against the candidate after the merge (REFERENCE_NOT_RETAINED). Keys and hashes are those of the incident.
/// </summary>
public sealed class FamDepsReferenceTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(FamDepsReferenceTests).Assembly.Location)!)!;
    private const string SystemKey = "uXCIR2Atc0+es3zYuZSnNw";
    private const string UserKey = "LYIWpFuserKeyAAAAAAAAA";
    private const string CsKey = "ctlxH_I+u0qYinuZ13qdyg";
    private const string IsKey = "q27uE1C0W0afvoBUoIjywA";
    private const string SystemBase = "25c9070b-5b59-c74b-b02c-0682c87dcb02";
    private const string SystemNew = "eee5a39e-be64-035a-9b30-34e14570177b";
    private const string CsPublished = "58fcb70e-14d9-ab51-f92e-11505b8e046e";

    // The recorded envelopes of the fake captures are read through the Studio model assemblies.
    public FamDepsReferenceTests() => StudioAssemblies.Bind();

    // ---- pure rules -------------------------------------------------------------------------------------------------

    private static ModuleReferenceEntry Ref(string name, string key, string hash, params (string Name, string Key)[] exports)
        => new(name, key, "eSpace", hash, exports.Select(e => new ReferencedExport(e.Name, "ReferenceEntity", e.Key)).ToArray());

    private static JsonObject Captured(bool withOwner = true)
    {
        var captured = new JsonObject
        {
            ["VisitaCerta_CS"] = new JsonObject { ["producer"] = "VisitaCerta_CS", ["key"] = CsKey, ["signatureHash"] = CsPublished,
                ["foreignDependencies"] = new JsonArray(SystemKey + "*" + UserKey) },
        };
        if (withOwner)
            captured["System"] = new JsonObject { ["producer"] = "(System)", ["key"] = SystemKey, ["ownerKey"] = SystemKey,
                ["reason"] = "foreign-owner-of:VisitaCerta_CS", ["signatureHash"] = SystemNew, ["foreignDependencies"] = new JsonArray() };
        return captured;
    }

    [Fact]
    public void AnOwnerTheBaseAlreadyReferencesWithEveryNeededObjectIsKeptOutOfTheApply()
    {
        var basis = new[] { Ref("(System)", SystemKey, SystemBase, ("User", UserKey)) };
        var (kept, report) = ReferenceClosure.OwnersKeptByBase(Captured(), basis);
        Assert.Equal(["System"], kept);
        var entry = Assert.Single(report)!;
        Assert.False(entry["linked"]!.GetValue<bool>());
        Assert.Equal(SystemBase, entry["baseHash"]!.ToString());
        Assert.Equal(SystemNew, entry["capturedHash"]!.ToString());
        Assert.Contains("(R5)", entry["why"]!.ToString());
    }

    [Fact]
    public void AnOwnerIsLinkedWhenTheBaseLacksItOrLacksAnObjectItsDependentsUse()
    {
        var (keptNone, reportNone) = ReferenceClosure.OwnersKeptByBase(Captured(), []);
        Assert.Empty(keptNone);
        Assert.True(reportNone[0]!["linked"]!.GetValue<bool>());
        Assert.Contains("does not reference", reportNone[0]!["why"]!.ToString());

        var (keptMissing, reportMissing) = ReferenceClosure.OwnersKeptByBase(Captured(), [Ref("(System)", SystemKey, SystemBase, ("Tenant", "tenantKey"))]);
        Assert.Empty(keptMissing);
        Assert.Contains("@" + UserKey, reportMissing[0]!["why"]!.ToString());
    }

    [Fact]
    public void TheCandidateCheckRefusesACollateralSignatureChangeNamingTheReferenceAndBothHashes()
    {
        var basis = new[] { Ref("(System)", SystemKey, SystemBase, ("User", UserKey)) };
        var candidate = new[] { Ref("(System)", SystemKey, SystemNew, ("User", UserKey)), Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "visitaKey")) };
        var expectations = ReferenceClosure.Expectations([("VisitaCerta_CS", ["IServerEntity:Visita"])], Captured(withOwner: false));
        var problems = ReferenceClosure.CheckCandidate(expectations, candidate, basis, [CsKey]);
        var problem = Assert.Single(problems)!;
        Assert.Equal("collateral", problem["cause"]!.ToString());
        Assert.Equal(ReferenceClosure.ClosureRefused, problem["code"]!.ToString());
        Assert.Equal("(System)", problem["producer"]!.ToString());
        Assert.Equal(SystemBase, problem["expectedHash"]!.ToString());
        Assert.Equal(SystemNew, problem["actualHash"]!.ToString());
        Assert.True(problem["ssamDefect"]!.GetValue<bool>());
        // A needed owner (linked because the base lacked an object) may change: no problem.
        Assert.Empty(ReferenceClosure.CheckCandidate(expectations, candidate, basis, [CsKey, SystemKey]));
    }

    [Fact]
    public void TheCandidateCheckNamesAProducerMissingOrNotAtItsPublishedSignature()
    {
        var expectations = ReferenceClosure.Expectations([("VisitaCerta_CS", ["IServerEntity:Visita"]), ("Alias", ["IServerEntity:X"])], Captured(withOwner: false));
        var missing = ReferenceClosure.CheckCandidate(expectations, [], [], []);
        // Only the producer whose key is known is missing for sure; a label without a key decides nothing.
        var only = Assert.Single(missing)!;
        Assert.Equal("missing", only["cause"]!.ToString());
        Assert.Equal("reference", only["patch"]!["op"]!.ToString());
        var outdated = ReferenceClosure.CheckCandidate(expectations, [Ref("VisitaCerta_CS", CsKey, "fc080de4-0000-0000-0000-000000000000")], [], []);
        Assert.Equal("outdated", Assert.Single(outdated)!["cause"]!.ToString());
    }

    [Fact]
    public void TheDeliveredCheckNamesEveryReferenceTheMergeDidNotKeep()
    {
        var candidate = new[] { Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "k1"), ("StatusVisita", "k2")), Ref("VisitaCerta_IS", IsKey, "is-hash", ("GetAddressByCep", "k3")) };
        Assert.Empty(ReferenceClosure.CheckDelivered(candidate, candidate, [CsKey, IsKey]));
        var delivered = new[] { Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "k1")) };
        var problems = ReferenceClosure.CheckDelivered(candidate, delivered, [CsKey, IsKey]);
        Assert.Equal(2, problems.Count);
        Assert.All(problems, p => Assert.Equal(ReferenceClosure.NotRetained, p!["code"]!.ToString()));
        Assert.Contains(problems, p => p!["element"]?.ToString() == "StatusVisita");
        Assert.Contains(problems, p => p!["producer"]!.ToString() == "VisitaCerta_IS" && p["message"]!.ToString().Contains("no reference"));
        var stale = ReferenceClosure.CheckDelivered(candidate, [Ref("VisitaCerta_CS", CsKey, "old", ("Visita", "k1"), ("StatusVisita", "k2"))], [CsKey]);
        Assert.Equal("old", Assert.Single(stale)!["actualHash"]!.ToString());
    }

    [Fact]
    public void ARollbackPlanIsDescribedWithNamesHashesAndWhetherTheJobNamedEachProducer()
    {
        var plan = new JsonObject { ["Changes"] = new JsonArray(new JsonObject { ["ProducerKey"] = SystemKey, ["BaseHash"] = SystemBase, ["ForeignHash"] = SystemNew }) };
        var changes = ReferenceClosure.SignatureChanges(plan, Captured(), [CsKey]);
        var change = Assert.Single(changes)!;
        Assert.Equal("(System)", change["producer"]!.ToString());
        Assert.False(change["namedByJob"]!.GetValue<bool>());
        Assert.Equal("(System) 25c9070b -> eee5a39e (owner of foreign types, not named by the job)", ReferenceClosure.Describe(changes));
    }

    [Fact]
    public void ReferenceOpsAreReadFromTheJobAndItsParts()
    {
        var work = Work("ops");
        var part = Path.Combine(work, "part.json");
        File.WriteAllText(part, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "reference", ["producer"] = "VisitaCerta_IS", ["elements"] = new JsonArray("IServiceAction:GetAddressByCep") }) }.ToJsonString());
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["jobs"] = new JsonArray("part.json"), ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "reference", ["producer"] = "VisitaCerta_CS", ["elements"] = new JsonArray("IServerEntity:Visita") },
            new JsonObject { ["op"] = "reference", ["producer"] = "VisitaCerta_CS", ["elements"] = new JsonArray("IServerEntity:Local", "IServerEntity:Visita") }) }.ToJsonString());
        var ops = ReferenceClosure.ReferenceOps(job);
        Assert.Equal(2, ops.Count);
        Assert.Equal(["IServerEntity:Visita", "IServerEntity:Local"], ops.Single(o => o.Producer == "VisitaCerta_CS").Elements);
        Assert.Equal(["IServiceAction:GetAddressByCep"], ops.Single(o => o.Producer == "VisitaCerta_IS").Elements);
    }

    [Fact]
    public void TheReaderListsEachProducerReferenceWithItsHashAndTheOriginalKeysOfItsExports()
    {
        // reactive-ui.oml carries the (System) reference of the template the incident's VisitaCerta_UI was made from.
        var references = ReferenceClosure.FromJson(ReferenceInventory.Read(Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml"), Work("reader")));
        var system = Assert.Single(references, r => r.Name == "(System)");
        Assert.Equal(SystemKey, system.ProducerKey);
        Assert.Equal(SystemBase, system.Hash);
        var user = Assert.Single(system.Exports, e => e.Name == "User");
        Assert.False(string.IsNullOrEmpty(user.Key));
        Assert.Equal("ReferenceEntity", user.Type);
        // R5 on the real read: a dependent that uses (System).User by that key keeps (System) out of the apply.
        var captured = Captured();
        captured["VisitaCerta_CS"]!["foreignDependencies"] = new JsonArray(SystemKey + "*" + user.Key);
        Assert.Equal(["System"], ReferenceClosure.OwnersKeptByBase(captured, references).Kept);
    }

    // ---- the delivery (fake bridge, authority and reader) -----------------------------------------------------------

    [Fact]
    public void AReaderThatCannotReadTheBaseLeavesTheDeliveryAsBeforeAndSaysWhy()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("no-reader");
            IReadOnlyDictionary<string, string>? bound = null;
            var result = Delivery.Run(new Stub(), new DeliveryRequest("VisitaCerta_UI", job, work, [], CaptureProducers: ["VisitaCerta_CS"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority(),
                applyWithProducers: (_, _, _, producers) => { bound = producers; return new JsonObject { ["isValid"] = false, ["accepted"] = false }; },
                referenceInventory: _ => throw new InvalidOperationException("the model did not load"));
            Assert.Equal(["System", "VisitaCerta_CS"], bound!.Keys.OrderBy(k => k, StringComparer.Ordinal).ToArray());
            Assert.False(result["referenceClosure"]!["base"]!["ran"]!.GetValue<bool>());
            Assert.Contains("did not load", result["referenceClosure"]!["base"]!["reason"]!.ToString());
        });

    /// <summary>A fake reader: the inventory of each file the delivery reads, by its name (base.oml, foreign.oml, delivered-*).</summary>
    private sealed class Reader
    {
        public IReadOnlyList<ModuleReferenceEntry> Base = [Ref("(System)", SystemKey, SystemBase, ("User", UserKey))];
        public IReadOnlyList<ModuleReferenceEntry>? Candidate;
        public IReadOnlyList<ModuleReferenceEntry>? Delivered;
        /// <summary>The module after the Refresh References the kernel runs after a rollback (refreshed-*.oml).</summary>
        public IReadOnlyList<ModuleReferenceEntry>? AfterRefresh;
        public List<string> Reads { get; } = [];
        public JsonArray Read(string path)
        {
            var name = Path.GetFileName(path);
            Reads.Add(name);
            var inventory = name == "base.oml" ? Base : name == "foreign.oml" ? Candidate ?? Base : name.StartsWith("delivered-", StringComparison.Ordinal) ? Delivered ?? Candidate ?? Base
                : name.StartsWith("refreshed-", StringComparison.Ordinal) ? AfterRefresh ?? Base : Base;
            return ReferenceClosure.ToJson(inventory);
        }
    }

    [Fact]
    public void TheDeliveryKeepsTheOwnerTheBaseAlreadyReferencesOutOfTheApplyAndOutOfTheRefresh()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("r5-kept");
            var reader = new Reader();
            IReadOnlyDictionary<string, string>? bound = null;
            var bridge = new Stub { Capabilities = ["refresh_references"] };
            var result = Delivery.Run(bridge, new DeliveryRequest("VisitaCerta_UI", job, work, [], CaptureProducers: ["VisitaCerta_CS"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority(),
                applyWithProducers: (_, _, _, producers) => { bound = producers; return new JsonObject { ["isValid"] = false, ["accepted"] = false }; },
                referenceInventory: reader.Read);
            Assert.Contains("job rejected", result["error"]!.ToString());
            Assert.Equal("(System)", result["capturedProducers"]!["System"]!["producer"]!.ToString());
            // R5: captured (read-only) but not linked: the apply binds only the producer the job names.
            Assert.Equal(["VisitaCerta_CS"], bound!.Keys.ToArray());
            var owner = Assert.Single(result["referenceClosure"]!["owners"]!.AsArray())!;
            Assert.False(owner["linked"]!.GetValue<bool>());
            // The Studio is asked to refresh only the named producer, never the owner.
            Assert.Equal(["VisitaCerta_CS"], bridge.Refresh!["producers"]!.AsArray().Select(p => p!.ToString()).ToArray());
        });

    [Fact]
    public void TheDeliveryLinksTheOwnerWhenTheBaseLacksAnObjectTheDependentUses()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("r5-linked");
            var reader = new Reader { Base = [Ref("(System)", SystemKey, SystemBase, ("Tenant", "tenantKey"))] };
            IReadOnlyDictionary<string, string>? bound = null;
            var result = Delivery.Run(new Stub(), new DeliveryRequest("VisitaCerta_UI", job, work, [], CaptureProducers: ["VisitaCerta_CS"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority(),
                applyWithProducers: (_, _, _, producers) => { bound = producers; return new JsonObject { ["isValid"] = false, ["accepted"] = false }; },
                referenceInventory: reader.Read);
            Assert.Equal(["System", "VisitaCerta_CS"], bound!.Keys.OrderBy(k => k, StringComparer.Ordinal).ToArray());
            Assert.True(result["referenceClosure"]!["owners"]![0]!["linked"]!.GetValue<bool>());
        });

    [Fact]
    public void ACollateralSignatureChangeInTheCandidateRefusesOnceBeforeTheMerge()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("collateral");
            var reader = new Reader { Candidate = [Ref("(System)", SystemKey, SystemNew, ("User", UserKey)), Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "k1"))] };
            var bridge = new Stub();
            var result = Delivery.Run(bridge, new DeliveryRequest("VisitaCerta_UI", job, work, [], CaptureProducers: ["VisitaCerta_CS"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority(),
                applyWithProducers: Valid, previewSignatures: (_, _, _) => new JsonObject { ["ran"] = false }, referenceInventory: reader.Read);
            Assert.Equal(ReferenceClosure.ClosureRefused, result["code"]!.ToString());
            var problem = Assert.Single(result["problems"]!.AsArray())!;
            Assert.Equal("collateral", problem["cause"]!.ToString());
            Assert.Contains("(System)", result["error"]!.ToString());
            Assert.DoesNotContain("merge_from_oml", bridge.Calls);
            Assert.Equal("not-sent", result["writeState"]!.ToString());
        });

    [Fact]
    public void AMergeBlockedByADialogOnlyThePersonAnswersComesBackAsOneQuestionAndIsNeverRepeated()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("blocked");
            var dialog = new JsonObject { ["kind"] = "Recovery", ["title"] = "Recover module", ["text"] = "Open | Discard", ["certain"] = false,
                ["question"] = "O Studio abriu \"Recover module\" durante a entrega: Open | Discard. Escolha Open ou Discard no Studio." };
            var bridge = new Stub { Merge = _ => new JsonObject { ["operationId"] = "x", ["merged"] = null, ["blocked"] = true, ["outcome"] = "running", ["blockedBy"] = dialog.DeepClone() } };
            var result = Delivery.Run(bridge, new DeliveryRequest("VisitaCerta_UI", job, work, [], CaptureProducers: ["VisitaCerta_CS"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority(),
                applyWithProducers: Valid, previewSignatures: (_, _, _) => new JsonObject { ["ran"] = false },
                referenceInventory: new Reader { Candidate = [Ref("(System)", SystemKey, SystemBase, ("User", UserKey)), Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "k1"))] }.Read);
            Assert.Equal(Delivery.StudioDialogPending, result["code"]!.ToString());
            Assert.Equal(dialog["question"]!.ToString(), result["question"]!.ToString());
            Assert.Equal("Recover module", result["blockedBy"]!["title"]!.ToString());
            Assert.Equal("unknown", result["writeState"]!.ToString());
            Assert.Contains("resume", result["error"]!.ToString());
            Assert.Equal(1, bridge.Calls.Count(c => c == "merge_from_oml"));
            Assert.DoesNotContain("merge_status", bridge.Calls);
        });

    [Fact]
    public void AMergeTheStudioRolledBackNamesTheExactReferencesTheStageAndTheRealCause()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("rolled-back");
            var bridge = new Stub { Merge = p => new JsonObject { ["operationId"] = p["operation_id"]!.DeepClone(), ["merged"] = false, ["reason"] = "rolled back", ["rolledBack"] = true,
                ["proof"] = "sha256", ["liveSha256"] = "241dba", ["baseSha256"] = "241dba", ["stage"] = "reference-merge",
                ["error"] = "InvalidOperationException: Native merge did not retain all validated producer signature selections: producer " + SystemKey + " stays at " + SystemBase,
                ["referenceSignatures"] = new JsonObject { ["Changes"] = new JsonArray(new JsonObject { ["ProducerKey"] = SystemKey, ["BaseHash"] = SystemBase, ["ForeignHash"] = SystemNew }) } } };
            var reader = new Reader { Base = [Ref("(System)", SystemKey, SystemBase, ("Tenant", "t"))],
                Candidate = [Ref("(System)", SystemKey, SystemNew, ("Tenant", "t"), ("User", UserKey)), Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "k1"))] };
            var result = Delivery.Run(bridge, new DeliveryRequest("VisitaCerta_UI", job, work, [], CaptureProducers: ["VisitaCerta_CS"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority(),
                applyWithProducers: Valid, previewSignatures: (_, _, _) => new JsonObject { ["ran"] = false }, referenceInventory: reader.Read);
            Assert.Equal(Delivery.MergeRolledBackCode, result["code"]!.ToString());
            var error = result["error"]!.ToString();
            Assert.Contains("(System) 25c9070b -> eee5a39e", error);
            Assert.Contains("stage reference-merge", error);
            Assert.Contains("stays at " + SystemBase, error);
            var change = Assert.Single(result["referenceSignatureChanges"]!.AsArray())!;
            Assert.False(change["namedByJob"]!.GetValue<bool>());
        });

    [Fact]
    public void AMergedModuleThatLostAReferenceExportIsKeptForReviewWithTheExactReference()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("not-retained");
            var reader = new Reader
            {
                Candidate = [Ref("(System)", SystemKey, SystemBase, ("User", UserKey)), Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "k1"), ("StatusVisita", "k2"))],
                Delivered = [Ref("(System)", SystemKey, SystemBase, ("User", UserKey)), Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "k1"))],
            };
            var bridge = new Stub { Merge = p => new JsonObject { ["operationId"] = p["operation_id"]!.DeepClone(), ["merged"] = true, ["undoSteps"] = 1, ["result"] = "Merge" } };
            var result = Delivery.Run(bridge, new DeliveryRequest("VisitaCerta_UI", job, work, [], CaptureProducers: ["VisitaCerta_CS"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority(),
                applyWithProducers: Valid, previewSignatures: (_, _, _) => new JsonObject { ["ran"] = false }, referenceInventory: reader.Read);
            Assert.Equal("applied", result["writeState"]!.ToString());
            Assert.False(result["delivered"]!.GetValue<bool>());
            Assert.Equal(ReferenceClosure.NotRetained, result["code"]!.ToString());
            var failure = Assert.Single(result["failures"]!.AsArray(), f => f!["stage"]!.ToString() == "reference-proof")!;
            Assert.Contains("StatusVisita", failure["error"]!.ToString());
            Assert.Contains(reader.Reads, r => r.StartsWith("delivered-", StringComparison.Ordinal));
        });

    [Fact]
    public void AMergedModuleThatKeptEveryReferenceIsDelivered()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("retained");
            var reader = new Reader { Candidate = [Ref("(System)", SystemKey, SystemBase, ("User", UserKey)), Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "k1"))] };
            var bridge = new Stub { Merge = p => new JsonObject { ["operationId"] = p["operation_id"]!.DeepClone(), ["merged"] = true, ["undoSteps"] = 1, ["result"] = "Merge" } };
            var result = Delivery.Run(bridge, new DeliveryRequest("VisitaCerta_UI", job, work, [], CaptureProducers: ["VisitaCerta_CS"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority(),
                applyWithProducers: Valid, previewSignatures: (_, _, _) => new JsonObject { ["ran"] = false }, referenceInventory: reader.Read);
            Assert.True(result["delivered"]!.GetValue<bool>(), result["error"]?.ToString());
            Assert.Empty(result["referenceClosure"]!["deliveredProblems"]!.AsArray());
        });

    [Fact]
    public void ADependenciesDialogTheBridgeClosedDuringTheMergeIsFollowedByTheStudiosRefreshReferences()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("merge-dependencies");
            var reader = new Reader { Candidate = [Ref("(System)", SystemKey, SystemBase, ("User", UserKey)), Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "k1"))] };
            var bridge = new Stub { Merge = p => new JsonObject { ["operationId"] = p["operation_id"]!.DeepClone(), ["merged"] = true, ["undoSteps"] = 1, ["result"] = "Merge",
                ["dialogs"] = new JsonArray(new JsonObject { ["kind"] = OperationDialogPolicy.Dependencies, ["title"] = "", ["answer"] = "close",
                    ["text"] = "Incompatible or missing dependencies found. Manage Dependencies Cancel" }) } };
            var result = Delivery.Run(bridge, new DeliveryRequest("VisitaCerta_UI", job, work, [], CaptureProducers: ["VisitaCerta_CS"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority(),
                applyWithProducers: Valid, previewSignatures: (_, _, _) => new JsonObject { ["ran"] = false }, referenceInventory: reader.Read);
            var refreshed = Assert.Single(result["referencesRefreshed"]!.AsArray())!;
            Assert.Equal("merge", refreshed["stage"]!.ToString());
            Assert.Equal("Cancel", refreshed["dialog"]![0]!["answer"]!.ToString());
            Assert.Equal("module-key", bridge.Refresh!["module_key"]!.ToString());
            Assert.True(result["delivered"]!.GetValue<bool>(), result["error"]?.ToString());
        });

    // ---- review of fam-deps (2026-10-13) ------------------------------------------------------------------------------

    private static readonly IReadOnlyList<ModuleReferenceEntry> RetainedCandidate = [Ref("(System)", SystemKey, SystemBase, ("User", UserKey)), Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "k1"))];

    private static JsonObject ClosedCrashReport() => new()
    {
        ["kind"] = OperationDialogPolicy.UnexpectedError, ["title"] = "Unexpected Error", ["certain"] = true, ["answer"] = "close", ["closed"] = true,
        ["text"] = "An unexpected error occurred. NullReferenceException: Object reference not set to an instance of an object. Report | Close",
    };

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void AMergeDuringWhichTheStudioReportedAnErrorIsNeverDeliveredOnItsOwnWordAndIsProvenAgainstTheBase(bool mergeSaidMerged)
        => WithAuthority(() =>
        {
            // Finding 1: the crash report the watch closed while the merge ran; the merge still answered as usual (merged, or a
            // plain Cancel). The live module equals the base: rolled back, a named refusal with the stage and the dialog's text.
            var (work, job) = JobWork("studio-error-" + mergeSaidMerged);
            var bridge = new Stub { Merge = p => new JsonObject { ["operationId"] = p["operation_id"]!.DeepClone(), ["merged"] = mergeSaidMerged,
                ["result"] = mergeSaidMerged ? "Merge" : "Cancel", ["undoSteps"] = mergeSaidMerged ? 1 : 0, ["dialogs"] = new JsonArray(ClosedCrashReport()) } };
            var result = Delivery.Run(bridge, new DeliveryRequest("VisitaCerta_UI", job, work, [], CaptureProducers: ["VisitaCerta_CS"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority(),
                applyWithProducers: Valid, previewSignatures: (_, _, _) => new JsonObject { ["ran"] = false }, referenceInventory: new Reader { Candidate = RetainedCandidate }.Read);
            Assert.False(result["delivered"]!.GetValue<bool>());
            Assert.Equal(Delivery.StudioErrorDuringMergeCode, result["code"]!.ToString());
            Assert.Equal("not-applied", result["writeState"]!.ToString());
            Assert.True(result["closed"]!.GetValue<bool>());
            Assert.Equal("rolled-back", result["studioError"]!["proof"]!.ToString());
            Assert.Equal("merge", result["studioError"]!["stage"]!.ToString());
            Assert.Contains("NullReferenceException", result["error"]!.ToString());
            Assert.Contains("Unexpected Error", result["error"]!.ToString());
            Assert.DoesNotContain("get_errors", bridge.Calls);
        });

    [Fact]
    public void AMergeWithAStudioErrorWhoseModuleChangedIsKeptForReviewWithEveryOtherCheckStillRun()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("studio-error-changed");
            var bridge = new Stub { SnapshotText = name => name.StartsWith("studio-error-", StringComparison.Ordinal) ? "OML changed by the merge" : "OML snapshot",
                Merge = p => new JsonObject { ["operationId"] = p["operation_id"]!.DeepClone(), ["merged"] = true, ["result"] = "Merge", ["undoSteps"] = 1,
                    ["dialogs"] = new JsonArray(ClosedCrashReport()) } };
            var result = Delivery.Run(bridge, new DeliveryRequest("VisitaCerta_UI", job, work, [], CaptureProducers: ["VisitaCerta_CS"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority(),
                applyWithProducers: Valid, previewSignatures: (_, _, _) => new JsonObject { ["ran"] = false }, referenceInventory: new Reader { Candidate = RetainedCandidate }.Read);
            Assert.False(result["delivered"]!.GetValue<bool>());
            Assert.Equal("applied", result["writeState"]!.ToString());
            Assert.Equal(Delivery.StudioErrorDuringMergeCode, result["code"]!.ToString());
            Assert.Equal("changed", result["studioError"]!["proof"]!.ToString());
            var failure = Assert.Single(result["failures"]!.AsArray(), f => f!["stage"]!.ToString() == "studio-error")!;
            Assert.Contains("not trusted", failure["error"]!.ToString());
            // Every other check still ran (the verification of the merged module).
            Assert.Contains("get_errors", bridge.Calls);
        });

    [Fact]
    public void ARollbackWithALinkedOwnerNeverSaysTheSameJobWhenNothingChangesTheNextRun()
        => WithAuthority(() =>
        {
            // Finding 2: the owner (System) was linked (the base lacks User), the merge had to select its signature and rolled
            // back. Without the Studio's Refresh References nothing changes for the next run: no "same job", the other fix.
            var (work, job) = JobWork("rollback-no-refresh");
            var result = RunRollback(new Stub { Merge = RolledBackMerge }, new Reader { Base = [Ref("(System)", SystemKey, SystemBase, ("Tenant", "t"))], Candidate = LinkedCandidate }, work, job);
            Assert.Equal(Delivery.MergeRolledBackCode, result["code"]!.ToString());
            Assert.False(result["sameJobAgain"]!.GetValue<bool>());
            Assert.DoesNotContain("same job again", result["error"]!.ToString());
            Assert.Contains("as OML", result["error"]!.ToString());
            Assert.True(Assert.Single(result["referenceSignatureChanges"]!.AsArray())!["neededByDelivery"]!.GetValue<bool>());
        });

    [Fact]
    public void ARollbackSaysTheSameJobOnlyAfterTheKernelBroughtTheModuleToTheCandidatesSignature()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("rollback-aligned");
            var bridge = new Stub { Capabilities = ["refresh_references"], Merge = RolledBackMerge };
            var reader = new Reader { Base = [Ref("(System)", SystemKey, SystemBase, ("Tenant", "t"))], Candidate = LinkedCandidate,
                AfterRefresh = [Ref("(System)", SystemKey, SystemNew, ("Tenant", "t"))] };
            var result = RunRollback(bridge, reader, work, job);
            Assert.True(result["sameJobAgain"]!.GetValue<bool>(), result["error"]!.ToString());
            Assert.Contains("same job again", result["error"]!.ToString());
            Assert.True(result["afterRollback"]!["aligned"]!.GetValue<bool>());
            // The refresh after the rollback named exactly the producer the merge had to select.
            Assert.Contains(SystemKey, bridge.Refreshes[^1]["producer_keys"]!.AsArray().Select(k => k!.ToString()));
        });

    [Fact]
    public void ARollbackWhoseRefreshDidNotAlignTheProducerGivesTheOtherFix()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("rollback-not-aligned");
            var bridge = new Stub { Capabilities = ["refresh_references"], Merge = RolledBackMerge };
            var reader = new Reader { Base = [Ref("(System)", SystemKey, SystemBase, ("Tenant", "t"))], Candidate = LinkedCandidate };
            var result = RunRollback(bridge, reader, work, job);
            Assert.False(result["sameJobAgain"]!.GetValue<bool>());
            Assert.Contains("did not bring (System)", result["error"]!.ToString());
            Assert.Contains("as OML", result["error"]!.ToString());
        });

    private static readonly IReadOnlyList<ModuleReferenceEntry> LinkedCandidate = [Ref("(System)", SystemKey, SystemNew, ("Tenant", "t"), ("User", UserKey)), Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "k1"))];

    private static JsonObject RolledBackMerge(JsonObject p) => new()
    {
        ["operationId"] = p["operation_id"]!.DeepClone(), ["merged"] = false, ["reason"] = "rolled back", ["rolledBack"] = true,
        ["proof"] = "sha256", ["liveSha256"] = "241dba", ["baseSha256"] = "241dba", ["stage"] = "reference-merge",
        ["error"] = "InvalidOperationException: Native merge did not retain all validated producer signature selections",
        ["referenceSignatures"] = new JsonObject { ["Changes"] = new JsonArray(new JsonObject { ["ProducerKey"] = SystemKey, ["BaseHash"] = SystemBase, ["ForeignHash"] = SystemNew }) },
    };

    private static JsonObject RunRollback(Stub bridge, Reader reader, string work, string job)
        => Delivery.Run(bridge, new DeliveryRequest("VisitaCerta_UI", job, work, [], CaptureProducers: ["VisitaCerta_CS"]),
            (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority(),
            applyWithProducers: Valid, previewSignatures: (_, _, _) => new JsonObject { ["ran"] = false }, referenceInventory: reader.Read);

    [Fact]
    public void ALinkedOwnerIsRefreshedBeforeTheSnapshotDecidedOnTheModuleAsItIsNow()
        => WithAuthority(() =>
        {
            // Finding 3: R5 decided before the refresh: the base lacks User of (System), so (System) is linked and refreshed
            // with the producer the job names; only a kept owner stays out of the refresh.
            var (work, job) = JobWork("refresh-linked");
            var reader = new Reader { Base = [Ref("(System)", SystemKey, SystemBase, ("Tenant", "t"))] };
            var bridge = new Stub { Capabilities = ["refresh_references"] };
            var result = Delivery.Run(bridge, new DeliveryRequest("VisitaCerta_UI", job, work, [], CaptureProducers: ["VisitaCerta_CS"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority(),
                applyWithProducers: (_, _, _, _) => new JsonObject { ["isValid"] = false, ["accepted"] = false }, referenceInventory: reader.Read);
            var refresh = Assert.Single(bridge.Refreshes);
            Assert.Equal(["(System)", "VisitaCerta_CS"], refresh["producers"]!.AsArray().Select(p => p!.ToString()).OrderBy(p => p, StringComparer.Ordinal).ToArray());
            Assert.Contains(SystemKey, refresh["producer_keys"]!.AsArray().Select(k => k!.ToString()));
            Assert.Contains("pre-refresh.oml", reader.Reads);
            Assert.True(result["referenceClosure"]!["ownersBeforeRefresh"]![0]!["linked"]!.GetValue<bool>());
            // The capture of the module before the refresh precedes the refresh, which precedes the base snapshot.
            var calls = bridge.Calls;
            Assert.True(calls.IndexOf("snapshot_module") < calls.IndexOf("refresh_references") && calls.LastIndexOf("snapshot_module") > calls.IndexOf("refresh_references"));
        });

    [Fact]
    public void ARefreshTheStudioStoppedWithADialogForThePersonIsOneQuestionBeforeAnyMerge()
        => WithAuthority(() =>
        {
            // Finding 8: the Refresh References the delivery runs has the merge's dialog rule; a dialog only the person answers
            // ends the delivery with STUDIO_DIALOG_PENDING and the question; the closed error report is kept in the result.
            var (work, job) = JobWork("refresh-blocked");
            var question = "O Studio abriu \"Sign in\" durante a entrega: Sign in to lab.example. Entre no Studio. O SSAM nunca digita senha.";
            var bridge = new Stub { Capabilities = ["refresh_references"], RefreshAnswer = _ => new JsonObject { ["module"] = "VisitaCerta_UI", ["changed"] = null,
                ["blocked"] = true, ["blockedBy"] = new JsonObject { ["kind"] = OperationDialogPolicy.SignIn, ["title"] = "Sign in", ["question"] = question },
                ["dialogsBefore"] = new JsonArray(ClosedCrashReport()) } };
            var result = Delivery.Run(bridge, new DeliveryRequest("VisitaCerta_UI", job, work, [], CaptureProducers: ["VisitaCerta_CS"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority(),
                applyWithProducers: Valid, referenceInventory: new Reader().Read);
            Assert.Equal(Delivery.StudioDialogPending, result["code"]!.ToString());
            Assert.Equal(question, result["question"]!.ToString());
            Assert.DoesNotContain("merge_from_oml", bridge.Calls);
            Assert.Equal(OperationDialogPolicy.UnexpectedError, result["refreshDialogs"]![0]!["kind"]!.ToString());
        });

    [Fact]
    public void TheResumeOfABlockedMergeAsksTheQuestionTheStudioShowsNowNotTheFirstOne()
        => WithAuthority(() =>
        {
            // Finding 5: the watch stayed with the merge; merge_status says which dialog waits now.
            var (work, job) = JobWork("resume-new-question");
            var first = new JsonObject { ["kind"] = "Recovery", ["title"] = "Recover module", ["question"] = "primeira pergunta" };
            var now = new JsonObject { ["kind"] = OperationDialogPolicy.Question, ["title"] = "Save changes", ["question"] = "pergunta de agora" };
            var bridge = new Stub { Merge = _ => new JsonObject { ["operationId"] = "x", ["merged"] = null, ["blocked"] = true, ["outcome"] = "running", ["blockedBy"] = first.DeepClone() },
                Status = p => new JsonObject { ["operationId"] = p["operation_id"]!.DeepClone(), ["state"] = "unknown", ["dialogWatch"] = true, ["pendingDialog"] = now.DeepClone(),
                    ["dialogs"] = new JsonArray() } };
            // No captured producer: a resume re-reads only the task's own files (the fake captures are not real envelopes).
            var request = new DeliveryRequest("VisitaCerta_UI", job, work, []);
            JsonObject Deliver(DeliveryRequest r) => Delivery.Run(bridge, r, (_, _, output) => { File.WriteAllText(output, "OML candidate"); return new JsonObject { ["isValid"] = true, ["accepted"] = true }; },
                referenceInventory: new Reader { Candidate = RetainedCandidate }.Read);
            var blocked = Deliver(request);
            Assert.Equal("primeira pergunta", blocked["question"]!.ToString());
            var resumed = Deliver(request with { TaskId = blocked["taskId"]!.ToString() });
            Assert.Equal(Delivery.StudioDialogPending, resumed["code"]?.ToString() ?? resumed["error"]?.ToString());
            Assert.Equal("pergunta de agora", resumed["question"]!.ToString());
            Assert.Contains("Save changes", resumed["error"]!.ToString());
            Assert.Equal(1, bridge.Calls.Count(c => c == "merge_from_oml"));
        });

    private static JsonObject Valid(string basePath, string jobPath, string output, IReadOnlyDictionary<string, string> producers)
    {
        File.WriteAllText(output, "OML candidate");
        return new JsonObject { ["isValid"] = true, ["accepted"] = true };
    }

    private static string Work(string tag)
    {
        var work = Path.Combine(Root, ".local", "fam-deps-tests", tag + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        return work;
    }

    private static (string Work, string Job) JobWork(string tag)
    {
        var work = Work(tag);
        var job = Path.Combine(work, tag + "-job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "reference", ["producer"] = "VisitaCerta_CS",
            ["elements"] = new JsonArray("IServerEntity:Visita") }) }.ToJsonString());
        return (work, job);
    }

    private static void WithAuthority(Action body)
    {
        var before = Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR");
        Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Path.Combine(Path.GetTempPath(), "fam-deps-authority-" + Guid.NewGuid().ToString("N")));
        try { body(); }
        finally { Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Pa2F1TestAuthority.Restore(before)); }
    }

    /// <summary>VisitaCerta_CS uses User of (System), as the capture of the incident does. Each capture writes a recorded
    /// envelope (legacy fixture, no attestation, so no re-attestation is needed).</summary>
    private sealed class Authority : IProducerSignatureAuthority
    {
        private static readonly string Fixture = Path.Combine(Root, "tests", "contracts", "native-reference", "ordinal-primitive.avsig");
        public JsonObject Capture(string producer, IReadOnlyList<string> elements, string destination, string environment)
        {
            File.Copy(Fixture, destination, overwrite: true);
            return new JsonObject { ["producer"] = producer, ["key"] = CsKey, ["kind"] = "eSpace", ["guard"] = "module-version", ["versionIdBefore"] = 6777,
                ["signatureHash"] = CsPublished, ["foreignDependencies"] = new JsonArray(SystemKey + "*" + UserKey) };
        }
        public JsonObject CaptureByKey(string producerKey, IReadOnlyList<string> elements, string destination, string environment)
        {
            File.Copy(Fixture, destination, overwrite: true);
            return new JsonObject { ["producer"] = "(System)", ["key"] = producerKey, ["kind"] = "eSpace", ["guard"] = "signature-hash",
                ["signatureHash"] = SystemNew, ["foreignDependencies"] = new JsonArray() };
        }
        public JsonObject Attest(string avsigPath, string environment) => new() { ["attested"] = true };
    }

    private sealed class Stub : IBridgeClient
    {
        public List<string> Calls { get; } = [];
        public string[] Capabilities { get; init; } = [];
        public JsonObject? Refresh;
        public List<JsonObject> Refreshes { get; } = [];
        public Func<JsonObject, JsonObject>? Merge { get; init; }
        /// <summary>The text of each capture by file name (a live module that differs from the base); "OML snapshot" by default.</summary>
        public Func<string, string>? SnapshotText { get; init; }
        public Func<JsonObject, JsonObject>? RefreshAnswer { get; init; }
        public Func<JsonObject, JsonObject>? Status { get; init; }
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Calls.Add(method);
            switch (method)
            {
                case "open_module": return new() { ["name"] = "VisitaCerta_UI", ["opened"] = true, ["alreadyOpen"] = true };
                case "get_active_module": return new() { ["name"] = "VisitaCerta_UI", ["key"] = "module-key", ["environment"] = "lab.example" };
                case "snapshot_module":
                    if (parameters?["path"] is { } path) File.WriteAllText(path.ToString(), SnapshotText?.Invoke(Path.GetFileName(path.ToString())) ?? "OML snapshot");
                    return new() { ["key"] = "module-key", ["snapshot_id"] = "snapshot-1", ["baseline"] = new JsonArray() };
                case "bridge_manifest": return new() { ["capabilities"] = new JsonArray(Capabilities.Select(c => (JsonNode)JsonValue.Create(c)!).ToArray()) };
                case "refresh_references":
                    Refresh = parameters!.DeepClone().AsObject();
                    Refreshes.Add(Refresh.DeepClone().AsObject());
                    return RefreshAnswer?.Invoke(parameters!) ?? new() { ["module"] = "VisitaCerta_UI", ["changed"] = false, ["refreshed"] = new JsonArray(), ["upToDate"] = new JsonArray() };
                case "merge_from_oml": return (Merge ?? (_ => new JsonObject { ["merged"] = false, ["reason"] = "conflicts: use mode=dialog" }))(parameters!);
                case "merge_status": return Status?.Invoke(parameters!) ?? new() { ["operationId"] = parameters?["operation_id"]?.DeepClone(), ["state"] = "unknown" };
                case "get_errors": return new() { ["rawMessages"] = new JsonArray() };
                default: throw new Exception("Unexpected bridge call: " + method);
            }
        }
    }
}
