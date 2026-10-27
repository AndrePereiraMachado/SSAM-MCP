using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// SSAM's own generators satisfy SSAM's own flow rules. The pre-release battery of 2026-10-23 found the C# translator writing a
/// For Each that only maps the rows of a query into a list (CSharpDataEffectsTests, ColdQueryProjection), which T1/T2 refuses
/// (FLOW_FOREACH_LIST_ACTION) whenever the planned op is carried by a job as JSON. The sweep runs every source of the
/// translator's corpus (tests/csharp, subfolders included, derived from the folder: GeneratedFlowCorpus) through the planner,
/// the Apply, the proof and a second plan, as the delivery does, and asks:
///  - no materialization left as a For Each that only copies the rows of a query (GeneratedFlowCorpus.MappingOnlyLoops: the
///    shapes T2 does not recognize, records with nullable members or records inside records, included), and the List actions
///    with a mapping it must write where the review counted them (MappedAppends);
///  - no finding of the flow rules in the refusal, none listed for what the planner wrote (FLOW_OWNER_RULE_PLANNED), none when
///    every flow of the written module is judged as new (ModelSession.GeneratedFlowRuleFindings), a query inside a loop only
///    where the loop is one the source writes (GeneratedFlowCorpus.QueriesInSourceLoops);
///  - a source the translator does not translate is a finding, unless its refusal is a known limit pinned below by its code.
/// </summary>
public sealed class GeneratedFlowRulesTests(ITestOutputHelper output)
{
    private static string Root => JobRunner.RepoRoot(Path.GetDirectoryName(typeof(GeneratedFlowRulesTests).Assembly.Location)!)!;

    private static readonly HashSet<string> FlowRules = new(StringComparer.Ordinal)
        { "FLOW_FOREACH_LIST_ACTION", "FLOW_JAVASCRIPT_NOT_ISOLATED", ModelSession.OwnerRulesUnreadCode, QueryInLoopRule.Code };

    // The sources the translator refuses as a known limit, by the diagnostic it gives: listed in the output, never silent; one
    // that translates now, or refuses with another diagnostic, fails here (and is taken out of this list).
    private static readonly Dictionary<string, string> KnownRefusals = new(StringComparer.Ordinal)
    {
        // The CLR oracle corpus of exception search (tests/csharp/exception-search, README.md): its harness, OracleProgram, is
        // a .NET program over a Dictionary that the cases share (OracleResult), not a source to translate.
        ["exception-search/"] = "AVCS205",
    };

    // The List actions with a mapping the translator writes for the mapping-only materializations, by source: the total, and
    // the actions that must hold one (the review of ae659f85: records with nullable members, records inside records).
    private static readonly Dictionary<string, (int Total, string[] Actions)> MappedExpected = new(StringComparer.Ordinal)
    {
        ["ColdQueryProjection"] = (4, ["ActiveAccountCodes", "AccountCards", "OpenInvoices", "NullableReferences"]),
        ["QueryOrdering"] = (15, ["Page", "NullableAscending", "AbsentValues"]),
        ["EnumRuntime"] = (3, ["EnumSeed", "EnumReadDelete"]),
        ["ColdStock"] = (1, []),
        ["DataActions"] = (1, ["ListAvailable"]),
        ["EdgeMaterialization"] = (24, ["Whole", "Empty", "Nested", "Mixes", "Widens", "Stageds", "Stampeds", "Optionals", "LiftedRanks", "Notes", "Joined"]),
        ["NullableShapes"] = (3, ["Conditional", "Picks", "Coalesced"]),
    };

    public static IEnumerable<object[]> CSharpCorpus() => GeneratedFlowCorpus.Sources(Root);

