using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Family F5, the review of a0a23ad8 (R1–R7): what the composition must never do. A job that is valid in its written order
/// stays valid (no need taken from a word, nothing moved across an op the kernel does not read); the last write as written
/// wins; a screen declared first because another navigates to it is refused for its own document's problems only, and its
/// corrected document is checked as when nothing navigates to it; a node named like an element of its scope is refused
/// naming both, never renamed with the variable the text assigns. Real jobs through JobRunner on the Reactive fixture.
/// </summary>
public sealed class CompositionSafetyTests
{
    private const string Fixture = "reactive-ui.oml";

    private static string Dir()
    {
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "composition-safety", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string Job(string dir, string name, IEnumerable<JsonNode> ops)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, new JsonObject { ["base"] = Fixture, ["expectedMessages"] = new JsonArray(), ["ops"] = new JsonArray(ops.Select(o => o.DeepClone()).ToArray()) }.ToJsonString());
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

    // The problems of a refusal (warnings left out), or null when the job was accepted.
    private static List<JsonObject>? Problems(string dir, string job)
    {
        try
        {
            var result = Run(dir, job);
            if (result["accepted"]?.GetValue<bool>() == true) return null;
            return (result["problems"] as JsonArray ?? []).OfType<JsonObject>().Where(p => p["severity"]?.ToString() != "warning").ToList();
        }
        catch (Exception error)
        {
            var coded = Errors.FindCoded(error);
            Assert.True(coded != null, Errors.Text(error));
            return (coded!.Problems ?? new JsonArray()).OfType<JsonObject>().Where(p => p["severity"]?.ToString() != "warning").ToList();
        }
    }

    private static string Text(IEnumerable<JsonObject> problems) => string.Join("\n", problems.Select(p => p.ToJsonString()));

