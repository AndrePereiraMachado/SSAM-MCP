using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Lane B, C06 and the C37 tolerance: one validation policy for the kernel, the O11 deliver and the ODC builder. Every new
/// message gets a verdict (matched, tolerated, allowlisted, unexpected); count/all cover several messages; an identical
/// duplicate merges; a preexisting message satisfies; a stale expectation informs and never blocks; the allowlist is small
/// and mechanical; the anonymous-access warning is not tolerated on the job's own screens; the apply carries the verdicts,
/// the footprint and the sha256 of its output, and the builder accepts exactly what the kernel judged.
/// </summary>
public sealed class PacoteBPolicyTests
{
    private static readonly string Root = FindRoot();
    private static readonly HashSet<string> Known = new(StringComparer.Ordinal) { "UnusedUserAction", "UnusedElement", "InvalidResourceURL_Offline", "CustomObjectWarning", "ServerActionInScreenAccessibleByEveryone" };
    private static MessageInfo Msg(string key, string path = "M (ESpace) / Screen (MobileScreen) / A (ServerAction)", string id = "UnusedUserAction", string? owner = null, string? screen = null)
        => new(id, "Warning", key, path, "not used") { OwnerKey = owner, ScreenKey = screen };
    private static IReadOnlyList<ExpectedMessage> Parse(string json) => MessageExpectations.Parse(JsonNode.Parse(json), Known);

    [Fact]
    public void CountAndAllCoverSeveralMessagesOfTheSameElement()
    {
        var two = new[] { Msg("a"), Msg("b") };
        Assert.Single(MessageExpectations.Evaluate(two, Parse("""[{"id":"UnusedUserAction","element":"Screen (MobileScreen) / A (ServerAction)","why":"x"}]""")).Ambiguous);
        var counted = MessageExpectations.Evaluate(two, Parse("""[{"id":"UnusedUserAction","element":"Screen (MobileScreen) / A (ServerAction)","why":"x","count":2}]"""));
        Assert.True(counted.Accepted);
        Assert.Equal(2, Assert.Single(counted.Matched).Count);
        Assert.All(counted.Verdicts, v => Assert.Equal("matched", v.Verdict));
        var all = MessageExpectations.Evaluate([.. two, Msg("c")], Parse("""[{"id":"UnusedUserAction","element":"Screen (MobileScreen) / A (ServerAction)","why":"x","all":true}]"""));
        Assert.True(all.Accepted);
        Assert.Equal(3, all.Matched[0].Count);
    }

    [Fact]
    public void AnIdenticalDuplicateEntryMergesInsteadOfThrowing()
    {
        var parsed = Parse("""[{"id":"UnusedElement","element":"A / B","why":"same"},{"id":"UnusedElement","element":"A / B","why":"same"}]""");
        Assert.Equal(2, Assert.Single(parsed).Count);
        Assert.Throws<ArgumentException>(() => Parse("""[{"id":"UnusedElement","element":"A / B","why":"one"},{"id":"UnusedElement","element":"A / B","why":"two"}]"""));
    }

    [Fact]
    public void AnExpectationSatisfiedByAPreexistingMessageCountsAsSatisfied()
    {
        var expected = Parse("""[{"id":"UnusedUserAction","element":"Screen (MobileScreen) / A (ServerAction)","why":"kept on purpose"}]""");
        var result = MessageExpectations.Evaluate([], expected, [Msg("old")], JobFootprint.Empty);
        Assert.True(result.Accepted);
        var matched = Assert.Single(result.Matched);
        Assert.True(matched.Preexisting);
        Assert.Empty(result.UnusedExpectations);
    }

    [Fact]
    public void AnUnusedExpectationIsReportedAndDoesNotBlock()
    {
        var result = MessageExpectations.Evaluate([], Parse("""[{"id":"UnusedUserAction","element":"Screen (MobileScreen) / Gone (ServerAction)","why":"stale"}]"""), [], JobFootprint.Empty);
        Assert.True(result.Accepted);
        Assert.Single(result.UnusedExpectations);
        Assert.Empty(result.MissingExpected);
    }

