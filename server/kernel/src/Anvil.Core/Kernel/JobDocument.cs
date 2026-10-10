using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// C24 of the atritos 3 package (D3): the job reader never leaks a raw System.Text.Json exception. A job document is an
/// object {ops:[...]} or an array of ops (Read normalizes the array to {ops:[...]} for the readers that want an object:
/// ModuleSpecification.SourceDocument, JobProvenance); a field of the wrong JSON type (an object where text is expected,
/// "true" where a boolean is, an array where an object is) is a JSON_SHAPE problem with its JSON pointer, the shape the
/// grammar expects and, when the conversion is unambiguous, the RFC 6902 patch that writes it. The table below is the
/// shape of the verb fields and of the spec and logic grammars; closed keys and values stay the business of each grammar.
/// Pure: no model, no I/O beyond reading the file.
/// </summary>
public static class JobDocument
{
    public const string ShapeCode = "JSON_SHAPE";

    public sealed record Shape(string? Pointer, string Message, string Fix, JsonArray? Patch = null);

    /// <summary>The job document as written (object or array).</summary>
    public static JsonNode Parse(string path)
        => JsonNode.Parse(File.ReadAllText(path)) ?? throw new ArgumentException($"{path}: the job is empty (null); write {{\"ops\":[...]}} or an array of ops");

    /// <summary>The job as an object: an array of ops is {ops:[...]} (D3: the O11 readers took only the object form).</summary>
    public static JsonObject Read(string path) => Normalize(Parse(path), path);

    public static JsonObject Normalize(JsonNode node, string? path = null) => node switch
    {
        JsonObject o => o,
        JsonArray a => new JsonObject { ["ops"] = a.DeepClone() },
        _ => throw new KernelRefusalException(ShapeCode, $"{path ?? "job"}: a job is an object {{\"ops\":[...]}} or an array of ops, not {Kind(node)}",
            new JsonArray(JobPreflight.PublicProblem(JobPreflight.Problem(null, "", ShapeCode, "error", $"a job is an object {{\"ops\":[...]}} or an array of ops, not {Kind(node)}",
                "write {\"ops\":[{\"op\":\"...\"}]}")))),
    };

    /// <summary>A raw System.Text.Json cast or conversion of a node (never a syntax error of the document, which is a
    /// JsonException): the kind of exception that must become a JSON_SHAPE problem.</summary>
    public static bool IsShapeError(Exception ex)
    {
        for (var e = ex; e != null; e = e.InnerException)
            if (e is InvalidOperationException or FormatException && e is not JsonException && e.Source == "System.Text.Json") return true;
        return false;
    }

    /// <summary>What a raw cast expected, in the grammar's words (never its own text).</summary>
    public static string Describe(Exception ex)
    {
        for (var e = ex; e != null; e = e.InnerException)
        {
            if (e.Source != "System.Text.Json") continue;
            if (e.Message.Contains("'JsonObject'", StringComparison.Ordinal)) return "an object {...} was expected";
            if (e.Message.Contains("'JsonArray'", StringComparison.Ordinal)) return "an array [...] was expected";
            if (e.Message.Contains("'JsonValue'", StringComparison.Ordinal)) return "a text, number or boolean was expected";
        }
        return "a value of another JSON type was expected";
    }

    // ---- the shape table -----------------------------------------------------------------------------------------------

    private enum K { Text, Bool, Number, Object, Array, TextOrArray, TextOrNumber, TextOrObject, Scalar, Any }

    private sealed record Field(K Kind, Dictionary<string, Field>? Members = null, Field? Item = null, Field? Values = null);

    private static Field Text => new(K.Text);
    private static Field Bool => new(K.Bool);
    private static Field Number => new(K.Number);
    private static Field Any => new(K.Any);
    private static Field Obj(Dictionary<string, Field>? members = null, Field? values = null) => new(K.Object, members, null, values);
    private static Field List(Field item) => new(K.Array, null, item);

    private static readonly Dictionary<string, Field> Parameter = new()
    {
        ["name"] = Text, ["type"] = Text, ["mandatory"] = Bool, ["default"] = Text, ["description"] = Text, ["in"] = Text,
    };

    private static readonly Dictionary<string, Field> Step = BuildStep();

