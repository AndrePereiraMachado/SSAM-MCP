using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
namespace Anvil.Core.Delivery;

public interface IBridgeClient { JsonObject Call(string method, JsonObject? parameters = null); }

/// <summary>The merge order (Anvil.Core.MergeOrder) on the task's files. Plan: the defaults the native merge would drop
/// and, when there are any, the first-pass copy at firstPassPath ({rule, deferred[], firstPass}). Missing: those of the
/// deferred defaults the delivered snapshot does not carry.</summary>
public interface IMergePlanner
{
    JsonObject Plan(string basePath, string foreignPath, string firstPassPath);
    JsonArray Missing(string snapshotPath, JsonArray deferred);
}
// BridgeCallException (Anvil.Core) lives in Kernel/BridgeCallException.cs: the kernel reads Executed, the adapters throw it.
/// <summary>CaptureProducers: binding names whose current server signature the delivery captures (read-only) into its
/// own task folder, records by SHA-256 and reuses on resume; absent from the serialized request when unused, so
/// earlier tasks keep their identity. CloseOpenedTab (K1-g): close the Studio tab this delivery opened when it ends in a
/// saved state; a property of the call, never of the task identity (not serialized), so a resume passes it again.</summary>
public sealed record DeliveryRequest(string Module, string JobPath, string WorkDirectory, IReadOnlyList<string> Checks,
    IReadOnlyDictionary<string, string>? Producers = null, string? TaskId = null, int? BridgePort = null, JsonObject? Specification = null, string? ExpectedEnvironment = null, string? ReservationOwner = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? CaptureProducers = null,
    [property: System.Text.Json.Serialization.JsonIgnore] bool CloseOpenedTab = false);

public sealed record DeliveryDependencyContext(DeliveryRequest Request, string Environment, string ModuleKey,
    string TaskDirectory, Anvil.CSharp.CompilationResult? Compilation);

/// <summary>The controller acquires verified runtime descriptors; apply and inspection consume only frozen choices.</summary>
public interface IDeliveryDependencyRuntime
{
    FrozenFrameworkDependencies? Acquire(DeliveryDependencyContext context);
    JsonObject Apply(string basePath, string jobPath, string outputPath, FrozenFrameworkDependencies dependencies);
    JsonObject Inspect(string snapshot, JsonObject specification, JsonObject? expectedTypes, FrozenFrameworkDependencies dependencies);
}

/// <summary>Production C# execution consumes the same frozen compilation for planning and proof,
/// including sources that selected no framework dependency.</summary>
public interface IDeliveryCompilationRuntime : IDeliveryDependencyRuntime
{
    JsonObject ApplyCompilation(string basePath, string jobPath, string outputPath, FrozenCSharpCompilation compilation, FrozenFrameworkDependencies? dependencies);
    JsonObject InspectCompilation(string snapshot, JsonObject specification, JsonObject? expectedTypes, FrozenCSharpCompilation compilation, FrozenFrameworkDependencies? dependencies);
}

