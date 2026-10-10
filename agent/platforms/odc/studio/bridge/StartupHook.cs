using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Avalonia.Threading;
using OutSystems.Model;
using OutSystems.Model.DependenciesProviders;
using OutSystems.Model.Enumerations;
using OutSystems.Model.Merge;
using OutSystems.ObjectKeys;
using ServiceStudio.Model;
using ServiceStudio.Framework.ReferencesManager;
using ServiceStudio.Presenter;
using ServiceStudio.Presenter.AddRemoveReferences;
using ServiceStudio.Presenter.Commands;
using ServiceStudio.ServerCommunications.API;
using ServiceStudio.ServerCommunications.API.Services.AssetManagement;
// The DTOs namespace declares its own Environment type, so its request type is qualified where used.
using BulkRevisionRequest = ServiceStudio.ServerCommunications.API.Services.AssetManagement.DTOs.BulkRevisionRequest;
using DataDtos = ServiceStudio.ServerCommunications.API.Services.Data.DTOs;

public static class StartupHook { public static void Initialize() => Bridge.Start(); }

// ODC3 generic resident bridge, version 1.
// Loaded once per Studio session through the .NET diagnostics startup hook. Every command is
// parameterized by a manifest file, never by constants compiled into this assembly.
// The bridge never initializes the ModelAPI runtime inside the Studio and never edits the open
// model directly: every mutation goes through the native CompareAndMerge with a hash-checked base
// and an immutable candidate, and every command appends one line to the operations journal.
internal static partial class Bridge {
    public const string Version = "v48";
    // A command that outlives its timeout is reported as uncertain and keeps running; the loop stays
    // available for status, and every other command is refused until the late command completes.
    private static volatile string? busyCommand;
    private static DateTimeOffset busySince;
    // The SSAM Hybrid-ODC repository root: SSAM_HYBRID_ODC_ROOT or ODC3_ROOT when set, otherwise found from this
    // assembly's location (studio\bridge\bin\Release\net8.0). A checkout is recognized by its studio folder and README.
    private static readonly string Root = ResolveRoot();
    private static string ResolveRoot() {
        foreach (var name in new[] { "SSAM_HYBRID_ODC_ROOT", "ODC3_ROOT" }) { var v = Environment.GetEnvironmentVariable(name); if (!string.IsNullOrWhiteSpace(v) && Directory.Exists(v)) return v; }
        var start = Path.GetDirectoryName(typeof(Bridge).Assembly.Location);
        for (var d = start; d != null; d = Path.GetDirectoryName(d)) if (Directory.Exists(Path.Combine(d, "studio")) && File.Exists(Path.Combine(d, "README.md"))) return d;
        return start ?? Environment.CurrentDirectory;
    }
    private static readonly string Snapshots = Path.Combine(Root, "snapshots");
    private static readonly Journal Log = new(Path.Combine(Root, "journal", "operations.jsonl"));
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
    // The catalog is read and copied by people and LLMs, so keys are written with '+' as is, never as +.
    private static readonly JsonSerializerOptions CatalogJson = new() { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private static readonly ConcurrentDictionary<string, DateTimeOffset> MergedAt = new();
    private static readonly ConcurrentDictionary<string, DateTimeOffset> PublishedAt = new();
    private static int started;

    private enum Mode { CheckBase, Preview, Merge, Reconcile }
    private sealed record ProviderState(string? Operations, string? Environment, bool Native);
    private sealed class Context {
        public string? Module, ModuleKey, BaseSha, CandidateSha, EvidenceDir, Feature;
        // Set by commands that answer a refusal instead of throwing (the portal lane), so the journal line tells the truth.
        public string? Outcome, GateName, Note;
        public bool HandedOff;
        // Informational dialogs and notice windows the watchdog closed while the command ran.
        public readonly List<object> Closed = new();
        public void Bind(Manifest m) { Module = m.Module; ModuleKey = m.ModuleKey; BaseSha = m.BaseSha256; CandidateSha = m.CandidateSha256; EvidenceDir = m.EvidenceDir; Feature = m.Feature; }
    }

    internal static void Start() {
        if (Interlocked.Exchange(ref started, 1) != 0) return;
        Directory.CreateDirectory(Snapshots);
        _ = Task.Run(Serve);
    }

    private static async Task Serve() {
        try {
            var running = true;
            while (running) {
                using var pipe = new NamedPipeServerStream("ODC3-Bridge-" + Version + "-" + Environment.ProcessId, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync();
                using var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen: true);
                using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
                var line = (await reader.ReadLineAsync() ?? "").Trim();
                var space = line.IndexOf(' ');
                var command = space < 0 ? line : line[..space];
                var argument = space < 0 ? "" : line[(space + 1)..].Trim();
                var start = DateTimeOffset.UtcNow;
                var context = new Context();
                object response; Exception? failure = null;
                if (command == "stop") { response = Stop(out running); }
                else if (busyCommand != null && command != "status" && command != "dismiss-dialog" && command != "auth-status" && command != "publish-log") {
                    failure = new InvalidOperationException("Command '" + busyCommand + "' is still running since " + busySince.ToString("o") + "; only status is accepted until it completes. Never retry it.");
                    response = new { ok = false, outcome = "gate_refused", gate = "studio_busy", error = failure.Message };
                } else {
                    var timeout = command switch { "query-test" => TimeSpan.FromMinutes(3), "merge" => TimeSpan.FromMinutes(15), "publish" => argument.Contains("--wait") ? TimeSpan.FromMinutes(20) : TimeSpan.FromMinutes(10), "wait" => TimeSpan.FromMinutes(20), "open" or "latest" => TimeSpan.FromMinutes(3), "check-base" or "preview" => TimeSpan.FromMinutes(5), "assets" or "consumers" or "reference-snapshot" or "templates" => TimeSpan.FromMinutes(2), "create" or "create-app" or "template-download" => TimeSpan.FromMinutes(3), "refresh-references" => TimeSpan.FromMinutes(5), "data" or "data-insert" or "data-update" or "data-delete" => TimeSpan.FromMinutes(3), "portal-call" or "portal-session" => TimeSpan.FromMinutes(3), "portal-upload" => TimeSpan.FromMinutes(13), _ => TimeSpan.FromMinutes(1) };
                    var work = Task.Run(() => Dispatch(command, argument, context));
                    // The watchdog closes informational dialogs and notice windows while the command runs, so a
                    // native command that ends with "Close" never holds the bridge. Choices are never made for the user.
                    // The portal lane opens no Studio dialog, so it never closes the user's.
                    var watchdog = command is "query-test" or "status" or "dismiss-dialog" or "auth-status" or "portal-call" or "portal-session" or "portal-upload" or "publish-log" ? Task.CompletedTask : WatchDialogs(work, context);
                    if (await Task.WhenAny(work, Task.Delay(timeout)) == work) {
                        try { response = await work; }
                        catch (Exception error) {
                            failure = error;
                            // A publication that ended without success answers every message of its log (publish-log), not only the state.
                            // The answer carries the message, never the .NET stack trace (last-error.json keeps it as evidence); an
                            // uncertain merge also lists each divergence of the comparison (element, property, local, candidate).
                            response = error is PublishFailedException failedPublish
                                ? new { ok = false, outcome = Journal.Outcome(error, context.HandedOff), gate = Journal.Gate(error.Message), error = error.Message, dialogsClosed = context.Closed.ToArray(), publishLog = failedPublish.PublishLog }
                                : error is MergeDiagnostics.MergeUncertainException uncertain
                                ? new { ok = false, outcome = Journal.Outcome(error, context.HandedOff), gate = Journal.Gate(error.Message), error = uncertain.Detailed, divergences = uncertain.Divergences, dialogsClosed = context.Closed.ToArray() }
                                : (object)new { ok = false, outcome = Journal.Outcome(error, context.HandedOff), gate = Journal.Gate(error.Message), error = MergeDiagnostics.Answer(error), dialogsClosed = context.Closed.ToArray() };
                            // G-3 (C16): a merge that failed after CompareAndMerge took the candidate is integrated in the open
                            // module: the answer says merged:true (equal:false), so nobody repeats it.
                            if (command == "merge" && context.HandedOff && JsonSerializer.SerializeToNode(response) is JsonObject handed) {
                                handed["merged"] = true; handed["equal"] = false; handed["equivalence"] = "uncertain";
                                response = handed;
                            }
                            if (context.EvidenceDir != null) {
                                // Same fields as the answer (friction ingest reads them), plus the stack for whoever reads the evidence.
                                var evidence = JsonSerializer.SerializeToNode(response) as JsonObject ?? new JsonObject();
                                evidence["stack"] = error.ToString();
                                TryWrite(Path.Combine(context.EvidenceDir, "last-error.json"), evidence.ToJsonString(Json));
                            }
                        }
                    } else {
                        busyCommand = command; busySince = start;
                        object[] openDialogs = Array.Empty<object>(), openWindows = Array.Empty<object>();
                        try { openDialogs = DescribeDialogs(await Ui(Dialogs)); openWindows = DescribeWindows(await Ui(ModalWindows)); } catch { }
                        failure = new TimeoutException("Command '" + command + "' is still running after " + timeout + "; it was not cancelled. Poll status; do not retry. Open dialogs: " + JsonSerializer.Serialize(openDialogs) + "; modal windows: " + JsonSerializer.Serialize(openWindows) + ". A dialog with a choice must be closed with dismiss-dialog <caption>|<action>.");
                        response = new { ok = false, outcome = "uncertain", gate = "studio_busy", error = failure.Message, openDialogs, openWindows, dialogsClosed = context.Closed.ToArray() };
                        var late = start; var lateContext = context; var lateCommand = command;
                        _ = work.ContinueWith(t => {
                            busyCommand = null;
                            var lateFailure = t.Exception?.GetBaseException();
                            Log.Append(new Journal.Entry(late.ToString("o"), DateTimeOffset.UtcNow.ToString("o"), "studio-" + Environment.ProcessId, "bridge", lateCommand + "-late",
                                lateContext.Module, lateContext.ModuleKey, lateContext.BaseSha, lateContext.CandidateSha, Environment.ProcessId, null,
                                Journal.Outcome(lateFailure, lateContext.HandedOff), lateFailure == null ? "none" : Journal.Gate(lateFailure.Message), lateContext.EvidenceDir, lateFailure?.Message, "live", lateContext.Feature));
                            if (lateContext.EvidenceDir != null) TryWrite(Path.Combine(lateContext.EvidenceDir, lateFailure == null ? "late-result.json" : "last-error.json"), lateFailure == null ? t.Result : new { ok = false, error = lateFailure.ToString() });
                        }, TaskScheduler.Default);
                    }
                }
                var note = failure?.Message ?? context.Note ?? (context.Closed.Count > 0 ? "watchdog closed " + context.Closed.Count + " dialog(s): " + JsonSerializer.Serialize(context.Closed) : null);
                Log.Append(new Journal.Entry(start.ToString("o"), DateTimeOffset.UtcNow.ToString("o"), "studio-" + Environment.ProcessId, "bridge", command,
                    context.Module, context.ModuleKey, context.BaseSha, context.CandidateSha, Environment.ProcessId, null,
                    failure is TimeoutException ? "uncertain" : failure == null && context.Outcome != null ? context.Outcome : Journal.Outcome(failure, context.HandedOff),
                    failure == null ? context.GateName ?? "none" : failure is TimeoutException ? "studio_busy" : Journal.Gate(failure.Message), context.EvidenceDir, note, "live", context.Feature));
                await writer.WriteLineAsync(JsonSerializer.Serialize(response));
            }
        } catch (Exception error) {
            TryWrite(Path.Combine(Root, "journal", "bridge-server-error-" + Environment.ProcessId + ".txt"), error.ToString());
        }
    }

    private static object Stop(out bool running) { running = false; return new { ok = true, stopped = true }; }

    private static async Task<object> Dispatch(string command, string argument, Context context) => command switch {
        "query-test" => await QueryTest(argument, context),
        "status" => await Ui(() => StatusView(argument)),
        "wait" => await Wait(argument, context),
        "authorize" => await Ui(() => Authorize(argument, context)),
        "open" => await Open(argument, context),
        "snapshot" => await Ui(() => Snapshot(argument, context)),
        "latest" => await Latest(argument, context),
        "check-base" => await InContext(argument, context, Mode.CheckBase),
        "preview" => await InContext(argument, context, Mode.Preview),
        "merge" => await InContext(argument, context, Mode.Merge),
        "reconcile-merge" => await InContext(argument, context, Mode.Reconcile),
        "publish" => await Publish(argument, context),
        "publish-status" => await Ui(() => PublishStatus(argument, context)),
        "publish-log" => await PublishLog(argument, context),
        "dismiss-dialog" => await DismissDialog(argument, context),
        "close" => await Close(argument, context),
        "module-info" => await Ui(() => ModuleInfo(argument, context)),
        "assets" => await Assets(argument, context),
        "consumers" => await Consumers(argument, context),
        "create" => await Create(argument, context),
        "create-app" => await CreateApp(argument, context),
        "templates" => await Templates(argument, context),
        "template-download" => await TemplateDownload(argument, context),
        "refresh-references" => await RefreshReferences(argument, context),
        "reference-snapshot" => await ReferenceSnapshot(argument, context),
        "data" => await Data("read", argument, context),
        "data-insert" => await Data("insert", argument, context),
        "data-update" => await Data("update", argument, context),
        "data-delete" => await Data("delete", argument, context),
        "portal-call" => await PortalCall(argument, context),
        "portal-session" => await PortalSessionCommand(argument, context),
        "portal-upload" => await PortalUploadCommand(argument, context),
        "auth-status" => await AuthStatus(argument, context),
        _ => throw new ArgumentException("Commands: status [brief|<field.path>] | wait idle|no-dialogs|published <Module>|open <Module> [timeoutSeconds] | authorize <manifest> publish|create <text> | assets [tenant] [--no-catalog] | consumers <Module|key> | open <Module|key> [local.oml] | close <Module> [--duplicates] [--discard] | snapshot <Module> | latest <Module|key> | module-info <Module> | reference-snapshot <json: module, producer, output> | refresh-references <Module> [--producer <Library|key>] | check-base <manifest> | preview <manifest> | merge <manifest> | create <manifest> | create-app <manifest> | templates [--kind reactive|mobile|all] [--tenant <host>] | template-download <templateKey> [--tenant <host>] | publish <manifest> [--wait [minutes]] | publish-status <manifest> | publish-log [<Module|key>] [--no-resolve] | dismiss-dialog <caption>|<action label> | data <Module> <Entity> [--limit N] [--offset N] [--fields A,B] [--out file] | data-insert|data-update <Module> <Entity> --records-file <json array> --authorize <text> | data-delete <Module> <Entity> --ids <id,id> --authorize <text> | portal-call <request.json> [--tenant <host>] | portal-session status|open|close [--tenant <host>] | portal-session fetch <request.json> [--tenant <host>] | portal-upload <request.json> --tenant <host> | auth-status [--tenant <host>] | stop")
    };

    // ---- Watchdog: informational dialogs are closed, choices are reported, everything is journaled.
    private static readonly string[] InformationalLabels = { "Close", "OK", "Ok", "Fechar" };
    private static async Task WatchDialogs(Task work, Context c) {
        while (!work.IsCompleted) {
            await Task.WhenAny(work, Task.Delay(750));
            if (work.IsCompleted) return;
            try { await CloseInformational(c); } catch (Exception error) { c.Closed.Add(new { error = error.Message }); }
        }
    }
    // A presenter dialog whose only enabled labeled action is Close/OK, or an owned window whose only enabled
    // labeled informational action is Close/OK carries no decision. Window chrome and blank windows are never dismissed.
    private static async Task<object[]> CloseInformational(Context c) {
        var closed = new List<object>();
        foreach (var d in await Ui(Dialogs)) {
            var enabled = d.Actions.Where(a => a.Enabled && !string.IsNullOrWhiteSpace(a.Label)).ToArray();
            if (enabled.Length != 1 || !InformationalLabels.Contains(enabled[0].Label!.Trim())) continue;
            var record = new { at = DateTimeOffset.UtcNow, caption = d.Caption, d.Message, action = enabled[0].Label, closedBy = "watchdog" };
            TryWrite(Path.Combine(Root, "journal", "dialog-" + DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmssfff") + ".json"), record);
            try { await DismissDialog(d.Caption + "|" + enabled[0].Label, new Context()); closed.Add(record); c.Closed.Add(record); }
            catch (Exception error) { c.Closed.Add(new { record.caption, error = error.Message }); }
        }
        foreach (var w in await Ui(ModalWindows)) {
            var enabled = w.Buttons.Where(b => b.Enabled).ToArray();
            if (w.IsMain || string.IsNullOrWhiteSpace(w.Title) || w.Texts.Length == 0
                || enabled.Length != 1 || !InformationalLabels.Contains(enabled[0].Text.Trim())) continue;
            var record = new { at = DateTimeOffset.UtcNow, window = w.Title, texts = w.Texts, button = enabled[0].Text, closedBy = "watchdog" };
            TryWrite(Path.Combine(Root, "journal", "dialog-" + DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmssfff") + ".json"), record);
            try { await DismissDialog(w.Title + "|" + enabled[0].Text, new Context()); closed.Add(record); c.Closed.Add(record); }
            catch (Exception error) { c.Closed.Add(new { record.window, error = error.Message }); }
        }
        return closed.ToArray();
    }

    // ---- wait: one blocking call instead of a polling loop of client processes.
    // Usage: wait idle | no-dialogs | published <Module> | open <Module>   [timeoutSeconds, default 600]
    private static object[] ServerProcesses(IAggregatorPresenter p) => p.BottomPanePresenter.ChildPresenters.OfType<IServerMessagesPanePresenter>().Select(i => i.ServerProcess).Where(i => i != null).Select(i => (object)new { state = i!.CurrentState.ToString(), operation = i.ServerOperationType.ToString() }).ToArray();
    private static bool Running(object[] processes) => processes.Any(x => Member(x, "state")?.ToString() == "Running");
    private static async Task<object> Wait(string argument, Context c) {
        var parts = argument.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        Require(parts.Length >= 1, "wait requires a condition: idle | no-dialogs | published <Module> | open <Module> [timeoutSeconds].");
        var condition = parts[0];
        var needsModule = condition is "published" or "open";
        Require(!needsModule || parts.Length >= 2, "wait " + condition + " requires a module name.");
        var module = needsModule ? parts[1] : null; c.Module = module;
        var timeoutSeconds = int.TryParse(parts.LastOrDefault(), out var t) && parts.Length > (needsModule ? 2 : 1) ? t : 600;
        var started = DateTimeOffset.UtcNow; var seenRunning = false; object? state = null;
        while (true) {
            await CloseInformational(c);
            state = await Ui(() => {
                var choices = Dialogs().Where(d => d.Actions.Any(a => a.Enabled)).Select(d => (object)new { d.Caption, actions = d.Actions.Select(a => a.Label) }).ToArray();
                var windows = DescribeWindows(ModalWindows());
                var aggregators = RuntimeImplementation.Instance.Aggregators.Where(a => a.ActiveESpace != null).ToArray();
                var running = aggregators.Where(a => Running(ServerProcesses(a))).Select(a => a.ActiveESpace!.Name).ToArray();
                var target = module == null ? null : aggregators.FirstOrDefault(a => a.ActiveESpace!.Name == module || a.ActiveESpace.Key.ToString() == module);
                var targetProcesses = target == null ? Array.Empty<object>() : ServerProcesses(target);
                var satisfied = condition switch {
                    "idle" => choices.Length == 0 && windows.Length == 0 && running.Length == 0,
                    "no-dialogs" => choices.Length == 0 && windows.Length == 0,
                    "published" => target != null && !Running(targetProcesses) && (seenRunning || (DateTimeOffset.UtcNow - started).TotalSeconds > 10),
                    "open" => target != null,
                    _ => throw new ArgumentException("Unknown wait condition: " + condition)
                };
                if (module != null && target != null && Running(targetProcesses)) seenRunning = true;
                return new { satisfied, choices, windows, running, module, targetOpen = target != null, targetProcesses };
            });
            if (Member(state, "satisfied") is true) break;
            if ((DateTimeOffset.UtcNow - started).TotalSeconds > timeoutSeconds)
                throw new InvalidOperationException("Studio did not become '" + condition + (module == null ? "" : " " + module) + "' within " + timeoutSeconds + " s. State: " + JsonSerializer.Serialize(state));
            await Task.Delay(1000);
        }
        return new { ok = true, condition, module, seconds = Math.Round((DateTimeOffset.UtcNow - started).TotalSeconds, 1), state, dialogsClosed = c.Closed.ToArray() };
    }

    // ---- status views: the whole object, a brief summary, or one field by dotted path.
    private static object StatusView(string argument) {
        var full = Status();
        if (argument == "") return full;
        var node = JsonSerializer.SerializeToNode(full)!;
        if (argument == "brief") {
            var dialogs = node["dialogs"]!.AsArray().Where(d => d!["actions"]!.AsArray().Count > 0).Select(d => d!["caption"]!.ToString()).ToArray();
            var modules = node["modules"]!.AsArray().Select(m => (object)new { name = m!["name"]!.ToString(), modified = (bool)m["modified"]!, mergePending = (bool)m["mergePending"]!, lastPublish = m["lastPublish"]?.DeepClone() }).ToArray();
            return new { ok = true, bridge = Version, capabilities = Capabilities, root = Root, busy = node["busy"], catalog = node["catalog"], dialogsWithChoices = dialogs, modalWindows = node["modalWindows"]!.AsArray().Count, modules };
        }
        JsonNode? current = node;
        foreach (var part in argument.Split('.')) current = int.TryParse(part, out var index) && current is JsonArray array ? (index < array.Count ? array[index] : null) : current?[part];
        return new { ok = true, field = argument, value = current };
    }

    // ---- authorize: records the user's words in the manifest instead of hand-editing JSON.
    // Usage: authorize <manifest> publish|create <text...>
    private static object Authorize(string argument, Context c) {
        var parts = argument.Split(' ', 3, StringSplitOptions.RemoveEmptyEntries);
        Require(parts.Length == 3 && parts[1] is "publish" or "create", "authorize requires: <manifest> publish|create <the user's authorization text>.");
        var path = Path.GetFullPath(parts[0]);
        var node = JsonNode.Parse(File.ReadAllText(path)) as JsonObject ?? throw new InvalidOperationException("Manifest is not a JSON object: " + path);
        var field = parts[1] == "publish" ? "publishAuthorization" : "createAuthorization";
        var text = parts[2].Trim() + " [recorded " + DateTimeOffset.UtcNow.ToString("o") + " by bridge " + Version + "]";
        node[field] = text;
        File.WriteAllText(path, node.ToJsonString(CatalogJson));
        try { c.Bind(Manifest.Load(path)); } catch { }
        return new { ok = true, manifest = path, field, text };
    }

    private sealed record ModuleCapture(byte[] Bytes, string Sha256, string[] Dependencies, bool Modified);
    private static ModuleCapture Capture(ESpace s) {
        using var stream = s.SaveToMemoryStream(); var bytes = stream.ToArray();
        return new ModuleCapture(bytes, Hash(bytes), ((IESpace)s).Dependencies.Select(d => d.Name + " r" + d.Revision).ToArray(), s.WasModifiedSinceLastSave);
    }
    // Public action signatures a reference exposes, with their output count, to show what a refresh brought in.
    private static object[] ReferenceActions(ESpace s, string producerName) {
        var reference = ((IESpace)s).Dependencies.FirstOrDefault(d => d.Name == producerName);
        if (reference == null) return Array.Empty<object>();
        var found = new List<object>();
        var stack = new Stack<IModelObject>(); stack.Push(reference);
        while (stack.Count > 0) {
            var node = stack.Pop();
            if (node is OutSystems.Model.Logic.IActionSignature signature) found.Add(new { name = node.DisplayName, inputs = signature.InputParameters.Count(), outputs = signature.OutputParameters.Count(), outputNames = signature.OutputParameters.Select(o => o.DisplayName).ToArray() });
            foreach (var child in node.Children) stack.Push(child);
        }
        return found.ToArray();
    }

    // Refreshes the dependencies of an open module through the Studio's own paths. Without --producer it runs the
    // module menu command "Check for dependency updates": app-to-app references are refreshed and library updates are
    // only notified, as ODC does. With --producer <Library> the library reference is updated to the latest published
    // revision the way the Library Updates panel does (RefreshSpecificReferencesByKey with revision and model digest).
    // A capture before and after, compared with the native MatchTree, proves that only references changed.
    // Usage: refresh-references <Module> [--producer <Library|key>]
    private static async Task<object> RefreshReferences(string argument, Context c) {
        var parts = argument.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        Require(parts.Length >= 1, "refresh-references requires a module name, optionally --producer <Library|key>.");
        var module = parts[0];
        var producerIndex = Array.IndexOf(parts, "--producer");
        var producer = producerIndex >= 0 && producerIndex + 1 < parts.Length ? parts[producerIndex + 1] : null;
        await CloseInformational(c);
        var blocking = await Ui(ModalWindows);
        Require(blocking.Length == 0, "A Studio dialog with a choice is open; dismiss it first with dismiss-dialog <title>|<button>. Modal windows: " + JsonSerializer.Serialize(DescribeWindows(blocking)));
        var p = await Ui(() => Active(module));
        var s = p.ActiveESpace; c.Module = s.Name; c.ModuleKey = s.Key.ToString();
        var before = await Ui(() => { Require(s.Match == null, "Pending merge exists in " + s.Name + "; refresh refused."); Require(p.ServerCommunicationsProvider.IsLoggedIn, "The module's session is not signed in."); return Capture(s); });
        var startedAt = DateTimeOffset.UtcNow;
        object answer; string mode; string? producerName = null; object? producerAsset = null;
        if (producer == null) {
            mode = "check-updates";
            var done = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            var queued = p.ExecuteInContext(() => {
                try { var result = AutoRegistryType<AddRemoveReferencesCommands.RefreshDependenciesFromModuleMenu>.Instance.Execute(p, p); done.SetResult(result?.ToString() ?? "null"); }
                catch (Exception error) { done.SetException(error); }
            }, executeWhenTopLevelIsIdle: true);
            // The command ends with an informational dialog "Refresh of library dependencies" whose only action is
            // Close; the command does not return until it is closed. The watchdog closes it and journals its text.
            // Proven on 2026-09-16: the refresh itself had taken the reference from r0 to r3 before the dialog appeared.
            await queued;
            answer = new { result = await done.Task, dialogsClosed = c.Closed.ToArray() };
        } else {
            mode = "library-update";
            var key = await Ui(() => ResolveKey(producer, Host(p)));
            var provider = (IServerCommunicationsServicesProvider)p.ServerCommunicationsProvider;
            var asset = provider.AssetManagementService.GetAssetInfo(new RevisionRequest(RevisionRequestType.Latest, key));
            Require(asset != null, "The server returned no asset for " + producer + " (key " + key + ").");
            producerName = asset!.Name;
            producerAsset = new { asset.Name, key = key.ToString(), asset.Revision, modelDigest = asset.ModelDigest?.ToString(), asset.AssetType, revisionBy = asset.RevisionUserName };
            var referenced = await Ui(() => s.References.FirstOrDefault(r => r.ReferenceKey.ToString() == key.ToString()));
            Require(referenced != null, s.Name + " does not reference " + asset.Name + " (key " + key + "); refresh applies only to an existing reference.");
            var request = new Dictionary<string, RevisionWithModelDigest> { { key.ToString(), new RevisionWithModelDigest { Revision = asset.Revision.ToString(), ModelDigest = asset.ModelDigest?.ToString() } } };
            var done = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            await p.ExecuteInContext(() => {
                try { var refreshed = ReferencesManagerServiceProvider.GetInstance(provider).RefreshSpecificReferencesByKey(p, s, request); done.SetResult(new { refreshed, targetRevision = asset.Revision }); }
                catch (Exception error) { done.SetException(error); }
            }, executeWhenTopLevelIsIdle: true);
            answer = await done.Task;
        }
        var after = await Ui(() => Capture(s));
        var stamp = DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmss");
        var dumpPath = Path.Combine(Root, "journal", "refresh-" + s.Name + "-" + stamp + ".txt");
        var (outside, refreshed) = await Ui(() => {
            using var basis = Load(before.Bytes);
            using var tree = new MatchTree(s, basis, basis, false, true);
            TryWrite(dumpPath, tree.Dump());
            return DifferencesOutsideReferences(tree, s, includeNonVisible: true);
        });
        var actions = producerName == null ? Array.Empty<object>() : await Ui(() => ReferenceActions(s, producerName));
        var receipt = new {
            ok = true, module = s.Name, moduleKey = c.ModuleKey, mode, producer = producerAsset, answer, startedAt, completedAt = DateTimeOffset.UtcNow,
            changed = before.Sha256 != after.Sha256, sha256Before = before.Sha256, sha256After = after.Sha256, modifiedBefore = before.Modified, modifiedAfter = after.Modified,
            dependenciesBefore = before.Dependencies, dependenciesAfter = after.Dependencies,
            refreshedReferences = refreshed, differencesOutsideReferences = outside, producerActions = actions, dump = dumpPath,
            note = outside.Length == 0 ? "Only references changed; capture a new snapshot before building the next candidate." : "Differences outside references were found; inspect the dump before trusting this module state."
        };
        TryWrite(Path.Combine(Root, "journal", "refresh-" + s.Name + "-" + stamp + ".json"), receipt);
        Require(outside.Length == 0, "Refresh changed the module outside its references: " + string.Join("; ", outside.Take(10)) + ". Dump: " + dumpPath);
        return receipt;
    }

    // Creates a new asset in the tenant from a whole-module candidate, through the native
    // AssetManagementService.CreateAsset that the Studio's own "New application" flow and Publish use.
    // Gates: creation manifest, explicit authorization text, candidate hash and validation, identity, the name
    // free in the live tenant listing, one attempt per evidence directory. The upload is a revision, not a
    // deployment: open the module from the organization and publish it with its own authorization.
    private static async Task<object> Create(string manifestPath, Context c) {
        var m = Manifest.Load(manifestPath); c.Bind(m);
        Require(m.Create, "create requires a manifest produced by 'ODC3.Builder new'.");
        Require(!string.IsNullOrWhiteSpace(m.CreateAuthorization), "create requires manifest.createAuthorization with the user's explicit authorization text.");
        Directory.CreateDirectory(m.EvidenceDir);
        Require(!File.Exists(Path.Combine(m.EvidenceDir, "create-started.json")), "An asset creation was already attempted in this evidence directory; inspect its receipt, never retry here.");
        var top = await Ui(() => Top(m.Tenant));
        var provider = (IServerCommunicationsServicesProvider)top.ServerCommunicationsProvider;
        var host = top.ServerCommunicationsProvider.LoginInfo.HostInfo.Hostname;
        var bytes = m.ReadCandidate();
        using (var candidate = Load(bytes)) {
            Require(candidate.Name == m.Module && candidate.Key.ToString() == m.ModuleKey, "Candidate identity " + candidate.Name + " " + candidate.Key + " differs from the manifest " + m.Module + " " + m.ModuleKey + ".");
            var errors = Errors(candidate);
            File.WriteAllText(Path.Combine(m.EvidenceDir, "candidate-validation.json"), JsonSerializer.Serialize(new { errors, messages = Messages(candidate) }, Json));
            Require(errors.Length == 0, "Candidate has validation errors: " + string.Join(" | ", errors));
        }
        var (assets, _) = ListAssets(provider);
        var taken = assets.Where(a => string.Equals(a.Name, m.Module, StringComparison.OrdinalIgnoreCase)).Select(a => a.Name + " (" + a.AssetType + ", key " + ObjectKey.NewKey(a.AssetKey) + ")").ToArray();
        Require(taken.Length == 0, "An asset named " + m.Module + " already exists in " + host + ": " + string.Join(", ", taken) + ". Module creation never shadows an existing asset.");
        TryWrite(Path.Combine(m.EvidenceDir, "create-started.json"), new { at = DateTimeOffset.UtcNow, pid = Environment.ProcessId, module = m.Module, moduleKey = m.ModuleKey, tenant = host, authorization = m.CreateAuthorization, candidateSha256 = m.CandidateSha256, assetsListed = assets.Length });
        c.HandedOff = true;
        var info = provider.AssetManagementService.CreateAsset(bytes, new CreateAssetRevisionOptions { SkipSequentialVersionValidation = true });
        Require(info != null, "CreateAsset returned no asset info for " + m.Module + ".");
        var receipt = new {
            ok = true, created = true, merged = false, module = m.Module, moduleKey = m.ModuleKey, tenant = host,
            assetKey = ObjectKey.NewKey(info!.AssetKey).ToString(), assetName = info.Name, assetType = info.AssetType.ToString(), revision = info.Revision, revisionBy = info.RevisionUserName, revisionAt = info.RevisionDateTime.ToString("o"),
            sha256 = m.CandidateSha256, publishInvoked = false, completedAt = DateTimeOffset.UtcNow,
            note = "Asset revision uploaded, not deployed. Open the module from the organization and publish it with explicit authorization."
        };
        File.WriteAllText(Path.Combine(m.EvidenceDir, "receipt.json"), JsonSerializer.Serialize(receipt, Json));
        object catalog;
        try { catalog = await Assets(host, new Context()); } catch (Exception error) { catalog = new { error = error.Message }; }
        return new { receipt.ok, receipt.created, receipt.module, receipt.moduleKey, receipt.assetKey, receipt.assetName, receipt.assetType, receipt.revision, receipt.revisionBy, receipt.sha256, receipt.note, catalog = catalog is { } cat ? Member(cat, "catalog") : null };
    }

    private const DifferenceType OwnDifference = DifferenceType.Different | DifferenceType.AddedToLocal | DifferenceType.AddedToForeign | DifferenceType.RemovedFromLocal | DifferenceType.RemovedFromForeign | DifferenceType.ChangedInLocal | DifferenceType.ChangedInForeign | DifferenceType.Conflict;

    // Differences of a native comparison that lie outside the module's references. The Studio refreshes references
    // from the server when a module is opened from the organization or merged with a new dependency, so a difference
    // confined to a reference is that native refresh, not a deviation of content. Everything else is reported by path.
    // includeNonVisible also counts property changes the Studio hides from the merge view (reference revisions,
    // signature hashes), which is what a dependency refresh mostly changes.
    private static (string[] Outside, string[] RefreshedReferences) DifferencesOutsideReferences(MatchTree tree, ESpace local, bool includeNonVisible = false) {
        var references = new HashSet<object>(((IESpace)local).Dependencies.Cast<object>(), ReferenceEqualityComparer.Instance);
        static bool LooksLikeReference(AbstractObject? o) => o != null && o.GetType().Name is "Reference" or "ESpaceReference";
        Match? ReferenceOf(Match m) { for (var x = m; x != null; x = x.Parent) if (x.AnyObject != null && (references.Contains(x.AnyObject) || LooksLikeReference(x.AnyObject))) return x; return null; }
        static string PathOf(Match m) { var parts = new List<string>(); for (var x = m; x != null; x = x.Parent) parts.Add(x.AnyObject?.DisplayName ?? "?"); parts.Reverse(); return string.Join("/", parts); }
        var outside = new List<string>(); var refreshed = new HashSet<string>();
        foreach (var match in tree.GetMatches(x => ((includeNonVisible ? x.Difference : x.VisibleDifference) & OwnDifference) != 0).ToArray()) {
            var reference = ReferenceOf(match);
            if (reference != null) refreshed.Add(reference.AnyObject!.DisplayName);
            else outside.Add(PathOf(match) + " [" + match.VisibleDifference + "]");
        }
        return (outside.ToArray(), refreshed.Order().ToArray());
    }

    private static (AssetInfo[] Assets, string KindsUsed) ListAssets(IServerCommunicationsServicesProvider provider) {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        try {
            return (provider.AssetManagementService.GetAssetInfos(new BulkRevisionRequest { FilterDisallowedAssets = true, Kinds = AssetTypeHelper.ValidAssetTypes, Embeds = AssetManagementServiceConstants.NoEmbed, CancellationToken = timeout.Token }).ToArray(), "ValidAssetTypes");
        } catch (Exception first) {
            // The native Open dialog asks only for the kinds a Studio can open; fall back to exactly that request.
            return (provider.AssetManagementService.GetAssetInfos(new BulkRevisionRequest { FilterDisallowedAssets = true, Kinds = AssetTypeHelper.AssetTypesWithoutExtensions, Embeds = AssetManagementServiceConstants.NoEmbed, CancellationToken = timeout.Token }).ToArray(), "AssetTypesWithoutExtensions (ValidAssetTypes failed: " + first.GetBaseException().Message + ")");
        }
    }

    // Lists the published consumers of a module through the native AssetManagementService.GetConsumers, so a
    // change to a producer is planned with its consumers known before any merge or publication.
    private static async Task<object> Consumers(string module, Context c) {
        Require(module != "", "consumers requires a module name or key.");
        var (top, key, openKeys) = await Ui(() => { var t = TopAny(); return (t, ResolveKey(module, Host(t)), RuntimeImplementation.Instance.Aggregators.Where(a => a.ActiveESpace != null).Select(a => a.ActiveESpace!.Key.ToString()).ToHashSet()); });
        c.Module = module; c.ModuleKey = key.ToString();
        var provider = (IServerCommunicationsServicesProvider)top.ServerCommunicationsProvider;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        var consumers = provider.AssetManagementService.GetConsumers(key, null, timeout.Token)
            .Select(x => new { name = x.Name, key = x.Key?.ToString(), kind = Kind(x.AssetType), assetType = x.AssetType.ToString(), open = x.Key != null && openKeys.Contains(x.Key.ToString()) })
            .OrderBy(x => x.name, StringComparer.OrdinalIgnoreCase).ToArray();
        var result = new { ok = true, module, moduleKey = key.ToString(), tenant = top.ServerCommunicationsProvider.LoginInfo.HostInfo.Hostname, listedAt = DateTimeOffset.UtcNow.ToString("o"), source = "AssetManagementService.GetConsumers", count = consumers.Length, consumers };
        File.WriteAllText(Path.Combine(Snapshots, module + "-consumers.json"), JsonSerializer.Serialize(result, CatalogJson));
        return result;
    }

    // Lists the assets of a signed-in tenant through the same native service the Studio's Open dialog uses
    // (AssetManagementService.GetAssetInfos) and rewrites that tenant's section of snapshots\modules.json from
    // the listing. The catalog is therefore what the server returned, never an inventory a session assumed.
    // Usage: assets [tenant-host] [--no-catalog]
    private static async Task<object> Assets(string argument, Context c) {
        var parts = argument.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var requested = parts.FirstOrDefault(x => !x.StartsWith("--"));
        var updateCatalog = !parts.Contains("--no-catalog");
        var top = await Ui(() => requested != null ? Top(requested) : TopAny());
        var host = top.ServerCommunicationsProvider.LoginInfo.HostInfo.Hostname;
        var provider = (IServerCommunicationsServicesProvider)top.ServerCommunicationsProvider;
        var (infos, kindsUsed) = ListAssets(provider);
        var converter = FindStatic("ToModuleInfoMetadata", p => p.Length == 1 && p[0].ParameterType == typeof(AssetInfo));
        var assets = infos.Select(a => {
            object? info = null; try { info = converter?.Invoke(null, new object[] { a }); } catch { }
            object? M(string name) => info == null ? null : Member(info, name);
            var key = M("Key")?.ToString() ?? ObjectKey.NewKey(a.AssetKey).ToString();
            return new {
                name = a.Name, key, kind = Kind(a.AssetType), assetType = a.AssetType.ToString(), moduleKind = M("Kind")?.ToString(),
                revision = a.Revision, revisionBy = a.RevisionUserName, revisionAt = a.RevisionDateTime.ToString("o"),
                applicationKey = M("ApplicationKey")?.ToString(), applicationName = M("ApplicationName")?.ToString(),
                isolated = M("ApplicationIsIsolated") is true, versionId = M("VersionId") is int v ? v : (int?)null,
                isExternal = a.IsExternal, description = a.Description
            };
        }).OrderBy(x => x.name, StringComparer.OrdinalIgnoreCase).ToArray();
        var listedAt = DateTimeOffset.UtcNow.ToString("o");
        var listing = new { ok = true, tenant = host, listedAt, count = assets.Length, source = "AssetManagementService.GetAssetInfos", kindsUsed, assets };
        File.WriteAllText(Path.Combine(Snapshots, "assets-" + host + ".json"), JsonSerializer.Serialize(listing, CatalogJson));
        object? catalog = null;
        if (updateCatalog) catalog = UpdateCatalog(host, listedAt, assets.Select(a => (a.name, a.key, a.kind, a.assetType, a.revision, (string?)a.revisionBy)).ToArray());
        return new { ok = true, tenant = host, listedAt, count = assets.Length, kindsUsed, catalog, assets = assets.Select(a => new { a.name, a.key, a.kind, a.assetType, a.revision, a.revisionBy }).ToArray() };
    }
    private static string Kind(AssetType t) => t switch {
        AssetType.WebApplication or AssetType.MobileApplication => "app",
        AssetType.Agent => "agent",
        AssetType.LowCodeLibrary or AssetType.MobileLibrary or AssetType.ExtensionLibrary or AssetType.WidgetLibrary or AssetType.ExternalLibrary => "library",
        _ => t.ToString()
    };
    // The catalog tenant when the Studio holds a session on it; otherwise the only signed-in session.
    private static ITopLevelPresenter TopAny() {
        try { return Top(); } catch (InvalidOperationException) {
            var any = RuntimeImplementation.Instance.GetAllTopLevelPresenters().Where(p => p.ServerCommunicationsProvider?.IsLoggedIn == true).ToArray();
            Require(any.Length == 1, "No session on the catalog tenant and " + any.Length + " other sessions; pass the tenant host explicitly. Sessions: " + JsonSerializer.Serialize(Sessions()));
            return any[0];
        }
    }
    // Rewrites one tenant's section of the catalog from a server listing; notes, author and other tenants stay.
    private static object UpdateCatalog(string host, string listedAt, (string name, string key, string kind, string assetType, int revision, string? revisionBy)[] assets) {
        var path = Path.Combine(Snapshots, "modules.json");
        var root = (File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path)) as JsonObject : null) ?? new JsonObject();
        // A RAIZ SEGUE A SESSAO. O proprio catalogo descreve a raiz como "the one the Studio is expected to be
        // signed into" -- e uma expectativa escrita a mao que ninguem reconciliava com a realidade, e o builder
        // carimba o manifesto a partir dela.
        //
        // Medido em 2026-09-18: o Studio estava autenticado no tenant PESSOAL, `assets` listou-o correctamente
        // com ok:true e 59 assets, arquivou-o em otherTenants, e a raiz continuou no tenant CORPORATIVO com os 57
        // modulos do dia anterior. O manifesto seguinte saiu carimbado com o corporativo. A unica coisa que
        // impediu a escrita la foi a sessao ter caido -- nenhuma verificacao.
        //
        // So se promove quando NAO ha ambiguidade: uma unica sessao autenticada, e e a deste host. Com duas
        // sessoes abertas a raiz pode ser uma escolha deliberada e nao se mexe; quem quiser trocar diz o tenant.
        var sessoes = RuntimeImplementation.Instance.GetAllTopLevelPresenters()
            .Where(p => p.ServerCommunicationsProvider?.IsLoggedIn == true).Select(Host).Distinct().ToArray();
        var raizAntiga = (string?)root["tenant"];
        if (raizAntiga != host && sessoes.Length == 1 && sessoes[0] == host) {
            var outros = root["otherTenants"] as JsonArray ?? new JsonArray(); root["otherTenants"] = outros;
            // A raiz antiga desce para otherTenants com o que tinha, para nao se perder nada.
            if (raizAntiga != null && !outros.OfType<JsonObject>().Any(o => (string?)o["tenant"] == raizAntiga)) {
                var descida = new JsonObject { ["tenant"] = raizAntiga };
                foreach (var campo in new[] { "modules", "modulesListedAt", "modulesSource" })
                    if (root[campo] is { } valor) { descida[campo] = valor.DeepClone(); root.Remove(campo); }
                outros.Add(descida);
            }
            // E a que estava arquivada sobe, se ja la estava.
            var arquivada = outros.OfType<JsonObject>().FirstOrDefault(o => (string?)o["tenant"] == host);
            if (arquivada != null) outros.Remove(arquivada);
            root["tenant"] = host;
            root["tenantFollowedSession"] = "raiz promovida de " + (raizAntiga ?? "(nenhuma)") + " para " + host
                + " em " + listedAt + ": era a unica sessao autenticada";
        }

        JsonObject section;
        if ((string?)root["tenant"] == host) section = root;
        else {
            var others = root["otherTenants"] as JsonArray ?? new JsonArray(); root["otherTenants"] = others;
            var existing = others.OfType<JsonObject>().FirstOrDefault(o => (string?)o["tenant"] == host);
            if (existing == null) { existing = new JsonObject { ["tenant"] = host }; others.Add(existing); }
            section = existing;
        }
        var previous = (section["modules"] as JsonArray)?.OfType<JsonObject>().Select(o => (string?)o["name"]).OfType<string>().ToHashSet() ?? new HashSet<string>();
        var list = new JsonArray();
        foreach (var a in assets) list.Add(new JsonObject { ["name"] = a.name, ["key"] = a.key, ["kind"] = a.kind, ["assetType"] = a.assetType, ["revision"] = a.revision, ["revisionBy"] = a.revisionBy });
        section["modules"] = list; section["modulesListedAt"] = listedAt; section["modulesSource"] = "bridge assets, native AssetManagementService.GetAssetInfos";
        File.WriteAllText(path, root.ToJsonString(CatalogJson));
        var names = assets.Select(a => a.name).ToHashSet();
        return new { path, previousCount = previous.Count, count = assets.Length, added = names.Except(previous).Order().ToArray(), removed = previous.Except(names).Order().ToArray() };
    }
    private static object? CatalogSummary() {
        try {
            using var d = JsonDocument.Parse(File.ReadAllText(Path.Combine(Snapshots, "modules.json"))); var r = d.RootElement;
            return new { tenant = r.TryGetProperty("tenant", out var t) ? t.GetString() : null, modules = r.TryGetProperty("modules", out var m) ? m.GetArrayLength() : 0, listedAt = r.TryGetProperty("modulesListedAt", out var l) ? l.GetString() : null };
        } catch { return null; }
    }

    // Reflective access used for native dialogs, whose presenters expose views, captions and footer actions
    // through non-public members. Mirrors the proven CollaborationStudio recovery adapters.
    private static object? P(object? o, string name) {
        if (o == null) return null;
        foreach (var t in o.GetType().GetInterfaces().Append(o.GetType())) {
            var p = t.GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance).FirstOrDefault(p => p.Name == name && p.GetIndexParameters().Length == 0);
            if (p != null) { try { return p.GetValue(o); } catch { return null; } }
        }
        var field = Fields(o.GetType()).FirstOrDefault(f => f.Name == name || f.Name == "<" + name + ">k__BackingField");
        try { return field?.GetValue(o); } catch { return null; }
    }
    private static IEnumerable<FieldInfo> Fields(Type type) { for (var t = type; t != null; t = t.BaseType) foreach (var f in t.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly)) yield return f; }

    private sealed record DialogAction(string? Label, bool Enabled, object? Id);
    private sealed record DialogInfo(object Presenter, object Owner, string Caption, string Type, string? Message, DialogAction[] Actions);

    // Walks the child presenters of every top-level presenter and aggregator and returns those that show a captioned view.
    private static DialogInfo[] Dialogs() {
        var found = new List<DialogInfo>();
        var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
        void Walk(object owner, object presenter, int depth) {
            if (!seen.Add(presenter)) return;
            var view = P(presenter, "View");
            var caption = P(view, "Caption")?.ToString();
            if (!string.IsNullOrWhiteSpace(caption)) {
                var component = P(P(view, "InnerView"), "Component");
                var actions = Array.Empty<DialogAction>();
                if (component != null && Fields(component.GetType()).FirstOrDefault(f => f.Name == "GetFooterActions")?.GetValue(component) is Delegate getter)
                    try { actions = ((System.Collections.IEnumerable)getter.DynamicInvoke()!).Cast<object>().Select(x => new DialogAction(P(x, "label")?.ToString(), P(x, "isEnabled") is true, P(x, "id"))).ToArray(); } catch { }
                var message = new[] { "Message", "Text", "Description", "Details", "Content" }.Select(n => P(view, n)?.ToString() ?? P(component, n)?.ToString()).FirstOrDefault(s => !string.IsNullOrWhiteSpace(s));
                found.Add(new DialogInfo(presenter, owner, caption!, presenter.GetType().FullName ?? "", message, actions));
            }
            if (depth > 0 && P(presenter, "ChildPresenters") is System.Collections.IEnumerable children)
                foreach (var child in children.Cast<object>().ToArray()) Walk(owner, child, depth - 1);
        }
        foreach (var top in RuntimeImplementation.Instance.GetAllTopLevelPresenters().ToArray()) Walk(top, top, 4);
        foreach (var aggregator in RuntimeImplementation.Instance.Aggregators.ToArray()) Walk(aggregator, aggregator, 4);
        return found.ToArray();
    }
    private static object[] DescribeDialogs(DialogInfo[] dialogs) => dialogs.Select(d => (object)new { caption = d.Caption, type = d.Type, message = d.Message, actions = d.Actions.Select(a => new { a.Label, a.Enabled }).ToArray() }).ToArray();

    // Modal message boxes such as "Communication error" are separate Avalonia windows, not child presenters.
    // They are listed with their visible text and buttons so a refusal explains itself without a screen.
    private sealed record WindowButton(Avalonia.Controls.Button Button, string Text, bool Enabled, bool HasCommand);
    private sealed record WindowInfo(Avalonia.Controls.Window Window, string Title, bool IsMain, string[] Texts, WindowButton[] Buttons);
    private static string ButtonText(Avalonia.Controls.Button button) => button.Content switch {
        string s => s,
        Avalonia.Controls.TextBlock t => t.Text ?? "",
        Avalonia.Controls.ContentControl c => c.Content?.ToString() ?? "",
        null => "",
        var other => (Avalonia.VisualTree.VisualExtensions.GetVisualDescendants(button).OfType<Avalonia.Controls.TextBlock>().Select(t => t.Text).FirstOrDefault(t => !string.IsNullOrWhiteSpace(t)) ?? other.ToString() ?? "")
    };
    // Every text-bearing control is read: message boxes render their body through TextBox, SelectableTextBlock or TextPresenter.
    private static string? VisualText(Avalonia.Visual visual) => visual switch {
        Avalonia.Controls.TextBlock t => t.Text,
        Avalonia.Controls.TextBox t => t.Text,
        Avalonia.Controls.Presenters.TextPresenter t => t.Text,
        Avalonia.Controls.ContentControl c when c.Content is string s => s,
        _ => null
    };
    private static WindowInfo[] Windows() {
        if (Avalonia.Application.Current?.ApplicationLifetime is not Avalonia.Controls.ApplicationLifetimes.IClassicDesktopStyleApplicationLifetime desktop) return Array.Empty<WindowInfo>();
        return desktop.Windows.Where(w => w.IsVisible).Select(w => {
            var descendants = Avalonia.VisualTree.VisualExtensions.GetVisualDescendants(w).ToArray();
            var texts = descendants.Select(VisualText).Where(t => !string.IsNullOrWhiteSpace(t)).Select(t => t!.Trim()).Distinct().Take(30).ToArray();
            var buttons = descendants.OfType<Avalonia.Controls.Button>().Where(b => b.IsVisible).Select((b, i) => {
                var text = ButtonText(b);
                if (text.StartsWith("Avalonia.")) text = !string.IsNullOrWhiteSpace(b.Name) ? b.Name : "#" + i;
                return new WindowButton(b, text, b.IsEnabled, b.Command != null);
            }).ToArray();
            return new WindowInfo(w, w.Title ?? "", ReferenceEquals(w, desktop.MainWindow), texts, buttons);
        }).ToArray();
    }
    private static object[] DescribeWindows(WindowInfo[] windows) => windows.Select(w => (object)new { title = w.Title, isMain = w.IsMain, texts = w.Texts, buttons = w.Buttons.Select(b => new { b.Text, b.Enabled, b.HasCommand }).ToArray() }).ToArray();
    // A modal dialog is an owned window; the Studio's main window has no owner.
    private static WindowInfo[] ModalWindows() => Windows().Where(w => w.Window.Owner != null).ToArray();

    // Records the native ModuleInfo of an open module (application key and name, isolation, version) into
    // snapshots\<Module>-moduleinfo.json, which the server open path needs when the module is closed.
    private static object ModuleInfo(string module, Context c) {
        var p = Active(module); var s = p.ActiveESpace; c.Module = s.Name; c.ModuleKey = s.Key.ToString();
        // CreateModuleInfo is an extension method; locate it in any loaded Studio assembly.
        var creator = AppDomain.CurrentDomain.GetAssemblies()
            .Where(a => (a.GetName().Name ?? "").StartsWith("ServiceStudio") || (a.GetName().Name ?? "").StartsWith("OutSystems"))
            .SelectMany(a => { try { return a.GetTypes(); } catch (ReflectionTypeLoadException e) { return e.Types.Where(t => t != null)!; } })
            .SelectMany(t => t.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
            .FirstOrDefault(m => m.Name == "CreateModuleInfo" && m.GetParameters().Length == 1 && m.GetParameters()[0].ParameterType.IsInstanceOfType(s));
        Require(creator != null, "No CreateModuleInfo(ESpace) method found in the loaded Studio assemblies.");
        var info = creator!.Invoke(null, new object[] { s });
        Require(info != null, "CreateModuleInfo returned null.");
        // ModuleInfo is a struct: read public and non-public properties and fields alike.
        var values = new Dictionary<string, object?>();
        object? Scalar(object? v) => v == null ? null : v is bool or int or string || v.GetType().IsEnum ? v : v.ToString();
        foreach (var property in info!.GetType().GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).Where(x => x.GetIndexParameters().Length == 0)) {
            try { values[property.Name] = Scalar(property.GetValue(info)); } catch { }
        }
        foreach (var field in Fields(info.GetType()).Where(f => !f.Name.Contains("k__BackingField"))) {
            try { values[field.Name] = Scalar(field.GetValue(info)); } catch { }
        }
        values["$type"] = info.GetType().FullName;
        var record = new { ok = true, module = s.Name, moduleKey = c.ModuleKey, tenant = p.ServerCommunicationsProvider?.LoginInfo?.HostInfo?.Hostname, capturedAt = DateTimeOffset.UtcNow.ToString("o"), moduleInfo = values };
        File.WriteAllText(Path.Combine(Snapshots, s.Name + "-moduleinfo.json"), JsonSerializer.Serialize(record, Json));
        return record;
    }

    // Closes open copies of a module through the native CloseModule command. Only unmodified copies without a
    // pending merge are closed, so the Studio never asks to save. Usage: close <Module> [--duplicates] [--discard]
    // With --duplicates the first copy stays open and every extra copy is closed. With --discard a modified copy
    // is closed through the native ForceClose without saving; the discarded model is snapshotted first.
    private static async Task<object> Close(string argument, Context c) {
        var parts = argument.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        Require(parts.Length >= 1, "close requires a module name or key, optionally followed by --duplicates or --discard.");
        var module = parts[0]; var duplicatesOnly = parts.Contains("--duplicates"); var discard = parts.Contains("--discard");
        var copies = await Ui(() => RuntimeImplementation.Instance.Aggregators.Where(a => a.ActiveESpace != null && (a.ActiveESpace.Name == module || a.ActiveESpace.Key.ToString() == module)).ToArray());
        Require(copies.Length > 0, "No open copy of " + module + ".");
        c.Module = module;
        var targets = duplicatesOnly ? copies.Skip(1).ToArray() : copies;
        var closed = new List<object>();
        foreach (var copy in targets) {
            var state = await Ui(() => new { modified = copy.ActiveESpace.WasModifiedSinceLastSave, mergePending = copy.ActiveESpace.Match != null, running = copy.BottomPanePresenter.ChildPresenters.OfType<IServerMessagesPanePresenter>().Any(i => i.ServerProcess?.CurrentState.ToString() == "Running") });
            Require(!state.mergePending && !state.running, "Copy of " + module + " is merging or running a server operation; refusing to close it.");
            Require(!state.modified || discard, "Copy of " + module + " is modified; refusing to close it without --discard.");
            if (state.modified && discard) {
                var discarded = await Ui(() => { using var st = copy.ActiveESpace.SaveToMemoryStream(); var b = st.ToArray(); var h = Hash(b); var path = Path.Combine(Snapshots, module + "-discarded-" + h + ".oml"); File.WriteAllBytes(path, b); return new { path, sha256 = h }; });
                TryWrite(Path.Combine(Root, "journal", "discard-" + DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmss") + ".json"), new { at = DateTimeOffset.UtcNow, module, discarded });
                var forced = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
                // ForceClose is an explicit interface implementation (IAggregatorPresenter.ForceClose => close with force,
                // no save prompt), so it is called through the interface, never located by name on the concrete type.
                await copy.ExecuteInContext(() => { try { copy.ForceClose(); forced.SetResult(new { discarded = true, snapshot = discarded.path }); } catch (Exception error) { forced.SetException(error); } }, executeWhenTopLevelIsIdle: true);
                closed.Add(await forced.Task);
                continue;
            }
            var done = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            await copy.ExecuteInContext(() => { try { var result = AutoRegistryType<ServiceStudio.Presenter.Commands.ESpaceCommands.CloseModule>.Instance.Execute(copy, copy); done.SetResult(result?.ToString() ?? "null"); } catch (Exception error) { done.SetException(error); } }, executeWhenTopLevelIsIdle: true);
            closed.Add(new { result = await done.Task });
        }
        await Task.Delay(500);
        var remaining = await Ui(() => RuntimeImplementation.Instance.Aggregators.Count(a => a.ActiveESpace != null && (a.ActiveESpace.Name == module || a.ActiveESpace.Key.ToString() == module)));
        return new { ok = true, module, closed = closed.Count, remaining, results = closed };
    }

    // Triggers one named footer action of one open dialog, through the owner's native execution context.
    // Usage: dismiss-dialog <caption>|<action label>. The dialog's text and actions are journaled before the click.
    private static async Task<object> DismissDialog(string argument, Context c) {
        var parts = argument.Split('|', 2);
        Require(parts.Length == 2, "dismiss-dialog requires <caption>|<action label>.");
        var caption = parts[0].Trim(); var label = parts[1].Trim();
        var dialogs = await Ui(Dialogs);
        var matches = dialogs.Where(d => d.Caption.Trim() == caption && d.Actions.Length > 0).ToArray();
        if (matches.Length == 0) {
            // Window path: a modal message box. Its button command is executed on the UI thread, the same
            // code path a user click takes inside the Studio; no operating-system input is synthesized.
            var windows = await Ui(ModalWindows);
            var window = windows.Where(w => w.Title.Trim() == caption).ToArray();
            Require(window.Length == 1, "Expected exactly one open window titled '" + caption + "'; found " + window.Length + ". Modal windows: " + JsonSerializer.Serialize(DescribeWindows(windows)) + "; presenter dialogs: " + JsonSerializer.Serialize(DescribeDialogs(dialogs)));
            var button = window[0].Buttons.Where(b => b.Text.Trim() == label).ToArray();
            Require(button.Length == 1, "Window '" + caption + "' has no single button '" + label + "'. Buttons: " + JsonSerializer.Serialize(window[0].Buttons.Select(b => new { b.Text, b.Enabled, b.HasCommand })));
            Require(button[0].Enabled, "Button '" + label + "' is disabled.");
            var windowRecord = new { at = DateTimeOffset.UtcNow, window = caption, button = label, texts = window[0].Texts, buttons = window[0].Buttons.Select(b => new { b.Text, b.Enabled, b.HasCommand }) };
            TryWrite(Path.Combine(Root, "journal", "dialog-" + DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmss") + ".json"), windowRecord);
            var clicked = await Ui(() => {
                var b = button[0].Button;
                if (b.Command != null && b.Command.CanExecute(b.CommandParameter)) { b.Command.Execute(b.CommandParameter); return "command"; }
                var raise = typeof(Avalonia.Controls.Button).GetMethod("OnClick", BindingFlags.Instance | BindingFlags.NonPublic);
                Require(raise != null, "Button has neither a command nor an OnClick handler.");
                raise!.Invoke(b, null); return "click";
            });
            await Task.Delay(500);
            var remaining = await Ui(() => ModalWindows().Any(w => w.Title.Trim() == caption));
            return new { ok = true, dismissed = !remaining, window = caption, button = label, via = clicked, texts = window[0].Texts, note = remaining ? "The window is still visible after the action." : "The window closed." };
        }
        Require(matches.Length == 1, "Expected exactly one open dialog captioned '" + caption + "'; found " + matches.Length + ". Open dialogs: " + JsonSerializer.Serialize(DescribeDialogs(dialogs)));
        var dialog = matches[0];
        var action = dialog.Actions.SingleOrDefault(a => a.Label?.Trim() == label);
        Require(action != null, "Dialog '" + caption + "' has no action '" + label + "'. Actions: " + JsonSerializer.Serialize(dialog.Actions.Select(a => new { a.Label, a.Enabled })));
        Require(action!.Enabled, "Action '" + label + "' is disabled.");
        var record = new { at = DateTimeOffset.UtcNow, caption, label, dialog.Message, dialog.Type, actions = dialog.Actions.Select(a => new { a.Label, a.Enabled }) };
        TryWrite(Path.Combine(Root, "journal", "dialog-" + DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmss") + ".json"), record);
        var done = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
        Action click = () => {
            try {
                Require(!Dispatcher.UIThread.CheckAccess(), "Dialog continuation must execute outside the UI thread.");
                var component = P(P(P(dialog.Presenter, "View"), "InnerView"), "Component")!;
                var trigger = (Delegate)Fields(component.GetType()).Single(f => f.Name == "FooterActionTriggered").GetValue(component)!;
                trigger.DynamicInvoke(action.Id);
                done.SetResult(new { ok = true, dismissed = true, caption, label, dialog.Message });
            } catch (Exception error) { done.SetException(error); }
        };
        if (dialog.Owner is IAggregatorPresenter aggregator) await aggregator.ExecuteInContext(click, executeWhenTopLevelIsIdle: false);
        else if (dialog.Owner is ITopLevelPresenter top) await top.ExecuteInContext(click, executeWhenTopLevelIsIdle: false);
        else throw new InvalidOperationException("Unsupported dialog owner: " + dialog.Owner.GetType().FullName);
        return await done.Task;
    }

    // Scalar state of a presenter, for diagnosing why the Studio is not idle without seeing its screen.
    private static object State(object? presenter) {
        if (presenter == null) return new { };
        var result = new Dictionary<string, object?>();
        foreach (var property in presenter.GetType().GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)) {
            if (property.GetIndexParameters().Length != 0) continue;
            if (!System.Text.RegularExpressions.Regex.IsMatch(property.Name, "Idle|Busy|Dialog|Modal|Operation|Load|State|Running|Pending|Active|Progress|Enabled", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) continue;
            try {
                var value = property.GetValue(presenter);
                result[property.Name] = value == null ? null : value is bool or int or string || value.GetType().IsEnum ? value : value.GetType().Name;
            } catch (Exception error) { result[property.Name] = "<" + error.GetBaseException().Message + ">"; }
        }
        return result;
    }
    private static async Task<T> Ui<T>(Func<T> callback) => await Dispatcher.UIThread.InvokeAsync(callback);
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));
    private static string Developer(ESpace model) => Providers.Instance.GetEnvironment().GetDeveloperId(model);
    private static ESpace Load(byte[] bytes) => ESpace.Load(bytes, productKey: null, informationForUpgrader: null, loadFlags: LoadFlags.SkipUpgrades);
    private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    private static void TryWrite(string path, object value) { try { Directory.CreateDirectory(Path.GetDirectoryName(path)!); File.WriteAllText(path, value is string s ? s : JsonSerializer.Serialize(value, Json)); } catch { } }
    private static string[] Errors(IESpace model) => model.GetValidationMessages().Where(x => x.Type.ToString() == "Error").Select(x => x.Owner.Key + "|" + x.Id + "|" + x.Message + "|" + x.Detail).Order().ToArray();
    private static object[] Messages(IESpace model) => model.GetValidationMessages().Select(x => (object)new { key = x.Owner.Key.ToString(), id = x.Id.ToString(), type = x.Type.ToString(), message = x.Message, detail = x.Detail?.ToString() }).ToArray();
    // The messages of the live module that the candidate did not have (compared on the fields of Messages), each with its
    // owner and the nearest ancestor ssam_map and studio_inspect address by @key (a property-owned wrapper or an expression
    // owns many messages and has no key of its own in the module index).
    private static object[] NewMessages(IESpace model, object[] previous) {
        var before = previous.Select(x => JsonSerializer.Serialize(x)).ToHashSet();
        return model.GetValidationMessages().Select(x => (Base: (object)new { key = x.Owner.Key.ToString(), id = x.Id.ToString(), type = x.Type.ToString(), message = x.Message, detail = x.Detail?.ToString() }, Owner: (object?)x.Owner))
            .Where(x => !before.Contains(JsonSerializer.Serialize(x.Base))).Select(x => Addressed(x.Base, x.Owner)).ToArray();
    }
    private static object Addressed(object message, object? owner) {
        var chain = new List<MergeDiagnostics.ModelNode>();
        try {
            for (var o = owner as IModelObject; o != null && chain.Count < 64; o = o.Parent as IModelObject) {
                var kind = o.GetInterface()?.Name ?? o.GetType().Name;
                if (kind.Length > 1 && kind[0] == 'I' && char.IsUpper(kind[1])) kind = kind[1..];
                string? name; try { name = Member(o, "Name")?.ToString() ?? o.DisplayName; } catch { name = o.DisplayName; }
                chain.Add(new MergeDiagnostics.ModelNode(o.Key?.ToString(), kind, name));
            }
        } catch { /* the address is diagnostic; the message itself stays */ }
        var at = MergeDiagnostics.Locate(chain);
        var node = JsonSerializer.SerializeToNode(message) as JsonObject ?? new JsonObject();
        node["ownerKey"] = at.OwnerKey; node["ownerPath"] = at.OwnerPath;
        node["addressableKey"] = at.AddressableKey; node["addressablePath"] = at.AddressablePath;
        return node;
    }

    private static ProviderState ProvidersState() {
        var operations = Providers.Instance.GetOperations();
        var environment = Providers.Instance.GetEnvironment();
        var operationsAssembly = operations?.GetType().Assembly.GetName().Name;
        var environmentType = environment?.GetType().FullName;
        return new ProviderState(operationsAssembly, environmentType, operations != null && operationsAssembly == "ServiceStudio.Presenter" && !(environmentType ?? "").Contains("ModelAPI"));
    }

    private static IAggregatorPresenter Active(string module) {
        Require(module != "", "A module name or key is required.");
        var all = RuntimeImplementation.Instance.Aggregators.Where(a => a.ActiveESpace != null && (a.ActiveESpace.Name == module || a.ActiveESpace.Key.ToString() == module)).ToArray();
        Require(all.Length == 1, "Expected exactly one open " + module + "; found " + all.Length + ".");
        return all[0];
    }

    private static void Guard(Manifest m, IAggregatorPresenter p) {
        var providers = ProvidersState();
        Require(providers.Native, "Studio providers are not native (" + providers.Operations + ", " + providers.Environment + "); the bridge refuses to operate in this process.");
        Require(p.ActiveESpace.Name == m.Module && p.ActiveESpace.Key.ToString() == m.ModuleKey, "Module identity changed: expected " + m.Module + " " + m.ModuleKey + ".");
        Require(p.ActiveESpace.Match == null, "Pending merge exists in " + m.Module + "; reconcile before another operation.");
        // The refusal names what the Studio answered next to what the manifest expects (developer id, tenant, user, session).
        // 2026-10-05 (QuizLiveWeb, lab 63): the merge itself had completed with developerId = the author (its receipt); the
        // relay timed out, not the bridge. Thirteen minutes later the publish was refused here, right after the watchdog closed
        // an untitled window, and the observed id was not recorded. Developer() asks the Studio's global environment
        // (Providers.GetEnvironment), not the module's own session, so another active session or an expired sign-in changes it;
        // the evidence does not tell which, so the rule stays and the refusal now records what it saw.
        var developer = Developer(p.ActiveESpace);
        if (developer != m.Author) {
            var login = p.ServerCommunicationsProvider?.LoginInfo;
            string? Safe(Func<string?> read) { try { return read(); } catch { return null; } }
            var sessions = Sessions().Select(s => Member(s, "host") + (Member(s, "loggedIn") is true ? "" : " (signed out)"));
            throw new InvalidOperationException(MergeDiagnostics.AuthorMismatch(m.Author, m.Tenant, developer, Safe(() => login?.HostInfo?.Hostname), Safe(() => login?.Username),
                p.ServerCommunicationsProvider?.IsLoggedIn, sessions));
        }
        Require(p.ServerCommunicationsProvider.IsLoggedIn && p.ServerCommunicationsProvider.LoginInfo.HostInfo.Hostname == m.Tenant, "Authenticated tenant " + m.Tenant + " required.");
    }

    // I10: what this build does that older bridges do not; the facade uses each behavior only when it is here (status, brief).
    // merge:normalized: a merge proven equal but for the Studio's own rewrites answers ok:true, merged:true, normalized (G-1);
    // template-download:have: a template whose revision the caller already has answers cached:true without bytes (C25).
    private static readonly string[] Capabilities = { "merge:normalized", "template-download:have" };
    private static object Status() {
        var providers = ProvidersState();
        object? topState = null;
        try { topState = State(RuntimeImplementation.Instance.GetAllTopLevelPresenters().FirstOrDefault(p => p.ServerCommunicationsProvider?.IsLoggedIn == true)); } catch (Exception error) { topState = error.Message; }
        return new {
            ok = true, bridge = Version, capabilities = Capabilities, root = Root, pid = Environment.ProcessId, providers, sessions = Sessions(), catalogTenant = CatalogTenant(), catalog = CatalogSummary(),
            busy = busyCommand == null ? null : new { command = busyCommand, since = busySince.ToString("o") },
            dialogs = DescribeDialogs(Dialogs()), modalWindows = DescribeWindows(ModalWindows()),
            topLevel = topState, runtime = State(RuntimeImplementation.Instance),
            modules = RuntimeImplementation.Instance.Aggregators.Where(a => a.ActiveESpace != null).Select(a => new {
                name = a.ActiveESpace!.Name, key = a.ActiveESpace.Key.ToString(), mergePending = a.ActiveESpace.Match != null, modified = a.ActiveESpace.WasModifiedSinceLastSave,
                loggedIn = a.ServerCommunicationsProvider?.IsLoggedIn, host = a.ServerCommunicationsProvider?.LoginInfo?.HostInfo?.Hostname, developerId = Developer(a.ActiveESpace),
                mergedInThisSessionAt = MergedAt.TryGetValue(a.ActiveESpace.Name, out var at) ? at.ToString("o") : null,
                publishedInThisSessionAt = PublishedAt.TryGetValue(a.ActiveESpace.Name, out var pat) ? pat.ToString("o") : null,
                // The last publication of the module, whoever started it (publish-log has every message).
                lastPublish = LastPublishCompact(a),
                dependencies = ((IESpace)a.ActiveESpace).Dependencies.Select(d => d.Name + " r" + d.Revision).ToArray()
            }).ToArray(),
            publishInvoked = false
        };
    }

    // Step 2 of the cycle: capture the open module as an immutable, hash-named base.
    private static object Snapshot(string module, Context c) {
        var p = Active(module); var s = p.ActiveESpace;
        c.Module = s.Name; c.ModuleKey = s.Key.ToString();
        Require(s.Match == null, "Pending merge exists in " + s.Name + "; snapshot refused.");
        using var stream = s.SaveToMemoryStream(); var bytes = stream.ToArray(); var hash = Hash(bytes); c.BaseSha = hash;
        var path = Path.Combine(Snapshots, s.Name + "-" + hash + ".oml");
        if (!File.Exists(path)) File.WriteAllBytes(path, bytes);
        var capture = new {
            ok = true, module = s.Name, moduleKey = c.ModuleKey, sha256 = hash, path, capturedAt = DateTimeOffset.UtcNow.ToString("o"),
            modified = s.WasModifiedSinceLastSave, developerId = Developer(s), host = p.ServerCommunicationsProvider?.LoginInfo?.HostInfo?.Hostname,
            // App or library: the facade refuses, before any build, what only a library can hold (a public structure).
            kind = s.IsLibraryEspace ? "library" : "app",
            dependencies = ((IESpace)s).Dependencies.Select(d => new { d.Name, d.Revision }).ToArray()
        };
        File.WriteAllText(path + ".json", JsonSerializer.Serialize(capture, Json));
        return capture;
    }

    // The authenticated top-level presenter owns server communication whether or not a module is open.
    // A Studio can hold sessions on several tenants, so the presenter is chosen by tenant host.
    private static object[] Sessions() => RuntimeImplementation.Instance.GetAllTopLevelPresenters()
        .Select(p => (object)new { loggedIn = p.ServerCommunicationsProvider?.IsLoggedIn, host = p.ServerCommunicationsProvider?.LoginInfo?.HostInfo?.Hostname }).ToArray();
    private static string? CatalogTenant() {
        try { using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(Snapshots, "modules.json"))); return document.RootElement.TryGetProperty("tenant", out var t) ? t.GetString() : null; } catch { return null; }
    }
    private static ITopLevelPresenter Top(string? tenant = null) {
        var requested = tenant; tenant ??= CatalogTenant();
        var all = RuntimeImplementation.Instance.GetAllTopLevelPresenters().Where(p => p.ServerCommunicationsProvider?.IsLoggedIn == true).ToArray();
        var top = tenant == null ? all.FirstOrDefault() : all.FirstOrDefault(p => p.ServerCommunicationsProvider.LoginInfo.HostInfo.Hostname == tenant);
        // The catalog root names one tenant. When nothing was requested and the Studio is signed into a single
        // other tenant, that session is the only possible answer; its catalog section lives under otherTenants.
        // A session once spent minutes editing modules.json by hand to get past this.
        if (top == null && requested == null && all.Select(Host).Distinct().Count() == 1) top = all[0];
        Require(top != null, "No authenticated Studio session for tenant " + (tenant ?? "(any)") + "; sessions: " + JsonSerializer.Serialize(Sessions()));
        return top!;
    }
    private static string? Host(ITopLevelPresenter p) => p.ServerCommunicationsProvider?.LoginInfo?.HostInfo?.Hostname;
    // Download results carry their own diagnostics; surface every scalar property so a refusal explains itself.
    private static string Describe(object? result) {
        if (result == null) return "null";
        try { return string.Join(", ", result.GetType().GetProperties().Where(p => p.GetIndexParameters().Length == 0 && p.PropertyType != typeof(byte[])).Select(p => { try { var v = p.GetValue(result); return p.Name + "=" + (v is byte[] b ? b.Length + " bytes" : v?.ToString() ?? "null"); } catch (Exception e) { return p.Name + "=<" + e.GetBaseException().Message + ">"; } })); }
        catch (Exception e) { return "<" + e.Message + ">"; }
    }

    // Module names resolve to keys through the open modules, then the catalog section of the session's tenant
    // (root or otherTenants), then any catalog section, then the other snapshots\*.json files. The same module
    // name exists in several tenants (WrightFlood in both), so the tenant of the session decides first.
    private static ObjectKey ResolveKey(string moduleOrKey, string? tenant = null) {
        var open = RuntimeImplementation.Instance.Aggregators.FirstOrDefault(a => a.ActiveESpace != null && (a.ActiveESpace.Name == moduleOrKey || a.ActiveESpace.Key.ToString() == moduleOrKey));
        if (open != null) return open.ActiveESpace!.Key;
        static string? KeyIn(JsonElement section, string module) {
            if (section.ValueKind == JsonValueKind.Object && section.TryGetProperty("modules", out var list))
                foreach (var entry in list.EnumerateArray()) if (entry.TryGetProperty("name", out var n) && n.GetString() == module && entry.TryGetProperty("key", out var key)) return key.GetString();
            return null;
        }
        try {
            using var catalog = JsonDocument.Parse(File.ReadAllText(Path.Combine(Snapshots, "modules.json")));
            var root = catalog.RootElement;
            var sections = new List<JsonElement> { root };
            if (root.TryGetProperty("otherTenants", out var others)) sections.AddRange(others.EnumerateArray());
            string? TenantOf(JsonElement s) => s.TryGetProperty("tenant", out var t) ? t.GetString() : null;
            foreach (var section in sections.Where(s => tenant != null && string.Equals(TenantOf(s), tenant, StringComparison.OrdinalIgnoreCase)).Concat(sections))
                if (KeyIn(section, moduleOrKey) is string found) return ObjectKey.Parse(found);
        } catch { }
        foreach (var file in Directory.EnumerateFiles(Snapshots, "*.json")) {
            try {
                using var document = JsonDocument.Parse(File.ReadAllText(file));
                var root = document.RootElement;
                if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("module", out var m) && m.GetString() == moduleOrKey && root.TryGetProperty("moduleKey", out var k)) return ObjectKey.Parse(k.GetString()!);
            } catch { }
        }
        return ObjectKey.Parse(moduleOrKey);
    }

    // A revision downloaded twice is not byte-stable (server metadata changes), so a differing download is
    // kept under a hash-suffixed name instead of being treated as corruption. The earlier file is never touched.
    private static (string Path, bool Differs) StoreRevision(string module, int revision, byte[] data, string hash) {
        var path = Path.Combine(Snapshots, module + "-revision-" + revision + ".oml");
        if (!File.Exists(path)) { File.WriteAllBytes(path, data); return (path, false); }
        if (File.ReadAllBytes(path).SequenceEqual(data)) return (path, false);
        var alternate = Path.Combine(Snapshots, module + "-revision-" + revision + "-" + hash[..12] + ".oml");
        if (!File.Exists(alternate)) File.WriteAllBytes(alternate, data);
        return (alternate, true);
    }

    // Downloads the latest published revision through the authenticated native DownloadService.
    private static async Task<object> Latest(string module, Context c) {
        var (top, key) = await Ui(() => { var t = Top(); return (t, ResolveKey(module, Host(t))); });
        c.ModuleKey = key.ToString();
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var d = ((IServerCommunicationsServicesProvider)top.ServerCommunicationsProvider).DownloadService.DownloadESpace(0, key, timeout.Token);
        Require(d.Success && d.Data != null && d.AssetInfo != null && d.IsPublishedVersion, "Latest published revision could not be verified for " + module + " (key " + key + "): " + Describe(d) + "; asset: " + Describe(d.AssetInfo));
        var data = d.Data!; var asset = d.AssetInfo!; var name = asset.Name; c.Module = name;
        var hash = Hash(data);
        var (path, differs) = StoreRevision(name, asset.Revision, data, hash);
        var result = new { ok = true, module = name, moduleKey = c.ModuleKey, revision = asset.Revision, sha256 = hash, path, bytesDifferFromEarlierDownload = differs, isPublishedVersion = d.IsPublishedVersion, downloadedAt = DateTimeOffset.UtcNow.ToString("o") };
        File.WriteAllText(path + ".json", JsonSerializer.Serialize(result, Json));
        return result;
    }

    // Opens a module in the Studio: from a local .oml when a path is given, otherwise from the latest published revision.
    // Opening is asynchronous in the Studio; poll status until the module appears.
    private static async Task<object> Open(string argument, Context c) {
        var parts = argument.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
        Require(parts.Length >= 1, "open requires a module name or key, optionally followed by a local .oml path.");
        var module = parts[0]; var localPath = parts.Length == 2 ? Path.GetFullPath(parts[1]) : null;
        var already = await Ui(() => RuntimeImplementation.Instance.Aggregators.Any(a => a.ActiveESpace != null && (a.ActiveESpace.Name == module || a.ActiveESpace.Key.ToString() == module)));
        if (already) return new { ok = true, alreadyOpen = true, module };
        await CloseInformational(c);
        var blocking = await Ui(ModalWindows);
        Require(blocking.Length == 0, "A Studio dialog with a choice is open and blocks top-level operations; dismiss it first with dismiss-dialog <title>|<button>. Modal windows: " + JsonSerializer.Serialize(DescribeWindows(blocking)));
        var top = await Ui(() => Top());
        // Default: open from the organization through the native path, which keeps the upload linkage that
        // Publish needs. A local .oml path opens that file; --download-file downloads and opens as a file.
        string path, source; object? revision = null;
        if (localPath != null && localPath.EndsWith("--download-file", StringComparison.OrdinalIgnoreCase)) localPath = null;
        else if (localPath != null) { Require(File.Exists(localPath), "Local model not found: " + localPath); path = localPath; source = "local"; goto load; }
        else return await OpenFromServer(module, top, c);
        {
            var key = await Ui(() => ResolveKey(module, Host(top)));
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90));
            var d = ((IServerCommunicationsServicesProvider)top.ServerCommunicationsProvider).DownloadService.DownloadESpace(0, key, timeout.Token);
            Require(d.Success && d.Data != null && d.AssetInfo != null && d.IsPublishedVersion, "Published module download failed verification for " + module + " (key " + key + "): " + Describe(d) + "; asset: " + Describe(d.AssetInfo));
            module = d.AssetInfo!.Name; revision = d.AssetInfo.Revision; source = "published";
            var downloadHash = Hash(d.Data!);
            (path, _) = StoreRevision(module, d.AssetInfo.Revision, d.Data!, downloadHash);
            File.WriteAllText(path + ".json", JsonSerializer.Serialize(new { ok = true, module, moduleKey = key.ToString(), revision, sha256 = downloadHash, path, isPublishedVersion = true, downloadedAt = DateTimeOffset.UtcNow.ToString("o") }, Json));
        }
        load:
        c.Module = module;
        var requested = new { at = DateTimeOffset.UtcNow, module, path, source, revision };
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var queued = top.ExecuteInContext(() => {
            started.TrySetResult();
            if (RuntimeImplementation.Instance.Aggregators.Any(a => a.ActiveESpace?.Name == module)) return;
            var type = typeof(RuntimeImplementation).Assembly.GetTypes().Single(t => t.Name == "AggregatorPresenter");
            var method = type.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic).Single(m => m.Name == "LoadAndOpenESpaceAsync");
            TryWrite(Path.Combine(Snapshots, "open-" + module + "-" + DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmss") + ".json"), requested);
            method.Invoke(null, new object?[] { top, path, path, null, false, false, "", null, false, true, false, null, false });
        }, executeWhenTopLevelIsIdle: true);
        // The Studio runs the queued action only when its top-level presenter is idle. Report instead of hanging.
        if (await Task.WhenAny(started.Task, Task.Delay(TimeSpan.FromSeconds(20))) != started.Task)
            throw new InvalidOperationException("Studio top-level presenter did not become idle within 20 s; the open request stays queued and is guarded against duplicates. Top-level state: " + JsonSerializer.Serialize(await Ui(() => State(top))) + "; runtime: " + JsonSerializer.Serialize(await Ui(() => State(RuntimeImplementation.Instance))));
        await queued;
        var deadline = DateTimeOffset.UtcNow.AddSeconds(150);
        while (!await Ui(() => RuntimeImplementation.Instance.Aggregators.Any(a => a.ActiveESpace?.Name == module))) {
            if (DateTimeOffset.UtcNow > deadline) throw new InvalidOperationException("Document opening is unconfirmed after 150 s; do not retry blindly. Top-level state: " + JsonSerializer.Serialize(await Ui(() => State(top))));
            await Task.Delay(500);
        }
        var opened = await Ui(() => { var a = Active(module); var s = a.ActiveESpace; return new { key = s.Key.ToString(), developerId = Developer(s), modified = s.WasModifiedSinceLastSave, mergePending = s.Match != null }; });
        return new { ok = true, opened = true, module, path, source, revision, opened.key, opened.developerId, opened.modified, opened.mergePending };
    }

    // Opens a module through the native "Open from organization" path (DownloadAndOpen), which keeps the
    // server upload information the Publish command compares against. A module opened from a local file
    // lacks it and Publish then reports a version conflict and shows Compare and Merge.
    private static MethodInfo? FindStatic(string name, Func<ParameterInfo[], bool> accepts) => AppDomain.CurrentDomain.GetAssemblies()
        .Where(a => (a.GetName().Name ?? "").StartsWith("ServiceStudio") || (a.GetName().Name ?? "").StartsWith("OutSystems"))
        .SelectMany(a => { try { return a.GetTypes(); } catch (ReflectionTypeLoadException e) { return e.Types.Where(t => t != null)!; } })
        .SelectMany(t => t.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
        .FirstOrDefault(m => m.Name == name && accepts(m.GetParameters()));
    private static object? Member(object target, string name) {
        var type = target.GetType();
        var property = type.GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (property != null) return property.GetValue(target);
        var field = Fields(type).FirstOrDefault(f => f.Name == name || f.Name == "<" + name + ">k__BackingField");
        return field?.GetValue(target);
    }

    // The same conversion the native Open dialog uses: AssetInfo from the server, then ToModuleInfoMetadata.
    private static async Task<object> OpenFromServer(string module, ITopLevelPresenter top, Context c) {
        var key = await Ui(() => ResolveKey(module, Host(top)));
        var provider = (IServerCommunicationsServicesProvider)top.ServerCommunicationsProvider;
        var asset = provider.AssetManagementService.GetAssetInfo(new RevisionRequest(RevisionRequestType.Latest, key));
        Require(asset != null, "The server returned no asset for " + module + " (key " + key + ").");
        var converter = FindStatic("ToModuleInfoMetadata", p => p.Length == 1 && p[0].ParameterType.IsInstanceOfType(asset!));
        Require(converter != null, "Native ToModuleInfoMetadata(AssetInfo) was not found.");
        var moduleInfo = converter!.Invoke(null, new object[] { asset! })!;
        var name = Member(moduleInfo, "Name")?.ToString() ?? module;
        var applicationKey = (ObjectKey)(Member(moduleInfo, "ApplicationKey") ?? throw new InvalidOperationException("ModuleInfo has no ApplicationKey for " + module + "."));
        var applicationName = Member(moduleInfo, "ApplicationName")?.ToString() ?? "";
        var isolated = Member(moduleInfo, "ApplicationIsIsolated") is true;
        var versionId = Member(moduleInfo, "VersionId") is int v ? v : 0;
        var revision = Member(moduleInfo, "Revision");
        File.WriteAllText(Path.Combine(Snapshots, name + "-moduleinfo.json"), JsonSerializer.Serialize(new { ok = true, module = name, moduleKey = key.ToString(), source = "server", capturedAt = DateTimeOffset.UtcNow.ToString("o"), applicationKey = applicationKey.ToString(), applicationName, isolated, versionId, revision = revision?.ToString(), assetRevision = asset!.Revision, assetName = asset.Name }, Json));
        c.Module = name; c.ModuleKey = key.ToString();
        var method = typeof(DownloadAndOpen).GetMethod("ExecuteCreatingNewAggregatorAsync", BindingFlags.Public | BindingFlags.Static);
        Require(method != null, "Native DownloadAndOpen.ExecuteCreatingNewAggregatorAsync is not available.");
        var parameters = method!.GetParameters();
        var sourceType = parameters.Single(p => p.Name == "eSpaceOpenedFrom").ParameterType;
        var sourceNames = Enum.GetNames(sourceType);
        var sourceName = sourceNames.FirstOrDefault(n => n.Contains("Server", StringComparison.OrdinalIgnoreCase) || n.Contains("Environment", StringComparison.OrdinalIgnoreCase) || n.Contains("Organization", StringComparison.OrdinalIgnoreCase)) ?? sourceNames[0];
        var source = Enum.Parse(sourceType, sourceName);
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        TryWrite(Path.Combine(Snapshots, "open-server-" + name + "-" + DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmss") + ".json"), new { at = DateTimeOffset.UtcNow, name, key = key.ToString(), applicationName, applicationKey = applicationKey.ToString(), isolated, versionId, source = sourceName, sourceNames });
        var queued = top.ExecuteInContext(() => {
            started.TrySetResult();
            if (RuntimeImplementation.Instance.Aggregators.Any(a => a.ActiveESpace?.Key.ToString() == key.ToString())) return;
            method.Invoke(null, new object?[] { top, "Opening " + name, applicationName, applicationKey, isolated, versionId, key, name, null, false, false, source, false, null, true });
        }, executeWhenTopLevelIsIdle: true);
        if (await Task.WhenAny(started.Task, Task.Delay(TimeSpan.FromSeconds(20))) != started.Task)
            throw new InvalidOperationException("Studio top-level presenter did not become idle within 20 s; the open request stays queued and is guarded against duplicates. Modal windows: " + JsonSerializer.Serialize(DescribeWindows(await Ui(ModalWindows))));
        await queued;
        var deadline = DateTimeOffset.UtcNow.AddSeconds(180);
        while (!await Ui(() => RuntimeImplementation.Instance.Aggregators.Any(a => a.ActiveESpace?.Key.ToString() == key.ToString()))) {
            if (DateTimeOffset.UtcNow > deadline) throw new InvalidOperationException("Document opening is unconfirmed after 180 s; do not retry blindly. Modal windows: " + JsonSerializer.Serialize(DescribeWindows(await Ui(ModalWindows))));
            await Task.Delay(500);
        }
        var opened = await Ui(() => { var a = Active(key.ToString()); var s = a.ActiveESpace; return new { developerId = Developer(s), modified = s.WasModifiedSinceLastSave, mergePending = s.Match != null, published = s.IsPublishedVersion, lastUpload = s.LastUploadDateTime }; });
        return new { ok = true, opened = true, module = name, key = key.ToString(), source = "server", openedFrom = sourceName, applicationName, applicationKey = applicationKey.ToString(), versionId, assetRevision = asset.Revision, opened.developerId, opened.modified, opened.mergePending, opened.published, opened.lastUpload };
    }

    private static async Task<object> InContext(string manifestPath, Context c, Mode mode) {
        var m = Manifest.Load(manifestPath); c.Bind(m);
        var p = await Ui(() => Active(m.ModuleKey));
        var done = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
        await p.ExecuteInContext(() => { try { done.SetResult(Run(m, p, mode, c)); } catch (Exception error) { done.SetException(error); } }, executeWhenTopLevelIsIdle: true);
        return await done.Task;
    }

    // Steps 4 and 5 of the cycle: native preview, then a single native merge with full verification.
    private static object Run(Manifest m, IAggregatorPresenter p, Mode mode, Context c) {
        Require(!Dispatcher.UIThread.CheckAccess(), "Native operations must run outside the UI thread.");
        Directory.CreateDirectory(m.EvidenceDir);
        Guard(m, p);
        var capturedAt = m.CapturedAt();
        var local = p.ActiveESpace;
        if (mode == Mode.Reconcile) {
            // A read of an already returned native merge, never another CompareAndMerge.
            using var started = JsonDocument.Parse(File.ReadAllText(Path.Combine(m.EvidenceDir, "merge-started.json")));
            using var returned = JsonDocument.Parse(File.ReadAllText(Path.Combine(m.EvidenceDir, "native-return.json")));
            var start = started.RootElement;
            Require(start.GetProperty("module").GetString() == m.Module
                && start.GetProperty("baseSha256").GetString() == m.BaseSha256
                && start.GetProperty("candidateSha256").GetString() == m.CandidateSha256,
                "The returned merge does not belong to this manifest.");
            Require(returned.RootElement.GetProperty("publishInvoked").GetBoolean() == false,
                "Reconciliation requires a returned merge before publication.");
            Require(!File.Exists(Path.Combine(m.EvidenceDir, "publish-started.json")), "Publication already started; read publish-status.");
            using var reconciledCandidate = Load(m.ReadCandidate());
            var messages = Messages(reconciledCandidate);
            return Dispatcher.UIThread.InvokeAsync(() => VerifyMerged(m, p, local, "reconciled", messages, c)).GetAwaiter().GetResult();
        }
        // Producer -> consumer: a producer merged or published in this bridge session after the base capture
        // invalidates only the bases of modules that reference it. Any other module goes on to the native
        // MatchTree check, which is what detects a real change of the open model. Proven on 2026-09-16: a
        // time-only rule refused a WrightFlood base whose bytes were unchanged after a merge on TestGap.
        var references = ((IESpace)local).Dependencies.Select(d => d.Name).ToHashSet();
        var producers = MergedAt.Where(x => x.Key != m.Module && x.Value > capturedAt).Select(x => (Name: x.Key, At: x.Value, What: "merged"))
            .Concat(PublishedAt.Where(x => x.Key != m.Module && x.Value > capturedAt).Select(x => (Name: x.Key, At: x.Value, What: "published"))).ToArray();
        var referenced = producers.Where(x => references.Contains(x.Name)).ToArray();
        if (referenced.Length > 0)
            throw new InvalidOperationException("Captured base of " + m.Module + " predates " + string.Join(", ", referenced.Select(x => x.What + " " + x.Name + " at " + x.At.ToString("o"))) + ", which " + m.Module + " references; the Studio may have updated the dependency. Capture a new snapshot and rebuild the candidate.");
        var unreferencedProducers = producers.Select(x => x.What + " " + x.Name + " at " + x.At.ToString("o")).ToArray();
        var basisBytes = m.ReadBase();
        m.RequireFreshBase();
        using var basis = Load(basisBytes);
        using (var current = new MatchTree(local, basis, basis, false, true)) {
            var file = mode switch { Mode.CheckBase => "current-vs-base.txt", Mode.Preview => "current-vs-base-preview.txt", _ => "current-vs-base-before-merge.txt" };
            File.WriteAllText(Path.Combine(m.EvidenceDir, file), current.Dump());
            if (mode == Mode.CheckBase) {
                var check = new { ok = current.HasNoDifferences, module = m.Module, baseSha256 = m.BaseSha256, baseAgeMinutes = (int)m.BaseAge().TotalMinutes, currentMatchesBase = current.HasNoDifferences, gate = current.HasNoDifferences ? "none" : "base_drift", unreferencedProducers, note = current.HasNoDifferences ? "Open module equals the captured base." : "Open module differs from the captured base: capture a new snapshot and rebuild the candidate." };
                File.WriteAllText(Path.Combine(m.EvidenceDir, "check-base.json"), JsonSerializer.Serialize(check, Json));
                // A mismatch is a refusal like any other gate, so the journal records base_drift.
                Require(current.HasNoDifferences, "Open " + m.Module + " differs from the captured base; capture a new snapshot and rebuild the candidate.");
                return check;
            }
            Require(current.HasNoDifferences, "Open " + m.Module + " differs from the captured base; capture a new snapshot and rebuild the candidate.");
        }
        var candidateBytes = m.ReadCandidate();
        var candidate = Load(candidateBytes);
        var handedOff = false;
        try {
            Require(candidate.Key == local.Key && basis.Key == local.Key, "Native module key mismatch between the open module, the base and the candidate.");
            var addedErrors = Errors(candidate).Except(Errors(basis)).ToArray();
            File.WriteAllText(Path.Combine(m.EvidenceDir, "candidate-validation.json"), JsonSerializer.Serialize(new { addedErrors }, Json));
            Require(addedErrors.Length == 0, "Candidate introduces validation errors: " + string.Join(" | ", addedErrors));
            bool conflicts, noDifferences;
            using (var tree = new MatchTree(local, candidate, basis, false, true)) {
                conflicts = tree.HasConflicts; noDifferences = tree.HasNoDifferences;
                File.WriteAllText(Path.Combine(m.EvidenceDir, "match-tree.txt"), tree.Dump());
            }
            var preview = new { ok = true, module = m.Module, conflicts, noDifferences, exactCapturedBase = true, baseSha256 = m.BaseSha256, candidateSha256 = m.CandidateSha256, unreferencedProducers, publishInvoked = false };
            File.WriteAllText(Path.Combine(m.EvidenceDir, "preview.json"), JsonSerializer.Serialize(preview, Json));
            if (mode == Mode.Preview) return preview;
            // The merge proves the preview's conditions itself (studio_deliver until=merge calls it without a preview).
            Require(!noDifferences, "Automatic merge requires clean, non-empty changes: the candidate has no changes over the open module (NO_CHANGE); nothing was merged.");
            Require(!conflicts, "Automatic merge requires clean, non-empty changes: the candidate conflicts with the open module (MERGE_CONFLICT; match-tree.txt names each conflict); nothing was merged.");
            Require(!File.Exists(Path.Combine(m.EvidenceDir, "merge-started.json")), "A merge was already attempted in this evidence directory; inspect its journal, never retry here.");
            var expectedMessages = Messages(candidate);
            // Merge order: defaults the Studio drops on elements a merge creates go in a second native merge of this command.
            var order = NativeMergeOrder.Prepare(candidate, basis, candidateBytes, Load);
            if (order.FirstPass != null) {
                File.WriteAllBytes(Path.Combine(m.EvidenceDir, "first-pass.oml"), order.FirstPass);
                File.WriteAllText(Path.Combine(m.EvidenceDir, "merge-order.json"), JsonSerializer.Serialize(new { rule = MergeOrder.Rule, deferred = MergeOrder.ToJson(order.Deferred), firstPassSha256 = Hash(order.FirstPass) }, Json));
            }
            File.WriteAllText(Path.Combine(m.EvidenceDir, "merge-started.json"), JsonSerializer.Serialize(new { at = DateTimeOffset.UtcNow, pid = Environment.ProcessId, module = m.Module, baseSha256 = m.BaseSha256, candidateSha256 = m.CandidateSha256, passes = order.FirstPass == null ? 1 : 2, publishInvoked = false }, Json));
            handedOff = true; c.HandedOff = true;
            string NativeMerge(ESpace into, ESpace foreign, ESpace over) => CompareAndMergeCommands.CompareAndMerge(p, into, foreign, over, false, automaticMerge: true, isFrom1CP: false).ToString();
            string outcome; object? second = null;
            if (order.FirstPass == null) outcome = NativeMerge(local, candidate, basis);
            else {
                candidate.Close();
                outcome = NativeMerge(local, Load(order.FirstPass), basis);
                Require(Dispatcher.UIThread.InvokeAsync(() => local.Match == null).GetAwaiter().GetResult(), "Native merge has a pending state after the first merge of the merge order.");
                var pass = NativeMergeOrder.SecondPass(local, candidateBytes, order.FirstPass, Load, NativeMerge);
                File.WriteAllText(Path.Combine(m.EvidenceDir, "second-pass-match-tree.txt"), pass.Dump);
                second = new { merged = pass.Merged, outcome = pass.Outcome, reason = pass.Reason };
                if (pass.Merged) outcome = pass.Outcome!;
            }
            File.WriteAllText(Path.Combine(m.EvidenceDir, "native-return.json"), JsonSerializer.Serialize(new { outcome, secondPass = second, publishInvoked = false }, Json));
            return Dispatcher.UIThread.InvokeAsync(() => VerifyMerged(m, p, local, outcome, expectedMessages, c)).GetAwaiter().GetResult();
        } finally { if (!handedOff) candidate.Close(); }
    }

    private static object VerifyMerged(Manifest m, IAggregatorPresenter p, ESpace local, string outcome, object[] expectedMessages, Context c) {
        Require(local.Match == null, "Native merge has a pending state.");
        using var expected = Load(m.ReadCandidate());
        NativeMergeVerification.Proof proof; var refreshedReferences = Array.Empty<string>();
        var lost = Array.Empty<DeferredDefault>();
        var forced = Array.Empty<NativeMergeVerification.ForcedDeleteRule>();
        var normalized = Array.Empty<NativeMergeVerification.Normalization>();
        // G-1 (C16): the rewrites the ODC Studio makes on every merge (NativeMergeVerification.Rewrites), proven element by
        // element; with forced delete rules they are the only differences a merge may keep and still answer ok:true.
        var rewrites = Array.Empty<NativeMergeVerification.Normalization>();
        var equivalence = Path.Combine(m.EvidenceDir, "native-equivalence.txt");
        try { proof = NativeMergeVerification.Verify(local, expected, m.Owners.ToHashSet(), equivalence); }
        catch (InvalidOperationException strict) {
            // Known classes: defaults the Studio removed (MergeOrder), delete rules it forced to Ignore, the properties it
            // rewrites on merge (Refresh Data Max. Records, Structure Public in an app) and the G-1 rewrites (a block instance's
            // derived name, Max. Records dropped from a Data Action refresh, a FontAwesome icon converted to Phosphor). When
            // nothing else differs the outcome is known exactly, and the answer names each element.
            var dump = File.ReadAllText(equivalence);
            lost = MergeOrder.Lost(local, expected).ToArray();
            forced = NativeMergeVerification.ForcedDeleteRules(dump);
            var icons = NativeMergeVerification.IconConversions(local, expected);
            var all = NativeMergeVerification.Normalizations(dump, icons);
            normalized = all.Where(n => !NativeMergeVerification.Rewrites.Contains(n.Kind)).ToArray();
            rewrites = all.Where(n => NativeMergeVerification.Rewrites.Contains(n.Kind)).ToArray();
            var named = lost.Select(d => { var parts = d.Element.Split('.'); return new NativeMergeVerification.LostDefault(parts.Length > 1 ? parts[^2] : "", parts[^1], d.Value); }).ToArray();
            NativeMergeVerification.Proof? knownOnly = null;
            if (lost.Length + forced.Length + all.Length > 0)
                try { knownOnly = NativeMergeVerification.Verify(local, expected, m.Owners.ToHashSet(), equivalence, named, forced, all, icons); }
                catch (InvalidOperationException) { }
            if (knownOnly != null) proof = knownOnly;
            else {
                // A merge that adds a dependency makes the Studio refresh that reference from the server. A difference
                // confined to references is that native refresh; anything else keeps the strict refusal.
                using var tree = new MatchTree(local, expected, expected, false, true);
                var (outside, refreshed) = DifferencesOutsideReferences(tree, local, includeNonVisible: true);
                File.WriteAllText(Path.Combine(m.EvidenceDir, "native-equivalence-references.json"), JsonSerializer.Serialize(new { strictError = strict.Message, refreshedReferences = refreshed, differencesOutsideReferences = outside, lostDefaults = MergeOrder.ToJson(lost), forcedDeleteRules = forced, normalizations = normalized }, Json));
                if (outside.Length > 0 || refreshed.Length == 0) {
                    // Uncertain: one line per divergence of the comparison, never a stack trace.
                    var divergences = NativeMergeVerification.Divergences(dump);
                    var known = lost.Length + forced.Length + all.Length == 0 ? "" : "; among the differences, " + KnownLosses(lost, forced, all) + ", and other differences remain";
                    throw new MergeDiagnostics.MergeUncertainException(strict.Message + known, divergences, strict);
                }
                refreshedReferences = refreshed; lost = Array.Empty<DeferredDefault>(); forced = Array.Empty<NativeMergeVerification.ForcedDeleteRule>(); normalized = Array.Empty<NativeMergeVerification.Normalization>();
                rewrites = Array.Empty<NativeMergeVerification.Normalization>();
                proof = new NativeMergeVerification.Proof(true, false, 0, Array.Empty<NativeMergeVerification.LayoutAddition>());
            }
        }
        using var basis = Load(m.ReadBase());
        var addedErrors = Errors(local).Except(Errors(basis)).ToArray();
        Require(addedErrors.Length == 0, "Merge introduces validation errors: " + string.Join(" | ", addedErrors));
        var newMessages = NewMessages(local, expectedMessages);
        File.WriteAllText(Path.Combine(m.EvidenceDir, "new-messages.json"), JsonSerializer.Serialize(newMessages, Json));
        // G-2 (A03, C16): after the merge only errors and security warnings (SecurityWarnings.IsSecurity) block, as in the
        // kernel, the builder and the O11 LiveContract; every other new live message is a warning of the receipt.
        var blocking = newMessages.Where(x => MergeDiagnostics.BlocksAfterMerge(x as JsonObject)).ToArray();
        var warnings = newMessages.Except(blocking).ToArray();
        Require(blocking.Length == 0, "New live validation diagnostics after merge: " + blocking.Length + " (ids: " + string.Join(", ", blocking.Select(x => (x as JsonObject)?["id"]?.ToString()).Where(id => id != null).Distinct().Take(5)) + "); new-messages.json names each owner and its addressableKey for ssam_map and studio_inspect.");
        using var stream = local.SaveToMemoryStream(); var bytes = stream.ToArray();
        var path = Path.Combine(m.EvidenceDir, "after-merge.oml"); File.WriteAllBytes(path, bytes);
        MergedAt[m.Module] = DateTimeOffset.UtcNow;
        var others = RecordOthers(m, p);
        // Only the Studio's own rewrites (G-1) and delete rules it forced to Ignore remain: merged and equal but for them.
        if (lost.Length + normalized.Length == 0 && forced.Length + rewrites.Length > 0) {
            var notes = forced.Select(f => new NormalizedNote(f.Parent + "." + f.Name, "ForcedDeleteRule", "Ignore", f.Requested))
                .Concat(rewrites.Select(n => new NormalizedNote(n.Parent + "/" + n.Element, n.Kind, n.Local, n.Candidate))).ToArray();
            var normalizedReceipt = new {
                ok = true, merged = true, module = m.Module, outcome, equivalence = "normalized", normalized = notes.Take(20).ToArray(), normalizedTotal = notes.Length,
                sha256 = Hash(bytes), afterSnapshot = path, strictlyEqual = false, emptyLayoutProperties = proof.EmptyLayoutProperties, warnings,
                developerId = Developer(local), publishInvoked = false, completedAt = DateTimeOffset.UtcNow, otherOpenModules = others
            };
            File.WriteAllText(Path.Combine(m.EvidenceDir, "receipt.json"), JsonSerializer.Serialize(normalizedReceipt, Json));
            c.Note = "merged; normalized by the Studio: " + string.Join(", ", notes.Select(n => n.Rule).Distinct());
            return normalizedReceipt;
        }
        if (lost.Length + forced.Length + normalized.Length > 0) {
            normalized = normalized.Concat(rewrites).ToArray();
            // Merged, and everything else proven equal: not uncertain. The elements exist now, so a merge keeps the defaults;
            // a forced delete rule is the only one this environment allows, so the job declares it; a normalized property is
            // the value the Studio keeps, so the job omits it (Max. Records) or declares the kept value (Public False).
            var declare = new JsonObject { ["ops"] = new JsonArray(forced.Select(f => (JsonNode)new JsonObject { ["op"] = "set", ["target"] = AttributeTarget(expected, f.Parent, f.Name), ["prop"] = "DeleteRule", ["value"] = "Ignore" })
                .Concat(normalized.Where(n => n.Kind == "Structure").Select(n => (JsonNode)new JsonObject { ["op"] = "set", ["target"] = "IStructure:" + n.Element, ["prop"] = "Public", ["value"] = false })).ToArray()) };
            var error = "Native merge kept the candidate except: " + KnownLosses(lost, forced, normalized) + "." +
                (lost.Length > 0 ? " Each element exists now, so a merge keeps a default set on it: deliver the repair job (repair) from a new snapshot." : "") +
                (forced.Length > 0 ? " This environment allows only Delete Rule Ignore on those references: declare it in the job (declare) so the next candidate equals the module." : "") +
                (normalized.Length > 0 ? " The Studio rewrites those properties on every merge: " + string.Join(" ", normalized.Select(n => n.Kind).Distinct().Select(NormalizationFix)) : "") +
                " Nothing was published.";
            var incomplete = new {
                ok = false, merged = true, outcome = "incomplete", gate = "known_losses", module = m.Module, mergeOutcome = outcome, error,
                missing = MergeOrder.ToJson(lost), repair = MergeOrder.RepairJob(lost), rule = MergeOrder.Rule,
                forcedDeleteRules = forced.Select(f => new { element = f.Parent + "." + f.Name, requested = f.Requested, kept = "Ignore" }).ToArray(), declare,
                normalized = normalized.Select(n => new { element = n.Parent + "/" + n.Element, kind = n.Kind, property = n.Property, local = n.Local, candidate = n.Candidate, fix = NormalizationFix(n.Kind) }).ToArray(),
                sha256 = Hash(bytes), afterSnapshot = path, strictlyEqual = false, developerId = Developer(local),
                publishInvoked = false, completedAt = DateTimeOffset.UtcNow, otherOpenModules = others
            };
            File.WriteAllText(Path.Combine(m.EvidenceDir, "incomplete-receipt.json"), JsonSerializer.Serialize(incomplete, Json));
            // A gate of its own: "equivalence" means a merge pending in the Studio (never repeat); this one is merged and
            // proven equal but for the named losses, whose repair the facade delivers as a new job.
            c.Outcome = "incomplete"; c.GateName = "known_losses"; c.Note = error;
            return incomplete;
        }
        var receipt = new {
            ok = true, merged = true, module = m.Module, outcome, sha256 = Hash(bytes), afterSnapshot = path,
            strictlyEqual = proof.StrictlyEqual, equivalence = proof.StrictlyEqual ? "strict" : null, emptyLayoutProperties = proof.EmptyLayoutProperties, refreshedReferences, warnings,
            developerId = Developer(local), publishInvoked = false, completedAt = DateTimeOffset.UtcNow, otherOpenModules = others
        };
        File.WriteAllText(Path.Combine(m.EvidenceDir, "receipt.json"), JsonSerializer.Serialize(receipt, Json));
        return receipt;
    }

    // The known losses of a merge, named for the answer: defaults the Studio removed, delete rules it forced to Ignore,
    // properties it normalized.
    private static string KnownLosses(DeferredDefault[] lost, NativeMergeVerification.ForcedDeleteRule[] forced, NativeMergeVerification.Normalization[]? normalized = null) => string.Join("; ", new[] {
        lost.Length > 0 ? "the native merge did not keep " + lost.Length + " default value(s): " + MergeOrder.Describe(lost) : null,
        forced.Length > 0 ? "the Studio set Delete Rule Ignore on " + string.Join(", ", forced.Select(f => f.Parent + "." + f.Name + " (requested " + f.Requested + ")")) + " and removed their automatic indexes" : null,
        normalized is { Length: > 0 } ? "the Studio normalized " + string.Join(", ", normalized.Select(n => n.Parent + "/" + n.Element + " " + n.Property + " to " + n.Local + " (candidate " + n.Candidate + ")")) : null,
    }.Where(s => s != null));
    private static string NormalizationFix(string kind) => kind switch {
        "Structure" => "an app keeps Structure Public False (ODC_STRUCTURE_PUBLIC_IN_APP): return flat outputs, use a public entity, or move the structure to a library.",
        NativeMergeVerification.CustomNameTrio => "the Studio derives a block instance's name from its block (CustomNameIsSuffix True): create the instance without a name.",
        NativeMergeVerification.RefreshMaxRecordsRemoved => "a Data Action has no Max. Records: the refresh of a Data Action takes none.",
        NativeMergeVerification.IconConversion => "the Studio converts a FontAwesome icon to its Phosphor name and weight: write the Phosphor name.",
        _ => "the Refresh Data takes the Max. Records of its aggregate (ODC_REFRESH_MAXRECORDS): omit MaxRecords on the refresh; set Max. Records on the aggregate.",
    };
    // One element the Studio rewrote on merge, as studio_deliver answers it (I8): element, rule, the module's and the
    // candidate's value.
    private sealed record NormalizedNote(string Element, string Rule, string Local, string Candidate);

    // The target of a declaration op for entity attribute Parent.Name: "@ObjectKey" when the candidate holds exactly one.
    private static string AttributeTarget(ESpace model, string parent, string name) {
        var keys = model.GetAllChildrenOfType<OutSystems.Model.Data.IEntityAttribute>().Where(a => a.Name == name && (a as AbstractObject)?.GetParent()?.Name == parent).Select(a => a.ObjectKey?.ToString()).ToArray();
        return keys.Length == 1 && keys[0] != null ? "@" + keys[0] : "IServerEntity:" + parent + "/" + name;
    }

    // After a merge the Studio may update the other open modules' dependency on this one.
    // Their state is recorded so the next builder knows it must start from a fresh snapshot.
    private static object[] RecordOthers(Manifest m, IAggregatorPresenter merged) {
        var list = new List<object>();
        foreach (var a in RuntimeImplementation.Instance.Aggregators.Where(x => x.ActiveESpace != null && !ReferenceEquals(x, merged))) {
            var s = a.ActiveESpace!;
            try { list.Add(new { module = s.Name, moduleKey = s.Key.ToString(), mergePending = s.Match != null, modified = s.WasModifiedSinceLastSave, dependencies = ((IESpace)s).Dependencies.Select(d => new { d.Name, d.Revision }).ToArray() }); }
            catch (Exception error) { list.Add(new { module = s.Name, error = error.Message }); }
        }
        var result = list.ToArray();
        File.WriteAllText(Path.Combine(m.EvidenceDir, "consumer-capture-required.json"), JsonSerializer.Serialize(new { note = "Modules listed here that reference " + m.Module + " need a new snapshot before their next candidate; the bridge refuses their older bases. Modules that do not reference it are checked by the native MatchTree as usual.", mergedModule = m.Module, at = DateTimeOffset.UtcNow, modules = result }, Json));
        return result;
    }

    // Step 6: publication, only with the user's explicit authorization recorded in the manifest.
    // Usage: publish <manifest> [--wait [minutes]]. With --wait the command follows the server process to its end,
    // lets the watchdog close the publication notice, downloads the published revision and compares it with the
    // open module through the native MatchTree, returning one receipt (publish-receipt.json).
    private static async Task<object> Publish(string argument, Context c) {
        var parts = argument.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var manifestPath = parts[0];
        var wait = parts.Contains("--wait");
        var waitMinutes = wait && int.TryParse(parts.LastOrDefault(), out var minutes) ? minutes : 10;
        await CloseInformational(c);
        var dispatched = await PublishDispatch(manifestPath, c);
        if (!wait) return dispatched;
        var m = Manifest.Load(manifestPath);
        var p = await Ui(() => Active(m.ModuleKey));
        var started = DateTimeOffset.UtcNow; var seenRunning = false; object[] processes = Array.Empty<object>();
        while (true) {
            await Task.Delay(2000);
            processes = await Ui(() => ServerProcesses(p));
            if (Running(processes)) seenRunning = true;
            else if (seenRunning || (DateTimeOffset.UtcNow - started).TotalSeconds > 15) break;
            if ((DateTimeOffset.UtcNow - started).TotalMinutes > waitMinutes)
                throw new PublishFailedException("Publication of " + m.Module + " is still running after " + waitMinutes + " min; use publish-log, publish-status and latest, never republish. Processes: " + JsonSerializer.Serialize(processes), await SafePublishLog(p, false));
        }
        var serverSeconds = Math.Round((DateTimeOffset.UtcNow - started).TotalSeconds, 1);
        await CloseInformational(c);
        var state = processes.Select(x => Member(x, "state")?.ToString()).FirstOrDefault(x => x != null) ?? "unknown";
        var success = state.StartsWith("CompletedWithSuccess", StringComparison.OrdinalIgnoreCase);
        object? download = null; string? note = null;
        if (success) {
            try {
                var latest = await Latest(m.Module, new Context());
                var path = Member(latest, "path")!.ToString()!;
                var (outside, refreshed, equal) = await Ui(() => {
                    using var published = Load(File.ReadAllBytes(path));
                    using var tree = new MatchTree(p.ActiveESpace, published, published, false, true);
                    TryWrite(Path.Combine(m.EvidenceDir, "open-vs-published.txt"), tree.Dump());
                    var (o, r) = DifferencesOutsideReferences(tree, p.ActiveESpace);
                    return (o, r, tree.HasNoDifferences);
                });
                download = new { revision = Member(latest, "revision"), path, sha256 = Member(latest, "sha256"), matchesOpenModule = outside.Length == 0, strictlyEqual = equal, refreshedReferences = refreshed, differencesOutsideReferences = outside };
                note = outside.Length == 0 ? "Published revision equals the open module." : "Published revision differs from the open module outside references; inspect open-vs-published.txt.";
            } catch (Exception error) { download = new { error = error.Message }; note = "Publication completed but the revision could not be downloaded and compared."; }
            PublishedAt[m.Module] = DateTimeOffset.UtcNow;
        } else note = "Publication did not complete with success; publishLog carries every message of the Studio messages pane (type, text, element, stage).";
        // The log of this publication, read from the same pane the person sees (publish-log): every message on failure.
        var publishLog = success ? null : await SafePublishLog(p, true);
        var receipt = new { ok = success, module = m.Module, moduleKey = m.ModuleKey, dispatched = true, completed = true, state, processes, serverSeconds, published = download, dialogsClosed = c.Closed.ToArray(), completedAt = DateTimeOffset.UtcNow, note, publishLog };
        TryWrite(Path.Combine(m.EvidenceDir, "publish-receipt.json"), receipt);
        if (!success) {
            // Counts only: the message texts stay in publishLog, so they never steer the journal's gate classification.
            var counts = publishLog != null && Member(publishLog, "lastPublish") is object last && Member(last, "counts") is object n ? " with " + Member(n, "errors") + " error(s) and " + Member(n, "warnings") + " warning(s)" : "";
            throw new PublishFailedException("Publication of " + m.Module + " ended in state " + state + counts + ". " + note, publishLog!);
        }
        return receipt;
    }

    private static async Task<object> PublishDispatch(string manifestPath, Context c) {
        var m = Manifest.Load(manifestPath); c.Bind(m);
        Require(!string.IsNullOrWhiteSpace(m.PublishAuthorization), "publish requires manifest.publishAuthorization with the user's explicit authorization text.");
        var receiptPath = Path.Combine(m.EvidenceDir, "receipt.json");
        Require(File.Exists(receiptPath), "publish requires a completed merge receipt in the evidence directory.");
        string? expectedOpenHash; bool created;
        using (var receipt = JsonDocument.Parse(File.ReadAllText(receiptPath))) {
            var r = receipt.RootElement;
            created = r.TryGetProperty("created", out var flag) && flag.GetBoolean();
            Require(r.GetProperty("ok").GetBoolean() && (created || r.GetProperty("merged").GetBoolean()), "Receipt is neither a successful merge nor a successful creation.");
            expectedOpenHash = r.GetProperty("sha256").GetString();
        }
        Require(!File.Exists(Path.Combine(m.EvidenceDir, "publish-started.json")), "Publication already requested in this evidence directory; use publish-status, never retry.");
        var p = await Ui(() => Active(m.ModuleKey));
        var done = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
        await p.ExecuteInContext(() => {
            try {
                var s = p.ActiveESpace;
                Guard(m, p);
                Require(!p.BottomPanePresenter.ChildPresenters.OfType<IServerMessagesPanePresenter>().Any(i => i.ServerProcess?.CurrentState.ToString() == "Running"), "Another server operation is running.");
                if (m.ExpectedPublishedRevision != null) {
                    using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
                    var d = ((IServerCommunicationsServicesProvider)p.ServerCommunicationsProvider).DownloadService.DownloadESpace(0, s.Key, timeout.Token);
                    Require(d.Success && d.IsPublishedVersion && d.AssetInfo != null && d.AssetInfo.Revision.ToString() == m.ExpectedPublishedRevision.ToString(), "Latest published revision changed since the manifest was written; re-evaluate before publishing.");
                }
                using (var stream = s.SaveToMemoryStream()) {
                    var bytes = stream.ToArray();
                    if (created) {
                        // A created module opened from the organization is not byte-identical to the uploaded
                        // candidate (server upload metadata); the native MatchTree decides equivalence.
                        using var expected = Load(m.ReadCandidate());
                        using var tree = new MatchTree(s, expected, expected, false, true);
                        File.WriteAllText(Path.Combine(m.EvidenceDir, "open-vs-candidate.txt"), tree.Dump());
                        var (outside, refreshed) = DifferencesOutsideReferences(tree, s);
                        File.WriteAllText(Path.Combine(m.EvidenceDir, "open-vs-candidate.json"), JsonSerializer.Serialize(new { equal = tree.HasNoDifferences, refreshedReferences = refreshed, differencesOutsideReferences = outside }, Json));
                        Require(outside.Length == 0, "Open module differs from the created candidate outside its references; do not publish an unverified model: " + string.Join("; ", outside.Take(10)));
                    } else Require(Hash(bytes) == expectedOpenHash, "Open module differs from the merged receipt; do not publish an unverified model.");
                    File.WriteAllBytes(Path.Combine(m.EvidenceDir, "before-publish.oml"), bytes);
                }
                Require(!((IESpace)s).GetValidationMessages().Any(x => x.Type.ToString() == "Error"), "Native validation errors block publication.");
                File.WriteAllText(Path.Combine(m.EvidenceDir, "publish-started.json"), JsonSerializer.Serialize(new { at = DateTimeOffset.UtcNow, pid = Environment.ProcessId, module = m.Module, authorization = m.PublishAuthorization, openSha256 = expectedOpenHash }, Json));
                c.HandedOff = true;
                AutoRegistryType<ServiceStudio.Presenter.Commands.Publish>.Instance.Execute(p, p);
                PublishedAt[m.Module] = DateTimeOffset.UtcNow;
                File.WriteAllText(Path.Combine(m.EvidenceDir, "publish-dispatched.json"), JsonSerializer.Serialize(new { at = DateTimeOffset.UtcNow }, Json));
                done.SetResult(new { ok = true, dispatched = true, module = m.Module, publishInvoked = true, note = "Publication dispatched. Confirm with publish-status, then latest, and compare the downloaded revision with after-merge.oml." });
            } catch (Exception error) { done.SetException(error); }
        }, executeWhenTopLevelIsIdle: true);
        return await done.Task;
    }

    private static object PublishStatus(string manifestPath, Context c) {
        var m = Manifest.Load(manifestPath); c.Bind(m);
        var p = Active(m.ModuleKey); var s = p.ActiveESpace;
        var processes = ServerProcesses(p);
        var result = new { ok = true, module = s.Name, published = s.IsPublishedVersion, modified = s.WasModifiedSinceLastSave, lastUpload = s.LastUploadDateTime, mergePending = s.Match != null, processes };
        File.WriteAllText(Path.Combine(m.EvidenceDir, "publish-status.json"), JsonSerializer.Serialize(result, Json));
        return result;
    }
}
