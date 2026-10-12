using System.Text.Json.Serialization;

namespace Anvil.Core;

/// <summary>Projecao portatil de uma mensagem; Key codifica a identidade completa do Studio, nunca o texto localizado.</summary>
public sealed record MessageInfo(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("key")] string Key,
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("detail")] string Detail)
{
    /// <summary>Key of the object the message is about (the owner). Read by the policy: an Unused* warning on an object
    /// this job created is mechanical, the same warning on an older object is not.</summary>
    [JsonPropertyName("ownerKey"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? OwnerKey { get; init; }
    /// <summary>Key of the screen that holds the owner (the owner itself when it is a screen), or null outside screens.</summary>
    [JsonPropertyName("screenKey"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? ScreenKey { get; init; }
    /// <summary>The owner as the Verify gave it, while its module is loaded (never written): the CustomProperty of a widget
    /// (the Values of a Dropdown, the Value of an Expression) is not among the children of its widget, so no walk of the
    /// module finds it by its key. Held weakly: the bridge keeps the messages of every snapshot of a Studio session
    /// (SnapshotRegistry), and a message must never keep the objects of a closed or changed module alive.</summary>
    [JsonIgnore] public object? Owner { get => _owner != null && _owner.TryGetTarget(out var o) ? o : null; init => _owner = value == null ? null : new(value); }
    private readonly WeakReference<object>? _owner;
    /// <summary>The properties of the owner the message is about (the Verify's PropertyNames: Condition, ValueExpression).</summary>
    [JsonIgnore] public IReadOnlyList<string>? Properties { get; init; }
    [JsonIgnore] public bool IsError => Type.Contains("Error", StringComparison.Ordinal);
    public override string ToString() => $"{Type} {Id}: {Detail} @ {Path}";
}

public sealed record MessageDelta(
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
