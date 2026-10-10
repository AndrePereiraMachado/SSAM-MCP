using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>Durable, exclusive receipt. An uncertain request is never repeated automatically.</summary>
public static class DataReceipt
{
    public static JsonObject Execute(string directory, string host, string moduleKey, string entityKey,
        string modelHash, JsonObject request, Func<JsonObject> send)
    {
        if (string.IsNullOrWhiteSpace(request["authorization"]?.ToString()))
            throw new ArgumentException("Writing data requires the user's original authorization words in authorization.");
        if (!Guid.TryParse(request["operationId"]?.ToString(), out var operationId))
            throw new ArgumentException("Writing data requires a stable UUID operationId.");
        Directory.CreateDirectory(directory);
        var file = Path.Combine(directory, operationId.ToString("N") + ".json");
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            host + "\n" + moduleKey + "\n" + entityKey + "\n" + modelHash + "\n" + request.ToJsonString())));
        using var gate = new FileStream(file + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        if (File.Exists(file))
        {
            var previous = JsonNode.Parse(File.ReadAllText(file))!.AsObject();
            if (previous["digest"]?.ToString() != digest) throw new InvalidOperationException("operationId already belongs to a different request.");
            if (previous["state"]?.ToString() == "completed")
            {
                var result = previous["result"]!.DeepClone().AsObject(); result["replayed"] = true; result["receipt"] = file; return result;
            }
            throw new InvalidOperationException("Uncertain write: reconcile live records and receipt before any new request: " + file);
        }
        var receipt = new JsonObject { ["operationId"] = operationId.ToString(), ["digest"] = digest,
            ["host"] = host, ["moduleKey"] = moduleKey, ["entityKey"] = entityKey, ["modelHash"] = modelHash,
            ["authorization"] = request["authorization"]!.ToString(), ["operation"] = request["operation"]?.ToString(),
            ["state"] = "pending", ["startedUtc"] = DateTime.UtcNow.ToString("O") };
        Save(file, receipt);
        // No catch/retry. A crash, timeout, transport or deserialization error leaves pending evidence.
        var response = send();
        receipt["result"] = response.DeepClone(); receipt["state"] = "completed";
        receipt["finishedUtc"] = DateTime.UtcNow.ToString("O"); Save(file, receipt);
        response["receipt"] = file; return response;
    }

    private static void Save(string path, JsonObject value)
    {
        using (var stream = new FileStream(path + ".tmp", FileMode.Create, FileAccess.Write, FileShare.None))
        {
            var bytes = Encoding.UTF8.GetBytes(value.ToJsonString()); stream.Write(bytes); stream.Flush(flushToDisk: true);
        }
        File.Move(path + ".tmp", path, overwrite: true);
    }
}
