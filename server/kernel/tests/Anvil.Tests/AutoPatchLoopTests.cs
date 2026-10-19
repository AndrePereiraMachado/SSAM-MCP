using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

public sealed class AutoPatchLoopTests
{
    private static JsonArray Ops() => new(new JsonObject { ["op"] = "set", ["value"] = "before" },
        new JsonObject { ["op"] = "set", ["value"] = "second before" });

    private static JsonObject Problem(int op = 0, string rule = "TEXT_LITERAL_QUOTED", string value = "after")
    {
        var problem = JobPreflight.Problem(op, $"/ops/{op}/value", "HTML_INVALID", "error", "an invalid expression", "quote its literal",
            new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = $"/ops/{op}/value", ["value"] = value }), patchRule: rule);
        problem["phase"] = "apply";
        return JobPreflight.PublicProblem(problem);
    }

    private static JobPreflightException Refusal(params JsonObject[] problems)
        => new("refusal", new JsonArray(problems.Select(p => (JsonNode)p).ToArray())) { VerifyRan = true, Phases = ["apply", "verify"] };

    [Fact]
    public void CertainCorrectionsContinueToTheFinalAcceptedExecution()
    {
        var calls = 0;
        var result = Assert.IsType<JobRunner.AutoPatchResult>(JobRunner.AutoPatchLoop(Refusal(Problem()), Ops(), "/ops", (ops, probe) => {
            calls++; Assert.True(probe.Final); Assert.Equal("after", ops[0]!["value"]!.ToString());
            return new JsonObject { ["accepted"] = true };
        }));
        Assert.Equal(1, calls); Assert.Equal(1, result.Rounds); Assert.Single(result.Problems);
    }

    [Fact]
    public void AChoiceAlongsideACertainCorrectionPreservesTheWholeSingleRefusal()
    {
        var refusal = Refusal(Problem(), Problem(1, "NEAREST_NAME"));
        var result = JobRunner.AutoPatchLoop(refusal, Ops(), "/ops", (_, _) => throw new InvalidOperationException("must not execute"));
        Assert.Same(refusal, result); Assert.Equal(2, refusal.Problems.Count);
    }

    [Theory]
    [InlineData(false, true, "/ops")]
    [InlineData(true, false, "/ops")]
    [InlineData(true, true, null)]
    public void OptOutInvalidExpectationAndCompositeJobsNeverAutoApply(bool enabled, bool valid, string? pointer)
        => Assert.False(JobRunner.AutoPatchApplies(Refusal(Problem()), enabled, valid, pointer));

    [Fact]
    public void ANewChoiceAfterTheFirstCorrectionJoinsTheSingleRefusal()
    {
        var calls = 0;
        var result = Assert.IsType<JobPreflightException>(JobRunner.AutoPatchLoop(Refusal(Problem()), Ops(), "/ops", (_, probe) => {
            calls++; probe.Found.Add((Problem(1, "NEAREST_NAME"), null)); return probe;
        }));
        Assert.Equal(1, calls); Assert.Equal(2, result.Problems.Count);
        Assert.True(result.Problems[1]!["afterPatch"]!.GetValue<bool>());
    }

    [Fact]
    public void ANeedExposedByTheFirstCorrectionUsesOneMoreFinalRound()
    {
        var calls = 0;
        var result = Assert.IsType<JobRunner.AutoPatchResult>(JobRunner.AutoPatchLoop(Refusal(Problem()), Ops(), "/ops", (ops, probe) => {
            calls++;
            if (calls == 1) { probe.Found.Add((Problem(1, "REQUIRED_ARGUMENT_DEFAULT", "second after"), null)); return probe; }
            Assert.Equal("after", ops[0]!["value"]!.ToString()); Assert.Equal("second after", ops[1]!["value"]!.ToString());
            return new JsonObject { ["accepted"] = true };
        }));
        Assert.Equal(2, calls); Assert.Equal(2, result.Rounds); Assert.Equal(2, result.Problems.Count);
    }

    [Fact]
    public void TheSecondRoundNeverStartsAThirdRound()
    {
        var calls = 0;
        var result = Assert.IsType<JobPreflightException>(JobRunner.AutoPatchLoop(Refusal(Problem()), Ops(), "/ops", (_, probe) => {
            calls++; var next = Problem(1, "REQUIRED_ARGUMENT_DEFAULT", "round " + calls); next["message"] = "new need " + calls;
            probe.Found.Add((next, null)); return probe;
        }));
        Assert.Equal(2, calls); Assert.Equal(3, result.Problems.Count);
    }

    [Fact]
    public void AProblemCausedByTheCorrectionWithdrawsThatPatch()
    {
        var calls = 0;
        var result = Assert.IsType<JobPreflightException>(JobRunner.AutoPatchLoop(Refusal(Problem()), Ops(), "/ops", (_, probe) => {
            calls++; var broken = Problem(); broken["message"] = "the corrected op is invalid";
            probe.Found.Add((broken, "invalid corrected expression")); return probe;
        }));
        Assert.Equal(1, calls); Assert.Null(result.Problems[0]!["patch"]);
        Assert.Contains("no patch", result.Problems[0]!["fix"]!.ToString());
        Assert.False(PatchCertainty.IsCertain(result.Problems[0]!.AsObject()));
    }

    [Fact]
    public void ARepeatedUnresolvedProblemIsNeverTreatedAsAnAcceptedRound()
    {
        var calls = 0;
        var result = JobRunner.AutoPatchLoop(Refusal(Problem()), Ops(), "/ops", (_, probe) => {
            calls++; probe.Found.Add((Problem(), null)); return probe;
        });
        Assert.IsType<JobPreflightException>(result); Assert.Equal(1, calls);
    }
}