    [Fact]
    public void UnusedOnAnElementTheJobCreatedIsAllowlistedAndOnAnOldElementIsNonBlocking()
    {
        // A03 (atritos 2): the warning on an old element blocks nothing; it is reported with the verdict nonblocking.
        var footprint = new JobFootprint(new HashSet<string> { "new-key" }, new HashSet<string>(), new HashSet<string>());
        var result = MessageExpectations.Evaluate([Msg("n", owner: "new-key"), Msg("o", owner: "old-key")], [], [], footprint);
        Assert.True(result.Accepted);
        Assert.Equal("n", Assert.Single(result.Allowlisted).Key);
        Assert.Equal("o", Assert.Single(result.NonBlocking).Key);
        Assert.Contains(result.Verdicts, v => v.Key == "n" && v.Verdict == "allowlisted" && v.Reason == "unused-created-by-job");
        Assert.Contains(result.Verdicts, v => v.Key == "o" && v.Verdict == "nonblocking" && v.Reason == "warning-non-blocking");
        // Without a footprint (the old call) nothing is allowlisted: both are nonblocking.
        Assert.Equal(2, MessageExpectations.Evaluate([Msg("n", owner: "new-key"), Msg("o", owner: "old-key")], []).NonBlocking.Count);
    }

    [Fact]
    public void AnOfflineFontOrCdnUrlIsAllowlistedAndAnyOtherHostIsNonBlocking()
    {
        MessageInfo Offline(string key, string url) => new("InvalidResourceURL_Offline", "Warning", key, "M (ESpace) / Theme (Theme)",
            $"Offline Behavior | The url '{url}' will not be cached for offline usage. Consider adding this resource to the module and use it in the stylesheet instead.");
        var result = MessageExpectations.Evaluate([Offline("font", "https://fonts.gstatic.com/s/nunito/v32/x.woff2"), Offline("api", "https://api.example.com/data.json")], [], [], JobFootprint.Empty);
        Assert.Contains(result.Verdicts, v => v.Key == "font" && v.Verdict == "allowlisted" && v.Reason == "offline-font-url");
        Assert.Equal("api", Assert.Single(result.NonBlocking).Key);
        Assert.True(result.Accepted);
    }

    [Fact]
    public void TheAnonymousWarningOnAJobScreenIsUnexpectedAndToleratedOutsideIt()
    {
        MessageInfo Anonymous(string key, string screen) => new("CustomObjectWarning", "Warning", key, "M (ESpace) / Home (MobileScreen) / Read (ServerAction)",
            "Security Warning | You're exposing a Server Action for public access and without authentication. Consider removing the Anonymous Role from this Screen.") { ScreenKey = screen };
        var footprint = new JobFootprint(new HashSet<string>(), new HashSet<string>(), new HashSet<string> { "job-screen" });
        var result = MessageExpectations.Evaluate([Anonymous("in", "job-screen"), Anonymous("out", "old-screen")], [], [], footprint);
        Assert.Equal("in", Assert.Single(result.Unexpected).Key);
        Assert.Equal("out", Assert.Single(result.Tolerated).Key);
        Assert.Contains(result.Verdicts, v => v.Key == "in" && v.Reason == "anonymous-in-job-screen");
        Assert.Contains(result.Verdicts, v => v.Key == "out" && v.Verdict == "tolerated" && v.Reason == "anonymous-outside-footprint");
        // Declared with why, it is matched.
        var declared = MessageExpectations.Evaluate([Anonymous("in", "job-screen")],
            Parse("""[{"id":"CustomObjectWarning","element":"Home (MobileScreen) / Read (ServerAction)","why":"public landing page on purpose"}]"""), [], footprint);
        Assert.True(declared.Accepted);
        Assert.Equal("matched", Assert.Single(declared.Verdicts).Verdict);
    }

