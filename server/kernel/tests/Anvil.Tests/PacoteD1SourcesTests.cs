using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>Lane D1, C27: bases and producers resolved by name. JobSources accepts the OMLs the SSAM itself captured
/// (.local/**/snapshots|downloads|work, platforms/odc/snapshots) and still refuses any other loose file; a producer capture
/// is reused while the server keeps the version it was captured from, and captured again once it was republished.</summary>
public sealed class PacoteD1SourcesTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(PacoteD1SourcesTests).Assembly.Location)!)!;
    private static readonly string JobDir = Path.Combine(Root, "tests", "jobs");

    // The producer captures read the recorded envelopes through the Studio model assemblies.
    public PacoteD1SourcesTests() => StudioAssemblies.Bind();

    [Theory]
    [InlineData(".local/snapshots/GameStore_CS-20261005.oml")]
    [InlineData(".local/lane-ss5/snapshots/GameStore_CS.oml")]
    [InlineData(".local/environment/downloads/2026/OfficePet.oml")]
    [InlineData(".local/work/deliver/0123456789abcdef0123456789abcdef/attempt-0/base.oml")]
    public void CapturesOfTheSsamAreSourcesByName(string relative)
    {
        var full = Path.GetFullPath(Path.Combine(Root, relative));
        Assert.True(JobSources.IsCapturePath(full, Root));
        Assert.Equal(full, JobSources.FixturePath(full, JobDir, "base"));
        Assert.Equal(full, JobSources.FixturePath(relative, JobDir, "producer"));
    }

    [Fact]
    public void TheOdcSnapshotFolderIsASource()
    {
        var odc = Path.GetFullPath(Path.Combine(Root, "..", "platforms", "odc", "snapshots", "QuizLive.oml"));
        Assert.True(JobSources.IsCapturePath(odc, Root));
        Assert.Equal(odc, JobSources.FixturePath(odc, JobDir, "base"));
    }

    [Theory]
    [InlineData(".local/jobs/producer-public.oml")]
    [InlineData(".local/snapshot.oml")]
    [InlineData(".local/snapshots/notes.txt")]
    [InlineData("tests/fixtures-other/old.oml")]
    public void AnyOtherFileStaysRefused(string relative)
    {
        var full = Path.GetFullPath(Path.Combine(Root, relative));
        Assert.False(JobSources.IsCapturePath(full, Root));
        var error = Assert.Throws<ArgumentException>(() => JobSources.FixturePath(relative, JobDir, "producer"));
        Assert.Contains("outside tests/fixtures", error.Message);
        Assert.Contains("o11_studio snapshot", error.Message);
        var outside = Path.Combine(Path.GetTempPath(), "snapshots", "loose.oml");
        Assert.Throws<ArgumentException>(() => JobSources.FixturePath(outside, JobDir, "base"));
    }

    [Fact]
    public void AnUnboundProducerNamesTheMcpWayToBindIt()
    {
        var error = Assert.Throws<ArgumentException>(() => JobSources.Resolve("Headless_CS", JobDir, "producer")).Message;
        Assert.Contains("producer Headless_CS not bound", error);
        Assert.Contains("captureProducers", error);
    }

    [Fact]
    public void AProducerCaptureIsReusedWhileTheServerKeepsItsVersion()
    {
        // The module reservations of these deliveries stay in a private authority folder.
        var before = Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR");
        Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Path.Combine(Path.GetTempPath(), "pacote-d1-authority-" + Guid.NewGuid().ToString("N")));
        try { ReuseScenario(); }
        finally { Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Pa2F1TestAuthority.Restore(before)); }
    }

    private static void ReuseScenario()
    {
        var work = Path.Combine(Root, ".local", "pacote-d1-sources-tests", Guid.NewGuid().ToString("N"), ".local", "work");
        Directory.CreateDirectory(work);
        var cache = ProducerCache.ForWork(work)!;
        Assert.Equal(Path.GetFullPath(Path.Combine(work, "..", "producer-cache")), cache.DirectoryPath);
        Assert.Null(ProducerCache.ForWork(Path.Combine(Root, ".local", "native-reference-capture-tests", "x")));   // not a lane work folder

        var environment = SignatureEnvironment.Primitive();
        var authority = new StudioProducerAuthority(host => HeadlessSession.ConnectStudio(environment, host, null, readOnly: true));
        var job = Path.Combine(work, "..", "capture-job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "reference", ["producer"] = "Primitive",
            ["elements"] = new JsonArray("IServerActionSignature:CSharpTextCompareOrdinal") }) }.ToJsonString());
        JsonObject Deliver() => Delivery.Run(new Stub(), new DeliveryRequest("Probe", job, work, [], CaptureProducers: ["Primitive=ZZHighCodePrimitives"]),
            (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: authority,
            applyWithProducers: (_, _, _, _) => new JsonObject { ["isValid"] = false, ["accepted"] = false });

        var first = Deliver();
        Assert.Contains("job rejected", first["error"]!.ToString());
        Assert.Equal(1, environment.Operations.Count(o => o == "signature"));
        Assert.Null(first["capturedProducers"]!["Primitive"]!["reusedFromCache"]);

        var second = Deliver();   // a new task: same environment, producer and elements, same server version
        Assert.NotEqual(first["taskId"]!.ToString(), second["taskId"]!.ToString());
        Assert.Equal(1, environment.Operations.Count(o => o == "signature"));
        var reused = second["capturedProducers"]!["Primitive"]!;
        Assert.True(reused["reusedFromCache"]!.GetValue<bool>());
        Assert.Equal(first["capturedProducers"]!["Primitive"]!["sha256"]!.ToString(), reused["sha256"]!.ToString());
        Assert.StartsWith(second["work"]!.ToString(), reused["path"]!.ToString());
        Assert.True(second["producerAttestation"]!.AsArray().Single()!["attested"]!.GetValue<bool>());

        // Republished by SSAM (F5: the facade records each publication it starts): the ledger no longer vouches for the
        // capture, the server re-attests it, it no longer attests and the producer is captured again.
        Thread.Sleep(20);
        ProducerLedger.ForWork(work)!.Published("lab.example", "ZZHighCodePrimitives", null, "o11_publish", DateTime.UtcNow);
        environment.Version = 8;
        var third = Deliver();
        Assert.Equal(2, environment.Operations.Count(o => o == "signature"));
        Assert.Null(third["capturedProducers"]!["Primitive"]!["reusedFromCache"]);
        Assert.Equal(8, third["capturedProducers"]!["Primitive"]!["versionId"]!.GetValue<int>());
    }

    /// <summary>C26 and C15 item 4: a consumer delivery with captured producers runs the Studio's Refresh References first when
    /// the bridge offers it (an older bridge is not asked), and a candidate whose producer signature does not survive the
    /// disposable preview merge is refused before the live merge.</summary>
    [Fact]
    public void ProducerDeliveriesRefreshFirstAndPreviewTheSignatureMerge()
    {
        var before = Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR");
        Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Path.Combine(Path.GetTempPath(), "pacote-d1-authority-" + Guid.NewGuid().ToString("N")));
        try
        {
            var work = Path.Combine(Root, ".local", "pacote-d1-sources-tests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(work);
            var environment = SignatureEnvironment.Primitive();
            var authority = new StudioProducerAuthority(host => HeadlessSession.ConnectStudio(environment, host, null, readOnly: true));
            var job = Path.Combine(work, "capture-job.json");
            File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "reference", ["producer"] = "Primitive",
                ["elements"] = new JsonArray("IServerActionSignature:CSharpTextCompareOrdinal") }) }.ToJsonString());
            var request = new DeliveryRequest("Probe", job, work, [], CaptureProducers: ["Primitive=ZZHighCodePrimitives"]);
            JsonObject Valid(string b, string j, string o, IReadOnlyDictionary<string, string> p) { File.WriteAllText(o, "candidate"); return new JsonObject { ["isValid"] = true, ["accepted"] = true }; }
            var previews = 0;

            var refreshing = new Stub { Capabilities = ["refresh_references"] };
            var refused = Delivery.Run(refreshing, request, (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: authority,
                applyWithProducers: Valid, previewSignatures: (b, f, d) => { previews++; return new JsonObject { ["ran"] = true, ["accepted"] = false, ["changes"] = 1,
                    ["error"] = "Native merge did not retain all validated producer signature selections." }; });
            Assert.Equal(Delivery.SignaturePreviewRefused, refused["code"]!.ToString());
            Assert.Contains("disposable preview", refused["error"]!.ToString());
            Assert.Equal("not-sent", refused["writeState"]!.ToString());
            Assert.Equal(1, previews);
            Assert.DoesNotContain("merge_from_oml", refreshing.Calls);
            Assert.True(refreshing.Calls.IndexOf("refresh_references") < refreshing.Calls.IndexOf("snapshot_module"), string.Join(",", refreshing.Calls));
            var sent = refreshing.Refresh!;
            Assert.Equal("ZZHighCodePrimitives", sent["producers"]![0]!.ToString());
            Assert.Equal("module-key", sent["module_key"]!.ToString());
            Assert.True(refused["refreshReferences"]!["changed"]!.GetValue<bool>());

            // An older bridge (no capability) is never asked to refresh; a preview that could not run lets the delivery go on.
            var old = new Stub();
            var request2 = new DeliveryRequest("Probe", job, Path.Combine(work, "second"), [], CaptureProducers: ["Primitive=ZZHighCodePrimitives"]);
            Directory.CreateDirectory(request2.WorkDirectory);
            var passed = Delivery.Run(old, request2, (_, _, _) => throw new Exception("producer-aware apply expected"), producerAuthority: authority,
                applyWithProducers: Valid, previewSignatures: (b, f, d) => new JsonObject { ["ran"] = false, ["reason"] = "no runtime" });
            Assert.DoesNotContain("refresh_references", old.Calls);
            Assert.Contains("merge_from_oml", old.Calls);
            Assert.False(passed["signaturePreview"]!["ran"]!.GetValue<bool>());
        }
        finally { Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Pa2F1TestAuthority.Restore(before)); }
    }

    [Fact]
    public void TheO11PreviewIsFoundByNameAndSaysWhenItCouldNotRun()
    {
        // Delivery finds the preview by name (the delivery sources also compile in Anvil.Core.Odc, which has no O11 merge).
        Assert.NotNull(typeof(Delivery).Assembly.GetType("Anvil.Core.Delivery.SignaturePreview"));
        var dir = Path.Combine(Root, ".local", "pacote-d1-sources-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "base.oml"), "not a module"); File.WriteAllText(Path.Combine(dir, "foreign.oml"), "not a module");
        var preview = SignaturePreview.Check(Path.Combine(dir, "base.oml"), Path.Combine(dir, "foreign.oml"), dir);
        Assert.False(preview["ran"]!.GetValue<bool>());
        Assert.False(string.IsNullOrEmpty(preview["reason"]?.ToString()));
        Assert.True(Delivery.BindsProducerSignatures(new DeliveryRequest("M", "j.json", dir, [], CaptureProducers: ["P"])));
        Assert.True(Delivery.BindsProducerSignatures(new DeliveryRequest("M", "j.json", dir, [], new Dictionary<string, string> { ["P"] = "C:\\p.avsig" })));
        Assert.False(Delivery.BindsProducerSignatures(new DeliveryRequest("M", "j.json", dir, [], new Dictionary<string, string> { ["P"] = "C:\\p.oml" })));
    }

    private sealed class Stub : IBridgeClient
    {
        public string[] Capabilities = [];
        public List<string> Calls { get; } = [];
        public JsonObject? Refresh;
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Calls.Add(method);
            switch (method)
            {
                case "open_module": return new() { ["opened"] = true };
                case "get_active_module": return new() { ["name"] = "Probe", ["key"] = "module-key", ["environment"] = "lab.example" };
                case "snapshot_module":
                    if (parameters?["path"] is { } path) File.WriteAllText(path.ToString(), "snapshot");
                    return new() { ["key"] = "module-key", ["snapshot_id"] = "snapshot-1" };
                case "bridge_manifest": return new() { ["capabilities"] = new JsonArray(Capabilities.Select(c => (JsonNode)JsonValue.Create(c)!).ToArray()) };
                case "refresh_references": Refresh = parameters!.DeepClone().AsObject(); return new() { ["module"] = "Probe", ["changed"] = true, ["refreshed"] = new JsonArray("ZZHighCodePrimitives") };
                case "merge_from_oml": return new() { ["merged"] = false, ["reason"] = "conflicts: use mode=dialog" };
                default: throw new Exception("Unexpected bridge call: " + method);
            }
        }
    }
}
