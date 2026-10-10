using System.Diagnostics;
using System.Reflection;
using System.Text.Json.Nodes;
using Avalonia.Threading;
using ServiceStudio;
using ServiceStudio.Commands;
using ServiceStudio.Presenter;
using ServiceStudio.Presenter.Commands;

namespace Anvil.Bridge;

/// <summary>
/// 1-Click Publish do modulo aberto pelo comando do proprio Studio (ServiceStudio.Presenter.Commands.Publish, singleton
/// AutoRegistryType&lt;Publish&gt;.Instance). O membro que aceita a mensagem de commit e interno (ofuscado): resolvido por
/// assinatura (IAggregatorPresenter, IPresenter, string) -> ExecutePublish(target, presenter, ActiveESpace, message).
/// Conclusao: o processo desta publicacao termina num estado explicito de sucesso.
/// Upload sozinho nao comprova compilacao nem deployment.
/// publish {message?, timeout?, module_key?, environment?}
/// C41: module_key names the module in any tab (Studio.Target), not only the selected one.
/// C31 (capability publish:wait_running): a server operation already running on the module (a publish the person started)
/// is waited for, inside timeout, and then this publication runs; the refusal comes only when that wait expires.
/// C10 (capability publish:dialogs_seen): the dialogs the Studio showed while the publication was followed come back in
/// dialogsSeen, on success and on failure.
/// </summary>
internal static class PublishHandler
{
    private static readonly MethodInfo? pending = typeof(ServerProcess).GetMethods(BindingFlags.Static | BindingFlags.NonPublic)
        .SingleOrDefault(m => m.ReturnType == typeof(ServerProcess) && m.GetParameters() is { Length: 1 } ps
            && ps[0].ParameterType == typeof(IAggregatorPresenter));

    /// <summary>How long a successful publish waits for its tab to be idle before answering (capability publish:settled).</summary>
    internal static readonly TimeSpan SettleLimit = TimeSpan.FromSeconds(45);

    private static ServerProcess? Current(IAggregatorPresenter target) => pending?.Invoke(null, new object[] { target }) as ServerProcess
        ?? ServerProcess.GetStartedESpaceServerProcess(target);

    /// <summary>The server operation (publish, upload) of a module tab, for list_open_modules/get_active_module (C31):
    /// {running, verb, state}; null when there is none. UI thread.</summary>
    public static JsonObject? ServerOperation(IAggregatorPresenter target)
    {
        try
        {
            var process = Current(target);
            if (process == null) return null;
            return new JsonObject { ["running"] = process.CurrentState == ServerOperationState.Running,
                ["verb"] = process.ServerOperationVerb.ToString(), ["state"] = process.CurrentState.ToString() };
        }
        catch (Exception ex) { return new JsonObject { ["running"] = null, ["error"] = Server.Unwrap(ex) }; }
    }

