using Xunit;

namespace Anvil.CSharp.Tests;

public class ReferenceListStateTests
{
    [Fact]
    public void CapacityReadUsesTheCallerListStateWithoutMutatingIt()
    {
        using var call = new ReferencePublicGraphTests.Call("public static class Rules { public static int Capacity(List<int> value) => value.Capacity; }", "Capacity");
        var list = new List<int>(17) { 4 }; var enumerator = list.GetEnumerator();
        Assert.Equal(17, call.Invoke(list)); Assert.Equal(17, list.Capacity); Assert.True(enumerator.MoveNext());
    }
    [Fact]
    public void VersionWrapsExactlyAsTheSourceListCounter()
    {
        using var call = new ReferencePublicGraphTests.Call("public static class Rules { public static List<int> Set(List<int> value) { value[0] = value[0]; return value; } }", "Set");
        var list = new List<int> { 1 };
        var version = typeof(List<int>).GetField("_version", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        version.SetValue(list, int.MaxValue); var enumerator = list.GetEnumerator();
        Assert.Same(list, call.Invoke(list)); Assert.Equal(int.MinValue, version.GetValue(list));
        Assert.Throws<InvalidOperationException>(() => enumerator.MoveNext());
    }

    [Fact]
    public void CopyConstructorKeepsTheOriginalAndAllocatesAnIndependentListWithCountCapacity()
    {
        using var call = new ReferencePublicGraphTests.Call("public static class Rules { public static List<int> Copy(List<int> value) => new List<int>(value); }", "Copy");
        var list = new List<int>(16) { 1, 2 }; var enumerator = list.GetEnumerator();
        var copy = Assert.IsType<List<int>>(call.Invoke(list));
        Assert.NotSame(list, copy); Assert.Equal(list, copy); Assert.Equal(2, copy.Capacity); Assert.Equal(16, list.Capacity);
        Assert.True(enumerator.MoveNext()); Assert.Equal(1, enumerator.Current);
    }

    [Fact]
    public void EditingAMemberDoesNotCountAsAListMutation()
    {
        using var call = new ReferencePublicGraphTests.Call("public sealed class Item { public int Value { get; set; } } public static class Rules { public static List<Item> Edit(List<Item> value) { value[0].Value++; return value; } }", "Edit");
        var item = call.New("Item"); var list = (System.Collections.IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(item.GetType()))!;
        list.Add(item); var enumerator = list.GetEnumerator();
        Assert.Same(list, call.Invoke(list)); Assert.True(enumerator.MoveNext()); Assert.Same(item, enumerator.Current);
        Assert.Equal(1, call.Member(item, "Value"));
    }

    [Fact]
    public void EchoDoesNotInvalidateAnExistingEnumerator()
    {
        using var call = new ReferencePublicGraphTests.Call("public static class Rules { public static List<int> Echo(List<int> value) => value; }", "Echo");
        var list = new List<int> { 1, 2 }; var enumerator = list.GetEnumerator();
        Assert.True(enumerator.MoveNext()); Assert.Same(list, call.Invoke(list));
        Assert.True(enumerator.MoveNext()); Assert.Equal(2, enumerator.Current);
    }

    [Fact]
    public void SameValueAssignmentStillInvalidatesTheEnumerator()
    {
        using var call = new ReferencePublicGraphTests.Call("public static class Rules { public static List<int> Set(List<int> value) { value[0] = value[0]; return value; } }", "Set");
        var list = new List<int> { 1, 2 }; var enumerator = list.GetEnumerator();
        Assert.True(enumerator.MoveNext()); Assert.Same(list, call.Invoke(list));
        Assert.Throws<InvalidOperationException>(() => enumerator.MoveNext()); Assert.Equal(new[] { 1, 2 }, list);
    }

    [Fact]
    public void AddThenRemoveRetainsTheCapacityGrowthAndInvalidation()
    {
        using var call = new ReferencePublicGraphTests.Call("public static class Rules { public static List<int> Roundtrip(List<int> value) { value.Add(1); value.RemoveAt(0); return value; } }", "Roundtrip");
        var list = new List<int>(); var enumerator = list.GetEnumerator();
        Assert.Same(list, call.Invoke(list)); Assert.Empty(list); Assert.Equal(4, list.Capacity);
        Assert.Throws<InvalidOperationException>(() => enumerator.MoveNext());
    }

    [Fact]
    public void MutationsBeforeThrowStillInvalidateCallerEnumeration()
    {
        using var call = new ReferencePublicGraphTests.Call("public static class Rules { public static void Mutate(List<int> value) { value[0] = value[0]; throw new InvalidOperationException(\"failed\"); } }", "Mutate");
        var list = new List<int> { 2 }; var enumerator = list.GetEnumerator();
        Assert.True(enumerator.MoveNext()); var error = Assert.Throws<InvalidOperationException>(() => call.Invoke(list));
        Assert.Equal("failed", error.Message); Assert.Throws<InvalidOperationException>(() => enumerator.MoveNext());
    }
}
