using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// servidor/fase4-26 a8 round 2 (review C:\t\revisoes\agent-pack-next\REVISAO.md, IP option D): the thin bridge of the agent
/// pack answers the problems of the Studio's Manage Dependencies with their cause and facts only; the server writes the
/// explanation and the fix (ManageDependenciesText, the same sentences the kernel's ManageDependencies writes for the owner's
/// full bridge). The hosted kernel renders them where the thin bridge's answer arrives (ThinBridge.Call), so a delivery
/// refusal (REFERENCES_NOT_ADDED) says the same as before and the agent pack carries no product text. Pure; no Studio.
/// </summary>
public sealed class ManageDependenciesTextTests
{
    private static JsonObject Neutral(string cause, string? producer, string? element, JsonObject? facts = null)
    {
        var problem = new JsonObject { ["code"] = "REFERENCES_NOT_ADDED", ["severity"] = "error", ["cause"] = cause, ["producer"] = producer, ["key"] = "k1",
            ["element"] = element, ["message"] = cause + ": neutral", ["fix"] = "fix the cause, then repeat", ["patch"] = null };
        if (facts != null) problem["facts"] = facts;
        return problem;
    }

    private static JsonObject Rendered(JsonObject problem, string module = "ZZConsumer")
    {
        var answer = new JsonObject { ["module"] = module, ["committed"] = false, ["code"] = "REFERENCES_NOT_ADDED", ["problems"] = new JsonArray(problem) };
        return ManageDependenciesText.Render(answer)["problems"]![0]!.AsObject();
    }

    [Theory]
    [InlineData("catalog-unavailable", null, null, null, "The Studio could not read the referenceable producers of ZZConsumer from its environment.",
        "check that the Studio is signed in to the module's environment (o11_studio status), then deliver the same job again")]
    [InlineData("not-referenceable", "ZZExt", null, "environment", "ZZExt is not a referenceable producer of the module's environment.",
        "check that ZZExt is published and referenceable in this environment (o11_environment referenceable), then deliver the same job again")]
    [InlineData("not-referenceable", "ZZExt", null, "catalog", "The Studio's catalog has no published signature of ZZExt.",
        "check that ZZExt is published and referenceable in this environment (o11_environment referenceable), then deliver the same job again")]
    [InlineData("signature-unavailable", "ZZExt", null, null, "The published signature of ZZExt could not be loaded by the Studio.",
        "publish ZZExt again (its published signature does not load), then deliver the same job again")]
    [InlineData("not-in-signature", "ZZExt", "IServerActionSignature:ZZAction", null, "ZZAction is not in the published signature of ZZExt.",
        "publish ZZExt with ZZAction public, then deliver the same job again (o11_dependencies list shows what ZZExt publishes)")]
    [InlineData("not-allowed", "ZZExt", "IEntitySignature:ZZRow", null, "The Studio does not let ZZConsumer reference ZZRow of ZZExt in this module kind.",
        "use ZZRow through a form this module may reference (for a server entity in a UI module, a service or server action of ZZExt), then deliver again")]
    [InlineData("not-retained", "ZZExt", "IServerActionSignature:A, IStructureSignature:B", null, "The Studio's Manage Dependencies did not keep A, B of ZZExt in ZZConsumer.",
        "an SSAM defect (reported); nothing was applied (the command rolled back): deliver the same job again once the bridge is updated")]
    public void EachCauseGetsTheKernelsSentences(string cause, string? producer, string? element, string? where, string message, string fix)
    {
        var problem = Rendered(Neutral(cause, producer, element, where == null ? null : new JsonObject { ["where"] = where }));
        Assert.Equal(message, problem["message"]!.ToString());
        Assert.Equal(fix, problem["fix"]!.ToString());
        Assert.Equal(cause, problem["cause"]!.ToString());
    }

    [Fact]
    public void TheFactsOfACauseFillItsSentence()
    {
        var ambiguous = Rendered(Neutral("ambiguous", "ZZExt", "ZZAction", new JsonObject { ["count"] = 2 }));
        Assert.Equal("ZZAction names 2 elements of ZZExt.", ambiguous["message"]!.ToString());
        Assert.Equal("name it by its original key, Type:@<key> (o11_dependencies list shows the keys of ZZExt), then deliver again", ambiguous["fix"]!.ToString());
        var published = Rendered(Neutral("not-at-published", "ZZExt", null, new JsonObject { ["after"] = "h-after", ["published"] = "h-pub" }));
        Assert.Equal("The Studio kept ZZExt at h-after; its published signature is h-pub.", published["message"]!.ToString());
        Assert.Equal("an SSAM defect (reported); nothing was applied (the command rolled back)", published["fix"]!.ToString());
    }

    /// <summary>Review M1: the dialog the thin bridge closed during the command is the first problem, with its title.</summary>
    [Fact]
    public void TheDialogTheBridgeClosedIsSaidWithItsTitle()
    {
        var dialog = Rendered(Neutral("studio-dialog", null, "Sign in", new JsonObject { ["kind"] = "Modal" }));
        Assert.Equal("A Studio dialog opened during the Manage Dependencies of ZZConsumer: \"Sign in\". The bridge closed it (Cancel, the window's X) so the command does not wait in the Studio; nothing was applied.",
            dialog["message"]!.ToString());
        Assert.StartsWith("answer what the Studio asks first", dialog["fix"]!.ToString());
    }

    [Fact]
    public void AnUnknownCauseKeepsTheBridgesTextAndAnAnswerWithoutProblemsIsUnchanged()
    {
        var other = Rendered(Neutral("some-new-cause", "ZZExt", null));
        Assert.Equal("some-new-cause: neutral", other["message"]!.ToString());
        var committed = new JsonObject { ["committed"] = true, ["added"] = new JsonArray() };
        Assert.Equal(committed.ToJsonString(), ManageDependenciesText.Render(committed.DeepClone().AsObject()).ToJsonString());
    }

    /// <summary>The hosted kernel renders the texts where the thin bridge's answer arrives: every refresh_references reply.</summary>
    [Fact]
    public void TheThinBridgeDecoratorRendersTheTextsOfARefreshReferencesReply()
    {
        JsonObject Send(string method, JsonObject? parameters) => method == "refresh_references"
            ? new JsonObject { ["module"] = "ZZConsumer", ["committed"] = false, ["code"] = "REFERENCES_NOT_ADDED",
                ["problems"] = new JsonArray(Neutral("not-in-signature", "ZZExt", "IServerActionSignature:ZZAction")) }
            : new JsonObject();
        var reply = new ThinBridge(Send).Call("refresh_references", new JsonObject { ["add"] = new JsonArray() });
        Assert.Equal("ZZAction is not in the published signature of ZZExt.", reply["problems"]![0]!["message"]!.ToString());
        var result = new JsonObject();
        var text = Anvil.Core.Delivery.Delivery.ReferencesNotAdded(result, reply)!;
        Assert.Contains("ZZAction is not in the published signature of ZZExt. Fix: publish ZZExt with ZZAction public", text);
    }
}
