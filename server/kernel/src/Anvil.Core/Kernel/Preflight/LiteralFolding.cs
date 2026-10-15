using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>
/// Familias (2026-10-12, VisitaCerta_UI by hand: 8 Verify errors InvalidPropertyValue_DefaultValue in two rounds, 2
/// DEFAULT_NOT_LITERAL): a slot that takes only a literal (the default of a variable, an input, an output, a client variable,
/// a site property, a setting, an attribute; the value of a static record) written as a constant expression has one value,
/// and the slot gets it as the literal of its type. One rule for every form that writes such a slot: a raw `set
/// DefaultValue`, the data text (`client variable X: Date = ...`, `default ...` of an attribute), the logic text
/// (`in`/`out`/`local` lines of an action), the logic JSON (inputs, outputs, vars), the document of a screen or block
/// (`&lt;var default&gt;`, `&lt;input default&gt;`) and the spec (attribute defaults, static record values). Listed as
/// LITERAL_FOLDED, never refused.
/// <list type="bullet">
/// <item>A constant call: TextToDate("2026-05-04") is #2026-05-04#; TextToDateTime, TextToTime, NewDate, NewTime,
/// NewDateTime, DateToDateTime, DateTimeToDate, DateTimeToTime, TextToInteger, TextToLongInteger, TextToDecimal,
/// IntegerToText, LongIntegerToText, IntegerToDecimal, IntegerToLongInteger, LongIntegerToInteger, of literals (or of other
/// constant calls). An argument that is no valid value (2026-02-30, "abc" for a number) folds nothing.</item>
/// <item>A literal of another type in a typed slot whose meaning is one: "2026-05-04" in a Date, "12:30" in a Time, "5" in
/// an Integer, "True" in a Boolean, #2026-05-04# in a Date Time (midnight).</item>
/// </list>
/// What stays an expression in such a slot (CurrDate(), a name, an operator) is left as written: the Studio accepts some of
/// them (a screen variable's CurrDate(), html-replay 0162) and refuses others, so no rule refuses it here; motor2 moves it
/// where an action can assign it (DEFAULT_MOVED_TO_INITIALIZE / DEFAULT_MOVED_TO_ASSIGN).
/// </summary>
public static class LiteralFolding
{
    public const string Rule = "LITERAL_FOLDED";

    private enum Kind { Text, Integer, Decimal, Boolean, Date, DateTime, Time }

    private sealed record Value(Kind Kind, string Text, long Integer = 0, decimal Number = 0, DateTime When = default, bool Flag = false);

    // ---- the fold --------------------------------------------------------------------------------------------------------

    /// <summary>The literal <paramref name="expression"/> is in a slot of <paramref name="type"/> (null: unknown, the value's
    /// own type), or null when it is already a literal of that type, is no constant, or has no single literal there.
    /// <paramref name="callsOnly"/>: only a constant call is folded (the logic JSON and the spec, whose mistyped literals are
    /// JobPreflight.LiteralFix's: DEFAULT_LITERAL_INVALID, DEFAULT_LITERAL_REWRITTEN).</summary>
    public static string? Fold(string expression, string? type, bool callsOnly = false)
    {
        var text = expression.Trim();
        if (text.Length == 0 || callsOnly && !text.Contains('(')) return null;
        var target = KindOf(type);
        if (!string.IsNullOrWhiteSpace(type) && target == null) return null;   // a record, a list, an identifier, an entity: never
        Value? value;
        try { value = Evaluate(text); } catch { return null; }
        if (value == null) return null;
        var literal = Write(value, target);
        if (literal == null || string.Equals(literal, text, StringComparison.Ordinal)) return null;
        return literal;
    }

    private static Kind? KindOf(string? type) => type?.Trim().ToLowerInvariant() switch
    {
        null or "" => null,
        "text" or "long text" or "email" or "phone number" => Kind.Text,
        "integer" or "long integer" or "longinteger" => Kind.Integer,
        "decimal" or "currency" => Kind.Decimal,
        "boolean" => Kind.Boolean,
        "date" => Kind.Date,
        "date time" or "datetime" => Kind.DateTime,
        "time" => Kind.Time,
        _ => null,
    };

    private static Value? Evaluate(string text)
    {
        var tokens = ExpressionText.Tokens(text);
        if (tokens.Count == 0) return null;
        var at = 0;
        var value = Parse(text, tokens, ref at);
        return at == tokens.Count ? value : null;
    }

