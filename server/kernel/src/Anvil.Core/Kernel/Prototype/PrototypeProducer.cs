using System.Collections;
using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>A parameter or an attribute of the producer: its name, its type as the Studio writes it (Text, Integer, Time,
/// "EtapaPontoDTO List", "TipoBatida Identifier", "ResumoDiaDTO") and whether it is mandatory.</summary>
public sealed record ProducerParam(string Name, string Type, bool Mandatory);

/// <summary>A public server (or service) action of the producer.</summary>
public sealed record ProducerAction(string Name, IReadOnlyList<ProducerParam> Inputs, IReadOnlyList<ProducerParam> Outputs);

/// <summary>A record of a static entity of the producer: its identifier (the name Entities.&lt;Entity&gt;.&lt;Identifier&gt; reads), its
/// Id and Label values and its position.</summary>
public sealed record ProducerRecord(string Identifier, string? Id, string? Label, int Order);

/// <summary>
/// The public surface of the producer module a prototype binds to (data.bind, docs/PROTOTIPO-NATIVO.md 2.12): its server actions
/// with inputs and outputs, the attributes of its structures and entities (the types the outputs carry) and the records of its
/// static entities. Read the same way from the producer's own model (an .oml binding) and from the signatures a reference
/// imported into the consumer (an .avsig binding), so the binder never depends on how the producer was bound.
/// </summary>
public sealed class PrototypeProducer
{
    public required string Name { get; init; }
    public Dictionary<string, ProducerAction> Actions { get; } = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>Structure or entity name -> attributes (the fields of a record of that type).</summary>
    public Dictionary<string, List<ProducerParam>> Types { get; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, List<ProducerRecord>> Statics { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The element of a list type, the entity of an identifier, or the type itself.</summary>
    public static (string Base, string Shape) Shape(string type)
    {
        if (type.EndsWith(" List", StringComparison.Ordinal)) return (type[..^" List".Length], "list");
        if (type.EndsWith(" Identifier", StringComparison.Ordinal)) return (type[..^" Identifier".Length], "identifier");
        if (type.EndsWith(" Record", StringComparison.Ordinal)) return (type[..^" Record".Length], "record");
        return (type, "value");
    }

    /// <summary>The attributes of a record type (structure or entity), or null for a basic type.</summary>
    public IReadOnlyList<ProducerParam>? Fields(string type)
    {
        var (b, shape) = Shape(type);
        if (shape is "list" or "identifier") return null;
        return Types.TryGetValue(b, out var f) ? f : null;
    }

    public static bool IsBasic(string type) => type is "Text" or "Integer" or "Long Integer" or "Decimal" or "Currency" or "Boolean" or "Date" or "Time" or "Date Time"
        or "Email" or "Phone Number" or "Binary Data";

    /// <summary>The surface as JSON (the receipt and the tests read it).</summary>
    public JsonObject ToJson() => new()
    {
        ["name"] = Name,
        ["actions"] = new JsonObject(Actions.Values.OrderBy(a => a.Name, StringComparer.Ordinal).Select(a => KeyValuePair.Create(a.Name, (JsonNode?)new JsonObject
        {
            ["inputs"] = new JsonArray(a.Inputs.Select(p => (JsonNode)(p.Name + ": " + p.Type + (p.Mandatory ? " req" : ""))).ToArray()),
            ["outputs"] = new JsonArray(a.Outputs.Select(p => (JsonNode)(p.Name + ": " + p.Type)).ToArray()),
        }))),
        ["types"] = new JsonObject(Types.OrderBy(t => t.Key, StringComparer.Ordinal).Select(t => KeyValuePair.Create(t.Key, (JsonNode?)new JsonArray(t.Value.Select(p => (JsonNode)(p.Name + ": " + p.Type)).ToArray())))),
        ["statics"] = new JsonObject(Statics.OrderBy(t => t.Key, StringComparer.Ordinal).Select(t => KeyValuePair.Create(t.Key, (JsonNode?)new JsonArray(t.Value.Select(r => (JsonNode)$"{r.Identifier}={r.Id}:{r.Label}").ToArray())))),
    };

    /// <summary>Reads the surface from model elements: the producer's top-level elements (publicOnly: the actions marked Public) or
    /// the children of the consumer's reference to it (every element there is public by construction).</summary>
    public static PrototypeProducer Read(string name, IEnumerable<object> elements, bool publicOnly)
    {
        var producer = new PrototypeProducer { Name = name };
        foreach (var element in elements)
        {
            if (element is not IObjectSignature o || TypeResolver.Name(o) is not { Length: > 0 } elementName) continue;
            if (Is(o, "IServerAction", "IServerActionSignature", "IServiceAction", "IServiceActionSignature"))
            {
                if (publicOnly && ModelHost.Prop(o, "Public") is not true) continue;
                producer.Actions[elementName] = new ProducerAction(elementName,
                    Sequence(o, "InputParameters").Select(Param).ToList(), Sequence(o, "OutputParameters").Select(Param).ToList());
            }
            else if (Is(o, "IStructure", "IStructureSignature"))
                producer.Types[elementName] = Sequence(o, "Attributes").Select(Param).ToList();
            else if (Is(o, "IStaticEntity", "IStaticEntitySignature"))
            {
                producer.Types[elementName] = Sequence(o, "Attributes").Select(Param).ToList();
                producer.Statics[elementName] = Records(o);
            }
            else if (Is(o, "IServerEntity", "IServerEntitySignature", "IEntity", "IEntitySignature"))
                producer.Types[elementName] = Sequence(o, "Attributes").Select(Param).ToList();
        }
        return producer;
    }

    private static bool Is(object o, params string[] kinds) => kinds.Any(k => ModelSession.Implements(o, k));

    private static ProducerParam Param(object p) => new(TypeResolver.Name(p) ?? "", UiCatalog.TypeName(ModelHost.Prop(p, "DataType")), ModelHost.Prop(p, "IsMandatory") is true);

    private static IEnumerable<object> Sequence(object? value, string property)
        => value != null && ModelHost.Prop(value, property) is IEnumerable sequence and not string ? sequence.Cast<object>() : [];

    private static List<ProducerRecord> Records(object entity)
    {
        var records = new List<ProducerRecord>();
        var children = Sequence(entity, "Records").ToList();
        if (children.Count == 0 && entity is IObjectSignature sig)
            children = sig.Children.OfType<IObjectSignature>().Where(c => ModelSession.Implements(c, "IRecord") || ModelSession.Implements(c, "IRecordSignature")).Cast<object>().ToList();
        foreach (var record in children)
        {
            var identifier = ModelHost.Prop(record, "Identifier") as string ?? TypeResolver.Name(record) ?? "";
            string? id = null, label = null; int? order = null;
            var values = Sequence(record, "AttributeValues").ToList();
            if (values.Count == 0 && record is IObjectSignature rs) values = rs.Children.OfType<IObjectSignature>().Where(c => ModelSession.Implements(c, "IRecordAttributeValue") || ModelSession.Implements(c, "IRecordAttributeValueSignature")).Cast<object>().ToList();
            var attributes = Sequence(entity, "Attributes").Select(a => TypeResolver.Name(a) ?? "").ToList();
            foreach (var (v, index) in values.Select((v, i) => (v, i)))
            {
                // a signature's value may not name its attribute: the values follow the attributes in order
                var attribute = TypeResolver.Name(ModelHost.Prop(v, "Attribute")) is { Length: > 0 } named ? named : index < attributes.Count ? attributes[index] : "";
                var text = (ModelHost.Prop(v, "Value") as IExpression)?.Text ?? ModelHost.Prop(v, "Value")?.ToString();
                if (text == null) continue;
                var literal = text.Length >= 2 && text[0] == '"' && text[^1] == '"' ? text[1..^1].Replace("\"\"", "\"") : text;
                if (attribute.Equals("Id", StringComparison.OrdinalIgnoreCase)) id = literal;
                else if (attribute.Equals("Label", StringComparison.OrdinalIgnoreCase)) label = literal;
                else if (attribute.Equals("Order", StringComparison.OrdinalIgnoreCase) && int.TryParse(literal, out var n)) order = n;
            }
            records.Add(new ProducerRecord(identifier, id, label, order ?? records.Count + 1));
        }
        return records.OrderBy(r => r.Order).ThenBy(r => r.Identifier, StringComparer.Ordinal).ToList();
    }
}