    public static async Task<string> Publish(JsonObject? p)
    {
        var message = p?["message"]?.GetValue<string>() ?? "SSAM Hybrid: publish de prova";
        var timeout = p?["timeout"]?.GetValue<int>() ?? 300;
        var sw = Stopwatch.StartNew();
        var dialogsSeen = new List<string>();
        string name;
        IAggregatorPresenter aggregator;
        ServiceStudio.Model.ESpace module;
        ServerProcess? previous;
        Task command;
        ServerProcess? process = null;
        try
        {
            // C31: wait (inside timeout) for a server operation already running on this module; nothing was dispatched yet.
            while (true)
            {
                var (moduleName, moduleKey, runningVerb, blocked) = await Ui.Run(() =>
                {
                    var (agg, e) = Studio.Target(p);
                    Studio.RequireTarget(agg, e, p);
                    var running = Current(agg);
                    return (e.Name, e.Key.ToString(), running != null && running.CurrentState == ServerOperationState.Running ? running.ServerOperationVerb.ToString() : null, Dialogs.BlockedBy(agg));
                }, UiGate.Read, "publish: read the module");
                MergeRollbackProof.AddSeen(dialogsSeen, blocked);
                // Pattern 2 (2026-10-08): a headless publication of this module (environment session) in flight is waited for
                // like a server operation of the tab; two publications of one module never overlap.
                if (runningVerb == null && HeadlessPublications.Of(moduleKey, DateTime.UtcNow) != null) runningVerb = "HeadlessPublish";
                if (runningVerb == null) break;
                if (sw.Elapsed.TotalSeconds >= timeout)
                    return Server.Fail($"'{moduleName}' has a server operation running ({runningVerb}) that did not end within {timeout} s; nothing was published");
                await Task.Delay(500);
            }
            MethodInfo exec0;
            (name, aggregator, module, previous, exec0) = await Ui.Run(() =>
            {
                var (agg, e) = Studio.Target(p);
                Studio.RequireTarget(agg, e, p);
                if (!e.IsValid) throw new InvalidOperationException($"'{e.Name}' has TrueChange errors: fix them before publishing (get_errors)");
                var running = Current(agg);
                if (running != null && running.CurrentState == ServerOperationState.Running)
                    throw new InvalidOperationException($"'{e.Name}' already has a server operation running: {running.ServerOperationVerb}");
                var exec = typeof(ServiceStudio.Presenter.Commands.Publish)
                    .GetMethods(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)
                    .FirstOrDefault(m =>
                    {
                        var ps = m.GetParameters();
                        return ps.Length == 3 && typeof(IAggregatorPresenter).IsAssignableFrom(ps[0].ParameterType)
                               && typeof(IPresenter).IsAssignableFrom(ps[1].ParameterType) && ps[2].ParameterType == typeof(string)
                               && m.ReturnType == typeof(CommandResult);
                    }) ?? throw new InvalidOperationException("Publish.(IAggregatorPresenter, IPresenter, string) not found in this build");
                return (e.Name, agg, e, running, exec);
            }, UiGate.Read, "publish: prepare");
            // o comando de servidor recusa a UI thread ("Cannot execute in UI thread"): dispara num worker, como o Studio faz
            command = Task.Run(() =>
            {
                var instance = AutoRegistryType<ServiceStudio.Presenter.Commands.Publish>.Instance;
                var result = exec0.Invoke(instance, new object?[] { aggregator, aggregator, message }) as CommandResult;
                while (result?.Repeat == true)
                    result = exec0.Invoke(instance, new object?[] { aggregator, aggregator, message }) as CommandResult;
            });
            UiGate.MarkDispatched();
        }
        catch (Exception ex) { return Server.Fail(Server.Unwrap(ex)); }

        string? state = null;
        var lastDialogRead = TimeSpan.Zero;
        // C10 (capability publish:blocked_by_dialog): a blocking dialog (references, merge editor, recovery, web dialog) of this
        // module's tabs or any owned window, in three reads in a row, ends the wait with published:false and the dialog, the
        // rule of OpenHandler; before, the publication waited for it until its timeout (600 s, LF-04).
        var streak = new DialogScope.Streak();
        // MB2 (capability dialogs:dependencies_auto, asked with answer_dependencies:true): the dependencies dialog shown before
        // this publication's server process is closed as Cancel; a publication it cancelled answers PUBLISH_BLOCKED_BY_DIALOG,
        // not-started, with dependenciesDialog, and the caller refreshes the references and publishes again.
        var answerDependencies = p?["answer_dependencies"]?.GetValue<bool>() == true;
        var answeredDependencies = new JsonArray();
        TimeSpan? answeredAt = null;
        var uiBusy = false;
        while (sw.Elapsed.TotalSeconds < timeout)
        {
            await Task.Delay(100);
            try
            {
                if (command.IsFaulted) await command;
                // The dialogs are read about once a second: enough to see a sign-in or a confirmation the person answered.
                var readDialogs = sw.Elapsed - lastDialogRead >= TimeSpan.FromSeconds(1);
                if (readDialogs) lastDialogRead = sw.Elapsed;
                var (after, st, valid, blocked) = await Ui.Run(() =>
                {
                    var candidate = Current(aggregator);
                    if (candidate != null && candidate != previous && candidate != process)
                    {
                        process = candidate;
                        PublishLogHandler.RecordBridgeOperation(module.Key.ToString(), candidate.ServerOperationId);
                    }
                    if (process != null && process.ESpace.Key != module.Key)
                        throw new InvalidOperationException("Publish process belongs to another module; result is unknown");
                    return (module.LastUploadDateTime, process?.CurrentState.ToString(), module.IsValid, readDialogs ? Dialogs.BlockingModule(aggregator) : null);
                }, UiGate.Read, "publish: read the publication");
                MergeRollbackProof.AddSeen(dialogsSeen, blocked);
                if (answerDependencies && process == null && DialogScope.MayBeDependencies(blocked))
                {
                    var (closed, _) = await DependenciesDialog.Answer();
                    foreach (var entry in closed) answeredDependencies.Add(entry!.DeepClone());
                    if (closed.Count > 0) { answeredAt = sw.Elapsed; streak = new DialogScope.Streak(); blocked = null; }
                }
                if (answeredAt is { } at && DialogScope.AfterDependenciesAnswer(command.IsCompleted, process != null, sw.Elapsed - at) == "not-started")
                    return Server.Ok(DialogScope.PublishCancelledByDependencies(name, answeredDependencies, Seen(dialogsSeen), sw.ElapsedMilliseconds));
                if (!PublishConfirmation.Succeeded(st) && !PublishConfirmation.Failed(st) && streak.Observe(blocked) is { } stuck)
                    return Server.Ok(DialogScope.PublishBlocked(name, stuck, process != null, Seen(dialogsSeen), sw.ElapsedMilliseconds));
                state = st;
                if (command.IsCompleted && PublishConfirmation.Succeeded(st))
                {
                    // Pattern 1 (2026-10-08): the server says success before the tab has finished the publication on its own
                    // dispatcher. The answer waits (bounded, never on the UI thread) for the tab to be idle, so the next call
                    // (close_module above all) finds it settled. settled:false = still finishing; close_module then waits too.
                    var settle = Stopwatch.StartNew();
                    var settled = await AggregatorIdle.Wait(aggregator, SettleLimit);
                    return Server.Ok(new JsonObject { ["module"] = name, ["published"] = true, ["lastUploadDateTime"] = after.ToString("s"), ["state"] = st, ["isValid"] = valid,
                        ["elapsedMs"] = sw.ElapsedMilliseconds, ["dialogsSeen"] = Seen(dialogsSeen), ["settled"] = settled, ["settleMs"] = settle.ElapsedMilliseconds,
                        ["dependenciesDialog"] = answeredDependencies.Count > 0 ? new JsonObject { ["answered"] = answeredDependencies.DeepClone() } : null });
                }
                if (command.IsCompleted && PublishConfirmation.Failed(st))
                    return await Failed(name, aggregator, module, process, dialogsSeen);
                if (process == null && command.IsCompleted && sw.Elapsed.TotalSeconds > 20)
                    return Server.Fail($"publish: '{name}' has no observed publication process; completion is unknown. Reconcile the server version before retrying.");
            }
            // The publication was dispatched: a read the busy UI thread did not run is withdrawn and read again later; it never
            // turns this answer into "not executed".
            catch (UiBusyException) { uiBusy = true; UiGate.Forget(); }
            catch (Exception ex) { return Server.Fail(Server.Unwrap(ex)); }
        }
        return Server.Fail($"publish: '{name}' still {state ?? "pending"} after {timeout} s" + (uiBusy ? " (the Studio UI thread was busy; outcome unknown: read the publication before any retry)" : ""));
    }

