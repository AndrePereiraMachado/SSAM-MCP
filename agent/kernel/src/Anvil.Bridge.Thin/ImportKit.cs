using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using ServiceStudio.Model;
using ServiceStudio.Presenter.Commands;
using ServiceStudio.Presenter;

namespace Anvil.Bridge;

/// <summary>
/// The thin bridge's side of the seam of IntegrationImportHandler.cs (fase4-28 r4-f3-import): the handler is linked from the
/// full bridge unchanged (kernel/src/Anvil.Bridge/IntegrationImportHandler.cs), and every member it needs beyond the Studio is
/// here, on Studio types and the BCL only, never the kernel (docs/O11-BRIDGE-FINA.md section 2.1). The full bridge's
/// ImportKit delegates the same members to the kernel. The pure parts are held equal to the kernel's by
/// Anvil.Bridge.Thin.Tests/IntegrationImportThinTests: Validate answers the same problems as
/// Anvil.Core.IntegrationImport.Validate on every case of the table, Filtered gives the same document as
/// Anvil.Core.RestOpenApi.Filtered, Label the same label as RestOpenApi.Operation.Label.
/// Mutate runs the change inside one native command of a headless aggregator of the detached copy, as the kernel's
/// Publisher.Mutate does, but through QuietCommand: an exception of the importer never leaves the command (no crash dialog in
/// the customer's Studio), the command is rolled back by the SDK and the failure is raised after it, as SSAM's own answer.
/// </summary>
internal static class ImportKit
{
    public const string ImporterNotFound = "INTEGRATION_IMPORTER_NOT_FOUND";
    public const string ImportFailed = "INTEGRATION_IMPORT_FAILED";
    private static readonly Regex Sha = new("^[0-9a-fA-F]{64}$", RegexOptions.Compiled);
    private static readonly Regex OutSystemsName = new("^[A-Za-z][A-Za-z0-9_]{0,49}$", RegexOptions.Compiled);
    private static readonly string[] HttpVerbs = ["get", "put", "post", "delete", "patch", "head", "options"];

