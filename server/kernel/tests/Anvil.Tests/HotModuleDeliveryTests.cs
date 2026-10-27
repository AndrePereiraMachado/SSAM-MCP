using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>R3 (módulo quente) in the delivery, with a fake bridge, authority and reader (the shape of FamDepsReferenceTests):
/// the reference closure of a second delivery on the same model reads the inventories it kept, never the module again,
/// and the delivery's receipt says so (referenceClosure reused/savedMs, hot). Another model is read again.</summary>
public sealed class HotModuleDeliveryTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(HotModuleDeliveryTests).Assembly.Location)!)!;
    private const string SystemKey = "uXCIR2Atc0+es3zYuZSnNw";
    private const string UserKey = "LYIWpFuserKeyAAAAAAAAA";
    private const string CsKey = "ctlxH_I+u0qYinuZ13qdyg";
    private const string SystemBase = "25c9070b-5b59-c74b-b02c-0682c87dcb02";
    private const string SystemNew = "eee5a39e-be64-035a-9b30-34e14570177b";
    private const string CsPublished = "58fcb70e-14d9-ab51-f92e-11505b8e046e";

    public HotModuleDeliveryTests() => StudioAssemblies.Bind();

    private static ModuleReferenceEntry Ref(string name, string key, string hash, params (string Name, string Key)[] exports)
        => new(name, key, "eSpace", hash, exports.Select(e => new ReferencedExport(e.Name, "ReferenceEntity", e.Key)).ToArray());

    [Fact]
    public void ASecondDeliveryOnTheSameModelReadsNoInventoryAgain()
    {
        if (ReferenceInventoryCache.Runtime() == null) return;   // no Studio runtime here: nothing is kept, the reader always runs
        var before = Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR");
        Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Path.Combine(Path.GetTempPath(), "hot-delivery-authority-" + Guid.NewGuid().ToString("N")));
        Delivery.CacheInjectedReferenceReads.Value = true;
        try
        {
            var work = Path.Combine(Root, ".local", "hot-delivery-tests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(work);
            var job = Path.Combine(work, "job.json");
            File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "reference", ["producer"] = "VisitaCerta_CS",
                ["elements"] = new JsonArray("IServerEntity:Visita") }) }.ToJsonString());
            // A collateral signature change in the candidate: the closure reads the base and the candidate, then refuses
            // before the merge (FamDepsReferenceTests.ACollateralSignatureChangeInTheCandidateRefusesOnceBeforeTheMerge).
            var reader = new Reader { Candidate = [Ref("(System)", SystemKey, SystemNew, ("User", UserKey)), Ref("VisitaCerta_CS", CsKey, CsPublished, ("Visita", "k1"))] };
            var snapshot = "OML snapshot " + Guid.NewGuid().ToString("N");   // the model of this test only
            JsonObject Deliver() => Delivery.Run(new Stub { SnapshotText = snapshot }, new DeliveryRequest("VisitaCerta_UI", job, work, [], CaptureProducers: ["VisitaCerta_CS"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: new Authority(),
                applyWithProducers: (_, _, output, _) => { File.WriteAllText(output, "OML candidate " + snapshot); return new JsonObject { ["isValid"] = true, ["accepted"] = true }; },
                previewSignatures: (_, _, _) => new JsonObject { ["ran"] = false }, referenceInventory: reader.Read);

            var first = Deliver();
            Assert.Equal(ReferenceClosure.ClosureRefused, first["code"]!.ToString());
            Assert.Equal(["base.oml", "foreign.oml"], reader.Reads);
            Assert.Null(first["referenceClosure"]!["base"]!["reused"]);
            Assert.False(first["hot"]!["reused"]!.GetValue<bool>());

            var second = Deliver();
            Assert.Equal(ReferenceClosure.ClosureRefused, second["code"]!.ToString());
            Assert.Equal(["base.oml", "foreign.oml"], reader.Reads);           // nothing read again
            Assert.Equal("read:base", second["referenceClosure"]!["base"]!["reused"]!.ToString());
            Assert.Equal("read:candidate", second["referenceClosure"]!["candidate"]!["reused"]!.ToString());
            Assert.Equal(2, HotModule.Number(second["referenceClosure"]!["reused"]));
            Assert.True(second["hot"]!["reused"]!.GetValue<bool>());
            Assert.Equal(HotModule.Number(second["referenceClosure"]!["savedMs"]), HotModule.Number(second["hot"]!["savedMs"]));
            // The same problems as the first delivery: what was kept is what was read.
            Assert.Equal(first["problems"]!.ToJsonString(), second["problems"]!.ToJsonString());
        }
        finally
        {
            Delivery.CacheInjectedReferenceReads.Value = false;
            Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Pa2F1TestAuthority.Restore(before));
        }
    }

    private sealed class Reader
    {
        public IReadOnlyList<ModuleReferenceEntry> Base = [Ref("(System)", SystemKey, SystemBase, ("User", UserKey))];
        public IReadOnlyList<ModuleReferenceEntry>? Candidate;
        public List<string> Reads { get; } = [];
        public JsonArray Read(string path)
        {
            var name = Path.GetFileName(path);
            Reads.Add(name);
            return ReferenceClosure.ToJson(name == "foreign.oml" ? Candidate ?? Base : Base);
        }
    }

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
        public required string SnapshotText { get; init; }
        public JsonObject Call(string method, JsonObject? parameters = null) => method switch
        {
            "open_module" => new() { ["name"] = "VisitaCerta_UI", ["opened"] = true, ["alreadyOpen"] = true },
            "get_active_module" => new() { ["name"] = "VisitaCerta_UI", ["key"] = "module-key", ["environment"] = "lab.example" },
            "snapshot_module" => Snapshot(parameters),
            "bridge_manifest" => new() { ["capabilities"] = new JsonArray() },
            "get_errors" => new() { ["rawMessages"] = new JsonArray() },
            _ => throw new Exception("Unexpected bridge call: " + method),
        };

        private JsonObject Snapshot(JsonObject? parameters)
        {
            if (parameters?["path"] is { } path) File.WriteAllText(path.ToString(), SnapshotText);
            return new() { ["key"] = "module-key", ["snapshot_id"] = "snapshot-1", ["baseline"] = new JsonArray() };
        }
    }
}
