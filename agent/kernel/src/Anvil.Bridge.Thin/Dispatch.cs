using System.Diagnostics;
using System.Text.Json.Nodes;
using Avalonia.Threading;

namespace Anvil.Bridge;

/// <summary>Verb table of the thin bridge (docs/O11-BRIDGE-FINA.md section 3.2): the full bridge's protocol 2 minus the
/// verbs whose logic is the kernel's (login, export_modules, export_status, find_element, get_flow_nodes), which the
/// server computes on captures or refuses. Any other method is not executed. The ninth release added refresh_references
/// (the Studio's own Refresh References, C26) to the full bridge; the thin bridge serves it too (section 14). The atritos 3 package
/// added the dialogs of every tab and window (publish blocked by a dialog, the second window, answer_dependencies_dialog): Studio
/// primitives, served here too (linked DialogScope and DependenciesDialog); query_test is not (its runtime is the product's).</summary>
internal static class Dispatch
{
    internal const string Flavor = "thin";

    /// <summary>The ABI of the release hook that loads this bridge (Anvil.Hook.h1: Start(int, string, string), then
    /// bridge_manifest with the Studio pid and the bridge id). bridge_manifest says it with pid, bridgeId (null outside the
    /// release layout), ideVersion and bridgeSha256 (docs/O11-BRIDGE-FINA.md section 13).</summary>
    internal const string HookAbi = "h1";

    internal static readonly string[] Verbs = ["ping", "bridge_manifest", "get_active_module", "list_open_modules", "get_errors",
        "open_module", "close_module", "publish", "windows", "ui_alive", "close_dialog", "snapshot_module",
        "merge_from_oml", "merge_status", "environment_session", "sc_api", "sc_web", "studio_login", "sc_session", "publish_log",
        "refresh_references", DialogScope.DependenciesVerb];

    /// <summary>The full bridge's capabilities (same order, Anvil.Bridge Dispatch.Capabilities) plus the thin markers:
    /// callers check a capability, not the version. The 16th release's sc_api:integration-studio (ScApiHandler, linked) and
    /// sc_web:studioSession (ScWebHandler, linked) are served; integration_import:wsdl/openapi and environment_session:users-read
    /// are not (their logic is the kernel's: Anvil.Core.IntegrationImport and UserDirectory), so the kernel refuses those jobs
    /// and lookups before any change (INTEGRATION_IMPORT_NEEDS_BRIDGE, STUDIO_BRIDGE_OUTDATED).</summary>
    internal static readonly string[] Capabilities = [.. UiGate.Capabilities, "environment_session", "sc_api:soap", "sc_api:server-api", "sc_api:sc-rest", "sc_web",
        "sc_web:secretRefs", "sc_web:hidden", "sc_web:login", "studio_login", "sc_session", "publish_log", "merge_from_oml:first_pass",
        MergeRollbackProof.Capability, "merge_from_oml:module_key", "get_errors:generation", "publish:wait_running", "publish:dialogs_seen",
        "list_open_modules:server_operation", "refresh_references", "sc_api:integration-studio", ScWebSession.StudioSessionCapability,
        DialogScope.BlockedCapability, DialogScope.DialogsCapability, DialogScope.WindowCapability, DialogScope.DependenciesCapability,
        "thin", "merge:reference-plan"];

    public static JsonObject BridgeInfo() => new()
    {
        ["bridge"] = "anvil", ["flavor"] = Flavor, ["version"] = typeof(Dispatch).Assembly.GetName().Version?.ToString(), ["protocolVersion"] = 2,
        ["capabilities"] = new JsonArray(Capabilities.Select(c => (JsonNode)JsonValue.Create(c)!).ToArray()),
    };

    public static async Task<string> Handle(string method, JsonObject? p) => method switch
    {
        "ping" => Server.Ok(new JsonObject { ["pid"] = Environment.ProcessId, ["bridge"] = "anvil", ["flavor"] = Flavor, ["version"] = typeof(Dispatch).Assembly.GetName().Version?.ToString(), ["uiThread"] = Dispatcher.UIThread.CheckAccess() }),
        "bridge_manifest" => Server.Ok(new JsonObject { ["bridge"] = "anvil", ["flavor"] = Flavor, ["protocolVersion"] = 2, ["authentication"] = true,
            ["pid"] = Environment.ProcessId, ["bridgeId"] = Server.BridgeId, ["hookAbi"] = HookAbi, ["ideVersion"] = IdeVersion(), ["bridgeSha256"] = Server.FileSha256,
            ["verbs"] = new JsonArray(Verbs.Select(v => (JsonNode)JsonValue.Create(v)!).ToArray()),
            ["capabilities"] = new JsonArray(Capabilities.Select(c => (JsonNode)JsonValue.Create(c)!).ToArray()),
            ["serviceCenter"] = ScApi.Catalog() }),
        "get_active_module" => await Reads.ActiveModule(),
        "list_open_modules" => await Reads.OpenModules(),
        "get_errors" => await Reads.Errors(p),
        "open_module" => await OpenHandler.Open(p),
        "close_module" => await OpenHandler.Close(p),
        "publish" => await PublishHandler.Publish(p),
        "windows" => await WindowsHandler.Windows(p),
        "ui_alive" => await WindowsHandler.UiAlive(p),
        "close_dialog" => await WindowsHandler.CloseDialog(p),
        "snapshot_module" => await MergeHandler.Snapshot(p),
        "merge_from_oml" => await MergeHandler.Merge(p),
        "merge_status" => MergeHandler.Status(p),
        "environment_session" => await EnvironmentSessionHandler.Handle(p),
        "sc_api" => await ScApiHandler.Api(p),
        "sc_web" => await ScWebHandler.Handle(p),
        "studio_login" => await ScApiHandler.Login(p),
        "sc_session" => await ScApiHandler.Session(p),
        "publish_log" => await PublishLogHandler.Handle(p),
        "refresh_references" => await RefreshReferencesHandler.Handle(p),
        DialogScope.DependenciesVerb => await DependenciesDialog.Handle(p),
        _ => Server.NotExecuted("Unknown method: " + method),
    };

    /// <summary>The file version of the Studio's model assembly (the release bridge's selftest reads the same), or null.</summary>
    internal static string? IdeVersion()
    {
        try { return FileVersionInfo.GetVersionInfo(typeof(ServiceStudio.Model.ESpace).Assembly.Location).FileVersion; }
        catch (Exception error) when (error is IOException or ArgumentException or TypeLoadException) { return null; }
    }
}
