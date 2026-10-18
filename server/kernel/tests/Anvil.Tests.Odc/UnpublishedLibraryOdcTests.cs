using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>fix/unpublished-library (family OF, session b67c47db of 2026-10-15), the ODC lane: the kernel's
/// REFERENCE_ELEMENT_MISSING of an element the producer's published revision lacks never says "remove it from the reference
/// op"; its fix publishes the producer first (studio_publish, the person's own words), then the same job, else names an element
/// the producer publishes. The facade answers PRODUCER_NOT_PUBLISHED itself when it reads the open model (kernel-delivery.mjs);
/// this is the kernel's own text when it does not. Pure: no Studio.</summary>
public sealed class UnpublishedLibraryOdcTests
{
    [Fact]
    public void AnElementThePublishedRevisionLacksIsFixedByPublishingTheLibraryNeverByRemovingIt()
    {
        var reference = new JsonObject { ["op"] = "reference", ["producer"] = "FloodServices", ["elements"] = new JsonArray("ServerAction:GetQuotes") };
        var problems = JobRunner.ReferenceProblems(new ArgumentException("Element not declared in the frozen producer signature: ServerAction:GetQuotes"), reference, 0, "/ops");
        var problem = Assert.Single(problems)!.AsObject();
        Assert.Equal("REFERENCE_ELEMENT_MISSING", problem["code"]!.GetValue<string>());
        Assert.Equal("/ops/0/elements/0", problem["pointer"]!.GetValue<string>());
        var fix = problem["fix"]!.GetValue<string>();
        Assert.Contains("publish FloodServices first (studio_publish, with the person's own words), then deliver the same job again", fix);
        Assert.Contains("studio_reference_snapshot lists what it publishes", fix);
        Assert.DoesNotContain("remove it", fix, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Round 2 (review C:\t\revisoes\unpublished-lib, A1): a kind the ODC published signature cannot hold (a service
    /// action, a role: NativeReferenceSnapshot.Select "Unsupported element kind") is never fixed by publishing the producer,
    /// which never adds that kind. The refusal stays REFERENCE_ELEMENT_MISSING on that element; its fix says the kind cannot be
    /// referenced through the signature and what it holds.</summary>
    [Fact]
    public void AKindTheOdcSignatureCannotHoldIsNeverFixedByPublishing()
    {
        var reference = new JsonObject { ["op"] = "reference", ["producer"] = "FloodServices", ["elements"] = new JsonArray("ServerAction:GetNcipDetails", "ServiceAction:GetRates") };
        var problems = JobRunner.ReferenceProblems(new ArgumentException("Unsupported element kind for this frozen producer signature: ServiceAction:GetRates"), reference, 0, "/ops");
        var problem = Assert.Single(problems)!.AsObject();
        Assert.Equal("REFERENCE_ELEMENT_MISSING", problem["code"]!.GetValue<string>());
        Assert.Equal("/ops/0/elements/1", problem["pointer"]!.GetValue<string>());
        var fix = problem["fix"]!.GetValue<string>();
        Assert.Contains("the kind of ServiceAction:GetRates cannot be referenced through the signature of producer FloodServices", fix);
        Assert.Contains("server actions, client actions, structures, entities and blocks", fix);
        Assert.Contains("publishing FloodServices does not change this", fix);
        Assert.DoesNotContain("publish FloodServices first", fix);
        Assert.DoesNotContain("remove it", fix, StringComparison.OrdinalIgnoreCase);
    }
}
