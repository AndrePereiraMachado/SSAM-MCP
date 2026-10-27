using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class SwitchMergeIntegrityTests
{
    public static IEnumerable<object[]> Fixtures() => HtmlCrossPlatformLifecycleTests.Fixtures();

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void NativeMergeRetainsSwitchMeaningAndProofRejectsChangedBranches(string fixture)
    {
        var binder = typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc")
            ?? typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var bind = binder.GetMethods().First(m => m.Name == "Bind");
        bind.Invoke(null, bind.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(SwitchMergeIntegrityTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "switch-merge-proof", fixture.Replace('/', '-'), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var basis = Path.Combine(root, "tests", "fixtures", fixture);
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, """
          {"ops":[{"op":"logic","data":{"actions":[{"name":"SwitchProof","kind":"server",
           "inputs":[{"name":"Choice","type":"Integer"}],"outputs":[{"name":"Result","type":"Text"}],
           "steps":[{"as":"Pick","switch":[
            {"when":"Choice >= 0","steps":[{"assign":{"Result":"\"nonnegative\""}}]},
            {"when":"Choice > 10","steps":[{"assign":{"Result":"\"greater\""}}]}],
            "otherwise":[{"assign":{"Result":"\"negative\""}}]},{"return":true}]}]}}]}
          """);
        var candidate = Path.Combine(work, "candidate.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, candidate))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var plan = new MergePlanner(_ => host).Plan(basis, candidate, Path.Combine(work, "first-pass.oml"));
        File.WriteAllText(Path.Combine(work, "merge-proof.json"), plan.ToJsonString());
        Assert.True(plan["contentPreview"]!["accepted"]!.GetValue<bool>(), work + "\n" + plan);
        var tree = host.ReadModel(candidate, "ServerAction:SwitchProof/SwitchNode:Pick", new(Depth: 3, Full: true))["tree"]!;
        var conditions = tree["children"]!.AsArray().Where(n => n!["kind"]!.ToString() == "SwitchCondition").ToArray();
        var first = conditions.Single(n => n!["children"]![0]!["properties"]!["Text"]!.ToString() == "Choice >= 0")!["reference"]!.ToString();
        var second = conditions.Single(n => n!["children"]![0]!["properties"]!["Text"]!.ToString() == "Choice > 10")!["reference"]!.ToString();
        var fallback = host.ReadModel(candidate, "ServerAction:SwitchProof", new(Kind: "EndNode"))["entries"]![0]!["reference"]!.ToString();
        foreach (var mutation in new[] {"condition", "target", "priority"}) {
            var op = mutation switch {
                "condition" => new JsonObject { ["op"]="set", ["target"]=first, ["prop"]="Value", ["value"]="Choice >= 1" },
                "target" => new JsonObject { ["op"]="set", ["target"]=first, ["prop"]="Target", ["value"]=fallback },
                _ => new JsonObject { ["op"]="move", ["target"]=second, ["before"]=first }
            };
            var actual = Path.Combine(work, mutation + ".oml");
            CompileCheck.WriteUnchecked(host, File.ReadAllBytes(candidate), new JsonArray(op), actual);
            var proof = MergeContentProof.Check(host, candidate, actual);
            File.WriteAllText(Path.Combine(work, mutation + "-proof.json"), proof.ToJsonString());
            Assert.False(proof["accepted"]!.GetValue<bool>(), mutation + ": " + work);
            Assert.Contains(proof["differences"]!.AsArray(), d => d!["property"]!.ToString() == "ordered:Conditions");
        }
    }
}
