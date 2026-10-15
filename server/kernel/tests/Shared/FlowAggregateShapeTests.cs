using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// One battery, linked to both lanes. It never replaces an expected corpus floor or modifies its captures.
public sealed class FlowAggregateShapeTests(ITestOutputHelper output)
{
    private static readonly Type Shape = typeof(ModuleFlow).Assembly.GetType("Anvil.Reading.FlowAggregateShape")!;
    private static readonly Type Syntax = typeof(ModuleFlow).Assembly.GetType("Anvil.Reading.FlowSyntax")!;
    private static (string? Text, string Why) Canonical(string text) =>
        ((string?, string))Shape.GetMethod("Canonical", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, [text])!;
    private static int Scan(string text, int from, string[] ends) =>
        (int)Syntax.GetMethod("Scan")!.Invoke(null, [text, from, ends])!;
    private static string Expression(string text) => (string)Syntax.GetMethod("Expr")!.Invoke(null,
        [text, new[] { " JOIN ", " WHERE ", " GROUP BY ", " AGG ", " CALC ", " SORT ", " MAX ", " START ", "  # ", " | " }])!;
    private static string Action(string line) => "server action Shape @action\n  " + line.Trim() + "\n  end @finish\n";

    [Theory]
    [InlineData("JOIN", "Inner")]
    [InlineData("iNnEr JoIn", "Inner")]
    [InlineData("LEFT JOIN", "Left")]
    [InlineData("left outer join", "Left")]
    [InlineData("RIGHT JOIN", "Right")]
    [InlineData("Right Outer Join", "Right")]
    [InlineData("FULL JOIN", "Full")]
    [InlineData("full outer join", "Full")]
    public void SqlJoinKindsHaveOneCanonicalMap(string sql, string kind)
    {
        var line = "G = aggregate FROM A " + sql + " B ON (A.Id = B.AId)";
        var expected = "G = aggregate FROM A, B JOIN " + kind + " A~B ON (A.Id = B.AId)";
        Assert.Equal(expected, Canonical(line).Text);
        Assert.Equal(expected, Canonical(expected).Text);
        var error = Assert.ThrowsAny<FormatException>(() => ModuleFlow.Read(Action(line)));
        Assert.Contains(expected[4..], error.Message);
        var normalized = FlowTextNormalizer.Normalize(Action(line));
        Assert.Contains(normalized.Edits, e => e.Rule == "FLOW_AGGREGATE_SQL_SHAPE");
        Assert.Equal(ModuleFlow.Read(Action(expected)).Canon(), ModuleFlow.Read(normalized.Text).Canon());
    }

    [Theory]
    [InlineData("B b", "b=B")]
    [InlineData("B AS b", "b=B")]
    [InlineData("b=B", "b=B")]
    public void AliasesAndLiteralsArePreserved(string source, string canonicalSource)
    {
        const string condition = "(A.Id = b.AId and b.Text = \" LEFT JOIN Ghost ON A.X \" and b.Value = If(True, 1, 2))";
        var line = "aggregate FROM A LEFT JOIN " + source + " ON " + condition;
        Assert.Equal("aggregate FROM A, " + canonicalSource + " JOIN Left A~b ON " + condition, Canonical(line).Text);
    }

    [Fact]
    public void MixedCaseHeadAndClausesNormalizeThroughTheParser()
    {
        const string line = "G = AgGrEgAtE fRoM A lEfT jOiN B oN (A.Id = B.AId) sOrT A.Id mAx 10 sTaRt 2";
        const string expected = "G = aggregate FROM A, B JOIN Left A~B ON (A.Id = B.AId) SORT A.Id MAX 10 START 2";
        Assert.Equal(expected, Canonical(line).Text);
        Assert.Equal(ModuleFlow.Read(Action(expected)).Canon(), ModuleFlow.Read(FlowTextNormalizer.Normalize(Action(line)).Text).Canon());
    }

