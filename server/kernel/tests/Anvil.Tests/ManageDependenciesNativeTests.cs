using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// fix-ext-refs (2026-10-16): the Studio's own Manage Dependencies (ReferencesManager: InitializeAddReferences, SetIsChecked,
/// Refresh, CommitRefreshReferences, in one Studio command) adds NEW elements of a producer to a consumer, and brings the
/// reference to the producer's published signature when asked. The bridge runs it on the live module (refresh_references
/// with add); here the same code runs headless on a real model with the frozen signatures of the SSAM lab extension
/// ZZHighCodePrimitives: v112 (CSharpTextCompareOrdinal) referenced by the consumer, v113 published with a new action
/// (CSharpTextUtf16Length). The signature of an Extension comes from its extension reference (the catalog the Studio serves:
/// here the captured envelope), never from an OML. No server, Studio, worker or bridge.
/// </summary>
public sealed class ManageDependenciesNativeTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ManageDependenciesNativeTests).Assembly.Location)!)!;
    private static readonly string Fixture = Path.Combine(Root, "tests", "fixtures", "blank-service.oml");
    private static readonly string OldSignature = Path.Combine(Root, "tests", "contracts", "native-reference", "ordinal-primitive.avsig");
    private static readonly string NewSignature = Path.Combine(Root, "tests", "contracts", "native-reference", "text-primitives.avsig");

    private (ModelHost Host, string Work, string Base, string Key, string OldHash, string NewHash) Consumer()
    {
        StudioAssemblies.Bind();
        var work = Path.Combine(Root, ".local", "fix-ext-refs-native", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        output.WriteLine("Artifacts: " + work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var job = Path.Combine(work, "base.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "reference", ["producer"] = "Runtime",
            ["elements"] = new JsonArray("IServerActionSignature:CSharpTextCompareOrdinal") }) }.ToJsonString());
        var basePath = Path.Combine(work, "base.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, Fixture, job, basePath, bindings: new Dictionary<string, string> { ["Runtime"] = OldSignature }))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied.ToJsonString());
        var oldEnvelope = JsonNode.Parse(File.ReadAllText(OldSignature))!;
        var newEnvelope = JsonNode.Parse(File.ReadAllText(NewSignature))!;
        return (host, work, basePath, oldEnvelope["ModuleKey"]!.ToString(), oldEnvelope["SignatureHash"]!.ToString(), newEnvelope["SignatureHash"]!.ToString());
    }

    private static ModuleReference ReferenceOf(ModelHost host, string path, string key)
        => Assert.Single(host.Inspect(path).References, r => Keys.Parse(r.Key).ToString() == Keys.Parse(key).ToString());

    [Fact]
    public void TheStudiosManageDependenciesAddsANewActionOfAnExtensionAtItsPublishedSignature()
    {
        var (host, work, basePath, key, oldHash, newHash) = Consumer();
        var before = ReferenceOf(host, basePath, key);
        Assert.Equal(oldHash, before.ReferenceHash, ignoreCase: true);
        var outPath = Path.Combine(work, "added.oml");
        var result = ManageDependencies.ApplyOffline(host, basePath,
            [new DependencyRequest(null, key, ["IServerActionSignature:CSharpTextUtf16Length", "IServerActionSignature:CSharpTextCompareOrdinal"], Published: true)],
            [NewSignature], outPath);
        File.WriteAllText(Path.Combine(work, "result.json"), result.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Assert.True(result["committed"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Equal(ManageDependencies.CommandName, result["command"]!.ToString());
        Assert.Contains(result["added"]!.AsArray(), a => a!["element"]!.ToString() == "CSharpTextUtf16Length");
        Assert.Contains(result["alreadyReferenced"]!.AsArray(), a => a!["element"]!.ToString() == "CSharpTextCompareOrdinal");
        var reference = Assert.Single(result["references"]!.AsArray())!;
        Assert.Equal("Extension", reference["kind"]!.ToString());
        Assert.Equal(oldHash, reference["hashBefore"]!.ToString(), ignoreCase: true);
        Assert.Equal(newHash, reference["hashAfter"]!.ToString(), ignoreCase: true);
        // The saved model: the reference at the published signature with both actions, and a valid module.
        var after = ReferenceOf(host, outPath, key);
        Assert.Equal(newHash, after.ReferenceHash, ignoreCase: true);
        Assert.True(after.Elements > before.Elements, JsonSerializer.Serialize(after));
        Assert.True(host.Inspect(outPath).IsValid);
        // Every other reference of the module stays as it was: the Studio's Manage Dependencies touches only what it was asked.
        var others = host.Inspect(basePath).References.Where(r => r.Key != before.Key).Select(r => r.Key + "|" + r.ReferenceHash + "|" + r.Elements).OrderBy(x => x, StringComparer.Ordinal).ToList();
        Assert.Equal(others, host.Inspect(outPath).References.Where(r => r.Key != before.Key).Select(r => r.Key + "|" + r.ReferenceHash + "|" + r.Elements).OrderBy(x => x, StringComparer.Ordinal).ToList());
        Assert.NotEmpty(others);
    }

    [Fact]
    public void AnElementTheSignatureDoesNotPublishIsRefusedWithEveryProblemAndNothingIsCommitted()
    {
        var (host, work, basePath, key, oldHash, _) = Consumer();
        var outPath = Path.Combine(work, "refused.oml");
        var result = ManageDependencies.ApplyOffline(host, basePath,
            [new DependencyRequest(null, key, ["IServerActionSignature:CSharpTextUtf16Length", "IServerActionSignature:NotPublished", "IStructureSignature:AlsoMissing"], Published: true)],
            [NewSignature], outPath);
        Assert.False(result["committed"]!.GetValue<bool>(), result.ToJsonString());
        var problems = result["problems"]!.AsArray().OfType<JsonObject>().ToList();
        Assert.Equal(2, problems.Count);
        Assert.All(problems, p => Assert.Equal("not-in-signature", p["cause"]!.ToString()));
        Assert.Contains(problems, p => p["element"]!.ToString().Contains("NotPublished", StringComparison.Ordinal));
        Assert.Contains(problems, p => p["fix"]!.ToString().Contains("publish", StringComparison.OrdinalIgnoreCase));
        Assert.False(File.Exists(outPath));
        Assert.Equal(oldHash, ReferenceOf(host, basePath, key).ReferenceHash, ignoreCase: true);
    }

    [Fact]
    public void WithoutPublishedTheStudioAddsTheElementAndKeepsTheReferenceSignature()
    {
        // The dialog's Apply with only checks: the Studio keeps the hash of a reference it considers up to date.
        var (host, work, basePath, key, oldHash, _) = Consumer();
        var outPath = Path.Combine(work, "checks-only.oml");
        var result = ManageDependencies.ApplyOffline(host, basePath,
            [new DependencyRequest(null, key, ["IServerActionSignature:CSharpTextUtf16Length"], Published: false)], [NewSignature], outPath);
        Assert.True(result["committed"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Contains(result["added"]!.AsArray(), a => a!["element"]!.ToString() == "CSharpTextUtf16Length");
        Assert.Equal(oldHash, ReferenceOf(host, outPath, key).ReferenceHash, ignoreCase: true);
    }

    [Fact]
    public void TheRequestsAreReadFromTheBridgeParameters()
    {
        var requests = ManageDependencies.Requests(JsonNode.Parse("""
            {"add":[{"producer":"ZZ_Report_Ext","producer_key":"k1","elements":["IServerActionSignature:A","B"]},{"producer":"Other","elements":["@k2"]}],"published":true}
            """)!.AsObject());
        Assert.Equal(2, requests.Count);
        Assert.Equal("k1", requests[0].ProducerKey);
        Assert.Equal(["IServerActionSignature:A", "B"], requests[0].Elements);
        Assert.True(requests.All(r => r.Published));
        Assert.Null(requests[1].ProducerKey);
        Assert.Throws<ArgumentException>(() => ManageDependencies.Requests(JsonNode.Parse("""{"add":[{"elements":["A"]}]}""")!.AsObject()));
    }
}
