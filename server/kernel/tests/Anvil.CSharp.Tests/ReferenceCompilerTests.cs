using System.Collections;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.Loader;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Xunit;

namespace Anvil.CSharp.Tests;

/// <summary>
/// CLR execution supplies the source oracle only in tests. The other side executes emitted native
/// logic with value-copy boundaries, so CLR aliasing cannot conceal missing arena writebacks.
/// </summary>
public class ReferenceCompilerTests
{
    private const string Source = """
        public sealed record PostingJournal
        {
            public List<string> Entries { get; } = new List<string>();
            public int Total { get; set; }
        }
        public static class JournalRules
        {
            public static int Run(bool fail, int amount)
            {
                var journal = new PostingJournal();
                var alias = journal;
                var entries = journal.Entries;
                Apply(journal, alias, entries, amount, fail);
                return journal.Total * 100 + entries.Count;
            }
            private static void Apply(PostingJournal left, PostingJournal right, List<string> entries, int amount, bool fail)
            {
                left.Total += amount;
                entries.Add("before:" + amount);
                right.Entries.Add("shared");
                Leaf(fail);
                right.Total += 1;
                entries.Add("after");
            }
            private static void Leaf(bool fail)
            {
                if (fail) throw new InvalidOperationException("leaf failed");
            }
            public static bool Same(bool shared)
            {
                var left = new PostingJournal();
                var right = shared ? left : new PostingJournal();
                return SamePair(left, right);
            }
            private static bool SamePair(PostingJournal left, PostingJournal right)
                => object.ReferenceEquals(left, right);
            public static int Fresh()
            {
                var first = new PostingJournal();
                var second = new PostingJournal();
                first.Entries.Add("first");
                return first.Entries.Count * 10 + second.Entries.Count;
            }
            public static int Rebind()
            {
                var first = new PostingJournal();
                var second = new PostingJournal();
                return RebindPair(first, second);
            }
            private static int RebindPair(PostingJournal first, PostingJournal second)
            {
                var receiver = first;
                receiver.Total = Touch(first, receiver = second);
                return first.Total * 100 + first.Entries.Count * 10 + receiver.Entries.Count;
            }
            private static int Touch(PostingJournal first, PostingJournal second)
            {
                first.Total = 40;
                first.Entries.Add("rhs");
                second.Entries.Add("replacement");
                return 9;
            }
            public static int NullRequired()
            {
                PostingJournal journal = null!;
                return Require(journal);
            }
            private static int Require(PostingJournal journal)
            {
                ArgumentNullException.ThrowIfNull(journal);
                return journal.Total;
            }
        }
        """;

    private static readonly Lazy<CompilationResult> Compiled = new(() => Compile(Source));
    private static CompilationResult Compile(string source)
        => CSharpCompiler.Compile(new Dictionary<string, string> { ["ReferenceRules.cs"] = source });

