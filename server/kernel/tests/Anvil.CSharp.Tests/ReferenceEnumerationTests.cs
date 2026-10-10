using Xunit;

namespace Anvil.CSharp.Tests;

public class ReferenceEnumerationTests
{
    [Fact]
    public void UnreachableContinueAfterBreakDoesNotInventAnUpdatePath()
    {
        using var call = new ReferencePublicGraphTests.Call("public static class Rules { public static int Stop(List<int> values) { foreach (var item in values) { break; continue; } return 7; } }", "Stop");
        Assert.Equal(7, call.Invoke(new List<int> { 1 }));
    }

    [Fact]
    public void UnconditionalContinueStillAdvancesTheEnumerator()
    {
        using var call = new ReferencePublicGraphTests.Call("public static class Rules { public static int Count(List<int> values) { int count = 0; foreach (var item in values) { count++; continue; } return count; } }", "Count");
        Assert.Equal(3, call.Invoke(new List<int> { 4, 5, 6 }));
    }

    [Fact]
    public void ForeachVisitsTheCapturedListWithBreakAndContinue()
    {
        using var call = new ReferencePublicGraphTests.Call("""
            public static class Rules {
                public static int Sum(List<int> values) {
                    int sum = 0;
                    foreach (var item in values) { if (item < 0) continue; if (item == 9) break; sum += item; }
                    return sum;
                }
            }
            """, "Sum");
        Assert.Equal(6, call.Invoke(new List<int> { 1, -2, 2, 3, 9, 100 }));
    }

    [Fact]
    public void ForeachDetectsMutationAtTheNextMoveEvenAfterClear()
    {
        using var call = new ReferencePublicGraphTests.Call("public static class Rules { public static void Clear(List<int> values) { foreach (var item in values) values.Clear(); } }", "Clear");
        var values = new List<int> { 1 };
        var error = Assert.Throws<InvalidOperationException>(() => call.Invoke(values));
        Assert.Contains("Collection was modified", error.Message); Assert.Empty(values);
    }

    [Fact]
    public void BreakingAfterMutationDoesNotPerformAnotherVersionCheck()
    {
        using var call = new ReferencePublicGraphTests.Call("public static class Rules { public static int Clear(List<int> values) { foreach (var item in values) { values.Clear(); break; } return values.Count; } }", "Clear");
        var values = new List<int> { 1 }; Assert.Equal(0, call.Invoke(values)); Assert.Empty(values);
    }

    [Fact]
    public void ArrayEnumerationSeesElementChangesWithoutListVersionRules()
    {
        using var call = new ReferencePublicGraphTests.Call("public static class Rules { public static int Sum(int[] values) { int sum = 0; foreach (var item in values) { sum += item; values[1] = 7; } return sum; } }", "Sum");
        var values = new[] { 2, 3 }; Assert.Equal(9, call.Invoke(values)); Assert.Equal(new[] { 2, 7 }, values);
    }
}
