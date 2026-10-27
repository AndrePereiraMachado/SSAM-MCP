using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// The ODC lane of GeneratedFlowRulesTests: the C# translator is shared code, so every source of its corpus (GeneratedFlowCorpus,
/// subfolders included) the ODC lane can plan (one that needs no framework runtime: the ODC lane has no headless runtime
/// delivery, OdcJobTests) is applied on the ODC fixture as the delivery does, and every flow the job wrote is judged as new
/// (the fixture's own flows are subtracted): no finding of the flow rules, a query inside a loop only where the source writes
/// the loop. The sources that query the database are refused in the ODC lane before any flow is written (the translator
/// writes SQL Server SQL; ODC runs PostgreSQL), a known limit of the C# data path in this lane: their materializations are
/// proven in the O11 lane only. Without an ODC Studio on the machine the cases are skipped, with the reason.
/// </summary>
public sealed class GeneratedFlowRulesOdcTests(ITestOutputHelper output)
{
    private static string Root
    {
        get
        {
            var dir = Path.GetDirectoryName(typeof(GeneratedFlowRulesOdcTests).Assembly.Location);
            while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
            return dir ?? Directory.GetCurrentDirectory();
        }
    }

    /// <summary>A theory skipped, with the reason, when no ODC Studio is installed (the lane cannot load its model).</summary>
    private sealed class OdcStudioTheoryAttribute : TheoryAttribute
    {
        public OdcStudioTheoryAttribute()
        {
            string? why;
            try { StudioAssembliesOdc.Bind(null); why = Directory.Exists(StudioAssembliesOdc.Directory) ? null : "no ODC Studio at " + StudioAssembliesOdc.Directory; }
            catch (Exception error) { why = "the ODC Studio cannot be loaded (" + error.GetType().Name + ")"; }
            if (why != null) Skip = "ODC lane not available on this machine: " + why + "; set ANVIL_ODC_STUDIO_DIR to an ODC Studio to run it";
        }
    }

    public static IEnumerable<object[]> CSharpCorpus() => GeneratedFlowCorpus.Sources(Root);

    [OdcStudioTheory]
    [MemberData(nameof(CSharpCorpus))]
    public void TheCSharpTranslatorWritesNoFlowTheFlowRulesRefuseInTheOdcLane(string fixture)
    {
        StudioAssembliesOdc.Bind(null);
        var work = Path.Combine(Root, ".local", "lane-odc", "generated-flow-rules", Guid.NewGuid().ToString("N"), fixture.Replace('/', '_')); Directory.CreateDirectory(work);
        var basis = Path.Combine(Root, "tests", "fixtures", "odc", "insurance-reactive-r8.oml");
        var contract = GeneratedFlowCorpus.Contract(Root, fixture);
        var host = new ModelHost(work);
        JsonArray planned;
        try { ModuleSpecification.Validate(contract); planned = host.PlanModuleSpecification(basis, contract); }
        catch (Exception error) when (error is Anvil.CSharp.SourceCompilationException || Errors.Text(error).Contains("AVCS", StringComparison.Ordinal)
            || Errors.Text(error).Contains("resolve the C# runtime requirements", StringComparison.Ordinal))
        {
            // What the translator refuses is the O11 sweep's (KnownRefusals); here: what the ODC lane cannot plan.
            output.WriteLine(fixture + ": not planned in the ODC lane (" + Errors.Text(error).Split('\n')[0] + ")");
            return;
        }
        catch (Exception error) when (SqlDialect(error))
        {
            output.WriteLine(fixture + ": its SQL is refused in the ODC lane (SQL Server dialect), no flow written");
            return;
        }
        // An ODC app exposes no public server action (OdcJobTests): the authored public entries stay private here.
        foreach (var action in GeneratedFlowCorpus.Actions(planned))
            if (action["kind"]?.ToString() != "service" && action["public"]?.GetValue<bool>() == true) action["public"] = false;
        // The sources that query inside their own loops (the user's code) take the rule's explicit escape: the other rules judge.
        foreach (var op in planned.OfType<JsonObject>().Where(o => o["op"]?.ToString() == "logic"))
            op[QueryInLoopRule.AllowKey] = new JsonObject { ["why"] = "the sweep judges the flow rules of the generated module itself" };
        var job = Path.Combine(work, "generated.json"); var module = Path.Combine(work, "generated.oml");
        File.WriteAllText(job, new JsonObject { ["ops"] = planned }.ToJsonString());
        JsonNode result;
        try { result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, module))!; }
        catch (Exception error) when (SqlDialect(error))
        {
            output.WriteLine(fixture + ": its SQL is refused in the ODC lane (SQL Server dialect), no flow written");
            return;
        }
        catch (Exception error) when (Errors.FindCoded(error) is { } coded)
        {
            Assert.Fail(fixture + ": refused " + coded.Code + ": " + string.Join(" | ", (coded.Problems ?? []).OfType<JsonObject>().Select(p => p["code"] + " " + p["message"])));
            return;
        }
        Assert.True(result["isValid"]?.GetValue<bool>() == true, fixture + ": " + result["details"] + " " + result["validation"]);
        Assert.Empty(GeneratedFlowCorpus.MappingOnlyLoops(planned));
        // The fixture's own flows are not the generator's: what the module had before the job is subtracted, finding by finding.
        // A query inside a loop is the user's code only when the loop is one the source writes around the query's step.
        var sourceLoops = GeneratedFlowCorpus.QueriesInSourceLoops(planned, contract);
        var before = host.GeneratedFlowRuleFindings(basis).OfType<JsonObject>().Select(f => f["code"] + " " + f["flow"] + ": " + f["message"]).ToList();
        var findings = host.GeneratedFlowRuleFindings(module).OfType<JsonObject>()
            .Where(f => !(f["code"]?.ToString() == QueryInLoopRule.Code && sourceLoops.Contains((f["flow"]?.ToString() ?? "", f["node"]?.ToString() ?? ""))))
            .Select(f => f["code"] + " " + f["flow"] + ": " + f["message"]).Where(f => !before.Remove(f)).ToList();
        output.WriteLine(fixture + ": written in the ODC lane, " + findings.Count + " findings");
        Assert.Empty(findings);
    }

    // Every problem of the refusal is the SQL check of the ODC lane (SQL_INVALID).
    private static bool SqlDialect(Exception error) => Errors.FindCoded(error) is { } coded && (coded.Problems ?? []).OfType<JsonObject>().Any()
        && (coded.Problems ?? []).OfType<JsonObject>().All(p => p["code"]?.ToString() == "SQL_INVALID");
}
