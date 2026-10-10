using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Xunit;

namespace Anvil.CSharp.Tests;

public class ReferencePlaceBoundaryTests
{
    public static IEnumerable<object[]> Cases()
    {
        yield return ["nullable-temporal-result", """
            class C { public TimeSpan? Value {get;set;} }
            public static class R { public static bool Run() {
                var c=new C(); c.Value=TimeSpan.Zero;
                return (c.Value += TimeSpan.FromTicks(1)).HasValue;
            }}
            """];
        yield return ["absent-text-dereference", """
            class C { public string Value {get;set;} }
            public static class R { public static int Run() { var c=new C(); return c.Value.Length; }}
            """];
        yield return ["list-get-before-rhs", """
            public static class R { public static int Run() { var a=new List<int>{1}; a[2]+=Fail(); return 1; }
                private static int Fail() { throw new InvalidOperationException("RHS must not run"); } }
            """];
        yield return ["array-get-before-rhs", """
            public static class R { public static int Run() { var a=new[]{1}; a[2]+=Fail(); return 1; }
                private static int Fail() { throw new InvalidOperationException("RHS must not run"); } }
            """];
    }

    [Theory, MemberData(nameof(Cases))]
    public void PlaceResultsAndImplicitFailuresMatchClr(string name, string source)
    {
        var compiled = CSharpCompiler.Compile(new Dictionary<string, string> { [name + ".cs"] = source });
        using var oracle = new Oracle(source);
        var expected = oracle.Run();
        var map = compiled.SourceMap.OfType<JsonObject>().Single(m => m["source"]!.ToString() == "R.Run()");
        var probe = new ReferenceGraphProbe(compiled.Specification);
        var actual = probe.Run(map["implementation"]!.ToString());
        var completion = (Dictionary<string, object>)actual["AvCompletion"];
        if (expected.Failure == null)
        {
            Assert.Equal(1m, completion["Kind"]); Assert.Equal(expected.Value, actual["AvResult"]);
            Assert.Equal(expected.Value, probe.Run(map["native"]!.ToString())["AvResult"]);
        }
        else
        {
            Assert.Equal(2m, completion["Kind"]);
            var context = (Dictionary<string, object>)actual["AvContextOut"];
            var exceptions = (List<object>)context["Exceptions"];
            var exception = (Dictionary<string, object>)exceptions[(int)(decimal)completion["ExceptionRef"] - 1];
            Assert.Equal(expected.Failure.GetType().FullName, exception["TypeName"]);
            Assert.Equal(expected.Failure.Message, exception["Message"]);
            if (expected.Failure is ArgumentException argument) Assert.Equal(argument.ParamName, exception["ParamName"]);
            var boundary = Assert.Throws<ReferenceGraphProbe.Failure>(() => probe.Run(map["native"]!.ToString()));
            Assert.Equal(expected.Failure.GetType().Name, boundary.Kind); Assert.Equal(expected.Failure.Message, boundary.Message);
        }
    }

    [Fact]
    public void SourceMethodNamedLikeAFrameworkIntrinsicKeepsItsOwnBody()
    {
        const string source = """
            namespace System { public static class ArgumentNullException {
                internal static void ThrowIfNull(string argument) { throw new InvalidOperationException("spoof-body"); }
            }}
            public static class R { public static int Run() { ArgumentNullException.ThrowIfNull("x"); return 1; }}
            """;
        using var oracle = new Oracle(source); var expected = oracle.Run();
        Assert.IsType<InvalidOperationException>(expected.Failure);
        var compiled = CSharpCompiler.Compile(new Dictionary<string, string> { ["SourceIntrinsic.cs"] = source });
        var failure = Assert.Throws<ReferenceGraphProbe.Failure>(() => new ReferenceGraphProbe(compiled.Specification).Run("Run"));
        Assert.Equal(expected.Failure!.Message, failure.Message); Assert.Equal(expected.Failure.GetType().Name, failure.Kind);
    }

    [Fact]
    public void ArgumentExceptionDefaultConstructorMatchesClrInManagedCompletion()
    {
        const string source = """
            class C { public int Value {get;set;} }
            public static class R { public static int Run() { var c=new C(); c.Value=1; throw new ArgumentException(); }}
            """;
        using var oracle = new Oracle(source); var expected = oracle.Run();
        Assert.IsType<ArgumentException>(expected.Failure);
        var compiled = CSharpCompiler.Compile(new Dictionary<string, string> { ["Defaults.cs"] = source });
        var map = compiled.SourceMap.OfType<JsonObject>().Single(m => m["source"]!.ToString() == "R.Run()");
        var probe = new ReferenceGraphProbe(compiled.Specification);
        var result = probe.Run(map["implementation"]!.ToString());
        Assert.Equal(2m, ((Dictionary<string, object>)result["AvCompletion"])["Kind"]);
        var exception = Assert.Single((List<object>)((Dictionary<string, object>)result["AvContextOut"])["Exceptions"]);
        Assert.Equal(expected.Failure!.Message, ((Dictionary<string, object>)exception)["Message"]);
        var failure = Assert.Throws<ReferenceGraphProbe.Failure>(() => probe.Run("Run"));
        Assert.Equal(expected.Failure.Message, failure.Message); Assert.Equal("ArgumentException", failure.Kind);
    }

    private sealed class Oracle : IDisposable
    {
        private readonly AssemblyLoadContext context = new("reference-place-" + Guid.NewGuid(), isCollectible: true);
        private readonly Type type;
        public Oracle(string source)
        {
            var program = SourceProgram.Parse(new Dictionary<string, string> { ["Oracle.cs"] = source });
            using var stream = new MemoryStream(); var result = program.Compilation.Emit(stream);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics)); stream.Position = 0;
            type = context.LoadFromStream(stream).GetType("R")!;
        }
        public (object? Value, Exception? Failure) Run()
        {
            try { return (type.GetMethod("Run")!.Invoke(null, null), null); }
            catch (TargetInvocationException error) { return (null, error.InnerException); }
        }
        public void Dispose() => context.Unload();
    }
}
