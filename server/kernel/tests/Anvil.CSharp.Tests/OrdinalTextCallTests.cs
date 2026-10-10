using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public sealed class OrdinalTextCallTests
{
    private static readonly Lazy<CompilationResult> Compiled = new(() => CSharpCompiler.CompileReferenceGraph(
        new Dictionary<string, string> { ["OrdinalText.cs"] = Source }));

    [Theory]
    [InlineData(null, null)]
    [InlineData(null, "")]
    [InlineData("", null)]
    [InlineData("", "")]
    [InlineData("z", "a")]
    [InlineData("abc", "abd")]
    [InlineData("same", "same")]
    [InlineData("é", "e")]
    [InlineData("😀", "\uE000")]
    [InlineData("long\0tail", "long\0tags")]
    public void DirectCallPreservesNullAndTheWholePrimitiveResult(string? left, string? right)
    {
        var compiled = Compiled.Value;
        Assert.Equal(FrameworkIntrinsic.CompareOrdinal, Assert.Single(compiled.RequiredIntrinsics!));
        var result = new ReferenceGraphProbe(compiled.Specification).Run("Compare", new Dictionary<string, object> {
            ["Arg_left"] = Text(left), ["Arg_right"] = Text(right) });
        Assert.Equal(string.CompareOrdinal(left, right), Convert.ToInt32(result["AvResult"]));
    }

    [Fact]
    public void PositionalAndNamedArgumentsEvaluateOnceInSourceOrder()
    {
        var result = new ReferenceGraphProbe(Compiled.Value.Specification).Run("EvaluationOrder");
        Assert.Equal(true, result["AvResult"]);
    }

    [Fact]
    public void PublicScalarAuthoringEntryUsesTheSameIntrinsicWithoutAnAuthoredBinding()
    {
        var compiled = CSharpCompiler.Compile(new Dictionary<string, string> { ["Compare.cs"] =
            "#nullable enable\npublic static class Comparison { public static int Compare(string? left, string? right) => string.CompareOrdinal(left, right); }" });
        Assert.Equal(FrameworkIntrinsic.CompareOrdinal, Assert.Single(compiled.RequiredIntrinsics!));
        Assert.Equal(-1, Convert.ToInt32(new ReferenceGraphProbe(compiled.Specification).Run("Compare",
            new Dictionary<string, object> { ["Arg_left"] = Text(null), ["Arg_right"] = Text("") })["AvResult"]));
    }

    private static Dictionary<string, object> Text(string? value) => new() { ["HasValue"] = value != null, ["Value"] = value ?? "" };
    private const string Source = """
        #nullable enable
        public sealed class Box { public string? Text { get; set; } public int Calls { get; set; } }
        public static class Work {
            public static int Compare(string? left, string? right) => string.CompareOrdinal(left, right);
            private static string? Change(Box box) { var previous = box.Text; box.Text = "z"; box.Calls++; return previous; }
            public static bool EvaluationOrder() {
                var box = new Box { Text = "a" };
                var positional = string.CompareOrdinal(box.Text, Change(box));
                box.Text = "a";
                var named = string.CompareOrdinal(strB: Change(box), strA: box.Text);
                return positional == 0 && named > 0 && box.Calls == 2;
            }
        }
        """;
}
