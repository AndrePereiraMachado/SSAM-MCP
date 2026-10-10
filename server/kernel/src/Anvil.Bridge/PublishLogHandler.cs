using System.Collections;
using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.RuntimeCommon;
using ServiceStudio.Model;
using ServiceStudio.Presenter;

namespace Anvil.Bridge;

/// <summary>
/// publish_log {module?, max?}: the result of the LAST 1-Click Publish of the active (or named, open) module, whoever
/// triggered it (the person in the Studio or the bridge's own publish), read from where the Studio shows it.
/// Native source (Service Studio 11.55.91, ServiceStudio.Presenter.dll): each server operation writes to its own
/// IServerMessagesPanePresenter (ServerMessagesPanePresenter, the 1-Click Publish tab of the bottom pane), which the
/// aggregator keeps in a private IDictionary&lt;int, IServerMessagesPanePresenter&gt; by ServerOperationId
/// (IAggregatorPresenter.GetServerMessagesPanePresenter(int) is internal; the entry leaves when the person closes the tab).
/// The pane exposes the rows (IDataGridEditorPresenter.RootItems -> Message&lt;MessageDefinition&gt; {ExtraInfo, DateTime}),
/// the MessageDefinitions (Messages) and its ServerProcess {ServerOperationType, CurrentState, InnerState, ESpace}.
/// ServerProcess.Execute sets CompletedWithFailure after the server messages arrived (ProcessOrchestrationMessageHandler ->
/// AddServerMessage); the step rows come from ServerProcess.AddStep (PresenterMessageId.OneCP_*). Read only, UI thread.
/// The resolver of quoted names (ResolverFor) lives in PublishLogResolver.cs: the full bridge resolves them to model
/// elements, the thin bridge returns null (the element comes only from ExtraInfo).
/// </summary>
internal static partial class PublishLogHandler
{
    private const BindingFlags Instance = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

    // ServerOperationIds of the publications this bridge started, per module key (PublishHandler records them).
    private static readonly ConcurrentDictionary<string, int> BridgeOperations = new();

    internal static void RecordBridgeOperation(string moduleKey, int serverOperationId) => BridgeOperations[moduleKey] = serverOperationId;

    private static readonly Lazy<IReadOnlyDictionary<string, string>> StepStages = new(() =>
    {
        var stages = new Dictionary<string, string>(StringComparer.Ordinal);
        void Add(PresenterMessageId id, string stage)
        {
            try { var d = MessageDefinition.GetMessage(id); if (!string.IsNullOrEmpty(d.Id)) stages[d.Id] = stage; } catch { /* other build */ }
        }
        Add(PresenterMessageId.OneCP_Save, PublishLog.Save);
        Add(PresenterMessageId.OneCP_Upload, PublishLog.Upload);
        Add(PresenterMessageId.OneCP_Compile, PublishLog.Compile);
        Add(PresenterMessageId.OneCP_NRCompile, PublishLog.Compile);
        Add(PresenterMessageId.OneCP_Publish, PublishLog.Deploy);
        Add(PresenterMessageId.OneCP_PublishWithoutDeploy, PublishLog.Deploy);
        return stages;
    });

    public static Task<string> Handle(JsonObject? p) => Reads.OnUi(() =>
    {
        var max = p?["max"]?.GetValue<int>() ?? 60;
        var (agg, e) = Target(p?["module"]?.GetValue<string>(), p);
        return Server.Ok(Read(agg, e, null, Math.Clamp(max, 1, 500)));
    });

    /// <summary>The named module's own tab (no selection change: a read never switches tabs), else the active one.</summary>
    internal static (IAggregatorPresenter Aggregator, ESpace Module) Target(string? module, JsonObject? p)
    {
        if (string.IsNullOrWhiteSpace(module))
        {
            var (agg, e) = Studio.Active();
            Studio.RequireTarget(agg, e, p);
            return (agg, e);
        }
        var open = Studio.Aggregators().Where(a => a.ActiveESpace != null).ToList();
        var matches = open.Where(a => string.Equals(a.ActiveESpace!.Name, module.Trim(), StringComparison.OrdinalIgnoreCase)).ToList();
        if (matches.Count == 0)
            throw new InvalidOperationException($"module '{module}' is not open in the Studio (open: {string.Join(", ", open.Select(a => a.ActiveESpace!.Name).Distinct())})");
        if (matches.Count > 1)
        {
            var active = Studio.ActiveAggregator();
            var selected = matches.FirstOrDefault(a => ReferenceEquals(a, active))
                ?? throw new InvalidOperationException($"module '{module}' is open in {matches.Count} tabs: select the one to read in the Studio");
            matches = [selected];
        }
        Studio.RequireTarget(matches[0], matches[0].ActiveESpace!, p);
        return (matches[0], matches[0].ActiveESpace!);
    }

