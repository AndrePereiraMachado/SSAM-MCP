using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>A value of the capture that the compiler cannot express with the closed tables (2.8, 3.4). The caller keeps the
/// literal of the canonical rendering and reports it (unevaluable), never guesses.</summary>
public sealed class PrototypeExpressionException(string message) : Exception(message);

/// <summary>
/// Where a capture value (Val, Pred, Expr of docs/PROTOTIPO-NATIVO.md 2.10) is read: each resolver answers the OutSystems text
/// of one kind of value in the place the expression goes (a widget of a list row, an aggregate filter, a screen action, a server
/// action, a block). A resolver left null means that kind of value does not exist there.
/// </summary>
public sealed class PrototypeScope
{
    public Func<string, string?, string>? Field { get; init; }
    public Func<string, string?, string?>? FieldType { get; init; }
    public Func<string, string>? Dim { get; init; }
    public Func<string, string>? Param { get; init; }
    public Func<string, string>? Control { get; init; }
    public Func<string, string>? Input { get; init; }
    public Func<string, string, string?, string>? Record { get; init; }
    /// <summary>The type of a field of a named record (a view record, a popup record), as FieldType for the current one.</summary>
    public Func<string, string, string?, string?>? RecordType { get; init; }
    public Func<string, string>? Count { get; init; }
    public Func<string, JsonNode, string>? Sum { get; init; }
    public Func<string, string>? Inserted { get; init; }
    public Func<string, string>? Existing { get; init; }
    public Func<string, string>? Updated { get; init; }
    public Func<string, string>? Local { get; init; }
    public Func<JsonObject, PrototypeScope, string>? First { get; init; }
    /// <summary>The view key when the expression is on a screen (Val view / input View is then a literal).</summary>
    public string? View { get; init; }
    public Func<string, string?>? DimType { get; init; }
    public Func<string, string?>? ControlType { get; init; }
    public Func<string, string?>? ParamType { get; init; }
    /// <summary>The type of a field of a record input of a block (the shell's UsuarioAtual.Name).</summary>
    public Func<string, string, string?>? InputFieldType { get; init; }

    public PrototypeScope With(Func<string, string?, string>? field = null, Func<string, string?, string?>? fieldType = null)
        => new()
        {
            Field = field ?? Field, FieldType = fieldType ?? FieldType, Dim = Dim, Param = Param, Control = Control, Input = Input, Record = Record, RecordType = RecordType,
            Count = Count, Sum = Sum, Inserted = Inserted, Existing = Existing, Updated = Updated, Local = Local, First = First, View = View,
            DimType = DimType, ControlType = ControlType, ParamType = ParamType, InputFieldType = InputFieldType,
        };
}

/// <summary>
/// The capture values as OutSystems expressions: the closed predicate grammar and format table of 2.8, the same text on O11
/// and ODC. Literals are typed (text quoted with "", decimals with '.', booleans True/False); every function used is in the
/// catalog of both Studios (IntegerToText, FormatDecimal, FormatDateTime, FormatText, Substr, Index, Length, ToLower, If,
/// CurrDateTime, Month, Year, Max, Min).
/// </summary>
public static class PrototypeExpr
{
    public static string Quote(string text) => "\"" + text.Replace("\"", "\"\"").Replace("\r", "").Replace("\n", "\" + NewLine() + \"") + "\"";

