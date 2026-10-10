using System.Text.Json;
using OutSystems.Model;
using ServiceStudio.Model;
using ServiceStudio.Presenter;
using ServiceStudio.Presenter.Commands;

// publish-log: the result of the LAST publication of an open module in this ODC Studio, whoever started it (the person
// in the Studio, studio_publish or studio_create_app): state, time, revision and every message of the cloud
// build/publish with type, text, element and stage, read from the Studio's own server messages pane (see
// PublishLogCore.cs for the native source). Read-only: nothing is published, saved or closed, and no dialog is touched.
// The last log of each module is kept under journal\publish-log, so it is still answered after the person closes the pane.
// Usage: publish-log [<Module|key>] [--no-resolve]
internal static partial class Bridge
{
    // The step rows the Publish command adds (Publish.ServerProcess step switch: Upload, Compile/NRCompile, Publish).
    private static readonly Lazy<Dictionary<string, string>> PublishStepStages = new(() => {
        var stages = new Dictionary<string, string>();
        void Add(PresenterMessageId id, string stage) { try { if (id?.Id != null) stages.TryAdd(id.Id, stage); } catch { } }
        Add(PresenterMessageId.OneCP_Upload, "upload");
        Add(PresenterMessageId.OneCP_Compile, "compilation");
        Add(PresenterMessageId.OneCP_NRCompile, "compilation");
        Add(PresenterMessageId.PhoenixOneCP_NRCompile, "compilation");
        Add(PresenterMessageId.OneCP_Publish, "deploy");
        Add(PresenterMessageId.OneCP_PublishWithoutDeploy, "deploy");
        return stages;
    });

    // Raised by publish --wait when the server process ends without success: the Serve loop answers its log.
    internal sealed class PublishFailedException : InvalidOperationException {
        public object PublishLog { get; }
        public PublishFailedException(string message, object publishLog) : base(message) { PublishLog = publishLog; }
    }

    private static string PublishLogCache(string module) => Path.Combine(Root, "journal", "publish-log", string.Concat(module.Select(ch => Path.GetInvalidFileNameChars().Contains(ch) ? '_' : ch)) + ".json");

    private static async Task<object> PublishLog(string argument, Context c) {
        var parts = argument.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
        var resolve = !parts.Remove("--no-resolve");
        Require(parts.Count <= 1, "publish-log takes at most one module name or key: publish-log [<Module|key>] [--no-resolve].");
        return await Ui(() => {
            if (parts.Count == 1) { var p = Active(parts[0]); c.Module = p.ActiveESpace.Name; c.ModuleKey = p.ActiveESpace.Key.ToString(); return ModulePublishLog(p, resolve); }
            var open = RuntimeImplementation.Instance.Aggregators.Where(a => a.ActiveESpace != null).ToArray();
            if (open.Length == 1) { c.Module = open[0].ActiveESpace.Name; c.ModuleKey = open[0].ActiveESpace.Key.ToString(); return ModulePublishLog(open[0], resolve); }
            return new { ok = true, source = "ServerMessagesPane", note = open.Length == 0 ? "No module is open in this ODC Studio." : "Several modules are open: name one for every message (publish-log <Module>).",
                modules = open.Select(a => new { module = a.ActiveESpace!.Name, moduleKey = a.ActiveESpace.Key.ToString(), lastPublish = LastPublishCompact(a) }).ToArray() };
        });
    }

    // The newest publish pane of the module: the server messages panes of its bottom pane, Publish operations only.
    private static IServerMessagesPanePresenter? LastPublishPane(IAggregatorPresenter p) =>
        p.BottomPanePresenter.ChildPresenters.OfType<IServerMessagesPanePresenter>()
            .Where(i => i.ServerProcess == null ? i.Messages.Any() : i.ServerProcess.ServerOperationType == ServerOperationType.Publish)
            .OrderByDescending(i => i.ServerOperationId).FirstOrDefault();

