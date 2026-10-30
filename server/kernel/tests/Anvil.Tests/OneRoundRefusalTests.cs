using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using System.Reflection;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R2-B (one round, MINERACAO F2 and F18): a validated job goes through every phase that does not depend on another's result
/// and is refused once, with the problems of every phase. A part that fails never hides the parts that do not need it, and a
/// part that needs it is judged against its stub (the signature it declares). A problem whose one correction the refusal
/// already knows comes with that patch, certain, and the patched job passes the next round.
/// </summary>
public sealed class OneRoundRefusalTests
{
    private static string Dir(string name)
    {
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "one-round-tests", name + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        return dir;
    }

    // The kernel log of the last refused job (in the messages of a failed assertion).
    private static readonly List<string> Log = [];
    private static string LogText() { lock (Log) return string.Join(Environment.NewLine, Log.TakeLast(60)); }

    private static JobPreflightException Refused(string dir, JsonObject job, string file = "job.json")
    {
        var path = Path.Combine(dir, file);
        File.WriteAllText(path, job.ToJsonString());
        var output = Path.Combine(dir, Path.GetFileNameWithoutExtension(file) + ".oml");
        Log.Clear();
        Exception? error = null;
        object? result = null;
        try { result = JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, output, line => { lock (Log) Log.Add(line); }); }
        catch (Exception ex) { error = ex; }
        Assert.True(error != null, "no refusal: " + LogText() + Environment.NewLine + System.Text.Json.JsonSerializer.Serialize(result));
        Assert.False(File.Exists(output));
        // A lone coded failure keeps its own refusal (A7: DDL_NOT_CONVERGED, DELETE_HAS_CONSUMERS): the same code and problems.
        var coded = Errors.FindCoded(error);
        Assert.True(coded is JobPreflightException || coded?.Problems is { Count: > 0 }, Errors.Text(error) + Environment.NewLine + error);
        return coded as JobPreflightException ?? new JobPreflightException(Errors.Text(error), coded!.Problems!.DeepClone().AsArray());
    }

    private static void Passes(string dir, JsonObject job, string file)
    {
        var path = Path.Combine(dir, file);
        File.WriteAllText(path, job.ToJsonString());
        var output = Path.Combine(dir, Path.GetFileNameWithoutExtension(file) + ".oml");
        JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, output);
        Assert.True(File.Exists(output));
    }

    private static List<JsonObject> Problems(JobPreflightException refusal) => refusal.Problems.OfType<JsonObject>().ToList();

    private static JsonObject Logic(params string[] texts) => new() { ["op"] = "logic", ["data"] = new JsonObject {
        ["flow"] = texts.Length == 1 ? JsonValue.Create(texts[0]) : new JsonArray(texts.Select(t => (JsonNode)JsonValue.Create(t)!).ToArray()) } };

    // ---- rule 1 and 2: one refusal with every phase -----------------------------------------------------------------------

    /// <summary>Three independent problems of one logic op, each found by another phase: a call the scope phase cannot resolve,
    /// a parameter of a type the apply cannot write, and an assignment only the Verify judges. Before, the scope phase left the
    /// whole op out (round 1), the unknown type then failed the op whole and hid the Verify (round 2), and the Verify came in
    /// round 3. Now the three come in one refusal, ordered by op, each with its phase.</summary>
    [Fact]
    public void ThreeIndependentProblemsInThreePhasesComeInOneRefusal()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir("three-phases");
        var refusal = Refused(dir, new JsonObject { ["base"] = "blank-service.oml", ["ops"] = new JsonArray(Logic(
            "server action CallsWhatIsNowhere\n  NowhereToBeFound()\n  end\n",
            "server action TakesAnUnknownType\n  in Amount: NoSuchTypeAnywhere\n  end\n",
            "server action AssignsTheWrongType\n  out Code: Integer\n  assign Code = \"abc\"\n  end\n")) });
        var problems = Problems(refusal);
        Assert.True(refusal.VerifyRan, string.Join(" | ", problems.Select(p => p.ToJsonString())));
        Assert.Contains(problems, p => p["pointer"]?.ToString() == "/ops/0/data/flow/0" && p["phase"]?.ToString() is "scope" or "apply"
            && p["message"]!.ToString().Contains("NowhereToBeFound", StringComparison.Ordinal));
        Assert.Contains(problems, p => p["pointer"]?.ToString() == "/ops/0/data/flow/1" && p["phase"]?.ToString() is "base" or "apply"
            && p["message"]!.ToString().Contains("NoSuchTypeAnywhere", StringComparison.Ordinal));
        Assert.Contains(problems, p => p["pointer"]?.ToString() == "/ops/0/data/flow/2" && p["phase"]?.ToString() == "verify"
            && p["code"]?.ToString() == "ExpressionInvalidExpressionType");
        // Said once: the scope's unknown call and the apply's are one place.
        Assert.Single(problems, p => p["pointer"]?.ToString() == "/ops/0/data/flow/0");
        Assert.DoesNotContain(problems, p => p["code"]?.ToString() == ScopePhase.Blocked);
        Assert.All(problems, p => Assert.False(string.IsNullOrEmpty(p["phase"]?.ToString())));
    }

    /// <summary>An op that calls an action a refused op declares is built against the stub of that action (its declared
    /// signature, no body) and its own fault comes in the same refusal, instead of "the ops it blocks need no change".</summary>
    [Fact]
    public void AnOpThatNeedsARefusedOpIsJudgedAgainstItsStub()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir("stub-scope");
        var refusal = Refused(dir, new JsonObject { ["base"] = "blank-service.oml", ["ops"] = new JsonArray(
            Logic("server action ProvidesAValue\n  out Value: Integer\n  NowhereToBeFound()\n  assign Value = 1\n  end\n"),
            Logic("server action UsesTheProvider\n  out Code: Integer\n  ProvidesAValue()\n  assign Code = \"abc\"\n  end\n")) });
        var problems = Problems(refusal);
        var dump = string.Join(" | ", problems.Select(p => p.ToJsonString()));
        Assert.Contains(problems, p => p["op"]?.GetValue<int>() == 0 && p["message"]!.ToString().Contains("NowhereToBeFound", StringComparison.Ordinal));
        // The dependent's own problem, found by the Verify against the stub; nothing about the provider's name in op #1.
        Assert.Contains(problems, p => p["op"]?.GetValue<int>() == 1 && p["phase"]?.ToString() == "verify" && p["code"]?.ToString() == "ExpressionInvalidExpressionType");
        Assert.DoesNotContain(problems, p => p["op"]?.GetValue<int>() == 1 && p["message"]!.ToString().Contains("ProvidesAValue", StringComparison.Ordinal));
        Assert.DoesNotContain(problems, p => p["code"]?.ToString() == ScopePhase.Blocked);
        Assert.DoesNotContain(refusal.Warnings.OfType<JsonObject>(), w => w["code"]?.ToString() == "APPLY_SKIPPED" && w["op"]?.GetValue<int>() == 1);
        // Ordered by op.
        Assert.Equal(problems.Select(p => p["op"]?.GetValue<int>() ?? int.MaxValue).Order(), problems.Select(p => p["op"]?.GetValue<int>() ?? int.MaxValue));
        Assert.True(refusal.VerifyRan, dump);
    }

    /// <summary>The same for an op that fails whole at apply (a JSON action with a variable of an unknown type): the op after it
    /// that calls its action is applied against its stub, never skipped.</summary>
    [Fact]
    public void AnOpAfterAFailedOpIsJudgedAgainstItsStubNotSkipped()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir("stub-apply");
        var refusal = Refused(dir, JsonNode.Parse("""
            {"base":"blank-service.oml","ops":[
              {"op":"logic","data":{"actions":[{"name":"ComputesAValue","outputs":[{"name":"Value","type":"Integer"}],
                "vars":[{"name":"Scratch","type":"NoSuchTypeAnywhere"}],"steps":[{"assign":{"Value":"1"}}]}]}},
              {"op":"logic","data":{"flow":"server action CallsTheFailedOne\n  out Code: Integer\n  ComputesAValue()\n  assign Code = \"abc\"\n  end\n"}}
            ]}
            """)!.AsObject());
        var problems = Problems(refusal);
        var dump = $"verifyRan={refusal.VerifyRan} reason={refusal.VerifyReason} phases={string.Join(",", refusal.Phases ?? [])} message={refusal.Message} :: " + LogText() + " :: " + string.Join(" | ", problems.Concat(refusal.Warnings.OfType<JsonObject>()).Select(p => p.ToJsonString()));
        Assert.True(problems.Any(p => p["op"]?.GetValue<int>() == 0 && p["message"]!.ToString().Contains("NoSuchTypeAnywhere", StringComparison.Ordinal)), dump);
        Assert.True(problems.Any(p => p["op"]?.GetValue<int>() == 1 && p["phase"]?.ToString() == "verify" && p["code"]?.ToString() == "ExpressionInvalidExpressionType"), dump);
        Assert.False(refusal.Warnings.OfType<JsonObject>().Any(w => w["code"]?.ToString() == "APPLY_SKIPPED"), dump);
    }

    // ---- rule 3: the certain patch, and the next round passes -------------------------------------------------------------

    /// <summary>A path whose segment names a child by a kind it is not (here a kind the model does not have), when exactly one
    /// child has that name: the patch writes the child by its name, certain, and the job with it passes. With the kernel's
    /// automatic patching (the default), that next round is the same call: the job is saved with the patch in its receipt.</summary>
    [Fact]
    public void AChildWrittenByItsNameIsACertainPatchThatPasses()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir("child-by-name");
        File.WriteAllText(Path.Combine(dir, "first.json"), new JsonObject { ["base"] = "blank-service.oml", ["ops"] = new JsonArray(
            Logic("server action HoldsAParameter\n  out Amount: Integer\n  assign Amount = 1\n  end\n")) }.ToJsonString());
        JsonObject Second(string target) => new() { ["base"] = "job:first", ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = "Description", ["value"] = "what the action gives back" }) };
        JobPreflightException refusal;
        using (JobPreflight.UseAutoPatch(false)) refusal = Refused(dir, Second("IServerAction:HoldsAParameter/IExecuteParameterNode:Amount"), "second.json");
        var child = Assert.Single(Problems(refusal), p => p["code"]?.ToString() == "CHILD_NOT_FOUND");
        Assert.Equal("CHILD_BY_NAME", child["patchRule"]?.ToString());
        Assert.True(child["patchCertain"]?.GetValue<bool>(), child.ToJsonString());
        Assert.Null(child["patchChoice"]);
        var patch = Assert.Single(child["patch"]!.AsArray()).AsObject();
        Assert.Equal("/ops/0/target", patch["path"]?.ToString());
        Assert.Equal("IServerAction:HoldsAParameter/Amount", patch["value"]?.ToString());
        Passes(dir, Second(patch["value"]!.ToString()), "patched.json");
        // Automatic patching on: one call, saved, the patch said in the receipt.
        var path = Path.Combine(dir, "auto.json");
        File.WriteAllText(path, Second("IServerAction:HoldsAParameter/IExecuteParameterNode:Amount").ToJsonString());
        var receipt = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, Path.Combine(dir, "auto.oml")))!;
        Assert.Contains("CHILD_BY_NAME", receipt["patchesApplied"]?.ToJsonString() ?? "", StringComparison.Ordinal);
    }

    /// <summary>Names the platform cuts to the length it keeps (several of one data text): every problem carries the same
    /// patch, the text with every cut name as the platform kept it, certain (PLATFORM_NAME_KEPT). Before, each problem had its
    /// own text with its one rename, no rule: applying them gave one rename per round. The corrected text converges.</summary>
    [Fact]
    public void TheCutNamesAreOneCertainPatchThatConverges()
    {
        const string text = "create entity ProbeOfLongNames (\n  Id Long Integer identifier auto required,\n  First Text(50),\n  Second Text(50)\n);\n"
            + "create unique index UQ_ProbeOfLongNames_FirstColumnIndex on ProbeOfLongNames (First);\n"
            + "create index IX_ProbeOfLongNames_SecondColumnIndex on ProbeOfLongNames (Second);\n";
        static DdlElement Index(string name, int line) => new() { Kind = "EntityIndex", Name = name, Line = line };
        var lost = new List<(DdlElement Element, DdlElement? Became)> {
            (Index("UQ_ProbeOfLongNames_FirstColumnIndex", 6), Index("UQ_ProbeOfLongNames_FirstCol", 6)),
            (Index("IX_ProbeOfLongNames_SecondColumnIndex", 7), Index("IX_ProbeOfLongNames_SecondCo", 7)) };
        var all = typeof(ModelSession).GetMethod("RenamedAll", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.True(all != null, "the problems of one data text are composed by ModelSession.RenamedAll");
        var problems = (IReadOnlyList<DdlProblem>)all!.Invoke(null, [lost, text])!;
        var refusal = SpecExpander.DdlRefusal("DDL_NOT_CONVERGED", problems);
        var cut = refusal.Problems!.OfType<JsonObject>().ToList();
        Assert.Equal(2, cut.Count);
        Assert.All(cut, p => Assert.Equal("PLATFORM_NAME_KEPT", p["patchRule"]?.ToString()));
        Assert.All(cut, p => Assert.True(p["patchCertain"]?.GetValue<bool>(), p.ToJsonString()));
        var patch = Assert.Single(Assert.Single(cut.Select(p => p["patch"]!.ToJsonString()).Distinct()) is { } one ? JsonNode.Parse(one)!.AsArray() : []).AsObject();
        Assert.Equal("/ddl", patch["path"]?.ToString());
        var corrected = patch["value"]!.ToString();
        Assert.Equal(text.Replace("UQ_ProbeOfLongNames_FirstColumnIndex", "UQ_ProbeOfLongNames_FirstCol").Replace("IX_ProbeOfLongNames_SecondColumnIndex", "IX_ProbeOfLongNames_SecondCo"), corrected);
        // Another name (not a cut) keeps no patch and no rule.
        var other = SpecExpander.DdlRefusal("DDL_NOT_CONVERGED", [ModelSession.Renamed(Index("IX_A", 1), Index("IX_A_1", 1), "create index IX_A on T (A);")]);
        Assert.Null(other.Problems![0]!["patchRule"]);
        Assert.False(other.Problems![0]!["patchCertain"]!.GetValue<bool>());
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        Passes(Dir("cut-names"), new JsonObject { ["base"] = "blank-service.oml", ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = corrected } }) }, "patched.json");
    }

    // ---- review of R2-B (C:\t\r2\REVISAO-R2B.md, items 1 to 5) -------------------------------------------------------------

    /// <summary>Item 1 (A1): a segment whose kind is a real kind of the model that the child of that name is not has two readings
    /// (the kind or the name): never a certain patch, so automatic patching never moves the op (a delete never removes the input
    /// parameter when the author wrote an output one).</summary>
    [Theory]
    [InlineData("delete")]
    [InlineData("set")]
    public void AChildOfAnotherRealKindIsNoCertainPatch(string verb)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir("child-other-kind-" + verb);
        File.WriteAllText(Path.Combine(dir, "first.json"), new JsonObject { ["base"] = "blank-service.oml", ["ops"] = new JsonArray(
            Logic("server action Holder\n  in Amount: Integer\n  out Result: Integer\n  assign Result = 1\n  end\n")) }.ToJsonString());
        const string target = "IServerAction:Holder/IOutputParameter:Amount";
        var op = verb == "delete" ? new JsonObject { ["op"] = "delete", ["target"] = target }
            : new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = "Description", ["value"] = "the output the author meant" };
        // automatic patching on (the default): refused, never saved with the op moved to the input parameter
        var refusal = Refused(dir, new JsonObject { ["base"] = "job:first", ["ops"] = new JsonArray(op) }, "second.json");
        var child = Assert.Single(Problems(refusal), p => p["code"]?.ToString() == "CHILD_NOT_FOUND");
        Assert.False(child["patchCertain"]?.GetValue<bool>() == true, child.ToJsonString());
    }

    /// <summary>Item 2 (A2): a skipped text says the problem it waits for: the one the refusal publishes for the text that declares
    /// what it uses, at that text's pointer in the job as sent.</summary>
    [Fact]
    public void ASkippedTextDependsOnTheProblemOfTheTextThatDeclaresWhatItUses()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var refusal = Refused(Dir("depends-on"), JsonNode.Parse("""
            {"base":"blank-service.oml","ops":[
              {"op":"logic","data":{"flow":[
                "server action FirstFails\n  out Code: Integer\n  NowhereToBeFound()\n  assign Code = 1\n  end\n",
                "server action ProvidesType\n  in Amount: NoSuchTypeAnywhere\n  end\n"]}},
              {"op":"logic","data":{"flow":"server action UsesProvider\n  ProvidesType()\n  end\n"}}]}
            """)!.AsObject());
        var skip = Assert.Single(refusal.Warnings.OfType<JsonObject>(), w => w["code"]?.ToString() == "APPLY_SKIPPED" && w["op"]?.GetValue<int>() == 1);
        var dependsOn = skip["dependsOn"]?.ToString() ?? "";
        Assert.EndsWith(" at /ops/0/data/flow/1", dependsOn);
        Assert.Contains(Problems(refusal), p => dependsOn == $"{p["code"]} at {p["pointer"]}");
        // The answer of the kernel carries it with the problems (the facade folds the skipped ops into one entry).
        var envelope = Errors.Envelope("job", refusal, 0);
        Assert.Contains(envelope["problems"]!.AsArray().OfType<JsonObject>(), p => p["code"]?.ToString() == "APPLY_SKIPPED" && p["dependsOn"]?.ToString() == dependsOn);
        Assert.DoesNotContain(refusal.Warnings.OfType<JsonObject>(), w => w["_because"] != null || w["_becauseAt"] != null);
    }

    /// <summary>Item 3 (A3): only the sentence of an unknown rule goes; a registered rule that is not certain says its reason, with
    /// or without a patch on top.</summary>
    [Fact]
    public void AChoiceBetweenCandidatesKeepsTheReasonOfItsRule()
    {
        var problem = JobPreflight.Problem(0, "/ops/0/data/flow", "FLOW_SYNTAX", "error", "two readings", "write the one you mean (candidates: the patch of each)",
            null, "logic", patchRule: "FLOW_TEXT_READING");
        problem["candidates"] = new JsonArray(new JsonObject { ["reading"] = "a", ["patch"] = new JsonArray() }, new JsonObject { ["reading"] = "b", ["patch"] = new JsonArray() });
        var published = JobPreflight.PublicProblem(problem);
        Assert.Equal(PatchCertainty.Rules["FLOW_TEXT_READING"].Reason, published["patchChoice"]?.ToString());
    }

    private const string SameStartText = "create entity ProbeOfLongNames (\n  Id Long Integer identifier auto required,\n  First Text(50),\n  Second Text(50)\n);\n"
        + "create unique index UQ_ProbeOfLongNames_SameStartAlpha on ProbeOfLongNames (First);\n"
        + "create unique index UQ_ProbeOfLongNames_SameStartBravo on ProbeOfLongNames (Second);\n";

    /// <summary>Item 4 (A4): a corrected text that would name two elements of one kind and place alike is no correction.</summary>
    [Fact]
    public void TwoNamesTheModuleKeptAsOneAreNoCertainPatch()
    {
        const string text = SameStartText;
        static DdlElement Index(string name, int line) => new() { Kind = "EntityIndex", Name = name, Line = line };
        var kept = Index("UQ_ProbeOfLongNames_SameStar", 6);
        var lost = new List<(DdlElement Element, DdlElement? Became)> { (Index("UQ_ProbeOfLongNames_SameStartAlpha", 6), kept), (Index("UQ_ProbeOfLongNames_SameStartBravo", 7), kept) };
        var refusal = SpecExpander.DdlRefusal("DDL_NOT_CONVERGED", ModelSession.RenamedAll(lost, text));
        Assert.All(refusal.Problems!.OfType<JsonObject>(), p => Assert.False(p["patchCertain"]!.GetValue<bool>(), p.ToJsonString()));
    }

    /// <summary>Item 4 (A4): two long index names that share what the platform keeps are no cut of one name: the module's element
    /// is what at most one of them became.</summary>
    [Fact]
    public void TwoLongIndexNamesWithTheSameStartAreNotSaidToBeOneName()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        const string text = SameStartText;
        JobPreflightException refusal;
        using (JobPreflight.UseAutoPatch(false)) refusal = Refused(Dir("cut-same-start"), new JsonObject { ["base"] = "blank-service.oml",
            ["ops"] = new JsonArray(new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = text } }) });
        var bravo = Assert.Single(Problems(refusal), p => p["line"]?.GetValue<int>() == 7);
        Assert.DoesNotContain("named it UQ_ProbeOfLongNames_SameStar ", bravo["message"]!.ToString() + " ");
        Assert.DoesNotContain(Problems(refusal), p => p["patchRule"]?.ToString() == "PLATFORM_NAME_KEPT" && p["patch"] is JsonArray patch
            && System.Text.RegularExpressions.Regex.Matches(patch[0]!["value"]!.ToString(), @"index (\S+) on").Select(m => m.Groups[1].Value).GroupBy(n => n).Any(g => g.Count() > 1));
    }

    /// <summary>Item 5 (A5): a data text that fails blocks its entities, never a common word (an attribute named Name, the name=
    /// of a screen tag): the html op is built and its own fault comes in the same refusal; what really uses the failed entity is
    /// skipped and says the problem it waits for.</summary>
    [Fact]
    public void AFailedDataTextDoesNotSkipAnHtmlOpThatOnlyWritesACommonWord()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var refusal = Refused(Dir("false-dependency"), JsonNode.Parse("""
            {"base":"reactive-ui.oml","ops":[
              {"op":"spec","data":{"ddl":"create entity ProbeBroken (\n  Id Long Integer identifier auto required,\n  Name NoSuchDataType(50)\n);\n"}},
              {"op":"html","data":{"html":"<screen name=\"ProbeIndependent\" roles=\"Registered\"><p>{{ NotDeclaredAnywhere }}</p></screen>"}},
              {"op":"logic","data":{"flow":"server action ReadsTheBroken\n  out Count: Integer\n  local Row: ProbeBroken\n  assign Count = 1\n  end\n"}}]}
            """)!.AsObject());
        Assert.Contains(Problems(refusal), p => p["op"]?.GetValue<int>() == 1 && p["code"]?.ToString() == "ExpressionUnknownObject");
        Assert.DoesNotContain(refusal.Warnings.OfType<JsonObject>(), w => w["code"]?.ToString() == "APPLY_SKIPPED" && w["op"]?.GetValue<int>() == 1);
        // what really uses the failed entity is still said with the problem it waits for
        var skip = Assert.Single(refusal.Warnings.OfType<JsonObject>(), w => w["code"]?.ToString() == "APPLY_SKIPPED" && w["op"]?.GetValue<int>() == 2);
        Assert.Contains(Problems(refusal), p => skip["dependsOn"]?.ToString() == $"{p["code"]} at {p["pointer"]}");
    }

    // ---- pure ---------------------------------------------------------------------------------------------------------------

    private static object? Call(Type type, string name, params object?[] args)
    {
        var method = type.GetMethod(name, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.True(method != null, $"{type.Name}.{name} is missing");
        return method!.Invoke(null, args);
    }

    [Fact]
    public void AStubKeepsTheHeaderAndTheParametersAndDropsTheBody()
    {
        string? Stub(string text) => (string?)Call(typeof(ModelSession), "StubText", text);
        Assert.Equal("server action Provider public\n  /// the amount\n  in Amount: Integer\n  out Value: Integer\n  end\n",
            Stub("/// what it does\nserver action Provider public\n  /// the amount\n  in Amount: Integer\n  local Scratch: Text\n  out Value: Integer\n  NowhereToBeFound()\n  assign Value = Amount\n  end\n"));
        // A text that does not read past its header still gives the header; an edit by key has no stub.
        Assert.Equal("server action Broken\n  end\n", Stub("server action Broken\n  not a flow statement\n"));
        Assert.Null(Stub("server action Edited @AbCdEfGhIjKlMnOpQrStUv\n  end\n"));
        Assert.Null(Stub("not a header\n"));
    }

    [Fact]
    public void AProblemWithoutAPatchSaysNoChoiceSentence()
    {
        var bare = JobPreflight.PublicProblem(JobPreflight.Problem(0, "/ops/0", "FUNCTION_UNKNOWN", "error", "unknown", "use one of: A, B"));
        Assert.False(bare["patchCertain"]!.GetValue<bool>());
        Assert.Null(bare["patchChoice"]);
        var chosen = JobPreflight.PublicProblem(JobPreflight.Problem(0, "/ops/0", "X", "error", "m", "f",
            new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = "/ops/0/value", ["value"] = "v" })));
        Assert.Equal(PatchCertainty.UnknownReason, chosen["patchChoice"]?.ToString());
    }

    [Fact]
    public void TheChildPatchWritesOnlyTheWrongSegmentAsTheJobWroteIt()
    {
        string? ByName(JsonArray ops, string pointer, string segment, string bare) => (string?)Call(typeof(JobRunner), "ByName", ops, pointer, "/ops", segment, bare);
        var ops = new JsonArray(new JsonObject { ["op"] = "set", ["target"] = " ServerActionSignature:Holder/IInputParameter:Amount/Deeper ", ["prop"] = "Description" });
        Assert.Equal("ServerActionSignature:Holder/Amount/Deeper", ByName(ops, "/ops/0/target", "IInputParameter:Amount", "Amount"));
        Assert.Null(ByName(ops, "/ops/0/target", "IInputParameter:Amoun", "Amoun"));
        Assert.Null(ByName(ops, "/ops/1/target", "IInputParameter:Amount", "Amount"));
    }
}