    /// <summary>A JSON literal as the OutSystems literal of <paramref name="type"/> (Text, Integer, Decimal, Boolean, DateTime).</summary>
    public static string Literal(JsonNode? value, string? type = null)
    {
        if (value == null) return type switch { "Integer" or "Decimal" => "0", "Boolean" => "False", "DateTime" => "NullDate()", _ => "\"\"" };
        if (value is not JsonValue v) throw new PrototypeExpressionException("a literal is a JSON scalar, got " + value.ToJsonString());
        if (v.TryGetValue<bool>(out var b)) return b ? "True" : "False";
        if (type == "Identifier") type = "Integer";
        if (v.TryGetValue<string>(out var s))
        {
            if (type is "Integer" && long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var si)) return si.ToString(CultureInfo.InvariantCulture);
            if (type is "Decimal" && decimal.TryParse(s, NumberStyles.Number, CultureInfo.InvariantCulture, out var sd)) return sd.ToString(CultureInfo.InvariantCulture);
            if (type is "Boolean" && bool.TryParse(s, out var sb)) return sb ? "True" : "False";
            if (type is "DateTime" && DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var dt))
                return "#" + dt.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "#";
            return Quote(s);
        }
        var raw = v.ToJsonString();
        if (decimal.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var d))
        {
            if (type == "Text") return Quote(raw);
            return d.ToString(CultureInfo.InvariantCulture);
        }
        throw new PrototypeExpressionException("unsupported literal " + raw);
    }

    public static string TypeOfLiteral(JsonNode? value)
    {
        if (value is not JsonValue v) return "Text";
        if (v.TryGetValue<bool>(out _)) return "Boolean";
        if (v.TryGetValue<string>(out _)) return "Text";
        var raw = v.ToJsonString();
        return long.TryParse(raw, out _) ? "Integer" : "Decimal";
    }

    /// <summary>The OutSystems type of a value (Text, Integer, Decimal, Boolean, DateTime, Identifier for any entity
    /// identifier), when the scope knows it.</summary>
    public static string? TypeOf(JsonNode? val, PrototypeScope scope)
    {
        var type = RawTypeOf(val, scope);
        return type != null && type.EndsWith(" Identifier", StringComparison.Ordinal) ? "Identifier" : type;
    }

    private static string? RawTypeOf(JsonNode? val, PrototypeScope scope)
    {
        if (val is not JsonObject o) return null;
        if (o.ContainsKey("lit")) return TypeOfLiteral(o["lit"]);
        if (o["input"]?.ToString() is { } recordInput && o["field"]?.ToString() is { } inputField) return scope.InputFieldType?.Invoke(recordInput, inputField);
        if (o["field"]?.ToString() is { } f)
            return o["record"]?.ToString() is { } record ? scope.RecordType?.Invoke(record, f, o["via"]?.ToString()) : scope.FieldType?.Invoke(f, o["via"]?.ToString());
        if (o["dim"]?.ToString() is { } dk) return scope.DimType?.Invoke(dk);
        if (o["control"]?.ToString() is { } c) return scope.ControlType?.Invoke(c);
        if (o["param"]?.ToString() is { } p) return scope.ParamType?.Invoke(p);
        if (o.ContainsKey("count")) return "Integer";
        if (o.ContainsKey("clock")) return "DateTime";
        if (o.ContainsKey("not")) return "Boolean";
        if (o["input"]?.ToString() is "View" or "Aviso") return "Text";
        if (o["input"]?.ToString() is "AvisoErro") return "Boolean";
        if (o["mul"] is JsonArray || o["add"] is JsonArray) return "Decimal";
        return null;
    }

    /// <summary>A Val as an expression.</summary>
    public static string Val(JsonNode? val, PrototypeScope scope)
    {
        if (val is not JsonObject o) throw new PrototypeExpressionException("a value is an object, got " + (val?.ToJsonString() ?? "null"));
        if (o.ContainsKey("lit")) return Literal(o["lit"]);
        // a field of a record input of the block (the shell shows the current user's name: UsuarioAtual.Name)
        if (o["input"]?.ToString() is { } recordInput && o["field"]?.ToString() is { } inputField)
            return (scope.Input ?? throw Missing("block input " + recordInput))(recordInput) + "." + inputField;
        if (o["field"]?.ToString() is { } field)
        {
            var via = o["via"]?.ToString();
            if (o["record"]?.ToString() is { } record)
                return (scope.Record ?? throw Missing("record " + record))(record, field, via);
            return (scope.Field ?? throw Missing("field " + field))(field, via);
        }
        if (o["dim"]?.ToString() is { } dim) return (scope.Dim ?? throw Missing("dimension " + dim))(dim);
        if (o["param"]?.ToString() is { } param) return (scope.Param ?? throw Missing("parameter " + param))(param);
        if (o["control"]?.ToString() is { } control) return (scope.Control ?? throw Missing("control " + control))(control);
        if (o["input"]?.ToString() is { } input)
        {
            if (input == "View" && scope.View != null) return Quote(scope.View);
            return (scope.Input ?? throw Missing("block input " + input))(input);
        }
        if (o["view"] is JsonValue) return scope.View != null ? Quote(scope.View) : (scope.Input ?? throw Missing("the view"))("View");
        if (o["local"]?.ToString() is { } local) return (scope.Local ?? (n => n))(local);
        if (o["count"] is JsonObject count) return (scope.Count ?? throw Missing("count"))(count["list"]?.ToString() ?? throw new PrototypeExpressionException("count names its list"));
        if (o["sum"] is JsonObject sum) return (scope.Sum ?? throw Missing("sum"))(sum["list"]?.ToString() ?? "", sum);
        if (o["inserted"]?.ToString() is { } inserted) return (scope.Inserted ?? throw Missing("inserted key of " + inserted))(inserted);
        if (o["existing"]?.ToString() is { } existing) return (scope.Existing ?? throw Missing("existing " + existing))(existing);
        if (o["updated"]?.ToString() is { } updated) return (scope.Updated ?? throw Missing("updated " + updated))(updated);
        if (o["clock"] is JsonValue) return "CurrDateTime()";
        if (o["not"] is JsonNode n) return "not (" + Val(n, scope) + ")";
        if (o["mul"] is JsonArray mul) return string.Join(" * ", mul.Select(x => Paren(Val(x, scope))));
        if (o["add"] is JsonArray add) return string.Join(" + ", add.Select(x => Paren(Val(x, scope))));
        if (o["first"] is JsonObject first) return (scope.First ?? throw Missing("first option"))(first, scope);
        throw new PrototypeExpressionException("unsupported value " + o.ToJsonString());
    }

    private static PrototypeExpressionException Missing(string what) => new(what + " has no meaning here");

    private static string Paren(string text) => text.All(ch => char.IsLetterOrDigit(ch) || ch is '.' or '_' or '"') ? text : "(" + text + ")";

    /// <summary>A predicate as a Boolean expression.</summary>
    public static string Pred(JsonNode? pred, PrototypeScope scope)
    {
        if (pred is not JsonObject p) throw new PrototypeExpressionException("a predicate is an object");
        var op = p["op"]?.ToString();
        string Side(string key) => Val(p[key], scope);
        string Typed(string key, string other)
        {
            // a literal compared with a typed value takes that type ("1" against an Integer dimension is 1)
            if (p[key] is JsonObject o && o.ContainsKey("lit") && TypeOf(p[other], scope) is { } t) return Literal(o["lit"], t);
            return Side(key);
        }
        // an identifier compared with anything else is compared as its integer (IdentifierToInteger)
        string Compared(string key, string other)
        {
            var text = Typed(key, other);
            return TypeOf(p[key], scope) == "Identifier" && TypeOf(p[other], scope) != "Identifier" ? $"IdentifierToInteger({text})" : text;
        }
        switch (op)
        {
            case "truthy":
            {
                var type = TypeOf(p["l"], scope);
                var text = Side("l");
                return type switch { "Integer" or "Decimal" => $"{Paren(text)} <> 0", "Text" => $"{Paren(text)} <> \"\"", _ => text };
            }
            case "not": return "not (" + Pred(p["a"]?[0], scope) + ")";
            case "eq": return $"{Paren(Compared("l", "r"))} = {Paren(Compared("r", "l"))}";
            case "ne": return $"{Paren(Compared("l", "r"))} <> {Paren(Compared("r", "l"))}";
            case "gt": return $"{Paren(Compared("l", "r"))} > {Paren(Compared("r", "l"))}";
            case "ge": return $"{Paren(Compared("l", "r"))} >= {Paren(Compared("r", "l"))}";
            case "lt": return $"{Paren(Compared("l", "r"))} < {Paren(Compared("r", "l"))}";
            case "le": return $"{Paren(Compared("l", "r"))} <= {Paren(Compared("r", "l"))}";
            case "len-ge": return $"Length({Side("l")}) >= {Side("r")}";
            case "len-le": return $"Length({Side("l")}) <= {Side("r")}";
            case "len-gt": return $"Length({Side("l")}) > {Side("r")}";
            case "len-lt": return $"Length({Side("l")}) < {Side("r")}";
            case "in":
            {
                var left = Side("l");
                var values = p["r"]?["values"] as JsonArray ?? throw new PrototypeExpressionException("in lists its values in r.values");
                return "(" + string.Join(" or ", values.Select(v => $"{Paren(left)} = {Literal(v, TypeOf(p["l"], scope))}")) + ")";
            }
            case "contains":
            {
                // the search of the prototype ignores case (and accents, an approximation recorded in outOfScope)
                var term = Side("l");
                var fields = p["r"]?["fields"] as JsonArray ?? throw new PrototypeExpressionException("contains lists the fields in r.fields");
                var tests = fields.Select(f => $"Index(ToLower({(scope.Field ?? throw Missing("field"))(f!.ToString(), null)}), ToLower({term})) <> -1");
                return $"({Paren(term)} = \"\" or " + string.Join(" or ", tests) + ")";
            }
            case "and": return string.Join(" and ", (p["a"] as JsonArray ?? []).Select(x => "(" + Pred(x, scope) + ")"));
            case "or": return "(" + string.Join(" or ", (p["a"] as JsonArray ?? []).Select(x => "(" + Pred(x, scope) + ")")) + ")";
            default: throw new PrototypeExpressionException($"predicate op '{op}' is not in the grammar");
        }
    }

    /// <summary>An Expr (2.8 format table) as a Text expression.</summary>
    public static string Expr(JsonNode? expr, PrototypeScope scope)
    {
        if (expr is not JsonObject e) throw new PrototypeExpressionException("an expression is an object");
        var fmt = e["fmt"]?.ToString() ?? "text";
        string core;
        if (fmt == "cases")
        {
            var cases = e["cases"] as JsonArray ?? throw new PrototypeExpressionException("cases lists its cases");
            var otherwise = e["else"] is JsonObject el ? Expr(el, scope) : "\"\"";
            core = otherwise;
            foreach (var c in cases.Reverse())
                core = $"If({Pred(c!["when"], scope)}, {Expr(c["then"], scope)}, {core})";
        }
        else if (fmt == "concat")
            core = string.Join(" + ", (e["parts"] as JsonArray ?? []).Select(x => Paren(Expr(x, scope))));
        else
        {
            var value = Val(e["value"], scope);
            var type = TypeOf(e["value"], scope);
            core = Format(fmt, value, type, e);
        }
        var prefix = e["prefix"]?.ToString() ?? "";
        var suffix = e["suffix"]?.ToString() ?? "";
        if (prefix.Length > 0) core = Quote(prefix) + " + " + Paren(core);
        if (suffix.Length > 0) core = (prefix.Length > 0 ? core : Paren(core)) + " + " + Quote(suffix);
        return core;
    }

    private static readonly string[] PtMonths = ["jan.", "fev.", "mar.", "abr.", "mai.", "jun.", "jul.", "ago.", "set.", "out.", "nov.", "dez."];

    private static string Format(string fmt, string v, string? type, JsonObject e)
    {
        var parts = fmt.Split(':', 3);
        switch (parts[0])
        {
            case "text":
                return type switch { "Identifier" => $"IntegerToText(IdentifierToInteger({v}))", "Integer" => $"IntegerToText({v})", "Decimal" => $"DecimalToText({v})", "Boolean" => $"If({v}, \"true\", \"false\")", "DateTime" => $"DateTimeToText({v})", _ => v };
            case "integer": return type == "Text" ? v : type == "Identifier" ? $"IntegerToText(IdentifierToInteger({v}))" : $"IntegerToText({v})";
            case "decimal":
            {
                var digits = parts.Length > 1 ? parts[1] : "2";
                var (thousands, dec) = Separators(parts.Length > 2 ? parts[2] : "en-US");
                return $"FormatDecimal({v}, {digits}, {Quote(thousands)}, {Quote(dec)})";
            }
            case "currency":
            {
                var locale = parts.Length > 1 ? parts[1] : "en-US";
                var code = parts.Length > 2 ? parts[2] : "USD";
                var (thousands, dec) = Separators(locale);
                var number = $"FormatDecimal({v}, 2, {Quote(thousands)}, {Quote(dec)})";
                return (locale, code) switch
                {
                    ("pt-BR", "BRL") => Quote("R$ ") + " + " + number,
                    (_, "USD") => Quote("$") + " + " + number,
                    (_, "EUR") when locale.StartsWith("en", StringComparison.Ordinal) => Quote("€") + " + " + number,
                    (_, "EUR") => number + " + " + Quote(" €"),
                    _ => Quote(code + " ") + " + " + number,
                };
            }
            case "date":
            {
                var locale = parts.Length > 1 ? parts[1] : "en-US";
                var options = parts.Length > 2 ? parts[2] : "";
                if (locale == "pt-BR" && options.Contains("\"month\":\"short\"") && options.Contains("\"day\":\"2-digit\"") && options.Contains("\"year\":\"numeric\""))
                    return $"FormatDateTime({v}, \"dd\") + \" de \" + Substr({Quote(string.Concat(PtMonths))}, (Month({v}) - 1) * 4, 4) + \" de \" + IntegerToText(Year({v}))";
                if (locale == "pt-BR") return $"FormatDateTime({v}, \"dd/MM/yyyy\")";
                return $"FormatDateTime({v}, \"MM/dd/yyyy\")";
            }
            case "time": return $"FormatDateTime({v}, \"HH:mm\")";
            case "pad":
            {
                var n = parts.Length > 1 ? parts[1] : "2";
                var c = parts.Length > 2 ? parts[2] : "0";
                return $"FormatText({(type == "Text" ? v : type == "Identifier" ? $"IntegerToText(IdentifierToInteger({v}))" : $"IntegerToText({v})")}, {n}, {n}, True, {Quote(c)})";
            }
            case "substr-after":
            {
                var sep = fmt["substr-after:".Length..];
                return $"Substr({v}, Index({v}, {Quote(sep)}) + {sep.Length}, Length({v}))";
            }
            case "substr-before":
            {
                var sep = fmt["substr-before:".Length..];
                return $"Substr({v}, 0, Index({v}, {Quote(sep)}))";
            }
            case "count": return type == "Text" ? v : $"IntegerToText({v})";
            case "sum": return $"DecimalToText({v})";
            default: throw new PrototypeExpressionException($"format '{fmt}' is not in the table of 2.8");
        }
    }

    private static (string Thousands, string Decimal) Separators(string locale) => locale switch
    {
        "pt-BR" or "pt-PT" or "de-DE" or "es-ES" or "it-IT" => (".", ","),
        "fr-FR" => (" ", ","),
        _ => (",", "."),
    };
}

