using System.Reflection;
using System.Runtime.Loader;
using Xunit;

namespace Anvil.CSharp.Tests;

public class ScalarConcatenationTests
{
    private static string Source(bool managed) => """
        public sealed class Counter { public int Value; }
        public static class Rules
        {
            public static string Run(string? text, int number, long large, bool flag, int? optionalNumber, long? optionalLarge, bool? optionalFlag)
            {
        """ + (managed ? "var counter = new Counter(); counter.Value++;" : "") + """
                return text + "|" + number + "|" + large + "|" + flag + "|" + optionalNumber + "|" + optionalLarge + "|" + optionalFlag;
            }
        }
        """;

    [Theory]
    [InlineData(false, false, false, null)]
    [InlineData(false, false, true, "")]
    [InlineData(false, true, false, "é😀")]
    [InlineData(false, true, true, "x")]
    [InlineData(true, false, false, null)]
    [InlineData(true, false, true, "")]
    [InlineData(true, true, false, "é😀")]
    [InlineData(true, true, true, "x")]
    public void ExistingScalarCodecsFormatBothExecutionAbis(bool managed, bool hasValues, bool flag, string? text)
    {
        var source = Source(managed);
        using var oracle = new Oracle(source);
        var expected = oracle.Call("Run", text, int.MinValue, long.MaxValue, flag,
            hasValues ? int.MaxValue : null, hasValues ? long.MinValue : null, hasValues ? flag : null);
        var compiled = Compile(source);
        var actual = Run(compiled, "Run", new() {
            ["Arg_text"] = Optional(text != null, text ?? ""), ["Arg_number"] = (decimal)int.MinValue,
            ["Arg_large"] = (decimal)long.MaxValue, ["Arg_flag"] = flag,
            ["Arg_optionalNumber"] = Optional(hasValues, (decimal)int.MaxValue),
            ["Arg_optionalLarge"] = Optional(hasValues, (decimal)long.MinValue),
            ["Arg_optionalFlag"] = Optional(hasValues, flag)
        });
        Assert.Equal(expected, actual);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(7)]
    public void DirectConcatenationCapturesEarlierOperandsBeforeLaterEffects(int start)
    {
        const string source = """
            public static class Rules
            {
                private static int Keep(int value) => value;
                public static string Run(int value)
                {
                    var prefix = "a";
                    return prefix + (prefix = "b") + prefix + ":" + value++ + ":" + Keep(value++) + ":" + value;
                }
            }
            """;
        using var oracle = new Oracle(source);
        var compiled = Compile(source);
        Assert.DoesNotContain(compiled.SourceMap, entry => entry?["implementation"] != null);
        Assert.Equal(oracle.Call("Run", start), Run(compiled, "Run", new() { ["Arg_value"] = (decimal)start }));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ManagedConcatenationEvaluatesEachCallOnceInSourceOrder(bool absent)
    {
        const string source = """
            public sealed class Counter { public int Value; }
            public static class Rules
            {
                private static string? Left(Counter c, bool absent) { c.Value = c.Value * 10 + 1; return absent ? null : "left"; }
                private static int Right(Counter c) { c.Value = c.Value * 10 + 2; return c.Value; }
                public static string Run(bool absent)
                {
                    var c = new Counter();
                    var text = Left(c, absent) + Right(c);
                    return text + ":" + c.Value;
                }
            }
            """;
        using var oracle = new Oracle(source);
        Assert.Equal(oracle.Call("Run", absent), Run(Compile(source), "Run", new() { ["Arg_absent"] = absent }));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("value")]
    public void LiteralNullOnEitherSideAndNullableOperandsProducePresentText(string? value)
    {
        const string source = """
            public static class Rules
            {
                public static string Left(string? value) => null + value;
                public static string Right(string? value) => value + null;
                public static string Both(string? value) => value + value;
            }
            """;
        using var oracle = new Oracle(source); var compiled = Compile(source);
        foreach (var method in new[] { "Left", "Right", "Both" })
            Assert.Equal(oracle.Call(method, value), Run(compiled, method, new() { ["Arg_value"] = Optional(value != null, value ?? "") }));
    }

    [Theory]
    [InlineData(true, "True")]
    [InlineData(false, "False")]
    public void BooleanCodecUsesClrText(bool value, string expected)
        => Assert.Equal(expected, Run(Compile("public static class Rules { public static string Run(bool value) => \"\" + value; }"), "Run", new() { ["Arg_value"] = value }));

    [Fact]
    public void UnknownScalarAndCustomConversionsAreNotFormattedAsArbitraryObjects()
    {
        var enumeration = Assert.Throws<SourceCompilationException>(() => Compile("public enum State { A } public static class Rules { public static string Run(State value) => \"\" + value; }"));
        Assert.Contains(enumeration.Diagnostics, diagnostic => diagnostic.Code == "AVCS310" && diagnostic.Message.Contains("enum", StringComparison.OrdinalIgnoreCase));
        var custom = Assert.Throws<SourceCompilationException>(() => Compile("""
            public readonly struct Value { public static implicit operator string(Value value) => "custom"; }
            public static class Rules { public static string Run(Value value) => "" + value; }
            """));
        Assert.Contains(custom.Diagnostics, diagnostic => diagnostic.Code == "AVCS310" && diagnostic.Message.Contains("conversion", StringComparison.OrdinalIgnoreCase));
    }

    private static Dictionary<string, object> Optional(bool present, object value) => new() { ["HasValue"] = present, ["Value"] = value };
    private static CompilationResult Compile(string source) => CSharpCompiler.Compile(new Dictionary<string, string> { ["Concat.cs"] = source });
    private static object Run(CompilationResult compiled, string method, Dictionary<string, object> inputs)
    {
        var result = new ReferenceGraphProbe(compiled.Specification).Run(method, inputs)["AvResult"];
        if (result is Dictionary<string, object> optional) { Assert.Equal(true, optional["HasValue"]); return optional["Value"]; }
        return result;
    }
    private sealed class Oracle : IDisposable
    {
        private readonly AssemblyLoadContext context = new("concat-" + Guid.NewGuid(), isCollectible: true);
        private readonly Type rules;
        internal Oracle(string source)
        {
            var program = SourceProgram.Parse(new Dictionary<string, string> { ["Concat.cs"] = source });
            using var stream = new MemoryStream(); var emitted = program.Compilation.Emit(stream);
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics)); stream.Position = 0;
            rules = context.LoadFromStream(stream).GetType("Rules")!;
        }
        internal object? Call(string method, params object?[] arguments) => rules.GetMethod(method)!.Invoke(null, arguments);
        public void Dispose() => context.Unload();
    }
}
