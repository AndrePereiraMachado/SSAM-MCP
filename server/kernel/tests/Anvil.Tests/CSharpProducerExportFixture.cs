using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Anvil.CSharp;

namespace Anvil.Tests;

/// <summary>Explicit synthetic controller receipt for consistency tests. Proof flags are
/// test stubs; creating this receipt does not attest a native model or publication.</summary>
internal sealed class CSharpProducerExportFixture
{
    internal string Work { get; }
    internal string ResultPath { get; }
    internal string SourcePath => State["request"]!["JobPath"]!.ToString();
    internal string CompilationPath => State["csharpCompilation"]!["path"]!.ToString();
    internal string SnapshotPath => State["deliveredSnapshot"]!["path"]!.ToString();
    internal string Environment => Compilation.Environment;
    internal string ModuleKey => Compilation.ModuleKey;
    internal JsonObject State { get; }
    internal FrozenCSharpCompilation Compilation { get; }
    internal FrozenFrameworkDependencies? Runtime { get; }
    internal CSharpProducerExport Export { get; }

    internal CSharpProducerExportFixture(bool usesRuntime = false, bool historicalCompiler = false)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(CSharpProducerExportFixture).Assembly.Location)!)!;
        Work = Path.Combine(root, ".local/data-logic-translator/csharp-producer-export-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Work);
        var moduleKey = Keys.ToStudio(Guid.NewGuid().ToString());
        const string environment = "export-fixture.invalid";
        var source = JsonValue.Create(usesRuntime
            ? "#nullable enable\npublic static class Words { public static int Compare(string? left, string? right) => string.CompareOrdinal(left, right); }"
            : "public static class Pricing { public static int Price(int quantity) => quantity * 3; }")!;
        if (usesRuntime)
        {
            var compiled = CSharpCompiler.Compile(SourceBundle.From(source)); var intrinsic = compiled.RequiredIntrinsics!.Single();
            var producerKey = Guid.NewGuid().ToString(); var elementKey = Guid.NewGuid().ToString(); var signatureHash = Guid.NewGuid().ToString();
            var path = Path.Combine(Work, "runtime.avsig");
            File.WriteAllText(path, new JsonObject {
                ["FormatVersion"] = 1, ["Environment"] = environment, ["ModuleKey"] = producerKey, ["ApplicationKey"] = "",
                ["Name"] = "RuntimeTest", ["ModuleKind"] = "Extension", ["SignatureHash"] = signatureHash,
                ["SignatureBinary"] = Convert.ToBase64String([1, 2, 3]),
                ["Elements"] = new JsonArray(new JsonObject { ["Kind"] = "action", ["Name"] = "NativeOrdinal", ["Key"] = elementKey })
            }.ToJsonString());
            var artifact = Path.Combine(Work, "runtime.xif"); File.WriteAllText(artifact, "synthetic package artifact");
            Runtime = FrozenFrameworkDependencies.Create(compiled.SourceHash, compiled.RequiredIntrinsics!, environment, moduleKey,
                new("FixtureOnly", "synthetic", DeliveryReceipt.Hash(artifact), artifact),
                [new("Runtime", path, DeliveryReceipt.Hash(path), producerKey, signatureHash)],
                [new(intrinsic.Reference, "Runtime", "NativeOrdinal", elementKey, intrinsic.Inputs, intrinsic.Output)]);
        }
        var frozen = FrozenCSharpCompilation.Create(source, environment, moduleKey, Runtime);
        if (historicalCompiler)
        {
            var document = frozen.ToJson(); document["compiler"]!.AsObject()["Anvil.CSharp"] = new string('0', 64);
            frozen = FrozenCSharpCompilation.FromJson(document, DurableJson.Hash(document.ToJsonString()));
        }
        Compilation = frozen;
        var snapshot = Path.Combine(Work, "producer.oml"); File.WriteAllText(snapshot, "synthetic snapshot bytes, not a native OML");
        Export = WriteReceipt(frozen, Runtime, snapshot, Work);
        ResultPath = Path.Combine(Work, "deliver", Export.TaskId, "result.json");
        State = DurableJson.Read(Path.Combine(Path.GetDirectoryName(ResultPath)!, "task.json"));
    }

    internal void Save()
    {
        DurableJson.Write(Path.Combine(Path.GetDirectoryName(ResultPath)!, "task.json"), State);
        File.WriteAllText(ResultPath, State.ToJsonString());
    }

    internal static CSharpProducerExport WriteReceipt(FrozenCSharpCompilation frozen, FrozenFrameworkDependencies? runtime, string snapshotPath, string work)
    {
        Directory.CreateDirectory(work);
        var specification = new JsonObject { ["csharpSource"] = frozen.Source };
        var sourcePath = Path.Combine(work, "export-source-" + Guid.NewGuid().ToString("N") + ".json");
        File.WriteAllText(sourcePath, specification.ToJsonString());
        var request = new DeliveryRequest("FixtureProducer", sourcePath, work, [], Specification: specification, ExpectedEnvironment: frozen.Environment);
        using var task = new DeliveryTask(request);
        var compilationPath = Path.Combine(task.DirectoryPath, "csharp-compilation.json"); frozen.Write(compilationPath);
        var sources = new JsonArray(Artifact(sourcePath), Artifact(compilationPath));
        var decision = new JsonObject { ["decision"] = "frozen", ["path"] = compilationPath,
            ["fingerprint"] = frozen.Fingerprint, ["sourceHash"] = frozen.SourceHash, ["profile"] = frozen.Profile };
        var runtimeDecision = new JsonObject { ["decision"] = "none", ["sourceHash"] = frozen.SourceHash, ["requirementsHash"] = DurableJson.Hash("[]") };
        if (runtime != null)
        {
            var runtimePath = Path.Combine(task.DirectoryPath, "runtime-lock.json"); runtime.Write(runtimePath); sources.Add(Artifact(runtimePath));
            foreach (var producer in runtime.Producers) sources.Add(Artifact(producer.Path));
            if (runtime.Package.ArtifactPath != null) sources.Add(Artifact(runtime.Package.ArtifactPath));
            runtimeDecision = new JsonObject { ["decision"] = "frozen", ["path"] = runtimePath,
                ["fingerprint"] = runtime.Fingerprint, ["sourceHash"] = frozen.SourceHash, ["requirementsHash"] = runtime.RequirementsHash };
        }
        var snapshot = new JsonObject { ["key"] = frozen.ModuleKey, ["environment"] = frozen.Environment,
            ["path"] = Path.GetFullPath(snapshotPath), ["sha256"] = DeliveryReceipt.Hash(snapshotPath), ["snapshot_id"] = Guid.NewGuid().ToString("N") };
        var state = task.State;
        state["moduleKey"] = frozen.ModuleKey; state["environment"] = frozen.Environment;
        state["specification"] = specification.DeepClone(); state["contractHash"] = DurableJson.Hash(specification.ToJsonString());
        state["delivered"] = true; state["everDelivered"] = true; state["writeState"] = "applied"; state["hasAppliedWrites"] = true;
        state["apply"] = new JsonObject { ["accepted"] = true, ["isValid"] = true };
        state["requirementsBeforeMerge"] = SyntheticProof(); state["dataProof"] = SyntheticProof();
        state["newErrors"] = 0; state["failures"] = new JsonArray();
        state["sources"] = sources; state["artifacts"] = new JsonArray(Artifact(snapshotPath));
        state["csharpCompilation"] = decision; state["runtimeDependencies"] = runtimeDecision; state["deliveredSnapshot"] = snapshot;
        state["csharpExports"] = new JsonObject { ["sourceHash"] = frozen.SourceHash, ["compilation"] = decision.DeepClone(),
            ["snapshot"] = snapshot.DeepClone(), ["sourceAbis"] = frozen.Compilation.SourceAbis!.DeepClone() };
        task.Save("complete");
        return CSharpProducerExport.FromDelivery(Path.Combine(task.DirectoryPath, "result.json"));
    }

    private static JsonObject Artifact(string path) => new() { ["path"] = Path.GetFullPath(path), ["sha256"] = DeliveryReceipt.Hash(path) };
    private static JsonObject SyntheticProof() => new() { ["accepted"] = true, ["count"] = 0,
        ["assertions"] = new JsonArray(), ["differences"] = new JsonArray(),
        ["scope"] = "Synthetic receipt fixture only; no native model proof or publication is asserted by this helper." };
}
