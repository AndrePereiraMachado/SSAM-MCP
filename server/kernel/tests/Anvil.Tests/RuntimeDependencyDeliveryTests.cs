using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Anvil.CSharp;
using Xunit;

namespace Anvil.Tests;

public sealed class RuntimeDependencyDeliveryTests : IDisposable
{
    private readonly string? previousAuthority;
    private readonly string directory;
    public RuntimeDependencyDeliveryTests()
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(RuntimeDependencyDeliveryTests).Assembly.Location)!)!;
        directory = Path.Combine(root, ".local", "data-logic-translator", "runtime-delivery-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(directory, "authority", "reservations"));
        previousAuthority = System.Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR");
        System.Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Path.Combine(directory, "authority"));
    }
    // Never back to absent: a parallel test class would then reserve in the user's authority (Pa2F1TestAuthority).
    public void Dispose() => System.Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Pa2F1TestAuthority.Restore(previousAuthority));

    [Fact]
    public void FreezePrecedesSnapshotAndTheSameLockReachesApplyAndBothProofs()
    {
        var fixture = new Fixture(directory); var runtime = new Runtime(fixture);
        var original = fixture.Request.Specification!.ToJsonString();
        fixture.Bridge.BeforeSnapshot = () => Assert.True(File.Exists(Path.Combine(runtime.TaskDirectory!, "runtime-lock.json")));
        var result = fixture.Run(runtime);
        Assert.True(result["delivered"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Equal(1, runtime.Acquisitions); Assert.Equal(1, runtime.Applies); Assert.Equal(2, runtime.Inspections);
        Assert.Single(runtime.ObservedFingerprints.Distinct()); Assert.Equal(original, fixture.Request.Specification.ToJsonString());
        Assert.Null(fixture.Request.Producers); Assert.Null(result["request"]!["Producers"]);
        var locked = ReadLock(result);
        Assert.StartsWith(result["work"]!.ToString(), locked.Producers[0].Path, StringComparison.OrdinalIgnoreCase);
        Assert.NotEqual(runtime.AcquiredPath, locked.Producers[0].Path);
        Assert.Equal(4, result["sources"]!.AsArray().Count);
        AssertCompilationRecorded(result);
        var history = result["history"]!.AsArray().Select(e => e!["stage"]!.ToString()).ToArray();
        Assert.True(Array.IndexOf(history, "runtime-dependencies-frozen") < Array.IndexOf(history, "snapshot"));
        Assert.True(DeliveryReceipt.Check(Path.Combine(result["work"]!.ToString(), "result.json"))["accepted"]!.GetValue<bool>());
    }

    [Theory]
    [InlineData("proof")]
    [InlineData("lost-merge-response")]
    public void ResumeReusesFrozenChoicesWithoutAcquisitionOrRepeatedMerge(string failure)
    {
        var fixture = new Fixture(directory); var initial = new Runtime(fixture) { FailPostProof = failure == "proof" };
        fixture.Bridge.LoseMergeResponse = failure == "lost-merge-response";
        var first = fixture.Run(initial); Assert.False(first["delivered"]!.GetValue<bool>(), first.ToJsonString());
        var fingerprint = first["runtimeDependencies"]!["fingerprint"]!.ToString();
        File.Delete(initial.AcquiredPath!); // A shared provider cache is no longer needed.
        var resumedRuntime = new Runtime(fixture) { RejectAcquisition = true, PackageRevision = "new catalog revision" };
        fixture.Bridge.LoseMergeResponse = false;
        var resumed = fixture.Run(resumedRuntime, fixture.Resume(first));
        Assert.True(resumed["delivered"]!.GetValue<bool>(), resumed.ToJsonString());
        Assert.Equal(0, resumedRuntime.Acquisitions); Assert.Equal(0, resumedRuntime.Applies); Assert.Equal(1, resumedRuntime.Inspections);
        Assert.Equal(fingerprint, Assert.Single(resumedRuntime.ObservedFingerprints)); Assert.Equal(1, fixture.Bridge.Merges);
        Assert.Equal("1", ReadLock(resumed).Package.Revision);
    }

    [Fact]
    public void FailedSnapshotResumesAnAlreadyFrozenDecision()
    {
        var fixture = new Fixture(directory); fixture.Bridge.FailSnapshot = true; var runtime = new Runtime(fixture);
        var first = fixture.Run(runtime); Assert.False(first["delivered"]!.GetValue<bool>());
        Assert.Equal("not-sent", first["writeState"]!.ToString()); Assert.Equal(0, runtime.Applies);
        runtime.RejectAcquisition = true; fixture.Bridge.FailSnapshot = false;
        var resumed = fixture.Run(runtime, fixture.Resume(first));
        Assert.True(resumed["delivered"]!.GetValue<bool>(), resumed.ToJsonString());
        Assert.Equal(1, runtime.Acquisitions); Assert.Equal(1, runtime.Applies);
    }

    [Theory]
    [InlineData("source-file")]
    [InlineData("environment")]
    [InlineData("module")]
    [InlineData("lock-file")]
    [InlineData("snapshot-file")]
    [InlineData("fingerprint")]
    [InlineData("source-hash")]
    [InlineData("requirements-hash")]
    [InlineData("missing-receipt-source")]
    public void ChangedSourceTargetOrFrozenEvidencePreventsAnyMerge(string fault)
    {
        var fixture = new Fixture(directory); fixture.Bridge.FailSnapshot = true; var runtime = new Runtime(fixture);
        var first = fixture.Run(runtime); Assert.NotNull(first["runtimeDependencies"]);
        var locked = ReadLock(first); var statePath = Path.Combine(first["work"]!.ToString(), "task.json");
        var state = DurableJson.Read(statePath);
        switch (fault)
        {
            case "source-file": File.AppendAllText(fixture.SourcePath, "\n// another revision"); break;
            case "environment": fixture.Bridge.Environment = "different.invalid"; break;
            case "module": fixture.Bridge.ModuleKey = Guid.NewGuid().ToString(); break;
            case "lock-file": File.AppendAllText(state["runtimeDependencies"]!["path"]!.ToString(), " "); break;
            case "snapshot-file": File.AppendAllText(locked.Producers[0].Path, " "); break;
            case "fingerprint": state["runtimeDependencies"]!["fingerprint"] = new string('a', 64); break;
            case "source-hash": state["runtimeDependencies"]!["sourceHash"] = new string('a', 64); break;
            case "requirements-hash": state["runtimeDependencies"]!["requirementsHash"] = new string('a', 64); break;
            case "missing-receipt-source":
                var entry = state["sources"]!.AsArray().Single(s => s!["path"]!.ToString() == locked.Producers[0].Path);
                state["sources"]!.AsArray().Remove(entry); break;
        }
        DurableJson.Write(statePath, state); runtime.RejectAcquisition = true; fixture.Bridge.FailSnapshot = false;
        var resumed = fixture.Run(runtime, fixture.Resume(first));
        Assert.False(resumed["delivered"]!.GetValue<bool>(), resumed.ToJsonString()); Assert.NotNull(resumed["error"]);
        Assert.Equal(0, fixture.Bridge.Merges); Assert.Equal(1, runtime.Acquisitions); Assert.Equal(0, runtime.Applies);
    }

    [Theory]
    [InlineData("intent", false)]
    [InlineData("unknown", false)]
    [InlineData("applied", true)]
    [InlineData("unchanged", false)]
    [InlineData("not-sent", true)]
    public void MissingDecisionAfterAWriteNeverAuthorizesFreshAcquisition(string writeState, bool hasAppliedWrites)
    {
        var fixture = new Fixture(directory); var runtime = new Runtime(fixture); var first = fixture.Run(runtime);
        Assert.True(first["delivered"]!.GetValue<bool>(), first.ToJsonString());
        var statePath = Path.Combine(first["work"]!.ToString(), "task.json"); var state = DurableJson.Read(statePath);
        state.Remove("runtimeDependencies"); state["writeState"] = writeState; state["hasAppliedWrites"] = hasAppliedWrites;
        DurableJson.Write(statePath, state); runtime.RejectAcquisition = true;
        var resumed = fixture.Run(runtime, fixture.Resume(first));
        Assert.False(resumed["delivered"]!.GetValue<bool>()); Assert.Contains("not frozen", resumed["error"]!.ToString());
        Assert.Equal(1, runtime.Acquisitions); Assert.Equal(1, fixture.Bridge.Merges);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void MissingProviderOrUnresolvedRequirementStopsBeforeSnapshot(bool providerReturnsNull)
    {
        var fixture = new Fixture(directory); var runtime = providerReturnsNull ? new Runtime(fixture) { ReturnNull = true } : null;
        var result = fixture.Run(runtime);
        Assert.False(result["delivered"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Equal(0, fixture.Bridge.Snapshots); Assert.Equal(0, fixture.Bridge.Merges);
    }

    [Fact]
    public void NullDecisionUsesLegacyDelegatesAndIsNotReacquiredOnResume()
    {
        var fixture = new Fixture(directory, "public static class Example { public static int Add(int value) => value + 1; }");
        var runtime = new Runtime(fixture) { ReturnNull = true };
        var first = fixture.Run(runtime, legacy: true);
        Assert.True(first["delivered"]!.GetValue<bool>(), first.ToJsonString());
        Assert.Equal("none", first["runtimeDependencies"]!["decision"]!.ToString());
        runtime.RejectAcquisition = true;
        var resumed = fixture.Run(runtime, fixture.Resume(first), legacy: true);
        Assert.True(resumed["delivered"]!.GetValue<bool>(), resumed.ToJsonString());
        Assert.Equal(1, runtime.Acquisitions); Assert.Equal(0, runtime.Applies); Assert.Equal(0, runtime.Inspections);
    }

    [Fact]
    public void NonCSharpDeliveryDoesNotConsultTheRuntimeProvider()
    {
        var fixture = new Fixture(directory); var runtime = new Runtime(fixture) { RejectAcquisition = true };
        var job = Path.Combine(directory, "legacy.json"); File.WriteAllText(job, "{\"ops\":[]}");
        var result = fixture.Run(runtime, fixture.Request with { JobPath = job, Specification = null }, legacy: true);
        Assert.True(result["delivered"]!.GetValue<bool>(), result.ToJsonString()); Assert.Equal(0, runtime.Acquisitions); Assert.Null(result["runtimeDependencies"]);
    }

    [Theory]
    [InlineData("lock")]
    [InlineData("producer")]
    public void FrozenArtifactChangedDuringPreMergeProofCannotBeMerged(string artifact)
    {
        var fixture = new Fixture(directory); var runtime = new Runtime(fixture);
        runtime.AfterInspection = dependencies => File.AppendAllText(artifact == "lock"
            ? Path.Combine(runtime.TaskDirectory!, "runtime-lock.json") : dependencies.Producers[0].Path, " ");
        var result = fixture.Run(runtime);
        Assert.False(result["delivered"]!.GetValue<bool>()); Assert.Contains("during inspection", result["error"]!.ToString());
        Assert.Equal(0, fixture.Bridge.Merges);
    }

    [Fact]
    public void PackageBytesAreCopiedAndPinnedForResumeWithoutTheProviderCache()
    {
        var fixture = new Fixture(directory); fixture.Bridge.FailSnapshot = true;
        var runtime = new Runtime(fixture) { IncludePackageArtifact = true };
        var first = fixture.Run(runtime); var frozen = ReadLock(first);
        Assert.Equal(Path.Combine(first["work"]!.ToString(), "runtime-package.xif"), frozen.Package.ArtifactPath);
        Assert.NotEqual(runtime.AcquiredPackagePath, frozen.Package.ArtifactPath);
        Assert.Equal(5, first["sources"]!.AsArray().Count);
        AssertCompilationRecorded(first);
        File.Delete(runtime.AcquiredPackagePath!); File.Delete(runtime.AcquiredPath!);
        runtime.RejectAcquisition = true; fixture.Bridge.FailSnapshot = false;
        var resumed = fixture.Run(runtime, fixture.Resume(first));
        Assert.True(resumed["delivered"]!.GetValue<bool>(), resumed.ToJsonString());
        File.AppendAllText(frozen.Package.ArtifactPath!, "altered");
        var rejected = fixture.Run(runtime, fixture.Resume(resumed));
        Assert.False(rejected["delivered"]!.GetValue<bool>()); Assert.Equal(1, fixture.Bridge.Merges);
        Assert.Equal(1, runtime.Acquisitions);
    }

    [Fact]
    public void RuntimeInspectionAfterMergeDoesNotDependOnTheAdaptersAssertionCount()
    {
        var fixture = new Fixture(directory); var runtime = new Runtime(fixture) { EmptyAssertions = true };
        var result = fixture.Run(runtime);
        Assert.True(result["delivered"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Equal(2, runtime.Inspections); Assert.NotNull(result["dataProof"]);
    }

    [Fact]
    public void UnknownEnvironmentNeverReachesProviderAcquisition()
    {
        var fixture = new Fixture(directory); fixture.Bridge.Environment = null!;
        var runtime = new Runtime(fixture) { RejectAcquisition = true };
        var result = fixture.Run(runtime, fixture.Request with { ExpectedEnvironment = null });
        Assert.False(result["delivered"]!.GetValue<bool>()); Assert.Contains("known target environment", result["error"]!.ToString());
        Assert.Equal(0, runtime.Acquisitions); Assert.Equal(0, fixture.Bridge.Snapshots);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void InterruptedFreezeMaterializesTheRecordedPlanWithoutAcquisition(bool lockAlreadyCreated)
    {
        var fixture = new Fixture(directory); fixture.Bridge.FailSnapshot = true;
        var runtime = new Runtime(fixture) { IncludePackageArtifact = true };
        var first = fixture.Run(runtime); var frozen = ReadLock(first);
        var statePath = Path.Combine(first["work"]!.ToString(), "task.json");
        var state = DurableJson.Read(statePath); var decision = state["runtimeDependencies"]!.AsObject();
        var lockPath = decision["path"]!.ToString();
        decision["decision"] = "freezing"; decision["plan"] = frozen.ToJson();
        var lockSource = state["sources"]!.AsArray().Single(s => s!["path"]!.ToString() == lockPath);
        state["sources"]!.AsArray().Remove(lockSource);
        if (!lockAlreadyCreated) File.Delete(lockPath);
        DurableJson.Write(statePath, state);
        runtime.RejectAcquisition = true; fixture.Bridge.FailSnapshot = false;
        File.Delete(runtime.AcquiredPath!); File.Delete(runtime.AcquiredPackagePath!);
        var resumed = fixture.Run(runtime, fixture.Resume(first));
        Assert.True(resumed["delivered"]!.GetValue<bool>(), resumed.ToJsonString());
        Assert.Equal("frozen", resumed["runtimeDependencies"]!["decision"]!.ToString());
        Assert.Equal(frozen.Fingerprint, ReadLock(resumed).Fingerprint);
        Assert.Equal(5, resumed["sources"]!.AsArray().Count);
        AssertCompilationRecorded(resumed);
        Assert.Equal(1, runtime.Acquisitions); Assert.Equal(1, fixture.Bridge.Merges);
        Assert.True(DeliveryReceipt.Check(Path.Combine(first["work"]!.ToString(), "result.json"))["accepted"]!.GetValue<bool>());
    }

    private static FrozenFrameworkDependencies ReadLock(JsonObject state) => FrozenFrameworkDependencies.Read(
        state["runtimeDependencies"]!["path"]!.ToString(), state["runtimeDependencies"]!["fingerprint"]!.ToString());

    private static void AssertCompilationRecorded(JsonObject state)
    {
        var decision = state["csharpCompilation"]!; Assert.Equal("frozen", decision["decision"]!.ToString());
        var frozen = FrozenCSharpCompilation.Read(decision["path"]!.ToString(), decision["fingerprint"]!.ToString());
        Assert.Equal(ReadLock(state).Fingerprint, frozen.RuntimeFingerprint);
        var source = Assert.Single(state["sources"]!.AsArray(), item => item!["path"]!.ToString() == decision["path"]!.ToString());
        Assert.Equal(DeliveryReceipt.Hash(decision["path"]!.ToString()), source!["sha256"]!.ToString());
    }

    private sealed class Fixture
    {
        public string SourcePath { get; }
        public DeliveryRequest Request { get; }
        public Bridge Bridge { get; } = new();
        public Fixture(string directory, string? source = null)
        {
            SourcePath = Path.Combine(directory, "Report.cs"); File.WriteAllText(SourcePath, source ?? Source);
            Request = new("Probe", SourcePath, directory, [], Specification: new JsonObject { ["csharpSource"] = SourceBundle.Read(SourcePath) }, ExpectedEnvironment: Bridge.Environment);
        }
        public DeliveryRequest Resume(JsonObject result) => DeliveryTask.ResumeRequest(Request.WorkDirectory, result["taskId"]!.ToString());
        public JsonObject Run(Runtime? runtime, DeliveryRequest? request = null, bool legacy = false) => Delivery.Run(Bridge, request ?? Request,
            (_, _, output) => { Assert.True(legacy, "Original apply delegate must not receive a bound-runtime delivery"); File.WriteAllText(output, "foreign"); return new() { ["isValid"] = true, ["accepted"] = true }; },
            inspectSpecification: (_, specification, types) => { Assert.True(legacy, "Original proof delegate must not receive a bound-runtime delivery"); return Proof(types); }, dependencyRuntime: runtime);
    }

    private sealed class Runtime(Fixture fixture) : IDeliveryDependencyRuntime
    {
        public int Acquisitions, Applies, Inspections;
        public bool RejectAcquisition, ReturnNull, FailPostProof, IncludePackageArtifact, EmptyAssertions;
        public string PackageRevision = "1";
        public string? TaskDirectory, AcquiredPath, AcquiredPackagePath;
        public List<string> ObservedFingerprints { get; } = [];
        public Action<FrozenFrameworkDependencies>? AfterInspection;
        public FrozenFrameworkDependencies? Acquire(DeliveryDependencyContext context)
        {
            Assert.False(RejectAcquisition, "Resume must not resolve providers again"); Acquisitions++;
            Assert.Equal(0, fixture.Bridge.Snapshots); Assert.NotNull(context.Compilation); TaskDirectory = context.TaskDirectory;
            Assert.True(JsonNode.DeepEquals(fixture.Request.Specification, context.Request.Specification));
            if (ReturnNull) return null;
            var intrinsic = Assert.Single(context.Compilation.RequiredIntrinsics!);
            var producerKey = Guid.NewGuid().ToString(); var elementKey = Guid.NewGuid().ToString(); var signatureHash = Guid.NewGuid().ToString();
            AcquiredPath = Path.Combine(context.Request.WorkDirectory, "shared-runtime.avsig");
            File.WriteAllText(AcquiredPath, new JsonObject {
                ["FormatVersion"] = 1, ["Environment"] = context.Environment, ["ModuleKey"] = producerKey, ["ApplicationKey"] = "",
                ["Name"] = "RuntimeTest", ["ModuleKind"] = "Extension", ["SignatureHash"] = signatureHash, ["SignatureBinary"] = Convert.ToBase64String([1, 2, 3]),
                ["Elements"] = new JsonArray(new JsonObject { ["Kind"] = "action", ["Name"] = "NativeOrdinal", ["Key"] = elementKey })
            }.ToJsonString());
            if (IncludePackageArtifact)
            {
                AcquiredPackagePath = Path.Combine(context.Request.WorkDirectory, "shared-runtime.xif");
                File.WriteAllText(AcquiredPackagePath, "controller verified package");
            }
            return FrozenFrameworkDependencies.Create(context.Compilation.SourceHash, context.Compilation.RequiredIntrinsics!, context.Environment, context.ModuleKey,
                new("RuntimeTest", PackageRevision, DurableJson.Hash("controller verified package"), AcquiredPackagePath),
                [new("Runtime", AcquiredPath, DeliveryReceipt.Hash(AcquiredPath), producerKey, signatureHash)],
                [new(intrinsic.Reference, "Runtime", "NativeOrdinal", elementKey, intrinsic.Inputs, intrinsic.Output)]);
        }
        public JsonObject Apply(string basePath, string jobPath, string outputPath, FrozenFrameworkDependencies dependencies)
        {
            Applies++; ObservedFingerprints.Add(dependencies.Fingerprint); dependencies.ValidateArtifacts();
            Assert.Equal(fixture.SourcePath, jobPath); File.WriteAllText(outputPath, "foreign");
            return new() { ["isValid"] = true, ["accepted"] = true };
        }
        public JsonObject Inspect(string snapshot, JsonObject specification, JsonObject? expectedTypes, FrozenFrameworkDependencies dependencies)
        {
            Inspections++; ObservedFingerprints.Add(dependencies.Fingerprint);
            Assert.True(JsonNode.DeepEquals(fixture.Request.Specification, specification));
            if (Inspections > 1) Assert.Equal("preserved", expectedTypes!["binding"]!.ToString());
            AfterInspection?.Invoke(dependencies);
            var proof = Proof(expectedTypes, !(FailPostProof && Inspections == 2));
            if (EmptyAssertions) { proof["assertions"] = new JsonArray(); proof["count"] = 0; }
            return proof;
        }
    }

    private static JsonObject Proof(JsonObject? types, bool accepted = true) => new() {
        ["accepted"] = accepted, ["count"] = 1, ["expectedTypes"] = types?.DeepClone() ?? new JsonObject { ["binding"] = "preserved" },
        ["assertions"] = new JsonArray(new JsonObject { ["element"] = "runtimeDependency", ["property"] = "identity", ["expected"] = "frozen" }),
        ["differences"] = accepted ? new JsonArray() : new JsonArray(new JsonObject { ["element"] = "runtimeDependency", ["property"] = "identity", ["actual"] = "missing" })
    };
    private sealed class Bridge : IBridgeClient
    {
        public string Environment = "runtime-delivery.invalid", ModuleKey = Guid.NewGuid().ToString();
        public int Snapshots, Merges;
        public bool FailSnapshot, LoseMergeResponse;
        public Action? BeforeSnapshot;
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            switch (method)
            {
                case "open_module": return new() { ["opened"] = true };
                case "get_active_module": return new() { ["name"] = "Probe", ["key"] = ModuleKey, ["environment"] = Environment };
                case "snapshot_module":
                    BeforeSnapshot?.Invoke(); Snapshots++; if (FailSnapshot) throw new IOException("Snapshot unavailable");
                    File.WriteAllText(parameters!["path"]!.ToString(), "snapshot"); return new() { ["key"] = ModuleKey, ["snapshot_id"] = "snapshot-id" };
                case "merge_from_oml": Merges++; if (LoseMergeResponse) throw new IOException("Lost applied merge response"); return new() { ["merged"] = true };
                case "merge_status": return new() { ["state"] = "applied", ["receipt"] = new JsonObject { ["merged"] = true } };
                case "get_errors": return new() { ["newErrors"] = 0, ["new"] = new JsonArray() };
                default: throw new InvalidOperationException("Unexpected bridge call: " + method);
            }
        }
    }
    private const string Source = """
        using System;
        using System.Linq;
        using System.Collections.Generic;
        using Anvil.Authoring;
        [Entity] public record Item(Id<Item> Id, string? Name);
        public record Summary(string? Name, int Count);
        public static class Reports {
            public static List<Summary> Read(IDataSession data) => data.Query<Item>()
                .GroupBy(row=>row.Name).Select(group=>new Summary(group.Key,group.Count()))
                .OrderBy(row=>row.Name,StringComparer.Ordinal).ToList();
        }
        """;
}
