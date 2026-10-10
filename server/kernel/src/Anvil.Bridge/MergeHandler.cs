using Anvil.Core;
using Anvil.Core.Delivery;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Avalonia.Threading;
using ServiceStudio.Merge;
using ServiceStudio.Model;
using ServiceStudio.Presenter;
using ServiceStudio.Presenter.Commands;

namespace Anvil.Bridge;

/// <summary>
/// O merge de 3 vias do proprio Studio sobre o modulo aberto (CompareAndMergeCommands.CompareAndMerge).
/// Com base, automaticMerge e sem conflito, aplica matchTree.Merge() dentro de um comando: entra como edicao
/// normal, com Ctrl+Z e TrueChange; nada e publicado. Roda FORA da UI thread, como o 1CP faz (na UI thread o
/// editor de merge dispara "Cannot execute in UI thread").
/// snapshot_module {path}; merge_from_oml {foreign_path, base_path?, mode=preview|auto|dialog, match_by_structure?,
/// first_pass_path?, first_pass_sha256?}.
/// Merge order (Anvil.Core.MergeOrder): with first_pass_path the same operation runs two native merges, the first-pass copy
/// over the base, then the candidate over that copy, so the defaults the Studio drops on elements a merge creates are
/// merged onto the elements the first merge created. One operation id, one journal entry, one receipt (secondPass).
/// </summary>
internal static class MergeHandler
{
    internal static SnapshotRegistry Snapshots { get; } = new();
    private static readonly SemaphoreSlim execution = new(1);
    private static MergeJournal Journal => new(Server.StateDirectory);
    public static string Status(JsonObject? p) => Server.Ok(Journal.Status(p?["operation_id"]?.ToString() ?? "", p?["module_key"]?.ToString()));
    public static Task<string> Snapshot(JsonObject? p) => Reads.OnUi(limit: UiGate.Model, what: "snapshot_module", f: () =>
    {
        var path = PathArgs.Absolute("snapshot_module", "path", p?["path"]?.GetValue<string>());   // relativo cairia no cwd do Studio (plano, item 11)
        var sw = Stopwatch.StartNew();
        var (agg, e) = Studio.Target(p);   // C41: the tab of module_key, selected or not
        Studio.RequireTarget(agg, e, p);
        var messages = ModelHost.Messages(e);
        using var ms = e.SaveToMemoryStream();
        var bytes = ms.ToArray();
        var full = path;
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllBytes(full, bytes);
        var registered = Snapshots.Register(e.Key.ToString(), bytes, messages);
        return Server.Ok(new JsonObject { ["baseline"] = JsonSerializer.SerializeToNode(messages), ["environment"] = Studio.EnvironmentHost(agg), ["bridgeSessionId"] = Server.SessionId, ["snapshot_id"] = registered.Id, ["sha256"] = registered.Sha256, ["path"] = full, ["bytes"] = bytes.Length, ["name"] = e.Name, ["key"] = e.Key.ToString(), ["elapsedMs"] = sw.ElapsedMilliseconds });
    });