    private static Value? Parse(string text, List<Token> tokens, ref int at)
    {
        if (at >= tokens.Count) return null;
        var t = tokens[at];
        switch (t.Kind)
        {
            case TokenKind.Text: at++; return new Value(Kind.Text, t.Text[1..^1].Replace("\"\"", "\""));
            case TokenKind.Number:
                at++;
                return Number(t.Text, negative: false);
            case TokenKind.Operator when t.Text == "-" && at + 1 < tokens.Count && tokens[at + 1].Kind == TokenKind.Number:
                at += 2;
                return Number(tokens[at - 1].Text, negative: true);
            case TokenKind.Date:
                at++;
                return DateLiteral(t.Text);
            case TokenKind.Name when t.Is("True") || t.Is("False"):
                at++;
                return new Value(Kind.Boolean, t.Is("True") ? "True" : "False", Flag: t.Is("True"));
            case TokenKind.Name when !t.Text.Contains('.') && at + 1 < tokens.Count && tokens[at + 1].Kind == TokenKind.Open:
            {
                var name = t.Text;
                at += 2;
                var args = new List<Value>();
                if (at < tokens.Count && tokens[at].Kind == TokenKind.Close) { at++; return Call(name, args); }
                while (true)
                {
                    var arg = Parse(text, tokens, ref at);
                    if (arg == null) return null;
                    args.Add(arg);
                    if (at < tokens.Count && tokens[at].Kind == TokenKind.Comma) { at++; continue; }
                    if (at < tokens.Count && tokens[at].Kind == TokenKind.Close) { at++; break; }
                    return null;
                }
                return Call(name, args);
            }
            default: return null;
        }
    }

    private static Value? Number(string text, bool negative)
    {
        var written = (negative ? "-" : "") + text;
        if (!text.Contains('.'))
            return long.TryParse(written, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var n) ? new Value(Kind.Integer, written, Integer: n, Number: n) : null;
        return decimal.TryParse(written, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var d) ? new Value(Kind.Decimal, written, Number: d) : null;
    }

    private static readonly Regex DateText = new(@"^(\d{4})-(\d{1,2})-(\d{1,2})$", RegexOptions.Compiled);
    private static readonly Regex DateTimeText = new(@"^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$", RegexOptions.Compiled);
    private static readonly Regex TimeText = new(@"^(\d{1,2}):(\d{2})(?::(\d{2}))?$", RegexOptions.Compiled);

    private static Value? DateLiteral(string token)
    {
        var inner = token.Trim('#').Trim();
        return ParseDate(inner) ?? ParseDateTime(inner) ?? ParseTime(inner);
    }

