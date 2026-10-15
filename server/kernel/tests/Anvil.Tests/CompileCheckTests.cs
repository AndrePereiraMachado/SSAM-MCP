using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The publish error P0 of 2026-10-12 (VisitaCerta_CS): 18 actions delivered as ssam-flow text with aggregate sorts written as
/// expressions (`SORT -IdentifierToLongInteger(VisitEvent.Id)`, `SORT If(...)`), accepted by the Model API and the Verify, and
/// the OutSystems compiler failed on them. Per class (C:\t\pub\DIAGNOSTICO.md; review C:\t\pub\ACHADOS-PROVAR.json):
/// <list type="bullet">
/// <item>A (sorts): AggregateSortRule normalizes the forms that certainly mean one attribute and a direction, in the flow text
/// (FlowDiff.Sorts.cs) and in every `set` of ISort.Attribute (JSON logic, html, screen, raw verbs), listed in the receipt;
/// anything else is refused once, with the fix. A grouped aggregate sorts only by its grouped or aggregated columns.</item>
/// <item>A (columns, joins): a group by or aggregated column over an expression is refused, with the verified patch (CALC
/// NameRow + the column by name); a join the Studio never writes is refused (Right of two sources is the Left join swapped).</item>
/// <item>A, E, D on the candidate (CompileCheck.cs, the checagem de compilação): every rule is an error; a SOAP client the job's
/// verbs created is refused with the exact import call; the aggregates of the base the job did not write are judged too
/// (preexisting), with the raw ops that fix them when certain.</item>
/// <item>Zero false positives on what the Studio made: the fixtures here; the corpus of C:\t\html-plan\unique.json through
/// `anvil compile-check` (the bad capture of the session, when present, has exactly its three bad sorts).</item>
/// </list>
/// </summary>
public sealed class CompileCheckTests
{
    private const string Fixture = "blank-service.oml";
    private const string SessionCapture = @"C:\t\pub\VisitaCerta_CS-20261012154543-39594535.oml";

    private const string Spec = """
        {"op":"spec","data":{"entities":[
          {"name":"CcEvent","attributes":[{"name":"Title","type":"Text","length":50},{"name":"IsDone","type":"Boolean"},{"name":"Score","type":"Integer"}]},
          {"name":"CcTag","attributes":[{"name":"EventId","type":"CcEvent Identifier"},{"name":"Name","type":"Text","length":50}]}]}}
        """;

    private static string Scratch()
    {
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "compile-check-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir); return dir;
    }

