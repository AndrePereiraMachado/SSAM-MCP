using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
namespace Anvil.Core.Delivery;

public interface IBridgeClient
{
    JsonObject Call(string method, JsonObject? parameters = null);

    /// <summary>Releases what the client keeps loaded between calls (the thin bridge's find_element capture); the client
    /// stays usable. Delivery.Run calls it when it ends. By default a client keeps nothing.</summary>
    void ReleaseCapture() { }
}

/// <summary>Compare the validated candidate with the actual post-merge snapshot before declaring delivery.</summary>
public interface IMergeContentVerifier
{
    JsonObject VerifyContent(string expectedPath, string snapshotPath);
}

/// <summary>The merge order on the task's files: plan deferred defaults and detect losses after merge.</summary>
public interface IMergePlanner
{
    JsonObject Plan(string basePath, string foreignPath, string firstPassPath);
    JsonArray Missing(string snapshotPath, JsonArray deferred);
    /// <summary>The merge order without the disposable preview merge (rule a of the merge proof: the open module equals the
    /// delivery's base). A planner without its own answers its full Plan.</summary>
    JsonObject PlanOrder(string basePath, string foreignPath, string firstPassPath) => Plan(basePath, foreignPath, firstPassPath);
}
// BridgeCallException (Anvil.Core) lives in Kernel/BridgeCallException.cs: the kernel reads Executed, the adapters throw it.
/// <summary>CaptureProducers: binding names whose current server signature the delivery captures (read-only) into its
/// own task folder, records by SHA-256 and reuses on resume; absent from the serialized request when unused, so
/// earlier tasks keep their identity. CloseOpenedTab (K1-g): close the Studio tab this delivery opened when it ends in a
/// saved state; a property of the call, never of the task identity (not serialized), so a resume passes it again.
/// SkipOpenReferencesCheck (speed lane vel-entrega): the build phase of this call captured the module's tab by key (`deliver
/// --prebuilt`), so the open of an already open tab skips the Studio's references check (OpeningOwnTab); a call property,
/// not serialized. AutoPatch is a nullable call override recorded with the task and retained on resume;
/// false disables automatic correction and null leaves the job policy in force.</summary>
public sealed record DeliveryRequest(string Module, string JobPath, string WorkDirectory, IReadOnlyList<string> Checks,
    IReadOnlyDictionary<string, string>? Producers = null, string? TaskId = null, int? BridgePort = null, JsonObject? Specification = null, string? ExpectedEnvironment = null, string? ReservationOwner = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? CaptureProducers = null,
    [property: System.Text.Json.Serialization.JsonIgnore] bool CloseOpenedTab = false,
    [property: System.Text.Json.Serialization.JsonIgnore] bool SkipOpenReferencesCheck = false,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] bool? AutoPatch = null,
    [property: System.Text.Json.Serialization.JsonIgnore] DeliveryTrace? Trace = null);