    /// <summary>UI thread. The pane of serverOperationId, or the newest publication pane of the module.</summary>
    internal static JsonObject Read(IAggregatorPresenter agg, ESpace e, int? serverOperationId, int max)
    {
        var environment = Studio.EnvironmentHost(agg);
        var panes = Panes(agg);
        var pane = serverOperationId is int id
            ? panes.FirstOrDefault(x => x.ServerOperationId == id)
            : panes.Where(IsPublication).OrderByDescending(x => x.ServerOperationId).FirstOrDefault();
        if (pane == null)
            return PublishLog.NotFound(e.Name, e.Key.ToString(), environment, serverOperationId != null
                ? $"the messages tab of server operation {serverOperationId} is no longer open in the Studio"
                : "no 1-Click Publish messages tab is open for this module in the Studio (none since it was opened, or the person closed it)");
        var process = pane.ServerProcess;
        var key = e.Key.ToString();
        var op = new PublishLog.Operation(pane.ServerOperationId, process?.ServerOperationType.ToString(), process?.CurrentState.ToString(),
            process?.InnerState.ToString(), process?.ESpace?.Name ?? e.Name, process?.ESpace?.Key.ToString() ?? key, environment,
            e.LastUploadDateTime == default ? null : e.LastUploadDateTime.ToString("s"),
            BridgeOperations.TryGetValue(key, out var mine) && mine == pane.ServerOperationId ? "bridge" : "studio", Rows(pane));
        return PublishLog.Project(op, StepStages.Value, max, ResolverFor(e));
    }

    /// <summary>Quoted names of a message -> the module element of that name, or null without a resolver.</summary>
    private static partial Func<string, JsonObject?>? ResolverFor(ESpace e);

    // The aggregator's own map of server messages panes, by its declared type (the field name is obfuscated).
    private static IReadOnlyList<IServerMessagesPanePresenter> Panes(IAggregatorPresenter agg)
    {
        for (var t = agg.GetType(); t != null; t = t.BaseType)
            foreach (var f in t.GetFields(Instance | BindingFlags.DeclaredOnly))
                if (typeof(IDictionary<int, IServerMessagesPanePresenter>).IsAssignableFrom(f.FieldType))
                    return f.GetValue(agg) is IDictionary<int, IServerMessagesPanePresenter> map ? map.Values.ToList() : [];
        throw new InvalidOperationException("this Service Studio build keeps no IDictionary<int, IServerMessagesPanePresenter> in its aggregator; publish_log cannot read it");
    }

    private static bool IsPublication(IServerMessagesPanePresenter pane)
    {
        var process = pane.ServerProcess;
        if (process != null) return process.ServerOperationType != ServerOperationType.Test;
        return pane.Messages.Any(m => m.Id != null && StepStages.Value.ContainsKey(m.Id));
    }

    // Rows with the time the pane shows; the pane is written from the server thread, so a changing list is read again.
    private static IReadOnlyList<PublishLog.Row> Rows(IServerMessagesPanePresenter pane)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                var rows = new List<PublishLog.Row>();
                if (Studio.Prop(pane, "RootItems") is IEnumerable items)
                    foreach (var item in items)
                    {
                        var message = Studio.Prop(item, "Object");
                        if (Studio.Prop(message, "ExtraInfo") is MessageDefinition d) rows.Add(new(d, Studio.Prop(message, "DateTime") as string));
                    }
                if (rows.Count == 0) rows.AddRange(pane.Messages.Select(d => new PublishLog.Row(d, null)));
                return rows;
            }
            catch (InvalidOperationException) when (attempt < 2) { /* collection changed while reading */ }
            catch (Exception) { break; /* another row shape: the messages without their time */ }
        }
        try { return pane.Messages.Select(d => new PublishLog.Row(d, null)).ToList(); } catch { return []; }
    }
}
