using System.Globalization;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.Loader;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public sealed class ExceptionValueTests
{
    private static readonly Lazy<CompilationResult> Compiled = new(() => Compile(Source));
    private static CompilationResult Compile(string source) => CSharpCompiler.Compile(new Dictionary<string, string> { ["ExceptionValues.cs"] = source });

    [Theory]
    [InlineData("Exception")]
    [InlineData("SystemException")]
    [InlineData("ApplicationException")]
    [InlineData("ArgumentException")]
    [InlineData("ArgumentNullException")]
    [InlineData("ArgumentOutOfRangeException")]
    [InlineData("InvalidOperationException")]
    [InlineData("NullReferenceException")]
    [InlineData("IndexOutOfRangeException")]
    [InlineData("OverflowException")]
    [InlineData("DivideByZeroException")]
    [InlineData("NotSupportedException")]
    [InlineData("InvalidCastException")]
    [InlineData("FormatException")]
    public void NullEmptyAndExplicitMessagesMatchTheRunningClr(string type)
    {
        var prefix = type is "ArgumentNullException" or "ArgumentOutOfRangeException" ? "null, " : "";
        var source = "public static class Rules { public static string Metadata(string? message) { Exception value = new " + type + "(" + prefix + "message); return value.Message; } }";
        using var fixture = new Fixture(source);
        foreach (var message in new string?[] { null, "", "explicit message" }) {
            var expected = fixture.Clr("Metadata", new object?[] { message });
            var native = fixture.Native("Metadata", ("message", new Dictionary<string, object> { ["HasValue"] = message != null, ["Value"] = message ?? "" }));
            Assert.Equal(expected, Record(native["AvResult"])["Value"]);
            Assert.Single(Pool(native));
        }
    }

    [Fact]
    public void ConstructionPrivateCallsAndThrowReuseOnePoolIdentity()
    {
        using var fixture = new Fixture();
        var clr = Assert.IsType<InvalidOperationException>(fixture.Clr("Make"));
        Assert.Same(clr, fixture.Clr("Identity", clr));
        Assert.Same(clr, Assert.Throws<InvalidOperationException>(() => fixture.Clr("ThrowValue", clr)));

        var created = fixture.Native("Make"); var handle = Record(created["AvResult"]);
        Assert.Equal(1m, handle["Index"]); Assert.Single(Pool(created));
        Assert.Equal(1m, Record(created["AvCompletion"])["Kind"]);
        var same = fixture.Native("Identity", ("value", handle), ("AvContextIn", created["AvContextOut"]));
        Assert.Equal(handle, Record(same["AvResult"])); Assert.Single(Pool(same));
        var thrown = fixture.Native("ThrowValue", ("value", handle), ("AvContextIn", same["AvContextOut"]));
        Assert.Equal(2m, Record(thrown["AvCompletion"])["Kind"]);
        Assert.Equal(handle["Index"], Record(thrown["AvCompletion"])["ExceptionRef"]);
        Assert.Single(Pool(thrown));
        var rethrownValue = fixture.Native("ThrowValue", ("value", handle), ("AvContextIn", thrown["AvContextOut"]));
        Assert.Single(Pool(rethrownValue)); Assert.Equal(handle["Index"], Record(rethrownValue["AvCompletion"])["ExceptionRef"]);
        Assert.Equal(clr.Message, Record(Pool(created)[0])["Message"]);
        Assert.Equal((decimal)clr.HResult, Record(Pool(created)[0])["HResult"]);
        Assert.Empty(Compiled.Value.SourceAbis!);
        if (Environment.GetEnvironmentVariable("ANVIL_EXCEPTION_VALUE_PROOF_DIRECTORY") is { Length: > 0 } folder)
        {
            Directory.CreateDirectory(folder);
            File.WriteAllText(Path.Combine(folder, "ExceptionValues.cs"), Source);
            File.WriteAllText(Path.Combine(folder, "source-hash.txt"), Compiled.Value.SourceHash);
            File.WriteAllText(Path.Combine(folder, "contract.json"), Compiled.Value.Specification.ToJsonString());
            File.WriteAllText(Path.Combine(folder, "source-map.json"), Compiled.Value.SourceMap.ToJsonString());
        }
    }

    [Theory]
    [InlineData("Aliases", true, 2)]
    [InlineData("LocalState", true, 1)]
    [InlineData("ValueState", true, 1)]
    [InlineData("Inner", true, 2)]
    [InlineData("CoalesceMissing", true, 1)]
    [InlineData("CoalescePresent", true, 1)]
    public void NativeIdentityAndEffectsAgreeWithExplicitClrOutcomes(string method, bool expected, int poolCount)
    {
        using var fixture = new Fixture();
        Assert.Equal(expected, fixture.Clr(method));
        var output = fixture.Native(method);
        Assert.Equal(expected, output["AvResult"]); Assert.Equal(poolCount, Pool(output).Count);
        Assert.Equal(1m, Record(output["AvCompletion"])["Kind"]);
        if (method == "Inner") Assert.Equal(1m, Record(Pool(output)[1])["InnerRef"]);
        if (method == "LocalState")
        {
            var context = Record(output["AvContextOut"]);
            var state = context.Where(pair => pair.Key != "Exceptions" && pair.Value is List<object> { Count: > 0 })
                .SelectMany(pair => (List<object>)pair.Value).Select(Record).Single(record => record.ContainsKey("Original"));
            Assert.Equal(Record(state["Original"])["Index"], Record(state["Alias"])["Index"]);
            Assert.Equal(1m, Record(state["Original"])["Index"]);
        }
    }

    [Theory]
    [InlineData("ThrowNull")]
    [InlineData("ThrowLiteral")]
    [InlineData("ReadNull")]
    public void NullExceptionUseAllocatesAFreshNullReferenceFailure(string method)
    {
        using var fixture = new Fixture();
        Assert.Throws<NullReferenceException>(() => fixture.Clr(method));
        var first = fixture.Native(method);
        Assert.Equal(2m, Record(first["AvCompletion"])["Kind"]);
        Assert.Equal(1m, Record(first["AvCompletion"])["ExceptionRef"]);
        Assert.Equal("System.NullReferenceException", Record(Assert.Single(Pool(first)))["TypeName"]);
        var second = fixture.Native(method, ("AvContextIn", first["AvContextOut"]));
        Assert.Equal(2, Pool(second).Count); Assert.Equal(2m, Record(second["AvCompletion"])["ExceptionRef"]);
    }

    [Fact]
    public void ConstructorArgumentsKeepSourceOrderAndActualValuePayload()
    {
        using var fixture = new Fixture();
        const string expected = "123|bad (Parameter 'limit')\r\nActual value was 5.";
        Assert.Equal(expected, fixture.Clr("ConstructorEffects"));
        var output = fixture.Native("ConstructorEffects");
        Assert.Equal(expected, Record(output["AvResult"])["Value"]);
        var exception = Record(Assert.Single(Pool(output)));
        Assert.Equal("limit", exception["ParamName"]); Assert.Equal(true, exception["HasParamName"]);
        Assert.Equal(5m, exception["ActualValueInteger"]); Assert.Equal(true, exception["HasActualValue"]);
    }

    [Theory]
    [InlineData("Exception")]
    [InlineData("SystemException")]
    [InlineData("ApplicationException")]
    [InlineData("ArgumentException")]
    [InlineData("ArgumentNullException")]
    [InlineData("ArgumentOutOfRangeException")]
    [InlineData("InvalidOperationException")]
    [InlineData("NullReferenceException")]
    [InlineData("IndexOutOfRangeException")]
    [InlineData("OverflowException")]
    [InlineData("DivideByZeroException")]
    [InlineData("NotSupportedException")]
    [InlineData("InvalidCastException")]
    [InlineData("FormatException")]
    public void BuiltinTypeNameMessageAndHResultComeFromTheConstructedException(string type)
    {
        var source = "public static class Rules { public static string Metadata() { Exception value = new " + type + "(); return value.GetType().Name + \"|\" + value.Message + \"|\" + value.HResult; } }";
        using var fixture = new Fixture(source);
        var expected = (Exception)Activator.CreateInstance(typeof(Exception).Assembly.GetType("System." + type)!)!;
        var text = type + "|" + expected.Message + "|" + expected.HResult.ToString(CultureInfo.InvariantCulture);
        Assert.Equal(text, fixture.Clr("Metadata"));
        var output = fixture.Native("Metadata");
        Assert.Equal(text, Record(output["AvResult"])["Value"]);
        Assert.Single(Pool(output));
    }

    [Theory]
    [InlineData("public static class Rules { public static Exception Export() => new Exception(); }", "AVCS347")]
    [InlineData("public sealed class State { public Exception? Error; } public static class Rules { public static bool Read(State state) => state.Error == null; }", "AVCS347")]
    [InlineData("public static class Rules { public static bool Cast() { Exception e = new InvalidOperationException(); return ((ArgumentException)e).Message == \"x\"; } }", "AVCS310")]
    [InlineData("public static class Rules { public static bool Cast() { Exception e = new ArgumentException(); return (e as ArgumentException) == null; } }", "AVCS310")]
    [InlineData("public class Custom : Exception { public Custom() { } } public static class Rules { public static int Fail() { throw new Custom(); } }", "AVCS103")]
    [InlineData("public class Custom : Exception { } public static class Rules { public static int Fail() { throw new Custom(); } }", "AVCS310")]
    [InlineData("public static class Rules { public static bool Make() { var e = new Exception { Source = \"changed\" }; return e != null; } }", "AVCS310")]
    [InlineData("public struct State { public Exception? Error; } public static class Rules { public static bool Make() { var value = new State { Error = new Exception() }; return value.Error != null; } }", "AVCS310")]
    [InlineData("public static class Rules { public static int Fail() { throw; } }", "CS0156")]
    public void MissingBoundaryCastConstructorAndRethrowSemanticsRemainExplicit(string source, string diagnostic)
    {
        var failure = Assert.Throws<SourceCompilationException>(() => Compile("#nullable enable\n" + source));
        Assert.Contains(failure.Diagnostics, item => item.Code == diagnostic);
    }

    [Fact]
    public void SourceTypeSpelledSystemExceptionIsNotTheBclExceptionIdentity()
    {
        const string source = "namespace System { public sealed class Exception { public int Code; } } public static class Rules { public static int Read() { var value = new System.Exception { Code = 8 }; return value.Code; } }";
        using var fixture = new Fixture(source);
        Assert.Equal(8, fixture.Clr("Read"));
        var output = fixture.Native("Read"); Assert.Equal(8m, output["AvResult"]); Assert.Empty(Pool(output));
    }

    private static Dictionary<string, object> Record(object value) => Assert.IsType<Dictionary<string, object>>(value);
    private static List<object> Pool(Dictionary<string, object> output) => Assert.IsType<List<object>>(Record(output["AvContextOut"])["Exceptions"]);
    private sealed class Fixture : IDisposable
    {
        private readonly AssemblyLoadContext context = new("exception-value-oracle-" + Guid.NewGuid(), isCollectible: true);
        private readonly Assembly assembly;
        private readonly CompilationResult compiled;
        internal Fixture(string? source = null)
        {
            compiled = source == null ? Compiled.Value : Compile(source);
            using var bytes = new MemoryStream(); var result = SourceProgram.Parse(new Dictionary<string, string> { ["ExceptionValues.cs"] = source ?? Source }).Compilation.Emit(bytes);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics)); bytes.Position = 0; assembly = context.LoadFromStream(bytes);
        }
        internal object? Clr(string method, params object?[] arguments)
        {
            try { return assembly.GetType("Rules")!.GetMethod(method, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!.Invoke(null, arguments); }
            catch (TargetInvocationException failure) when (failure.InnerException != null) { ExceptionDispatchInfo.Capture(failure.InnerException).Throw(); throw; }
        }
        internal Dictionary<string, object> Native(string method, params (string Name, object Value)[] arguments)
        {
            var mapping = compiled.SourceMap.OfType<JsonObject>().Single(item => item["source"]!.ToString().StartsWith("Rules." + method + "(", StringComparison.Ordinal));
            return new ReferenceGraphProbe(compiled.Specification).Run(mapping["implementation"]?.ToString() ?? mapping["native"]!.ToString(),
                arguments.ToDictionary(item => item.Name == "AvContextIn" ? item.Name : "Arg_" + item.Name, item => item.Value));
        }
        public void Dispose() => context.Unload();
    }

    private const string Source = """
        #nullable enable
        public sealed class FailureState { public Exception? Original; public Exception? Alias; public int Trace; }
        public readonly record struct FailureValue(Exception? Error);
        public static class Rules {
            private static Exception Make() => new InvalidOperationException("held");
            private static Exception Identity(Exception value) => value;
            private static int ThrowValue(Exception value) { throw value; }
            public static bool Aliases() { var first = new ArgumentException("same"); var second = new ArgumentException("same"); Exception alias = first; return ReferenceEquals(first, alias) && !ReferenceEquals(first, second) && first == alias && first != second; }
            public static bool LocalState() { var state = new FailureState(); state.Original = Make(); state.Alias = Identity(state.Original); return ReferenceEquals(state.Original, state.Alias); }
            public static bool ValueState() { var state = new FailureValue(Make()); var copy = state; return ReferenceEquals(state.Error, copy.Error); }
            public static bool Inner() { var inner = new Exception("inner"); var outer = new InvalidOperationException("outer", inner); return ReferenceEquals(outer.InnerException, inner) && outer.InnerException!.Message == "inner"; }
            public static bool CoalesceMissing() { Exception? missing = null; var chosen = missing ?? Make(); return missing == null && chosen != null && !ReferenceEquals(missing, chosen); }
            public static bool CoalescePresent() { Exception? value = Make(); var chosen = value ?? Make(); return ReferenceEquals(value, chosen) && !ReferenceEquals(value, null); }
            private static int ThrowNull() { Exception? value = null; throw value; }
            private static int ThrowLiteral() { throw null!; }
            private static int ReadNull() { Exception? value = null; return value!.HResult; }
            public static string ConstructorEffects() { var state = new FailureState(); var value = new ArgumentOutOfRangeException(message: Message(state), paramName: Parameter(state), actualValue: Actual(state)); return state.Trace + "|" + value.Message; }
            private static string Message(FailureState state) { state.Trace = state.Trace * 10 + 1; return "bad"; }
            private static string Parameter(FailureState state) { state.Trace = state.Trace * 10 + 2; return "limit"; }
            private static int Actual(FailureState state) { state.Trace = state.Trace * 10 + 3; return 5; }
        }
        """;
}
