using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public class ReferenceMemberTests
{
    private const string Source = """
        #nullable enable
        public static class R
        {
            private sealed class Entry { public int Value; public int Other { get; set; } = Seed(); }
            private static int Seed() => 7;
            public static string Echo(string input) { var e = new Entry(); e.Value++; return input; }
            public static string Edit(string input, int index, bool missing)
            {
                var e = new Entry { Value = 1 };
                var first = new List<Entry> { e, e };
                List<Entry>? absent = null;
                var copy = new List<Entry>(missing ? absent! : first);
                copy.RemoveAt(index);
                e.Value += copy.Count;
                return (input == null ? "null" : "text:" + input.Length + ":" + input) + "/" + first.Count + "/" + first[0].Value + "/" + copy[0].Other;
            }
            public static int NamedException()
            {
                var e = new Entry();
                throw new ArgumentOutOfRangeException(message: Message(e), actualValue: Actual(e), paramName: Parameter(e));
            }
            private static string Message(Entry e) { e.Value++; return "seen:" + e.Value; }
            private static int Actual(Entry e) { e.Value += 10; return e.Value; }
            private static string Parameter(Entry e) { e.Value += 100; return "p" + e.Value; }
        }
        """;
    private static readonly Lazy<CompilationResult> Compiled = new(() => CSharpCompiler.Compile(new Dictionary<string, string> { ["Members.cs"] = Source }));
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("é😀")]
    public void NonAnnotatedTextBoundaryPreservesNullAndUtf16(string? text)
    {
        using var oracle = new Oracle();
        Assert.Equal(text, oracle.Call("Echo", text));
        var inputs = new Dictionary<string, object> { ["Arg_input"] = TextInput(text) };
        var probe = new ReferenceGraphProbe(Compiled.Value.Specification);
        foreach (var action in new[] { "Echo", Implementation("Echo") })
        {
            var result = Fields(probe.Run(action, inputs)["AvResult"]);
            Assert.Equal(text != null, result["HasValue"]);
            if (text != null) Assert.Equal(text, result["Value"]);
        }
    }
    [Theory]
    [InlineData(null, 0, false)]
    [InlineData("", 1, false)]
    [InlineData("é😀", 0, false)]
    [InlineData("x", -1, false)]
    [InlineData("x", 2, false)]
    [InlineData("x", 0, true)]
    public void CopyIsShallowRemovalPreservesObjectsAndInvalidInputsMatchClr(string? text, int index, bool missing)
    {
        using var oracle = new Oracle();
        object? expected = null; Exception? failure = null;
        try { expected = oracle.Call("Edit", text, index, missing); } catch (TargetInvocationException error) { failure = error.InnerException; }
        var inputs = new Dictionary<string, object> { ["Arg_input"] = TextInput(text), ["Arg_index"] = (decimal)index, ["Arg_missing"] = missing };
        var probe = new ReferenceGraphProbe(Compiled.Value.Specification);
        var result = probe.Run(Implementation("Edit"), inputs);
        if (failure == null)
        {
            Assert.Equal(expected, Fields(result["AvResult"])["Value"]);
            Assert.Equal(expected, Fields(probe.Run("Edit", inputs)["AvResult"])["Value"]);
        }
        else
        {
            var exception = Exception(result);
            Assert.Equal(failure.GetType().FullName, exception["TypeName"]);
            Assert.Equal(failure.Message, exception["Message"]);
            Assert.Equal(((ArgumentException)failure).ParamName, exception["ParamName"]);
            var raised = Assert.Throws<ReferenceGraphProbe.Failure>(() => probe.Run("Edit", inputs));
            Assert.Equal(failure.Message, raised.Message);
        }
    }
    [Fact]
    public void ExceptionConstructorEvaluatesNamedArgumentsInSourceOrderAndStoresTypedActualValue()
    {
        using var oracle = new Oracle();
        var failed = Assert.Throws<TargetInvocationException>(() => oracle.Call("NamedException"));
        var expected = Assert.IsType<ArgumentOutOfRangeException>(failed.InnerException);
        Assert.Equal(11, expected.ActualValue); Assert.Equal("p111", expected.ParamName);
        var output = new ReferenceGraphProbe(Compiled.Value.Specification).Run(Implementation("NamedException"));
        var exception = Exception(output);
        Assert.Equal(expected.Message, exception["Message"]);
        Assert.Equal(11m, exception["ActualValueInteger"]);
        Assert.Equal("System.Int32", exception["ActualValueType"]);
        Assert.Contains(Fields(output["AvContextOut"]).Values.OfType<List<object>>().SelectMany(l => l).OfType<Dictionary<string, object>>(), cell => cell.GetValueOrDefault("Value") is decimal number && number == 111);
    }
    [Fact]
    public void FieldsAndPropertiesShareTheDataShapeWithoutConvertingEntityStorageToAnArena()
    {
        const string source = "public class Reading { public int Amount; public string? Note {get;set;} }";
        var compiled = CSharpCompiler.CompileData(new Dictionary<string, string> { ["Data.cs"] = source });
        var reading = compiled.Specification["data"]!["structures"]!.AsArray().Single(s => s!["name"]!.ToString() == "Reading")!;
        Assert.Equal(new[] { "Amount", "Note" }, reading["attributes"]!.AsArray().Select(a => a!["name"]!.ToString()));
        Assert.DoesNotContain("AvReferenceContext", compiled.Specification.ToJsonString());
        var error = Assert.Throws<SourceCompilationException>(() => CSharpCompiler.CompileData(new Dictionary<string, string> {
            ["Data.cs"] = "[System.ComponentModel.DataAnnotations.Schema.Table(\"Reading\")] public class Reading { public int Amount; }" }));
        Assert.Contains(error.Diagnostics, diagnostic => diagnostic.Code == "AVCS104");
    }
    private static Dictionary<string, object> TextInput(string? value) => new() { ["HasValue"] = value != null, ["Value"] = value ?? "" };
    private static string Implementation(string name) => Compiled.Value.SourceMap.OfType<JsonObject>().Single(m => m["source"]?.ToString().StartsWith("R." + name + "(", StringComparison.Ordinal) == true)["implementation"]!.ToString();
    private static Dictionary<string, object> Fields(object value) => Assert.IsType<Dictionary<string, object>>(value);
    private static Dictionary<string, object> Exception(Dictionary<string, object> output)
    {
        var completion = Fields(output["AvCompletion"]); Assert.Equal(2m, completion["Kind"]);
        return Fields(((List<object>)Fields(output["AvContextOut"])["Exceptions"])[(int)(decimal)completion["ExceptionRef"] - 1]);
    }
    private sealed class Oracle : IDisposable
    {
        private readonly AssemblyLoadContext context = new("reference-members-" + Guid.NewGuid(), isCollectible: true);
        private readonly Type type;
        public Oracle()
        {
            using var stream = new MemoryStream(); var result = SourceProgram.Parse(new Dictionary<string, string> { ["Members.cs"] = Source }).Compilation.Emit(stream);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics)); stream.Position = 0;
            type = context.LoadFromStream(stream).GetType("R")!;
        }
        public object? Call(string name, params object?[] arguments) => type.GetMethod(name)!.Invoke(null, arguments);
        public void Dispose() => context.Unload();
    }
}
