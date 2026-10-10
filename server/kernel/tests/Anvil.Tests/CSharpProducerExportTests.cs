using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

public sealed class CSharpProducerExportTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ControllerReceiptPreservesOriginalCompilationRuntimeAndSnapshotEvidence(bool usesRuntime)
    {
        var fixture = new CSharpProducerExportFixture(usesRuntime);
        var export = CSharpProducerExport.FromDelivery(fixture.ResultPath);
        export.Validate(fixture.Environment.ToUpperInvariant(), fixture.ModuleKey);
        Assert.Equal(fixture.Compilation.Fingerprint, export.Compilation.Fingerprint);
        Assert.Equal(fixture.Runtime?.Fingerprint, export.Runtime?.Fingerprint);
        Assert.Equal(fixture.State["taskId"]!.ToString(), export.TaskId);
        Assert.Equal(DeliveryReceipt.Hash(fixture.ResultPath), export.ReceiptSha256);
        Assert.Equal(DeliveryReceipt.Hash(fixture.SnapshotPath), export.DeliveredSnapshotSha256);
        Assert.True(JsonNode.DeepEquals(fixture.Compilation.Compilation.Specification, export.Compilation.Compilation.Specification));
        export.Compilation.Compilation.Specification.Clear(); export.Compilation.ToJson().Clear();
        Assert.Equal(fixture.Compilation.Fingerprint, export.Compilation.Fingerprint);
        Assert.Empty(typeof(CSharpProducerExport).GetConstructors()); Assert.True(typeof(CSharpProducerExport).IsSealed);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void HistoricalCompilerStampIsReadAsOriginalEvidenceButCannotResumeAuthorship(bool usesRuntime)
    {
        var fixture = new CSharpProducerExportFixture(usesRuntime, historicalCompiler: true);
        var export = CSharpProducerExport.FromDelivery(fixture.ResultPath);
        export.Validate(fixture.Environment, fixture.ModuleKey);
        Assert.Equal(new string('0', 64), export.Compilation.ToJson()["compiler"]!["Anvil.CSharp"]!.ToString());
        Assert.Equal(fixture.Compilation.Fingerprint, export.Compilation.Fingerprint);
        Assert.Throws<InvalidOperationException>(() => export.Compilation.Bind(export.Runtime));
        Assert.Throws<InvalidOperationException>(() => export.Compilation.ValidateReuse(export.Compilation.Source, fixture.Environment, fixture.ModuleKey, export.Runtime));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void EditingOrRemovingTheWorkingFileDoesNotChangeOriginalEmbeddedSourceEvidence(bool removeWorkingFile)
    {
        var fixture = new CSharpProducerExportFixture();
        var original = fixture.Export.Compilation.Source.ToJsonString();
        if (removeWorkingFile) File.Delete(fixture.SourcePath); else File.WriteAllText(fixture.SourcePath, "new authoring revision");
        Assert.False(DeliveryReceipt.Check(fixture.ResultPath)["accepted"]!.GetValue<bool>());
        fixture.Export.Validate(fixture.Environment, fixture.ModuleKey);
        var readAgain = CSharpProducerExport.FromDelivery(fixture.ResultPath);
        Assert.Equal(original, readAgain.Compilation.Source.ToJsonString());
        Assert.Equal(fixture.Export.Compilation.Fingerprint, readAgain.Compilation.Fingerprint);
    }

    [Theory]
    [InlineData("delivered")]
    [InlineData("stage")]
    [InlineData("write-state")]
    [InlineData("data-proof")]
    [InlineData("pre-merge-proof")]
    [InlineData("apply-contract")]
    [InlineData("apply-validity")]
    [InlineData("new-errors")]
    [InlineData("failures")]
    [InlineData("legacy-no-exports")]
    [InlineData("task-id")]
    [InlineData("work")]
    public void ExportFlagsCannotReplaceACompletedAcceptedControllerProof(string mutation)
    {
        var fixture = new CSharpProducerExportFixture(); var state = fixture.State;
        switch (mutation)
        {
            case "delivered": state["delivered"] = false; break;
            case "stage": state["stage"] = "data-proof"; break;
            case "write-state": state["writeState"] = "unknown"; break;
            case "data-proof": state["dataProof"]!["accepted"] = false; break;
            case "pre-merge-proof": state["requirementsBeforeMerge"]!["accepted"] = false; break;
            case "apply-contract": state["apply"]!["accepted"] = false; break;
            case "apply-validity": state["apply"]!["isValid"] = false; break;
            case "new-errors": state["newErrors"] = 1; break;
            case "failures": state["failures"]!.AsArray().Add(new JsonObject { ["stage"] = "verify", ["error"] = "failed" }); break;
            case "legacy-no-exports": state.Remove("csharpExports"); state.Remove("csharpCompilation"); break;
            case "task-id": state["taskId"] = Guid.NewGuid().ToString("N"); break;
            case "work": state["work"] = fixture.Work; break;
        }
        fixture.Save();
        Assert.Throws<InvalidOperationException>(() => CSharpProducerExport.FromDelivery(fixture.ResultPath));
    }

    [Theory]
    [InlineData("export-source")]
    [InlineData("export-abi")]
    [InlineData("export-compilation")]
    [InlineData("decision-profile")]
    [InlineData("accepted-specification")]
    [InlineData("contract-hash")]
    [InlineData("embedded-source")]
    [InlineData("export-snapshot")]
    [InlineData("snapshot-key")]
    [InlineData("snapshot-environment")]
    [InlineData("snapshot-sha")]
    [InlineData("environment")]
    [InlineData("module")]
    [InlineData("no-runtime-hash")]
    [InlineData("runtime-source")]
    public void ExportMetadataMustMatchTheOriginalRequestLockSnapshotAndRuntimeChoice(string mutation)
    {
        var fixture = new CSharpProducerExportFixture(); var state = fixture.State;
        var exports = state["csharpExports"]!;
        switch (mutation)
        {
            case "export-source": exports["sourceHash"] = new string('0', 64); break;
            case "export-abi": exports["sourceAbis"]!.AsArray().Add(new JsonObject { ["id"] = "invented" }); break;
            case "export-compilation": exports["compilation"]!["fingerprint"] = new string('0', 64); break;
            case "decision-profile":
                state["csharpCompilation"]!["profile"] = "reference-graph-2-staged";
                exports["compilation"] = state["csharpCompilation"]!.DeepClone(); break;
            case "accepted-specification": state["specification"]!["csharpSource"] = "another accepted source"; break;
            case "contract-hash": state["contractHash"] = new string('0', 64); break;
            case "embedded-source":
                state["request"]!["Specification"]!["csharpSource"] = "public static class Different { public static int Price() => 4; }";
                state["specification"] = state["request"]!["Specification"]!.DeepClone();
                state["contractHash"] = DurableJson.Hash(state["specification"]!.ToJsonString()); break;
            case "export-snapshot": exports["snapshot"]!["snapshot_id"] = "other"; break;
            case "snapshot-key": state["deliveredSnapshot"]!["key"] = "other"; exports["snapshot"] = state["deliveredSnapshot"]!.DeepClone(); break;
            case "snapshot-environment": state["deliveredSnapshot"]!["environment"] = "other.invalid"; exports["snapshot"] = state["deliveredSnapshot"]!.DeepClone(); break;
            case "snapshot-sha": state["deliveredSnapshot"]!["sha256"] = new string('0', 64); exports["snapshot"] = state["deliveredSnapshot"]!.DeepClone(); break;
            case "environment": state["environment"] = "other.invalid"; break;
            case "module":
                state["moduleKey"] = "other"; state["deliveredSnapshot"]!["key"] = "other";
                exports["snapshot"] = state["deliveredSnapshot"]!.DeepClone(); break;
            case "no-runtime-hash": state["runtimeDependencies"]!["requirementsHash"] = new string('0', 64); break;
            case "runtime-source": state["runtimeDependencies"]!["sourceHash"] = new string('0', 64); break;
        }
        fixture.Save();
        Assert.Throws<InvalidOperationException>(() => CSharpProducerExport.FromDelivery(fixture.ResultPath));
    }

    [Theory]
    [InlineData("compilation")]
    [InlineData("snapshot")]
    [InlineData("runtime-lock")]
    [InlineData("runtime-producer")]
    [InlineData("runtime-package")]
    public void EvidenceFilesAreRecheckedAfterExportCreation(string artifact)
    {
        var fixture = new CSharpProducerExportFixture(usesRuntime: true);
        var path = artifact switch {
            "compilation" => fixture.CompilationPath, "snapshot" => fixture.SnapshotPath,
            "runtime-lock" => fixture.State["runtimeDependencies"]!["path"]!.ToString(),
            "runtime-producer" => fixture.Runtime!.Producers[0].Path,
            _ => fixture.Runtime!.Package.ArtifactPath!
        };
        File.AppendAllText(path, "changed evidence bytes");
        Assert.Throws<InvalidOperationException>(() => fixture.Export.Validate(fixture.Environment, fixture.ModuleKey));
        Assert.Throws<InvalidOperationException>(() => CSharpProducerExport.FromDelivery(fixture.ResultPath));
    }

    [Theory]
    [InlineData("compilation")]
    [InlineData("snapshot")]
    [InlineData("runtime-lock")]
    [InlineData("runtime-producer")]
    [InlineData("runtime-package")]
    public void UnrecordedEvidenceCannotBeAddedToAnExport(string artifact)
    {
        var fixture = new CSharpProducerExportFixture(usesRuntime: true);
        var path = artifact switch {
            "compilation" => fixture.CompilationPath, "snapshot" => fixture.SnapshotPath,
            "runtime-lock" => fixture.State["runtimeDependencies"]!["path"]!.ToString(),
            "runtime-producer" => fixture.Runtime!.Producers[0].Path,
            _ => fixture.Runtime!.Package.ArtifactPath!
        };
        var records = fixture.State[artifact == "snapshot" ? "artifacts" : "sources"]!.AsArray();
        records.Remove(records.Single(item => item!["path"]!.ToString() == path)); fixture.Save();
        Assert.Throws<InvalidOperationException>(() => CSharpProducerExport.FromDelivery(fixture.ResultPath));
    }

    [Theory]
    [InlineData("none")]
    [InlineData("fingerprint")]
    [InlineData("requirements")]
    public void ARequiredRuntimeCannotBeDroppedOrReplaced(string mutation)
    {
        var fixture = new CSharpProducerExportFixture(usesRuntime: true);
        var decision = fixture.State["runtimeDependencies"]!;
        if (mutation == "none") decision["decision"] = "none";
        else decision[mutation == "fingerprint" ? "fingerprint" : "requirementsHash"] = new string('0', 64);
        fixture.Save();
        Assert.Throws<InvalidOperationException>(() => CSharpProducerExport.FromDelivery(fixture.ResultPath));
    }

    [Theory]
    [InlineData("result-only")]
    [InlineData("checkpoint-only")]
    [InlineData("both-after-read")]
    public void ReceiptAndCheckpointAreComparedAndPinnedForTheReaderLifetime(string mutation)
    {
        var fixture = new CSharpProducerExportFixture(); fixture.State["new-metadata"] = true;
        if (mutation == "result-only") File.WriteAllText(fixture.ResultPath, fixture.State.ToJsonString());
        else if (mutation == "checkpoint-only") DurableJson.Write(Path.Combine(Path.GetDirectoryName(fixture.ResultPath)!, "task.json"), fixture.State);
        else fixture.Save();
        Assert.Throws<InvalidOperationException>(() => fixture.Export.Validate(fixture.Environment, fixture.ModuleKey));
        if (mutation != "both-after-read") Assert.Throws<InvalidOperationException>(() => CSharpProducerExport.FromDelivery(fixture.ResultPath));
    }

    [Fact]
    public void SourceAbiAndContractInsideTheCompilationRemainBoundToTheRecordedFingerprint()
    {
        var fixture = new CSharpProducerExportFixture(); var document = fixture.Compilation.ToJson();
        document["compilation"]!["sourceAbis"]!.AsArray().Add(new JsonObject { ["id"] = "invented" });
        document["compilation"]!["specification"]!["changed"] = true;
        DurableJson.Write(fixture.CompilationPath, document);
        fixture.State["sources"]!.AsArray().Single(item => item!["path"]!.ToString() == fixture.CompilationPath)!["sha256"] = DeliveryReceipt.Hash(fixture.CompilationPath);
        fixture.Save();
        Assert.Throws<InvalidOperationException>(() => CSharpProducerExport.FromDelivery(fixture.ResultPath));
    }

    [Fact]
    public void ProducerEvidenceCannotBeUsedForAnotherEnvironmentOrModule()
    {
        var fixture = new CSharpProducerExportFixture();
        Assert.Throws<InvalidOperationException>(() => fixture.Export.Validate("other.invalid", fixture.ModuleKey));
        Assert.Throws<InvalidOperationException>(() => fixture.Export.Validate(fixture.Environment, "other"));
    }
}