    private static JsonArray Seen(List<string> dialogs) => new(dialogs.Select(d => (JsonNode)JsonValue.Create(d)!).ToArray());

    // The failure carries what the Studio shows in the 1-Click Publish tab of this process (PublishLogHandler): every
    // compilation/deployment message with type, text, element and stage. Server.Fail stays as it is (release overlay).
    private static async Task<string> Failed(string name, IAggregatorPresenter aggregator, ServiceStudio.Model.ESpace module, ServerProcess? process, List<string> dialogsSeen)
    {
        JsonObject? log = null;
        try { log = await Ui.Run(() => PublishLogHandler.Read(aggregator, module, process?.ServerOperationId, 200), UiGate.Read, "publish: read the messages"); }
        catch (Exception ex) { log = PublishLog.NotFound(name, module.Key.ToString(), null, "the publish messages could not be read: " + Server.Unwrap(ex)); }
        var first = (log["messages"] as JsonArray)?.OfType<JsonObject>().FirstOrDefault(m => m["type"]?.GetValue<string>() == "Error");
        var error = $"publish: '{name}' completed with failure; an upload is not a successful publication."
            + (first != null ? $" {first["stage"]} error: {first["text"]}" : " Check the server compilation/deployment messages.");
        return new JsonObject { ["success"] = false, ["data"] = new JsonObject { ["publishLog"] = log, ["dialogsSeen"] = Seen(dialogsSeen) }, ["error"] = error }.ToJsonString();
    }
}
