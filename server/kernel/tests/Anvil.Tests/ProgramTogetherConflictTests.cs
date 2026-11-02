using System.Text.Json.Nodes;
using OutSystems.Model;
using Xunit;

namespace Anvil.Tests;

/// <summary>F1 conflict (owner 2026-11-02: stopping because the person was programming is "imperdoável"): the person and the
/// job change the SAME property between the delivery's capture and its merge. The delivery's value wins in the same call,
/// with a note; the person's other edits stay. The harness is in ProgramTogetherTests.cs.</summary>
public partial class ProgramTogetherTests
{
    private static void SetDescription(string live, string action, string text) => Edit(live, model =>
    {
        foreach (var a in Actions(model, action)) a.GetType().GetProperty("Description")!.SetValue(a, text);
    });
    private static string? DescriptionOf(string path, string action)
    {
        var host = new Anvil.Core.ModelHost(Path.Combine(Path.GetDirectoryName(path)!, "desc-" + Guid.NewGuid().ToString("N")[..8]));
        var model = host.Load(File.ReadAllBytes(path));
        try { return Actions(model, action).Select(a => a.GetType().GetProperty("Description")!.GetValue(a)?.ToString()).SingleOrDefault(); }
        finally { Anvil.Core.ModelHost.Release(model); }
    }

    [Fact]
    public void Conflict_TheSamePropertyEditedByThePersonAndTheJobKeepsTheDeliverysValueInTheSameCall()
    {
        var studio = Studio(fingerprint: true);
        Apply(studio.Live, Action("Shared"));
        Apply(studio.Live, Action("Elsewhere"));
        SetDescription(studio.Live, "Shared", "before");
        studio.AfterBaseSnapshot = live => { SetDescription(live, "Shared", "edited by the person"); SetDescription(live, "Elsewhere", "the person's own edit"); };
        var result = Deliver(studio, """{"ops":[{"op":"set","target":"ServerAction:Shared","prop":"Description","value":"written by the job"}]}""");
        File.WriteAllText(Path.Combine(studio.Work, "conflict-result.json"), result.ToJsonString());
        Assert.True(result["delivered"]?.GetValue<bool>() == true, result["code"] + " " + result["error"] + " " + result["contentProof"]?["differences"]?.ToJsonString());
        Assert.Equal("written by the job", DescriptionOf(studio.Live, "Shared"));
        Assert.Equal("the person's own edit", DescriptionOf(studio.Live, "Elsewhere"));
        Assert.Contains(Notes(result), n => n.Contains("conflict", StringComparison.OrdinalIgnoreCase));
    }
}