    [Fact]
    public void TheBuilderAcceptsExactlyTheWarningsTheKernelJudged()
    {
        var candidate = "ABCDEF0123";
        JsonObject Receipt(string sha) => new()
        {
            ["ok"] = true, ["data"] = new JsonObject { ["outSha256"] = sha, ["validation"] = new JsonObject { ["verdicts"] = new JsonArray(
                new JsonObject { ["id"] = "UnusedUserAction", ["type"] = "Warning", ["ownerKey"] = "k1", ["verdict"] = "allowlisted" },
                new JsonObject { ["id"] = "UnusedElement", ["type"] = "Warning", ["ownerKey"] = "k2", ["verdict"] = "unexpected" }) } },
        };
        var added = new[] { "k1|UnusedUserAction|Unused|detail", "k2|UnusedElement|Unused|detail" };
        var judged = CandidateReceipt.Judge(Receipt("abcdef0123"), candidate, added);
        Assert.True(judged.Applies);
        Assert.Equal(added[0], Assert.Single(judged.Accepted));
        Assert.Equal(added[1], Assert.Single(judged.Refused));
        // Without an applying receipt (A03, atritos 2): only security warnings are refused; these two Unused* pass.
        var other = CandidateReceipt.Judge(Receipt("0000"), candidate, added);
        Assert.False(other.Applies); Assert.Empty(other.Refused); Assert.Equal(2, other.Accepted.Count); Assert.Contains("does not describe this candidate", other.Reason);
        var none = CandidateReceipt.Judge(null, candidate, [.. added, "k3|SQLInjection|SQL Injection|d"]);
        Assert.False(none.Applies); Assert.Equal("k3|SQLInjection|SQL Injection|d", Assert.Single(none.Refused)); Assert.Equal(2, none.Accepted.Count);
    }

    [Fact]
    public void TheApplyCarriesVerdictsFootprintAndTheSha256OfItsOutput()
    {
        if (!StudioAvailable()) return;
        var dir = Scratch();
        var job = Path.Combine(dir, "unused.json");
        File.WriteAllText(job, """{"base":"blank-service.oml","ops":[{"op":"logic","data":{"actions":[{"name":"PacoteBUnusedProbe","steps":[]}]}}]}""");
        var output = Path.Combine(dir, "unused.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, output))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]!.ToJsonString());
        var verdict = Assert.Single(result["validation"]!["verdicts"]!.AsArray())!;
        Assert.Equal("allowlisted", verdict["verdict"]!.GetValue<string>());
        Assert.Equal("unused-created-by-job", verdict["reason"]!.GetValue<string>());
        Assert.False(string.IsNullOrEmpty(verdict["ownerKey"]?.GetValue<string>()));
        Assert.Contains(result["footprint"]!["created"]!.AsArray(), e => e!["name"]?.GetValue<string>() == "PacoteBUnusedProbe" && e["key"]?.GetValue<string>() == verdict["ownerKey"]!.GetValue<string>());
        Assert.Equal(Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(output))).ToLowerInvariant(), result["outSha256"]!.GetValue<string>());
        Assert.Empty(result["validation"]!["unusedExpectations"]!.AsArray());
    }

    [Fact]
    public void TheFootprintNamesTheScreenAJobCreates()
    {
        if (!StudioAvailable()) return;
        var dir = Scratch();
        var job = Path.Combine(dir, "screen.json");
        File.WriteAllText(job, """{"base":"reactive-ui.oml","expectValid":true,"ops":[{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"PacoteBFootprintScreen","as":"$s"}]}""");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, Path.Combine(dir, "screen.oml")))!;
        var screen = Assert.Single(result["footprint"]!["screens"]!.AsArray(), s => s!["name"]?.GetValue<string>() == "PacoteBFootprintScreen")!;
        Assert.Equal("create", screen["mode"]!.GetValue<string>());
    }

    private static string Scratch()
    {
        var dir = Path.Combine(Root, ".local", "pacote-b-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir); return dir;
    }
    internal static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }
    internal static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(PacoteBPolicyTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir!;
    }
}
