using System.Collections;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public class ReferencePublicGraphEdgeTests
{
    [Fact]
    public void NewResultCyclePreservesOriginalNodesAndExcludesInternalAllocations()
    {
        using var call = new ReferencePublicGraphTests.Call("""
            public sealed class Node { public int Value { get; set; } public Node? Next { get; set; } }
            public static class Rules {
                public static Node Extend(Node value) {
                    var scratch = new Node { Value = 999 };
                    value.Value++;
                    var result = new Node { Value = scratch.Value - 998, Next = value };
                    value.Next = result;
                    return result;
                }
            }
            """, "Extend");
        var input = call.New("Node"); var result = call.Invoke(input)!;
        Assert.NotSame(input, result); Assert.Same(input, call.Member(result, "Next"));
        Assert.Same(result, call.Member(input, "Next")); Assert.Equal(1, call.Member(input, "Value"));
        Assert.Equal(1, call.Member(result, "Value"));
        Assert.Equal(2, call.LastResponse!["AvGraphOut"]!.AsObject().Single().Value!.AsArray().Count);
    }

    [Fact]
    public void DetachedInputStillReceivesMutationsAndNewResultGetsItsOwnIdentity()
    {
        using var call = new ReferencePublicGraphTests.Call("""
            public sealed class Leaf { public int Value { get; set; } }
            public sealed class Holder { public Leaf? Left { get; set; } public Leaf? Right { get; set; } }
            public static class Rules {
                public static Leaf Detach(Holder value) {
                    value.Left!.Value++;
                    value.Left = null;
                    value.Right = null;
                    return new Leaf { Value = 9 };
                }
            }
            """, "Detach");
        var leaf = call.New("Leaf"); var holder = call.New("Holder");
        holder.GetType().GetProperty("Left")!.SetValue(holder, leaf);
        holder.GetType().GetProperty("Right")!.SetValue(holder, leaf);
        var result = call.Invoke(holder)!;
        Assert.Null(call.Member(holder, "Left")); Assert.Null(call.Member(holder, "Right"));
        Assert.Equal(1, call.Member(leaf, "Value")); Assert.Equal(9, call.Member(result, "Value")); Assert.NotSame(leaf, result);
    }

    [Fact]
    public void SharedListMutationsAndNewMemberRemainVisibleThroughBothFields()
    {
        using var call = new ReferencePublicGraphTests.Call("""
            public sealed class Item { public int Value { get; set; } }
            public sealed class Pair { public List<Item> Left { get; set; } public List<Item> Right { get; set; } }
            public static class Rules {
                public static Item Append(Pair value) {
                    value.Left[0].Value++;
                    var result = new Item { Value = 7 };
                    value.Right.Add(result);
                    return result;
                }
            }
            """, "Append");
        var item = call.New("Item"); var pair = call.New("Pair");
        var list = (IList)Activator.CreateInstance(pair.GetType().GetProperty("Left")!.PropertyType)!; list.Add(item);
        pair.GetType().GetProperty("Left")!.SetValue(pair, list); pair.GetType().GetProperty("Right")!.SetValue(pair, list);
        var result = call.Invoke(pair)!;
        Assert.Same(list, call.Member(pair, "Left")); Assert.Same(list, call.Member(pair, "Right"));
        Assert.Equal(2, list.Count); Assert.Same(item, list[0]); Assert.Same(result, list[1]); Assert.Equal(1, call.Member(item, "Value"));
    }

    [Fact]
    public void ArrayElementReplacementKeepsArrayIdentityAndExportsTheNewElement()
    {
        using var call = new ReferencePublicGraphTests.Call("""
            public sealed class Item { public int Value { get; set; } }
            public static class Rules {
                public static Item[] Replace(Item[] value) { value[0] = new Item { Value = 12 }; return value; }
            }
            """, "Replace");
        var old = call.New("Item"); var input = Array.CreateInstance(old.GetType(), 1); input.SetValue(old, 0);
        Assert.Same(input, call.Invoke(input)); Assert.NotSame(old, input.GetValue(0)); Assert.Equal(12, call.Member(input.GetValue(0)!, "Value"));
    }
}
