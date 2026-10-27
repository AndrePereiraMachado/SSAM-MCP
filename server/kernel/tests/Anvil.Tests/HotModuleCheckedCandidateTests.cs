using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>S9 (rascunho com candidato): the facade's build phase writes the prebuilt manifest of a draft's delivery from the
/// candidate of the draft's joint check (platforms/odc/facade/o11-build-phase.mjs fromCheckedCandidate): the check's base,
/// its candidate, and its kernel result with the sources naming the delivery's job file, whose JSON the facade found equal
/// to the job the check applied. PrebuiltCandidate takes that manifest on the same model and still refuses any other job,
/// model or candidate.</summary>
public class HotModuleCheckedCandidateTests
{
    private static string Work()
    {
        var root = Anvil.Core.JobRunner.RepoRoot(Path.GetDirectoryName(typeof(HotModuleCheckedCandidateTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "hot-module-checked-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work); return work;
    }

    private static byte[] Oml(string header, string model)
    {
        var head = Encoding.ASCII.GetBytes(header); var body = Encoding.ASCII.GetBytes(model);
        var bytes = new byte[7 + head.Length + body.Length];
        Encoding.ASCII.GetBytes("OML").CopyTo(bytes, 0);
        BitConverter.GetBytes((uint)head.Length).CopyTo(bytes, 3);
        head.CopyTo(bytes, 7); body.CopyTo(bytes, 7 + head.Length);
        return bytes;
    }

    private const string JobText = "{\"ops\":[{\"op\":\"logic\",\"data\":{\"flow\":[\"server action A\\n  end\\n\"]}}]}";

    /// <summary>The check's folder (its capture, the job it applied, the candidate and the kernel's result) and the manifest the
    /// facade writes for the delivery job; rewrite:false keeps the check's own sources.</summary>
    private static (string Manifest, string DeliveryJob, string CheckJob) Scene(string work, bool rewrite = true)
    {
        var check = Directory.CreateDirectory(Path.Combine(work, "check")).FullName;
        var checkJob = Path.Combine(check, "job.json"); File.WriteAllText(checkJob, JsonNode.Parse(JobText)!.ToJsonString(new() { WriteIndented = true }));
        var deliveryJob = Path.Combine(Directory.CreateDirectory(Path.Combine(work, "inline")).FullName, "delivery.json");
        File.WriteAllText(deliveryJob, JsonNode.Parse(JobText)!.ToJsonString(new() { WriteIndented = true }) + "\n");
        var capture = Path.Combine(check, "capture.oml"); File.WriteAllBytes(capture, Oml("check-capture|tree", "MODEL-1"));
        var candidate = Path.Combine(check, "candidate.oml"); File.WriteAllText(candidate, "checked-candidate");
        var kernelResult = new JsonObject { ["isValid"] = true, ["accepted"] = true, ["sources"] = DeliveryReceipt.Sources(checkJob), ["provenance"] = new JsonObject { ["kernelSha256"] = "k" } };
        var build = Directory.CreateDirectory(Path.Combine(work, "build")).FullName;
        var copy = Path.Combine(build, "candidate.oml"); File.Copy(candidate, copy);
        // What the facade writes: the sources of the delivery's job, as the facade composes them ({path, sha256} of the file).
        if (rewrite) kernelResult["sources"] = new JsonArray(new JsonObject { ["path"] = Path.GetFullPath(deliveryJob), ["sha256"] = DeliveryReceipt.Hash(deliveryJob) });
        var result = Path.Combine(build, "candidate.result.json"); File.WriteAllText(result, kernelResult.ToJsonString());
        var manifest = Path.Combine(build, "prebuilt.json");
        File.WriteAllText(manifest, new JsonObject { ["schema"] = PrebuiltCandidate.Schema, ["job"] = deliveryJob, ["base"] = capture, ["baseSha256"] = DeliveryReceipt.Hash(capture),
            ["baseModelSha256"] = PrebuiltCandidate.ModelSha256(capture), ["candidate"] = copy, ["candidateSha256"] = DeliveryReceipt.Hash(copy), ["result"] = result,
            ["producers"] = new JsonObject(), ["checked"] = new JsonObject { ["candidate"] = candidate, ["job"] = checkJob } }.ToJsonString());
        return (manifest, deliveryJob, checkJob);
    }

    [Fact]
    public void TheFacadesSourcesOfTheDeliveryJobAreTheKernelsOwn()
    {
        var work = Work();
        var (_, deliveryJob, _) = Scene(work);
        var facade = new JsonArray(new JsonObject { ["path"] = Path.GetFullPath(deliveryJob), ["sha256"] = DeliveryReceipt.Hash(deliveryJob) });
        Assert.True(JsonNode.DeepEquals(facade, DeliveryReceipt.Sources(deliveryJob)));
    }

    [Fact]
    public void TheCheckedCandidateServesTheDeliveryOfTheSameModelAndNothingElse()
    {
        var work = Work();
        var (manifest, deliveryJob, _) = Scene(work);
        var snapshot = Path.Combine(work, "snapshot.oml"); File.WriteAllBytes(snapshot, Oml("delivery-snapshot|other-state", "MODEL-1"));
        var output = Path.Combine(work, "applied.oml");
        var reused = PrebuiltCandidate.TryReuse(manifest, snapshot, deliveryJob, output, null, null, out var reason);
        Assert.NotNull(reused); Assert.Equal("", reason);
        Assert.Equal("checked-candidate", File.ReadAllText(output));

        // The module changed after the check: never the checked candidate.
        File.WriteAllBytes(snapshot, Oml("delivery-snapshot", "MODEL-2"));
        Assert.Null(PrebuiltCandidate.TryReuse(manifest, snapshot, deliveryJob, output, null, null, out reason)); Assert.Equal("base-changed", reason);
        File.WriteAllBytes(snapshot, Oml("delivery-snapshot", "MODEL-1"));
        // The delivery's job changed after the manifest was written.
        File.AppendAllText(deliveryJob, " ");
        Assert.Null(PrebuiltCandidate.TryReuse(manifest, snapshot, deliveryJob, output, null, null, out reason)); Assert.Equal("job-changed", reason);
        // Producers the check did not bind.
        var (again, job2, _) = Scene(Work());
        var lib = Path.Combine(work, "lib.oml"); File.WriteAllText(lib, "lib");
        Assert.Null(PrebuiltCandidate.TryReuse(again, snapshot, job2, output, new Dictionary<string, string> { ["Lib"] = lib }, null, out reason)); Assert.Equal("producers-changed", reason);
    }

    [Fact]
    public void WithoutTheRewriteTheKernelWouldRebuild()
    {
        // The check's sources name the check's own job file: the kernel compares them with the delivery's job (job-changed),
        // so the facade's rewrite, after its JSON comparison, is what lets the candidate serve.
        var work = Work();
        var (manifest, deliveryJob, _) = Scene(work, rewrite: false);
        var snapshot = Path.Combine(work, "snapshot.oml"); File.WriteAllBytes(snapshot, Oml("delivery-snapshot", "MODEL-1"));
        Assert.Null(PrebuiltCandidate.TryReuse(manifest, snapshot, deliveryJob, Path.Combine(work, "applied.oml"), null, null, out var reason));
        Assert.Equal("job-changed", reason);
    }
}