/// <summary>
/// The data of a capture as native elements (3.4): a static entity for each collection no compiled effect writes (records from
/// the store), a regular entity with Integer Id without AutoNumber for each mutated one (the prototype keys show on screen and the
/// seed writes them after publication), the options entities of the selects, and the Client Variables of the global
/// dimensions. Emitted as the existing verbs (create/set), in an order where every identifier type exists before a field uses
/// it; on a reimport the marked elements are updated in place (same keys).
/// </summary>
public sealed class PrototypeDataModel
{
    public sealed record Field(string Name, string Type, int? Length, string? References);
    public sealed record Entity(string Collection, string Name, bool Static, IReadOnlyList<Field> Fields, JsonArray Rows, string Key);
    public sealed record OptionsEntity(string Name, string ValueType, bool ByKey, string? KeyType, IReadOnlyList<(JsonNode? Key, string Value, string Label, int Order)> Rows, string Control);
    public sealed record ClientVariable(string Dimension, string Name, string Type, string Default);

    public List<Entity> Entities { get; } = [];
    public List<OptionsEntity> Options { get; } = [];
    public List<ClientVariable> ClientVariables { get; } = [];

    public Entity? ByCollection(string collection) => Entities.FirstOrDefault(e => e.Collection == collection);

    public static string NativeType(string type) => type switch { "DateTime" => "Date Time", _ => type };