    private static PublishLogCore.Row RowOf(OutSystems.RuntimeCommon.MessageDefinition m) => new(m.Id, m.Type.ToString(), m.Message, m.Detail);

    // name -> (key, kind) over the open model, built once per call and only when a message names something.
    private static Func<string, (string Key, string Kind)?> ModelResolver(ESpace s) {
        Dictionary<string, (string Key, string Kind)>? index = null;
        return name => {
            if (index == null) {
                index = new Dictionary<string, (string, string)>(StringComparer.OrdinalIgnoreCase);
                var ambiguous = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var stack = new Stack<IModelObject>(); stack.Push((IESpace)s); var seen = 0;
                while (stack.Count > 0 && seen++ < 200000) {
                    var node = stack.Pop();
                    try {
                        var n = node.DisplayName;
                        if (!string.IsNullOrWhiteSpace(n) && !ambiguous.Contains(n) && !index.TryAdd(n, (node.Key?.ToString() ?? "", node.GetType().Name))) { index.Remove(n); ambiguous.Add(n); }
                        foreach (var child in node.Children) stack.Push(child);
                    } catch { }
                }
            }
            return index.TryGetValue(name, out var hit) ? hit : null;
        };
    }

    // The publish operation key the Studio polled (BaseEspace1CPProcess.PublishRequestResult.Key, kept by the Publish
    // ServerProcess as its publicationId): the only GUID-valued string field of the process. Null when not found.
    private static string? PublicationKey(ServerProcess? process) {
        if (process == null) return null;
        try {
            foreach (var field in Fields(process.GetType()))
                if (field.FieldType == typeof(string) && field.GetValue(process) is string value && Guid.TryParse(value, out _)) return value;
        } catch { }
        return null;
    }

    private static object? TryRead(Func<object?> read) { try { return read(); } catch { return null; } }

    // The log for a publish receipt or refusal: never throws, so a failure to read it never hides the publication's outcome.
    private static async Task<object> SafePublishLog(IAggregatorPresenter p, bool resolve) {
        try { return await Ui(() => ModulePublishLog(p, resolve)); }
        catch (Exception error) { return new { ok = false, error = "publish-log could not be read: " + error.GetBaseException().Message }; }
    }

