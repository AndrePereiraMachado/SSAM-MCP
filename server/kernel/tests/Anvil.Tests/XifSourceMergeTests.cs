using Anvil.Xif;
using Xunit;

namespace Anvil.Tests;

/// <summary>XifSourceMerge: only the bodies the spec gives change; every signature comes from the stubs; untouched bodies
/// and the author's helper members stay byte for byte; D8 turns the declared names into ss&lt;Name&gt;.</summary>
public sealed class XifSourceMergeTests
{
    private static string Fixture(string path) => File.ReadAllText(Path.Combine(XifCompilerTests.Fixtures, path));

    [Fact]
    public void DeclaredNamesBecomeTheStubParameterNames()
    {
        var merged = XifSourceMerge.Merge("ZZHybridXifLab", Fixture("stubs\\ZZHybridXifLab.cs"), null, [new XifActionBody("Add", "Result = checked(Left + Right);")]);
        Assert.Contains("ssResult = checked(ssLeft + ssRight);", merged.Source);
        Assert.DoesNotContain("// TODO: Write implementation for action", merged.Source);
        Assert.Equal(["Add"], merged.Changed);
        // Everything before and after the method is the stub, byte for byte (the trailing "// MssAdd" comment included).
        var stub = Fixture("stubs\\ZZHybridXifLab.cs");
        var start = stub.IndexOf("public void MssAdd", StringComparison.Ordinal);
        var end = stub.IndexOf("} // MssAdd", StringComparison.Ordinal) + 1;
        Assert.StartsWith(stub[..start], merged.Source);
        Assert.EndsWith(stub[end..], merged.Source);
    }

    [Fact]
    public void OnlyTheSpecBodiesChangeAndHelpersStayByteForByte()
    {
        var current = Fixture("current\\ZZHybridXifLab.cs");
        var merged = XifSourceMerge.Merge("ZZHybridXifLab", Fixture("stubs-edit\\ZZHybridXifLab.cs"), current,
            [new XifActionBody("Add", "Result = checked(Left + Right);"), new XifActionBody("Multiply", "Result = checked(Left * Right);")]);
        var text = merged.Source;
        // The helper and the untouched body of Echo are the author's bytes.
        Assert.Contains("\t\tprivate static int Twice(int value) {\n\t\t\treturn  FakeRuntime.Twice(value);   // odd spacing kept on purpose\n\t\t}".Replace("\n", NewLine(current)), text);
        Assert.Contains("\t\t\tssEchoed   =   ssValue + \"!\"; // untouched body", text);
        // Echo's signature follows the stubs (a new input), its body stays.
        Assert.Contains("public void MssEcho(string ssValue, string ssSuffix, out string ssEchoed) {", text);
        Assert.DoesNotContain("public void MssEcho(string ssValue, out string ssEchoed)", text);
        // Add's body is the spec's; Multiply is new; Gone is no longer in the stubs.
        Assert.Contains("ssResult = checked(ssLeft + ssRight);", text);
        Assert.DoesNotContain("ssLeft - ssRight", text);
        Assert.Contains("public void MssMultiply(int ssLeft, int ssRight, out int ssResult)", text);
        Assert.Contains("ssResult = checked(ssLeft * ssRight);", text);
        Assert.DoesNotContain("MssGone", text);
        Assert.True(text.IndexOf("MssEcho", StringComparison.Ordinal) < text.IndexOf("MssMultiply", StringComparison.Ordinal));
        Assert.Equal(new[] { "Add", "Echo", "Gone", "Multiply" }, merged.Changed.Order(StringComparer.Ordinal));
        Assert.True(merged.BodyLines.ContainsKey("Add") && merged.BodyLines.ContainsKey("Multiply"));
        Assert.False(merged.BodyLines.ContainsKey("Echo"));
        // A second merge of the result with the same input changes nothing.
        var again = XifSourceMerge.Merge("ZZHybridXifLab", Fixture("stubs-edit\\ZZHybridXifLab.cs"), text,
            [new XifActionBody("Add", "Result = checked(Left + Right);"), new XifActionBody("Multiply", "Result = checked(Left * Right);")]);
        Assert.Equal(text, again.Source);
        Assert.Empty(again.Changed);
    }

    [Fact]
    public void ANameThatResolvesToAnotherSymbolIsNotRewritten()
    {
        var members = new HashSet<string>(StringComparer.Ordinal) { "Right" };
        var body = "var Left2 = Left;\nvar o = new { Result = 1 };\nint Total = o.Result;\nResult = Fn(Left: Left2, x: Right) + Total;";
        var rewritten = XifSourceMerge.RewriteDeclaredNames(body, ["ssLeft", "ssRight", "ssResult", "ssTotal"], members);
        Assert.Equal("var Left2 = ssLeft;\nvar o = new { Result = 1 };\nint Total = o.Result;\nssResult = Fn(Left: Left2, x: Right) + Total;", rewritten);
        // ss names are accepted as written.
        Assert.Equal("ssResult = ssLeft;", XifSourceMerge.RewriteDeclaredNames("ssResult = ssLeft;", ["ssLeft", "ssResult"], new HashSet<string>()));
    }

    [Fact]
    public void StubsWithoutTheExtensionClassAreRefused()
    {
        var refusal = Assert.Throws<XifRefusal>(() => XifSourceMerge.Merge("Other", Fixture("stubs\\ZZHybridXifLab.cs"), null, []));
        Assert.Equal(XifCodes.MergeFailed, refusal.Code);
        var unknown = Assert.Throws<XifRefusal>(() => XifSourceMerge.Merge("ZZHybridXifLab", Fixture("stubs\\ZZHybridXifLab.cs"), null, [new XifActionBody("Nope", "return;")]));
        Assert.Contains("MssNope", unknown.Problems[0].Message);
    }

    private static string NewLine(string text) => text.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
}
