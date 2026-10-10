using System.Security.Cryptography;
using System.Text.Json.Nodes;
namespace Anvil.Core.Delivery;

public static class DeliveryReceipt
{
    // Keep the model adapter out of the pure delivery path's JIT dependencies.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    internal static void RequireProducerEnvironment(string path,string? target)
        => NativeReferenceSnapshot.Read(path).RequireDeliverable(target);
    public static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
    public static JsonArray Sources(string path)
    {
        var files = new JsonArray(); var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        Visit(Path.GetFullPath(path)); return files;
        void Visit(string file)
        {
            if (!visited.Add(file)) return;
            files.Add(new JsonObject { ["path"] = file, ["sha256"] = Hash(file) });
            if (ModuleSpecification.IsCSharpSource(file)) return;
            if (ModuleSpecification.IsHtmlSource(file))
            {
                var bundle=UiSourceBundle.Read(file);var root=UiSourceBundle.SourceRoot(file);
                foreach(var name in bundle.Files.Keys)
                {
                    var dependency=Path.GetFullPath(Path.Combine(root,name));
                    if(visited.Add(dependency))files.Add(new JsonObject{["path"]=dependency,["sha256"]=Hash(dependency)});
                }
                return;
            }
            var node = JsonNode.Parse(File.ReadAllText(file))!;
            var dir = Path.GetDirectoryName(file)!;
            if (node is JsonObject obj)
            {
                if (obj["base"]?.ToString().StartsWith("job:") == true) Visit(JobRunner.ResolveJobFile(obj["base"]!.ToString(), dir));
                foreach (var part in obj["jobs"]?.AsArray() ?? new JsonArray()) Visit(JobRunner.ResolveJobFile(part!.ToString(), dir));
            }
            foreach (var op in (node is JsonArray array ? array : node["ops"]?.AsArray()) ?? new JsonArray())
                if (op?["op"]?.ToString() == "reference" && op["producer"]?.ToString().StartsWith("job:") == true)
                    Visit(JobRunner.ResolveJobFile(op["producer"]!.ToString(), dir));
        }
    }
    public static void RequireFrozenSource(string path,JsonObject specification)
    {
        if (specification["csharpSource"] is { } code)
        {
            var currentCode = ModuleSpecification.IsCSharpSource(path) ? Anvil.CSharp.SourceBundle.Read(path)
                : JsonNode.Parse(File.ReadAllText(path))?["csharpSource"];
            if (currentCode == null || !JsonNode.DeepEquals(Anvil.CSharp.SourceBundle.Canonical(code), Anvil.CSharp.SourceBundle.Canonical(currentCode)))
                throw new InvalidOperationException("C# source changed between compilation and delivery; no write was attempted");
            return;
        }
        if(specification["uiSource"] is not { } frozen)return;
        var current=ModuleSpecification.IsHtmlSource(path)?UiSourceBundle.Read(path).ToJson():
            JsonNode.Parse(File.ReadAllText(path))?["uiSource"];
        if(current==null||!JsonNode.DeepEquals(UiSourceBundle.From(frozen).ToJson(),UiSourceBundle.From(current).ToJson()))
            throw new InvalidOperationException("UI source changed between compilation and delivery; no write was attempted");
    }
    public static JsonArray Changed(JsonArray files)
    {
        var changed = new JsonArray();
        foreach (var entry in files.OfType<JsonObject>())
        {
            var path = entry["path"]!.ToString();
            if (!File.Exists(path) || Hash(path) != entry["sha256"]!.ToString()) changed.Add(path);
        }
        return changed;
    }
    public static JsonObject Check(string resultPath)
    {
        var result = JsonNode.Parse(File.ReadAllText(resultPath))!;
        if (result["taskId"] != null)
        {
            var checkpoint = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(resultPath))!, "task.json");
            if (!File.Exists(checkpoint) || !JsonNode.DeepEquals(result, DurableJson.Read(checkpoint)))
                return new JsonObject { ["accepted"] = false, ["error"] = "Receipt differs from the authoritative task checkpoint" };
        }
        var changed = result["sources"] is JsonArray sources ? Changed(sources) : new JsonArray("Receipt has no source hashes");
        if (result["artifacts"] is JsonArray artifacts)
            foreach (var entry in Changed(artifacts)) changed.Add(entry!.DeepClone());
        else changed.Add("Receipt has no artifact hashes");
        foreach (var attempt in result["attempts"]?.AsArray().OfType<JsonObject>() ?? [])
            if (attempt["artifacts"] is JsonArray previousArtifacts)
                foreach (var entry in Changed(previousArtifacts)) changed.Add(entry!.DeepClone());
        return new JsonObject { ["accepted"] = result["delivered"]?.GetValue<bool>() == true && changed.Count == 0,
            ["module"] = result["module"]?.DeepClone(), ["changed"] = changed,
            ["dataChecks"] = result["dataProof"]?["count"]?.DeepClone(),
            ["dataSummary"] = result["dataProof"]?["dataSummary"]?.DeepClone(),
            ["scope"] = "Checks this successful receipt and its source/artifact hashes. It does not inspect later edits in the live Studio.",
            ["hint"] = changed.Count > 0 ? "Changed files are not covered by this delivery. Inspect the differences and deliver the remaining change before claiming completion." : null };
    }
}
