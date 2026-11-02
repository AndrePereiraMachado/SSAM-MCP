using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Linked into both test projects: ONINITIALIZE_SERVER_CALL (F11, 2026-10-26) decided on the candidate model by
/// ModelSession.Apply (OnInitializeServerCallRule.cs), the same on O11 and ODC. Each scenario applies a real job to the lane's
/// Reactive or Mobile fixture through JobRunner (spec + logic + html document, no Studio window): a server action called from
/// the OnInitialize of a screen or a block is refused with the screen, the handler, the callee and the fix: a Data Action
/// (Fetch: At start) or an aggregate, never another lifecycle event and never an event-swap patch (the owner's rule S1, review
/// of r4-w2-flow correction 2); a call reached through a client action is refused naming the chain; the same call from
/// OnReady is not this rule's (S1 covers it, a question for the owner); a raw set that binds OnInitialize to a handler with the call is refused; a call that was already in the
/// module, in a screen the job touched without changing the binding or the call, is a HIGH warning, never a refusal.
/// </summary>
public static class OnInitializeRuleScenarios
{
    private const string Spec = """{"op":"spec","data":{"entities":[{"name":"OiOrder","attributes":[{"name":"Title","type":"Text","length":50}]}]}}""";

    private const string Server = """
        {"op":"logic","data":{"actions":[{"name":"OiCount","kind":"server","outputs":[{"name":"Count","type":"Integer"}],"steps":[
          {"get":"OiOrder","as":"GetOrders"},{"assign":{"Count":"GetOrders.List.Length"}}]}]}}
        """;

    /// <summary>The screen OiHome with the handler OiInit bound as <paramref name="binding"/> writes it (oninitialize= or onready=).</summary>
    private static string Screen(string binding, string actions = "OiInit") =>
        $$$"""{"op":"html","data":{"html":"<screen name=\"OiHome\" roles=\"{{{Roles}}}\" {{{binding.Replace("\"", "\\\"")}}} actions=\"{{{actions}}}\"><var name=\"Total\" type=\"Integer\"/><span>{{ Total }}</span></screen>"}}""";

    private const string Block =
        """{"op":"html","data":{"html":"<block name=\"OiBadge\" oninitialize=\"OiInit\" actions=\"OiInit\"><var name=\"Total\" type=\"Integer\"/><span>{{ Total }}</span></block>"}}""";

    /// <summary>The handler OiInit of <paramref name="owner"/>: a call of <paramref name="callee"/> and the assign of its Count.</summary>
    private static string Init(string owner = "IMobileScreen:OiHome", string callee = "OiCount") =>
        $$$"""{"op":"logic","data":{"actions":[{"name":"OiInit","kind":"screen","owner":"{{{owner}}}","steps":[{"call":"{{{callee}}}","as":"Counted"},{"assign":{"Total":"Counted.Count"}}]}]}}""";

    private const string ClientLoad = """
        {"op":"logic","data":{"actions":[{"name":"OiLoad","kind":"client","outputs":[{"name":"Count","type":"Integer"}],"steps":[
          {"call":"OiCount","as":"Counted"},{"assign":{"Count":"Counted.Count"}}]}]}}
        """;

    /// <summary>Ops every job of the lane starts with (the ODC blank fixture has no UI flow: its runner creates one); empty on O11.</summary>
    public static string[] Prelude = [];
    /// <summary>The roles of the screen: the platform role on O11; a role the ODC prelude creates (an ODC screen without a role is a Verify warning the policy does not accept).</summary>
    public static string Roles = "Registered";
    private static int Shift => Prelude.Length;

    private static string Job(string fixture, params string[] ops) =>
        $$$"""{"base":"{{{fixture}}}","ops":[{{{string.Join(",", Prelude.Concat(ops))}}}]}""";