    [Fact]
    public void EncodedJoinExpressionsStillIdentifyTheEarlierSource()
    {
        const string line = "aggregate FROM A, B LEFT JOIN C ON `A.Id = C.Id\\nAnd C.Active`";
        Assert.Equal("aggregate FROM A, B, C JOIN Left A~C ON `A.Id = C.Id\\nAnd C.Active`", Canonical(line).Text);
        _ = ModuleFlow.Read(FlowTextNormalizer.Normalize(Action(line)).Text);
    }
    [Fact]
    public void ClausesCombineAndReorderWithoutRewritingExpressions()
    {
        const string line = "aggregate FROM A CALC X=If(A.Id > 0, 1, 2) SORT A.Id AGG N=Count(A.Id) CALC Y=A.Id + 1 GROUP BY A.Id WHERE (A.Id > 0) SORT A.Name WHERE (A.Name <> \" SORT bogus\") GROUP BY A.Name AGG Total=Sum(A.Id) START 2 MAX 10  # Summary";
        const string expected = "aggregate FROM A WHERE (A.Id > 0) AND (A.Name <> \" SORT bogus\") GROUP BY A.Id, A.Name AGG N=Count(A.Id), Total=Sum(A.Id) CALC X=If(A.Id > 0, 1, 2), Y=A.Id + 1 SORT A.Id, A.Name MAX 10 START 2  # Summary";
        Assert.Equal(expected, Canonical(line).Text);
        Assert.Equal(expected, Canonical(expected).Text);
        Assert.Equal(ModuleFlow.Read(Action(expected)).Canon(), ModuleFlow.Read(FlowTextNormalizer.Normalize(Action(line)).Text).Canon());
    }

    [Theory]
    [InlineData("Check #1")]
    [InlineData("Review SORT MAX LEFT JOIN #2")]
    public void LabelsWithHashAndClauseWordsRemainLiteral(string label)
    {
        var line = "aggregate FROM A WHERE (A.Id = 1)  # " + label;
        Assert.Equal(line, Canonical(line).Text);
        Assert.Equal(Action(line), FlowTextNormalizer.Normalize(Action(line)).Text);
        var sql = "aggregate FROM A LEFT JOIN B ON (A.Id = B.Id)  # " + label + " @node";
        Assert.Equal("aggregate FROM A, B JOIN Left A~B ON (A.Id = B.Id)  # " + label + " @node", Canonical(sql).Text);
    }
    [Fact]
    public void AWholeWhereExpressionIsWrappedWithoutChangingItsBooleanMeaning()
    {
        const string source = "aggregate FROM A WHERE (A.Id = 1) OR (A.Id = 2)";
        const string expected = "aggregate FROM A WHERE ((A.Id = 1) OR (A.Id = 2))";
        Assert.Equal(expected, Canonical(source).Text);
        Assert.Equal(expected, Canonical(expected).Text);
        _ = ModuleFlow.Read(Action(expected));
    }
    [Fact]
    public void ReferencesOutsideLiteralsChooseTheOnlyEarlierSource()
    {
        const string line = "aggregate FROM A, B LEFT JOIN C ON (C.Id = A.Id and C.Text = \"B.Id\")";
        Assert.Contains("JOIN Left A~C ON (C.Id = A.Id and C.Text = \"B.Id\")", Canonical(line).Text!);
        Assert.Equal("aggregate FROM A, B JOIN Inner A~B ON True", Canonical("aggregate FROM A JOIN B ON True").Text);
    }

    [Theory]
    [InlineData("aggregate FROM A, B JOIN C ON (A.Id = C.Id and B.Id = C.Id)", "A~C", "B~C")]
    [InlineData("aggregate FROM A, B JOIN C ON True", "A~C", "B~C")]
    [InlineData("aggregate FROM A MAX 1 MAX 2", "1", "2")]
    [InlineData("aggregate FROM A START 0 START 1", "0", "1")]
    public void AmbiguityNamesBothReadingsAndNeverNormalizes(string line, string first, string second)
    {
        var shape = Canonical(line);
        Assert.Null(shape.Text);
        Assert.Contains(first, shape.Why);
        Assert.Contains(second, shape.Why);
        var error = Assert.ThrowsAny<FormatException>(() => ModuleFlow.Read(Action(line)));
        Assert.Contains(first, error.Message);
        Assert.Contains(second, error.Message);
        Assert.Equal(Action(line), FlowTextNormalizer.Normalize(Action(line)).Text);
    }