    private static Value? ParseDate(string s)
    {
        var m = DateText.Match(s);
        return m.Success && Make(int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[3].Value), 0, 0, 0) is { } d ? new Value(Kind.Date, "", When: d) : null;
    }

    private static Value? ParseDateTime(string s)
    {
        var m = DateTimeText.Match(s);
        if (!m.Success) return null;
        var seconds = m.Groups[6].Success ? int.Parse(m.Groups[6].Value) : 0;
        return Make(int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[3].Value), int.Parse(m.Groups[4].Value), int.Parse(m.Groups[5].Value), seconds) is { } d
            ? new Value(Kind.DateTime, "", When: d) : null;
    }

    private static Value? ParseTime(string s)
    {
        var m = TimeText.Match(s);
        if (!m.Success) return null;
        var seconds = m.Groups[3].Success ? int.Parse(m.Groups[3].Value) : 0;
        return Make(1900, 1, 1, int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), seconds) is { } d ? new Value(Kind.Time, "", When: d) : null;
    }

    private static DateTime? Make(long year, long month, long day, long hour, long minute, long second)
    {
        if (year is < 1900 or > 3000 || month is < 1 or > 12 || hour is < 0 or > 23 || minute is < 0 or > 59 || second is < 0 or > 59) return null;
        if (day < 1 || day > DateTime.DaysInMonth((int)year, (int)month)) return null;
        return new DateTime((int)year, (int)month, (int)day, (int)hour, (int)minute, (int)second, DateTimeKind.Unspecified);
    }

    private static Value? Call(string name, List<Value> a)
    {
        bool Is(params Kind[] kinds) => a.Count == kinds.Length && a.Select((v, i) => v.Kind == kinds[i]).All(x => x);
        switch (name.ToLowerInvariant())
        {
            case "texttodate" when Is(Kind.Text): return ParseDate(a[0].Text.Trim());
            case "texttodatetime" when Is(Kind.Text): return ParseDateTime(a[0].Text.Trim()) ?? (ParseDate(a[0].Text.Trim()) is { } d ? d with { Kind = Kind.DateTime } : null);
            case "texttotime" when Is(Kind.Text): return ParseTime(a[0].Text.Trim());
            case "newdate" when Is(Kind.Integer, Kind.Integer, Kind.Integer):
                return Make(a[0].Integer, a[1].Integer, a[2].Integer, 0, 0, 0) is { } nd ? new Value(Kind.Date, "", When: nd) : null;
            case "newtime" when Is(Kind.Integer, Kind.Integer, Kind.Integer):
                return Make(1900, 1, 1, a[0].Integer, a[1].Integer, a[2].Integer) is { } nt ? new Value(Kind.Time, "", When: nt) : null;
            case "newdatetime" when Is(Kind.Integer, Kind.Integer, Kind.Integer, Kind.Integer, Kind.Integer, Kind.Integer):
                return Make(a[0].Integer, a[1].Integer, a[2].Integer, a[3].Integer, a[4].Integer, a[5].Integer) is { } ndt ? new Value(Kind.DateTime, "", When: ndt) : null;
            case "datetodatetime" when Is(Kind.Date): return a[0] with { Kind = Kind.DateTime };
            case "datetimetodate" when Is(Kind.DateTime): return a[0] with { Kind = Kind.Date, When = a[0].When.Date };
            case "datetimetotime" when Is(Kind.DateTime): return new Value(Kind.Time, "", When: new DateTime(1900, 1, 1) + a[0].When.TimeOfDay);
            case "texttointeger" or "texttolonginteger" when Is(Kind.Text):
                return long.TryParse(a[0].Text.Trim(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var n) && !a[0].Text.Trim().StartsWith('+')
                    ? new Value(Kind.Integer, n.ToString(CultureInfo.InvariantCulture), Integer: n, Number: n) : null;
            case "texttodecimal" when Is(Kind.Text):
                return Regex.IsMatch(a[0].Text.Trim(), @"^-?\d+(\.\d+)?$") && decimal.TryParse(a[0].Text.Trim(), NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var dn)
                    ? new Value(Kind.Decimal, a[0].Text.Trim(), Number: dn) : null;
            case "integertotext" or "longintegertotext" when Is(Kind.Integer): return new Value(Kind.Text, a[0].Integer.ToString(CultureInfo.InvariantCulture));
            case "integertodecimal" when Is(Kind.Integer): return new Value(Kind.Decimal, a[0].Text, Number: a[0].Integer);
            case "integertolonginteger" or "longintegertointeger" when Is(Kind.Integer):
                return name.Equals("LongIntegerToInteger", StringComparison.OrdinalIgnoreCase) && (a[0].Integer > int.MaxValue || a[0].Integer < int.MinValue) ? null : a[0];
            default: return null;
        }
    }

    /// <summary>The literal of <paramref name="value"/> for a slot of <paramref name="target"/> (null: its own type), or null
    /// when the value has no single literal there.</summary>
    private static string? Write(Value value, Kind? target)
    {
        var to = target ?? value.Kind;
        switch (to)
        {
            case Kind.Date when value.Kind == Kind.Date: return "#" + value.When.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + "#";
            case Kind.Date when value.Kind == Kind.Text: return ParseDate(value.Text.Trim()) is { } d ? Write(d, Kind.Date) : null;
            case Kind.DateTime when value.Kind is Kind.DateTime or Kind.Date: return "#" + value.When.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "#";
            case Kind.DateTime when value.Kind == Kind.Text: return (ParseDateTime(value.Text.Trim()) ?? ParseDate(value.Text.Trim())) is { } dt ? Write(dt, Kind.DateTime) : null;
            case Kind.Time when value.Kind == Kind.Time: return "#" + value.When.ToString("HH:mm:ss", CultureInfo.InvariantCulture) + "#";
            case Kind.Time when value.Kind == Kind.Text: return ParseTime(value.Text.Trim()) is { } t ? Write(t, Kind.Time) : null;
            case Kind.Integer when value.Kind == Kind.Integer: return value.Integer.ToString(CultureInfo.InvariantCulture);
            case Kind.Integer when value.Kind == Kind.Text:
                return Regex.IsMatch(value.Text.Trim(), @"^-?\d+$") && long.TryParse(value.Text.Trim(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var n) ? n.ToString(CultureInfo.InvariantCulture) : null;
            case Kind.Decimal when value.Kind is Kind.Decimal or Kind.Integer: return value.Kind == Kind.Integer ? value.Integer.ToString(CultureInfo.InvariantCulture) : value.Text;
            case Kind.Decimal when value.Kind == Kind.Text: return Regex.IsMatch(value.Text.Trim(), @"^-?\d+(\.\d+)?$") ? value.Text.Trim() : null;
            case Kind.Boolean when value.Kind == Kind.Boolean: return value.Flag ? "True" : "False";
            case Kind.Boolean when value.Kind == Kind.Text:
                return value.Text.Trim().Equals("true", StringComparison.OrdinalIgnoreCase) ? "True" : value.Text.Trim().Equals("false", StringComparison.OrdinalIgnoreCase) ? "False" : null;
            case Kind.Text when value.Kind == Kind.Text: return "\"" + value.Text.Replace("\"", "\"\"") + "\"";
            case Kind.Text when value.Kind == Kind.Integer: return "\"" + value.Integer.ToString(CultureInfo.InvariantCulture) + "\"";
            default: return null;
        }
    }

    // ---- the slots -------------------------------------------------------------------------------------------------------

    /// <summary>Every literal-only slot of the job written as a constant expression, folded in place and listed. Idempotent.</summary>
    public static void Normalize(JsonArray ops, string? prefix, string lane, List<JsonObject> done)
    {
        var types = DeclaredTypes(ops, lane);
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            var at = prefix == null ? null : $"{prefix}/{i}";
            try
            {
                switch (op["op"]?.ToString())
                {
                    case "set": RawSet(op, at, types, done); break;
                    case "logic": Logic(op, at, done); break;
                    case "spec": Spec(op, at, lane, done); break;
                    case "html": Document(op, at, done); break;
                }
            }
            catch { /* a normalization never refuses: the checks judge what stays */ }
        }
    }

    private static void Entry(List<JsonObject> done, string? path, string what, string from, string to)
        => done.Add(JobNormalizer.Entry(Rule, path, from, to, $"{what} takes only a literal, and {from} is the constant {to}"));

    // The module-wide values a raw `IClientVariable:Name` (or another of these kinds) names: a name, never a path.
    private static readonly Regex GlobalTarget = new(@"^I?(ClientVariable|SiteProperty|Setting|SessionVariable):([A-Za-z_][A-Za-z0-9_]*)$", RegexOptions.Compiled);

    /// <summary>The types the job declares for the targets of its raw sets: the client variables, site properties, settings
    /// and session variables of its data texts and creates (by "Kind:Name"), and the $alias of an element whose DataType a set
    /// writes. A key written with two types is unknown (null).</summary>
    private static Dictionary<string, string?> DeclaredTypes(JsonArray ops, string lane)
    {
        var types = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        void Add(string key, string? type)
        {
            if (string.IsNullOrEmpty(type)) return;
            types[key] = types.TryGetValue(key, out var known) && (known == null || !string.Equals(known, type, StringComparison.OrdinalIgnoreCase)) ? null : type;
        }
        var created = new Dictionary<string, string>(StringComparer.Ordinal);   // $alias -> Kind:Name of a module-wide value
        foreach (var op in ops.OfType<JsonObject>())
        {
            var verb = op["op"]?.ToString();
            if (verb == "spec" && op["data"]?["ddl"] is JsonValue dv && dv.TryGetValue<string>(out var ddl))
            {
                try
                {
                    foreach (var e in DdlParser.Parse(ddl, lane).All())
                        if (e.Kind is "ClientVariable" or "SiteProperty" or "SessionVariable" && e.Props.TryGetValue("DataType", out var t)) Add(e.Kind + ":" + e.Name, t);
                }
                catch { }
            }
            if (verb == "create" && op["name"]?.ToString() is { Length: > 0 } name && op["as"]?.ToString() is { Length: > 0 } alias
                && GlobalTarget.Match((op["type"]?.ToString() ?? "") + ":" + name) is { Success: true } g)
                created[alias] = g.Groups[1].Value + ":" + g.Groups[2].Value;
            if (verb == "set" && op["prop"]?.ToString() == "DataType" && op["value"] is JsonValue tv && tv.TryGetValue<string>(out var type) && op["target"]?.ToString() is { } target)
            {
                if (target.StartsWith('$')) { Add(target, type); if (created.TryGetValue(target, out var global)) Add(global, type); }
                else if (GlobalTarget.Match(target) is { Success: true } m) Add(m.Groups[1].Value + ":" + m.Groups[2].Value, type);
            }
        }
        // SiteProperty and Setting are one kind of the data text (`setting` is the ODC word).
        foreach (var key in types.Keys.Where(k => k.StartsWith("SiteProperty:", StringComparison.OrdinalIgnoreCase)).ToList())
            types.TryAdd("Setting:" + key["SiteProperty:".Length..], types[key]);
        return types;
    }

    private static void RawSet(JsonObject op, string? at, Dictionary<string, string?> types, List<JsonObject> done)
    {
        if (op["prop"]?.ToString() != "DefaultValue" || op["value"] is not JsonValue v || !v.TryGetValue<string>(out var value)) return;
        var target = op["target"]?.ToString() ?? "";
        // The type is the target's when the job declares it; else the value's own (a constant call), never a literal's guess.
        string? type = null;
        if (target.StartsWith('$')) types.TryGetValue(target, out type);
        else if (GlobalTarget.Match(target) is { Success: true } m) types.TryGetValue(m.Groups[1].Value + ":" + m.Groups[2].Value, out type);
        if (Fold(value, type, callsOnly: type == null) is not { } literal) return;
        op["value"] = literal;
        Entry(done, at == null ? null : at + "/value", $"the default of {target}", value.Trim(), literal);
    }

    private static void Logic(JsonObject op, string? at, List<JsonObject> done)
    {
        if (op["data"] is not JsonObject data) return;
        if (data["actions"] is JsonArray actions)
            for (var a = 0; a < actions.Count; a++)
            {
                if (actions[a] is not JsonObject action) continue;
                foreach (var section in new[] { "inputs", "outputs", "vars" })
                    for (var p = 0; p < (action[section] as JsonArray)?.Count; p++)
                    {
                        if (action[section]![p] is not JsonObject parameter || parameter["default"] is not JsonValue dv || !dv.TryGetValue<string>(out var value)) continue;
                        if (Fold(value, parameter["type"]?.ToString(), callsOnly: true) is not { } literal) continue;
                        parameter["default"] = literal;
                        Entry(done, at == null ? null : $"{at}/data/actions/{a}/{section}/{p}/default", $"the default of {parameter["name"]} of {action["name"]}", value.Trim(), literal);
                    }
            }
        if (data.ContainsKey("flow")) FlowTexts.Rewrite(data, at, (text, path) => FlowDefaults(text, path, done));
    }

    // `in X: T = v`, `out X: T = v`, `local X: T = v` at depth 1 of an action (a node's in/out lines are arguments, not defaults).
    private static readonly Regex ParameterLine = new(@"^  (in|out|local) ([A-Za-z_][A-Za-z0-9_]*)\??(?:: ([^=@]+?))?(?: inline)? = (.+?)(\s+@[A-Za-z0-9+]+)?$", RegexOptions.Compiled);

    private static string? FlowDefaults(string text, string? path, List<JsonObject> done)
    {
        var lines = text.Split('\n');
        var changed = false;
        for (var k = 0; k < lines.Length; k++)
        {
            var line = lines[k].TrimEnd('\r');
            var m = ParameterLine.Match(line);
            if (!m.Success || m.Groups[4].Value.StartsWith('`')) continue;
            var value = m.Groups[4].Value;
            if (Fold(value, m.Groups[3].Success ? m.Groups[3].Value.Trim() : null) is not { } literal) continue;
            lines[k] = line[..m.Groups[4].Index] + literal + line[(m.Groups[4].Index + value.Length)..] + (lines[k].EndsWith('\r') ? "\r" : "");
            changed = true;
            Entry(done, path, $"line {k + 1}: the default of {m.Groups[1].Value} {m.Groups[2].Value}", value.Trim(), literal);
        }
        return changed ? string.Join("\n", lines) : null;
    }

    private static void Spec(JsonObject op, string? at, string lane, List<JsonObject> done)
    {
        if (op["data"] is not JsonObject data) return;
        if (data["ddl"] is JsonValue dv && dv.TryGetValue<string>(out var ddl) && DdlDefaults(ddl, lane, at == null ? null : at + "/data/ddl", done) is { } written)
        {
            data["ddl"] = written;
        }
        foreach (var section in new[] { "entities", "clientEntities", "structures", "static" })
        {
            if (data[section] is not JsonArray records) continue;
            for (var r = 0; r < records.Count; r++)
            {
                if (records[r] is not JsonObject record || record["attributes"] is not JsonArray attributes) continue;
                var typed = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                for (var a = 0; a < attributes.Count; a++)
                {
                    if (attributes[a] is not JsonObject attribute || attribute["name"]?.ToString() is not { Length: > 0 } name) continue;
                    var type = attribute["type"]?.ToString() ?? "Text";
                    typed[name] = type;
                    if (attribute["default"] is not JsonValue av || !av.TryGetValue<string>(out var value) || Fold(value, type, callsOnly: true) is not { } literal) continue;
                    attribute["default"] = literal;
                    Entry(done, at == null ? null : $"{at}/data/{section}/{r}/attributes/{a}/default", $"the default of {record["name"]}.{name}", value.Trim(), literal);
                }
                if (section != "static" || record["records"] is not JsonArray rows) continue;
                for (var row = 0; row < rows.Count; row++)
                {
                    if (rows[row] is not JsonObject values) continue;
                    foreach (var (name, type) in typed)
                    {
                        if (values[name] is not JsonValue rv || !rv.TryGetValue<string>(out var value) || Fold(value, type, callsOnly: true) is not { } literal) continue;
                        values[name] = literal;
                        Entry(done, at == null ? null : $"{at}/data/static/{r}/records/{row}/{name}", $"the value {name} of static record {values["name"]}", value.Trim(), literal);
                    }
                }
            }
        }
    }

    /// <summary>The defaults of the data text's variables (`= v`) and attributes (`default v`), folded on their line.</summary>
    private static string? DdlDefaults(string ddl, string lane, string? path, List<JsonObject> done)
    {
        DdlDocument document;
        try { document = DdlParser.Parse(ddl, lane); } catch { return null; }
        var lines = ddl.Replace("\r\n", "\n").Split('\n');
        var changed = false;
        foreach (var e in document.All())
        {
            if (!e.Props.TryGetValue("DefaultValue", out var value) || value == null || e.Line < 1 || e.Line > lines.Length) continue;
            e.Props.TryGetValue("DataType", out var type);
            if (Fold(value, type) is not { } literal) continue;
            // The value on its line, once: after the '=' of a variable, after 'default ' of an attribute.
            var line = lines[e.Line - 1];
            var marker = e.Kind is "ClientVariable" or "SiteProperty" or "SessionVariable" ? "= " : "default ";
            var head = line.IndexOf(marker + value, StringComparison.Ordinal);
            if (head < 0 || line.IndexOf(marker + value, head + 1, StringComparison.Ordinal) >= 0) continue;
            var start = head + marker.Length;
            lines[e.Line - 1] = line[..start] + literal + line[(start + value.Length)..];
            changed = true;
            Entry(done, path, $"line {e.Line}: the default of {(e.Parent is { } parent ? parent.Name + "." : "")}{e.Name}", value.Trim(), literal);
        }
        return changed ? string.Join("\n", lines) : null;
    }

    private static void Document(JsonObject op, string? at, List<JsonObject> done)
    {
        if (op["parent"] != null || op["data"] is not JsonObject data || data["html"] is not JsonValue hv || !hv.TryGetValue<string>(out var html) || !HtmlText.IsDocument(html)) return;
        if (ScreenDocFacts.Of(op, 0) is not { } doc) return;
        var edits = new List<HtmlText.Edit>();
        var path = at == null ? null : at + "/data/html";
        foreach (var d in doc.Declared.Where(d => d.Kind is "var" or "input" && d.Default != null))
        {
            var written = HtmlDocumentRules.Decode(d.Default!.Value);
            if (Fold(written, d.Type) is not { } literal) continue;
            var quote = d.Default.ValueEnd < html.Length ? html[d.Default.ValueEnd] : '"';
            var encoded = literal.Replace("&", "&amp;");
            encoded = quote == '"' ? encoded.Replace("\"", "&quot;") : quote == '\'' ? encoded.Replace("'", "&#39;") : encoded;
            edits.Add(new(d.Default.ValueStart, d.Default.ValueEnd - d.Default.ValueStart, encoded));
            var (line, column) = doc.Text.Position(d.Default.Start);
            Entry(done, path, $"line {line} col {column}: the default of {d.Kind} {d.Name} of {doc.Name}", written.Trim(), literal);
        }
        if (edits.Count == 0) return;
        SentJob.HtmlBefore(data, html);
        data["html"] = HtmlText.Apply(html, edits);
    }
}
