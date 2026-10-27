using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class TraditionalInputChangeTests
{
    [Fact]
    public void InputAndTextareaChangeHandlersSurviveNativeMerge()
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalInputChangeTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "traditional-onchange", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var basis = Path.Combine(root, "tests/fixtures/traditional-ui.oml");
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = """
                <screen name="InputChangeAudit" actions="Recalculate" roles="Registered">
                 <var name="Query" type="Text"/><var name="Details" type="Text"/>
                 <input id="QueryInput" bind="Query" onchange="Recalculate"/>
                 <textarea id="DetailsInput" bind="Details" onchange="Recalculate"/>
                 <div>{{ Query }}</div>
                </screen>
                """ } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "action InputChangeAudit.Recalculate\n  assign Query = Details\n  end" } }
        ) }.ToJsonString());
        var candidate = Path.Combine(work, "candidate.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, candidate))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var merged = Path.Combine(work, "merged.oml");
        Assert.True(MergeProbe.ThreeWay(host, File.ReadAllBytes(basis), File.ReadAllBytes(candidate), merged).LocalIsValid, work);
        var proof = MergeContentProof.Check(host, candidate, merged);
        File.WriteAllText(Path.Combine(work, "proof.json"), proof.ToJsonString());
        Assert.True(proof["accepted"]!.GetValue<bool>(), work);
        var html = host.HtmlRead(File.ReadAllBytes(merged), "InputChangeAudit")["documents"]![0]!["html"]!.ToString();
        Assert.Equal(2, html.Split("onchange=\"Recalculate\"").Length - 1);
        Assert.Contains("bind=\"Query\"", html);
        Assert.Contains("bind=\"Details\"", html);
    }
}
