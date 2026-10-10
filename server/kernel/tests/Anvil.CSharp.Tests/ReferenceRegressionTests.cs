using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.Loader;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Xunit;

namespace Anvil.CSharp.Tests;

/// <summary>Regression oracles execute source only in the test process; production receives native logic.</summary>
public class ReferenceRegressionTests
{
    private const string Source = """
        public sealed record Journal
        {
            public int Total { get; set; } = Defaults.Seven();
            public int Marker { get; set; }
            public List<string> Entries { get; } = new List<string>();
        }
        public sealed record ArrayJournal
        {
            public int[] Values { get; } = new[] { 1, 2 };
            public int Total { get; set; }
        }
        public static class Defaults
        {
            public static int Seven() => 7;
        }
        public static class Rules
        {
            public static int InitialValue()
            {
                var journal = new Journal();
                return journal.Total;
            }
            public static int Reordered()
            {
                Journal journal = null!;
                ArgumentNullException.ThrowIfNull(paramName: "journal", argument: journal);
                return 99;
            }
            public static int DynamicName(bool missing)
            {
                var journal = new Journal();
                Journal argument = missing ? null! : journal;
                ArgumentNullException.ThrowIfNull(argument, Name(journal));
                return journal.Total;
            }
            private static string Name(Journal journal)
            {
                journal.Total = 5;
                return "argument";
            }
            public static int ParameterName(int kind)
            {
                Journal journal = null!;
                if (kind == 0) ArgumentNullException.ThrowIfNull(journal, null);
                else ArgumentNullException.ThrowIfNull(journal, "");
                return 99;
            }
            public static int Anonymous()
            {
                var journal = new Journal();
                journal.Total = 12;
                var box = new { Journal = journal };
                box.Journal.Total += 3;
                return journal.Total + box.Journal.Total;
            }
            public static int ShallowWith()
            {
                var original = new Journal();
                original.Total = 3;
                original.Entries.Add("shared");
                var copy = original with { Total = 9 };
                copy.Entries.Add("copy");
                return (object.ReferenceEquals(original, copy) ? 1000 : 0)
                    + (object.ReferenceEquals(original.Entries, copy.Entries) ? 100 : 0)
                    + original.Total * 10 + original.Entries.Count + copy.Total;
            }
            public static int Repeated()
            {
                int score = 0;
                for (int i = 0; i < 3; i++)
                {
                    var journal = new Journal();
                    score += journal.Total * 10 + journal.Marker + journal.Entries.Count;
                    journal.Total = i + 100;
                    journal.Marker = i + 1;
                    journal.Entries.Add("item");
                }
                return score;
            }
            public static int ArrayAliases()
            {
                var journal = new ArrayJournal();
                var alias = journal.Values;
                alias[0] = TouchArray(journal, alias);
                return journal.Values[0] * 100 + journal.Values[1] * 10 + journal.Total;
            }
            private static int TouchArray(ArrayJournal journal, int[] alias)
            {
                alias[1] = 8;
                journal.Total = 4;
                return 9;
            }
        }
        """;

    private static readonly Lazy<CompilationResult> Compiled = new(() => Compile(Source));
    private static CompilationResult Compile(string source)
        => CSharpCompiler.Compile(new Dictionary<string, string> { ["ReferenceRegressions.cs"] = source });

    [Fact]
    public void InitializerHelperParticipatesInContextPropagation()
    {
        var compiled = Compiled.Value;
        using var oracle = new ClrOracle();
        var native = MatchScalar(compiled, oracle, "InitialValue");
        Assert.Equal(7m, native["AvResult"]);
        var helper = Action(compiled, Implementation(compiled, "Seven", "Defaults"));
        Assert.Contains(Children(helper, "inputs"), input => Name(input) == "AvContextIn");
        Assert.Contains(Children(helper, "outputs"), output => Name(output) == "AvContextOut");
        Assert.Contains(Children(helper, "outputs"), output => Name(output) == "AvCompletion");
        Assert.Equal(7m, Assert.Single(Journals(compiled, native))["Total"]);
    }

