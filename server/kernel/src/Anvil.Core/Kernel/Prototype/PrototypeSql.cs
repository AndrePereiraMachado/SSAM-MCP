using System.Text;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// The set effects of a capture (insertFrom, updateFrom, removeWhere; docs/PROTOTIPO-NATIVO.md 3.4) as ONE parameterized Advanced
/// SQL each, written only in the forms that run on SQL Server (O11) and PostgreSQL (ODC): INSERT ... SELECT with the new keys
/// COALESCE(MAX(Id), 0) + ROW_NUMBER() OVER (ORDER BY the source key), UPDATE ... SET x = x +/- (correlated subquery) WHERE Id IN
/// (subquery), DELETE ... WHERE. Every value is a parameter (never a literal in the text): dimensions, parameters, controls, the
/// key inserted by the same event, the clock, booleans. Entities as {Entity}, attributes as {Entity}.[Attribute] or alias.[Attribute].
/// </summary>
public static class PrototypeSql
{
    public sealed record Sql(string Name, string Text, IReadOnlyDictionary<string, (string Type, string Value)> Parameters);

    /// <summary>The statement of one set effect, its node name and its parameters (name, OutSystems type, the server value).</summary>
    internal static Sql Statement(PrototypePlanner p, JsonObject effect, PrototypeScope scope, IReadOnlyDictionary<string, string> inserted)
    {
        var kind = effect["kind"]!.ToString();
        var target = effect["target"]!.ToString();
        var targetEntity = p.EntityName(target);
        var parameters = new Dictionary<string, (string, string)>(StringComparer.OrdinalIgnoreCase);
        var builder = new Builder(p, scope, parameters, inserted);
        switch (kind)
        {
            case "insertFrom":
            {
                var source = effect["source"]!.ToString();
                var sourceEntity = p.EntityName(source);
                var join = effect["join"] as JsonObject;
                var joinEntity = join?["collection"]?.ToString() is { } jc ? p.EntityName(jc) : null;
                builder.Source = ("{" + sourceEntity + "}", source);
                builder.Join = joinEntity != null ? ("{" + joinEntity + "}", join!["collection"]!.ToString()) : null;
                var key = p.Data.ByCollection(target)?.Key ?? "Id";
                var sourceKey = p.Data.ByCollection(source)?.Key ?? "Id";
                var columns = new List<string> { $"[{key}]" };
                var values = new List<string> { $"(SELECT COALESCE(MAX(ssam_t.[{key}]), 0) FROM {{{targetEntity}}} ssam_t) + ROW_NUMBER() OVER (ORDER BY {{{sourceEntity}}}.[{sourceKey}])" };
                foreach (var (field, value) in effect["fields"] as JsonObject ?? [])
                {
                    if (field == key) continue;
                    columns.Add($"[{field}]");
                    values.Add(builder.Value(value));
                }
                var sb = new StringBuilder();
                sb.Append($"INSERT INTO {{{targetEntity}}} ({string.Join(", ", columns)})\n");
                sb.Append($"SELECT {string.Join(", ", values)}\n");
                sb.Append($"FROM {{{sourceEntity}}}");
                if (joinEntity != null)
                    sb.Append($"\nINNER JOIN {{{joinEntity}}} ON {{{joinEntity}}}.[{p.Data.ByCollection(join!["collection"]!.ToString())?.Key ?? "Id"}] = {{{sourceEntity}}}.[{join["on"]}]");
                if (effect["where"] is JsonObject where) sb.Append($"\nWHERE {builder.Predicate(where)}");
                return new Sql((p.Pt ? "Inserir" : "Insert") + target, sb.ToString(), parameters);
            }
            case "updateFrom":
            {
                var source = effect["source"]!.ToString();
                var sourceEntity = p.EntityName(source);
                var field = effect["field"]!.ToString();
                var via = effect["via"]!.ToString();
                var sum = effect["sum"]!.ToString();
                var sign = effect["sign"]?.ToString() == "+" ? "+" : "-";
                var key = p.Data.ByCollection(target)?.Key ?? "Id";
                builder.Source = ("ssam_s", source);
                var correlated = effect["where"] is JsonObject w1 ? " AND " + builder.Predicate(w1) : "";
                var sub = $"SELECT COALESCE(SUM(ssam_s.[{sum}]), 0) FROM {{{sourceEntity}}} ssam_s WHERE ssam_s.[{via}] = {{{targetEntity}}}.[{key}]{correlated}";
                builder.Source = ("ssam_k", source);
                var keys = $"SELECT ssam_k.[{via}] FROM {{{sourceEntity}}} ssam_k" + (effect["where"] is JsonObject w2 ? " WHERE " + builder.Predicate(w2) : "");
                var text = $"UPDATE {{{targetEntity}}}\nSET [{field}] = {{{targetEntity}}}.[{field}] {sign} ({sub})\nWHERE {{{targetEntity}}}.[{key}] IN ({keys})";
                return new Sql((p.Pt ? "Atualizar" : "Update") + target + field, text, parameters);
            }
            case "removeWhere":
            {
                builder.Source = ("{" + targetEntity + "}", target);
                var text = $"DELETE FROM {{{targetEntity}}}" + (effect["where"] is JsonObject where ? "\nWHERE " + builder.Predicate(where) : "");
                return new Sql((p.Pt ? "Remover" : "Remove") + target, text, parameters);
            }
            default: throw new PrototypeExpressionException($"{kind} is not a set effect");
        }
    }

