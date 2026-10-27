using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class NativeContentMergeTests
{
    [Fact]
    public void TraditionalDefaultScreenLostByNativeMergeCannotPassProof()
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeContentMergeTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "native-content-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var basis = Path.Combine(root, "tests", "fixtures", "traditional-ui.oml");
        var candidate = Path.Combine(work, "candidate.oml");
        CompileCheck.WriteUnchecked(host, File.ReadAllBytes(basis), JsonNode.Parse("""
            [{"op":"create","parent":"IWebFlow:MainFlow","type":"IWebScreen","name":"MergeProbeHome","as":"$home"},
             {"op":"set","target":"@espace","prop":"DefaultScreen","value":"$home"}]
            """)!.AsArray(), candidate);
        var merged = Path.Combine(work, "merged.oml");
        MergeProbe.ThreeWay(host, File.ReadAllBytes(basis), File.ReadAllBytes(candidate), merged);
        var proof = MergeContentProof.Check(host, candidate, merged);
        File.WriteAllText(Path.Combine(work, "proof.json"), proof.ToJsonString());
        Assert.False(proof["accepted"]!.GetValue<bool>(), work + "\n" + proof.ToJsonString());
        var loss = Assert.Single(proof["differences"]!.AsArray(), d => d!["property"]!.ToString() == "DefaultScreen")!;
        Assert.False(string.IsNullOrEmpty(loss["expected"]!.ToString()));
        Assert.Equal("", loss["actual"]!.ToString());
        Assert.True(MergeContentProof.Check(host, candidate, candidate)["accepted"]!.GetValue<bool>());
    }

    [Fact]
    public void NewRefreshBindingsSurviveNativeMerge()
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeContentMergeTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "native-content-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var historical = Environment.GetEnvironmentVariable("SSAM_MERGE_REPLAY");
        var basis = historical == null ? Path.Combine(root, "tests", "fixtures", "reactive-ui.oml") : Path.Combine(historical, "base.oml");
        var candidate = Path.Combine(work, "candidate.oml");
        string job;
        Dictionary<string, string>? bindings = null;
        if (historical == null)
        {
            var ops = new JsonArray();
            var flows = new JsonArray();
            for (var i = 0; i < 6; i++)
            {
                ops.Add(new JsonObject { ["op"] = "create", ["parent"] = "IMobileFlow:MainFlow", ["type"] = "IMobileScreen", ["name"] = "Probe" + i });
                flows.Add($"data action Probe{i}.LoadValue\n  out Value: Text\n  assign Value = \"ok\"\n  end");
                flows.Add($"action Probe{i}.RefreshValue\n  refresh LoadValue\n  end");
            }
            ops.Add(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = flows } });
            job = Path.Combine(work, "job.json");
            File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
        }
        else
        {
            job = Environment.GetEnvironmentVariable("SSAM_REPLAY_JOB")!;
            // The producer module the replayed job binds, when it binds one: its signature is producers/<name>.avsig beside
            // the replay folder. The name comes from the environment, never from this file.
            if (Environment.GetEnvironmentVariable("SSAM_REPLAY_PRODUCER") is { Length: > 0 } producer)
                bindings = new() { [producer] = Path.Combine(Path.GetDirectoryName(historical)!, "producers", producer + ".avsig") };
        }
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, candidate, bindings: bindings))!;
        File.WriteAllText(Path.Combine(work, "apply.json"), result.ToJsonString());
        Assert.True(result["accepted"]!.GetValue<bool>(), work + "\n" + result.ToJsonString());
        var merged = Path.Combine(work, "merged.oml");
        MergeProbe.ThreeWay(host, File.ReadAllBytes(basis), File.ReadAllBytes(candidate), merged);
        var proof = MergeContentProof.Check(host, candidate, merged);
        File.WriteAllText(Path.Combine(work, "proof.json"), proof.ToJsonString());
        Assert.True(proof["accepted"]!.GetValue<bool>(), work + "\n" + proof.ToJsonString());
    }
}
