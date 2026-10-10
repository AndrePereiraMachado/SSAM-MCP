using Xunit;

namespace Anvil.CSharp.Tests;

public class ReferenceInlineGraphTests
{
    [Fact]
    public void ValueCopyPreservesSharedListWhileItsScalarFieldsStayIndependent()
    {
        using var call = new ReferencePublicGraphTests.Call("""
            public readonly record struct Parcel(string Label, List<int> Values);
            public static class Rules {
                public static Parcel Change(Parcel value) {
                    var copied = value with { Label = "changed" };
                    copied.Values.Add(7);
                    return copied;
                }
            }
            """, "Change");
        var list = new List<int> { 2 };
        var input = call.New("Parcel", "original", list); var result = call.Invoke(input)!;
        Assert.Equal("original", call.Member(input, "Label")); Assert.Equal("changed", call.Member(result, "Label"));
        Assert.Same(list, call.Member(input, "Values")); Assert.Same(list, call.Member(result, "Values"));
        Assert.Equal(new[] { 2, 7 }, list);
    }

    [Fact]
    public void ClassStructCycleUsesOneClassIdentityAndInlineValueCopies()
    {
        using var call = new ReferencePublicGraphTests.Call("""
            public readonly record struct Link(string Label, Node? Next);
            public sealed class Node { public Link Link { get; set; } }
            public static class Rules { public static Node Echo(Node value) => value; }
            """, "Echo");
        var node = call.New("Node"); var link = call.New("Link", null, node);
        node.GetType().GetProperty("Link")!.SetValue(node, link);
        var result = call.Invoke(node)!;
        Assert.Same(node, result); var returnedLink = call.Member(result, "Link")!;
        Assert.Null(call.Member(returnedLink, "Label")); Assert.Same(node, call.Member(returnedLink, "Next"));
    }
}