    private static JsonObject Html(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };
    private static JsonObject Flow(params string[] texts) => new() { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(texts.Select(t => (JsonNode)t).ToArray()) } };
    private const string One = "/// Gives one.\nclient action CmpRvOne\n  out Value: Integer\n  assign Value = 1\n  end\n";

    private static string HtmlOf(string dir, string job, string root)
    {
        var bytes = File.ReadAllBytes(Path.ChangeExtension(job, ".oml"));
        return new ModelHost(Path.Combine(dir, "work")).HtmlRead(bytes, null, withKeys: false)["documents"]!.AsArray().OfType<JsonObject>()
            .Single(d => d["root"]?.ToString() == root)["html"]!.ToString();
    }

    // R1: valid as written. An output parameter of op 0 is named like the action op 2 creates (a parameter's name is no
    // reference), and op 2 calls an action a raw create (op 1, a barrier) makes.
    [Fact]
    public void AParameterNamedLikeALaterActionMovesNothing()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var result = Accepted(dir, Job(dir, "r1", [
            Flow("/// First.\nserver action CmpRvFirst\n  out CmpRvSecond: Integer\n  assign CmpRvSecond = 1\n  end\n"),
            JsonNode.Parse("""{"op":"create","parent":"@espace","type":"IServerAction","name":"CmpRvHelper","as":"$helper"}""")!,
            JsonNode.Parse("""{"op":"create","parent":"$helper","type":"IStartNode","as":"$start"}""")!,
            JsonNode.Parse("""{"op":"create","parent":"$helper","type":"IEndNode","as":"$end"}""")!,
            JsonNode.Parse("""{"op":"link","from":"$start","to":"$end"}""")!,
            Flow("/// Second.\nserver action CmpRvSecond\n  CmpRvHelper()\n  end\n")]));
        Assert.Null(result["composedOrder"]);
    }

    // R1b: the same, the raw ops (a barrier) build the structure the last op types an input with.
    [Fact]
    public void RawOpsThatBuildAStructureAreABarrier()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var result = Accepted(dir, Job(dir, "r1b", [
            Flow("/// First.\nserver action CmpRvFirst\n  out CmpRvSecond: Integer\n  assign CmpRvSecond = 1\n  end\n"),
            JsonNode.Parse("""{"op":"create","parent":"@espace","type":"IStructure","name":"CmpRvRow","as":"$st"}""")!,
            JsonNode.Parse("""{"op":"create","parent":"$st","type":"IStructureAttribute","name":"Label","as":"$label"}""")!,
            JsonNode.Parse("""{"op":"set","target":"$label","prop":"DataType","value":"Text"}""")!,
            Flow("/// Second.\nserver action CmpRvSecond\n  in Row: CmpRvRow\n  out Label: Text\n  assign Label = Row.Label\n  end\n")]));
        Assert.Null(result["composedOrder"]);
    }

    // R2: the text names a node like a variable of the screen and assigns the node's value to that variable: the name says two
    // things. Refused naming the node and the variable, never written with a name the author did not write.
    [Fact]
    public void ANodeNamedLikeAScreenVariableIsRefusedNamingBoth()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var screen = Html("<screen name=\"CmpRvScope\" roles=\"Registered\" actions=\"Reload\">\n<var name=\"Loaded\" type=\"Integer\"/>\n"
            + "<button onclick=\"Reload\">Reload</button>\n<p>{{ Loaded }}</p>\n</screen>");
        var reload = "/// Reads one into the variable.\naction CmpRvScope.Reload\n  Loaded = CmpRvOne()\n  assign Loaded = Loaded.Value\n  end\n";
        var problems = Problems(dir, Job(dir, "r2", [screen, Flow(One, reload)]));
        Assert.NotNull(problems);
        var taken = Assert.Single(problems!, p => p["code"]?.ToString() == "FLOW_NODE_NAME_TAKEN");
        Assert.Contains("Loaded", taken["node"]!.ToString());
        Assert.Contains("LocalVariable Loaded", taken["holder"]!.ToString());
        Assert.Contains("Loaded2", taken["fix"]!.ToString());
        // Nothing is written with a name the author did not write.
        Assert.DoesNotContain(problems!, p => p["phase"]?.ToString() == "verify" && (p["message"] + "").Contains("Loaded2", StringComparison.Ordinal));
    }

    // R3: the screen declared first because another navigates to it; its own document names nothing that exists: refused for
    // that name only.
    [Fact]
    public void ADeclaredScreenWhoseDocumentFailsIsRefusedForItsOwnProblem()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var problems = Problems(dir, Job(dir, "r3", [
            Html("<screen name=\"CmpRvHome\" roles=\"Registered\">\n<a onclick=\"CmpRvDetail(Id = 1)\">Open</a>\n</screen>"),
            Html("<screen name=\"CmpRvDetail\" roles=\"Registered\">\n<input name=\"Id\" type=\"Integer\"/>\n<p>{{ NoSuchName }}</p>\n</screen>")]));
        Assert.NotNull(problems);
        Assert.Contains(problems!, p => (p["message"] + "").Contains("NoSuchName", StringComparison.Ordinal));
        Assert.DoesNotContain(problems!, p => p["code"]?.ToString() == ScreenDocument.RootExists);
    }

    // R3b: the same, its document refused at compile (a block nothing has).
    [Fact]
    public void ADeclaredScreenWhoseDocumentIsRefusedAtCompileNamesItsBlock()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var problems = Problems(dir, Job(dir, "r3b", [
            Html("<screen name=\"CmpRvHome2\" roles=\"Registered\">\n<a onclick=\"CmpRvDetail2(Id = 1)\">Open</a>\n</screen>"),
            Html("<screen name=\"CmpRvDetail2\" roles=\"Registered\">\n<input name=\"Id\" type=\"Integer\"/>\n<Block name=\"CmpRvNoSuchBlock\"/>\n</screen>")]));
        Assert.NotNull(problems);
        Assert.Contains(problems!, p => (p["message"] + "").Contains("CmpRvNoSuchBlock", StringComparison.Ordinal));
        Assert.DoesNotContain(problems!, p => p["code"]?.ToString() == ScreenDocument.RootExists);
    }

    // R4: a raw set written before the document of its target keeps its place (a barrier): refused as written, naming it.
    [Fact]
    public void ARawSetBeforeTheDocumentOfItsTargetKeepsItsPlace()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var problems = Problems(dir, Job(dir, "r4", [
            JsonNode.Parse("""{"op":"set","target":"IMobileScreen:CmpRvTitled","prop":"Description","value":"from the set (op 0)"}""")!,
            Html("<screen name=\"CmpRvTitled\" roles=\"Registered\">\n<p>x</p>\n</screen>")]));
        Assert.NotNull(problems);
        Assert.Contains(problems!, p => (p["message"] + "").Contains("CmpRvTitled", StringComparison.Ordinal) && p["op"]?.ToString() == "0");
    }

    // R4b: two writers of one property, the raw set first and the document last: the last write as written wins (or the job is
    // refused as written); never the set's value over the document's.
    [Fact]
    public void TheLastWriteAsWrittenWins()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var job = Job(dir, "r4b", [
            JsonNode.Parse("""{"op":"set","target":"IMobileScreen:CmpRvTitled2","prop":"Description","value":"from the set (op 0)"}""")!,
            Html("<screen name=\"CmpRvTitled2\" description=\"from the document (op 1, written last)\" roles=\"Registered\">\n<p>x</p>\n</screen>")]);
        var problems = Problems(dir, job);
        if (problems == null) Assert.DoesNotContain("from the set (op 0)", HtmlOf(dir, job, "CmpRvTitled2"));
        else Assert.Contains(problems, p => p["op"]?.ToString() == "0");
    }

    // R5: a navigation written in another case than the screen's name: the same screen (OutSystems names have no case).
    [Fact]
    public void ANavigationInAnotherCaseReachesTheScreenOfTheJob()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        Accepted(dir, Job(dir, "r5", [
            Html("<screen name=\"CmpRvA\" roles=\"Registered\">\n<a onclick=\"cmprvb(Id = 1)\">Open</a>\n</screen>"),
            Html("<screen name=\"CmpRvB\" roles=\"Registered\">\n<input name=\"Id\" type=\"Integer\"/>\n<p>b</p>\n</screen>")]));
    }

    // R6: the page form, then the logic op that declares its screen action (H10) and a client action its text only mentions:
    // builds as written; and the logic op written first runs after the page whose screen it needs.
    [Fact]
    public void APageAndItsLogicOpBuildInBothOrders()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var page = new JsonObject { ["op"] = "html", ["data"] = JsonNode.Parse("""{"screen":"CmpRvPg","title":"Pg","layout":"blank","html":"<div><p>Run CmpRvFormatar before saving</p><button data-av=\"go\">Save</button></div>","bindings":{"go":{"kind":"call","action":"CmpRvSalvar"}}}""") };
        var logic = JsonNode.Parse("""{"op":"logic","data":{"actions":[{"name":"CmpRvFormatar","description":"Formats.","kind":"client","steps":[]},{"name":"CmpRvSalvar","description":"Saves.","kind":"screen","owner":"IMobileScreen:CmpRvPg","steps":[]}]}}""")!;
        Assert.Null(Accepted(dir, Job(dir, "r6", [page, logic]))["composedOrder"]);
        var reversed = Accepted(dir, Job(dir, "r6-reversed", [logic, page]));
        Assert.Contains(reversed["composedOrder"]!.AsArray(), m => m!["op"]!.GetValue<int>() == 1 && m["before"]?.GetValue<int>() == 0);
    }

    // The page form calls a client action a later logic op declares (the old HTML_CALL_ORDER): through the planner, built.
    [Fact]
    public void APageThatCallsAnActionOfALaterLogicOpBuilds()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var page = new JsonObject { ["op"] = "html", ["data"] = JsonNode.Parse("""{"screen":"CmpRvCalls","title":"Calls","layout":"blank","html":"<div><button data-av=\"go\">Go</button></div>","bindings":{"go":{"kind":"call","action":"CmpRvGo"}}}""") };
        var logic = JsonNode.Parse("""{"op":"logic","data":{"actions":[{"name":"CmpRvGo","description":"Goes.","kind":"client","steps":[]}]}}""")!;
        var result = Accepted(dir, Job(dir, "page-call", [page, logic]));
        Assert.Contains(result["composedOrder"]!.AsArray(), m => m!["op"]!.GetValue<int>() == 1 && m["before"]?.GetValue<int>() == 0);
        Assert.Contains(result["composedOrder"]!.AsArray(), m => m!["op"]!.GetValue<int>() == 0 && m["to"]?.GetValue<int>() == 1);
    }

    // R7: a declared screen whose document has a name the kernel corrects (one nearest): the same refusal and patch as when
    // nothing navigates to it (R7b), never HTML_ROOT_EXISTS.
    [Fact]
    public void ADeclaredScreenGetsTheSameCorrectedDocumentAsAnUndeclaredOne()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var info = Html("<screen name=\"CmpRvInfo\" roles=\"Registered\">\n<input name=\"Id\" type=\"Integer\"/>\n<a onclick=\"CmpRvStar()\">Back</a>\n</screen>");
        var declared = Problems(dir, Job(dir, "r7a", [Html("<screen name=\"CmpRvStart\" roles=\"Registered\">\n<a onclick=\"CmpRvInfo(Id = 1)\">Open</a>\n</screen>"), info]));
        var control = Problems(dir, Job(dir, "r7b", [Html("<screen name=\"CmpRvStart\" roles=\"Registered\">\n<p>start</p>\n</screen>"), info]));
        Assert.NotNull(declared); Assert.NotNull(control);
        Assert.DoesNotContain(declared!, p => p["code"]?.ToString() == ScreenDocument.RootExists);
        Assert.Equal(control!.Select(p => p["code"]?.ToString()).Order(), declared!.Select(p => p["code"]?.ToString()).Order());
        var named = Assert.Single(declared!, p => p["code"]?.ToString() == ScreenDocument.NameUnknown);
        Assert.IsType<JsonArray>(named["patch"]);
        Assert.Contains("CmpRvStart", named["patch"]!.ToJsonString());
    }
}
