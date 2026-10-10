using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>`anvil signature` and deliver --capture-producer against a stub of the Studio's environment session: the
/// recorded server signature is the lab capture of ZZHighCodePrimitives (tests/contracts/native-reference). No server,
/// no Studio: the stub asserts that every lease is read-only and that no write operation is ever requested.</summary>
public sealed class NativeReferenceSignatureCaptureTests
{
    public NativeReferenceSignatureCaptureTests() => StudioAssemblies.Bind();

    [Fact]
    public void ListingReadsAndValidatesTheLiveSignatureWithoutWritingAFrozenFile()
    {
        var stub=SignatureEnvironment.Primitive();
        using var session=HeadlessSession.ConnectStudio(stub,"lab.example",null,readOnly:true);
        var result=ProducerSignatureCapture.Capture(session,new SignatureCaptureRequest("ZZHighCodePrimitives",[],"",ListOnly:true));
        Assert.True(result["readOnly"]!.GetValue<bool>());
        Assert.Contains(result["elements"]!.AsArray(),e=>e!["name"]!.ToString()=="CSharpTextCompareOrdinal"
            && e["supported"]!.GetValue<bool>() && e["selector"]!.ToString()=="IServerActionSignature:CSharpTextCompareOrdinal");
        Assert.DoesNotContain("extension-download",stub.Operations);
    }

    [Fact]
    public void ListingPagesCannotMixProducerRevisions()
    {
        var stub=SignatureEnvironment.Primitive();
        using var session=HeadlessSession.ConnectStudio(stub,"lab.example",null,readOnly:true);
        var first=ProducerSignatureCapture.Capture(session,new SignatureCaptureRequest("ZZHighCodePrimitives",[],"",ListOnly:true,Limit:1));
        Assert.Single(first["elements"]!.AsArray());
        Assert.True(first["total"]!.GetValue<int>()>1);
        Assert.Throws<ArgumentException>(()=>ProducerSignatureCapture.Capture(session,
            new SignatureCaptureRequest("ZZHighCodePrimitives",[],"",ListOnly:true,Offset:1)));
        Assert.Throws<SignatureCaptureException>(()=>ProducerSignatureCapture.Capture(session,
            new SignatureCaptureRequest("ZZHighCodePrimitives",[],"",ListOnly:true,Offset:1,ExpectedSignatureHash:Guid.NewGuid().ToString())));
        var second=ProducerSignatureCapture.Capture(session,new SignatureCaptureRequest("ZZHighCodePrimitives",[],"",ListOnly:true,
            Offset:1,Limit:1,ExpectedSignatureHash:first["signatureHash"]!.ToString()));
        Assert.NotEqual(first["elements"]![0]!["originalKey"]!.ToString(),second["elements"]![0]!["originalKey"]!.ToString());
    }

    [Fact]
    public void CaptureResolvesTheServerSignatureAndPinsTheXifThroughAReadOnlyLease()
    {
        var work = Work(); var stub = SignatureEnvironment.Primitive();
        var outPath = Path.Combine(work, "task", "Primitive.avsig");
        using var session = HeadlessSession.ConnectStudio(stub, "lab.example", null, readOnly: true);
        var result = ProducerSignatureCapture.Capture(session, new SignatureCaptureRequest("ZZHighCodePrimitives",
            ["IServerActionSignature:CSharpTextCompareOrdinal"], outPath, PinXif: true));

        Assert.Equal("ZZHighCodePrimitives", result["producer"]!.ToString());
        Assert.Equal("Extension", result["kind"]!.ToString());
        Assert.Equal("lab.example", result["environment"]!.ToString());
        Assert.Equal(7, result["versionIdBefore"]!.GetValue<int>());
        Assert.Equal(7, result["versionIdAfter"]!.GetValue<int>());
        Assert.Equal(stub.Recorded.SignatureHash.ToString(), result["signatureHash"]!.ToString());
        var element = Assert.Single(result["elements"]!.AsArray())!;
        Assert.Equal("IServerActionSignature", element["type"]!.ToString());
        Assert.Equal("i5FAvgzI2UOEJ7U4bvKbRw", element["originalKey"]!.ToString());   // read from the payload, not supplied
        Assert.Empty(result["closure"]!.AsArray());
        Assert.Equal(Hash(File.ReadAllBytes(outPath)), result["avsigSha256"]!.ToString());
        Assert.Equal(Hash(stub.Xif), result["xifSha256"]!.ToString());
        Assert.Equal(Path.GetDirectoryName(outPath), Path.GetDirectoryName(result["xifPath"]!.ToString()));

        var captured = NativeReferenceSnapshot.Read(outPath);
        Assert.Equal(2, captured.FormatVersion);
        Assert.Equal(NativeReferenceAttestation.ServerSignature, captured.Attestation!.Source);
        Assert.Equal(7, captured.Attestation.VersionId);
        Assert.Equal("extension-version", captured.Attestation.Guard);
        Assert.Equal(stub.Recorded.SignatureBinary, captured.SignatureBinary);
        captured.RequireDeliverable("lab.example");
        Assert.All(stub.Connects, c => Assert.True(c["readOnly"]!.GetValue<bool>()));
        Assert.Equal(new[] { "referenceable", "referenceable", "extensions", "signature", "referenceable", "extensions",
            "extension-download", "referenceable", "extensions" }, stub.Operations);
    }

