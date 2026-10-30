using System.Text;
using System.Text.Json.Nodes;

namespace Ssam.Agent;

internal sealed class FileKinds(string root, AgentChannel channel, Blobs blobs)
{
    public static readonly string[] Names = ["file.put", "file.get", "file.list", "file.sync"];
    private readonly Workspace workspace = new(root);
    private static string Text(JsonObject p, string key) => p[key] is JsonValue value && value.TryGetValue<string>(out var text)
        ? text : throw new AgentFault("PARAMS_INVALID", key + " must be a string");
    private static bool Manifest(JsonObject p)
    {
        if (p["json"] == null) return false;
        if (Text(p, "json") != "agent-paths") throw new AgentFault("PARAMS_INVALID", "json must be agent-paths");
        return true;
    }
    public Task<JsonNode> Execute(string kind, JsonObject p, CancellationToken token) => kind switch {
        "file.put" => Put(p, token), "file.get" => Get(p, token), "file.list" => List(p, token),
        "file.sync" => Sync(p, token), _ => throw new AgentFault("KIND_NOT_ALLOWED", "Unknown file kind")
    };
    private static JsonObject PutResult(string path, BlobRef blob, bool skipped) => new() {
        ["path"] = path, ["sha256"] = blob.Sha256, ["size"] = blob.Size, ["skipped"] = skipped
    };
    private async Task<JsonNode> Put(JsonObject p, CancellationToken token)
    {
        var target = Text(p, "path"); var file = workspace.Resolve(target, true); var manifest = Manifest(p);
        var reference = BlobRef.Parse(p["blob"], channel.PartBytes, channel.MaxFileBytes);
        if (Directory.Exists(file)) throw new AgentFault("PATH_FORBIDDEN", "Destination is a directory");
        if (!manifest && File.Exists(file) && new FileInfo(file).Length == reference.Size
            && await Blobs.FileHash(file, token) == reference.Sha256) return PutResult(target, reference, true);
        if (!manifest)
        {
            await blobs.Download(reference, file, token, () => workspace.Resolve(target, true));
            return PutResult(target, reference, false);
        }
        var temporary = Path.Combine(root, "private", "tmp", Guid.NewGuid().ToString("N") + ".json");
        string? staged = null;
        try
        {
            await blobs.Download(reference, temporary, token);
            JsonNode? json;
            try { json = JsonNode.Parse(await File.ReadAllTextAsync(temporary, token)); }
            catch (System.Text.Json.JsonException) { throw new AgentFault("PARAMS_INVALID", "agent-paths requires JSON"); }
            workspace.TransformManifest(json, true);
            workspace.Resolve(target, true);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            staged = file + "." + Guid.NewGuid().ToString("N") + Blobs.TemporarySuffix;
            await File.WriteAllTextAsync(staged, json?.ToJsonString() ?? "null", new UTF8Encoding(false), token);
            workspace.Resolve(target, true);
            File.Move(staged, file, true);
            return PutResult(target, reference, false);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); if (staged != null && File.Exists(staged)) File.Delete(staged); }
    }
    private async Task<JsonNode> Get(JsonObject p, CancellationToken token)
    {
        var target = Text(p, "path"); var file = workspace.Resolve(target); var manifest = Manifest(p);
        if (!File.Exists(file)) throw new AgentFault("FILE_NOT_FOUND", "Path is not a file on the agent");
        if (new FileInfo(file).Length > channel.MaxFileBytes) throw new AgentFault("FILE_TOO_LARGE", "File exceeds the negotiated limit");
        BlobRef reference;
        if (manifest)
        {
            JsonNode? json;
            try { json = JsonNode.Parse(await File.ReadAllTextAsync(file, token)); }
            catch (System.Text.Json.JsonException) { throw new AgentFault("PARAMS_INVALID", "Path is not a JSON file"); }
            workspace.TransformManifest(json, false);
            using var source = new MemoryStream(Encoding.UTF8.GetBytes(json?.ToJsonString() ?? "null"));
            reference = await blobs.Upload(source, token);
        }
        else
        {
            await using var source = File.OpenRead(file);
            reference = await blobs.Upload(source, token);
        }
        return new JsonObject { ["path"] = target, ["blob"] = reference.Json() };
    }
    private async Task<JsonNode> Sync(JsonObject p, CancellationToken token)
    {
        if (p["files"] is not JsonArray entries || entries.Count is < 1 or > 256)
            throw new AgentFault("PARAMS_INVALID", "files must contain between 1 and 256 entries");
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in entries)
        {
            if (entry is not JsonObject row) throw new AgentFault("PARAMS_INVALID", "Each file must be an object");
            if (!seen.Add(Text(row, "path").Replace('\\', '/'))) throw new AgentFault("PARAMS_INVALID", "A file path was named twice");
        }
        using var concurrency = new SemaphoreSlim(4);
        var results = await Task.WhenAll(entries.Select(async entry => {
            await concurrency.WaitAsync(token);
            var row = (JsonObject)entry!; var target = Text(row, "path");
            try
            {
                var ifMissing = row["ifMissing"] is JsonValue v && v.TryGetValue<bool>(out var b) && b;
                if (ifMissing && Path.Exists(workspace.Resolve(target, true)))
                    return (JsonNode)new JsonObject { ["path"] = target, ["skipped"] = true, ["present"] = true };
                return await Put(row, token);
            }
            catch (Exception e) when (e is AgentFault or PathRefusal or IOException or UnauthorizedAccessException)
            {
                return new JsonObject { ["path"] = target, ["error"] = new JsonObject {
                    ["code"] = e is AgentFault fault ? fault.Code : e is PathRefusal refusal ? refusal.Code : "AGENT_ERROR",
                    ["message"] = e is AgentFault or PathRefusal ? e.Message : "File operation failed"
                } };
            }
            finally { concurrency.Release(); }
        }));
        return new JsonObject { ["results"] = new JsonArray(results) };
    }
    private async Task<JsonNode> List(JsonObject p, CancellationToken token)
    {
        var target = Text(p, "path"); var folder = workspace.Resolve(target);
        var limit = p["max"] is JsonValue v && v.TryGetValue<int>(out var n) && n > 0 ? Math.Min(n, 2000) : 2000;
        var entries = new JsonArray(); var truncated = false;
        var prefix = "agent:" + string.Join('/', Workspace.Segments(target[6..]));
        async Task Add(string file, string name)
        {
            if (entries.Count >= limit) { truncated = true; return; }
            var stat = new FileInfo(file);
            entries.Add((JsonNode)new JsonObject { ["path"] = name, ["size"] = stat.Length,
                ["sha256"] = await Blobs.FileHash(file, token), ["mtimeMs"] = new DateTimeOffset(stat.LastWriteTimeUtc).ToUnixTimeMilliseconds() });
        }
        async Task Walk(string dir, string name)
        {
            IEnumerable<string> files;
            try { files = Directory.GetFileSystemEntries(dir).Order(StringComparer.Ordinal); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return; }
            foreach (var file in files)
            {
                token.ThrowIfCancellationRequested();
                if (truncated) return;
                if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0 || file.EndsWith(Blobs.TemporarySuffix)) continue;
                var leaf = Path.GetFileName(file);
                try { Workspace.Segments(leaf); } catch (PathRefusal) { continue; }
                if (Directory.Exists(file)) await Walk(file, name + "/" + leaf);
                else if (File.Exists(file)) await Add(file, name + "/" + leaf);
            }
        }
        if (Path.Exists(folder) && (File.GetAttributes(folder) & FileAttributes.ReparsePoint) == 0)
        {
            if (File.Exists(folder)) await Add(folder, prefix);
            else if (Directory.Exists(folder)) await Walk(folder, prefix);
        }
        return new JsonObject { ["entries"] = entries, ["truncated"] = truncated };
    }
}
