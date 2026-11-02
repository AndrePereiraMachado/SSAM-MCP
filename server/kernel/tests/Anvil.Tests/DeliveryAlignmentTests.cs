using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// B7 (port of proto F9 d01b576c/5282d252; receipts of SSAMCoverageSoapWire_UI on 25/10/2026: every Manage Dependencies before
/// the merge answered "unchanged" in 2.0-4.3 s, every signature preview "changes 0" in ~2.2 s): a consumer delivery asks the
/// Studio to align its producers only when the module, as captured now, lacks a reference, its published signature or an
/// element the job names, and then that capture is the merge's base (no second snapshot); the C15 preview runs only when the
/// closure's inventories show a signature moving. Each skip is in the receipt with its reason. Fake bridge counting its
/// calls, fake authority and reader (no Studio).
/// </summary>
public sealed class DeliveryAlignmentTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(DeliveryAlignmentTests).Assembly.Location)!)!;
    private const string SystemKey = "uXCIR2Atc0+es3zYuZSnNw";
    private const string UserKey = "LYIWpFuserKeyAAAAAAAAA";
    private const string CsKey = "ctlxH_I+u0qYinuZ13qdyg";
    private const string SystemBase = "25c9070b-5b59-c74b-b02c-0682c87dcb02";
    private const string CsPublished = "58fcb70e-14d9-ab51-f92e-11505b8e046e";
    private const string CsOlder = "fc080de4-0000-0000-0000-000000000000";

    public DeliveryAlignmentTests() => StudioAssemblies.Bind();

    private static ModuleReferenceEntry Ref(string name, string key, string hash, params (string Name, string Key)[] exports)
        => new(name, key, "eSpace", hash, exports.Select(e => new ReferencedExport(e.Name, "ReferenceEntity", e.Key)).ToArray());

    private static readonly ModuleReferenceEntry System = Ref("(System)", SystemKey, SystemBase, ("User", UserKey));

    [Fact]
    public void AModuleAlreadyAlignedSendsNoManageDependenciesAndItsCaptureIsTheBase()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("aligned");
            var reader = new Reader { Base = [System, Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "k1"))] };
            var bridge = new Stub();
            var result = Deliver(bridge, work, job, reader, Refused);
            Assert.Contains("job rejected", result["error"]!.ToString());
            Assert.DoesNotContain("refresh_references", bridge.Calls);
            Assert.Equal(1, bridge.Calls.Count(c => c == "snapshot_module"));
            var alignment = result["referencesAlignment"]!;
            Assert.False(alignment["sent"]!.GetValue<bool>());
            Assert.Equal("Manage Dependencies", alignment["command"]!.ToString());
            Assert.Equal("pre-refresh", alignment["base"]!.ToString());
            Assert.Contains("would change nothing", alignment["reason"]!.ToString());
            Assert.True(alignment["producers"]![0]!["aligned"]!.GetValue<bool>());
            // The base is the capture taken before the alignment, byte for byte (a merge base is proven by module and bytes).
            var attempt = Path.Combine(work, "deliver", result["taskId"]!.ToString(), "attempt-0");
            Assert.Equal(File.ReadAllBytes(Path.Combine(attempt, "pre-refresh.oml")), File.ReadAllBytes(Path.Combine(attempt, "base.oml")));
            Assert.Equal("snapshot-1", result["snapshot"]!["snapshot_id"]!.ToString());
            Assert.Equal("pre-refresh", result["snapshot"]!["reusedFrom"]!.ToString());
            Assert.EndsWith("base.oml", result["snapshot"]!["path"]!.ToString());
            Assert.True(result["studioWrites"] is not JsonArray { Count: > 0 });
        });

    [Fact]
    public void AModuleBehindThePublishedSignatureStillTakesTheStudiosAlignmentAndANewBase()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("behind");
            var reader = new Reader { Base = [System, Ref("VisitaCerta_CS", CsKey, CsOlder, ("Visita", "k1"))] };
            var bridge = new Stub();
            var result = Deliver(bridge, work, job, reader, RefusedAfterTheCheck);
            Assert.Equal(1, bridge.Calls.Count(c => c == "refresh_references"));
            Assert.Equal(2, bridge.Calls.Count(c => c == "snapshot_module"));
            Assert.True(result["referencesAlignment"]!["sent"]!.GetValue<bool>());
            Assert.Equal("snapshot", result["referencesAlignment"]!["base"]!.ToString());
            Assert.Contains(CsOlder, result["referencesAlignment"]!["producers"]![0]!["why"]!.ToString());
            Assert.Null(result["snapshot"]!["reusedFrom"]);
            Assert.Equal("snapshot-2", result["snapshot"]!["snapshot_id"]!.ToString());
        });

    [Fact]
    public void AnElementTheJobNamesThatTheModuleLacksGoesThroughManageDependencies()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("element");
            var reader = new Reader { Base = [System, Ref("VisitaCerta_CS", CsKey, CsPublished, ("Local", "k2"))] };
            var bridge = new Stub();
            Deliver(bridge, work, job, reader, RefusedAfterTheCheck);
            var refresh = Assert.Single(bridge.Refreshes);
            Assert.Equal("IServerEntity:Visita", refresh["add"]![0]!["elements"]![0]!.ToString());
        });

    [Fact]
    public void AnExportOfTheSameNameButAnotherElementGoesThroughManageDependencies()
        => WithAuthority(() =>
        {
            // B7 review (round 2, fix 2): the module's reference exports a Visita, but not the element the capture resolves
            // IServerEntity:Visita to (k1): a name alone is no proof, the Studio adds the element.
            var (work, job) = JobWork("same-name-other-element");
            var reader = new Reader { Base = [System, Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "k-action"))] };
            var bridge = new Stub();
            var result = Deliver(bridge, work, job, reader, RefusedAfterTheCheck);
            var refresh = Assert.Single(bridge.Refreshes);
            Assert.Equal("IServerEntity:Visita", refresh["add"]![0]!["elements"]![0]!.ToString());
            Assert.True(result["referencesAlignment"]!["sent"]!.GetValue<bool>());
            Assert.Contains("lacks IServerEntity:Visita", result["referencesAlignment"]!["producers"]![0]!["why"]!.ToString());
        });

    [Fact]
    public void WithoutOwnersTheOpensReferencesCheckDecidesWhetherTheModuleIsCapturedBeforeTheAlignment()
        => WithAuthority(() =>
        {
            // No owner of foreign types (no capture before the alignment of its own) and the open's references check found nothing
            // outdated: the capture is taken, the alignment is spared and the capture is the base.
            var reader = new Reader { Base = [Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "k1"))] };
            var (work, job) = JobWork("no-owner-current");
            var bridge = new Stub();
            var result = Deliver(bridge, work, job, reader, Refused, owners: false);
            Assert.Null(result["capturedProducers"]!.AsObject().FirstOrDefault(p => p.Value?["ownerKey"] != null).Value);
            Assert.DoesNotContain("refresh_references", bridge.Calls);
            Assert.Equal(1, bridge.Calls.Count(c => c == "snapshot_module"));
            Assert.Equal("pre-refresh", result["snapshot"]!["reusedFrom"]!.ToString());

            // The open did not run its references check: nothing predicts an aligned module, so the alignment takes no capture of
            // its own and the Studio's alignment runs, as before this rule. R4 integration (C-06 of B1): the job is checked first on
            // a capture of the module as it is now (pre-refresh.oml, the second snapshot), and the report holds only that check.
            var (work2, job2) = JobWork("no-owner-unchecked");
            var unchecked_ = new Stub { ReferencesCheck = "not-requested" };
            var plain = Deliver(unchecked_, work2, job2, reader, RefusedAfterTheCheck, owners: false);
            Assert.Equal(1, unchecked_.Calls.Count(c => c == "refresh_references"));
            Assert.Equal(2, unchecked_.Calls.Count(c => c == "snapshot_module"));
            Assert.Equal(new[] { "command", "validation" }, plain["referencesAlignment"]!.AsObject().Select(p => p.Key).Order(StringComparer.Ordinal));
            Assert.True(plain["referencesAlignment"]!["validation"]!["ran"]!.GetValue<bool>());
            Assert.False(plain["referencesAlignment"]!["validation"]!["refused"]!.GetValue<bool>());
            Assert.Null(plain["snapshot"]!["reusedFrom"]);
        });

    [Fact]
    public void TheSignaturePreviewRunsOnlyWhenTheClosureSeesASignatureMove()
        => WithAuthority(() =>
        {
            var (work, job) = JobWork("preview-skipped");
            var previews = 0;
            var unchanged = new Reader { Base = [System, Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "k1"))] };
            var result = Deliver(new Stub(), work, job, unchanged, Valid, (_, _, _) => { previews++; return new JsonObject { ["ran"] = true, ["accepted"] = true, ["changes"] = 0 }; });
            Assert.Equal(0, previews);
            Assert.Equal("reference-closure", result["signaturePreview"]!["by"]!.ToString());
            Assert.False(result["signaturePreview"]!["ran"]!.GetValue<bool>());
            Assert.True(result["signaturePreview"]!["accepted"]!.GetValue<bool>());
            Assert.Contains("no producer signature change", result["signaturePreview"]!["reason"]!.ToString());

            // The base references the producer at an older signature and the candidate at the published one: it runs.
            var (work2, job2) = JobWork("preview-ran");
            var moved = new Reader { Base = [System, Ref("VisitaCerta_CS", CsKey, CsOlder, ("Visita", "k1"))],
                Candidate = [System, Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "k1"))] };
            var ran = Deliver(new Stub(), work2, job2, moved, Valid, (_, _, _) => { previews++; return new JsonObject { ["ran"] = true, ["accepted"] = true, ["changes"] = 1 }; });
            Assert.Equal(1, previews);
            Assert.Equal(1, ran["signaturePreview"]!["changes"]!.GetValue<int>());

            // A refusal of the preview still refuses the delivery before the merge.
            var (work3, job3) = JobWork("preview-refused");
            var refused = Deliver(new Stub(), work3, job3, moved, Valid, (_, _, _) => new JsonObject { ["ran"] = true, ["accepted"] = false, ["changes"] = 1, ["error"] = "conflict" });
            Assert.Equal(Delivery.SignaturePreviewRefused, refused["code"]!.ToString());
        });

    private static JsonObject Deliver(Stub bridge, string work, string job, Reader reader,
        Func<string, string, string, IReadOnlyDictionary<string, string>, JsonObject> apply, Func<string, string, string, JsonObject>? preview = null, bool owners = true)
        => Delivery.Run(bridge, new DeliveryRequest("VisitaCerta_UI", job, work, [], CaptureProducers: ["VisitaCerta_CS"]),
            (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority { Owners = owners },
            applyWithProducers: apply, previewSignatures: preview ?? ((_, _, _) => new JsonObject { ["ran"] = false }), referenceInventory: reader.Read);

    private static JsonObject Refused(string basePath, string jobPath, string output, IReadOnlyDictionary<string, string> producers)
        => new() { ["isValid"] = false, ["accepted"] = false };

    /// <summary>R4 integration (C-06 of B1 with B7): the check of the job on the module as it is now, before the Studio's alignment
    /// would write it (validation.oml), accepts, so the alignment runs; the apply after it refuses, as <see cref="Refused"/>.</summary>
    private static JsonObject RefusedAfterTheCheck(string basePath, string jobPath, string output, IReadOnlyDictionary<string, string> producers)
        => Path.GetFileName(output) == "validation.oml" ? Valid(basePath, jobPath, output, producers) : Refused(basePath, jobPath, output, producers);

    private static JsonObject Valid(string basePath, string jobPath, string output, IReadOnlyDictionary<string, string> producers)
    {
        File.WriteAllText(output, "OML candidate");
        return new JsonObject { ["isValid"] = true, ["accepted"] = true };
    }

    private static (string Work, string Job) JobWork(string tag)
    {
        var work = Path.Combine(Root, ".local", "delivery-alignment-tests", tag + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = Path.Combine(work, tag + "-job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "reference", ["producer"] = "VisitaCerta_CS",
            ["elements"] = new JsonArray("IServerEntity:Visita") }) }.ToJsonString());
        return (work, job);
    }

    private static void WithAuthority(Action body)
    {
        var before = Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR");
        Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Path.Combine(Path.GetTempPath(), "delivery-alignment-authority-" + Guid.NewGuid().ToString("N")));
        try { body(); }
        finally { Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Pa2F1TestAuthority.Restore(before)); }
    }

    /// <summary>The inventory of each file the delivery reads, by its name (pre-refresh.oml and base.oml: the base).</summary>
    private sealed class Reader
    {
        public IReadOnlyList<ModuleReferenceEntry> Base = [System];
        public IReadOnlyList<ModuleReferenceEntry>? Candidate;
        public JsonArray Read(string path)
            => ReferenceClosure.ToJson(Path.GetFileName(path) == "foreign.oml" ? Candidate ?? Base : Base);
    }

    /// <summary>VisitaCerta_CS uses User of (System), as in the fam-deps incident; legacy envelopes (no re-attestation).</summary>
    private sealed class Authority : IProducerSignatureAuthority
    {
        private static readonly string Fixture = Path.Combine(Root, "tests", "contracts", "native-reference", "ordinal-primitive.avsig");
        /// <summary>Whether the producer uses a type of (System), whose owner the delivery then captures too (an owner).</summary>
        public bool Owners { get; init; } = true;
        public JsonObject Capture(string producer, IReadOnlyList<string> elements, string destination, string environment)
        {
            File.Copy(Fixture, destination, overwrite: true);
            return new JsonObject { ["producer"] = producer, ["key"] = CsKey, ["kind"] = "eSpace", ["guard"] = "module-version", ["versionIdBefore"] = 6777,
                ["signatureHash"] = CsPublished, ["foreignDependencies"] = Owners ? new JsonArray(SystemKey + "*" + UserKey) : new JsonArray(),
                // The element the job names, resolved by the capture to its original key (ProducerSignatureCapture).
                ["elements"] = new JsonArray(new JsonObject { ["type"] = "IServerEntity", ["name"] = "Visita", ["path"] = "Visita", ["originalKey"] = "k1" }) };
        }
        public JsonObject CaptureByKey(string producerKey, IReadOnlyList<string> elements, string destination, string environment)
        {
            File.Copy(Fixture, destination, overwrite: true);
            return new JsonObject { ["producer"] = "(System)", ["key"] = producerKey, ["kind"] = "eSpace", ["guard"] = "signature-hash",
                ["signatureHash"] = "eee5a39e-be64-035a-9b30-34e14570177b", ["foreignDependencies"] = new JsonArray() };
        }
        public JsonObject Attest(string avsigPath, string environment) => new() { ["attested"] = true };
    }

    private sealed class Stub : IBridgeClient
    {
        private int snapshots;
        public string ReferencesCheck { get; init; } = "complete";
        public List<string> Calls { get; } = [];
        public List<JsonObject> Refreshes { get; } = [];
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Calls.Add(method);
            switch (method)
            {
                case "open_module": return new() { ["name"] = "VisitaCerta_UI", ["opened"] = true, ["alreadyOpen"] = true, ["referencesCheck"] = ReferencesCheck, ["referencesOutdated"] = false };
                case "get_active_module": return new() { ["name"] = "VisitaCerta_UI", ["key"] = "module-key", ["environment"] = "lab.example" };
                case "snapshot_module":
                    // Each capture has its own bytes, as the Studio's do: a base copied from another capture is seen as such.
                    File.WriteAllText(parameters!["path"]!.ToString(), "OML snapshot " + (++snapshots));
                    return new() { ["key"] = "module-key", ["snapshot_id"] = "snapshot-" + snapshots, ["baseline"] = new JsonArray(), ["path"] = parameters!["path"]!.DeepClone() };
                case "bridge_manifest": return new() { ["capabilities"] = new JsonArray("refresh_references", "refresh_references:add") };
                case "refresh_references":
                    Refreshes.Add(parameters!.DeepClone().AsObject());
                    return new() { ["module"] = "VisitaCerta_UI", ["committed"] = true, ["changed"] = false, ["added"] = new JsonArray(), ["refreshed"] = new JsonArray(), ["upToDate"] = new JsonArray() };
                case "merge_from_oml": return new() { ["merged"] = false, ["reason"] = "conflicts: use mode=dialog" };
                case "merge_status": return new() { ["operationId"] = parameters?["operation_id"]?.DeepClone(), ["state"] = "unknown" };
                case "get_errors": return new() { ["rawMessages"] = new JsonArray() };
                default: throw new Exception("Unexpected bridge call: " + method);
            }
        }
    }
}
