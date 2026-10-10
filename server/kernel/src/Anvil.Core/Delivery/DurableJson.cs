using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>Durable, checksummed JSON replacement. Callers hold a file lease for read/modify/write.</summary>
public static class DurableJson
{
    public static FileStream Lease(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException ex) { throw new InvalidOperationException("Operation is already running; inspect its status instead of starting another: " + Path.GetFileName(path), ex); }
    }

    public static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

    public static JsonObject Read(string path)
    {
        var envelope = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        var payload = envelope["payload"]!.GetValue<string>();
        if (envelope["format"]?.GetValue<int>() != 1 || envelope["sha256"]?.ToString() != Hash(payload))
            throw new InvalidDataException("Task checkpoint is corrupt; execution refused: " + path);
        return JsonNode.Parse(payload)!.AsObject();
    }

    public static void Write(string path, JsonObject value)
    {
        var payload = value.ToJsonString();
        var envelope = new JsonObject { ["format"] = 1, ["sha256"] = Hash(payload), ["payload"] = payload };
        WriteBytes(path, Encoding.UTF8.GetBytes(envelope.ToJsonString()));
    }

    public static void WriteBytes(string path, byte[] bytes)
    {
        path = Path.GetFullPath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            { stream.Write(bytes); stream.Flush(flushToDisk: true); }
            File.Move(temporary, path, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}
