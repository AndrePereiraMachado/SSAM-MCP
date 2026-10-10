using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.Model.Data;
using OutSystems.Model.Types;

namespace Anvil.Core;

/// <summary>Type meaning survives regenerated list keys; named records retain their producer identity.</summary>
public static class SemanticTypes
{
    public static JsonObject Describe(IESpace module, ITypeSignature type)
    {
        if (type is IListType list)
            return new() { ["kind"] = "list", ["element"] = Describe(module, list.ElementType) };
        if (type is IIdentifierType identifier)
            return new() { ["kind"] = "identifier", ["entity"] = Named(identifier.Entity, "entity") };
        foreach (var name in new[] { "Text", "Integer", "Long Integer", "Decimal", "Boolean", "Date", "Time", "Date Time", "Currency", "Email", "Phone Number", "Binary Data" })
            if (ReferenceEquals(TypeResolver.Basic(module, name), type))
                return new() { ["kind"] = "primitive", ["name"] = name };
        if (ReferenceEquals(module.ObjectType, type)) return new() { ["kind"] = "primitive", ["name"] = "Object" };
        if (type is IEntitySignature entity) return Named(entity, "entity");
        if (type is IStructureSignature structure) return Named(structure, "structure");
        throw new InvalidOperationException("Unsupported semantic data type: " + type.GetType().FullName);
    }

    private static JsonObject Named(IObjectSignature element, string kind)
    {
        var identity = element.GlobalKey?.ToString();
        if (string.IsNullOrWhiteSpace(identity)) throw new InvalidOperationException("Data type has no producer identity");
        return new() { ["kind"] = kind, ["globalKey"] = identity };
    }
}
