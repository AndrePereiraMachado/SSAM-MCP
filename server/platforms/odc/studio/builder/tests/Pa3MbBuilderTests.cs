using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.Model.Enumerations;
using OutSystems.ModelAPILoader;
using Xunit;

namespace Builder.Tests;

/// <summary>
/// Package 3, lane mb. C02 B1: a kernel candidate whose receipt proves this (base, candidate) pair becomes a manifest without
/// loading either model; anything else takes the model path. C09: the module root is compared (DefaultScreen), and a name
/// that cannot be read never brings the builder down.
/// </summary>
public sealed class Pa3MbBuilderTests : IDisposable {
    private const string Author = "pa3mb@builder.test";
    private readonly string dir = Path.Combine(Path.GetTempPath(), "pa3mb-builder", Guid.NewGuid().ToString("N")[..8]);
    public Pa3MbBuilderTests() => Directory.CreateDirectory(dir);
    public void Dispose() { try { Directory.Delete(dir, true); } catch (IOException) { } }

    private static string Fixture(string name) => Path.Combine(StudioRuntime.KernelRoot, "tests", "fixtures", "odc", name);
    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));

    // A capture as the bridge writes it: the OML and its sidecar (module, key, sha256, capturedAt, host, developerId).
    private string Capture(byte[] bytes) {
        var header = OmlHeader.Read(bytes)!;
        var path = Path.Combine(dir, header.Name + "-" + Sha(bytes) + ".oml");
        File.WriteAllBytes(path, bytes);
        File.WriteAllText(path + ".json", new JsonObject { ["ok"] = true, ["module"] = header.Name, ["moduleKey"] = header.Key, ["sha256"] = Sha(bytes),
            ["capturedAt"] = DateTimeOffset.UtcNow.ToString("o"), ["host"] = "pa3mb.outsystems.dev", ["developerId"] = Author }.ToJsonString());
        return path;
    }

    // A kernel candidate folder: the candidate and, optionally, the kernel's receipt beside it (kernel-result.json).
    private string Candidate(byte[] bytes, JsonObject? receipt) {
        var folder = Path.Combine(dir, "kernel-" + Guid.NewGuid().ToString("N")[..6]);
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "kernel-candidate.oml");
        File.WriteAllBytes(path, bytes);
        if (receipt != null) File.WriteAllText(Path.Combine(folder, "kernel-result.json"), new JsonObject { ["ok"] = true, ["data"] = receipt }.ToJsonString());
        return path;
    }

    private static JsonObject Receipt(byte[] candidate, byte[] basis, int created = 1, int changed = 0, string author = Author) => new() {
        ["accepted"] = true, ["isValid"] = true, ["outSha256"] = Sha(candidate).ToLowerInvariant(), ["baseSha256"] = Sha(basis).ToLowerInvariant(), ["developerId"] = author,
        ["footprint"] = new JsonObject { ["createdTotal"] = created, ["changedTotal"] = changed },
    };

    // The same bytes header, another body: a model load of it throws, so a manifest written from it proves no model was loaded.
    private static byte[] HeaderOnly(byte[] oml) {
        var length = BitConverter.ToInt32(oml, 3);
        var bytes = oml.Take(7 + length).Concat(Enumerable.Repeat((byte)0xAB, 4096)).ToArray();
        return bytes;
    }

    private (int Exit, string Output) Prepare(string basis, string candidate) {
        var output = Path.Combine(dir, "manifest-" + Guid.NewGuid().ToString("N")[..6]);
        var exit = PrepareManifest.Run(new[] { "--base", basis, "--candidate", candidate, "--output", output, "--feature", "pa3mb",
            "--owners", "[\"Pa3Mb\"]", "--changes", "[\"pa3mb test\"]" }, dir);
        return (exit, output);
    }

    private static JsonNode BuilderReceipt(string output) => JsonNode.Parse(File.ReadAllText(Path.Combine(output, "builder-receipt.json")))!;

    [Fact]
    public void AKernelCandidateWithItsReceiptBecomesAManifestWithoutLoadingTheModel() {
        if (!StudioRuntime.Available) return;
        var basisBytes = File.ReadAllBytes(Fixture("blank-mobile.oml"));
        var candidateBytes = HeaderOnly(basisBytes);
        var basis = Capture(basisBytes);
        var candidate = Candidate(candidateBytes, Receipt(candidateBytes, basisBytes, created: 2, changed: 1));
        var clock = Stopwatch.StartNew();
        var (exit, output) = Prepare(basis, candidate);
        clock.Stop();
        Assert.Equal(0, exit);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(2), "fast path took " + clock.Elapsed);
        var receipt = BuilderReceipt(output);
        Assert.Equal("kernel-receipt", receipt["path"]!.GetValue<string>());
        Assert.Equal(2, receipt["change"]!["added"]!.GetValue<int>());
        Assert.Equal(1, receipt["change"]!["changedProperties"]!.GetValue<int>());
        var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(output, "manifest.json")))!;
        Assert.Equal(Sha(candidateBytes), manifest["candidateSha256"]!.GetValue<string>());
        Assert.Equal("CovBlankMobile", manifest["module"]!.GetValue<string>());
    }

    [Fact]
    public void ATamperedCandidateTakesTheModelPath() {
        if (!StudioRuntime.Available) return;
        var basisBytes = File.ReadAllBytes(Fixture("blank-mobile.oml"));
        var basis = Capture(basisBytes);
        // The receipt names other candidate bytes: the models are loaded and compared (the candidate equals the base).
        var candidate = Candidate(basisBytes, Receipt(HeaderOnly(basisBytes), basisBytes));
        var refused = Assert.Throws<InvalidOperationException>(() => Prepare(basis, candidate));
        Assert.Contains("Candidate equals the live module", refused.Message);
    }

    [Fact]
    public void AReceiptOfAnotherAuthorNeverSkipsTheModels() {
        if (!StudioRuntime.Available) return;
        var basisBytes = File.ReadAllBytes(Fixture("blank-mobile.oml"));
        var candidateBytes = HeaderOnly(basisBytes);
        var basis = Capture(basisBytes);
        // The kernel applied the job as someone else: the model path loads the candidate (and fails on these bytes).
        var candidate = Candidate(candidateBytes, Receipt(candidateBytes, basisBytes, author: "other@builder.test"));
        Assert.ThrowsAny<Exception>(() => Prepare(basis, candidate));
        Assert.Empty(Directory.GetFiles(dir, "manifest.json", SearchOption.AllDirectories));
    }

    [Fact]
    public void AReceiptOfAnotherModuleHeaderNeverSkipsTheModels() {
        if (!StudioRuntime.Available) return;
        var basisBytes = File.ReadAllBytes(Fixture("blank-mobile.oml"));
        var other = HeaderOnly(File.ReadAllBytes(Fixture("blank-workflow.oml")));
        var basis = Capture(basisBytes);
        var candidate = Candidate(other, Receipt(other, basisBytes));
        // The receipt matches the files, but the header names another module: the model path loads it (and fails on it).
        Assert.ThrowsAny<Exception>(() => Prepare(basis, candidate));
        Assert.Empty(Directory.GetFiles(dir, "manifest.json", SearchOption.AllDirectories));
    }

    [Fact]
    public void TheModuleRootIsCompared() {
        if (!StudioRuntime.Available) return;
        // The base: the anonymized ODC lane fixture. The candidate: the same module with only ESpace.DefaultScreen set.
        var basisBytes = File.ReadAllBytes(Fixture("insurance-reactive-r8.oml"));
        byte[] candidateBytes; string screen;
        using (var model = PrepareManifest.Services(Author).LoadESpace(basisBytes, CancellationToken.None, loadFlags: LoadFlags.SkipUpgrades, enableTransactions: true, developerId: Author, trackChanges: true)) {
            var target = CandidateChange.Nodes(model).OfType<OutSystems.Model.UI.IUIFlowNodeSignature>()
                .Where(n => ModelPath.Kind(n).EndsWith("Screen", StringComparison.Ordinal) && !ReferenceEquals(n, model.DefaultScreen))
                .OrderBy(n => n.DisplayName, StringComparer.Ordinal).First();
            screen = target.DisplayName;
            model.TransactionsManager.ExecuteTransaction("pa3mb default screen", (_, _) => { model.DefaultScreen = target; return true; });
            candidateBytes = model.Save();
        }
        var basis = Capture(basisBytes);
        var candidate = Candidate(candidateBytes, null); // no receipt: the model path
        var (exit, output) = Prepare(basis, candidate);
        Assert.Equal(0, exit);
        var change = BuilderReceipt(output)["change"]!;
        Assert.Equal("model", BuilderReceipt(output)["path"]!.GetValue<string>());
        Assert.Equal(0, change["added"]!.GetValue<int>());
        Assert.Equal(1, change["changedProperties"]!.GetValue<int>());
        Assert.Contains(change["sample"]!.AsArray(), s => s!.GetValue<string>().EndsWith(".DefaultScreen", StringComparison.Ordinal));
        Assert.False(string.IsNullOrEmpty(screen));
    }

    [Fact]
    public void ANameThatCannotBeReadIsWrittenAsKindAndKey() {
        // Lab 20 (2026-10-07): the DisplayName of a ParsedExpression threw "Duplicated object Block1" and brought the builder down.
        var node = DispatchProxy.Create<IModelObject, ThrowingName>();
        var name = CandidateChange.SafeName(node);
        Assert.Contains("#", name);
    }

    [Fact]
    public void TheOmlHeaderNamesTheModuleAndItsKey() {
        var header = OmlHeader.Read(File.ReadAllBytes(Fixture("insurance-reactive-r8.oml")));
        Assert.Equal(new OmlHeader.Identity("zd+K_z1D9E2+7T74jXyUNQ", "InsuranceApp"), header);
        Assert.Null(OmlHeader.Read(new byte[] { (byte)'P', (byte)'K', 3, 4, 0, 0, 0, 0 }));
    }

    public class ThrowingName : DispatchProxy {
        protected override object? Invoke(MethodInfo? method, object?[]? args) =>
            method?.Name == "get_DisplayName" ? throw new InvalidOperationException("Duplicated object Block1") : null;
    }
}
