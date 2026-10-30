using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>Review C1 of the platform limits table: the sentence of a refusal and each problem of a cut data text name are
/// written from the same certainty decision (certain, a candidate because the module was not read, dropped because the cut
/// is taken), in every phase, the base phase that rewrites the preflight's problems included.</summary>
public sealed class PlatformLimitsAnswerTextTests(ITestOutputHelper output)
{
    private const string Ddl30 = """{"op":"spec","data":{"ddl":"create index IX_Contact_Email_Name_Status30 on Contact (Name);\n"}}""";
    private const string ContactSpec = """{"op":"spec","data":{"entities":[{"name":"Contact","attributes":[{"name":"Email","type":"Email"},{"name":"Name","type":"Text"}]}]}}""";

    private static List<JsonObject> Cut(JsonNode answer)
        => (answer["problems"] as JsonArray ?? []).OfType<JsonObject>().Where(p => p["code"]?.ToString() == PlatformLimits.NameLimit).ToList();

    /// <summary>What a decision says, in the problem and in the sentence alike: certain ⇔ patchCertain and no candidate words;
    /// a candidate ⇔ a patch without certainty and the candidate words; dropped ⇔ no patch and no candidate words; and the
    /// sentence carries the problem's own message and fix.</summary>
    private static void Agrees(JsonObject problem, string sentence, string decision)
    {
        Assert.Equal(decision, problem["cutDecision"]?.ToString());
        var message = problem["message"]!.ToString();
        Assert.Contains(message, sentence);
        Assert.Contains(problem["fix"]!.ToString(), sentence);
        var certain = problem["patchCertain"]?.GetValue<bool>() ?? false;
        var hasPatch = problem["patch"] is JsonArray { Count: > 0 };
        switch (decision.Split(':')[0])
        {
            case "certain":
                Assert.True(certain && hasPatch, problem.ToJsonString());
                Assert.DoesNotContain("candidate", sentence, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("not read", sentence, StringComparison.OrdinalIgnoreCase);
                break;
            case "candidate":
                Assert.True(!certain && hasPatch, problem.ToJsonString());
                Assert.Contains("candidate", message, StringComparison.OrdinalIgnoreCase);
                break;
            default:
                Assert.True(!certain && !hasPatch, problem.ToJsonString());
                Assert.DoesNotContain("candidate", sentence, StringComparison.OrdinalIgnoreCase);
                break;
        }
    }

    private static (JsonObject Analysis, string Sentence) Preflight(params string[] ops)
    {
        var job = new JsonObject { ["ops"] = new JsonArray(ops.Select(o => JsonNode.Parse(o)).ToArray()) };
        var analysis = JobPreflight.Analyze(job["ops"]!.AsArray(), job, []);
        return (analysis, string.Join("\n", (analysis["errors"] as JsonArray ?? []).Select(e => e!.ToString())));
    }

    /// <summary>The job alone, one case per decision.</summary>
    [Fact]
    public void TheSentenceAndTheProblemAgreeForEveryDecisionOfTheJobAlone()
    {
        // certain: the entity is the text's own.
        var (certain, s1) = Preflight("""{"op":"spec","data":{"ddl":"create entity Probe (\n  Id Long Integer identifier auto required,\n  Name Text(50)\n);\ncreate index IX_Probe_NameOfTheProbeRecordLong on Probe (Name);\n"}}""");
        Agrees(Assert.Single(Cut(certain)), s1, "certain");
        // candidate: the entity is the module's, not read by the job alone.
        var (candidate, s2) = Preflight(Ddl30);
        Agrees(Assert.Single(Cut(candidate)), s2, "candidate:module-not-read");
        // dropped: another op of the job takes the cut.
        var (taken, s3) = Preflight("""{"op":"spec","data":{"entities":[{"name":"Contact","attributes":[{"name":"Email","type":"Email"},{"name":"Name","type":"Text"}],"indexes":[{"name":"IX_Contact_Email_Name_Status","attributes":["Email"]}]}]}}""", Ddl30);
        Agrees(Assert.Single(Cut(taken)), s3, "dropped:collision");
        // dropped for the other: one cut taken, the other free, no corrected text for either.
        var (other, s4) = Preflight("""{"op":"spec","data":{"entities":[{"name":"Contact","attributes":[{"name":"Email","type":"Email"},{"name":"Name","type":"Text"}],"indexes":[{"name":"IX_Contact_Email_Name_Status","attributes":["Email"]}]}]}}""",
            """{"op":"spec","data":{"ddl":"create index IX_Contact_Email_Name_Status30 on Contact (Name);\ncreate index IX_Contact_Name_Only_For_Search on Contact (Name);\n"}}""");
        var both = Cut(other);
        Assert.Equal(2, both.Count);
        Agrees(both.Single(p => p["message"]!.ToString().Contains("Status30")), s4, "dropped:collision");
        Agrees(both.Single(p => p["message"]!.ToString().Contains("Only_For_Search")), s4, "dropped:another-cut-taken");
    }

    private JsonNode Run(string dir, string name, JsonObject job)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job.ToJsonString());
        try { return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work-" + name)), null, path, Path.Combine(dir, "work", name + ".oml")))!; }
        catch (Exception error) { return new JsonObject { ["error"] = Errors.Text(error), ["problems"] = Errors.FindCoded(error)?.Problems?.DeepClone() }; }
    }

    private string Base(params string[] ops)
    {
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "r3-limits-answer", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(dir, "work"));   // a capture folder: a base the runner loads
        var first = Run(dir, "one", new JsonObject { ["base"] = "blank-service.oml", ["ops"] = new JsonArray(ops.Select(o => JsonNode.Parse(o)).ToArray()) });
        Assert.True(first["accepted"]?.GetValue<bool>(), first.ToJsonString());
        return dir;
    }

    /// <summary>Review Q4: with the base read and the module free of the cut, no text of the answer still calls the patch a
    /// candidate or says the module was not read.</summary>
    [Fact]
    public void TheAnswerSaysWhatTheBaseProves()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) { output.WriteLine("no studio"); return; }
        var dir = Base(ContactSpec);
        var second = Run(dir, "two", new JsonObject { ["base"] = Path.Combine(dir, "work", "one.oml"), ["autoPatch"] = false, ["ops"] = new JsonArray(JsonNode.Parse(Ddl30)) });
        var text = second.ToJsonString();
        output.WriteLine(text);
        Assert.Contains("\"patchCertain\":true", text);
        Assert.DoesNotContain("candidate", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("not read", text, StringComparison.OrdinalIgnoreCase);
        Agrees(Assert.Single(Cut(second)), second["error"]!.ToString(), "certain");
    }

    /// <summary>With the base read and the module's index taking the cut: the sentence and the problem both say it is taken.</summary>
    [Fact]
    public void TheAnswerSaysTheModuleTakesTheCut()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) { output.WriteLine("no studio"); return; }
        var dir = Base(ContactSpec,
            """{"op":"create","parent":"IServerEntity:Contact","type":"EntityIndex","name":"IX_Contact_Email_Name_Status","args":{"unique":false,"attributes":["IServerEntity:Contact/Email"]}}""");
        var second = Run(dir, "two", new JsonObject { ["base"] = Path.Combine(dir, "work", "one.oml"), ["autoPatch"] = false, ["ops"] = new JsonArray(JsonNode.Parse(Ddl30)) });
        output.WriteLine(second.ToJsonString());
        Agrees(Assert.Single(Cut(second)), second["error"]!.ToString(), "dropped:collision");
    }
}
