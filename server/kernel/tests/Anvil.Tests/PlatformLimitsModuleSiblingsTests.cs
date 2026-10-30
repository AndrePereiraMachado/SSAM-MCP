using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>A cut data text name is certain only when every source that proves it unique is visible in that phase: the job
/// alone gives a candidate for an entity of the module; the base phase judges it with the module's names.</summary>
public sealed class PlatformLimitsModuleSiblingsTests(ITestOutputHelper output)
{
    private static JsonObject Analyze(params string[] ops)
    {
        var job = new JsonObject { ["ops"] = new JsonArray(ops.Select(o => JsonNode.Parse(o)).ToArray()) };
        return JobPreflight.Analyze(job["ops"]!.AsArray(), job, []);
    }

    private static List<JsonObject> Coded(JsonNode analysis, string code)
        => (analysis["problems"] as JsonArray ?? []).OfType<JsonObject>().Where(p => p["code"]?.ToString() == code).ToList();

    private const string Ddl30 = """{"op":"spec","data":{"ddl":"create index IX_Contact_Email_Name_Status30 on Contact (Name);\n"}}""";

    // Q1: the entity is not created by the job (it is the module's): the preflight cannot see the module's indexes, so by the
    // Integradora rule the patch is a candidate, never patchCertain.
    [Fact]
    public void ACutOnAnEntityOfTheModuleIsNotCertainInThePreflight()
    {
        var analysis = Analyze(Ddl30);
        output.WriteLine(analysis.ToJsonString());
        foreach (var p in Coded(analysis, "PLATFORM_NAME_LIMIT"))
            Assert.False(p["patchCertain"]?.GetValue<bool>() ?? false, p.ToJsonString());
    }

    // Q3: the colliding index comes from a JSON spec section of the job (JobSiblings covers specs).
    [Fact]
    public void ACutTakenByAJsonSpecIndexHasNoCertainPatch()
    {
        var analysis = Analyze(
            """{"op":"spec","data":{"entities":[{"name":"Contact","attributes":[{"name":"Email","type":"Email"},{"name":"Name","type":"Text"}],"indexes":[{"name":"IX_Contact_Email_Name_Status","attributes":["Email"]}]}]}}""",
            Ddl30);
        output.WriteLine(analysis.ToJsonString());
        foreach (var p in Coded(analysis, "PLATFORM_NAME_LIMIT"))
            Assert.False(p["patchCertain"]?.GetValue<bool>() ?? false, p.ToJsonString());
    }

    // Q2 (Studio): end to end, a module whose Contact has IX_Contact_Email_Name_Status; a data text adds
    // IX_Contact_Email_Name_Status30. Whatever answers (preflight or apply), the patch is not certain.
    [Fact]
    public void EndToEndTheModulesIndexMakesThePatchNotCertain()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) { output.WriteLine("no studio"); return; }
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "r3b-review2", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(dir, "work"));   // a capture folder (<kernel>/.local/**/work): a base the runner loads
        JsonNode Run(string name, JsonObject job)
        {
            var path = Path.Combine(dir, name + ".json");
            File.WriteAllText(path, job.ToJsonString());
            try { return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work-" + name)), null, path, Path.Combine(dir, "work", name + ".oml")))!; }
            catch (Exception error) { return new JsonObject { ["error"] = Errors.Text(error), ["reason"] = (error as JobPreflightException)?.VerifyReason, ["problems"] = Errors.FindCoded(error)?.Problems?.DeepClone() }; }
        }
        var first = Run("one", new JsonObject
        {
            ["base"] = "blank-service.oml",
            ["ops"] = new JsonArray(
                JsonNode.Parse("""{"op":"spec","data":{"entities":[{"name":"Contact","attributes":[{"name":"Email","type":"Email"},{"name":"Name","type":"Text"}]}]}}"""),
                JsonNode.Parse("""{"op":"create","parent":"IServerEntity:Contact","type":"EntityIndex","name":"IX_Contact_Email_Name_Status","args":{"unique":false,"attributes":["IServerEntity:Contact/Email"]}}""")),
        });
        output.WriteLine("one: " + first["accepted"] + " " + first["error"]);
        Assert.True(first["accepted"]?.GetValue<bool>(), first.ToJsonString());
        var second = Run("two", new JsonObject { ["base"] = Path.Combine(dir, "work", "one.oml"), ["autoPatch"] = false, ["ops"] = new JsonArray(JsonNode.Parse(Ddl30)) });
        var text = second.ToJsonString();
        output.WriteLine("two: " + text[..Math.Min(4000, text.Length)]);
        Assert.DoesNotContain("\"patchCertain\":true", text);
    }

    /// <summary>The other side of the same rule: with the base read and nothing of the module taking the cut, the patch the
    /// job alone could only offer is certain (PLATFORM_NAME_KEPT).</summary>
    [Fact]
    public void EndToEndAModuleFreeOfTheCutMakesThePatchCertain()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) { output.WriteLine("no studio"); return; }
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "r3-limits-module", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(dir, "work"));   // a capture folder (<kernel>/.local/**/work): a base the runner loads
        JsonNode Run(string name, JsonObject job)
        {
            var path = Path.Combine(dir, name + ".json");
            File.WriteAllText(path, job.ToJsonString());
            try { return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work-" + name)), null, path, Path.Combine(dir, "work", name + ".oml")))!; }
            catch (Exception error) { return new JsonObject { ["error"] = Errors.Text(error), ["reason"] = (error as JobPreflightException)?.VerifyReason, ["problems"] = Errors.FindCoded(error)?.Problems?.DeepClone() }; }
        }
        var first = Run("one", new JsonObject
        {
            ["base"] = "blank-service.oml",
            ["ops"] = new JsonArray(JsonNode.Parse("""{"op":"spec","data":{"entities":[{"name":"Contact","attributes":[{"name":"Email","type":"Email"},{"name":"Name","type":"Text"}]}]}}""")),
        });
        Assert.True(first["accepted"]?.GetValue<bool>(), first.ToJsonString());
        var second = Run("two", new JsonObject { ["base"] = Path.Combine(dir, "work", "one.oml"), ["autoPatch"] = false, ["ops"] = new JsonArray(JsonNode.Parse(Ddl30)) });
        var cut = Coded(second, "PLATFORM_NAME_LIMIT");
        output.WriteLine(second.ToJsonString());
        var problem = Assert.Single(cut);
        Assert.True(problem["patchCertain"]?.GetValue<bool>(), problem.ToJsonString());
        Assert.Contains("IX_Contact_Email_Name_Status on Contact", problem["patch"]![0]!["value"]!.ToString());
    }
}