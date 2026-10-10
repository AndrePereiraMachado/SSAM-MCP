using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.Loader;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

/// <summary>Source initialization order is compared with CLR execution of the same syntax trees.</summary>
public class ReferenceInitializerOrderTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PartialTypeInitializersFollowCompilationTreeOrderBeforeLocalSpans(bool reverseParts)
    {
        const string first = """
            // These offsets deliberately exceed those in the other syntax tree.
            // Field declarations and auto-property initializers still share one sequence.
            // Partial type initialization must retain the compilation's tree ordering.
            public partial record C(State state)
            {
                public int First = R.Next(state), Second = R.Next(state);
                public int Third { get; set; } = R.Next(state);
            }
            public class State { public int Count; }
            public static class R
            {
                internal static int Next(State state) { state.Count++; return state.Count; }
                public static int Run()
                {
                    var state = new State();
                    var value = new C(state);
                    return state.Count * 10000 + value.First * 1000 + value.Second * 100 + value.Third * 10 + value.Fourth;
                }
            }
            """;
        const string second = "public partial record C { public int Fourth { get; set; } = R.Next(state); }";
        var source = Parts(first, second, reverseParts);
        using var oracle = new Oracle(source);
        var expected = (int)oracle.Run()!;
        Assert.Equal(reverseParts ? 42341 : 41234, expected);
        var compiled = CSharpCompiler.Compile(source);
        var internalResult = Run(compiled, true);
        Assert.Equal((decimal)expected, internalResult["AvResult"]);
        Assert.Equal(1m, Fields(internalResult["AvCompletion"])["Kind"]);
        Assert.Empty(Assert.IsType<List<object>>(Fields(internalResult["AvContextOut"])["Exceptions"]));
        Assert.Equal((decimal)expected, Run(compiled, false)["AvResult"]);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void FirstThrowingInitializerAcrossPartialDeclarationsMatchesClr(bool reverseParts)
    {
        const string first = """
            // The first source declaration has a larger local span than the second tree.
            // Sorting SourceSpan.Start globally must not let a later initializer run first.
            // The exception identifies which initializer was actually executed.
            public partial class C { public int First = R.First(); }
            public static class R
            {
                internal static int First() { throw new InvalidOperationException("first field"); }
                internal static int Second() { throw new InvalidOperationException("second property"); }
                public static int Run() { var value = new C(); return value.First + value.Second; }
            }
            """;
        const string second = "public partial class C { public int Second { get; set; } = R.Second(); }";
        var source = Parts(first, second, reverseParts);
        using var oracle = new Oracle(source);
        var expected = Assert.Throws<InvalidOperationException>(() => oracle.Run());
        Assert.Equal(reverseParts ? "second property" : "first field", expected.Message);
        var compiled = CSharpCompiler.Compile(source);
        var internalResult = Run(compiled, true);
        Assert.Equal(2m, Fields(internalResult["AvCompletion"])["Kind"]);
        var exception = Fields(Assert.Single(Assert.IsType<List<object>>(Fields(internalResult["AvContextOut"])["Exceptions"])));
        Assert.Equal(expected.GetType().FullName, exception["TypeName"]);
        Assert.Equal(expected.Message, exception["Message"]);
        var boundary = Assert.Throws<ReferenceGraphProbe.Failure>(() => Run(compiled, false));
        Assert.Equal(expected.GetType().Name, boundary.Kind);
        Assert.Equal(expected.Message, boundary.Message);
    }

    private static Dictionary<string, string> Parts(string first, string second, bool reverseParts)
        // Deliberately insert B before A; SourceProgram owns the actual compilation order.
        => new() { ["B.cs"] = reverseParts ? first : second, ["A.cs"] = reverseParts ? second : first };
    private static Dictionary<string, object> Fields(object value) => Assert.IsType<Dictionary<string, object>>(value);
    private static Dictionary<string, object> Run(CompilationResult compiled, bool implementation)
    {
        var mapping = compiled.SourceMap.OfType<JsonObject>().Single(m => m["source"]?.ToString() == "R.Run()");
        return new ReferenceGraphProbe(compiled.Specification).Run(mapping[implementation ? "implementation" : "native"]!.ToString());
    }
    private sealed class Oracle : IDisposable
    {
        private readonly AssemblyLoadContext context = new("initializer-order-" + Guid.NewGuid(), isCollectible: true);
        private readonly MethodInfo run;
        internal Oracle(IReadOnlyDictionary<string, string> source)
        {
            using var bytes = new MemoryStream();
            var emitted = SourceProgram.Parse(source).Compilation.Emit(bytes);
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            bytes.Position = 0;
            run = context.LoadFromStream(bytes).GetType("R")!.GetMethod("Run")!;
        }
        internal object? Run()
        {
            try { return run.Invoke(null, null); }
            catch (TargetInvocationException error)
            {
                ExceptionDispatchInfo.Capture(error.InnerException!).Throw();
                throw;
            }
        }
        public void Dispose() => context.Unload();
    }
}
