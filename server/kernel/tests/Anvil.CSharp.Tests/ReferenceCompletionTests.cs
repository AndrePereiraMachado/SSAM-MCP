using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.Loader;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Xunit;

namespace Anvil.CSharp.Tests;

/// <summary>Tests generated leaf failures and context returns, without claiming lexical handler semantics.</summary>
public class ReferenceCompletionTests
{
    private const string Source = """
        public sealed class C
        {
            public int Value { get; set; }
        }
        public static class Rules
        {
            public static int Run(int day)
            {
                var c = new C();
                c.Value = 1;
                Leaf(c, day);
                return c.Value;
            }
            private static void Leaf(C c, int day)
            {
                c.Value = 2;
                DateOnly.FromDayNumber(day);
            }
            public static int RunException(int messageKind)
            {
                var c = new C();
                c.Value = 1;
                ExceptionLeaf(c, messageKind);
                return c.Value;
            }
            private static void ExceptionLeaf(C c, int messageKind)
            {
                c.Value = 2;
                if (messageKind == 0) throw new InvalidOperationException((string?)null);
                throw new InvalidOperationException();
            }
        }
        """;

    private static readonly Lazy<CompilationResult> Compiled = new(() => CSharpCompiler.Compile(
        new Dictionary<string, string> { ["ReferenceCompletion.cs"] = Source }));

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void TemporalLeafPreservesEarlierMutationOnNormalAndGeneratedThrowCompletion(int day)
    {
        var compiled = Compiled.Value;
        using var oracle = new ClrOracle();
        var c = oracle.NewC();
        oracle.SetValue(c, 1);
        var expectedFailure = Record.Exception(() => oracle.Call("Leaf", c, day));
        var native = Run(compiled, "Run", true, ("day", day));
        Assert.Equal((decimal)oracle.Value(c), NativeValue(compiled, native));
        Assert.Equal(2m, NativeValue(compiled, native));

        if (expectedFailure == null)
        {
            var completion = Fields(native["AvCompletion"]);
            Assert.Contains((decimal)completion["Kind"], new[] { 0m, 1m });
            Assert.Equal(0m, completion["ExceptionRef"]);
            Assert.Empty(Assert.IsType<List<object>>(Fields(native["AvContextOut"])["Exceptions"]));
            var expected = (decimal)(int)oracle.Call("Run", day)!;
            Assert.Equal(expected, native["AvResult"]);
            Assert.Equal(expected, Run(compiled, "Run", false, ("day", day))["AvResult"]);
        }
        else
        {
            Assert.IsType<ArgumentOutOfRangeException>(expectedFailure);
            AssertFailure(native, expectedFailure);
            AssertBoundaryFailure(compiled, "Run", expectedFailure, ("day", day));
            var rootFailure = Assert.Throws<ArgumentOutOfRangeException>(() => oracle.Call("Run", day));
            Assert.Equal(expectedFailure.Message, rootFailure.Message);
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    public void NullMessageAndNoArgumentExceptionsKeepRuntimeClrMessagesAndPriorMutation(int messageKind)
    {
        var compiled = Compiled.Value;
        using var oracle = new ClrOracle();
        var c = oracle.NewC();
        oracle.SetValue(c, 1);
        var expected = Assert.Throws<InvalidOperationException>(() => oracle.Call("ExceptionLeaf", c, messageKind));
        Assert.NotEmpty(expected.Message);
        // Some CLR versions return the same default text for both constructors. Fidelity is to
        // the running CLR, not an assumption that the two messages must always differ.
        var expectedMessage = messageKind == 0 ? new InvalidOperationException((string?)null).Message : new InvalidOperationException().Message;
        Assert.Equal(expectedMessage, expected.Message);

        var native = Run(compiled, "RunException", true, ("messageKind", messageKind));
        Assert.Equal((decimal)oracle.Value(c), NativeValue(compiled, native));
        Assert.Equal(2m, NativeValue(compiled, native));
        AssertFailure(native, expected);
        AssertBoundaryFailure(compiled, "RunException", expected, ("messageKind", messageKind));
        var rootFailure = Assert.Throws<InvalidOperationException>(() => oracle.Call("RunException", messageKind));
        Assert.Equal(expected.Message, rootFailure.Message);
    }

    private static void AssertFailure(Dictionary<string, object> output, Exception expected)
    {
        var completion = Fields(output["AvCompletion"]);
        Assert.Equal(2m, completion["Kind"]);
        var exceptions = Assert.IsType<List<object>>(Fields(output["AvContextOut"])["Exceptions"]);
        Assert.Single(exceptions);
        var index = Convert.ToInt32(completion["ExceptionRef"]);
        Assert.InRange(index, 1, exceptions.Count);
        var exception = Fields(exceptions[index - 1]);
        Assert.Equal(expected.GetType().FullName, exception["TypeName"]);
        Assert.Equal(expected.Message, exception["Message"]);
    }

    private static void AssertBoundaryFailure(CompilationResult compiled, string method, Exception expected,
        params (string Name, object Value)[] inputs)
    {
        var failure = Assert.Throws<ReferenceGraphProbe.Failure>(() => Run(compiled, method, false, inputs));
        Assert.Equal(expected.GetType().Name, failure.Kind);
        Assert.Equal(expected.Message, failure.Message);
    }

    private static decimal NativeValue(CompilationResult compiled, Dictionary<string, object> output)
    {
        var cell = Structures(compiled).Single(structure => Name(structure).StartsWith("AvCell_", StringComparison.Ordinal)
            && Children(structure, "attributes").Count() == 1
            && Children(structure, "attributes").Any(attribute => Name(attribute) == "Value" && attribute["type"]!.ToString() == "Integer"));
        var action = compiled.Specification["logic"]!["actions"]!.AsArray().OfType<JsonObject>()
            .Single(candidate => Name(candidate) == Implementation(compiled, "Run"));
        var contextType = Children(action, "outputs").Single(parameter => Name(parameter) == "AvContextOut")["type"]!.ToString();
        var context = Structures(compiled).Single(structure => Name(structure) == contextType);
        var arena = Children(context, "attributes").Single(attribute => attribute["type"]!.ToString() == Name(cell) + " List");
        var cells = Assert.IsType<List<object>>(Fields(output["AvContextOut"])[Name(arena)]);
        return (decimal)Fields(Assert.Single(cells))["Value"];
    }

    private static Dictionary<string, object> Run(CompilationResult compiled, string method, bool implementation,
        params (string Name, object Value)[] inputs)
        => new ReferenceGraphProbe(compiled.Specification).Run(implementation ? Implementation(compiled, method)
            : Mapping(compiled, method)["native"]!.ToString(), inputs.ToDictionary(input => "Arg_" + input.Name, input => input.Value));
    private static JsonObject Mapping(CompilationResult compiled, string method)
        => compiled.SourceMap.OfType<JsonObject>().Single(entry => entry["source"]?.ToString()
            .StartsWith("Rules." + method + "(", StringComparison.Ordinal) == true);
    private static string Implementation(CompilationResult compiled, string method)
    {
        var mapping = Mapping(compiled, method);
        return mapping["implementation"]?.ToString() ?? "AvImpl_" + mapping["native"]!.ToString();
    }
    private static IEnumerable<JsonObject> Structures(CompilationResult compiled)
        => compiled.Specification["data"]!["structures"]!.AsArray().OfType<JsonObject>();
    private static IEnumerable<JsonObject> Children(JsonObject owner, string collection)
        => (owner[collection] as JsonArray)?.OfType<JsonObject>() ?? Enumerable.Empty<JsonObject>();
    private static string Name(JsonObject value) => value["name"]!.ToString();
    private static Dictionary<string, object> Fields(object value) => Assert.IsType<Dictionary<string, object>>(value);

    private sealed class ClrOracle : IDisposable
    {
        private readonly AssemblyLoadContext context = new("ReferenceCompletionClrOracle", isCollectible: true);
        private readonly Type rules;
        private readonly Type cell;
        public ClrOracle()
        {
            using var stream = new MemoryStream();
            var emitted = SourceProgram.Parse(new Dictionary<string, string> { ["ReferenceCompletion.cs"] = Source }).Compilation.Emit(stream);
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            stream.Position = 0;
            var assembly = context.LoadFromStream(stream);
            rules = assembly.GetType("Rules")!;
            cell = assembly.GetType("C")!;
        }
        public object NewC() => Activator.CreateInstance(cell)!;
        public int Value(object instance) => (int)cell.GetProperty("Value")!.GetValue(instance)!;
        public void SetValue(object instance, int value) => cell.GetProperty("Value")!.SetValue(instance, value);
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
