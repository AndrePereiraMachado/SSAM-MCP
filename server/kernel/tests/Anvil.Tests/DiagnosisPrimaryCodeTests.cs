using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The single refusal of a job that failed somewhere carries the Verify of what did apply (primeira-certa A2), on a model the
/// failure left partial. That Verify may ADD what is certain and the job's own (an action of another op without its Start), and
/// never: replace the code of the job's own refusal (a lone coded apply failure keeps it), invent an error from what a failed
/// op left half-built, or judge the partial model by the job's expectations of its final module (expectValid). The complete
/// candidate keeps every final verdict of the policy (the VERIFY_REFUSED of 9cb0f8e8).
/// </summary>
public sealed class DiagnosisPrimaryCodeTests
{
    private static readonly string Root = JobRunner.RepoRoot(Directory.GetCurrentDirectory())!;
    private static string? _withCaller;

    private static string Work()
    {
        var dir = Path.Combine(Root, ".local", "diagnosis-primary-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    /// <summary>The module of tests/jobs/rest-consume-call.json: a REST method with a caller (its delete has consumers).</summary>
    private static string WithCaller()
    {
        if (_withCaller != null && File.Exists(_withCaller)) return _withCaller;
        var dir = Work();
        var output = Path.Combine(dir, "rest-consume-call.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "model")), null, Path.Combine(Root, "tests", "jobs", "rest-consume-call.json"), output))!;
        Assert.True(result["accepted"]!.GetValue<bool>());
        return _withCaller = output;
    }

    private static (JsonNode? Result, Exception? Error, string Output) Run(string? basePath, string ops, bool expectValid)
    {
        var dir = Work();
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = "tests/fixtures/blank-service.oml", ["expectValid"] = expectValid, ["ops"] = JsonNode.Parse(ops) }.ToJsonString());
        var output = Path.Combine(dir, "out.oml");
        try { return (JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "model")), basePath, job, output)), null, output); }
        catch (Exception ex) { return (null, ex, output); }
    }

    private static List<JsonObject> Problems(Exception error) => Errors.FindCoded(error)!.Problems!.OfType<JsonObject>().ToList();

    // An action created raw (no Start): the Verify's InvalidFlow_NoStart on op 0, a finding certain and of the job's own op.
    private const string RawAction = """{"op":"create","parent":"@espace","type":"IServerAction","name":"DiagNoStart"}""";

    private static void NoInventedVerdict(IEnumerable<JsonObject> problems)
    {
        // Never the job's expectation judged on the partial model, never a message of what a failed op left half-built.
        Assert.DoesNotContain(problems, p => p["message"]?.ToString()?.Contains("expectValid=", StringComparison.Ordinal) == true);
        Assert.DoesNotContain(problems, p => p["code"]?.ToString() == "VERIFY_REFUSED");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ALoneDeleteWithConsumersKeepsItsCodeWithOrWithoutExpectValid(bool expectValid)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (_, error, output) = Run(WithCaller(), """[{"op":"delete","target":"IRestAction:GetAddressByCep"}]""", expectValid);
        Assert.Equal("DELETE_HAS_CONSUMERS", Errors.FindCoded(error!)!.Code);
        var problems = Problems(error!);
        Assert.All(problems, p => Assert.Equal("DELETE_HAS_CONSUMERS", p["code"]!.ToString()));
        NoInventedVerdict(problems);
        Assert.False(File.Exists(output));
    }

    [Fact]
    public void ARealVerifyFindingJoinsADeleteWithConsumersAndTheCodeStays()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (_, error, output) = Run(WithCaller(), "[" + RawAction + """,{"op":"delete","target":"IRestAction:GetAddressByCep"}]""", expectValid: true);
        var coded = Errors.FindCoded(error!)!;
        Assert.Equal("DELETE_HAS_CONSUMERS", coded.Code);
        var problems = Problems(error!);
        Assert.Contains(problems, p => p["code"]!.ToString() == "DELETE_HAS_CONSUMERS" && p["phase"]!.ToString() == "apply" && p["op"]!.GetValue<int>() == 1);
        // The finding of another op that applied: certain, attributable, added (one refusal, never a second round).
        Assert.Contains(problems, p => p["code"]!.ToString() == "InvalidFlow_NoStart" && p["phase"]!.ToString() == "verify" && p["op"]!.GetValue<int>() == 0);
        NoInventedVerdict(problems);
        Assert.Contains("refused", Errors.Text(error!));
        Assert.False(File.Exists(output));
    }

    [Fact]
    public void ADifferentBreaksListKeepsConsumersChangedWithAFinding()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (_, error, _) = Run(WithCaller(), "[" + RawAction + """,{"op":"delete","target":"IRestAction:GetAddressByCep","breaks":["ServerAction:Someone/ExecuteServerAction:Else"]}]""", expectValid: true);
        Assert.Equal("CONSUMERS_CHANGED", Errors.FindCoded(error!)!.Code);
        var problems = Problems(error!);
        Assert.Contains(problems, p => p["code"]!.ToString() == "InvalidFlow_NoStart" && p["op"]!.GetValue<int>() == 0);
        NoInventedVerdict(problems);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ANameCollisionKeepsItsProblemAndTheFindingOfAnotherOp(bool expectValid)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (_, error, output) = Run(null, """
            [{"op":"create","parent":"@espace","type":"IServerAction","name":"DiagCollide","as":"$a"},
             {"op":"create","parent":"$a","type":"IOutputParameter","name":"Total","as":"$o1"},
             {"op":"create","parent":"$a","type":"IOutputParameter","name":"Total","as":"$o2"}]
            """, expectValid);
        var refused = Assert.IsType<JobPreflightException>(error);
        Assert.Equal(JobPreflightException.PreflightRefused, refused.Code);
        var problems = refused.Problems.OfType<JsonObject>().ToList();
        var collision = Assert.Single(problems, p => p["phase"]!.ToString() == "apply");
        Assert.Equal("NAME_COLLISION", collision["code"]!.ToString());
        Assert.Equal(2, collision["op"]!.GetValue<int>());
        // With expectValid the Verify of what applied adds its finding; without, the job expects errors: none is a problem.
        if (expectValid) Assert.Contains(problems, p => p["phase"]!.ToString() == "verify" && p["code"]!.ToString() == "InvalidFlow_NoStart" && p["op"]!.GetValue<int>() == 0);
        else Assert.DoesNotContain(problems, p => p["phase"]!.ToString() == "verify");
        NoInventedVerdict(problems);
        Assert.False(File.Exists(output));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void AnUnresolvedReferenceKeepsItsProblemAndTheFindingOfAnotherOp(bool expectValid)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (_, error, output) = Run(null, "[" + RawAction + """,{"op":"set","target":"IServerAction:DiagNowhere","prop":"Description","value":"x"}]""", expectValid);
        var coded = Errors.FindCoded(error!)!;
        Assert.Equal(JobPreflightException.PreflightRefused, coded.Code);
        var problems = Problems(error!);
        Assert.Contains(problems, p => p["code"]!.ToString() == "REFERENCE_UNRESOLVED" && p["op"]!.GetValue<int>() == 1);
        if (expectValid) Assert.Contains(problems, p => p["phase"]!.ToString() == "verify" && p["code"]!.ToString() == "InvalidFlow_NoStart" && p["op"]!.GetValue<int>() == 0);
        NoInventedVerdict(problems);
        Assert.False(File.Exists(output));
    }

    [Fact]
    public void TheCompleteCandidateKeepsTheFinalVerdictOfExpectValid()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        // The same expectation on a job that applied whole: the module is valid and the job said it would not be. That verdict
        // is the final policy's (9cb0f8e8: every final verdict reaches the author) and stays VERIFY_REFUSED.
        var (result, error, _) = Run(null, """[{"op":"set","target":"@espace","prop":"Description","value":"Diagnosis probe"}]""", expectValid: false);
        Assert.Null(error);
        Assert.False(result!["accepted"]!.GetValue<bool>());
        Assert.Contains(result["problems"]!.AsArray().OfType<JsonObject>(), p => p["code"]!.ToString() == "VERIFY_REFUSED"
            && p["message"]!.ToString().Contains("expectValid=False, but Verify isValid=True", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("Lower(\\\"a\\\")")]
    [InlineData("Lower(\\\"a\\\", \\\"b\\\")")]
    public void ADeleteWithConsumersKeepsItsCodeWhenThePatchRoundAddsAProblem(string value)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        // A value the Verify refuses with a certain patch (Lower is ToLower): the patch round rebuilds the refusal (Merge) with
        // what the patched job finds; the code of the lone coded apply failure stays.
        var (_, error, output) = Run(WithCaller(), """
            [{"op":"create","parent":"@espace","type":"IServerAction","name":"DiagL","as":"$a"},
             {"op":"create","parent":"$a","type":"IStartNode","as":"$s"},
             {"op":"create","parent":"$a","type":"IEndNode","as":"$e"},
             {"op":"link","from":"$s","to":"$e"},
             {"op":"create","parent":"$a","type":"ILocalVariable","name":"V","as":"$v"},
             {"op":"set","target":"$v","prop":"DataType","value":"Text"},
             {"op":"set","target":"$v","prop":"DefaultValue","value":"
            """ + value + """
            "},
             {"op":"delete","target":"IRestAction:GetAddressByCep"}]
            """, expectValid: true);
        Assert.Equal("DELETE_HAS_CONSUMERS", Errors.FindCoded(error!)!.Code);
        var problems = Problems(error!);
        Assert.Contains(problems, p => p["code"]!.ToString() == "DELETE_HAS_CONSUMERS" && p["op"]!.GetValue<int>() == 7);
        Assert.Contains(problems, p => p["message"]?.ToString()?.Contains("Lower", StringComparison.Ordinal) == true);
        Assert.False(File.Exists(output));
    }

    /// <summary>A module with an error of its own (an action without its Start), saved as the base of the next job.</summary>
    private static string WithAnError()
    {
        var (result, error, output) = Run(null, "[" + RawAction + "]", expectValid: false);
        Assert.True(error == null, error?.ToString());
        Assert.False(result!["isValid"]!.GetValue<bool>());
        return output;
    }

    // R4 and R5: the only failure is an op that names nothing of the module (an unresolved set): it wrote nothing, so the
    // expectation of the job is judged on this model in the same refusal, never in a second round.
    [Fact]
    public void R4_AnInvalidBaseWithExpectValidAndAnUnresolvedSetIsRefusedWithTheVerdictAtOnce()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (_, error, _) = Run(WithAnError(), """[{"op":"set","target":"IServerAction:DiagNowhere","prop":"Description","value":"x"}]""", expectValid: true);
        var problems = Problems(error!);
        Assert.Contains(problems, p => p["code"]!.ToString() == "REFERENCE_UNRESOLVED" && p["op"]!.GetValue<int>() == 0);
        Assert.Contains(problems, p => p["code"]!.ToString() == "VERIFY_REFUSED"
            && p["message"]!.ToString().Contains("expectValid=True, but Verify isValid=False", StringComparison.Ordinal));
    }

    [Fact]
    public void R5_AValidModuleWithExpectValidFalseAndAnUnresolvedSetIsRefusedWithTheVerdictAtOnce()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (_, error, _) = Run(null, """[{"op":"set","target":"IServerAction:DiagNowhere","prop":"Description","value":"x"}]""", expectValid: false);
        var problems = Problems(error!);
        Assert.Contains(problems, p => p["code"]!.ToString() == "REFERENCE_UNRESOLVED" && p["op"]!.GetValue<int>() == 0);
        Assert.Contains(problems, p => p["code"]!.ToString() == "VERIFY_REFUSED"
            && p["message"]!.ToString().Contains("expectValid=False, but Verify isValid=True", StringComparison.Ordinal));
    }

    [Fact]
    public void AFailedOpThatRewritesAPropertyNeverHidesTheDifferenceOfAnEarlierOp()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Work();
        var host = new ModelHost(Path.Combine(dir, "model"));
        var espace = host.Load(File.ReadAllBytes(Path.Combine(Root, "tests", "fixtures", "blank-service.oml")));
        try {
            var session = new ModelSession(espace);
            session.Apply(JsonNode.Parse("""[{"op":"spec","data":{"entities":[{"name":"DiagDc","attributes":[{"name":"Title","type":"Text","length":50}]}]}}]""")!.AsArray());
            var title = new KernelModelReader().Walk((OutSystems.Model.IObjectSignature)espace)
                .First(n => n.GetType().GetInterfaces().Any(i => i.Name == "IEntityAttribute") && Anvil.Core.TypeResolver.Name(n) == "Title");
            void Call(string name, params object?[] args) =>
                typeof(ModelSession).GetMethod(name, System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.Invoke(session, args);
            // Op 5 applied and wrote Length 80, which the module does not keep (it has 50): a difference of its own. Op 6 wrote the
            // same property and failed: its write is no expectation, and op 5's difference is still found.
            Call("BeginAnchors", 5); Call("RememberData", title, "Length", JsonValue.Create("80"), null); Call("EndAnchors", false);
            Call("BeginAnchors", 6); Call("RememberData", title, "Length", JsonValue.Create("50"), null); Call("EndAnchors", true);
            var contract = session.DataContract(ofAppliedOps: true);
            Assert.False(contract["accepted"]!.GetValue<bool>(), contract.ToJsonString());
            Assert.Contains(contract["differences"]!.AsArray(), d => d!["property"]!.ToString() == "Length" && d["expected"]!.ToString() == "80");
            // A failed op alone invents nothing: its write is given back.
            Call("BeginAnchors", 7); Call("RememberData", title, "Decimals", JsonValue.Create("3"), null); Call("EndAnchors", true);
            Assert.DoesNotContain(session.DataContract(ofAppliedOps: true)["differences"]!.AsArray(), d => d!["property"]!.ToString() == "Decimals");
        }
        finally { ModelHost.Release(espace); }
    }

    [Fact]
    public void ARefusalWithoutAPrimaryCodeIsStillPreflightRefused()
    {
        var refusal = new JobPreflightException("refused", new JsonArray());
        Assert.Equal("PREFLIGHT_REFUSED", refusal.Code);
        Assert.Equal("PREFLIGHT_REFUSED", Errors.Envelope("job", refusal, 0)["code"]!.ToString());
        Assert.Equal("DELETE_HAS_CONSUMERS", Errors.Envelope("job", new JobPreflightException("refused", new JsonArray()) { Code = "DELETE_HAS_CONSUMERS" }, 0)["code"]!.ToString());
    }
}
