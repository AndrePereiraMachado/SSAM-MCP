using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Linked into both test projects: family F5, composition in one delivery. The order of the ops of one job never matters for
/// the references among the elements the job itself creates (a screen another screen navigates to, a block a screen uses, an
/// action another action calls, a structure a parameter is typed with, the screen a screen action belongs to): every order
/// builds, passes the Verify and saves the same module content (each screen and block read as ssam-html/1, each action as
/// ssam-flow/1, the data as ssam-ddl/1, keys left out). Two screens that navigate to each other build in one job. A
/// reference to something that exists nowhere is refused once, naming it. Real jobs through JobRunner on the lane's fixture.
/// </summary>
public static class CompositionScenarios
{
    private static string Roles(string lane) => lane == "odc" ? "" : " roles=\"Registered\"";
    private static JsonArray Expected(string lane) => lane == "odc"
        ? new JsonArray(new JsonObject { ["id"] = "AnonymousAccess_NoPermissions", ["all"] = true, ["why"] = "a test screen without a role" }) : new JsonArray();

    private static string Job(string dir, string name, string fixture, string lane, IEnumerable<JsonNode> ops)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, new JsonObject { ["base"] = fixture, ["expectedMessages"] = Expected(lane), ["ops"] = new JsonArray(ops.Select(o => o.DeepClone()).ToArray()) }.ToJsonString());
        return path;
    }

    private static JsonObject Run(string dir, string job) =>
        JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, Path.ChangeExtension(job, ".oml")))!.AsObject();

    private static JsonObject Accepted(string dir, string job)
    {
        JsonObject result;
        try { result = Run(dir, job); }
        catch (Exception error) { throw new Xunit.Sdk.XunitException(Path.GetFileName(job) + " refused: " + Errors.Text(error) + " " + Errors.FindCoded(error)?.Problems?.ToJsonString()); }
        Assert.True(result["accepted"]!.GetValue<bool>(), Path.GetFileName(job) + ": " + result["details"]?.ToJsonString() + result["policyMessages"]?.ToJsonString());
        return result;
    }

    private static List<JsonObject> Refused(string dir, string job)
    {
        var error = Assert.ThrowsAny<Exception>(() => Run(dir, job));
        var coded = Errors.FindCoded(error);
        Assert.True(coded != null, Errors.Text(error));
        File.WriteAllText(Path.ChangeExtension(job, ".refusal.json"), coded!.Problems?.ToJsonString() + Environment.NewLine + Errors.Text(error));
        return (coded.Problems ?? new JsonArray()).OfType<JsonObject>().Where(p => p["severity"]?.ToString() != "warning").ToList();
    }

    private static JsonObject Html(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };
    private static JsonObject Flow(params string[] texts) => new() { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(texts.Select(t => (JsonNode)t).ToArray()) } };
    private static JsonObject Ddl(string text) => new() { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = text } };

    // The module content of a saved candidate, without keys: every screen and block of the job (ssam-html/1), every action whose
    // name starts with the prefix (ssam-flow/1) and the data text, each sorted by name.
    internal static string Content(string dir, string job, string prefix, string lane)
    {
        var bytes = File.ReadAllBytes(Path.ChangeExtension(job, ".oml"));
        var host = new ModelHost(Path.Combine(dir, "work"));
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        var parts = new List<string>();
        foreach (var document in host.HtmlRead(bytes, null, withKeys: false)["documents"]!.AsArray().OfType<JsonObject>())
            if (document["root"]?.ToString() is { } root && root.StartsWith(prefix, StringComparison.Ordinal))
                parts.Add("html " + root + "\n" + document["html"]);
        // An action of the job: its header (the first line that is not a description) names it or its owner with the prefix.
        static string Header(string text) => text.Split('\n').FirstOrDefault(l => l.Trim().Length > 0 && !l.TrimStart().StartsWith("///", StringComparison.Ordinal)) ?? "";
        foreach (var action in host.BuildFlow(bytes, sha, lane).Actions.Where(a => Regex.IsMatch(Header(a.Text), @"\b" + prefix)))
            parts.Add("flow " + Keyless.Replace(Header(action.Text), "") + "\n" + action.Text);
        var ddl = host.BuildDdl(bytes, sha, lane).Text;
        // The whole data text (its attribute lines too): the fixture's part is the same in every order.
        parts.Add("ddl\n" + string.Join("\n", ddl.Split('\n').Where(l => !l.StartsWith("-- ssam-ddl/", StringComparison.Ordinal))));
        parts.Sort(StringComparer.Ordinal);
        return Keyless.Replace(string.Join("\n----\n", parts), "@_");
    }

    private static readonly Regex Keyless = new(@"@[A-Za-z0-9+/_=#.\-]{2,}", RegexOptions.Compiled);

    // ---- the reference kinds, each a set of ops of one job (the providers and their consumers) ------------------------------

    /// <summary>The ops of one reference kind: a set of ops whose order the scenario permutes.</summary>
    internal sealed record Kind(string Name, Func<string, JsonObject[]> Ops);

    internal static IReadOnlyList<Kind> Kinds() =>
    [
        // A screen that navigates to a screen of the same job, with an argument of its input.
        new("navigation", lane => [
            Html($"<screen name=\"CmpList\"{Roles(lane)}>\n<a onclick=\"CmpDetail(ItemId = 7)\">Open</a>\n</screen>"),
            Html($"<screen name=\"CmpDetail\"{Roles(lane)}>\n<input name=\"ItemId\" type=\"Integer\"/>\n<p>{{{{ ItemId }}}}</p>\n</screen>")]),
        // Two screens that navigate to each other (a cycle: the one written first needs the other's signature).
        new("navigation cycle", lane => [
            Html($"<screen name=\"CmpHome\"{Roles(lane)}>\n<a onclick=\"CmpBack(Code = 1)\">Next</a>\n</screen>"),
            Html($"<screen name=\"CmpBack\"{Roles(lane)}>\n<input name=\"Code\" type=\"Integer\"/>\n<a onclick=\"CmpHome()\">Home</a>\n</screen>")]),
        // A block a screen of the same job uses, with an input.
        new("block", lane => [
            Html($"<screen name=\"CmpUsesBlock\"{Roles(lane)}>\n<Block name=\"CmpCard\" :Title=\"&quot;Hello&quot;\"/>\n</screen>"),
            Html("<block name=\"CmpCard\">\n<input name=\"Title\" type=\"Text\"/>\n<p>{{ Title }}</p>\n</block>")]),
        // A server action that calls a server action of another logic op of the job.
        new("call", _ => [
            Flow("/// Doubles the callee's value.\nserver action CmpCaller\n  out Total: Integer\n  Got = CmpCallee()\n  assign Total = Got.Value * 2\n  end\n"),
            Flow("/// Gives one.\nserver action CmpCallee\n  out Value: Integer\n  assign Value = 1\n  end\n")]),
        // A parameter typed with a structure a data text of the job declares.
        new("structure", _ => [
            Flow("/// Reads a row.\nserver action CmpTakesRow\n  in Row: CmpRow\n  out Label: Text\n  assign Label = Row.Label\n  end\n"),
            Ddl("/// A row of the composition test.\ntype CmpRow = {\n  /// The label.\n  Label: Text(50);\n}\n")]),
        // A screen action whose screen an html op of the same job creates.
        new("owner", lane => [
            Flow("/// Counts the clicks.\naction CmpCounter.Increment\n  assign Clicks = Clicks + 1\n  end\n"),
            Html($"<screen name=\"CmpCounter\"{Roles(lane)} actions=\"Increment\">\n<var name=\"Clicks\" type=\"Integer\"/>\n<button onclick=\"Increment\">+</button>\n</screen>")]),
    ];

    private static IEnumerable<int[]> Permutations(int n)
    {
        if (n == 1) { yield return [0]; yield break; }
        foreach (var rest in Permutations(n - 1))
            for (var at = 0; at < n; at++) { var p = rest.ToList(); p.Insert(at, n - 1); yield return p.ToArray(); }
    }

    /// <summary>Each reference kind, in every order of its ops: accepted, and the same module content in every order.</summary>
    public static void EveryOrderOfEveryReferenceKindBuildsTheSameModule(string dir, string fixture, string lane)
    {
        var failures = new List<string>();
        foreach (var kind in Kinds())
        {
            var ops = kind.Ops(lane);
            string? first = null;
            foreach (var order in Permutations(ops.Length))
            {
                var name = "cmp-" + kind.Name.Replace(' ', '-') + "-" + string.Join("", order);
                var job = Job(dir, name, fixture, lane, order.Select(i => (JsonNode)ops[i]));
                try
                {
                    var result = Accepted(dir, job);
                    var content = Content(dir, job, "Cmp", lane);
                    first ??= content;
                    if (content != first) failures.Add(kind.Name + " [" + string.Join(",", order) + "]: another module content than the first order:\n" + content + "\n=== first ===\n" + first);
                }
                catch (Exception error) { failures.Add(kind.Name + " [" + string.Join(",", order) + "]: " + error.Message); }
            }
        }
        Assert.True(failures.Count == 0, string.Join("\n\n", failures));
    }

    /// <summary>The generated sweep: every reference kind together in one job, in shuffled orders (a fixed seed per order):
    /// accepted, and the same module content as the first order.</summary>
    public static void AShuffledJobOfEveryReferenceKindBuildsTheSameModule(string dir, string fixture, string lane)
    {
        var ops = Kinds().SelectMany(k => k.Ops(lane)).ToList();
        string? first = null;
        var failures = new List<string>();
        for (var seed = 0; seed < 4; seed++)
        {
            var random = new Random(seed);
            var order = seed == 0 ? Enumerable.Range(0, ops.Count).ToArray() : Enumerable.Range(0, ops.Count).OrderBy(_ => random.Next()).ToArray();
            var job = Job(dir, "cmp-all-" + seed, fixture, lane, order.Select(i => (JsonNode)ops[i]));
            try
            {
                Accepted(dir, job);
                var content = Content(dir, job, "Cmp", lane);
                first ??= content;
                if (content != first) failures.Add("[" + string.Join(",", order) + "]: another module content than the first order");
            }
            catch (Exception error) { failures.Add("[" + string.Join(",", order) + "]: " + error.Message); }
        }
        Assert.True(failures.Count == 0, string.Join("\n\n", failures));
    }

    // ---- flows: aliases are never the agent's job ----------------------------------------------------------------------------

    private const string One = "/// Gives one.\nclient action CmpOne\n  out Value: Integer\n  assign Value = 1\n  end\n";

    /// <summary>The same logic with and without hand-made aliases (two calls of one action, two List actions, nested ifs):
    /// both accepted, both fixed points of their text; the names the text does not give are the ones the engine generates.</summary>
    public static void TheSameLogicWithoutAliasesBuildsAsWithThem(string dir, string fixture, string lane)
    {
        const string bare = "/// Calls twice, appends twice.\nclient action CmpBare\n  in Flag: Boolean\n  out Items: Integer List\n  out Total: Integer\n"
            + "  CmpOne()\n  CmpOne()\n  (System).ListAppend(List=Items, Element=1)\n  (System).ListAppend(List=Items, Element=2)\n"
            + "  if Flag:\n    if Total > 0:\n      assign Total = Total + 1\n      end\n    end\n  end\n";
        const string named = "/// Calls twice, appends twice.\nclient action CmpNamed\n  in Flag: Boolean\n  out Items: Integer List\n  out Total: Integer\n"
            + "  First = CmpOne()\n  Second = CmpOne()\n  AddOne = (System).ListAppend(List=Items, Element=1)\n  AddTwo = (System).ListAppend(List=Items, Element=2)\n"
            + "  if Flag:\n    if Total > First.Value + Second.Value:\n      assign Total = Total + 1\n      end\n    end\n  end\n";
        var job = Job(dir, "cmp-aliases", fixture, lane, [Flow(One, bare, named)]);
        var result = Accepted(dir, job);
        var bytes = File.ReadAllBytes(Path.ChangeExtension(job, ".oml"));
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        var flows = new ModelHost(Path.Combine(dir, "work")).BuildFlow(bytes, sha, lane).Actions;
        foreach (var name in new[] { "CmpBare", "CmpNamed" }) Assert.True(flows.Single(a => a.Name == name).FixedPoint, name);
        var text = flows.Single(a => a.Name == "CmpBare").Text;
        Assert.Contains("CmpOne2 = CmpOne()", text);
        Assert.Contains("ListAppend2 = (System).ListAppend(", text);
    }

    /// <summary>The alias fix: a node whose name the text gives and its scope already holds (a variable of the screen of a
    /// screen action). The platform names the node otherwise and the text's name says two things (the node, the variable):
    /// refused once naming both, with the next step (rename the node), never FLOW_NOT_EXACT (what the receipts showed: expected
    /// node Loaded, read node Loaded2). With the node renamed as the fix says, accepted.</summary>
    public static void ANodeNameTheScopeHoldsIsRefusedNamingBoth(string dir, string fixture, string lane)
    {
        var screen = Html($"<screen name=\"CmpScope\"{Roles(lane)} actions=\"Reload\">\n<var name=\"Loaded\" type=\"Integer\"/>\n<var name=\"Count\" type=\"Integer\"/>\n"
            + "<button onclick=\"Reload\">Reload</button>\n</screen>");
        var reload = "/// Reads one into the count.\naction CmpScope.Reload\n  Loaded = CmpOne()\n  assign Count = Loaded.Value + 1\n  end\n";
        var problems = Refused(dir, Job(dir, "cmp-scope", fixture, lane, [screen, Flow(One, reload)]));
        Assert.DoesNotContain(problems, p => p["code"]!.ToString() == "FLOW_NOT_EXACT");
        var taken = Assert.Single(problems, p => p["code"]!.ToString() == "FLOW_NODE_NAME_TAKEN");
        Assert.Equal("Loaded", taken["node"]!.ToString());
        Assert.Contains("Variable Loaded", taken["holder"]!.ToString());
        Assert.Contains("Loaded2", taken["fix"]!.ToString());
        var renamed = reload.Replace("Loaded = CmpOne()", "LoadedOne = CmpOne()").Replace("Loaded.Value", "LoadedOne.Value");
        var job = Job(dir, "cmp-scope-renamed", fixture, lane, [screen, Flow(One, renamed)]);
        Accepted(dir, job);
        var bytes = File.ReadAllBytes(Path.ChangeExtension(job, ".oml"));
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        Assert.Contains("assign Count = LoadedOne.Value + 1", new ModelHost(Path.Combine(dir, "work")).BuildFlow(bytes, sha, lane).Actions
            .Single(a => a.Text.Contains("action CmpScope.Reload", StringComparison.Ordinal)).Text);
    }
    /// <summary>The JSON form of the logic op answers a call named like an element of its scope as the text form does (F5's
    /// ScopeHolder): a variable of the screen or a widget of it holds the call's name, the platform numbers the call, and the
    /// name says two things (the call, the element). Both forms refuse it naming both (FLOW_NODE_NAME_TAKEN, with the name the
    /// platform gives); neither rewrites the references (the JSON form renamed them silently: Loaded.Value -> Loaded2.Value).
    /// The call renamed as the fix says is accepted and reads its own value.</summary>
    public static void ACallNamedLikeItsScopeIsRefusedOnTheJsonAndTheTextForm(string dir, string fixture, string lane)
    {
        var screen = Html($"<screen name=\"CmpCallScope\"{Roles(lane)}>\n<var name=\"Loaded\" type=\"Integer\"/>\n<var name=\"Count\" type=\"Integer\"/>\n"
            + "<input id=\"CountInput\" bind=\"Count\"/>\n</screen>");
        static JsonNode Json(string alias) => JsonNode.Parse("""
            {"op":"logic","data":{"actions":[{"name":"Probe","kind":"screen","owner":"IMobileScreen:CmpCallScope","steps":[
              {"call":"CmpOne","as":"ALIAS"},
              {"assign":{"Count":"ALIAS.Value + 1"}}]}]}}
            """.Replace("ALIAS", alias))!;
        static JsonObject Text(string alias) => Flow("/// Reads one into the count.\naction CmpCallScope.Probe\n  " + alias + " = CmpOne()\n  assign Count = " + alias + ".Value + 1\n  end\n");
        foreach (var (alias, holder) in new[] { ("Loaded", "Variable Loaded"), ("CountInput", "CountInput") })
            foreach (var (form, op) in new[] { ("json", Json(alias)), ("text", (JsonNode)Text(alias)) })
            {
                var problems = Refused(dir, Job(dir, $"cmp-call-scope-{form}-{alias}", fixture, lane, [screen, Flow(One), op]));
                var context = form + " " + alias + ": " + string.Join("\n", problems.Select(p => p.ToJsonString()));
                var taken = problems.SingleOrDefault(p => p["code"]!.ToString() == "FLOW_NODE_NAME_TAKEN");
                Assert.True(taken != null, context);
                Assert.Equal(alias, taken!["node"]!.ToString());
                Assert.Equal(alias + "2", taken["given"]!.ToString());
                Assert.Contains(holder, taken["holder"]!.ToString());
                Assert.Contains(alias + "2", taken["fix"]!.ToString());
                // Nothing is written with a name the author did not write.
                Assert.DoesNotContain(problems, p => p["code"]?.ToString() == "LOGIC_NATIVE_CALL_RENAMED");
            }
        // The call named as nothing of its scope is: accepted, and the count reads the call's own value.
        var renamed = Job(dir, "cmp-call-scope-json-renamed", fixture, lane, [screen, Flow(One), Json("LoadedOne")]);
        var result = Accepted(dir, renamed);
        Assert.DoesNotContain("LOGIC_NATIVE_CALL_RENAMED", result["normalizations"]?.ToJsonString() ?? "");
        var bytes = File.ReadAllBytes(Path.ChangeExtension(renamed, ".oml"));
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        Assert.Contains("assign Count = LoadedOne.Value + 1", new ModelHost(Path.Combine(dir, "work")).BuildFlow(bytes, sha, lane).Actions
            .Single(a => a.Text.Contains("action CmpCallScope.Probe", StringComparison.Ordinal)).Text);
    }

    /// <summary>A navigation to a screen that neither the module nor the job has is refused once, naming it, wherever the op
    /// is; the screen the job does create is not reported.</summary>
    public static void AReferenceToAnElementThatExistsNowhereIsRefusedOnceNamingIt(string dir, string fixture, string lane)
    {
        foreach (var flip in new[] { false, true })
        {
            JsonNode[] ops = [
                Html($"<screen name=\"CmpMissingNav\"{Roles(lane)}>\n<a onclick=\"CmpNowhere(Id = 1)\">Go</a>\n<a onclick=\"CmpThere()\">There</a>\n</screen>"),
                Html($"<screen name=\"CmpThere\"{Roles(lane)}>\n<p>here</p>\n</screen>")];
            var problems = Refused(dir, Job(dir, "cmp-missing-" + flip, fixture, lane, flip ? ops.Reverse() : ops));
            var named = problems.Where(p => (p["message"] + "").Contains("CmpNowhere", StringComparison.Ordinal)).ToList();
            Assert.True(named.Count == 1, string.Join("\n", problems.Select(p => p.ToJsonString())));
            Assert.DoesNotContain(problems, p => (p["message"] + "").Contains("CmpThere", StringComparison.Ordinal));
        }
        // A call to an action that exists nowhere: one problem that names it.
        var call = Refused(dir, Job(dir, "cmp-missing-call", fixture, lane, [Flow("/// Calls nothing.\nserver action CmpOrphan\n  out N: Integer\n  Got = CmpNoSuchAction()\n  assign N = 1\n  end\n")]));
        Assert.Single(call, p => (p["message"] + "").Contains("CmpNoSuchAction", StringComparison.Ordinal));
    }
}