    private static JsonNode Run(string dir, string name, string job, string? basePath = null)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), basePath, path, Path.Combine(dir, name + ".oml")))!;
    }

    private static JsonArray Refused(string dir, string name, string job, string? basePath = null)
    {
        var error = Assert.ThrowsAny<Exception>(() => Run(dir, name, job, basePath));
        var coded = Errors.FindCoded(error);
        Assert.True(coded != null, Errors.Text(error));
        File.WriteAllText(Path.Combine(dir, name + ".refusal.json"), coded!.Problems?.ToJsonString() + Environment.NewLine + Errors.Text(error));
        Assert.False(File.Exists(Path.Combine(dir, name + ".oml")), "a refused job saves nothing");
        return coded.Problems!;
    }

    private static string Flow(params string[] texts) => "{\"op\":\"logic\",\"data\":{\"flow\":[" + string.Join(",", texts.Select(t => JsonSerializer.Serialize(t))) + "]}}";
    private static string Act(string name, string query, string extra = "") => $"server action {name}\n{extra}  out N: Integer\n  Q = aggregate {query}\n  assign N = Q.List.Length\n  end\n";

    /// <summary>The sorts of the output module, in model order: (aggregate, attribute, direction, dynamic).</summary>
    private static List<(string Aggregate, string Attribute, string Direction, bool Dynamic)> Sorts(string dir, string oml) =>
        CompileCheck.SortsOf(new ModelHost(Path.Combine(dir, "read")), File.ReadAllBytes(oml))
            .Select(s => (s!["aggregate"]?.ToString() ?? "", s["attribute"]!.ToString(), s["direction"]?.ToString() ?? "", s["dynamic"]!.GetValue<bool>())).ToList();

    private static List<JsonObject> Parts(string dir, string oml, string kind) =>
        CompileCheck.PartsOf(new ModelHost(Path.Combine(dir, "read")), File.ReadAllBytes(oml)).OfType<JsonObject>().Where(p => p["kind"]!.ToString() == kind).ToList();

    /// <summary>A JSON patch (replace and add, as the refusals write them) applied to a job.</summary>
    private static JsonObject Patched(JsonObject job, JsonArray patch)
    {
        foreach (var step in patch.OfType<JsonObject>())
        {
            var path = step["path"]!.ToString().Split('/').Skip(1).ToArray();
            JsonNode node = job;
            foreach (var part in path[..^1]) node = node is JsonArray a ? a[int.Parse(part)]! : node[part]!;
            var last = path[^1];
            if (step["op"]!.ToString() == "add" && node is JsonArray list) { if (last == "-") list.Add(step["value"]!.DeepClone()); else list.Insert(int.Parse(last), step["value"]!.DeepClone()); }
            else if (node is JsonArray array) array[int.Parse(last)] = step["value"]!.DeepClone();
            else node[last] = step["value"]!.DeepClone();
        }
        return job;
    }

    // ---- the sort rule (pure) ----------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("-IdentifierToLongInteger(VisitEvent.Id)", "VisitEvent.Id", true)]
    [InlineData("VisitEvent.Id DESC", "VisitEvent.Id", true)]
    [InlineData("VisitEvent.Id desc", "VisitEvent.Id", true)]
    [InlineData("Place.Name ASC", "Place.Name", false)]
    [InlineData("-VisitEvent.Id", "VisitEvent.Id", true)]
    [InlineData("(Place.Name)", "Place.Name", false)]
    [InlineData("If(Place.IsFavorite, 0, 1)", "Place.IsFavorite", true)]
    [InlineData("If(Place.IsFavorite, 1, 0)", "Place.IsFavorite", false)]
    [InlineData("-VisitEvent.Id DESC", "VisitEvent.Id", false)]
    [InlineData("IntegerToLongInteger(Visit.Score)", "Visit.Score", false)]
    public void ACertainFormIsOneAttributeAndADirection(string text, string attribute, bool reversed)
    {
        var key = AggregateSortRule.Normalize(text);
        Assert.NotNull(key);
        Assert.Equal((attribute, reversed), (key!.Attribute, key.Flip));
        Assert.NotEmpty(key.Steps);
    }

    [Fact]
    public void APlainAttributeOrColumnIsItselfWithNoStep()
    {
        Assert.Equal(("Place.Name", false, 0), AggregateSortRule.Normalize(" Place.Name ") is { } k ? (k.Attribute, k.Flip, k.Steps.Count) : default);
        Assert.Equal(("SortDate", false, 0), AggregateSortRule.Normalize("SortDate") is { } c ? (c.Attribute, c.Flip, c.Steps.Count) : default);
    }

    [Theory]
    [InlineData("If(SortMode = \"safe\", -Visit.PredictedScore, If(SortMode = \"risk\", Visit.PredictedScore, 0))")]
    [InlineData("Visit.Score + 1")]
    [InlineData("ToLower(Place.Name)")]
    [InlineData("IdentifierToText(Place.Id)")]
    [InlineData("If(Place.IsFavorite, 0, 0)")]
    [InlineData("If(Place.Score > 3, 0, 1)")]
    [InlineData("\"Place.Name\"")]
    [InlineData("")]
    public void AnExpressionIsNotOneAttribute(string text) => Assert.Null(AggregateSortRule.Normalize(text));

    [Fact]
    public void AnAttributeOutsideTheAggregateIsNamed()
    {
        Assert.Null(AggregateSortRule.OutOfScope("Place.Name", ["Place"], []));
        Assert.Null(AggregateSortRule.OutOfScope("sortdate", ["Place"], ["SortDate"]));
        Assert.Contains("not a source", AggregateSortRule.OutOfScope("Visit.Id", ["Place"], []));
        Assert.Contains("not a column", AggregateSortRule.OutOfScope("SortMode", ["Place"], []));
    }

    [Fact]
    public void AGroupedAggregateSortsOnlyByTheAttributesItGroupsBy()
    {
        string[] keys = ["CcEvent.IsDone", "K"];
        Assert.Null(AggregateSortRule.OutOfGroup("CcEvent.IsDone", true, keys));
        Assert.Null(AggregateSortRule.OutOfGroup("k", true, keys));
        Assert.Null(AggregateSortRule.OutOfGroup("CcEvent.Score", false, []));
        Assert.Contains("8127", AggregateSortRule.OutOfGroup("CcEvent.Score", true, keys));
        // A sort lives before the grouping: an aggregated column is not there yet (the Verify: "Can't identify 'Total'").
        Assert.NotNull(AggregateSortRule.OutOfGroup("Total", true, keys));
        Assert.Contains("SORT one of CcEvent.IsDone, K", AggregateSortRule.GroupedFix(keys));
    }

    // ---- the flow text (pure) ----------------------------------------------------------------------------------------------

    [Fact]
    public void TheFlowTextWritesACertainSortAsTheStudioDoes()
    {
        var text = "server action History\n  out N: Integer\n  Q = aggregate FROM VisitEvent SORT -IdentifierToLongInteger(VisitEvent.Id), If(VisitEvent.IsDone, 0, 1), VisitEvent.Title DESC MAX 10\n  assign N = Q.List.Length\n  end\n";
        var diff = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(text));
        Assert.Empty(diff.Problems);
        Assert.Equal(3, diff.SortNormalizations.Count);
        Assert.Equal(("-IdentifierToLongInteger(VisitEvent.Id)", "VisitEvent.Id desc"), (diff.SortNormalizations[0].From, diff.SortNormalizations[0].To));
        var sorts = diff.Expected.Items.Single(i => i.Role == "node" && i.Kind == "AggregateNode").Items.Where(p => p.Role == "sort").ToList();
        Assert.Equal([("VisitEvent.Id", "Descending"), ("VisitEvent.IsDone", "Descending"), ("VisitEvent.Title", "Descending")],
            sorts.Select(s => (s.Prop("Attribute"), s.Prop("SortDirection"))));
        // The ops write the attribute and its direction, never the expression.
        Assert.DoesNotContain(diff.Ops, o => o.ToJsonString().Contains("IdentifierToLongInteger", StringComparison.Ordinal));
        Assert.Contains(diff.Ops, o => o["prop"]?.ToString() == "SortDirection" && o["value"]?.ToString() == "Descending");
    }

    [Fact]
    public void TheFlowTextRefusesASortThatIsNotOneAttributeWithTheFix()
    {
        var text = "server action Agenda\n  in SortMode: Text\n  out N: Integer\n"
            + "  Q = aggregate FROM VisitEvent SORT If(SortMode = \"safe\", -VisitEvent.Score, VisitEvent.Score), SortMode MAX 10\n"
            + "  G = aggregate FROM VisitEvent GROUP BY Year=Year(VisitEvent.CreatedOn) AGG Total=Count(VisitEvent.Id)\n"
            + "  assign N = Q.List.Length + G.List.Length\n  end\n";
        var diff = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(text));
        Assert.Equal(2, diff.Problems.Count(p => p.Code == AggregateSortRule.Code));
        // A group by over an expression is refused too (review, alta: it was only a HIGH warning).
        var column = Assert.Single(diff.Problems, p => p.Code == AggregateSortRule.ColumnCode);
        Assert.Contains("CALC YearRow=Year(VisitEvent.CreatedOn)", column.Fix);
        Assert.All(diff.Problems.Where(p => p.Code == AggregateSortRule.Code), p => Assert.Contains("CALC SortKey=", p.Fix));
        Assert.Contains(diff.Problems, p => p.Message.Contains("'SortMode' is not a column", StringComparison.Ordinal));
        Assert.Empty(diff.Ops);
    }

    [Fact]
    public void ASortExpressionBecomesACalculatedColumnWhenThatIsCertain()
    {
        var text = "server action Agenda\n  in SortMode: Text\n  out N: Integer\n"
            + "  Q = aggregate FROM VisitEvent SORT If(SortMode = \"safe\", -VisitEvent.Score, VisitEvent.Score), VisitEvent.Id MAX 10\n"
            + "  assign N = Q.List.Length\n  end\n";
        var diff = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(text), null, FlowDiff.AliasPrefix + ".", text);
        var problem = Assert.Single(diff.Problems);
        Assert.Equal(AggregateSortRule.Code, problem.Code);
        Assert.NotNull(problem.Corrected);
        Assert.Contains("Q = aggregate FROM VisitEvent CALC SortKey=If(SortMode = \"safe\", -VisitEvent.Score, VisitEvent.Score) SORT SortKey, VisitEvent.Id MAX 10", problem.Corrected);
        // The corrected text is accepted as it is (the patch was read again under the same rules).
        var again = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(problem.Corrected!), null, FlowDiff.AliasPrefix + ".", problem.Corrected);
        Assert.Empty(again.Problems);
        // Rows read whole (Rows = Q.List) would change type with a new column: no patch, the fix only.
        var whole = text.Replace("out N: Integer", "out Rows: VisitEvent List", StringComparison.Ordinal).Replace("assign N = Q.List.Length", "assign Rows = Q.List", StringComparison.Ordinal);
        var refused = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(whole), null, FlowDiff.AliasPrefix + ".", whole);
        Assert.Null(Assert.Single(refused.Problems).Corrected);
        // A mapping reads field by field: certain.
        var mapped = text.Replace("out N: Integer", "out N: Integer\n  out Ids: IdList", StringComparison.Ordinal)
            .Replace("assign N = Q.List.Length", "assign\n    N = Q.List.Length\n    Ids = Q.List mapTo { Id: Q.List.Current.VisitEvent.Id }", StringComparison.Ordinal);
        var withMapping = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(mapped), null, FlowDiff.AliasPrefix + ".", mapped);
        Assert.NotNull(Assert.Single(withMapping.Problems, p => p.Code == AggregateSortRule.Code).Corrected);
    }

    [Fact]
    public void NoPatchWhenTheDatabaseCannotRunTheExpression()
    {
        // Review (baixa): CALC SortKey=EncodeHtml(...) would be refused by the Verify (InvalidArgumentForExternalFunction).
        var text = Act("P1", "FROM CcEvent SORT EncodeHtml(CcEvent.Title) MAX 10");
        var diff = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(text), null, FlowDiff.AliasPrefix + ".", text);
        var problem = Assert.Single(diff.Problems);
        Assert.Equal(AggregateSortRule.Code, problem.Code);
        Assert.Null(problem.Corrected);
        Assert.True(AggregateSortRule.RunsInDatabase("If(CcEvent.IsDone, ToUpper(CcEvent.Title), \"\")"));
        Assert.False(AggregateSortRule.RunsInDatabase("EncodeHtml(CcEvent.Title)"));
    }

    [Fact]
    public void ASortThatRepeatsAnEarlierKeyIsDroppedAndListed()
    {
        // Review (baixa): the normalization made two equal keys and the Verify refused a sort the model never wrote.
        foreach (var (query, kept) in new[] { ("SORT -IdentifierToLongInteger(CcEvent.Id), CcEvent.Id MAX 10", ("CcEvent.Id", "Descending")),
                                               ("SORT If(CcEvent.IsDone, 0, 1), CcEvent.IsDone MAX 10", ("CcEvent.IsDone", "Descending")) })
        {
            var diff = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(Act("N1", "FROM CcEvent " + query)));
            Assert.Empty(diff.Problems);
            var sort = Assert.Single(diff.Expected.Items.Single(i => i.Role == "node" && i.Kind == "AggregateNode").Items, p => p.Role == "sort");
            Assert.Equal(kept, (sort.Prop("Attribute"), sort.Prop("SortDirection")));
            Assert.Contains(diff.SortNormalizations, n => n.To == "(removed)");
        }
    }

    [Fact]
    public void ASortReadAndWrittenBackAsItWasIsNotJudged()
    {
        // A sort the module already has (written by an older tool) stays as it is when the text does not change it (the apply
        // refuses it as preexisting, with the raw ops that fix it).
        var baseline = ModuleFlow.Read("server action Legacy\n  out N: Integer\n  Q = aggregate FROM VisitEvent SORT -VisitEvent.Score MAX 10\n  assign N = Q.List.Length\n  end\n");
        baseline.Key = "Kaction";
        var k = 0;
        foreach (var item in baseline.Items.Where(i => FlowItem.Keyed(i.Role))) item.Key = "K" + ++k;
        var read = ModuleFlow.Print(baseline);
        var edited = read.Text.Replace("assign N = Q.List.Length", "assign N = Q.List.Length + 1", StringComparison.Ordinal);
        var diff = FlowDiff.Compute(baseline, read.Keys, ModuleFlow.Read(edited), read.Text);
        Assert.Empty(diff.Problems);
        Assert.Empty(diff.SortNormalizations);
        // The same sort changed by the text is judged (normalized).
        var changed = FlowDiff.Compute(baseline, read.Keys, ModuleFlow.Read(read.Text.Replace("SORT -VisitEvent.Score", "SORT -VisitEvent.Score, VisitEvent.Title", StringComparison.Ordinal)), read.Text);
        Assert.Empty(changed.Problems);
        Assert.Single(changed.SortNormalizations);
    }

    [Fact]
    public void TheFlowTextRefusesAColumnOverAnExpressionWithItsVerifiedPatch()
    {
        // Review (alta): GROUP BY / AGG over an expression, the P0 roots included, were delivered with a HIGH warning only.
        foreach (var (query, from, to) in new[]
        {
            ("FROM CcEvent GROUP BY Up=ToUpper(CcEvent.Title) AGG Total=Count(CcEvent.Id)", "GROUP BY Up=ToUpper(CcEvent.Title)", "GROUP BY Up=UpRow AGG Total=Count(CcEvent.Id) CALC UpRow=ToUpper(CcEvent.Title)"),
            ("FROM CcEvent GROUP BY CcEvent.IsDone AGG Total=Sum(CcEvent.Score * 2)", "AGG Total=Sum(CcEvent.Score * 2)", "AGG Total=Sum(TotalRow) CALC TotalRow=CcEvent.Score * 2"),
            ("FROM CcEvent GROUP BY K=-IdentifierToLongInteger(CcEvent.Id) AGG Total=Count(CcEvent.Id)", "GROUP BY K=-IdentifierToLongInteger(CcEvent.Id)", "GROUP BY K=KRow AGG Total=Count(CcEvent.Id) CALC KRow=-IdentifierToLongInteger(CcEvent.Id)"),
            ("FROM CcEvent GROUP BY Bucket=If(CcEvent.Score > 10, \"high\", \"low\") AGG Total=Count(CcEvent.Id)", "GROUP BY Bucket=If(", "GROUP BY Bucket=BucketRow AGG Total=Count(CcEvent.Id) CALC BucketRow=If(CcEvent.Score > 10, \"high\", \"low\")"),
            ("FROM CcEvent GROUP BY CcEvent.IsDone AGG Top=Max(If(CcEvent.IsDone, CcEvent.Score, 0)) SORT CcEvent.IsDone desc", "AGG Top=Max(If(", "AGG Top=Max(TopRow) CALC TopRow=If(CcEvent.IsDone, CcEvent.Score, 0) SORT CcEvent.IsDone desc"),
        })
        {
            var text = Act("G1", query);
            var diff = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(text), null, FlowDiff.AliasPrefix + ".", text);
            var problem = Assert.Single(diff.Problems);
            Assert.Equal(AggregateSortRule.ColumnCode, problem.Code);
            Assert.Contains(from, problem.Message);
            Assert.True(problem.Corrected != null, query);
            Assert.Contains(to, problem.Corrected);
            Assert.Empty(diff.Ops);
            var again = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(problem.Corrected!), null, FlowDiff.AliasPrefix + ".", problem.Corrected);
            Assert.Empty(again.Problems);
        }
        // Not certain: the rows read whole, an unnamed group, a function the database does not run.
        var whole = "server action W\n  out Rows: CcEvent List\n  Q = aggregate FROM CcEvent GROUP BY Up=ToUpper(CcEvent.Title) AGG Total=Count(CcEvent.Id)\n  assign Rows = Q.List\n  end\n";
        Assert.Null(Assert.Single(FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(whole), null, FlowDiff.AliasPrefix + ".", whole).Problems).Corrected);
        var unnamed = Act("U", "FROM CcEvent GROUP BY ToUpper(CcEvent.Title) AGG Total=Count(CcEvent.Id)");
        Assert.Null(Assert.Single(FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(unnamed), null, FlowDiff.AliasPrefix + ".", unnamed).Problems).Corrected);
        var html = Act("H", "FROM CcEvent GROUP BY E=EncodeHtml(CcEvent.Title) AGG Total=Count(CcEvent.Id)");
        Assert.Null(Assert.Single(FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(html), null, FlowDiff.AliasPrefix + ".", html).Problems).Corrected);
        // The published forms pass: a calculated column grouped or aggregated by name.
        foreach (var query in new[] { "FROM CcEvent GROUP BY B=K AGG Total=Count(CcEvent.Id) CALC K=CcEvent.Score / 10 SORT K", "FROM CcEvent AGG Total=Sum(TotalRow) CALC TotalRow=If(CcEvent.IsDone, CcEvent.Score, 0) MAX 1" })
            Assert.Empty(FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(Act("P", query))).Problems);
    }

    [Fact]
    public void TheFlowTextRefusesAGroupedSortOutsideTheGroup()
    {
        // Review (média): a grouped aggregate sorted by an attribute that is not grouped passed silently (SQL Server error 8127).
        foreach (var query in new[] { "FROM CcEvent GROUP BY CcEvent.IsDone AGG Total=Count(CcEvent.Id) SORT CcEvent.Score",
                                      "FROM CcEvent GROUP BY CcEvent.IsDone AGG Total=Count(CcEvent.Id) SORT CcEvent.Title desc",
                                      "FROM CcEvent GROUP BY CcEvent.IsDone AGG Total=Count(CcEvent.Id) SORT -IdentifierToLongInteger(CcEvent.Id)",
                                      "FROM CcEvent GROUP BY CcEvent.IsDone AGG Total=Count(CcEvent.Id) SORT Total desc" })
        {
            var diff = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(Act("G", query)));
            var problem = Assert.Single(diff.Problems);
            Assert.Equal(AggregateSortRule.Code, problem.Code);
            Assert.Contains("8127", problem.Message);
            Assert.Contains("SORT one of CcEvent.IsDone", problem.Fix);
            Assert.Empty(diff.SortNormalizations);
        }
        // The published forms: the grouped attribute, and a calculated column grouped by name (AgentOps ReadRunsPerDay).
        foreach (var query in new[] { "FROM CcEvent GROUP BY CcEvent.IsDone AGG Total=Count(CcEvent.Id) SORT CcEvent.IsDone desc",
                                      "FROM CcEvent GROUP BY B=K AGG Total=Count(CcEvent.Id) CALC K=CcEvent.Score / 10 SORT K" })
            Assert.Empty(FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(Act("G", query))).Problems);
    }

    [Fact]
    public void TheFlowTextWritesARightJoinAsTheStudioDoesAndRefusesTheOthers()
    {
        // Review (baixa/média): Right, None and two sources without a join passed silently.
        var right = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(Act("J", "FROM CcEvent, CcTag JOIN Right CcEvent~CcTag ON CcTag.EventId = CcEvent.Id MAX 10")));
        Assert.Empty(right.Problems);
        var normalized = Assert.Single(right.JoinNormalizations);
        Assert.Equal(("Right CcEvent~CcTag", "Left CcTag~CcEvent"), (normalized.From, normalized.To));
        var join = Assert.Single(right.Expected.Items.Single(i => i.Role == "node" && i.Kind == "AggregateNode").Items, p => p.Role == "join");
        Assert.Equal(("Left", "CcTag", "CcEvent"), (join.Prop("JoinType"), join.Prop("LeftSource"), join.Prop("RightSource")));
        foreach (var query in new[] { "FROM CcEvent, CcTag JOIN None CcEvent~CcTag ON CcTag.EventId = CcEvent.Id MAX 10", "FROM CcEvent, CcTag MAX 10" })
        {
            var diff = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(Act("J", query)));
            Assert.Contains(diff.Problems, p => p.Code == AggregateSortRule.JoinCode);
            Assert.Empty(diff.Ops);
        }
        foreach (var type in new[] { "Inner", "Left", "Full" })
            Assert.Empty(FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(Act("J", $"FROM CcEvent, CcTag JOIN {type} CcEvent~CcTag ON CcTag.EventId = CcEvent.Id MAX 10"))).Problems);
    }

    /// <summary>What the model says of the identifiers (Count(Source.Id)), for the text's patch of a column that reads nothing.</summary>
    private sealed class Identifiers : IFlowTypes
    {
        public string? TypeOf(string name) => null;
        public IReadOnlyList<(string Alias, string Record)>? SourcesOf(string aggregate) => null;
        public IReadOnlyList<string>? AttributesOf(string record) => null;
        public string? IdentifierOf(string record) => record == "CcEvent" ? "Id" : null;
    }

    [Fact]
    public void TheFlowTextRefusesAColumnThatReadsNoAttribute()
    {
        // Re-check (high): `AGG Total=Count()` was read as a column with an empty Attribute and delivered (no data type; the O11
        // Verify passes it while nothing reads the column). The parse refuses `Fn()` with the column's code and fix.
        var count = Assert.Throws<FlowRuleFormatException>(() => ModuleFlow.Read(Act("E1", "FROM CcEvent GROUP BY CcEvent.IsDone AGG Total=Count()")));
        Assert.Equal(AggregateSortRule.ColumnCode, count.Code);
        Assert.Contains("reads no attribute", count.Message);
        Assert.Contains("AGG Total=Count(CcEvent.Id)", count.Fix);
        Assert.Equal(("Total=Count()", "Total=Count(CcEvent.{identifier})", "CcEvent"), (count.Replace, count.With, count.Entity));
        foreach (var query in new[] { "FROM CcEvent GROUP BY CcEvent.IsDone AGG X=Sum()", "FROM CcEvent GROUP BY CcEvent.IsDone AGG X=Max( )", "FROM CcEvent GROUP BY G=, CcEvent.IsDone AGG T=Count(CcEvent.Id)",
                                      "FROM CcEvent, CcTag JOIN Inner CcEvent~CcTag ON CcTag.EventId = CcEvent.Id GROUP BY CcEvent.IsDone AGG T=Count()" })
        {
            var refused = Assert.Throws<FlowRuleFormatException>(() => ModuleFlow.Read(Act("E2", query)));
            Assert.Equal(AggregateSortRule.ColumnCode, refused.Code);
            Assert.Null(refused.Replace);   // certain only for Count with one source
        }
        // `` is what the reader prints for a column that reads nothing: parsed, and refused by the diff (with the patch when the
        // model names the identifier of the one source).
        var text = Act("E3", "FROM CcEvent GROUP BY CcEvent.IsDone AGG Total=Count(``)");
        var bare = Assert.Single(FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(text), null, FlowDiff.AliasPrefix + ".", text).Problems);
        Assert.Equal(AggregateSortRule.ColumnCode, bare.Code);
        Assert.Contains("reads no attribute", bare.Message);
        Assert.Null(bare.Corrected);
        var typed = Assert.Single(FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(text), null, FlowDiff.AliasPrefix + ".", text, types: new Identifiers()).Problems);
        Assert.Contains("AGG Total=Count(CcEvent.Id)", typed.Corrected);
        Assert.Empty(FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(typed.Corrected!), null, FlowDiff.AliasPrefix + ".", typed.Corrected).Problems);
        // Sum(``) and GROUP BY G=``: refused, no patch (which attribute is the author's).
        foreach (var query in new[] { "FROM CcEvent GROUP BY CcEvent.IsDone AGG X=Sum(``)", "FROM CcEvent GROUP BY G=`` AGG T=Count(CcEvent.Id)" })
        {
            var empty = Act("E4", query);
            var problem = Assert.Single(FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(empty), null, FlowDiff.AliasPrefix + ".", empty, types: new Identifiers()).Problems);
            Assert.Equal(AggregateSortRule.ColumnCode, problem.Code);
            Assert.Null(problem.Corrected);
        }
    }

    // ---- jobs on the fixture ----------------------------------------------------------------------------------------------

    [Fact]
    public void AFlowTextJobWritesNativeSortsAndListsThem()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var flow = JsonSerializer.Serialize("server action CcHistory\n  out N: Integer\n  Q = aggregate FROM CcEvent SORT -IdentifierToLongInteger(CcEvent.Id), If(CcEvent.IsDone, 0, 1), CcEvent.Title DESC MAX 10\n  assign N = Q.List.Length\n  end\n");
        var result = Run(dir, "cc-flow", $$$"""{"base":"{{{Fixture}}}","ops":[{{{Spec}}},{"op":"logic","data":{"flow":[{{{flow}}}]}}]}""");
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var rewrites = result["expressionRewrites"]!.AsArray();
        // Junction 24-1-final: `CcEvent.Title DESC` is written `desc` by the text normalizer of tx-visitacerta before the sort rule
        // reads it (FLOW_SORT_DIRECTION in normalizations); the two expressions are the sort rule's (expressionRewrites and notes).
        Assert.Equal(2, rewrites.Count);
        Assert.Contains(rewrites, r => r!["from"]!.ToString() == "-IdentifierToLongInteger(CcEvent.Id)" && r["to"]!.ToString() == "CcEvent.Id desc" && r["path"]!.ToString().StartsWith("/ops/1/data/flow", StringComparison.Ordinal));
        Assert.Contains(rewrites, r => r!["from"]!.ToString() == "If(CcEvent.IsDone, 0, 1)" && r["to"]!.ToString() == "CcEvent.IsDone desc");
        Assert.Equal(2, result["notes"]!.AsArray().Count(n => n!["code"]!.ToString() == AggregateSortRule.NormalizedCode));
        Assert.Contains(result["normalizations"]!.AsArray(), n => n!["rule"]!.ToString() == "FLOW_SORT_DIRECTION" && n["to"]!.ToString().Contains("CcEvent.Title desc", StringComparison.Ordinal));
        Assert.Equal([("Q", "CcEvent.Id", "Descending", false), ("Q", "CcEvent.IsDone", "Descending", false), ("Q", "CcEvent.Title", "Descending", false)],
            Sorts(dir, Path.Combine(dir, "cc-flow.oml")));
    }

    [Fact]
    public void ALogicJobWritesNativeSortsAndListsThem()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var job = $$$"""
            {"base":"{{{Fixture}}}","ops":[{{{Spec}}},
             {"op":"logic","data":{"actions":[{"name":"CcList","outputs":[{"name":"N","type":"Integer"}],"steps":[
               {"get":"CcEvent","as":"GetEvents","sort":["-IdentifierToLongInteger(CcEvent.Id)","If(CcEvent.IsDone, 0, 1)",{"by":"CcEvent.Title","desc":true}],"max":10},
               {"assign":{"N":"GetEvents.List.Length"}}]}]}}]}
            """;
        var result = Run(dir, "cc-logic", job);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var rewrites = result["expressionRewrites"]!.AsArray();
        Assert.Contains(rewrites, r => r!["from"]!.ToString() == "IdentifierToLongInteger(CcEvent.Id)" && r["to"]!.ToString().StartsWith("CcEvent.Id", StringComparison.Ordinal));
        Assert.Contains(rewrites, r => r!["from"]!.ToString() == "If(CcEvent.IsDone, 0, 1)");
        // The direction the expander writes after the attribute keeps the reversal: If(C, 0, 1) ascending is C descending.
        Assert.Equal([("GetEvents", "CcEvent.Id", "Descending", false), ("GetEvents", "CcEvent.IsDone", "Descending", false), ("GetEvents", "CcEvent.Title", "Descending", false)],
            Sorts(dir, Path.Combine(dir, "cc-logic.oml")));
    }

    [Fact]
    public void ASortThatIsNotOneAttributeIsRefusedOnceWithEveryProblemAndTheFix()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var flow = JsonSerializer.Serialize("server action CcAgenda\n  in SortMode: Text\n  out N: Integer\n  Q = aggregate FROM CcEvent SORT If(SortMode = \"safe\", -CcEvent.Score, CcEvent.Score) MAX 10\n  assign N = Q.List.Length\n  end\n");
        var job = $$$"""
            {"base":"{{{Fixture}}}","ops":[{{{Spec}}},
             {"op":"logic","data":{"flow":[{{{flow}}}]}},
             {"op":"logic","data":{"actions":[{"name":"CcRanked","inputs":[{"name":"Mode","type":"Text"}],"outputs":[{"name":"N","type":"Integer"}],"steps":[
               {"get":"CcEvent","as":"GetRanked","sort":"If(Mode = \"a\", CcEvent.Score, 0)","max":10},
               {"assign":{"N":"GetRanked.List.Length"}}]}]}}]}
            """;
        var problems = Refused(dir, "cc-refused", job);
        var sorts = problems.Where(p => p!["code"]!.ToString() == AggregateSortRule.Code).ToList();
        Assert.Equal(2, sorts.Count);
        // The flow text: refused at its text. The JSON op: refused by the checagem de compilação, at its step.
        Assert.Contains(sorts, p => p!["op"]!.GetValue<int>() == 1 && p["pointer"]!.ToString().StartsWith("/ops/1/data/flow", StringComparison.Ordinal));
        var check = Assert.Single(sorts, p => p!["op"]!.GetValue<int>() == 2)!;
        Assert.Equal("/ops/2/data/actions/0/steps/0", check["pointer"]!.ToString());
        Assert.Equal("apply", check["phase"]!.ToString());
        Assert.Contains("CALC SortKey=", check["fix"]!.ToString());
    }

    [Fact]
    public void ALogicSortOverAVariableKeepsItsExpressionInTheRefusal()
    {
        // Review (baixa): If(Fav, 0, 1) with Fav an input was written as 'Fav' and refused as "'Fav' ... is not a column".
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var problems = Refused(dir, "cc-fav", $$$"""
            {"base":"{{{Fixture}}}","ops":[{{{Spec}}},
             {"op":"logic","data":{"actions":[{"name":"CcFav","inputs":[{"name":"Fav","type":"Boolean"}],"outputs":[{"name":"N","type":"Integer"}],"steps":[
               {"get":"CcEvent","as":"GetFav","sort":"If(Fav, 0, 1)","max":10},{"assign":{"N":"GetFav.List.Length"}}]}]}}]}
            """);
        var problem = Assert.Single(problems, p => p!["code"]!.ToString() == AggregateSortRule.Code)!;
        Assert.Contains("'If(Fav, 0, 1)'", problem["message"]!.ToString());
        Assert.Contains("If(Fav, 0, 1)", problem["fix"]!.ToString());
        Assert.DoesNotContain("CALC SortKey=Fav", problem["fix"]!.ToString());
    }

    [Fact]
    public void ARawSetOfASortIsWrittenAsTheStudioDoesOrRefusedAtItsValue()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        const string Logic = """
            {"op":"logic","data":{"actions":[{"name":"CcRaw","outputs":[{"name":"N","type":"Integer"}],"steps":[
              {"get":"CcEvent","as":"GetEvents","sort":"CcEvent.Title","max":10},{"assign":{"N":"GetEvents.List.Length"}}]}]}}
            """;
        // The direction written BEFORE the attribute: `-X` reverses the declared one (Descending -> Ascending).
        var result = Run(dir, "cc-raw", $$$"""
            {"base":"{{{Fixture}}}","ops":[{{{Spec}}},{{{Logic}}},
             {"op":"create","parent":"IAggregateNode:GetEvents","type":"ISort","as":"$s"},
             {"op":"set","target":"$s","prop":"SortDirection","value":"Descending"},
             {"op":"set","target":"$s","prop":"Attribute","value":"-IdentifierToLongInteger(CcEvent.Id)"}]}
            """);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        Assert.Contains(result["expressionRewrites"]!.AsArray(), r => r!["from"]!.ToString() == "-IdentifierToLongInteger(CcEvent.Id)");
        Assert.Equal([("GetEvents", "CcEvent.Title", "Ascending", false), ("GetEvents", "CcEvent.Id", "Ascending", false)], Sorts(dir, Path.Combine(dir, "cc-raw.oml")));
        // An expression that is not one attribute: refused once by the checagem de compilação, at the value of its set.
        var problems = Refused(dir, "cc-raw-refused", $$$"""
            {"base":"{{{Fixture}}}","ops":[{{{Spec}}},{{{Logic}}},
             {"op":"create","parent":"IAggregateNode:GetEvents","type":"ISort","as":"$s"},
             {"op":"set","target":"$s","prop":"Attribute","value":"CcEvent.Score * 2"}]}
            """);
        var problem = Assert.Single(problems, p => p!["code"]!.ToString() == AggregateSortRule.Code)!;
        Assert.Equal("/ops/3/value", problem["pointer"]!.ToString());
        Assert.Equal("apply", problem["phase"]!.ToString());
    }

    [Fact]
    public void AColumnOverAnExpressionIsRefusedInEveryWriterAndThePatchedTextIsDelivered()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        // JSON logic: refused at its step (it was a HIGH warning).
        var logic = Refused(dir, "cc-column", $$$"""
            {"base":"{{{Fixture}}}","ops":[{{{Spec}}},
             {"op":"logic","data":{"actions":[{"name":"CcTotals","outputs":[{"name":"N","type":"Integer"}],"steps":[
               {"get":"CcEvent","as":"GetTotals","columns":[{"name":"Total","kind":"Sum","attribute":"CcEvent.Score * 2"},{"name":"Done","kind":"Group","attribute":"CcEvent.IsDone"}]},
               {"assign":{"N":"GetTotals.List.Length"}}]}]}}]}
            """);
        var column = Assert.Single(logic, p => p!["code"]!.ToString() == AggregateSortRule.ColumnCode)!;
        Assert.Equal("/ops/1/data/actions/0/steps/0", column["pointer"]!.ToString());
        Assert.Contains("CALC TotalRow=CcEvent.Score * 2 and AGG Total=Sum(TotalRow)", column["fix"]!.ToString());
        // Raw verbs: refused at the value of the set.
        var raw = Refused(dir, "cc-column-raw", $$$"""
            {"base":"{{{Fixture}}}","ops":[{{{Spec}}},
             {"op":"logic","data":{"actions":[{"name":"CcRaw3","outputs":[{"name":"N","type":"Integer"}],"steps":[{"get":"CcEvent","as":"GetG","max":10},{"assign":{"N":"GetG.List.Length"}}]}]}},
             {"op":"create","parent":"IAggregateNode:GetG","type":"IGroupByAttribute","name":"Bucket","as":"$g"},
             {"op":"set","target":"$g","prop":"Attribute","value":"If(CcEvent.Score > 10, \"high\", \"low\")"}]}
            """);
        Assert.Equal("/ops/3/value", Assert.Single(raw, p => p!["code"]!.ToString() == AggregateSortRule.ColumnCode)!["pointer"]!.ToString());
        // The flow text: refused with the verified patch; the patched job is delivered as the published form.
        var text = Act("CcBuckets", "FROM CcEvent GROUP BY Up=ToUpper(CcEvent.Title) AGG Total=Count(CcEvent.Id)");
        var job = JsonNode.Parse($$$"""{"base":"{{{Fixture}}}","ops":[{{{Spec}}},{{{Flow(text)}}}]}""")!.AsObject();
        var flow = Refused(dir, "cc-column-flow", job.ToJsonString());
        var problem = Assert.Single(flow, p => p!["code"]!.ToString() == AggregateSortRule.ColumnCode)!;
        var patched = Patched(job, problem["patch"]!.AsArray());
        Assert.Contains("CALC UpRow=ToUpper(CcEvent.Title)", patched.ToJsonString(new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
        var result = Run(dir, "cc-column-patched", patched.ToJsonString());
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var oml = Path.Combine(dir, "cc-column-patched.oml");
        Assert.Equal("UpRow", Assert.Single(Parts(dir, oml, "group"))["value"]!.ToString());
        Assert.Equal("ToUpper(CcEvent.Title)", Assert.Single(Parts(dir, oml, "calc"))["value"]!.ToString());
    }

    [Fact]
    public void AGroupedSortOutsideTheGroupIsRefusedInEveryWriter()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var problems = Refused(dir, "cc-grouped", $$$"""
            {"base":"{{{Fixture}}}","ops":[{{{Spec}}},
             {{{Flow(Act("CcG1", "FROM CcEvent GROUP BY CcEvent.IsDone AGG Total=Count(CcEvent.Id) SORT CcEvent.Score"))}}},
             {"op":"logic","data":{"actions":[{"name":"CcG2","outputs":[{"name":"N","type":"Integer"}],"steps":[
               {"get":"CcEvent","as":"GetG2","columns":[{"name":"Done","kind":"Group","attribute":"CcEvent.IsDone"},{"name":"Total","kind":"Count","attribute":"CcEvent.Id"}],"sort":"CcEvent.Score"},
               {"assign":{"N":"GetG2.List.Length"}}]}]}},
             {"op":"logic","data":{"actions":[{"name":"CcG3","outputs":[{"name":"N","type":"Integer"}],"steps":[
               {"get":"CcEvent","as":"GetG3","columns":[{"name":"Done","kind":"Group","attribute":"CcEvent.IsDone"}]},{"assign":{"N":"GetG3.List.Length"}}]}]}},
             {"op":"create","parent":"IAggregateNode:GetG3","type":"ISort","as":"$s"},
             {"op":"set","target":"$s","prop":"Attribute","value":"CcEvent.Title"}]}
            """);
        var sorts = problems.Where(p => p!["code"]!.ToString() == AggregateSortRule.Code).ToList();
        Assert.Equal(3, sorts.Count);
        Assert.All(sorts, p => Assert.Contains("8127", p!["message"]!.ToString()));
        Assert.Contains(sorts, p => p!["pointer"]!.ToString().StartsWith("/ops/1/data/flow", StringComparison.Ordinal));
        Assert.Contains(sorts, p => p!["pointer"]!.ToString() == "/ops/2/data/actions/0/steps/0");
        Assert.Contains(sorts, p => p!["pointer"]!.ToString() == "/ops/5/value");
        // Sorted by its grouped attribute or an aggregated column: delivered.
        var result = Run(dir, "cc-grouped-ok", $$$"""{"base":"{{{Fixture}}}","ops":[{{{Spec}}},{{{Flow(Act("CcG1", "FROM CcEvent GROUP BY CcEvent.IsDone AGG Total=Count(CcEvent.Id) SORT CcEvent.IsDone desc"))}}}]}""");
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
    }

    [Fact]
    public void JoinsAreTheThreeTheStudioWrites()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        // Right of two sources: the Left join with them swapped, in the text and in the logic op, listed.
        var result = Run(dir, "cc-right", $$$"""
            {"base":"{{{Fixture}}}","ops":[{{{Spec}}},
             {{{Flow(Act("CcJ1", "FROM CcEvent, CcTag JOIN Right CcEvent~CcTag ON CcTag.EventId = CcEvent.Id MAX 10"))}}},
             {"op":"logic","data":{"actions":[{"name":"CcJ2","outputs":[{"name":"N","type":"Integer"}],"steps":[
               {"get":"CcEvent","as":"GetJ2","sources":["CcTag"],"joins":[{"left":"CcEvent","right":"CcTag","kind":"Right","condition":"CcTag.EventId = CcEvent.Id"}],"max":10},
               {"assign":{"N":"GetJ2.List.Length"}}]}]}}]}
            """);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        // Listed: the text in the notes and its rewrite, the logic op in its preflight warnings (LogicExpander's notes).
        Assert.Single(result["notes"]!.AsArray(), n => n!["code"]!.ToString() == AggregateSortRule.JoinNormalizedCode);
        Assert.Contains(result["expressionRewrites"]!.AsArray(), r => r!["to"]!.ToString() == "Left CcTag~CcEvent");
        Assert.Contains(result["preflight"]!["warnings"]!.AsArray(), w => w!["code"]!.ToString() == AggregateSortRule.JoinNormalizedCode);
        var joins = Parts(dir, Path.Combine(dir, "cc-right.oml"), "join");
        Assert.Equal(2, joins.Count);
        Assert.All(joins, j => Assert.Equal(("Left", "CcTag", "CcEvent"), (j["type"]!.ToString(), j["left"]!.ToString(), j["right"]!.ToString())));
        // None, a source in no join, and a raw set of Right: refused.
        var problems = Refused(dir, "cc-joins", $$$"""
            {"base":"{{{Fixture}}}","ops":[{{{Spec}}},
             {{{Flow(Act("CcJ3", "FROM CcEvent, CcTag JOIN None CcEvent~CcTag ON CcTag.EventId = CcEvent.Id MAX 10"), Act("CcJ4", "FROM CcEvent, CcTag MAX 10"))}}},
             {"op":"logic","data":{"actions":[{"name":"CcJ5","outputs":[{"name":"N","type":"Integer"}],"steps":[
               {"get":"CcEvent","as":"GetJ5","sources":["CcTag"],"joins":[{"left":"CcEvent","right":"CcTag","kind":"Inner","condition":"CcTag.EventId = CcEvent.Id"}],"max":10},
               {"assign":{"N":"GetJ5.List.Length"}}]}]}},
             {"op":"set","target":"IAggregateNode:GetJ5/**IJoin","prop":"JoinType","value":"Right"}]}
            """);
        var refused = problems.Where(p => p!["code"]!.ToString() == AggregateSortRule.JoinCode).ToList();
        Assert.True(refused.Count >= 3, problems.ToJsonString());
        Assert.Contains(refused, p => p!["pointer"]!.ToString() == "/ops/3/value" && p["fix"]!.ToString().Contains("JOIN Left CcTag~CcEvent", StringComparison.Ordinal));
        Assert.Contains(refused, p => p!["message"]!.ToString().Contains("in no join", StringComparison.Ordinal));
    }

    [Fact]
    public void AColumnThatReadsNoAttributeIsRefusedInEveryWriterWithItsPatchWhenCertain()
    {
        // Re-check (high): a column without an attribute (text Count(), JSON "", a raw create or set) was "entregue" on O11.
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        // The text: refused at the parse; Count with one source carries the corrected text, which is delivered.
        var job = JsonNode.Parse($$$"""{"base":"{{{Fixture}}}","ops":[{{{Spec}}},{{{Flow(Act("CcCount", "FROM CcEvent GROUP BY CcEvent.IsDone AGG Total=Count()"))}}}]}""")!.AsObject();
        var text = Assert.Single(Refused(dir, "cc-empty-flow", job.ToJsonString()), p => p!["code"]!.ToString() == AggregateSortRule.ColumnCode)!;
        Assert.StartsWith("/ops/1/data/flow", text["pointer"]!.ToString(), StringComparison.Ordinal);
        Assert.Contains("Total=Count(CcEvent.Id)", text["fix"]!.ToString());
        var patched = Run(dir, "cc-empty-flow-patched", Patched(job, text["patch"]!.AsArray()).ToJsonString());
        Assert.True(patched["accepted"]!.GetValue<bool>(), patched["policyMessages"]?.ToJsonString() + patched["details"]);
        var agg = Assert.Single(Parts(dir, Path.Combine(dir, "cc-empty-flow-patched.oml"), "agg"));
        Assert.Equal(("CcEvent.Id", "Count"), (agg["value"]!.ToString(), agg["type"]!.ToString()));
        // Sum() has no certain patch.
        Assert.Null(Assert.Single(Refused(dir, "cc-empty-sum", $$$"""{"base":"{{{Fixture}}}","ops":[{{{Spec}}},{{{Flow(Act("CcSum", "FROM CcEvent GROUP BY CcEvent.IsDone AGG X=Sum()"))}}}]}"""),
            p => p!["code"]!.ToString() == AggregateSortRule.ColumnCode)!["patch"]);
        // The logic op: a field error at the column's attribute.
        var logic = Assert.Single(Refused(dir, "cc-empty-logic", $$$"""
            {"base":"{{{Fixture}}}","ops":[{{{Spec}}},
             {"op":"logic","data":{"actions":[{"name":"CcLogic","outputs":[{"name":"N","type":"Integer"}],"steps":[
               {"get":"CcEvent","as":"GetLogic","columns":[{"name":"G","kind":"Group","attribute":"CcEvent.IsDone"},{"name":"T","kind":"Count","attribute":""}]},
               {"assign":{"N":"GetLogic.List.Length"}}]}]}}]}
            """), p => p!["code"]!.ToString() == AggregateSortRule.ColumnCode)!;
        Assert.Equal("/ops/1/data/actions/0/steps/0/columns/1/attribute", logic["pointer"]!.ToString());
        Assert.Contains("T=Count(CcEvent.Id)", logic["fix"]!.ToString());
        // Raw verbs: a create without its set, and a set that clears the attribute (Count: patched at the set's value).
        const string Grouped = """
            {"op":"logic","data":{"actions":[{"name":"CcRaw4","outputs":[{"name":"N","type":"Integer"}],"steps":[
              {"get":"CcEvent","as":"GetRaw4","columns":[{"name":"G","kind":"Group","attribute":"CcEvent.IsDone"},{"name":"T","kind":"Count","attribute":"CcEvent.Id"}]},{"assign":{"N":"GetRaw4.List.Length"}}]}]}}
            """;
        var created = Assert.Single(Refused(dir, "cc-empty-create", $$$"""
            {"base":"{{{Fixture}}}","ops":[{{{Spec}}},{{{Grouped}}},
             {"op":"create","parent":"IAggregateNode:GetRaw4","type":"IAggregateAttribute","name":"Empty","as":"$a"},{"op":"set","target":"$a","prop":"AggregationType","value":"Sum"}]}
            """), p => p!["code"]!.ToString() == AggregateSortRule.ColumnCode)!;
        Assert.Contains("reads no attribute", created["message"]!.ToString());
        var clearJob = JsonNode.Parse($$$"""{"base":"{{{Fixture}}}","ops":[{{{Spec}}},{{{Grouped}}},{"op":"set","target":"IAggregateNode:GetRaw4/IAggregateAttribute:T","prop":"Attribute","value":""}]}""")!.AsObject();
        var cleared = Assert.Single(Refused(dir, "cc-empty-set", clearJob.ToJsonString()), p => p!["code"]!.ToString() == AggregateSortRule.ColumnCode)!;
        Assert.Equal("/ops/2/value", cleared["pointer"]!.ToString());
        Assert.Equal("""[{"op":"replace","path":"/ops/2/value","value":"CcEvent.Id"}]""", cleared["patch"]!.ToJsonString());
        var fixedSet = Run(dir, "cc-empty-set-patched", Patched(clearJob, cleared["patch"]!.AsArray()).ToJsonString());
        Assert.True(fixedSet["accepted"]!.GetValue<bool>(), fixedSet["policyMessages"]?.ToJsonString() + fixedSet["details"]);
        // A base an older release wrote with such a column: refused as preexisting, with the raw op that fixes it.
        var basePath = Path.Combine(dir, "legacy-empty.oml");
        CompileCheck.WriteUnchecked(new ModelHost(Path.Combine(dir, "write")), File.ReadAllBytes(Path.Combine(PacoteBPolicyTests.FindRoot(), "tests", "fixtures", Fixture)), JsonNode.Parse($$$"""
            [{{{Spec}}},{{{Grouped}}},{"op":"create","parent":"IAggregateNode:GetRaw4","type":"IAggregateAttribute","name":"Rows","as":"$a"},{"op":"set","target":"$a","prop":"AggregationType","value":"Count"}]
            """)!.AsArray(), basePath);
        var ping = JsonNode.Parse("""{"ops":[{"op":"logic","data":{"actions":[{"name":"Ping","outputs":[{"name":"N","type":"Integer"}],"steps":[{"assign":{"N":"1"}}]}]}}]}""")!.AsObject();
        var old = Assert.Single(Refused(dir, "cc-empty-legacy", ping.ToJsonString(), basePath), p => p!["preexisting"]?.GetValue<bool>() == true)!;
        Assert.Equal(AggregateSortRule.ColumnCode, old["code"]!.ToString());
        Assert.Contains("\"value\":\"CcEvent.Id\"", old["ops"]!.ToJsonString());
        var repaired = Run(dir, "cc-empty-legacy-fixed", Patched(ping, old["patch"]!.AsArray()).ToJsonString(), basePath);
        Assert.True(repaired["accepted"]!.GetValue<bool>(), repaired["policyMessages"]?.ToJsonString() + repaired["details"]);
    }

    [Fact]
    public void AJoinNamesTwoSourcesOfItsOwnAggregate()
    {
        // Re-check (medium): a raw join over a source of another aggregate (by path, or by a Type:Name only another aggregate
        // has) was "entregue" on O11; the ODC Model API refuses that write.
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        const string Two = """
            {"op":"logic","data":{"actions":[{"name":"CcJa","outputs":[{"name":"N","type":"Integer"}],"steps":[
              {"get":"CcEvent","as":"GetJa","sources":["CcTag"],"joins":[{"left":"CcEvent","right":"CcTag","kind":"Only With","condition":"CcTag.EventId = CcEvent.Id"}],"max":10},{"assign":{"N":"GetJa.List.Length"}}]},
             {"name":"CcJb","outputs":[{"name":"N","type":"Integer"}],"steps":[{"get":"CcUser","as":"GetJb","max":10},{"assign":{"N":"GetJb.List.Length"}}]}]}}
            """;
        const string Users = """{"op":"spec","data":{"entities":[{"name":"CcUser","attributes":[{"name":"Name","type":"Text","length":50}]}]}}""";
        string Join(string left, string right, string parent = "IAggregateNode:GetJa") => $$$"""
            {"op":"create","parent":"{{{parent}}}","type":"IJoin","as":"$j"},
            {"op":"set","target":"$j","prop":"LeftSource","value":"{{{left}}}"},
            {"op":"set","target":"$j","prop":"RightSource","value":"{{{right}}}"},
            {"op":"set","target":"$j","prop":"JoinType","value":"Left"},
            {"op":"set","target":"$j","prop":"Condition","value":"True"}
            """;
        foreach (var (name, left) in new[] { ("cc-join-foreign", "IAggregateNode:GetJb/IAliasedSource:CcUser"), ("cc-join-typename", "IAliasedSource:CcUser") })
        {
            var problem = Assert.Single(Refused(dir, name, $$$"""{"base":"{{{Fixture}}}","ops":[{{{Spec}}},{{{Users}}},{{{Two}}},{{{Join(left, "IAggregateNode:GetJa/IAliasedSource:CcTag")}}}]}"""),
                p => p!["code"]!.ToString() == AggregateSortRule.JoinCode)!;
            Assert.Equal("/ops/4/value", problem["pointer"]!.ToString());
            Assert.Contains("not a source of this aggregate (it is a source of the aggregate GetJb)", problem["message"]!.ToString());
            Assert.Contains("add it to the FROM of GetJa", problem["fix"]!.ToString());
            Assert.Null(problem["patch"]);
        }
        // The same source on both sides: refused.
        Assert.Contains(Refused(dir, "cc-join-self", $$$"""{"base":"{{{Fixture}}}","ops":[{{{Spec}}},{{{Users}}},{{{Two}}},{{{Join("IAggregateNode:GetJa/IAliasedSource:CcTag", "IAggregateNode:GetJa/IAliasedSource:CcTag")}}}]}"""),
            p => p!["code"]!.ToString() == AggregateSortRule.JoinCode && p["message"]!.ToString().Contains("with itself", StringComparison.Ordinal));
        // A join between two sources of its own: delivered.
        const string Own = """
            {"op":"logic","data":{"actions":[{"name":"CcJc","outputs":[{"name":"N","type":"Integer"}],"steps":[
              {"get":"CcEvent","as":"GetJc","sources":["CcTag","CcUser"],"joins":[{"left":"CcEvent","right":"CcTag","kind":"Only With","condition":"CcTag.EventId = CcEvent.Id"}],"max":10},{"assign":{"N":"GetJc.List.Length"}}]}]}}
            """;
        var result = Run(dir, "cc-join-own", $$$"""{"base":"{{{Fixture}}}","ops":[{{{Spec}}},{{{Users}}},{{{Own}}},{{{Join("IAggregateNode:GetJc/IAliasedSource:CcEvent", "IAggregateNode:GetJc/IAliasedSource:CcUser", "IAggregateNode:GetJc")}}}]}""");
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
    }

    [Fact]
    public void ASoapClientTheJobsVerbsCreateIsRefusedWithTheExactImportCall()
    {
        // Review (alta): the job of 2026-10-09 (create ISOAPClient + DefaultUri + ISOAPAction) was delivered with a HIGH warning,
        // and the same candidate had failed twice in the compiler ("error in XML document (0, 0)").
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var problems = Refused(dir, "cc-soap", $$$"""
            {"base":"{{{Fixture}}}","ops":[
             {"op":"create","parent":"@espace","type":"ISOAPClient","name":"SSAMSoapProof","as":"$soap"},
             {"op":"set","target":"$soap","prop":"DefaultUri","value":"https://ssam-proof.invalid/Proof.asmx"},
             {"op":"create","parent":"$soap","type":"ISOAPAction","name":"Ping","as":"$ping"}]}
            """);
        var problem = Assert.Single(problems, p => p!["code"]!.ToString() == CompileCheck.SoapDefinition)!;
        Assert.Equal(0, problem["op"]!.GetValue<int>());
        Assert.Contains("o11_deliver", problem["fix"]!.ToString());
        var import = problem["suggestion"]!.AsObject();
        Assert.Equal("soap", import["op"]!.ToString());
        Assert.Equal(("https://ssam-proof.invalid/Proof.asmx?WSDL", "SSAMSoapProof", "[\"Ping\"]"),
            (import["data"]!["wsdl"]!.ToString(), import["data"]!["client"]!.ToString(), import["data"]!["methods"]!.ToJsonString()));
        // A WSDL written by verbs, even a real one, is no import: refused too.
        var wsdl = JsonSerializer.Serialize(File.ReadAllText(Path.Combine(PacoteBPolicyTests.FindRoot(), "tests", "fixtures", "wsdl", "calculator-two-ports.wsdl")));
        foreach (var value in new[] { "\"<a/>\"", wsdl })
            Assert.Contains(Refused(dir, "cc-soap-wsdl", $$$"""{"base":"{{{Fixture}}}","ops":[{"op":"create","parent":"@espace","type":"ISOAPClient","name":"Calculator","as":"$c"},{"op":"set","target":"$c","prop":"WSDL","value":{{{value}}}}]}"""),
                p => p!["code"]!.ToString() == CompileCheck.SoapDefinition);
        // The lab escape: accepted with a HIGH warning (the delivery refuses it); a short why is no escape.
        var lab = Run(dir, "cc-soap-lab", $$$"""{"base":"{{{Fixture}}}","expectValid":false,"ops":[{"op":"create","parent":"@espace","type":"ISOAPClient","name":"CcLab","as":"$c","{{{CompileCheck.SoapAllowKey}}}":{"why":"coverage lab: measures the SOAP verbs, never delivered"}}]}""");
        var warning = Assert.Single(lab["highWarnings"]!.AsArray(), w => w!["code"]!.ToString() == CompileCheck.SoapAllowed)!;
        Assert.Contains("never delivered", warning["message"]!.ToString());
        Assert.Contains(Refused(dir, "cc-soap-short", $$$"""{"base":"{{{Fixture}}}","expectValid":false,"ops":[{"op":"create","parent":"@espace","type":"ISOAPClient","name":"CcLab","as":"$c","{{{CompileCheck.SoapAllowKey}}}":{"why":"lab"}}]}"""),
            p => p!["code"]!.ToString() == CompileCheck.SoapDefinition && p["message"]!.ToString().Contains("at least 15", StringComparison.Ordinal));
    }

    [Fact]
    public void AWsdlARawSetWritesOnAnImportedClientIsRefused()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var basePath = Path.Combine(dir, "with-client.oml");
        CompileCheck.WriteUnchecked(new ModelHost(Path.Combine(dir, "write")), File.ReadAllBytes(Path.Combine(PacoteBPolicyTests.FindRoot(), "tests", "fixtures", Fixture)),
            JsonNode.Parse("""[{"op":"create","parent":"@espace","type":"ISOAPClient","name":"Imported","as":"$c"}]""")!.AsArray(), basePath);
        var problems = Refused(dir, "cc-soap-set", """{"ops":[{"op":"set","target":"ISOAPClient:Imported","prop":"WSDL","value":"<definitions/>"}]}""", basePath);
        var problem = Assert.Single(problems, p => p!["code"]!.ToString() == CompileCheck.SoapDefinition)!;
        Assert.Contains("raw set", problem["message"]!.ToString());
        Assert.Equal("refresh", problem["suggestion"]!["data"]!.AsObject().Select(p => p.Key).Last());
    }

    [Fact]
    public void ABaseThatDoesNotCompileRefusesEveryDeliveryOnTopOfIt()
    {
        // Review (média): a new action on a base with the session's bad sorts was "entregue" in silence; the publish of 15:50
        // failed on two If sorts that job did not touch. The old part is refused, marked preexisting, with its fix.
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var basePath = Path.Combine(dir, "legacy.oml");
        CompileCheck.WriteUnchecked(new ModelHost(Path.Combine(dir, "write")), File.ReadAllBytes(Path.Combine(PacoteBPolicyTests.FindRoot(), "tests", "fixtures", Fixture)), JsonNode.Parse($$$"""
            [{{{Spec}}},
             {"op":"logic","data":{"actions":[{"name":"Legacy","inputs":[{"name":"Mode","type":"Text"}],"outputs":[{"name":"N","type":"Integer"}],"steps":[
               {"get":"CcEvent","as":"GetLegacy","sort":"If(Mode = \"a\", CcEvent.Score, 0)","max":10},{"assign":{"N":"GetLegacy.List.Length"}}]}]}},
             {"op":"logic","data":{"actions":[{"name":"LegacyJoin","outputs":[{"name":"N","type":"Integer"}],"steps":[
               {"get":"CcEvent","as":"GetLegacyJoin","sources":["CcTag"],"joins":[{"left":"CcEvent","right":"CcTag","kind":"None","condition":"CcTag.EventId = CcEvent.Id"}],"max":10},{"assign":{"N":"GetLegacyJoin.List.Length"}}]}]}}]
            """)!.AsArray(), basePath);
        Assert.Equal(1, CompileCheck.Module(new ModelHost(Path.Combine(dir, "read")), File.ReadAllBytes(basePath), "legacy")["byCode"]![AggregateSortRule.Code]!.GetValue<int>());
        // An action that touches nothing of them.
        var problems = Refused(dir, "cc-on-legacy", """{"ops":[{"op":"logic","data":{"actions":[{"name":"Ping","outputs":[{"name":"N","type":"Integer"}],"steps":[{"assign":{"N":"1"}}]}]}}]}""", basePath);
        var old = problems.Where(p => p!["preexisting"]?.GetValue<bool>() == true).ToList();
        Assert.Contains(old, p => p!["code"]!.ToString() == AggregateSortRule.Code && p["message"]!.ToString().Contains("If(Mode = \"a\", CcEvent.Score, 0)", StringComparison.Ordinal));
        Assert.Contains(old, p => p!["code"]!.ToString() == AggregateSortRule.JoinCode);
        Assert.All(old, p => Assert.Contains("already has it", p!["message"]!.ToString()));
        // A job that only reads is not judged.
        var read = Run(dir, "cc-read-legacy", """{"ops":[{"op":"find","name":"Legacy"}]}""", basePath);
        Assert.True(read["accepted"]!.GetValue<bool>(), read["policyMessages"]?.ToJsonString());
    }

    [Fact]
    public void ThePreexistingSortsOfTheSessionCaptureAreRefusedWithTheOpsThatFixThem()
    {
        if (!PacoteBPolicyTests.StudioAvailable() || !File.Exists(SessionCapture)) return;
        var dir = Scratch();
        var job = JsonNode.Parse("""{"ops":[{"op":"logic","data":{"actions":[{"name":"PingProbe","outputs":[{"name":"N","type":"Integer"}],"steps":[{"assign":{"N":"1"}}]}]}}]}""")!.AsObject();
        var problems = Refused(dir, "session-b01", job.ToJsonString(), SessionCapture);
        var old = problems.Where(p => p!["preexisting"]?.GetValue<bool>() == true && p["code"]!.ToString() == AggregateSortRule.Code).ToList();
        Assert.Equal(3, old.Count);
        // GetVisitHistory and GetPlaces: certain (the attribute and its direction); GetAgenda: the fix only.
        var patched = old.Where(p => p!["patch"] is JsonArray).ToList();
        Assert.Equal(2, patched.Count);
        Assert.Contains(patched, p => p!["ops"]!.ToJsonString().Contains("\"VisitEvent.Id\"", StringComparison.Ordinal));
        // The two patches and a hand fix of GetAgenda's sort (deleted): delivered.
        foreach (var p in patched) Patched(job, p!["patch"]!.AsArray());
        var agenda = old.Single(p => p!["patch"] is not JsonArray)!;
        job["ops"]!.AsArray().Add(new JsonObject { ["op"] = "delete", ["target"] = "@" + agenda["key"]!.ToString() });
        var result = Run(dir, "session-b01-fixed", job.ToJsonString(), SessionCapture);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        Assert.Equal(0, CompileCheck.Module(new ModelHost(Path.Combine(dir, "read")), File.ReadAllBytes(Path.Combine(dir, "session-b01-fixed.oml")), "fixed")["findings"]!.GetValue<int>());
    }

    [Fact]
    public void AReferenceToAnElementOfAnotherModuleIsFound()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var findings = CompileCheck.ForeignReferenceProbe(new ModelHost(Path.Combine(dir, "work")), File.ReadAllBytes(Path.Combine(PacoteBPolicyTests.FindRoot(), "tests", "fixtures", Fixture)));
        File.WriteAllText(Path.Combine(dir, "probe.json"), findings?.ToJsonString() ?? "the model refused the write");
        if (findings == null) return;   // the model keeps the producer's action out of the consumer: nothing to find
        var finding = Assert.Single(findings)!;
        Assert.Equal(CompileCheck.ReferenceOutside, finding["code"]!.ToString());
        Assert.Contains("Foreign", finding["message"]!.ToString());
        Assert.Contains("reference", finding["fix"]!.ToString());
    }

    // ---- the prototype importer ----------------------------------------------------------------------------------------------

    [Fact]
    public void ThePrototypeImporterAggregatesAComputedValueThroughACalculatedColumn()
    {
        // Review (alta): the importer wrote Sum(A.Qty * B.Price) in the aggregated column itself.
        var capture = File.ReadAllText(PrototypeFakes.FarmaVirtual);
        const string Plain = "\"from\":{\"sum\":{\"collection\":\"CarrinhoItem\",\"field\":\"Quantidade\"";
        Assert.Contains(Plain, capture);
        var dir = Scratch();
        var path = Path.Combine(dir, "farmavirtual.capture.json");
        // The capture reads its bundle next to it (2 small files).
        var bundle = Path.Combine(Path.GetDirectoryName(PrototypeFakes.FarmaVirtual)!, "farmavirtual.bundle");
        foreach (var file in Directory.GetFiles(bundle, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(dir, "farmavirtual.bundle", Path.GetRelativePath(bundle, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target);
        }
        File.WriteAllText(path, capture.Replace(Plain, "\"from\":{\"sum\":{\"collection\":\"CarrinhoItem\",\"field\":{\"mul\":[{\"field\":\"Quantidade\"},{\"field\":\"Quantidade\"}]}", StringComparison.Ordinal));
        var ops = PrototypeFakes.Ops(PrototypeFakes.Plan(path).Plan).ToList();
        // One per screen (each screen sums the cart for the shell).
        var calcs = ops.Where(o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == "ICalculatedAttribute" && o["name"]?.ToString() == "CarrinhoQuantidadeRow").ToList();
        Assert.NotEmpty(calcs);
        Assert.All(calcs, calc => Assert.Contains(ops, o => o["op"]?.ToString() == "set" && o["target"]?.ToString() == calc["as"]!.ToString() && o["prop"]?.ToString() == "Value" && o["value"]!.ToString().Contains(" * ", StringComparison.Ordinal)));
        Assert.Contains(ops, o => o["op"]?.ToString() == "set" && o["prop"]?.ToString() == "Attribute" && o["value"]?.ToString() == "CarrinhoQuantidadeRow");
        Assert.DoesNotContain(ops, o => o["op"]?.ToString() == "set" && o["prop"]?.ToString() == "Attribute" && o["value"]!.ToString().Contains(" * ", StringComparison.Ordinal));
        // The server logic of the capture as it is (the order total: Sum of Quantidade * Preco over the cart): a calculated column.
        var (plan, _) = PrototypeFakes.Plan(PrototypeFakes.FarmaVirtual);
        var sums = PrototypeFakes.Actions(plan).SelectMany(a => PrototypeFakes.Steps(a["steps"])).Where(s => s["columns"] is JsonArray c && c.OfType<JsonObject>().Any(k => k["kind"]?.ToString() == "Sum")).ToList();
        Assert.NotEmpty(sums);
        Assert.All(sums.SelectMany(s => s["columns"]!.AsArray().OfType<JsonObject>()), c => Assert.NotNull(AggregateSortRule.Plain(c["attribute"]!.ToString())));
        Assert.Contains(sums, s => s["calculated"] is JsonArray calc && calc.OfType<JsonObject>().Any(k => k["name"]!.ToString() == "TotalRow" && k["value"]!.ToString().Contains(" * ", StringComparison.Ordinal)));
    }

    // ---- zero false positives on what the Studio made; the session's capture -----------------------------------------------

    [Theory]
    [InlineData("blank-service.oml")]
    [InlineData("reactive-ui.oml")]
    [InlineData("mobile-ui.oml")]
    [InlineData("traditional-ui.oml")]
    public void TheCheckFindsNothingInAModuleTheStudioMade(string fixture)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var path = Path.Combine(PacoteBPolicyTests.FindRoot(), "tests", "fixtures", fixture);
        if (!File.Exists(path)) return;
        var report = CompileCheck.Module(new ModelHost(Path.Combine(Scratch(), "work")), File.ReadAllBytes(path), fixture);
        Assert.True(report["findings"]!.GetValue<int>() == 0, report.ToJsonString());
        Assert.Equal(report["read"]!["aggregates"]!.GetValue<int>(), report["walk"]!["aggregates"]!.GetValue<int>());
    }

    [Fact]
    public void TheCheckFindsTheThreeBadSortsOfTheSessionCapture()
    {
        if (!PacoteBPolicyTests.StudioAvailable() || !File.Exists(SessionCapture)) return;
        var report = CompileCheck.Module(new ModelHost(Path.Combine(Scratch(), "work")), File.ReadAllBytes(SessionCapture), "session");
        Assert.Equal(3, report["findings"]!.GetValue<int>());
        Assert.Equal(3, report["byCode"]![AggregateSortRule.Code]!.GetValue<int>());
        Assert.Equal(3, report["walk"]!["preexisting"]!.GetValue<int>());
        var texts = report["list"]!.AsArray().Select(f => f!["message"]!.ToString()).ToList();
        Assert.Contains(texts, t => t.Contains("-IdentifierToLongInteger(VisitEvent.Id)", StringComparison.Ordinal));
        Assert.Contains(report["list"]!.AsArray(), f => f!["fix"]!.ToString().StartsWith("write the attribute VisitEvent.Id with SortDirection Descending", StringComparison.Ordinal));
    }
}