    [Theory]
    [InlineData("NotReadOnly")]
    [InlineData("ProducerNotFound")]
    [InlineData("NotActive")]
    [InlineData("VersionIdChanged")]
    [InlineData("SignatureUnavailable")]
    [InlineData("IdentityMismatch")]
    public void CaptureRefusalsAreTypedAndWriteNothing(string code)
    {
        var work = Work(); var stub = SignatureEnvironment.Primitive();
        var elements = new List<string> { "IServerActionSignature:CSharpTextCompareOrdinal" };
        var producer = "ZZHighCodePrimitives";
        switch (code)
        {
            case "ProducerNotFound": producer = "HMISPdfText"; break;
            case "NotActive": stub.Active = false; break;
            case "VersionIdChanged": stub.VersionAfterReads = 1; break;
            case "SignatureUnavailable": stub.Signature = null; break;
            case "IdentityMismatch": stub.Signature!["Name"] = "AnotherProducer"; break;
        }
        var outPath = Path.Combine(work, "refused.avsig");
        using var session = HeadlessSession.ConnectStudio(stub, "lab.example", null, readOnly: code != "NotReadOnly");
        var error = Assert.Throws<SignatureCaptureException>(() =>
            ProducerSignatureCapture.Capture(session, new SignatureCaptureRequest(producer, elements, outPath)));
        Assert.Equal(code, error.Code);
        Assert.False(File.Exists(outPath));
        if (code == "NotReadOnly") Assert.Empty(stub.Operations);   // refused before any server call
    }

