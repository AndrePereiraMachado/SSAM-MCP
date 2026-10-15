using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>F5, the family rule of producer signatures (analysis of 2026-10-12: the same producer, same published version,
/// captured and attested again on every round of o11_deliver). A capture is reused while its identity (environment,
/// producer, published version or advertised hash) did not change: the workspace ledger vouches for a recent observation
/// with no publication since, so a round before the merge makes no server call; the merge always observes every producer
/// first (one lease); a producer that changed refuses as PRODUCER_CHANGED before any write and is captured again next
/// time. Never across environments, never after a publication SSAM recorded. Stubbed environment, no Studio.</summary>
public sealed class ProducerSignatureReuseTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ProducerSignatureReuseTests).Assembly.Location)!)!;
    private const string Element = "IServerActionSignature:CSharpTextCompareOrdinal";

    public ProducerSignatureReuseTests() => StudioAssemblies.Bind();

    private sealed class Lab
    {
        public required string Work { get; init; }
        public required SignatureEnvironment Environment { get; init; }
        public required StudioBridge Bridge { get; init; }
        public required StudioProducerAuthority Authority { get; init; }
        public string Job(params string[] elements)
        {
            var job = Path.Combine(Work, "..", "job-" + Guid.NewGuid().ToString("N")[..8] + ".json");
            File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "reference", ["producer"] = "Primitive",
                ["elements"] = new JsonArray(elements.Select(e => (JsonNode)JsonValue.Create(e)!).ToArray()) }) }.ToJsonString());
            return Path.GetFullPath(job);
        }
        public ProducerLedger Ledger => ProducerLedger.ForWork(Work)!;
        public ProducerCache Cache => ProducerCache.ForWork(Work)!;
        public int Signatures => Environment.Operations.Count(o => o == "signature");
        /// <summary>A delivery whose apply refuses (nothing reaches the merge), or accepts when accept is true.</summary>
        public JsonObject Deliver(string job, bool accept = false)
            => Delivery.Run(Bridge, new DeliveryRequest("Probe", job, Work, [], CaptureProducers: ["Primitive=ZZHighCodePrimitives"]),
                (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: Authority,
                applyWithProducers: (_, _, output, _) => { if (accept) File.WriteAllText(output, "candidate"); return new JsonObject { ["isValid"] = accept, ["accepted"] = accept }; },
                previewSignatures: (_, _, _) => new JsonObject { ["ran"] = false, ["reason"] = "no runtime in the test" });
    }

    private static Lab NewLab(string host = "lab.example", string fixture = "ordinal-primitive")
    {
        var work = Path.Combine(Root, ".local", "producer-reuse-tests", Guid.NewGuid().ToString("N"), ".local", "work");
        Directory.CreateDirectory(work);
        var environment = SignatureEnvironment.Serving(NativeReferenceSnapshot.Read(Path.Combine(Root, "tests/contracts/native-reference", fixture + ".avsig")), "Extension");
        environment.Host = host;
        return new Lab { Work = work, Environment = environment, Bridge = new StudioBridge(host),
            Authority = new StudioProducerAuthority(h => HeadlessSession.ConnectStudio(environment, h, null, readOnly: true)) };
    }

    private static void WithAuthorityFolder(Action body)
    {
        var before = Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR");
        Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Path.Combine(Path.GetTempPath(), "producer-reuse-authority-" + Guid.NewGuid().ToString("N")));
        try { body(); }
        finally { Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Pa2F1TestAuthority.Restore(before)); }
    }

    [Fact]
    public void ACacheHitAcrossDeliveriesMakesNoServerCallBeforeTheMerge() => WithAuthorityFolder(() =>
    {
        var lab = NewLab(); var job = lab.Job(Element);
        var first = lab.Deliver(job);
        Assert.Contains("job rejected", first["error"]!.ToString());
        Assert.Equal(1, lab.Signatures);
        Assert.Single(lab.Environment.Connects);   // the capture only: the fresh capture counts as observed for the apply
        Assert.Equal("capture", first["capturedProducers"]!["Primitive"]!["observed"]!["by"]!.ToString());
        Assert.Equal("capture", first["producerAttestation"]!.AsArray().Single()!["by"]!.ToString());

        // Round 2 and 3: new tasks, same producer, same published version: no lease at all before the merge.
        foreach (var round in new[] { lab.Job(Element), job })
        {
            var again = lab.Deliver(round);
            Assert.Contains("job rejected", again["error"]!.ToString());
            var captured = again["capturedProducers"]!["Primitive"]!;
            Assert.True(captured["reusedFromCache"]!.GetValue<bool>());
            Assert.Equal("ledger", captured["observed"]!["by"]!.ToString());
            Assert.Equal(7, captured["versionId"]!.GetValue<int>());
            var attested = again["producerAttestation"]!.AsArray().Single()!;
            Assert.True(attested["attested"]!.GetValue<bool>());
            Assert.Equal("ledger", attested["by"]!.ToString());
        }
        Assert.Equal(1, lab.Signatures);
        Assert.Single(lab.Environment.Connects);

        // The round that reaches the merge observes the producer on the server first, in one lease, and merges.
        var merged = lab.Deliver(job, accept: true);
        Assert.Equal(2, lab.Environment.Connects.Count);
        var beforeMerge = merged["producerAttestationBeforeMerge"]!.AsArray().Single()!;
        Assert.Equal("server", beforeMerge["by"]!.ToString());
        Assert.Contains("merge_from_oml", lab.Bridge.Calls);
    });

    [Fact]
    public void APublicationSsamRecordedEndsTheReuseAndTheNewVersionIsCaptured() => WithAuthorityFolder(() =>
    {
        var lab = NewLab(); var job = lab.Job(Element);
        lab.Deliver(job);
        Thread.Sleep(20);
        var publication = lab.Ledger.Published("lab.example", "ZZHighCodePrimitives", null, "o11_publish", DateTime.UtcNow);   // the facade's record
        var envelope = ProducerIdentity.ReadEnvelope(lab.Cache.EntriesOf("lab.example", "ZZHighCodePrimitives").Single().Path)!;
        Assert.Null(lab.Ledger.Trust(envelope, DateTime.UtcNow, out var reason));
        Assert.Equal("publication-in-progress", reason);
        Thread.Sleep(20);
        lab.Ledger.PublicationEnded("lab.example", "ZZHighCodePrimitives", publication, DateTime.UtcNow);
        Assert.Null(lab.Ledger.Trust(envelope, DateTime.UtcNow, out reason));
        Assert.Equal("published-since", reason);

        // Same version after the publication (nothing changed): the server is asked once, the capture is reused.
        var same = lab.Deliver(lab.Job(Element));
        Assert.Equal("server", same["capturedProducers"]!["Primitive"]!["observed"]!["by"]!.ToString());
        Assert.True(same["capturedProducers"]!["Primitive"]!["reusedFromCache"]!.GetValue<bool>());
        Assert.Equal(1, lab.Signatures);

        // A new version published by SSAM: the cached capture no longer attests, the producer is captured again.
        Thread.Sleep(20);
        lab.Ledger.Published("lab.example", "ZZHighCodePrimitives", null, "o11_publish", DateTime.UtcNow);
        lab.Environment.Version = 8;
        var republished = lab.Deliver(lab.Job(Element));
        Assert.Equal(2, lab.Signatures);
        Assert.Null(republished["capturedProducers"]!["Primitive"]!["reusedFromCache"]);
        Assert.Equal(8, republished["capturedProducers"]!["Primitive"]!["versionId"]!.GetValue<int>());
        Assert.All(lab.Cache.EntriesOf("lab.example", "ZZHighCodePrimitives"), e => Assert.Equal(8, e.Receipt["versionIdBefore"]!.GetValue<int>()));
    });

    [Fact]
    public void AVersionChangedOutsideSsamIsCaughtRightBeforeTheMergeAndCapturedAgain() => WithAuthorityFolder(() =>
    {
        var lab = NewLab(); var job = lab.Job(Element);
        lab.Deliver(job);
        lab.Environment.Version = 8;   // published by someone else: the ledger does not know

        // A round refused before the merge writes nothing: it may use the version the ledger saw.
        var refused = lab.Deliver(lab.Job(Element));
        Assert.Equal("ledger", refused["capturedProducers"]!["Primitive"]!["observed"]!["by"]!.ToString());
        Assert.Equal(1, lab.Signatures);

        // The round that would merge observes the server first: PRODUCER_CHANGED, nothing merged, the capture is dropped.
        var changed = lab.Deliver(lab.Job(Element), accept: true);
        Assert.Equal(Delivery.ProducerChangedCode, changed["code"]!.ToString());
        Assert.Contains("VersionIdChanged", changed["error"]!.ToString());
        Assert.Equal("not-sent", changed["writeState"]!.ToString());
        Assert.DoesNotContain("merge_from_oml", lab.Bridge.Calls);
        Assert.Empty(lab.Cache.EntriesOf("lab.example", "ZZHighCodePrimitives"));

        // The next delivery captures the new version.
        var next = lab.Deliver(lab.Job(Element));
        Assert.Equal(2, lab.Signatures);
        Assert.Equal(8, next["capturedProducers"]!["Primitive"]!["versionId"]!.GetValue<int>());
        Assert.Equal("capture", next["capturedProducers"]!["Primitive"]!["observed"]!["by"]!.ToString());
    });

    [Fact]
    public void NeverAcrossEnvironments() => WithAuthorityFolder(() =>
    {
        var lab = NewLab(); var job = lab.Job(Element);
        lab.Deliver(job);
        Assert.Equal(1, lab.Signatures);
        // The same workspace, the same producer, another environment: its own capture, never the lab.example one.
        var other = SignatureEnvironment.Primitive(); other.Host = "other.example";
        var otherLab = new Lab { Work = lab.Work, Environment = other, Bridge = new StudioBridge("other.example"),
            Authority = new StudioProducerAuthority(h => HeadlessSession.ConnectStudio(other, h, null, readOnly: true)) };
        var there = otherLab.Deliver(job);
        Assert.Equal(1, otherLab.Signatures);
        Assert.Null(there["capturedProducers"]!["Primitive"]!["reusedFromCache"]);
        Assert.Equal("other.example", there["capturedProducers"]!["Primitive"]!["environment"]!.ToString());
        Assert.Single(lab.Cache.EntriesOf("lab.example", "ZZHighCodePrimitives"));
        Assert.Single(lab.Cache.EntriesOf("other.example", "ZZHighCodePrimitives"));
        // An observation of one environment never vouches for the other.
        var lead = ProducerIdentity.ReadEnvelope(lab.Cache.EntriesOf("lab.example", "ZZHighCodePrimitives").Single().Path)!;
        Assert.NotNull(lab.Ledger.Trust(lead, DateTime.UtcNow, out _));
        Assert.Null(lab.Ledger.Trust(lead with { Environment = "third.example" }, DateTime.UtcNow, out var reason));
        Assert.Equal("not-observed", reason);
    });

    [Fact]
    public void AnElementTheCachedSignatureLacksIsCapturedAndTheWiderCaptureCoversTheNarrowerJob() => WithAuthorityFolder(() =>
    {
        var lab = NewLab(fixture: "text-primitives");   // serves CSharpTextCompareOrdinal and CSharpTextUtf16Length
        const string second = "IServerActionSignature:CSharpTextUtf16Length";

        lab.Deliver(lab.Job(Element));
        Assert.Equal(1, lab.Signatures);
        var wider = lab.Deliver(lab.Job(Element, second));   // needs an element the cached signature lacks
        Assert.Equal(2, lab.Signatures);
        Assert.Equal("capture", wider["capturedProducers"]!["Primitive"]!["observed"]!["by"]!.ToString());
        var entries = lab.Cache.EntriesOf("lab.example", "ZZHighCodePrimitives");
        Assert.Equal(2, Assert.Single(entries).Elements.Count);   // the narrower capture is covered and dropped

        var narrow = lab.Deliver(lab.Job(Element));
        Assert.Equal(2, lab.Signatures);
        Assert.Equal("ledger", narrow["capturedProducers"]!["Primitive"]!["observed"]!["by"]!.ToString());
        Assert.True(narrow["capturedProducers"]!["Primitive"]!["reusedFromCache"]!.GetValue<bool>());
    });

    [Fact]
    public void TheLedgerRule()
    {
        var dir = Path.Combine(Root, ".local", "producer-reuse-tests", Guid.NewGuid().ToString("N"), "ledger");
        var ledger = new ProducerLedger(dir, TimeSpan.FromMinutes(15));
        var now = DateTime.UtcNow;
        var v7 = new ProducerIdentity("Lab.Example", "Orders_CS", "k", "module-version", 7, "h");
        Assert.Null(ledger.Trust(v7, now, out var reason)); Assert.Equal("not-observed", reason);
        ledger.Observe(v7, "capture", now);
        Assert.NotNull(ledger.Trust(v7 with { Environment = "lab.example", Producer = "orders_cs" }, now.AddMinutes(1), out _));
        Assert.Null(ledger.Trust(v7 with { VersionId = 8 }, now, out reason)); Assert.Equal("another-version", reason);
        Assert.Null(ledger.Trust(v7, now.AddMinutes(16), out reason)); Assert.Equal("observation-too-old", reason);
        var started = ledger.Published("lab.example", "orders_cs", null, "o11_publish", now.AddSeconds(5));
        Assert.Null(ledger.Trust(v7, now.AddSeconds(6), out reason)); Assert.Equal("publication-in-progress", reason);
        ledger.PublicationEnded("lab.example", "Orders_CS", started, now.AddSeconds(8));
        Assert.Null(ledger.Trust(v7, now.AddSeconds(9), out reason)); Assert.Equal("published-since", reason);
        ledger.Observe(v7, "attest", now.AddSeconds(10));   // observed again after the end of the publication: it counts again
        Assert.NotNull(ledger.Trust(v7, now.AddSeconds(11), out _));
        // The record the facade writes (producer-signatures.mjs recordPublished: JSON.stringify, toISOString) counts the same.
        var facadeRecord = Path.Combine(dir, "published", ProducerLedger.Id(" LAB.example", "orders_CS ") + ".json");
        string Iso(double seconds) => now.AddSeconds(seconds).ToUniversalTime().ToString("yyyy'-'MM'-'dd'T'HH':'mm':'ss'.'fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
        File.WriteAllText(facadeRecord, "{\"schema\":\"ssam-producer-published/1\",\"environment\":\"lab.example\",\"module\":\"Orders_CS\",\"key\":null,\"publishedAtUtc\":\""
            + Iso(10.5) + "\",\"source\":\"o11_publish\",\"publicationId\":\"f1\",\"endedAtUtc\":\"" + Iso(10.8) + "\"}");
        Assert.Null(ledger.Trust(v7, now.AddSeconds(11), out reason)); Assert.Equal("published-since", reason);
        ledger.Observe(v7, "attest", now.AddSeconds(11));
        Assert.NotNull(ledger.Trust(v7, now.AddSeconds(12), out _));

        // The race of the finding: session A starts a publication at T0 and the server changes at T0+20s; session B observed
        // the producer at T0+5s, before the change. That observation never counts: not while A runs (its end unknown, for
        // MaxPublication), not after A's end; only an observation after the end does.
        var t0 = now.AddSeconds(20);
        var race = ledger.Published("lab.example", "Orders_CS", null, "o11_publish", t0, "race");
        ledger.Observe(v7, "attest", t0.AddSeconds(5));
        Assert.Null(ledger.Trust(v7, t0.AddMinutes(10), out reason)); Assert.Equal("publication-in-progress", reason);
        Assert.Null(new ProducerLedger(dir, TimeSpan.FromMinutes(30)).Trust(v7, t0.AddMinutes(28), out reason)); Assert.Equal("publication-in-progress", reason);
        ledger.PublicationEnded("lab.example", "Orders_CS", race, t0.AddSeconds(21));
        Assert.Null(ledger.Trust(v7, t0.AddMinutes(10), out reason)); Assert.Equal("published-since", reason);
        ledger.Observe(v7, "attest", t0.AddSeconds(30));
        Assert.NotNull(ledger.Trust(v7, t0.AddMinutes(10), out _));
        Assert.False(Directory.EnumerateFiles(Path.Combine(dir, "publishing")).Any(), "the end removes the marker");
        // A publication whose end is never recorded (a crash) counts as running for MaxPublication after its start.
        var crash = t0.AddMinutes(1);
        ledger.Published("lab.example", "Orders_CS", null, "o11_publish", crash, "crash");
        ledger.Observe(v7, "attest", crash.AddSeconds(30));
        Assert.Null(ledger.Trust(v7, crash.AddMinutes(1), out _));
        var fresh = new ProducerLedger(dir, ProducerLedger.MaxPublication + TimeSpan.FromHours(1));
        fresh.Observe(v7, "attest", crash + ProducerLedger.MaxPublication + TimeSpan.FromSeconds(1));
        Assert.NotNull(fresh.Trust(v7, crash + ProducerLedger.MaxPublication + TimeSpan.FromMinutes(1), out _));
        ledger.Forget("lab.example", "Orders_CS");
        Assert.Null(ledger.Trust(v7, now.AddSeconds(12), out reason)); Assert.Equal("not-observed", reason);
        // (System): the advertised hash is its published state.
        var system = new ProducerIdentity("lab.example", "(System)", null, "signature-hash", null, Guid.Empty.ToString().Replace('0', 'a'));
        ledger.Observe(system, "capture", now);
        Assert.NotNull(ledger.Trust(system, now, out _));
        Assert.Null(ledger.Trust(system with { AdvertisedSignatureHash = Guid.NewGuid().ToString() }, now, out reason)); Assert.Equal("another-version", reason);
        // The rule off: always the server.
        Assert.Null(new ProducerLedger(dir, TimeSpan.Zero).Trust(system, now, out reason)); Assert.Equal("rule-off", reason);
        // A publication of unknown modules (a solution publish: producer "*") covers every producer of its environment.
        ledger.Published("lab.example", "*", null, "o11_service_center_write solution-publish", now.AddSeconds(1), "sol");
        Assert.Null(ledger.Trust(system, now.AddSeconds(2), out reason)); Assert.Equal("publication-in-progress", reason);
        Assert.Null(ledger.Trust(v7 with { Environment = "other.example" }, now.AddSeconds(2), out reason)); Assert.Equal("not-observed", reason);
    }

    [Fact]
    public void AnO11JobCaptureAndADeliveryShareTheSameCacheAndLedger() => WithAuthorityFolder(() =>
    {
        // o11_job captureProducers: `anvil signature --out <lane .local>/jobs/captured/<stem>/<B>.avsig` (SignatureReuse).
        var lab = NewLab();
        var local = Path.GetFullPath(Path.Combine(lab.Work, ".."));
        var firstOut = Path.Combine(local, "jobs", "captured", "round1", "Primitive.avsig");
        Directory.CreateDirectory(Path.GetDirectoryName(firstOut)!);
        Assert.Null(SignatureReuse.Reuse(firstOut, "lab.example", "ZZHighCodePrimitives", [Element], DateTime.UtcNow));   // nothing cached yet
        JsonObject receipt;
        using (var session = HeadlessSession.ConnectStudio(lab.Environment, "lab.example", null, readOnly: true))
            receipt = ProducerSignatureCapture.Capture(session, new SignatureCaptureRequest("ZZHighCodePrimitives", [Element], firstOut));
        SignatureReuse.Remember(firstOut, "lab.example", "ZZHighCodePrimitives", [Element], receipt, DateTime.UtcNow);
        Assert.Equal(1, lab.Signatures);

        // The next job round: the same capture, no lease.
        var secondOut = Path.Combine(local, "jobs", "captured", "round2", "Primitive.avsig");
        var connects = lab.Environment.Connects.Count;
        var reused = SignatureReuse.Reuse(secondOut, "lab.example", "ZZHighCodePrimitives", [Element], DateTime.UtcNow)!;
        Assert.True(reused["reused"]!.GetValue<bool>());
        Assert.Equal("ledger", reused["observed"]!["by"]!.ToString());
        Assert.Equal(secondOut, reused["avsigPath"]!.ToString());
        Assert.Equal(NativeReferenceSignatureCaptureTests.Hash(File.ReadAllBytes(secondOut)), reused["avsigSha256"]!.ToString());
        Assert.Equal(connects, lab.Environment.Connects.Count);
        Assert.Null(SignatureReuse.Reuse(secondOut, "other.example", "ZZHighCodePrimitives", [Element], DateTime.UtcNow));   // never another environment

        // A delivery of the same workspace reuses the job's capture with no server call before the merge.
        var delivered = lab.Deliver(lab.Job(Element));
        Assert.Equal("ledger", delivered["capturedProducers"]!["Primitive"]!["observed"]!["by"]!.ToString());
        Assert.Equal(1, lab.Signatures);

        // A reused signature read nothing on the server now: the job's candidate is not valid for a merge as it is.
        Assert.False(reused["mergeReady"]!.GetValue<bool>());

        // After a publication SSAM recorded, the job captures again.
        Thread.Sleep(20);
        lab.Ledger.Published("lab.example", "ZZHighCodePrimitives", null, "o11_publish", DateTime.UtcNow);
        Assert.Null(SignatureReuse.Reuse(secondOut, "lab.example", "ZZHighCodePrimitives", [Element], DateTime.UtcNow));
    });

    [Fact]
    public void SeveralEnvelopesAreAttestedInOneLeaseWithOneReadOfEachCatalog()
    {
        var work = NativeReferenceSignatureCaptureTests.Work(); var environment = SignatureEnvironment.Primitive();
        var first = Path.Combine(work, "a.avsig"); var second = Path.Combine(work, "b.avsig");
        using (var session = HeadlessSession.ConnectStudio(environment, "lab.example", null, readOnly: true))
        {
            ProducerSignatureCapture.Capture(session, new SignatureCaptureRequest("ZZHighCodePrimitives", [Element], first));
            ProducerSignatureCapture.Capture(session, new SignatureCaptureRequest("ZZHighCodePrimitives", [Element], second));
        }
        environment.Operations.Clear(); environment.Connects.Clear();
        var authority = new StudioProducerAuthority(h => HeadlessSession.ConnectStudio(environment, h, null, readOnly: true));
        var outcomes = authority.AttestAll([first, second], "lab.example");
        Assert.All(outcomes, o => Assert.True(o.Observed!["attested"]!.GetValue<bool>()));
        Assert.Single(environment.Connects);
        Assert.Equal(new[] { "referenceable", "extensions" }, environment.Operations);
        environment.Version = 8;
        var changed = authority.AttestAll([first, second], "lab.example");
        Assert.All(changed, o => Assert.Contains("VersionIdChanged", o.Error!.Message));
    }

    /// <summary>The Studio side of a delivery, merge included (merged with no differences).</summary>
    private sealed class StudioBridge(string environment) : IBridgeClient
    {
        private readonly string key = "f5-" + Guid.NewGuid().ToString("N")[..12];
        public List<string> Calls { get; } = [];
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Calls.Add(method);
            switch (method)
            {
                case "open_module": return new() { ["opened"] = true };
                case "get_active_module": return new() { ["name"] = "Probe", ["key"] = key, ["environment"] = environment };
                case "snapshot_module":
                    if (parameters?["path"] is { } path) File.WriteAllText(path.ToString(), "snapshot");
                    return new() { ["key"] = key, ["snapshot_id"] = "snapshot-1", ["baseline"] = new JsonArray() };
                case "bridge_manifest": return new() { ["capabilities"] = new JsonArray() };
                case "merge_from_oml": return new() { ["merged"] = true, ["reason"] = "no differences" };
                case "get_errors": return new() { ["rawMessages"] = new JsonArray(), ["new"] = new JsonArray(), ["newErrors"] = 0 };
                default: throw new Exception("Unexpected bridge call: " + method);
            }
        }
    }
}
