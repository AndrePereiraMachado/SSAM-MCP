using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>R2-H (review H1, the family): a lone coded refusal raised without problems of its own
/// (KernelRefusalException(code, message): ROLE_ACTION_REQUIRES_SERVER and the like) never answers problems:[]. Its caller
/// attaches the problem it knows (code, op, pointer, phase), and the envelope says it whether or not the refusal went through
/// the diagnosis (Errors.Annotate) first; a refusal with problems of its own keeps them as they are.</summary>
public class LoneRefusalProblemsTests
{
    private static JsonObject Problem(string code) => new()
    {
        ["op"] = 13, ["pointer"] = "/ops/13", ["code"] = code, ["severity"] = "error", ["phase"] = "apply",
        ["message"] = "a client action calls a role action", ["fix"] = "call it from a server action",
    };

    [Fact]
    public void ALoneCodedRefusalWithoutProblemsAnswersTheAttachedOne()
    {
        var refusal = new KernelRefusalException("ROLE_ACTION_REQUIRES_SERVER", "op #13 (logic Approve): a client action calls a role action");
        Errors.AttachProblems(refusal, [Problem("ROLE_ACTION_REQUIRES_SERVER")]);
        var envelope = Errors.Envelope("apply", refusal, 0);
        Assert.Equal("ROLE_ACTION_REQUIRES_SERVER", envelope["code"]?.ToString());
        var problem = Assert.Single(Assert.IsType<JsonArray>(envelope["problems"]).OfType<JsonObject>());
        Assert.Equal(13, problem["op"]!.GetValue<int>());
        Assert.Equal("/ops/13", problem["pointer"]?.ToString());
        Assert.Equal("apply", problem["phase"]?.ToString());
        Assert.Single(Errors.ProblemsOf(refusal));
    }

    [Fact]
    public void AnEmptyDiagnosisListNeverHidesTheAttachedProblem()
    {
        // The diagnosis of one phase alone (primeira-certa A7) annotated with an empty list: the envelope still says the problem.
        var refusal = new KernelRefusalException("ROLE_ACTION_REQUIRES_SERVER", "op #13 (logic Approve): a client action calls a role action");
        Errors.AttachProblems(refusal, [Problem("ROLE_ACTION_REQUIRES_SERVER")]);
        Errors.Annotate(refusal, true, null, ["preflight", "base", "apply", "verify"], new JsonArray());
        var envelope = Errors.Envelope("apply", refusal, 0);
        Assert.Single(Assert.IsType<JsonArray>(envelope["problems"]));
        Assert.True(envelope["verifyRan"]!.GetValue<bool>());
    }

    [Fact]
    public void AnEmptyOwnListGivesWayToTheDiagnosisProblems()
    {
        var refusal = new KernelRefusalException("DELETE_HAS_CONSUMERS", "op #2 (delete X): consumers", new JsonArray());
        Errors.Annotate(refusal, false, "not run", ["apply"], new JsonArray(Problem("DELETE_HAS_CONSUMERS")));
        Assert.Single(Assert.IsType<JsonArray>(Errors.Envelope("apply", refusal, 0)["problems"]));
    }

    [Fact]
    public void ARefusalWithProblemsOfItsOwnKeepsThem()
    {
        var own = Problem("DELETE_HAS_CONSUMERS");
        own["pointer"] = "Entity:Order";
        var refusal = new KernelRefusalException("DELETE_HAS_CONSUMERS", "op #2 (delete X): consumers", new JsonArray(own));
        Errors.AttachProblems(refusal, [Problem("OTHER")]);
        var problems = Assert.IsType<JsonArray>(Errors.Envelope("apply", refusal, 0)["problems"]);
        Assert.Equal("Entity:Order", Assert.Single(problems)!["pointer"]?.ToString());
        Assert.Null(Errors.AttachedProblems(refusal));
    }
}