    [Theory]
    [MemberData(nameof(CSharpCorpus))]
    public void TheCSharpTranslatorWritesNoFlowTheFlowRulesRefuse(string fixture)
    {
        StudioAssemblies.Bind();
        var work = Path.Combine(Root, ".local", "generated-flow-rules", Guid.NewGuid().ToString("N"), fixture.Replace('/', '_')); Directory.CreateDirectory(work);
        var contract = GeneratedFlowCorpus.Contract(Root, fixture);
        var host = new ModelHost(work); var basis = Path.Combine(Root, "tests", "fixtures", "blank-service.oml");
        JsonArray planned; Anvil.Core.Delivery.FrozenFrameworkDependencies? runtime = null;
        Func<string, JsonObject> prove; Func<string, JsonArray> replan;
        try
        {
            ModuleSpecification.Validate(contract); runtime = FrameworkRuntimeFixture.For(host, basis, contract, Root);
            planned = host.PlanModuleSpecification(basis, contract, runtime);
            var publicRuntime = runtime;
            prove = module => host.CheckModuleSpecification(module, contract, runtime: publicRuntime);
            replan = module => host.PlanModuleSpecification(module, contract, publicRuntime);
        }
        catch (Exception error) when (Translator(error))
        {
            // A source whose references cross its public boundary is delivered through the reference-graph compilation (the
            // frozen C# delivery's graph profile, as the native graph tests deliver it); what that refuses too is the source's.
            var diagnostic = Errors.Text(error).Split('\n')[0];
            string? graphRefusal = null;
            var graph = GraphCodes.Any(c => diagnostic.Contains(c + ":", StringComparison.Ordinal)) ? Graph(host, basis, fixture, out graphRefusal) : null;
            if (graph is not { } delivered)
            {
                if (graphRefusal != null) diagnostic = graphRefusal;
                Assert.True(KnownRefusals.TryGetValue(fixture, out var code) && diagnostic.Contains(code + ":", StringComparison.Ordinal),
                    fixture + ": the translator does not translate it: " + diagnostic);
                output.WriteLine(fixture + ": refused as the known limit " + code + " (" + diagnostic + ")");
                return;
            }
            output.WriteLine(fixture + ": the public contract refuses it (" + diagnostic + "); delivered through the reference graph");
            (planned, prove, replan, runtime) = delivered;
        }
        Assert.False(KnownRefusals.ContainsKey(fixture), fixture + " translates now: take it out of KnownRefusals");
        // Every materialization that only copies rows is a List action; the ones the review counted are there.
        Assert.Empty(GeneratedFlowCorpus.MappingOnlyLoops(planned));
        var mapped = GeneratedFlowCorpus.MappedAppends(planned);
        output.WriteLine(fixture + ": List actions with a mapping: " + string.Join(", ", mapped.Select(m => m.Key + "=" + m.Value)));
        if (MappedExpected.TryGetValue(fixture, out var expected))
        {
            Assert.Equal(expected.Total, mapped.Values.Sum());
            Assert.All(expected.Actions, a => Assert.True(mapped.ContainsKey(a), fixture + ": " + a + " writes no List action with a mapping"));
        }
        var findings = new List<string>();
        var module = Path.Combine(work, "generated.oml");
        var result = Apply(host, basis, planned, module, runtime, findings);
        // A source that itself queries inside a loop is refused for it (QUERY_IN_LOOP, the user's code): the flows are still
        // judged, written with the rule's explicit escape, which lists it and judges the rest as any JSON form.
        if (result == null && findings.Count > 0 && findings.All(f => f.StartsWith(QueryInLoopRule.Code + " ", StringComparison.Ordinal)))
        {
            var escaped = (JsonArray)planned.DeepClone();
            foreach (var op in escaped.OfType<JsonObject>().Where(o => o["op"]?.ToString() == "logic"))
                op[QueryInLoopRule.AllowKey] = new JsonObject { ["why"] = "the source queries inside its own loop; the sweep judges the other rules" };
            findings.Clear();
            result = Apply(host, basis, escaped, module, runtime, findings);
        }
        Assert.True(result != null, fixture + ": the Apply refused the generated job: " + string.Join("\n", findings));
        // The proof reads what the module holds (the mappings included) against the source, and a second plan has nothing to do.
        var proof = prove(module);
        Assert.True(proof["accepted"]!.GetValue<bool>(), fixture + ": " + proof["differences"]!.ToJsonString());
        Assert.Empty(replan(module));
        // Every flow of the written module judged as new. A query inside a loop is the user's code only when the loop is one the
        // source writes (a for, while or foreach of the method, around the query's step); any other is the translator's.
        var sourceLoops = GeneratedFlowCorpus.QueriesInSourceLoops(planned, contract);
        foreach (var finding in host.GeneratedFlowRuleFindings(module).OfType<JsonObject>())
        {
            var code = finding["code"]!.ToString(); var flow = finding["flow"]?.ToString() ?? "";
            if (code == QueryInLoopRule.Code && sourceLoops.Contains((flow, finding["node"]?.ToString() ?? "")))
            { output.WriteLine(fixture + ": in a loop of the source: " + flow + ": " + finding["message"]); continue; }
            findings.Add(code + " " + flow + ": " + finding["message"]);
        }
        File.WriteAllText(Path.Combine(work, "findings.json"), JsonSerializer.Serialize(findings));
        output.WriteLine(fixture + ": written, " + findings.Count + " findings");
        Assert.Empty(findings);
    }