    private static JsonNode Run(string dir, string name, string job)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, Path.Combine(dir, name + ".oml")))!;
    }

    private static JsonNode Accepted(string dir, string name, string job)
    {
        var result = Run(dir, name, job);
        Assert.True((result["accepted"] ?? result["isValid"])?.GetValue<bool>() == true, name + ": " + result.ToJsonString()[..Math.Min(3000, result.ToJsonString().Length)]);
        return result;
    }

    private static JsonArray Refused(string dir, string name, string job)
    {
        var error = Assert.ThrowsAny<Exception>(() => Run(dir, name, job));
        var coded = Errors.FindCoded(error);
        Assert.True(coded != null, Errors.Text(error));
        File.WriteAllText(Path.Combine(dir, name + ".refusal.json"), coded!.Problems?.ToJsonString() + Environment.NewLine + Errors.Text(error));
        return coded.Problems!;
    }

    private static JsonObject Problem(JsonArray problems)
    {
        var problem = Assert.Single(problems, p => p!["code"]!.GetValue<string>() == OnInitializeServerCallRule.Code)!.AsObject();
        Assert.Equal("apply", problem["phase"]!.GetValue<string>());
        Assert.Equal("error", problem["severity"]!.GetValue<string>());
        // S1 (review of r4-w2-flow, correction 2): the data comes from a Data Action or an aggregate, never from OnReady, and no
        // patch swaps the event.
        Assert.Contains("Data Action", problem["fix"]!.GetValue<string>());
        Assert.Contains("aggregate", problem["fix"]!.GetValue<string>());
        Assert.DoesNotContain("OnReady", problem["fix"]!.GetValue<string>());
        Assert.Null(problem["patch"]);
        return problem;
    }

    private static JsonArray High(JsonNode result) => result["highWarnings"] as JsonArray ?? new JsonArray();

    private static void NoWarningOfTheRule(JsonNode result) =>
        Assert.DoesNotContain(High(result), w => w!["code"]!.GetValue<string>() == OnInitializeServerCallRule.Code);

    public static void AServerCallInOnInitializeIsRefusedWithTheFixToADataAction(string dir, string fixture)
    {
        var job = Job(fixture, Spec, Server, Screen("oninitialize=\"OiInit\""), Init());
        var problem = Problem(Refused(dir, "oi-oninitialize", job));
        Assert.Equal(2 + Shift, problem["op"]!.GetValue<int>());
        Assert.Equal($"/ops/{2 + Shift}/data/html", problem["pointer"]!.GetValue<string>());
        Assert.Equal("OiHome", problem["screen"]!.GetValue<string>());
        Assert.Equal("OiInit", problem["handler"]!.GetValue<string>());
        Assert.Equal("OiCount", Assert.Single(problem["callees"]!.AsArray())!.GetValue<string>());
        Assert.Contains("'OiCount'", problem["message"]!.GetValue<string>());
        Assert.Contains("before the first render", problem["message"]!.GetValue<string>());
        // The fix names the screen's Data Action and the binding the job wrote; nothing is moved to another event.
        Assert.Contains("a Data Action of OiHome (Fetch: At start)", problem["fix"]!.GetValue<string>());
        Assert.Contains("oninitialize=\"OiInit\" on <screen>", problem["fix"]!.GetValue<string>());
    }

    public static void AServerCallThroughAClientActionIsRefusedNamingTheChain(string dir, string fixture)
    {
        var problem = Problem(Refused(dir, "oi-chain", Job(fixture, Spec, Server, ClientLoad, Screen("oninitialize=\"OiInit\""), Init(callee: "OiLoad"))));
        Assert.Equal(3 + Shift, problem["op"]!.GetValue<int>());
        Assert.Contains("through the client action 'OiLoad'", problem["message"]!.GetValue<string>());
        Assert.Equal("OiCount", Assert.Single(problem["callees"]!.AsArray())!.GetValue<string>());
    }

    public static void TheSameCallFromOnReadyPassesAndAnOnInitializeWithoutCallsPasses(string dir, string fixture)
    {
        const string prep = """{"op":"logic","data":{"actions":[{"name":"OiPrep","kind":"screen","owner":"IMobileScreen:OiHome","steps":[{"assign":{"Total":"0"}}]}]}}""";
        var result = Accepted(dir, "oi-onready", Job(fixture, Spec, Server, Screen("onready=\"OiInit\" oninitialize=\"OiPrep\"", "OiInit,OiPrep"), Init(), prep));
        NoWarningOfTheRule(result);
    }

    public static void ABlockIsJudgedLikeAScreen(string dir, string fixture)
    {
        var problem = Problem(Refused(dir, "oi-block", Job(fixture, Spec, Server, Block, Init(owner: "IMobileBlock:OiBadge"))));
        Assert.Contains("block 'OiBadge'", problem["message"]!.GetValue<string>());
        Assert.Equal($"/ops/{2 + Shift}/data/html", problem["pointer"]!.GetValue<string>());
        Assert.Contains("a Data Action of OiBadge (Fetch: At start)", problem["fix"]!.GetValue<string>());
    }

    public static void ARawSetThatBindsOnInitializeToAHandlerWithTheCallIsRefused(string dir, string fixture)
    {
        Accepted(dir, "oi-set-base", Job(fixture, Spec, Server, Screen("onready=\"OiInit\""), Init()));
        var problem = Problem(Refused(dir, "oi-set",
            """{"base":"job:oi-set-base","ops":[{"op":"set","target":"IMobileScreen:OiHome/OnInitialize","prop":"Destination","value":"IMobileScreen:OiHome/OiInit"}]}"""));
        Assert.Equal(0, problem["op"]!.GetValue<int>());
        Assert.True(problem["pointer"] == null || problem["pointer"]!.GetValue<string>() is "" or "/ops/0", "pointer: " + problem["pointer"]?.ToString());
        Assert.Contains("the set of IMobileScreen:OiHome/OnInitialize", problem["fix"]!.GetValue<string>());   // the binding the job wrote
    }

    /// <summary>A module built before the rule (the binding written out of band, as the Studio would): a job that only adds
    /// another screen action to the screen is accepted, and the call is a HIGH warning with legacy true.</summary>
    public static void ALegacyCallIsAHighWarningNotARefusal(string dir, string fixture)
    {
        Accepted(dir, "oi-legacy-base", Job(fixture, Spec, Server, Screen("onready=\"OiInit\""), Init()));
        // Out of band: the OnInitialize bound to the same handler, without the apply's reviews (no footprint), saved as the base.
        var host = new ModelHost(Path.Combine(dir, "work"));
        var load = typeof(ModelHost).GetMethod("Load", [typeof(byte[])])!;
        var save = typeof(ModelHost).GetMethod("Save")!;
        var espace = load.Invoke(host, [File.ReadAllBytes(Path.Combine(dir, "oi-legacy-base.oml"))])!;
        byte[] bytes;
        try
        {
            var session = (ModelSession)Activator.CreateInstance(typeof(ModelSession), espace)!;
            session.Apply(JsonNode.Parse("""[{"op":"set","target":"IMobileScreen:OiHome/OnInitialize","prop":"Destination","value":"IMobileScreen:OiHome/OiInit"}]""")!.AsArray());
            bytes = (byte[])save.Invoke(host, [espace])!;
        }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [espace]); }
        var legacyBase = Path.Combine(dir, "work", "oi-legacy.oml");   // under the host's work folder: a base the runner accepts
        Directory.CreateDirectory(Path.GetDirectoryName(legacyBase)!);
        File.WriteAllBytes(legacyBase, bytes);
        const string other = """{"op":"logic","data":{"actions":[{"name":"OiOther","kind":"screen","owner":"IMobileScreen:OiHome","steps":[{"assign":{"Total":"Total + 1"}}]}]}}""";
        var result = Accepted(dir, "oi-legacy-touch", $$$"""{"base":"{{{legacyBase.Replace("\\", "/")}}}","ops":[{{{other}}}]}""");
        var legacy = Assert.Single(High(result), w => w!["code"]!.GetValue<string>() == OnInitializeServerCallRule.Code)!;
        Assert.True(legacy["legacy"]!.GetValue<bool>());
        Assert.Equal("high", legacy["severity"]!.GetValue<string>());
        Assert.Equal("OiHome", legacy["screen"]!.GetValue<string>());
        Assert.Contains("OiCount", legacy["message"]!.GetValue<string>());
        Assert.Contains("Data Action", legacy["fix"]!.GetValue<string>());
        Assert.DoesNotContain("OnReady", legacy["fix"]!.GetValue<string>());
        Assert.Null(legacy["patch"]);
    }
}
