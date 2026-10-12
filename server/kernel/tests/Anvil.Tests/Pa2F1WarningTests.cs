using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Lane F1 of the atritos 2 package (docs/PACOTE-ATRITOS-2.md), A03, owner decision of 2026-10-06: only Verify ERRORS block a
/// delivery. The security list (SecurityWarnings) and the anonymous-access family on a screen of the job (C37) still block;
/// every other new warning gets the verdict nonblocking and comes back as a warning {id, path, key?, detail, fix}, never in a
/// refusal, never requiring expectedMessages. expectedMessages stays optional and accepts the exact path the message prints
/// or a suffix of one level or more (the name with or without " (Kind)"); a level that names several messages is ambiguous
/// with its candidates. Real cases of RELATORIO-ATRITOS-20261006.md (A03) are reproduced with synthetic messages.
/// </summary>
public sealed class Pa2F1WarningTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Pa2F1WarningTests).Assembly.Location)!)!;
    private static readonly HashSet<string> Known = new(StringComparer.Ordinal)
        { "UnusedUserAction", "UnusedElement", "JSNodeTooLarge", "SQLInjection", "CustomObjectWarning", "ServerActionInAnonymousScreen", "ExpressionUnknownObject" };
    private static MessageInfo Warning(string key, string id = "UnusedUserAction", string path = "Cardapio_BackOffice (ESpace) / Calculo (ServerAction)",
        string detail = "'Calculo' action is never used. Consider deleting it.", string? owner = null, string? screen = null)
        => new(id, "Warning", key, path, detail) { OwnerKey = owner, ScreenKey = screen };
    private static IReadOnlyList<ExpectedMessage> Parse(string json) => MessageExpectations.Parse(JsonNode.Parse(json), Known);

    [Fact]
    public void ANewOrdinaryWarningIsNonBlockingAndAccepted()
    {
        // The Cardapio_UI refusal "Unexpected JSNodeTooLarge @ ... corrija ou declare em expectedMessages com why": a warning.
        var tooLarge = Warning("js", "JSNodeTooLarge", "Cardapio_UI (ESpace) / Home (WebScreen) / OnReady (ScreenAction) / Js1 (JavaScript)", "JavaScript node is too large.");
        var unused = Warning("u", owner: "old-action");
        var result = MessageExpectations.Evaluate([tooLarge, unused], [], [], JobFootprint.Empty);
        Assert.True(result.Accepted);
        Assert.Empty(result.Unexpected);
        Assert.Equal(2, result.NonBlocking.Count);
        Assert.All(result.Verdicts, v => { Assert.Equal("nonblocking", v.Verdict); Assert.Equal("warning-non-blocking", v.Reason); });
        Assert.DoesNotContain(result.Diagnostics(), d => d.Contains("Unexpected", StringComparison.Ordinal));
        // Without a footprint (the old call) too: a warning never needs expectedMessages.
        Assert.True(MessageExpectations.Evaluate([tooLarge], []).Accepted);
    }

    [Fact]
    public void ANewErrorStaysUnexpected()
    {
        var error = new MessageInfo("ExpressionUnknownObject", "Error", "e", "M (ESpace) / A (ServerAction)", "Can't identify 'GrupoSelecionado' element");
        var result = MessageExpectations.Evaluate([error, Warning("w")], [], [], JobFootprint.Empty);
        Assert.False(result.Accepted);
        Assert.Equal("e", Assert.Single(result.Unexpected).Key);
        Assert.Contains(result.Verdicts, v => v.Key == "e" && v.Verdict == "unexpected" && v.Reason == null);
        Assert.Contains(result.Verdicts, v => v.Key == "w" && v.Verdict == "nonblocking");
    }

    [Fact]
    public void ASecurityWarningIsUnexpectedWithItsReasonUnlessDeclared()
    {
        var sql = Warning("sql", "SQLInjection", "M (ESpace) / Search (ServerAction) / SQL1 (SQL)", "Possible SQL injection: use EncodeSql");
        var result = MessageExpectations.Evaluate([sql], [], [], JobFootprint.Empty);
        Assert.False(result.Accepted);
        var verdict = Assert.Single(result.Verdicts);
        Assert.Equal("unexpected", verdict.Verdict);
        Assert.Equal("security:SQLInjection", verdict.Reason);
        Assert.Contains(result.Diagnostics(), d => d.StartsWith("Unexpected SQLInjection", StringComparison.Ordinal));
        // Declared with why (exact path), it is matched.
        var declared = MessageExpectations.Evaluate([sql], Parse("""[{"id":"SQLInjection","element":"M (ESpace) / Search (ServerAction) / SQL1 (SQL)","why":"inline parameter is a constant"}]"""), [], JobFootprint.Empty);
        Assert.True(declared.Accepted);
        Assert.Equal("matched", Assert.Single(declared.Verdicts).Verdict);
        Assert.All(SecurityWarnings.Ids, id => Assert.True(SecurityWarnings.IsSecurity(id, "")));
    }

    [Fact]
    public void TheAnonymousFamilyBlocksOnAJobScreenAndIsToleratedOutside()
    {
        const string ss11 = "Security Warning | You're exposing a Server Action for public access and without authentication. Consider removing the Anonymous Role from this Screen.";
        var footprint = new JobFootprint(new HashSet<string>(), new HashSet<string>(), new HashSet<string> { "job-screen" });
        var o11In = Warning("o11-in", "CustomObjectWarning", "M (ESpace) / Home (MobileScreen) / Read (ServerAction)", ss11, screen: "job-screen");
        var o11Out = Warning("o11-out", "CustomObjectWarning", "M (ESpace) / Old (MobileScreen) / Read (ServerAction)", ss11, screen: "old-screen");
        var odcIn = Warning("odc-in", "ServerActionInAnonymousScreen", "M (ESpace) / Home (Screen) / Read (ServerAction)", "anonymous screen", screen: "job-screen");
        var odcOut = Warning("odc-out", "ServerActionInAnonymousScreen", "M (ESpace) / Old (Screen) / Read (ServerAction)", "anonymous screen", screen: "old-screen");
        var result = MessageExpectations.Evaluate([o11In, o11Out, odcIn, odcOut], [], [], footprint);
        Assert.False(result.Accepted);
        Assert.Equal(new[] { "o11-in", "odc-in" }, result.Unexpected.Select(m => m.Key).ToArray());
        Assert.Equal(new[] { "o11-out", "odc-out" }, result.Tolerated.Select(m => m.Key).ToArray());
        Assert.All(result.Verdicts.Where(v => v.Verdict == "unexpected"), v => Assert.Equal("anonymous-in-job-screen", v.Reason));
        // The generic O11 bucket is anonymous only with its sentences; any other text in it is an ordinary warning.
        Assert.True(SecurityWarnings.IsAnonymous("CustomObjectWarning", ss11));
        Assert.False(SecurityWarnings.IsAnonymous("CustomObjectWarning", "Some other custom warning about something else."));
        Assert.Equal("nonblocking", Assert.Single(MessageExpectations.Evaluate([Warning("x", "CustomObjectWarning", detail: "Other custom warning")], [], [], footprint).Verdicts).Verdict);
        Assert.All(SecurityWarnings.AnonymousIds, id => Assert.True(SecurityWarnings.IsSecurity(id, null)));
        Assert.False(SecurityWarnings.IsSecurity("UnusedElement", "never used"));
    }

    [Fact]
    public void ExpectedMessagesAcceptsTheExactPathOrOneLevelWithOrWithoutTheKind()
    {
        // "expectedMessages element 'Calculo' must be a PathOf suffix with at least two levels" (A03): accepted now.
        var calculo = Warning("c");
        foreach (var element in new[] { "Calculo", "Calculo (ServerAction)", "Cardapio_BackOffice (ESpace) / Calculo (ServerAction)", "Cardapio_BackOffice / Calculo" })
        {
            var expected = Parse($$"""[{"id":"UnusedUserAction","element":"{{element}}","why":"kept for the next screen"}]""");
            var result = MessageExpectations.Evaluate([calculo], expected, [], JobFootprint.Empty);
            Assert.True(result.Accepted, element);
            Assert.Equal("matched", Assert.Single(result.Verdicts).Verdict);
            Assert.Single(result.Matched);
        }
        // A level of another element, or of another kind, does not match.
        Assert.False(MessageExpectations.PathMatches(calculo.Path, "Calc"));
        Assert.False(MessageExpectations.PathMatches(calculo.Path, "Calculo (ClientAction)"));
        Assert.False(MessageExpectations.PathMatches(calculo.Path, "Other / Calculo"));
        // A level is never empty.
        Assert.Throws<ArgumentException>(() => Parse("""[{"id":"UnusedUserAction","element":"A /  / Calculo","why":"x"}]"""));
    }

    [Fact]
    public void AOneLevelExpectationThatNamesSeveralMessagesIsAmbiguousWithItsCandidates()
    {
        var a = Warning("a", path: "M (ESpace) / Orders (WebScreen) / Calculo (ScreenAction)");
        var b = Warning("b", path: "M (ESpace) / Invoices (WebScreen) / Calculo (ScreenAction)");
        var result = MessageExpectations.Evaluate([a, b], Parse("""[{"id":"UnusedUserAction","element":"Calculo","why":"x"}]"""), [], JobFootprint.Empty);
        var ambiguous = Assert.Single(result.Ambiguous);
        Assert.Equal(new[] { "a", "b" }, ambiguous.Candidates.Select(m => m.Key).ToArray());
        Assert.False(result.Accepted);
        Assert.Contains(result.Diagnostics(), d => d.Contains("Candidates: " + a.Path + " | " + b.Path, StringComparison.Ordinal));
        // The longer suffix picks one; the other stays an ordinary non-blocking warning.
        var picked = MessageExpectations.Evaluate([a, b], Parse("""[{"id":"UnusedUserAction","element":"Orders / Calculo","why":"x"}]"""), [], JobFootprint.Empty);
        Assert.True(picked.Accepted);
        Assert.Contains(picked.Verdicts, v => v.Key == "a" && v.Verdict == "matched");
        Assert.Contains(picked.Verdicts, v => v.Key == "b" && v.Verdict == "nonblocking");
    }

    [Fact]
    public void TheLiveContractAcceptsAnUnforeseenWarningAndRefusesAnUnforeseenSecurityWarning()
    {
        var verdicts = new JsonArray(new JsonObject { ["id"] = "UnusedElement", ["path"] = "M / A", ["verdict"] = "nonblocking", ["reason"] = "warning-non-blocking" });
        var foreseen = new MessageInfo("UnusedElement", "Warning", "k1", "M / A", "never used") { OwnerKey = "a-key" };
        var unforeseen = new MessageInfo("JSNodeTooLarge", "Warning", "k2", "M / B", "too large");
        var live = LiveContract.Evaluate([foreseen, unforeseen], verdicts);
        Assert.True(live["accepted"]!.GetValue<bool>(), live.ToJsonString());
        Assert.All(live["matched"]!.AsArray(), e => Assert.Equal("nonblocking", e!["verdict"]!.ToString()));
        Assert.Equal("a-key", live["matched"]![0]!["ownerKey"]!.ToString());
        var sql = new MessageInfo("SQLInjection", "Warning", "k3", "M / S", "injection");
        var refused = LiveContract.Evaluate([foreseen, sql], verdicts);
        Assert.False(refused["accepted"]!.GetValue<bool>());
        var entry = Assert.Single(refused["unexpected"]!.AsArray())!;
        Assert.Equal("SQLInjection", entry["id"]!.ToString());
        Assert.Equal("security:SQLInjection", entry["reason"]!.ToString());
        // The anonymous family and errors are never accepted unforeseen either.
        Assert.False(LiveContract.Evaluate([new MessageInfo("ServerActionInAnonymousScreen", "Warning", "k4", "M / H", "x")], verdicts)["accepted"]!.GetValue<bool>());
        Assert.False(LiveContract.Evaluate([new MessageInfo("UnusedElement", "Error", "k5", "M / E", "x")], verdicts)["accepted"]!.GetValue<bool>());
    }

    [Fact]
    public void TheBuilderWithoutAKernelReceiptRefusesOnlySecurityWarnings()
    {
        // The FloodQuotes builder refusal (platforms/odc/docs/ONDE-FORAM-AS-8-HORAS.md): "Candidate introduces validation
        // warnings, which the live merge gate would refuse: <key>|UnusedElement|Unused Element|Client Variable ...".
        var unused = "_3NEpL+lfEmiAvkDE1T8xg|UnusedElement|Unused Element|Client Variable 'WF_Bld_AttachedGarage' is never used in App 'Quotes'. Consider deleting it.";
        var sql = "k2|SQLInjection|SQL Injection|Possible SQL injection in SQL1";
        var anonymous = "k3|CustomObjectWarning|Security Warning|You're exposing a Server Action for public access and without authentication. Consider removing the Anonymous Role from this Screen.";
        var judged = CandidateReceipt.JudgeWithoutReceipt([unused, sql, anonymous]);
        Assert.False(judged.Applies);
        Assert.Equal(unused, Assert.Single(judged.Accepted));
        Assert.Equal(new[] { sql, anonymous }, judged.Refused.ToArray());
        // The same judgement when there is no receipt, or it belongs to another candidate.
        Assert.Equal(judged.Accepted, CandidateReceipt.Judge(null, "AB", [unused, sql, anonymous]).Accepted);
        var other = CandidateReceipt.Judge(new JsonObject { ["data"] = new JsonObject { ["outSha256"] = "00" } }, "AB", [unused, sql]);
        Assert.False(other.Applies); Assert.Equal(unused, Assert.Single(other.Accepted)); Assert.Equal(sql, Assert.Single(other.Refused));
        // With an applying receipt: a warning the kernel judged unexpected stays refused; one it does not cover is judged alike.
        var receipt = new JsonObject { ["data"] = new JsonObject { ["outSha256"] = "ab", ["validation"] = new JsonObject { ["verdicts"] = new JsonArray(
            new JsonObject { ["id"] = "UnusedElement", ["type"] = "Warning", ["ownerKey"] = "k9", ["verdict"] = "unexpected" }) } } };
        var covered = CandidateReceipt.Judge(receipt, "AB", ["k9|UnusedElement|Unused|d", unused, sql]);
        Assert.True(covered.Applies);
        Assert.Equal(new[] { "k9|UnusedElement|Unused|d", sql }, covered.Refused.ToArray());
        Assert.Equal(unused, Assert.Single(covered.Accepted));
    }

    [Fact]
    public void EachWarningCarriesItsPathKeyOneLineDetailAndTheSuggestedFix()
    {
        var hints = VerifyHints.Read(Root);
        var verdicts = new JsonArray(
            new JsonObject { ["id"] = "UnusedElement", ["path"] = "M / Board (Structure)", ["ownerKey"] = "s-key", ["verdict"] = "nonblocking", ["detail"] = "Structure 'Board'\n is never used." },
            new JsonObject { ["id"] = "UnusedFancyThing", ["path"] = "M / X", ["verdict"] = "nonblocking", ["detail"] = new string('x', 400) },
            new JsonObject { ["id"] = "JSNodeTooLarge", ["path"] = "M / J", ["verdict"] = "nonblocking", ["detail"] = "too large" },
            new JsonObject { ["id"] = "UnusedElement", ["path"] = "M / Y", ["verdict"] = "allowlisted" });
        var warnings = VerifyHints.Warnings(verdicts, hints);
        Assert.Equal(3, warnings.Count);
        Assert.Equal("s-key", warnings[0]!["key"]!.ToString());
        Assert.Equal("Structure 'Board' is never used.", warnings[0]!["detail"]!.ToString());
        Assert.Equal(hints["UnusedElement"].Hint, warnings[0]!["fix"]!.ToString());
        Assert.Equal(VerifyHints.UnusedFix, warnings[1]!["fix"]!.ToString());
        Assert.Equal(200, warnings[1]!["detail"]!.ToString().Length);
        Assert.Null(warnings[1]!["key"]);
        Assert.Equal(hints.TryGetValue("JSNodeTooLarge", out var js) ? js.Hint : null, warnings[2]!["fix"]?.ToString());
    }

    [Fact]
    public void ADataUrlOrBase64RunInADetailIsCutWithItsSizeSoTheSentenceAfterItIsRead()
    {
        // FarmaVirtual session (2026-10-10, calls 105 and 168): each InvalidResourceURL_Offline quoted its data: URL whole, so the
        // detail cut at 200 characters ended inside the URL and never said what was wrong. One of the 34 of call 105.
        const string url = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22"
            + "%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.7%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Ccircle%20cx%3D%2212%22"
            + "%20cy%3D%2212%22%20r%3D%2210%22%2F%3E%3Cpath%20d%3D%22M12%2016v-4%22%2F%3E%3Cpath%20d%3D%22M12%208h.01%22%2F%3E%3C%2Fsvg%3E";
        const string png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg";
        const string path = "Theme/Resources/Images/Icons2024/Navigation/ArrowLeftCircle/Variants/Outline24/DarkMode/Final3/Large";
        const string slashed = "R0lGODlhAQABAIAAAP/AAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw/Zm9vYmFyMTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFla==";
        var verdicts = new JsonArray(
            new JsonObject { ["id"] = "InvalidResourceURL_Offline", ["path"] = "Haiku_UI (ESpace) / Haiku_UI (MobileTheme) / WebStyleSheet", ["ownerKey"] = "EHWy15q2lEymE4eJ_Th8yQ.#StyleSheet",
                ["verdict"] = "nonblocking", ["detail"] = "Offline Behavior | The url '" + url + "' will not be cached for offline usage. Consider adding this resource to the module and use it in the stylesheet instead." },
            new JsonObject { ["id"] = "ImageTooBig", ["path"] = "M / Logo (Image)", ["verdict"] = "nonblocking", ["detail"] = "Image 'Logo' " + png + png + " is big" },
            new JsonObject { ["id"] = "InvalidResourceURL_Offline", ["path"] = "M / T", ["verdict"] = "nonblocking", ["detail"] = "The url 'data:,x' stays" },
            // A slash path has mixed case and digits too, but never a "+" or the "=" padding: it is not base64 and stays whole.
            new JsonObject { ["id"] = "UnusedResource", ["path"] = "M / R", ["verdict"] = "nonblocking", ["detail"] = "The resource " + path + " is unused" },
            new JsonObject { ["id"] = "ImageTooBig", ["path"] = "M / Icon (Image)", ["verdict"] = "nonblocking", ["detail"] = "Icon " + slashed + " is big" });
        var warnings = VerifyHints.Warnings(verdicts, new Dictionary<string, VerifyHint>());
        Assert.Equal(435, url.Length);
        Assert.Equal("Offline Behavior | The url 'data:image/svg+xml,…(435 chars)' will not be cached for offline usage. Consider adding this resource to the module and use it in the stylesheet instead.",
            warnings[0]!["detail"]!.ToString());
        Assert.Equal("Image 'Logo' iVBORw0KGgoA…(" + (2 * png.Length) + " chars) is big", warnings[1]!["detail"]!.ToString());
        Assert.Equal("The url 'data:,x' stays", warnings[2]!["detail"]!.ToString());
        Assert.Equal("The resource " + path + " is unused", warnings[3]!["detail"]!.ToString());
        Assert.Equal("Icon R0lGODlhAQAB…(" + slashed.Length + " chars) is big", warnings[4]!["detail"]!.ToString());
    }

    [Fact]
    public void ADeliveryWithOnlyWarningsIsDeliveredWithItsWarnings()
    {
        // Foreseen by the apply (nonblocking) and one the live Verify adds that the apply did not foresee.
        var verdicts = new JsonArray(new JsonObject { ["id"] = "UnusedUserAction", ["type"] = "Warning", ["path"] = "Probe (ESpace) / Calculo (ServerAction)",
            ["ownerKey"] = "calc-key", ["detail"] = "'Calculo' action is never used.", ["verdict"] = "nonblocking", ["reason"] = "warning-non-blocking" });
        var current = new JsonArray(
            new JsonObject { ["id"] = "UnusedUserAction", ["type"] = "Warning", ["key"] = "m1", ["path"] = "Probe (ESpace) / Calculo (ServerAction)", ["detail"] = "'Calculo' action is never used.", ["ownerKey"] = "calc-key" },
            new JsonObject { ["id"] = "JSNodeTooLarge", ["type"] = "Warning", ["key"] = "m2", ["path"] = "Probe (ESpace) / Home (WebScreen)", ["detail"] = "JavaScript node is too large." });
        var (work, job) = Job();
        var result = Delivery.Run(new LiveBridge { Current = current }, new DeliveryRequest("Probe", job, work, []), Apply(verdicts));
        Assert.True(result["delivered"]!.GetValue<bool>(), result.ToJsonString());
        var warnings = result["warnings"]!.AsArray();
        Assert.Equal(new[] { "UnusedUserAction", "JSNodeTooLarge" }, warnings.Select(w => w!["id"]!.ToString()).ToArray());
        Assert.Equal("Probe (ESpace) / Calculo (ServerAction)", warnings[0]!["path"]!.ToString());
        Assert.Equal("calc-key", warnings[0]!["key"]!.ToString());
        Assert.False(string.IsNullOrWhiteSpace(warnings[0]!["fix"]?.ToString()));
        Assert.True(warnings[1]!.AsObject().ContainsKey("fix"));
        // The task receipt keeps the whole list.
        Assert.Equal(2, JsonNode.Parse(File.ReadAllText(Path.Combine(result["work"]!.ToString(), "result.json")))!["warnings"]!.AsArray().Count);

        // Without the apply's verdicts (an older apply): the job's expectedMessages policy, where a warning is nonblocking too.
        var (work2, job2) = Job();
        var legacy = Delivery.Run(new LiveBridge { Current = current }, new DeliveryRequest("Probe", job2, work2, []), Apply(null));
        Assert.True(legacy["delivered"]!.GetValue<bool>(), legacy.ToJsonString());
        Assert.Equal(2, legacy["warnings"]!.AsArray().Count);
    }

    [Fact]
    public void ARefusedApplyStillNamesTheWarningsThatBlockNothing()
    {
        var verdicts = new JsonArray(
            new JsonObject { ["id"] = "ExpressionUnknownObject", ["type"] = "Error", ["path"] = "Probe / A", ["verdict"] = "unexpected" },
            new JsonObject { ["id"] = "UnusedElement", ["type"] = "Warning", ["path"] = "Probe / B", ["verdict"] = "nonblocking", ["detail"] = "never used" });
        var (work, job) = Job();
        var bridge = new LiveBridge();
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), (_, _, output) =>
        {
            File.WriteAllText(output, "foreign");
            return new JsonObject { ["isValid"] = false, ["accepted"] = false, ["validation"] = new JsonObject { ["verdicts"] = verdicts.DeepClone() } };
        });
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Contains("validation contract", result["error"]!.ToString());
        Assert.Equal("UnusedElement", Assert.Single(result["warnings"]!.AsArray())!["id"]!.ToString());
        Assert.DoesNotContain("merge_from_oml", bridge.Calls);
    }

    // ---- helpers
    private static Func<string, string, string, JsonObject> Apply(JsonArray? verdicts) => (_, _, output) =>
    {
        File.WriteAllText(output, "foreign");
        var applied = new JsonObject { ["isValid"] = true, ["accepted"] = true };
        if (verdicts != null) applied["validation"] = new JsonObject { ["verdicts"] = verdicts.DeepClone() };
        return applied;
    };

    internal static (string Work, string Job) Job()
    {
        var work = Path.Combine(Root, ".local", "pa2-f1-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = Path.Combine(work, "job.json"); File.WriteAllText(job, "{\"ops\":[]}");
        return (work, job);
    }

    /// <summary>A bridge whose live Verify answers <see cref="Current"/> as the new messages after a merge.</summary>
    private sealed class LiveBridge : IBridgeClient
    {
        public JsonArray? Current;
        public List<string> Calls { get; } = [];
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Calls.Add(method);
            switch (method)
            {
                case "open_module": return new() { ["opened"] = true };
                case "get_active_module": return new() { ["name"] = "Probe", ["key"] = "A" };
                case "snapshot_module":
                    File.WriteAllText(parameters!["path"]!.ToString(), "snapshot");
                    return new JsonObject { ["key"] = "A", ["snapshot_id"] = "base-id", ["baseline"] = new JsonArray() };
                case "merge_from_oml": return new() { ["merged"] = true, ["newErrors"] = 0 };
                case "get_errors":
                    return new() { ["rawMessages"] = (Current ?? new JsonArray()).DeepClone(), ["settled"] = true, ["newErrors"] = 0, ["new"] = new JsonArray() };
                default: throw new Exception("Unexpected call: " + method);
            }
        }
    }
}
