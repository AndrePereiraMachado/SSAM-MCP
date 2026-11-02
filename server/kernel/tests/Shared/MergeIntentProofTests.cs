using System.Reflection;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>F1 (owner 2026-11-02): the rule of the post-merge proof on both lanes (this file builds into Anvil.Tests and
/// Anvil.Tests.Odc; MergeContentProof is the same source in both kernels). With the delivery's base, only what the job wrote is
/// required; editor state (canvas positions) and the person's edits are notes; a value the job wrote that is missing still
/// refuses. The proof is reached by reflection so this file builds on a kernel without the base parameter (it then fails).</summary>
public class MergeIntentProofTests
{
    private static Dictionary<(string Key, string Property), string> Values(params (string Key, string Property, string Value)[] values)
        => values.ToDictionary(v => (v.Key, v.Property), v => v.Value);

    private static JsonObject Compare(Dictionary<(string Key, string Property), string> expected, Dictionary<(string Key, string Property), string> actual,
        Dictionary<(string Key, string Property), string>? basis)
    {
        var compare = typeof(MergeContentProof).GetMethods(BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public)
            .SingleOrDefault(m => m.Name == "Compare" && m.GetParameters().Length == 5);
        Assert.True(compare != null, "MergeContentProof.Compare takes the delivery's base");
        return (JsonObject)compare!.Invoke(null, [expected, actual, null, null, basis])!;
    }

    [Fact]
    public void PositionsOnTheCanvasAreEditorStateNotes()
    {
        var proof = Compare(Values(("m/A", "api:HorizontalPosition", "scalar:3200"), ("m/A", "api:Label", "scalar:x")),
            Values(("m/A", "api:HorizontalPosition", "scalar:3240"), ("m/A", "api:Label", "scalar:x")), basis: null);
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof.ToJsonString());
        Assert.Equal(1, proof["editorState"]!["total"]!.GetValue<int>());
        Assert.NotEmpty(proof["notes"]!.AsArray());
    }

    [Fact]
    public void ThePersonsEditOfAValueTheJobDidNotWriteIsANote()
    {
        var basis = Values(("m/B", "api:Description", "scalar:before"), ("m/C", "api:Name", "scalar:New"));
        var proof = Compare(Values(("m/B", "api:Description", "scalar:before"), ("m/C", "api:Name", "scalar:Written")),
            Values(("m/B", "api:Description", "scalar:edited in the Studio"), ("m/C", "api:Name", "scalar:Written")), basis);
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof.ToJsonString());
        Assert.Equal(1, proof["outsideDelivery"]!["total"]!.GetValue<int>());
        Assert.False(proof["outsideDelivery"]!["elements"]![0]!["onWrittenElement"]!.GetValue<bool>());
    }

    [Fact]
    public void AnotherValueOfAnElementTheJobWroteEditedByThePersonIsANoteOnThatElement()
    {
        var basis = Values(("m/D", "api:Label", "scalar:1"), ("m/D", "api:Description", "scalar:1"));
        var proof = Compare(Values(("m/D", "api:Label", "scalar:2"), ("m/D", "api:Description", "scalar:1")),
            Values(("m/D", "api:Label", "scalar:2"), ("m/D", "api:Description", "scalar:9")), basis);
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof.ToJsonString());
        Assert.True(proof["outsideDelivery"]!["elements"]![0]!["onWrittenElement"]!.GetValue<bool>());
        // The owner's rule: the same element edited by both says so in a note of its own.
        Assert.Equal(1, proof["sameElement"]?["total"]?.GetValue<int>());
        Assert.Contains(proof["notes"]!.AsArray(), n => n!.ToString().Contains("also edited in the Studio", StringComparison.Ordinal));
    }

    [Fact]
    public void AValueTheJobWroteMissingAfterTheMergeStillRefuses()
    {
        var basis = Values(("m/E", "api:Label", "scalar:1"));
        var proof = Compare(Values(("m/E", "api:Label", "scalar:2"), ("m/F", "$kind", "IServerAction")),
            Values(("m/E", "api:Label", "scalar:1")), basis);
        Assert.False(proof["accepted"]!.GetValue<bool>());
        Assert.Equal(2, proof["differences"]!.AsArray().Count);
    }
}
