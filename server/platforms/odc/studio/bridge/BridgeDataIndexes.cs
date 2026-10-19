using OutSystems.Model.Data;
using OutSystems.Model.Enumerations;

// Read-only model metadata. The same signature API covers a local entity and
// the producer signature of an entity consumed through a reference.
internal static class BridgeDataIndexes
{
    public static object[] Read(IEntitySignature entity) => entity is IServerEntitySignature server
        ? server.Indexes.Where(index => index.Unique).Select(index => (object)new {
            name = index.Name, unique = index.Unique,
            attributes = index.IndexAttributes.Select(part => part.Attribute.DisplayName).ToArray(),
        }).ToArray()
        : [];

    // Whether the server numbers the identifier itself, from IEntityAttributeSignature.IsAutoNumber: the own entity's
    // attribute (IEntityAttribute) and the producer signature of a referenced entity both carry it. YesIfEmpty counts
    // as auto-number (the server may generate the value). Null when the model cannot say: no identifier, an unknown
    // value, or a model that fails to answer. Never throws.
    public static bool? IdentifierAutoNumber(IEntitySignature entity)
    {
        try
        {
            return entity?.IdentifierAttribute?.IsAutoNumber switch
            {
                AutoNumber.No => false,
                AutoNumber.Yes or AutoNumber.YesIfEmpty => true,
                _ => null,
            };
        }
        catch (Exception)
        {
            return null;
        }
    }
}
