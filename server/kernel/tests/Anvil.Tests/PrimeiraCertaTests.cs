using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// primeira-certa A1/A2 (decision of the owner, 2026-10-10): a job with problems is refused ONCE, with every problem of every
/// phase (preflight, base, apply, Verify), each with phase, op, pointer, code, message and fix; nothing is saved. The waves
/// came from each phase refusing alone: the base check ran only after a clean preflight (so the field of a SQL output on a
/// module entity came one round later), the apply only after a clean base check, the Verify only after a clean apply, and
/// check-job ran the property rules without the Model API.
/// </summary>
public sealed class PrimeiraCertaTests
{
    private static readonly string Root = PacoteBPolicyTests.FindRoot();

    private static string Dir()
    {
        var dir = Path.Combine(Root, ".local", "pa4-pc-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static (JsonNode? Result, Exception? Error, string Output) Run(string dir, string name, string job, string? output = null)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        return RunFile(dir, path, name, output);
    }

    private static (JsonNode? Result, Exception? Error, string Output) RunFile(string dir, string path, string name, string? output = null)
    {
        output ??= Path.Combine(dir, name + ".oml");
        try { return (JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, output)), null, output); }
        catch (Exception ex) { return (null, ex, output); }
    }

    private static JsonObject[] Problems(Exception? error) => Assert.IsType<JobPreflightException>(Errors.FindCoded(error!)).Problems.OfType<JsonObject>().ToArray();

    [Fact]
    public void FourPhasesAreRefusedOnceWithEveryProblemAndThePatchedJobIsAccepted()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var source = Path.Combine(Root, "tests", "jobs-negative", "pa4-pc-four-phases.json");
        var (_, error, output) = RunFile(dir, source, "four");
        var refused = Assert.IsType<JobPreflightException>(Errors.FindCoded(error!));
        Assert.True(refused.VerifyRan);
        Assert.Equal(new[] { "preflight", "base", "apply", "verify" }, refused.Phases);
        var problems = refused.Problems.OfType<JsonObject>().ToArray();
        string Code(string phase) => Assert.Single(problems, p => p["phase"]!.GetValue<string>() == phase && p["code"]!.GetValue<string>() != "DEFAULT_LITERAL_INVALID")["code"]!.GetValue<string>();
        Assert.Equal("EXPR_UNKNOWN_IDENTIFIER", Code("preflight"));
        Assert.Equal("REFERENCE_UNRESOLVED", Code("base"));
        Assert.Equal("CHILD_NOT_FOUND", Code("apply"));
        Assert.Equal("ExpressionInvalidExpressionType", Code("verify"));
        // Every problem points into the job and says how to fix it; the Verify's points at the expression itself.
        Assert.All(problems, p => Assert.StartsWith("/ops/" + p["op"]!.GetValue<int>(), p["pointer"]!.GetValue<string>()));
        Assert.All(problems, p => Assert.False(string.IsNullOrWhiteSpace(p["fix"]?.GetValue<string>())));
        var verify = Assert.Single(problems, p => p["phase"]!.GetValue<string>() == "verify");
        Assert.Equal("/ops/0/data/actions/0/steps/1/assign/Code", verify["pointer"]!.GetValue<string>());
        Assert.Contains("TextToInteger", verify["fix"]!.GetValue<string>());
        Assert.Contains("IAssignNode", Assert.Single(problems, p => p["phase"]!.GetValue<string>() == "apply")["fix"]!.GetValue<string>());
        // One place, one problem: the Verify's own ExpressionUnknownObject for the unknown name and for the unquoted default
        // are the preflight's problems again; the problem with the patch stays.
        Assert.DoesNotContain(problems, p => p["code"]!.GetValue<string>() == "ExpressionUnknownObject");
        Assert.Single(problems, p => p["code"]!.GetValue<string>() == "EXPR_UNKNOWN_IDENTIFIER");
        var literal = Assert.Single(problems, p => p["code"]!.GetValue<string>() == "DEFAULT_LITERAL_INVALID");
        Assert.IsType<JsonArray>(literal["patch"]);
        Assert.False(File.Exists(output));
        var envelope = Errors.Envelope("apply", error!, 1);
        Assert.Equal("PREFLIGHT_REFUSED", envelope["code"]!.GetValue<string>());
        Assert.True(envelope["verifyRan"]!.GetValue<bool>());
        Assert.Equal(4, envelope["phases"]!.AsArray().Count);

        // The patches as they come, the rest as the fixes say: the job is accepted.
        var job = JsonNode.Parse(File.ReadAllText(source))!.AsObject();
        foreach (var p in problems)
            if (p["patch"] is JsonArray patch) ApplyPatch(job, patch);
        Replace(job, "/ops/0/data/actions/0/steps/0/assign/Total", "Quantity + 1");
        Replace(job, "/ops/0/data/actions/0/steps/1/assign/Code", "TextToInteger(\"12\")");
        var ops = job["ops"]!.AsArray();
        ops.RemoveAt(3); ops.RemoveAt(1);
        job.Remove("expectError");
        var (result, fine, _) = Run(dir, "four-fixed", job.ToJsonString());
        Assert.True(fine == null, fine?.ToString());
        Assert.True(result!["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString());
    }

    [Fact]
    public void AnApplyFailureAndAVerifyErrorComeInTheSameRefusal()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var (_, error, output) = Run(dir, "apply-verify", """
        {"base":"blank-service.oml","ops":[
          {"op":"logic","data":{"actions":[{"name":"PcTyped","outputs":[{"name":"Code","type":"Integer"}],"steps":[{"assign":{"Code":"\"abc\""}}]}]}},
          {"op":"set","target":"IServerAction:PcTyped/PcNoSuchNode","prop":"Label","value":"x"}]}
        """);
        var problems = Problems(error);
        Assert.Contains(problems, p => p["phase"]!.GetValue<string>() == "apply" && p["code"]!.GetValue<string>() == "CHILD_NOT_FOUND" && p["op"]!.GetValue<int>() == 1);
        Assert.Contains(problems, p => p["phase"]!.GetValue<string>() == "verify" && p["code"]!.GetValue<string>() == "ExpressionInvalidExpressionType" && p["op"]!.GetValue<int>() == 0);
        Assert.False(File.Exists(output));
    }

    [Fact]
    public void TheRuleThatNeedsTheBaseAnswersWithThePureRulesInOneRefusal()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var (built, buildError, basePath) = Run(dir, "base", """
        {"base":"blank-service.oml","ops":[{"op":"spec","data":{"entities":[{"name":"PcItem","attributes":[{"name":"Quantity","type":"Integer"}]}]}}]}
        """, Path.Combine(dir, "work", "base.oml"));
        Assert.True(buildError == null, buildError?.ToString());
        Assert.True(built!["isValid"]!.GetValue<bool>());
        // The real waves of 2026-10-10: a site property read without Site. (the job alone says it) and the field of a SQL output
        // read without its List segment (only the base knows the entity's attributes) came in two rounds.
        var (_, error, output) = Run(dir, "sql-and-site", $$$"""
        {"base":"{{{basePath.Replace('\\', '/')}}}","ops":[
          {"op":"logic","data":{"actions":[
            {"name":"PcReadSql","outputs":[{"name":"N","type":"Integer"}],"steps":[
              {"get":"PcItem","sql":true,"as":"ReadItems","statement":"SELECT {PcItem}.* FROM {PcItem}","max":10},
              {"if":"not ReadItems.List.Empty","then":[{"assign":{"N":"ReadItems.List.Current.Quantity"}}]}]},
            {"name":"PcSiteRead","outputs":[{"name":"D","type":"Integer"}],"steps":[{"assign":{"D":"ExpiryAlertDays"}}]}]}}]}
        """);
        var problems = Problems(error);
        var site = Assert.Single(problems, p => p["message"]!.GetValue<string>().Contains("'ExpiryAlertDays'"));
        Assert.Equal("preflight", site["phase"]!.GetValue<string>());
        var sql = Assert.Single(problems, p => p["message"]!.GetValue<string>().Contains("'Quantity'"));
        Assert.Equal("base", sql["phase"]!.GetValue<string>());
        Assert.Equal("/ops/0/data/actions/0/steps/1/then/0/assign/N", sql["pointer"]!.GetValue<string>());
        Assert.Equal("ReadItems.List.Current.List.Quantity", sql["patch"]![0]!["value"]!.GetValue<string>());
        // The Verify says both again (ExpressionUnknownObject at the same expressions): not repeated.
        Assert.Equal(2, problems.Length);
        Assert.False(File.Exists(output));
    }

    [Fact]
    public void CheckJobSaysTheVerifyDidNotRunAndWhy()
    {
        var dir = Dir();
        var path = Path.Combine(dir, "pure.json");
        File.WriteAllText(path, """{"base":"blank-service.oml","ops":[{"op":"logic","data":{"actions":[{"name":"PcPure","outputs":[{"name":"D","type":"Integer"}],"steps":[{"assign":{"D":"ExpiryAlertDays"}}]}]}}]}""");
        var check = JobPreflight.Check(path);
        Assert.False(check["valid"]!.GetValue<bool>());
        Assert.False(check["verifyRan"]!.GetValue<bool>());
        Assert.Contains("apply --job", check["verifyReason"]!.GetValue<string>());
        Assert.All(check["problems"]!.AsArray(), p => Assert.Equal("preflight", p!["phase"]!.GetValue<string>()));
        var refused = Assert.Throws<JobPreflightException>(() => JobPreflight.RequireValid(check));
        var envelope = Errors.Envelope("check-job", refused, 1);
        Assert.False(envelope["verifyRan"]!.GetValue<bool>());
        Assert.Contains("did not run", envelope["verifyReason"]!.GetValue<string>());
    }

    [Fact]
    public void ABaseThatCannotLoadIsSaidNeverHidden()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var (_, error, _) = Run(dir, "no-base", """
        {"base":"job:pa4-pc-no-such-job","ops":[{"op":"logic","data":{"actions":[{"name":"PcPure","outputs":[{"name":"D","type":"Integer"}],"steps":[{"assign":{"D":"ExpiryAlertDays"}}]}]}}]}
        """);
        var refused = Assert.IsType<JobPreflightException>(Errors.FindCoded(error!));
        Assert.False(refused.VerifyRan);
        Assert.Contains("could not be loaded", refused.VerifyReason);
        Assert.Contains(refused.Problems, p => p!["code"]!.GetValue<string>() == "EXPR_UNKNOWN_IDENTIFIER");
    }

    /// <summary>A phase after the preflight that stops on its own (the replay of 2026-10-10: a frozen producer signature
    /// without an element the job names) still answers with the preflight's problems, never with that exception alone.</summary>
    [Fact]
    public void ALaterPhaseThatStopsNeverHidesThePreflightProblems()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        // The frozen signature is bound by name, as the delivery binds a producer (--producer Runtime=<file>).
        var signature = Path.Combine(Root, "tests", "contracts", "native-reference", "ordinal-primitive.avsig");
        var job = Path.Combine(dir, "frozen-missing.json");
        File.WriteAllText(job, """
        {"base":"blank-service.oml","ops":[
          {"op":"reference","producer":"Runtime","elements":["IServerAction:PcNoSuchAction"]},
          {"op":"logic","data":{"actions":[{"name":"PcPure","outputs":[{"name":"D","type":"Integer"}],"steps":[{"assign":{"D":"ExpiryAlertDays"}}]}]}}]}
        """);
        var output = Path.Combine(dir, "frozen-missing.oml");
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, output,
            bindings: new Dictionary<string, string> { ["Runtime"] = signature }));
        var refused = Assert.IsType<JobPreflightException>(Errors.FindCoded(error));
        Assert.False(refused.VerifyRan);
        Assert.Contains("stopped before the refusal", refused.VerifyReason);
        Assert.Contains(refused.Problems, p => p!["code"]!.GetValue<string>() == "EXPR_UNKNOWN_IDENTIFIER");
        Assert.False(File.Exists(output));
    }

    [Fact]
    public void TheUnionKeepsOnePlaceOnceAndPrefersThePatch()
    {
        JsonObject P(int op, string pointer, string code, string phase, string message, bool patch = false)
        {
            var p = JobPreflight.Problem(op, pointer, code, "error", message, "fix", patch ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = "x" }) : null);
            p["phase"] = phase;
            return p;
        }
        var union = JobRunner.Union([
            P(0, "/ops/0/data/actions/0/steps/0/assign/D", "EXPR_UNKNOWN_IDENTIFIER", "preflight", "can't identify 'ExpiryAlertDays' in ExpiryAlertDays"),
            // The base check says the preflight's problem again: dropped.
            P(0, "/ops/0/data/actions/0/steps/0/assign/D", "EXPR_UNKNOWN_IDENTIFIER", "base", "can't identify 'ExpiryAlertDays' in ExpiryAlertDays"),
            P(1, "/ops/1/target", "REFERENCE_UNRESOLVED", "base", "IServerAction:Gone does not resolve in the base module"),
            // The op the base refused fails at apply for the same reason: dropped.
            P(1, "/ops/1", "REFERENCE_UNRESOLVED", "apply", "no IServerAction named Gone"),
            // The Verify at the same expression: dropped; at the action, naming the same name: dropped; another fault: kept.
            P(0, "/ops/0/data/actions/0/steps/0/assign/D", "ExpressionUnknownObject", "verify", "Error ExpressionUnknownObject: Unknown 'ExpiryAlertDays'"),
            P(0, "/ops/0/data/actions/0", "ExpressionUnknownObject", "verify", "Error ExpressionUnknownObject: Unknown 'ExpiryAlertDays'"),
            P(0, "/ops/0/data/actions/0/steps/1/assign/C", "ExpressionInvalidExpressionType", "verify", "Error: 'Integer' data type required instead of 'Text'"),
            // A later problem with the patch the earlier one lacks replaces it.
            P(2, "/ops/2/value", "EXPRESSION_SYNTAX", "base", "unbalanced quote"),
            P(2, "/ops/2/value", "ParserUnexpectedElement", "verify", "unexpected element", patch: true),
            // The base names the function as 'Right(', the Verify as 'Right': the same name, dropped.
            P(3, "/ops/3", "FUNCTION_UNKNOWN", "base", "'Right(' is not a built-in function of this Studio (o11)"),
            P(3, "/ops/3/data/actions/0/steps/0/assign/Out", "ExpressionUnknownFunction", "verify", "Error ExpressionUnknownFunction: Unknown function 'Right' in expression."),
        ], "/ops");
        Assert.Equal(new[] { "EXPR_UNKNOWN_IDENTIFIER", "REFERENCE_UNRESOLVED", "ExpressionInvalidExpressionType", "ParserUnexpectedElement", "FUNCTION_UNKNOWN" },
            union.Select(p => p["code"]!.GetValue<string>()));
    }

    /// <summary>check-job of the O11 CLI judges the job's sets against the Model API (PropertyRules): unbound, the rule was
    /// skipped (PREFLIGHT_RULE_FAILED) and PROPERTY_NOT_WRITABLE came one round later, from apply. Runs the built CLI.</summary>
    [Fact]
    public void CheckJobOfTheCliRunsThePropertyRules()
    {
        var cli = Path.Combine(Root, ".local", "cli", "anvil.dll");
        if (!File.Exists(cli) || !PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var path = Path.Combine(dir, "property.json");
        File.WriteAllText(path, """{"base":"blank-service.oml","ops":[{"op":"create","parent":"@espace","type":"IServerAction","name":"PcProp","as":"$a"},{"op":"set","target":"$a","prop":"PcNoSuchProperty","value":"1"}]}""");
        var start = new ProcessStartInfo("dotnet", $"\"{cli}\" check-job --job \"{path}\"") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEnd();
        process.StandardError.ReadToEnd();
        process.WaitForExit(120_000);
        var data = JsonNode.Parse(stdout)!["data"]!;
        Assert.Contains(data["problems"]!.AsArray(), p => p!["code"]!.GetValue<string>() == "PROPERTY_NOT_WRITABLE" && p["pointer"]!.GetValue<string>() == "/ops/1/prop");
        Assert.DoesNotContain(data["warnings"]!.AsArray(), w => w!["code"]!.GetValue<string>() == "PREFLIGHT_RULE_FAILED");
    }

    private static void Replace(JsonObject job, string pointer, string value) => ApplyPatch(job, new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = value }));

    /// <summary>RFC 6902 replace/add/remove on object members and array items (what the refusals' patches use).</summary>
    private static void ApplyPatch(JsonObject document, JsonArray patch)
    {
        foreach (var step in patch.OfType<JsonObject>())
        {
            var parts = step["path"]!.GetValue<string>().Split('/').Skip(1).Select(s => s.Replace("~1", "/").Replace("~0", "~")).ToArray();
            JsonNode parent = document;
            foreach (var part in parts[..^1]) parent = parent is JsonArray a ? a[int.Parse(part)]! : parent[part]!;
            var last = parts[^1];
            var op = step["op"]!.GetValue<string>();
            if (parent is JsonArray list)
            {
                var index = last == "-" ? list.Count : int.Parse(last);
                if (op == "remove") list.RemoveAt(index);
                else if (op == "add") list.Insert(index, step["value"]?.DeepClone());
                else list[index] = step["value"]?.DeepClone();
            }
            else if (op == "remove") parent.AsObject().Remove(last);
            else parent[last] = step["value"]?.DeepClone();
        }
    }
}