    // A query inside a loop is the user's only inside a loop the source writes (a for or while by its condition, a foreach by
    // its iteration variable); a query in a loop only the translator writes, in the same method, is still a finding.
    [Fact]
    public void OnlyTheLoopsTheSourceWritesExcuseAQueryInALoop()
    {
        var contract = new JsonObject { ["csharpSource"] = "public static class S { public static void M(int[] rows) { for (var i = 0; i < 3; i++) { } foreach (var row in rows) { } } }" };
        var planned = JsonNode.Parse("""
            [{"op":"logic","data":{"actions":[{"name":"M","steps":[
              {"while":"True","label":"i < 3","do":[{"get":"T","as":"AvQuery1"}]},
              {"while":"AvTemp2 < AvTemp1.Length","do":[{"assign":{"Var2_row":"AvTemp1[AvTemp2]"}},{"if":"Var2_row > 0","then":[{"get":"T","as":"AvQuery2"}]}]},
              {"while":"AvTemp3 < 4","do":[{"get":"T","as":"AvQuery3"}]},
              {"foreach":"AvQuery3.List","do":[{"get":"T","as":"AvQuery4"}]}]}]}}]
            """)!.AsArray();
        var excused = GeneratedFlowCorpus.QueriesInSourceLoops(planned, contract);
        Assert.Equal([("M", "AvQuery1"), ("M", "AvQuery2")], excused.OrderBy(e => e.Query, StringComparer.Ordinal));
    }

