using System.Text.Json.Nodes;
using System.Reflection;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class FlowDependencyIsolationTests
{
    private static object Blocked() => Activator.CreateInstance(typeof(ModelSession).GetNestedType("Blocked", BindingFlags.NonPublic)!, nonPublic: true)!;
    private static object? Call(object blocked, string method, params object[] args) => blocked.GetType().GetMethod(method)!.Invoke(blocked, args);

    [Theory]
    [InlineData("<block name=\"BrokenPanel\" actions=\"Initialize\"><div>OtherPanel</div></block>")]
    [InlineData("<block name=\"BrokenPanel\" actions=\"Initialize\"><div>")]
    public void AFailedDocumentBlocksItsDeclaredRootAndNotWordsInItsContent(string html)
    {
        var blocked = Blocked();
        Call(blocked, "Mark", new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } }, 4);
        Assert.NotNull(Call(blocked, "UsedByText", "action BrokenPanel.Initialize\n  end\n"));
        Assert.Null(Call(blocked, "UsedByText", "action OtherPanel.Initialize\n  end\n"));
        Assert.Null(Call(blocked, "UsedByText", "server action ReadCaption\n  out Caption: Text\n  assign Caption = \"BrokenPanel\"\n  end\n"));
    }

    [Fact]
    public void FailedOwnedActionsBlockOnlyTheirOwnerAndExplicitReferences()
    {
        var blocked = Blocked();
        Call(blocked, "MarkFlow", "action Conversation.Initialize\n  end\n", 7);
        Assert.Null(Call(blocked, "UsedByText", "action Attachments.Initialize\n  end\n"));
        Assert.Null(Call(blocked, "UsedByText", "action Attachments.Load\n  Initialize()\n  end\n"));
        Assert.NotNull(Call(blocked, "UsedByText", "action Conversation.Load\n  Initialize()\n  end\n"));
        Assert.NotNull(Call(blocked, "UsedByText", "action Attachments.Load\n  Conversation.Initialize()\n  end\n"));
        Assert.Null(Call(blocked, "Mentioned", "Initialize"));
        Assert.NotNull(Call(blocked, "Mentioned", "Conversation.Initialize"));
        Call(blocked, "MarkFlow", "action Conversation.Load\n  Initialize()\n  end\n", 7);
        Assert.NotNull(Call(blocked, "UsedByText", "action Conversation.Refresh\n  Load()\n  end\n"));
    }

    [Fact]
    public void QualifiedOwnerPathsKeepSeparateFlowsSeparate()
    {
        var blocked = Blocked();
        Call(blocked, "MarkFlow", "action Orders/Detail.Initialize\n  end\n", 7);
        Assert.NotNull(Call(blocked, "UsedByText", "action Orders/Detail.Load\n  Initialize()\n  end\n"));
        Assert.Null(Call(blocked, "UsedByText", "action Inventory/Detail.Load\n  Initialize()\n  end\n"));
        Assert.Null(Call(blocked, "UsedByText", "action Inventory/Detail.Initialize\n  end\n"));
    }

    [Fact]
    public void AFailedDocumentNamesItsMissingWidgetWithoutBlockingHomonymousVariables()
    {
        var blocked = Blocked();
        Call(blocked, "Mark", new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
            ["html"] = "<block name=\"FailedPanel\"><div id=\"OptionsHost\">UnrelatedCaption</div></block>" } }, 9);
        Assert.NotNull(Call(blocked, "Mentioned", "OptionsHost"));
        Assert.Null(Call(blocked, "Mentioned", "UnrelatedCaption"));
        Assert.Null(Call(blocked, "UsedByText", "server action Independent\n  local OptionsHost: Integer\n  assign OptionsHost = 1\n  end\n"));
    }

    [Fact]
    public void LocalNamesDoNotDependOnFailedTypesButDatatypesAndCalleesStillDo()
    {
        var blocked = Blocked();
        Call(blocked, "Mark", JsonNode.Parse("""{"op":"spec","data":{"structures":[{"name":"RecordProbe","attributes":[{"name":"Count","type":"Integer"}]}]}}""")!.AsObject(), 3);
        Assert.Null(Call(blocked, "UsedByText", "server action Fine\n  out RecordProbe: Integer\n  assign RecordProbe = 1\n  end\n"));
        Assert.Null(Call(blocked, "UsedByText", "server action Fine\n  in RecordProbe: Integer\n  out Value: Integer\n  assign Value = RecordProbe + 1\n  end\n"));
        Assert.NotNull(Call(blocked, "UsedByText", "server action NeedsType\n  out RecordProbe: RecordProbe\n  end\n"));
        Assert.NotNull(Call(blocked, "UsedByText", "server action NeedsCall\n  local RecordProbe: Integer\n  RecordProbe()\n  end\n"));
    }

    [Fact]
    public void DiagnosticPatchesMapEveryItemBackAndPreserveBasedOn()
    {
        var data = JsonNode.Parse("""{"flow":["bad",{"text":"first","basedOn":"first-sha"},{"text":"second","basedOn":"second-sha"}]}""")!.AsObject();
        var patch = JsonNode.Parse("""[{"op":"replace","path":"/ops/4/data/flow/0/text","value":"fixed-first"},{"op":"replace","path":"/ops/4/data/flow/1/text","value":"fixed-second"}]""")!.AsArray();
        var mapped = JobRunner.RebaseFlowPatch(patch, "/ops/4/data", data, [1, 2])!;
        Assert.Equal("/ops/4/data/flow/1/text", mapped[0]!["path"]!.ToString());
        Assert.Equal("/ops/4/data/flow/2/text", mapped[1]!["path"]!.ToString());
        var document = new JsonObject { ["ops"] = new JsonArray(null, null, null, null, new JsonObject { ["data"] = data.DeepClone() }) };
        var applied = (JsonNode)typeof(JobRunner).GetMethod("Patched", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, [document, mapped])!;
        Assert.Equal("first-sha", applied["ops"]![4]!["data"]!["flow"]![1]!["basedOn"]!.ToString());
        Assert.Equal("second-sha", applied["ops"]![4]!["data"]!["flow"]![2]!["basedOn"]!.ToString());
    }

    [Fact]
    public void DiagnosticWholeListPatchesKeepExcludedTextsAndTheirReadings()
    {
        var data = JsonNode.Parse("""{"flow":[{"text":"bad","basedOn":"bad-sha"},{"text":"first","basedOn":"first-sha"},"second"]}""")!.AsObject();
        var patch = JsonNode.Parse("""[{"op":"replace","path":"/ops/4/data/flow","value":[{"text":"fixed-first","basedOn":"first-sha"},"fixed-second"]}]""")!.AsArray();
        var mapped = JobRunner.RebaseFlowPatch(patch, "/ops/4/data", data, [1, 2])!;
        var values = mapped[0]!["value"]!.AsArray();
        Assert.Equal(3, values.Count);
        Assert.True(JsonNode.DeepEquals(data["flow"]![0], values[0]));
        Assert.Equal("fixed-first", values[1]!["text"]!.ToString());
        Assert.Equal("first-sha", values[1]!["basedOn"]!.ToString());
        Assert.Equal("fixed-second", values[2]!.ToString());
    }

    [Fact]
    public void BlockedFlowTextsDoNotHideIndependentTextsOrTheirVerifyProblems()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "flow-dependency-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var job = new JsonObject {
            ["base"] = "blank-service.oml",
            ["ops"] = new JsonArray(
                new JsonObject { ["op"] = "logic", ["data"] = new JsonObject {
                    ["flow"] = "server action MissingDependency\n  not a flow statement\n" } },
                new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(
                    "server action IndirectCaller\n  DependentFlow()\n  end\n",
                    "server action IndependentTyped\n  out Code: Integer\n  assign Code = \"abc\"\n  end\n",
                    "server action DependentFlow\n  MissingDependency()\n  end\n",
                    "server action IndependentGood\n  out Count: Integer\n  assign Count = 1\n  end\n") } },
                new JsonObject { ["op"] = "logic", ["data"] = new JsonObject {
                    ["flow"] = "server action LaterCaller\n  DependentFlow()\n  end\n" } })
        };
        var path = Path.Combine(dir, "job.json");
        File.WriteAllText(path, job.ToJsonString());
        var output = Path.Combine(dir, "candidate.oml");
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, output));
        var refusal = Assert.IsType<JobPreflightException>(Errors.FindCoded(error));
        Assert.True(refusal.VerifyRan);
        Assert.Contains(refusal.Problems.OfType<JsonObject>(), p => p["phase"]?.ToString() == "verify"
            && p["code"]?.ToString() == "ExpressionInvalidExpressionType" && p["pointer"]?.ToString() == "/ops/1/data/flow/1");
        var skipped = refusal.Warnings.OfType<JsonObject>().Where(p => p["code"]?.ToString() == "APPLY_SKIPPED").ToList();
        Assert.Contains(skipped, p => p["pointer"]?.ToString() == "/ops/1/data/flow/0");
        Assert.Contains(skipped, p => p["pointer"]?.ToString() == "/ops/1/data/flow/2");
        Assert.Contains(skipped, p => p["pointer"]?.ToString() == "/ops/2/data/flow");
        Assert.DoesNotContain(skipped, p => p["pointer"]?.ToString() is "/ops/1/data/flow/1" or "/ops/1/data/flow/3");
        Assert.DoesNotContain(refusal.Problems.OfType<JsonObject>(), p => p["code"]?.ToString() == "CHILD_NOT_FOUND");
        Assert.False(File.Exists(output));
    }

    [Fact]
    public void AMalformedTextDoesNotHideTheRequiredArgumentOfAnIndependentTextInTheSameOp()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "flow-dependency-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var job = JsonNode.Parse("""
            {"base":"blank-service.oml","expectValid":true,"ops":[
              {"op":"logic","data":{"actions":[{"name":"ReadFlag","inputs":[{"name":"Reset","type":"Boolean","default":"False"}],"outputs":[{"name":"Value","type":"Boolean"}],"steps":[{"assign":{"Value":"Reset"}}]}]}},
              {"op":"logic","data":{"flow":[
                "server action BrokenBody\n  not a flow statement\n",
                "server action DependsOnBroken\n  BrokenBody()\n  end\n",
                "/// BrokenBody is only prose.\nserver action IndependentRequired\n  out Note: Text\n  assign Note = \"BrokenBody\"\n  Probe = ReadFlag()\n  end\n",
                "server action IndependentGood\n  end\n"
              ]}}
            ]}
            """)!;
        var path = Path.Combine(dir, "job.json");
        File.WriteAllText(path, job.ToJsonString());
        var output = Path.Combine(dir, "candidate.oml");
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, output));
        var refusal = Assert.IsType<JobPreflightException>(Errors.FindCoded(error));
        var problems = refusal.Problems.OfType<JsonObject>().ToList();
        Assert.Contains(problems, p => p["code"]?.ToString() == "FLOW_SYNTAX" && p["pointer"]?.ToString() == "/ops/1/data/flow/0");
        var required = Assert.Single(problems, p => p["code"]?.ToString() == "ArgumentRequiredExpression");
        Assert.Equal("/ops/1/data/flow/2", required["pointer"]?.ToString());
        Assert.True(required["afterPatch"]?.GetValue<bool>() == true, required.ToJsonString());
        Assert.Equal("/ops/1/data/flow/2", required["patch"]![0]!["path"]!.ToString());
        Assert.Contains("Reset=False", required["patch"]![0]!["value"]!.ToString());
        Assert.DoesNotContain(problems, p => p["pointer"]?.ToString() == "/ops/1/data/flow/1");
        Assert.False(File.Exists(output));
    }
}
