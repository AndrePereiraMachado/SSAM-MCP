using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>Proof-only jobs never reach a module: a job kept under the K1 proof folder of tests\jobs-live (the K1
/// Manage Dependencies proofs over a copy, a client module; the folder is recognized by the SHA-256 of its name, so no
/// client name is compiled in) or whose description, or any element description it writes, carries the
/// "NEVER DELIVER" marker is refused before a delivery task is registered or the bridge is called. The rule covers every
/// job file the delivery reads: composite parts ("jobs"), "job:" bases and "job:" producers, not only the top-level file.
/// Resume re-reads the recorded job, so a task registered before this rule is refused as well.</summary>
public static class NonDeliverableJobs
{
    public const string Marker = "NEVER DELIVER";
    // tests\jobs-live\<K1 proof folder>: the parents by name, the folder by the SHA-256 of its lower-case name.
    private static readonly string[] ProofFolderParents = ["tests", "jobs-live"];
    private const string ProofFolderNameSha256 = "5e5a79b97d0fbd5246ef445e39e2eca687476757cb84527aa324c04f94eed270";

    public static void Require(string jobPath)
    {
        var top = Path.GetFullPath(jobPath);
        foreach (var file in JobFiles(top))
        {
            var via = file.Equals(top, StringComparison.OrdinalIgnoreCase) ? "" : $" (read by '{top}')";
            if (ProofFolderOf(file) is { } folder)
                throw new InvalidOperationException($"deliver refuses proof-only jobs: '{file}'{via} is under {folder} " +
                    "(K1 proofs over a copy, never delivered). Write a job of your own for the target module; no new task was registered and the bridge was not called");
            if (MarkedDescription(file) is { } where)
                throw new InvalidOperationException($"deliver refuses a job marked {Marker}: {where} of '{file}'{via} carries the marker. " +
                    "No new task was registered and the bridge was not called");
        }
    }

    /// <summary>The job and every job file it pulls in, as the delivery receipt records them. A graph that cannot be
    /// walked (missing part, unreadable file) falls back to the top-level file; the job validation refuses it later.</summary>
    private static IEnumerable<string> JobFiles(string jobPath)
    {
        try { return DeliveryReceipt.Sources(jobPath).Select(source => source!["path"]!.GetValue<string>()).ToList(); }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException)
        { return new[] { jobPath }; }
    }

    /// <summary>True when the job sits in the K1 proof folder of tests\jobs-live (or below it), in any checkout.</summary>
    public static bool InProofFolder(string jobPath) => ProofFolderOf(jobPath) != null;

    /// <summary>tests\jobs-live\<folder> when the job sits in the K1 proof folder (or below it), else null.</summary>
    private static string? ProofFolderOf(string jobPath)
    {
        for (var directory = new DirectoryInfo(Path.GetDirectoryName(Path.GetFullPath(jobPath))!); directory != null; directory = directory.Parent)
            if (IsProofFolder(directory.Name) && Named(directory.Parent, 1) && Named(directory.Parent?.Parent, 0))
                return Path.Combine(ProofFolderParents[0], ProofFolderParents[1], directory.Name);
        return null;
        static bool Named(DirectoryInfo? directory, int index) =>
            directory != null && directory.Name.Equals(ProofFolderParents[index], StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsProofFolder(string name) =>
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(name.ToLowerInvariant())))
            .Equals(ProofFolderNameSha256, StringComparison.OrdinalIgnoreCase);

    /// <summary>The JSON path of the first description carrying the marker: a "description" value anywhere in the job,
    /// or the value of a "set" of the Description property. A job that cannot be read or parsed is left to the job
    /// validation, which parses it the same way and refuses it.</summary>
    public static string? MarkedDescription(string jobPath)
    {
        JsonNode? root;
        try { root = JsonNode.Parse(File.ReadAllText(jobPath)); }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException) { return null; }
        return Find(root, "$");
    }

    private static string? Find(JsonNode? node, string path)
    {
        switch (node)
        {
            case JsonObject item:
                if (Text(item["prop"]) is { } property && property.Equals("Description", StringComparison.OrdinalIgnoreCase) && Marked(item["value"]))
                    return path + ".value";
                foreach (var (name, value) in item)
                {
                    if (name.Equals("description", StringComparison.OrdinalIgnoreCase) && Marked(value)) return path + "." + name;
                    if (Find(value, path + "." + name) is { } found) return found;
                }
                break;
            case JsonArray items:
                for (var i = 0; i < items.Count; i++)
                    if (Find(items[i], $"{path}[{i}]") is { } found) return found;
                break;
        }
        return null;
    }

    private static string? Text(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
    private static bool Marked(JsonNode? node) => Text(node)?.Contains(Marker, StringComparison.Ordinal) == true;
}
