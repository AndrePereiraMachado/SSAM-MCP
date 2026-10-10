using System.Diagnostics;
using System.Text.Json.Nodes;
using Avalonia.Threading;
using ServiceStudio.Model;
using ServiceStudio.Presenter;
using ServiceStudio.Presenter.AddRemoveReferences;

namespace Anvil.Bridge;

/// <summary>
/// C26: the Studio's own Refresh References on an open module (capability refresh_references).
/// refresh_references {module_key, environment?, producers?: [reference name], producer_keys?: [producer key], timeout? = 600,
/// answer_dependencies?: the dependencies dialog is closed as Cancel first (MB2, dialogs:dependencies_auto)}.
/// The SDK's own commands, the same the Studio's MCP (ServiceStudioRefreshReferencesProvider) and Manage Dependencies run:
/// ReferencesManager.RefreshAllReferences (every reference) or RefreshSpecificReferences (the named ones), on the module's
/// aggregator queue when its top level is idle. Each is one Studio command: Ctrl+Z undoes it; nothing is published.
/// Answer: {module, moduleKey, changed, refreshed:[names whose signature changed], upToDate, missing, newErrors}.
/// Refusals before anything ran come with executed:false; a refresh that did not end in time is unknown.
/// Shared with the thin bridge by link (no kernel type): the error count is Reads.ErrorCount of each bridge.
/// </summary>
internal static class RefreshReferencesHandler
{
    public static async Task<string> Handle(JsonObject? p)
    {
        var timeout = Math.Clamp(p?["timeout"]?.GetValue<int>() ?? 600, 10, 1800);
        var sw = Stopwatch.StartNew();
        // MB2 (dialogs:dependencies_auto, answer_dependencies:true): the dependencies dialog asks for exactly this refresh; it
        // is answered (Cancel) first, so it never refuses the refresh as "a dialog pending". Listed in dependenciesDialog.
        var answered = p?["answer_dependencies"]?.GetValue<bool>() == true ? (await DependenciesDialog.Answer()).Answered : new JsonArray();
        var dependencies = answered.Count > 0 ? new JsonObject { ["answered"] = answered } : null;
        IAggregatorPresenter aggregator; ESpace module; List<string>? names; JsonArray missing;
        Dictionary<string, Guid> before; int errorsBefore;
        try
        {
            (aggregator, module, names, missing, before, errorsBefore) = await Ui.Run(() =>
            {
                var (a, e) = Studio.Target(p);
                Studio.RequireTarget(a, e, p);
                var pending = Dialogs.BlockedBy(a);
                if (pending.Count > 0 || e.Match != null)
                    throw new InvalidOperationException($"refresh_references: '{e.Name}' has a dialog or merge editor pending in the Studio"
                        + (pending.Count > 0 ? $" ({Dialogs.Summary(pending)})" : "") + "; nothing was refreshed");
                var requested = Strings(p?["producers"]); var keys = Strings(p?["producer_keys"]);
                List<string>? selected = null; var absent = new JsonArray();
                if (requested.Count > 0 || keys.Count > 0)
                {
                    selected = new List<string>();
                    foreach (var reference in e.References)
                    {
                        var key = reference.ReferenceKey?.ToString() ?? "";
                        if (requested.Contains(reference.Name, StringComparer.OrdinalIgnoreCase) || keys.Contains(key, StringComparer.OrdinalIgnoreCase))
                            selected.Add(reference.Name);
                    }
                    // Producer keys identify a reference whatever its local label; names are reported only when no key was given.
                    if (keys.Count > 0)
                    {
                        foreach (var key in keys.Where(k => !e.References.Any(r => string.Equals(r.ReferenceKey?.ToString(), k, StringComparison.OrdinalIgnoreCase))))
                            absent.Add(key);
                    }
                    else foreach (var name in requested.Where(n => !e.References.Any(r => string.Equals(r.Name, n, StringComparison.OrdinalIgnoreCase))))
                        absent.Add(name);
                }
                return (a, e, selected, absent, Hashes(e), Reads.ErrorCount(e));
            }, UiGate.Model, "refresh_references: read the module");
        }
        catch (Exception ex) { return Server.NotExecuted(Server.Unwrap(ex)); }
        if (names is { Count: 0 })
            return Server.Ok(new JsonObject { ["module"] = module.Name, ["moduleKey"] = module.Key.ToString(), ["changed"] = false,
                ["refreshed"] = new JsonArray(), ["upToDate"] = new JsonArray(), ["missing"] = missing, ["elapsedMs"] = sw.ElapsedMilliseconds,
                ["dependenciesDialog"] = dependencies?.DeepClone() });

        var done = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var queued = aggregator.ExecuteInContext(() =>
        {
            try
            {
                var changed = names == null
                    ? ReferencesManager.RefreshAllReferences(aggregator, module, null, null, null, CancellationToken.None)
                    : ReferencesManager.RefreshSpecificReferences(aggregator, module, new HashSet<string>(names, StringComparer.Ordinal));
                done.TrySetResult(changed);
            }
            catch (Exception ex) { done.TrySetException(ex); }
        }, executeWhenTopLevelIsIdle: true);
        _ = queued.ContinueWith(t => done.TrySetException(t.Exception?.InnerException ?? new InvalidOperationException("the refresh was not run")),
            TaskContinuationOptions.OnlyOnFaulted);
        UiGate.MarkDispatched();
        if (await Task.WhenAny(done.Task, Task.Delay(TimeSpan.FromSeconds(timeout))) != done.Task)
            return Server.Fail($"refresh_references: '{module.Name}' did not end within {timeout} s; its outcome is unknown. Check the module in the Studio (Ctrl+Z undoes a refresh).");
        bool reported;
        try { reported = await done.Task; }
        catch (Exception ex) { return Server.Fail("refresh_references: " + Server.Unwrap(ex) + "; check the module in the Studio before any retry"); }

        return await Reads.OnUi(() =>
        {
            var after = Hashes(module);
            var refreshed = new JsonArray(); var upToDate = new JsonArray();
            foreach (var (name, hash) in after)
            {
                if (names != null && !names.Contains(name, StringComparer.Ordinal)) continue;
                if (!before.TryGetValue(name, out var old) || old != hash) refreshed.Add(name); else upToDate.Add(name);
            }
            var errorsAfter = Reads.ErrorCount(module);
            return Server.Ok(new JsonObject
            {
                ["module"] = module.Name, ["moduleKey"] = module.Key.ToString(), ["changed"] = reported || refreshed.Count > 0,
                ["refreshed"] = refreshed, ["upToDate"] = upToDate, ["missing"] = missing, ["newErrors"] = Math.Max(0, errorsAfter - errorsBefore),
                ["undo"] = refreshed.Count > 0 || reported ? "Ctrl+Z in the Studio undoes the refresh" : null, ["elapsedMs"] = sw.ElapsedMilliseconds,
                ["dependenciesDialog"] = dependencies?.DeepClone(),
            });
        }, UiGate.Model, "refresh_references: read the result");
    }

    private static List<string> Strings(JsonNode? node) => (node as JsonArray)?.Select(n => n?.ToString()).Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s!.Trim()).ToList() ?? new();
    private static Dictionary<string, Guid> Hashes(ESpace module)
    {
        var result = new Dictionary<string, Guid>(StringComparer.Ordinal);
        foreach (var reference in module.References) result[reference.Name] = reference.ReferenceHash;
        return result;
    }
}
