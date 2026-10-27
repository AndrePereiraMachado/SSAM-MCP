using System.Text.Json.Nodes;
using System.Text.Json;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class TraditionalLayoutDocumentTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ExplicitAndImplicitLayoutsProduceOneShell(bool explicitLayout)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalLayoutDocumentTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "traditional-layout-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var basis = Path.Combine(root, "tests/fixtures/traditional-ui.oml");
        var job = Path.Combine(work, "job.json");
        var content = explicitLayout ? "<Block name=\"LayoutTopMenu\"><slot name=\"Left\"><Block name=\"ApplicationTitle\"/></slot><slot name=\"MainContent\"><div>One body</div></slot></Block>" : "<div>One body</div>";
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen name=\"SingleShell\">" + content + "</screen>" } }) }.ToJsonString());
        var candidate = Path.Combine(work, "candidate.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, candidate))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(), work);
        var merged = Path.Combine(work, "merged.oml");
        Assert.True(MergeProbe.ThreeWay(host, File.ReadAllBytes(basis), File.ReadAllBytes(candidate), merged).LocalIsValid, work);
        Assert.True(MergeContentProof.Check(host, candidate, merged)["accepted"]!.GetValue<bool>(), work);
        var model = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [merged])!;
        try {
            IEnumerable<object> Walk(object node) {
                yield return node;
                foreach (var child in ((System.Collections.IEnumerable)ModelHost.Prop(node, "Children")!).Cast<object>())
                    foreach (var item in Walk(child)) yield return item;
            }
            var screen = Walk(model).Single(n => ModelHost.Prop(n, "Name")?.ToString() == "SingleShell");
            var sources = Walk(screen).Select(n => ModelHost.Prop(n, "SourceBlock")).Where(n => n != null).Select(n => ModelHost.Prop(n!, "Name")?.ToString()).ToArray();
            Assert.Single(sources, n => n == "LayoutTopMenu");
            if (explicitLayout) Assert.Single(sources, n => n == "ApplicationTitle");
        } finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [model]); }
    }
}
