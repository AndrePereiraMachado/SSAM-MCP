using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

public sealed class BlockAcceptanceFamilyTests
{
    [Theory]
    [InlineData("(System).ListFilter", "List", "SourceList", "Condition=Names.Current <> \"List=untouched\"")]
    [InlineData("System.ListDuplicate", "List", "SourceList", "")]
    [InlineData("ListIndexOf", "SourceList", "List", "Condition=Names.Current = Trim(\"a, b\")")]
    public void SystemListInputNamesAreNormalizedInFlowWithoutReprintingIt(string callee, string wrong, string correct, string rest)
    {
        var tail = rest.Length == 0 ? "" : ", " + rest;
        var flow = $"server action Probe\n  in Names: Text List\n  Result = {callee}({wrong}=Names{tail})  # Keep this label\n  end\n";
        var ops = FlowOps(flow);
        var done = JobNormalizer.Pure(ops, "/ops", "o11");
        var entry = Assert.Single(done, n => n["rule"]!.ToString() == SystemCalls.Rule);
        Assert.Equal("/ops/0/data/flow", entry["path"]!.ToString());
        Assert.Equal(flow.Replace($"{callee}({wrong}=", $"{callee}({correct}="), ops[0]!["data"]!["flow"]!.ToString());
        Assert.Empty(JobNormalizer.Pure(ops, "/ops", "o11"));
    }

    [Fact]
    public void ShorthandArgumentsKeepTheAuthoredValueWhenTheParameterIsRenamed()
    {
        var ops = FlowOps("server action Probe\n  in List: Text List\n  Copy = ListDuplicate(List)\n  end\n");
        Assert.Single(JobNormalizer.Pure(ops, "/ops", "o11"), n => n["rule"]!.ToString() == SystemCalls.Rule);
        Assert.Contains("ListDuplicate(SourceList=List)", ops[0]!["data"]!["flow"]!.ToString());
    }

    [Theory]
    [InlineData("server action Probe\n  in Names: Text List\n  Copy = ListDuplicate(List=Names, SourceList=Names)\n  end\n", "o11")]
    [InlineData("server action Probe\n  in Names: Text List\n  Copy = Other.ListDuplicate(List=Names)\n  end\n", "o11")]
    [InlineData("server action Probe\n  in Names: Text List\n  Copy = ListDuplicate(List=Names)\n  end\n", "odc")]
    public void AmbiguousArgumentsOtherOwnersAndOtherLanesStayUnchanged(string flow, string lane)
    {
        var ops = FlowOps(flow);
        Assert.DoesNotContain(JobNormalizer.Pure(ops, "/ops", lane), n => n["rule"]!.ToString() == SystemCalls.Rule);
        Assert.Equal(flow, ops[0]!["data"]!["flow"]!.ToString());
    }

    [Fact]
    public void AJobActionOfTheSameNameIsNotAssumedToBeTheSystemAction()
    {
        var flow = "server action Probe\n  in Names: Text List\n  Copy = ListDuplicate(List=Names)\n  end\n";
        var ops = FlowOps(flow);
        ops.Add(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "server action ListDuplicate\n  in List: Text List\n  end\n" } });
        Assert.DoesNotContain(JobNormalizer.Pure(ops, "/ops", "o11"), n => n["rule"]!.ToString() == SystemCalls.Rule);
        Assert.Equal(flow, ops[0]!["data"]!["flow"]!.ToString());
    }

    [Fact]
    public void ALabelResolvesTheExactIdOfALaterTextArea()
    {
        try { StudioAssemblies.Bind(); } catch { return; }
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(BlockAcceptanceFamilyTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "block-acceptance-families", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
            ["html"] = "<screen name=\"LabelProbe\" roles=\"Registered\"><var name=\"Body\" type=\"Text\"/><label for=\"DescriptionInput\">Description</label><textarea id=\"DescriptionInput\" bind=\"Body\"/></screen>" } }) }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), null, job, Path.Combine(work, "out.oml")))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
    }

    [Fact]
    public void UploadBindWritesItsBinaryContentProperty()
    {
        Assert.Equal("FileContent", Anvil.Reading.ScreenHtmlTables.Reverse("Upload", Anvil.Reading.ScreenHtmlModuleMode.Widget)["bind"]);
        Assert.Equal("FileContent", Anvil.Reading.ScreenHtmlTables.Reverse("Upload", Anvil.Reading.ScreenHtmlModuleMode.Widget)["content"]);
        Assert.Equal("Variable", Anvil.Reading.ScreenHtmlTables.Reverse("Input", Anvil.Reading.ScreenHtmlModuleMode.Widget)["bind"]);
        try { StudioAssemblies.Bind(); } catch { return; }
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(BlockAcceptanceFamilyTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "block-acceptance-families", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
            ["html"] = "<screen name=\"UploadProbe\" roles=\"Registered\"><var name=\"Data\" type=\"Binary Data\"/><var name=\"FileName\" type=\"Text\"/><upload bind=\"Data\" filename=\"FileName\"/></screen>" } }) }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), null, job, Path.Combine(work, "out.oml")))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
    }

    [Fact]
    public void JavaScriptParameterDocumentationIsReportedWithoutRejectingTheAction()
    {
        try { StudioAssemblies.Bind(); } catch { return; }
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(BlockAcceptanceFamilyTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "block-acceptance-families", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var file = Path.Combine(work, "job.json");
        File.WriteAllText(file, """
            {"base":"reactive-ui.oml","ops":[{"op":"logic","data":{"actions":[{
              "name":"ReadNumber","kind":"client","public":true,"outputs":[{"name":"Number","type":"Integer"}],
              "steps":[{"node":"IJavaScriptNode","as":"Calculate","properties":{"JavaScript":"$parameters.Output = $parameters.Input;"},
                "inputs":[{"name":"Input","type":"Integer","description":"Input documentation"}],
                "outputs":[{"name":"Output","type":"Integer","description":"Output documentation"}],"args":{"Input":"7"}},
                {"assign":{"Number":"Calculate.Output"}}]
            }]}}]}
            """);
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), null, file, Path.Combine(work, "out.oml")))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Equal(2, result["normalizations"]!.AsArray().Count(n => n?["rule"]?.ToString() == JobNormalizer.PropertyDropped));
    }

    private static JsonArray FlowOps(string flow) => new(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = flow } });
}
