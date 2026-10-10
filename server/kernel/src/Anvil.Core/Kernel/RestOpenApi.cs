using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// The OpenAPI part of the op `rest` (`openapi {path, sha256, source?, operations[], external?}`): the pure plan reads the
/// pinned document, finds each chosen operation (operationId or "VERB /path") and checks that every external $ref is
/// bundled in `external` (the kernel never fetches: an unbundled reference is OPENAPI_EXTERNAL_REF_MISSING naming the URI).
/// The import itself is the platform's own: on ODC headless (Adapters.ODC/OdcRestOpenApi.cs registers <see cref="Importer"/>
/// from its module initializer: GetSwaggerInfo, ToImport on the chosen operations, ISwaggerInfo.Create, every HTTP call
/// refused); on O11 through the bridge verb integration_import before the job is applied (Delivery), because the O11
/// importer needs the live workspace.
/// </summary>
public static class RestOpenApi
{
    public const int MaxBytes = 5 * 1024 * 1024;
    private static readonly string[] HttpVerbs = ["get", "put", "post", "delete", "patch", "head", "options"];

    public sealed record Operation(string Id, string Verb, string Path)
    {
        public string Label => Id.Length > 0 ? Id : $"{Verb.ToUpperInvariant()} {Path}";
    }

    public sealed record OpenApiPlan(string DocumentPath, string Sha256, string Text, string? Source, IReadOnlyList<Operation> Selected, IReadOnlyList<Operation> Available,
        IReadOnlyList<(string Uri, string Path, string Sha256)> External);

    /// <summary>The import the platform runs; <see cref="Importer"/> answers what it created or the refusal with its code.</summary>
    public sealed record ImportRequest(string ClientName, OpenApiPlan Plan, string? BaseUrl);
    public sealed record ImportResult(string? ClientKey, bool ClientCreated, IReadOnlyList<string> Imported, IReadOnlyList<string> Skipped, IReadOnlyList<string> Warnings,
        IReadOnlyList<IntegrationProblem> Problems, int HttpCalls);

    /// <summary>The lane's headless importer (espace, request): set by the ODC adapter; null on O11 (bridge) and in tests
    /// that run without the ODC Studio.</summary>
    public static Func<object, ImportRequest, ImportResult>? Importer { get; set; }

    /// <summary>The pure plan: every problem of the document and of the selection at once (OPENAPI_INVALID,
    /// OPENAPI_OPERATION_NOT_FOUND, OPENAPI_EXTERNAL_REF_MISSING, DOCUMENT_SHA256_MISMATCH); null when refused.</summary>
    public static OpenApiPlan? Plan(JsonObject openapi, List<IntegrationProblem> problems)
    {
        var before = problems.Count;
        foreach (var key in openapi.Select(p => p.Key).Where(k => !RestExpander.OpenApiKeys.Contains(k, StringComparer.Ordinal)))
            problems.Add(new("REST_UNKNOWN_KEYS", "/data/openapi/" + key, $"rest: openapi has unknown key '{key}'", "use only: " + string.Join(", ", RestExpander.OpenApiKeys)));
        var wanted = RestExpander.Strings(openapi["operations"]).ToList();
        if (wanted.Count == 0)
            problems.Add(new("OPENAPI_OPERATION_NOT_FOUND", "/data/openapi/operations", "rest: openapi needs the operations to import (operationId or \"VERB /path\")", "\"operations\": [\"getOrder\", \"POST /orders\"]"));
        var documentNode = new JsonObject { ["path"] = openapi["path"]?.DeepClone(), ["sha256"] = openapi["sha256"]?.DeepClone(), ["source"] = openapi["source"]?.DeepClone(),
            ["external"] = openapi["external"]?.DeepClone() };
        foreach (var empty in documentNode.Where(p => p.Value == null).Select(p => p.Key).ToList()) documentNode.Remove(empty);
        var document = IntegrationDocuments.Read(documentNode, "/data/openapi", problems, "OpenAPI", MaxBytes, "external");
        if (document == null) return null;
        var text = System.Text.Encoding.UTF8.GetString(document.Value.Bytes);
        JsonObject root;
        try { root = JsonNode.Parse(text) as JsonObject ?? throw new System.Text.Json.JsonException("not an object"); }
        catch (System.Text.Json.JsonException ex)
        {
            problems.Add(new("OPENAPI_INVALID", "/data/openapi/path", "rest: the OpenAPI document is not JSON: " + ex.Message.Split('.')[0], "pin the JSON form of the OpenAPI/Swagger document (YAML is converted by the facade only when it is JSON-compatible)"));
            return null;
        }
        var version = root["openapi"]?.ToString() ?? root["swagger"]?.ToString();
        if (version == null || !(version.StartsWith("2.", StringComparison.Ordinal) || version.StartsWith("3.", StringComparison.Ordinal)))
        {
            problems.Add(new("OPENAPI_INVALID", "/data/openapi/path", $"rest: the document declares neither swagger 2.x nor openapi 3.x (found '{version}')", "pin a Swagger 2.0 or OpenAPI 3.x document"));
            return null;
        }
        var available = Operations(root);
        var selected = new List<Operation>();
        foreach (var name in wanted)
        {
            var match = Find(available, name);
            if (match == null)
                problems.Add(new("OPENAPI_OPERATION_NOT_FOUND", "/data/openapi/operations", $"rest: operation '{name}' is not in the document",
                    "use one of: " + string.Join(", ", available.Select(a => a.Label).Take(40))));
            else if (!selected.Contains(match)) selected.Add(match);
        }
        // External references: the kernel never fetches; each one is a bundled file of `external`.
        var bundled = document.Value.Imports.Select(i => i.Uri).ToHashSet(StringComparer.Ordinal);
        foreach (var reference in ExternalReferences(root).Distinct(StringComparer.Ordinal))
        {
            var file = reference.Split('#')[0];
            if (bundled.Contains(file) || bundled.Contains(reference)) continue;
            // A network reference would be fetched by the platform importer: refused here, before it runs (zero HTTP).
            var network = Uri.TryCreate(file, UriKind.Absolute, out var absolute) && absolute.Scheme is "http" or "https";
            problems.Add(new(network ? "OPENAPI_NETWORK_REFUSED" : "OPENAPI_EXTERNAL_REF_MISSING", "/data/openapi/external",
                network ? $"rest: the document references '{file}' on the network; the import never fetches it" : $"rest: the document references '{file}', which is not bundled (the import never fetches it)",
                $"bundle it: \"external\": {{\"{file}\": {{\"path\": \"<absolute>\", \"sha256\": \"<hex>\"}}}} (o11_deliver/studio_deliver pin it when the source is a URL)"));
        }
        if (problems.Count > before) return null;
        return new(document.Value.Path, document.Value.Sha256, text, document.Value.Source, selected, available, document.Value.Imports);
    }