    [Fact]
    public void AllSixteenGateAggregateLinesNormalizeAndParse()
    {
        var root = TextRoundTripCorpus.Root()!;
        var file = Path.Combine(root, "cx3", "inputs", "gate-refused-joins.json");
        if (!File.Exists(file)) { output.WriteLine("WARNING: gate-refused-joins.json is absent; gate acceptance was not checked."); return; }
        var flows = JsonNode.Parse(File.ReadAllText(file))!["ops"]![7]!["data"]!["flow"]!.AsArray();
        var lines = flows.SelectMany(f => f!.GetValue<string>().Split('\n'))
            .Where(l => l.Contains("= aggregate FROM ", StringComparison.Ordinal)).ToList();
        Assert.Equal(16, lines.Count);
        foreach (var line in lines) {
            var shape = Canonical(line);
            Assert.True(shape.Text != null, shape.Why + "\n" + line);
            var normalized = FlowTextNormalizer.Normalize(Action(line));
            _ = ModuleFlow.Read(normalized.Text);
            Assert.Equal(shape.Text, Canonical(shape.Text!).Text);
        }
        output.WriteLine("Gate aggregate lines: 16 normalized, 16 parsed, 0 aggregate syntax errors.");
    }

    [Fact]
    public void EveryCorpusJoinRewrittenAsSqlPreservesItsCanonicalModel()
    {
        var root = TextRoundTripCorpus.Root()!;
        var assembly = typeof(ModelHost).Assembly;
        var odc = assembly.GetType("Anvil.Core.StudioAssembliesOdc");
        var lane = odc == null ? "o11" : "odc";
        var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "kernel", "tests", "fixtures", "text-roundtrip", "corpus.json")))!.AsArray();
        var modules = manifest.Where(m => m!["lane"]!.GetValue<string>() == lane).ToList();
        var missing = modules.Where(m => !File.Exists(m!["oml"]!.GetValue<string>())).ToList();
        Assert.True(missing.Count == 0, "WARNING: the corpus of the plan is not on this machine: " + string.Join(", ", missing.Select(m => m!["oml"])));
        var binder = odc ?? assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var bind = binder.GetMethod("Bind")!;
        bind.Invoke(null, bind.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
        var work = Path.Combine(root, "cx3", "join-corpus-" + lane);
        Directory.CreateDirectory(work);
        var count = 0; var exact = 0; var ambiguous = new List<string>();
        var actions = 0; var nodes = 0; var aggregates = 0; var nativeJoins = 0; var opaqueAggregates = 0;
        var opaqueReasons = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var module in modules) {
            var bytes = File.ReadAllBytes(module!["oml"]!.GetValue<string>());
            var sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            Assert.Equal(module["sha"]!.GetValue<string>(), sha);
            var flow = Build(bytes, sha, lane, work, item => {
                foreach (var node in item.Items.Where(n => n.Role == "node")) {
                    if (node.Kind != "AggregateNode") continue;
                    aggregates++;
                    nativeJoins += node.Items.Count(p => p.Role == "join");
                    if (node.Opaque) {
                        opaqueAggregates++;
                        foreach (var reason in node.OpaqueReasons ?? []) opaqueReasons.Add(reason);
                    }
                }
            });
            actions += flow.Actions.Count;
            nodes += flow.Actions.Sum(a => a.Nodes);
            output.WriteLine(module["label"] + ": " + flow.Actions.Count + " actions, " + flow.Actions.Sum(a => a.Nodes) + " nodes");
            foreach (var action in flow.Actions)
                foreach (var line in action.Text.Split('\n').Where(l => l.Contains("aggregate FROM ", StringComparison.Ordinal) && l.Contains(" JOIN ", StringComparison.Ordinal))) {
                    count++;
                    Assert.Equal(line, Canonical(line).Text);
                    var sql = ToSql(line);
                    var shape = Canonical(sql);
                    if (shape.Text == null) {
                        Assert.Contains("ambiguous", shape.Why);
                        Assert.ThrowsAny<FormatException>(() => ModuleFlow.Read(Action(sql)));
                        Assert.Equal(Action(sql), FlowTextNormalizer.Normalize(Action(sql)).Text);
                        ambiguous.Add(module["label"] + "/" + action.Name + ": " + shape.Why);
                        continue;
                    }
                    var normalized = FlowTextNormalizer.Normalize(Action(sql));
                    Assert.Equal(ModuleFlow.Read(Action(line)).Canon(), ModuleFlow.Read(normalized.Text).Canon());
                    Assert.Equal(shape.Text, Canonical(shape.Text).Text);
                    exact++;
                }
        }
        var expected = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "kernel", "tests", "fixtures", "text-roundtrip", "logic-expected.json")))!["lanes"]![lane]!;
        Assert.Equal(expected["actions"]!.GetValue<int>(), actions);
        Assert.Equal(expected["nodes"]!.GetValue<int>(), nodes);
        Assert.Equal(expected["nodeKinds"]!["AggregateNode"]!.GetValue<int>(), aggregates);
        output.WriteLine("Read coverage: " + modules.Count + " modules, " + actions + " actions, " + nodes + " nodes, " + aggregates
            + " aggregates, " + nativeJoins + " extracted joins, " + opaqueAggregates + " opaque aggregates.");
        foreach (var reason in opaqueReasons) output.WriteLine("Opaque aggregate: " + reason);
        output.WriteLine("JOIN corpus " + lane + ": " + count + " aggregates; " + exact + " SQL rewrites with identical Canon(); "
            + ambiguous.Count + " ambiguous and refused; 0 incorrect normalizations.");
        foreach (var refusal in ambiguous) output.WriteLine(refusal);
        File.WriteAllText(Path.Combine(work, "summary.txt"), "modules=" + modules.Count + "\nactions=" + actions + "\nnodes=" + nodes + "\nallAggregates=" + aggregates + "\nopaqueAggregates=" + opaqueAggregates + "\nnativeJoins=" + nativeJoins + "\naggregates=" + count + "\nexact=" + exact + "\nambiguous=" + ambiguous.Count
            + "\nincorrect=0\n" + string.Join("\n", ambiguous));
        if (count == 0) output.WriteLine("WARNING: this lane's corpus has no printable JOIN aggregate; SQL JOIN normalization is covered by the shared unit battery, not by native corpus JOINs.");
        Assert.Equal(nativeJoins == 0, count == 0);
        Assert.Equal(count, exact + ambiguous.Count);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static ModuleFlow Build(byte[] bytes, string sha, string lane, string work, Action<FlowItem> visit) => new ModelHost(work).BuildFlow(bytes, sha, lane, visit);

    private static string ToSql(string line)
    {
        var node = ModuleFlow.Read(Action(line)).Items.Single(n => n.Kind == "AggregateNode");
        var sources = node.Items.Where(n => n.Role == "source").ToDictionary(n => n.Name, StringComparer.Ordinal);
        var joins = node.Items.Where(n => n.Role == "join").ToList();
        var from = line.IndexOf("aggregate FROM ", StringComparison.Ordinal) + "aggregate FROM ".Length;
        var tail = Scan(line, from, [" WHERE ", " GROUP BY ", " AGG ", " CALC ", " SORT ", " MAX ", " START ", "  # "]);
        // A trailing id belongs to the node, not to its last join condition.
        if (tail == line.Length) {
            var id = Regex.Match(line, @" @[^ ]+$");
            if (id.Success) tail = id.Index;
        }
        string SourceText(string name) => sources[name].Prop("Source") == name ? name : sources[name].Prop("Source") + " AS " + name;
        var declared = sources.Keys.Where(s => !joins.Any(j => j.Prop("RightSource") == s)).ToHashSet(StringComparer.Ordinal);
        if (declared.Count == 0) declared.Add(joins[0].Prop("LeftSource")!);
        var text = line[..from] + string.Join(", ", declared.Select(SourceText));
        while (joins.Count > 0) {
            var join = joins.FirstOrDefault(j => declared.Contains(j.Prop("LeftSource")!) && !declared.Contains(j.Prop("RightSource")!));
            Assert.True(join != null, "JOIN graph cannot be introduced as SQL without duplicating an alias: " + line);
            joins.Remove(join!);
            var right = join!.Prop("RightSource")!;
            Assert.NotEqual("None", join.Prop("JoinType"));
            text += " " + join.Prop("JoinType")!.ToUpperInvariant() + " JOIN " + SourceText(right) + " ON " + Expression(join.Prop("Condition")!);
            declared.Add(right);
        }
        return text + line[tail..];
    }
}