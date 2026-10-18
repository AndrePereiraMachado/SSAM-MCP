using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>fix/unpublished-library (family OF, session b67c47db of 2026-10-15): a job references an element that exists only
/// in the producer's open model, added or made Public after its last publication. The frozen (published) signature lacks it,
/// and the kernel's REFERENCE_ELEMENT_MISSING said "fix its kind or name, capture the producer again ..., or remove it from
/// the reference op", which invites changing what the job means. Its fix now says to publish the producer first (a write:
/// the person's own words), then the same job; else to write an element the producer publishes. Never "remove it". The
/// facade answers PRODUCER_NOT_PUBLISHED itself when it reads the open model; this is the text of the kernel's own refusal
/// when it does not. Pure: no Studio.</summary>
public sealed class UnpublishedLibraryKernelTests
{
    private static JsonObject MissingProblem(string producer)
    {
        var reference = new JsonObject { ["op"] = "reference", ["producer"] = producer, ["elements"] = new JsonArray("IServerAction:GetPolicy", "IServerAction:GetQuotes") };
        var problems = JobRunner.ReferenceProblems(new ArgumentException("Element not declared in the frozen producer signature: IServerAction:GetQuotes"), reference, 0, "/ops");
        return Assert.Single(problems)!.AsObject();
    }

    [Fact]
    public void AnElementThePublishedSignatureLacksIsFixedByPublishingTheProducerNeverByRemovingIt()
    {
        var problem = MissingProblem("FloodServices_CS");
        Assert.Equal("REFERENCE_ELEMENT_MISSING", problem["code"]!.GetValue<string>());
        Assert.Equal("/ops/0/elements/1", problem["pointer"]!.GetValue<string>());
        var fix = problem["fix"]!.GetValue<string>();
        Assert.Contains("publish FloodServices_CS first (o11_publish, with the person's own words), then deliver the same job again", fix);
        Assert.Contains("o11_dependencies list shows what it publishes", fix);
        Assert.DoesNotContain("remove it", fix, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Round 2 (review C:\t\revisoes\unpublished-lib, A1, the same family on O11): an extension signature holds server
    /// actions and entities only (NativeReferenceSnapshot.Select, format 1). Another kind is never fixed by publishing the
    /// extension: its fix says the kind cannot be referenced through the signature.</summary>
    [Fact]
    public void AKindAnExtensionSignatureCannotHoldIsNeverFixedByPublishing()
    {
        var reference = new JsonObject { ["op"] = "reference", ["producer"] = "PdfExtension", ["elements"] = new JsonArray("IStructure:PdfOptions") };
        var problems = JobRunner.ReferenceProblems(new ArgumentException("Native extension references require a server action or entity signature: IStructure:PdfOptions"), reference, 0, "/ops");
        var problem = Assert.Single(problems)!.AsObject();
        Assert.Equal("REFERENCE_ELEMENT_MISSING", problem["code"]!.GetValue<string>());
        Assert.Equal("/ops/0/elements/0", problem["pointer"]!.GetValue<string>());
        var fix = problem["fix"]!.GetValue<string>();
        Assert.Contains("the kind of IStructure:PdfOptions cannot be referenced through the signature of producer PdfExtension", fix);
        Assert.Contains("an extension signature holds server actions and entities", fix);
        Assert.DoesNotContain("publish PdfExtension first", fix);
    }

    [Theory]
    [InlineData(@"C:\work\producers\FloodServices_CS.avsig")]
    [InlineData(@"C:\work\producers\FloodServices_CS.oml")]
    public void AProducerBoundByItsFileIsNamedByTheFile(string file)
    {
        var fix = MissingProblem(file)["fix"]!.GetValue<string>();
        Assert.StartsWith("the published signature of producer FloodServices_CS has no IServerAction:GetQuotes", fix);
        Assert.DoesNotContain(@"C:\work", fix);
    }
}
