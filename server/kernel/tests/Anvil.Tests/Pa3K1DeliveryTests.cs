using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Atritos 3, lane K1, in the delivery (fake bridge, fake producer authority, nothing live):
/// K1-b (C06): capturing a producer whose signature uses types of other producers captures those owners by key, in the same
/// producer-signatures stage, each under its own binding with reason foreign-owner-of:&lt;producer&gt; ((System) is System),
/// and links every signature of the task to the apply; an owner that cannot be captured refuses as
/// PRODUCER_SIGNATURE_MISSING, cause foreign, naming it, before any apply.
/// K1-g (C22): the tab the delivery opened (open_module answered alreadyOpen false) is closed once when the delivery ends in a
/// saved state and the call asks for it (--close-opened-tab); a tab that was already open is never closed.
/// </summary>
public sealed class Pa3K1DeliveryTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Pa3K1DeliveryTests).Assembly.Location)!)!;
    private const string SystemKey = "uXCIR2Atc0+es3zYuZSnNw";
    private const string CaseKey = "193bf0e7-0c07-4ee5-bdb9-a59eb3f2d4f0";
    private const string ReferenceKey = "6f1c0b2a-3d4e-4f50-8a9b-0c1d2e3f4a5b";
    private const string UserKey = "kV+IlDsSrEKfo3vxS9MHeg";
    private const string OrganizationKey = "Pa3K1OrgKeyAAAAAAAAAAA";
    private const string CacKey = "Pa3K1CacKeyAAAAAAAAAAA";

    // The envelopes are read through the Studio model assemblies.
    public Pa3K1DeliveryTests() => StudioAssemblies.Bind();

    [Fact]
    public void CapturingCaseCapturesSystemAndReferenceByThemselvesAndLinksAllThree()
        => WithAuthorityDir(() =>
        {
            var (work, job) = Work("owners", Reference("Case", "IEntitySignature:Casualty"));
            var authority = new OwnerAuthority();
            IReadOnlyDictionary<string, string>? bound = null; var linked = -1;
            var result = Delivery.Run(new Stub(alreadyOpen: true), new DeliveryRequest("Probe", job, work, [], CaptureProducers: ["Case"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: authority,
                applyWithProducers: (_, _, _, producers) => { bound = producers; linked = NativeReferenceSnapshot.Linked.Count; return Rejected(); });
            Assert.Contains("job rejected", result["error"]!.ToString());
            var captured = result["capturedProducers"]!.AsObject();
            var system = captured["System"]!;
            Assert.Equal("(System)", system["producer"]!.ToString());
            Assert.Equal("foreign-owner-of:Case", system["reason"]!.ToString());
            Assert.Equal(SystemKey, system["ownerKey"]!.ToString());
            var reference = captured["Reference_CS"]!;
            Assert.Equal("foreign-owner-of:Case", reference["reason"]!.ToString());
            Assert.Null(captured["Case"]!["reason"]);
            // Each owner by its key, with exactly the elements the dependent uses (typed by the owner's payload).
            Assert.Contains("owner:" + SystemKey + ":@" + UserKey, authority.Calls);
            Assert.Contains("owner:" + ReferenceKey + ":@" + OrganizationKey + ",@" + CacKey, authority.Calls);
            Assert.Equal(1, authority.Calls.Count(c => c.StartsWith("capture:", StringComparison.Ordinal)));
            // The apply binds and links the three signatures; every owner is a recorded source of the task.
            Assert.Equal(new[] { "Case", "Reference_CS", "System" }, bound!.Keys.OrderBy(k => k, StringComparer.Ordinal));
            Assert.Equal(3, linked);
            Assert.Equal(0, NativeReferenceSnapshot.Linked.Count);
            var sources = result["sources"]!.AsArray().Select(s => s!["path"]!.ToString()).ToList();
            Assert.Contains(system["path"]!.ToString(), sources); Assert.Contains(reference["path"]!.ToString(), sources);
        });

    [Fact]
    public void AnOwnerThatCannotBeCapturedRefusesAsForeignNamingItBeforeTheApply()
        => WithAuthorityDir(() =>
        {
            var (work, job) = Work("owner-refused", Reference("Case", "IEntitySignature:Casualty"));
            var authority = new OwnerAuthority { Refused = ReferenceKey };
            var applied = false;
            var result = Delivery.Run(new Stub(alreadyOpen: true), new DeliveryRequest("Probe", job, work, [], CaptureProducers: ["Case"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: authority,
                applyWithProducers: (_, _, _, _) => { applied = true; return Rejected(); });
            Assert.False(applied);
            Assert.Equal("PRODUCER_SIGNATURE_MISSING", result["code"]!.ToString());
            var problem = Assert.Single(result["problems"]!.AsArray())!;
            Assert.Equal("foreign", problem["cause"]!.ToString());
            Assert.Equal(ReferenceKey, problem["owner"]!.ToString());
            Assert.Equal("Case", problem["producer"]!.ToString());
            Assert.Contains("not referenceable", problem["message"]!.ToString());
            Assert.Equal("not-sent", result["writeState"]!.ToString());
        });

    [Theory]
    [InlineData(false, true, 1)]   // opened by the delivery, the call asks: closed once
    [InlineData(true, true, 0)]    // the tab was already open: never closed
    [InlineData(false, false, 0)]  // the call does not ask (a publication follows): the facade closes it after the publish
    public void TheTabTheDeliveryOpenedIsClosedOnceWhenItEndsSaved(bool alreadyOpen, bool close, int expected)
        => WithAuthorityDir(() =>
        {
            var (work, job) = Work("tab", new JsonObject { ["op"] = "find", ["name"] = "Anything" });
            var bridge = new Stub(alreadyOpen);
            var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, [], CloseOpenedTab: close), (_, _, _) => Rejected());
            Assert.Equal("not-sent", result["writeState"]!.ToString());
            Assert.Equal(expected, bridge.Calls.Count(c => c == "close_module"));
            if (expected == 1)
            {
                Assert.True(result["closedTab"]!.GetValue<bool>());
                Assert.Equal("Probe", bridge.Closed!["name"]!.ToString());
                Assert.Equal("module-key", bridge.Closed["module_key"]!.ToString());
            }
            else Assert.Null(result["closedTab"]);
            // Closing is a property of the call, never of the task identity (a resume passes it again).
            var request = new DeliveryRequest("Probe", job, work, [], CloseOpenedTab: true);
            Assert.False(JsonSerializer.SerializeToNode(request)!.AsObject().ContainsKey("CloseOpenedTab"));
            Assert.True(DeliverArguments.CloseOpenedTab(["deliver", "--close-opened-tab"]));
            Assert.False(DeliverArguments.CloseOpenedTab(["deliver"]));
        });

    [Fact]
    public void ATabTheGuardKeepsIsReportedWithTheReason()
        => WithAuthorityDir(() =>
        {
            var (work, job) = Work("tab-kept", new JsonObject { ["op"] = "find", ["name"] = "Anything" });
            var bridge = new Stub(alreadyOpen: false) { RefuseClose = true };
            var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, [], CloseOpenedTab: true), (_, _, _) => Rejected());
            Assert.Equal(1, bridge.Calls.Count(c => c == "close_module"));
            Assert.False(result["closedTab"]!["closed"]!.GetValue<bool>());
            Assert.Contains("unsaved changes", result["closedTab"]!["reason"]!.ToString());
            Assert.Contains("job rejected", result["error"]!.ToString());   // the delivery's own answer stands
        });

    private static JsonObject Rejected() => new() { ["isValid"] = false, ["accepted"] = false };

    private static JsonObject Reference(string producer, string element)
        => new() { ["op"] = "reference", ["producer"] = producer, ["elements"] = new JsonArray(element) };

    private static (string Work, string Job) Work(string tag, JsonObject op)
    {
        var work = Path.Combine(Root, ".local", "pa3-k1-delivery-tests", tag + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = Path.Combine(work, tag + "-job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(op) }.ToJsonString());
        return (work, job);
    }

    private static void WithAuthorityDir(Action body)
    {
        // The module reservations of these deliveries stay in a private authority folder.
        var before = Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR");
        Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Path.Combine(Path.GetTempPath(), "pa3-k1-authority-" + Guid.NewGuid().ToString("N")));
        try { body(); }
        finally { Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Pa2F1TestAuthority.Restore(before)); }
    }

    /// <summary>Case's signature uses User of (System) and Organization and CasualtyAssistanceCenter of Reference_CS
    /// (the shape of the captures of the 2026-10-07 session; synthetic keys). Each capture writes a recorded envelope (legacy fixture, no attestation).</summary>
    private sealed class OwnerAuthority : IProducerSignatureAuthority
    {
        private static readonly string Fixture = Path.Combine(Root, "tests", "contracts", "native-reference", "ordinal-primitive.avsig");
        public List<string> Calls { get; } = [];
        public string? Refused { get; init; }

        public JsonObject Capture(string producer, IReadOnlyList<string> elements, string destination, string environment)
        {
            Calls.Add("capture:" + producer);
            File.Copy(Fixture, destination, overwrite: true);
            return Receipt(producer, CaseKey, [SystemKey + "*" + UserKey, ReferenceKey + "*" + OrganizationKey, ReferenceKey + "*" + CacKey]);
        }

        public JsonObject CaptureByKey(string producerKey, IReadOnlyList<string> elements, string destination, string environment)
        {
            Calls.Add("owner:" + producerKey + ":" + string.Join(",", elements));
            if (producerKey == Refused) throw new InvalidOperationException("ProducerNotFound: producer key " + producerKey + " is not referenceable in " + environment);
            File.Copy(Fixture, destination, overwrite: true);
            return Receipt(producerKey == SystemKey ? "(System)" : "Reference_CS", producerKey, []);
        }

        public JsonObject Attest(string avsigPath, string environment) => new() { ["attested"] = true };

        private static JsonObject Receipt(string producer, string key, string[] foreign) => new() {
            ["producer"] = producer, ["key"] = key, ["kind"] = "eSpace", ["guard"] = "module-version", ["versionIdBefore"] = 7,
            ["signatureHash"] = Guid.NewGuid().ToString(), ["foreignDependencies"] = new JsonArray(foreign.Select(f => (JsonNode)f).ToArray()) };
    }

    private sealed class Stub(bool alreadyOpen) : IBridgeClient
    {
        public List<string> Calls { get; } = [];
        public JsonObject? Closed;
        public bool RefuseClose { get; init; }
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Calls.Add(method);
            switch (method)
            {
                case "open_module": return new() { ["name"] = "Probe", ["opened"] = true, ["alreadyOpen"] = alreadyOpen };
                case "get_active_module": return new() { ["name"] = "Probe", ["key"] = "module-key", ["environment"] = "lab.example" };
                case "snapshot_module":
                    if (parameters?["path"] is { } path) File.WriteAllText(path.ToString(), "snapshot");
                    return new() { ["key"] = "module-key", ["snapshot_id"] = "snapshot-1" };
                case "bridge_manifest": return new() { ["capabilities"] = new JsonArray() };
                case "close_module":
                    Closed = parameters!.DeepClone().AsObject();
                    if (RefuseClose) throw new InvalidOperationException("close_module: tab has unsaved changes, is opening, or has a pending operation; save or resolve it in Studio first");
                    return new() { ["name"] = "Probe", ["closed"] = true };
                default: throw new Exception("Unexpected bridge call: " + method);
            }
        }
    }
}
