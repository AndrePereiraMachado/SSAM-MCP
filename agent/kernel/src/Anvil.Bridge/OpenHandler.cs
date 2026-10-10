using System.Diagnostics;
using System.Text.Json.Nodes;
using Avalonia.Threading;
using ServiceStudio.Presenter;
using ServiceStudio.Presenter.AddRemoveReferences;

namespace Anvil.Bridge;

/// <summary>Open on the aggregator queue; silent mode belongs only to this attempt and is always reset.
/// Close and open never hold the UI thread (UiGate.cs): every UI step is bounded, and a tab is closed only when ModuleGate
/// says it is idle (capability close_module:idle_gate). An open waits (bounded) for a headless publication of the same
/// environment to end (capability open_module:headless_guard).</summary>
internal static class OpenHandler
{
    /// <summary>How long close_module waits for the tab to become idle before answering MODULE_BUSY (param idle_timeout_ms).</summary>
    private static readonly TimeSpan CloseIdleLimit = TimeSpan.FromSeconds(30);

    public static async Task<string> Close(JsonObject? p)
    {
        var name = p?["name"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(name)) return Server.NotExecuted("close_module: name is required");
        // C22: module_key picks the tab of that module when two tabs share a name (an environment's module and a copy).
        var key = p?["module_key"]?.ToString();
        var idleLimit = TimeSpan.FromMilliseconds(Math.Clamp(p?["idle_timeout_ms"]?.GetValue<int>() ?? (int)CloseIdleLimit.TotalMilliseconds, 0, 120000));
        try
        {
            var outcome = await ModuleGate.CloseAsync(
                // 1. Which tab, and the guards that keep it (unsaved, opening, dialog), on the UI thread: a bounded read.
                () => Ui.Run(() =>
                {
                    var matches = Studio.Aggregators().Where(a => string.Equals(a.ActiveESpace?.Name, name, StringComparison.OrdinalIgnoreCase)
                        && (string.IsNullOrEmpty(key) || a.ActiveESpace?.Key.ToString() == key)).ToArray();
                    if (matches.Length == 0) return new ModuleGate.Look(null, null, null, false);
                    if (matches.Length != 1) throw new InvalidOperationException("close_module: multiple matching tabs; choose in Studio");
                    var a = matches[0];
                    if (!a.HasOpenedActiveESpace || a.ActiveESpace.WasModifiedSinceLastSave || a.ServerSilentMode || Dialogs.BlockedBy(a).Count > 0)
                        return new ModuleGate.Look(a, "close_module: tab has unsaved changes, is opening, or has a pending operation; save or resolve it in Studio first", null, false);
                    return new ModuleGate.Look(a, null, a.ActiveESpace.Key.ToString(), PublishHandler.ServerOperation(a)?["running"]?.GetValue<bool?>() == true);
                }, UiGate.Read, "close_module: read the tab"),
                // 2. The idle gate: its Close waits synchronously for the tab's own dispatcher, and a publication still
                // finishing there needs the UI thread (ModuleGate).
                moduleKey => HeadlessPublications.Of(moduleKey, DateTime.UtcNow) != null,
                (tab, limit) => AggregatorIdle.Wait((IAggregatorPresenter)tab, limit),
                tab => AggregatorIdle.FrameCount((IAggregatorPresenter)tab),
                // 3. The close itself, re-checked on the UI thread just before it runs; bounded like every UI step.
                (tab0, moduleKey) => Ui.Run<bool?>(() =>
                {
                    var tab = (IAggregatorPresenter)tab0;
                    if (!tab.HasOpenedActiveESpace || tab.ActiveESpace?.Key.ToString() != moduleKey) return null;
                    if (tab.ActiveESpace.WasModifiedSinceLastSave || tab.ServerSilentMode || Dialogs.BlockedBy(tab).Count > 0) return false;
                    if (PublishHandler.ServerOperation(tab)?["running"]?.GetValue<bool?>() == true || AggregatorIdle.FrameCount(tab) is > 1) return false;
                    return tab.Close();
                }, UiGate.Step, "close_module: close the tab"),
                idleLimit);
            return outcome.Kind switch
            {
                "already-closed" => Server.Ok(new JsonObject { ["name"] = name, ["closed"] = true, ["alreadyClosed"] = true }),
                "refused" => Server.Fail(outcome.Text!),
                "busy" => Busy(name, key, outcome.Reason!, outcome.WaitedMs),
                _ => Server.Ok(new JsonObject { ["name"] = name, ["closed"] = true, ["idleWaitMs"] = outcome.WaitedMs }),
            };
        }
        catch (UiBusyException) { throw; }
        catch (Exception ex) { return Server.Fail(Server.Unwrap(ex)); }
    }