    private static Dictionary<string, Field> BuildStep()
    {
        var step = new Dictionary<string, Field>();
        var steps = List(Obj(step));
        foreach (var key in new[] { "get", "as", "label", "statement", "call", "save", "create", "update", "delete", "id", "if", "foreach", "while", "raise", "message", "node" })
            step[key] = Text;
        step["where"] = new(K.TextOrArray, Item: Text);
        step["sort"] = new(K.TextOrArray, Item: Any);
        step["sources"] = new(K.TextOrArray, Item: Text);
        step["max"] = new(K.TextOrNumber); step["start"] = new(K.TextOrNumber);
        step["sql"] = Bool; step["break"] = Bool; step["continue"] = Bool; step["return"] = Bool;
        step["params"] = Obj(values: Obj(new() { ["type"] = Text, ["value"] = Text }));
        step["joins"] = List(Obj(new() { ["left"] = Text, ["right"] = Text, ["kind"] = Text, ["condition"] = Text }));
        step["columns"] = List(Obj(new() { ["name"] = Text, ["attribute"] = Text, ["kind"] = Text }));
        step["calculated"] = List(Obj(new() { ["name"] = Text, ["value"] = Text }));
        step["assign"] = Obj(values: Text);
        step["args"] = Obj(values: Text);
        // C18: a record is a variable (text) or the values of the record's fields ({Field: expression}).
        step["record"] = new(K.TextOrObject, Values: Text);
        step["then"] = steps; step["else"] = steps; step["do"] = steps; step["next"] = steps; step["otherwise"] = steps;
        step["switch"] = List(Obj(new() { ["when"] = Text, ["steps"] = steps }));
        step["properties"] = Obj(values: Any);
        step["inputs"] = List(Obj(Parameter)); step["outputs"] = List(Obj(Parameter));
        return step;
    }

    private static readonly Field Logic = Obj(new()
    {
        ["actions"] = List(Obj(new()
        {
            ["name"] = Text, ["kind"] = Text, ["owner"] = Text, ["public"] = Bool, ["description"] = Text, ["function"] = Bool, ["replace"] = Bool,
            ["inputs"] = List(Obj(Parameter)), ["outputs"] = List(Obj(Parameter)), ["vars"] = List(Obj(Parameter)),
            ["steps"] = List(Obj(Step)),
            ["handlers"] = List(Obj(new() { ["name"] = Text, ["exception"] = Text, ["abortTransaction"] = Bool, ["logError"] = Bool, ["steps"] = List(Obj(Step)) })),
            ["comments"] = List(Obj(new() { ["text"] = Text, ["reminder"] = Bool })),
            ["fetch"] = Text, ["timeout"] = Number, ["http"] = Text, ["path"] = Text, ["access"] = Obj(values: Any),
        })),
    });

    private static readonly Dictionary<string, Field> Attribute = new()
    {
        ["name"] = Text, ["type"] = Text, ["mandatory"] = Bool, ["length"] = Number, ["description"] = Text, ["label"] = Text, ["deleteRule"] = Text,
        // C21: a default may be written as JSON (true, 3): the spec writes it as the literal the Studio stores.
        ["default"] = new(K.Scalar),
    };

    private static readonly Field Spec = Obj(new()
    {
        ["static"] = List(Obj(new()
        {
            ["name"] = Text, ["public"] = Bool, ["description"] = Text, ["attributes"] = List(Obj(Attribute)),
            ["records"] = List(Obj(new() { ["name"] = Text, ["id"] = Number, ["label"] = Text, ["order"] = Number }, values: Any)),
        })),
        ["entities"] = List(Obj(Entity())),
        ["clientEntities"] = List(Obj(Entity())),
        ["structures"] = List(Obj(new() { ["name"] = Text, ["public"] = Bool, ["description"] = Text, ["attributes"] = List(Obj(Attribute)) })),
    });

    private static Dictionary<string, Field> Entity() => new()
    {
        ["name"] = Text, ["public"] = Bool, ["readOnly"] = Bool, ["description"] = Text, ["label"] = Text, ["id"] = Bool, ["idType"] = Text,
        ["attributes"] = List(Obj(Attribute)), ["updateBehavior"] = Text,
        ["indexes"] = List(Obj(new() { ["name"] = Text, ["unique"] = Bool, ["attributes"] = List(Text) })),
    };

    private static readonly Dictionary<string, Field> Verb = new()
    {
        ["op"] = Text, ["target"] = Text, ["prop"] = Text, ["parent"] = Text, ["type"] = Text, ["name"] = Text, ["as"] = Text, ["source"] = Text,
        ["from"] = Text, ["to"] = Text, ["connector"] = Text, ["into"] = Text, ["before"] = Text, ["after"] = Text, ["file"] = Text, ["html"] = Text,
        ["producer"] = Text, ["scope"] = Text,
        ["empty"] = Bool, ["force"] = Bool, ["reconnect"] = Bool, ["first"] = Bool, ["last"] = Bool, ["includeInternal"] = Bool,
        ["x"] = Number, ["y"] = Number, ["max"] = Number, ["offset"] = Number, ["depth"] = Number,
        ["args"] = Obj(values: Any), ["elements"] = List(Text), ["breaks"] = List(Text),
    };

    /// <summary>Every field of an op whose JSON type the grammar does not take, each with its pointer (under
    /// <paramref name="pointer"/>, the op's; null in a composite job), the expected shape and a patch when the conversion is
    /// unambiguous. Empty when the shape is right (the values are still each grammar's to judge).</summary>
    public static List<Shape> OpShape(JsonObject op, string? pointer)
    {
        var found = new List<Shape>();
        var kind = op["op"] is JsonValue v && v.TryGetValue<string>(out var verb) ? verb : null;
        foreach (var (key, value) in op)
        {
            if (key.StartsWith('_')) continue;
            if (key == "data")
            {
                // The compact languages: spec and logic have a closed shape here; the others an object (their grammar reads it).
                var shape = kind switch { "spec" => Spec, "logic" => Logic, "screen" or "html" or "rest" or "rest-expose" or "soap" => Obj(values: Any), _ => Any };
                Walk(value, shape, At(pointer, key), key, found);
                continue;
            }
            if (Verb.TryGetValue(key, out var field)) Walk(value, field, At(pointer, key), key, found);
        }
        return found;
    }

