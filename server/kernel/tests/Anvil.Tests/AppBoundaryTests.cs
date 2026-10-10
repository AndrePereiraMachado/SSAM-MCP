using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

public class AppBoundaryTests
{
    private static string Work()
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(AppBoundaryTests).Assembly.Location)!)!;
        return Path.Combine(root, ".local", "app-boundary-tests", Guid.NewGuid().ToString("N"));
    }
    private static JsonObject Input(string session, string turn, string prompt) => new() { ["session_id"] = session, ["turn_id"] = turn, ["prompt"] = prompt };
    private static JsonObject Proposal() => JsonNode.Parse("""
    {"module":"Probe","lane":"ss5","environment":"fixture.test","data":{"entities":[{"name":"Entry","attributes":[{"name":"Title","type":"Text","length":120}]}]}}
    """)!.AsObject();

    [Fact]
    public void UiSourceIsCapturedAsHighCodeAndCannotBeRewrittenAsRecovery()
    {
        var sessions=new AppSessions(Work());var id=sessions.Capture(Input("ui-session","first","Create a reusable counter block"))["taskId"]!.ToString();
        var proposal=new JsonObject{["module"]="Probe",["lane"]="ss5",["environment"]="fixture.test",["uiSource"]="<component name='Counter'><script type='module'>export let value=0;</script><p>{{value}}</p></component>"};
        Assert.True(sessions.Propose(id,proposal)["accepted"]!.GetValue<bool>());
        Assert.NotNull(sessions.Context(id)["schema"]!["uiSource"]);
        var changed=proposal.DeepClone().AsObject();changed["uiSource"]=changed["uiSource"]!.ToString().Replace("value=0","value=9");
        Assert.Throws<InvalidOperationException>(()=>sessions.Propose(id,changed));
        var mixed=proposal.DeepClone().AsObject();mixed["data"]=Proposal()["data"]!.DeepClone();
        Assert.Throws<ArgumentException>(()=>sessions.Propose(id,mixed));
    }

    [Fact]
    public void OriginalUserEventsAreImmutableAndDoNotComeFromToolArguments()
    {
        var sessions = new AppSessions(Work());
        var first = sessions.Capture(Input("session", "turn", "Create Entry with Title Text 120"));
        var repeated = sessions.Capture(Input("session", "turn", "Create Entry with Title Text 120"));
        Assert.Equal(first["taskId"]!.ToString(), repeated["taskId"]!.ToString());
        Assert.Throws<InvalidOperationException>(() => sessions.Capture(Input("session", "turn", "Replace the original request")));
        Assert.Single(sessions.Context(first["taskId"]!.ToString())["source"]!.AsArray());
        Assert.Throws<InvalidOperationException>(() => sessions.Context(Guid.NewGuid().ToString("N")));
    }

    [Fact]
    public void ChangingAContractNeedsNewUserInputAndAcceptance()
    {
        var sessions = new AppSessions(Work());
        var id = sessions.Capture(Input("session", "first", "Create Entry with Title Text 120"))["taskId"]!.ToString();
        var original = sessions.Propose(id, Proposal()); Assert.True(original["accepted"]!.GetValue<bool>());
        Assert.True(sessions.Propose(id, Proposal())["accepted"]!.GetValue<bool>());
        var weakened = Proposal(); weakened["data"]!["entities"]![0]!["attributes"]![0]!["length"] = 50;
        Assert.Throws<InvalidOperationException>(() => sessions.Propose(id, weakened));
        sessions.Capture(Input("session", "second", "Change the title to 50 characters"));
        var pending = sessions.Propose(id, weakened); Assert.False(pending["accepted"]!.GetValue<bool>());
        Assert.Equal(original["contractHash"]!.ToString(), sessions.Context(id)["contractHash"]!.ToString());
        sessions.Accept(id, pending["contractHash"]!.ToString());
        Assert.Equal(pending["contractHash"]!.ToString(), sessions.Context(id)["contractHash"]!.ToString());
    }

    [Theory]
    [InlineData("Bash")]
    [InlineData("apply_patch")]
    [InlineData("mcp__ssam_hybrid__accept")]
    [InlineData("mcp__other__write")]
    [InlineData("spawn_agent")]
    public void AppSessionCannotUseAlternativeTools(string tool)
    {
        var sessions = new AppSessions(Work()); var id = sessions.Capture(Input("s", "t", "Create data"))["taskId"]!.ToString();
        var guard = sessions.Guard(new() { ["session_id"] = "s", ["tool_name"] = tool, ["tool_input"] = new JsonObject { ["task_id"] = id } });
        Assert.False(guard["allowed"]!.GetValue<bool>());
    }

    [Fact]
    public void ExactToolCallNeedsOneUseHostGrantAndCannotCrossSessions()
    {
        var sessions = new AppSessions(Work()); var id = sessions.Capture(Input("s", "t", "Create data"))["taskId"]!.ToString();
        var args = new JsonObject { ["task_id"] = id };
        Assert.Throws<UnauthorizedAccessException>(() => sessions.ConsumePermit("continue", args));
        Assert.False(sessions.Guard(new() { ["session_id"] = "other", ["tool_name"] = "mcp__ssam_hybrid__continue", ["tool_input"] = args.DeepClone() })["allowed"]!.GetValue<bool>());
        Assert.True(sessions.Guard(new() { ["session_id"] = "s", ["tool_name"] = "mcp__ssam_hybrid__continue", ["tool_input"] = args.DeepClone() })["allowed"]!.GetValue<bool>());
        Assert.Throws<UnauthorizedAccessException>(() => sessions.ConsumePermit("context", args));
        Assert.True(sessions.ConsumePermit("continue", args)["authorized"]!.GetValue<bool>());
        Assert.Throws<UnauthorizedAccessException>(() => sessions.ConsumePermit("continue", args));
    }

    [Fact]
    public void ChangedArgumentsAndStaleAcceptanceAreRefused()
    {
        var sessions = new AppSessions(Work()); var id = sessions.Capture(Input("s", "one", "Create data"))["taskId"]!.ToString();
        var args = new JsonObject { ["task_id"] = id, ["data"] = Proposal()["data"]!.DeepClone() };
        sessions.Guard(new() { ["session_id"] = "s", ["tool_name"] = "mcp__ssam_hybrid__propose", ["tool_input"] = args.DeepClone() });
        args["data"]!["entities"]![0]!["name"] = "Different";
        Assert.Throws<UnauthorizedAccessException>(() => sessions.ConsumePermit("propose", args));
        sessions.Propose(id, Proposal()); sessions.Capture(Input("s", "two", "Change title to 50"));
        var proposal = Proposal(); proposal["data"]!["entities"]![0]!["attributes"]![0]!["length"] = 50;
        var pending = sessions.Propose(id, proposal); sessions.Capture(Input("s", "three", "Keep 120"));
        Assert.Throws<InvalidOperationException>(() => sessions.Accept(id, pending["contractHash"]!.ToString()));
    }

    [Fact]
    public void UncertainModuleReservationSurvivesProcessLifetimeAndOtherLanesCannotTakeIt()
    {
        var work = Work();
        using (var first = new ModuleReservation(work, "env", "module", "task-A"))
            Assert.Throws<InvalidOperationException>(() => new ModuleReservation(work, "env", "module", "task-B"));
        Assert.Throws<InvalidOperationException>(() => new ModuleReservation(work, "env", "module", "task-B"));
        using (var resumed = new ModuleReservation(work, "env", "module", "task-A")) resumed.Release();
        using var next = new ModuleReservation(work, "env", "module", "task-B"); next.Release();
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ToolStatusKeepsEveryDiagnosticAndLeavesFullProofInCheckpoint(bool accepted)
    {
        var sessions = new AppSessions(Work());
        var id = sessions.Capture(Input("s", "t", "Create data"))["taskId"]!.ToString();
        sessions.Propose(id, Proposal()); var prepared = sessions.PrepareDelivery(id);
        var request = DeliveryTask.ResumeRequest(prepared["work"]!.ToString(), prepared["deliveryTaskId"]!.ToString());
        var differences = accepted ? new JsonArray() : new JsonArray(new JsonObject { ["element"] = "Entry/Title", ["expected"] = 120, ["actual"] = 50 });
        using (var delivery = new DeliveryTask(request))
        {
            delivery.State["delivered"] = accepted;
            delivery.State["dataProof"] = new JsonObject { ["accepted"] = accepted, ["count"] = 500,
                ["assertions"] = new JsonArray(Enumerable.Range(0, 500).Select(i => (JsonNode)new JsonObject { ["key"] = i, ["expected"] = "full evidence" }).ToArray()),
                ["expectedTypes"] = new JsonObject { ["Title"] = "Text" }, ["differences"] = differences.DeepClone(),
                ["dataSummary"] = JsonNode.Parse("""[{"name":"Entry","kind":"IServerEntity","attributes":[{},{}],"records":[],"indexes":[{"name":"IX_Title"}]}]""") };
            delivery.State["apply"] = new JsonObject { ["accepted"] = false, ["details"] = new JsonArray("Full diagnostic, with element path") };
            delivery.Save("proof");
        }
        var result = sessions.Refresh(id)["result"]!.AsObject(); var proof = result["dataProof"]!.AsObject();
        Assert.Equal(500, proof["count"]!.GetValue<int>()); Assert.Null(proof["assertions"]); Assert.Null(proof["expectedTypes"]);
        Assert.True(JsonNode.DeepEquals(differences, proof["differences"]));
        Assert.Equal(2, proof["elements"]![0]!["attributes"]!.GetValue<int>());
        Assert.Equal("Full diagnostic, with element path", result["diagnostics"]!["preparation"]!["details"]![0]!.ToString());
        Assert.True(result.ToJsonString().Length < 2000);
        using var checkpoint = new DeliveryTask(request);
        Assert.Equal(500, checkpoint.State["dataProof"]!["assertions"]!.AsArray().Count);
    }

    [Fact]
    public void LogicOnlyContractUsesTheSameDurableTaskAndCannotWeakenItsAccessPolicy()
    {
        var sessions = new AppSessions(Work()); var id = sessions.Capture(Input("s", "t", "Create an authenticated action"))["taskId"]!.ToString();
        var proposal = JsonNode.Parse("""{"module":"Probe","lane":"ss5","environment":"fixture.test","logic":{"actions":[{"name":"Probe_Check","public":true,"access":{"authenticated":true},"outputs":[{"name":"Ok","type":"Boolean"}],"steps":[{"assign":{"Ok":"True"}}]}]}}""")!.AsObject();
        Assert.True(sessions.Propose(id, proposal)["accepted"]!.GetValue<bool>());
        var prepared = sessions.PrepareDelivery(id);
        var request = DeliveryTask.ResumeRequest(prepared["work"]!.ToString(), prepared["deliveryTaskId"]!.ToString());
        Assert.NotNull(request.Specification?["logic"]); Assert.Null(request.Specification?["data"]);
        var changed = proposal.DeepClone().AsObject(); changed["logic"]!["actions"]![0]!["access"]!["authenticated"] = false;
        Assert.ThrowsAny<Exception>(() => sessions.Propose(id, changed));
        var raw = proposal.DeepClone().AsObject(); raw["ops"] = new JsonArray(); Assert.Throws<ArgumentException>(() => sessions.Propose(id, raw));
    }

    [Fact]
    public void MissingOrDifferentBridgeCredentialNeverAuthorizesAWritingClient()
    {
        Assert.False(BridgeAccess.Matches(null, "secret")); Assert.False(BridgeAccess.Matches("wrong", "secret"));
        Assert.True(BridgeAccess.Matches("secret", "secret"));
        Assert.Throws<UnauthorizedAccessException>(() => BridgeAccess.Require(new JsonObject { ["method"] = "merge_from_oml" }, "secret"));
    }

    [Fact]
    public void AuthorityLocationIsExplicitAndDoesNotAcceptRelativePaths()
    {
        var root = Path.GetTempPath();
        Assert.Equal(Path.Combine(root, "Anvil", "authority"), BridgeAccess.ResolveDirectory(null, root));
        var shared = Path.Combine(root, "shared-authority");
        Assert.Equal(Path.GetFullPath(shared), BridgeAccess.ResolveDirectory(shared, root));
        Assert.Throws<InvalidOperationException>(() => BridgeAccess.ResolveDirectory("relative/authority", root));
    }
    [Fact]
    public void WorkspaceScopeDoesNotCaptureOrCreateAuthorityForUnrelatedSessions()
    {
        var (authority, workspace, outside) = ScopedPaths();
        var sessions = new AppSessions(authority, workspace);
        var capture = sessions.Capture(ScopedInput("s", "t", "Private maintenance request", outside));
        Assert.False(capture["captured"]!.GetValue<bool>());
        Assert.False(capture["inScope"]!.GetValue<bool>());
        var guard = sessions.Guard(ScopedTool("unknown", outside, tool: "Bash"));
        Assert.False(guard["allowed"]!.GetValue<bool>());
        Assert.False(guard["inScope"]!.GetValue<bool>());
        Assert.False(Directory.Exists(authority));
    }

    [Fact]
    public void CanonicalWorkspaceAllowsChildrenButRequiresTheCapturedSessionAndTurn()
    {
        var (authority, workspace, outside) = ScopedPaths();
        var child = Directory.CreateDirectory(Path.Combine(workspace, "child")).FullName;
        var sessions = new AppSessions(authority, Path.Combine(child, ".."));
        var id = sessions.Capture(ScopedInput("s", "t", "Create Entry", child))["taskId"]!.ToString();
        var args = new JsonObject { ["task_id"] = id };
        Assert.Equal(workspace, sessions.Context(id)["workspace"]!["root"]!.ToString());
        Assert.False(sessions.Guard(ScopedTool(id, workspace, session: "other"))["allowed"]!.GetValue<bool>());
        Assert.False(sessions.Guard(ScopedTool(id, workspace, turn: "child-turn"))["allowed"]!.GetValue<bool>());
        Assert.False(sessions.Guard(ScopedTool(id, workspace, tool: "spawn_agent"))["allowed"]!.GetValue<bool>());
        Assert.True(sessions.Guard(ScopedTool(id, child))["allowed"]!.GetValue<bool>());
        Assert.Throws<UnauthorizedAccessException>(() => new AppSessions(authority, outside).ConsumePermit("continue", args));
        Assert.Throws<UnauthorizedAccessException>(() => new AppSessions(authority).ConsumePermit("continue", args));
        Assert.True(sessions.ConsumePermit("continue", args)["authorized"]!.GetValue<bool>());
        Assert.Throws<UnauthorizedAccessException>(() => sessions.ConsumePermit("continue", args));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void LeavingWorkspaceRevokesCachedPermitsWithoutCapturingMaintenance(bool leaveThroughTool)
    {
        var (authority, workspace, outside) = ScopedPaths();
        var sessions = new AppSessions(authority, workspace);
        var id = sessions.Capture(ScopedInput("s", "t", "Create Entry", workspace))["taskId"]!.ToString();
        sessions.Propose(id, Proposal());
        var contractHash = sessions.Context(id)["contractHash"]!.ToString();
        var args = new JsonObject { ["task_id"] = id };
        Assert.True(sessions.Guard(ScopedTool(id, workspace))["allowed"]!.GetValue<bool>());
        var result = leaveThroughTool
            ? sessions.Guard(ScopedTool(id, outside, tool: "Bash"))
            : sessions.Capture(ScopedInput("s", "outside", "Private maintenance request", outside));
        Assert.False(result["inScope"]!.GetValue<bool>());
        Assert.False(sessions.Context(id)["workspace"]!["active"]!.GetValue<bool>());
        Assert.Single(sessions.Context(id)["source"]!.AsArray());
        Assert.DoesNotContain("Private maintenance request", File.ReadAllText(Path.Combine(authority, "app-sessions.json")));
        Assert.Throws<UnauthorizedAccessException>(() => new AppSessions(authority, workspace).ConsumePermit("continue", args));
        Assert.Equal(id, sessions.Capture(ScopedInput("s", "resumed", "Continue Entry", workspace))["taskId"]!.ToString());
        Assert.Equal(contractHash, sessions.Context(id)["contractHash"]!.ToString());
        Assert.Equal(2, sessions.Context(id)["source"]!.AsArray().Count);
        Assert.Throws<UnauthorizedAccessException>(() => sessions.ConsumePermit("continue", args));
        Assert.True(sessions.Guard(ScopedTool(id, workspace, turn: "resumed"))["allowed"]!.GetValue<bool>());
        Assert.True(sessions.ConsumePermit("continue", args)["authorized"]!.GetValue<bool>());
    }

    [Fact]
    public void ScopedBootstrapDoesNotAdoptLegacyTasksOrRewriteTheirStorage()
    {
        var (authority, workspace, _) = ScopedPaths();
        var legacy = new AppSessions(authority);
        var id = legacy.Capture(Input("legacy", "one", "Existing request"))["taskId"]!.ToString();
        legacy.Propose(id, Proposal());
        var before = legacy.Context(id);
        var scoped = new AppSessions(authority, workspace);
        Assert.False(scoped.Capture(ScopedInput("legacy", "two", "Do not adopt this", workspace))["captured"]!.GetValue<bool>());
        Assert.True(JsonNode.DeepEquals(before, legacy.Context(id)));
        var args = new JsonObject { ["task_id"] = id };
        Assert.True(legacy.Guard(new() { ["session_id"] = "legacy", ["tool_name"] = "mcp__ssam_hybrid__continue", ["tool_input"] = args.DeepClone() })["allowed"]!.GetValue<bool>());
        Assert.Throws<UnauthorizedAccessException>(() => scoped.ConsumePermit("continue", args));
        Assert.True(legacy.ConsumePermit("continue", args)["authorized"]!.GetValue<bool>());
        Assert.NotEqual(id, scoped.Capture(ScopedInput("new", "one", "New Hybrid request", workspace))["taskId"]!.ToString());
    }

    [Fact]
    public void AnotherWorkspaceCannotRebindAnExistingScopedSession()
    {
        var (authority, workspace, other) = ScopedPaths();
        var sessions = new AppSessions(authority, workspace);
        var id = sessions.Capture(ScopedInput("s", "t", "Original request", workspace))["taskId"]!.ToString();
        Assert.True(sessions.Guard(ScopedTool(id, workspace))["allowed"]!.GetValue<bool>());
        Assert.False(new AppSessions(authority, other).Capture(ScopedInput("s", "different", "Wrong workspace", other))["captured"]!.GetValue<bool>());
        Assert.Single(sessions.Context(id)["source"]!.AsArray());
        Assert.False(sessions.Context(id)["workspace"]!["active"]!.GetValue<bool>());
        Assert.Throws<UnauthorizedAccessException>(() => sessions.ConsumePermit("continue", new JsonObject { ["task_id"] = id }));
    }

    private static (string Authority, string Workspace, string Outside) ScopedPaths()
    {
        var work = Work();
        return (Path.Combine(work, "authority"), Directory.CreateDirectory(Path.Combine(work, "hybrid")).FullName,
            Directory.CreateDirectory(Path.Combine(work, "hybrid-other")).FullName);
    }
    private static JsonObject ScopedInput(string session, string turn, string prompt, string cwd)
    {
        var input = Input(session, turn, prompt); input["cwd"] = cwd; return input;
    }
    private static JsonObject ScopedTool(string id, string cwd, string session = "s", string turn = "t", string tool = "mcp__ssam_hybrid__continue")
        => new() { ["session_id"] = session, ["turn_id"] = turn, ["cwd"] = cwd, ["tool_name"] = tool,
            ["tool_input"] = new JsonObject { ["task_id"] = id } };

}
