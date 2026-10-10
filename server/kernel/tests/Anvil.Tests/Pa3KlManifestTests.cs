using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Atritos 3, lane kl, C01 and N3: the list of Verify ids is found from where the kernel runs (the Anvil.Core assembly), never
/// from the job's folder or the current directory alone; a hosted job lives in &lt;ws&gt;/odc/.local/jobs/inline with the current
/// directory in &lt;ws&gt;/odc (labs 11 and 26: "verify ID manifest not found: run from the repository"). The problems of
/// expectedMessages are problems of the preflight, collected with the others (lab 11: one round per problem), and an entry
/// with all:true needs no element.
/// </summary>
public sealed class Pa3KlManifestTests
{
    private static string Outside()
    {
        var dir = Path.Combine(Path.GetTempPath(), "pa3kl-outside", Guid.NewGuid().ToString("N"), "odc", ".local", "jobs", "inline");
        Directory.CreateDirectory(dir);
        Assert.Null(JobRunner.RepoRoot(dir)); // the hosted layout: no MANIFESTO.md above the job
        return dir;
    }

    private static string Write(string dir, string name, string json)
    {
        var path = Path.Combine(dir, name);
        File.WriteAllText(path, json);
        return path;
    }

    [Fact]
    public void ExpectedMessagesResolveWithCwdAndJobOutsideTheRepository()
    {
        var dir = Outside();
        var good = Write(dir, "good.json", """{"ops":[],"expectedMessages":[{"id":"UnusedUserAction","element":"X","why":"probe"}]}""");
        var bad = Write(dir, "bad.json", """{"ops":[],"expectedMessages":[{"id":"NotAVerifyIdAtAll","element":"X","why":"probe"}]}""");
        var cwd = Directory.GetCurrentDirectory();
        try
        {
            Directory.SetCurrentDirectory(Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(dir)))!);
            Assert.Null(JobRunner.RepoRoot(Directory.GetCurrentDirectory()));
            JobRunner.ValidateJob(good);
            var read = MessageExpectations.Read(JsonNode.Parse(File.ReadAllText(good))!, good);
            Assert.Equal("UnusedUserAction", Assert.Single(read).Id);
            // The ids were checked (not skipped): an unknown one is a problem of the preflight, with its pointer.
            var check = JobPreflight.Check(bad);
            var problem = Assert.Single(check["problems"]!.AsArray().OfType<JsonObject>(), p => p["code"]!.GetValue<string>() == "EXPECTED_MESSAGES_INVALID");
            Assert.Equal("/expectedMessages/0/id", problem["pointer"]!.GetValue<string>());
            Assert.DoesNotContain(check["notes"]!.AsArray(), n => n!["code"]!.GetValue<string>() == "VERIFY_IDS_UNCHECKED");
        }
        finally { Directory.SetCurrentDirectory(cwd); }
    }

    [Fact]
    public void TheIdListComesFromTheRunningKernelFirst()
    {
        var dir = Outside();
        var (ids, source) = MessageExpectations.KnownIds("o11", Path.Combine(dir, "job.json"));
        Assert.NotNull(ids);
        Assert.Contains("UnusedUserAction", ids!);
        Assert.Contains(Path.Combine("catalog"), source);
        // The O11 lane never takes the ODC list (each lane its own verifier).
        Assert.DoesNotContain("UnusedGlobalEvent", ids!);
    }

    [Fact]
    public void MalformedExpectedMessagesAreProblemsOfThePreflightWithTheOthers()
    {
        var dir = Outside();
        var job = Write(dir, "lab11.json", """
            {"expectedMessages":[
               {"id":"UnusedUserAction","all":true,"why":"lab 11: every message of the id"},
               {"id":"UnusedUserAction","element":"A","why":"x","extra":1},
               {"id":"UnusedElement","why":"no element and no all"}],
             "ops":[{"op":"logic","data":{"actions":[{"name":"A","bogus":1,"steps":[]}]}}]}
            """);
        JobRunner.ValidateJob(job); // never throws for them any more (N3)
        var check = JobPreflight.Check(job);
        var problems = check["problems"]!.AsArray().OfType<JsonObject>().ToArray();
        var expectations = problems.Where(p => p["code"]!.GetValue<string>() == "EXPECTED_MESSAGES_INVALID").Select(p => p["pointer"]!.GetValue<string>()).ToArray();
        Assert.Equal(["/expectedMessages/1/extra", "/expectedMessages/2/element"], expectations.Order(StringComparer.Ordinal));
        // The op's own problem comes out in the same answer.
        Assert.Contains(problems, p => p["op"]?.GetValue<int>() == 0 && p["code"]!.GetValue<string>().StartsWith("LOGIC", StringComparison.Ordinal));
        Assert.All(problems, p => Assert.False(string.IsNullOrWhiteSpace(p["fix"]?.GetValue<string>())));
        Assert.Throws<JobPreflightException>(() => JobPreflight.RequireValid(check));
    }

    [Fact]
    public void AllWithoutElementCoversEveryMessageOfTheId()
    {
        var known = new HashSet<string>(StringComparer.Ordinal) { "ServerActionInScreenAccessibleByEveryone", "UnusedUserAction" };
        var expected = MessageExpectations.Parse(JsonNode.Parse("""[{"id":"UnusedUserAction","all":true,"why":"every unused action of this job"}]"""), known);
        Assert.Equal("", Assert.Single(expected).Element);
        var a = new MessageInfo("UnusedUserAction", "Warning", "k1", "M (ESpace) / A (ServerAction)", "never used");
        var b = new MessageInfo("UnusedUserAction", "Warning", "k2", "M (ESpace) / F / B (ServerAction)", "never used");
        var result = MessageExpectations.Evaluate([a, b], expected);
        Assert.True(result.Accepted);
        Assert.Equal(2, Assert.Single(result.Matched).Count);
    }

    [Fact]
    public void WithoutAnIdListOnlyTheShapeIsChecked()
    {
        var problems = new List<ExpectationProblem>();
        var parsed = MessageExpectations.ParseAll(JsonNode.Parse("""[{"id":"AnyIdTheStudioMayKnow","element":"X","why":"y"},{"id":"","element":"X","why":"y"}]"""), null, "lookup", problems);
        Assert.Equal("AnyIdTheStudioMayKnow", Assert.Single(parsed).Id);
        Assert.Equal("/expectedMessages/1/id", Assert.Single(problems).Pointer);
    }
}