    private static string? At(string? pointer, string key) => pointer == null ? null : pointer + "/" + key.Replace("~", "~0", StringComparison.Ordinal).Replace("/", "~1", StringComparison.Ordinal);

    private static void Walk(JsonNode? node, Field field, string? pointer, string key, List<Shape> found)
    {
        if (node == null || field.Kind == K.Any) return;
        switch (field.Kind)
        {
            case K.Text:
                if (node is JsonValue t && t.TryGetValue<string>(out _)) return;
                Wrong(node, "text", pointer, key, found, Scalar(node) is { } text ? JsonValue.Create(text) : null);
                return;
            case K.Bool:
                if (node is JsonValue b && b.TryGetValue<bool>(out _)) return;
                Wrong(node, "true or false", pointer, key, found, node is JsonValue s && s.TryGetValue<string>(out var word) && bool.TryParse(word.Trim(), out var flag) ? JsonValue.Create(flag) : null);
                return;
            case K.Number:
                if (node is JsonValue n && (n.TryGetValue<int>(out _) || n.TryGetValue<long>(out _) || n.TryGetValue<double>(out _))) return;
                Wrong(node, "a number", pointer, key, found, node is JsonValue ns && ns.TryGetValue<string>(out var digits)
                    && long.TryParse(digits.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var number) ? JsonValue.Create(number) : null);
                return;
            case K.Scalar:
                if (node is JsonValue) return;
                Wrong(node, "text, a number or a boolean", pointer, key, found, null);
                return;
            case K.TextOrNumber:
                if (node is JsonValue) { if (node is JsonValue x && x.TryGetValue<bool>(out _)) Wrong(node, "text or a number", pointer, key, found, null); return; }
                Wrong(node, "text or a number", pointer, key, found, null);
                return;
            case K.TextOrArray:
                if (node is JsonValue ta && ta.TryGetValue<string>(out _)) return;
                if (node is JsonArray items) { Items(items, field.Item!, pointer, key, found); return; }
                Wrong(node, "text or an array of texts", pointer, key, found, null);
                return;
            case K.TextOrObject:
                if (node is JsonValue to && to.TryGetValue<string>(out _)) return;
                if (node is JsonObject members) { Members(members, field, pointer, found); return; }
                Wrong(node, "text (a variable) or an object {\"Field\": \"expression\"}", pointer, key, found, null);
                return;
            case K.Array:
                if (node is JsonArray array) { Items(array, field.Item!, pointer, key, found); return; }
                // One object where a list is expected is the list of one (the patch writes it).
                Wrong(node, "an array [...]", pointer, key, found, node is JsonObject single ? new JsonArray(single.DeepClone()) : null);
                return;
            case K.Object:
                if (node is JsonObject obj) { Members(obj, field, pointer, found); return; }
                Wrong(node, "an object {...}", pointer, key, found, null);
                return;
        }
    }

    private static void Items(JsonArray items, Field item, string? pointer, string key, List<Shape> found)
    {
        for (var i = 0; i < items.Count; i++) Walk(items[i], item, pointer == null ? null : pointer + "/" + i, key, found);
    }

    private static void Members(JsonObject obj, Field field, string? pointer, List<Shape> found)
    {
        foreach (var (name, value) in obj)
        {
            if (field.Members != null && field.Members.TryGetValue(name, out var member)) Walk(value, member, At(pointer, name), name, found);
            else if (field.Values != null) Walk(value, field.Values, At(pointer, name), name, found);
        }
    }

    private static void Wrong(JsonNode node, string expected, string? pointer, string key, List<Shape> found, JsonNode? replacement)
    {
        var patch = replacement != null && pointer != null ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = replacement }) : null;
        found.Add(new(pointer, $"'{key}' must be {expected}, not {Kind(node)}",
            replacement != null ? $"write '{key}' as {replacement.ToJsonString()}" : $"write '{key}' as {expected}", patch));
    }

    /// <summary>The text of a number or boolean (what a text field takes for it); null for objects and arrays.</summary>
    private static string? Scalar(JsonNode node)
    {
        if (node is not JsonValue v) return null;
        if (v.TryGetValue<bool>(out var b)) return b ? "True" : "False";
        if (v.TryGetValue<long>(out var l)) return l.ToString(CultureInfo.InvariantCulture);
        if (v.TryGetValue<double>(out var d)) return d.ToString(CultureInfo.InvariantCulture);
        return null;
    }

    private static string Kind(JsonNode? node) => node switch
    {
        null => "null",
        JsonObject => "an object",
        JsonArray => "an array",
        JsonValue v when v.TryGetValue<string>(out _) => "text",
        JsonValue v when v.TryGetValue<bool>(out _) => "a boolean",
        _ => "a number",
    };
}
