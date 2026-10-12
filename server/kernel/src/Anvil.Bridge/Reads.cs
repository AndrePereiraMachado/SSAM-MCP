using System.Text.Json.Nodes;
using Avalonia.Threading;
using OutSystems.Model;
using ServiceStudio.Model;
using ServiceStudio.Presenter;

namespace Anvil.Bridge;

/// <summary>Leituras que o merge e as provas precisam. Todas pela Model API; nada muta.
/// Shared with the thin bridge; get_errors, find_element and get_flow_nodes live in ReadsKernel.cs (full bridge) and
/// ReadsThin.cs (thin bridge, get_errors only).</summary>
internal static partial class Reads
{
    public static Task<string> ActiveModule() => OnUi(() =>
    {
        var (agg, e) = Studio.Active();
        var es = (IESpace)e;
        return Server.Ok(new JsonObject
        {
            ["name"] = e.Name, ["key"] = e.Key.ToString(), ["kind"] = e.ESpaceType.ToString(),
            ["environment"] = Studio.EnvironmentHost(agg), ["bridgeSessionId"] = Server.SessionId,
            ["description"] = e.Description, ["isModified"] = e.WasModifiedSinceLastSave,
            ["lastUploadUser"] = Studio.Prop(e, "LastUploadUser")?.ToString(),
            ["serverSilentMode"] = agg.ServerSilentMode, ["activeMatch"] = e.Match != null, ["pendingDialogs"] = Dialogs.BlockedBy(agg),
            // C10 (list_open_modules:dialogs): what blocks in the other tabs and windows, which pendingDialogs never shows.
            ["otherDialogs"] = DialogScope.Others(Dialogs.AllBlocking(), e.Name),
            ["serverOperation"] = PublishHandler.ServerOperation(agg),
            ["counts"] = new JsonObject
            {
                ["serverActions"] = es.ServerActions.Count(), ["serviceActions"] = es.ServiceActions.Count(), ["clientActions"] = es.ClientActions.Count(),
                ["entities"] = es.GetAllDescendantsOfType<OutSystems.Model.Data.IEntity>().Count(), ["roles"] = es.Roles.Count(), ["timers"] = es.Timers.Count(),
                ["references"] = es.References.Count(),
            },
        });
    });

    /// <summary>list_open_modules. With model_sha256_of (a module name or key; capability list_open_modules:model_sha256) the
    /// rows of the opened tabs of that module also carry modelSha256 (MergeRollbackProof.ModelSha256Hex of the tab's own
    /// SaveToMemoryStream, the bytes snapshot_module would write), modelBytes and modelSha256Ms, read in a second bounded UI
    /// step: the O11 build phase reuses a capture the server already holds when the model is the same, instead of capturing
    /// and uploading it again (o11-build-phase.mjs captureByKey). A tab that changed between the two steps, is opening or
    /// is in silent mode gets no fingerprint; a fingerprint that cannot be read leaves the list as it is.</summary>
    public static async Task<string> OpenModules(JsonObject? p = null)
    {
        var wanted = p?["model_sha256_of"]?.GetValue<string>();
        var targets = new List<(JsonObject Row, IAggregatorPresenter Tab)>();
        JsonObject listing;
        try { listing = await Ui.Run(() => OpenModulesNow(wanted, targets), UiGate.Read, "list_open_modules"); }
        catch (UiBusyException) { throw; }
        catch (Exception ex) { return Server.Fail(Server.Unwrap(ex)); }
        if (targets.Count > 0) await ModelFingerprints(targets);
        return Server.Ok(listing);
    }

    private static async Task ModelFingerprints(List<(JsonObject Row, IAggregatorPresenter Tab)> targets)
    {
        try
        {
            var read = await Ui.Run(() => targets.Select(target =>
            {
                var e = target.Tab.ActiveESpace;
                if (e == null || !target.Tab.HasOpenedActiveESpace || target.Tab.ServerSilentMode || e.Key.ToString() != target.Row["key"]?.ToString())
                    return (Sha: (string?)null, Bytes: 0, Ms: 0L);
                var sw = System.Diagnostics.Stopwatch.StartNew();
                using var ms = e.SaveToMemoryStream();
                var bytes = ms.ToArray();
                return (Sha: MergeRollbackProof.ModelSha256Hex(bytes), Bytes: bytes.Length, Ms: sw.ElapsedMilliseconds);
            }).ToList(), UiGate.Model, "list_open_modules: model fingerprint");
            for (var i = 0; i < targets.Count; i++)
            {
                if (read[i].Sha == null) continue;
                targets[i].Row["modelSha256"] = read[i].Sha; targets[i].Row["modelBytes"] = read[i].Bytes; targets[i].Row["modelSha256Ms"] = read[i].Ms;
            }
        }
        // A busy UI or a failed save leaves the rows without a fingerprint: the caller captures as before.
        catch (UiBusyException) { UiGate.Forget(); Server.Log("list_open_modules model fingerprint: UI busy"); }
        catch (Exception ex) { Server.Log("list_open_modules model fingerprint: " + Server.Unwrap(ex)); }
    }