    /// <summary>Why the bridge must not run this request (empty: it may). Every problem at once; nothing is read beyond the
    /// files named, nothing is written. The kernel's IntegrationImport.Validate, problem for problem.</summary>
    public static List<string> Validate(JsonObject? p)
    {
        var problems = new List<string>();
        if (p == null) return ["integration_import: parameters are required"];
        var kind = p["kind"]?.ToString();
        if (kind is not ("wsdl" or "openapi")) problems.Add($"integration_import: kind '{kind}' is not wsdl or openapi");
        if (string.IsNullOrWhiteSpace(p["module_key"]?.ToString())) problems.Add("integration_import: module_key is required (the tab whose workspace the importer borrows)");
        if (string.IsNullOrWhiteSpace(p["operation_id"]?.ToString())) problems.Add("integration_import: operation_id is required");
        File("base_path", "base_sha256");
        File("document_path", "document_sha256");
        var outPath = p["out_path"]?.ToString();
        if (string.IsNullOrWhiteSpace(outPath) || !Path.IsPathFullyQualified(outPath)) problems.Add($"integration_import: out_path '{outPath}' must be an absolute path");
        else if (System.IO.File.Exists(outPath)) problems.Add($"integration_import: out_path {outPath} already exists (a candidate is written once)");
        var client = p["client"]?.ToString();
        if (client == null || !OutSystemsName.IsMatch(client)) problems.Add($"integration_import: client '{client}' is not an OutSystems name");
        if (p["dependencies"] is JsonArray dependencies)
            foreach (var dependency in dependencies)
            {
                if (dependency is not JsonObject d || string.IsNullOrWhiteSpace(d["uri"]?.ToString())) { problems.Add("integration_import: each dependency is {uri, path, sha256}"); continue; }
                File(null, null, d, "dependency " + d["uri"]);
            }
        else if (p["dependencies"] != null) problems.Add("integration_import: dependencies is a list");
        if (p["selection"] is not JsonObject selection) problems.Add("integration_import: selection is required");
        else if (kind == "wsdl" && (selection["port"] == null || selection["methods"] is not JsonArray { Count: > 0 }))
            problems.Add("integration_import: a wsdl selection names the port and at least one method");
        else if (kind == "openapi" && selection["operations"] is not JsonArray { Count: > 0 })
            problems.Add("integration_import: an openapi selection names at least one operation");
        return problems;

        void File(string? pathKey, string? shaKey, JsonObject? owner = null, string? label = null)
        {
            var source = owner ?? p;
            var path = source[pathKey ?? "path"]?.ToString();
            var sha = source[shaKey ?? "sha256"]?.ToString();
            var name = label ?? pathKey ?? "path";
            if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path)) { problems.Add($"integration_import: {name} '{path}' must be an absolute path"); return; }
            if (sha == null || !Sha.IsMatch(sha)) { problems.Add($"integration_import: {name} needs its sha256 (64 hex)"); return; }
            if (!System.IO.File.Exists(path)) { problems.Add($"integration_import: {name} {path} does not exist"); return; }
            var actual = Convert.ToHexString(SHA256.HashData(System.IO.File.ReadAllBytes(path))).ToLowerInvariant();
            if (!string.Equals(actual, sha, StringComparison.OrdinalIgnoreCase)) problems.Add($"integration_import: {name} {path} has sha256 {actual}, not {sha}");
        }
    }

    /// <summary>The copy must be the snapshot of the open module (same key): the thin SnapshotRegistry's rule.</summary>
    public static void RequireForeignIdentity(string localKey, string foreignKey) => SnapshotRegistry.RequireForeignIdentity(localKey, foreignKey);

    /// <summary>The Name of a model object, or null.</summary>
    public static string? Name(object? o) => o?.GetType().GetProperty("Name")?.GetValue(o) as string;

    /// <summary>A change of the detached copy inside one native command of a headless aggregator of that copy (never the
    /// open tab's): PrepareForSave, the command, then the undo history of that aggregator cleared. A failure of the change is
    /// raised after the command, which the SDK rolled back.</summary>
    public static void Mutate(ESpace espace, string description, Action<ESpace> mutation)
    {
        typeof(ESpace).GetMethod("PrepareForSave", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public, Type.EmptyTypes)
            ?.Invoke(espace, null);
        using var aggregator = new MockAggregatorPresenter(espace, null, registerAsStaticInstance: false);
        var presenter = new MockPresenter(aggregator);
        QuietCommandFailure? failure;
        try { failure = QuietCommand.Execute(presenter.GetPresenterContext(), description, _ => mutation(espace)); }
        finally
        {
            try { ServiceStudio.Undo.UndoManager.ClearHistory(aggregator); } catch { /* no history for this aggregator */ }
        }
        if (failure != null) throw new QuietCommandException(failure);
    }

    /// <summary>The label of an OpenAPI operation: its operationId, else "VERB /path".</summary>
    public static string Label(string id, string verb, string path) => id.Length > 0 ? id : $"{verb.ToUpperInvariant()} {path}";

    /// <summary>The document with only the chosen operations under paths (the rest of the document intact): what the Studio's
    /// importer receives, since it imports every operation of what it is given.</summary>
    public static string Filtered(string documentPath, string sha256, string text, IReadOnlyList<(string Id, string Verb, string Path)> operations)
    {
        var root = JsonNode.Parse(text)!.AsObject();
        if (root["paths"] is JsonObject paths)
            foreach (var (path, item) in paths.ToList())
            {
                if (item is not JsonObject verbs) continue;
                foreach (var verb in verbs.Select(p => p.Key).ToList())
                    if (HttpVerbs.Contains(verb.ToLowerInvariant()) && !operations.Any(s => s.Path == path && s.Verb == verb.ToLowerInvariant())) verbs.Remove(verb);
                if (!verbs.Any(p => HttpVerbs.Contains(p.Key.ToLowerInvariant()))) paths.Remove(path);
            }
        return root.ToJsonString();
    }
}
