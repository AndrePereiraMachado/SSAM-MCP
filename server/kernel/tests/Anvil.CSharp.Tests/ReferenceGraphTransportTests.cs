using Anvil.Authoring.Transport;
using Xunit;

namespace Anvil.CSharp.Tests;

// Caller codec tests, deliberately separate from compiler/native-public-entry acceptance.
// Replies below stand for a transport peer; these do not certify source lowering or O11.
public class ReferenceGraphTransportTests
{
    private static readonly GraphReference NodeRef = new("Node");
    private static readonly GraphReference ListRef = new("Nodes");
    private static GraphField Field<T>(string name, GraphShape shape)
        => new(name, typeof(T).GetField(name)!, shape);
    private static ReferenceGraphSession Session() => new([
        new("Node", typeof(Node), [Field<Node>(nameof(Node.Value), new GraphScalar(typeof(int))), Field<Node>(nameof(Node.Next), NodeRef)]),
        new("Nodes", typeof(List<Node>), [], NodeRef),
        new("Array", typeof(Node[]), [], NodeRef)]);
    private static GraphRecord Cell(int value, int next = 0) => new(new Dictionary<string, object?> {
        [nameof(Node.Value)] = value, [nameof(Node.Next)] = new GraphHandle("Node", next) });
    private static ReferenceGraph Reply(ReferenceGraph request, object[] nodes, params object?[] roots)
        => new(request.Arenas.ToDictionary(p => p.Key, p => p.Key == "Node" ? (IReadOnlyList<object>)nodes : p.Value), roots);

    [Fact]
    public void JointRootsKeepIdentityNullEmptyAndSelfCyclesDistinct()
    {
        var n = new Node { Value = 3 }; n.Next = n; var list = new List<Node>(); var s = Session();
        var graph = s.Encode([NodeRef, NodeRef, NodeRef, ListRef, ListRef], [n, n, null, list, null]);
        Assert.Single(graph.Arenas["Node"]); Assert.Single(graph.Arenas["Nodes"]);
        Assert.Equal(graph.Roots[0], graph.Roots[1]); Assert.Equal(new GraphHandle("Node", 0), graph.Roots[2]);
        Assert.NotEqual(graph.Roots[3], graph.Roots[4]);
        Assert.Equal(graph.Roots[0], ((GraphRecord)graph.Arenas["Node"][0]).Fields["Next"]);
        var result = s.Reconcile(graph, [NodeRef, NodeRef, NodeRef, ListRef, ListRef]);
        Assert.Same(n, result[0]); Assert.Same(n, result[1]); Assert.Same(n, n.Next);
        Assert.Null(result[2]); Assert.Same(list, result[3]); Assert.Null(result[4]);
    }

    [Fact]
    public void ResponseReservesForwardIdentitiesWithoutRunningSourceConstructorsOrGetters()
    {
        var s = Session(); var request = s.Encode([], []); var count = Node.Constructions;
        var reply = Reply(request, [Cell(8, 2), Cell(9, 1)], new GraphHandle("Node", 1));
        var first = Assert.IsType<Node>(Assert.Single(s.Reconcile(reply, [NodeRef])));
        Assert.Equal(8, first.Value); Assert.Equal(9, first.Next!.Value); Assert.Same(first, first.Next.Next);
        Assert.Equal(count, Node.Constructions);
    }

    [Fact]
    public void DetachedInputStillReceivesWritebackBeforeReturnedFailureIsRaised()
    {
        var first = new Node { Value = 1 }; var detached = new Node { Value = 2 }; first.Next = detached;
        var s = Session(); var request = s.Encode([NodeRef], [first]);
        var response = Reply(request, [Cell(10), Cell(20)]);
        void Complete()
        {
            s.Reconcile(response, []);
            // The generated caller must perform this ordering for a native completion.
            throw new InvalidOperationException("source failure");
        }
        var failure = Assert.Throws<InvalidOperationException>(Complete);
        Assert.Equal("source failure", failure.Message); Assert.Null(first.Next); Assert.Equal(20, detached.Value);
    }

    [Fact]
    public void ReturnedRebindingDoesNotReplaceTheOriginalCallerVariable()
    {
        var original = new Node { Value = 1 }; var s = Session(); var request = s.Encode([NodeRef], [original]);
        var result = Assert.IsType<Node>(Assert.Single(s.Reconcile(Reply(request, [Cell(2), Cell(3)], new GraphHandle("Node", 2)), [NodeRef])));
        Assert.NotSame(original, result); Assert.Equal(2, original.Value); Assert.Equal(3, result.Value);
    }

