using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>Family F5: the comparison of an action with its text (FlowExactness), without a module. A node the platform named
/// otherwise is the same node (the expected takes the platform's name with its references); a name kept in another case is the
/// same expression; a real difference (a wrong target, a wrong expression, a missing node, swapped branches) is still one,
/// named by the element's id, the property, the text's value and the action's.</summary>
public sealed class FlowExactnessTests
{
    private const string Text = "/// Doubles when asked.\nserver action CmpX @A1\n  in Flag: Boolean @p1\n  out Total: Integer @p2\n"
        + "  Got = CmpOne() @n1\n  if Flag: @n2\n    assign Total = Got.Value * 2 @n3\n    end @n4\n  assign Total = Got.Value @n5\n  end @n4\n";

    private static FlowItem Read(string text) => ModuleFlow.Read(text);
    private static string? Id(string key) => key;

    [Fact]
    public void ANodeThePlatformNamedOtherwiseIsTheSameNodeWithItsReferences()
    {
        var expected = Read(Text);
        var read = Read(Text.Replace("Got = CmpOne()", "Got2 = CmpOne()").Replace("Got.Value", "Got2.Value"));
        Assert.NotEmpty(FlowExactness.Differences(expected, read, Id));
        // No element of its scope holds the text's name: the platform's name, with the expressions that read the node.
        var adopted = Assert.Single(FlowExactness.AdoptNodeNames(expected, read, _ => null));
        Assert.Equal(("n1", "Got", "Got2", (string?)null), (adopted.Key, adopted.Asked, adopted.Given, adopted.Holder));
        Assert.Empty(FlowExactness.Differences(expected, read, Id));
        Assert.Equal(read.Canon(), expected.Canon());
    }

    [Fact]
    public void ANameTheActionAlsoDeclaresIsNeverRewritten()
    {
        // The text declares a local Got and names a node Got: two meanings of one name; the difference stays, named.
        var text = Text.Replace("  out Total: Integer @p2\n", "  out Total: Integer @p2\n  local Got: Integer @l1\n");
        var expected = Read(text);
        var read = Read(text.Replace("Got = CmpOne()", "Got2 = CmpOne()"));
        var taken = Assert.Single(FlowExactness.AdoptNodeNames(expected, read));
        Assert.Equal("the local Got of this action", taken.Holder);
        var difference = Assert.Single(FlowExactness.Differences(expected, read, Id));
        Assert.Equal("n1", difference.Id);
        Assert.Equal("Name", difference.Property);
        Assert.Equal("Got", difference.Expected);
        Assert.Equal("Got2", difference.Actual);
    }

    [Fact]
    public void ANameAnElementOfTheScopeHoldsIsNeverAdopted()
    {
        // A variable of the screen named Got (what the session finds in the scope): the text's Got says two things.
        var expected = Read(Text);
        var read = Read(Text.Replace("Got = CmpOne()", "Got2 = CmpOne()"));
        var taken = Assert.Single(FlowExactness.AdoptNodeNames(expected, read, name => name == "Got" ? "the LocalVariable Got of Home" : null));
        Assert.Equal("the LocalVariable Got of Home", taken.Holder);
        // Nothing of the expected was rewritten: the assignments still read Got.
        Assert.Contains("Got.Value * 2", expected.Canon());
        Assert.DoesNotContain("Got2", expected.Canon());
    }

    [Fact]
    public void ANameInAnotherCaseIsTheSameExpressionAndALiteralIsNot()
    {
        var expected = Read(Text);
        var read = Read(Text.Replace("Got.Value * 2", "got.value * 2"));
        Assert.Single(FlowExactness.AdoptNameCase(expected, read));
        Assert.Empty(FlowExactness.Differences(expected, read, Id));
        Assert.True(FlowExactness.SameButCase("A.b = \"x\"", "a.B = \"x\""));
        Assert.False(FlowExactness.SameButCase("A = \"x\"", "A = \"X\""));
    }

    // Generated: each real difference of the read is one problem naming the node, the property, the text's value and the action's.
    public static IEnumerable<object[]> RealDifferences() =>
    [
        ["wrong expression", Text.Replace("Got.Value * 2", "Got.Value * 3"), "n3", "assignment 1"],
        ["wrong target", Text.Replace("Got = CmpOne()", "Got = CmpTwo()"), "n1", "Action"],
        ["missing node", "/// Doubles when asked.\nserver action CmpX @A1\n  in Flag: Boolean @p1\n  out Total: Integer @p2\n"
            + "  Got = CmpOne() @n1\n  if Flag: @n2\n    assign Total = Got.Value * 2 @n3\n    end @n4\n  end @n4\n", "n5", "element"],
        ["swapped branches", "/// Doubles when asked.\nserver action CmpX @A1\n  in Flag: Boolean @p1\n  out Total: Integer @p2\n"
            + "  Got = CmpOne() @n1\n  if Flag: @n2\n    assign Total = Got.Value @n5\n    end @n4\n  assign Total = Got.Value * 2 @n3\n  end @n4\n", "n2", "connector"],
    ];

    [Fact]
    public void APropertyThePlatformDoesNotKeepIsNamedWithNothingAsTheActual()
    {
        // The receipts' second cause: a description (or a value at its default) the platform drops on the way.
        var described = Text.Replace("  Got = CmpOne() @n1\n", "  /// Reads the one.\n  Got = CmpOne() @n1\n");
        var difference = Assert.Single(FlowExactness.Differences(Read(described), Read(Text), Id));
        Assert.Equal(("n1", "Description", "Reads the one.", (string?)null), (difference.Id, difference.Property, difference.Expected, difference.Actual));
        Assert.Contains("@n1 Execute Got: Description reads nothing, the text says `Reads the one.`", difference.Message);
    }

    [Theory, MemberData(nameof(RealDifferences))]
    public void ARealDifferenceIsNamedByItsNodeWithTheExpectedAndTheActual(string what, string readText, string id, string property)
    {
        var expected = Read(Text);
        var read = Read(readText);
        FlowExactness.AdoptNodeNames(expected, read, _ => null);
        FlowExactness.AdoptNameCase(expected, read);
        var differences = FlowExactness.Differences(expected, read, Id);
        Assert.True(differences.Any(d => d.Id == id && d.Property.StartsWith(property, StringComparison.Ordinal)),
            what + ": " + string.Join(" | ", differences.Select(d => d.Message)));
        Assert.All(differences, d => Assert.True(d.Expected != null || d.Actual != null));
        Assert.Contains(differences, d => d.Message.Contains("@" + id, StringComparison.Ordinal));
    }
}
