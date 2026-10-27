using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class TraditionalHtmlFrontendTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void NativeFrontendKeepsFieldsEventsCssAndEntryAfterMerge(bool existingEntry)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalHtmlFrontendTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "traditional-frontend-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var basis = Path.Combine(root, "tests", "fixtures", "traditional-ui.oml");
        string? originalTarget = null;
        if (existingEntry) {
            var setup = Path.Combine(work, "setup.json");
            File.WriteAllText(setup, """{"ops":[{"op":"create","parent":"IWebFlow:MainFlow","type":"IWebScreen","name":"OriginalHome","as":"$home"},{"op":"create","parent":"IWebFlow:MainFlow","type":"IEntry","name":"OriginalEntry","as":"$entry"},{"op":"link","from":"$entry","to":"$home"},{"op":"set","target":"$entry","prop":"IsDefault","value":true}]}""");
            var prepared = Path.Combine(work, "baseline.oml");
            var setupResult = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, setup, prepared))!;
            originalTarget = "@" + setupResult["handles"]!["$home"]!.ToString();
            basis = prepared;
        }
        var candidate = Path.Combine(work, "candidate.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, Path.Combine(root, "tests", "jobs", "traditional-html-frontend.json"), candidate))!;
        File.WriteAllText(Path.Combine(work, "apply.json"), applied.ToJsonString());
        Assert.True(applied["accepted"]!.GetValue<bool>(), work + "\n" + applied);
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(basis), File.ReadAllBytes(candidate), merged);
        Assert.True(merge.LocalIsValid, work + "\n" + JsonSerializer.Serialize(merge));
        Assert.False(merge.HasConflicts);
        Assert.True(MergeContentProof.Check(host, candidate, merged)["accepted"]!.GetValue<bool>());
        var readJob = Path.Combine(work, "read.json");
        File.WriteAllText(readJob, """{"ops":[{"op":"get","target":"IWebScreen:FrontendAudit"},{"op":"get","target":"IEntry:FrontendAuditEntry"},{"op":"get","target":"IWebScreen:FrontendAudit/**IInputWidget"},{"op":"get","target":"IWebScreen:FrontendAudit/**IButtonWidget/OnClick"},{"op":"get","target":"IWebScreen:FrontendAudit/Confirm"},{"op":"get","target":"IWebScreen:FrontendAudit/**IButtonWidget"},{"op":"get","target":"IWebBlock:AuditHeader"}]}""".Replace("IEntry:FrontendAuditEntry", existingEntry ? "IEntry:OriginalEntry" : "IEntry:FrontendAuditEntry"));
        var read = JsonSerializer.SerializeToNode(JobRunner.Run(host, merged, readJob, Path.Combine(work, "read.oml")))!;
        File.WriteAllText(Path.Combine(work, "read.json.result"), read.ToJsonString());
        Assert.True(read["accepted"]!.GetValue<bool>(), work + "\n" + read);
        var results = read["results"]!.AsArray();
        Assert.Contains("audit-page", results[0]!["result"]!["properties"]!["StyleSheet"]!.ToString());
        var home = "@" + results[0]!["result"]!["key"];
        var entryTarget = results[1]!["result"]!["properties"]!["Target"]!.ToString();
        Assert.Equal(existingEntry ? originalTarget : home, entryTarget);
        Assert.Equal("True", results[1]!["result"]!["properties"]!["IsDefault"]!.ToString());
        Assert.DoesNotContain("\"\"\"", results[0]!["result"]!["properties"]!["Title"]!.ToString());
        Assert.Equal("Name", results[2]!["result"]!["properties"]!["Variable"]!.ToString());
        Assert.Equal("@" + results[4]!["result"]!["key"], results[3]!["result"]!["properties"]!["Destination"]!.ToString());
        Assert.Equal("\"Confirm\"", results[5]!["result"]!["properties"]!["Label"]!.ToString());
        Assert.Contains("audit-header", results[6]!["result"]!["properties"]!["StyleSheet"]!.ToString());
        var flow = host.BuildFlow(File.ReadAllBytes(merged), "test", "o11");
        var action = Assert.Single(flow.Actions, a => a.Key == results[4]!["result"]!["key"]!.ToString());
        File.WriteAllText(Path.Combine(work, "action.txt"), action.Text);
        Assert.True(action.FixedPoint);
        Assert.Contains("The Traditional frontend works.", action.Text);
    }

    [Theory]
    [InlineData("<video/>")]
    // A plain unknown attribute on a widget is an extended property (as the reader prints them); a misplaced attribute
    // of the language and a browser event handler are still refused.
    [InlineData("<div bind=\"x\"/>")]
    [InlineData("<div onfoo=\"x\"/>")]
    [InlineData("<div><input name=\"MissingBind\"/></div>")]
    [InlineData("<div>{{ unclosed</div>")]
    public void UnsupportedMarkupIsRefusedWithoutAnOutput(string content)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalHtmlFrontendTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "traditional-frontend-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = Path.Combine(work, "refuse.json");
        File.WriteAllText(job, new JsonObject { ["base"] = "traditional-ui.oml", ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen name=\"Rejected\">" + content + "</screen>" } }) }.ToJsonString());
        var output = Path.Combine(work, "refused.oml");
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(work, "model")), null, job, output));
        Assert.NotNull(Errors.FindCoded(error));
        Assert.False(File.Exists(output));
    }
}