    [Fact]
    public void InputListIdentitySurvivesResizeAndSharedElementWriteback()
    {
        var node = new Node { Value = 1 }; var list = new List<Node> { node, node }; var s = Session();
        var request = s.Encode([ListRef], [list]); var arenas = request.Arenas.ToDictionary(p => p.Key, p => p.Value);
        var listState = (GraphSequence)request.Arenas["Nodes"][0];
        arenas["Node"] = [Cell(4)]; arenas["Nodes"] = [new GraphSequence([new GraphHandle("Node", 1)], listState.Version + 1, listState.Capacity)];
        var result = s.Reconcile(new(arenas, request.Roots), [ListRef]);
        Assert.Same(list, result[0]); Assert.Same(node, Assert.Single(list)); Assert.Equal(4, node.Value);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ConcurrentCallerListChangesAreRejectedBeforeObjectWriteback(bool capacityOnly)
    {
        var node = new Node { Value = 7 }; var list = new List<Node> { node }; var session = Session();
        var request = session.Encode([ListRef], [list]);
        if (capacityOnly) list.Capacity = 16; else list.Add(node);
        Assert.Throws<InvalidDataException>(() => session.Reconcile(Reply(request, [Cell(9)], request.Roots[0]), [ListRef]));
        Assert.Equal(7, node.Value);
        Assert.Equal(capacityOnly ? 1 : 2, list.Count);
        if (capacityOnly) Assert.Equal(16, list.Capacity);
    }

    [Fact]
    public void InvalidReplyCapacityCannotPartiallyUpdateCallerObjects()
    {
        var node = new Node { Value = 7 }; var list = new List<Node> { node }; var session = Session();
        var request = session.Encode([ListRef], [list]); var arenas = request.Arenas.ToDictionary(p => p.Key, p => p.Value);
        arenas["Node"] = [Cell(9)];
        var sequence = (GraphSequence)arenas["Nodes"][0]; arenas["Nodes"] = [sequence with { Capacity = -1 }];
        Assert.Throws<InvalidDataException>(() => session.Reconcile(new(arenas, request.Roots), [ListRef]));
        Assert.Equal(7, node.Value); Assert.Same(node, Assert.Single(list));
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(2)]
    public void InvalidLateHandleCannotPartiallyMutateEarlierCallerFields(int invalid)
    {
        var node = new Node { Value = 7 }; var s = Session(); var request = s.Encode([NodeRef], [node]);
        Assert.Throws<InvalidDataException>(() => s.Reconcile(Reply(request, [Cell(99, invalid)], new GraphHandle("Node", 1)), [NodeRef]));
        Assert.Equal(7, node.Value);
        Assert.Same(node, Assert.Single(s.Reconcile(request, [NodeRef])));
    }

    [Fact]
    public void UnreachableCalleeIdentitiesAreRejectedBeforeCallerWriteback()
    {
        var original = new Node { Value = 7 }; var s = Session(); var request = s.Encode([NodeRef], [original]);
        var reply = Reply(request, [Cell(8), Cell(12345)], new GraphHandle("Node", 1));
        Assert.Throws<InvalidDataException>(() => s.Reconcile(reply, [NodeRef]));
        Assert.Equal(7, original.Value);
    }

    [Fact]
    public void InputIdentitiesCannotBeOmittedFromAReply()
    {
        var node = new Node { Value = 7 }; var s = Session(); var request = s.Encode([NodeRef], [node]);
        Assert.Throws<InvalidDataException>(() => s.Reconcile(Reply(request, []), [])); Assert.Equal(7, node.Value);
    }

    [Fact]
    public void ArrayIdentityCannotResizeAndValidationPrecedesWriteback()
    {
        var node = new Node { Value = 7 }; var input = new[] { node }; var s = Session();
        var request = s.Encode([new GraphReference("Array")], [input]); var arenas = request.Arenas.ToDictionary(p => p.Key, p => p.Value);
        arenas["Node"] = [Cell(9)]; arenas["Array"] = [new GraphSequence([])];
        Assert.Throws<InvalidDataException>(() => s.Reconcile(new(arenas, request.Roots), [new GraphReference("Array")]));
        Assert.Equal(7, node.Value); Assert.Same(node, input[0]);
    }

    [Fact]
    public void InlineStructCopiesItsValueWhilePreservingReferencedListIdentity()
    {
        var n = new Node { Value = 1 }; var list = new List<Node> { n }; var value = new ValueWithList { Items = list, Count = 4 };
        var shape = new GraphInline(typeof(ValueWithList), [Field<ValueWithList>(nameof(ValueWithList.Items), ListRef), Field<ValueWithList>(nameof(ValueWithList.Count), new GraphScalar(typeof(int)))]);
        var s = Session(); var request = s.Encode([shape], [value]);
        var result = Assert.IsType<ValueWithList>(Assert.Single(s.Reconcile(request, [shape])));
        Assert.Equal(4, result.Count); Assert.Same(list, result.Items); Assert.Same(n, result.Items[0]);
    }

    [Fact]
    public void CustomListConstructorsCannotEnterTheSchema()
    {
        Assert.Throws<ArgumentException>(() => new ReferenceGraphSession([new("Custom", typeof(CustomList), [], new GraphScalar(typeof(int)))]));
        Assert.Equal(0, CustomList.Constructions);
    }

    public sealed class Node
    {
        public static int Constructions;
        public Node() => Constructions++;
        public int Value;
        public Node? Next;
        public int DangerousGetter => throw new InvalidOperationException("must not run");
    }
    public struct ValueWithList { public List<Node> Items; public int Count; }
    public sealed class CustomList : List<int> { public static int Constructions; public CustomList() => Constructions++; }
}
