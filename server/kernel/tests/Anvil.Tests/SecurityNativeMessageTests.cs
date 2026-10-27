using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// T12 correction round: the security list judged on the messages the Studio really emits, not only on its list of
/// definitions. The O11 Studio files the ORDER BY / GROUP BY expand-inline SQL injection under the generic
/// CustomObjectWarning ("SQL Injection | When adding an expand inline parameter after a Group By or Order By..."): it came
/// back nonblocking. Now it blocks as SQL_InputParameterPropagation with its own fix, its acceptance is one patch even on a
/// job without expectedMessages, a placeholder why is refused, and a warning the base already had that a replace recreates
/// is not judged new. Native: every case runs a real job through the bound Service Studio.
/// </summary>
public sealed class SecurityNativeMessageTests(ITestOutputHelper output)
{
    private const string Words = "the user said: keep it, the sort column is checked by the caller";

    private static JsonObject Run(string work, string baseOml, string name, JsonNode job, string? outOml = null)
    {
        var path = Path.Combine(work, name + ".json"); File.WriteAllText(path, job.ToJsonString());
        using var policy = JobPreflight.UseAutoPatch(false);
        return System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), baseOml, path, outOml ?? Path.Combine(work, name + ".oml")))!.AsObject();
    }

    private static (string Kernel, string Work, JsonObject Job) OrderByJob(string name)
    {
        var kernel = JobSources.KernelRoot()!;
        var work = Path.Combine(kernel, ".local", "t12-native-" + name, Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var job = JsonNode.Parse(File.ReadAllText(Path.Combine(kernel, "scripts", "outsystems_padroes", "tests", "casos", "d3-expandinline-nontoken.json")))!.AsObject();
        job.Remove("base");
        return (kernel, work, job);
    }

    private static string BlankService(string kernel) => Path.Combine(kernel, "tests", "fixtures", "blank-service.oml");

    private void Show(JsonObject result)
    {
        foreach (var v in result["validation"]?["verdicts"]?.AsArray().OfType<JsonObject>() ?? [])
            output.WriteLine($"verdict {v["id"]} | {v["verdict"]} | {v["reason"]} | {v["path"]}");
    }

    private static JsonObject SecurityVerdict(JsonObject result) => result["validation"]!["verdicts"]!.AsArray().OfType<JsonObject>()
        .Single(v => v["reason"]?.ToString() is { } r && (r.StartsWith("security", StringComparison.Ordinal)));

    [Fact]
    public void TheOrderByExpandInlineWarningBlocksAsSqlInjectionWithItsOwnFixAndItsAcceptance()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (kernel, work, job) = OrderByJob("orderby");
        // The fixture's own declaration of the generic warning goes away: the job keeps only its SQL_Enumeration entry.
        job["expectedMessages"] = new JsonArray(job["expectedMessages"]!.AsArray().OfType<JsonObject>().Where(e => e["id"]!.ToString() != "CustomObjectWarning").Select(e => (JsonNode)e.DeepClone()).ToArray());
        var refused = Run(work, BlankService(kernel), "refused", job);
        Show(refused);
        Assert.False(refused["accepted"]!.GetValue<bool>());
        var verdict = SecurityVerdict(refused);
        Assert.Equal(("unexpected", "security:SQL_InputParameterPropagation"), (verdict["verdict"]!.ToString(), verdict["reason"]!.ToString()));
        output.WriteLine("the real message arrives as " + verdict["id"]);
        Assert.True(SecurityWarnings.IsSecurity(verdict["id"]!.ToString(), verdict["detail"]?.ToString()));
        var problem = refused["problems"]!.AsArray().OfType<JsonObject>().Single(p => p["code"]!.ToString() == verdict["id"]!.ToString());
        Assert.Contains("allowlist", problem["fix"]!.ToString());
        Assert.Contains("the user's own words", problem["fix"]!.ToString());
        Assert.Equal(SecurityAcceptance.PatchRule, problem["patchRule"]!.ToString());
        Assert.False(problem["patchCertain"]!.GetValue<bool>());
        var edit = Assert.IsType<JsonObject>(Assert.Single(problem["patch"]!.AsArray()));
        Assert.Equal("/expectedMessages/-", edit["path"]!.ToString());
        // The acceptance, with the user's words, makes the same job deliverable.
        var entry = edit["value"]!.DeepClone().AsObject(); entry["why"] = Words;
        job["expectedMessages"]!.AsArray().Add(entry);
        var accepted = Run(work, BlankService(kernel), "accepted", job);
        Assert.True(accepted["accepted"]!.GetValue<bool>(), accepted.ToJsonString());
    }

    [Fact]
    public void AJobWithoutExpectedMessagesIsAcceptedInOneCallAndAPlaceholderWhyIsRefused()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (kernel, work, job) = OrderByJob("unlisted");
        job.Remove("expectedMessages");
        var refused = Run(work, BlankService(kernel), "refused", job);
        Assert.False(refused["accepted"]!.GetValue<bool>());
        var problem = refused["problems"]!.AsArray().OfType<JsonObject>().Single(p => p["patchRule"]?.ToString() == SecurityAcceptance.PatchRule);
        var edit = Assert.IsType<JsonObject>(Assert.Single(problem["patch"]!.AsArray()));
        // No list in the job: the patch adds the member itself (an add under /expectedMessages/- would have no parent).
        Assert.Equal(("add", "/expectedMessages"), (edit["op"]!.ToString(), edit["path"]!.ToString()));
        var list = edit["value"]!.AsArray();
        Assert.Equal(SecurityAcceptance.WordsMarker, Assert.Single(list)!["why"]!.ToString());
        // Applied as given, the marker is no words of the user: refused before anything is built.
        var marker = job.DeepClone().AsObject(); marker["expectedMessages"] = list.DeepClone();
        var error = Assert.ThrowsAny<Exception>(() => Run(work, BlankService(kernel), "marker", marker));
        Assert.Contains("not the user's own words", error.ToString());
        // With the user's words in why: one call, accepted.
        var words = list.DeepClone().AsArray(); foreach (var e in words.OfType<JsonObject>()) e["why"] = Words;
        job["expectedMessages"] = words;
        var accepted = Run(work, BlankService(kernel), "accepted", job);
        Assert.True(accepted["accepted"]!.GetValue<bool>(), accepted.ToJsonString());
    }

    [Fact]
    public void AWarningTheBaseHadThatTheJobRecreatesIsNotNewButANewOneStillBlocks()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (kernel, work, job) = OrderByJob("replace");
        var baseOml = Path.Combine(work, "base.oml");
        Assert.True(Run(work, BlankService(kernel), "base", job, baseOml)["accepted"]!.GetValue<bool>());
        var actionOps = job["ops"]!.AsArray().Skip(1).Select(o => o!.DeepClone()).ToArray();
        // The same action deleted and written again in one job: the platform gives its nodes new keys, the warning the base
        // had comes back with the same id, path and text, and no declaration is needed for it.
        var replace = new JsonObject { ["ops"] = new JsonArray([new JsonObject { ["op"] = "delete", ["target"] = "IServerAction:SearchProductsByColumn" }, .. actionOps]) };
        var same = Run(work, baseOml, "same", replace);
        Show(same);
        Assert.True(same["accepted"]!.GetValue<bool>(), same.ToJsonString());
        Assert.Equal(MessageExpectations.SecurityPreexistingReason, SecurityVerdict(same)["reason"]!.ToString());
        // A second action with the same pattern is a warning this job introduces: it still blocks.
        var copy = new JsonObject { ["ops"] = new JsonArray(actionOps.Select(o => JsonNode.Parse(o!.ToJsonString().Replace("SearchProductsByColumn", "SearchProductsByColumn2"))).ToArray()) };
        var added = Run(work, baseOml, "added", copy);
        Show(added);
        Assert.False(added["accepted"]!.GetValue<bool>());
        Assert.Equal("security:SQL_InputParameterPropagation", SecurityVerdict(added)["reason"]!.ToString());
    }

    [Fact]
    public void ARedirectToAScreenInputOnO11ReactiveBlocksAsOpenRedirect()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var kernel = JobSources.KernelRoot()!;
        var work = Path.Combine(kernel, ".local", "t12-native-redirect", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var job = JsonNode.Parse("""
            {"ops":[
              {"op":"html","data":{"html":"<screen name=\"RedirectProbe\" roles=\"Registered\" actions=\"Go\">\n<input name=\"Target\" type=\"Text\"/>\n<button onclick=\"Go\">Go</button>\n</screen>"}},
              {"op":"logic","data":{"flow":"action RedirectProbe.Go\n  navigate RedirectToURL(URL=Target)\n"}}
            ]}
            """)!;
        var result = Run(work, Path.Combine(kernel, "tests", "fixtures", "reactive-ui.oml"), "redirect", job);
        Show(result);
        Assert.False(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var verdict = SecurityVerdict(result);
        output.WriteLine("the real message arrives as " + verdict["id"]);
        Assert.Equal("security:OpenRedirectNR", verdict["reason"]!.ToString());
        var problem = result["problems"]!.AsArray().OfType<JsonObject>().Single(p => p["code"]!.ToString() == verdict["id"]!.ToString());
        Assert.Contains("allowed hosts", problem["fix"]!.ToString());
        Assert.DoesNotContain("ReplaceURLDomain", problem["fix"]!.ToString());
    }
}
