namespace Anvil.Authoring;

/// <summary>Persistent identity. Different entity types cannot be interchanged accidentally.</summary>
public readonly record struct Id<T>(long Value) : IComparable<Id<T>>
{
    public bool IsEmpty => Value == 0;
    public int CompareTo(Id<T> other) => Value.CompareTo(other.Value);
    public override string ToString() => Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
}

/// <summary>Marks a class/record as persisted data. Unmarked data records are transport structures.</summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct)]
public sealed class EntityAttribute : Attribute;

/// <summary>Marks a fixed catalog expressed as an enum or immutable record with declared values.</summary>
[AttributeUsage(AttributeTargets.Enum | AttributeTargets.Class | AttributeTargets.Struct)]
public sealed class StaticEntityAttribute : Attribute;

/// <summary>Declares an ordered index using property names, normally supplied through nameof.</summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct, AllowMultiple = true)]
public sealed class IndexAttribute(params string[] properties) : Attribute
{
    public string[] Properties { get; } = properties;
    public bool Unique { get; set; }
    public string? Name { get; set; }
}

/// <summary>Declares a native server action. Public actions require authenticated access.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class ServerActionAttribute : Attribute;

/// <summary>Declares a native service action with a remote module boundary.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class ServiceActionAttribute : Attribute;

/// <summary>Additional role restrictions; checks are emitted on the server.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class AuthorizeAttribute(params string[] roles) : Attribute
{
    public string[] Roles { get; } = roles;
}
