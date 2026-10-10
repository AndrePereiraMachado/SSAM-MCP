using Anvil.Authoring.Transport;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public sealed class ByteArrayGraphTests
{
    [Fact]
    public void EchoRetainsNullEmptyAndOriginalArrayIdentity()
    {
        using var call = new ReferencePublicGraphTests.Call("public static class Rules { public static byte[] Echo(byte[] input) => input; }", "Echo");
        var input = new byte[] { 0, 127, 255 };
        Assert.Same(input, call.Invoke(input));
        var empty = new byte[0]; Assert.Same(empty, call.Invoke(empty));
        Assert.Null(call.Invoke(new object?[] { null }));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AliasedFieldsAndArgumentKeepOneArrayAcrossMutation(bool sharedStorage)
    {
        const string source = """
            public sealed class State { public byte[] Data { get; set; } = null!; public byte[] Alias { get; set; } = null!; }
            public static class Rules {
                public static byte[] Update(State state, byte[] input) {
                    state.Data = input; state.Alias = input;
                    input[0] = unchecked((byte)(input[0] + 3));
                    state.Alias[1]++;
                    return state.Data;
                }
            }
            """;
        using var call = new ReferencePublicGraphTests.Call(source, "Update", sharedStorage);
        var state = call.New("State"); var input = new byte[] { 254, 255 };
        Assert.Same(input, call.Invoke(state, input));
        Assert.Same(input, call.Member(state, "Data")); Assert.Same(input, call.Member(state, "Alias"));
        Assert.Equal(new byte[] { 1, 0 }, input);
    }

    [Fact]
    public void LiteralAllocatesAndIndexReturnsAnExactByte()
    {
        using var create = new ReferencePublicGraphTests.Call("public static class Rules { public static byte[] Create() => new byte[] { 0, 128, 255 }; }", "Create");
        Assert.Equal(new byte[] { 0, 128, 255 }, Assert.IsType<byte[]>(create.Invoke()));
        using var read = new ReferencePublicGraphTests.Call("public static class Rules { public static byte Last(byte[] value) => value[value.Length - 1]; }", "Last");
        Assert.Equal((byte)255, read.Invoke(new byte[] { 1, 255 }));
        Assert.Throws<IndexOutOfRangeException>(() => read.Invoke(Array.Empty<byte>()));
        Assert.Throws<NullReferenceException>(() => read.Invoke(new object?[] { null }));
    }

    [Fact]
    public void CheckedMutationFailurePreservesEarlierArrayEffects()
    {
        const string source = "public static class Rules { public static byte[] Update(byte[] value) { value[0] = 7; checked { value[1]++; } return value; } }";
        using var call = new ReferencePublicGraphTests.Call(source, "Update");
        var input = new byte[] { 1, 255 }; Assert.Throws<OverflowException>(() => call.Invoke(input));
        Assert.Equal(new byte[] { 7, 255 }, input);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(5)]
    public void SizedArrayHasZeroedElementsAndAllocatesDistinctIdentities(int length)
    {
        using var call = new ReferencePublicGraphTests.Call("public static class Rules { public static byte[] Create(int count) => new byte[count]; }", "Create");
        var first = Assert.IsType<byte[]>(call.Invoke(length)); var second = Assert.IsType<byte[]>(call.Invoke(length));
        Assert.NotSame(first, second); Assert.Equal(new byte[length], first); Assert.Equal(first, second);
    }

    [Fact]
    public void NegativeSizeRunsItsExpressionOnceBeforeThrowing()
    {
        const string source = """
            public sealed class State { public int Count { get; set; } }
            public static class Rules {
                public static byte[] Create(State state, int length) => new byte[Size(state, length)];
                private static int Size(State state, int length) { state.Count++; return length; }
            }
            """;
        using var call = new ReferencePublicGraphTests.Call(source, "Create");
        var state = call.New("State"); Assert.Throws<OverflowException>(() => call.Invoke(state, -1));
        Assert.Equal(1, call.Member(state, "Count"));
    }

    [Theory]
    [InlineData("int?")]
    [InlineData("string")]
    [InlineData("DateOnly?")]
    [InlineData("Point")]
    [InlineData("Flags")]
    public void SizedArraysUseCompleteRuntimeDefaultsForEveryElement(string element)
    {
        var source = "public struct Point { public int X { get; set; } public string Name { get; set; } } " +
            "public enum Flags { On = 1, Off = 2 } " +
            "public static class Rules { public static " + element + "[] Create(int length) => new " + element + "[length]; }";
        using var call = new ReferencePublicGraphTests.Call(source, "Create");
        var actual = Assert.IsAssignableFrom<Array>(call.Invoke(2));
        var expected = Array.CreateInstance(actual.GetType().GetElementType()!, 2);
        Assert.Equal(expected.Cast<object?>(), actual.Cast<object?>());
    }

    [Theory]
    [InlineData("long", 2147483648L, "Array dimensions exceeded supported range.")]
    [InlineData("long", long.MaxValue, "Array dimensions exceeded supported range.")]
    [InlineData("uint", 2147483648L, "Arithmetic operation resulted in an overflow.")]
    [InlineData("uint", 4294967295L, "Arithmetic operation resulted in an overflow.")]
    public void OversizedDimensionEvaluatesOnceAndFailsBeforeAllocating(string integer, long length, string message)
    {
        var source = "public sealed class State { public int Calls { get; set; } } public static class Rules { " +
            "private static " + integer + " Size(State state, " + integer + " length) { state.Calls++; return length; } " +
            "public static byte[] Create(State state, " + integer + " length) => new byte[Size(state, length)]; }";
        using var call = new ReferencePublicGraphTests.Call(source, "Create");
        var state = call.New("State"); object dimension = integer == "uint" ? (object)(uint)length : length;
        var failure = Assert.Throws<OverflowException>(() => call.Invoke(state, dimension));
        Assert.Equal(message, failure.Message); Assert.Equal(1, call.Member(state, "Calls"));
    }

    [Fact]
    public void BinaryStorageDoesNotReceiveAnArrayHandleAsIfItWereBytes()
    {
        const string source = """
            using Anvil.Authoring;
            [Entity] public sealed class Blob { public Id<Blob> Id { get; set; } public byte[] Data { get; set; } = null!; }
            public static class Rules { public static Id<Blob> Save(IDataSession store, Blob row) => store.Insert(row); }
            """;
        var failure = Assert.Throws<SourceCompilationException>(() => CSharpCompiler.CompileReferenceGraph(new Dictionary<string, string> { ["Blob.cs"] = source }));
        Assert.Contains("Binary Data persistence requires a byte-array value codec", failure.Message);
    }

    [Fact]
    public void NativeByteDomainIsCheckedBeforeTheBusinessBody()
    {
        const string source = "public static class Rules { public static byte[] Echo(byte[] input) => input; }";
        var compiled = CSharpCompiler.CompileReferenceGraph(new Dictionary<string, string> { ["Bytes.cs"] = source });
        var schema = compiled.SourceAbis![0]!["abi"]!.AsObject();
        var binding = new ReferenceGraphBinding(schema, typeof(ByteArrayGraphTests).Assembly, maxSupportedVersion: 4);
        var session = binding.CreateSession(); var wire = binding.CreateWire(); var graph = session.Encode(binding.Inputs, [new byte[] { 1 }]);
        var arena = wire.EncodeArenas(graph); var name = arena.Single().Key;
        arena[name]![0]!["Items"]![0] = 256;
        var request = new Dictionary<string, object> { ["Arg_input"] = new Dictionary<string, object> { ["Index"] = 1m },
            ["AvGraphIn"] = new Dictionary<string, object> { [name] = new List<object> { new Dictionary<string, object> { ["Items"] = new List<object> { 256m } } } } };
        var failure = Assert.Throws<ReferenceGraphProbe.Failure>(() => new ReferenceGraphProbe(compiled.Specification).Run("Echo", request));
        Assert.Equal("Invalid C# reference graph.", failure.Message);
        Assert.Throws<System.Text.Json.JsonException>(() => wire.Decode(arena, [new JsonObject { ["Index"] = 1 }], binding.Results));
    }
}