    // Full log of the last publish of one module (UI thread). Answers the cache when the pane is gone.
    private static object ModulePublishLog(IAggregatorPresenter p, bool resolve) {
        var s = p.ActiveESpace;
        var pane = LastPublishPane(p);
        var host = p.ServerCommunicationsProvider?.LoginInfo?.HostInfo?.Hostname;
        if (pane == null) {
            var cache = PublishLogCache(s.Name);
            if (File.Exists(cache)) {
                try {
                    var cached = JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(cache));
                    return new { ok = true, module = s.Name, moduleKey = s.Key.ToString(), host, found = true, fromCache = true, cachedAt = File.GetLastWriteTimeUtc(cache).ToString("o"),
                        note = "The Studio's messages pane of that publication was closed; this is the log the bridge read last. A newer publication shows here once the bridge reads it.",
                        lastPublish = cached.TryGetProperty("lastPublish", out var lp) ? lp : cached };
                } catch { }
            }
            return new { ok = true, module = s.Name, moduleKey = s.Key.ToString(), host, found = false, source = "ServerMessagesPane",
                note = "No publication of " + s.Name + " in this Studio session (no messages pane, no earlier log). Publications made elsewhere are read with odc_read deployments-api-v1:get:/publish-operations?assetKey=" + s.Key + " and odc_operation_status {kind:\"publish\", operationKey, messages:true}." };
        }
        var log = PublishLogCore.Build(pane.Messages.Select(RowOf), PublishStepStages.Value, resolve ? ModelResolver(s) : null);
        var lastPublish = LastPublishBody(p, pane, log);
        var result = new { ok = true, module = s.Name, moduleKey = s.Key.ToString(), host, found = true, fromCache = false, source = "ServerMessagesPane",
            nativeSource = "IServerMessagesPanePresenter.Messages of the Publish ServerProcess; the server messages are Deployments API v1 publish-operations/{key}/messages as polled by PublishService.CheckPublish",
            lastPublish };
        TryWrite(PublishLogCache(s.Name), new { module = s.Name, moduleKey = s.Key.ToString(), host, readAt = DateTimeOffset.UtcNow.ToString("o"), lastPublish });
        return result;
    }

    private static object LastPublishBody(IAggregatorPresenter p, IServerMessagesPanePresenter pane, PublishLogCore.Log log) {
        var s = p.ActiveESpace; var process = pane.ServerProcess;
        var state = process?.CurrentState.ToString() ?? "unknown";
        var running = process?.CurrentState == ServerOperationState.Running;
        var succeeded = process != null && process.CurrentState.ToString().StartsWith("CompletedWithSuccess", StringComparison.Ordinal);
        var failed = process?.CurrentState == ServerOperationState.CompletedWithFailure;
        return new {
            operation = process?.ServerOperationType.ToString() ?? "Publish", serverOperationId = pane.ServerOperationId, state, innerState = process?.InnerState.ToString(),
            running, completed = process != null && !running, succeeded, failed,
            publicationKey = PublicationKey(process),
            revision = TryRead(() => { var info = Member(s, "ApplicationInfo"); return info == null ? null : Member(info, "Revision"); }),
            lastUploadAt = TryRead(() => s.LastUploadDateTime == default ? null : s.LastUploadDateTime.ToUniversalTime().ToString("o")),
            lastUploadUser = TryRead(() => s.LastUploadUser),
            durationSeconds = TryRead(() => s.LastPublishDuration > 0 ? Math.Round(s.LastPublishDuration, 1) : null),
            ssamDispatchedAt = PublishedAt.TryGetValue(s.Name, out var at) ? at.ToString("o") : null,
            summary = PublishLogCore.Summary(state, log),
            stages = log.Stages, lastStage = log.LastStage,
            counts = new { errors = log.Errors, warnings = log.Warnings, infos = log.Infos },
            messages = log.Messages.Select(m => new { type = m.Type, text = m.Text, detail = m.Detail, stage = m.Stage,
                element = m.Element == null ? null : new { name = m.Element.Name, key = m.Element.Key, kind = m.Element.Kind, source = m.Element.Source }, code = m.Code }).ToArray()
        };
    }

    // The compact form for status: state, counts and the first error, no element resolution (UI thread).
    private static object? LastPublishCompact(IAggregatorPresenter a) {
        try {
            var pane = LastPublishPane(a);
            if (pane == null) {
                var cache = PublishLogCache(a.ActiveESpace.Name);
                if (!File.Exists(cache)) return null;
                using var cached = JsonDocument.Parse(File.ReadAllText(cache));
                var lp = cached.RootElement.GetProperty("lastPublish");
                return new { fromCache = true, state = lp.GetProperty("state").GetString(), summary = lp.TryGetProperty("summary", out var sm) ? sm.GetString() : null,
                    errors = lp.GetProperty("counts").GetProperty("errors").GetInt32(), warnings = lp.GetProperty("counts").GetProperty("warnings").GetInt32() };
            }
            var log = PublishLogCore.Build(pane.Messages.Select(RowOf), PublishStepStages.Value);
            var state = pane.ServerProcess?.CurrentState.ToString() ?? "unknown";
            return new { fromCache = false, state, running = pane.ServerProcess?.CurrentState == ServerOperationState.Running, lastStage = log.LastStage,
                errors = log.Errors, warnings = log.Warnings, summary = PublishLogCore.Summary(state, log) };
        } catch (Exception error) { return new { error = error.GetBaseException().Message }; }
    }
}
