using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

public sealed class PatchCertaintyArgumentOrderTests
{
    [Theory]
    [InlineData("B=2, C=3", "A", "1", "A=1, B=2, C=3")]
    [InlineData("A=1, C=3", "B", "2", "A=1, B=2, C=3")]
    [InlineData("A=1, B=2", "C", "3", "A=1, B=2, C=3")]
    [InlineData("A= 1, C=3  ", "B", "2", "A= 1, B=2, C=3  ")]
    [InlineData("A=1  ", "B", "2", "A=1  , B=2")]
    [InlineData("C=3, A=1", "B", "2", "C=3, A=1, B=2")]
    [InlineData("A, C", "B", "2", "A, B=2, C")]
    [InlineData("C, A", "B", "2", "C, A, B=2")]
    [InlineData("", "B", "2", "B=2")]
    [InlineData("A=Trim(\"x,y)\"), C=If(State, True, False)", "B", "0", "A=Trim(\"x,y)\"), B=0, C=If(State, True, False)")]
    [InlineData("A=`If(\nState, \"x,y)\", \"z\")`, C=3", "B", "2", "A=`If(\nState, \"x,y)\", \"z\")`, B=2, C=3")]
    public void InsertionPreservesExistingArgumentsAndCanonicalOrdering(string arguments, string input, string value, string expected)
    {
        // Escaped flow expressions have backslash-n in the source, rather than a physical line break.
        arguments = arguments.Replace("\n", "\\n"); expected = expected.Replace("\n", "\\n");
        const string prefix = "client action Check\n  Probe = ReadValue(";
        const string suffix = ")  # Keep\n  end\n";
        Assert.Equal(prefix + expected + suffix, VerifySourceEdits.AddFlowArgument(prefix + arguments + suffix, "Probe", "ReadValue", input, value));
    }
}