    /// <summary>The OutSystems type of a collection field: its own type, or "&lt;Entity&gt; Identifier" for a foreign key.</summary>
    public string FieldDataType(Entity entity, Field field)
        => field.References is { } target && ByCollection(target) is { } referenced ? referenced.Name + " Identifier" : field.Name == entity.Key ? "Integer" : NativeType(field.Type);

    public static string FieldLiteral(Field field, JsonNode? value) => PrototypeExpr.Literal(value, field.Type == "DateTime" ? "DateTime" : field.Type);

    /// <summary>The record Identifier of a static row: the first text field in PascalCase, else R&lt;id&gt;; unique in the entity.</summary>
    public static string RecordName(Entity entity, JsonObject row, HashSet<string> taken)
    {
        var text = entity.Fields.Where(f => f.Type == "Text" && f.Name != entity.Key).Select(f => row[f.Name]?.ToString()).FirstOrDefault(t => !string.IsNullOrWhiteSpace(t));
        var name = text != null ? PrototypeNames.Pascal(text) : "R" + row[entity.Key];
        if (name.Length > 50) name = name[..50];
        var candidate = name;
        for (var n = 2; !taken.Add(candidate); n++) candidate = name + n;
        return candidate;
    }

    public static string RecordLabel(Entity entity, JsonObject row)
    {
        if (entity.Fields.Any(f => f.Name == "Label") && row["Label"]?.ToString() is { } label) return label;
        return entity.Fields.Where(f => f.Type == "Text" && f.Name != entity.Key).Select(f => row[f.Name]?.ToString()).FirstOrDefault(t => !string.IsNullOrEmpty(t)) ?? row[entity.Key]?.ToString() ?? "";
    }
}