    private static JsonObject OpenModulesNow(string? fingerprintOf, List<(JsonObject Row, IAggregatorPresenter Tab)> targets)
    {
        var arr = new JsonArray();
        var runtime = ServiceStudio.Runtime.Instance as RuntimeImplementation;
        var windowList = runtime?.AggregatorWindows.ToList() ?? [];
        var perWindow = windowList.Select(_ => new JsonArray()).ToList();
        var blocking = new List<(string?, JsonArray)>();
        foreach (var a in Studio.Aggregators())
        {
            var e = a.ActiveESpace;
            var blockedBy = Dialogs.BlockedBy(a);
            blocking.Add((e?.Name, blockedBy));
            // C22 (list_open_modules:window): the Studio window that holds the tab, by its index in the runtime's windows.
            object? owner = null;
            try { owner = a.GetOwnerAggregatorWindow(); } catch { owner = null; }
            var index = owner == null ? -1 : windowList.FindIndex(w => ReferenceEquals(w, owner));
            if (index >= 0 && e != null) perWindow[index].Add(JsonValue.Create(e.Name));
            // serverOperation (C31, capability list_open_modules:server_operation): a publish or upload running for the module.
            // pendingDialogs (C10, list_open_modules:dialogs): the tab's own modal presenters (Manage Dependencies, merge editor).
            var row = new JsonObject { ["name"] = e?.Name, ["key"] = e?.Key.ToString(), ["hasESpace"] = e != null, ["environment"] = Studio.EnvironmentHost(a), ["isModified"] = e?.WasModifiedSinceLastSave, ["hasOpenedActiveESpace"] = a.HasOpenedActiveESpace, ["serverSilentMode"] = a.ServerSilentMode, ["presenter"] = a.GetType().Name,
                ["serverOperation"] = e == null ? null : PublishHandler.ServerOperation(a),
                ["pendingDialogs"] = DialogScope.Presenters(blockedBy), ["window"] = index >= 0 ? index : null };
            arr.Add(row);
            if (e != null && a.HasOpenedActiveESpace && !a.ServerSilentMode && !string.IsNullOrWhiteSpace(fingerprintOf) && targets.Count < 4
                && (string.Equals(e.Name, fingerprintOf, StringComparison.OrdinalIgnoreCase) || e.Key.ToString() == fingerprintOf))
                targets.Add((row, a));
        }
        var environments = windowList.Select(w => w.ServerCommunicationsProvider?.LoginInfo)
            .Where(login => !string.IsNullOrEmpty(login?.UserName) && !string.IsNullOrEmpty(login.HostInfo?.HostName))
            .Select(login => login!.HostInfo.HostName.ToLowerInvariant()).Distinct().ToArray();
        var windows = new JsonArray(windowList.Select((w, i) => (JsonNode)new JsonObject { ["index"] = i,
            ["title"] = Studio.Prop(w, "Title")?.ToString() ?? Studio.Prop(w, "Caption")?.ToString(),
            ["environment"] = w.ServerCommunicationsProvider?.LoginInfo?.HostInfo?.HostName?.ToLowerInvariant(), ["modules"] = perWindow[i] }).ToArray());
        return new JsonObject { ["count"] = arr.Count, ["modules"] = arr,
            ["environments"] = new JsonArray(environments.Select(host => (JsonNode)JsonValue.Create(host)!).ToArray()),
            ["windows"] = windows, ["dialogs"] = blocking.Count == 0 ? Dialogs.BlockedBy(null) : DialogScope.Union(blocking) };
    }

    // C28: the validation generation (capability get_errors:generation), shared by get_errors of both bridges
    // (ReadsKernel.cs, ReadsThin.cs). settle:true (the kernel's verify after a merge) first waits, bounded and inside the
    // bridge, until the module's aggregator is idle (the merge command, its post-processing and the TrueChange queued
    // after it have run), then reads the validation and answers settled:true with a new generation. Without settle the
    // read is as before and the generation is the last one.
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, long> generations = new();
    private static readonly TimeSpan SettleLimit = TimeSpan.FromSeconds(30);

    private static async Task<bool> Settle(JsonObject? p)
    {
        if (p?["settle"]?.GetValue<bool>() != true) return false;
        try
        {
            var aggregator = await Ui.Run(() => Studio.Target(p).Aggregator, UiGate.Read, "get_errors: find the module");
            var idle = aggregator.ExecuteInContext(() => { }, executeWhenTopLevelIsIdle: true);
            return await Task.WhenAny(idle, Task.Delay(SettleLimit)) == idle && idle.IsCompletedSuccessfully;
        }
        catch (Exception ex) { Server.Log("get_errors settle: " + Server.Unwrap(ex)); return false; }
    }

    private static void Generation(JsonObject result, string moduleKey, bool settled)
    {
        result["generation"] = settled ? generations.AddOrUpdate(moduleKey, 1, (_, n) => n + 1) : generations.TryGetValue(moduleKey, out var last) ? last : 0;
        result["settled"] = settled;
    }

    /// <summary>Leituras do modelo rodam na UI thread (o modelo nao e thread-safe para leitura concorrente com edicao).
    /// Sempre com prazo (UiGate.cs): UI_BUSY quando a UI thread nao roda o passo a tempo; o passo e retirado da fila.</summary>
    internal static async Task<string> OnUi(Func<string> f, TimeSpan? limit = null, [System.Runtime.CompilerServices.CallerMemberName] string what = "")
    {
        try { return await Ui.Run(f, limit ?? UiGate.Read, what); }
        catch (UiBusyException) { throw; }
        catch (Exception ex) { return Server.Fail(Server.Unwrap(ex)); }
    }
}
