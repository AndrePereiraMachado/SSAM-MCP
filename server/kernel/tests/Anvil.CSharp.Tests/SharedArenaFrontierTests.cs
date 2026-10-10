using Xunit;

namespace Anvil.CSharp.Tests;

public sealed class SharedArenaFrontierTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void UnreachableObjectAndListAllocationsDoNotBecomeOriginalCallerIdentities(bool shared)
    {
        const string source = """
            public sealed class Node { public int Value { get; set; } public Node? Next { get; set; } }
            public static class Rules {
                public static int Run(Node owner, List<Node> entries) {
                    var discarded = new Node { Value = 99 };
                    discarded.Next = discarded;
                    var discardedList = new List<Node> { discarded };
                    owner.Value += discardedList.Count;
                    entries.Add(owner);
                    return owner.Value;
                }
            }
            """;
        using var call = new ReferencePublicGraphTests.Call(source, "Run", shared);
        var owner = call.New("Node"); var listType = typeof(List<>).MakeGenericType(owner.GetType());
        var entries = (System.Collections.IList)Activator.CreateInstance(listType)!;
        Assert.Equal(1, call.Invoke(owner, entries));
        Assert.Same(owner, Assert.Single(entries.Cast<object>()));
        Assert.Equal(1, call.Member(owner, "Value"));
        var arenas = call.LastResponse!["AvGraphOut"]!.AsObject();
        Assert.Equal(2, arenas.Count); Assert.All(arenas, arena => Assert.Single(arena.Value!.AsArray()));
        Assert.Equal(2, call.LastResponse["AvCompletion"]!.AsObject().Count);
    }
}