    public static async Task<string> Merge(JsonObject? p)
    {
        var foreignPath = p?["foreign_path"]?.GetValue<string>();
        var basePath = p?["base_path"]?.GetValue<string>();
        var mode = (p?["mode"]?.GetValue<string>() ?? "auto").ToLowerInvariant();
        var byStructure = p?["match_by_structure"]?.GetValue<bool>() ?? false;
        var dumpChars = p?["dump_chars"]?.GetValue<int>() ?? 3000;
        var firstPassPath = p?["first_pass_path"]?.GetValue<string>();
        foreignPath = PathArgs.Absolute("merge_from_oml", "foreign_path", foreignPath);
        if (basePath != null) basePath = PathArgs.Absolute("merge_from_oml", "base_path", basePath);
        if (firstPassPath != null) firstPassPath = PathArgs.Absolute("merge_from_oml", "first_pass_path", firstPassPath);
        if (!File.Exists(foreignPath)) return Server.NotExecuted("merge_from_oml: 'foreign_path' must exist");
        if (basePath != null && !File.Exists(basePath)) return Server.NotExecuted("merge_from_oml: 'base_path' does not exist");
        if (firstPassPath != null && !File.Exists(firstPassPath)) return Server.NotExecuted("merge_from_oml: 'first_pass_path' does not exist");
        if (mode is not ("preview" or "auto" or "dialog")) return Server.NotExecuted("merge_from_oml: mode must be preview|auto|dialog");
        if (firstPassPath != null && mode == "dialog") return Server.NotExecuted("merge_from_oml: first_pass_path runs two automatic merges; use mode=auto or preview");
        var foreignBytes = File.ReadAllBytes(foreignPath);
        var baseBytes = basePath != null ? File.ReadAllBytes(basePath) : null;
        var firstPassBytes = firstPassPath != null ? File.ReadAllBytes(firstPassPath) : null;
        if (firstPassBytes != null && p?["first_pass_sha256"]?.ToString() != Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(firstPassBytes)).ToLowerInvariant())
            return Server.NotExecuted("Validated first-pass bytes changed before merge (first_pass_sha256 is required with first_pass_path)");

        IAggregatorPresenter aggregator; ESpace local; JsonArray pending; bool matchSet; string? environment;
        try
        {
            (aggregator, local, pending, matchSet, environment) = await Ui.Run(() =>
            {
                var (a, e) = Studio.Target(p);   // C41: the aggregator of module_key in any tab, not the selected tab
                Studio.RequireTarget(a, e, p);
                return (a, e, Dialogs.BlockedBy(a), e.Match != null, Studio.EnvironmentHost(a));
            }, UiGate.Read, "merge_from_oml: find the module");
        }
        catch (Exception ex) { return Server.NotExecuted(Server.Unwrap(ex)); }
        // Manage Dependencies monta um MatchTree e deixa Match nos objetos do modulo aberto; o nosso MatchTree recusaria com
        // "Matches cannot be set already" (plano, item 12). Recusar cedo, com o que esta pendente, em vez de esperar a excecao.
        if (matchSet || pending.Count > 0)
            return Server.NotExecuted($"merge_from_oml: '{local.Name}' has a dialog or merge editor pending in the Studio" +
                               (pending.Count > 0 ? $" ({Dialogs.Summary(pending)})" : " (match state set on the module)") +
                               ": apply or close it in the Studio (see `windows` / `python scripts/cdp_pages.py`) and retry; never restart the Studio for this");

