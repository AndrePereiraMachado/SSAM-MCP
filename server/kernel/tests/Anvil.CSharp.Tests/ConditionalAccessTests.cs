using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public class ConditionalAccessTests
{
    private const string TextSource = """
        #nullable enable
        public static class Rules
        {
            public static int Measure(string? value) => value?.Length ?? -1;
            public static string? Trim(string? value) => value?.Trim();
            public static int Chain(string? value) => value?.Trim().Length ?? -1;
            public static bool IsNull(string? value) => value == null;
            public static bool NullFirst(string? value) => null == value;
            public static bool NotNull(string? value) => value != null;
            public static bool ObjectNull(string? value) => value != default(object);
        }
        """;
    private const string EffectsSource = """
        #nullable enable
        public sealed class Journal { public int Calls; public List<int>? Values; }
        public sealed class Box { public Box? Next; public string? Text; }
        public static class Rules
        {
            private static List<int>? Receiver(Journal journal, bool present)
            { journal.Calls++; return present ? journal.Values : null; }
            private static int Argument(Journal journal, bool fail)
            { journal.Calls += 10; journal.Values = new List<int> { 99 }; if (fail) throw new InvalidOperationException("argument"); return 0; }
            public static int Index(bool present, bool fail)
            {
                var journal = new Journal(); journal.Values = new List<int> { 7 };
                var result = Receiver(journal, present)?[Argument(journal, fail)] ?? -1;
                return journal.Calls * 100 + result;
            }
            public static int Void(bool present, bool fail)
            {
                var journal = new Journal(); journal.Values = new List<int> { 7 };
                var original = journal.Values;
                Receiver(journal, present)?.Add(Argument(journal, fail));
                return journal.Calls * 100 + original.Count * 10 + original[original.Count - 1];
            }
            public static int Nested(int mode)
            {
                Box? root = mode == 0 ? null : new Box();
                if (root != null && mode > 1) { root.Next = new Box(); if (mode > 2) root.Next.Text = "é😀"; }
                return root?.Next?.Text?.Length ?? -1;
            }
            public static int BrokenChain(bool present)
            {
                Box? root = present ? new Box() : null;
                return root?.Text!.Length ?? -1;
            }
            public static int Parenthesized(bool present)
            {
                Box? root = present ? new Box() : null;
                if (root != null) root.Text = "a";
                return (root?.Text)!.Length;
            }
            public static int Repeated()
            {
                var journal = new Journal(); journal.Values = new List<int> { 7 }; var sum = 0;
                for (var i = 0; i < 2; i++) sum += Receiver(journal, i == 0)?[0] ?? -1;
                return sum * 10 + journal.Calls;
            }
        }
        """;
    private static readonly Lazy<CompilationResult> TextCompiled = new(() => Compile(TextSource));
    private static readonly Lazy<CompilationResult> EffectsCompiled = new(() => Compile(EffectsSource));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("é😀")]
    [InlineData(" \t é😀 \r\n")]
    public void NullableTextAccessAndNullComparisonsMatchTheSource(string? value)
    {
        using var oracle = new Oracle(TextSource);
        foreach (var method in new[] { "Measure", "Trim", "Chain", "IsNull", "NullFirst", "NotNull", "ObjectNull" })
        {
            var expected = oracle.Call(method, value);
            var result = Run(TextCompiled.Value, method, ("value", Optional(value)));
            Assert.Equal(expected is int number ? (object)(decimal)number : expected, result is Dictionary<string, object> optional ? Unwrap(optional) : result);
        }
    }

    [Theory]
    [InlineData("Index", false, false)]
    [InlineData("Index", false, true)]
    [InlineData("Index", true, false)]
    [InlineData("Index", true, true)]
    [InlineData("Void", false, false)]
    [InlineData("Void", false, true)]
    [InlineData("Void", true, false)]
    [InlineData("Void", true, true)]
    public void ReceiverIsCapturedOnceAndArgumentsOnlyRunWhenPresent(string method, bool present, bool fail)
    {
        using var oracle = new Oracle(EffectsSource);
        object? expected = null; Exception? thrown = null;
        try { expected = oracle.Call(method, present, fail); }
        catch (TargetInvocationException error) { thrown = error.InnerException; }
        if (thrown != null)
        {
            var actual = Assert.Throws<ReferenceGraphProbe.Failure>(() => Run(EffectsCompiled.Value, method, ("present", present), ("fail", fail)));
            Assert.Equal(thrown.GetType().Name, actual.Kind);
            Assert.Equal(thrown.Message, actual.Message);
        }
        else Assert.Equal(Convert.ToDecimal(expected), Run(EffectsCompiled.Value, method, ("present", present), ("fail", fail)));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void NestedConditionalReceiversRetainTheirLexicalBindings(int mode)
    {
        using var oracle = new Oracle(EffectsSource);
        Assert.Equal(Convert.ToDecimal(oracle.Call("Nested", mode)), Run(EffectsCompiled.Value, "Nested", ("mode", (decimal)mode)));
    }

    [Theory]
    [InlineData("BrokenChain", false)]
    [InlineData("BrokenChain", true)]
    [InlineData("Parenthesized", false)]
    [InlineData("Parenthesized", true)]
    public void OnlyConditionalLinksShortCircuitDereferences(string method, bool present)
    {
        using var oracle = new Oracle(EffectsSource);
        object? expected = null; Exception? thrown = null;
        try { expected = oracle.Call(method, present); }
        catch (TargetInvocationException error) { thrown = error.InnerException; }
        if (thrown != null)
            Assert.Equal(thrown.GetType().Name, Assert.Throws<ReferenceGraphProbe.Failure>(() => Run(EffectsCompiled.Value, method, ("present", present))).Kind);
        else Assert.Equal(Convert.ToDecimal(expected), Run(EffectsCompiled.Value, method, ("present", present)));
    }

    [Fact]
    public void RepeatedEvaluationClearsThePreviousLiftedResult()
    {
        using var oracle = new Oracle(EffectsSource);
        Assert.Equal(Convert.ToDecimal(oracle.Call("Repeated")), Run(EffectsCompiled.Value, "Repeated"));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void NullableValueReceiverLiftsOnceAndPreservesNullableMemberAbsence(bool hasReceiver, bool hasMember)
    {
        const string source = """
            public readonly record struct Pair(int First, int? Second);
            public static class Rules
            {
                public static int First(Pair? pair) => pair?.First ?? -1;
                public static int? Second(Pair? pair) => pair?.Second;
            }
            """;
        using var oracle = new Oracle(source);
        var compiled = Compile(source);
        var pair = oracle.New("Pair", 7, hasMember ? 11 : null);
        var input = new Dictionary<string, object> { ["HasValue"] = hasReceiver, ["Value"] = new Dictionary<string, object> {
            ["First"] = 7m, ["Second"] = new Dictionary<string, object> { ["HasValue"] = hasMember, ["Value"] = 11m }
        } };
        Assert.Equal(Convert.ToDecimal(oracle.Call("First", hasReceiver ? pair : null)), Run(compiled, "First", ("pair", input)));
        var expected = oracle.Call("Second", hasReceiver ? pair : null);
        Assert.Equal(expected == null ? null : Convert.ToDecimal(expected), Unwrap(Assert.IsType<Dictionary<string, object>>(Run(compiled, "Second", ("pair", input)))));
    }

    [Fact]
    public void MissingReferencePresenceAndUserDefinedNullEqualityRemainDiagnosed()
    {
        var raw = Assert.Throws<SourceCompilationException>(() => Compile("public static class Rules { public static int Run(string value) => value?.Length ?? -1; }"));
        Assert.Contains(raw.Diagnostics, diagnostic => diagnostic.Code == "AVCS310" && diagnostic.Message.Contains("presence", StringComparison.Ordinal));
        var custom = Assert.Throws<SourceCompilationException>(() => Compile("""
            public sealed class R { public static bool operator ==(R? a, R? b) => true; public static bool operator !=(R? a, R? b) => false; }
            public static class Rules { public static bool Run(R? value) => value == null; }
            """));
        Assert.Contains(custom.Diagnostics, diagnostic => diagnostic.Code == "AVCS310" && diagnostic.Message.Contains("user-defined", StringComparison.Ordinal));
    }

    private static CompilationResult Compile(string source) => CSharpCompiler.Compile(new Dictionary<string, string> { ["Conditional.cs"] = source });
    private static object Run(CompilationResult compiled, string method, params (string Name, object Value)[] inputs)
        => new ReferenceGraphProbe(compiled.Specification).Run(method, inputs.ToDictionary(input => "Arg_" + input.Name, input => input.Value))["AvResult"];
    private static Dictionary<string, object> Optional(string? text) => new() { ["HasValue"] = text != null, ["Value"] = text ?? "" };
    private static object? Unwrap(Dictionary<string, object> optional) => (bool)optional["HasValue"] ? optional["Value"] : null;
    private sealed class Oracle : IDisposable
    {
        private readonly AssemblyLoadContext context = new("conditional-access-" + Guid.NewGuid(), isCollectible: true);
        private readonly Assembly assembly;
        internal Oracle(string source)
        {
            var program = SourceProgram.Parse(new Dictionary<string, string> { ["Conditional.cs"] = source });
            using var stream = new MemoryStream(); var emitted = program.Compilation.Emit(stream);
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics)); stream.Position = 0;
            assembly = context.LoadFromStream(stream);
        }
        internal object? Call(string name, params object?[] arguments) => assembly.GetType("Rules")!.GetMethod(name)!.Invoke(null, arguments);
        internal object New(string type, params object?[] arguments) => Activator.CreateInstance(assembly.GetType(type)!, arguments)!;
        public void Dispose() => context.Unload();
    }
}
