using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// The ODC lane of the publish-error rules (AggregateSortRule.cs, FlowDiff.Sorts.cs, CompileCheck.cs; O11 in
/// tests/Anvil.Tests/CompileCheckTests.cs): the same kernel writes an aggregate sort as the Studio does on ODC (the flow text
/// and the JSON logic op), refuses a sort that is not one attribute once with its verified patch, refuses a column over an
/// expression (with the patch), a grouped sort outside the group, a join the Studio never writes (a Right join of two sources
/// is written as the Left join swapped), a SOAP client (ODC consumes REST only) and a base that already does not compile; and
/// the checagem de compilação finds nothing in the modules the ODC Studio made. Needs the ODC Studio installed.
/// </summary>
public class CompileCheckOdcTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Fixture = Path.Combine(Root, "tests", "fixtures", "odc", "blank-mobile.oml");

    private const string Spec = """
        {"op":"spec","data":{"entities":[
          {"name":"CcEvent","attributes":[{"name":"Title","type":"Text","length":50},{"name":"IsDone","type":"Boolean"},{"name":"Score","type":"Integer"}]},
          {"name":"CcTag","attributes":[{"name":"EventId","type":"CcEvent Identifier"},{"name":"Name","type":"Text","length":50}]}]}}
        """;

    private static string Work()
    {
        var dir = Path.Combine(Root, ".local", "lane-odc", "compile-check-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir); return dir;
    }

    private static JsonNode Run(string dir, string name, string ops, string? basePath = null)
    {
        var job = Path.Combine(dir, name + ".json");
        File.WriteAllText(job, "{\"ops\":[" + ops + "]}");
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), basePath ?? Fixture, job, Path.Combine(dir, name + ".oml")))!;
    }

    private static JsonArray Refused(string dir, string name, string ops, string? basePath = null)
    {
        var error = Assert.ThrowsAny<Exception>(() => Run(dir, name, ops, basePath));
        var coded = Errors.FindCoded(error);
        Assert.True(coded != null, Errors.Text(error));
        Assert.False(File.Exists(Path.Combine(dir, name + ".oml")), "a refused job saves nothing");
        return coded!.Problems!;
    }

    private static string Flow(params string[] texts) => "{\"op\":\"logic\",\"data\":{\"flow\":[" + string.Join(",", texts.Select(t => JsonSerializer.Serialize(t))) + "]}}";
    private static string Act(string name, string query) => $"server action {name}\n  out N: Integer\n  Q = aggregate {query}\n  assign N = Q.List.Length\n  end\n";

    private static List<(string Attribute, string Direction)> Sorts(string dir, string oml) =>
        CompileCheck.SortsOf(new ModelHost(Path.Combine(dir, "read")), File.ReadAllBytes(oml))
            .Select(s => (s!["attribute"]!.ToString(), s["direction"]?.ToString() ?? "")).ToList();

    private static List<JsonObject> Parts(string dir, string oml, string kind) =>
        CompileCheck.PartsOf(new ModelHost(Path.Combine(dir, "read")), File.ReadAllBytes(oml)).OfType<JsonObject>().Where(p => p["kind"]!.ToString() == kind).ToList();

    /// <summary>The replace patch of a refusal applied to the ops as the model sends them back.</summary>
    private static string Patched(string ops, JsonArray patch)
    {
        var job = new JsonObject { ["ops"] = JsonNode.Parse("[" + ops + "]")!.AsArray() };
        foreach (var op in patch.OfType<JsonObject>())
        {
            Assert.Equal("replace", op["op"]!.ToString());
            var path = op["path"]!.ToString().Split('/').Skip(1).ToArray();
            JsonNode node = job;
            foreach (var step in path[..^1]) node = node is JsonArray a ? a[int.Parse(step)]! : node[step]!;
            if (node is JsonArray list) list[int.Parse(path[^1])] = op["value"]!.DeepClone(); else node[path[^1]] = op["value"]!.DeepClone();
        }
        return string.Join(",", job["ops"]!.AsArray().Select(o => o!.ToJsonString()));
    }

    [Fact]
    public void TheFlowTextAndTheLogicOpWriteNativeSortsAndListThem()
    {
        if (!StudioAvailable()) return;
        var dir = Work();
        var flow = JsonSerializer.Serialize("server action CcHistory\n  out N: Integer\n  Q = aggregate FROM CcEvent SORT -IdentifierToLongInteger(CcEvent.Id), If(CcEvent.IsDone, 0, 1) MAX 10\n  assign N = Q.List.Length\n  end\n");
        var logic = """
            {"op":"logic","data":{"actions":[{"name":"CcList","outputs":[{"name":"N","type":"Integer"}],"steps":[
              {"get":"CcEvent","as":"GetEvents","sort":["CcEvent.Title DESC","If(CcEvent.IsDone, 0, 1)"],"max":10},
              {"assign":{"N":"GetEvents.List.Length"}}]}]}}
            """;
        var result = Run(dir, "cc-odc", Spec + ",{\"op\":\"logic\",\"data\":{\"flow\":[" + flow + "]}}," + logic);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        Assert.True(result["expressionRewrites"]!.AsArray().Count >= 3, result["expressionRewrites"]!.ToJsonString());
        var sorts = Sorts(dir, Path.Combine(dir, "cc-odc.oml"));
        Assert.Contains(("CcEvent.Id", "Descending"), sorts);
        Assert.Equal(2, sorts.Count(s => s == ("CcEvent.IsDone", "Descending")));
        Assert.Contains(("CcEvent.Title", "Descending"), sorts);
        Assert.DoesNotContain(sorts, s => s.Attribute.Contains('(') || s.Attribute.StartsWith('-'));
    }

    [Fact]
    public void ASortThatIsNotOneAttributeIsRefusedOnceWithItsVerifiedPatch()
    {
        if (!StudioAvailable()) return;
        var dir = Work();
        var text = "server action CcAgenda\n  in SortMode: Text\n  out N: Integer\n  Q = aggregate FROM CcEvent SORT If(SortMode = \"safe\", -CcEvent.Score, CcEvent.Score), CcEvent.Id MAX 10\n  assign N = Q.List.Length\n  end\n";
        var ops = Spec + "," + Flow(text);
        var problem = Assert.Single(Refused(dir, "cc-odc-refused", ops), p => p!["code"]!.ToString() == AggregateSortRule.Code)!;
        Assert.Contains("CALC SortKey=", problem["fix"]!.ToString());
        var patched = Patched(ops, Assert.IsType<JsonArray>(problem["patch"]));
        Assert.Contains("CALC SortKey=", patched);
        var result = Run(dir, "cc-odc-patched", patched);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        Assert.Equal([("SortKey", "Ascending"), ("CcEvent.Id", "Ascending")], Sorts(dir, Path.Combine(dir, "cc-odc-patched.oml")));
    }

    [Fact]
    public void AColumnOverAnExpressionIsRefusedAndThePatchedTextIsDelivered()
    {
        // Review (alta, o02): a Sum over an expression was delivered with a HIGH warning only.
        if (!StudioAvailable()) return;
        var dir = Work();
        var logic = Refused(dir, "cc-odc-column", Spec + """
            ,{"op":"logic","data":{"actions":[{"name":"CcTotals","outputs":[{"name":"N","type":"Integer"}],"steps":[
              {"get":"CcEvent","as":"GetTotals","columns":[{"name":"Total","kind":"Sum","attribute":"CcEvent.Score * 2"},{"name":"Done","kind":"Group","attribute":"CcEvent.IsDone"}]},
              {"assign":{"N":"GetTotals.List.Length"}}]}]}}
            """);
        var column = Assert.Single(logic, p => p!["code"]!.ToString() == AggregateSortRule.ColumnCode)!;
        Assert.Equal("/ops/1/data/actions/0/steps/0", column["pointer"]!.ToString());
        Assert.Contains("CALC TotalRow=CcEvent.Score * 2 and AGG Total=Sum(TotalRow)", column["fix"]!.ToString());
        // The flow text is refused at its text (ODC's text does not write a grouped aggregate: no text patch there).
        var flow = Assert.Single(Refused(dir, "cc-odc-column-flow", Spec + "," + Flow(Act("CcBuckets", "FROM CcEvent GROUP BY Up=ToUpper(CcEvent.Title) AGG Total=Count(CcEvent.Id)"))),
            p => p!["code"]!.ToString() == AggregateSortRule.ColumnCode)!;
        Assert.Contains("CALC UpRow=ToUpper(CcEvent.Title)", flow["fix"]!.ToString());
        // The fix as the logic op writes it (calculated column, aggregated by name): delivered.
        var result = Run(dir, "cc-odc-column-fixed", Spec + """
            ,{"op":"logic","data":{"actions":[{"name":"CcTotals","outputs":[{"name":"N","type":"Integer"}],"steps":[
              {"get":"CcEvent","as":"GetTotals","calculated":[{"name":"TotalRow","value":"CcEvent.Score * 2"}],"columns":[{"name":"Total","kind":"Sum","attribute":"TotalRow"},{"name":"Done","kind":"Group","attribute":"CcEvent.IsDone"}]},
              {"assign":{"N":"GetTotals.List.Length"}}]}]}}
            """);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        Assert.Equal("TotalRow", Assert.Single(Parts(dir, Path.Combine(dir, "cc-odc-column-fixed.oml"), "agg"))["value"]!.ToString());
    }

    [Fact]
    public void AColumnThatReadsNoAttributeIsRefusedBeforeTheVerify()
    {
        // Re-check (high): a column without an attribute; on ODC the Verify says InvalidAggregateAttribute_NoAttribute, the kernel
        // refuses it first, in every writer, with the column's code.
        if (!StudioAvailable()) return;
        var dir = Work();
        const string Grouped = """
            {"op":"logic","data":{"actions":[{"name":"CcRaw4","outputs":[{"name":"N","type":"Integer"}],"steps":[
              {"get":"CcEvent","as":"GetRaw4","columns":[{"name":"G","kind":"Group","attribute":"CcEvent.IsDone"},{"name":"T","kind":"Count","attribute":"CcEvent.Id"}]},{"assign":{"N":"GetRaw4.List.Length"}}]}]}}
            """;
        // The text: refused at the parse, no text patch (ODC's text does not write a grouped aggregate; the fix names the logic op).
        var text = Assert.Single(Refused(dir, "cc-odc-empty-flow", Spec + "," + Flow(Act("CcCount", "FROM CcEvent GROUP BY CcEvent.IsDone AGG Total=Count()"))),
            p => p!["code"]!.ToString() == AggregateSortRule.ColumnCode)!;
        Assert.Null(text["patch"]);
        Assert.Contains("logic op", text["fix"]!.ToString());
        // The logic op: a field error at the column's attribute.
        var logic = Assert.Single(Refused(dir, "cc-odc-empty-logic", Spec + "," + Grouped.Replace("\"attribute\":\"CcEvent.Id\"", "\"attribute\":\"\"", StringComparison.Ordinal)),
            p => p!["code"]!.ToString() == AggregateSortRule.ColumnCode)!;
        Assert.Equal("/ops/1/data/actions/0/steps/0/columns/1/attribute", logic["pointer"]!.ToString());
        // A raw set that clears a Count column: refused at its value, with the identifier of the one source as the patch.
        var ops = Spec + "," + Grouped + """,{"op":"set","target":"$CcRaw4.GetRaw4.column2","prop":"Attribute","value":""}""";
        var cleared = Assert.Single(Refused(dir, "cc-odc-empty-set", ops), p => p!["code"]!.ToString() == AggregateSortRule.ColumnCode)!;
        Assert.Equal("/ops/2/value", cleared["pointer"]!.ToString());
        var result = Run(dir, "cc-odc-empty-set-patched", Patched(ops, Assert.IsType<JsonArray>(cleared["patch"])));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
    }

    [Fact]
    public void AGroupedSortOutsideTheGroupIsRefused()
    {
        // Review (média, o03): a grouped aggregate sorted by an attribute it does not group by.
        if (!StudioAvailable()) return;
        var dir = Work();
        var problems = Refused(dir, "cc-odc-grouped", Spec + "," + Flow(Act("CcG1", "FROM CcEvent GROUP BY CcEvent.IsDone AGG Total=Count(CcEvent.Id) SORT CcEvent.Score")) + """
            ,{"op":"logic","data":{"actions":[{"name":"CcG2","outputs":[{"name":"N","type":"Integer"}],"steps":[
              {"get":"CcEvent","as":"GetG2","columns":[{"name":"Done","kind":"Group","attribute":"CcEvent.IsDone"},{"name":"Total","kind":"Count","attribute":"CcEvent.Id"}],"sort":"CcEvent.Score"},
              {"assign":{"N":"GetG2.List.Length"}}]}]}}
            """);
        var sorts = problems.Where(p => p!["code"]!.ToString() == AggregateSortRule.Code).ToList();
        Assert.Equal(2, sorts.Count);
        Assert.All(sorts, p => Assert.Contains("8127", p!["message"]!.ToString()));
        // Sorted by the attribute it groups by (the logic op: ODC's text does not write a grouped aggregate): delivered.
        var result = Run(dir, "cc-odc-grouped-ok", Spec + """
            ,{"op":"logic","data":{"actions":[{"name":"CcG2","outputs":[{"name":"N","type":"Integer"}],"steps":[
              {"get":"CcEvent","as":"GetG2","columns":[{"name":"Done","kind":"Group","attribute":"CcEvent.IsDone"},{"name":"Total","kind":"Count","attribute":"CcEvent.Id"}],"sort":"CcEvent.IsDone DESC"},
              {"assign":{"N":"GetG2.List.Length"}}]}]}}
            """);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
    }

    [Fact]
    public void JoinsAreTheThreeTheStudioWrites()
    {
        // Review (baixa/média, o06): JOIN Right was delivered on ODC.
        if (!StudioAvailable()) return;
        var dir = Work();
        var result = Run(dir, "cc-odc-right", Spec + "," + Flow(Act("CcJ1", "FROM CcEvent, CcTag JOIN Right CcEvent~CcTag ON CcTag.EventId = CcEvent.Id MAX 10")) + """
            ,{"op":"logic","data":{"actions":[{"name":"CcJ2","outputs":[{"name":"N","type":"Integer"}],"steps":[
              {"get":"CcEvent","as":"GetJ2","sources":["CcTag"],"joins":[{"left":"CcEvent","right":"CcTag","kind":"Right","condition":"CcTag.EventId = CcEvent.Id"}],"max":10},
              {"assign":{"N":"GetJ2.List.Length"}}]}]}}
            """);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        Assert.Contains(result["expressionRewrites"]!.AsArray(), r => r!["to"]!.ToString() == "Left CcTag~CcEvent");
        var joins = Parts(dir, Path.Combine(dir, "cc-odc-right.oml"), "join");
        Assert.Equal(2, joins.Count);
        Assert.All(joins, j => Assert.Equal("Left", j["type"]!.ToString()));
        var problems = Refused(dir, "cc-odc-none", Spec + "," + Flow(Act("CcJ3", "FROM CcEvent, CcTag JOIN None CcEvent~CcTag ON CcTag.EventId = CcEvent.Id MAX 10")));
        Assert.Contains(problems, p => p!["code"]!.ToString() == AggregateSortRule.JoinCode);
    }

    [Fact]
    public void ASoapClientIsRefusedOnOdc()
    {
        if (!StudioAvailable()) return;
        var dir = Work();
        var problem = Assert.Single(Refused(dir, "cc-odc-soap", """{"op":"create","parent":"@espace","type":"ISOAPClient","name":"OdcSoap","as":"$soap"}"""),
            p => p!["code"]!.ToString() == CompileCheck.SoapDefinition)!;
        Assert.Contains("REST", problem["fix"]!.ToString());
    }

    [Fact]
    public void ABaseThatDoesNotCompileRefusesADeliveryOnTopOfIt()
    {
        if (!StudioAvailable()) return;
        var dir = Work();
        var basePath = Path.Combine(dir, "legacy.oml");
        // As an older release wrote them: a join the Studio never writes and a Sum over an expression (on ODC a sort over an
        // expression is written dynamic by the model itself, so it is no example here).
        CompileCheck.WriteUnchecked(new ModelHost(Path.Combine(dir, "write")), File.ReadAllBytes(Fixture), JsonNode.Parse("[" + Spec + """
            ,{"op":"logic","data":{"actions":[{"name":"Legacy","outputs":[{"name":"N","type":"Integer"}],"steps":[
              {"get":"CcEvent","as":"GetLegacy","sources":["CcTag"],"joins":[{"left":"CcEvent","right":"CcTag","kind":"None","condition":"CcTag.EventId = CcEvent.Id"}],"max":10},
              {"get":"CcEvent","as":"GetLegacyTotals","columns":[{"name":"Total","kind":"Sum","attribute":"CcEvent.Score * 2"}]},
              {"assign":{"N":"GetLegacy.List.Length + GetLegacyTotals.List.Length"}}]}]}}]
            """)!.AsArray(), basePath);
        var problems = Refused(dir, "cc-odc-on-legacy", """{"op":"logic","data":{"actions":[{"name":"Ping","outputs":[{"name":"N","type":"Integer"}],"steps":[{"assign":{"N":"1"}}]}]}}""", basePath);
        var old = problems.Where(p => p!["preexisting"]?.GetValue<bool>() == true).ToList();
        Assert.Contains(old, p => p!["code"]!.ToString() == AggregateSortRule.JoinCode);
        Assert.Contains(old, p => p!["code"]!.ToString() == AggregateSortRule.ColumnCode);
        Assert.All(old, p => Assert.Contains("already has it", p!["message"]!.ToString()));
    }

    [Theory]
    [InlineData("blank-mobile.oml")]
    [InlineData("insurance-reactive-r8.oml")]
    [InlineData("wrightflood-personal-r8.oml")]
    public void TheCheckFindsNothingInAModuleTheStudioMade(string fixture)
    {
        if (!StudioAvailable()) return;
        var path = Path.Combine(Root, "tests", "fixtures", "odc", fixture);
        if (!File.Exists(path)) return;
        var report = CompileCheck.Module(new ModelHost(Path.Combine(Work(), "work")), File.ReadAllBytes(path), fixture);
        Assert.True(report["findings"]!.GetValue<int>() == 0, report.ToJsonString());
        Assert.Equal(report["read"]!["aggregates"]!.GetValue<int>(), report["walk"]!["aggregates"]!.GetValue<int>());
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(CompileCheckOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
