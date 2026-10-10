using System.Globalization;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Authoring.Transport;
using Xunit;

namespace Anvil.CSharp.Tests;

public sealed class OptionalGraphArgumentTests
{
    private const string MatrixSource = "public sealed record R(int Value); public static class Rules { public static R Echo(R value, int count = 1) => count > 0 ? value : new R(0); }";
    private const string Source = """
        #nullable enable
        public sealed class State { public int Value; public int Trace; public State? Other; }
        public enum Mode { First = 1, Second = 8 }
        public static class Rules
        {
            public static State Apply(State state, State? other = null, int delta = 7, string? label = "default", int? limit = null)
            {
                state.Value += delta;
                state.Value += label == null ? 100 : label.Length;
                state.Value += limit ?? 1000;
                state.Other = other;
                return state;
            }
            public static State? Echo(State? value = null) => value;
            public static int Values(State state, Mode mode = Mode.Second, int? number = 5, byte tiny = 3, bool flag = true)
                => (int)mode + (number ?? 0) + tiny + (flag ? 100 : 0);
            public static char Letter(State state, char value = 'A') => value;
            public static decimal Amount(State state, decimal value = 1.25m) => value;
            public static DateTime Instant(State state, DateTime value = default) => value;
            private static int Stamp(State state, int digit) { state.Trace = state.Trace * 10 + digit; return digit; }
            private static int Pair(int left = 4, int? right = null) => left * 10 + (right ?? 5);
            public static State Route(State state, int mode)
            {
                if (mode == 0) return Apply(state);
                if (mode == 1) return Apply(state, null, 0, null, 0);
                if (mode == 2) return Apply(state, label: "", delta: 0);
                if (mode == 3) return Apply(limit: Stamp(state, 1), label: null, delta: Stamp(state, 2), other: state, state: state);
                state.Value = Pair(right: Stamp(state, 3));
                return Apply(delta: Stamp(state, 4), state: state);
            }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void OriginalOptionalObjectMatrixSourcePreservesDefaultAndIdentity(bool explicitZero)
    {
        using var fixture = new Fixture(MatrixSource);
        var value = Activator.CreateInstance(fixture.Assembly.GetType("R")!, 29)!;
        var actual = fixture.Invoke("Echo", explicitZero ? [value, 0] : [value]);
        if (!explicitZero) Assert.Same(value, actual);
        Assert.Equal(explicitZero ? 0 : 29, actual!.GetType().GetProperty("Value")!.GetValue(actual));
        Assert.Equal(4, fixture.Abi("Echo")["version"]!.GetValue<int>());
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    public void OmissionNullAndNamedEffectsMatchIndependentClr(int mode)
    {
        using var fixture = new Fixture(Source); var expected = fixture.State(); var actual = fixture.State();
        Assert.Same(expected, fixture.Clr("Route", expected, mode));
        Assert.Same(actual, fixture.Invoke("Route", [actual, mode]));
        Assert.Equal(fixture.Field(expected, "Value"), fixture.Field(actual, "Value"));
        Assert.Equal(fixture.Field(expected, "Trace"), fixture.Field(actual, "Trace"));
        Assert.Equal(ReferenceEquals(expected, fixture.Field(expected, "Other")), ReferenceEquals(actual, fixture.Field(actual, "Other")));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void SdkOmissionAndExplicitArgumentsMatchClr(int mode)
    {
        using var fixture = new Fixture(Source); var expected = fixture.State(); var actual = fixture.State();
        object?[] Arguments(object state) => mode switch {
            0 => [state], 1 => [state, null, 0, null, 0],
            2 => [state, Type.Missing, Type.Missing, "", Type.Missing],
            _ => [state, state, 2, "x", 3]
        };
        fixture.Clr("Apply", Arguments(expected));
        Assert.Same(actual, fixture.Invoke("Apply", Arguments(actual)));
        Assert.Equal(fixture.Field(expected, "Value"), fixture.Field(actual, "Value"));
        Assert.Equal(ReferenceEquals(expected, fixture.Field(expected, "Other")), ReferenceEquals(actual, fixture.Field(actual, "Other")));
        var request = fixture.LastRequest!;
        Assert.Equal(mode is 1 or 3, request.ContainsKey("Arg_other"));
        if (mode is 1 or 3) Assert.True(request["Arg_other"]!["IsSpecified"]!.GetValue<bool>());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void OptionalNullReferenceUsesZeroHandleWithoutCreatingAnIdentity(bool supplied)
    {
        using var fixture = new Fixture(Source);
        Assert.Null(fixture.Invoke("Echo", supplied ? [null] : []));
        Assert.Equal(supplied, fixture.LastRequest!.ContainsKey("Arg_value"));
        if (supplied) {
            Assert.True(fixture.LastRequest["Arg_value"]!["IsSpecified"]!.GetValue<bool>());
            Assert.Equal(0, fixture.LastRequest["Arg_value"]!["Value"]!["Index"]!.GetValue<int>());
        }
    }

    [Theory]
    [InlineData("Values")]
    [InlineData("Amount")]
    [InlineData("Letter")]
    [InlineData("Instant")]
    public void DefaultsReuseOrdinaryScalarNullableEnumAndTemporalLowering(string method)
    {
        using var fixture = new Fixture(Source); var state = fixture.State();
        var expected = fixture.Clr(method, state);
        Assert.Equal(expected, fixture.Invoke(method, [state]));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void MissingRequiredArgumentsFailBeforeTransport(bool hole)
    {
        using var fixture = new Fixture(Source); var binding = new ReferenceGraphBinding(fixture.Abi("Apply"), fixture.Assembly, 4);
        var reached = 0;
        Assert.Throws<ArgumentException>(() => binding.CreateCall("Apply").Invoke(hole ? [Type.Missing, null] : [], (_, _) => { reached++; throw new Exception(); }));
        Assert.Equal(0, reached);
    }

    [Theory]
    [InlineData("false")]
    [InlineData("null")]
    [InlineData("1")]
    [InlineData("\"true\"")]
    public void OptionalMetadataHasOneClosedTrueForm(string invalid)
    {
        using var fixture = new Fixture(Source); var abi = fixture.Abi("Apply");
        abi["inputs"]![1]!["optional"] = JsonNode.Parse(invalid);
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphBinding(abi, fixture.Assembly, 4));
    }

    [Theory]
    [InlineData(2)]
    [InlineData(3)]
    public void HistoricalAbiReadersRejectOptionalFields(int version)
    {
        using var fixture = new Fixture(Source); var abi = fixture.Abi("Apply"); abi["version"] = version;
        if (version == 2) abi.Remove("exceptionArena");
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphBinding(abi, fixture.Assembly, 4));
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphBinding(fixture.Abi("Apply"), fixture.Assembly, version));
    }

    [Theory]
    [InlineData("Arg_other", "Index")]
    [InlineData("Arg_delta", "")]
    [InlineData("Arg_label", "Value")]
    [InlineData("Arg_limit", "Value")]
    public void UnspecifiedNativeArgumentsRequireCanonicalInactivePayload(string name, string field)
    {
        using var fixture = new Fixture(Source); fixture.Invoke("Apply", [fixture.State()]);
        var request = fixture.LastRequest!;
        var payload = name switch {
            "Arg_other" => (JsonNode)new JsonObject { ["Index"] = 99 },
            "Arg_delta" => JsonValue.Create(99)!,
            "Arg_label" => new JsonObject { ["HasValue"] = false, ["Value"] = "stale" },
            _ => new JsonObject { ["HasValue"] = false, ["Value"] = 99 }
        };
        request[name] = new JsonObject { ["IsSpecified"] = false, ["Value"] = payload };
        var failure = Assert.Throws<ReferenceGraphProbe.Failure>(() => fixture.Raw("Apply", request));
        Assert.Equal("InvalidOperationException", failure.Kind);
        Assert.Equal("Invalid C# reference graph.", failure.Message);
    }

    [Fact]
    public void OriginalSdkConstructorAritiesRemainAvailableForCompiledConsumers()
    {
        Assert.NotNull(typeof(ReferenceGraphCall).GetConstructor([typeof(string), typeof(IReadOnlyList<string>),
            typeof(IReadOnlyList<GraphShape>), typeof(IReadOnlyList<GraphShape>), typeof(IReadOnlyList<GraphDefinition>)]));
        Assert.NotNull(typeof(ReferenceGraphCall).GetConstructor([typeof(string), typeof(IReadOnlyList<string>),
            typeof(IReadOnlyList<GraphShape>), typeof(IReadOnlyList<GraphShape>), typeof(IReadOnlyList<GraphDefinition>), typeof(int)]));
    }

    private sealed class Fixture : IDisposable
    {
        private readonly AssemblyLoadContext load = new("optional-graph-" + Guid.NewGuid(), true);
        private readonly CompilationResult compiled;
        private readonly ReferenceGraphProbe probe;
        internal Assembly Assembly { get; }
        internal JsonObject? LastRequest;
        internal Fixture(string source)
        {
            var files = new Dictionary<string, string> { ["Original.cs"] = source };
            using var bytes = new MemoryStream(); var emitted = SourceProgram.Parse(files).Compilation.Emit(bytes);
            Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics)); bytes.Position = 0;
            Assembly = load.LoadFromStream(bytes); compiled = CSharpCompiler.CompileReferenceGraph(files); probe = new(compiled.Specification);
        }
        internal object State() => Activator.CreateInstance(Assembly.GetType("State")!)!;
        internal object? Field(object state, string name) => state.GetType().GetField(name)!.GetValue(state);
        internal JsonObject Abi(string method) => compiled.SourceAbis!.Single(item => item!["native"]!.ToString() == method)!["abi"]!.DeepClone().AsObject();
        internal object? Clr(string method, params object?[] arguments)
        {
            var target = Assembly.GetType("Rules")!.GetMethod(method)!;
            return target.Invoke(null, arguments.Concat(Enumerable.Repeat(Type.Missing, target.GetParameters().Length - arguments.Length)).ToArray());
        }
        internal JsonObject Raw(string method, JsonObject request) => JsonSerializer.SerializeToNode(probe.Run(method,
            request.ToDictionary(pair => pair.Key, pair => Native(pair.Value))))!.AsObject();
        internal object? Invoke(string method, object?[] arguments)
        {
            var binding = new ReferenceGraphBinding(Abi(method), Assembly, 4);
            return binding.CreateCall(method).Invoke(arguments, (action, request) => {
                LastRequest = request.DeepClone().AsObject();
                return JsonSerializer.SerializeToNode(probe.Run(action, request.ToDictionary(pair => pair.Key, pair => Native(pair.Value))))!.AsObject();
            });
        }
        private static object Native(JsonNode? node) => node switch {
            JsonObject record => record.ToDictionary(pair => pair.Key, pair => Native(pair.Value)), JsonArray list => list.Select(Native).ToList(),
            JsonValue value when value.TryGetValue<string>(out var text) => text, JsonValue value when value.TryGetValue<bool>(out var flag) => flag,
            JsonValue value => decimal.Parse(value.ToJsonString(), CultureInfo.InvariantCulture), _ => throw new InvalidDataException("Native presence is explicit.")
        };
        public void Dispose() => load.Unload();
    }
}
