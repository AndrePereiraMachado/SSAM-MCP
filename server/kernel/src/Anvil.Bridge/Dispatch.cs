using System.Text.Json.Nodes;
using System.Diagnostics;
using System.Security.Cryptography;
using Avalonia.Threading;

namespace Anvil.Bridge;

/// <summary>Tabela de verbos do bridge. Pequena de proposito (ver docs/architecture/2026-09-04-modelo-de-verbos.md).</summary>
internal static class Dispatch
{
    // Read once from this revision's immutable file, never from a replacement
    // candidate. Lets a controller bind an isolated listener to its attach receipt.
    private static readonly Lazy<string> RevisionSha256 = new(() =>
        Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(typeof(Dispatch).Assembly.Location))).ToLowerInvariant());
    private static readonly string[] Verbs = ["ping", "bridge_manifest", "get_active_module", "list_open_modules", "get_errors", "find_element",
        "get_flow_nodes", "login", "open_module", "close_module", "publish", "windows", "ui_alive", "close_dialog", "snapshot_module",
        "merge_from_oml", "merge_status", "export_modules", "export_status", "environment_session",
        "sc_api", "sc_web", "sc_http", "sc_private_http", "sc_private_http_cookie", "studio_login", "sc_session", "publish_log", "refresh_references", "integration_import", "query_test",
        DialogScope.DependenciesVerb];

    /// <summary>What this build adds over protocol 2 without changing it: callers check a capability, not the version.
    /// merge_from_oml:rollback_proof (C15: a merge rolled back by the SDK is proven on the module and journaled not-applied),
    /// merge_from_oml:module_key (C41: snapshot, merge, publish and the reads target module_key in any tab),
    /// get_errors:generation (C28: settle waits for the idle Studio and answers the validation generation),
    /// publish:wait_running and publish:dialogs_seen (C31, C10), list_open_modules:server_operation (C31),
    /// refresh_references (C26: the Studio's own Refresh References),
    /// integration_import:wsdl and integration_import:openapi (the Studio's own SOAP/OpenAPI importer on a detached copy of
    /// the snapshot, IntegrationImportHandler), sc_api:integration-studio (the read-only Integration Studio surface of
    /// sc_api for .NET extensions, implemented in ScApiHandler/ScOperations), sc_web:studioSession (sc_web login
    /// {session:"studio"}: the Service Center window signed in through the Studio's own session, never the vault; A13),
    /// environment_session:users-read (the read-only lookup of users and roles with a closed attribute list, UserDirectory; A13),
    /// publish:blocked_by_dialog (C10: a blocking dialog in three reads ends the publication's wait with published:false,
    /// code PUBLISH_BLOCKED_BY_DIALOG, blockedBy), list_open_modules:dialogs (C10: pendingDialogs per module, the union in
    /// dialogs, get_active_module.otherDialogs), list_open_modules:window (C22: the window of each tab, windows) and
    /// dialogs:dependencies_auto (MB2: open_module and publish with answer_dependencies:true, and the verb
    /// answer_dependencies_dialog, close the "Incompatible or missing dependencies found" dialog as Cancel; the caller then
    /// runs refresh_references {module_key}). UI freeze of 2026-10-08 (UiGate.Capabilities): ui:bounded (every UI step has a
    /// deadline and answers UI_BUSY), close_module:idle_gate, publish:settled and open_module:headless_guard.
    /// Speed lane vel-entrega (2026-10-12): list_open_modules:model_sha256 (list_open_modules {model_sha256_of} adds the
    /// model fingerprint of that module's tabs, so the build phase reuses a capture the server holds instead of uploading the
    /// same model again) and open_module:references_check_optional (open_module {references_check:false} on a tab already
    /// open skips the Studio's 3 s references check, whose result no delivery reads; a pending dependencies dialog is still
    /// answered).</summary>
    private static readonly string[] Capabilities = [.. UiGate.Capabilities, "environment_session", "sc_api:soap", "sc_api:server-api", "sc_api:sc-rest", "sc_web",
        "sc_web:secretRefs", "sc_session", "publish_log", "merge_from_oml:first_pass",
        MergeRollbackProof.Capability, "merge_from_oml:module_key", "get_errors:generation", "publish:wait_running", "publish:dialogs_seen",
        "list_open_modules:server_operation", "refresh_references", "integration_import:wsdl", "integration_import:openapi", "sc_api:integration-studio",
        ScHttpHandler.Capability, ScPrivateHttp.Capability, "sc_private_http:cookieUpdates", Anvil.Core.UserDirectory.Capability, "query_test:v1",
        DialogScope.BlockedCapability, DialogScope.DialogsCapability, DialogScope.WindowCapability, DialogScope.DependenciesCapability,
        "list_open_modules:model_sha256", "open_module:references_check_optional"];

    public static JsonObject BridgeInfo() => new()
    {
        ["bridge"] = "anvil", ["version"] = typeof(Dispatch).Assembly.GetName().Version?.ToString(), ["protocolVersion"] = 2,
        ["capabilities"] = new JsonArray(Capabilities.Select(c => (JsonNode)JsonValue.Create(c)!).ToArray()),
    };

    public static async Task<string> Handle(string method, JsonObject? p) => method switch
    {
        "ping" => Server.Ok(new JsonObject { ["pid"] = Environment.ProcessId, ["bridge"] = "anvil", ["version"] = typeof(Dispatch).Assembly.GetName().Version?.ToString(), ["uiThread"] = Dispatcher.UIThread.CheckAccess(),
            ["revisionSha256"] = RevisionSha256.Value, ["startedUtc"] = Process.GetCurrentProcess().StartTime.ToUniversalTime().ToString("O") }),
        "bridge_manifest" => Server.Ok(new JsonObject { ["bridge"] = "anvil", ["protocolVersion"] = 2, ["authentication"] = true,
            ["verbs"] = new JsonArray(Verbs.Select(v => (JsonNode)JsonValue.Create(v)!).ToArray()),
            ["capabilities"] = new JsonArray(Capabilities.Select(c => (JsonNode)JsonValue.Create(c)!).ToArray()),
            ["serviceCenter"] = ScApi.Catalog() }),
        "get_active_module" => await Reads.ActiveModule(),
        "environment_session" => await EnvironmentSessionHandler.Handle(p),
        "sc_api" => await ScApiHandler.Api(p),
        "query_test" => await QueryTestHandler.Handle(p),
        "sc_web" => await ScHttpHandler.Handle(p),
        "sc_http" => await ScHttpHandler.Handle(p),
        "sc_private_http" => await ScPrivateHttpHandler.Handle(p),
        "sc_private_http_cookie" => await ScPrivateHttpHandler.Handle(p, cookieExchange: true),
        "studio_login" => ScReply.Fail(new ScFailure(ScCodes.StudioNotSignedIn, "Headless Service Center tools require an existing authenticated Studio session; no login dialog was opened.")),
        "sc_session" => await ScApiHandler.Session(p),
        "list_open_modules" => await Reads.OpenModules(p),
        "get_errors" => await Reads.Errors(p),
        "find_element" => await Reads.Find(p),
        "get_flow_nodes" => await Reads.FlowNodes(p),
        "login" => await LoginHandler.Login(p),
        "open_module" => await OpenHandler.Open(p),
        "close_module" => await OpenHandler.Close(p),
        "windows" => await WindowsHandler.Windows(p),
        "close_dialog" => await WindowsHandler.CloseDialog(p),
        "ui_alive" => await WindowsHandler.UiAlive(p),
        "publish" => await PublishHandler.Publish(p),
        "publish_log" => await PublishLogHandler.Handle(p),
        "snapshot_module" => await MergeHandler.Snapshot(p),
        "merge_from_oml" => await MergeHandler.Merge(p),
        "merge_status" => MergeHandler.Status(p),
        "refresh_references" => await RefreshReferencesHandler.Handle(p),
        "integration_import" => await IntegrationImportHandler.Handle(p),
        DialogScope.DependenciesVerb => await DependenciesDialog.Handle(p),
        "export_modules" => await ExportHandler.Start(p),
        "export_status" => ExportHandler.Status(p),
        _ => Server.Fail("Unknown method: " + method),
    };
}
