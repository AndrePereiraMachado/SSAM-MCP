using System.Globalization;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Authoring.Transport;
using Xunit;

namespace Anvil.CSharp.Tests;

public sealed class ReadOnlyListCompilerTests
{
    private const string Source = """
        public sealed class Holder { public IReadOnlyList<int> First; public IReadOnlyList<int> Second; }
        public static class Rules {
            public static IReadOnlyList<int> Echo(IReadOnlyList<int> value) => value;
            public static IReadOnlyList<int> MakeList() => new List<int> { 2, 3 };
            public static IReadOnlyList<int> MakeArray() => new[] { 2, 3 };
            public static int Read(IReadOnlyList<int> value) => value.Count * 10 + value[1];
            public static int Sum(IReadOnlyList<int> value) { int result=0; foreach(var item in value) result += item; return result; }
            public static List<int> AsList(IReadOnlyList<int> value) => (List<int>)value;
            public static int[] AsArray(IReadOnlyList<int> value) => (int[])value;
            public static List<int>? TryList(IReadOnlyList<int> value) => value as List<int>;
            public static int[]? TryArray(IReadOnlyList<int> value) => value as int[];
            public static bool SameList(List<int> concrete, IReadOnlyList<int> first, IReadOnlyList<int> second) {
                concrete.Add(7); return ReferenceEquals(concrete, first) && ReferenceEquals(first, second) && second[second.Count-1] == 7;
            }
            public static bool SameArray(int[] concrete, IReadOnlyList<int> first, IReadOnlyList<int> second) {
                concrete[1]=7; return ReferenceEquals(concrete, first) && ReferenceEquals(first, second) && second[1] == 7;
            }
            public static bool Distinct(IReadOnlyList<int> first, IReadOnlyList<int> second) => first != second;
            public static Holder Nested(List<int> value) => new Holder { First=value, Second=value };
            public static List<IReadOnlyList<int>> NestedViews(IReadOnlyList<int> value) => new List<IReadOnlyList<int>> { value, value };
            public static int FailFast(List<int> concrete, IReadOnlyList<int> view) { int result=0; foreach(var item in view) { result+=item; concrete.Add(7); } return result; }
            public static int ArrayEnumeration(int[] concrete, IReadOnlyList<int> view) { int result=0; foreach(var item in view) { result+=item; concrete[1]=7; } return result; }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void IdentityReadAndEnumerationMatchClrForBothConcreteRuntimeTypes(bool array)
    {
        using var fixture = new Fixture(Source);
        IReadOnlyList<int> value = array ? new[] { 2, 3 } : new List<int> { 2, 3 };
        Assert.Same(value, fixture.Clr("Echo", value)); Assert.Same(value, fixture.Invoke("Echo", value));
        Assert.Equal(fixture.Clr("Read", value), fixture.Invoke("Read", value));
        Assert.Equal(fixture.Clr("Sum", value), fixture.Invoke("Sum", value));
        Assert.Equal(4, fixture.Abi("Echo")["version"]!.GetValue<int>());
        var shape = fixture.Abi("Echo")["inputs"]![0]!["shape"]!;
        Assert.Equal("readonly-list", shape["kind"]!.ToString());
        Assert.Equal(2, fixture.Abi("Echo")["definitions"]!.AsArray().Count);
        Assert.Null(fixture.Invoke("Echo", new object?[] { null }));
        Assert.Throws<NullReferenceException>(() => fixture.Invoke("Read", new object?[] { null }));
        IReadOnlyList<int> empty = array ? Array.Empty<int>() : new List<int>();
        var expected = Assert.Throws<TargetInvocationException>(() => fixture.Clr("Read", empty)).InnerException!;
        var actual = Assert.Throws<ArgumentOutOfRangeException>(() => fixture.Invoke("Read", empty));
        Assert.Equal(expected.GetType(), actual.GetType());
    }

    [Fact]
    public void TwoViewsAndConcreteArgumentShareTheSameIdentityAndMutation()
    {
        using var fixture = new Fixture(Source);
        var list = new List<int> { 2, 3 }; var clrList = new List<int> { 2, 3 };
        Assert.Equal(fixture.Clr("SameList", clrList, clrList, clrList), fixture.Invoke("SameList", list, list, list));
        Assert.Equal(clrList, list);
        var array = new[] { 2, 3 }; var clrArray = new[] { 2, 3 };
        Assert.Equal(fixture.Clr("SameArray", clrArray, clrArray, clrArray), fixture.Invoke("SameArray", array, array, array));
        Assert.Equal(clrArray, array);
        Assert.Equal(false, fixture.Invoke("Distinct", list, list));
        Assert.Equal(true, fixture.Invoke("Distinct", list, new List<int>(list)));
        Assert.Equal(true, fixture.Invoke("Distinct", list, list.ToArray()));
    }

    [Fact]
    public void ReturnConversionsAndCastsPreserveConcreteTypeAndThrowForWrongKind()
    {
        using var fixture = new Fixture(Source);
        Assert.Equal(new[] { 2, 3 }, Assert.IsType<List<int>>(fixture.Invoke("MakeList")));
        Assert.Equal(new[] { 2, 3 }, Assert.IsType<int[]>(fixture.Invoke("MakeArray")));
        var list = new List<int> { 2, 3 }; var array = new[] { 2, 3 };
        Assert.Same(list, fixture.Invoke("AsList", list)); Assert.Same(array, fixture.Invoke("AsArray", array));
        foreach (var (name, value) in new[] { ("AsList", (object)array), ("AsArray", (object)list) })
        {
            var expected = Assert.IsType<InvalidCastException>(Assert.Throws<TargetInvocationException>(() => fixture.Clr(name, value)).InnerException);
            var actual = Assert.Throws<InvalidCastException>(() => fixture.Invoke(name, value));
            Assert.Equal(expected.Message, actual.Message);
        }
        Assert.Null(fixture.Invoke("AsList", new object?[] { null })); Assert.Null(fixture.Invoke("AsArray", new object?[] { null }));
        Assert.Null(fixture.Invoke("TryList", array)); Assert.Null(fixture.Invoke("TryArray", list));
        Assert.Same(list, fixture.Invoke("TryList", list)); Assert.Same(array, fixture.Invoke("TryArray", array));
    }

    [Fact]
    public void ViewsInObjectsAndNestedCollectionsDoNotCreateCollectionIdentities()
    {
        using var fixture = new Fixture(Source); var list = new List<int> { 2, 3 };
        var holder = fixture.Invoke("Nested", list)!;
        Assert.Same(list, holder.GetType().GetField("First")!.GetValue(holder));
        Assert.Same(list, holder.GetType().GetField("Second")!.GetValue(holder));
        var nested = Assert.IsType<List<IReadOnlyList<int>>>(fixture.Invoke("NestedViews", list));
        Assert.Equal(2, nested.Count); Assert.All(nested, view => Assert.Same(list, view));
    }

    [Fact]
    public void ForeachRetainsConcreteVersionAndArrayElementSemantics()
    {
        using var fixture = new Fixture(Source);
        var list = new List<int> { 2, 3 }; var clrList = new List<int> { 2, 3 };
        Assert.IsType<InvalidOperationException>(Assert.Throws<TargetInvocationException>(() => fixture.Clr("FailFast", clrList, clrList)).InnerException);
        Assert.Throws<InvalidOperationException>(() => fixture.Invoke("FailFast", list, list)); Assert.Equal(clrList, list);
        var array = new[] { 2, 3 }; var clrArray = new[] { 2, 3 };
        Assert.Equal(fixture.Clr("ArrayEnumeration", clrArray, clrArray), fixture.Invoke("ArrayEnumeration", array, array));
        Assert.Equal(clrArray, array);
    }

    [Fact]
    public void RecursiveViewClosurePreservesTheCollectionAndItsBackreference()
    {
        using var fixture = new Fixture("""
            public sealed class Node { public IReadOnlyList<Node> Children; }
            public static class Rules { public static IReadOnlyList<Node> Echo(IReadOnlyList<Node> value) => value; }
            """);
        var nodeType = fixture.Assembly.GetType("Node")!; var node = Activator.CreateInstance(nodeType)!;
        var list = (System.Collections.IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(nodeType))!;
        list.Add(node); nodeType.GetField("Children")!.SetValue(node, list);
        Assert.Same(list, fixture.Invoke("Echo", list)); Assert.Same(node, list[0]);
        Assert.Same(list, nodeType.GetField("Children")!.GetValue(node));
    }

    [Fact]
    public void TemporalElementsUseTheExistingExactAbi4Descriptor()
    {
        using var fixture = new Fixture("""
            public static class Rules {
                public static IReadOnlyList<DateTimeOffset> Echo(IReadOnlyList<DateTimeOffset> value) => value;
                public static DateTimeOffset Read(IReadOnlyList<DateTimeOffset> value) => value[0];
            }
            """);
        var value = new List<DateTimeOffset> { new(DateTime.MaxValue.Ticks - 14 * TimeSpan.TicksPerHour, TimeSpan.FromHours(-14)) };
        Assert.Same(value, fixture.Invoke("Echo", value));
        var result = Assert.IsType<DateTimeOffset>(fixture.Invoke("Read", value));
        Assert.Equal(value[0].UtcTicks, result.UtcTicks); Assert.Equal(value[0].Offset, result.Offset);
        foreach (var definition in fixture.Abi("Echo")["definitions"]!.AsArray())
            Assert.Equal("{\"kind\":\"temporal\",\"type\":{\"kind\":\"temporal\",\"name\":\"System.DateTimeOffset\"}}", definition!["element"]!.ToJsonString());
    }

    [Fact]
    public void OriginalCapabilityMatrixEchoCompilesWithoutChangingItsSourceHash()
    {
        const string source = "public static class Rules { public static IReadOnlyList<int> Echo(IReadOnlyList<int> value) => value; }";
        var compiled = CSharpCompiler.CompileReferenceGraph(new Dictionary<string, string> { ["Automatic.cs"] = source });
        Assert.Equal("5039b653de0a4db84db38650aa46fb4270d2acf15c1f751379a2ba542fa91b51", compiled.SourceHash);
        Assert.Equal(4, Assert.Single(compiled.SourceAbis!)!["abi"]!["version"]!.GetValue<int>());
    }

    [Theory]
    [InlineData("OrderBy")]
    [InlineData("OrderByDescending")]
    public void OriginalOrdinalGroupMaterializationStillDiagnosesItsSeparateNativeBufferGap(string order)
    {
        var source = """
            using System;
            using System.Linq;
            using System.Collections.Generic;
            using Anvil.Authoring;
            [Entity] public record Item(Id<Item> Id, string? Name);
            public record Summary(string? Name, int Count);
            public static class Reports {
                public static List<Summary> Read(IDataSession data) => data.Query<Item>()
                    .GroupBy(row=>row.Name).Select(group=>new Summary(group.Key,group.Count()))
                    .ORDER(row=>row.Name,StringComparer.Ordinal).ToList();
            }
            """;
        // Preserve the old source and its separate capability failure. QueryNativePlan
        // returns a NativeBuffer into List<Summary>; this is not a readonly view cast.
        var error = Assert.Throws<SourceCompilationException>(() => CSharpCompiler.CompileReferenceGraph(new Dictionary<string, string> {
            ["Report.cs"] = source.Replace("ORDER", order, StringComparison.Ordinal) }));
        var diagnostic = Assert.Single(error.Diagnostics); Assert.Equal("AVCS310", diagnostic.Code);
        Assert.Equal("Report.cs", diagnostic.File); Assert.Equal(8, diagnostic.Line); Assert.Equal(60, diagnostic.Column);
        Assert.Contains("boundary/storage copying is not implicit", diagnostic.Message);
    }

    [Fact]
    public void CastFailurePayloadRemainsObservableInsideTheOriginalCatch()
    {
        using var fixture = new Fixture("""
            public static class Rules {
                public static string Wrong(IReadOnlyList<int> value) {
                    try { var list=(List<int>)value; return "passed"; }
                    catch(InvalidCastException error) { return error.Message; }
                }
            }
            """);
        var array = new[] { 2 }; Assert.Equal(fixture.Clr("Wrong", array), fixture.Invoke("Wrong", array));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void IndexArgumentEffectsPrecedeDereferenceAndReloadTheSameCollection(bool sharedListStorage)
    {
        using var fixture = new Fixture("""
            public static class Rules {
                private static int Change(List<int> value) { value[0]=9; return 0; }
                public static int Read(List<int> concrete, IReadOnlyList<int> view) => view[Change(concrete)];
            }
            """, sharedListStorage);
        var list = new List<int> { 2 }; var clrList = new List<int> { 2 };
        Assert.Equal(fixture.Clr("Read", clrList, clrList), fixture.Invoke("Read", list, list)); Assert.Equal(clrList, list);
        list[0]=2; clrList[0]=2;
        Assert.IsType<NullReferenceException>(Assert.Throws<TargetInvocationException>(() => fixture.Clr("Read", clrList, null)).InnerException);
        Assert.Throws<NullReferenceException>(() => fixture.Invoke("Read", list, null)); Assert.Equal(clrList, list);
    }

    [Theory]
    [InlineData("1.5", "1")]
    [InlineData("1", "0.5")]
    public void FractionalHandlesAreRejectedBeforeBusinessEffects(string kind, string index)
    {
        using var fixture = new Fixture("""
            using Anvil.Authoring;
            [Entity] public sealed class Row { public long Id { get; set; } }
            public static class Rules { public static IReadOnlyList<int> Inspect(IDataSession db, IReadOnlyList<int> value) { var count=db.Query<Row>().Count(); return value; } }
            """);
        var binding = new ReferenceGraphBinding(fixture.Abi("Inspect"), fixture.Assembly, 4);
        var graph = binding.CreateSession().Encode(binding.Inputs, [new List<int> { 2 }]);
        var request = new JsonObject { ["AvGraphAbiIn"] = 4, ["AvGraphIn"] = binding.CreateWire().EncodeArenas(graph),
            ["Arg_value"] = new JsonObject { ["Kind"] = JsonNode.Parse(kind), ["Index"] = JsonNode.Parse(index) } };
        var effects = 0; fixture.DataEffect = (_, _) => { effects++; return new(); };
        Assert.Throws<ReferenceGraphProbe.Failure>(() => fixture.Raw("Inspect", request)); Assert.Equal(0, effects);
    }

    [Theory]
    [InlineData("IReadOnlyList<object>", "string[]")]
    [InlineData("IReadOnlyList<object>", "IReadOnlyList<string>")]
    public void CovarianceIsDiagnosedInsteadOfReinterpretingTypedArenas(string result, string input)
    {
        var exception = Assert.Throws<SourceCompilationException>(() => CSharpCompiler.CompileReferenceGraph(new Dictionary<string, string> {
            ["Covariance.cs"] = "public static class Rules { public static " + result + " Echo(" + input + " value) => value; }" }));
        Assert.Contains("covariance", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(1, 0)]
    [InlineData(2, 0)]
    [InlineData(3, 1)]
    [InlineData(1, 2)]
    [InlineData(2, 1)]
    public void GeneratedEntryRejectsInvalidTagAndConcreteArenaBounds(int kind, int index)
    {
        using var fixture = new Fixture(Source);
        var binding = new ReferenceGraphBinding(fixture.Abi("Echo"), fixture.Assembly, 4);
        var encoded = binding.CreateSession().Encode(binding.Inputs, [new List<int> { 2 }]); var wire = binding.CreateWire();
        var request = new JsonObject { ["AvGraphAbiIn"] = 4, ["AvGraphIn"] = wire.EncodeArenas(encoded),
            ["Arg_value"] = new JsonObject { ["Kind"] = kind, ["Index"] = index } };
        var failure = Assert.Throws<ReferenceGraphProbe.Failure>(() => fixture.Raw("Echo", request));
        Assert.Equal("InvalidOperationException", failure.Kind); Assert.Equal("Invalid C# reference graph.", failure.Message);
    }

    private sealed class Fixture : IDisposable
    {
        private readonly AssemblyLoadContext load = new("readonly-compiler-" + Guid.NewGuid(), true);
        private readonly CompilationResult compiled;
        private readonly ReferenceGraphProbe probe;
        internal Assembly Assembly { get; }
        internal Func<JsonObject, IReadOnlyDictionary<string, object>, Dictionary<string, object>>? DataEffect { set => probe.DataEffect = value; }
        internal Fixture(string source, bool sharedListStorage = false)
        {
            var files = new Dictionary<string, string> { ["ReadOnlyLists.cs"] = source };
            using var bytes = new MemoryStream(); var emitted = SourceProgram.Parse(files).Compilation.Emit(bytes);
            Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics)); bytes.Position = 0; Assembly = load.LoadFromStream(bytes);
            compiled = CSharpCompiler.CompileReferenceGraph(files); probe = new(compiled.Specification, sharedListStorage);
        }
        internal object? Clr(string method, params object?[] arguments) => Assembly.GetType("Rules")!.GetMethod(method)!.Invoke(null, arguments);
        internal JsonObject Abi(string method) => compiled.SourceAbis!.Single(item => item!["native"]!.ToString() == method)!["abi"]!.DeepClone().AsObject();
        internal JsonObject Raw(string method, JsonObject request) => JsonSerializer.SerializeToNode(probe.Run(method,
            request.ToDictionary(pair => pair.Key, pair => Native(pair.Value))))!.AsObject();
        internal object? Invoke(string method, params object?[] arguments) => new ReferenceGraphBinding(Abi(method), Assembly, 4)
            .CreateCall(method).Invoke(arguments, Raw);
        private static object Native(JsonNode? node) => node switch {
            JsonObject record => record.ToDictionary(pair => pair.Key, pair => Native(pair.Value)), JsonArray list => list.Select(Native).ToList(),
            JsonValue value when value.TryGetValue<string>(out var text) => text, JsonValue value when value.TryGetValue<bool>(out var flag) => flag,
            JsonValue value => decimal.Parse(value.ToJsonString(), CultureInfo.InvariantCulture), _ => throw new InvalidDataException("Native presence is explicit.")
        };
        public void Dispose() => load.Unload();
    }
}
