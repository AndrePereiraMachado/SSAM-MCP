using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public class OptionalTextBoundaryTests
{
    private const string Source = """
        #nullable enable
        public sealed class Cell { public int Value; }
        public static class R
        {
            public static string DefaultText(string value = "é😀") { var c = new Cell(); c.Value++; return Describe(value); }
            public static string DefaultNull(string? value = null) { var c = new Cell(); c.Value++; return Describe(value); }
            public static string DefaultEmpty(string value = "") { var c = new Cell(); c.Value++; return Describe(value); }
            public static string Pair(string? left = "left", string? right = "right") { var c = new Cell(); c.Value++; return Describe(left) + "/" + Describe(right); }
            private static string Describe(string? value) { if (value == null) return "null"; return "text:" + value.Length + ":" + value; }
            private static string Helper(Cell c, string? value = null, string suffix = "tail") { c.Value++; return Describe(value) + "/" + suffix; }
            private static string Stamp(Cell c, string label) { c.Value = c.Value * 10 + 1; return label + c.Value; }
            public static string Calls(int mode)
            {
                var c = new Cell();
                if (mode == 0) return Helper(c);
                if (mode == 1) return Helper(c, "");
                if (mode == 2) return Helper(c, suffix: "", value: null);
                if (mode == 3) return DefaultText() + "/" + DefaultNull() + "/" + DefaultEmpty();
                var result = Helper(suffix: Stamp(c, "S"), value: Stamp(c, "V"), c: c);
                return result + "/" + c.Value;
            }
        }
        """;
    private static readonly Lazy<CompilationResult> Compiled = new(() => CSharpCompiler.Compile(new Dictionary<string, string> { ["OptionalText.cs"] = Source }));
    [Theory]
    [InlineData("DefaultText", false, null)]
    [InlineData("DefaultText", true, null)]
    [InlineData("DefaultText", true, "")]
    [InlineData("DefaultText", true, "é😀")]
    [InlineData("DefaultNull", false, null)]
    [InlineData("DefaultNull", true, null)]
    [InlineData("DefaultNull", true, "")]
    [InlineData("DefaultEmpty", false, null)]
    [InlineData("DefaultEmpty", true, null)]
    [InlineData("DefaultEmpty", true, "x")]
    public void OmissionAndExplicitNullOrEmptyUseDistinctBoundaryStates(string method, bool specified, string? text)
    {
        using var oracle = new Oracle();
        var expected = oracle.Call(method, specified ? text : Type.Missing);
        var inputs = new Dictionary<string, object>();
        if (specified) inputs.Add("Arg_value", Argument(true, text));
        Assert.Equal(expected, Result(new ReferenceGraphProbe(Compiled.Value.Specification).Run(method, inputs)));
        // Even stale payload bits in an unspecified argument cannot override the source default.
        if (!specified)
            Assert.Equal(expected, Result(new ReferenceGraphProbe(Compiled.Value.Specification).Run(method,
                new Dictionary<string, object> { ["Arg_value"] = Argument(false, "stale") })));
    }
    [Theory]
    [InlineData(false, null, false, null)]
    [InlineData(true, null, false, null)]
    [InlineData(false, null, true, "")]
    [InlineData(true, "", true, null)]
    public void EachNamedBoundaryArgumentRetainsItsOwnOmissionState(bool hasLeft, string? left, bool hasRight, string? right)
    {
        using var oracle = new Oracle();
        var expected = oracle.Call("Pair", hasLeft ? left : Type.Missing, hasRight ? right : Type.Missing);
        var inputs = new Dictionary<string, object>();
        if (hasRight) inputs["Arg_right"] = Argument(true, right);
        if (hasLeft) inputs["Arg_left"] = Argument(true, left);
        Assert.Equal(expected, Result(new ReferenceGraphProbe(Compiled.Value.Specification).Run("Pair", inputs)));
    }
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    public void SourceCallsBindDefaultsAndNamedArgumentsBeforeEnteringTheCallee(int mode)
    {
        using var oracle = new Oracle();
        var expected = oracle.Call("Calls", mode);
        Assert.Equal(expected, Result(new ReferenceGraphProbe(Compiled.Value.Specification).Run("Calls", new Dictionary<string, object> { ["Arg_mode"] = (decimal)mode })));
    }
    [Fact]
    public void OptionalTextNeverEmitsAScalarDefaultForAStructureParameter()
    {
        var compiled = Compiled.Value;
        var actions = compiled.Specification["logic"]!["actions"]!.AsArray().OfType<JsonObject>().ToArray();
        var entry = actions.Single(a => a["name"]!.ToString() == "DefaultText");
        var parameter = Assert.Single(entry["inputs"]!.AsArray());
        Assert.False(parameter!["mandatory"]!.GetValue<bool>());
        Assert.Null(parameter["default"]);
        var structure = compiled.Specification["data"]!["structures"]!.AsArray().Single(s => s!["name"]!.ToString() == parameter["type"]!.ToString())!;
        Assert.True(structure["public"]!.GetValue<bool>());
        Assert.Equal(new[] { "IsSpecified", "Value" }, structure["attributes"]!.AsArray().Select(a => a!["name"]!.ToString()));
        var implementationName = compiled.SourceMap.OfType<JsonObject>().Single(m => m["source"]?.ToString().StartsWith("R.DefaultText(", StringComparison.Ordinal) == true)["implementation"]!.ToString();
        var internalInput = actions.Single(a => a["name"]!.ToString() == implementationName)["inputs"]!.AsArray().Single(p => p!["name"]!.ToString() == "Arg_value")!;
        Assert.NotEqual(parameter["type"]!.ToString(), internalInput["type"]!.ToString());
        Assert.Null(internalInput["default"]);
        Assert.NotEqual(false, internalInput["mandatory"]?.GetValue<bool>());
    }
    private static Dictionary<string, object> Argument(bool specified, string? text) => new() {
        ["IsSpecified"] = specified, ["Value"] = new Dictionary<string, object> { ["HasValue"] = text != null, ["Value"] = text ?? "" }
    };
    private static object Result(Dictionary<string, object> output)
    {
        var result = Assert.IsType<Dictionary<string, object>>(output["AvResult"]);
        Assert.True((bool)result["HasValue"]); return result["Value"];
    }
    private sealed class Oracle : IDisposable
    {
        private readonly AssemblyLoadContext context = new("optional-text-" + Guid.NewGuid(), isCollectible: true);
        private readonly Type type;
        public Oracle()
        {
            using var stream = new MemoryStream(); var result = SourceProgram.Parse(new Dictionary<string, string> { ["OptionalText.cs"] = Source }).Compilation.Emit(stream);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics)); stream.Position = 0;
            type = context.LoadFromStream(stream).GetType("R")!;
        }
        public object? Call(string name, params object?[] arguments) => type.GetMethod(name)!.Invoke(null, arguments);
        public void Dispose() => context.Unload();
    }
}