/// <summary>F7 (traceability per session): the session (correlationId) and the call (operationId) a delivery runs for, as
/// the facade's kernel runner passes them (--correlation-id, --call-id). A property of the call, never of the task identity
/// (not serialized into the request binding), so a resume from another session keeps the task and records that session too.
/// task.json keeps correlationId and trace (the creating call) and traces (every run: create, resume, close; the last 20).</summary>
public sealed record DeliveryTrace(string CorrelationId, string? OperationId)
{
    private static string? Id(string? value) => Guid.TryParseExact(value ?? "", "D", out var g) ? g.ToString("D") : null;
    /// <summary>The trace of a command line, or null when it carries no valid correlation id (an id that is not a UUID is
    /// ignored, never written).</summary>
    public static DeliveryTrace? FromArgs(IReadOnlyList<string> args)
    {
        string? Option(string name) { for (var i = 0; i + 1 < args.Count; i++) if (args[i] == name) return args[i + 1]; return null; }
        return Id(Option("--correlation-id")) is { } correlation ? new DeliveryTrace(correlation, Id(Option("--call-id"))) : null;
    }
    public JsonObject ToJson(string run) => new() { ["correlationId"] = CorrelationId, ["operationId"] = OperationId, ["run"] = run, ["at"] = DateTimeOffset.UtcNow.ToString("O") };
}

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
        Func<string, string, string, JsonObject>? previewSignatures = null,
        Func<string, JsonArray>? referenceInventory = null)
    {
        using var autoPatch = JobPreflight.UseAutoPatch(request.AutoPatch);
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
        result.Remove("error"); result.Remove("code"); result.Remove("warnings"); result.Remove("reselected"); result.Remove("normalizations");
        // CX14 R4: the hint of an earlier close refusal ("close the dialog ...") belongs to that refusal, never to this run.
        result.Remove("next");
        result.Remove("referencesRefreshed"); result.Remove("referencesRefreshFailed");
        // fam-deps: the reference closure belongs to this run; a dialog that blocked the merge (blockedBy, question) stays
        // until the merge settles (RecordMerge).
        result.Remove("referenceClosure"); result.Remove("referenceSignatureChanges"); result.Remove("hot");
        // fix-ext-refs: the alignment a rollback answers and the Manage Dependencies after it belong to this run. Review A1: the
        // one before the merge (referencesAdded) stays: its write stays in the module until Ctrl+Z, and the next one keeps it.
        result.Remove("alignment"); result.Remove("referencesAddedAfterRollback");
        // Review round 3: one record per Studio write outside the merge (studioWrites, kept across the runs of the task); a
        // command that waited for the person in an earlier run ended by itself after the answer.
        BeginStudioWritesRun(result);
        // CX14 N6: what a call sent again after the proof of a call it settled belongs to that call's answer.
        result.Remove("sentAgainAfterIdle");
        IReadOnlyDictionary<string, VerifyHint>? hints = null;
        var dataProofDiffers = false;
        // primeira-certa A3: the preflight of a job it refuses, kept for an answer without a capture (Fail).
        JsonObject? pure = null;
        CountingBridge? sentAfterSettlement = null;
        try
        {
            // CX14: an unjournaled UI write may have run after this client stopped waiting. While it may still run, the
            // resume only observes (two bounded reads) and never repeats open/refresh/close.
            // CX14 R3: once two reads prove the Studio idle, that call has ended. It is settled (its fence lifted) and never
            // changes the merge's writeState, so the resume goes on as any resume of that writeState: an applied merge is
            // re-verified, an unknown one is reconciled through its journal.
            // CX14 N2 (declared): a task whose merge was never sent (not-sent) goes on too, in this same call (before it was
            // told to close and deliver again); a settled Refresh References is named with Ctrl+Z in settledBridgeOperations.
            // CX14 N3: the same for a UI call that stopped beside a pending merge (pendingBridgeOperation.after): no
            // open/refresh/close is sent while it may still run.
            if (DeliveryTask.UnsettledUiCall(result) is { } running)
            {
                if (!DeliveryTask.InspectPendingUi(result, bridge)["idle"]!.GetValue<bool>())
                    return Fail("The prior Studio UI operation (" + running + ") is still pending or idle could not be proven; nothing was repeated. Resolve the current Studio blocker and inspect this task again.");
                // CX14 N6: from here on, what this call sends again is counted for the calls it settled (their notes).
                sentAfterSettlement = CountingBridge.Wrap(bridge);
                sentAfterSettlement.Settled.AddRange(DeliveryTask.SettlePendingUi(result));
                // Review round 4 (N1): the idle proof is the evidence that the Studio commands of earlier runs ended.
                EndStudioWrites(result, "idle");
                task.Save("pending-ui-settled");
                bridge = sentAfterSettlement;
            }
            result["delivered"] = false;
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
                    // The whole-job preflight (C20/C28), recorded as it is. primeira-certa A3: a job it refuses is no longer
                    // refused here, alone: the delivery goes on to the capture of the live module and the apply over it, which
                    // refuses once with every phase (preflight, base, apply, Verify) before the merge, the only Studio write.
                    // The preflight alone answers only when no capture can be had (Fail below), with verifyRan false.
                    var preflight = JobPreflight.Check(request.JobPath);
                    result["preflight"] = preflight.DeepClone();
                    if (preflight["valid"]?.GetValue<bool>() == false) pure = preflight;
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
            var opened = bridge.Call("open_module", OpeningOwnTab(request, new() { ["name"] = request.Module, ["timeout"] = 20,
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
                var reopened = bridge.Call("open_module", OpeningOwnTab(request, new() { ["name"] = request.Module, ["timeout"] = 20,
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
            // F5: what this call observed of each producer signature (a fresh capture, a server attestation) and the
            // workspace ledger that vouches for a recent observation of the same published state.
            var signatures = new SignatureObservations(ProducerLedger.ForWork(request.WorkDirectory), ProducerCache.ForWork(request.WorkDirectory));
            var producers = CaptureProducers(task, request, sources, active["environment"]?.ToString(), producerAuthority, log, key, signatures);
            if (writeState == "not-sent") AttestProducers("producerAttestation");
            // fam-deps (family E): a consumer delivery (reference ops, captured or bound producers) has its references read and
            // checked by the kernel: the base (owners kept, R5), the candidate before the merge, the merged module after it.
            var referenceOps = request.Specification == null ? ReferenceClosure.ReferenceOps(request.JobPath) : [];
            var consumer = request.Specification == null && (referenceOps.Count > 0 || producers.Count > 0);
            IReadOnlyList<ModuleReferenceEntry>? baseReferences = null, candidateReferences = null;
            var keptOwners = new List<string>();
            stage = "runtime-dependencies";
            var frozenCompilation = ReadCompilation(task, request, active["environment"]?.ToString(), key);
            var sourceCompilation = frozenCompilation?.Compilation ?? (request.Specification == null ? null : ModuleSpecification.CompileCSharpSource(request.Specification));
            var dependencies = PrepareDependencies(task, request, active["environment"]?.ToString(), key, dependencyRuntime, sourceCompilation);
            frozenCompilation = FreezeCompilation(task, request, active["environment"]?.ToString(), key, sourceCompilation, dependencies, frozenCompilation);
            if (writeState is "intent" or "unknown")
            {
                stage = "reconcile";
                if (!Reconcile())
                {
                    // fam-deps: a merge blocked by a dialog only the person answers is still waiting for that answer.
                    if (result["blockedBy"] is JsonObject waiting)
                    {
                        result["code"] = StudioDialogPending;
                        // CX14 N7: what this call sent again after a proven idle is in its counts; the text says only what is true.
                        return Fail("The merge still waits in the Studio for the person to answer \"" + waiting["title"] + "\". " + waiting["question"]
                            + " " + DeliveryTask.NotRepeated(sentAfterSettlement, sentence: true) + "; resume this task again after the answer.");
                    }
                    return Fail("Merge outcome remains unknown; no creation or merge was replayed. Reconcile the original operation.");
                }
                if (StudioErrorDuringMerge() is { } studioErrorAnswer) return studioErrorAnswer;
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
            // fam-deps R5: an owner of foreign types (ownerKey) the module already references with every object its dependents
            // use keeps its signature, so the Studio is never asked to move it either. Review finding 3: that decision is made
            // here, BEFORE the refresh, on a capture of the module as it is now (pre-refresh.oml): the producers the job names and
            // the owners R5 links (the module lacks an object they must provide) are refreshed to their published signature, so
            // the candidate does not change their signature and the live merge never selects one; only the kept owners stay
            // out. When the module cannot be read here, the owners stay out of the refresh, as before.
            // fix-ext-refs (2026-10-16): with a bridge that runs the Studio's own Manage Dependencies (refresh_references:add) the
            // same call adds the elements the job's reference ops name and brings each producer to its published signature, for
            // every producer the delivery captured or binds (eSpace, Extension or system alike), all or nothing; a refusal is one
            // answer before any merge (REFERENCES_NOT_ADDED). The candidate then changes no producer signature (DeliveryManageDependencies.cs).
            var capturedNow = result["capturedProducers"] as JsonObject;
            var boundNow = writeState == "not-sent" ? BoundSignatures(request) : new Dictionary<string, (string Key, string? Hash)>();
            if (writeState == "not-sent" && (capturedNow is { Count: > 0 } || boundNow.Count > 0) && Offers(bridge, RefreshReferencesCapability))
            {
                var keptBeforeRefresh = new List<string>();
                var owners = (capturedNow ?? new JsonObject()).Where(p => p.Value?["ownerKey"] != null).Select(p => p.Key).ToList();
                if (owners.Count > 0)
                {
                    keptBeforeRefresh.AddRange(owners);
                    if (consumer)
                    {
                        stage = "reference-closure";
                        var preRefreshPath = Path.Combine(attemptDirectory, "pre-refresh.oml");
                        var preRefresh = bridge.Call("snapshot_module", Target(new() { ["path"] = preRefreshPath }));
                        if (preRefresh["key"]?.ToString() == key && ReadReferences(preRefreshPath, "preRefresh") is { } current)
                        {
                            var (keptNow, ownersNow) = ReferenceClosure.OwnersKeptByBase(capturedNow!, current, SameProducerKey);
                            keptBeforeRefresh.Clear(); keptBeforeRefresh.AddRange(keptNow);
                            Closure()["ownersBeforeRefresh"] = ownersNow;
                        }
                    }
                }
                var toRefreshPairs = (capturedNow ?? new JsonObject()).Where(p => !keptBeforeRefresh.Contains(p.Key, StringComparer.OrdinalIgnoreCase) && p.Value is JsonObject).ToList();
                var toRefresh = toRefreshPairs.Select(p => (JsonObject)p.Value!).ToList();
                var manage = Offers(bridge, ManageDependenciesCapability);
                var aligned = toRefreshPairs.Select(p => new AlignedProducer(p.Key, p.Value!["key"]?.ToString(), p.Value["producer"]?.ToString(), p.Value["kind"]?.ToString())).ToList();
                if (manage)
                    foreach (var (binding, (signatureKey, _)) in boundNow)
                        if (!aligned.Any(a => a.Key != null && SameProducerKey(a.Key, signatureKey))) aligned.Add(new AlignedProducer(binding, signatureKey, null, null));
                if (toRefresh.Count > 0 || (manage && aligned.Count > 0))
                {
                    stage = manage ? "add-references" : "refresh-references";
                    var names = new JsonArray(); var keys = new JsonArray();
                    foreach (var producer in aligned)
                    {
                        if (producer.Name is { Length: > 0 } producerName) names.Add(producerName);
                        if (producer.Key is { Length: > 0 } producerKey) keys.Add(producerKey);
                    }
                    var parameters = new JsonObject { ["producers"] = names, ["producer_keys"] = keys, ["timeout"] = 600 };
                    if (manage) { parameters["add"] = AlignmentAdd(referenceOps, aligned); parameters["published"] = true; }
                    var refreshed = CallStudioWrite(bridge, result, "before-merge", Target(parameters), request.Module);
                    result["refreshReferences"] = refreshed;
                    // Review A1: what the Studio's Manage Dependencies wrote to the module, declared in every answer from here on.
                    if (manage) result["referencesAdded"] = DeclareReferencesAdded(refreshed, result["referencesAdded"], request.Module, "before-merge");
                    // The same family (C26): the Studio's Refresh References that changed the module is declared too.
                    else result["referencesRefreshedBeforeMerge"] = DeclareReferencesRefreshed(refreshed, result["referencesRefreshedBeforeMerge"], request.Module);
                    LinkDetail(result, manage ? "referencesAdded" : "referencesRefreshedBeforeMerge");
                    task.Save(stage);
                    log?.Invoke(manage ? $"deliver: Manage Dependencies before the merge committed={refreshed["committed"]} added={(refreshed["added"] as JsonArray)?.Count ?? 0}"
                        : $"deliver: refresh_references before the merge changed={refreshed["changed"]}");
                    if (RefreshBlocked(result, refreshed, stage) is { } waiting) return Fail(waiting);
                    if (manage && ReferencesNotAdded(result, refreshed) is { } refused) return Fail(refused);
                    // A Manage Dependencies that failed inside the Studio (an exception, its command rolled back): recorded, and the
                    // delivery goes on as with a bridge without it (the Studio's Refresh References, then the merge).
                    if (manage && refreshed["committed"]?.GetValue<bool>() == false && toRefresh.Count > 0)
                    {
                        stage = "refresh-references";
                        var plainNames = new JsonArray(); var plainKeys = new JsonArray();
                        foreach (var entry in toRefresh)
                        {
                            if (entry["producer"]?.ToString() is { Length: > 0 } producerName) plainNames.Add(producerName);
                            if (entry["key"]?.ToString() is { Length: > 0 } producerKey) plainKeys.Add(producerKey);
                        }
                        // Review B1: the answer names the fallback that ran instead of the Manage Dependencies.
                        if (result["referencesAdded"] is JsonObject failedManage) failedManage["fallback"] = "Refresh References";
                        if ((result["studioWrites"] as JsonArray)?.LastOrDefault() is JsonObject failedRecord) failedRecord["fallback"] = RefreshReferencesCommand;
                        var plain = CallStudioWrite(bridge, result, "before-merge", Target(new() { ["producers"] = plainNames, ["producer_keys"] = plainKeys, ["timeout"] = 600 }), request.Module);
                        result["refreshReferences"] = plain;
                        result["referencesRefreshedBeforeMerge"] = DeclareReferencesRefreshed(plain, result["referencesRefreshedBeforeMerge"], request.Module);
                        LinkDetail(result, "referencesRefreshedBeforeMerge");
                        task.Save(stage);
                        if (RefreshBlocked(result, plain, stage) is { } waitingAgain) return Fail(waitingAgain);
                    }
                }
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
                // fam-deps R5: the references of the base decide which owners of foreign types the apply links. An owner the
                // module already references with every object its dependents use keeps its signature: the delivery changes
                // the signature of a producer only when it needs something the module does not have.
                if (consumer)
                {
                    stage = "reference-closure";
                    baseReferences = ReadReferences(basePath, "base");
                    if (baseReferences != null && result["capturedProducers"] is JsonObject capturedAll)
                    {
                        var (kept, owners) = ReferenceClosure.OwnersKeptByBase(capturedAll, baseReferences, SameProducerKey);
                        if (owners.Count > 0) Closure()["owners"] = owners;
                        keptOwners.AddRange(kept);
                        if (kept.Count > 0)
                        {
                            producers = producers.Where(p => !kept.Contains(p.Key, StringComparer.OrdinalIgnoreCase))
                                .ToDictionary(p => p.Key, p => p.Value, StringComparer.OrdinalIgnoreCase);
                            log?.Invoke($"deliver: the module already references {string.Join(", ", kept)} with what the job needs; their signatures stay (R5)");
                        }
                    }
                    task.Save(stage);
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
                // R3: the inventories the apply recorded (a prebuilt candidate's are its build's) answer the candidate's read.
                ReferenceInventoryCache.ReadSidecar(applied["referenceInventory"]?["file"]?.ToString());
                Hot();
                if (IntegrationReports(applied, importReceipts) is { } integration) result["integration"] = integration;
                // A03: only errors and security warnings make the apply's policy refuse (MessageExpectations); a refusal
                // still carries the warnings that block nothing, so the correction sees them in the same answer.
                if (applied["isValid"]?.GetValue<bool>() != true || applied["accepted"]?.GetValue<bool>() != true)
                {
                    RecordWarnings(null);
                    // The part of the contract that refused, with its counts: the task's receipt and every record of it say so.
                    return Fail("job rejected by validation contract (" + ValidationVerdict(applied) + "); merge was not attempted");
                }
                // A lab that builds a SOAP client by verbs (allowSoapWithoutImport) measures the verbs: it never reaches a module,
                // whose compiler would fail on that client (CompileCheck, class D).
                if (applied["highWarnings"] is JsonArray labWarnings && labWarnings.OfType<JsonObject>().FirstOrDefault(w => w["code"]?.ToString() == CompileCheck.SoapAllowed) is { } lab)
                {
                    RecordWarnings(null);
                    result["code"] = CompileCheck.SoapDefinition;
                    return Fail($"the job builds a consumed SOAP service by verbs under the lab escape {CompileCheck.SoapAllowKey} ({lab["message"]}); a lab is never delivered: import the service with op soap. Nothing was merged.");
                }
                if (DeliveryReceipt.Changed(sources).Count > 0) return Fail("Job or dependency changed during apply; nothing was merged. Deliver the current source.");
                // fam-deps (family E): the candidate's references against the base and the captures, before the only Studio
                // write: a named producer missing or not at its published signature, or a collateral signature change (R5),
                // refuses here once with every reference named; the live merge never meets them.
                if (consumer && baseReferences != null)
                {
                    stage = "reference-closure";
                    candidateReferences = ReadReferences(foreignPath, "candidate");
                    if (candidateReferences != null)
                    {
                        var captured = result["capturedProducers"] as JsonObject;
                        var referenceExpectations = ReferenceClosure.Expectations(referenceOps, captured, BoundSignatures(request));
                        var mayChange = DeliveryProducerKeys();
                        Closure()["changes"] = ReferenceClosure.Changed(baseReferences, candidateReferences, SameProducerKey);
                        var problems = ReferenceClosure.CheckCandidate(referenceExpectations, candidateReferences, baseReferences, mayChange, SameProducerKey);
                        if (problems.Count > 0)
                        {
                            result["code"] = ReferenceClosure.ClosureRefused; result["problems"] = problems;
                            RecordWarnings(null);
                            return Fail("The candidate's producer references do not match what this delivery may merge; nothing was merged: "
                                + string.Join(" ", problems.OfType<JsonObject>().Select(p => p["message"] + " Fix: " + p["fix"])));
                        }
                    }
                    task.Save(stage);
                }
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
                result.Remove("mergeContentPreview");
                result.Remove("mergeProof"); result.Remove("timings");
                if (mergePlanner != null)
                {
                    // The merge proof (finding 1 of the kernel review of 3ab12209): (a) the open module equals this
                    // delivery's base, so the live merge takes the candidate as is: no disposable preview, the proof after
                    // the merge is the only one; otherwise the preview runs, and after the merge (b) a live result with the
                    // preview's model reuses its verdict, (c) any other is proved again.
                    var decision = OpenModuleAgainstBase();
                    result["mergeProof"] = decision;
                    var sameAsBase = decision["rule"]?.ToString() == "a";
                    var planClock = Stopwatch.StartNew();
                    var plan = sameAsBase ? mergePlanner.PlanOrder(basePath, foreignPath, Path.Combine(attemptDirectory, "first-pass.oml"))
                        : mergePlanner.Plan(basePath, foreignPath, Path.Combine(attemptDirectory, "first-pass.oml"));
                    var timings = Timings();
                    timings["mergePlanMs"] = planClock.ElapsedMilliseconds;
                    if (plan["timings"]?["orderMs"] is { } orderMs) timings["mergeOrderMs"] = orderMs.DeepClone();
                    if (plan["timings"]?["previewMs"] is { } previewMs) timings["previewMs"] = previewMs.DeepClone();
                    if (plan["contentPreview"]?["timings"] is JsonObject previewTimings)
                    {
                        timings["previewMergeMs"] = previewTimings["mergeMs"]?.DeepClone();
                        timings["previewContentProofMs"] = previewTimings["contentProofMs"]?.DeepClone();
                    }
                    decision["previewRan"] = plan["contentPreview"] is JsonObject;
                    if (!sameAsBase && plan["contentPreview"] is not JsonObject)
                        decision["reason"] = decision["reason"]?.ToString() + "; no disposable preview ran" + (plan["contentPreviewError"] is { } previewError ? " (" + previewError + ")" : "") + ", so the content is proved after the merge";
                    if (plan["contentPreview"] is JsonObject preview)
                    {
                        result["mergeContentPreview"] = preview.DeepClone();
                        if (preview["accepted"]?.GetValue<bool>() != true)
                        {
                            stage = "merge-content-preview";
                            result["code"] = "MERGE_CONTENT_PREVIEW_REFUSED";
                            return Fail("A disposable native merge did not preserve the candidate. Nothing was merged in the Studio or published. Inspect mergeContentPreview.contentProof; fix the candidate or merge implementation before retrying.");
                        }
                    }
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
                    result["writeState"] = "unknown"; result["mergeError"] = Errors.Text(ex);
                    if (ex.Stall != null) { RecordStall(ex); task.Save("merge-stalled"); }
                    else task.Save("merge-unknown");
                }
                // fam-deps (family D): the bridge answered in seconds that a dialog the Studio opened during the merge needs the
                // person (OperationDialogLoop); the merge still waits for that answer in the Studio. One question with the exact
                // text; nothing is repeated, and the resume settles the merge through its journal once the person answered.
                if (result["merge"]?["blocked"]?.GetValue<bool>() == true && result["merge"]?["blockedBy"] is JsonObject dialog)
                {
                    result["code"] = StudioDialogPending; result["blockedBy"] = dialog.DeepClone(); result["question"] = dialog["question"]?.DeepClone();
                    task.Save("merge-blocked");
                    return Fail("The Studio opened \"" + dialog["title"] + "\" during the merge and only the person can answer it. " + dialog["question"]
                        + " " + DeliveryTask.NotRepeated(sentAfterSettlement, sentence: true) + "; after the answer, resume this task (deliver --resume " + task.Id + ").");
                }
                // A native merge that failed after it started (verificationError) is unknown, never repeated: it is reconciled
                // in this same call (merge_status, then the rollback proofs); what stays unknown is resumed later.
                if (result["writeState"]!.ToString() == "unknown")
                {
                    stage = "reconcile";
                    var failed = result["merge"]?["verificationError"]?.ToString() ?? result["mergeError"]?.ToString();
                    if (!Reconcile())
                    {
                        if (result["stalled"] is JsonObject stopped)
                        {
                            var seconds = double.TryParse(stopped["afterMs"]?.ToString(), System.Globalization.NumberStyles.Float,
                                System.Globalization.CultureInfo.InvariantCulture, out var elapsed) ? elapsed / 1000d : 0;
                            return Fail("The Studio stopped answering the merge: " + stopped["verdict"]
                                + (stopped["blockedBy"]?["title"] is { } title ? " (" + title + ")" : "")
                                + " after " + seconds.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture)
                                + " s; " + DeliveryTask.NotRepeated(sentAfterSettlement) + ". Resume reconciles it through merge_status.");
                        }
                        return Fail("Merge outcome is unknown" + (failed != null ? ": " + failed : "")
                            + "; " + DeliveryTask.NotRepeated(sentAfterSettlement) + ". Resume reconciles it through merge_status.");
                    }
                    stage = "merge";
                }
                // Review finding 1: a merge during which the Studio reported an error is proven against the base before its result counts.
                if (StudioErrorDuringMerge() is { } studioErrorAnswer) return studioErrorAnswer;
                if (result["writeState"]!.ToString() == "not-applied" && result["merge"]?["rolledBack"]?.GetValue<bool>() == true) return RolledBack();
                if (result["writeState"]!.ToString() is not ("applied" or "unchanged"))
                    return Fail("merge not applied: " + (result["merge"]?["reason"]?.ToString() ?? result["merge"]?["result"]?.ToString()));
                // fam-deps + MB2: the dependencies dialog the bridge closed (Cancel) while the merge ran is followed, as after an
                // open, by the Studio's own Refresh References of every producer of the module.
                if (result["merge"]?["dialogs"] is JsonArray seenDialogs
                    && seenDialogs.OfType<JsonObject>().Where(d => d["kind"]?.ToString() == OperationDialogPolicy.Dependencies).ToArray() is { Length: > 0 } dependencyAnswers)
                {
                    stage = "refresh-references";
                    var answeredDependencies = new JsonArray(dependencyAnswers.Select(d => (JsonNode)new JsonObject { ["kind"] = DependenciesKindAnswered, ["title"] = d["title"]?.DeepClone(), ["answer"] = "Cancel", ["text"] = d["text"]?.DeepClone() }).ToArray());
                    if (RefreshAfterDependencies(bridge, result, "merge", answeredDependencies, request.Module, key, result["environment"]?.ToString(), log) is { } refreshFailed)
                        failures.Add(("refresh-references", refreshFailed));
                    task.Save(stage);
                }
            }
            // Review finding 1: a resumed applied task whose merge reported a Studio error keeps that failure (idempotent here).
            if (StudioErrorDuringMerge() is { } studioErrorLate) return studioErrorLate;
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
            catch (Exception ex) when (ex is not BridgeCallException { Stall: not null }) { failures.Add((stage, Errors.Text(ex))); }
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
            // fam-deps (class E): after a merge of a consumer, the merged module keeps the producer references the validated
            // candidate had (same signature, every export); read on the same delivered snapshot as the data proof.
            if (consumer && result["writeState"]?.ToString() == "applied" && candidateReferences == null && File.Exists(foreignPath) && File.Exists(basePath))
            {
                baseReferences ??= ReadReferences(basePath, "base");
                if (baseReferences != null) candidateReferences = ReadReferences(foreignPath, "candidate");
            }
            var proveReferences = consumer && result["writeState"]?.ToString() == "applied" && candidateReferences != null && baseReferences != null;
            var contentVerifier = mergePlanner as IMergeContentVerifier;
            string? deliveredFile = null;   // L3b: the capture after the merge, the base the worker prepares next once delivered
            result.Remove("contentProof");
            if (assertions.Count > 0 || dependencies != null || frozenCompilation != null || deferred is { Count: > 0 } || proveReferences || contentVerifier != null)
            {
                try
                {
                    var deliveredPath = Path.Combine(work, "delivered-" + Guid.NewGuid().ToString("N") + ".oml");
                    var deliveredSnapshot = bridge.Call("snapshot_module", Target(new() { ["path"] = deliveredPath }));
                    if (deliveredSnapshot["key"]?.ToString() != key) throw new InvalidOperationException("Active module changed before content proof; merge kept for review");
                    result["deliveredSnapshot"] = deliveredSnapshot;
                    deliveredFile = deliveredPath;
                    result["artifacts"]!.AsArray().Add(Artifact(deliveredPath));
                    if (proveReferences) ProveReferences(deliveredPath);
                    if (contentVerifier != null)
                    {
                        // Accepted or not is decided below, once the known losses of the merge order are read: a difference
                        // the repair job already covers is no content mismatch of its own.
                        // A proof that cannot run is said and decides nothing: the merge stands as the other checks find it.
                        // Rule (b) of the merge proof: the preview's verdict on the same model is reused, never proved twice.
                        if (ReusedPreviewProof(deliveredPath) is { } reusedProof) { result["contentProof"] = reusedProof; Timings().Remove("contentProofMs"); }
                        else
                        {
                            var proofClock = Stopwatch.StartNew();
                            try { result["contentProof"] = contentVerifier.VerifyContent(foreignPath, deliveredPath); }
                            catch (Exception proofError) when (proofError is not OutOfMemoryException and not BridgeCallException) { result["contentProofError"] = Errors.Text(proofError); }
                            finally { Timings()["contentProofMs"] = proofClock.ElapsedMilliseconds; }
                        }
                    }
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
                            // One entry per element, told by its name (finding 4): the merge may have re-keyed it, so the key the
                            // data proof read and the one the merge order found may differ for the same element.
                            foreach (var entry in named.OfType<JsonObject>())
                                if (!lost.OfType<JsonObject>().Any(l => l["element"]?.ToString() == entry["element"]?.ToString())) lost.Add(entry);
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
                        // Finding 4 of the kernel review of 3ab12209: each content-proof difference is matched to a known loss by
                        // its element's name (the proof names no element by a local key), never by a count: any difference no
                        // lost default and no forced Delete Rule explains is a content mismatch of its own. "Nothing else
                        // differs" only when a content proof ran and matched every difference.
                        var (unmatched, matched) = MatchKnownLosses(result["contentProof"], lost, forced);
                        others |= unmatched > 0;
                        result["mergeOrder"] = new JsonObject { ["missing"] = lost.DeepClone(), ["rule"] = MergeOrderRule,
                            ["repair"] = RepairJob(lost), ["forcedDeleteRules"] = forced.DeepClone(), ["declare"] = DeclareJob(forced) };
                        failures.Add((stage, KnownLossesText(lost, forced, proven: matched && !others) + (deferred is { Count: > 0 } ? SecondMergeText(result["merge"]) : "")));
                    }
                    if (result["contentProof"]?["accepted"]?.GetValue<bool>() == false && (lost.Count == 0 && forced.Count == 0 || others))
                    {
                        result["code"] = "MERGE_CONTENT_MISMATCH";
                        failures.Add((stage, "Merge kept for review: model content differs from the validated candidate; inspect contentProof and its coverage. Nothing was published; do not repeat the merge."));
                    }
                }
                catch (Exception ex) when (ex is not BridgeCallException { Stall: not null }) { failures.Add((stage, Errors.Text(ex))); }
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
            // L3b (spare pós-merge): in a worker, the delivered capture is the module now; its spare is prepared while idle.
            if (BaseModelCache.AfterMerge(deliveredFile, basePath) is { } nextSpare) result["nextSpare"] = nextSpare;
            // Review A1: the declared Studio writes say their undo for a merge that applied after them.
            StudioWritesText(result);
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
            // The costs of the merge proof in this run, in milliseconds (the receipt's timings).
            JsonObject Timings()
            {
                if (result["timings"] is JsonObject existing) return existing;
                var created = new JsonObject();
                result["timings"] = created;
                return created;
            }
            // Rule (a) of the merge proof, read right before the plan: the model the open tab holds now (list_open_modules
            // {model_sha256_of}: the SHA-256 of what snapshot_module would write, after the OML header where the Studio keeps
            // its window state; no file, no registered snapshot) against the model of this delivery's base (the same rule,
            // PrebuiltCandidate.ModelSha256). Equal: no edit reached the module between the snapshot and now. Anything that is
            // not that proof (an older bridge, no fingerprint, another tab, a different model) is rule c, with the reason.
            JsonObject OpenModuleAgainstBase()
            {
                var watch = Stopwatch.StartNew();
                var decision = new JsonObject { ["rule"] = "c" };
                try
                {
                    var baseModel = PrebuiltCandidate.ModelSha256(basePath);
                    decision["baseModelSha256"] = baseModel;
                    if (!Offers(bridge, OpenModelFingerprintCapability))
                    {
                        decision["reason"] = "the bridge does not offer " + OpenModelFingerprintCapability + ", so the open module could not be compared with the base";
                        return decision;
                    }
                    var listed = bridge.Call("list_open_modules", new JsonObject { ["model_sha256_of"] = key });
                    var tabEnvironment = result["environment"]?.ToString();
                    var tabs = (listed["modules"] as JsonArray ?? []).OfType<JsonObject>()
                        .Where(t => t["key"]?.ToString() == key && t["hasOpenedActiveESpace"]?.GetValue<bool>() == true
                            && (tabEnvironment == null || t["environment"] == null || string.Equals(t["environment"]!.ToString(), tabEnvironment, StringComparison.OrdinalIgnoreCase)))
                        .ToList();
                    var opened = tabs.Count == 1 ? tabs[0]["modelSha256"]?.ToString() : null;
                    if (string.IsNullOrWhiteSpace(opened))
                    {
                        decision["reason"] = tabs.Count != 1 ? tabs.Count + " open tab(s) of this module answered list_open_modules, so the open module could not be compared with the base"
                            : "the Studio gave no model fingerprint of the open module (a busy UI, a tab opening or in silent mode)";
                        return decision;
                    }
                    decision["localModelSha256"] = opened;
                    if (tabs[0]["modelSha256Ms"] is { } studioMs) Timings()["studioFingerprintMs"] = studioMs.DeepClone();
                    if (!string.Equals(opened.Trim(), baseModel, StringComparison.OrdinalIgnoreCase))
                    {
                        decision["reason"] = "the open module differs from this delivery's base (an edit reached it after the snapshot), so the disposable preview runs";
                        return decision;
                    }
                    decision["rule"] = "a";
                    decision["reason"] = "the open module equals this delivery's base (model sha256 " + baseModel[..16] + "): a three-way merge over an unchanged module takes the candidate as is, so no disposable preview runs and the content is proved after the merge";
                    return decision;
                }
                catch (Exception ex) when (ex is not OutOfMemoryException and not BridgeCallException { Stall: not null })
                {
                    decision["rule"] = "c";
                    decision["reason"] = "the open module could not be compared with the base: " + Errors.Text(ex);
                    return decision;
                }
                finally { Timings()["openModuleFingerprintMs"] = watch.ElapsedMilliseconds; }
            }
            // Rule (b) of the merge proof, after the merge: a disposable preview ran and the delivered module holds the same
            // model as the preview's result (PrebuiltCandidate.ModelSha256 of both files), so the preview's content proof is
            // the verdict on the delivered module: it is reused and the proof is not run again. Null otherwise (rule c, with
            // the reason in mergeProof), and the proof runs.
            JsonObject? ReusedPreviewProof(string deliveredPath)
            {
                if (result["mergeProof"] is not JsonObject decision || decision["previewRan"]?.GetValue<bool>() != true) return null;
                var watch = Stopwatch.StartNew();
                // What decided before the merge stays in the reason, followed by what the delivered module showed.
                string Before() => decision["reason"]?.ToString() is { Length: > 0 } said ? said + "; after the merge, " : "";
                try
                {
                    var previewed = result["mergeContentPreview"] as JsonObject;
                    var previewProof = previewed?["contentProof"] as JsonObject;
                    var previewPath = previewed?["path"]?.ToString();
                    string? why = null;
                    if (previewed?["accepted"]?.GetValue<bool>() != true || previewProof?["accepted"]?.GetValue<bool>() != true) why = "the preview did not accept the candidate";
                    else if (string.IsNullOrEmpty(previewPath) || !File.Exists(previewPath) || DeliveryReceipt.Hash(previewPath) != previewed!["sha256"]?.ToString()) why = "the preview's result is gone or changed";
                    else if (previewProof!["inputs"]?["expected"]?["sha256"]?.ToString() is not { } candidateSha || !string.Equals(candidateSha, DeliveryReceipt.Hash(foreignPath), StringComparison.OrdinalIgnoreCase)) why = "the preview proved another candidate";
                    if (why == null)
                    {
                        var previewModel = PrebuiltCandidate.ModelSha256(previewPath!); var deliveredModel = PrebuiltCandidate.ModelSha256(deliveredPath);
                        decision["previewModelSha256"] = previewModel; decision["deliveredModelSha256"] = deliveredModel;
                        if (previewModel == deliveredModel)
                        {
                            decision["rule"] = "b"; decision["proofReused"] = true;
                            decision["reason"] = Before() + "the delivered module holds the model of the disposable preview's result (model sha256 " + deliveredModel[..16] + "): the preview's content proof is its verdict, reused instead of a second proof";
                            var reused = previewProof.DeepClone().AsObject();
                            reused["reused"] = new JsonObject { ["from"] = "mergeContentPreview", ["previewModelSha256"] = previewModel, ["deliveredModelSha256"] = deliveredModel, ["delivered"] = Path.GetFullPath(deliveredPath) };
                            return reused;
                        }
                        why = "the delivered module differs from the preview's result";
                    }
                    decision["rule"] = "c"; decision["proofReused"] = false;
                    decision["reason"] = Before() + why + ", so the content is proved again on the delivered module";
                    return null;
                }
                finally { Timings()["previewReuseCheckMs"] = watch.ElapsedMilliseconds; }
            }
            // R3: what this run reused of a module the worker knew: the apply's spare (a prebuilt candidate: none applied here)
            // and the closure's inventories, with the time saved (each part measured where it was paid).
            void Hot()
            {
                var apply = result["apply"]?["hot"] as JsonObject;
                var closure = result["referenceClosure"] as JsonObject;
                var reusedApply = apply?["reused"]?.GetValue<bool>() == true;
                var prebuilt = result["apply"]?["prebuilt"]?["reused"]?.GetValue<bool>() == true;
                var reusedClosure = HotModule.Number(closure?["reused"]);
                var reasons = new List<string>();
                if (prebuilt) reasons.Add("the candidate built outside the Studio lock was reused (no apply here)");
                else if (apply != null) reasons.Add("apply: " + apply["reason"]);
                if (closure?["ms"] != null)
                    reasons.Add(reusedClosure > 0 ? "reference closure: " + reusedClosure + (reusedClosure == 1 ? " inventory" : " inventories") + " of a known model" : "reference closure: every inventory read now");
                result["hot"] = new JsonObject
                {
                    ["reused"] = (reusedApply && !prebuilt) || reusedClosure > 0, ["reason"] = string.Join("; ", reasons),
                    ["savedMs"] = (prebuilt ? 0 : HotModule.Number(apply?["savedMs"])) + HotModule.Number(closure?["savedMs"]),
                    ["apply"] = apply?.DeepClone(),
                    ["referenceClosure"] = closure == null ? null : new JsonObject { ["ms"] = closure["ms"]?.DeepClone(), ["reused"] = reusedClosure, ["savedMs"] = HotModule.Number(closure["savedMs"]) },
                };
            }
            // fam-deps: the reference closure receipt of this run (base, candidate, delivered summaries, owners, changes).
            JsonObject Closure()
            {
                if (result["referenceClosure"] is JsonObject existing) return existing;
                var created = new JsonObject();
                result["referenceClosure"] = created;
                return created;
            }
            // The references of an OML (ReferenceInventory, SS11), or null with the reason when they cannot be read here (no
            // reader in this lane, not an OML, a model that does not load): the checks that need them do not run, as before.
            // R3 (módulo quente): the Studio's reader loads the whole module; the inventory of a model this process already read
            // or an apply recorded (its sidecar, ReferenceInventoryCache) is read by model identity instead. Only with the
            // lane's own reader (an injected one is a test's and always runs).
            IReadOnlyList<ModuleReferenceEntry>? ReadReferences(string path, string what)
            {
                var reader = referenceInventory ?? (DefaultReferenceInventory is { } read ? p => read(p, attemptDirectory) : null);
                string? reason = reader == null ? "no reference reader in this lane" : !LooksLikeOml(path) ? "not an OML file" : null;
                if (reason == null)
                {
                    var watch = Stopwatch.StartNew();
                    try
                    {
                        var (json, reused, savedMs) = referenceInventory == null || CacheInjectedReferenceReads.Value
                            ? ReferenceInventoryCache.ReadThrough(path, reader!, what) : (reader!(path), null, 0);
                        var references = ReferenceClosure.FromJson(json);
                        var entry = new JsonObject { ["ran"] = true, ["references"] = ReferenceClosure.Summary(references), ["ms"] = watch.ElapsedMilliseconds };
                        if (reused != null) { entry["reused"] = reused; entry["savedMs"] = savedMs; }
                        Closure()[what] = entry;
                        ClosureTime(watch.ElapsedMilliseconds, reused != null ? savedMs : null);
                        return references;
                    }
                    catch (Exception ex) when (ex is not OutOfMemoryException) { reason = Errors.Text(ex); ClosureTime(watch.ElapsedMilliseconds, null); }
                }
                Closure()[what] = new JsonObject { ["ran"] = false, ["reason"] = reason };
                return null;
            }
            // The closure's own time and what its reused inventories saved, and the delivery's `hot` (the apply's with it).
            void ClosureTime(long ms, long? saved)
            {
                var closure = Closure();
                closure["ms"] = HotModule.Number(closure["ms"]) + ms;
                if (saved is { } kept) { closure["reused"] = HotModule.Number(closure["reused"]) + 1; closure["savedMs"] = HotModule.Number(closure["savedMs"]) + kept; }
                Hot();
            }
            // Class E after the merge: the references the delivery changed or named, in the merged module as validated.
            void ProveReferences(string deliveredPath)
            {
                var delivered = ReadReferences(deliveredPath, "delivered");
                if (delivered == null || candidateReferences == null || baseReferences == null) return;
                var watched = ReferenceClosure.Changed(baseReferences, candidateReferences, SameProducerKey).OfType<JsonObject>()
                    .Select(c => c["key"]?.ToString()).Where(k => !string.IsNullOrWhiteSpace(k)).Select(k => k!)
                    .Concat(DeliveryProducerKeys()).Distinct(StringComparer.Ordinal).ToList();
                var problems = ReferenceClosure.CheckDelivered(candidateReferences, delivered, watched, SameProducerKey);
                Closure()["deliveredProblems"] = problems;
                if (problems.Count == 0) return;
                result["code"] ??= ReferenceClosure.NotRetained;
                failures.Add(("reference-proof", "Merge kept for review: the merged module did not keep the producer references the validated candidate had: "
                    + string.Join(" ", problems.OfType<JsonObject>().Select(p => p["message"]?.ToString())) + " "
                    + (problems.OfType<JsonObject>().FirstOrDefault()?["fix"]?.ToString() ?? "")));
            }
            // A08: before the verification, the tab of this task's module is the selected one: when another session selected
            // its own tab of the same Studio, open_module by the task's key selects it again (a bridge with module_key reads
            // already target any tab; an older one reads the selected tab). Throws when the module cannot be selected.
            void SelectOwnTab()
            {
                var now = bridge.Call("get_active_module");
                if (now["key"]?.ToString() == key) return;
                var again = bridge.Call("open_module", OpeningOwnTab(request, Target(new() { ["name"] = request.Module, ["timeout"] = 20 })));
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
            // F5 (the family rule of producer signatures): before the apply, an envelope this call already observed (its fresh
            // capture, the attestation of its cached capture) or one whose identity the workspace ledger saw lately with the
            // same published state and no publication since is not observed again ({by: capture|server|ledger, observedAtUtc});
            // the rest are observed together, in one read-only lease. Right before the merge every envelope is observed on the
            // server, always (one lease). A producer that changed drops its ledger observation and its cached captures (the
            // next round captures it again); right before the merge it refuses the delivery as PRODUCER_CHANGED, nothing written.
            void AttestProducers(string field)
            {
                var beforeMerge = field == "producerAttestationBeforeMerge";
                // Only .avsig sources reach RequiresAttestation: invoking it JIT-compiles the envelope reader, which loads the
                // Studio model assemblies, and a delivery without producer signatures must not need them here.
                var paths = sources.OfType<JsonObject>().Select(s => s["path"]!.ToString())
                    .Where(p => Path.GetExtension(p).Equals(".avsig", StringComparison.OrdinalIgnoreCase)).Where(ProducerSignatures.RequiresAttestation).ToList();
                if (paths.Count == 0) return;
                var environmentName = active["environment"]?.ToString();
                var entries = new Dictionary<string, JsonObject>(StringComparer.OrdinalIgnoreCase);
                var server = new List<string>();
                var now = DateTime.UtcNow;
                foreach (var path in paths)
                {
                    var identity = ProducerIdentity.ReadEnvelope(path);
                    if (!beforeMerge && signatures.Seen(path) is { } seen)
                        entries[path] = AttestedLocally(path, identity, seen.By, seen.AtUtc);
                    else if (!beforeMerge && identity != null && environmentName != null
                             && string.Equals(identity.Environment, environmentName, StringComparison.OrdinalIgnoreCase)
                             && signatures.Ledger?.Trust(identity, now, out _) is { } trust)
                        entries[path] = AttestedLocally(path, identity, "ledger", trust.ObservedAtUtc);
                    else server.Add(path);
                }
                if (server.Count > 0)
                {
                    if (producerAuthority == null)
                        throw new InvalidOperationException("Attested producer signature requires server re-attestation before merge; no read-only producer authority: " + server[0]);
                    var environment = environmentName ?? throw new InvalidOperationException("Unknown target environment");
                    Exception? refused = null;
                    foreach (var outcome in producerAuthority.AttestAll(server, environment))
                    {
                        var identity = ProducerIdentity.ReadEnvelope(outcome.Path);
                        if (outcome.Error != null || outcome.Observed == null)
                        {
                            refused ??= outcome.Error ?? new InvalidOperationException("The producer signature was not re-observed: " + outcome.Path);
                            if (identity != null) signatures.Changed(identity);
                            continue;
                        }
                        var observed = outcome.Observed;
                        observed["path"] = outcome.Path; observed["sha256"] = DeliveryReceipt.Hash(outcome.Path); observed["by"] = "server";
                        observed["observedAtUtc"] = DateTime.UtcNow.ToString("O");
                        entries[outcome.Path] = observed;
                        if (identity != null) signatures.Ledger?.Observe(ProducerIdentity.OfAttestation(observed, environment, identity.Key) ?? identity, "attest", DateTime.UtcNow);
                        log?.Invoke($"deliver: producer {observed["producer"]} re-attested ({observed["guard"]} {observed["versionId"] ?? observed["advertisedSignatureHash"]})");
                    }
                    if (refused != null)
                    {
                        if (entries.Count > 0) result[field] = new JsonArray(paths.Where(entries.ContainsKey).Select(p => (JsonNode)entries[p]).ToArray());
                        // Before the apply the refusal stays as it was (a job the preflight refused still answers its problems).
                        if (beforeMerge && ProducerChanged(refused)) result["code"] = ProducerChangedCode;
                        System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(refused).Throw();
                    }
                }
                result[field] = new JsonArray(paths.Where(entries.ContainsKey).Select(p => (JsonNode)entries[p]).ToArray());
                task.Save(stage);
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
                // Review finding 5: a bridge whose watch stayed with the merge (dialogWatch) says which dialog waits for the person
                // NOW; the resume repeats that question, never the one of the first answer (none open: no question).
                if (status["dialogWatch"]?.GetValue<bool>() == true)
                {
                    if (status["pendingDialog"] is JsonObject now) { result["blockedBy"] = now.DeepClone(); result["question"] = now["question"]?.DeepClone(); }
                    else { result.Remove("blockedBy"); result.Remove("question"); }
                }
                if (status["state"]?.ToString() is "applied" or "unchanged" or "not-applied" && status["receipt"] is JsonObject receipt)
                {
                    RecordMerge(receipt.DeepClone().AsObject());
                    return true;
                }
                // CX14: a stopped UI call can still be queued in Studio. Only its journal may settle it; taking another
                // snapshot would wait behind the same modal and its base hash cannot prove that queued work is over.
                if (result["pendingBridgeOperation"] != null && result["stalled"] != null) return false;
                if (!RollbackProof.KernelProofApplies(status)) return false;
                var baseSha = RollbackProof.BaseSha256(result);
                var livePath = Path.Combine(attemptDirectory, "reconcile-" + Guid.NewGuid().ToString("N") + ".oml");
                JsonObject live;
                try { live = bridge.Call("snapshot_module", Target(new() { ["path"] = livePath })); }
                catch (Exception ex) when (ex is not BridgeCallException { Stall: not null }) { result["reconcileError"] = Errors.Text(ex); return false; }
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
                // fam-deps R7/R8: the exact references whose signature the merge had to select (the bridge's plan, else the
                // kernel's own preview of it), whether the job named each one, and the stage and the real exception of the
                // failure inside the Studio command; never the symptom alone.
                var named = (result["capturedProducers"] as JsonObject ?? new JsonObject()).Where(p => p.Value?["ownerKey"] == null)
                    .Select(p => p.Value?["key"]?.ToString()).Concat(BoundSignatureKeys(request)).Where(k => !string.IsNullOrWhiteSpace(k)).Select(k => k!).ToList();
                var changes = ReferenceClosure.SignatureChanges(merge["referenceSignatures"] ?? result["signaturePreview"]?["plan"],
                    result["capturedProducers"] as JsonObject, named, baseReferences, SameProducerKey);
                // Review finding 2: the same classification as the candidate check (mayChange): the producers the job names, the
                // owners R5 linked and the bound signatures are the delivery's; any other change is collateral.
                var deliveryKeys = DeliveryProducerKeys();
                foreach (var change in changes.OfType<JsonObject>())
                    change["neededByDelivery"] = deliveryKeys.Any(k => SameProducerKey(k, change["key"]?.ToString() ?? ""));
                if (changes.Count > 0) result["referenceSignatureChanges"] = changes;
                // Review finding 2: "the same job again" only when the next run will not select these signatures. That changes
                // only if the module already holds them: the kernel runs the Studio's Refresh References of exactly those
                // producers now and reads the module again; the same job is said only when every one is at the candidate's
                // signature. Otherwise the answer is a different fix (fix-ext-refs: the Studio's own Manage Dependencies, `alignment`;
                // producers as OML only when every one is an eSpace module), never a loop of the same refusal.
                var aligned = changes.Count > 0 ? AlignAfterRollback(changes) : null;
                var sameJob = aligned?["aligned"]?.GetValue<bool>() == true;
                result["sameJobAgain"] = sameJob;
                var producerNames = string.Join(", ", changes.OfType<JsonObject>().Select(c => c["producer"]?.ToString()).Distinct());
                // fix-ext-refs: what the Studio's own Manage Dependencies must do for the next delivery (producers, kinds, the
                // elements the job names) and whether the loaded bridge runs it; the facade answers it as the continuation.
                // Producers as OML are named only when every one is an eSpace module: an Extension has no OML.
                var alignment = changes.Count > 0 && !sameJob ? Alignment(changes, referenceOps, result["capturedProducers"] as JsonObject,
                    merge["referenceSignatures"] ?? result["signaturePreview"]?["plan"], Offers(bridge, ManageDependenciesCapability)) : null;
                if (alignment != null) result["alignment"] = alignment;
                var onlyModules = alignment != null && alignment["bridgeOffers"]?.GetValue<bool>() != true
                    && (alignment["add"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().All(a => string.Equals(a["kind"]?.ToString() ?? "eSpace", "eSpace", StringComparison.OrdinalIgnoreCase));
                // Review A1: the base is the module as the Studio's Manage Dependencies left it before the merge; what it (and the
                // alignment after the rollback) wrote is said right here, with the undo, never "nothing was applied".
                var written = StudioWritesText(result);
                // Review A1 (D3): the command the kernel ran after the rollback, by its name.
                var ranAfter = aligned?["command"]?.ToString() ?? "Refresh References";
                return Fail("The Studio rolled the merge back (" + result["closedReason"] + "): the live module equals this task's base, sha256 "
                    + merge["liveSha256"] + ". " + (written.Length > 0 ? "Nothing was merged, the task is closed and the module is free. " + written
                        : "Nothing was applied, the task is closed and the module is free.")
                    + (changes.Count > 0 ? " Producer signatures the merge had to select: " + ReferenceClosure.Describe(changes) + "." : "")
                    + (merge["stage"] is { } failedStage ? " Failed at stage " + failedStage + "." : "")
                    + (merge["error"] is { } cause ? " Cause reported by the Studio: " + cause : "")
                    + string.Concat((merge["dialogs"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Where(OperationDialogPolicy.IsStudioError).Take(1)
                        .Select(d => " The Studio showed \"" + d["title"] + "\" (closed by the bridge): " + d["text"] + "."))
                    + (sameJob ? " The module now holds those signatures (the Studio's " + ranAfter + " of " + producerNames + " ran now, after the rollback"
                            + (ranAfter == ManageDependenciesCommand ? "" : "; Ctrl+Z undoes it") + "): "
                            + "deliver the same job again as a new delivery; its merge selects no producer signature."
                        : alignment != null ? AlignmentText(alignment, producerNames, aligned?["reason"]?.ToString())
                            + (onlyModules ? " Or deliver it with " + producerNames + " as OML (producers: {<name>: <capture OML>}), so the candidate carries the signature the module has." : "")
                        : " Deliver the corrected job as a new delivery."));
            }
            // Review finding 2: the Studio's Refresh References of the producers a rolled-back merge had to select, then the
            // module's references read again: aligned when each one is now at the candidate's signature.
            JsonObject AlignAfterRollback(JsonArray changes)
            {
                var report = new JsonObject { ["aligned"] = false };
                result["afterRollback"] = report;
                if (!Offers(bridge, RefreshReferencesCapability)) { report["reason"] = "this bridge has no refresh_references"; return report; }
                var names = new JsonArray(); var keys = new JsonArray();
                foreach (var change in changes.OfType<JsonObject>())
                {
                    if (change["key"]?.ToString() is { Length: > 0 } producerKey) keys.Add(producerKey);
                    if (change["producer"]?.ToString() is { Length: > 0 } producerName && producerName != change["key"]?.ToString()) names.Add(producerName);
                }
                try
                {
                    stage = "refresh-references";
                    // fix-ext-refs: the Studio's own Manage Dependencies when the bridge runs it (the elements the job names, each
                    // producer brought to its published signature); the Refresh References alone keeps a reference that only
                    // lacks new elements where it is ("up to date"), so it can never align such a producer.
                    var parameters = new JsonObject { ["producers"] = names, ["producer_keys"] = keys, ["timeout"] = 600 };
                    var manage = Offers(bridge, ManageDependenciesCapability);
                    var command = manage ? ManageDependenciesCommand : "Refresh References";
                    report["command"] = command;
                    if (manage)
                    {
                        parameters["add"] = Alignment(changes, referenceOps, result["capturedProducers"] as JsonObject,
                            result["merge"]?["referenceSignatures"] ?? result["signaturePreview"]?["plan"], true)["add"]!.DeepClone();
                        parameters["published"] = true;
                    }
                    var refreshed = CallStudioWrite(bridge, result, "after-rollback", Target(parameters), request.Module);
                    report["refresh"] = refreshed.DeepClone();
                    // Review A1: what this Manage Dependencies wrote after the rollback is declared like the one before the merge.
                    if (manage) { result["referencesAddedAfterRollback"] = DeclareReferencesAdded(refreshed, null, request.Module, "after-rollback"); LinkDetail(result, "referencesAddedAfterRollback"); }
                    if (refreshed["blocked"]?.GetValue<bool>() == true)
                    {
                        report["reason"] = "the " + command + " waits for the person in the Studio: " + refreshed["blockedBy"]?["question"];
                        return report;
                    }
                    if (refreshed["committed"]?.GetValue<bool>() == false && refreshed["problems"] is JsonArray { Count: > 0 } refusedNow)
                    {
                        report["problems"] = refusedNow.DeepClone();
                        report["reason"] = "the Studio's Manage Dependencies refused: " + string.Join(" ", refusedNow.OfType<JsonObject>().Select(p => p["message"] + " Fix: " + p["fix"]));
                        return report;
                    }
                    // Review B1: a Manage Dependencies that failed inside the Studio (its command rolled back) is named with its cause.
                    if (manage && refreshed["committed"]?.GetValue<bool>() == false)
                    {
                        report["reason"] = "the Studio's Manage Dependencies failed inside the Studio (" + (refreshed["error"]?.ToString() ?? "no cause reported") + ") and its command rolled back";
                        return report;
                    }
                    var livePath = Path.Combine(attemptDirectory, "refreshed-" + Guid.NewGuid().ToString("N") + ".oml");
                    var live = bridge.Call("snapshot_module", Target(new() { ["path"] = livePath }));
                    if (live["key"]?.ToString() != key) { report["reason"] = "another module answered the capture after the refresh"; return report; }
                    if (ReadReferences(livePath, "afterRollback") is not { } references)
                    {
                        report["reason"] = "the module's references could not be read after the refresh";
                        return report;
                    }
                    var each = new JsonArray(); var all = true;
                    foreach (var change in changes.OfType<JsonObject>())
                    {
                        var producerKey = change["key"]?.ToString() ?? "";
                        var now = references.FirstOrDefault(r => r.ProducerKey.Length > 0 && SameProducerKey(r.ProducerKey, producerKey));
                        var at = now != null && ReferenceClosure.SameHash(now.Hash, change["candidateHash"]?.ToString());
                        all &= at;
                        each.Add(new JsonObject { ["producer"] = change["producer"]?.DeepClone(), ["key"] = producerKey, ["liveHash"] = now?.Hash,
                            ["candidateHash"] = change["candidateHash"]?.DeepClone(), ["aligned"] = at });
                    }
                    report["references"] = each; report["aligned"] = all;
                    if (!all)
                        report["reason"] = "the Studio's " + command + " did not bring " + string.Join(", ", each.OfType<JsonObject>().Where(e => e["aligned"]?.GetValue<bool>() != true)
                            .Select(e => e["producer"] + " (now " + (e["liveHash"]?.ToString() ?? "absent") + ", candidate " + e["candidateHash"] + ")")) + " to the candidate's signature";
                }
                catch (Exception ex) when (ex is not OutOfMemoryException and not BridgeCallException { Stall: not null }) { report["reason"] = Errors.Text(ex); }
                task.Save(stage);
                return report;
            }
            // Review finding 2: one classification of the producers a delivery may move, for the candidate check, the proof after
            // the merge and the rollback answer: the captured producers except the owners R5 kept, and the bound signatures.
            List<string> DeliveryProducerKeys()
                => (result["capturedProducers"] as JsonObject ?? new JsonObject()).Where(p => !keptOwners.Contains(p.Key, StringComparer.OrdinalIgnoreCase))
                    .Select(p => p.Value?["key"]?.ToString()).Concat(BoundSignatureKeys(request))
                    .Where(k => !string.IsNullOrWhiteSpace(k)).Select(k => k!).Distinct(StringComparer.Ordinal).ToList();
            // Review finding 1: the Studio reported an error (its "Unexpected Error", or an error box with only OK) while the merge
            // ran and the bridge closed it. The Studio rolled back the command that raised it and swallowed the exception, so the
            // merge's own word (merged, or a plain "not applied") is not trusted: the module is captured now and compared with
            // this task's base in the same call. Equal: rolled back, the task closes with this code, the stage and the dialog's
            // text. Different: the merge stays for review (one failure, verification still runs). Not provable: unknown, never
            // repeated; resume proves it. Null when no error was reported (or after the proof, for an applied module).
            JsonObject? StudioErrorDuringMerge()
            {
                var reports = (result["merge"]?["dialogs"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Where(OperationDialogPolicy.IsStudioError).ToList();
                // A rollback the bridge already proved is answered by RolledBack, which names the dialog too.
                if (reports.Count == 0 || result["merge"]?["rolledBack"]?.GetValue<bool>() == true) return null;
                var first = reports[0];
                var text = first["text"]?.ToString() ?? "";
                var said = "The Studio reported an error while the merge ran (\"" + (first["title"]?.ToString() is { Length: > 0 } title ? title : first["kind"]?.ToString()) + "\""
                    + (text.Length > 0 ? ": " + (text.Length > 400 ? text[..400] + "..." : text) : "") + "), closed by the bridge";
                string Kept() => "Merge kept for review: " + said + ", and the module differs from this task's base, so the merge's own result is not trusted. "
                    + "Ctrl+Z in the Studio undoes it; nothing was published.";
                if (result["studioError"]?["proof"]?.ToString() == "changed")
                {
                    if (!failures.Any(f => f.Stage == "studio-error")) failures.Add(("studio-error", Kept()));
                    result["code"] ??= StudioErrorDuringMergeCode;
                    return null;
                }
                stage = "studio-error";
                result["code"] = StudioErrorDuringMergeCode;
                var failedStage = result["merge"]?["stage"]?.ToString() ?? "merge";
                var studioError = new JsonObject { ["stage"] = failedStage, ["kind"] = first["kind"]?.DeepClone(), ["title"] = first["title"]?.DeepClone(),
                    ["text"] = first["text"]?.DeepClone(), ["count"] = reports.Count, ["mergeSaid"] = result["writeState"]?.DeepClone(),
                    ["mergeResult"] = result["merge"]?["result"]?.DeepClone() };
                result["studioError"] = studioError;
                var baseSha = RollbackProof.BaseSha256(result);
                string? liveSha = null;
                try
                {
                    var livePath = Path.Combine(attemptDirectory, "studio-error-" + Guid.NewGuid().ToString("N") + ".oml");
                    var live = bridge.Call("snapshot_module", Target(new() { ["path"] = livePath }));
                    if (live["key"]?.ToString() != key) throw new InvalidOperationException("another module answered the capture");
                    liveSha = live["sha256"]?.ToString() ?? (File.Exists(livePath) ? DeliveryReceipt.Hash(livePath) : null);
                    studioError["live"] = livePath;
                }
                catch (Exception ex) when (ex is not OutOfMemoryException and not BridgeCallException { Stall: not null }) { studioError["proofError"] = Errors.Text(ex); }
                studioError["liveSha256"] = liveSha; studioError["baseSha256"] = baseSha;
                if (string.IsNullOrWhiteSpace(liveSha) || string.IsNullOrWhiteSpace(baseSha))
                {
                    result["writeState"] = "unknown"; task.Save(stage);
                    return Fail(said + ". Whether the module changed could not be proven (" + (studioError["proofError"]?.ToString() ?? "no hash of the base") + "): "
                        + "the outcome is unknown and " + DeliveryTask.NotRepeated(sentAfterSettlement) + "; resume proves it against the base.");
                }
                if (RollbackProof.SameSha256(liveSha, baseSha))
                {
                    studioError["proof"] = "rolled-back";
                    result["writeState"] = "not-applied"; result["closed"] = true;
                    result["closedReason"] = "the Studio reported an error and rolled the merge back";
                    task.Save(stage);
                    return Fail(said + ". The live module equals this task's base (sha256 " + liveSha + "): the Studio rolled the merge back. Nothing was applied, "
                        + "the task is closed and the module is free. Failed at stage " + failedStage + ". The Studio's text above is the cause "
                        + "(an SSAM defect when the job is valid); deliver the job again as a new delivery.");
                }
                studioError["proof"] = "changed";
                result["writeState"] = "applied"; result["hasAppliedWrites"] = true;
                task.Save(stage);
                failures.Add(("studio-error", Kept()));
                return null;
            }
        }
        catch (Exception ex)
        {
            if (result["writeState"]?.ToString() == "intent") result["writeState"] = ex is BridgeCallException { Executed: false } ? "not-sent" : "unknown";
            if (ex is BridgeCallException { Stall: not null } stopped) RecordStall(stopped);
            // A coded kernel refusal raised inside the apply (the base check's PREFLIGHT_REFUSED with every problem, I2;
            // SIGNATURE_CHANGE_BREAKS_CONSUMERS, ...) keeps its code and problems in the task result, as the CLI envelope does.
            // prazos B: a read of the environment the Studio's own client cut (ENVIRONMENT_CALL_CUT) names what was cut in
            // cut {what, stage, producer, host, operation, cause, afterSeconds, elapsedSeconds, cutBy, writeState}; a job the
            // preflight already refused keeps that refusal as the answer (A3), with the cut as the reason the rest did not run.
            var environmentCut = EnvironmentCut.Find(ex);
            // servidor/fase4-24: an environment read of this delivery that still failed on the network after the kernel's
            // single retry (ENVIRONMENT_UNREACHABLE, outside the producer capture) is the same cut while nothing was written
            // yet, so a delivery answers one code (ENVIRONMENT_CALL_CUT) for one failure. After a write it keeps its own code.
            var unreachableOnly = environmentCut == null && result["writeState"]?.ToString() is null or "not-sent"
                && EnvironmentCut.FindUnreachable(ex) is { } unreachable ? EnvironmentCut.FromUnreachable(unreachable, "an environment read of the delivery") : null;
            environmentCut ??= unreachableOnly;
            if (environmentCut != null) result["cut"] = environmentCut.Cut(stage);
            if ((unreachableOnly ?? Errors.FindCoded(ex)) is { } coded && result["code"] == null && !(environmentCut != null && pure != null))
            {
                result["code"] = coded.Code;
                if (coded.Problems is { } problems) result["problems"] = problems.DeepClone();
            }
            // primeira-certa A2/A7: whether the Verify ran, the phases and, for a refusal of one phase, its problems.
            if (Errors.Diagnosis(ex) is { } diagnosis && result["apply"] == null)
                foreach (var (key, value) in diagnosis)
                    if (key != "problems" || result["problems"] == null) result[key] = value?.DeepClone();
            // lentidao 2026-10-12: what the kernel rewrote instead of refusing comes with the refusal of what stayed.
            if (Errors.Normalizations(ex) is { } normalizations && result["apply"] == null) result["normalizations"] = normalizations;
            return Fail(Errors.Text(ex));
        }
        finally
        {
            result["elapsedMs"] = clock.ElapsedMilliseconds;
            CloseOpenedTab();
            ReleaseCapture();
            DeliveryTask.FinishSettledNotes(result, sentAfterSettlement);
            try
            {
                task.Save(stage);
                if (result["delivered"]?.GetValue<bool>() == true || (result["pendingBridgeOperation"] == null && result["writeState"]?.ToString() is "not-sent" or "not-applied")) reservation?.Release();
            }
            finally { reservation?.Dispose(); }
        }
        // A03, I9: the warnings that block nothing, each {id, path, key?, detail, fix}: from the live verdicts when the live
        // contract ran (live), else from the apply's verdicts. The whole list stays in the task result (result.json); the
        // answers cap it.
        void RecordStall(BridgeCallException stopped)
        {
            // CX14 R2: the receipt keeps no typed text, whichever client built the stall.
            var stall = BridgeStallRule.Clean(stopped.Stall!);
            result["stalled"] = stall.DeepClone();
            if (stopped.Executed == false)
            {
                // CX14 R1: the pre-probe refused this call before sending it. That names the task's refusal only while the
                // task's own write was never sent; an intent, unknown or applied write keeps its code and its outcome.
                if (result["writeState"]?.ToString() == "not-sent") result["code"] ??= "STUDIO_ERROR_DIALOG_OPEN";
                return;
            }
            var method = stall["method"]?.ToString();
            // CX14 R4: the pending operation keeps its own evidence (pendingBridgeOperation.stall: which Studio ran it, what
            // stopped it). `stalled` is the stop of the latest call, what blocks the Studio now. A later stop of another
            // call (the resume's open_module) is recorded there and never replaces the pending operation or its journal.
            if (method is "merge_from_oml" or "refresh_references" or "open_module" or "close_module" && result["pendingBridgeOperation"] == null)
            {
                var pending = new JsonObject { ["method"] = method, ["moduleKey"] = result["moduleKey"]?.DeepClone() };
                // Review round 3 (L7): which Studio command the stopped refresh_references was (its note names it).
                if (method == "refresh_references" && PendingStudioCommand(result) is { } stoppedCommand) pending["command"] = stoppedCommand;
                if (method == "merge_from_oml") pending["operationId"] = result["operationId"]?.DeepClone();
                pending["stall"] = stall.DeepClone();
                result["pendingBridgeOperation"] = pending;
            }
            // CX14 N3: a UI write sent beside an operation already pending (the resume's open_module or its refresh, while
            // the merge's journal is unknown) may still run too: it is fenced beside it (after), never replacing it.
            else if (method is "refresh_references" or "open_module" or "close_module" && result["pendingBridgeOperation"] is JsonObject existing)
            {
                if (existing["after"] is not JsonArray after) existing["after"] = after = new JsonArray();
                var next = new JsonObject { ["method"] = method, ["moduleKey"] = result["moduleKey"]?.DeepClone(), ["stall"] = stall.DeepClone() };
                if (method == "refresh_references" && PendingStudioCommand(result) is { } stoppedCommand) next["command"] = stoppedCommand;
                after.Add(next);
            }
        }
        void RecordWarnings(JsonArray? live)
        {
            var source = live ?? result["apply"]?["validation"]?["verdicts"] as JsonArray ?? new JsonArray();
            hints ??= VerifyHints.TryRead();
            var warnings = VerifyHints.Warnings(source, hints);
            // The HIGH warnings of the data-access rules (QUERY_IN_LOOP legacy/allowed, AGGREGATES_MERGEABLE) come first, and
            // also on their own (highWarnings) so a compacted answer still shows them; they never block (A03).
            var high = QueryInLoopRule.HighWarnings(result["apply"]?["highWarnings"] as JsonArray);
            foreach (var warning in QueryInLoopRule.HighWarnings(ProducerHashWarnings.OfCaptures(result["capturedProducers"] as JsonObject)))
                high.Add(warning?.DeepClone());
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
            if (result["pendingBridgeOperation"] != null || result["writeState"]?.ToString() is not ("not-sent" or "not-applied" or "applied" or "unchanged"))
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
            catch (Exception ex)
            {
                // CX14 R1: a tab close the pre-probe refused was never sent: a fact of the tab only (closedTab), never the
                // task's code or stall. A close that was sent and then stopped may still run in the Studio: it is fenced.
                if (ex is BridgeCallException { Stall: not null, Executed: not false } stopped) RecordStall(stopped);
                result["closedTab"] = new JsonObject { ["closed"] = false, ["reason"] = Errors.Text(ex) };
            }
        }
        // A resident worker (hosted: one per customer) runs many deliveries in one process. What the bridge client keeps
        // loaded for this one (the thin bridge's capture of the checks, find_element) is released when it ends, after the
        // last bridge call, as the exit of a cold process frees it. Never throws: the delivery's answer stands.
        void ReleaseCapture()
        {
            try { bridge.ReleaseCapture(); }
            catch (Exception ex) { log?.Invoke("deliver: the bridge client's capture was not released: " + Errors.Text(ex)); }
        }
        void RecordMerge(JsonObject merge)
        {
            result["merge"] = merge;
            if (merge["merged"]?.GetValue<bool>() == true) result["hasAppliedWrites"] = true;
            var unchanged = merge["reason"]?.ToString() == "no differences";
            result["unchanged"] = unchanged;
            result["writeState"] = merge["merged"]?.GetValue<bool>() == true ? "applied" : unchanged ? "unchanged"
                : merge["merged"]?.GetValue<bool>() == false ? "not-applied" : "unknown";
            // fam-deps: a settled merge no longer waits for any dialog.
            if (result["writeState"]!.ToString() != "unknown")
            {
                result.Remove("blockedBy"); result.Remove("question");
                // CX14 N3: a UI call that stopped beside the merge is not settled by the merge's journal: it stays pending
                // (without a journal) with its own stop, so resume and close still require idle for it.
                if (result["pendingBridgeOperation"]?["after"] is JsonArray { Count: > 0 } after)
                {
                    var next = after[0]!.DeepClone().AsObject();
                    if (after.Count > 1) next["after"] = new JsonArray(after.Skip(1).Select(a => a!.DeepClone()).ToArray());
                    result["pendingBridgeOperation"] = next; result["stalled"] = next["stall"]?.DeepClone();
                }
                else { result.Remove("stalled"); result.Remove("pendingBridgeOperation"); }
            }
            task.Save("merge-recorded");
        }
        JsonObject Fail(string message)
        {
            // primeira-certa A3: a job the preflight refused, stopped before the apply over the capture could refuse it with
            // every phase (no capture, the module not open, a producer, a bridge failure): the preflight's own refusal, with
            // the reason the rest did not run. The task keeps no sources, so the same task id validates again on resume.
            if (pure != null && result["code"] == null && result["problems"] == null)
            {
                result.Remove("sources");
                result["code"] = PreflightRefused;
                result["problems"] = PreflightProblems(pure);
                result["verifyRan"] = false;
                result["verifyReason"] = "the delivery stopped before the apply over the live module (" + message + "): only the job was read, so the base check, the apply and the Verify did not run";
                result["phases"] = new JsonArray("preflight");
                stage = "preflight";
                message = "Job refused by the preflight; nothing was merged. "
                    + string.Join(" ", (pure["errors"] as JsonArray ?? new JsonArray()).Select(e => e?.ToString()).Where(e => !string.IsNullOrWhiteSpace(e)));
            }
            // Review A1: every refusal or failure after the Studio's Manage Dependencies wrote the module declares that write
            // with its undo and never says that nothing was applied (whatever stage or exception raised it).
            message = DeclareStudioWrites(result, message);
            result["error"] = message; return result;
        }
    }
    /// <summary>Explicit bindings plus the producers this task captures. Each producer is captured (read-only) into the
    /// task folder and recorded, path + SHA-256, among the task sources and in capturedProducers, and the task is saved
    /// right after each capture. A resume reuses exactly the recorded files (whose hashes the source check has already
    /// confirmed) and captures only the producers still missing, e.g. after a later capture failed: a completed capture
    /// is never repeated for the same task, and every recorded one is re-attested before apply and before merge.</summary>
    private static IReadOnlyDictionary<string, string> CaptureProducers(DeliveryTask task, DeliveryRequest request, JsonArray sources,
        string? environment, IProducerSignatureAuthority? authority, Action<string>? log, string? moduleKey = null, SignatureObservations? signatures = null)
    {
        signatures ??= new SignatureObservations(ProducerLedger.ForWork(request.WorkDirectory), ProducerCache.ForWork(request.WorkDirectory));
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
        var announced = false;
        foreach (var (name, producerName) in targets)
        {
            if (captured[name] is JsonObject recorded)
            {
                if (!string.Equals(recorded["producer"]?.ToString(), producerName, StringComparison.Ordinal))
                    throw new InvalidOperationException("Task captured another producer for binding " + name + ": " + recorded["producer"]);
                ProducerHashWarnings.Record(state);
                continue;
            }
            if (authority == null) throw new InvalidOperationException("--capture-producer requires the read-only Studio producer authority");
            // prazos B: the task shows the stage it waits in while the Studio reads the environment (ssam_task read
            // "validate-job" for 107 s on 2026-10-12 while these reads hung on the PC's network).
            if (!announced) { announced = true; task.Save("producer-signatures"); }
            var destination = Path.Combine(task.DirectoryPath, "producers", name + ".avsig");
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            // Nothing consumed a file that is not recorded in capturedProducers (every capture precedes the apply): a
            // leftover of an interrupted attempt, or a source entry an earlier revision recorded before failing on a later
            // producer, is replaced instead of being checked as a frozen source forever.
            RemoveSource(destination);
            if (File.Exists(destination)) File.Delete(destination);
            var elements = ProducerSignatures.ReferencedElements(request.JobPath, name);
            // C27 + F5: the capture of the same producer is reused while its published state did not change (the ledger saw
            // it lately, else the server re-attests it here); a republished producer is captured again.
            var producerAuthority = authority;
            var acquired = Acquire(signatures, producerAuthority, environment, producerName, elements, destination, log,
                (producer, wanted, file) => producerAuthority.Capture(producer, wanted, file, environment));
            var sha = DeliveryReceipt.Hash(destination);
            sources.Add(new JsonObject { ["path"] = destination, ["sha256"] = sha });
            captured[name] = CapturedEntry(producerName, destination, sha, environment, acquired.Receipt);
            if (acquired.Reused) captured[name]!["reusedFromCache"] = true;
            captured[name]!["observed"] = acquired.Observed.DeepClone();
            ProducerHashWarnings.Record(state);
            task.Save("capture-producer:" + name);
            log?.Invoke($"deliver: {(acquired.Reused ? "reused the cached capture of" : "captured")} producer {name} sha256={sha} signatureHash={acquired.Receipt["signatureHash"]} version={acquired.Receipt["versionIdBefore"]} observed={acquired.Observed["by"]}");
        }
        var owners = CaptureOwners(task, request, sources, environment!, authority, moduleKey, log, signatures);
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

    /// <summary>The part of the apply's validation contract that refused a candidate, with its counts (VisitaCerta 2026-10-12:
    /// the refusal said only "job rejected by validation contract"): the Verify (its errors by code, when the module is not as
    /// the job expects it), the messages no expectedMessages entry covers, the data contract.</summary>
    public static string ValidationVerdict(JsonObject applied)
    {
        static bool? Flag(JsonNode? node) => node is JsonValue value && value.TryGetValue<bool>(out var flag) ? flag : null;
        var parts = new List<string>();
        var expectedValid = Flag(applied["expectedValid"]) ?? true;
        if (Flag(applied["isValid"]) is { } valid && valid != expectedValid)
        {
            var errors = (applied["problems"] as JsonArray ?? []).OfType<JsonObject>()
                .Where(p => p["phase"]?.ToString() == "verify" && p["severity"]?.ToString() != "warning").Select(p => p["code"]?.ToString() ?? "unknown").ToList();
            List<string> ErrorsOf(string list) => (applied["validation"]?[list] as JsonArray ?? []).OfType<JsonObject>()
                .Where(m => string.Equals(m["type"]?.ToString(), "Error", StringComparison.OrdinalIgnoreCase)).Select(m => m["id"]?.ToString() ?? "unknown").ToList();
            static string Counts(List<string> codes) => string.Join(", ", codes.GroupBy(c => c).Select(g => g.Key + " " + g.Count()));
            if (errors.Count == 0) errors = ErrorsOf("new");
            // Re-check of 2026-10-12 (probe K1): invalid only by errors the module already had, the job added none.
            var had = expectedValid && errors.Count == 0 ? ErrorsOf("preexisting") : new List<string>();
            parts.Add(!expectedValid ? "the Verify found the module valid and the job expects it invalid"
                : had.Count > 0 ? "the module already had " + had.Count + " error" + (had.Count == 1 ? "" : "s") + " (" + Counts(had) + "), the job added none"
                : "the Verify of the candidate: " + errors.Count + " error" + (errors.Count == 1 ? "" : "s") + (errors.Count == 0 ? "" : " (" + Counts(errors) + ")"));
        }
        var unexpected = (applied["validation"]?["unexpected"] as JsonArray)?.Count ?? 0;
        if (unexpected > 0) parts.Add(unexpected + " message" + (unexpected == 1 ? "" : "s") + " no expectedMessages entry covers");
        if (Flag(applied["dataContract"]?["accepted"]) == false) parts.Add("the data contract");
        // JobRunner: the references a refactor relies on, compared after the save and a reload.
        if (Flag(applied["refactorProof"]?["accepted"]) == false) parts.Add("the refactor proof (reference sets changed after save/reload)");
        return parts.Count == 0 ? "the candidate was not accepted" : string.Join("; ", parts);
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
        ["hashUnverified"] = receipt["hashUnverified"]?.DeepClone(),
        ["elements"] = receipt["elements"]?.DeepClone(), ["closure"] = receipt["closure"]?.DeepClone(),
        ["highWarnings"] = ProducerHashWarnings.OfReceipt(producer, receipt),
        ["foreignDependencies"] = receipt["foreignDependencies"]?.DeepClone(), ["capturedAtUtc"] = DateTime.UtcNow.ToString("O") };

    /// <summary>F5: refused by the server observation of a producer whose published state changed since its capture.</summary>
    public const string ProducerChangedCode = "PRODUCER_CHANGED";
    private static bool ProducerChanged(Exception error)
    {
        var text = Errors.Text(error);
        return text.Contains("VersionIdChanged", StringComparison.Ordinal) || text.Contains("SignatureHashChanged", StringComparison.Ordinal);
    }

    /// <summary>The producerAttestation entry of an envelope this call did not observe on the server again: its identity, how
    /// it counts as observed (capture or server in this call, ledger for an earlier one) and when.</summary>
    private static JsonObject AttestedLocally(string path, ProducerIdentity? identity, string by, DateTime atUtc) => new() {
        ["producer"] = identity?.Producer, ["environment"] = identity?.Environment, ["guard"] = identity?.Guard, ["versionId"] = identity?.VersionId,
        ["advertisedSignatureHash"] = identity?.AdvertisedSignatureHash, ["attested"] = true, ["by"] = by, ["observedAtUtc"] = atUtc.ToUniversalTime().ToString("O"),
        ["path"] = path, ["sha256"] = DeliveryReceipt.Hash(path) };

    private static JsonObject Observation(string by, DateTime atUtc) => new() { ["by"] = by, ["observedAtUtc"] = atUtc.ToUniversalTime().ToString("O") };

    /// <summary>One producer signature of a delivery: the receipt of its capture, whether it came from the cache, and how its
    /// identity was observed ({by: ledger|server|capture, observedAtUtc}).</summary>
    private sealed record Acquired(JsonObject Receipt, bool Reused, JsonObject Observed);

    /// <summary>C27 + F5, the family rule of producer signatures, for a producer named by the job and for an owner of its
    /// foreign types alike: the cached capture that covers the job's elements (ProducerCache.FindCovering) is reused with no
    /// server call when the workspace ledger saw its published state lately and no publication since (ProducerLedger.Trust);
    /// otherwise the server re-attests it (one read-only lease) and the observation is recorded; a capture that no longer
    /// attests drops every cached capture of the producer and its observation, and the producer is captured again. A new
    /// capture is stored (dropping the captures it covers and those of another published state) and observed. Never another
    /// environment: the cache and the ledger are keyed by it.</summary>
    private static Acquired Acquire(SignatureObservations signatures, IProducerSignatureAuthority authority, string environment, string producer,
        IReadOnlyList<string> elements, string destination, Action<string>? log, Func<string, IReadOnlyList<string>, string, JsonObject> capture)
    {
        var cache = signatures.Cache;
        if (cache?.FindCovering(environment, producer, elements) is { } cached)
        {
            var identity = ProducerIdentity.ReadEnvelope(cached.Path);
            var sameEnvironment = identity != null && string.Equals(identity.Environment, environment, StringComparison.OrdinalIgnoreCase);
            if (sameEnvironment && signatures.Ledger?.Trust(identity!, DateTime.UtcNow, out _) is { } trust)
            {
                File.Copy(cached.Path, destination, overwrite: true);
                return new Acquired(cached.Receipt, true, Observation("ledger", trust.ObservedAtUtc));
            }
            try
            {
                var observed = authority.Attest(cached.Path, environment);
                if (observed["attested"]?.GetValue<bool>() != false)
                {
                    File.Copy(cached.Path, destination, overwrite: true);
                    var at = DateTime.UtcNow;
                    if (identity != null) signatures.Ledger?.Observe(ProducerIdentity.OfAttestation(observed, environment, identity.Key) ?? identity, "attest", at);
                    signatures.Saw(destination, "server", at);
                    return new Acquired(cached.Receipt, true, Observation("server", at));
                }
            }
            // prazos B: a cut read (ENVIRONMENT_CALL_CUT) says nothing about the cached capture: it propagates, typed, and the
            // cache and the ledger stay.
            catch (Exception ex) when (ex is not OutOfMemoryException and not EnvironmentCallCutException)
            {
                log?.Invoke($"deliver: cached capture of {producer} no longer attests ({Errors.Text(ex)}); capturing it again");
                cache.RemoveProducer(environment, producer);
                if (identity != null) signatures.Changed(identity);
            }
        }
        var receipt = capture(producer, elements, destination);
        try { cache?.Store(environment, producer, elements, destination, receipt); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { log?.Invoke("deliver: producer cache not written: " + ex.Message); }
        var now = DateTime.UtcNow;
        if (ProducerIdentity.OfReceipt(receipt, environment) is { } fresh) signatures.Ledger?.Observe(fresh, "capture", now);
        signatures.Saw(destination, "capture", now);
        return new Acquired(receipt, false, Observation("capture", now));
    }

    /// <summary>K1-b (atritos 3): the producers that own the foreign types of the captured signatures (an entity attribute of
    /// one producer typed with another producer's identifier) are captured too, by key, read-only, in the same
    /// producer-signatures stage and before any write. The import links their signatures into the same native refresh
    /// (ReferenceRefresher), so the job never binds them by hand. Each one is recorded under its own binding (the producer
    /// name as an identifier: (System) is System) with reason foreign-owner-of:&lt;producer&gt; and its owner key; an owner's own
    /// owners follow. A producer the task already captures or binds is never captured again; a resume reuses the recorded
    /// owners. An owner that cannot be captured refuses the delivery as PRODUCER_SIGNATURE_MISSING, cause foreign, naming it.
    /// Returns the bindings of the owners.</summary>
    private static IReadOnlyList<string> CaptureOwners(DeliveryTask task, DeliveryRequest request, JsonArray sources, string environment,
        IProducerSignatureAuthority? authority, string? moduleKey, Action<string>? log, SignatureObservations? signatures = null)
    {
        signatures ??= new SignatureObservations(ProducerLedger.ForWork(request.WorkDirectory), ProducerCache.ForWork(request.WorkDirectory));
        var captured = (JsonObject)task.State["capturedProducers"]!;
        var known = captured.Select(p => p.Value?["key"]?.ToString()).Concat(BoundSignatureKeys(request)).Append(moduleKey)
            .Where(k => !string.IsNullOrWhiteSpace(k)).Select(k => k!).ToList();
        bool Known(string key) => known.Any(k => SameKey(k, key));
        var problems = new List<JsonObject>(); string? refusedFor = null;
        var queue = new Queue<string>(captured.Select(p => p.Key)); var scanned = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var owners = captured.Where(p => p.Value?["ownerKey"] != null).Select(p => p.Key).ToList();
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
                Acquired? acquired = null;
                try
                {
                    if (authority == null) throw new InvalidOperationException("no read-only producer authority captures it");
                    Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                    RemoveRecordedSource(sources, destination);
                    if (File.Exists(destination)) File.Delete(destination);
                    // C27 + F5: an owner's capture is reused by the same rule as a producer's (cached under "@<key>").
                    var ownerAuthority = authority;
                    acquired = Acquire(signatures, ownerAuthority, environment, "@" + owner, elements, destination, log,
                        (_, wanted, file) => ownerAuthority.CaptureByKey(owner, wanted, file, environment));
                }
                // prazos B: a cut read is not a missing owner (PRODUCER_SIGNATURE_MISSING would send the model to the job); it
                // propagates as ENVIRONMENT_CALL_CUT.
                catch (Exception ex) when (ex is not OutOfMemoryException and not EnvironmentCallCutException)
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
                var receipt = acquired!.Receipt;
                var name = receipt["producer"]?.ToString() is { Length: > 0 } producerName ? producerName : owner;
                var binding = UniqueBinding(name, captured, request);
                var sha = DeliveryReceipt.Hash(destination);
                sources.Add(new JsonObject { ["path"] = destination, ["sha256"] = sha });
                var entry = CapturedEntry(name, destination, sha, environment, receipt);
                entry["reason"] = "foreign-owner-of:" + dependentName; entry["ownerKey"] = owner;
                if (acquired.Reused) entry["reusedFromCache"] = true;
                entry["observed"] = acquired.Observed.DeepClone();
                captured[binding] = entry;
                known.Add(owner);
                if (receipt["key"]?.ToString() is { Length: > 0 } capturedKey) known.Add(capturedKey);
                owners.Add(binding); queue.Enqueue(binding);
                ProducerHashWarnings.Record(task.State);
                task.Save("capture-producer:" + binding);
                log?.Invoke($"deliver: {(acquired.Reused ? "reused the cached capture of" : "captured")} {name}, owner of foreign types of {dependentName}, as {binding} sha256={sha} observed={acquired.Observed["by"]}");
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

    /// <summary>fam-deps (family D): a dialog the Studio opened during the merge needs the person; the merge waits for it in the
    /// Studio and the answer carries the dialog (blockedBy) and the one question.</summary>
    public const string StudioDialogPending = "STUDIO_DIALOG_PENDING";
    /// <summary>fam-deps review (finding 1): the Studio reported an error (its "Unexpected Error", closed by the bridge) while
    /// the merge ran. The Studio rolled back the command that raised it and swallowed the exception, so the merge's own result
    /// is not trusted: the kernel proves the module against the base in the same call and answers with this code, the stage
    /// and the dialog's text (studioError), never delivered on the merge's word alone.</summary>
    public const string StudioErrorDuringMergeCode = "STUDIO_ERROR_DURING_MERGE";
    /// <summary>The kind of an answered dependencies dialog in referencesRefreshed (Anvil.Bridge DialogScope.DependenciesKind).</summary>
    private const string DependenciesKindAnswered = "DependenciesDialog";

    /// <summary>The O11 reference reader (Adapters.SS11/ReferenceInventory.cs), found by name like the signature preview:
    /// Anvil.Core.Odc has none, and there the reference closure does not run.</summary>
    private static readonly Func<string, string, JsonArray>? DefaultReferenceInventory =
        typeof(Delivery).Assembly.GetType("Anvil.Core.Delivery.ReferenceInventory")?.GetMethod("Read", [typeof(string), typeof(string)]) is { } readReferences
            ? readReferences.CreateDelegate<Func<string, string, JsonArray>>() : null;

    /// <summary>R3: the tests of the closure's cache let an injected reader be cached like the lane's own.</summary>
    internal static readonly AsyncLocal<bool> CacheInjectedReferenceReads = new();

    /// <summary>An OML file starts with "OML" (its textual header); anything else is never loaded as a model here.</summary>
    private static bool LooksLikeOml(string path)
    {
        try
        {
            using var stream = File.OpenRead(path);
            Span<byte> head = stackalloc byte[3];
            return stream.Read(head) == 3 && head[0] == (byte)'O' && head[1] == (byte)'M' && head[2] == (byte)'L';
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return false; }
    }

    /// <summary>Two producer keys name the same producer (ordinal, then by the Studio's key form).</summary>
    internal static bool SameProducerKey(string left, string right)
    {
        if (string.Equals(left, right, StringComparison.Ordinal)) return true;
        if (string.IsNullOrWhiteSpace(left) || string.IsNullOrWhiteSpace(right)) return false;
        try { return ParsedKeysEqual(left, right); } catch (Exception ex) when (ex is FormatException or ArgumentException or FileNotFoundException or FileLoadException or TypeLoadException) { return false; }
    }
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static bool ParsedKeysEqual(string left, string right) => Keys.Parse(left).Equals(Keys.Parse(right));

    /// <summary>The bound .avsig signatures of the request by binding: (producer key, signature hash); read only when there are any.</summary>
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static IReadOnlyDictionary<string, (string Key, string? Hash)> BoundSignatures(DeliveryRequest request)
    {
        var bound = new Dictionary<string, (string Key, string? Hash)>(StringComparer.OrdinalIgnoreCase);
        foreach (var (binding, file) in request.Producers ?? new Dictionary<string, string>())
        {
            if (!Path.GetExtension(file).Equals(".avsig", StringComparison.OrdinalIgnoreCase)) continue;
            try { var snapshot = NativeReferenceSnapshot.Read(file); bound[binding] = (snapshot.ModuleKey, snapshot.SignatureHash.ToString()); }
            catch (Exception ex) when (ex is IOException or ArgumentException or JsonException or FormatException or UnauthorizedAccessException) { }
        }
        return bound;
    }

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
    /// <summary>list_open_modules {model_sha256_of} answers the model fingerprint of the open tab (Anvil.Bridge Reads.OpenModules):
    /// rule (a) of the merge proof compares it with the delivery's base.</summary>
    public const string OpenModelFingerprintCapability = "list_open_modules:model_sha256";
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
    /// <summary>Finding 4: the content-proof differences no known loss explains, and whether a proof ran and every difference
    /// matched. Each difference is told by its element (the proof's readable path, by name; MergeContentProof never names a
    /// local key), never by a count:
    /// <list type="bullet">
    /// <item>a lost default: the element of a lost entry, and that default gone (the DefaultValue expression absent from the
    /// delivered module, or api:DefaultValue emptied); a default with another value is no loss;</item>
    /// <item>a forced Delete Rule: the element of a forced entry and its api:DeleteRule, from the requested rule to Ignore; and
    /// the index the Studio generates for that one attribute, absent with the rule (an attribute with Delete Rule Ignore has
    /// no foreign key index), named by the proof's own identity of that index.</item>
    /// </list></summary>
    internal static (int Unmatched, bool Matched) MatchKnownLosses(JsonNode? contentProof, JsonArray lost, JsonArray forced)
    {
        if (contentProof?["differences"] is not JsonArray differences) return (0, false);
        var lostElements = lost.OfType<JsonObject>().Select(l => l["element"]?.ToString()).OfType<string>().ToHashSet(StringComparer.Ordinal);
        var forcedRules = forced.OfType<JsonObject>().Where(f => f["element"] != null).ToLookup(f => f["element"]!.ToString(), StringComparer.Ordinal);
        static string? Last(JsonNode? value) => value?.ToString() is { } text ? text[(text.LastIndexOf(':') + 1)..] : null;
        static bool Gone(JsonObject d) => d["missing"]?.GetValue<bool>() == true;
        bool IsForced(JsonObject d, string? element) => element != null && d["property"]?.ToString() == "api:DeleteRule" && Last(d["actualValue"]) == "Ignore"
            && forcedRules[element].Any(f => Last(d["expectedValue"]) == f["requested"]?.ToString());
        // The generated index of each forced attribute, by identity: the attribute's address is its identity, its owner's the entity's.
        var forcedIndexes = differences.OfType<JsonObject>().Where(d => IsForced(d, MergeOrderElement(d["element"]?.ToString())))
            .Select(d => d["address"]?.ToString()).OfType<string>().Where(a => a.LastIndexOf('/') > 0)
            .Select(a => MergeContentProof.GeneratedIndexIdentity(a[..a.LastIndexOf('/')], [a])).ToHashSet(StringComparer.Ordinal);
        var unmatched = 0;
        foreach (var difference in differences.OfType<JsonObject>())
        {
            var element = MergeOrderElement(difference["element"]?.ToString());
            var address = difference["address"]?.ToString() ?? "";
            var lostDefault = element != null && lostElements.Contains(element)
                && (address.Contains("/IExpression[DefaultValue]", StringComparison.Ordinal) && Gone(difference)
                    || difference["property"]?.ToString() == "api:DefaultValue" && difference["actualValue"]?.ToString() is null or "null" or "expression:" or "text:");
            var forcedRule = IsForced(difference, element) || forcedIndexes.Contains(address) && Gone(difference);
            if (!lostDefault && !forcedRule) unmatched++;
        }
        return (unmatched, unmatched == 0);
    }

    /// <summary>The element of a content-proof difference as the merge order names it (MergeOrder's Element, the data proof's
    /// LostDefault): the names of its readable path ("Entity:Pet/EntityAttribute:SpeciesId/Expression" is Pet.SpeciesId),
    /// unnamed segments left out; null without a name.</summary>
    internal static string? MergeOrderElement(string? label)
    {
        if (string.IsNullOrEmpty(label)) return null;
        var names = label.Split('/').Select(s => s.IndexOf(':') is var at and > 0 && s[..at] != "module" ? s[(at + 1)..] : null).OfType<string>().Where(n => n.Length > 0).ToList();
        return names.Count == 0 ? null : string.Join(".", names);
    }

    private static string KnownLossesText(JsonArray lost, JsonArray forced, bool proven)
    {
        var missing = MergeOrder.FromJson(lost);
        var parts = new List<string>();
        if (missing.Count > 0) parts.Add("the native merge did not keep " + missing.Count + " default value(s): " + MergeOrder.Describe(missing));
        if (forced.Count > 0) parts.Add("the Studio set Delete Rule Ignore on " + string.Join(", ", forced.Select(f => f!["element"] + " (requested " + f["requested"] + ")")) + ", the only rule this environment allows there");
        return "Merge kept for review: " + string.Join("; ", parts) + (proven ? "; nothing else differs" : "") + "."
            + (missing.Count > 0 ? " Each element exists now, so a merge keeps a default set on it: deliver mergeOrder.repair as a new job " + RepairJob(lost).ToJsonString() + "." : "")
            + (forced.Count > 0 ? " Declare the rule in the job (mergeOrder.declare) so the next candidate equals the module " + DeclareJob(forced).ToJsonString() + "." : "");
    }
}

/// <summary>CX14 N6: counts the calls a delivery or a close sent to the bridge after it settled a stopped UI call (a refusal
/// before sending, executed false, is not sent), and keeps the entries it settled. The bounded probe reads of the inner
/// client stay bounded (CountingProbeBridge); they are reads and are not counted.</summary>
internal class CountingBridge(IBridgeClient inner) : IBridgeClient
{
    private readonly Dictionary<string, int> sent = new(StringComparer.Ordinal);
    public static CountingBridge Wrap(IBridgeClient inner) => inner is IBridgeProbeReader reader ? new CountingProbeBridge(inner, reader) : new CountingBridge(inner);
    /// <summary>The settledBridgeOperations entries this call settled.</summary>
    public List<JsonObject> Settled { get; } = new();
    public int Count(string method) => sent.GetValueOrDefault(method);
    public JsonObject Call(string method, JsonObject? parameters = null)
    {
        try { var reply = inner.Call(method, parameters); sent[method] = Count(method) + 1; return reply; }
        catch (Exception ex) when (ex is not BridgeCallException { Executed: false }) { sent[method] = Count(method) + 1; throw; }
    }
}

internal sealed class CountingProbeBridge(IBridgeClient inner, IBridgeProbeReader reader) : CountingBridge(inner), IBridgeProbeReader
{
    public Task<JsonObject?> ReadProbeAsync(string method, JsonObject? parameters = null, int timeoutMs = 250) => reader.ReadProbeAsync(method, parameters, timeoutMs);
}
