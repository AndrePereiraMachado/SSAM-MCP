using System.Reflection;
using System.Runtime.Loader;
using Xunit;

namespace Anvil.CSharp.Tests;

/// <summary>
/// Opt-in red acceptance cases. They assert source semantics, never the current limitation.
/// The native-logic probe is frontend evidence only; it is not the missing public graph adapter.
/// </summary>
public class ReferenceBoundaryCapabilityGapTests
{
    private sealed class BoundaryGapFactAttribute : FactAttribute
    {
        public BoundaryGapFactAttribute()
        {
            if (Environment.GetEnvironmentVariable("ANVIL_RUN_REFERENCE_BOUNDARY_GAPS") != "1")
                Skip = "Missing public identity codec: set ANVIL_RUN_REFERENCE_BOUNDARY_GAPS=1 to run red acceptance cases separately.";
        }
    }

    [BoundaryGapFact, Trait("Category", "ReferenceBoundaryCapabilityGap")]
    public void PublicEchoPreservesTheIdentityOfAnInputObject()
    {
        const string source = "public sealed record R(int Value); public static class Rules { public static R Echo(R value) => value; }";
        using var oracle = new Oracle(source);
        var instance = oracle.New("R", 7);
        var expected = ReferenceEquals(instance, oracle.Call("Echo", instance));
        Assert.True(expected);
        var input = new Dictionary<string, object> { ["Value"] = 7m };
        var actual = Probe(source).Run("Echo", new Dictionary<string, object> { ["Arg_value"] = input })["AvResult"];
        Assert.Equal(expected, ReferenceEquals(input, actual));
    }

    [BoundaryGapFact, Trait("Category", "ReferenceBoundaryCapabilityGap")]
    public void UnannotatedReferenceNullIsNotFoldedToPresent()
    {
        const string source = "public sealed record R(int Value); public static class Rules { public static bool IsNull(R value) => value == null; }";
        using var oracle = new Oracle(source);
        var expected = oracle.Call("IsNull", new object?[] { null });
        Assert.Equal(true, expected);
        // The probe can carry CLR null to expose the constant folding. This is not a claim
        // that the existing native record signature has a wire representation for that null.
        var actual = Probe(source).Run("IsNull", new Dictionary<string, object> { ["Arg_value"] = null! })["AvResult"];
        Assert.Equal(expected, actual);
    }

    [BoundaryGapFact, Trait("Category", "ReferenceBoundaryCapabilityGap")]
    public void PublicListEchoPreservesTheInputListIdentity()
    {
        const string source = "public static class Rules { public static List<int> Echo(List<int> value) => value; }";
        using var oracle = new Oracle(source);
        var instance = new List<int> { 1, 2 };
        var expected = ReferenceEquals(instance, oracle.Call("Echo", instance));
        Assert.True(expected);
        var input = new List<object> { 1m, 2m };
        var actual = Probe(source).Run("Echo", new Dictionary<string, object> { ["Arg_value"] = input })["AvResult"];
        Assert.Equal(expected, ReferenceEquals(input, actual));
    }

    [BoundaryGapFact, Trait("Category", "ReferenceBoundaryCapabilityGap")]
    public void SharedMembersDoNotBecomeIndependentCopiesAtTheBoundary()
    {
        const string source = """
            public sealed record Leaf(int Value);
            public sealed record Pair(Leaf Left, Leaf Right);
            public static class Rules { public static Pair Echo(Pair value) => value; }
            """;
        using var oracle = new Oracle(source);
        var leaf = oracle.New("Leaf", 3);
        var pair = oracle.Call("Echo", oracle.New("Pair", leaf, leaf))!;
        var expected = ReferenceEquals(oracle.Member(pair, "Left"), oracle.Member(pair, "Right"));
        Assert.True(expected);
        var inputLeaf = new Dictionary<string, object> { ["Value"] = 3m };
        var input = new Dictionary<string, object> { ["Left"] = inputLeaf, ["Right"] = inputLeaf };
        var actual = Assert.IsType<Dictionary<string, object>>(Probe(source).Run("Echo", new Dictionary<string, object> { ["Arg_value"] = input })["AvResult"]);
        Assert.Equal(expected, ReferenceEquals(actual["Left"], actual["Right"]));
    }

    [BoundaryGapFact, Trait("Category", "ReferenceBoundaryCapabilityGap")]
    public void SelfCycleRequiresAFinitePublicGraphTransport()
    {
        const string source = "public sealed class Node { public Node? Next { get; set; } } public static class Rules { public static Node Echo(Node value) => value; }";
        using var oracle = new Oracle(source);
        var node = oracle.New("Node");
        node.GetType().GetProperty("Next")!.SetValue(node, node);
        Assert.Same(node, oracle.Member(oracle.Call("Echo", node)!, "Next"));
        Assert.Same(node, oracle.Call("Echo", node));
        // Even this finite input fails while the native probe expands recursive record defaults;
        // a graph codec must also handle an actual cycle without recursive structural copying.
        var input = new Dictionary<string, object> {
            ["Next"] = new Dictionary<string, object> { ["HasValue"] = false, ["Value"] = new Dictionary<string, object>() }
        };
        var result = Probe(source).Run("Echo", new Dictionary<string, object> { ["Arg_value"] = input });
        Assert.Same(input, result["AvResult"]);
    }

    [BoundaryGapFact, Trait("Category", "ReferenceBoundaryCapabilityGap")]
    public void MutationBeforePublicThrowRemainsVisibleToTheCaller()
    {
        const string source = """
            public sealed class Cell { public int Value { get; set; } }
            public static class Rules { public static void Mutate(Cell value) { value.Value++; throw new InvalidOperationException("failed"); } }
            """;
        using var oracle = new Oracle(source);
        var cell = oracle.New("Cell");
        var error = Assert.Throws<TargetInvocationException>(() => oracle.Call("Mutate", cell));
        Assert.IsType<InvalidOperationException>(error.InnerException);
        Assert.Equal(1, oracle.Member(cell, "Value"));
        // Current compilation rejects this public signature with AVCS310. Passing requires the
        // real protocol and adapter to update caller state before propagating the completion.
        var input = new Dictionary<string, object> { ["Value"] = 0m };
        var probe = Probe(source);
        Assert.Throws<ReferenceGraphProbe.Failure>(() => probe.Run("Mutate", new Dictionary<string, object> { ["Arg_value"] = input }));
        Assert.Equal(1m, input["Value"]);
    }

    private static ReferenceGraphProbe Probe(string source)
        => new(CSharpCompiler.Compile(new Dictionary<string, string> { ["BoundaryGap.cs"] = source }).Specification);

    private sealed class Oracle : IDisposable
    {
        private readonly AssemblyLoadContext context = new("boundary-gap-" + Guid.NewGuid(), isCollectible: true);
        private readonly Assembly assembly;
        internal Oracle(string source)
        {
            var program = SourceProgram.Parse(new Dictionary<string, string> { ["BoundaryGap.cs"] = source });
            using var stream = new MemoryStream();
            var emitted = program.Compilation.Emit(stream);
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            stream.Position = 0; assembly = context.LoadFromStream(stream);
        }
        internal object New(string type, params object?[] arguments) => Activator.CreateInstance(assembly.GetType(type)!, arguments)!;
        internal object? Call(string method, params object?[] arguments) => assembly.GetType("Rules")!.GetMethod(method)!.Invoke(null, arguments);
        internal object? Member(object instance, string member) => instance.GetType().GetProperty(member)!.GetValue(instance);
        public void Dispose() => context.Unload();
    }
}
