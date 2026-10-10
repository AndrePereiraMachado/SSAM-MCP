using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Anvil.CSharp;
using Xunit;

namespace Anvil.Tests;

public sealed class FrozenCSharpDeliveryTests : IDisposable
{
    private readonly string directory;
    private readonly string? previousAuthority;

    public FrozenCSharpDeliveryTests()
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(FrozenCSharpDeliveryTests).Assembly.Location)!)!;
        directory = Path.Combine(root, ".local/data-logic-translator/frozen-csharp-delivery-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(directory, "authority/reservations"));
        previousAuthority = Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR");
        Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Path.Combine(directory, "authority"));
    }

    // Never back to absent: a parallel test class would then reserve in the user's authority (Pa2F1TestAuthority).
    public void Dispose() => Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Pa2F1TestAuthority.Restore(previousAuthority));

    [Fact]
    public void NoRuntimeChoiceFreezesBeforeSnapshotAndOneCompilationReachesApplyAndBothProofs()
    {
        var fixture = new Fixture(directory); var runtime = new Runtime();
        var original = fixture.Request.Specification!.ToJsonString();
        fixture.Bridge.BeforeSnapshot = () => {
            var checkpoint = DurableJson.Read(Path.Combine(runtime.TaskDirectory!, "task.json"));
            Assert.Equal("frozen", checkpoint["csharpCompilation"]!["decision"]!.ToString());
            Assert.Equal("none", checkpoint["runtimeDependencies"]!["decision"]!.ToString());
            Assert.NotNull(ReadLock(checkpoint));
        };
        var result = fixture.Run(runtime);
        Accepted(result);
        Assert.Equal(1, runtime.Acquisitions); Assert.Equal(1, runtime.Applies); Assert.Equal(2, runtime.Inspections);
        var observed = runtime.Compilations[0];
        Assert.All(runtime.Compilations, compilation => Assert.Same(observed, compilation));
        Assert.All(runtime.Compilations, compilation => Assert.Null(compilation.RuntimeFingerprint));
        Assert.Equal(ReadLock(result).Fingerprint, observed.Fingerprint);
        Assert.Equal(original, fixture.Request.Specification.ToJsonString());
        Assert.Null(fixture.Request.Producers);
        Assert.Equal(2, result["sources"]!.AsArray().Count);
        var history = result["history"]!.AsArray().Select(item => item!["stage"]!.ToString()).ToArray();
        Assert.True(Array.IndexOf(history, "csharp-compilation-frozen") < Array.IndexOf(history, "snapshot"));
        ReceiptAccepted(result);
    }

    [Fact]
    public void CompilationExecutorProvidesProofWithoutALegacyInspectionDelegate()
    {
        var fixture = new Fixture(directory); var runtime = new Runtime();
        var result = fixture.Run(runtime, legacyProofAvailable: false);
        Accepted(result);
        Assert.Equal(1, runtime.Applies); Assert.Equal(2, runtime.Inspections);
        ReceiptAccepted(result);
    }

    [Fact]
    public void FrozenCompilationGetsPostMergeProofEvenIfTheAdapterReturnsNoAssertions()
    {
        var fixture = new Fixture(directory); var runtime = new Runtime { EmptyAssertions = true };
        var result = fixture.Run(runtime);
        Accepted(result);
        Assert.Equal(2, runtime.Inspections); Assert.NotNull(result["dataProof"]);
        Assert.Equal(2, fixture.Bridge.Snapshots);
        ReceiptAccepted(result);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void InterruptedCompilationFreezeResumesItsRecordedPlanWithOrWithoutTheLockFile(bool lockAlreadyCreated)
    {
        var fixture = new Fixture(directory); fixture.Bridge.FailSnapshot = true;
        var initialRuntime = new Runtime(); var first = fixture.Run(initialRuntime);
        Assert.False(first["delivered"]!.GetValue<bool>());
        Assert.Equal("not-sent", first["writeState"]!.ToString());
        var frozen = ReadLock(first); var originalFingerprint = frozen.Fingerprint;
        var state = State(first); var decision = state["csharpCompilation"]!.AsObject();
        var path = decision["path"]!.ToString();
        decision["decision"] = "freezing"; decision["plan"] = frozen.ToJson();
        RemoveSource(state, path);
        if (!lockAlreadyCreated) File.Delete(path);
        Save(first, state);
        fixture.Bridge.FailSnapshot = false;
        var resumedRuntime = new Runtime { RejectAcquisition = true };
        var resumed = fixture.Run(resumedRuntime, fixture.Resume(first));
        Accepted(resumed);
        Assert.Equal("frozen", resumed["csharpCompilation"]!["decision"]!.ToString());
        Assert.Null(resumed["csharpCompilation"]!["plan"]);
        Assert.Equal(originalFingerprint, ReadLock(resumed).Fingerprint);
        Assert.All(resumedRuntime.Compilations, compilation => Assert.Equal(originalFingerprint, compilation.Fingerprint));
        Assert.Equal(0, resumedRuntime.Acquisitions); Assert.Equal(1, resumedRuntime.Applies); Assert.Equal(2, resumedRuntime.Inspections);
        Assert.Equal(1, fixture.Bridge.Merges); Assert.Equal(2, resumed["sources"]!.AsArray().Count);
        ReceiptAccepted(resumed);
    }

    [Fact]
    public void InterruptedFreezeWithAChangedRecordedPlanNeverCreatesOrMerges()
    {
        var fixture = new Fixture(directory); fixture.Bridge.FailSnapshot = true;
        var first = fixture.Run(new Runtime()); var frozen = ReadLock(first);
        var state = State(first); var decision = state["csharpCompilation"]!.AsObject();
        var path = decision["path"]!.ToString();
        decision["decision"] = "freezing"; decision["plan"] = frozen.ToJson();
        decision["plan"]!["compilation"]!["sourceAbis"]!.AsArray().Add(new JsonObject { ["changed"] = true });
        RemoveSource(state, path); File.Delete(path); Save(first, state);
        fixture.Bridge.FailSnapshot = false; var runtime = new Runtime { RejectAcquisition = true };
        var result = fixture.Run(runtime, fixture.Resume(first));
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Contains("fingerprint changed", result["error"]!.ToString());
        Assert.False(File.Exists(path)); Assert.Equal(0, fixture.Bridge.Merges);
        AssertUnused(runtime);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void LostMergeResponseResumesProofWithoutCreationAcquisitionOrAnotherMerge(bool unresolvedFirst)
    {
        var fixture = new Fixture(directory); fixture.Bridge.LoseMergeResponse = true;
        var initialRuntime = new Runtime(); var first = fixture.Run(initialRuntime);
        Assert.False(first["delivered"]!.GetValue<bool>());
        Assert.Equal("unknown", first["writeState"]!.ToString());
        Assert.Equal(1, initialRuntime.Applies); Assert.Equal(1, initialRuntime.Inspections);
        var fingerprint = ReadLock(first).Fingerprint; var operation = first["operationId"]!.ToString();
        fixture.Bridge.LoseMergeResponse = false;
        if (unresolvedFirst)
        {
            fixture.Bridge.UnknownStatus = true; var waitingRuntime = new Runtime { RejectAcquisition = true };
            var waiting = fixture.Run(waitingRuntime, fixture.Resume(first));
            Assert.False(waiting["delivered"]!.GetValue<bool>());
            Assert.Contains("unknown", waiting["error"]!.ToString()); AssertUnused(waitingRuntime);
            Assert.Equal("unknown", waiting["writeState"]!.ToString());
        }
        fixture.Bridge.UnknownStatus = false; var runtime = new Runtime { RejectAcquisition = true };
        var resumed = fixture.Run(runtime, fixture.Resume(first));
        Accepted(resumed);
        Assert.Equal(operation, resumed["operationId"]!.ToString());
        Assert.Equal(0, runtime.Acquisitions); Assert.Equal(0, runtime.Applies); Assert.Equal(1, runtime.Inspections);
        Assert.Equal(fingerprint, Assert.Single(runtime.Compilations).Fingerprint);
        Assert.Equal(1, fixture.Bridge.Merges); Assert.Equal(unresolvedFirst ? 2 : 1, fixture.Bridge.Reconciliations);
        ReceiptAccepted(resumed);
    }

    [Theory]
    [InlineData("compiler", "compiler binaries changed")]
    [InlineData("contract", "fingerprint changed")]
    [InlineData("abi", "fingerprint changed")]
    [InlineData("frozen-source", "another source revision")]
    [InlineData("source-file", "Task source changed")]
    [InlineData("recorded-hash", "Task source changed")]
    [InlineData("unrecorded-lock", "absent from the original receipt hashes")]
    [InlineData("missing-lock", "Task source changed")]
    [InlineData("missing-decision", "not frozen before writing")]
    public void ChangedCompilationEvidenceAfterAnAppliedWriteCannotReplay(string mutation, string diagnostic)
    {
        var fixture = new Fixture(directory); var first = fixture.Run(new Runtime { FailPostProof = true });
        Assert.False(first["delivered"]!.GetValue<bool>()); Assert.Equal("applied", first["writeState"]!.ToString());
        var state = State(first); var decision = state["csharpCompilation"]!.AsObject();
        var path = decision["path"]!.ToString(); var compilation = ReadLock(first).ToJson();
        switch (mutation)
        {
            case "compiler":
                compilation["compiler"]!.AsObject()["Anvil.CSharp"] = new string('0', 64);
                RewriteLock(updateFingerprint: true); break;
            case "contract":
                compilation["compilation"]!["specification"]!["changed"] = true;
                RewriteLock(updateFingerprint: false); break;
            case "abi":
                compilation["compilation"]!["sourceAbis"]!.AsArray().Add(new JsonObject { ["changed"] = true });
                RewriteLock(updateFingerprint: false); break;
            case "frozen-source":
                var files = compilation["source"]!["files"]!.AsObject();
                var name = files.First().Key; files[name] = files[name]!.ToString() + "\n// another revision";
                RewriteLock(updateFingerprint: true); break;
            case "source-file": File.AppendAllText(fixture.SourcePath, "\n// edited after merge"); break;
            case "recorded-hash": SourceEntry(state, path)["sha256"] = new string('0', 64); break;
            case "unrecorded-lock": RemoveSource(state, path); break;
            case "missing-lock": File.Delete(path); break;
            case "missing-decision": state.Remove("csharpCompilation"); break;
        }
        Save(first, state);
        var snapshots = fixture.Bridge.Snapshots; var runtime = new Runtime { RejectAcquisition = true };
        var result = fixture.Run(runtime, fixture.Resume(first));
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Contains(diagnostic, result["error"]!.ToString());
        Assert.Equal("applied", result["writeState"]!.ToString());
        AssertUnused(runtime); Assert.Equal(1, fixture.Bridge.Merges); Assert.Equal(snapshots, fixture.Bridge.Snapshots);

        void RewriteLock(bool updateFingerprint)
        {
            DurableJson.Write(path, compilation);
            SourceEntry(state, path)["sha256"] = DeliveryReceipt.Hash(path);
            // A prior compiler stamp/source can have a self-consistent stored hash; its
            // current-input validation must still reject it before invoking the executor.
            if (updateFingerprint) decision["fingerprint"] = DurableJson.Hash(compilation.ToJsonString());
        }
    }

    [Fact]
    public void AnUnrecordedCompilationLockCannotBeAdoptedBeforeTheFirstWrite()
    {
        var fixture = new Fixture(directory); fixture.Bridge.FailSnapshot = true;
        var first = fixture.Run(new Runtime()); var state = State(first);
        var path = state["csharpCompilation"]!["path"]!.ToString(); var bytes = File.ReadAllBytes(path);
        state.Remove("csharpCompilation"); Save(first, state);
        fixture.Bridge.FailSnapshot = false; var runtime = new Runtime { RejectAcquisition = true };
        var result = fixture.Run(runtime, fixture.Resume(first));
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Contains("unrecorded C# compilation lock", result["error"]!.ToString());
        Assert.Equal(bytes, File.ReadAllBytes(path)); AssertUnused(runtime); Assert.Equal(0, fixture.Bridge.Merges);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void RepairPreservesTheCompilationAndCannotSelectAgainAfterAnAppliedAttempt(bool removeDecision)
    {
        var fixture = new Fixture(directory); var first = fixture.Run(new Runtime { FailPostProof = true });
        Assert.False(first["delivered"]!.GetValue<bool>());
        var fingerprint = ReadLock(first).Fingerprint;
        var path = first["csharpCompilation"]!["path"]!.ToString(); var bytes = File.ReadAllBytes(path);
        var id = first["taskId"]!.ToString();
        Assert.True(DeliveryTask.PrepareRepair(fixture.Request.WorkDirectory, id));
        var state = State(first);
        Assert.True(JsonNode.DeepEquals(first["csharpCompilation"], state["csharpCompilation"]));
        Assert.Equal(fingerprint, ReadLock(state).Fingerprint);
        Assert.True(state["hasAppliedWrites"]!.GetValue<bool>());
        if (removeDecision) { state.Remove("csharpCompilation"); Save(first, state); }
        var runtime = new Runtime { RejectAcquisition = true };
        var repaired = fixture.Run(runtime, fixture.Resume(first));
        Assert.Equal(bytes, File.ReadAllBytes(path));
        if (removeDecision)
        {
            Assert.False(repaired["delivered"]!.GetValue<bool>());
            Assert.Contains("not frozen before writing", repaired["error"]!.ToString());
            AssertUnused(runtime); Assert.Equal(1, fixture.Bridge.Merges);
        }
        else
        {
            Accepted(repaired);
            Assert.Equal(fingerprint, ReadLock(repaired).Fingerprint);
            Assert.All(runtime.Compilations, compilation => Assert.Equal(fingerprint, compilation.Fingerprint));
            Assert.Equal(0, runtime.Acquisitions); Assert.Equal(1, runtime.Applies); Assert.Equal(2, runtime.Inspections);
            Assert.Equal(2, fixture.Bridge.Merges); Assert.Single(repaired["attempts"]!.AsArray());
            Assert.False(DeliveryTask.PrepareRepair(fixture.Request.WorkDirectory, id));
            ReceiptAccepted(repaired);
        }
    }

    private static JsonObject State(JsonObject result) => DurableJson.Read(Path.Combine(result["work"]!.ToString(), "task.json"));
    private static void Save(JsonObject result, JsonObject state) => DurableJson.Write(Path.Combine(result["work"]!.ToString(), "task.json"), state);
    private static JsonObject SourceEntry(JsonObject state, string path) => state["sources"]!.AsArray().OfType<JsonObject>().Single(item => item["path"]!.ToString() == path);
    private static void RemoveSource(JsonObject state, string path) => state["sources"]!.AsArray().Remove(SourceEntry(state, path));
    private static FrozenCSharpCompilation ReadLock(JsonObject state) => FrozenCSharpCompilation.Read(
        state["csharpCompilation"]!["path"]!.ToString(), state["csharpCompilation"]!["fingerprint"]!.ToString());
    private static void Accepted(JsonObject result) => Assert.True(result["delivered"]!.GetValue<bool>(), result.ToJsonString());
    private static void AssertUnused(Runtime runtime) { Assert.Equal(0, runtime.Acquisitions); Assert.Equal(0, runtime.Applies); Assert.Equal(0, runtime.Inspections); }
    private static void ReceiptAccepted(JsonObject result) => Assert.True(DeliveryReceipt.Check(Path.Combine(result["work"]!.ToString(), "result.json"))["accepted"]!.GetValue<bool>());

    private sealed class Fixture
    {
        public string SourcePath { get; }
        public DeliveryRequest Request { get; }
        public Bridge Bridge { get; } = new();
        public Fixture(string directory)
        {
            SourcePath = Path.Combine(directory, "Pricing.cs");
            File.WriteAllText(SourcePath, "public static class Pricing { public static int Price(int quantity) => quantity * 3; }");
            Request = new("Probe", SourcePath, directory, [], Specification: new JsonObject { ["csharpSource"] = SourceBundle.Read(SourcePath) }, ExpectedEnvironment: Bridge.Environment);
        }
        public DeliveryRequest Resume(JsonObject result) => DeliveryTask.ResumeRequest(Request.WorkDirectory, result["taskId"]!.ToString());
        public JsonObject Run(Runtime runtime, DeliveryRequest? request = null, bool legacyProofAvailable = true) => Delivery.Run(Bridge, request ?? Request,
            (_, _, _) => throw new InvalidOperationException("A frozen C# delivery must use ApplyCompilation"),
            inspectSpecification: legacyProofAvailable ? (_, _, _) => throw new InvalidOperationException("A frozen C# proof must use InspectCompilation") : null,
            dependencyRuntime: runtime);
    }

    private sealed class Runtime : IDeliveryCompilationRuntime
    {
        public int Acquisitions, Applies, Inspections;
        public bool RejectAcquisition, FailPostProof, EmptyAssertions;
        public string? TaskDirectory;
        public List<FrozenCSharpCompilation> Compilations { get; } = [];
        public FrozenFrameworkDependencies? Acquire(DeliveryDependencyContext context)
        {
            Acquisitions++; Assert.False(RejectAcquisition, "An existing C# task cannot acquire another runtime choice");
            TaskDirectory = context.TaskDirectory;
            Assert.NotNull(context.Compilation); Assert.Empty(context.Compilation.RequiredIntrinsics!);
            return null;
        }
        public JsonObject ApplyCompilation(string basePath, string jobPath, string outputPath, FrozenCSharpCompilation compilation, FrozenFrameworkDependencies? dependencies)
        {
            Applies++; Observe(compilation, dependencies); File.WriteAllText(outputPath, "foreign");
            return new JsonObject { ["isValid"] = true, ["accepted"] = true };
        }
        public JsonObject InspectCompilation(string snapshot, JsonObject specification, JsonObject? expectedTypes, FrozenCSharpCompilation compilation, FrozenFrameworkDependencies? dependencies)
        {
            Inspections++; Observe(compilation, dependencies);
            compilation.ValidateReuse(specification["csharpSource"]!, compilation.Environment, compilation.ModuleKey, dependencies);
            if (expectedTypes != null) Assert.Equal("preserved", expectedTypes["binding"]!.ToString());
            var accepted = !(FailPostProof && Inspections == 2);
            return new JsonObject { ["accepted"] = accepted, ["count"] = EmptyAssertions ? 0 : 1,
                ["expectedTypes"] = expectedTypes?.DeepClone() ?? new JsonObject { ["binding"] = "preserved" },
                ["assertions"] = EmptyAssertions ? new JsonArray() : new JsonArray(new JsonObject { ["element"] = "action/Price", ["property"] = "contract", ["expected"] = compilation.Fingerprint }),
                ["differences"] = accepted ? new JsonArray() : new JsonArray(new JsonObject { ["element"] = "action/Price", ["property"] = "contract", ["actual"] = "missing" }) };
        }
        private void Observe(FrozenCSharpCompilation compilation, FrozenFrameworkDependencies? dependencies)
        {
            Assert.Null(dependencies); Compilations.Add(compilation);
            Assert.NotEmpty(compilation.Bind(null).Specification);
        }
        public JsonObject Apply(string basePath, string jobPath, string outputPath, FrozenFrameworkDependencies dependencies)
            => throw new InvalidOperationException("Legacy runtime apply must not replace the frozen compilation");
        public JsonObject Inspect(string snapshot, JsonObject specification, JsonObject? expectedTypes, FrozenFrameworkDependencies dependencies)
            => throw new InvalidOperationException("Legacy runtime inspection must not replace the frozen compilation");
    }

    private sealed class Bridge : IBridgeClient
    {
        public string Environment = "frozen-csharp-delivery.invalid", ModuleKey = Guid.NewGuid().ToString();
        public int Snapshots, Merges, Reconciliations;
        public bool FailSnapshot, LoseMergeResponse, UnknownStatus;
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
                case "merge_status": Reconciliations++; return new() { ["state"] = UnknownStatus ? "unknown" : "applied", ["receipt"] = UnknownStatus ? null : new JsonObject { ["merged"] = true } };
                case "get_errors": return new() { ["newErrors"] = 0, ["new"] = new JsonArray() };
                default: throw new InvalidOperationException("Unexpected bridge call: " + method);
            }
        }
    }
}