    [Theory]
    [InlineData(false, 7)]
    [InlineData(false, -3)]
    [InlineData(true, 7)]
    public void AliasesAndHelperMutationsMatchClrBeforeNormalAndThrowCompletion(bool fail, int amount)
    {
        var compiled = Compiled.Value;
        using var oracle = new ClrOracle();
        var journal = oracle.NewJournal();
        var entries = oracle.Entries(journal);
        var expectedFailure = Record.Exception(() => oracle.Call("Apply", journal, journal, entries, amount, fail));
        var expected = oracle.Trace(journal);
        var native = RunInternal(compiled, "Run", ("fail", fail), ("amount", amount));
        var actual = Assert.Single(Journals(compiled, native));

        Assert.Equal(expected.Total, actual.Total);
        Assert.Equal(expected.Entries, actual.Entries);
        Assert.Equal(amount + (fail ? 0 : 1), actual.Total);
        Assert.Equal(fail ? new[] { "before:" + amount, "shared" } : new[] { "before:" + amount, "shared", "after" }, actual.Entries);

        if (fail)
        {
            Assert.IsType<InvalidOperationException>(expectedFailure);
            AssertFailure(native, expectedFailure!);
            var boundary = Assert.Throws<ReferenceGraphProbe.Failure>(() => RunBoundary(compiled, "Run", ("fail", fail), ("amount", amount)));
            Assert.Equal(expectedFailure!.GetType().Name, boundary.Kind);
            Assert.Equal(expectedFailure.Message, boundary.Message);
            Assert.Throws<InvalidOperationException>(() => oracle.Call("Run", fail, amount));
        }
        else
        {
            Assert.Null(expectedFailure);
            AssertNormal(native);
            var result = (decimal)(int)oracle.Call("Run", fail, amount)!;
            Assert.Equal(result, native["AvResult"]);
            Assert.Equal(result, RunBoundary(compiled, "Run", ("fail", fail), ("amount", amount))["AvResult"]);
        }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void TwoParametersPreserveAllocationIdentityAcrossAnOrdinaryHelperCall(bool shared)
    {
        var compiled = Compiled.Value;
        using var oracle = new ClrOracle();
        var native = RunInternal(compiled, "Same", ("shared", shared));
        AssertNormal(native);
        Assert.Equal((bool)oracle.Call("Same", shared)!, native["AvResult"]);
        Assert.Equal(shared, native["AvResult"]);
        var journals = Journals(compiled, native);
        Assert.Equal(shared ? 1 : 2, journals.Length);
        Assert.All(journals, journal => { Assert.Equal(0, journal.Total); Assert.Empty(journal.Entries); });
        if (!shared)
        {
            Assert.NotEqual(journals[0].Index, journals[1].Index);
            Assert.NotEqual(journals[0].EntriesIndex, journals[1].EntriesIndex);
        }
    }

    [Fact]
    public void GetOnlyListInitializerAllocatesOncePerObjectAndNeverSharesEqualEmptyLists()
    {
        var compiled = Compiled.Value;
        using var oracle = new ClrOracle();
        var first = oracle.NewJournal();
        var second = oracle.NewJournal();
        Assert.NotSame(oracle.Entries(first), oracle.Entries(second));
        Assert.Same(oracle.Entries(first), oracle.Entries(first));

        var native = RunInternal(compiled, "Fresh");
        AssertNormal(native);
        Assert.Equal((decimal)(int)oracle.Call("Fresh")!, native["AvResult"]);
        var journals = Journals(compiled, native);
        Assert.Equal(2, journals.Length);
        Assert.Equal(new[] { "first" }, journals[0].Entries);
        Assert.Empty(journals[1].Entries);
        Assert.NotEqual(journals[0].EntriesIndex, journals[1].EntriesIndex);
        Assert.Equal(2, Arena(compiled, native, TextListCell(compiled)).Count);
    }

    [Fact]
    public void FieldStoreCapturesReceiverBeforeRhsAndPreservesRhsSiblingMutations()
    {
        var compiled = Compiled.Value;
        using var oracle = new ClrOracle();
        var first = oracle.NewJournal();
        var second = oracle.NewJournal();
        var expected = (int)oracle.Call("RebindPair", first, second)!;
        var native = RunInternal(compiled, "Rebind");
        AssertNormal(native);
        Assert.Equal((decimal)expected, native["AvResult"]);
        Assert.Equal((decimal)(int)oracle.Call("Rebind")!, native["AvResult"]);
        var actual = Journals(compiled, native);
        Assert.Equal(2, actual.Length);
        Assert.Equal(oracle.Trace(first).Total, actual[0].Total);
        Assert.Equal(oracle.Trace(first).Entries, actual[0].Entries);
        Assert.Equal(oracle.Trace(second).Total, actual[1].Total);
        Assert.Equal(oracle.Trace(second).Entries, actual[1].Entries);
        Assert.Equal(9, actual[0].Total);
        Assert.Equal(0, actual[1].Total);
        Assert.Equal(new[] { "rhs" }, actual[0].Entries);
        Assert.Equal(new[] { "replacement" }, actual[1].Entries);
    }

    [Fact]
    public void NullForgivingInputToNonNullableHelperStillReturnsThrowCompletion()
    {
        var compiled = Compiled.Value;
        using var oracle = new ClrOracle();
        var expected = Assert.Throws<ArgumentNullException>(() => oracle.Call("NullRequired"));
        var native = RunInternal(compiled, "NullRequired");
        AssertFailure(native, expected);
        Assert.Empty(Journals(compiled, native));
        var exception = NativeException(native);
        Assert.Equal(expected.ParamName, exception["ParamName"]);
        var boundary = Assert.Throws<ReferenceGraphProbe.Failure>(() => RunBoundary(compiled, "NullRequired"));
        Assert.Equal(nameof(ArgumentNullException), boundary.Kind);
        Assert.Equal(expected.Message, boundary.Message);
    }

    [Theory]
    [InlineData("public sealed class Item { public int Total {get;set;} } public static class R { public static int Mutate(Item item) { item.Total++; return item.Total; } }")]
    [InlineData("public static class R { public static int Mutate(List<int> items) { items.Add(7); return items.Count; } }")]
    public void PublicReferenceInputNeedsAnExplicitBoundaryCodec(string source)
    {
        var error = Assert.Throws<SourceCompilationException>(() => Compile(source));
        Assert.Contains(error.Diagnostics, diagnostic => diagnostic.Code == "AVCS310"
            && diagnostic.Message.Contains("codec", StringComparison.OrdinalIgnoreCase)
            && diagnostic.File == "ReferenceRules.cs");
    }

    [Fact]
    public void TypedArenasAreGeneratedInternalStateAndScalarEntriesRetainTheirSignatures()
    {
        var compiled = Compiled.Value;
        Assert.DoesNotContain("AvRef_", Source);
        Assert.DoesNotContain("AvContext", Source);
        Assert.Null(compiled.Specification["data"]?["entities"]);
        var runtime = Structures(compiled).Where(s => Name(s).StartsWith("AvRef_", StringComparison.Ordinal)
            || Name(s).StartsWith("AvCell_", StringComparison.Ordinal)).ToArray();
        Assert.NotEmpty(runtime);
        Assert.All(runtime, structure => Assert.False(structure["public"]!.GetValue<bool>()));
        foreach (var sourceName in new[] { "Run", "Same", "Fresh", "Rebind", "NullRequired" })
        {
            var map = Mapping(compiled, sourceName);
            var entry = Action(compiled, map["native"]!.ToString());
            Assert.All(Parameters(entry, "inputs").Concat(Parameters(entry, "outputs")),
                parameter => Assert.Contains(parameter["type"]!.ToString(), new[] { "Integer", "Boolean" }));
            var implementation = Action(compiled, Implementation(compiled, sourceName));
            Assert.False(implementation["public"]!.GetValue<bool>());
            Assert.Contains(Parameters(implementation, "inputs"), p => Name(p) == "AvContextIn");
            Assert.Contains(Parameters(implementation, "outputs"), p => Name(p) == "AvContextOut");
            Assert.Contains(Parameters(implementation, "outputs"), p => Name(p) == "AvCompletion");
        }
    }

    private static Dictionary<string, object> RunInternal(CompilationResult compiled, string name, params (string Name, object Value)[] inputs)
        => new ReferenceGraphProbe(compiled.Specification).Run(Implementation(compiled, name), Inputs(inputs));
    private static Dictionary<string, object> RunBoundary(CompilationResult compiled, string name, params (string Name, object Value)[] inputs)
        => new ReferenceGraphProbe(compiled.Specification).Run(Mapping(compiled, name)["native"]!.ToString(), Inputs(inputs));
    private static Dictionary<string, object> Inputs((string Name, object Value)[] inputs)
        => inputs.ToDictionary(input => "Arg_" + input.Name, input => input.Value);
    private static JsonObject Mapping(CompilationResult compiled, string name)
        => compiled.SourceMap.OfType<JsonObject>().Single(entry => entry["source"]?.ToString()
            .StartsWith("JournalRules." + name + "(", StringComparison.Ordinal) == true);
    private static string Implementation(CompilationResult compiled, string name)
    {
        var map = Mapping(compiled, name);
        return map["implementation"]?.ToString() ?? "AvImpl_" + map["native"]!.ToString();
    }
    private static JsonObject Action(CompilationResult compiled, string name)
        => compiled.Specification["logic"]!["actions"]!.AsArray().OfType<JsonObject>().Single(action => Name(action) == name);
    private static IEnumerable<JsonObject> Structures(CompilationResult compiled)
        => compiled.Specification["data"]!["structures"]!.AsArray().OfType<JsonObject>();
    private static IEnumerable<JsonObject> Parameters(JsonObject owner, string collection)
        => (owner[collection] as JsonArray)?.OfType<JsonObject>() ?? Enumerable.Empty<JsonObject>();
    private static string Name(JsonObject value) => value["name"]!.ToString();
    private static Dictionary<string, object> Fields(object value) => Assert.IsType<Dictionary<string, object>>(value);

    private static void AssertNormal(Dictionary<string, object> output)
    {
        var completion = Fields(output["AvCompletion"]);
        Assert.Contains((decimal)completion["Kind"], new[] { 0m, 1m });
        Assert.Equal(0m, completion["ExceptionRef"]);
        Assert.Empty(Assert.IsType<List<object>>(Fields(output["AvContextOut"])["Exceptions"]));
    }
    private static void AssertFailure(Dictionary<string, object> output, Exception expected)
    {
        Assert.Equal(2m, Fields(output["AvCompletion"])["Kind"]);
        var exception = NativeException(output);
        Assert.Equal(expected.GetType().FullName, exception["TypeName"]);
        Assert.Equal(expected.Message, exception["Message"]);
        Assert.Single(Assert.IsType<List<object>>(Fields(output["AvContextOut"])["Exceptions"]));
    }
    private static Dictionary<string, object> NativeException(Dictionary<string, object> output)
    {
        var completion = Fields(output["AvCompletion"]);
        var exceptions = Assert.IsType<List<object>>(Fields(output["AvContextOut"])["Exceptions"]);
        var index = Convert.ToInt32(completion["ExceptionRef"]);
        Assert.InRange(index, 1, exceptions.Count);
        return Fields(exceptions[index - 1]);
    }
    private static JsonObject TextListCell(CompilationResult compiled)
        => Structures(compiled).Single(structure => Name(structure).StartsWith("AvCell_", StringComparison.Ordinal)
            && Parameters(structure, "attributes").Any(attribute => Name(attribute) == "Items"
                && attribute["type"]!.ToString().EndsWith(" List", StringComparison.Ordinal)
                && Structures(compiled).Any(element => Name(element) == attribute["type"]!.ToString()[..^5]
                    && Parameters(element, "attributes").Any(field => Name(field) == "HasValue" && field["type"]!.ToString() == "Boolean")
                    && Parameters(element, "attributes").Any(field => Name(field) == "Value" && field["type"]!.ToString() == "Text"))));
    private static List<object> Arena(CompilationResult compiled, Dictionary<string, object> output, JsonObject cell)
    {
        var implementation = Action(compiled, Implementation(compiled, "Run"));
        var contextType = Parameters(implementation, "outputs").Single(p => Name(p) == "AvContextOut")["type"]!.ToString();
        var context = Structures(compiled).Single(structure => Name(structure) == contextType);
        var field = Parameters(context, "attributes").Single(attribute => attribute["type"]!.ToString() == Name(cell) + " List");
        return Assert.IsType<List<object>>(Fields(output["AvContextOut"])[Name(field)]);
    }
    private static JournalTrace[] Journals(CompilationResult compiled, Dictionary<string, object> output)
    {
        var journalCell = Structures(compiled).Single(structure => Name(structure).StartsWith("AvCell_", StringComparison.Ordinal)
            && Parameters(structure, "attributes").Any(attribute => Name(attribute) == "Total")
            && Parameters(structure, "attributes").Any(attribute => Name(attribute) == "Entries"));
        var lists = Arena(compiled, output, TextListCell(compiled));
        return Arena(compiled, output, journalCell).Select((value, index) =>
        {
            var journal = Fields(value);
            var entriesIndex = Convert.ToInt32(Fields(journal["Entries"])["Index"]);
            Assert.InRange(entriesIndex, 1, lists.Count);
            var entries = Assert.IsType<List<object>>(Fields(lists[entriesIndex - 1])["Items"])
                .Select(item => { var text = Fields(item); return (bool)text["HasValue"] ? (string)text["Value"] : null; }).ToArray();
            return new JournalTrace(Convert.ToInt32(journal["Total"]), entries, index + 1, entriesIndex);
        }).ToArray();
    }
    private sealed record JournalTrace(int Total, string?[] Entries, int Index = 0, int EntriesIndex = 0);

    private sealed class ClrOracle : IDisposable
    {
        private readonly AssemblyLoadContext context = new("ReferenceGraphClrOracle", isCollectible: true);
        private readonly Type rules;
        private readonly Type journal;

        public ClrOracle()
        {
            using var stream = new MemoryStream();
            var emitted = SourceProgram.Parse(new Dictionary<string, string> { ["ReferenceRules.cs"] = Source }).Compilation.Emit(stream);
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            stream.Position = 0;
            var assembly = context.LoadFromStream(stream);
            rules = assembly.GetType("JournalRules")!;
            journal = assembly.GetType("PostingJournal")!;
        }
        public object NewJournal() => Activator.CreateInstance(journal)!;
        public object Entries(object instance) => journal.GetProperty("Entries")!.GetValue(instance)!;
        public JournalTrace Trace(object instance) => new((int)journal.GetProperty("Total")!.GetValue(instance)!,
            ((IEnumerable)Entries(instance)).Cast<string?>().ToArray());
        public object? Call(string name, params object?[] arguments)
        {
            try { return rules.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!.Invoke(null, arguments); }
            catch (TargetInvocationException error)
            {
                ExceptionDispatchInfo.Capture(error.InnerException!).Throw();
                throw;
            }
        }
        public void Dispose() => context.Unload();
    }
}
