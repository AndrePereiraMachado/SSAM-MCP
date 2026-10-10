using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Atritos 2, lane F2 (A25): every producer element a job names that the producer's published signature does not show comes
/// in one refusal, PRODUCER_SIGNATURE_MISSING, one problem per element with its cause (I6: private, unpublished, theme,
/// absent) and the exact fix, before anything is written. The fix of PUBLIC_SIGNATURE_PRIVATE_TYPE proposes the private
/// option first. The real messages (`IServerAction:Operation_NewId is not a visible element of the SS360_CS signature`,
/// `A new theme dependency requires the producer OML binding`, `Element is absent from the native producer signature:
/// Insight_Search`) came one per round before.
/// </summary>
public sealed class Pa2F2ProducerTests
{
    public Pa2F2ProducerTests() => StudioAssemblies.Bind();

    [Fact]
    public void TwoMissingElementsOfTheCaptureComeInOneRefusalWithTheirCause()
    {
        var work = NativeReferenceSignatureCaptureTests.Work(); var stub = SignatureEnvironment.Primitive();
        var outPath = Path.Combine(work, "refused.avsig");
        using var session = HeadlessSession.ConnectStudio(stub, "lab.example", null, readOnly: true);
        var error = Assert.Throws<KernelRefusalException>(() => ProducerSignatureCapture.Capture(session, new SignatureCaptureRequest("ZZHighCodePrimitives",
            ["IServerActionSignature:Operation_NewId", "IServerActionSignature:CSharpTextCompareOrdinal", "IServerActionSignature:Insight_Search"], outPath)));
        Assert.Equal("PRODUCER_SIGNATURE_MISSING", error.Code);
        var problems = error.Problems!.OfType<JsonObject>().ToArray();
        Assert.Equal(new[] { "IServerActionSignature:Operation_NewId", "IServerActionSignature:Insight_Search" }, problems.Select(p => p["element"]!.GetValue<string>()));
        Assert.All(problems, p =>
        {
            Assert.Equal("PRODUCER_SIGNATURE_MISSING", p["code"]!.GetValue<string>());
            Assert.Equal("absent", p["cause"]!.GetValue<string>());
            Assert.Equal("ZZHighCodePrimitives", p["producer"]!.GetValue<string>());
            Assert.Contains("publish ZZHighCodePrimitives", p["fix"]!.GetValue<string>());
        });
        Assert.Contains("not a visible element of the ZZHighCodePrimitives signature", error.Message);
        Assert.False(File.Exists(outPath));   // refused before anything is written
        // The CLI envelope (and the delivery task, Delivery.cs) carry the code and every problem.
        var envelope = Errors.Envelope("signature", error, 1);
        Assert.Equal("PRODUCER_SIGNATURE_MISSING", envelope["code"]!.GetValue<string>());
        Assert.Equal(2, envelope["problems"]!.AsArray().Count);
    }

    [Fact]
    public void AnElementOfAnotherKindIsNamedInTheFix()
    {
        // (The cause private, an element the payload has only hidden, is proven on the native fixture of
        // NativeDependencyReaderTests.HiddenExistingAbiCanBeValidatedByOriginalKeyButCannotBecomeANewExport.)
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Pa2F2ProducerTests).Assembly.Location)!)!;
        var work = NativeReferenceSignatureCaptureTests.Work();
        // The (System) payload as the committed consumers reconstruct it: Login is a server action signature.
        var recorded = SignatureFixtures.FromConsumers(new ModelHost(Path.Combine(work, "model")),
            [Path.Combine(root, "tests/fixtures/blank-service.oml"), Path.Combine(root, "tests/fixtures/reactive-ui.oml")],
            "uXCIR2Atc0+es3zYuZSnNw", ["IServerActionSignature:Login"], isSystem: true).Snapshot;
        var error = Assert.Throws<KernelRefusalException>(() => NativeDependencyReader.ResolveServerSignature(recorded.ModuleKey, recorded.Name, recorded.SignatureBinary,
            ["IClientActionSignature:Login", "IServerActionSignature:Login", "IServerActionSignature:Pa2NoSuchAction"]));
        var problems = error.Problems!.OfType<JsonObject>().ToArray();
        Assert.Equal(new[] { "IClientActionSignature:Login", "IServerActionSignature:Pa2NoSuchAction" }, problems.Select(p => p["element"]!.GetValue<string>()));
        Assert.All(problems, p => Assert.Equal("absent", p["cause"]!.GetValue<string>()));
        Assert.StartsWith("use IServerActionSignature:Login", problems[0]["fix"]!.GetValue<string>());
    }

    [Fact]
    public void EveryThemeASignatureCannotImportIsListedWithItsCause()
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Pa2F2ProducerTests).Assembly.Location)!)!;
        var snapshot = NativeReferenceSnapshot.Read(Path.Combine(root, "tests/contracts/native-reference/ordinal-primitive.avsig"));
        var themes = NativeReferenceStubs.Themes(snapshot, [
            new NativeReferenceElement("web-theme", "Pa2Tema", "AAAAAAAAAAAAAAAAAAAAAA"),
            new NativeReferenceElement("action", "CSharpTextCompareOrdinal", "BBBBBBBBBBBBBBBBBBBBBB"),
            new NativeReferenceElement("mobile-theme", "Pa2TemaMobile", "CCCCCCCCCCCCCCCCCCCCCC")]);
        Assert.Equal(new[] { "Pa2Tema", "Pa2TemaMobile" }, themes.Select(t => t["element"]!.GetValue<string>().Split(':')[1]));
        Assert.All(themes, t =>
        {
            Assert.Equal("theme", t["cause"]!.GetValue<string>());
            Assert.Contains("producer OML", t["fix"]!.GetValue<string>());
        });
        var refusal = Anvil.Core.Preflight.ProducerSignatureMissing.Refusal(snapshot.Name, themes);
        Assert.Equal("PRODUCER_SIGNATURE_MISSING", refusal.Code);
        Assert.Equal(2, refusal.Problems!.Count);
        Assert.Contains("A new theme dependency requires the producer OML binding", refusal.Message);
    }

    [Fact]
    public void ThePublicSignatureFixProposesThePrivateOptionFirst()
    {
        var ops = JsonNode.Parse("""
        [{"op":"spec","data":{"structures":[{"name":"Resumo","attributes":[{"name":"Total","type":"Integer"}]}]}},
         {"op":"logic","data":{"actions":[{"name":"ObterResumo","public":true,"outputs":[{"name":"Result","type":"Resumo"}],"steps":[{"assign":{"Result.Total":"1"}}]}]}}]
        """)!.AsArray();
        var problem = Assert.Single(JobPreflight.PublicSignatures(ops, "/ops"));
        var fix = problem["fix"]!.GetValue<string>();
        Assert.StartsWith("make 'ObterResumo' private", fix);
        Assert.True(fix.IndexOf("private", StringComparison.Ordinal) < fix.IndexOf("\"public\": true", StringComparison.Ordinal));
        // The patch still writes the public type (the second option), for a caller who chooses it.
        Assert.Equal("/ops/0/data/structures/0/public", problem["patch"]![0]!["path"]!.GetValue<string>());
    }
}