    /// <summary>Every operation of the document, in document order: operationId and "VERB /path".</summary>
    public static List<Operation> Operations(JsonObject root)
    {
        var list = new List<Operation>();
        foreach (var (path, item) in root["paths"] as JsonObject ?? new JsonObject())
            foreach (var (verb, operation) in item as JsonObject ?? new JsonObject())
                if (HttpVerbs.Contains(verb.ToLowerInvariant()))
                    list.Add(new(operation?["operationId"]?.ToString() ?? "", verb.ToLowerInvariant(), path));
        return list;
    }

    public static Operation? Find(IReadOnlyList<Operation> available, string name)
    {
        var byId = available.FirstOrDefault(a => a.Id.Length > 0 && string.Equals(a.Id, name, StringComparison.Ordinal));
        if (byId != null) return byId;
        var parts = name.Trim().Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
        return parts.Length == 2 ? available.FirstOrDefault(a => a.Verb.Equals(parts[0], StringComparison.OrdinalIgnoreCase) && a.Path == parts[1].Trim()) : null;
    }

    /// <summary>The $ref values that point outside the document (not starting with '#').</summary>
    public static IEnumerable<string> ExternalReferences(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject o:
                foreach (var (key, value) in o)
                {
                    if (key == "$ref" && value is JsonValue v && v.TryGetValue<string>(out var reference) && !reference.StartsWith('#')) yield return reference;
                    foreach (var nested in ExternalReferences(value)) yield return nested;
                }
                break;
            case JsonArray a:
                foreach (var item in a) foreach (var nested in ExternalReferences(item)) yield return nested;
                break;
        }
    }

    /// <summary>The document with only the chosen operations under paths (the rest of the document intact): what the platform
    /// importer receives when the lane's API imports every operation of what it is given.</summary>
    public static string Filtered(OpenApiPlan plan)
    {
        var root = JsonNode.Parse(plan.Text)!.AsObject();
        if (root["paths"] is JsonObject paths)
            foreach (var (path, item) in paths.ToList())
            {
                if (item is not JsonObject verbs) continue;
                foreach (var verb in verbs.Select(p => p.Key).ToList())
                    if (HttpVerbs.Contains(verb.ToLowerInvariant()) && !plan.Selected.Any(s => s.Path == path && s.Verb == verb.ToLowerInvariant())) verbs.Remove(verb);
                if (!verbs.Any(p => HttpVerbs.Contains(p.Key.ToLowerInvariant()))) paths.Remove(path);
            }
        return root.ToJsonString();
    }
}