    [Fact]
    public void SystemCaptureResolvesLoginAndGuardsOnTheAdvertisedHash()
    {
        var work = Work();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeReferenceSignatureCaptureTests).Assembly.Location)!)!;
        // The environment serves a (System) payload recorded from the committed consumers (reactive-ui has Login).
        var recorded = SignatureFixtures.FromConsumers(new ModelHost(Path.Combine(work, "model")),
            [Path.Combine(root, "tests/fixtures/blank-service.oml"), Path.Combine(root, "tests/fixtures/reactive-ui.oml")],
            "uXCIR2Atc0+es3zYuZSnNw", ["IServerActionSignature:Login"], isSystem: true).Snapshot;
        var environment = SignatureEnvironment.Serving(recorded, "eSpace", listedModule: false);
        var avsig = Path.Combine(work, "System.avsig");
        using (var session = HeadlessSession.ConnectStudio(environment, "lab.example", null, readOnly: true))
        {
            var result = ProducerSignatureCapture.Capture(session, new SignatureCaptureRequest("(System)", ["IServerActionSignature:Login"], avsig));
            Assert.True(result["system"]!.GetValue<bool>());   // recognized by key: the live catalog reports Is_System false
            Assert.Equal("signature-hash", result["guard"]!.ToString());
            Assert.Null(result["versionIdBefore"]);
            Assert.Equal("DrBxgnTw8ECd0ZLsqFHPbQ", result["elements"]![0]!["originalKey"]!.ToString());
            Assert.Contains(result["closure"]!.AsArray(), c => c!["type"]!.ToString() == "IEntitySignature" && c["name"]!.ToString() == "User");
        }
        var captured = NativeReferenceSnapshot.Read(avsig);
        Assert.True(captured.Attestation!.IsSystem);
        Assert.Equal(recorded.SignatureHash.ToString(), captured.Attestation.AdvertisedSignatureHash);
        using (var session = HeadlessSession.ConnectStudio(environment, "lab.example", null, readOnly: true))
            Assert.True(ProducerSignatureCapture.Attest(session, avsig, "lab.example")["attested"]!.GetValue<bool>());
        environment.Advertised = Guid.NewGuid().ToString();   // platform upgraded after the capture
        using (var session = HeadlessSession.ConnectStudio(environment, "lab.example", null, readOnly: true))
            Assert.Equal("SignatureHashChanged", Assert.Throws<SignatureCaptureException>(() => ProducerSignatureCapture.Attest(session, avsig, "lab.example")).Code);
        Assert.All(environment.Connects, c => Assert.True(c["readOnly"]!.GetValue<bool>()));
    }

    [Fact]
    public void DeliveryCapturesOnceRecordsTheHashAndReattestsBeforeApplying()
    {
        var work = Work(); var environment = SignatureEnvironment.Primitive(); var bridge = new StudioStub();
        var job = WriteJob(work);
        var authority = new StudioProducerAuthority(host => HeadlessSession.ConnectStudio(environment, host, null, readOnly: true));
        var request = new DeliveryRequest("Probe", job, work, [], CaptureProducers: ["Primitive=ZZHighCodePrimitives"]);
        IReadOnlyDictionary<string, string>? seen = null;
        JsonObject Apply(string b, string j, string o, IReadOnlyDictionary<string, string> producers)
        { seen = producers; return new JsonObject { ["isValid"] = false, ["accepted"] = false }; }

        var first = Delivery.Run(bridge, request, (_, _, _) => throw new Exception("producer-aware apply expected"),
            producerAuthority: authority, applyWithProducers: Apply);
        Assert.Contains("job rejected", first["error"]!.ToString());
        var captured = first["capturedProducers"]!["Primitive"]!;
        var path = captured["path"]!.ToString();
        Assert.Equal(path, seen!["Primitive"]);
        Assert.StartsWith(first["work"]!.ToString(), path);
        Assert.Equal(Hash(File.ReadAllBytes(path)), captured["sha256"]!.ToString());
        Assert.Contains(first["sources"]!.AsArray(), s => s!["path"]!.ToString() == path && s["sha256"]!.ToString() == captured["sha256"]!.ToString());
        Assert.Equal(7, captured["versionId"]!.GetValue<int>());
        Assert.True(first["producerAttestation"]!.AsArray().Single()!["attested"]!.GetValue<bool>());
        Assert.Equal(1, environment.Operations.Count(o => o == "signature"));

        // Resume: same task, same captured file (hash-checked as a source), no second capture, identity re-observed.
        var resumed = Delivery.Run(bridge, DeliveryTask.ResumeRequest(work, first["taskId"]!.ToString()),
            (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: authority, applyWithProducers: Apply);
        Assert.Contains("job rejected", resumed["error"]!.ToString());
        Assert.Equal(1, environment.Operations.Count(o => o == "signature"));
        Assert.Equal(path, seen!["Primitive"]);
        Assert.All(environment.Connects, c => Assert.True(c["readOnly"]!.GetValue<bool>()));
    }

    [Fact]
    public void DeliveryResumesAPartialCaptureAndCapturesOnlyTheMissingProducers()
    {
        var work = Work(); var bridge = new StudioStub();
        var primitive = SignatureEnvironment.Primitive(); var system = SystemEnvironment(work);
        var job = WriteJob(work, ("Primitive", "IServerActionSignature:CSharpTextCompareOrdinal"), ("System", "IServerActionSignature:Login"));
        var authority = new RoutingAuthority(primitive, system);
        var request = new DeliveryRequest("Probe", job, work, [], CaptureProducers: ["Primitive=ZZHighCodePrimitives", "System=(System)"]);
        IReadOnlyDictionary<string, string>? seen = null;
        JsonObject Apply(string b, string j, string o, IReadOnlyDictionary<string, string> producers)
        { seen = producers; return new JsonObject { ["isValid"] = false, ["accepted"] = false }; }
        JsonObject Run(DeliveryRequest r) => Delivery.Run(bridge, r, (_, _, _) => throw new Exception("producer-aware apply expected"),
            producerAuthority: authority, applyWithProducers: Apply);
        static string[] Captures(JsonObject state) => state["sources"]!.AsArray().Select(s => s!["path"]!.ToString())
            .Where(p => p.EndsWith(".avsig", StringComparison.OrdinalIgnoreCase)).ToArray();

        // First run: Primitive is captured, the (System) capture fails; nothing is applied and no snapshot is taken.
        var served = system.Signature; system.Signature = null;
        var first = Run(request);
        Assert.Contains("SignatureUnavailable", first["error"]!.ToString());
        Assert.Null(seen);
        Assert.DoesNotContain("snapshot_module", bridge.Calls);
        var primitiveCapture = first["capturedProducers"]!["Primitive"]!;
        var primitivePath = primitiveCapture["path"]!.ToString(); var primitiveSha = primitiveCapture["sha256"]!.ToString();
        Assert.Null(first["capturedProducers"]!["System"]);
        Assert.Equal(new[] { primitivePath }, Captures(first));
        Assert.Equal(primitiveSha, Hash(File.ReadAllBytes(primitivePath)));

        // Resume: only the missing (System) capture runs; the Primitive file and its source entry are reused unchanged,
        // and both recorded captures are re-attested before the apply.
        system.Signature = served;
        var resumed = Run(DeliveryTask.ResumeRequest(work, first["taskId"]!.ToString()));
        Assert.Contains("job rejected", resumed["error"]!.ToString());
        Assert.Equal(1, primitive.Operations.Count(o => o == "signature"));
        Assert.Equal(2, system.Operations.Count(o => o == "signature"));
        var systemPath = resumed["capturedProducers"]!["System"]!["path"]!.ToString();
        Assert.Equal(new[] { primitivePath, systemPath }, Captures(resumed));
        Assert.Equal(primitiveSha, Hash(File.ReadAllBytes(primitivePath)));
        Assert.Equal(primitiveSha, resumed["capturedProducers"]!["Primitive"]!["sha256"]!.ToString());
        Assert.Equal(primitivePath, seen!["Primitive"]); Assert.Equal(systemPath, seen["System"]);
        var attested = resumed["producerAttestation"]!.AsArray();
        Assert.Equal(new[] { primitivePath, systemPath }, attested.Select(a => a!["path"]!.ToString()));
        Assert.All(attested, a => Assert.True(a!["attested"]!.GetValue<bool>()));

        // A further resume captures nothing and passes the frozen-source check.
        var again = Run(DeliveryTask.ResumeRequest(work, first["taskId"]!.ToString()));
        Assert.Contains("job rejected", again["error"]!.ToString());
        Assert.Equal(1, primitive.Operations.Count(o => o == "signature"));
        Assert.Equal(2, system.Operations.Count(o => o == "signature"));
        Assert.All(primitive.Connects.Concat(system.Connects), c => Assert.True(c["readOnly"]!.GetValue<bool>()));
    }

    [Fact]
    public void RefusedXifPinWritesNeitherTheEnvelopeNorTheXif()
    {
        var work = Work(); var stub = SignatureEnvironment.Primitive();
        stub.VersionAfterReads = 2;   // republished while the .xif is read (third extension read)
        var outPath = Path.Combine(work, "pin", "Primitive.avsig");
        using var session = HeadlessSession.ConnectStudio(stub, "lab.example", null, readOnly: true);
        var error = Assert.Throws<SignatureCaptureException>(() => ProducerSignatureCapture.Capture(session,
            new SignatureCaptureRequest("ZZHighCodePrimitives", ["IServerActionSignature:CSharpTextCompareOrdinal"], outPath, PinXif: true)));
        Assert.Equal("VersionIdChanged", error.Code);
        Assert.Contains("extension-download", stub.Operations);
        Assert.False(File.Exists(outPath));
        Assert.True(!Directory.Exists(Path.GetDirectoryName(outPath)) || Directory.GetFiles(Path.GetDirectoryName(outPath)!).Length == 0);
    }

    [Fact]
    public void DeliveryRefusesAProducerRepublishedAfterItsCaptureBeforeAnySnapshot()
    {
        var work = Work(); var environment = SignatureEnvironment.Primitive(); var bridge = new StudioStub();
        var avsig = Path.Combine(work, "Primitive.avsig");
        using (var session = HeadlessSession.ConnectStudio(environment, "lab.example", null, readOnly: true))
            ProducerSignatureCapture.Capture(session, new SignatureCaptureRequest("ZZHighCodePrimitives",
                ["IServerActionSignature:CSharpTextCompareOrdinal"], avsig));
        environment.Version = 8;   // republished between capture and delivery
        var applied = false;
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", WriteJob(work), work, [], new Dictionary<string, string> { { "Primitive", avsig } }),
            (_, _, _) => { applied = true; return new JsonObject(); },
            producerAuthority: new StudioProducerAuthority(host => HeadlessSession.ConnectStudio(environment, host, null, readOnly: true)));
        Assert.False(applied);
        Assert.Contains("VersionIdChanged", result["error"]!.ToString());
        Assert.DoesNotContain("snapshot_module", bridge.Calls);
    }

    [Theory]
    [InlineData("another-environment", "another environment")]
    [InlineData("offline-fixture", "offline evidence")]
    [InlineData("no-authority", "re-attestation")]
    public void DeliveryRefusesUnattestableProducerSignatures(string scenario, string expected)
    {
        var work = Work(); var environment = SignatureEnvironment.Primitive(); var bridge = new StudioStub();
        var avsig = Path.Combine(work, "Primitive.avsig");
        using (var session = HeadlessSession.ConnectStudio(environment, "lab.example", null, readOnly: true))
            ProducerSignatureCapture.Capture(session, new SignatureCaptureRequest("ZZHighCodePrimitives",
                ["IServerActionSignature:CSharpTextCompareOrdinal"], avsig));
        var snapshot = NativeReferenceSnapshot.Read(avsig);
        if (scenario == "another-environment") (snapshot with { Environment = "another.example" }).Write(avsig);
        if (scenario == "offline-fixture")
            (snapshot with { Attestation = new NativeReferenceAttestation { Source = NativeReferenceAttestation.ConsumerReconstruction } }).Write(avsig);
        var applied = false;
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", WriteJob(work), work, [], new Dictionary<string, string> { { "Primitive", avsig } }),
            (_, _, _) => { applied = true; return new JsonObject(); },
            producerAuthority: scenario == "no-authority" ? null
                : new StudioProducerAuthority(host => HeadlessSession.ConnectStudio(environment, host, null, readOnly: true)));
        Assert.False(applied);
        Assert.Contains(expected, result["error"]!.ToString());
        Assert.DoesNotContain("snapshot_module", bridge.Calls);
    }

    private static string WriteJob(string work) => WriteJob(work, ("Primitive", "IServerActionSignature:CSharpTextCompareOrdinal"));

    private static string WriteJob(string work, params (string Producer, string Element)[] references)
    {
        var job = Path.Combine(work, "capture-job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(references.Select(r => (JsonNode)new JsonObject {
            ["op"] = "reference", ["producer"] = r.Producer, ["elements"] = new JsonArray(r.Element) }).ToArray()) }.ToJsonString());
        return job;
    }

    /// <summary>An environment serving a (System) payload recorded from the committed consumers (reactive-ui has Login).</summary>
    private static SignatureEnvironment SystemEnvironment(string work)
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeReferenceSignatureCaptureTests).Assembly.Location)!)!;
        var recorded = SignatureFixtures.FromConsumers(new ModelHost(Path.Combine(work, "model")),
            [Path.Combine(root, "tests/fixtures/blank-service.oml"), Path.Combine(root, "tests/fixtures/reactive-ui.oml")],
            "uXCIR2Atc0+es3zYuZSnNw", ["IServerActionSignature:Login"], isSystem: true).Snapshot;
        return SignatureEnvironment.Serving(recorded, "eSpace", listedModule: false);
    }

    /// <summary>One read-only Studio authority per stubbed producer environment, chosen by producer name.</summary>
    private sealed class RoutingAuthority(params SignatureEnvironment[] environments) : IProducerSignatureAuthority
    {
        private StudioProducerAuthority For(string producer)
        {
            var environment = environments.Single(e => e.Recorded.Name == producer);
            return new StudioProducerAuthority(host => HeadlessSession.ConnectStudio(environment, host, null, readOnly: true));
        }
        public JsonObject Capture(string producer, IReadOnlyList<string> elements, string destination, string environment)
            => For(producer).Capture(producer, elements, destination, environment);
        public JsonObject Attest(string avsigPath, string environment)
            => For(NativeReferenceSnapshot.Read(avsigPath).Name).Attest(avsigPath, environment);
    }

    internal static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    internal static string Work()
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeReferenceSignatureCaptureTests).Assembly.Location)!)!;
        var path = Path.Combine(root, ".local/native-reference-capture-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path); return path;
    }

    /// <summary>The Studio side of a delivery, only as far as the stages before a merge.</summary>
    private sealed class StudioStub : IBridgeClient
    {
        public List<string> Calls { get; } = [];
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Calls.Add(method);
            return method switch {
                "open_module" => new() { ["opened"] = true },
                "get_active_module" => new() { ["name"] = "Probe", ["key"] = "module-key", ["environment"] = "lab.example" },
                "snapshot_module" => new() { ["key"] = "module-key", ["snapshot_id"] = "snapshot-1" },
                _ => throw new Exception("Unexpected bridge call before merge: " + method)
            };
        }
    }
}

