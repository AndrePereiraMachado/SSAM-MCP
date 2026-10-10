using System.Collections;
using System.Reflection;

namespace Anvil.Authoring.Transport;

/// <summary>Fixed .NET List adapter. Version is observable through existing enumerators;
/// public Clear/Add cannot reproduce it. Validate this runtime layout before any call.
/// It never reads arbitrary source fields or executes a source constructor/getter.</summary>
internal sealed class ClrListState
{
    private readonly FieldInfo version;
    private readonly PropertyInfo capacity;
    internal ClrListState(Type type)
    {
        if (!type.IsGenericType || type.GetGenericTypeDefinition() != typeof(List<>))
            throw new NotSupportedException("List state requires the exact framework List<T> type.");
        version = type.GetField("_version", BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new NotSupportedException("This runtime does not expose the verified List<T> version layout.");
        capacity = type.GetProperty("Capacity")!;
        if (version.FieldType != typeof(int) || version.IsInitOnly || capacity?.PropertyType != typeof(int)
            || capacity.GetMethod == null || capacity.SetMethod == null)
            throw new NotSupportedException("This runtime has an unsupported List<T> state layout.");
    }
    internal int Version(IList list) => (int)version.GetValue(list)!;
    internal int Capacity(IList list) => (int)capacity.GetValue(list)!;
    internal void Restore(IList list, int desiredVersion, int desiredCapacity)
    {
        capacity.SetValue(list, desiredCapacity);
        version.SetValue(list, desiredVersion);
    }
}
