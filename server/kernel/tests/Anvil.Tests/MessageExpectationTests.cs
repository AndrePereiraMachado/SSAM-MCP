using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class MessageExpectationTests
{
    [Fact]
    public void AnonymousWarningIsReportedWithoutBlockingOrHidingOtherDiagnostics()
    {
        var warning = new MessageInfo("CustomObjectWarning", "Warning", "anonymous", "Dashboard / ReadSource", "Security Warning | You're exposing a Server Action for public access and without authentication. Consider removing the Anonymous Role from this Screen.");
        var policy = MessageExpectations.Evaluate([warning], []);
        Assert.True(policy.Accepted);
        Assert.Equal(warning, Assert.Single(policy.Tolerated));
        Assert.True(MessageExpectations.Evaluate([warning], [new(warning.Id, warning.Path, "Legacy explicit contract")]).Accepted);
        // An error next to it blocks; any other warning (the generic bucket without the sentence, another id) blocks nothing
        // since A03 (atritos 2): it is reported as nonblocking, never hidden.
        var error = warning with { Type = "Error" };
        var refused = MessageExpectations.Evaluate([warning, error], []);
        Assert.False(refused.Accepted);
        Assert.Equal(error, Assert.Single(refused.Unexpected));
        foreach (var other in new[] { warning with { Detail = "Other custom warning mentioning Anonymous Role" }, warning with { Id = "OtherWarning" } })
        {
            var result = MessageExpectations.Evaluate([warning, other], []);
            Assert.True(result.Accepted);
            Assert.Equal(other, Assert.Single(result.NonBlocking));
            Assert.Equal(warning, Assert.Single(result.Tolerated));
        }
    }
    private static readonly string Root = FindRoot();
    private static readonly HashSet<string> Known = new(StringComparer.Ordinal) { "UnusedUserAction", "UnusedElement", "ExpressionUnknownObject" };
    private static MessageInfo Msg(string key, string path = "M (ESpace) / A (ServerAction)", string detail = "not used")
        => new("UnusedUserAction", "Warning", key, path, detail);

    [Fact]
    public void DeltaUsesIdentityRatherThanCountPathOrLocalizedText()
    {
        var old = new[] { Msg("fixed"), Msg("same") };
        var current = new[] { Msg("new"), Msg("same", "renamed path", "translated text") };
        var delta = MessageDelta.Compute(old, current);
        Assert.Equal("new", Assert.Single(delta.New).Key);
        Assert.Equal("fixed", Assert.Single(delta.Fixed).Key);
        Assert.Equal("same", Assert.Single(delta.Preexisting).Key);
        Assert.Equal("translated text", delta.Preexisting[0].Detail);
        Assert.Single(MessageDelta.Compute(old, new[] { Msg("same"), Msg("same") }).Preexisting);
    }

    [Theory]
    [InlineData("{}")] // array required
    [InlineData("[{\"id\":\"NotAnId\",\"element\":\"A / B\",\"why\":\"reason\"}]")]
    [InlineData("[{\"id\":\"UnusedElement\",\"element\":\"A /  / B\",\"why\":\"reason\"}]")] // an empty level (one level alone is valid since A03)
    [InlineData("[{\"id\":\"UnusedElement\",\"element\":\"A / B\",\"why\":\"  \"}]")]
    [InlineData("[{\"id\":\"UnusedElement\",\"element\":\"A / B\",\"why\":\"reason\",\"count\":0}]")]
    [InlineData("[{\"id\":\"UnusedElement\",\"element\":\"A / B\",\"why\":\"reason\",\"count\":2,\"all\":true}]")]
    [InlineData("[{\"id\":\"UnusedElement\",\"element\":\"A / B\",\"why\":\"reason\",\"extra\":1}]")]
    public void SchemaRejectsInvalidDeclarations(string json)
        => Assert.Throws<ArgumentException>(() => MessageExpectations.Parse(JsonNode.Parse(json), Known));

    [Fact]
    public void ExpectationsAreSpecificAndUnusedOrAmbiguousOnDrift()
    {
        var expected = MessageExpectations.Parse(JsonNode.Parse("""[{"id":"UnusedUserAction","element":"Screen / A (ServerAction)","why":"isolated example"}]"""), Known);
        Assert.True(MessageExpectations.Evaluate(new[] { Msg("a", "M / Screen / A (ServerAction)") }, expected).Accepted);
        // A stale expectation is informative (unusedExpectations): the Studio would not refuse the module.
        var stale = MessageExpectations.Evaluate(Array.Empty<MessageInfo>(), expected);
        Assert.Single(stale.UnusedExpectations);
        Assert.Empty(stale.MissingExpected);
        Assert.True(stale.Accepted);
        var ambiguous = MessageExpectations.Evaluate(new[] { Msg("a", "M / Screen / A (ServerAction)"), Msg("b", "N / Screen / A (ServerAction)") }, expected);
        Assert.Equal(2, Assert.Single(ambiguous.Ambiguous).Candidates.Count);
        Assert.False(ambiguous.Accepted);
        // A warning the expectation does not name blocks nothing (A03): it is reported as nonblocking.
        Assert.Single(MessageExpectations.Evaluate(new[] { Msg("x", "M / OtherScreen / A (ServerAction)") }, expected).NonBlocking);
        Assert.Throws<ArgumentException>(() => MessageExpectations.Parse(JsonNode.Parse("""[{"id":"UnusedElement","element":"A / B","why":"one"},{"id":"UnusedElement","element":"A / B","why":"two"}]"""), Known));
    }

    [Fact]
    public void RemovedFieldFailsBeforeAnyModelIsNeeded()
    {
        var dir = Scratch();
        var job = Path.Combine(dir, "legacy.json");
        var removed = "max" + "NewMessages";
        File.WriteAllText(job, new JsonObject { [removed] = 0, ["base"] = "nonexistent.oml", ["ops"] = new JsonArray() }.ToJsonString());
        // N3 (atritos 3): ValidateJob only reads the document; the problem is the preflight's, with the others and a pointer.
        JobRunner.ValidateJob(job);
        var problem = Assert.Single(JobPreflight.Check(job)["problems"]!.AsArray().OfType<JsonObject>(), p => p["code"]!.GetValue<string>() == "EXPECTED_MESSAGES_INVALID");
        Assert.Equal("/" + removed, problem["pointer"]!.GetValue<string>());
        Assert.Contains("campo removido", problem["message"]!.GetValue<string>());
        Assert.Contains("campo removido", Assert.Throws<ArgumentException>(() => MessageExpectations.Read(JsonNode.Parse(File.ReadAllText(job))!, job)).Message);
    }

    /// <summary>Each lane declares the ids of its own verifier: an ODC-only warning (UnusedGlobalEvent) is refused by
    /// the O11 build and accepted against catalog/odc; an O11-only id (LdapFilterInjection) the other way round.</summary>
    [Fact]
    public void EachLaneDeclaresOnlyTheIdsOfItsOwnVerifier()
    {
        var dir = Scratch();
        string Job(string id)
        {
            var path = Path.Combine(dir, id + ".json");
            File.WriteAllText(path, new JsonObject { ["ops"] = new JsonArray(), ["expectedMessages"] = new JsonArray(
                new JsonObject { ["id"] = id, ["element"] = "M (ESpace) / E (GlobalEvent)", ["why"] = "lane catalog probe" }) }.ToJsonString());
            return path;
        }
        Assert.Equal("o11", MessageExpectations.Lane);
        // N3 (atritos 3): Read throws on the first problem; ValidateJob never does (the preflight collects them).
        IReadOnlyList<ExpectedMessage> Read(string path, string? lane = null) => MessageExpectations.Read(JsonNode.Parse(File.ReadAllText(path))!, path, lane);
        var odcOnly = Job("UnusedGlobalEvent");
        Assert.Contains("unknown expectedMessages id 'UnusedGlobalEvent'", Assert.Throws<ArgumentException>(() => Read(odcOnly)).Message);
        Read(odcOnly, "odc");
        JobRunner.ValidateJob(odcOnly);
        var o11Only = Job("LdapFilterInjection");
        Read(o11Only);
        Assert.Contains("anvil-odc verify-catalog", Assert.Throws<ArgumentException>(() => Read(o11Only, "odc")).Message);
    }

    [Fact]
    public void EmptyMobileJobPreservesSixMessagesAndReloadIdentity()
    {
        if (!StudioAvailable()) return;
        var dir = Scratch();
        var host = new ModelHost(Path.Combine(dir, "work"));
        var fixture = Path.Combine(Root, "tests", "fixtures", "mobile-ui.oml");
        var job = Path.Combine(dir, "empty.json");
        File.WriteAllText(job, """{"base":"mobile-ui.oml","ops":[]}""");
        var output = Path.Combine(dir, "empty.oml");
        var result = Run(host, null, job, output);
        Assert.True(result["accepted"]!.GetValue<bool>());
        Assert.Empty(result["validation"]!["new"]!.AsArray());
        Assert.Equal(6, result["validation"]!["preexisting"]!.AsArray().Count);
        var before = host.MessagesFromOml(fixture);
        var after = host.MessagesFromOml(output);
        Assert.Empty(MessageDelta.Compute(before, after).New);
        Assert.Empty(MessageDelta.Compute(before, after).Fixed);
    }

    /// <summary>A03 (atritos 2): an undeclared warning on an element the job did not create blocks nothing; the candidate is
    /// accepted and saved, and the warning is reported with the verdict nonblocking.</summary>
    [Fact]
    public void AnUndeclaredWarningIsNonBlockingAndTheCandidateIsSaved()
    {
        if (!StudioAvailable()) return;
        var dir = Scratch();
        var output = Path.Combine(dir, "output.oml");
        var result = Run(new ModelHost(Path.Combine(dir, "work")), null,
            Path.Combine(Root, "tests", "jobs-negative", "undeclared-warning.json"), output);
        Assert.True(result["isValid"]!.GetValue<bool>());
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]!.ToJsonString());
        Assert.Empty(result["validation"]!["unexpected"]!.AsArray());
        var verdict = Assert.Single(result["validation"]!["verdicts"]!.AsArray())!;
        Assert.Equal("nonblocking", verdict["verdict"]!.GetValue<string>());
        Assert.Equal("UnusedUserAction", verdict["id"]!.GetValue<string>());
        Assert.True(File.Exists(output));
        Assert.DoesNotContain("corrija ou declare em expectedMessages com why", result["policyMessages"]!.ToJsonString());
    }

    [Fact]
    public void StaleExpectationIsReportedWithoutBlocking()
    {
        if (!StudioAvailable()) return;
        var dir = Scratch();
        var result = Run(new ModelHost(Path.Combine(dir, "work")), null,
            Path.Combine(Root, "tests", "jobs-negative", "stale-expected.json"), Path.Combine(dir, "output.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]!.ToJsonString());
        Assert.Single(result["validation"]!["unusedExpectations"]!.AsArray());
        Assert.Empty(result["validation"]!["missingExpected"]!.AsArray());
    }

    /// <summary>A seed with UnusedSeedProbe (called only by UnusedSeedCaller) and OldAction: their Unused* warnings are of
    /// elements the seed created (allowlisted), so the seed is accepted.</summary>
    private static string Seed(ModelHost host, string dir)
    {
        var seed = Path.Combine(dir, "seed.json");
        File.WriteAllText(seed, """{"base":"blank-service.oml","ops":[{"op":"logic","data":{"actions":[{"name":"OldAction","steps":[]},{"name":"UnusedSeedProbe","steps":[]},{"name":"UnusedSeedCaller","steps":[{"call":"UnusedSeedProbe","as":"RunProbe"}]}]}}]}""");
        var basePath = Path.Combine(dir, "seed.oml");
        var seeded = Run(host, null, seed, basePath);
        Assert.True(seeded["accepted"]!.GetValue<bool>(), seeded["policyMessages"]!.ToJsonString());
        Assert.Equal(2, seeded["validation"]!["allowlisted"]!.AsArray().Count);
        return basePath;
    }

    [Fact]
    public void FixingOneWarningDoesNotHideANewWarning()
    {
        if (!StudioAvailable()) return;
        var dir = Scratch();
        var host = new ModelHost(Path.Combine(dir, "work"));
        var basePath = Seed(host, dir);
        // Fixes OldAction's and the caller's warnings, and leaves UnusedSeedProbe (an old element) unused: a new warning, which
        // the delta still names (the two fixed ones never pay for it); since A03 it is reported as nonblocking.
        var job = Path.Combine(dir, "replace.json");
        File.WriteAllText(job, """{"ops":[{"op":"delete","target":"IServerAction:OldAction"},{"op":"delete","target":"IServerAction:UnusedSeedCaller"}]}""");
        var result = Run(host, basePath, job, Path.Combine(dir, "replaced.oml"));
        Assert.Equal(1, result["messages"]!.GetValue<int>());
        Assert.Single(result["validation"]!["new"]!.AsArray());
        Assert.Equal(2, result["validation"]!["fixed"]!.AsArray().Count);
        Assert.Empty(result["validation"]!["unexpected"]!.AsArray());
        Assert.Equal("nonblocking", Assert.Single(result["validation"]!["verdicts"]!.AsArray())!["verdict"]!.GetValue<string>());
        Assert.True(result["accepted"]!.GetValue<bool>());
    }

    [Fact]
    public void CompositeUsesItsOwnExpectationsRatherThanThoseOfParts()
    {
        if (!StudioAvailable()) return;
        var dir = Scratch();
        var host = new ModelHost(Path.Combine(dir, "work"));
        var basePath = Seed(host, dir);
        File.WriteAllText(Path.Combine(dir, "part.json"), """{"expectedMessages":[{"id":"UnusedUserAction","element":"Headless_CS (ESpace) / UnusedSeedProbe (ServerAction)","why":"no consumer when the part runs alone"}],"ops":[{"op":"delete","target":"IServerAction:UnusedSeedCaller"}]}""");
        var job = Path.Combine(dir, "whole.json");
        File.WriteAllText(job, """{"jobs":["job:part"]}""");
        var result = Run(host, basePath, job, Path.Combine(dir, "whole.oml"));
        // The part's expectation is not the composite's: the warning is not matched; since A03 it blocks nothing.
        var verdict = Assert.Single(result["validation"]!["verdicts"]!.AsArray())!;
        Assert.Equal("nonblocking", verdict["verdict"]!.GetValue<string>());
        Assert.Empty(result["validation"]!["matched"]!.AsArray());
        Assert.Empty(result["validation"]!["unexpected"]!.AsArray());
        Assert.Empty(result["validation"]!["missingExpected"]!.AsArray());
    }

    [Fact]
    public void ExpectValidIsEnforcedEvenWhenMessagesAreDeclared()
    {
        if (!StudioAvailable()) return;
        var dir = Scratch();
        var host = new ModelHost(Path.Combine(dir, "work"));
        var source = Path.Combine(Root, "tests", "jobs-negative", "unknown-function.json");
        var first = Run(host, null, source, Path.Combine(dir, "first.oml"));
        var job = JsonNode.Parse(File.ReadAllText(source))!;
        job["expectedMessages"] = new JsonArray(first["validation"]!["new"]!.AsArray().Select(m => (JsonNode)new JsonObject {
            ["id"] = m!["id"]!.GetValue<string>(), ["element"] = m["path"]!.GetValue<string>(),
            ["why"] = "Cenario propositalmente invalido para provar o contrato de expectValid." }).ToArray());
        var path = Path.Combine(dir, "negative.json");
        File.WriteAllText(path, job.ToJsonString());
        Assert.True(Run(host, null, path, Path.Combine(dir, "negative.oml"))["accepted"]!.GetValue<bool>());
        job["expectValid"] = true;
        File.WriteAllText(path, job.ToJsonString());
        var rejected = Run(host, null, path, Path.Combine(dir, "positive.oml"));
        Assert.False(rejected["accepted"]!.GetValue<bool>());
        Assert.Empty(rejected["validation"]!["unexpected"]!.AsArray());
        Assert.Contains("expectValid=True", rejected["policyMessages"]!.ToJsonString());
    }

    private static JsonNode Run(ModelHost host, string? basePath, string job, string output)
        => JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, job, output))!;
    private static string Scratch()
    {
        var dir = Path.Combine(Root, ".local", "message-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir); return dir;
    }
    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }
    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(MessageExpectationTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir!;
    }
}