/// <summary>The same delivery resumes its original proof after a merge; uncertain writes are never replayed.</summary>
public static partial class Delivery
{
    public static JsonObject Run(IBridgeClient bridge, DeliveryRequest request,
        Func<string, string, string, JsonObject> apply, Action<string>? log = null,
        Func<string, JsonArray, JsonObject>? inspectData = null,
        Func<string, JsonObject, JsonObject?, JsonObject>? inspectSpecification = null,
        IDeliveryDependencyRuntime? dependencyRuntime = null,
        IProducerSignatureAuthority? producerAuthority = null,
        Func<string, string, string, IReadOnlyDictionary<string, string>, JsonObject>? applyWithProducers = null,
        IMergePlanner? mergePlanner = null,
        Func<string, string, string, JsonObject>? previewSignatures = null)
    {
        var clock = Stopwatch.StartNew();
        // Proof-only jobs (K1 proofs, NEVER DELIVER marker) are refused before a task exists or the bridge is called.
        NonDeliverableJobs.Require(request.JobPath);
        using var task = new DeliveryTask(request);
        var result = task.State;
        var work = task.DirectoryPath;
        var stage = "validate-job";
        var failures = new List<(string Stage, string Error)>();
        ModuleReservation? reservation = null;
        if (result["closed"]?.GetValue<bool>() == true) throw new InvalidOperationException("This failed delivery was closed for revision; it cannot be replayed");
        result["delivered"] = false; result.Remove("error"); result.Remove("code"); result.Remove("warnings"); result.Remove("reselected");
        result.Remove("referencesRefreshed"); result.Remove("referencesRefreshFailed");
        IReadOnlyDictionary<string, VerifyHint>? hints = null;
        var dataProofDiffers = false;
        try
        {
            if (result["sources"] == null)
            {
                // The job as this task checks it (path + SHA-256), recorded before anything can refuse it and kept on every
                // refusal or failure: a refused preflight drops the sources (so the same task re-validates on resume), and the
                // correction that follows, patch + basedOn {taskId}, reads the job's hash here in one call (job-patch.mjs).
                result["job"] = JobIdentity(request.JobPath);
                var initial = DeliveryReceipt.Sources(request.JobPath);
                foreach (var file in request.Producers?.Values.Distinct() ?? Enumerable.Empty<string>())
                    initial.Add(new JsonObject { ["path"] = Path.GetFullPath(file), ["sha256"] = DeliveryReceipt.Hash(file) });
                result["sources"] = initial;
                JobRunner.CheckJobName(request.JobPath);
                if (request.Specification == null || !ModuleSpecification.IsAuthoredSource(request.JobPath)) JobRunner.ValidateJob(request.JobPath);
                if (request.Specification == null)
                {
                    // The whole-job preflight (C20/C28): recorded as it is, and a refusal carries every problem at once,
                    // before the Studio is touched. The task keeps no sources, so the same task id re-validates on resume;
                    // its job record (path + SHA-256) stays for the correction by basedOn {taskId}.
                    var preflight = JobPreflight.Check(request.JobPath);
                    result["preflight"] = preflight.DeepClone();
                    if (preflight["valid"]?.GetValue<bool>() == false)
                    {
                        result.Remove("sources");
                        result["code"] = PreflightRefused;
                        result["problems"] = PreflightProblems(preflight);
                        stage = "preflight";
                        return Fail("Job refused by the preflight before any Studio call; nothing was sent. "
                            + string.Join(" ", (preflight["errors"] as JsonArray ?? new JsonArray()).Select(e => e?.ToString()).Where(e => !string.IsNullOrWhiteSpace(e))));
                    }
                }
                else
                {
                    DeliveryReceipt.RequireFrozenSource(request.JobPath,request.Specification);
                    ModuleSpecification.Validate(request.Specification);
                    result["specification"] = request.Specification.DeepClone();
                    result["contractHash"] = DurableJson.Hash(request.Specification.ToJsonString());
                }
                result["expectations"] = JsonSerializer.SerializeToNode(MessageExpectations.Read(ModuleSpecification.SourceDocument(request.JobPath), request.JobPath));
                task.Save(stage);
            }
            var sources = result["sources"]!.AsArray();
            if (result["artifacts"] is JsonArray recordedArtifacts && DeliveryReceipt.Changed(recordedArtifacts).Count > 0)
                return Fail("Task artifacts changed; reconcile the original operation before continuing");
            if (DeliveryReceipt.Changed(sources).Count > 0) return Fail("Task source changed; this task covers only its original revision");
            var expectations = result["expectations"]!.Deserialize<List<ExpectedMessage>>()!;
            stage = "open";
            var opened = bridge.Call("open_module", AnsweringDependencies(new() { ["name"] = request.Module, ["timeout"] = 20,
                ["environment"] = request.ExpectedEnvironment ?? result["environment"]?.ToString(), ["module_key"] = result["moduleKey"]?.DeepClone() }));
            result["open"] = opened;
            var dependencyDialogs = AnsweredDependencies(opened);
            if (opened["opened"]?.GetValue<bool>() != true && opened["alreadyOpen"]?.GetValue<bool>() != true)
                return Fail("open_module is blocked: " + (opened["hint"]?.ToString() ?? opened["blockedBy"]?.ToJsonString()));
            stage = "active-module";
            var active = bridge.Call("get_active_module");
            if (!string.Equals(active["name"]?.ToString(), request.Module, StringComparison.OrdinalIgnoreCase))
            {
                // A08: another session of the same Studio selected its own tab between open_module and here. The task selects
                // its module again (by the task's key when it has one) instead of failing; it fails only when it cannot.
                var reopened = bridge.Call("open_module", AnsweringDependencies(new() { ["name"] = request.Module, ["timeout"] = 20,
                    ["environment"] = request.ExpectedEnvironment ?? result["environment"]?.ToString(), ["module_key"] = result["moduleKey"]?.DeepClone() }));
                if (AnsweredDependencies(reopened) is { } again)
                {
                    dependencyDialogs ??= new JsonArray();
                    foreach (var entry in again) dependencyDialogs.Add(entry!.DeepClone());
                }
                if (reopened["opened"]?.GetValue<bool>() == true || reopened["alreadyOpen"]?.GetValue<bool>() == true)
                {
                    var other = active["name"]?.ToString();
                    active = bridge.Call("get_active_module");
                    if (string.Equals(active["name"]?.ToString(), request.Module, StringComparison.OrdinalIgnoreCase))
                        result["reselected"] = new JsonArray(new JsonObject { ["stage"] = stage, ["from"] = other });
                }
                if (!string.Equals(active["name"]?.ToString(), request.Module, StringComparison.OrdinalIgnoreCase)
                    && OpenTabOf(bridge, request.Module, request.ExpectedEnvironment ?? result["environment"]?.ToString(), result["moduleKey"]?.ToString()) is { } tab)
                {
                    // The tab is open in another window (or stays unselected): every later call names module_key.
                    result["reselected"] = new JsonArray(new JsonObject { ["stage"] = stage, ["from"] = active["name"]?.ToString(), ["byKey"] = true });
                    active = tab;
                }
                if (!string.Equals(active["name"]?.ToString(), request.Module, StringComparison.OrdinalIgnoreCase))
                    return Fail("active module changed before snapshot and the module could not be selected again (the Studio shows "
                        + (active["name"]?.ToString() ?? "no module") + "); select the requested module and resume");
            }
            var key = active["key"]!.GetValue<string>();
            if (request.ExpectedEnvironment != null && !string.Equals(request.ExpectedEnvironment, active["environment"]?.ToString(), StringComparison.OrdinalIgnoreCase))
                return Fail("Selected Studio is not connected to the accepted environment");
            if (result["moduleKey"] is { } boundKey && boundKey.ToString() != key) return Fail("Task belongs to another module identity");
            if (result["environment"] is { } boundEnvironment && boundEnvironment.ToString() != active["environment"]?.ToString())
                return Fail("Task belongs to another environment");
            foreach(var source in sources.OfType<JsonObject>())
            {
                var path=source["path"]!.ToString();
                if(Path.GetExtension(path).Equals(".avsig",StringComparison.OrdinalIgnoreCase))
                    DeliveryReceipt.RequireProducerEnvironment(path,active["environment"]?.ToString());
            }
            result["moduleKey"] = key;
            result["environment"] = active["environment"]?.DeepClone();
            if (result["environment"] is { } environment)
                reservation = new ModuleReservation(Path.Combine(BridgeAccess.DirectoryPath, "reservations"), environment.ToString(), key, request.ReservationOwner ?? task.Id);
            // MB2: the bridge answered the dependencies dialog (Cancel) in the open; the Studio's own Refresh References of
            // every producer runs now, by the module's key, before the snapshot, and the delivery goes on.
            if (dependencyDialogs != null)
            {
                stage = "refresh-references";
                if (RefreshAfterDependencies(bridge, result, "open", dependencyDialogs, request.Module, key, result["environment"]?.ToString(), log) is { } refreshFailed)
                    return Fail(refreshFailed);
                task.Save(stage);
            }
            var attemptDirectory = Path.Combine(work, "attempt-" + (result["attempt"]?.GetValue<int>() ?? 0));
            Directory.CreateDirectory(attemptDirectory);
            var basePath = Path.Combine(attemptDirectory, "base.oml");
            var foreignPath = Path.Combine(attemptDirectory, "foreign.oml");
            var writeState = result["writeState"]!.ToString();
            stage = "producer-signatures";
            var producers = CaptureProducers(task, request, sources, active["environment"]?.ToString(), producerAuthority, log, key);
            if (writeState == "not-sent") AttestProducers("producerAttestation");
            stage = "runtime-dependencies";
            var frozenCompilation = ReadCompilation(task, request, active["environment"]?.ToString(), key);
            var sourceCompilation = frozenCompilation?.Compilation ?? (request.Specification == null ? null : ModuleSpecification.CompileCSharpSource(request.Specification));
            var dependencies = PrepareDependencies(task, request, active["environment"]?.ToString(), key, dependencyRuntime, sourceCompilation);
            frozenCompilation = FreezeCompilation(task, request, active["environment"]?.ToString(), key, sourceCompilation, dependencies, frozenCompilation);
            if (writeState is "intent" or "unknown")
            {
                stage = "reconcile";
                if (!Reconcile()) return Fail("Merge outcome remains unknown; no creation or merge was replayed. Reconcile the original operation.");
                writeState = result["writeState"]!.ToString();
            }
            if (writeState == "not-applied")
                return result["merge"]?["rolledBack"]?.GetValue<bool>() == true ? RolledBack()
                    : Fail("Original merge was not applied; inspect the conflict/cancellation before preparing another revision");
            // Integration imports (SOAP, O11 OpenAPI): the Studio's own importer runs in the bridge on a copy of the snapshot.
            // A bridge without the verb is refused here, before the snapshot: nothing was captured, imported or merged.
            var imports = writeState == "not-sent" && request.Specification == null && MessageExpectations.Lane == "o11"
                ? IntegrationImport.Requests(JobRunner.CollectOps(JsonNode.Parse(File.ReadAllText(request.JobPath))!, Path.GetDirectoryName(Path.GetFullPath(request.JobPath))!))
                : new List<IntegrationImport.Request>();
            if (imports.Count > 0)
            {
                stage = "integration-import";
                var missing = imports.Select(i => IntegrationImport.CapabilityOf(i.Kind)).Distinct().Where(c => !Offers(bridge, c)).ToList();
                if (missing.Count > 0)
                {
                    result["code"] = IntegrationImport.NeedsBridge;
                    return Fail($"The Service Studio runs a bridge without the integration import ({string.Join(", ", missing)}): the {string.Join(" and ", imports.Select(i => i.Kind.ToUpperInvariant()).Distinct())} import of this job "
                        + "runs the Studio's own importer through it. Nothing was captured, imported or merged. The current bridge loads with the next Service Studio opened "
                        + "(\"Service Studio (SSAM)\" shortcut); then resume this task." + (imports.Any(i => i.Kind == "openapi") ? " For REST, explicit methods (op rest without openapi) need no import." : ""));
                }
            }
            // C26: a consumer whose job captured producer signatures first takes the Studio's own Refresh References for those
            // producers (a no-op when its references are already the server's), so the candidate and the live module agree on
            // the producer before the merge. Only with a bridge that has refresh_references; an older bridge merges as before.
            if (writeState == "not-sent" && result["capturedProducers"] is JsonObject { Count: > 0 } capturedNow && Offers(bridge, RefreshReferencesCapability))
            {
                stage = "refresh-references";
                var names = new JsonArray(); var keys = new JsonArray();
                foreach (var entry in capturedNow.Select(p => p.Value).OfType<JsonObject>())
                {
                    if (entry["producer"]?.ToString() is { Length: > 0 } producerName) names.Add(producerName);
                    if (entry["key"]?.ToString() is { Length: > 0 } producerKey) keys.Add(producerKey);
                }
                var refreshed = bridge.Call("refresh_references", Target(new() { ["producers"] = names, ["producer_keys"] = keys, ["timeout"] = 600 }));
                result["refreshReferences"] = refreshed;
                task.Save(stage);
                log?.Invoke($"deliver: refresh_references before the merge changed={refreshed["changed"]}");
            }
            if (writeState == "not-sent")
            {
                stage = "snapshot";
                var snapshot = bridge.Call("snapshot_module", Target(new() { ["path"] = basePath }));
                result["snapshot"] = snapshot;
                if (snapshot["key"]?.ToString() != key) return Fail("active module changed during snapshot; nothing was applied");
                if (string.IsNullOrEmpty(snapshot["snapshot_id"]?.ToString())) return Fail("bridge does not register snapshots; update the bridge before delivery");
                task.Save(stage);
                // The imports run on a detached copy of the snapshot, one after the other; the job is applied to the last
                // candidate and the merge still takes the registered snapshot as its base (one native merge).
                var applyBase = basePath;
                var importReceipts = new JsonArray();
                foreach (var import in imports)
                {
                    stage = "integration-import";
                    var importParameters = Target(import.Parameters.DeepClone().AsObject());
                    importParameters["operation_id"] = Guid.NewGuid().ToString("N");
                    importParameters["base_path"] = applyBase; importParameters["base_sha256"] = DeliveryReceipt.Hash(applyBase);
                    importParameters["out_path"] = Path.Combine(attemptDirectory, $"import-{importReceipts.Count}-{Guid.NewGuid():N}.oml");
                    log?.Invoke($"deliver: integration_import {import.Kind} op #{import.Op} client={importParameters["client"]}");
                    var receipt = bridge.Call(IntegrationImport.Verb, importParameters);
                    receipt["op"] = import.Op; receipt["kind"] = import.Kind;
                    importReceipts.Add(receipt);
                    result["integrationImport"] = importReceipts.DeepClone();
                    task.Save(stage);
                    if (receipt["errors"] is JsonArray { Count: > 0 } importErrors)
                    {
                        result["code"] = receipt["code"]?.ToString() is { Length: > 0 } importCode ? importCode : IntegrationImport.ImportFailed;
                        return Fail($"The Studio's {import.Kind.ToUpperInvariant()} importer refused op #{import.Op} on the copy of the module: "
                            + string.Join("; ", importErrors.Select(e => e?.ToString())) + ". Nothing was merged.");
                    }
                    if (receipt["candidate_path"]?.ToString() is { Length: > 0 } candidate)
                    {
                        if (receipt["candidate_sha256"]?.ToString() is { } candidateSha && candidateSha != DeliveryReceipt.Hash(candidate))
                            return Fail("The import candidate changed after the bridge wrote it; nothing was merged.");
                        applyBase = candidate;
                    }
                }
                stage = "apply";
                if (request.CaptureProducers is { Count: > 0 } && (applyWithProducers == null || dependencies != null || frozenCompilation != null))
                    return Fail("Captured producer signatures require the producer-aware job apply; nothing was applied");
                JsonObject applied;
                // K1: every producer signature of the task (bound, captured, owners) is linked to the apply, so a frozen import
                // refreshes the owners of its foreign types in the same native refresh.
                using (LinkSignatures(producers))
                    applied = frozenCompilation != null && dependencyRuntime is IDeliveryCompilationRuntime compiledRuntime
                    ? compiledRuntime.ApplyCompilation(applyBase, request.JobPath, foreignPath, frozenCompilation, dependencies)
                    : dependencies == null ? applyWithProducers != null ? applyWithProducers(applyBase, request.JobPath, foreignPath, producers)
                        : apply(applyBase, request.JobPath, foreignPath)
                    : dependencyRuntime!.Apply(applyBase, request.JobPath, foreignPath, dependencies);
                result["apply"] = applied;
                if (IntegrationReports(applied, importReceipts) is { } integration) result["integration"] = integration;
                // A03: only errors and security warnings make the apply's policy refuse (MessageExpectations); a refusal
                // still carries the warnings that block nothing, so the correction sees them in the same answer.
                if (applied["isValid"]?.GetValue<bool>() != true || applied["accepted"]?.GetValue<bool>() != true)
                {
                    RecordWarnings(null);
                    return Fail("job rejected by validation contract; merge was not attempted");
                }
                if (DeliveryReceipt.Changed(sources).Count > 0) return Fail("Job or dependency changed during apply; nothing was merged. Deliver the current source.");
                // C15: a candidate that changes a producer signature is merged first in a disposable preview; a postcondition
                // that fails there would roll the live merge back after it started (an uncertain delivery), so it refuses here.
                if (dependencies == null && frozenCompilation == null && BindsProducerSignatures(request)
                    && (previewSignatures ?? DefaultSignaturePreview) is { } previewer)
                {
                    var preview = previewer(basePath, foreignPath, attemptDirectory);
                    result["signaturePreview"] = preview;
                    if (preview["ran"]?.GetValue<bool>() == true && preview["accepted"]?.GetValue<bool>() == false)
                    {
                        result["code"] = SignaturePreviewRefused;
                        return Fail("The producer signature this candidate selects does not survive a native merge in the disposable preview, so the live merge "
                            + "would roll back after it started: " + preview["error"] + ". Nothing was merged.");
                    }
                }
                var localAssertions = applied["dataContract"]?["assertions"]?.AsArray() ?? new JsonArray();
                if (request.Specification != null)
                {
                    if (inspectSpecification == null && dependencies == null && !(frozenCompilation != null && dependencyRuntime is IDeliveryCompilationRuntime)) return Fail("Independent specification inspection is unavailable");
                    var requirementProof = InspectSpecification(foreignPath, request.Specification, result["expectedTypes"]?.AsObject());
                    result["requirementsBeforeMerge"] = requirementProof;
                    if (requirementProof["accepted"]?.GetValue<bool>() != true) return Fail("Generated model does not fulfill the original data requirements; merge was not attempted");
                    result["expectedTypes"] = requirementProof["expectedTypes"]!.DeepClone();
                    localAssertions = requirementProof["assertions"]!.AsArray();
                }
                if (localAssertions.Count > 0 && inspectData == null && inspectSpecification == null && dependencies == null && !(frozenCompilation != null && dependencyRuntime is IDeliveryCompilationRuntime)) return Fail("Data inspection is unavailable; update the delivery client before merging");
                if (DeliveryReceipt.Changed(sources).Count > 0) return Fail("Source or frozen runtime dependency changed during inspection; nothing was merged");
                // Merge order: defaults the native merge would drop go in a second native merge of the same call, over the
                // first-pass copy (MergeOrder). Silent when there are none: one merge, as before.
                stage = "merge-order";
                string? firstPassPath = null;
                // A plan belongs to its attempt: a repair or a resumed not-sent task plans again on its own capture.
                result.Remove("mergePlan");
                if (mergePlanner != null)
                {
                    var plan = mergePlanner.Plan(basePath, foreignPath, Path.Combine(attemptDirectory, "first-pass.oml"));
                    if (plan["deferred"] is JsonArray { Count: > 0 } planned)
                    {
                        // Two native merges need a bridge that runs them: one that ignores first_pass_path merges once and the
                        // Studio drops these defaults. Refused before any write, never found lost after the merge.
                        if (!HasCapability(bridge, MergeOrderCapability))
                        {
                            result["code"] = "BRIDGE_OUTDATED";
                            return Fail($"The Service Studio runs a bridge without the merge order (capability {MergeOrderCapability}): one native merge would drop "
                                + $"{planned.Count} default value(s) of this job ({MergeOrder.Describe(MergeOrder.FromJson(planned))}). Nothing was merged. "
                                + "The current bridge loads with the next Service Studio opened; then resume this task.");
                        }
                        firstPassPath = plan["firstPass"]?.ToString() ?? throw new InvalidOperationException("Merge order deferred defaults without a first-pass copy; nothing was merged");
                        result["mergePlan"] = plan;
                        log?.Invoke($"deliver: merge order defers {plan["deferred"]!.AsArray().Count} default value(s) to the second merge");
                    }
                }
                // The producer may have been republished while the job was applied: observe it again right before the write.
                stage = "producer-attestation";
                AttestProducers("producerAttestationBeforeMerge");
                result["assertions"] = localAssertions.DeepClone();
                result["artifacts"] = new JsonArray(Artifact(basePath), Artifact(foreignPath));
                if (firstPassPath != null) result["artifacts"]!.AsArray().Add(Artifact(firstPassPath));
                result["operationId"] = Guid.NewGuid().ToString("N");
                result["writeState"] = "intent";
                stage = "merge"; task.Save(stage);
                log?.Invoke($"deliver: merge_from_oml {request.Module} task={task.Id}");
                var parameters = Target(new() { ["base_path"] = basePath, ["foreign_path"] = foreignPath, ["mode"] = "auto",
                    ["operation_id"] = result["operationId"]!.DeepClone(), ["base_sha256"] = DeliveryReceipt.Hash(basePath),
                    ["foreign_sha256"] = DeliveryReceipt.Hash(foreignPath) });
                if (firstPassPath != null) { parameters["first_pass_path"] = firstPassPath; parameters["first_pass_sha256"] = DeliveryReceipt.Hash(firstPassPath); }
                try { RecordMerge(bridge.Call("merge_from_oml", parameters)); }
                catch (BridgeCallException ex) when (ex.Executed == null)
                {
                    // The bridge itself answered that the merge failed after it started (its journal recorded the failure, so
                    // the operation is over): unknown, reconciled at once below, never repeated. A lost reply (transport) is
                    // left to the outer handler and to resume: the merge may still be running in the Studio.
                    result["writeState"] = "unknown"; result["mergeError"] = Errors.Text(ex); task.Save("merge-unknown");
                }
                // A native merge that failed after it started (verificationError) is unknown, never repeated: it is reconciled
                // in this same call (merge_status, then the rollback proofs); what stays unknown is resumed later.
                if (result["writeState"]!.ToString() == "unknown")
                {
                    stage = "reconcile";
                    var failed = result["merge"]?["verificationError"]?.ToString() ?? result["mergeError"]?.ToString();
                    if (!Reconcile())
                        return Fail("Merge outcome is unknown" + (failed != null ? ": " + failed : "")
                            + "; nothing was repeated. Resume reconciles it through merge_status.");
                    stage = "merge";
                }
                if (result["writeState"]!.ToString() == "not-applied" && result["merge"]?["rolledBack"]?.GetValue<bool>() == true) return RolledBack();
                if (result["writeState"]!.ToString() is not ("applied" or "unchanged"))
                    return Fail("merge not applied: " + (result["merge"]?["reason"]?.ToString() ?? result["merge"]?["result"]?.ToString()));
            }
            // Every independent checker runs, even if a nominal check or another checker fails.
            stage = "verify";
            try
            {
                // A08: the TrueChange read is of this task's module; another session may have selected its own tab meanwhile.
                SelectOwnTab();
                var snapshot = result["snapshot"]!.AsObject();
                // settle: a bridge with get_errors:generation reads the TrueChange only once the Studio is idle after the merge
                // (bounded, inside the bridge) and answers the validation generation; an older bridge ignores it (C28).
                var verifyParameters = snapshot["baseline"] == null
                    ? Target(new() { ["since"] = snapshot["snapshot_id"]!.DeepClone() }) : Target(new());
                verifyParameters["settle"] = true;
                var validation = bridge.Call("get_errors", verifyParameters);
                if (snapshot["baseline"] is JsonArray baseline && validation["rawMessages"] is JsonArray current)
                {
                    var delta = MessageDelta.Compute(baseline.Deserialize<List<MessageInfo>>()!, current.Deserialize<List<MessageInfo>>()!);
                    validation["new"] = JsonSerializer.SerializeToNode(delta.New);
                    validation["fixed"] = JsonSerializer.SerializeToNode(delta.Fixed);
                    validation["preexisting"] = JsonSerializer.SerializeToNode(delta.Preexisting);
                    validation["newErrors"] = delta.New.Count(m => m.IsError);
                }
                result["validation"] = validation;
                if (validation["newErrors"] == null || validation["new"] is not JsonArray fresh)
                    throw new InvalidOperationException("bridge returned no snapshot delta");
                result["newErrors"] = validation["newErrors"]!.DeepClone();
                // An empty list after a base that had messages is a TrueChange that did not run, never "0 errors" (C28).
                if (LiveContract.VerifyUnavailable(snapshot["baseline"] as JsonArray, validation) is { } unavailable)
                {
                    result["code"] = VerifyUnavailableCode;
                    RecordWarnings(null);
                    failures.Add((stage, "merge kept for review: " + unavailable + " "
                        + (result["merge"]?["undoSteps"]?.ToString() == "2" ? "Ctrl+Z twice in Studio undoes it (two native merges)" : "Ctrl+Z in Studio undoes it") + "; nothing was published"));
                }
                else
                {
                    // The live contract: with the apply's verdicts (contract I3) each new live message must have a verdict with the
                    // same (id, path) other than unexpected; without them, the job's expectedMessages as before. A03: a warning
                    // outside SecurityWarnings blocks nothing in either and comes back in result.warnings (I9).
                    var freshMessages = fresh.Deserialize<List<MessageInfo>>()!;
                    bool accepted;
                    if (result["apply"]?["validation"]?["verdicts"] is JsonArray verdicts)
                    {
                        var live = LiveContract.Evaluate(freshMessages, verdicts);
                        result["contract"] = live; accepted = live["accepted"]!.GetValue<bool>();
                        RecordWarnings(live["matched"] as JsonArray);
                    }
                    else
                    {
                        var contract = MessageExpectations.Evaluate(freshMessages, expectations);
                        var serialized = JsonSerializer.SerializeToNode(contract)!.AsObject();
                        result["contract"] = serialized; accepted = contract.Accepted;
                        RecordWarnings(serialized["verdicts"] as JsonArray);
                    }
                    if (validation["newErrors"]!.GetValue<int>() > 0 || !accepted)
                        failures.Add((stage, "merge kept for review: new TrueChange errors or unexpected messages; inspect validation and contract. "
                            + (result["merge"]?["undoSteps"]?.ToString() == "2" ? "Ctrl+Z twice in Studio undoes it (two native merges)" : "Ctrl+Z in Studio undoes it") + "; nothing was published"));
                }
            }
            catch (Exception ex) { failures.Add((stage, Errors.Text(ex))); }
            task.Save(stage);
            stage = "checks";
            var checks = new JsonArray(); result["checks"] = checks;
            foreach (var name in request.Checks)
            {
                try
                {
                    var found = bridge.Call("find_element", Target(new() { ["name"] = name }));
                    checks.Add(found);
                    if (found["count"]?.GetValue<int>() is not > 0) failures.Add((stage, $"merge kept for review: requested element '{name}' was not found"));
                }
                catch (Exception ex) { checks.Add(new JsonObject { ["query"] = name, ["error"] = Errors.Text(ex) }); failures.Add((stage, Errors.Text(ex))); }
            }
            stage = "data-proof";
            // The known losses are this attempt's own proof: recomputed below on its delivered snapshot.
            result.Remove("mergeOrder");
            var assertions = result["assertions"]!.AsArray();
            var deferred = result["mergePlan"]?["deferred"] as JsonArray;
            if (assertions.Count > 0 || dependencies != null || frozenCompilation != null || deferred is { Count: > 0 })
            {
                try
                {
                    var deliveredPath = Path.Combine(work, "delivered-" + Guid.NewGuid().ToString("N") + ".oml");
                    var deliveredSnapshot = bridge.Call("snapshot_module", Target(new() { ["path"] = deliveredPath }));
                    if (deliveredSnapshot["key"]?.ToString() != key) throw new InvalidOperationException("Active module changed before content proof; merge kept for review");
                    result["deliveredSnapshot"] = deliveredSnapshot;
                    result["artifacts"]!.AsArray().Add(Artifact(deliveredPath));
                    // Deferred defaults are checked on the delivered module itself: logic parameters have no data assertion.
                    var lost = deferred is { Count: > 0 } && mergePlanner != null ? mergePlanner.Missing(deliveredPath, deferred) : new JsonArray();
                    var forced = new JsonArray();
                    var others = false;
                    if (assertions.Count > 0 || dependencies != null || frozenCompilation != null)
                    {
                        var proof = request.Specification != null
                            ? InspectSpecification(deliveredPath, request.Specification, result["expectedTypes"]?.AsObject())
                            : inspectData!(deliveredPath, assertions);
                        // Old receipts addressed static record values by transient wrapper keys. For flat declarative
                        // jobs, recover by checking the unchanged source specification independently, never by
                        // dropping failed assertions or repeating the already-applied merge.
                        if (dependencies == null && proof["accepted"]?.GetValue<bool>() == false && inspectSpecification != null &&
                            proof["differences"] is JsonArray failuresByValue && failuresByValue.Count > 0 &&
                            failuresByValue.All(d => d?["property"]?.ToString() == "Value" &&
                                d?["element"]?.ToString().EndsWith(" / RecordAttributeValue", StringComparison.Ordinal) == true &&
                                d?["actual"]?.ToString().StartsWith("unavailable: KeyNotFoundException:", StringComparison.Ordinal) == true) &&
                            FlatDataSpecification(JsonNode.Parse(File.ReadAllText(request.JobPath))!) is { } declared)
                        {
                            result["legacyDataProof"] = proof.DeepClone();
                            proof = inspectSpecification(deliveredPath, new JsonObject { ["data"] = declared }, null);
                            result["dataProofRecovery"] = "Independent verification of the unchanged flat data specification; legacy record-value wrapper keys were transient.";
                        }
                        result["dataProof"] = proof;
                        if (proof["accepted"]?.GetValue<bool>() != true)
                        {
                            var differences = proof["differences"] as JsonArray ?? new JsonArray();
                            var named = differences.Select(d => LostDefault(d, assertions)).ToList();
                            foreach (var entry in named.OfType<JsonObject>())
                                if (!lost.OfType<JsonObject>().Any(l => l["objectKey"]?.ToString() == entry["objectKey"]?.ToString())) lost.Add(entry);
                            var forcedRules = differences.Select(d => ForcedDeleteRule(d, assertions)).ToList();
                            foreach (var entry in forcedRules.OfType<JsonObject>()) forced.Add(entry);
                            others = named.Zip(forcedRules).Any(n => n.First == null && n.Second == null) || differences.Count == 0;
                            if (others)
                            {
                                dataProofDiffers = true;
                                failures.Add((stage, "Merge kept for review: delivered data differs from the task (" + differences.Count
                                    + " difference(s)); inspect dataProof.differences"));
                            }
                        }
                    }
                    if (lost.Count > 0 || forced.Count > 0)
                    {
                        result["mergeOrder"] = new JsonObject { ["missing"] = lost.DeepClone(), ["rule"] = MergeOrderRule,
                            ["repair"] = RepairJob(lost), ["forcedDeleteRules"] = forced.DeepClone(), ["declare"] = DeclareJob(forced) };
                        failures.Add((stage, KnownLossesText(lost, forced, others) + (deferred is { Count: > 0 } ? SecondMergeText(result["merge"]) : "")));
                    }
                }
                catch (Exception ex) { failures.Add((stage, Errors.Text(ex))); }
            }
            if (DeliveryReceipt.Changed(sources).Count > 0) failures.Add((stage, "Source changed after merge; this task does not cover the edited job"));
            result["failures"] = new JsonArray(failures.Select(f => (JsonNode)new JsonObject { ["stage"] = f.Stage, ["error"] = f.Error }).ToArray());
            if (failures.Count > 0)
            {
                // A12: only the data proof failed, with differences no known class explains: its own code, so the answer
                // carries dataProof.differences and the evidence continuation instead of a generic failure.
                if (result["code"] == null && dataProofDiffers && result["mergeOrder"] == null && failures.All(f => f.Stage == "data-proof"))
                    result["code"] = DataProofDiffersCode;
                stage = failures[0].Stage; return Fail(string.Join("; ", failures.Select(f => f.Error)));
            }
            if (frozenCompilation != null)
            {
                frozenCompilation.ValidateReuse(request.Specification!["csharpSource"]!, result["environment"]!.ToString(), key, dependencies);
                result["csharpExports"] = new JsonObject { ["sourceHash"] = frozenCompilation.SourceHash,
                    ["compilation"] = result["csharpCompilation"]!.DeepClone(), ["snapshot"] = result["deliveredSnapshot"]!.DeepClone(),
                    ["sourceAbis"] = frozenCompilation.Compilation.SourceAbis!.DeepClone() };
            }
            result["delivered"] = true; result["everDelivered"] = true; stage = "complete";
            return result;

            JsonObject InspectSpecification(string snapshot, JsonObject specification, JsonObject? expectedTypes)
            {
                if (frozenCompilation != null && dependencyRuntime is IDeliveryCompilationRuntime compiledRuntime)
                    return compiledRuntime.InspectCompilation(snapshot, specification, expectedTypes, frozenCompilation, dependencies);
                if (dependencies == null) return inspectSpecification!(snapshot, specification, expectedTypes);
                dependencies.ValidateArtifacts();
                return dependencyRuntime!.Inspect(snapshot, specification, expectedTypes, dependencies);
            }
            JsonObject Target(JsonObject parameters)
            {
                parameters["module_key"] = key;
                if (result["environment"] != null) parameters["environment"] = result["environment"]!.DeepClone();
                return parameters;
            }
            // A08: before the verification, the tab of this task's module is the selected one: when another session selected
            // its own tab of the same Studio, open_module by the task's key selects it again (a bridge with module_key reads
            // already target any tab; an older one reads the selected tab). Throws when the module cannot be selected.
            void SelectOwnTab()
            {
                var now = bridge.Call("get_active_module");
                if (now["key"]?.ToString() == key) return;
                var again = bridge.Call("open_module", AnsweringDependencies(Target(new() { ["name"] = request.Module, ["timeout"] = 20 })));
                // MB2: a dependencies dialog the bridge answered here is followed by the refresh of every producer.
                if (AnsweredDependencies(again) is { } answered
                    && RefreshAfterDependencies(bridge, result, "verify", answered, request.Module, key, result["environment"]?.ToString(), log) is { } refreshFailed)
                    throw new InvalidOperationException(refreshFailed);
                if (again["opened"]?.GetValue<bool>() != true && again["alreadyOpen"]?.GetValue<bool>() != true)
                    throw new InvalidOperationException("The module of this task could not be selected again before the verification: open_module is blocked: "
                        + (again["hint"]?.ToString() ?? again["blockedBy"]?.ToJsonString()));
                var selected = bridge.Call("get_active_module");
                // A tab in another window stays unselected for the first window; a bridge with module_key reads it by key.
                var byKey = selected["key"]?.ToString() != key && OpenTabOf(bridge, request.Module, result["environment"]?.ToString(), key) != null;
                if (selected["key"]?.ToString() != key && !byKey)
                    throw new InvalidOperationException("Another module stays selected in the Studio (" + (selected["name"]?.ToString() ?? "none")
                        + ") after selecting " + request.Module + " again; the verification reads its own module");
                var entry = new JsonObject { ["stage"] = "verify", ["from"] = now["name"]?.ToString() };
                if (byKey) entry["byKey"] = true;
                if (result["reselected"] is JsonArray reselected) reselected.Add(entry);
                else result["reselected"] = new JsonArray(entry);
            }
            // Attested envelopes (captured by `anvil signature` or --capture-producer) are re-observed on the server:
            // an offline fixture, another environment or a republished producer stops the delivery before any write.
            void AttestProducers(string field)
            {
                var attested = new JsonArray();
                // Only .avsig sources reach RequiresAttestation: invoking it JIT-compiles the envelope reader, which loads the
                // Studio model assemblies, and a delivery without producer signatures must not need them here.
                foreach (var path in sources.OfType<JsonObject>().Select(s => s["path"]!.ToString())
                             .Where(p => Path.GetExtension(p).Equals(".avsig", StringComparison.OrdinalIgnoreCase)).Where(ProducerSignatures.RequiresAttestation))
                {
                    if (producerAuthority == null)
                        throw new InvalidOperationException("Attested producer signature requires server re-attestation before merge; no read-only producer authority: " + path);
                    var observed = producerAuthority.Attest(path, active["environment"]?.ToString() ?? throw new InvalidOperationException("Unknown target environment"));
                    observed["path"] = path; observed["sha256"] = DeliveryReceipt.Hash(path);
                    attested.Add(observed);
                    log?.Invoke($"deliver: producer {observed["producer"]} re-attested ({observed["guard"]} {observed["versionId"] ?? observed["advertisedSignatureHash"]})");
                }
                if (attested.Count > 0) { result[field] = attested; task.Save(stage); }
            }
            // C15: an unknown merge is reconciled, never repeated. First the bridge's own journal (a bridge with
            // merge_from_oml:rollback_proof records there the rollback it proved itself); then, for an older bridge whose
            // journal recorded the failure of a merge that had started, the kernel hash proof: the live module captured now
            // has exactly the bytes of this attempt's base. Anything else stays unknown (false).
            bool Reconcile()
            {
                JsonObject status;
                try { status = bridge.Call("merge_status", new() { ["operation_id"] = result["operationId"]!.DeepClone(), ["module_key"] = key }); }
                catch (Exception ex) { result["reconcileError"] = Errors.Text(ex); return false; }
                result["operationStatus"] = status.DeepClone();
                if (status["state"]?.ToString() is "applied" or "unchanged" or "not-applied" && status["receipt"] is JsonObject receipt)
                {
                    RecordMerge(receipt.DeepClone().AsObject());
                    return true;
                }
                if (!RollbackProof.KernelProofApplies(status)) return false;
                var baseSha = RollbackProof.BaseSha256(result);
                var livePath = Path.Combine(attemptDirectory, "reconcile-" + Guid.NewGuid().ToString("N") + ".oml");
                JsonObject live;
                try { live = bridge.Call("snapshot_module", Target(new() { ["path"] = livePath })); }
                catch (Exception ex) { result["reconcileError"] = Errors.Text(ex); return false; }
                if (live["key"]?.ToString() != key) return false;
                var liveSha = live["sha256"]?.ToString() ?? (File.Exists(livePath) ? DeliveryReceipt.Hash(livePath) : null);
                var proof = RollbackProof.KernelReceipt(result["operationId"]?.ToString(), liveSha, baseSha, status["error"]?.ToString());
                result["reconcileProof"] = new JsonObject { ["liveSha256"] = liveSha, ["baseSha256"] = baseSha, ["live"] = livePath, ["equal"] = proof != null };
                task.Save("reconcile-proof");
                if (proof == null) return false;
                RecordMerge(proof);
                return true;
            }
            // A merge proven rolled back (by the bridge or by the kernel hash proof) left nothing applied: the task ends
            // closed and the reservation is released in finally (writeState not-applied).
            JsonObject RolledBack()
            {
                var merge = result["merge"]!;
                result["code"] = MergeRolledBackCode; result["closed"] = true;
                result["closedReason"] = merge["reason"]?.ToString() ?? RollbackProof.BridgeReason;
                return Fail("The Studio rolled the merge back (" + result["closedReason"] + "): the live module equals this task's base, sha256 "
                    + merge["liveSha256"] + ". Nothing was applied, the task is closed and the module is free; deliver the corrected job as a new delivery."
                    + (merge["error"] is { } cause ? " Cause reported by the Studio: " + cause : ""));
            }
        }
        catch (Exception ex)
        {
            if (result["writeState"]?.ToString() == "intent") result["writeState"] = ex is BridgeCallException { Executed: false } ? "not-sent" : "unknown";
            // A coded kernel refusal raised inside the apply (the base check's PREFLIGHT_REFUSED with every problem, I2;
            // SIGNATURE_CHANGE_BREAKS_CONSUMERS, ...) keeps its code and problems in the task result, as the CLI envelope does.
            if (Errors.FindCoded(ex) is { } coded && result["code"] == null)
            {
                result["code"] = coded.Code;
                if (coded.Problems is { } problems) result["problems"] = problems.DeepClone();
            }
            return Fail(Errors.Text(ex));
        }
        finally
        {
            result["elapsedMs"] = clock.ElapsedMilliseconds;
            CloseOpenedTab();
            try
            {
                task.Save(stage);
                if (result["delivered"]?.GetValue<bool>() == true || result["writeState"]?.ToString() is "not-sent" or "not-applied") reservation?.Release();
            }
            finally { reservation?.Dispose(); }
        }
        // A03, I9: the warnings that block nothing, each {id, path, key?, detail, fix}: from the live verdicts when the live
        // contract ran (live), else from the apply's verdicts. The whole list stays in the task result (result.json); the
        // answers cap it.
        void RecordWarnings(JsonArray? live)
        {
            var source = live ?? result["apply"]?["validation"]?["verdicts"] as JsonArray ?? new JsonArray();
            hints ??= VerifyHints.TryRead();
            var warnings = VerifyHints.Warnings(source, hints);
            // The HIGH warnings of the data-access rules (QUERY_IN_LOOP legacy/allowed, AGGREGATES_MERGEABLE) come first, and
            // also on their own (highWarnings) so a compacted answer still shows them; they never block (A03).
            var high = QueryInLoopRule.HighWarnings(result["apply"]?["highWarnings"] as JsonArray);
            for (var n = high.Count - 1; n >= 0; n--) warnings.Insert(0, high[n]!.DeepClone());
            if (high.Count > 0) result["highWarnings"] = high; else result.Remove("highWarnings");
            if (warnings.Count > 0) result["warnings"] = warnings; else result.Remove("warnings");
        }
        // K1-g (C22): the tab this delivery opened (open_module answered alreadyOpen false) is closed when the delivery ends in a
        // saved state: nothing was sent or applied, or the merge is recorded. The bridge's own guard keeps a tab with unsaved
        // changes, opening or with a dialog (an applied merge stays unsaved until the publish), and the answer says why. An
        // unsettled merge (intent, unknown) keeps its tab for the reconciliation. Never throws: the delivery's answer stands.
        void CloseOpenedTab()
        {
            if (!request.CloseOpenedTab || result["open"] is not JsonObject open || open["alreadyOpen"]?.GetValue<bool>() != false) return;
            if (result["writeState"]?.ToString() is not ("not-sent" or "not-applied" or "applied" or "unchanged"))
            {
                result["closedTab"] = new JsonObject { ["closed"] = false, ["reason"] = "the merge outcome is not settled; the tab stays for the reconciliation" };
                return;
            }
            try
            {
                var closed = bridge.Call("close_module", new() { ["name"] = request.Module, ["module_key"] = result["moduleKey"]?.DeepClone(),
                    ["environment"] = result["environment"]?.DeepClone() });
                result["closedTab"] = closed["closed"]?.GetValue<bool>() == true ? JsonValue.Create(true)
                    : new JsonObject { ["closed"] = false, ["reason"] = closed["error"]?.ToString() ?? closed["hint"]?.ToString() ?? "the Studio kept the tab" };
            }
            catch (Exception ex) { result["closedTab"] = new JsonObject { ["closed"] = false, ["reason"] = Errors.Text(ex) }; }
        }
        void RecordMerge(JsonObject merge)
        {
            result["merge"] = merge;
            if (merge["merged"]?.GetValue<bool>() == true) result["hasAppliedWrites"] = true;
            var unchanged = merge["reason"]?.ToString() == "no differences";
            result["unchanged"] = unchanged;
            result["writeState"] = merge["merged"]?.GetValue<bool>() == true ? "applied" : unchanged ? "unchanged"
                : merge["merged"]?.GetValue<bool>() == false ? "not-applied" : "unknown";
            task.Save("merge-recorded");
        }
        JsonObject Fail(string message) { result["error"] = message; return result; }
    }
    /// <summary>Explicit bindings plus the producers this task captures. Each producer is captured (read-only) into the
    /// task folder and recorded, path + SHA-256, among the task sources and in capturedProducers, and the task is saved
    /// right after each capture. A resume reuses exactly the recorded files (whose hashes the source check has already
    /// confirmed) and captures only the producers still missing, e.g. after a later capture failed: a completed capture
    /// is never repeated for the same task, and every recorded one is re-attested before apply and before merge.</summary>
    private static IReadOnlyDictionary<string, string> CaptureProducers(DeliveryTask task, DeliveryRequest request, JsonArray sources,
        string? environment, IProducerSignatureAuthority? authority, Action<string>? log, string? moduleKey = null)
    {
        var producers = new Dictionary<string, string>(request.Producers ?? new Dictionary<string, string>(), StringComparer.OrdinalIgnoreCase);
        if (request.CaptureProducers is not { Count: > 0 } entries) return producers;
        // "Binding" captures the producer of the same name; "Binding=Producer" names it when it is not a binding name,
        // e.g. System=(System).
        var targets = entries.Select(ProducerSignatures.ParseCapture).ToArray();
        if (targets.Select(t => t.Binding).Distinct(StringComparer.OrdinalIgnoreCase).Count() != targets.Length)
            throw new ArgumentException("Each captured producer binding must be unique");
        foreach (var (binding, _) in targets)
            if (producers.ContainsKey(binding)) throw new ArgumentException("Producer " + binding + " is both bound (--producer) and captured (--capture-producer)");
        if (request.Specification != null) throw new InvalidOperationException("Producer capture applies to jobs, not to data specifications");
        if (string.IsNullOrWhiteSpace(environment)) throw new InvalidOperationException("Producer capture requires a known target environment");
        var state = task.State;
        if (state["capturedProducers"] is not JsonObject captured) state["capturedProducers"] = captured = new JsonObject();
        foreach (var (name, producerName) in targets)
        {
            if (captured[name] is JsonObject recorded)
            {
                if (!string.Equals(recorded["producer"]?.ToString(), producerName, StringComparison.Ordinal))
                    throw new InvalidOperationException("Task captured another producer for binding " + name + ": " + recorded["producer"]);
                continue;
            }
            if (authority == null) throw new InvalidOperationException("--capture-producer requires the read-only Studio producer authority");
            var destination = Path.Combine(task.DirectoryPath, "producers", name + ".avsig");
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            // Nothing consumed a file that is not recorded in capturedProducers (every capture precedes the apply): a
            // leftover of an interrupted attempt, or a source entry an earlier revision recorded before failing on a later
            // producer, is replaced instead of being checked as a frozen source forever.
            RemoveSource(destination);
            if (File.Exists(destination)) File.Delete(destination);
            var elements = ProducerSignatures.ReferencedElements(request.JobPath, name);
            // C27: the capture of the same producer is reused while the server still serves the version it was captured from
            // (re-attested here; a republished producer throws and is captured again).
            var cache = ProducerCache.ForWork(request.WorkDirectory);
            JsonObject? receipt = null; var reused = false;
            if (cache?.Find(environment, producerName, elements) is { } cached)
            {
                try
                {
                    var observed = authority.Attest(cached.Path, environment);
                    if (observed["attested"]?.GetValue<bool>() != false)
                    {
                        File.Copy(cached.Path, destination, overwrite: true);
                        receipt = cached.Receipt; reused = true;
                    }
                }
                catch (Exception ex) when (ex is not OutOfMemoryException)
                {
                    log?.Invoke($"deliver: cached capture of {producerName} no longer attests ({Errors.Text(ex)}); capturing it again");
                    cache.Remove(environment, producerName, elements);
                }
            }
            if (!reused)
            {
                receipt = authority.Capture(producerName, elements, destination, environment);
                try { cache?.Store(environment, producerName, elements, destination, receipt); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { log?.Invoke("deliver: producer cache not written: " + ex.Message); }
            }
            var sha = DeliveryReceipt.Hash(destination);
            sources.Add(new JsonObject { ["path"] = destination, ["sha256"] = sha });
            captured[name] = CapturedEntry(producerName, destination, sha, environment, receipt!);
            if (reused) captured[name]!["reusedFromCache"] = true;
            task.Save("capture-producer:" + name);
            log?.Invoke($"deliver: {(reused ? "reused the cached capture of" : "captured")} producer {name} sha256={sha} signatureHash={receipt!["signatureHash"]} version={receipt["versionIdBefore"]}");
        }
        var owners = CaptureOwners(task, request, sources, environment!, authority, moduleKey, log);
        foreach (var name in targets.Select(t => t.Binding).Concat(owners))
        {
            var entry = captured[name] as JsonObject ?? throw new InvalidOperationException("Task has no capture for producer " + name);
            if (!string.Equals(entry["environment"]?.ToString(), environment, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Captured producer signature belongs to another environment: " + name);
            var path = entry["path"]!.ToString();
            var recordedSources = sources.OfType<JsonObject>().Where(s => string.Equals(s["path"]?.ToString(), path, StringComparison.OrdinalIgnoreCase)).ToArray();
            if (recordedSources.Length != 1 || recordedSources[0]["sha256"]?.ToString() != entry["sha256"]?.ToString())
                throw new InvalidOperationException("Captured producer signature is not recorded once, with its captured hash, among the task sources: " + name);
            producers[name] = path;
        }
        return producers;

        void RemoveSource(string path) => RemoveRecordedSource(sources, path);
    }

    /// <summary>K1: links the .avsig among the producer bindings for the apply (NativeReferenceSnapshot.Link); null, and no
    /// envelope reader loaded, when there is none.</summary>
    public static IDisposable? LinkSignatures(IReadOnlyDictionary<string, string>? producers)
        => producers?.Values.Any(p => Path.GetExtension(p).Equals(".avsig", StringComparison.OrdinalIgnoreCase)) == true ? Link(producers.Values) : null;
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static IDisposable Link(IEnumerable<string> paths) => NativeReferenceSnapshot.Link(paths);

    private static void RemoveRecordedSource(JsonArray sources, string path)
    {
        foreach (var stale in sources.OfType<JsonObject>().Where(s => string.Equals(s["path"]?.ToString(), path, StringComparison.OrdinalIgnoreCase)).ToArray())
            sources.Remove(stale);
    }

    /// <summary>The capturedProducers entry of one capture receipt (its foreignDependencies included, for K1-b).</summary>
    private static JsonObject CapturedEntry(string producer, string path, string sha, string environment, JsonObject receipt) => new() {
        ["producer"] = producer, ["path"] = path, ["sha256"] = sha, ["environment"] = environment,
        ["key"] = receipt["key"]?.DeepClone(), ["kind"] = receipt["kind"]?.DeepClone(), ["guard"] = receipt["guard"]?.DeepClone(),
        ["versionId"] = receipt["versionIdBefore"]?.DeepClone(), ["signatureHash"] = receipt["signatureHash"]?.DeepClone(),
        ["advertisedSignatureHash"] = receipt["advertisedSignatureHash"]?.DeepClone(), ["xifSha256"] = receipt["xifSha256"]?.DeepClone(),
        ["foreignDependencies"] = receipt["foreignDependencies"]?.DeepClone(), ["capturedAtUtc"] = DateTime.UtcNow.ToString("O") };

    /// <summary>K1-b (atritos 3): the producers that own the foreign types of the captured signatures (an entity attribute of
    /// one producer typed with another producer's identifier) are captured too, by key, read-only, in the same
    /// producer-signatures stage and before any write. The import links their signatures into the same native refresh
    /// (ReferenceRefresher), so the job never binds them by hand. Each one is recorded under its own binding (the producer
    /// name as an identifier: (System) is System) with reason foreign-owner-of:&lt;producer&gt; and its owner key; an owner's own
    /// owners follow. A producer the task already captures or binds is never captured again; a resume reuses the recorded
    /// owners. An owner that cannot be captured refuses the delivery as PRODUCER_SIGNATURE_MISSING, cause foreign, naming it.
    /// Returns the bindings of the owners.</summary>
    private static IReadOnlyList<string> CaptureOwners(DeliveryTask task, DeliveryRequest request, JsonArray sources, string environment,
        IProducerSignatureAuthority? authority, string? moduleKey, Action<string>? log)
    {
        var captured = (JsonObject)task.State["capturedProducers"]!;
        var known = captured.Select(p => p.Value?["key"]?.ToString()).Concat(BoundSignatureKeys(request)).Append(moduleKey)
            .Where(k => !string.IsNullOrWhiteSpace(k)).Select(k => k!).ToList();
        bool Known(string key) => known.Any(k => SameKey(k, key));
        var problems = new List<JsonObject>(); string? refusedFor = null;
        var queue = new Queue<string>(captured.Select(p => p.Key)); var scanned = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var owners = captured.Where(p => p.Value?["ownerKey"] != null).Select(p => p.Key).ToList();
        var cache = ProducerCache.ForWork(request.WorkDirectory);
        while (queue.Count > 0)
        {
            var dependentBinding = queue.Dequeue();
            if (!scanned.Add(dependentBinding) || captured[dependentBinding] is not JsonObject dependent) continue;
            var dependentName = dependent["producer"]?.ToString() ?? dependentBinding;
            foreach (var (owner, objects) in OwnerGroups(dependent["foreignDependencies"] as JsonArray))
            {
                if (Known(owner)) continue;
                var elements = objects.Select(o => "@" + o).ToList();
                var destination = Path.Combine(task.DirectoryPath, "producers", "owner-" + SafeKeyName(owner) + ".avsig");
                JsonObject? receipt = null; var reused = false;
                try
                {
                    if (authority == null) throw new InvalidOperationException("no read-only producer authority captures it");
                    Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                    RemoveRecordedSource(sources, destination);
                    if (File.Exists(destination)) File.Delete(destination);
                    if (cache?.Find(environment, "@" + owner, elements) is { } cached)
                    {
                        try
                        {
                            if (authority.Attest(cached.Path, environment)["attested"]?.GetValue<bool>() != false)
                            { File.Copy(cached.Path, destination, overwrite: true); receipt = cached.Receipt; reused = true; }
                        }
                        catch (Exception ex) when (ex is not OutOfMemoryException) { cache.Remove(environment, "@" + owner, elements); }
                    }
                    if (!reused)
                    {
                        receipt = authority.CaptureByKey(owner, elements, destination, environment);
                        try { cache?.Store(environment, "@" + owner, elements, destination, receipt); }
                        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { log?.Invoke("deliver: producer cache not written: " + ex.Message); }
                    }
                }
                catch (Exception ex) when (ex is not OutOfMemoryException)
                {
                    refusedFor ??= dependentName;
                    var problem = Preflight.ProducerSignatureMissing.Problem(string.Join(", ", elements), dependentName, "foreign",
                        $"{dependentName} uses types of the producer with key {owner}, and the delivery could not capture that producer: {Errors.Text(ex)}",
                        $"the delivery captures it by itself once it is referenceable in {environment} (o11_environment referenceable lists them); nothing else is needed in the job");
                    problem["owner"] = owner;
                    problems.Add(problem);
                    known.Add(owner);
                    continue;
                }
                var name = receipt!["producer"]?.ToString() is { Length: > 0 } producerName ? producerName : owner;
                var binding = UniqueBinding(name, captured, request);
                var sha = DeliveryReceipt.Hash(destination);
                sources.Add(new JsonObject { ["path"] = destination, ["sha256"] = sha });
                var entry = CapturedEntry(name, destination, sha, environment, receipt);
                entry["reason"] = "foreign-owner-of:" + dependentName; entry["ownerKey"] = owner;
                if (reused) entry["reusedFromCache"] = true;
                captured[binding] = entry;
                known.Add(owner);
                if (receipt["key"]?.ToString() is { Length: > 0 } capturedKey) known.Add(capturedKey);
                owners.Add(binding); queue.Enqueue(binding);
                task.Save("capture-producer:" + binding);
                log?.Invoke($"deliver: {(reused ? "reused the cached capture of" : "captured")} {name}, owner of foreign types of {dependentName}, as {binding} sha256={sha}");
            }
        }
        if (problems.Count > 0) throw Preflight.ProducerSignatureMissing.Refusal(refusedFor!, problems);
        return owners;

        static bool SameKey(string left, string right)
        {
            if (string.Equals(left, right, StringComparison.Ordinal)) return true;
            try { return Keys.Parse(left).Equals(Keys.Parse(right)); } catch (Exception ex) when (ex is FormatException or ArgumentException) { return false; }
        }
    }

    /// <summary>The foreign keys of a capture ("&lt;owner key&gt;*&lt;object key&gt;"), grouped by owner, in order.</summary>
    internal static IReadOnlyList<(string Owner, IReadOnlyList<string> Objects)> OwnerGroups(JsonArray? foreign)
    {
        var groups = new List<(string Owner, List<string> Objects)>();
        foreach (var value in foreign ?? new JsonArray())
        {
            var text = value?.ToString() ?? ""; var star = text.IndexOf('*');
            if (star <= 0 || star == text.Length - 1) continue;
            var owner = text[..star]; var item = text[(star + 1)..];
            var group = groups.FirstOrDefault(g => g.Owner == owner);
            if (group.Objects == null) groups.Add(group = (owner, new List<string>()));
            if (!group.Objects.Contains(item)) group.Objects.Add(item);
        }
        return groups.Select(g => (g.Owner, (IReadOnlyList<string>)g.Objects)).ToArray();
    }

    // Keys of the producer signatures the request binds explicitly (.avsig), read only when there are any.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static IEnumerable<string> BoundSignatureKeys(DeliveryRequest request)
    {
        var keys = new List<string>();
        foreach (var file in (request.Producers ?? new Dictionary<string, string>()).Values.Where(f => Path.GetExtension(f).Equals(".avsig", StringComparison.OrdinalIgnoreCase)))
            try { keys.Add(NativeReferenceSnapshot.Read(file).ModuleKey); }
            catch (Exception ex) when (ex is IOException or ArgumentException or JsonException or FormatException or UnauthorizedAccessException) { }
        return keys;
    }

    private static string SafeKeyName(string key) => new(key.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_').ToArray());

    /// <summary>The producer name as a binding name ((System) is System), unique among the task's bindings.</summary>
    private static string UniqueBinding(string producer, JsonObject captured, DeliveryRequest request)
    {
        var core = new string(producer.Where(c => char.IsLetterOrDigit(c) || c == '_').ToArray());
        if (core.Length == 0 || char.IsDigit(core[0])) core = "Owner" + core;
        bool Taken(string name) => captured.Any(p => string.Equals(p.Key, name, StringComparison.OrdinalIgnoreCase))
            || (request.Producers?.Keys.Any(k => string.Equals(k, name, StringComparison.OrdinalIgnoreCase)) ?? false);
        var binding = core;
        for (var n = 2; Taken(binding); n++) binding = core + "_" + n;
        return binding;
    }

    private static FrozenFrameworkDependencies? PrepareDependencies(DeliveryTask task, DeliveryRequest request,
        string? environment, string moduleKey, IDeliveryDependencyRuntime? runtime, Anvil.CSharp.CompilationResult? compilation)
    {
        var state = task.State; var decision = state["runtimeDependencies"]?.AsObject();
        if (compilation == null)
        {
            if (decision != null) throw new InvalidOperationException("Frozen runtime dependencies require the original C# source");
            return null;
        }
        var requirements = compilation.RequiredIntrinsics ?? [];
        if (requirements.Count > 0 && string.IsNullOrWhiteSpace(environment))
            throw new InvalidOperationException("Runtime dependencies require a known target environment before acquisition");
        var lockPath = Path.Combine(task.DirectoryPath, "runtime-lock.json");
        var sources = state["sources"]!.AsArray();
        if (decision != null)
        {
            if (decision["sourceHash"]?.ToString() != compilation.SourceHash) throw new InvalidOperationException("Frozen dependency decision belongs to another source revision");
            if (decision["decision"]?.ToString() == "none")
            {
                if (requirements.Count != 0 || decision["requirementsHash"]?.ToString() != DurableJson.Hash("[]"))
                    throw new InvalidOperationException("The frozen source now declares different runtime requirements");
                return null;
            }
            if (decision["decision"]?.ToString() is not ("frozen" or "freezing") || decision["path"]?.ToString() != lockPath || decision["fingerprint"] == null)
                throw new InvalidOperationException("Invalid frozen runtime dependency decision");
            if (runtime == null) throw new InvalidOperationException("The frozen runtime dependency executor is unavailable; resume with the original runtime support");
            var freezing = decision["decision"]!.ToString() == "freezing";
            var frozen = freezing
                ? FrozenFrameworkDependencies.FromJson(decision["plan"]?.AsObject() ?? throw new InvalidOperationException("Interrupted dependency freeze has no recorded plan"), decision["fingerprint"]!.ToString())
                : FrozenFrameworkDependencies.Read(lockPath, decision["fingerprint"]!.ToString());
            frozen.ValidateReuse(compilation.SourceHash, requirements, environment ?? "", moduleKey, frozen.Package);
            if (frozen.RequirementsHash != decision["requirementsHash"]?.ToString()) throw new InvalidOperationException("Frozen runtime requirement hash changed");
            if (!freezing) Recorded(lockPath, DeliveryReceipt.Hash(lockPath));
            if (frozen.Package.ArtifactPath != null) Recorded(frozen.Package.ArtifactPath, frozen.Package.ArtifactSha256);
            foreach (var producer in frozen.Producers) Recorded(producer.Path, producer.Sha256);
            return freezing ? CompleteFreeze(frozen) : frozen;
        }
        // An applied or uncertain delivery cannot choose a runtime, even after repair.
        var canAcquire = state["writeState"]?.ToString() == "not-sent" && state["hasAppliedWrites"]?.GetValue<bool>() != true;
        if (!canAcquire)
        {
            if (requirements.Count > 0) throw new InvalidOperationException("Runtime dependency choices were not frozen before the original write; no acquisition or merge was replayed");
            return null;
        }
        if (runtime == null)
        {
            if (requirements.Count > 0) throw new InvalidOperationException("This C# source requires a configured runtime dependency provider");
            return null;
        }
        if (File.Exists(lockPath)) throw new InvalidOperationException("An unrecorded runtime lock already exists; reconcile the interrupted dependency freeze before continuing");
        var acquired = runtime.Acquire(new(request with { Specification = request.Specification!.DeepClone().AsObject() },
            environment ?? "", moduleKey, task.DirectoryPath, compilation));
        if (acquired == null)
        {
            if (requirements.Count > 0) throw new InvalidOperationException("The runtime provider did not resolve the declared C# intrinsic requirements");
        }
        else acquired.ValidateReuse(compilation.SourceHash, requirements, environment ?? "", moduleKey, acquired.Package);
        if (acquired == null || acquired.Bindings.Count == 0)
        {
            state["runtimeDependencies"] = new JsonObject { ["decision"] = "none", ["sourceHash"] = compilation.SourceHash,
                ["requirementsHash"] = DurableJson.Hash("[]") };
            task.Save("runtime-dependencies-resolved"); return null;
        }
        // Task-owned bytes survive updates of a shared provider catalog or cache.
        var frozenProducers = new List<FrameworkProducerSnapshot>();
        foreach (var producer in acquired.Producers)
        {
            var bytes = File.ReadAllBytes(producer.Path);
            if (Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant() != producer.Sha256)
                throw new InvalidOperationException("Producer snapshot changed while freezing runtime dependencies");
            var destination = Path.Combine(task.DirectoryPath, "runtime-producers", producer.Binding + ".avsig");
            if (File.Exists(destination))
            {
                if (DeliveryReceipt.Hash(destination) != producer.Sha256) throw new InvalidOperationException("Task-owned producer snapshot already contains different bytes");
            }
            else DurableJson.WriteBytes(destination, bytes);
            frozenProducers.Add(producer with { Path = destination });
        }
        var package = acquired.Package;
        if (package.ArtifactPath != null)
        {
            var bytes = File.ReadAllBytes(package.ArtifactPath);
            if (Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant() != package.ArtifactSha256)
                throw new InvalidOperationException("Runtime package artifact changed while freezing dependencies");
            var destination = Path.Combine(task.DirectoryPath, "runtime-package.xif");
            if (File.Exists(destination))
            {
                if (DeliveryReceipt.Hash(destination) != package.ArtifactSha256) throw new InvalidOperationException("Task-owned runtime package already contains different bytes");
            }
            else DurableJson.WriteBytes(destination, bytes);
            package = package with { ArtifactPath = destination };
        }
        var dependencies = FrozenFrameworkDependencies.Create(compilation.SourceHash, requirements, environment ?? "", moduleKey,
            package, frozenProducers, acquired.Bindings);
        if (package.ArtifactPath != null) Record(package.ArtifactPath, package.ArtifactSha256);
        foreach (var producer in dependencies.Producers) Record(producer.Path, producer.Sha256);
        // Persist the selected plan before creating its lock file. A stopped process resumes
        // these choices even if it never recorded the subsequently-created file.
        state["runtimeDependencies"] = Decision("freezing", dependencies);
        state["runtimeDependencies"]!["plan"] = dependencies.ToJson();
        task.Save("runtime-dependencies-freezing");
        return CompleteFreeze(dependencies);

        JsonObject Decision(string kind, FrozenFrameworkDependencies frozen) => new() {
            ["decision"] = kind, ["path"] = lockPath, ["fingerprint"] = frozen.Fingerprint,
            ["sourceHash"] = frozen.SourceHash, ["requirementsHash"] = frozen.RequirementsHash
        };
        FrozenFrameworkDependencies CompleteFreeze(FrozenFrameworkDependencies frozen)
        {
            frozen.Write(lockPath);
            Record(lockPath, DeliveryReceipt.Hash(lockPath));
            state["runtimeDependencies"] = Decision("frozen", frozen);
            task.Save("runtime-dependencies-frozen"); return frozen;
        }

        void Record(string path, string sha256)
        {
            var existing = sources.OfType<JsonObject>().Where(s => string.Equals(s["path"]?.ToString(), path, StringComparison.OrdinalIgnoreCase)).ToArray();
            if (existing.Length == 0) sources.Add(new JsonObject { ["path"] = path, ["sha256"] = sha256 });
            else Recorded(path, sha256);
        }
        void Recorded(string path, string sha256)
        {
            var recorded = sources.OfType<JsonObject>().Where(s => string.Equals(s["path"]?.ToString(), path, StringComparison.OrdinalIgnoreCase)).ToArray();
            if (recorded.Length != 1 || recorded[0]["sha256"]?.ToString() != sha256)
                throw new InvalidOperationException("Frozen dependency file is absent from the original receipt hashes: " + path);
        }
    }

    public static JsonObject? FlatDataSpecification(JsonNode job)
    {
        if (job["jobs"] != null || job["ops"] is not JsonArray ops) return null;
        var data = new JsonObject();
        foreach (var op in ops.OfType<JsonObject>())
        {
            var kind = op["op"]?.ToString();
            if (kind == "spec")
            {
                if (op["data"] is not JsonObject specification) return null;
                foreach (var group in specification)
                {
                    if (group.Key is not ("static" or "entities" or "clientEntities" or "structures") || group.Value is not JsonArray definitions) return null;
                    var target = data[group.Key] as JsonArray;
                    if (target == null) data[group.Key] = target = new JsonArray();
                    foreach (var definition in definitions) target.Add(definition?.DeepClone());
                }
            }
            else if (kind is "logic" or "html" or "screen" or "reference" or "get" or "find" or "dump" or "usages" or "layout") { }
            else if (kind == "create" && op["type"]?.ToString() == "IUserException") { }
            else if (kind == "link" && op["connector"]?.ToString() == "Roles" && op["from"]?.ToString().StartsWith("IMobileScreen:", StringComparison.Ordinal) == true) { }
            else return null; // A raw data mutation must retain its own explicit assertions.
        }
        return data.Count == 0 ? null : data;
    }
    private static JsonObject Artifact(string path) => new() { ["path"] = path, ["sha256"] = DeliveryReceipt.Hash(path) };

    /// <summary>The integration reports of the apply (contract I7) with what the bridge imports did: the methods the
    /// importer created (imported), the ones it found (skipped), whether it created the client and its key. Null when the
    /// job has no integration op.</summary>
    public static JsonArray? IntegrationReports(JsonObject applied, JsonArray importReceipts)
    {
        if (applied["integration"] is not JsonArray reports) return null;
        var copy = reports.DeepClone().AsArray();
        foreach (var receipt in importReceipts.OfType<JsonObject>())
        {
            var kind = receipt["kind"]?.ToString() == "openapi" ? "rest" : "soap";
            var client = receipt["client"]?["name"]?.ToString();
            var report = copy.OfType<JsonObject>().FirstOrDefault(r => r["op"]?.ToString() == kind && string.Equals(r["client"]?["name"]?.ToString(), client, StringComparison.OrdinalIgnoreCase));
            if (report == null) continue;
            report["imported"] = receipt["imported"]?.DeepClone() ?? new JsonArray();
            var imported = (receipt["imported"] as JsonArray ?? new JsonArray()).Select(i => i?.ToString()).ToHashSet(StringComparer.Ordinal);
            report["skipped"] = new JsonArray((report["skipped"] as JsonArray ?? new JsonArray()).Select(s => s?.ToString()).Where(s => s != null && !imported.Contains(s))
                .Concat((receipt["skipped"] as JsonArray ?? new JsonArray()).Select(s => s?.ToString())).Where(s => s != null).Distinct(StringComparer.Ordinal).Select(s => (JsonNode)s!).ToArray());
            if (report["client"] is JsonObject reported)
            {
                if (receipt["client"]?["created"] is JsonValue created) reported["created"] = created.DeepClone();
                if (receipt["client"]?["key"]?.ToString() is { Length: > 0 } key) reported["key"] = key;
            }
            foreach (var warning in receipt["warnings"] as JsonArray ?? new JsonArray()) (report["warnings"] as JsonArray)?.Add(warning?.DeepClone());
        }
        return copy;
    }

    /// <summary>The job a task checks, as its record names it ({path, sha256}): the full path and the SHA-256 of its bytes now.</summary>
    public static JsonObject JobIdentity(string jobPath)
        => new() { ["path"] = Path.GetFullPath(jobPath), ["sha256"] = DeliveryReceipt.Hash(jobPath) };

    /// <summary>The refusal codes this delivery writes in result.code (section 3.2 of the session package contract).</summary>
    public const string PreflightRefused = "PREFLIGHT_REFUSED";
    public const string VerifyUnavailableCode = "VERIFY_UNAVAILABLE";
    public const string MergeRolledBackCode = "MERGE_ROLLED_BACK";
    public const string SignaturePreviewRefused = "SIGNATURE_PREVIEW_REFUSED";
    /// <summary>A12: the merge is kept for review because only the data proof differs (section 5.3 of the atritos 2 package).</summary>
    public const string DataProofDiffersCode = "DATA_PROOF_DIFFERS";

    /// <summary>The O11 signature preview (Adapters.SS11/SignaturePreview.cs), found by name: the delivery sources also compile
    /// in Anvil.Core.Odc, which has no O11 merge types; there the preview is absent (null) and nothing runs.</summary>
    private static readonly Func<string, string, string, JsonObject>? DefaultSignaturePreview =
        typeof(Delivery).Assembly.GetType("Anvil.Core.Delivery.SignaturePreview")?.GetMethod("Check", [typeof(string), typeof(string), typeof(string)]) is { } check
            ? check.CreateDelegate<Func<string, string, string, JsonObject>>() : null;

    /// <summary>Whether the job binds producer signatures (captured, or an explicit .avsig binding): only then can the candidate
    /// change a reference signature the live merge selects.</summary>
    public static bool BindsProducerSignatures(DeliveryRequest request)
        => request.CaptureProducers is { Count: > 0 }
           || request.Producers?.Values.Any(p => Path.GetExtension(p).Equals(".avsig", StringComparison.OrdinalIgnoreCase)) == true;

    /// <summary>The structured problems of a refused preflight (contract I2): the preflight's own problems when it has them,
    /// else one problem per error line, so a refusal always carries every error at once.</summary>
    public static JsonArray PreflightProblems(JsonObject preflight)
    {
        if (preflight["problems"] is JsonArray { Count: > 0 } problems) return problems.DeepClone().AsArray();
        var derived = new JsonArray();
        foreach (var error in preflight["errors"] as JsonArray ?? new JsonArray())
        {
            var text = error?.ToString() ?? "";
            if (text.Length == 0) continue;
            var match = System.Text.RegularExpressions.Regex.Match(text, @"^op #(\d+)");
            // The op index is the CollectOps order; a JSON pointer is only known to the preflight itself (composite jobs).
            derived.Add(new JsonObject { ["op"] = match.Success ? int.Parse(match.Groups[1].Value) : null,
                ["pointer"] = null, ["code"] = "PREFLIGHT_ERROR", ["severity"] = "error",
                ["message"] = text.Split('\n')[0].Trim(), ["fix"] = null, ["patch"] = null });
        }
        return derived;
    }

    private static string MergeOrderRule => MergeOrder.Rule;
    /// <summary>The bridge capability of merge_from_oml with first_pass_path (Anvil.Bridge Dispatch.Capabilities).</summary>
    public const string MergeOrderCapability = "merge_from_oml:first_pass";
    /// <summary>The bridge verb refresh_references (RefreshReferencesHandler): the Studio's own Refresh References.</summary>
    public const string RefreshReferencesCapability = "refresh_references";
    /// <summary>C41: snapshot, merge, publish and the reads of the bridge target module_key in any tab, selected or not.</summary>
    public const string ModuleKeyCapability = "merge_from_oml:module_key";

    /// <summary>The open tab of a module in ANY window of the Studio (list_open_modules), when the selected tab is another
    /// one: with ten or more tabs the Studio moves some into a second window, and the bridge's "active module" is the selected
    /// tab of the first window, so open_module selecting the tab in its own window never made it "active" (2026-10-07, a client session:
    /// "active module changed before snapshot" on every module of the second window). Only a bridge whose calls target
    /// module_key (C41) may go on by key; the tab must be opened and the only one of that name (and key, and environment).</summary>
    internal static JsonObject? OpenTabOf(IBridgeClient bridge, string module, string? environment, string? key)
    {
        if (!Offers(bridge, ModuleKeyCapability)) return null;
        JsonObject listed;
        try { listed = bridge.Call("list_open_modules"); }
        catch (Exception ex) when (ex is not OutOfMemoryException) { return null; }
        var tabs = (listed["modules"] as JsonArray ?? []).OfType<JsonObject>()
            .Where(t => string.Equals(t["name"]?.ToString(), module, StringComparison.OrdinalIgnoreCase)
                && t["hasOpenedActiveESpace"]?.GetValue<bool>() == true
                && (key == null || t["key"]?.ToString() == key)
                && (environment == null || string.Equals(t["environment"]?.ToString(), environment, StringComparison.OrdinalIgnoreCase)))
            .ToList();
        return tabs.Count == 1 && tabs[0]["key"]?.ToString() is { Length: > 0 }
            ? new JsonObject { ["name"] = tabs[0]["name"]?.DeepClone(), ["key"] = tabs[0]["key"]?.DeepClone(), ["environment"] = tabs[0]["environment"]?.DeepClone(), ["byKey"] = true }
            : null;
    }
    /// <summary>bridge_manifest (exempt from authentication) lists what the loaded bridge adds over protocol 2; a bridge that
    /// refuses the verb predates every capability.</summary>
    private static bool HasCapability(IBridgeClient bridge, string capability)
    {
        JsonObject manifest;
        try { manifest = bridge.Call("bridge_manifest"); }
        catch (BridgeCallException) { return false; }
        return manifest["capabilities"] is JsonArray list && list.Any(c => c?.ToString() == capability);
    }
    /// <summary>An optional capability: a bridge that cannot answer bridge_manifest at all simply does not offer it.</summary>
    private static bool Offers(IBridgeClient bridge, string capability)
    {
        try { return HasCapability(bridge, capability); }
        catch (Exception ex) when (ex is not OutOfMemoryException) { return false; }
    }
    /// <summary>Why the deferred defaults were not delivered by the second merge, from the bridge's own receipt.</summary>
    private static string SecondMergeText(JsonNode? merge)
    {
        var text = merge?["mergeOrder"]?["passes"] == null
            ? " The bridge loaded in the Studio ran one merge (its receipt has no mergeOrder): it predates the merge order, and the integrator updates it."
            : merge?["secondPass"] is JsonObject second && second["merged"]?.GetValue<bool>() != true
                ? " The second native merge did not merge: " + (second["reason"] ?? second["result"] ?? second["state"])?.ToString() + "."
                : "";
        return text + (merge?["verificationError"] is { } failed ? " The bridge reported after the merge: " + failed.ToString() + "." : "");
    }
    /// <summary>A data-proof difference of the known class (a default value the module lost: expected text, empty actual),
    /// as a merge-order entry addressed by the asserted element's ObjectKey; null for any other difference.</summary>
    private static JsonObject? LostDefault(JsonNode? difference, JsonArray assertions)
    {
        if (difference is not JsonObject || difference["property"]?.ToString() != "DefaultValue") return null;
        var expected = difference["expected"]?.ToString();
        if (string.IsNullOrEmpty(expected) || !string.IsNullOrEmpty(difference["actual"]?.ToString())) return null;
        var element = difference["element"]?.ToString() ?? "";
        var objectKey = assertions.OfType<JsonObject>().FirstOrDefault(a => a["element"]?.ToString() == element && a["property"]?.ToString() == "DefaultValue")?["key"]?.ToString();
        if (objectKey == null) return null;
        // "Module (ESpace) / Pet (ServerEntity) / SpeciesId (EntityAttribute)" names the element as Pet.SpeciesId.
        var name = string.Join(".", element.Split(" / ").Skip(1).Select(s => s.LastIndexOf(" (", StringComparison.Ordinal) is var i and > 0 ? s[..i] : s));
        return new JsonObject { ["key"] = objectKey, ["objectKey"] = objectKey, ["element"] = name, ["property"] = "DefaultValue", ["value"] = expected, ["baseValue"] = null };
    }
    /// <summary>A data-proof difference of the second known class: a Delete Rule the Studio set to Ignore when the merge set
    /// the attribute's type (the environment allows only Ignore for that reference); null for any other difference.</summary>
    private static JsonObject? ForcedDeleteRule(JsonNode? difference, JsonArray assertions)
    {
        if (difference is not JsonObject || difference["property"]?.ToString() != "DeleteRule" || difference["actual"]?.ToString() != "Ignore") return null;
        var requested = difference["expected"]?.ToString();
        if (string.IsNullOrEmpty(requested) || requested == "Ignore") return null;
        var element = difference["element"]?.ToString() ?? "";
        var objectKey = assertions.OfType<JsonObject>().FirstOrDefault(a => a["element"]?.ToString() == element && a["property"]?.ToString() == "DeleteRule")?["key"]?.ToString();
        if (objectKey == null) return null;
        var name = string.Join(".", element.Split(" / ").Skip(1).Select(s => s.LastIndexOf(" (", StringComparison.Ordinal) is var i and > 0 ? s[..i] : s));
        return new JsonObject { ["objectKey"] = objectKey, ["element"] = name, ["requested"] = requested, ["kept"] = "Ignore" };
    }
    private static JsonObject RepairJob(JsonArray lost) => MergeOrder.RepairJob(MergeOrder.FromJson(lost));
    private static JsonObject DeclareJob(JsonArray forced) => new() { ["ops"] = new JsonArray(forced.OfType<JsonObject>().Select(f => (JsonNode)new JsonObject {
        ["op"] = "set", ["target"] = "@" + f["objectKey"], ["prop"] = "DeleteRule", ["value"] = "Ignore" }).ToArray()) };
    private static string KnownLossesText(JsonArray lost, JsonArray forced, bool others)
    {
        var missing = MergeOrder.FromJson(lost);
        var parts = new List<string>();
        if (missing.Count > 0) parts.Add("the native merge did not keep " + missing.Count + " default value(s): " + MergeOrder.Describe(missing));
        if (forced.Count > 0) parts.Add("the Studio set Delete Rule Ignore on " + string.Join(", ", forced.Select(f => f!["element"] + " (requested " + f["requested"] + ")")) + ", the only rule this environment allows there");
        return "Merge kept for review: " + string.Join("; ", parts) + (others ? "" : "; nothing else differs") + "."
            + (missing.Count > 0 ? " Each element exists now, so a merge keeps a default set on it: deliver mergeOrder.repair as a new job " + RepairJob(lost).ToJsonString() + "." : "")
            + (forced.Count > 0 ? " Declare the rule in the job (mergeOrder.declare) so the next candidate equals the module " + DeclareJob(forced).ToJsonString() + "." : "");
    }
}