    // A For Each written by hand in the JSON form that only maps a list (the shape the translator wrote before: a local built
    // field by field from the item, then appended; a value of the item appended) is still refused, each loop named with its
    // action and the List action as the one next step (the RFC 6902 patch and the text's lines). Kept with the explicit
    // escape, the Apply lists it, and the sweep's audit still finds it: what the generators are held to is the rule itself.
    [Fact]
    public void AHandWrittenForEachThatOnlyMapsAListIsStillRefusedAndTheAuditFindsIt()
    {
        StudioAssemblies.Bind();
        var work = Path.Combine(Root, ".local", "generated-flow-rules", Guid.NewGuid().ToString("N"), "hand-written"); Directory.CreateDirectory(work);
        var host = new ModelHost(work); var basis = Path.Combine(Root, "tests", "fixtures", "blank-service.oml");
        const string Spec = """
            {"op":"spec","data":{"structures":[
              {"name":"GfSource","attributes":[{"name":"Code","type":"Text","length":50},{"name":"Amount","type":"Decimal"}]},
              {"name":"GfLine","attributes":[{"name":"Key","type":"Text","length":50},{"name":"Total","type":"Decimal"}]}]}}
            """;
        const string Loops = """
            {"op":"logic","data":{"actions":[
              {"name":"GfLines","inputs":[{"name":"Rows","type":"GfSource List"}],"outputs":[{"name":"Lines","type":"GfLine List"}],"vars":[{"name":"Line","type":"GfLine"}],
               "steps":[{"foreach":"Rows","as":"EachLine","do":[{"assign":{"Line.Key":"Rows.Current.Code"}},{"assign":{"Line.Total":"Rows.Current.Amount"}},
                 {"call":"ListAppend","as":"AppendLine","args":{"List":"Lines","Element":"Line"}}]}]},
              {"name":"GfCodes","inputs":[{"name":"Rows","type":"GfSource List"}],"outputs":[{"name":"Codes","type":"Text List"}],
               "steps":[{"foreach":"Rows","as":"EachCode","do":[{"call":"ListAppend","as":"AppendCode","args":{"List":"Codes","Element":"Rows.Current.Code"}}]}]}]}}
            """;
        var refused = new List<string>();
        Assert.Null(Apply(host, basis, JsonNode.Parse("[" + Spec + "," + Loops + "]")!.AsArray(), Path.Combine(work, "refused.oml"), null, refused));
        var problems = refused.Where(f => f.StartsWith("FLOW_FOREACH_LIST_ACTION ", StringComparison.Ordinal)).ToList();
        Assert.Equal(2, problems.Count);
        Assert.Contains(problems, p => p.Contains("action GfLines", StringComparison.Ordinal) && p.Contains("only maps Rows into Lines", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("action GfCodes", StringComparison.Ordinal) && p.Contains("only maps Rows into Codes", StringComparison.Ordinal));
        // The one next step of each: the List action, as the refusal's patch and text.
        var job = Path.Combine(work, "refused-direct.json"); File.WriteAllText(job, new JsonObject { ["ops"] = JsonNode.Parse("[" + Spec + "," + Loops + "]") }.ToJsonString());
        var coded = Errors.FindCoded(Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, basis, job, Path.Combine(work, "refused-direct.oml"))))!;
        var texts = coded.Problems!.OfType<JsonObject>().Where(p => p["code"]?.ToString() == "FLOW_FOREACH_LIST_ACTION").ToList();
        Assert.All(texts, p => Assert.IsType<JsonArray>(p["patch"]));
        Assert.Contains(texts, p => p["text"]?.ToString() == "(System).ListAppendAll(List=Lines, SourceList=Rows mapTo { Key: Code, Total: Amount })");
        Assert.Contains(texts, p => p["text"]?.ToString() == "(System).ListAppendAll(List=Codes, SourceList=Rows mapTo { Value: Code })");
        // Kept with the explicit escape: accepted and listed, never silent; the audit of the written module still finds both.
        var listed = new List<string>(); var module = Path.Combine(work, "kept.oml");
        var kept = Apply(host, basis, JsonNode.Parse("[" + Spec + "," + Loops.Replace("{\"op\":\"logic\",", "{\"op\":\"logic\",\"" + ForEachEscape.AllowKey + "\":{\"why\":\"a legacy mapping loop the test keeps\"},") + "]")!.AsArray(), module, null, listed);
        Assert.NotNull(kept);
        Assert.Equal(2, listed.Count(f => f.Contains("listed " + ForEachEscape.AllowedCode, StringComparison.Ordinal)));
        var audit = host.GeneratedFlowRuleFindings(module).OfType<JsonObject>().Where(f => f["code"]?.ToString() == "FLOW_FOREACH_LIST_ACTION").Select(f => f["flow"]!.ToString()).ToList();
        Assert.Equal(["GfCodes", "GfLines"], audit.OrderBy(f => f, StringComparer.Ordinal));
    }

    // The reference-boundary refusals of the public contract (a reference, an exception identity or a managed record crossing
    // the public boundary), which the reference-graph compilation translates.
    private static readonly string[] GraphCodes = ["AVCS310", "AVCS340", "AVCS347"];

    private static bool Translator(Exception error) => error is Anvil.CSharp.SourceCompilationException || Errors.Text(error).Contains("AVCS", StringComparison.Ordinal);

    // The plan, the proof and the second plan of the reference-graph delivery (FrozenCSharpCompilation.GraphProfile); null when
    // the graph compilation refuses the source too (its refusal is then the source's).
    private static (JsonArray, Func<string, JsonObject>, Func<string, JsonArray>, Anvil.Core.Delivery.FrozenFrameworkDependencies?)? Graph(ModelHost host, string basis, string fixture, out string? refused)
    {
        refused = null;
        var files = GeneratedFlowCorpus.Files(Root, fixture);
        Anvil.CSharp.CompilationResult compiled;
        try
        {
            compiled = (Anvil.CSharp.CompilationResult)typeof(Anvil.CSharp.CSharpCompiler).GetMethod("CompileReferenceGraph",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!.Invoke(null, [files])!;
        }
        catch (System.Reflection.TargetInvocationException error) when (error.InnerException is { } inner && Translator(inner))
        { refused = Errors.Text(inner).Split('\n')[0]; return null; }
        var bundle = new JsonObject { ["files"] = new JsonObject(files.Select(f => KeyValuePair.Create(f.Key, (JsonNode?)JsonValue.Create(f.Value)))) };
        var authored = new JsonObject { ["csharpSource"] = bundle.DeepClone() };
        var runtime = FrameworkRuntimeFixture.For(host, basis, compiled, Root);
        var frozen = Anvil.Core.Delivery.FrozenCSharpCompilation.Capture(bundle, compiled, Anvil.Core.Delivery.FrozenCSharpCompilation.GraphProfile,
            "fixture.invalid", host.Inspect(basis).Key, runtime);
        return (host.PlanFrozenCSharp(basis, authored, frozen, runtime), module => host.CheckFrozenCSharp(module, authored, null, frozen, runtime),
            module => host.PlanFrozenCSharp(module, authored, frozen, runtime), runtime);
    }

    // The job as the delivery sends it; the problems of the flow rules in the refusal or in highWarnings join the findings.
    private static JsonNode? Apply(ModelHost host, string basis, JsonArray ops, string module, Anvil.Core.Delivery.FrozenFrameworkDependencies? runtime, List<string> findings)
    {
        var job = Path.ChangeExtension(module, ".json"); File.WriteAllText(job, new JsonObject { ["ops"] = ops.DeepClone() }.ToJsonString());
        try
        {
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, module, bindings: runtime?.ProducerBindings()))!;
            foreach (var warning in (result["highWarnings"] as JsonArray ?? []).OfType<JsonObject>())
            {
                var code = warning["code"]?.ToString() ?? "";
                var rule = code == ModelSession.OwnerRulePlannedCode ? warning["rule"]?.ToString() ?? code : code;
                if (FlowRules.Contains(rule) || code is ModelSession.OwnerRulePlannedCode or ForEachEscape.AllowedCode)
                    findings.Add(rule + " (listed " + code + ") " + warning["message"]);
            }
            if (result["accepted"]?.GetValue<bool>() != true) { findings.Add("NOT_ACCEPTED " + result["details"]); return null; }
            return result;
        }
        catch (Exception error) when (Errors.FindCoded(error) is { } coded)
        {
            foreach (var problem in (coded.Problems ?? []).OfType<JsonObject>())
                findings.Add((problem["code"]?.ToString() ?? coded.Code) + " " + problem["message"]);
            if (coded.Problems is not { Count: > 0 }) findings.Add(coded.Code + " " + Errors.Text(error));
            return null;
        }
    }
}
