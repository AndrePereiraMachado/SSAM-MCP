using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R1 (escopo-kernel, 2026-10-24): the contract of the scope phase in JobRunner, on the reactive-ui fixture (headless, the
/// installed Studio's DLLs): a job with a scope problem is refused once, its op never built, with the problems of every
/// phase that ran (phases preflight, base, scope; verifyRan false); a job without one goes on to the apply and its receipt
/// says the time of the phase (timings.scopeMs).
/// </summary>
public sealed class ScopeStopTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScopeStopTests).Assembly.Location)!)!;

    private const string Block = """
        {"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileBlock","name":"ScopeStopCard","as":"$card"},
        {"op":"create","parent":"$card","type":"ILocalVariable","name":"ScopeStopTotal","as":"$total"},
        {"op":"set","target":"$total","prop":"DataType","value":"Integer"},
        {"op":"create","parent":"$card","type":"IExpression","name":"ScopeStopExpr","as":"$e"}
        """;

    // integ/proto-into-product: under the candidate's T16 rule (one refusal with the problems of every phase, never a chain)
    // the scope phase no longer stops the job before its first op: the op it refuses is never built (no cascade of what can
    // only fail), the other ops are, and the job is refused once with the scope's problem.
    [Fact]
    public void AScopeProblemIsRefusedOnceAndItsOpIsNeverBuilt()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (error, _) = Run("stop", Block + """,{"op":"set","target":"$e","prop":"Value","value":"ScopeStopMissing + 1"}""");
        Assert.NotNull(error);
        var problems = (Errors.FindCoded(error!)?.Problems ?? new JsonArray()).OfType<JsonObject>().ToList();
        var problem = Assert.Single(problems, p => p["code"]!.ToString() == "SCOPE_UNKNOWN_IDENTIFIER");
        Assert.Equal("scope", problem["phase"]!.ToString());
        Assert.Equal("/ops/4/value", problem["pointer"]!.ToString());
        // The refused op was never built: nothing of the apply or the Verify on it (the cascade ExpressionUnknownObject).
        Assert.DoesNotContain(problems, p => p["phase"]?.ToString() is "apply" or "verify" && (p["pointer"]?.ToString() ?? "").StartsWith("/ops/4", StringComparison.Ordinal));
        Assert.DoesNotContain(problems, p => p["code"]?.ToString() == "ExpressionUnknownObject");
    }

    [Fact]
    public void AJobWithoutScopeProblemsIsBuiltAndItsReceiptHasTheTimeOfThePhase()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (error, result) = Run("pass", Block + """,{"op":"set","target":"$e","prop":"Value","value":"ScopeStopTotal + 1"}""");
        Assert.True(error == null, error?.ToString());
        Assert.NotNull(result!["timings"]!["scopeMs"]);
    }

    private static (Exception? Error, JsonObject? Result) Run(string name, string ops)
    {
        var dir = Path.Combine(Root, ".local", "scope-stop-tests", name + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        var jobPath = Path.Combine(dir, name + ".json");
        File.WriteAllText(jobPath, $$"""{"expectValid":true,"ops":[{{ops}}]}""");
        try
        {
            var result = JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml"), jobPath, Path.Combine(dir, name + ".oml"));
            return (null, JsonSerializer.SerializeToNode(result)!.AsObject());
        }
        catch (Exception ex) { return (ex, null); }
    }
}