    // MODULE_BUSY: nothing was closed; the caller waits for the Studio (o11_studio wait idle) and closes again.
    private static string Busy(string name, string? key, string reason, long waitedMs) => new JsonObject
    {
        ["success"] = false, ["code"] = ModuleGate.BusyCode, ["executed"] = false,
        ["error"] = $"close_module: '{name}' was not closed: {ModuleGate.Explain(reason)}; nothing was closed",
        ["data"] = new JsonObject { ["code"] = ModuleGate.BusyCode, ["name"] = name, ["key"] = key, ["busy"] = reason, ["waitedMs"] = waitedMs,
            ["next"] = "wait until the Studio is idle (o11_studio wait idle), then close_module again" },
    }.ToJsonString();

    public static async Task<string> Open(JsonObject? p)
    {
        var name = p?["name"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(name)) return Server.Fail("open_module: 'name' is required");
        var app = p?["app"]?.GetValue<string>() ?? "";
        var timeout = Math.Clamp(p?["timeout"]?.GetValue<int>() ?? 120, 0, 300);
        var silent = p?["silent"]?.GetValue<bool>() ?? true;
        // MB2 (capability dialogs:dependencies_auto): the caller asks the bridge to answer the dependencies dialog (Cancel) on
        // its own; the answer lists it in dependenciesDialog and says referencesOutdated:true, so the caller refreshes the
        // references (refresh_references {module_key}). Any other dialog still ends the open with blockedBy, as before.
        var answerDependencies = p?["answer_dependencies"]?.GetValue<bool>() == true;
        var answered = new JsonArray();
        var sw = Stopwatch.StartNew();
        IAggregatorPresenter? target = null;
        SilentModeLease? lease = null;
        try
        {
            // Pattern 2 (2026-10-08): never start opening while a headless publication of this module (by key) or, without a
            // key, of this environment is in flight: wait for it inside the open's own timeout, else MODULE_BUSY.
            var headless = await WaitHeadless(p?["module_key"]?.ToString(), p?["environment"]?.ToString(), TimeSpan.FromSeconds(Math.Min(timeout, 120)));
            if (headless is { } holder)
                return new JsonObject { ["success"] = false, ["code"] = ModuleGate.BusyCode, ["executed"] = false,
                    ["error"] = $"open_module: '{name}' was not opened: {ModuleGate.Explain("headless-publish")} (module key {holder.Key}, since {holder.Since:s}Z); nothing was opened",
                    ["data"] = new JsonObject { ["code"] = ModuleGate.BusyCode, ["name"] = name, ["busy"] = "headless-publish", ["holderKey"] = holder.Key,
                        ["since"] = holder.Since.ToString("s") + "Z", ["next"] = "read the publication (o11_environment inventory), then open_module again" } }.ToJsonString();
            var already = await Ui.Run(() =>
            {
                var environment = p?["environment"]?.ToString();
                var expectedKey = p?["module_key"]?.ToString();
                var matches = Studio.Aggregators().Where(a => string.Equals(a.ActiveESpace?.Name, name, StringComparison.OrdinalIgnoreCase)
                    && (environment == null || string.Equals(Studio.EnvironmentHost(a), environment, StringComparison.OrdinalIgnoreCase))
                    && (expectedKey == null || a.ActiveESpace?.Key.ToString() == expectedKey)).ToArray();
                var modified = matches.Where(a => a.ActiveESpace?.WasModifiedSinceLastSave == true).ToArray();
                if (modified.Length > 1) throw new InvalidOperationException($"open_module: multiple edited tabs named '{name}'; select and close the redundant tab in Studio first");
                target = modified.SingleOrDefault() ?? matches.FirstOrDefault();
                if (target?.HasOpenedActiveESpace == true)
                {
                    target.GetOwnerAggregatorWindow().SelectedTopLevelPresenter = target;
                    return true;
                }
                if (target != null) return false; // an existing attempt owns its queue and flags
                var rt = ServiceStudio.Runtime.Instance as RuntimeImplementation ?? throw new InvalidOperationException("RuntimeImplementation not available");
                var window = rt.AggregatorWindows.FirstOrDefault(w => environment == null || string.Equals(w.ServerCommunicationsProvider?.LoginInfo?.HostInfo?.HostName, environment, StringComparison.OrdinalIgnoreCase))
                    ?? throw new InvalidOperationException("no Studio window connected to the requested environment");
                var page = window.ServerPagePresenter ?? throw new InvalidOperationException("no ServerPagePresenter");
                var li = window.ServerCommunicationsProvider?.LoginInfo;
                if (li == null || string.IsNullOrEmpty(li.UserName)) throw new InvalidOperationException("not logged in: use login with a credentials file");
                target = page.OpenESpace(null, name, null, app, false);
                if (target == null) throw new InvalidOperationException("OpenESpace did not return an aggregator");
                if (silent)
                {
                    var owner = target;
                    lease = new SilentModeLease(() => owner.ServerSilentMode, () => owner.ServerSilentMode = true, owner.ResetServerSilentMode);
                    // FIFO after DownloadAndOpen, plus finally below for timeout/blocked/error exits.
                    owner.ExecuteInContext(lease.Dispose, executeSynchronously: false, executeWhenTopLevelIsIdle: true);
                }
                return false;
            }, UiGate.Step, "open_module: start the open");
            if (already) return await Finished(true);
            UiGate.MarkDispatched();
            var blockedPolls = 0;
            while (sw.Elapsed.TotalSeconds < timeout)
            {
                await Task.Delay(Math.Min(1500, Math.Max(1, timeout * 1000 - (int)sw.ElapsedMilliseconds)));
                bool loaded; JsonArray blocked;
                try
                {
                    (loaded, blocked) = await Ui.Run(() =>
                    {
                        var a = target ?? Studio.Aggregators().FirstOrDefault(a => string.Equals(a.ActiveESpace?.Name, name, StringComparison.OrdinalIgnoreCase));
                        if (a?.HasOpenedActiveESpace == true)
                        {
                            target = a;
                            a.GetOwnerAggregatorWindow().SelectedTopLevelPresenter = a;
                            return (true, new JsonArray());
                        }
                        return (false, Dialogs.BlockedBy(a ?? Studio.ActiveAggregator()));
                    }, TimeSpan.FromSeconds(Math.Clamp(timeout - sw.Elapsed.TotalSeconds, 1, UiGate.Read.TotalSeconds)), "open_module: read the open");
                }
                catch (UiBusyException) { continue; }   // the open is running: a read the busy UI did not run is read again, inside timeout
                if (loaded) return await Finished(false);
                if (answerDependencies && DialogScope.MayBeDependencies(blocked) && await AnswerDependencies())
                {
                    blockedPolls = 0;   // answered: the open goes on (Cancel opens without updating the references)
                    continue;
                }
                blockedPolls = blocked.Count > 0 ? blockedPolls + 1 : 0;
                if (blockedPolls >= 3)
                {
                    await Reset();
                    return Server.Ok(new JsonObject { ["name"] = name, ["opened"] = false, ["blockedBy"] = blocked,
                        ["serverSilentMode"] = target?.ServerSilentMode, ["elapsedMs"] = sw.ElapsedMilliseconds,
                        ["dependenciesDialog"] = answered.Count > 0 ? new JsonObject { ["answered"] = answered.DeepClone() } : null,
                        ["hint"] = blocked[0]!["hint"]!.GetValue<string>() + "; then call open_module again" });
                }
            }
            return Server.Fail($"open_module: '{name}' did not become active in {timeout} s and no dialog was detected (check windows and ui_alive); temporary silent mode reset");
        }
        catch (Exception ex) { return Server.Fail(Server.Unwrap(ex)); }
        finally { await Reset(); }

        // Best effort and bounded: the lease is also reset by its own FIFO job on the tab (ExecuteInContext above).
        async Task Reset()
        {
            if (lease == null) return;
            try { await Ui.Run(lease.Dispose, UiGate.Step, "open_module: reset silent mode"); }
            catch (Exception ex) { Server.Log("open_module reset: " + Server.Unwrap(ex)); }
        }
        async Task<string> Finished(bool already)
        {
            await Reset();
            var result = new JsonObject { ["name"] = name, ["opened"] = true, ["alreadyOpen"] = already,
                ["selected"] = true, ["serverSilentMode"] = target!.ServerSilentMode };
            // MB2: the tab's own identity, for the refresh by module_key (a tab of the second window is not the active module).
            if (answerDependencies)
            {
                var owner0 = target;
                var (tabKey, tabEnvironment) = await Ui.Run(() => (owner0.ActiveESpace?.Key.ToString(), Studio.EnvironmentHost(owner0)), UiGate.Read, "open_module: read the tab");
                result["key"] = tabKey; result["environment"] = tabEnvironment;
            }
            // The manager may communicate with the server. Never block the Avalonia thread.
            var answer = new TaskCompletionSource<bool?>(TaskCreationOptions.RunContinuationsAsynchronously);
            var owner = target;
            var check = owner.ExecuteInContext(() =>
            {
                try
                {
                    var outdated = ReferencesManager.HasIncompatibleReferences(owner, owner.ActiveESpace, true, false, out var cancelled);
                    answer.TrySetResult(cancelled ? null : outdated);
                }
                catch { answer.TrySetResult(null); }
            }, executeWhenTopLevelIsIdle: true);
            _ = check.ContinueWith(t => answer.TrySetResult(null), TaskContinuationOptions.NotOnRanToCompletion);
            try
            {
                // MB2: while the check runs, the dependencies dialog it (or the open) shows is answered as soon as it is seen,
                // instead of holding the check until its 3 s and leaving the dialog to block the next call.
                var limit = sw.Elapsed + TimeSpan.FromSeconds(3);
                while (answerDependencies && !answer.Task.IsCompleted && sw.Elapsed < limit)
                {
                    await Task.WhenAny(answer.Task, Task.Delay(500));
                    if (!answer.Task.IsCompleted) await AnswerDependencies();
                }
                var outdated = await answer.Task.WaitAsync(answerDependencies ? TimeSpan.FromSeconds(1) : TimeSpan.FromSeconds(3));
                result["referencesCheck"] = outdated.HasValue ? "complete" : "skipped";
                if (outdated.HasValue) result["referencesOutdated"] = outdated.Value;
            }
            catch { result["referencesCheck"] = "skipped"; }
            if (answerDependencies) await AnswerDependencies();   // a dialog shown right after the check
            if (answered.Count > 0)
            {
                // The dialog itself says a producer changed: the references are outdated whatever the check could read.
                result["referencesOutdated"] = true;
                result["dependenciesDialog"] = new JsonObject { ["answered"] = answered.DeepClone(), ["next"] = "refresh_references" };
            }
            result["elapsedMs"] = sw.ElapsedMilliseconds;
            return Server.Ok(result);
        }
        async Task<bool> AnswerDependencies()
        {
            var (closed, _) = await DependenciesDialog.Answer();
            foreach (var entry in closed) answered.Add(entry!.DeepClone());
            return closed.Count > 0;
        }
    }

    /// <summary>Waits (bounded) for the headless publication of a module key, or of any module of the environment when the
    /// key is not known; the holder when it is still in flight at the limit, else null.</summary>
    internal static async Task<(string Key, DateTime Since)?> WaitHeadless(string? key, string? environment, TimeSpan limit)
    {
        var sw = Stopwatch.StartNew();
        while (true)
        {
            var holder = string.IsNullOrEmpty(key) ? HeadlessPublications.Any(environment, DateTime.UtcNow) : HeadlessPublications.Of(key, DateTime.UtcNow);
            if (holder == null || sw.Elapsed >= limit) return holder;
            await Task.Delay(1000);
        }
    }
}
