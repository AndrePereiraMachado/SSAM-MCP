using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Bridge;

/// <summary>Portable projection of one Verify message; Key encodes the Studio's complete identity, never the localized
/// text. Serializes exactly like the kernel's MessageInfo (id, type, key, path, detail, and since the ninth release
/// ownerKey and screenKey when known), which the server deserializes.</summary>
internal sealed record MessageInfo(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("key")] string Key,
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("detail")] string Detail)
{
    /// <summary>Key of the object the message is about (the owner); the server's message policy reads it.</summary>
    [JsonPropertyName("ownerKey"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? OwnerKey { get; init; }
    /// <summary>Key of the screen that holds the owner (the owner itself when it is a screen), or null outside screens.</summary>
    [JsonPropertyName("screenKey"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? ScreenKey { get; init; }
    [JsonIgnore] public bool IsError => Type.Contains("Error", StringComparison.Ordinal);
    public override string ToString() => $"{Type} {Id}: {Detail} @ {Path}";
}

internal sealed record MessageDelta(
    [property: JsonPropertyName("new")] IReadOnlyList<MessageInfo> New,
    [property: JsonPropertyName("fixed")] IReadOnlyList<MessageInfo> Fixed,
    [property: JsonPropertyName("preexisting")] IReadOnlyList<MessageInfo> Preexisting)
{
    public static MessageDelta Compute(IEnumerable<MessageInfo> before, IEnumerable<MessageInfo> after)
    {
        var old = before.DistinctBy(m => m.Key).ToDictionary(m => m.Key, StringComparer.Ordinal);
        var current = after.DistinctBy(m => m.Key).ToDictionary(m => m.Key, StringComparer.Ordinal);
        return new(Ordered(current.Values.Where(m => !old.ContainsKey(m.Key))),
            Ordered(old.Values.Where(m => !current.ContainsKey(m.Key))),
            Ordered(current.Values.Where(m => old.ContainsKey(m.Key))));
    }

    private static MessageInfo[] Ordered(IEnumerable<MessageInfo> messages) => messages.OrderByDescending(m => m.IsError)
        .ThenBy(m => m.Path, StringComparer.Ordinal).ThenBy(m => m.Id, StringComparer.Ordinal)
        .ThenBy(m => m.Key, StringComparer.Ordinal).ToArray();
}

/// <summary>The Verify messages of a loaded module, one per message, as the kernel projects them (same key, path and
/// detail): the server compares baselines and deltas by the exact key text.</summary>
internal static class NativeMessages
{
    public static IReadOnlyList<MessageInfo> Messages(ESpace espace)
    {
        var result = new List<MessageInfo>();
        foreach (var m in espace.Verify())
        {
            var key = System.Text.Json.JsonSerializer.Serialize(new object?[] {
                m.Id, m.ObjectIdentifier?.GetObjectKey()?.ToString(), m.PropertyNames, m.MessageParameters });
            var definition = m.MessageDefinition;
            var text = definition.Message ?? "";
            var detail = definition.Detail?.Replace("\r", " ").Replace("\n", " ").Trim();
            if (!string.IsNullOrEmpty(detail) && !string.Equals(detail, text.Trim(), StringComparison.Ordinal)) text += " | " + detail;
            var owner = m.ObjectIdentifier?.TryGetAbstractObject();
            result.Add(new(m.Id, m.Type.ToString(), key, PathOf(owner), text)
                { OwnerKey = m.ObjectIdentifier?.GetObjectKey()?.ToString(), ScreenKey = ScreenKeyOf(owner) });
        }
        return result;
    }

    /// <summary>The screen (Reactive/Mobile or Traditional) that holds <paramref name="owner"/>, itself included; null outside
    /// screens. The kernel's ModelHost.ScreenKeyOf (ModelSession.Implements by interface name).</summary>
    public static string? ScreenKeyOf(object? owner)
    {
        for (var o = owner as OutSystems.Model.IObjectSignature; o != null; o = o.Parent as OutSystems.Model.IObjectSignature)
            if (IsScreen(o)) return o.ObjectKey?.ToString();
        return null;
    }

    public static bool IsScreen(object o) => o.GetType().GetInterfaces().Any(i => i.Name is "IMobileScreen" or "IWebScreen" || i.FullName is "IMobileScreen" or "IWebScreen");

    /// <summary>The readable lines of get_errors without the kernel hints: every error, warnings up to max, and how many
    /// warnings were left out.</summary>
    public static IReadOnlyList<string> Details(IReadOnlyList<MessageInfo> all, int max)
    {
        var errors = all.Where(m => m.IsError).ToArray();
        var warnings = all.Where(m => !m.IsError).ToArray();
        var list = errors.Select(m => m.ToString()).ToList();
        var room = Math.Max(0, max - list.Count);
        list.AddRange(warnings.Take(room).Select(m => m.ToString()));
        if (warnings.Length > room) list.Add($"... {warnings.Length - room} more warnings not shown (of {warnings.Length})");
        return list;
    }

    /// <summary>"Owner (Kind) / Child (Kind) / ..." up to 6 levels; Label without Name; expressions show their text.</summary>
    public static string PathOf(object? owner)
    {
        var path = new List<string>();
        var o = owner as OutSystems.Model.IObjectSignature;
        while (o != null && path.Count < 6)
        {
            var kind = Kind(o.GetInterface()?.Name ?? o.GetType().Name);
            var name = BridgeKit.InterfaceProp(o, "Name") as string;
            if (string.IsNullOrEmpty(name)) name = BridgeKit.InterfaceProp(o, "Label") as string;
            string? text = null;
            if (o is IExpression ex) { try { text = ex.Text; } catch { text = null; } }
            if (!string.IsNullOrEmpty(text)) path.Add($"{kind} \"{(text.Length > 80 ? text[..80] + "..." : text)}\"");
            else path.Add(string.IsNullOrEmpty(name) ? kind : $"{name} ({kind})");
            o = o.Parent as OutSystems.Model.IObjectSignature;
        }
        path.Reverse();
        return string.Join(" / ", path);
    }

    /// <summary>"IInputParameter" -> "InputParameter" (only the interface I prefix).</summary>
    public static string Kind(string name) => name.Length > 1 && name[0] == 'I' && char.IsUpper(name[1]) ? name[1..] : name;
}

internal sealed record RegisteredSnapshot(string Id, string ModuleKey, string Sha256, IReadOnlyList<MessageInfo> Messages);

/// <summary>Session-local provenance by module identity and bytes; paths alone never establish a merge base.</summary>
internal sealed class SnapshotRegistry
{
    private readonly Dictionary<string, RegisteredSnapshot> snapshots = new(StringComparer.Ordinal);
    private readonly object gate = new();
    public RegisteredSnapshot Register(string moduleKey, byte[] bytes, IReadOnlyList<MessageInfo> messages)
    {
        var snapshot = new RegisteredSnapshot(Guid.NewGuid().ToString("N"), moduleKey, Hash(bytes), Array.AsReadOnly(messages.ToArray()));
        lock (gate) snapshots.Add(snapshot.Id, snapshot);
        return snapshot;
    }
    public RegisteredSnapshot RequireBase(string moduleKey, byte[]? bytes, string? path)
    {
        var hash = bytes == null ? null : Hash(bytes);
        lock (gate)
            return snapshots.Values.LastOrDefault(s => s.ModuleKey == moduleKey && s.Sha256 == hash)
                ?? throw new InvalidOperationException($"base '{path ?? "(missing)"}' is not a snapshot of this module taken in this session: use snapshot_module");
    }
    public RegisteredSnapshot RequireSince(string moduleKey, string id)
    {
        lock (gate)
        {
            if (!snapshots.TryGetValue(id, out var snapshot)) throw new InvalidOperationException($"snapshot '{id}' is not registered in this session: use snapshot_module");
            if (snapshot.ModuleKey != moduleKey) throw new InvalidOperationException($"snapshot '{id}' belongs to another module; select its module or take a new snapshot");
            return snapshot;
        }
    }
    public static void RequireForeignIdentity(string localKey, string foreignKey)
    {
        if (!string.Equals(localKey, foreignKey, StringComparison.Ordinal))
            throw new InvalidOperationException($"foreign module key '{foreignKey}' differs from local module key '{localKey}': apply the job to snapshot_module output, then merge that result");
    }
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));
}

/// <summary>
/// Copy of the kernel's MergeReceipt (Anvil.Core.Delivery, MergeJournal.cs): the receipt of a merge_from_oml with the merge
/// order (two native merges, MergeHandler), as the journal records it. The second merge runs only on what the first left:
/// merged, or nothing to merge. While it runs, merged is unknown and secondPass reads started, so the journal state is
/// "unknown": a failure inside it reconciles as unknown (never repeated), never as the first merge alone. After it, merged
/// is true when either merge merged and undoSteps counts the native merges that merged. PlumbingParityTests compares both.
/// </summary>
internal static class MergeReceipt
{
    public static bool RunsSecondPass(JsonObject receipt, bool firstPassHadNoDifferences)
        => receipt["merged"]?.GetValue<bool>() == true || firstPassHadNoDifferences;

    /// <summary>Marks the second merge as started; returns whether the first one merged.</summary>
    public static bool BeginSecondPass(JsonObject receipt)
    {
        var first = receipt["merged"]?.GetValue<bool>() == true;
        receipt["merged"] = null; receipt["secondPass"] = new JsonObject { ["state"] = "started" };
        return first;
    }

    public static void EndSecondPass(JsonObject receipt, JsonObject second, bool firstMerged)
    {
        var merged = second["merged"]?.GetValue<bool>() == true;
        receipt["secondPass"] = second;
        receipt["merged"] = firstMerged || merged;
        if (merged) receipt["result"] = second["result"]?.DeepClone();
        receipt["undoSteps"] = (firstMerged ? 1 : 0) + (merged ? 1 : 0);
    }
}

/// <summary>Write-ahead operation facts owned by the executor. Existing IDs never execute again. Same files as the
/// kernel's journal (DurableJson), so merge_status reads either bridge's records.</summary>
internal sealed class MergeJournal(string directory)
{
    private string PathFor(string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) throw new ArgumentException("operation_id must be a GUID without separators");
        return Path.Combine(Path.GetFullPath(directory), id + ".json");
    }

    public JsonObject Status(string id, string? moduleKey = null)
    {
        var path = PathFor(id);
        if (!File.Exists(path)) return new() { ["operationId"] = id, ["state"] = "unknown" };
        var record = DurableJson.Read(path);
        if (moduleKey != null && record["binding"]?["module_key"]?.ToString() != moduleKey)
            throw new InvalidOperationException("Operation belongs to another module");
        return record;
    }

    public Operation Begin(string id, JsonObject binding) => new(PathFor(id), id, binding);

    public sealed class Operation : IDisposable
    {
        private readonly string path;
        private readonly FileStream lease;
        public JsonObject State { get; }
        public bool IsNew { get; }
        internal Operation(string path, string id, JsonObject binding)
        {
            this.path = path;
            lease = DurableJson.Lease(path + ".lock");
            try
            {
                IsNew = !File.Exists(path);
                if (!IsNew)
                {
                    State = DurableJson.Read(path);
                    if (!JsonNode.DeepEquals(State["binding"], binding)) throw new InvalidOperationException("operation_id was already used with different bytes or target");
                }
                else
                {
                    State = new() { ["operationId"] = id, ["binding"] = binding.DeepClone(), ["state"] = "unknown", ["startedAt"] = DateTimeOffset.UtcNow.ToString("O") };
                    DurableJson.Write(path, State);
                }
            }
            catch { lease.Dispose(); throw; }
        }
        public void Record(JsonObject receipt)
        {
            State["receipt"] = receipt.DeepClone();
            State["state"] = receipt["merged"]?.GetValue<bool>() == true ? "applied"
                : receipt["reason"]?.ToString() == "no differences" ? "unchanged"
                : receipt["merged"]?.GetValue<bool>() == false ? "not-applied" : "unknown";
            State["recordedAt"] = DateTimeOffset.UtcNow.ToString("O");
            DurableJson.Write(path, State);
        }
        public void Failure(string error)
        {
            State["error"] = error;
            DurableJson.Write(path, State);
        }
        public void Dispose() => lease.Dispose();
    }
}
