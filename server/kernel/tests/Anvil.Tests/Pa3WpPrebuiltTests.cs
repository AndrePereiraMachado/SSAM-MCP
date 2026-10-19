using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>Lane wp (atritos 3, the OML writer pool): the candidate built outside the Studio lock is reused by the
/// delivery's apply only on the same model, and rebuilt on the fresh snapshot (a rebase, in the same call) otherwise.</summary>
public class Pa3WpPrebuiltTests
{
    private static string Work()
    {
        var root = Anvil.Core.JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Pa3WpPrebuiltTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "pa3-wp-prebuilt-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work); return work;
    }

    // An OML as the Service Studio writes it: "OML", the header length, the header (window state), the model.
    private static byte[] Oml(string header, string model)
    {
        var head = Encoding.ASCII.GetBytes(header); var body = Encoding.ASCII.GetBytes(model);
        var bytes = new byte[7 + head.Length + body.Length];
        Encoding.ASCII.GetBytes("OML").CopyTo(bytes, 0);
        BitConverter.GetBytes((uint)head.Length).CopyTo(bytes, 3);
        head.CopyTo(bytes, 7); body.CopyTo(bytes, 7 + head.Length);
        return bytes;
    }

    [Fact]
    public void ModelShaIgnoresTheStudioHeaderAndSeesEveryModelByte()
    {
        var work = Work();
        var a = Path.Combine(work, "a.oml"); var b = Path.Combine(work, "b.oml"); var c = Path.Combine(work, "c.oml"); var raw = Path.Combine(work, "raw.oml");
        File.WriteAllBytes(a, Oml("11.0|Probe|/NRWebFlows.x/NodesShownInESpaceTree.k1|eyJwcmVzZW50ZXIiOjF9", "MODEL-1"));
        File.WriteAllBytes(b, Oml("11.0|Probe|/UserActions.y|eyJwcmVzZW50ZXIiOjJ9-longer-state", "MODEL-1"));
        File.WriteAllBytes(c, Oml("11.0|Probe|/NRWebFlows.x/NodesShownInESpaceTree.k1|eyJwcmVzZW50ZXIiOjF9", "MODEL-2"));
        File.WriteAllText(raw, "not an oml");
        Assert.NotEqual(DeliveryReceipt.Hash(a), DeliveryReceipt.Hash(b));
        Assert.Equal(PrebuiltCandidate.ModelSha256(a), PrebuiltCandidate.ModelSha256(b));
        Assert.NotEqual(PrebuiltCandidate.ModelSha256(a), PrebuiltCandidate.ModelSha256(c));
        Assert.Equal(DeliveryReceipt.Hash(raw), PrebuiltCandidate.ModelSha256(raw));
    }

    // The build phase's output: capture, candidate, its result.json (with the sources apply records) and the manifest.
    private static (string Manifest, string Job, string Candidate) Build(string work, string model, string? producer = null)
    {
        var job = Path.Combine(work, "job.json"); if (!File.Exists(job)) File.WriteAllText(job, "{\"ops\":[]}");
        var build = Directory.CreateDirectory(Path.Combine(work, "build")).FullName;
        var capture = Path.Combine(build, "capture.oml"); File.WriteAllBytes(capture, Oml("build-header|tree.a", model));
        var candidate = Path.Combine(build, "candidate.oml"); File.WriteAllText(candidate, "prebuilt-candidate");
        var result = Path.Combine(build, "candidate.result.json");
        File.WriteAllText(result, new JsonObject { ["isValid"] = true, ["accepted"] = true, ["validation"] = new JsonObject { ["new"] = new JsonArray() },
            ["sources"] = DeliveryReceipt.Sources(job), ["provenance"] = new JsonObject { ["kernelSha256"] = "k" } }.ToJsonString());
        var producers = new JsonObject();
        if (producer != null) producers["Lib"] = new JsonObject { ["path"] = producer, ["sha256"] = DeliveryReceipt.Hash(producer) };
        var manifest = Path.Combine(build, "prebuilt.json");
        File.WriteAllText(manifest, new JsonObject { ["schema"] = PrebuiltCandidate.Schema, ["job"] = job, ["base"] = capture, ["baseSha256"] = DeliveryReceipt.Hash(capture),
            ["candidate"] = candidate, ["candidateSha256"] = DeliveryReceipt.Hash(candidate), ["result"] = result, ["producers"] = producers }.ToJsonString());
        return (manifest, job, candidate);
    }

