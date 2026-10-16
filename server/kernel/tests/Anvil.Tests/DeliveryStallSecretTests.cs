using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>CX14 R2: what the person types in a Studio dialog (a TextBox: a password in a sign-in) never reaches the task
/// receipt. The real BridgeClient reads `windows` from a loopback fake Studio whose sign-in dialog holds a synthetic
/// marker; the stall is recorded by the real Delivery.Run. Synthetic values only.</summary>
public class DeliveryStallSecretTests
{
    private const string Marker = "SYNTH-SECRET-R2-0003";

    [Fact]
    public void ASignInDialogThatStopsTheMergeNeverWritesTypedTextToTheReceipt()
    {
        using var test = new StallCase();
        test.Studio.Report = new JsonObject { ["type"] = "DialogWindow", ["title"] = "Sign in", ["isVisible"] = true, ["isModal"] = true,
            ["texts"] = new JsonArray("Sign in to synthetic.example", "[TextBox] synthetic.user (Username)", "[TextBox] " + Marker + " (Password)", "[Button] Log In", "[Button] Cancel") };
        test.Studio.OnMerge = s => { s.ReportVisible = true; return null; };
        var result = test.Run();
        Assert.Equal("unknown", result["writeState"]!.ToString());
        Assert.Equal("dialog", result["stalled"]!["verdict"]!.ToString());
        Assert.Equal("Sign in", result["stalled"]!["blockedBy"]!["title"]!.ToString());
        Assert.Equal("Sign in | Sign in to synthetic.example | [Button] Log In | [Button] Cancel", result["stalled"]!["blockedBy"]!["question"]!.ToString());
        Assert.Equal(1, test.Studio.Count("merge_from_oml"));
        var folder = Path.Combine(test.Work, "deliver", result["taskId"]!.ToString());
        foreach (var file in new[] { "task.json", "result.json" })
        {
            var text = File.ReadAllText(Path.Combine(folder, file));
            Assert.DoesNotContain(Marker, text);
            Assert.DoesNotContain("synthetic.user", text);
            Assert.DoesNotContain("[TextBox]", text);
        }
        Assert.DoesNotContain(Marker, result.ToJsonString());
    }
}