/// <summary>Stub of the Studio's environment_session for one producer: the referenceable catalog, the extension
/// catalog (VersionId/IsActive), the recorded server signature and the .xif bytes. Refuses write operations.</summary>
internal sealed class SignatureEnvironment : IBridgeClient
{
    public required NativeReferenceSnapshot Recorded { get; init; }
    public string Kind { get; init; } = "Extension";
    /// <summary>Hash the referenceable catalog advertises; a system producer's only published-state observation.</summary>
    public string? Advertised { get; set; }
    /// <summary>Listed in the module catalog (eSpace); (System) is not.</summary>
    public bool ListedModule { get; init; } = true;
    public JsonObject? Signature { get; set; }
    public byte[] Xif { get; } = [0x50, 0x4B, 3, 4, 42];
    public int Version { get; set; } = 7;
    public bool Active { get; set; } = true;
    /// <summary>After this many extension reads the version moves on (a republish during the capture).</summary>
    public int? VersionAfterReads { get; set; }
    public List<string> Operations { get; } = [];
    public List<JsonObject> Connects { get; } = [];
    private int extensionReads;

    public static SignatureEnvironment Primitive()
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(SignatureEnvironment).Assembly.Location)!)!;
        return Serving(NativeReferenceSnapshot.Read(Path.Combine(root, "tests/contracts/native-reference/ordinal-primitive.avsig")), "Extension");
    }

    /// <summary>Serves a recorded payload as the environment's current signature of that producer.</summary>
    public static SignatureEnvironment Serving(NativeReferenceSnapshot recorded, string kind, bool listedModule = true)
        => new() { Recorded = recorded, Kind = kind, ListedModule = listedModule, Advertised = recorded.SignatureHash.ToString(),
            Signature = new JsonObject {
                ["Key"] = Keys.ToStudio(recorded.ModuleKey), ["Name"] = recorded.Name, ["Kind"] = kind, ["Description"] = null,
                ["SignatureHash"] = recorded.SignatureHash.ToString(), ["SignatureBinary"] = Convert.ToBase64String(recorded.SignatureBinary),
                ["Is_Broken"] = 0, ["Is_Outdated"] = 0, ["Is_System"] = 0, ["JQueryVersion"] = null, ["Icon"] = null, ["RuntimeKind"] = 0,
                ["ExtensibilityConfiguration"] = null, ["AppKey"] = null } };

    public JsonObject Call(string method, JsonObject? parameters = null)
    {
        Assert.Equal("environment_session", method);
        var request = parameters!.DeepClone().AsObject();
        var operation = request["operation"]!.ToString();
        if (operation == "connect")
        {
            Connects.Add(request);
            return new JsonObject { ["lease"] = "lease-" + Connects.Count, ["host"] = "lab.example", ["username"] = "test-user",
                ["ideVersion"] = "11.55.69", ["serverVersion"] = "11.41.0.46924" };
        }
        if (operation == "close") return new JsonObject { ["closed"] = true };
        Assert.DoesNotContain(operation, ConnectedEnvironment.WriteOperations);
        Operations.Add(operation);
        ModuleSummary[] Listed(string kind) => Kind != kind || (kind == "eSpace" && !ListedModule) ? []
            : [new ModuleSummary(Recorded.Name, Keys.ToStudio(Recorded.ModuleKey), kind, null,
                VersionAfterReads is { } after && ++extensionReads > after ? Version + 1 : Version, 1, null, null, DateTime.UnixEpoch, null, Active, true, null)];
        JsonNode? value = operation switch {
            // Is_System reads false for every row of the live catalog, (System) included; the stub keeps that quirk.
            "referenceable" => JsonSerializer.SerializeToNode(new[] { new ReferenceableSummary(Keys.ToStudio(Recorded.ModuleKey), Recorded.Name,
                Kind, Advertised ?? "", false, null) }, ConnectedEnvironment.Wire),
            "extensions" => JsonSerializer.SerializeToNode(Listed("Extension"), ConnectedEnvironment.Wire),
            "modules" => JsonSerializer.SerializeToNode(Listed("eSpace"), ConnectedEnvironment.Wire),
            "signature" => Signature?.DeepClone(),
            "extension-download" => JsonSerializer.SerializeToNode(Xif, ConnectedEnvironment.Wire),
            _ => throw new Exception("Unexpected environment operation: " + operation)
        };
        return new JsonObject { ["value"] = value };
    }
}