    [Fact]
    public void SameModelReusesTheCandidateAndChangedInputsRebuild()
    {
        var work = Work();
        var (manifest, job, candidate) = Build(work, "MODEL-1");
        var snapshot = Path.Combine(work, "snapshot.oml"); File.WriteAllBytes(snapshot, Oml("delivery-header|tree.b|other-state", "MODEL-1"));
        var output = Path.Combine(work, "foreign.oml");
        var reused = PrebuiltCandidate.TryReuse(manifest, snapshot, job, output, null, null, out var reason);
        Assert.NotNull(reused); Assert.Equal("", reason);
        Assert.Equal("prebuilt-candidate", File.ReadAllText(output));
        Assert.True(reused!["prebuilt"]!["reused"]!.GetValue<bool>());
        Assert.Null(reused["provenance"]); Assert.Null(reused["sources"]);

        // The module changed after the build: never the old candidate.
        File.WriteAllBytes(snapshot, Oml("delivery-header", "MODEL-2"));
        Assert.Null(PrebuiltCandidate.TryReuse(manifest, snapshot, job, output, null, null, out reason)); Assert.Equal("base-changed", reason);
        File.WriteAllBytes(snapshot, Oml("delivery-header", "MODEL-1"));
        // The job changed after the build.
        File.WriteAllText(job, "{\"ops\":[],\"x\":1}");
        Assert.Null(PrebuiltCandidate.TryReuse(manifest, snapshot, job, output, null, null, out reason)); Assert.Equal("job-changed", reason);
        File.WriteAllText(job, "{\"ops\":[]}");
        // A producer the build did not bind, and a tampered candidate.
        var lib = Path.Combine(work, "lib.avsig"); File.WriteAllText(lib, "sig");
        Assert.Null(PrebuiltCandidate.TryReuse(manifest, snapshot, job, output, new Dictionary<string, string> { ["Lib"] = lib }, null, out reason)); Assert.Equal("producers-changed", reason);
        File.WriteAllText(candidate, "tampered");
        Assert.Null(PrebuiltCandidate.TryReuse(manifest, snapshot, job, output, null, null, out reason)); Assert.Equal("candidate-changed", reason);
    }

    [Fact]
    public void AnotherKernelAssemblyRebuilds()
    {
        var work = Work();
        var (manifest, job, _) = Build(work, "MODEL-1");
        var snapshot = Path.Combine(work, "snapshot.oml"); File.WriteAllBytes(snapshot, Oml("h", "MODEL-1"));
        var kernel = Path.Combine(work, "Anvil.Core.dll"); File.WriteAllText(kernel, "another kernel");
        Assert.Null(PrebuiltCandidate.TryReuse(manifest, snapshot, job, Path.Combine(work, "f.oml"), null, kernel, out var reason));
        Assert.Equal("kernel-changed", reason);
    }

