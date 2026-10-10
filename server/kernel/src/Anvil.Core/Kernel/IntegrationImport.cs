using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// The O11 bridge verb integration_import (Anvil.Bridge/IntegrationImportHandler.cs), its pure part: which imports a job
/// needs (a `soap` op; a `rest` op with `openapi` on O11), the exact request the delivery sends, and the validation the
/// bridge runs on its arguments before anything (absolute paths, existing files, matching sha256, a new out_path). The
/// bridge runs the Studio's own importer on a DETACHED copy of the snapshot (never the open module) and saves the
/// candidate the job is then applied to; the delivery merges that candidate once.
/// Request: {module_key, environment, operation_id, kind: wsdl|openapi, base_path, base_sha256, document_path,
/// document_sha256, dependencies: [{uri, path, sha256}], client, selection: {service, port, binding, soapVersion, methods,
/// refresh} | {operations}, out_path}. Answer: {candidate_path, candidate_sha256, client: {name, key, created}, imported,
/// skipped, warnings, errors}.
/// </summary>
public static class IntegrationImport
{
    public const string Verb = "integration_import";
    public const string WsdlCapability = "integration_import:wsdl";
    public const string OpenApiCapability = "integration_import:openapi";
    public const string NeedsBridge = "INTEGRATION_IMPORT_NEEDS_BRIDGE";
    public const string NeedsStudio = "INTEGRATION_IMPORT_NEEDS_STUDIO";
    public const string ImporterNotFound = "INTEGRATION_IMPORTER_NOT_FOUND";
    public const string ImportFailed = "INTEGRATION_IMPORT_FAILED";
    private static readonly Regex Sha = new("^[0-9a-fA-F]{64}$", RegexOptions.Compiled);
    private static readonly Regex Name = new("^[A-Za-z][A-Za-z0-9_]{0,49}$", RegexOptions.Compiled);

    public static string CapabilityOf(string kind) => kind == "openapi" ? OpenApiCapability : WsdlCapability;

    /// <summary>One import a job needs: the op it belongs to and the request without the delivery's own fields (module,
    /// environment, operation, base and out paths).</summary>
    public sealed record Request(int Op, string Kind, JsonObject Parameters);

    /// <summary>The imports of a job's ops (lane O11): one per `soap` op that imports or refreshes methods, one per `rest`
    /// op with `openapi`. Ops whose plan is refused give no request (the preflight already refused them).</summary>
    public static List<Request> Requests(JsonArray ops)
    {
        var list = new List<Request>();
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["data"] is not JsonObject data) continue;
            switch (op["op"]?.ToString())
            {
                case "soap":
                    var plan = SoapPlan.Plan(data);
                    if (plan.Selection is not { } s || s.Methods.Count == 0) continue;
                    list.Add(new(i, "wsdl", new JsonObject
                    {
                        ["kind"] = "wsdl", ["document_path"] = s.DocumentPath, ["document_sha256"] = s.DocumentSha256,
                        ["dependencies"] = Dependencies(s.Imports), ["client"] = s.Client, ["source"] = s.Source,
                        ["selection"] = new JsonObject { ["service"] = s.Port.Service, ["port"] = s.Port.Name, ["binding"] = s.Port.Binding, ["soapVersion"] = s.Port.SoapVersion,
                            ["methods"] = Names(s.Methods), ["refresh"] = Names(s.Refresh) },
                    }));
                    break;
                case "rest" when data["openapi"] is JsonObject openapi:
                    var problems = new List<IntegrationProblem>();
                    var document = RestOpenApi.Plan(openapi, problems);
                    if (document == null) continue;
                    list.Add(new(i, "openapi", new JsonObject
                    {
                        ["kind"] = "openapi", ["document_path"] = document.DocumentPath, ["document_sha256"] = document.Sha256,
                        ["dependencies"] = Dependencies(document.External), ["client"] = data["client"]?["name"]?.ToString(), ["source"] = document.Source,
                        ["selection"] = new JsonObject { ["operations"] = new JsonArray(document.Selected.Select(o => (JsonNode)new JsonObject { ["id"] = o.Id, ["verb"] = o.Verb, ["path"] = o.Path }).ToArray()) },
                    }));
                    break;
            }
        }
        return list;
    }

    private static JsonArray Names(IEnumerable<string> names) => new(names.Select(n => (JsonNode)n).ToArray());
    private static JsonArray Dependencies(IEnumerable<(string Uri, string Path, string Sha256)> dependencies)
        => new(dependencies.Select(d => (JsonNode)new JsonObject { ["uri"] = d.Uri, ["path"] = d.Path, ["sha256"] = d.Sha256 }).ToArray());

    /// <summary>Why the bridge must not run this request (empty: it may). Every problem at once; nothing is read beyond the
    /// files named, nothing is written.</summary>
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
        if (client == null || !Name.IsMatch(client)) problems.Add($"integration_import: client '{client}' is not an OutSystems name");
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
            var actual = IntegrationDocuments.Sha256(System.IO.File.ReadAllBytes(path));
            if (!string.Equals(actual, sha, StringComparison.OrdinalIgnoreCase)) problems.Add($"integration_import: {name} {path} has sha256 {actual}, not {sha}");
        }
    }
}
