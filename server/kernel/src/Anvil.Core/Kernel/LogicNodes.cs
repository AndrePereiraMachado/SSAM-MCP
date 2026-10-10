using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>Closed native-node declarations inside logic, compiled through the existing verbs.
/// References configure this node only; no target paths, mutations, or arbitrary Model API calls.</summary>
public static class LogicNodes
{
    public sealed record Field(string Kind, string[]? Values = null, string? Default = null);
    public sealed record Shape(bool Terminal, bool Named, bool Arguments, Dictionary<string, Field> Fields);
    private static Field E() => new("expression");
    private static Field T(string? value = null) => new("text", Default: value);
    private static Field R() => new("reference");
    private static Field B() => new("boolean");
    private static Field D() => new("dataType");
    private static Field Enum(params string[] values) => new("enum", values);
    private static Field EnumDefault(string value, params string[] values) => new("enum", values, value);
    /// <summary>The Refresh Data MaxRecords left out: the kernel writes the Max. Records of the aggregate it refreshes (50 when
    /// that is empty), the value the ODC native merge keeps anyway (Verbs.Set, IRefreshDataNode).</summary>
    public const string MaxRecordsOfSource = "";
    private static Shape S(bool terminal, bool named, bool args, params (string Name, Field Field)[] fields)
        => new(terminal, named, args, fields.ToDictionary(f => f.Name, f => f.Field, StringComparer.Ordinal));
    public static readonly IReadOnlyDictionary<string, Shape> Shapes = new Dictionary<string, Shape>
    {
        ["ICallAgentNode"] = S(false, true, true, ("Agent", R()), ("Description", T(""))),
        // C18 (atritos 3): DateFormat left out is ISO, the Studio's default for a new node.
        ["IJSONSerializeNode"] = S(false, true, false, ("Data", E()), ("DateFormat", EnumDefault("ISO", "ISO", "UNIX")), ("SerializeDefaultValues", B()), ("Description", T(""))),
        ["IJSONDeserializeNode"] = S(false, true, false, ("JSONString", E()), ("DataType", D()), ("DateFormat", EnumDefault("ISO", "ISO", "UNIX")), ("Description", T(""))),
        ["IJavaScriptNode"] = S(false, true, true, ("JavaScript", T()), ("Description", T(""))),
        ["IExcelToRecordListNode"] = S(false, true, false, ("FileContent", E()), ("SheetName", E()), ("DataType", D()), ("Description", T(""))),
        ["IRecordListToExcelNode"] = S(false, true, false, ("RecordList", E()), ("AttributeSelection", new("strings")), ("Description", T(""))),
        ["IMessageNode"] = S(false, false, false, ("Message", E()), ("Type", Enum("Info", "Success", "Warning", "Error"))),
        ["IDownloadNode"] = S(true, false, false, ("FileContent", E()), ("FileName", E()), ("MimeType", E()), ("SaveToDisk", B())),
        ["IDestinationNode"] = S(true, false, true, ("Destination", R()), ("Transition", EnumDefault("Inherited", "Inherited", "UseHistory", "None", "Fade", "SlideFromLeft", "SlideFromRight", "SlideFromBottom", "SlideFromTop"))),
        ["IRefreshDataNode"] = S(false, false, true, ("DataSource", R()), ("MaxRecords", new("expression", Default: MaxRecordsOfSource)), ("StartIndex", new("expression", Default: ""))),
        ["IAjaxRefreshNode"] = S(false, false, false, ("WidgetOrWebBlock", R()), ("RowNumber", E()), ("AnimationEffect", Enum("None", "Highlight", "Fade", "VerticalSlide"))),
        ["ISendEmailNode"] = S(false, true, true, ("Email", R()), ("To", E()), ("From", E()), ("Cc", E()), ("Bcc", E()), ("LogContent", B())),
        ["IAttachFileNode"] = S(false, true, false, ("FileContent", E()), ("FileName", E()), ("MimeType", E())),
        ["ITriggerNode"] = S(false, true, true, ("Event", R()), ("Description", T("")))
    }.Where(pair => pair.Key != "ICallAgentNode" || MessageExpectations.Lane == "odc")
        .ToDictionary(pair => pair.Key, pair => pair.Value);
    public static Shape Get(JsonObject step) => Shapes.TryGetValue(step["node"]?.ToString() ?? "", out var shape) ? shape
        : throw new ArgumentException("logic node must be one of: " + string.Join(", ", Shapes.Keys));
    public static JsonObject Values(JsonObject step)
    {
        var shape = Get(step); var values = step["properties"]?.DeepClone().AsObject() ?? new JsonObject();
        foreach (var key in values.Select(p => p.Key)) if (!shape.Fields.ContainsKey(key))
            throw new ArgumentException($"Unknown logic node property: {key}; {step["node"]} properties: {Describe(shape)}");
        foreach (var (key, field) in shape.Fields)
        {
            if (!values.ContainsKey(key) && field.Default != null) values[key] = field.Default;
            var value = values[key] ?? throw new ArgumentException($"{step["node"]} requires property {key}; properties: {Describe(shape)}");
            if (field.Kind == "strings")
            {
                if (value is not JsonArray array || array.Any(v => v is not JsonValue s || !s.TryGetValue<string>(out _))) throw new ArgumentException(key + " requires a string array");
                if (array.Select(v => v!.ToString()).Distinct(StringComparer.Ordinal).Count() != array.Count) throw new ArgumentException(key + " contains duplicates");
            }
            else if (field.Kind == "boolean") { if (value is not JsonValue b || !b.TryGetValue<bool>(out _)) throw new ArgumentException(key + " requires a boolean"); }
            else
            {
                if (value is not JsonValue s || !s.TryGetValue<string>(out var text)) throw new ArgumentException(key + " requires text");
                if (field.Kind == "enum" && !field.Values!.Contains(text, StringComparer.Ordinal))
                    throw new ArgumentException($"{step["node"]} {key} must be one of: {string.Join(", ", field.Values!)}" + (field.Default != null ? $" (omit it for {field.Default})" : ""));
                // DataSource also takes the alias of a screen aggregate or data action created earlier in the same job.
                if (field.Kind == "reference" && !System.Text.RegularExpressions.Regex.IsMatch(text, @"^I[A-Za-z0-9_]+:[A-Za-z][A-Za-z0-9_]*(?:/[A-Za-z][A-Za-z0-9_]*)*$")
                    && !(key == "DataSource" && System.Text.RegularExpressions.Regex.IsMatch(text, @"^\$[A-Za-z_][A-Za-z0-9_.]*$")))
                    throw new ArgumentException($"{step["node"]} {key} requires a named model reference (\"IScreenAggregate:GetOrders\", \"IMobileScreen:Home\")"
                        + (key == "DataSource" ? " or the $alias of a source created earlier in the job" : "") + "; keys are not accepted here");
            }
        }
        if (step["node"]!.ToString() == "IRefreshDataNode" && values["StartIndex"]!.ToString() != "")
            throw new ArgumentException("Refresh Data StartIndex is not preserved by native merge; bind pagination on the source aggregate instead");
        if (!shape.Arguments && step.ContainsKey("args")) throw new ArgumentException("This node has no arguments");
        if (step["node"]!.ToString() != "IJavaScriptNode" && (step.ContainsKey("inputs") || step.ContainsKey("outputs"))) throw new ArgumentException("Only JavaScript nodes declare parameters");
        return values;
    }
    /// <summary>The accepted properties of a node, as a refusal shows them: name (kind; values; default when optional).</summary>
    private static string Describe(Shape shape) => string.Join(", ", shape.Fields.Select(f => f.Key + " (" + f.Value.Kind
        + (f.Value.Values is { } values ? ": " + string.Join("|", values) : "")
        + (f.Value.Default == null ? "" : f.Value.Default.Length == 0 ? ", optional" : ", optional, default " + f.Value.Default) + ")"));

    public static JsonObject Schema() => new(Shapes.Select(pair => KeyValuePair.Create(pair.Key,
        (JsonNode?)new JsonObject { ["terminal"] = pair.Value.Terminal, ["arguments"] = pair.Value.Arguments,
            ["properties"] = System.Text.Json.JsonSerializer.SerializeToNode(pair.Value.Fields) })));
}