    // The whole delivery (Delivery.Run with a fake bridge), as the CLI composes it: the apply phase reuses the candidate
    // when the snapshot it takes has the build's model, and rebuilds once on the fresh snapshot when it does not.
    [Theory]
    [InlineData("MODEL-1", 0, true)]
    [InlineData("MODEL-CHANGED", 1, false)]
    public void DeliveryReusesOrRebasesInTheSameCall(string live, int expectedApplies, bool reused)
    {
        var work = Work();
        var (manifest, job, _) = Build(work, "MODEL-1");
        var bridge = new Bridge { Model = live }; var applies = 0;
        JsonObject Fresh(string basePath, string output)
        {
            applies++; Assert.Equal(live, Encoding.ASCII.GetString(File.ReadAllBytes(basePath)[^live.Length..]));
            File.WriteAllText(output, "fresh-candidate");
            return new() { ["isValid"] = true, ["accepted"] = true };
        }
        var result = Delivery.Run(bridge, new("Probe", job, Path.Combine(work, "deliver"), Array.Empty<string>()),
            (basePath, jobPath, output) => PrebuiltCandidate.Apply(manifest, basePath, jobPath, output, null, null, () => Fresh(basePath, output)));
        Assert.True(result["delivered"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Equal(expectedApplies, applies);
        Assert.Equal(1, bridge.Merges);
        Assert.Equal(reused, result["apply"]!["prebuilt"]!["reused"]!.GetValue<bool>());
        if (!reused) Assert.Equal("base-changed", result["apply"]!["prebuilt"]!["reason"]!.ToString());
        Assert.Equal(reused ? "prebuilt-candidate" : "fresh-candidate", File.ReadAllText(bridge.Foreign!));
    }

    [Theory]
    [InlineData(false, true)]
    [InlineData(null, false)]
    [InlineData(true, false)]
    public void AutoPatchOptOutRejectsPatchedPrebuiltCandidate(bool? callPolicy, bool jobPolicy)
    {
        var work = Work();
        var jobPath = Path.Combine(work, "job.json");
        File.WriteAllText(jobPath, new JsonObject { ["ops"] = new JsonArray(), ["autoPatch"] = jobPolicy }.ToJsonString());
        var (manifest, job, candidate) = Build(work, "MODEL-1");
        var resultPath = Path.Combine(Path.GetDirectoryName(candidate)!, "candidate.result.json");
        var result = JsonNode.Parse(File.ReadAllText(resultPath))!.AsObject();
        result["patchesApplied"] = new JsonArray(new JsonObject { ["patchRule"] = "TEXT_LITERAL_QUOTED" });
        File.WriteAllText(resultPath, result.ToJsonString());
        var snapshot = Path.Combine(work, "snapshot.oml"); File.WriteAllBytes(snapshot, Oml("live-header", "MODEL-1"));
        var output = Path.Combine(work, "foreign.oml");
        using var policy = Anvil.Core.JobPreflight.UseAutoPatch(callPolicy);
        Assert.Null(PrebuiltCandidate.TryReuse(manifest, snapshot, job, output, null, null, out var reason));
        Assert.Equal("auto-patch-disabled", reason);
        Assert.False(File.Exists(output));
        var applies = 0;
        var fresh = PrebuiltCandidate.Apply(manifest, snapshot, job, output, null, null, () =>
        {
            applies++;
            return new JsonObject { ["accepted"] = false, ["isValid"] = false };
        });
        Assert.Equal(1, applies);
        Assert.False(fresh["accepted"]!.GetValue<bool>());
        Assert.Equal("auto-patch-disabled", fresh["prebuilt"]!["reason"]!.GetValue<string>());
        Assert.False(File.Exists(output));
    }

    [Fact]
    public void AutoPatchOptOutKeepsUnpatchedPrebuiltCandidateReusable()
    {
        var work = Work();
        var (manifest, job, _) = Build(work, "MODEL-1");
        var snapshot = Path.Combine(work, "snapshot.oml"); File.WriteAllBytes(snapshot, Oml("live-header", "MODEL-1"));
        using var policy = Anvil.Core.JobPreflight.UseAutoPatch(false);
        Assert.NotNull(PrebuiltCandidate.TryReuse(manifest, snapshot, job, Path.Combine(work, "foreign.oml"), null, null, out var reason));
        Assert.Equal("", reason);
    }

    private sealed class Bridge : IBridgeClient
    {
        public string Model = "MODEL-1"; public int Merges; public string? Foreign;
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            switch (method)
            {
                case "open_module": return new() { ["alreadyOpen"] = true };
                case "get_active_module": return new() { ["name"] = "Probe", ["key"] = "A" };
                case "snapshot_module": File.WriteAllBytes(parameters!["path"]!.ToString(), Oml("live-header|" + Guid.NewGuid().ToString("N"), Model)); return new() { ["key"] = "A", ["snapshot_id"] = "base-id" };
                case "merge_from_oml": Merges++; Foreign = parameters!["foreign_path"]!.ToString(); return new() { ["merged"] = true, ["newErrors"] = 0 };
                case "get_errors": return new() { ["newErrors"] = 0, ["new"] = new JsonArray() };
                default: throw new Exception("Unexpected call: " + method);
            }
        }
    }
}