        if (p?.ContainsKey("allow_foreign_base") == true) return Server.NotExecuted("allow_foreign_base was removed; every merge requires a registered snapshot");
        try { Snapshots.RequireBase(local.Key.ToString(), baseBytes, basePath); }
        catch (Exception ex) { return Server.NotExecuted(ex.Message); }
        if (p?["base_sha256"] is { } expectedBase && expectedBase.ToString() != Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(baseBytes!)).ToLowerInvariant())
            return Server.NotExecuted("Validated base bytes changed before merge");
        if (p?["foreign_sha256"] is { } expectedForeign && expectedForeign.ToString() != Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(foreignBytes)).ToLowerInvariant())
            return Server.NotExecuted("Validated foreign bytes changed before merge");

        if (!await execution.WaitAsync(0)) return Server.NotExecuted("Another merge is running; wait for its operation status");
        try
        {
            string Execute()
            {
                var id = p?["operation_id"]?.ToString() ?? Guid.NewGuid().ToString("N");
                using var operation = Journal.Begin(id, new JsonObject { ["module_key"] = local.Key.ToString(),
                    ["environment"] = environment, ["mode"] = mode, ["byStructure"] = byStructure,
                    ["baseHash"] = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(baseBytes!)),
                    ["foreignHash"] = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(foreignBytes)),
                    ["firstPassHash"] = firstPassBytes == null ? null : Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(firstPassBytes)) });
                if (!operation.IsNew)
                    return Server.Ok(operation.State["receipt"]?.DeepClone() ?? new JsonObject { ["operationId"] = id, ["writeState"] = operation.State["state"]!.DeepClone() });
                var nativeStarted = false;
                try
                {
                    // This runs on the tab's own dispatcher thread: every UI read from here is bounded (UiGate.cs), so the tab and
                    // the UI thread can never wait on each other forever.
                    Ui.RunSync(() => Studio.RequireTarget(aggregator, aggregator.ActiveESpace, new JsonObject {
                        ["module_key"] = local.Key.ToString(), ["environment"] = operation.State["binding"]!["environment"]?.DeepClone() }), UiGate.Read, "merge_from_oml: check the target");
                    var response = Run(aggregator, local, foreignBytes, baseBytes, firstPassBytes, foreignPath, mode, byStructure, dumpChars,
                        data => { data["operationId"] = id; operation.Record(data); }, () => nativeStarted = true);
                    return response;
                }
                catch (Exception ex)
                {
                    var error = Server.Unwrap(ex);
                    if (!nativeStarted && operation.State["receipt"] == null)
                    {
                        operation.Record(new JsonObject { ["operationId"] = id, ["merged"] = false, ["reason"] = error });
                        return Server.NotExecuted(error);
                    }
                    operation.Failure(error);
                    if (operation.State["receipt"] is JsonObject receipt)
                    {
                        var data = receipt.DeepClone().AsObject(); data["verificationError"] = error;
                        return Server.Ok(data);
                    }
                    // C15: a merge that started and threw without a receipt is usually one the SDK command rolled back.
                    // Prove it on the module itself; proven, the journal records not-applied and the module is free.
                    if (RollbackReceipt(aggregator, local, baseBytes!, operation.State["binding"]?["baseHash"]?.ToString(), id, error) is { } rolledBack)
                    {
                        operation.Record(rolledBack);
                        return Server.Ok(rolledBack);
                    }
                    return Server.Fail(error + "; merge outcome is unknown, inspect merge_status operation_id=" + id);
                }
            }
            var response = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            var queued = aggregator.ExecuteInContext(() =>
            {
                try { response.TrySetResult(Execute()); }
                catch (Exception ex) { response.TrySetException(ex); }
            }, executeWhenTopLevelIsIdle: true);
            // Bounded like every wait of the bridge (UiGate.cs), under the client's 900 s: a tab that never ran the merge job
            // answers an unknown outcome with the operation id, never a call that hangs.
            if (await Task.WhenAny(response.Task, Task.Delay(UiGate.Heavy)) != response.Task)
                return Server.Fail($"merge_from_oml: the tab did not run the merge within {UiGate.Heavy.TotalMinutes:0} min; outcome unknown: inspect merge_status operation_id={p?["operation_id"]}");
            _ = queued;
            return await response.Task;
        }
        finally { execution.Release(); }
    }

    private static string Run(IAggregatorPresenter aggregator, ESpace local, byte[] foreignBytes, byte[]? baseBytes, byte[]? firstPassBytes, string foreignPath, string mode, bool byStructure, int dumpChars, Action<JsonObject> record, Action enteringNativeMerge)
    {
        var sw = Stopwatch.StartNew();
        var timings = new JsonObject { ["thread"] = Dispatcher.UIThread.CheckAccess() ? "ui" : "worker" };
        // The first merge takes the first-pass copy when the merge order deferred defaults, the candidate otherwise.
        var foreign = ESpace.Load(firstPassBytes ?? foreignBytes, productKey: null, informationForUpgrader: null);
        ESpace? baseEs = null;
        var handedOff = false;
        try
        {
        SnapshotRegistry.RequireForeignIdentity(local.Key.ToString(), foreign.Key.ToString());
        timings["loadForeignMs"] = sw.ElapsedMilliseconds;
        if (baseBytes != null)
        {
            var t0 = sw.ElapsedMilliseconds;
            baseEs = ESpace.Load(baseBytes, productKey: null, informationForUpgrader: null);
            timings["loadBaseMs"] = sw.ElapsedMilliseconds - t0;
        }

        var t1 = sw.ElapsedMilliseconds;
        bool hasNoDiff, hasConflicts, nativeHasNoDiff; string dump;
        var signaturePlan = ReferenceSignatureMerge.Analyze(local, foreign, baseEs);
        using (var tree = new MatchTree(local, foreign, baseEs, byStructure, true))
        {
            nativeHasNoDiff = tree.HasNoDifferences;
            hasNoDiff = nativeHasNoDiff && !signaturePlan.HasChanges && !signaturePlan.HasConflicts;
            hasConflicts = tree.HasConflicts || signaturePlan.HasConflicts;
            dump = tree.Dump();
        }
        timings["matchTreeMs"] = sw.ElapsedMilliseconds - t1;
        var dumpPath = foreignPath + ".matchtree.txt";
        File.WriteAllText(dumpPath, dump);
        var data = new JsonObject
        {
            ["mode"] = mode, ["local"] = local.Name, ["foreign"] = foreign.Name, ["base"] = baseEs?.Name,
            ["hasNoDifferences"] = hasNoDiff, ["hasConflicts"] = hasConflicts,
            ["nativeHasNoDifferences"] = nativeHasNoDiff,
            ["referenceSignatures"] = JsonSerializer.SerializeToNode(signaturePlan),
            ["dumpPath"] = dumpPath, ["dumpChars"] = dump.Length,
            ["dumpHead"] = dump.Length > dumpChars ? dump[..dumpChars] : dump, ["timings"] = timings,
        };
        var needsHuman = hasConflicts || baseEs == null;
        // The native dialog does not invoke its automatic-merge callback. Do not apply a
        // partial merge whose selected producer version cannot be preserved by that path.
        var unsupportedSignatureDialog = mode == "dialog" && signaturePlan.HasChanges;
        if (firstPassBytes != null) data["mergeOrder"] = new JsonObject { ["passes"] = 2,
            ["firstPassSha256"] = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(firstPassBytes)).ToLowerInvariant() };
        // With a first-pass copy equal to the base the first merge has nothing to do; the second still runs.
        if (mode == "preview" || (hasNoDiff && firstPassBytes == null) || signaturePlan.HasConflicts || unsupportedSignatureDialog || (mode == "auto" && needsHuman))
        {
            data["merged"] = false;
            data["reason"] = mode == "preview" ? "preview" : signaturePlan.HasConflicts
                ? "producer signature changed concurrently: review referenceSignatures before retrying"
                : unsupportedSignatureDialog ? "producer signature changes require automatic merge with a matching base; native dialog has no metadata-selection callback"
                : hasNoDiff ? "no differences" : hasConflicts ? "conflicts: use mode=dialog" : "no base: 3-way merge needs base_path (or mode=dialog)";
            record(data);
            var unchanged = ReadMessages(local, timings, "verifyUnchangedMs");
            SetDelta(data, MessageDelta.Compute(unchanged.Messages, unchanged.Messages), unchanged.IsValid);
            data["totalMs"] = sw.ElapsedMilliseconds;
            record(data);
            return Server.Ok(data);
        }
        var before = ReadMessages(local, timings, "verifyBeforeMs");
        var t2 = sw.ElapsedMilliseconds;
        MergeOperationResult result = MergeOperationResult.Merge;
        if (hasNoDiff) data["reason"] = "first pass: no differences";
        else if (signaturePlan.HasChanges)
        {
            // ReferenceHash is invisible to native diff. Merge the structural changes and
            // explicit reference selections through the same SDK command so undo/rollback
            // includes both. Each native tree is disposed before constructing the next.
            ReferenceSignatureMergeResult? applied = null;
            ServiceStudio.Commands.Command.Execute(aggregator.GetPresenterContext(), "Anvil: merge module and producer signatures", () =>
            {
                applied = ReferenceSignatureMerge.MergeInCurrentCommand(local, foreign, baseEs!, signaturePlan, tree =>
                {
                    enteringNativeMerge();
                    CompareAndMergeCommands.Merge(aggregator, tree);
                }, matchByStructure: byStructure);
            });
            // The SDK can roll back during command cleanup after the delegate has returned.
            // Confirm retained model state before recording a successful merge.
            Ui.RunSync(() => ReferenceSignatureMerge.VerifyApplied(local, foreign, baseEs!, signaturePlan), UiGate.Model, "merge_from_oml: verify the signatures");
            if (applied == null) throw new InvalidOperationException("The native merge command did not complete its apply callback.");
            data["referenceSignaturesSelected"] = applied.SelectedReferences;
            data["nativeMergeCount"] = applied.NativeMergeCount;
            result = MergeOperationResult.Merge;
        }
        else
        {
            handedOff = true;
            enteringNativeMerge();
            result = CompareAndMergeCommands.CompareAndMerge(aggregator, local, foreign, baseEs, byStructure,
                automaticMerge: mode == "auto", isFrom1CP: false);
        }
        timings["compareAndMergeMs"] = sw.ElapsedMilliseconds - t2;
        data["result"] = result.ToString();
        data["merged"] = !hasNoDiff && (result is MergeOperationResult.Merge or MergeOperationResult.MergeAndPublish);
        data["undoSteps"] = data["merged"]!.GetValue<bool>() ? 1 : 0;
        record(data);
        // The second merge (MergeReceipt): only after a first merge that merged or had nothing to merge, and journaled as
        // started first, so a failure inside it reconciles as unknown instead of as the first merge alone.
        if (firstPassBytes != null && MergeReceipt.RunsSecondPass(data, hasNoDiff))
        {
            var firstMerged = MergeReceipt.BeginSecondPass(data);
            record(data);
            var second = SecondPass(aggregator, local, foreignBytes, firstPassBytes, foreignPath, byStructure, timings, enteringNativeMerge);
            MergeReceipt.EndSecondPass(data, second, firstMerged);
            record(data);
        }
        var after = ReadMessages(local, timings, "verifyAfterMs");
        SetDelta(data, MessageDelta.Compute(before.Messages, after.Messages), after.IsValid);
        data["totalMs"] = sw.ElapsedMilliseconds;
        record(data);
        return Server.Ok(data);
        }
        finally
        {
            if (!handedOff) { Safe(() => foreign.Close()); if (baseEs != null) Safe(() => baseEs.Close()); }
        }
    }

    // Second merge of the merge order: the candidate over the first-pass copy. The copy differs from the candidate only by
    // the deferred defaults, so a native 3-way merge with it as base brings exactly those onto the live module and keeps
    // whatever the first merge normalized (a local change the candidate does not touch). A conflict or a pending merge
    // state stops here with the reason; the kernel's proof then names each default the module lacks.
    private static JsonObject SecondPass(IAggregatorPresenter aggregator, ESpace local, byte[] foreignBytes, byte[] firstPassBytes, string foreignPath, bool byStructure, JsonObject timings, Action enteringNativeMerge)
    {
        var sw = Stopwatch.StartNew();
        var second = new JsonObject();
        var pending = Ui.RunSync(() => local.Match != null, UiGate.Read, "merge_from_oml: second pass state");
        if (pending) { second["merged"] = false; second["reason"] = "the first merge left a merge state pending in the Studio"; return second; }
        var candidate = ESpace.Load(foreignBytes, productKey: null, informationForUpgrader: null);
        var firstPass = ESpace.Load(firstPassBytes, productKey: null, informationForUpgrader: null);
        var handedOff = false;
        try
        {
            SnapshotRegistry.RequireForeignIdentity(local.Key.ToString(), candidate.Key.ToString());
            SnapshotRegistry.RequireForeignIdentity(local.Key.ToString(), firstPass.Key.ToString());
            bool conflicts, noDifferences; string dump;
            using (var tree = new MatchTree(local, candidate, firstPass, byStructure, true)) { conflicts = tree.HasConflicts; noDifferences = tree.HasNoDifferences; dump = tree.Dump(); }
            var dumpPath = foreignPath + ".second-pass.matchtree.txt";
            File.WriteAllText(dumpPath, dump);
            second["dumpPath"] = dumpPath; second["hasConflicts"] = conflicts; second["hasNoDifferences"] = noDifferences;
            if (conflicts || noDifferences) { second["merged"] = false; second["reason"] = conflicts ? "conflicts" : "no differences"; return second; }
            handedOff = true;
            enteringNativeMerge();
            var result = CompareAndMergeCommands.CompareAndMerge(aggregator, local, candidate, firstPass, byStructure, automaticMerge: true, isFrom1CP: false);
            second["result"] = result.ToString();
            second["merged"] = result is MergeOperationResult.Merge or MergeOperationResult.MergeAndPublish;
            return second;
        }
        finally
        {
            timings["secondPassMs"] = sw.ElapsedMilliseconds;
            if (!handedOff) { Safe(() => candidate.Close()); Safe(() => firstPass.Close()); }
        }
    }

    // C15: the module now against the merge base. The sha256 of the live bytes (UI thread, as snapshot_module) against the
    // journal's baseHash; when they differ, a native 3-way tree of the live module over the base on both sides tells whether
    // anything differs at all. Any failure to decide leaves the outcome unknown (null).
    private static JsonObject? RollbackReceipt(IAggregatorPresenter aggregator, ESpace local, byte[] baseBytes, string? baseHash, string id, string error)
    {
        try
        {
            var (liveSha, pendingMatch) = Ui.RunSync(() =>
            {
                if (!ReferenceEquals(aggregator.ActiveESpace, local)) throw new InvalidOperationException("the module tab changed after the merge");
                using var ms = local.SaveToMemoryStream();
                return (MergeRollbackProof.Sha256Hex(ms.ToArray()), local.Match != null);
            }, UiGate.Model, "merge_from_oml: rollback proof");
            bool? treeHasNoDifferences = null;
            if (!MergeRollbackProof.SameHash(liveSha, baseHash) && !pendingMatch)
            {
                var basis = ESpace.Load(baseBytes, productKey: null, informationForUpgrader: null);
                try { using var tree = new MatchTree(local, basis, basis, false, true); treeHasNoDifferences = tree.HasNoDifferences; }
                finally { Safe(() => basis.Close()); }
            }
            return MergeRollbackProof.Receipt(id, liveSha, baseHash, treeHasNoDifferences, error);
        }
        catch (Exception ex) { Server.Log("rollback proof: " + Server.Unwrap(ex)); return null; }
    }

    // Run esta fora da UI thread; a projecao do modelo vivo e feita na UI, sem ler em paralelo com uma edicao.
    private static (IReadOnlyList<MessageInfo> Messages, bool IsValid) ReadMessages(ESpace local, JsonObject timings, string metric)
    {
        var sw = Stopwatch.StartNew();
        var result = Ui.RunSync(() =>
        {
            var messages = ModelHost.Messages(local);
            return (Messages: messages, IsValid: local.IsValid);
        }, UiGate.Model, "merge_from_oml: validation");
        timings[metric] = sw.ElapsedMilliseconds;
        return result;
    }

    private static void SetDelta(JsonObject data, MessageDelta delta, bool isValid)
    {
        data["new"] = JsonSerializer.SerializeToNode(delta.New);
        data["fixed"] = JsonSerializer.SerializeToNode(delta.Fixed);
        data["preexisting"] = JsonSerializer.SerializeToNode(delta.Preexisting);
        var newErrors = delta.New.Count(m => m.IsError);
        data["newErrors"] = newErrors;
        data["localIsValidAfter"] = isValid;
        // Each native merge that merged is one Studio command: a merge-order delivery takes two undo steps.
        var undo = data["undoSteps"]?.GetValue<int>() == 2 ? "Ctrl+Z twice in the Studio undoes the merge" : "Ctrl+Z in the Studio undoes the merge";
        if (newErrors > 0)
            data["hint"] = "Merge kept for review: new TrueChange errors were introduced. Inspect 'new'; " + undo + ". Nothing was published.";
    }

    private static void Safe(Action a) { try { a(); } catch (Exception ex) { Server.Log("close: " + Server.Unwrap(ex)); } }
}
