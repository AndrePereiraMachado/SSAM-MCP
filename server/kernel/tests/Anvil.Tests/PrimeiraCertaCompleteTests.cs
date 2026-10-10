using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// primeira-certa, second round (A4, A6, A7, A3 of the kernel): the refusal of the first answer carries everything.
/// A6: a logic op whose action fails at apply runs again without it, so its other actions reach the Verify. A7: a refusal
/// of one phase alone keeps its code and still says verifyRan, phases and problems. A4: exact fixes with patches (a site
/// property without Site., the one built-in an unknown function means, the output or input of a job action written
/// wrong) and the syntax of every expression. A3: the delivery no longer refuses the pure preflight before the capture.
/// </summary>
public sealed class PrimeiraCertaCompleteTests
{
    private static readonly string Root = PacoteBPolicyTests.FindRoot();

    private static string Dir()
    {
        var dir = Path.Combine(Root, ".local", "pa4-pc2-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static (JsonNode? Result, Exception? Error, string Output) Run(string dir, string name, string job, string? output = null)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        output ??= Path.Combine(dir, name + ".oml");
        try { return (JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, output)), null, output); }
        catch (Exception ex) { return (null, ex, output); }
    }

    private static JsonObject[] Pure(string dir, string name, string job)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        return JobPreflight.Check(path)["problems"]!.AsArray().OfType<JsonObject>().ToArray();
    }

    // ---- A6 ---------------------------------------------------------------------------------------------------------------

    [Fact]
    public void ALogicOpWithAFailingActionStillVerifiesItsOtherActions()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var (_, error, output) = Run(dir, "isolated", """
        {"base":"blank-service.oml","ops":[
          {"op":"logic","data":{"actions":[
            {"name":"PcGood","outputs":[{"name":"Code","type":"Integer"}],"steps":[{"assign":{"Code":"\"abc\""}}]},
            {"name":"PcBroken","outputs":[{"name":"N","type":"Integer"}],"steps":[{"call":"PcNoSuchAction","as":"Nope"},{"assign":{"N":"1"}}]},
            {"name":"PcUsesBroken","steps":[{"call":"PcBroken","as":"Again"}]}]}}]}
        """);
        var refused = Assert.IsType<JobPreflightException>(Errors.FindCoded(error!));
        Assert.True(refused.VerifyRan);
        var problems = refused.Problems.OfType<JsonObject>().ToArray();
        // The failed action points at itself in the op as written; the Verify of the action that applied comes with it.
        var apply = Assert.Single(problems, p => p["phase"]!.GetValue<string>() == "apply");
        Assert.StartsWith("/ops/0/data/actions/1", apply["pointer"]!.GetValue<string>());
        var verify = Assert.Single(problems, p => p["phase"]!.GetValue<string>() == "verify");
        Assert.Equal("ExpressionInvalidExpressionType", verify["code"]!.GetValue<string>());
        Assert.Equal("/ops/0/data/actions/0/steps/0/assign/Code", verify["pointer"]!.GetValue<string>());
        // The action that calls the failed one is left out, and said.
        Assert.Contains(refused.Warnings, w => w!["code"]!.GetValue<string>() == "APPLY_SKIPPED" && w["pointer"]!.GetValue<string>() == "/ops/0/data/actions/2");
        Assert.False(File.Exists(output));
    }

    /// <summary>The replay of 2026-10-10 (DCIPS_Reference_CS): an action whose name an element of another kind takes is
    /// renamed by the Studio (NAME_COLLISION); without its anchor the isolation left the renamed action half-built and the
    /// Verify reported it (InvalidFlow_NoStart) as a fault of its own.</summary>
    [Fact]
    public void AnActionTheStudioRenamedIsRemovedWithItsFailure()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        // The name is taken by an action of a referenced producer (a frozen signature bound by name): the Studio renames.
        var signature = Path.Combine(Root, "tests", "contracts", "native-reference", "ordinal-primitive.avsig");
        var job = Path.Combine(dir, "collision.json");
        File.WriteAllText(job, """
        {"base":"blank-service.oml","ops":[
          {"op":"reference","producer":"Runtime","elements":["IServerAction:CSharpTextCompareOrdinal"]},
          {"op":"logic","data":{"actions":[
            {"name":"CSharpTextCompareOrdinal","outputs":[{"name":"N","type":"Integer"}],"steps":[{"assign":{"N":"1"}}]},
            {"name":"PcOther","outputs":[{"name":"Code","type":"Integer"}],"steps":[{"assign":{"Code":"\"abc\""}}]}]}}]}
        """);
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, Path.Combine(dir, "collision.oml"),
            bindings: new Dictionary<string, string> { ["Runtime"] = signature }));
        var problems = Assert.IsType<JobPreflightException>(Errors.FindCoded(error)).Problems.OfType<JsonObject>().ToArray();
        Assert.Contains(problems, p => p["code"]!.GetValue<string>() == "NAME_COLLISION" && p["pointer"]!.GetValue<string>() == "/ops/1/data/actions/0");
        Assert.Contains(problems, p => p["phase"]!.GetValue<string>() == "verify" && p["pointer"]!.GetValue<string>() == "/ops/1/data/actions/1/steps/0/assign/Code");
        Assert.DoesNotContain(problems, p => p["code"]!.GetValue<string>() == "InvalidFlow_NoStart");
    }

    // ---- A7 ---------------------------------------------------------------------------------------------------------------

    [Fact]
    public void ARefusalOfTheApplyAloneKeepsItsCodeAndSaysEverything()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var (_, error, _) = Run(dir, "lone", """
        {"base":"blank-service.oml","ops":[
          {"op":"logic","data":{"actions":[
            {"name":"PcOld","outputs":[{"name":"R","type":"Integer"}],"steps":[{"assign":{"R":"1"}}]},
            {"name":"PcUsesOld","outputs":[{"name":"R","type":"Integer"}],"steps":[{"call":"PcOld","as":"Old"},{"assign":{"R":"Old.R"}}]}]}},
          {"op":"delete","target":"IServerAction:PcOld"}]}
        """);
        var envelope = Errors.Envelope("apply", error!, 1);
        Assert.Equal("DELETE_HAS_CONSUMERS", envelope["code"]!.GetValue<string>());
        Assert.True(envelope["verifyRan"]!.GetValue<bool>());
        Assert.Equal("apply", Assert.Single(envelope["phases"]!.AsArray())!.GetValue<string>());
        Assert.All(envelope["problems"]!.AsArray(), p => Assert.Equal("apply", p!["phase"]!.GetValue<string>()));
        Assert.NotEmpty(envelope["problems"]!.AsArray());
    }

    [Fact]
    public void AnIsolatedActionThatFailsAloneKeepsTheCodeOfItsRefusal()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var (_, error, _) = Run(dir, "lone-logic", """
        {"base":"blank-service.oml","ops":[
          {"op":"logic","data":{"actions":[
            {"name":"PcFine","outputs":[{"name":"N","type":"Integer"}],"steps":[{"assign":{"N":"1"}}]},
            {"name":"PcBroken","outputs":[{"name":"N","type":"Integer"}],"steps":[{"call":"PcNoSuchAction","as":"Nope"},{"assign":{"N":"1"}}]}]}}]}
        """);
        var envelope = Errors.Envelope("apply", error!, 1);
        Assert.Equal("LOGIC_INVALID", envelope["code"]!.GetValue<string>());
        Assert.True(envelope["verifyRan"]!.GetValue<bool>());
        var problem = Assert.Single(envelope["problems"]!.AsArray());
        Assert.StartsWith("/ops/0/data/actions/1", problem!["pointer"]!.GetValue<string>());
        Assert.Equal("apply", problem["phase"]!.GetValue<string>());
    }

    /// <summary>The replay of 2026-10-10 (chains 015, 055): a frozen producer signature without an element the job names
    /// stopped before the apply with the bare exception; it keeps it and says verifyRan, phases and the problem.</summary>
    [Fact]
    public void AFrozenSignatureWithoutTheElementSaysEverythingToo()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var signature = Path.Combine(Root, "tests", "contracts", "native-reference", "ordinal-primitive.avsig");
        var job = Path.Combine(dir, "frozen.json");
        File.WriteAllText(job, """
        {"base":"blank-service.oml","ops":[{"op":"reference","producer":"Runtime","elements":["IServerAction:PcNoSuchAction"]}]}
        """);
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, Path.Combine(dir, "frozen.oml"),
            bindings: new Dictionary<string, string> { ["Runtime"] = signature }));
        Assert.IsType<ArgumentException>(error);                        // its own exception, as before
        var envelope = Errors.Envelope("apply", error, 1);
        Assert.False(envelope["verifyRan"]!.GetValue<bool>());
        Assert.Contains("did not run", envelope["verifyReason"]!.GetValue<string>());
        var problem = Assert.Single(envelope["problems"]!.AsArray());
        Assert.Equal("REFERENCE_ELEMENT_MISSING", problem!["code"]!.GetValue<string>());
        Assert.Equal("/ops/0/elements/0", problem["pointer"]!.GetValue<string>());
    }

    /// <summary>A candidate only the Verify refuses (no op failed) answers its errors in the single refusal's format too
    /// (data.problems: op, pointer into the job, element, key, fix), next to the validation it always carried.</summary>
    [Fact]
    public void ACandidateOnlyTheVerifyRefusesCarriesItsProblems()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var (result, error, _) = Run(dir, "verify-only", """
        {"base":"blank-service.oml","ops":[{"op":"logic","data":{"actions":[{"name":"PcTyped","outputs":[{"name":"Code","type":"Integer"}],"steps":[{"assign":{"Code":"\"abc\""}}]}]}}]}
        """);
        Assert.True(error == null, error?.ToString());
        Assert.False(result!["accepted"]!.GetValue<bool>());
        Assert.True(result["verifyRan"]!.GetValue<bool>());
        var problem = Assert.Single(result["problems"]!.AsArray());
        Assert.Equal("ExpressionInvalidExpressionType", problem!["code"]!.GetValue<string>());
        Assert.Equal("/ops/0/data/actions/0/steps/0/assign/Code", problem["pointer"]!.GetValue<string>());
        Assert.Contains("TextToInteger", problem["fix"]!.GetValue<string>());
        Assert.False(string.IsNullOrEmpty(problem["key"]?.GetValue<string>()));
    }

    // ---- A4 ---------------------------------------------------------------------------------------------------------------

    [Fact]
    public void ASitePropertyWithoutSiteIsPatched()
    {
        var problems = Pure(Dir(), "site", """
        {"base":"blank-service.oml","ops":[
          {"op":"create","parent":"@espace","type":"ISiteProperty","name":"PcMaxDays"},
          {"op":"logic","data":{"actions":[{"name":"PcReadSite","outputs":[{"name":"D","type":"Integer"}],"steps":[{"assign":{"D":"PcMaxDays + 1"}}]}]}}]}
        """);
        var site = Assert.Single(problems, p => p["code"]!.GetValue<string>() == "EXPR_UNKNOWN_IDENTIFIER");
        Assert.Equal("/ops/1/data/actions/0/steps/0/assign/D", site["pointer"]!.GetValue<string>());
        Assert.Equal("Site.PcMaxDays + 1", site["patch"]![0]!["value"]!.GetValue<string>());
        Assert.Contains("Site.PcMaxDays", site["fix"]!.GetValue<string>());
    }

    [Fact]
    public void ASitePropertyOfTheBaseIsPatchedToo()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var (built, buildError, basePath) = Run(dir, "site-base", """
        {"base":"blank-service.oml","ops":[{"op":"create","parent":"@espace","type":"ISiteProperty","name":"PcAlertDays"},
          {"op":"set","target":"ISiteProperty:PcAlertDays","prop":"DataType","value":"Integer"}]}
        """, Path.Combine(dir, "work", "site-base.oml"));
        Assert.True(buildError == null, buildError?.ToString());
        Assert.True(built!["isValid"]!.GetValue<bool>(), built["details"]?.ToJsonString());
        var (_, error, _) = Run(dir, "site-use", $$$"""
        {"base":"{{{basePath.Replace('\\', '/')}}}","ops":[
          {"op":"logic","data":{"actions":[{"name":"PcReadAlert","outputs":[{"name":"D","type":"Integer"}],"steps":[{"assign":{"D":"PcAlertDays"}}]}]}}]}
        """);
        var problem = Assert.Single(Assert.IsType<JobPreflightException>(Errors.FindCoded(error!)).Problems.OfType<JsonObject>(),
            p => p["code"]!.GetValue<string>() == "EXPR_UNKNOWN_IDENTIFIER");
        Assert.Equal("Site.PcAlertDays", problem["patch"]![0]!["value"]!.GetValue<string>());
    }

    [Fact]
    public void AnUnknownFunctionWithOneCertainBuiltinIsPatched()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var (_, error, _) = Run(dir, "nulldatetime", """
        {"base":"blank-service.oml","ops":[
          {"op":"logic","data":{"actions":[{"name":"PcWhen","outputs":[{"name":"At","type":"Date Time"},{"name":"S","type":"Text"}],"steps":[
            {"assign":{"At":"If(True, NullDateTime(), CurrDateTime())"}},
            {"assign":{"S":"\"NullDateTime()\" + DateTimeToText(NullDateTime())"}}]}]}}]}
        """);
        var unknown = Assert.Single(Assert.IsType<JobPreflightException>(Errors.FindCoded(error!)).Problems.OfType<JsonObject>(),
            p => p["code"]!.GetValue<string>() == "FUNCTION_UNKNOWN");
        var patch = unknown["patch"]!.AsArray();
        Assert.Equal(2, patch.Count);
        Assert.Equal("If(True, NullDate(), CurrDateTime())", patch[0]!["value"]!.GetValue<string>());
        // A text that only looks like the call stays as written.
        Assert.Equal("\"NullDateTime()\" + DateTimeToText(NullDate())", patch[1]!["value"]!.GetValue<string>());
        Assert.Contains("NullDate", unknown["fix"]!.GetValue<string>());
        Assert.Equal("NullDate", FunctionCatalog.Certain("NullDateTime"));
        Assert.Null(FunctionCatalog.Certain("Left"));        // Substr takes other arguments: no rename is certain
    }

    [Fact]
    public void TheSignaturesOfTheJobsOwnActionsAreCrossCheckedWithPatches()
    {
        var problems = Pure(Dir(), "signatures", """
        {"base":"blank-service.oml","ops":[
          {"op":"logic","data":{"actions":[
            {"name":"PcCalc","inputs":[{"name":"Quantity","type":"Integer"}],"outputs":[{"name":"Total","type":"Integer"},{"name":"Code","type":"Text"}],"steps":[{"assign":{"Total":"Quantity","Code":"\"x\""}}]},
            {"name":"PcUse","outputs":[{"name":"R","type":"Integer"}],"steps":[
              {"call":"PcCalc","as":"Calc","args":{"Quantty":"2"}},
              {"assign":{"R":"Calc.Totl"}}]}]}}]}
        """);
        var output = Assert.Single(problems, p => p["code"]!.GetValue<string>() == "EXPR_UNKNOWN_IDENTIFIER");
        Assert.Equal("Calc.Total", output["patch"]![0]!["value"]!.GetValue<string>());
        var argument = Assert.Single(problems, p => p["code"]!.GetValue<string>() == "ARGUMENT_UNKNOWN");
        var patch = argument["patch"]!.AsArray();
        Assert.Equal("add", patch[0]!["op"]!.GetValue<string>());
        Assert.Equal("/ops/0/data/actions/1/steps/0/args/Quantity", patch[0]!["path"]!.GetValue<string>());
        Assert.Equal("remove", patch[1]!["op"]!.GetValue<string>());
        Assert.Equal("/ops/0/data/actions/1/steps/0/args/Quantty", patch[1]!["path"]!.GetValue<string>());
        // The mandatory input it means is still said (the same patch fixes both).
        Assert.Contains(problems, p => p["code"]!.GetValue<string>() == "REQUIRED_ARGUMENT");
    }

    [Fact]
    public void TheSyntaxOfEveryExpressionIsJudgedBeforeAnyModel()
    {
        var problems = Pure(Dir(), "syntax", """
        {"base":"blank-service.oml","ops":[
          {"op":"logic","data":{"actions":[{"name":"PcSyntax","inputs":[{"name":"A","type":"Integer"},{"name":"B","type":"Integer"}],
            "outputs":[{"name":"X","type":"Boolean"},{"name":"Y","type":"Integer"},{"name":"Z","type":"Boolean"},{"name":"W","type":"Text"},{"name":"Ok","type":"Boolean"}],"steps":[
            {"assign":{"X":"A == B"}},
            {"assign":{"Y":"Length(\"ab\""}},
            {"assign":{"Z":"A > 1 && B > 1"}},
            {"assign":{"W":"'ab'"}},
            {"assign":{"Ok":"not (A = B) and If(A > B, True, False) and Index(\"a,b\", \",\") <> -1"}}]}]}}]}
        """);
        var syntax = problems.Where(p => p["code"]!.GetValue<string>() == "EXPRESSION_SYNTAX").Select(p => p["pointer"]!.GetValue<string>()).ToArray();
        Assert.Equal(new[] { "X", "Y", "Z", "W" }.Select((k, i) => $"/ops/0/data/actions/0/steps/{i}/assign/{k}"), syntax);
        Assert.All(problems.Where(p => p["code"]!.GetValue<string>() == "EXPRESSION_SYNTAX"), p => Assert.False(string.IsNullOrWhiteSpace(p["fix"]?.GetValue<string>())));
        foreach (var valid in new[] { "-A + (B * 2)", "L[0].Name", "F(x).Name", "\"a\"\"b\" + \"c\"", "#2026-10-10#", "not A", "CurrDate()", "A mod 3", "x like \"%a%\"", "a = -1" })
            Assert.Null(Anvil.Core.Preflight.ExpressionSyntax.Check(valid));
        foreach (var invalid in new[] { "a b", "(a", "a)", "F(a,)", "a +", "= a", "a != b", "a || b", "x;", "#2026-10-10", "()", "L[]", "a, b" })
            Assert.NotNull(Anvil.Core.Preflight.ExpressionSyntax.Check(invalid));
    }

    // ---- A3 (kernel delivery) ---------------------------------------------------------------------------------------------

    private const string PureInvalidJob = """
    {"ops":[{"op":"logic","data":{"actions":[{"name":"PcPure","outputs":[{"name":"D","type":"Integer"}],"steps":[{"assign":{"D":"ExpiryAlertDays"}}]}]}}]}
    """;

    [Fact]
    public void TheDeliveryRefusesThePurePreflightOnlyWithTheApplyOverTheCapture()
    {
        var (work, job) = DeliveryJob(PureInvalidJob);
        var bridge = new Bridge();
        var applied = 0;
        var union = JobPreflight.Problem(0, "/ops/0/data/actions/0/steps/0/assign/D", "EXPR_UNKNOWN_IDENTIFIER", "error", "can't identify 'ExpiryAlertDays'", "declare it");
        union["phase"] = "preflight";
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), (_, _, _) =>
        {
            applied++;
            throw new JobPreflightException("op #0 (logic) [EXPR_UNKNOWN_IDENTIFIER]: can't identify 'ExpiryAlertDays'", new JsonArray(union)) { VerifyRan = true, Phases = ["preflight", "verify"] };
        });
        Assert.Equal(1, applied);                                        // the apply over the capture ran
        Assert.Contains("snapshot_module", bridge.Calls);
        Assert.DoesNotContain("merge_from_oml", bridge.Calls);
        Assert.Equal(Delivery.PreflightRefused, result["code"]!.ToString());
        Assert.True(result["verifyRan"]!.GetValue<bool>());
        Assert.Equal(2, result["phases"]!.AsArray().Count);
        Assert.False(result["delivered"]!.GetValue<bool>());
    }

    [Fact]
    public void WithoutACaptureThePurePreflightAnswersAndSaysWhy()
    {
        var (work, job) = DeliveryJob(PureInvalidJob);
        var result = Delivery.Run(new Bridge { BlockOpen = true }, new DeliveryRequest("Probe", job, work, []), (_, _, _) => throw new Exception("must not apply"));
        Assert.Equal(Delivery.PreflightRefused, result["code"]!.ToString());
        Assert.False(result["verifyRan"]!.GetValue<bool>());
        Assert.Contains("open_module is blocked", result["verifyReason"]!.ToString());
        Assert.Contains(result["problems"]!.AsArray(), p => p!["code"]!.ToString() == "EXPR_UNKNOWN_IDENTIFIER");
        Assert.Null(result["sources"]);
    }

    private static (string Work, string Job) DeliveryJob(string text)
    {
        var work = Dir();
        var job = Path.Combine(work, "job.json"); File.WriteAllText(job, text);
        return (work, job);
    }

    /// <summary>A Studio that opens the module, names it active, takes a snapshot, and records every call.</summary>
    private sealed class Bridge : IBridgeClient
    {
        public bool BlockOpen;
        public List<string> Calls { get; } = [];
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Calls.Add(method);
            switch (method)
            {
                case "open_module": return BlockOpen ? new() { ["opened"] = false, ["hint"] = "a dialog is open" } : new() { ["opened"] = true };
                // No environment: no module reservation is written anywhere.
                case "get_active_module": return new() { ["name"] = "Probe", ["key"] = "pc-key" };
                case "capabilities": return new() { ["capabilities"] = new JsonArray() };
                case "snapshot_module":
                    File.WriteAllText(parameters!["path"]!.ToString(), "base");
                    return new() { ["key"] = "pc-key", ["snapshot_id"] = "s1", ["path"] = parameters["path"]!.ToString() };
                default: throw new Exception("Unexpected call: " + method);
            }
        }
    }
}
