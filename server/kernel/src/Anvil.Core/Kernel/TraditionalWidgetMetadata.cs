using System.Reflection;
using System.Collections;
using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.Model.Types;

namespace Anvil.Core;

// The O11 V1 interface predates record-list ComboBoxes. Restrict the bridge to the
// native properties used by that control; do not expose arbitrary Studio internals.
internal static class TraditionalWidgetMetadata
{
    internal static bool Combo(Type type) => type.FullName == "ServiceStudio.Model.WebWidgets+ComboBox";
    private static readonly HashSet<string> ComboProperties = new(StringComparer.Ordinal) {
        "SourceRecordList", "SourceAttributeParent", "SourceAttributeRecord", "SourceIdentifierAttribute",
        "SourceIdentifierAttributeParent", "SourceIdentifierAttributeRecord", "OnChange", "Enabled"
    };
    public static IEnumerable<PropertyInfo> Properties(Type type) => Combo(type)
        ? type.GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p=>ComboProperties.Contains(p.Name))
        : type.FullName == "ServiceStudio.Model.SpecialListEntry"
            ? type.GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p=>p.Name is "Value" or "Label") : [];
    public static IEnumerable<MethodInfo> Methods(Type type) => Combo(type)
        ? type.GetMethods(BindingFlags.Public | BindingFlags.Instance).Where(m=>m.Name is "SetSourceRecordList" or "SetEnabled") : [];

    public static string SpecialOptions(object combo)
    {
        var entries = (IEnumerable)combo.GetType().GetProperty("SpecialList")!.GetValue(combo)!;
        return new JsonArray(entries.Cast<object>().Select(e => (JsonNode)new JsonObject {
            ["label"] = e.GetType().GetProperty("Label")!.GetValue(e)?.ToString() ?? "",
            ["value"] = e.GetType().GetProperty("Value")!.GetValue(e)?.ToString() ?? ""
        }).ToArray()).ToJsonString();
    }

    public static void SetSpecialOptions(object combo, string json)
    {
        var wanted = JsonNode.Parse(json) as JsonArray ?? throw new FormatException("SpecialOptions requires a JSON array of {label,value} strings.");
        var options = wanted.Select(n => n is JsonObject o && o.Count == 2 && o["label"] is JsonValue label && label.TryGetValue<string>(out var l)
            && o["value"] is JsonValue value && value.TryGetValue<string>(out var v) ? (l,v)
            : throw new FormatException("Each SpecialOptions item requires exactly label and value strings.")).ToArray();
        var entries = (IEnumerable)combo.GetType().GetProperty("SpecialList")!.GetValue(combo)!;
        foreach (var entry in entries.Cast<object>().ToArray()) entry.GetType().GetMethod("Delete", Type.EmptyTypes)!.Invoke(entry, null);
        var add = ModelApiMetadata.Methods(combo.GetType()).Single(m=>m.Name == "AddSpecialValue");
        foreach (var (label,value) in options) add.Invoke(combo,[label,value]);
    }

    public static IObjectSignature ColumnParent(object combo, IObjectSignature record, IObjectSignature field)
    {
        var expression = combo.GetType().GetProperty("SourceRecordList")!.GetValue(combo);
        var reference = expression?.GetType().GetProperty("Type")?.GetValue(expression);
        var type = reference?.GetType().GetProperty("Type")?.GetValue(reference);
        var element = type is IListType list ? list.ElementType : null;
        if (ReferenceEquals(element, record)) return field;
        var fields = element?.GetType().GetMethod("GetAttributes", Type.EmptyTypes)?.Invoke(element, null) as IEnumerable;
        var parent = fields?.Cast<object>().OfType<IObjectSignature>().SingleOrDefault(a =>
            ReferenceEquals(a.GetType().GetProperty("AttributeType")?.GetValue(a), record));
        return parent ?? throw new InvalidOperationException("The select column " + ModelHost.PathOf(field)
            + " does not belong to its Source Record List.");
    }
}
