using System.Globalization;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.Loader;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public sealed class InstanceMethodTests
{
    private static readonly Lazy<CompilationResult> Compiled = new(() => CSharpCompiler.CompileReferenceGraph(
        new Dictionary<string, string> { ["InstanceMethods.cs"] = Source }));

    [Fact]
    public void InstanceMethodsHaveTypedPrivateReceiversAndDoNotAddEndpointsOrSourceAbis()
    {
        var compiled = Compiled.Value;
        var mappings = compiled.SourceMap.OfType<JsonObject>().Where(item => item["source"]!.ToString().StartsWith("Counter.", StringComparison.Ordinal)).ToArray();
        Assert.NotEmpty(mappings);
        foreach (var mapping in mappings)
        {
            var helper = Actions(compiled).Single(action => action["name"]!.ToString() == mapping["implementation"]!.ToString());
            Assert.False(helper["public"]!.GetValue<bool>()); Assert.Null(helper["access"]);
            Assert.Equal(mapping["native"]!.ToString(), helper["name"]!.ToString());
            Assert.Equal("AvContextIn", helper["inputs"]![0]!["name"]!.ToString());
            Assert.Equal("AvThis", helper["inputs"]![1]!["name"]!.ToString());
            Assert.StartsWith("AvRef_", helper["inputs"]![1]!["type"]!.ToString(), StringComparison.Ordinal);
            Assert.DoesNotContain(compiled.SourceAbis!, item => item!["source"]!.ToString().StartsWith("Counter.", StringComparison.Ordinal));
        }
        Assert.All(Actions(compiled).Where(action => action["public"]!.GetValue<bool>()), action => {
            Assert.True(action["access"]!["authenticated"]!.GetValue<bool>());
            Assert.DoesNotContain(action["inputs"]!.AsArray(), input => input!["name"]!.ToString() == "AvThis");
        });
        Assert.All(compiled.SourceAbis!, entry => Assert.Equal(2, entry!["abi"]!["version"]!.GetValue<int>()));
        foreach (var name in new[] { "Self", "Names", "Fail" })
            Assert.Contains(compiled.SourceAbis!, entry => entry!["native"]!.ToString() == name && entry["source"]!.ToString().StartsWith("Rules." + name + "(", StringComparison.Ordinal));
        if (Environment.GetEnvironmentVariable("ANVIL_INSTANCE_PROOF_DIRECTORY") is { Length: > 0 } proof)
        {
            Directory.CreateDirectory(proof);
            File.WriteAllText(Path.Combine(proof, "InstanceMethods.cs"), Source);
            File.WriteAllText(Path.Combine(proof, "contract.json"), compiled.Specification.ToJsonString());
            File.WriteAllText(Path.Combine(proof, "source-map.json"), compiled.SourceMap.ToJsonString());
            File.WriteAllText(Path.Combine(proof, "source-abis.json"), compiled.SourceAbis!.ToJsonString());
            File.WriteAllText(Path.Combine(proof, "source-hash.txt"), compiled.SourceHash);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ThisPrivateForwardCallsAndAliasesKeepTheOriginalObject(bool graph)
    {
        using var fixture = new Fixture(); var counter = fixture.New("Counter"); fixture.Set(counter, "Value", 10);
        var returned = fixture.Invoke(graph, "Alias", counter);
        Assert.Same(counter, returned); Assert.Equal(13, fixture.Get(counter, "Value"));
        Assert.Same(counter, fixture.Invoke(graph, "Self", counter));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ReceiverIsEvaluatedOnceBeforeArgumentsThatReplaceItsSourceLocation(bool graph)
    {
        using var fixture = new Fixture(); var state = fixture.New("State");
        var original = fixture.New("Counter"); fixture.Set(original, "Value", 10);
        var replacement = fixture.New("Counter"); fixture.Set(replacement, "Value", 40);
        fixture.Set(state, "Current", original); fixture.Set(state, "Replacement", replacement);
        Assert.Equal(13, fixture.Invoke(graph, "Swap", state));
        Assert.Equal(12, fixture.Get(state, "Trace")); Assert.Same(replacement, fixture.Get(state, "Current"));
        Assert.Equal(13, fixture.Get(original, "Value")); Assert.Equal(40, fixture.Get(replacement, "Value"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void NullReceiverThrowsAfterArgumentEffectsEvenWhenTheBodyDoesNotUseThis(bool graph)
    {
        using var fixture = new Fixture(); var state = fixture.New("State"); var replacement = fixture.New("Counter");
        fixture.Set(state, "Replacement", replacement);
        Assert.Throws<NullReferenceException>(() => fixture.Invoke(graph, "NullReceiver", state));
        Assert.Equal(12, fixture.Get(state, "Trace")); Assert.Same(replacement, fixture.Get(state, "Current"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ArgumentFailurePrecedesNullDereferenceAndReceiverFailurePrecedesArguments(bool graph)
    {
        using var fixture = new Fixture(); var state = fixture.New("State");
        var argument = Assert.Throws<InvalidOperationException>(() => fixture.Invoke(graph, "ArgumentFails", state));
        Assert.Equal("argument", argument.Message); Assert.Equal(12, fixture.Get(state, "Trace"));
        fixture.Set(state, "Trace", 0);
        var receiver = Assert.Throws<InvalidOperationException>(() => fixture.Invoke(graph, "ReceiverFails", state));
        Assert.Equal("receiver", receiver.Message); Assert.Equal(1, fixture.Get(state, "Trace"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void RecursiveImplicitThisAndGeneratedNamesDoNotLoseReceiverIdentity(bool graph)
    {
        using var fixture = new Fixture(); var counter = fixture.New("Counter"); fixture.Set(counter, "Value", 2);
        Assert.Equal(6, fixture.Invoke(graph, "Recurse", counter, 4)); Assert.Equal(6, fixture.Get(counter, "Value"));
        Assert.Equal(321, fixture.Invoke(graph, "Names", counter));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void InstanceFailureReturnsEarlierMutationsToTheCaller(bool graph)
    {
        using var fixture = new Fixture(); var counter = fixture.New("Counter"); fixture.Set(counter, "Value", 5);
        var failure = Assert.Throws<InvalidOperationException>(() => fixture.Invoke(graph, "Fail", counter));
        Assert.Equal("instance", failure.Message); Assert.Equal(12, fixture.Get(counter, "Value"));
    }

    [Fact]
    public void PublicScalarEntryCanUseInstanceHelpersWithoutChangingItsExternalSignature()
    {
        const string source = """
            public sealed class Counter { public int Value; public int Add(int amount) { Value += amount; return Value; } }
            public static class Rules { public static int Run(int amount) { var value = new Counter(); return value.Add(amount); } }
            """;
        var compiled = CSharpCompiler.Compile(new Dictionary<string, string> { ["InternalReceiver.cs"] = source });
        var entry = Assert.Single(Actions(compiled), action => action["public"]!.GetValue<bool>());
        Assert.Equal("Run", entry["name"]!.ToString());
        Assert.Equal("Arg_amount", Assert.Single(entry["inputs"]!.AsArray())!["name"]!.ToString());
        Assert.Empty(compiled.SourceAbis!);
        Assert.Equal(7m, new ReferenceGraphProbe(compiled.Specification).Run("Run", new Dictionary<string, object> { ["Arg_amount"] = 7m })["AvResult"]);
    }

    [Theory]
    [InlineData("public struct C { public int Value; public int Read() => Value; }", "AVCS308")]
    [InlineData("public class C { public virtual int Read() => 1; }", "AVCS308")]
    [InlineData("public class B { public int Value; } public class C : B { public int Read() => Value; }", "AVCS201")]
    [InlineData("public sealed class C { [Anvil.Authoring.ServiceAction] public int Read() => 1; }", "AVCS307")]
    [InlineData("public sealed class C { [Anvil.Authoring.Authorize(\"Admin\")] public int Read() => 1; }", "AVCS307")]
    public void UnsupportedReceiverOrEndpointSemanticsAreDiagnosedAtTheSource(string source, string diagnostic)
    {
        var failure = Assert.Throws<SourceCompilationException>(() => CSharpCompiler.CompileReferenceGraph(new Dictionary<string, string> { ["UnsupportedInstance.cs"] = source }));
        Assert.Contains(failure.Diagnostics, item => item.Code == diagnostic && item.File == "UnsupportedInstance.cs");
    }

    private static IEnumerable<JsonObject> Actions(CompilationResult compilation) => compilation.Specification["logic"]!["actions"]!.AsArray().OfType<JsonObject>();

    // CLR execution supplies an independent route through exactly the same source; the
    // other route executes emitted native operations with the existing copy-semantics probe.
    // All expected values/effect order above are explicit, never learned from either route.
    private sealed class Fixture : IDisposable
    {
        private readonly AssemblyLoadContext context = new("instance-method-oracle-" + Guid.NewGuid(), isCollectible: true);
        private readonly Assembly assembly;
        private readonly ReferenceGraphProbe probe = new(Compiled.Value.Specification);
        internal Fixture()
        {
            using var bytes = new MemoryStream(); var emitted = SourceProgram.Parse(new Dictionary<string, string> { ["InstanceMethods.cs"] = Source }).Compilation.Emit(bytes);
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics)); bytes.Position = 0;
            assembly = context.LoadFromStream(bytes);
        }
        internal object New(string type) => Activator.CreateInstance(assembly.GetType(type)!)!;
        internal object? Get(object value, string field) => value.GetType().GetField(field)!.GetValue(value);
        internal void Set(object value, string field, object? content) => value.GetType().GetField(field)!.SetValue(value, content);
        internal object? Invoke(bool graph, string method, params object?[] inputs)
        {
            if (!graph)
            {
                try { return assembly.GetType("Rules")!.GetMethod(method)!.Invoke(null, inputs); }
                catch (TargetInvocationException failure) when (failure.InnerException != null) { ExceptionDispatchInfo.Capture(failure.InnerException).Throw(); throw; }
            }
            var entry = Compiled.Value.SourceAbis!.Single(item => item!["source"]!.ToString().StartsWith("Rules." + method + "(", StringComparison.Ordinal))!;
            var binding = new Anvil.Authoring.Transport.ReferenceGraphBinding(entry["abi"]!.AsObject(), assembly);
            return binding.CreateCall(entry["native"]!.ToString()).Invoke(inputs, (action, request) => JsonNode.Parse(JsonSerializer.Serialize(
                probe.Run(action, request.ToDictionary(pair => pair.Key, pair => Native(pair.Value)))))!.AsObject());
        }
        private static object Native(JsonNode? node) => node switch {
            JsonObject value => value.ToDictionary(pair => pair.Key, pair => Native(pair.Value)),
            JsonArray values => values.Select(Native).ToList(),
            JsonValue value when value.TryGetValue<string>(out var text) => text,
            JsonValue value when value.TryGetValue<bool>(out var flag) => flag,
            JsonValue value => decimal.Parse(value.ToJsonString(), CultureInfo.InvariantCulture),
            _ => throw new InvalidOperationException("Native payload requires explicit presence")
        };
        public void Dispose() => context.Unload();
    }

    private const string Source = """
        #nullable enable
        public sealed class Counter {
            public int Value;
            public int Add(int amount) { Value += amount; return Value; }
            public Counter Self() => this;
            public Counter AddTwice(Counter other) { Increment(1); other.Add(2); return this; }
            private void Increment(int amount) { this.Value += amount; }
            public int Ignore(int argument) => argument;
            public int Count(int remaining) { if (remaining == 0) return Value; Value += 1; return Count(remaining - 1); }
            public int Names(int AvThis, int AvContextIn, int AvResult) => AvThis + AvContextIn * 10 + AvResult * 100;
            public int Fail(int amount) { Value += amount; throw new InvalidOperationException("instance"); }
        }
        public sealed class State { public Counter? Current; public Counter? Replacement; public int Trace; }
        public static class Rules {
            public static Counter Alias(Counter value) => value.AddTwice(value);
            public static Counter Self(Counter value) => value.Self();
            public static int Swap(State state) => Pick(state).Add(Argument(state));
            public static int NullReceiver(State state) => Pick(state).Ignore(Argument(state));
            public static int ArgumentFails(State state) => Pick(state).Ignore(ThrowArgument(state));
            public static int ReceiverFails(State state) => ThrowReceiver(state).Ignore(Argument(state));
            public static int Recurse(Counter value, int count) => value.Count(count);
            public static int Names(Counter value) => value.Names(AvResult: 3, AvThis: 1, AvContextIn: 2);
            public static int Fail(Counter value) => value.Fail(7);
            private static Counter Pick(State state) { state.Trace = state.Trace * 10 + 1; return state.Current!; }
            private static int Argument(State state) { state.Trace = state.Trace * 10 + 2; state.Current = state.Replacement; return 3; }
            private static int ThrowArgument(State state) { state.Trace = state.Trace * 10 + 2; throw new InvalidOperationException("argument"); }
            private static Counter ThrowReceiver(State state) { state.Trace = state.Trace * 10 + 1; throw new InvalidOperationException("receiver"); }
        }
        """;
}