    [Fact]
    public void ReorderedNamedThrowIfNullChecksTheArgumentRatherThanItsName()
    {
        using var oracle = new ClrOracle();
        var native = MatchFailure(Compiled.Value, oracle, "Reordered");
        Assert.Equal("journal", ExceptionCell(native)["ParamName"]);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void DynamicParameterNameEffectsRunBeforeBothNormalAndThrowCompletion(bool missing)
    {
        var compiled = Compiled.Value;
        using var oracle = new ClrOracle();
        var native = missing
            ? MatchFailure(compiled, oracle, "DynamicName", ("missing", missing))
            : MatchScalar(compiled, oracle, "DynamicName", ("missing", missing));
        var journal = Assert.Single(Journals(compiled, native));
        Assert.Equal(5m, journal["Total"]);
        Assert.Empty(TextEntries(compiled, native, journal));
        if (missing) Assert.Equal("argument", ExceptionCell(native)["ParamName"]);
        else Assert.Equal(5m, native["AvResult"]);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    public void NullAndEmptyParameterNamesKeepClrExceptionMessages(int kind)
    {
        using var oracle = new ClrOracle();
        MatchFailure(Compiled.Value, oracle, "ParameterName", ("kind", kind));
    }

    [Fact]
    public void ManagedAnonymousObjectRetainsItsJournalAlias()
    {
        var compiled = Compiled.Value;
        using var oracle = new ClrOracle();
        var native = MatchScalar(compiled, oracle, "Anonymous");
        Assert.Equal(30m, native["AvResult"]);
        Assert.Equal(15m, Assert.Single(Journals(compiled, native))["Total"]);
        var boxCell = Structures(compiled).Single(structure => Name(structure).StartsWith("AvCell_", StringComparison.Ordinal)
            && Children(structure, "attributes").Count() == 1
            && Children(structure, "attributes").Any(attribute => Name(attribute) == "Journal"));
        var box = Fields(Assert.Single(Arena(compiled, native, boxCell)));
        Assert.Equal(1m, Fields(box["Journal"])["Index"]);
    }

    [Theory]
    [InlineData("int", "return box.Journal.Total;")]
    [InlineData("Box", "return box;")]
    public void InlineReferenceBearingStructWorksInternallyButNeedsThePublicGraphCodecToEscape(string resultType, string returned)
    {
        var source = """
            public sealed record Journal { public int Total { get; set; } }
            public readonly record struct Box(Journal Journal);
            public static class Rules
            {
            """ + "public static " + resultType + " Run() { var journal = new Journal(); journal.Total = 4; var box = new Box(journal); "
            + returned + " } }";
        if (resultType == "int")
        {
            var compiled = Compile(source);
            var result = new ReferenceGraphProbe(compiled.Specification).Run("Run");
            Assert.Equal(4m, result["AvResult"]);
            return;
        }
        var error = Assert.Throws<SourceCompilationException>(() => Compile(source));
        Assert.Contains(error.Diagnostics, diagnostic => diagnostic.File == "ReferenceRegressions.cs"
            && diagnostic.Message.Contains("codec", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void RecordWithAllocatesANewOuterObjectAndSharesReferenceMembers()
    {
        var compiled = Compiled.Value;
        using var oracle = new ClrOracle();
        var native = MatchScalar(compiled, oracle, "ShallowWith");
        Assert.Equal(141m, native["AvResult"]);
        var journals = Journals(compiled, native);
        Assert.Equal(2, journals.Length);
        Assert.Equal(3m, journals[0]["Total"]);
        Assert.Equal(9m, journals[1]["Total"]);
        Assert.Equal(Fields(journals[0]["Entries"])["Index"], Fields(journals[1]["Entries"])["Index"]);
        Assert.Equal(new[] { "shared", "copy" }, TextEntries(compiled, native, journals[0]));
        Assert.Equal(new[] { "shared", "copy" }, TextEntries(compiled, native, journals[1]));
        Assert.Single(Arena(compiled, native, TextListCell(compiled)));
    }

    [Fact]
    public void RepeatedAllocationResetsFieldsAndRunsFreshListInitializers()
    {
        var compiled = Compiled.Value;
        using var oracle = new ClrOracle();
        var native = MatchScalar(compiled, oracle, "Repeated");
        Assert.Equal(210m, native["AvResult"]);
        var journals = Journals(compiled, native);
        Assert.Equal(3, journals.Length);
        for (var index = 0; index < journals.Length; index++)
        {
            Assert.Equal((decimal)(index + 100), journals[index]["Total"]);
            Assert.Equal((decimal)(index + 1), journals[index]["Marker"]);
            Assert.Equal(new[] { "item" }, TextEntries(compiled, native, journals[index]));
        }
        Assert.Equal(3, journals.Select(journal => Fields(journal["Entries"])["Index"]).Distinct().Count());
        Assert.Equal(3, Arena(compiled, native, TextListCell(compiled)).Count);
    }

    [Fact]
    public void IndexedArrayStorePreservesAliasAndSiblingRhsMutations()
    {
        var compiled = Compiled.Value;
        using var oracle = new ClrOracle();
        var native = MatchScalar(compiled, oracle, "ArrayAliases");
        var expectedJournal = oracle.New("ArrayJournal");
        var expectedValues = (int[])oracle.Property(expectedJournal, "Values")!;
        expectedValues[0] = (int)oracle.Call("TouchArray", expectedJournal, expectedValues)!;
        var journalCell = Structures(compiled).Single(structure => Name(structure).StartsWith("AvCell_", StringComparison.Ordinal)
            && Children(structure, "attributes").Any(attribute => Name(attribute) == "Values")
            && Children(structure, "attributes").Any(attribute => Name(attribute) == "Total"));
        var journal = Fields(Assert.Single(Arena(compiled, native, journalCell)));
        var arrayCell = Structures(compiled).Single(structure => Name(structure).StartsWith("AvCell_", StringComparison.Ordinal)
            && Children(structure, "attributes").Any(attribute => Name(attribute) == "Items" && attribute["type"]!.ToString() == "Integer List"));
        var arrays = Arena(compiled, native, arrayCell);
        var arrayIndex = Convert.ToInt32(Fields(journal["Values"])["Index"]);
        Assert.InRange(arrayIndex, 1, arrays.Count);
        var items = Assert.IsType<List<object>>(Fields(arrays[arrayIndex - 1])["Items"]);
        Assert.Equal(expectedValues.Select(value => (decimal)value), items.Cast<decimal>());
        Assert.Equal((decimal)(int)oracle.Property(expectedJournal, "Total")!, journal["Total"]);
        Assert.Equal(984m, native["AvResult"]);
    }

    private static Dictionary<string, object> MatchScalar(CompilationResult compiled, ClrOracle oracle, string method,
        params (string Name, object Value)[] inputs)
    {
        var expected = oracle.Call(method, inputs.Select(input => input.Value).ToArray());
        var native = Run(compiled, method, true, inputs);
        var completion = Fields(native["AvCompletion"]);
        Assert.Contains((decimal)completion["Kind"], new[] { 0m, 1m });
        Assert.Equal(0m, completion["ExceptionRef"]);
        Assert.Empty(Assert.IsType<List<object>>(Fields(native["AvContextOut"])["Exceptions"]));
        Assert.Equal(Convert.ToDecimal(expected), native["AvResult"]);
        Assert.Equal(Convert.ToDecimal(expected), Run(compiled, method, false, inputs)["AvResult"]);
        return native;
    }

    private static Dictionary<string, object> MatchFailure(CompilationResult compiled, ClrOracle oracle, string method,
        params (string Name, object Value)[] inputs)
    {
        var expected = Assert.Throws<ArgumentNullException>(() => oracle.Call(method, inputs.Select(input => input.Value).ToArray()));
        var native = Run(compiled, method, true, inputs);
        Assert.Equal(2m, Fields(native["AvCompletion"])["Kind"]);
        var cell = ExceptionCell(native);
        Assert.Equal(expected.GetType().FullName, cell["TypeName"]);
        Assert.Equal(expected.Message, cell["Message"]);
        Assert.Equal(expected.ParamName ?? "", cell["ParamName"]);
        var boundary = Assert.Throws<ReferenceGraphProbe.Failure>(() => Run(compiled, method, false, inputs));
        Assert.Equal(expected.GetType().Name, boundary.Kind);
        Assert.Equal(expected.Message, boundary.Message);
        return native;
    }

    private static Dictionary<string, object> Run(CompilationResult compiled, string method, bool implementation,
        params (string Name, object Value)[] inputs)
        => new ReferenceGraphProbe(compiled.Specification).Run(implementation ? Implementation(compiled, method)
            : Mapping(compiled, method)["native"]!.ToString(), inputs.ToDictionary(input => "Arg_" + input.Name, input => input.Value));
    private static JsonObject Mapping(CompilationResult compiled, string method, string owner = "Rules")
        => compiled.SourceMap.OfType<JsonObject>().Single(entry => entry["source"]?.ToString()
            .StartsWith(owner + "." + method + "(", StringComparison.Ordinal) == true);
    private static string Implementation(CompilationResult compiled, string method, string owner = "Rules")
    {
        var mapping = Mapping(compiled, method, owner);
        return mapping["implementation"]?.ToString() ?? "AvImpl_" + mapping["native"]!.ToString();
    }
    private static JsonObject Action(CompilationResult compiled, string name)
        => compiled.Specification["logic"]!["actions"]!.AsArray().OfType<JsonObject>().Single(action => Name(action) == name);
    private static IEnumerable<JsonObject> Structures(CompilationResult compiled)
        => compiled.Specification["data"]!["structures"]!.AsArray().OfType<JsonObject>();
    private static IEnumerable<JsonObject> Children(JsonObject owner, string collection)
        => (owner[collection] as JsonArray)?.OfType<JsonObject>() ?? Enumerable.Empty<JsonObject>();
    private static string Name(JsonObject value) => value["name"]!.ToString();
    private static Dictionary<string, object> Fields(object value) => Assert.IsType<Dictionary<string, object>>(value);
    private static Dictionary<string, object> ExceptionCell(Dictionary<string, object> output)
    {
        var exceptions = Assert.IsType<List<object>>(Fields(output["AvContextOut"])["Exceptions"]);
        var index = Convert.ToInt32(Fields(output["AvCompletion"])["ExceptionRef"]);
        Assert.Single(exceptions);
        Assert.InRange(index, 1, exceptions.Count);
        return Fields(exceptions[index - 1]);
    }
    private static List<object> Arena(CompilationResult compiled, Dictionary<string, object> output, JsonObject cell)
    {
        var implementation = Action(compiled, Implementation(compiled, "InitialValue"));
        var contextType = Children(implementation, "outputs").Single(parameter => Name(parameter) == "AvContextOut")["type"]!.ToString();
        var context = Structures(compiled).Single(structure => Name(structure) == contextType);
        var field = Children(context, "attributes").Single(attribute => attribute["type"]!.ToString() == Name(cell) + " List");
        return Assert.IsType<List<object>>(Fields(output["AvContextOut"])[Name(field)]);
    }
    private static Dictionary<string, object>[] Journals(CompilationResult compiled, Dictionary<string, object> output)
    {
        var cell = Structures(compiled).Single(structure => Name(structure).StartsWith("AvCell_", StringComparison.Ordinal)
            && Children(structure, "attributes").Any(attribute => Name(attribute) == "Entries")
            && Children(structure, "attributes").Any(attribute => Name(attribute) == "Marker"));
        return Arena(compiled, output, cell).Select(Fields).ToArray();
    }
    private static JsonObject TextListCell(CompilationResult compiled)
        => Structures(compiled).Single(structure => Name(structure).StartsWith("AvCell_", StringComparison.Ordinal)
            && Children(structure, "attributes").Any(attribute => Name(attribute) == "Items"
                && attribute["type"]!.ToString().EndsWith(" List", StringComparison.Ordinal)
                && Structures(compiled).Any(element => Name(element) == attribute["type"]!.ToString()[..^5]
                    && Children(element, "attributes").Any(field => Name(field) == "HasValue" && field["type"]!.ToString() == "Boolean")
                    && Children(element, "attributes").Any(field => Name(field) == "Value" && field["type"]!.ToString() == "Text"))));
    private static string?[] TextEntries(CompilationResult compiled, Dictionary<string, object> output, Dictionary<string, object> journal)
    {
        var lists = Arena(compiled, output, TextListCell(compiled));
        var index = Convert.ToInt32(Fields(journal["Entries"])["Index"]);
        Assert.InRange(index, 1, lists.Count);
        return Assert.IsType<List<object>>(Fields(lists[index - 1])["Items"])
            .Select(item => { var text = Fields(item); return (bool)text["HasValue"] ? (string)text["Value"] : null; }).ToArray();
    }

    private sealed class ClrOracle : IDisposable
    {
        private readonly AssemblyLoadContext context = new("ReferenceRegressionClrOracle", isCollectible: true);
        private readonly Assembly assembly;
        public ClrOracle()
        {
            using var stream = new MemoryStream();
            var emitted = SourceProgram.Parse(new Dictionary<string, string> { ["ReferenceRegressions.cs"] = Source }).Compilation.Emit(stream);
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            stream.Position = 0;
            assembly = context.LoadFromStream(stream);
        }
        public object New(string type) => Activator.CreateInstance(assembly.GetType(type)!)!;
        public object? Property(object instance, string name) => instance.GetType().GetProperty(name)!.GetValue(instance);
        public object? Call(string name, params object?[] arguments)
        {
            try { return assembly.GetType("Rules")!.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!.Invoke(null, arguments); }
            catch (TargetInvocationException error)
            {
                ExceptionDispatchInfo.Capture(error.InnerException!).Throw();
                throw;
            }
        }
        public void Dispose() => context.Unload();
    }
}
