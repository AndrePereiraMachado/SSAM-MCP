using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Anvil.Core;

namespace Anvil.Cli;

/// <summary>`data`: Service Studio's Edit Data on published records, through one of two session sources (never mixed).
///
/// The Studio already logged in on the lane (SSO included); no credential file. Chosen with --studio, or when neither
/// --host nor --credentials is given (--host then only checks the Studio's environment; --credentials is refused):
///   data [--studio] --module &lt;Name&gt; --oml &lt;published snapshot&gt; --request &lt;json&gt; [--out &lt;json&gt;] [--host h] [--read-only] [--work dir]
/// The request is one operation, or {"authorization": "...", "batch": [operation, ...]} run in order in one lease,
/// stopping at the first failure. An operation is {"operation": "read" | "read-all" | "insert" | "update" | "delete",
/// "entity": "Name", "records": [{Attribute: value}], "ids": ["..."], "offset": n, "tenantId": n, "step": "name",
/// "operationId": "&lt;uuid&gt;" and "authorization": "&lt;the user's own words&gt;" on writes}. A value or id may be
/// {"$ref": "step"} or {"$ref": "step#i"}, the id an earlier insert of the batch returned. The logic lives in
/// EnvironmentData (RunBatch): values normalized by type and every problem refused before any write, updates of the
/// changed cells only, and a read-back of every insert and update.
///
/// The private credential of an explicit host (`ssam data --lane o11` / MCP `o11_data`, docs/O11-DADOS-HEADLESS.md):
///   data --host h --module &lt;Name&gt; --oml &lt;published snapshot&gt; --request &lt;json&gt; [--credentials &lt;private file&gt;] [--out &lt;json&gt;] [--read-only] [--work dir]
/// reads SSAM/O11/&lt;host&gt;/ServiceStudio from the Windows Credential Manager (or the legacy private file) and runs one
/// operation per call (read, insert, update, delete, binary) with the native EditDataAPIRestClient.
///
/// Every write keeps a receipt under &lt;work&gt;/receipts and is never repeated automatically.</summary>
internal static class DataCommand
{
    public static JsonObject Run(string[] args, Func<string[], HeadlessSession> connect)
        => args.Contains("--studio") || !(args.Contains("--host") || args.Contains("--credentials"))
            ? RunThroughStudio(args, connect)
            : RunWithCredential(args);

    private static JsonObject RunThroughStudio(string[] args, Func<string[], HeadlessSession> connect)
    {
        string? Opt(string name) { var i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
        string Need(string name) => Opt(name) ?? throw new ArgumentException("missing " + name);
        if (args.Contains("--credentials")) throw new ArgumentException("data through the Studio uses only the Studio's own login; --credentials is refused");
        var request = JsonNode.Parse(File.ReadAllText(Need("--request")))!.AsObject();
        var work = Opt("--work") ?? ".local/data";
        var oml = Need("--oml");
        var schema = EnvironmentData.Schema(new ModelHost(Path.Combine(work, "model")), oml);
        if (schema.Module != Need("--module")) throw new ArgumentException("Snapshot module does not match --module.");
        if (EnvironmentData.IsRefusedModule(schema.Key)) throw new InvalidOperationException("Users and roles are out of reach of Edit Data here");
        var modelHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(oml)));

        // The whole request is checked first (values by type, $ref, authorization): a refusal costs no lease and writes nothing.
        JsonObject output;
        if (EnvironmentData.Refusal(schema, request) is { } refusal)
        {
            output = new JsonObject { ["ok"] = false, ["module"] = schema.Module };
            foreach (var (key, value) in refusal) output[key] = value?.DeepClone();
        }
        else
        {
            using var session = connect(args);
            var live = session.FindModule(schema.Key) ?? session.FindModule(Keys.ToStudio(schema.Key));
            if (live == null || live.Name != schema.Module) throw new InvalidOperationException("Module identity not found in the live environment.");
            var store = new EnvironmentData.DataStore(
                (entityKey, tenantId, ids, offset) => session.ReadRecords(schema.Key, entityKey, tenantId, ids, offset),
                (entityKey, tenantId, operation, records, ids) => session.WriteRecords(schema.Key, entityKey, tenantId, operation, records, ids),
                (entity, write, send) => DataReceipt.Execute(Path.Combine(work, "receipts"), session.Host, schema.Key, entity.Key, modelHash, write, send));
            var batch = EnvironmentData.RunBatch(schema, request, store);
            output = new JsonObject { ["ok"] = batch["ok"]!.DeepClone(), ["host"] = session.Host, ["module"] = schema.Module, ["moduleVersion"] = live.VersionId };
            foreach (var (key, value) in batch) if (key != "ok") output[key] = value?.DeepClone();
        }
        if (Opt("--out") is { } path)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
            File.WriteAllText(path, output.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
        }
        return output;
    }

    private static JsonObject RunWithCredential(string[] args)
    {
        string? Opt(string name) { var i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
        string Need(string name) => Opt(name) ?? throw new ArgumentException(name + " required");
        var request = JsonNode.Parse(File.ReadAllText(Need("--request")))!.AsObject();
        var hostName = Need("--host");
        var work = Opt("--work") ?? ".local/data";
        var host = new ModelHost(Path.Combine(work, "model"));
        var oml = Need("--oml");
        var schema = EntityData.Schema(host, oml);
        var expectedModule = Need("--module");
        if (schema.Module != expectedModule) throw new ArgumentException("Snapshot module does not match --module.");
        var entity = schema.Entities.SingleOrDefault(e => e.Name == request["entity"]?.ToString())
            ?? throw new ArgumentException("Entity not found in this module: " + request["entity"]);
        var credentials = Opt("--credentials") is { } path ? HeadlessCredentials.FromJsonFile(path) : O11CredentialVault.Read(hostName);
        if (!string.Equals(credentials.Host, HeadlessCredentials.HostOnly(hostName), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Credential host differs from --host.");
        using var session = HeadlessSession.Connect(credentials);
        if (args.Contains("--read-only")) session.MarkReadOnly();
        var liveModule = session.FindModule(schema.Key) ?? session.FindModule(Keys.ToStudio(schema.Key));
        if (liveModule == null || liveModule.Name != schema.Module) throw new InvalidOperationException("Module identity not found in the live environment.");
        var api = new EntityData(session);
        JsonObject result;
        if (request["operation"]?.ToString() == "read")
            result = api.Read(schema, entity, request["offset"]?.GetValue<int>() ?? 0, request["tenantId"]?.GetValue<int>(),
                request["ids"]?.AsArray().Select(x => x!.ToString()).ToArray(), request["includeBinary"]?.GetValue<bool>() ?? false);
        else
        {
            session.RequireWrite("data");
            EntityData.ValidateWrite(entity, request);
            result = DataReceipt.Execute(Path.Combine(work, "receipts"), session.Host, schema.Key, entity.Key,
                Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(oml))), request, () => api.Write(schema, entity, request));
        }
        if (Opt("--out") is { } output) { Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output))!); File.WriteAllText(output, result.ToJsonString()); }
        return result;
    }
}
