using System.Text.Json.Nodes;
using Anvil.Xif;
using Xunit;

namespace Anvil.Tests;

/// <summary>XifContractDiff: breaking (action removed or renamed, parameter or attribute removed or retyped, new mandatory
/// input, structure removed) against additive (new action, new optional input, new output or structure, body only).</summary>
public sealed class XifContractDiffTests
{
    private static XifDocument Before() => XifPackage.Read(XifPackage.Pack(XifSynthetic.Extension("ZZHybridXifLab", "ext",
        [XifSynthetic.Structure("Pair", "s-pair", XifSynthetic.Attribute("Left", "a-left", "rtInteger"), XifSynthetic.Attribute("Right", "a-right", "rtInteger")),
         XifSynthetic.Structure("Old", "s-old", XifSynthetic.Attribute("V", "a-v", "rtText"))],
        [
            XifSynthetic.Action("Add", "act-add", false, XifSynthetic.Input("Left", "p-left", "rtInteger"), XifSynthetic.Input("Right", "p-right", "rtInteger"), XifSynthetic.Output("Result", "p-result", "rtInteger")),
            XifSynthetic.Action("Echo", "act-echo", false, XifSynthetic.Input("Value", "p-value", "rtText")),
            XifSynthetic.Action("Gone", "act-gone", false),
            XifSynthetic.Action("Name", "act-name", true, XifSynthetic.Output("Out", "p-out", "rtText")),
        ], [])));

    [Fact]
    public void EveryBreakingKindIsBreaking()
    {
        var after = XifPackage.Read(XifPackage.Pack(XifSynthetic.Extension("ZZHybridXifLab", "ext",
            [XifSynthetic.Structure("Pair", "s-pair", XifSynthetic.Attribute("Left", "a-left", "rtText"))],
            [
                XifSynthetic.Action("Sum", "act-add", false, XifSynthetic.Input("Left", "p-left", "rtInteger"), XifSynthetic.Input("Right", "p-right", "rtInteger"), XifSynthetic.Output("Result", "p-result", "rtInteger")),
                XifSynthetic.Action("Echo", "act-echo", false, XifSynthetic.Input("Value", "p-value", "rtInteger"), XifSynthetic.Input("Strict", "p-strict", "rtBoolean")),
                XifSynthetic.Action("Name", "act-name", false, XifSynthetic.Output("Out", "p-out", "rtText")),
            ], [])));
        var diff = XifContractDiff.Diff(Before(), after);
        Assert.True(diff["breaking"]!.GetValue<bool>());
        var changes = diff["changes"]!.AsArray().Select(c => (c!["change"]!.ToString(), c["element"]!.ToString(), c["name"]!.ToString(), c["breaking"]!.GetValue<bool>())).ToList();
        Assert.Contains(("removed", "attribute", "Pair.Right", true), changes);
        Assert.Contains(("retyped", "attribute", "Pair.Left", true), changes);
        Assert.Contains(("removed", "structure", "Old", true), changes);
        Assert.Contains(("renamed", "action", "Add", true), changes);
        Assert.Contains(("retyped", "input", "Echo.Value", true), changes);
        Assert.Contains(("added", "input", "Echo.Strict", true), changes);
        Assert.Contains(("removed", "action", "Gone", true), changes);
        Assert.Contains(("function", "action", "Name", true), changes);
        var elements = diff["breakingElements"]!.AsArray().Select(e => e!["name"]!.ToString()).Order(StringComparer.Ordinal).ToArray();
        Assert.Equal(["Add", "Echo", "Gone", "Name", "Old", "Pair"], elements);
        Assert.Equal("act-gone", diff["breakingElements"]!.AsArray().Single(e => e!["name"]!.ToString() == "Gone")!["key"]!.ToString());
    }

    [Fact]
    public void AdditiveChangesAreNotBreaking()
    {
        var after = XifPackage.Read(XifPackage.Pack(XifSynthetic.Extension("ZZHybridXifLab", "ext",
            [XifSynthetic.Structure("Pair", "s-pair", XifSynthetic.Attribute("Left", "a-left", "rtInteger"), XifSynthetic.Attribute("Right", "a-right", "rtInteger"), XifSynthetic.Attribute("Note", "a-note", "rtText")),
             XifSynthetic.Structure("Old", "s-old", XifSynthetic.Attribute("V", "a-v", "rtText")),
             XifSynthetic.Structure("Fresh", "s-fresh", XifSynthetic.Attribute("V", "a-fv", "rtText"))],
            [
                XifSynthetic.Action("Add", "act-add", false, XifSynthetic.Input("Left", "p-left", "rtInteger"), XifSynthetic.Input("Right", "p-right", "rtInteger"),
                    XifSynthetic.Input("Scale", "p-scale", "rtDecimal", mandatory: false), XifSynthetic.Output("Result", "p-result", "rtInteger"), XifSynthetic.Output("Overflow", "p-overflow", "rtBoolean")),
                XifSynthetic.Action("Echo", "act-echo", false, XifSynthetic.Input("Value", "p-value", "rtText")),
                XifSynthetic.Action("Gone", "act-gone", false),
                XifSynthetic.Action("Name", "act-name", true, XifSynthetic.Output("Out", "p-out", "rtText")),
                XifSynthetic.Action("Multiply", "act-mul", false),
            ], [])));
        var diff = XifContractDiff.Diff(Before(), after);
        Assert.False(diff["breaking"]!.GetValue<bool>());
        Assert.Empty(diff["breakingElements"]!.AsArray());
        var kinds = diff["changes"]!.AsArray().Select(c => c!["change"]!.ToString() + ":" + c["name"]!.ToString()).ToArray();
        Assert.Equal(["added:Pair.Note", "added:Fresh", "added:Add.Scale", "added:Add.Overflow", "added:Multiply"], kinds);
    }

    [Fact]
    public void ABodyOnlyChangeIsAdditiveAndNameMatchingWorksWithoutKeys()
    {
        var before = new XifContract("X", [], [new XifAction { Name = "Run", Body = "return;" }]);
        var after = new XifContract("X", [], [new XifAction { Name = "Run", Body = "Value = 2;" }]);
        var diff = XifContractDiff.Diff(before, after);
        Assert.False(diff["breaking"]!.GetValue<bool>());
        Assert.Equal("body", diff["changes"]![0]!["change"]!.ToString());
        Assert.Empty(XifContractDiff.Diff(before, new XifContract("X", [], [new XifAction { Name = "Run", Body = "\n    return;  \n" }]))["changes"]!.AsArray());
    }
}