    private sealed class Builder(PrototypePlanner p, PrototypeScope scope, Dictionary<string, (string, string)> parameters, IReadOnlyDictionary<string, string> inserted)
    {
        public (string Alias, string Collection) Source { get; set; }
        public (string Alias, string Collection)? Join { get; set; }

        private string Param(string wanted, string type, string value)
        {
            var name = new string(wanted.Where(char.IsLetterOrDigit).ToArray());
            if (name.Length == 0 || !char.IsLetter(name[0])) name = "P" + name;
            foreach (var (existing, (t, v)) in parameters) if (v == value && t == type) return "@" + existing;
            var candidate = name;
            for (var n = 2; parameters.ContainsKey(candidate); n++) candidate = name + n;
            parameters[candidate] = (type, value);
            return "@" + candidate;
        }

        private string ParamType(JsonNode? val)
            => PrototypeExpr.TypeOf(val, scope) switch { "DateTime" => "Date Time", null => "Integer", var t => t };

        /// <summary>A value of an insertFrom field or a comparison side: a column of the source or the join, or a parameter.</summary>
        public string Value(JsonNode? val)
        {
            if (val is not JsonObject o) throw new PrototypeExpressionException("an SQL value is an object");
            if (o["source"]?.ToString() is { } source) return $"{Source.Alias}.[{source}]";
            if (o["join"]?.ToString() is { } joined) return Join is { } j ? $"{j.Alias}.[{joined}]" : throw new PrototypeExpressionException("join value without a join");
            if (o["field"]?.ToString() is { } field && o["record"] == null)
            {
                if (o["via"]?.ToString() is { } via && Join is { } j) return $"{j.Alias}.[{field}]";
                return $"{Source.Alias}.[{field}]";
            }
            if (o["mul"] is JsonArray mul) return string.Join(" * ", mul.Select(Value));
            if (o["add"] is JsonArray add) return "(" + string.Join(" + ", add.Select(Value)) + ")";
            if (o["inserted"]?.ToString() is { } collection)
                return Param(collection + "Id", "Integer", inserted.TryGetValue(collection, out var output) ? output : collection + "Id");
            if (o["clock"] is JsonValue) return Param(p.Pt ? "Agora" : "Now", "Date Time", "CurrDateTime()");
            if (o.ContainsKey("lit")) return Param(p.Pt ? "Valor" : "Value", PrototypeExpr.TypeOfLiteral(o["lit"]) switch { "Decimal" => "Decimal", var t => t }, PrototypeExpr.Literal(o["lit"]));
            // a value the server action receives (dimension, parameter, control, record field): a parameter
            var text = PrototypeExpr.Val(o, scope);
            var wanted = o["dim"] != null ? p.Capture.Dimension(o["dim"]!.ToString())?["name"]?.ToString() ?? text : o["param"]?.ToString() ?? o["control"]?.ToString() ?? o["field"]?.ToString() ?? text;
            return Param(wanted, ParamType(o), text);
        }

        public string Predicate(JsonNode? pred)
        {
            if (pred is not JsonObject o) throw new PrototypeExpressionException("an SQL predicate is an object");
            var op = o["op"]?.ToString();
            return op switch
            {
                "and" => string.Join(" AND ", (o["a"] as JsonArray ?? []).Select(x => "(" + Predicate(x) + ")")),
                "or" => "(" + string.Join(" OR ", (o["a"] as JsonArray ?? []).Select(x => "(" + Predicate(x) + ")")) + ")",
                "not" => "NOT (" + Predicate(o["a"]?[0]) + ")",
                "truthy" => $"{Value(o["l"])} = {Param(p.Pt ? "Verdadeiro" : "True", "Boolean", "True")}",
                "eq" => $"{Value(o["l"])} = {Value(o["r"])}",
                "ne" => $"{Value(o["l"])} <> {Value(o["r"])}",
                "gt" => $"{Value(o["l"])} > {Value(o["r"])}",
                "ge" => $"{Value(o["l"])} >= {Value(o["r"])}",
                "lt" => $"{Value(o["l"])} < {Value(o["r"])}",
                "le" => $"{Value(o["l"])} <= {Value(o["r"])}",
                _ => throw new PrototypeExpressionException($"predicate {op} has no portable SQL form here"),
            };
        }
    }

    /// <summary>The portable forms a set effect may take (the tests read the statements against this list).</summary>
    public static readonly IReadOnlyList<string> PortableForms = ["INSERT INTO", "SELECT", "UPDATE", "SET", "DELETE FROM", "WHERE", "IN", "COALESCE", "MAX", "SUM", "ROW_NUMBER() OVER", "INNER JOIN", "AND", "OR", "NOT"];
}
