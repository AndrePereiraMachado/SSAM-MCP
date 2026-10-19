using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class AutoPatchReviewReceiptTests
{
    [Fact]
    public void ANonFunctionActionBlocksTheBuiltinWithItsOwnShadowingRule()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var kernel = JobSources.KernelRoot()!; var work = Path.Combine(kernel, ".local", "auto-patch-shadow-rule", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var path = Path.Combine(work, "job.json");
        File.WriteAllText(path, """
            {"ops":[{"op":"logic","data":{"actions":[
              {"name":"Lower","public":true,"inputs":[{"name":"Value","type":"Text"}],"outputs":[{"name":"Result","type":"Text"}],"steps":[{"assign":{"Result":"Replace(Value, \" \", \"-\")"}}]},
              {"name":"ReadSlug","public":true,"inputs":[{"name":"Title","type":"Text"}],"outputs":[{"name":"Slug","type":"Text"}],"steps":[{"assign":{"Slug":"Lower(Title)"}}]}
            ]}}]}
            """);
        using var policy = JobPreflight.UseAutoPatch(false);
        var response = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), Path.Combine(kernel, "tests", "fixtures", "blank-service.oml"), path, Path.Combine(work, "candidate.oml")))!;
        Assert.False(response["accepted"]!.GetValue<bool>());
        var problem = Assert.Single(response["problems"]!.AsArray().OfType<JsonObject>(), p => p["code"]?.ToString() == "ExpressionUnknownFunction");
        Assert.Equal("BUILTIN_FUNCTION_SHADOWED", problem["patchRule"]!.ToString());
        Assert.False(problem["patchCertain"]!.GetValue<bool>());
        Assert.Contains("action", problem["patchChoice"]!.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void MixedVerifyChoicesAndAmbiguousExpectationsKeepTheSavedRejectedResult(bool autoPatch)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var kernel = JobSources.KernelRoot()!;
        var work = Path.Combine(kernel, ".local", "auto-patch-review2-contract", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        // Exact r3-masked reproduction copied into the test: the native Verify rejects the condition and
        // finds two Tmp locals for one expectation. Those verdicts must not become a preflight refusal.
        var job = JsonNode.Parse("""
            {"expectValid":true,
             "expectedMessages":[
               {"id":"ArgumentRequiredExpression","element":"LoadFlag / Read / Argument","why":"verify-8 probe: this error is declared on purpose"},
               {"id":"UnusedElement","element":"Tmp","why":"verify-8 probe: two unused locals share this name"}],
             "ops":[
              {"op":"logic","data":{"actions":[{"name":"ReadFlag","kind":"client","inputs":[{"name":"Need","type":"Integer"}],"outputs":[{"name":"Result","type":"Boolean"}],"steps":[{"assign":{"Result":"Need > 0"}}]}]}},
              {"op":"html","data":{"html":"<screen name=\"PatchProbe\" roles=\"Registered\"><var name=\"TextValue\" type=\"Text\"/><input bind=\"TextValue\"/><p>{{ If(Now(), \"a\", \"b\") }}</p></screen>"}},
              {"op":"logic","data":{"flow":"action PatchProbe.LoadFlag\n  Read = ReadFlag()\n  end\n"}},
              {"op":"logic","data":{"flow":"action PatchProbe.KeepA\n  local Tmp: Integer\n  end\n"}},
              {"op":"logic","data":{"flow":"action PatchProbe.KeepB\n  local Tmp: Integer\n  end\n"}}
             ]}
            """)!;
        var path = Path.Combine(work, "r3-masked.json"); var candidate = Path.Combine(work, "candidate.oml"); File.WriteAllText(path, job.ToJsonString());
        using var policy = JobPreflight.UseAutoPatch(autoPatch);
        var result = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work),
            Path.Combine(kernel, "tests", "fixtures", "reactive-ui.oml"), path, candidate))!.AsObject();
        Assert.False(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        Assert.True(File.Exists(candidate)); Assert.Equal(candidate, result["outPath"]!.ToString());
        Assert.NotNull(result["validation"]); Assert.NotEmpty(result["validation"]!["unexpected"]!.AsArray());
        Assert.NotEmpty(result["validation"]!["ambiguous"]!.AsArray());
        Assert.Contains(result["policyMessages"]!.AsArray(), m => m!.ToString().StartsWith("Ambiguous ", StringComparison.Ordinal));
        Assert.Contains(result["problems"]!.AsArray().OfType<JsonObject>(), p => p["code"]?.ToString() == "VERIFY_REFUSED"
            && p["message"]!.ToString().Contains("Ambiguous ", StringComparison.Ordinal));
        Assert.Contains(result["problems"]!.AsArray().OfType<JsonObject>(), p => p["code"]?.ToString() != "VERIFY_REFUSED"
            && !Anvil.Core.Preflight.PatchCertainty.IsCertain(p));
        Assert.Null(result["patchesApplied"]);
    }

    private static JsonObject Receipt(string before, string after, params int[] lines)
    {
        var source = new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["data"] = new JsonObject { ["html"] = before } }) };
        var corrected = source.DeepClone(); corrected["ops"]![0]!["data"]!["html"] = after;
        var patch = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = "/ops/0/data/html", ["value"] = after });
        var problems = lines.Select(line => new JsonObject { ["code"] = "HTML_INVALID", ["phase"] = "apply", ["pointer"] = "/ops/0/data/html",
            ["line"] = line, ["patchRule"] = "TEXT_LITERAL_QUOTED", ["patch"] = patch.DeepClone() }).ToList();
        var work = Path.Combine(Path.GetTempPath(), "receipt-review", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        return JobRunner.AutoPatchReceipt(new JobRunner.AutoPatchResult(new JsonObject { ["accepted"] = true }, corrected, problems, 1), source, Path.Combine(work, "candidate.oml"), null, 1);
    }

    [Fact]
    public void AdjacentProblemsEachDiscloseTheirOwnLineInsteadOfTheWholeChangedRun()
    {
        var result = Receipt("header\nfirst prose\nsecond prose\ntail", "header\n\"first prose\"\n\"second prose\"\ntail", 2, 3);
        Assert.Equal("first prose", result["patchesApplied"]![0]!["from"]!.ToString());
        Assert.Equal("second prose", result["patchesApplied"]![1]!["from"]!.ToString());
    }

    [Fact]
    public void AChangeAfterColumn160IsVisibleWithinADiffCenteredWindow()
    {
        var prefix = new string('x', 220);
        var result = Receipt(prefix + " placeholder=Buscar por nome", prefix + " placeholder=\"Buscar por nome\"", 1);
        var item = Assert.Single(result["patchesApplied"]!.AsArray());
        var from = item!["from"]!.ToString(); var to = item["to"]!.ToString();
        Assert.NotEqual(from, to); Assert.True(from.Length <= 160); Assert.True(to.Length <= 160);
        Assert.StartsWith("…", from); Assert.Contains("Buscar por nome", from); Assert.Contains("\"Buscar por nome\"", to);
    }

    [Fact]
    public void PolicyFailuresFromAnEarlyRejectedAutoRoundJoinTheSingleRefusal()
    {
        var problem = new JsonObject { ["code"] = "HTML_INVALID", ["phase"] = "apply", ["pointer"] = "/ops/0/value", ["op"] = 0,
            ["patchRule"] = "TEXT_LITERAL_QUOTED", ["patch"] = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = "/ops/0/value", ["value"] = "after" }) };
        var refusal = new JobPreflightException("refusal", new JsonArray(problem));
        var ops = new JsonArray(new JsonObject { ["value"] = "before" });
        var result = Assert.IsAssignableFrom<Exception>(JobRunner.AutoPatchLoop(refusal, ops, "/ops", (_, _) => new JsonObject {
            ["accepted"] = false, ["policyMessages"] = new JsonArray("Ambiguous expected message UnusedElement @ Tmp") }));
        Assert.Contains(Errors.FindCoded(result)!.Problems!.OfType<JsonObject>(), p => p["code"]?.ToString() == "VERIFY_REFUSED" && p["message"]!.ToString().Contains("Ambiguous"));
    }

    [Fact]
    public void AnAcceptedCallbackCannotOverrideANewUnusedElementVeto()
    {
        var problem = new JsonObject { ["code"] = "HTML_INVALID", ["phase"] = "apply", ["pointer"] = "/ops/0/value", ["op"] = 0,
            ["patchRule"] = "TEXT_LITERAL_QUOTED", ["patch"] = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = "/ops/0/value", ["value"] = "after" }) };
        var refusal = new JobPreflightException("refusal", new JsonArray(problem));
        var result = Assert.IsAssignableFrom<Exception>(JobRunner.AutoPatchLoop(refusal, new JsonArray(new JsonObject { ["value"] = "before" }), "/ops", (_, probe) => {
            var unused = problem.DeepClone().AsObject(); unused["code"] = "UnusedElement"; unused["message"] = "Hint became unused";
            probe.Found.Add((unused, "the quoted name became unused"));
            return new JsonObject { ["accepted"] = true };
        }));
        Assert.Null(Errors.FindCoded(result)!.Problems![0]!["patch"]);
    }
}
