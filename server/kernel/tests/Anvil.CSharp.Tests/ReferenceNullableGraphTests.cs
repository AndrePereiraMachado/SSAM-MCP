using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public class ReferenceNullableGraphTests
{
    [Fact]
    public void ListOfNullableValuesPreservesNullZeroAndListIdentity()
    {
        using var call = new ReferencePublicGraphTests.Call("public static class Rules { public static List<int?> Echo(List<int?> value) => value; }", "Echo");
        var list = new List<int?> { null, 0, 12 };
        Assert.Same(list, call.Invoke(list)); Assert.Equal(new int?[] { null, 0, 12 }, list);
    }

    [Fact]
    public void NullableNumberKeepsNullDistinctFromZeroDuringCallerWriteback()
    {
        using var call = new ReferencePublicGraphTests.Call("""
            public sealed class Counter { public int? Count { get; set; } public List<int> Values { get; set; } }
            public static class Rules {
                public static Counter Increment(Counter value) {
                    value.Count = value.Count == null ? 0 : value.Count + 1;
                    value.Values.Add(value.Count.Value);
                    return value;
                }
            }
            """, "Increment");
        var input = call.New("Counter"); var list = new List<int>(); input.GetType().GetProperty("Values")!.SetValue(input, list);
        Assert.Null(call.Member(input, "Count")); Assert.Same(input, call.Invoke(input)); Assert.Equal(0, call.Member(input, "Count"));
        Assert.Same(input, call.Invoke(input)); Assert.Equal(1, call.Member(input, "Count")); Assert.Equal(new[] { 0, 1 }, list);
    }

    [Fact]
    public void NullableStructCarriesPresenceAndPreservesItsReferencedObject()
    {
        using var call = new ReferencePublicGraphTests.Call("""
            public sealed class Item { public int Value; }
            public readonly record struct Packet(string Name, Item? Item);
            public sealed class Envelope { public Packet? Packet { get; set; } }
            public static class Rules { public static Envelope Echo(Envelope value) => value; }
            """, "Echo");
        var envelope = call.New("Envelope"); Assert.Same(envelope, call.Invoke(envelope)); Assert.Null(call.Member(envelope, "Packet"));
        var item = call.New("Item"); var packet = call.New("Packet", null, item);
        envelope.GetType().GetProperty("Packet")!.SetValue(envelope, packet);
        Assert.Same(envelope, call.Invoke(envelope)); var result = call.Member(envelope, "Packet")!;
        Assert.Null(call.Member(result, "Name")); Assert.Same(item, call.Member(result, "Item"));
    }

    [Fact]
    public void AbsentTextHasACanonicalEmptyPayloadInTheNativeResponse()
    {
        using var call = new ReferencePublicGraphTests.Call("""
            public sealed class Document { public string Title { get; set; } }
            public static class Rules { public static Document Erase(Document value) { value.Title = null; return value; } }
            """, "Erase");
        var input = call.New("Document"); input.GetType().GetProperty("Title")!.SetValue(input, "previous-value");
        Assert.Same(input, call.Invoke(input)); Assert.Null(call.Member(input, "Title"));
        var title = call.LastResponse!["AvGraphOut"]!.AsObject().Single().Value![0]!["Title"]!;
        Assert.False(title["HasValue"]!.GetValue<bool>()); Assert.Equal("", title["Value"]!.GetValue<string>());
    }
}
