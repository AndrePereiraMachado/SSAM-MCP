using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace Anvil.Reading;

// The canonical model of one action as ssam-flow/1 represents it (FlowExtractor reads it from the module, FlowPrinter writes
// it as text, FlowParser reads the text back). Two models are the same action when their Canon texts are equal: that is the
// fixed point the corpus test proves (read -> print -> parse = the same model, so reapplying the text changes nothing).
//   Role: action, in, out, local (parameters and variables, keyed), node (keyed), and the parts a node owns (compared by
//   content, never by key): assignment, argument, case, event, source, join, filter, group, agg, calc, sort, output.
//   Props: authored properties only (FlowRules: defaults, derived and structural properties are left out on both sides).
//   Edges: the connectors of a node by name (Target, TrueTarget...), to a node key, "" for none.
// A property value is typed: e expression text, t literal text, v value (enum, number, boolean), r reference (the display
// name of the element it points at).
public sealed record FlowValue(char Type, string Text);

public sealed class FlowItem
{
    public string Role = "", Kind = "", Key = "", Name = "";
    // The screen, block or email a screen or data action belongs to, as the header writes it before the action's name
    // (FlowOwners.Text: the owner's name, or Flow/Name when two owners of the module share that name); "" for a module action.
    // Part of the canonical text of the action.
    public string Owner = "";
    // A node the text cannot carry whole (its reader found a part, value or property it cannot read or print): written as
    // "opaque <Kind>" with its name, key and connectors only, and never written back (FlowDiff refuses any change to it).
    public bool Opaque;
    // Why the node is opaque (the extractor's problems for it); not part of the canonical text.
    public List<string>? OpaqueReasons;
    // The kind of call an Execute node of a read makes (Client or Server), written in the text (Call=) only when it is not
    // the kind its flow picks by default; not part of the canonical text (FlowDiff compares the kind of call with it).
    public string? CallKind;
    public readonly SortedDictionary<string, FlowValue> Props = new(StringComparer.Ordinal);
    public readonly SortedDictionary<string, string> Edges = new(StringComparer.Ordinal);
    public readonly List<FlowItem> Items = [];

    public FlowItem(string role, string kind, string key = "", string name = "") { Role = role; Kind = kind; Key = key; Name = name; }

    // A copy (FlowDiff builds the expected model from the edited one).
    public FlowItem Clone()
    {
        var copy = new FlowItem(Role, Kind, Key, Name) { Owner = Owner, Opaque = Opaque, OpaqueReasons = OpaqueReasons, CallKind = CallKind };
        foreach (var (name, value) in Props) copy.Props[name] = value;
        foreach (var (name, target) in Edges) copy.Edges[name] = target;
        foreach (var item in Items) copy.Items.Add(item.Clone());
        return copy;
    }

    public string? Prop(string name) => Props.TryGetValue(name, out var value) ? value.Text : null;
    public FlowItem Set(string name, char type, string? text) { if (!string.IsNullOrEmpty(text)) Props[name] = new(type, text); return this; }

    // Keyed roles carry their element key; parts are compared by content.
    public static bool Keyed(string role) => role is "action" or "in" or "out" or "local" or "node";
    // Roles whose order in the model means nothing (sets): ordered by their canonical text.
    internal static bool Unordered(string role) => role is "argument" or "source" or "join" or "filter" or "group" or "agg" or "calc" or "event" or "node";
    private static readonly string[] RoleOrder = ["in", "out", "local", "event", "assignment", "argument", "case", "source", "join", "filter", "group",
        "agg", "calc", "sort", "output", "node"];
    private static int Rank(string role) { var at = Array.IndexOf(RoleOrder, role); return at < 0 ? RoleOrder.Length : at; }

    // The canonical text: one line per item (texts JSON-escaped), children grouped by role in a fixed order, sets sorted.
    public string Canon()
    {
        var text = new StringBuilder();
        Write(text, 0);
        return text.ToString();
    }

    private void Write(StringBuilder text, int depth)
    {
        text.Append(' ', depth * 2).Append(Role).Append(' ').Append(Kind).Append(' ').Append(FlowSyntax.Json(Name));
        if (Keyed(Role)) text.Append(" @").Append(Key);
        if (Owner.Length > 0) text.Append(" of=").Append(FlowSyntax.Json(Owner));
        if (Opaque) text.Append(" opaque");
        foreach (var (name, value) in Props) text.Append(' ').Append(name).Append('=').Append(value.Type).Append(FlowSyntax.Json(value.Text));
        foreach (var (name, target) in Edges) text.Append(" >").Append(name).Append('=').Append(target);
        text.Append('\n');
        foreach (var group in Items.Select((item, at) => (item, at)).GroupBy(x => x.item.Role).OrderBy(g => Rank(g.Key)).ThenBy(g => g.Key, StringComparer.Ordinal)) {
            var children = group.Select(x => { var child = new StringBuilder(); x.item.Write(child, depth + 1); return child.ToString(); }).ToList();
            if (Unordered(group.Key)) children.Sort(StringComparer.Ordinal);
            foreach (var child in children) text.Append(child);
        }
    }
}

// The record mapping a value holds outside its expression text (O11: the TypeConversion of an assignment or an argument,
// one AttributeMapping per attribute of the target type). Authored: a conversion the developer fills (the Studio shows
// its mapping editor); not authored: the automatic conversion the Studio derives from the two types (a SQL list wrapped in
// its structure, an aggregate record narrowed to its entity), which the text never writes. Fields: the target attribute
// and its source expression, in the model's order, the empty ones left out.
public sealed record NativeMapping(bool Authored, IReadOnlyList<(string Field, string Value)> Fields);

// A mapping at the top of an expression: "Source mapTo { Field: value, Other.Field: value }". ODC prints it as the text of
// the expression (a type conversion); O11 keeps it beside the expression (NativeMapping) and the reader writes it in the
// same form, so a model learns one form. Split as the text grammar scans (outside "texts", #dates# and brackets).
public static class FlowMapping
{
    private static readonly System.Text.RegularExpressions.Regex Entry = new(@"^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*:\s*(.+)$",
        System.Text.RegularExpressions.RegexOptions.Singleline | System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    // The text of a source and its fields; null when that text would not split back to exactly them (a value with a space
    // at either end, a field that is not a name), so a mapping is only written when the way back gives it whole.
    public static string? Compose(string source, IReadOnlyList<(string Field, string Value)> fields)
    {
        if (source.Length == 0 || fields.Count == 0) return null;
        var text = source + " mapTo { " + string.Join(", ", fields.Select(f => f.Field + ": " + f.Value)) + " }";
        return Split(text) is { } split && split.Source == source && split.Fields.SequenceEqual(fields) ? text : null;
    }

    // Two mapping texts that say the same: the same source and the same fields with the same values, in any order and any
    // case of the field names (OutSystems names have none). The order of a mapping means nothing to the platform: O11 keeps
    // its fields in the order of the target's attributes.
    public static bool SameMapping(string a, string b)
    {
        if (a == b) return true;
        if (Split(a) is not { } x || Split(b) is not { } y || x.Source != y.Source || x.Fields.Count != y.Fields.Count) return false;
        var rest = y.Fields.ToList();
        foreach (var (field, value) in x.Fields) {
            var at = rest.FindIndex(f => string.Equals(f.Field, field, StringComparison.OrdinalIgnoreCase) && f.Value == value);
            if (at < 0) return false;
            rest.RemoveAt(at);
        }
        return true;
    }

    // The mappings an action writes (the values of its assignments and arguments, an event's arguments too), split.
    public static IEnumerable<(string Source, List<(string Field, string Value)> Fields)> MappingsOf(FlowItem action) =>
        action.Items.Where(i => i.Role == "node").SelectMany(Values).Select(Split).OfType<(string Source, List<(string Field, string Value)> Fields)>();

    private static IEnumerable<string> Values(FlowItem node) =>
        node.Items.Where(p => p.Role is "assignment" or "argument").Select(p => p.Prop("Value")).OfType<string>().Concat(node.Items.Where(p => p.Role == "event").SelectMany(Values));

    // Its source and fields; null when the expression is not one mapping whole.
    public static (string Source, List<(string Field, string Value)> Fields)? Split(string text)
    {
        var at = FlowSyntax.Scan(text, 0, [" mapTo {"]);
        if (at <= 0 || at >= text.Length) return null;
        var rest = text[(at + " mapTo ".Length)..].Trim();
        if (rest.Length < 2 || rest[0] != '{' || rest[^1] != '}') return null;
        var inner = rest[1..^1];
        if (FlowSyntax.Scan(inner, 0, []) != inner.Length) return null;
        var fields = new List<(string, string)>();
        for (var i = 0; i < inner.Length;) {
            var end = FlowSyntax.Scan(inner, i, [","]);
            if (end < 0) return null;
            var match = Entry.Match(inner[i..end].Trim());
            if (!match.Success) return null;
            fields.Add((match.Groups[1].Value, match.Groups[2].Value.Trim()));
            i = end + 1;
        }
        return fields.Count == 0 ? null : (text[..at].Trim(), fields);
    }

    // "Source mapTo { }" (any spaces inside the braces): an empty mapping, the conversion the platform makes on its own (ODC
    // keeps it in the expression as "Source mapTo {  }"; O11 converts by itself and does not parse it). Its source, the value
    // the text writes in both lanes; null for any other expression.
    public static string? WithoutEmpty(string text)
    {
        var at = FlowSyntax.Scan(text, 0, [" mapTo {"]);
        if (at <= 0 || at >= text.Length) return null;
        var rest = text[(at + " mapTo ".Length)..].Trim();
        return rest.Length >= 2 && rest[0] == '{' && rest[^1] == '}' && rest[1..^1].Trim().Length == 0 && text[..at].Trim() is { Length: > 0 } source ? source : null;
    }

    // An ODC record literal whole: "{ Field: value, Other: value }", its fields split as the text grammar scans (outside
    // "texts", #dates# and brackets); null when the expression is not one record literal.
    public static List<(string Field, string Value)>? SplitRecord(string text)
    {
        var rest = text.Trim();
        if (rest.Length < 2 || rest[0] != '{' || rest[^1] != '}' || FlowSyntax.Scan(rest, 0, []) != rest.Length) return null;
        var inner = rest[1..^1];
        if (FlowSyntax.Scan(inner, 0, []) != inner.Length) return null;
        var fields = new List<(string, string)>();
        for (var i = 0; i < inner.Length;) {
            var end = FlowSyntax.Scan(inner, i, [","]);
            if (end < 0) return null;
            var match = Entry.Match(inner[i..end].Trim());
            if (!match.Success || match.Groups[1].Value.Contains('.')) return null;
            fields.Add((match.Groups[1].Value, match.Groups[2].Value.Trim()));
            i = end + 1;
        }
        return fields.Count == 0 ? null : fields;
    }
}

// The owner of a screen, block or data action (a screen, block or email of the module), as the header of ssam-flow/1 writes
// it before the action's name: "action Home.Save", "data action Orders.GetOrders". The owner is written by its name; when two
// owners of the module share the name (screens of two UI flows), by its path from the module (Flow/Name). The reader and the
// way back use the same index, so the owner a read writes is the owner a text resolves.
public static class FlowOwners
{
    // The kinds an owner is: Reactive and Mobile screens and blocks (both lanes), Traditional screens, blocks and emails.
    private static readonly string[] Kinds = ["MobileScreen", "MobileBlock", "WebScreen", "WebBlock", "WebEmail"];
    private static readonly string[] Flows = ["UIFlow", "MobileFlow", "WebFlow"];

    // The kinds of action that belong to an owner (the others belong to the module).
    public static bool Owned(string kind) => kind is "ScreenAction" or "DataAction";

    // A written owner: a name, or a path of names (Flow/Name).
    public static bool Valid(string text) => text.Length > 0 && text.Split('/').All(FlowSyntax.IsIdentifier);

    internal static bool IsOwner<T>(ModelReader<T> reader, T node) where T : class => Kinds.Any(k => reader.IsKind(node, k));

    // Its path from the module: the names of the elements between the module and it.
    internal static string PathOf<T>(ModelReader<T> reader, T root, T owner) where T : class
    {
        var path = new List<string>();
        for (var at = (T?)owner; at != null && !ReferenceEquals(at, root); at = reader.ParentOf(at)) path.Insert(0, reader.DisplayOf(at));
        return string.Join("/", path);
    }

    // The owners of a module by name, kept per module object (the reader and every text of a job read the same module).
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<object, object> Indexes = new();

    // The owners of the module by name, without case: the screens, blocks and emails of its UI flows (and any directly under
    // it). Built again when an owner or a name is not in it (a screen created or renamed since).
    private static Dictionary<string, List<T>> ByName<T>(ModelReader<T> reader, T root, bool fresh) where T : class
    {
        if (!fresh && Indexes.TryGetValue(root, out var held) && held is Dictionary<string, List<T>> cached) return cached;
        var index = new Dictionary<string, List<T>>(StringComparer.OrdinalIgnoreCase);
        void Add(T owner) { var name = reader.DisplayOf(owner); (index.TryGetValue(name, out var list) ? list : index[name] = []).Add(owner); }
        foreach (var child in reader.ChildrenOf(root)) {
            if (IsOwner(reader, child)) { Add(child); continue; }
            if (Flows.Any(f => reader.IsKind(child, f)) || reader.KindOf(child).EndsWith("Flow", StringComparison.Ordinal))
                foreach (var grandchild in reader.ChildrenOf(child)) if (IsOwner(reader, grandchild)) Add(grandchild);
        }
        Indexes.AddOrUpdate(root, index);
        return index;
    }

    // How the header writes this owner: its name, or its path when another owner of the module has the same name.
    public static string Text<T>(ModelReader<T> reader, T root, T owner) where T : class
    {
        var name = reader.DisplayOf(owner);
        var index = ByName(reader, root, false);
        if (!index.TryGetValue(name, out var same) || !same.Any(o => ReferenceEquals(o, owner))) index = ByName(reader, root, true);
        return index.TryGetValue(name, out same) && same.Any(o => !ReferenceEquals(o, owner)) ? PathOf(reader, root, owner) : name;
    }

    // The owners a written owner names: by name (without case), or by path when it has one.
    public static List<T> Find<T>(ModelReader<T> reader, T root, string text) where T : class
    {
        var last = text[(text.LastIndexOf('/') + 1)..];
        List<T> Match(Dictionary<string, List<T>> index) => (index.GetValueOrDefault(last) ?? [])
            .Where(o => !text.Contains('/') || string.Equals(PathOf(reader, root, o), text, StringComparison.OrdinalIgnoreCase)).ToList();
        var found = Match(ByName(reader, root, false));
        return found.Count > 0 ? found : Match(ByName(reader, root, true));
    }

    // Every owner of the module (the nearest names of an owner the text names wrong).
    public static IEnumerable<string> Names<T>(ModelReader<T> reader, T root) where T : class => ByName(reader, root, true).Keys;

    // Whether two written owners can name the same owner (the same text without case, or a path and the name it ends in).
    public static bool Same(string a, string b) =>
        string.Equals(a, b, StringComparison.OrdinalIgnoreCase)
        || a.Contains('/') != b.Contains('/') && string.Equals(a[(a.LastIndexOf('/') + 1)..], b[(b.LastIndexOf('/') + 1)..], StringComparison.OrdinalIgnoreCase);
}

// Lexical rules shared by the printer and the parser.
internal static class FlowSyntax
{
    private static readonly JsonSerializerOptions Relaxed = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    public static string Json(string text) => JsonSerializer.Serialize(text, Relaxed);

    // A JSON string literal starting at line[i] (a '"'); i moves past it.
    public static string ReadJson(string line, ref int i)
    {
        if (i >= line.Length || line[i] != '"') throw new FormatException("expected a JSON string at column " + (i + 1));
        var start = i++;
        while (i < line.Length) {
            if (line[i] == '\\') { i += 2; continue; }
            if (line[i] == '"') { i++; return JsonSerializer.Deserialize<string>(line.AsSpan(start, i - start)) ?? ""; }
            i++;
        }
        throw new FormatException("unterminated JSON string at column " + (start + 1));
    }

    // Characters that end a line or are invisible controls: a text holding them never prints as plain text.
    public static bool Breaks(char c) => c < 0x20 && c != (char)9 || c == (char)0x85 || c == (char)0x2028 || c == (char)0x2029 || c == (char)0x7f;
    public static bool HasBreaks(string text) { foreach (var c in text) if (Breaks(c)) return true; return false; }
    // A text that prints line by line (descriptions, comments, code): every character but CR and the controls.
    public static bool Lines(string text) { foreach (var c in text) if (c != '\n' && Breaks(c)) return false; return true; }

    // The escaped expression: `...` with \\ \` \n \r \t and \uXXXX for the other controls. It holds any text.
    public static string Escape(string text)
    {
        var builder = new StringBuilder(text.Length + 2).Append('`');
        foreach (var c in text) {
            switch (c) {
                case '\\': builder.Append("\\\\"); break;
                case '`': builder.Append("\\`"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (Breaks(c)) builder.Append("\\u").Append(((int)c).ToString("x4")); else builder.Append(c);
                    break;
            }
        }
        return builder.Append('`').ToString();
    }

    public static string ReadEscaped(string line, ref int i)
    {
        if (i >= line.Length || line[i] != '`') throw new FormatException("expected ` at column " + (i + 1));
        var start = i++;
        var builder = new StringBuilder();
        while (i < line.Length) {
            var c = line[i];
            if (c == '`') { i++; return builder.ToString(); }
            if (c == '\\') {
                if (i + 1 >= line.Length) break;
                var next = line[i + 1];
                switch (next) {
                    case '\\': builder.Append('\\'); i += 2; continue;
                    case '`': builder.Append('`'); i += 2; continue;
                    case 'n': builder.Append('\n'); i += 2; continue;
                    case 'r': builder.Append('\r'); i += 2; continue;
                    case 't': builder.Append('\t'); i += 2; continue;
                    case 'u' when i + 5 < line.Length:
                        builder.Append((char)Convert.ToInt32(line.Substring(i + 2, 4), 16)); i += 6; continue;
                }
                throw new FormatException("invalid escape \\" + next + " at column " + (i + 1));
            }
            builder.Append(c); i++;
        }
        throw new FormatException("unterminated ` at column " + (start + 1));
    }

    // Scans an OutSystems expression from i to the first top-level terminator (outside "strings" with "" escapes, #date
    // literals# and brackets). Returns that index, line.Length at the end, or -1 when a literal or bracket is left open or a
    // closing bracket has no opening one before a terminator.
    public static int Scan(string line, int i, string[] terminators)
    {
        var depth = 0;
        while (i < line.Length) {
            if (depth == 0)
                foreach (var terminator in terminators)
                    if (string.CompareOrdinal(line, i, terminator, 0, terminator.Length) == 0) return i;
            var c = line[i];
            if (c == '"') {
                i++;
                while (true) {
                    if (i >= line.Length) return -1;
                    if (line[i] == '"') { if (i + 1 < line.Length && line[i + 1] == '"') { i += 2; continue; } break; }
                    i++;
                }
                i++; continue;
            }
            if (c == '#') { var end = line.IndexOf('#', i + 1); if (end < 0) return -1; i = end + 1; continue; }
            if (c is '(' or '[' or '{') depth++;
            else if (c is ')' or ']' or '}') { if (depth == 0) return -1; depth--; }
            i++;
        }
        return depth == 0 ? line.Length : -1;
    }

    // An expression prints plain in a slot with these terminators when reading the slot gives it back whole: one line,
    // no space at either end, not starting with ` and no top-level terminator inside. Otherwise it prints escaped.
    public static bool Plain(string expression, string[] terminators) =>
        expression.Length > 0 && expression[0] != '`' && !char.IsWhiteSpace(expression[0]) && !char.IsWhiteSpace(expression[^1])
        && !HasBreaks(expression) && Scan(expression, 0, terminators) == expression.Length;

    public static string Expr(string expression, string[] terminators) => Plain(expression, terminators) ? expression : Escape(expression);

    // Reads one expression slot: escaped, or plain up to the first top-level terminator.
    public static string ReadExpr(string line, ref int i, string[] terminators)
    {
        if (i < line.Length && line[i] == '`') return ReadEscaped(line, ref i);
        var end = Scan(line, i, terminators);
        if (end < 0) throw new FormatException("unbalanced expression at column " + (i + 1) + ": " + line[i..]);
        var text = line[i..end];
        i = end;
        return text;
    }

    public static bool IsIdentifier(string text) =>
        text.Length > 0 && (char.IsLetter(text[0]) || text[0] == '_') && text.All(c => char.IsLetterOrDigit(c) || c == '_');

    // A short element id of the text (@n12, @p3, @l1) or a model key (@+3mRCJAK_Ey+D9No+edA8g).
    public static bool IsKeyToken(string text) => text.Length > 0 && text.All(c => char.IsLetterOrDigit(c) || c is '+' or '/' or '_' or '-' or '=' or '.' or '#');

    // Every keyed line ends with " @<key>": split it off (the key is always the last token of the line).
    public static bool SplitKey(string content, out string head, out string key)
    {
        var at = content.LastIndexOf(" @", StringComparison.Ordinal);
        head = key = "";
        if (at < 0) return false;
        var token = content[(at + 2)..];
        if (!IsKeyToken(token)) return false;
        head = content[..at]; key = token;
        return true;
    }

    // ---- @{...}: properties without a word of their own --------------------------------------------------------------
    // Name=value pairs separated by one space: True/enum/number bare, "json" text, `escaped` expression, &"json" reference,
    // v"json" for a value that is not a bare token.
    public static bool Bare(string text) => text.Length > 0 && text.All(c => char.IsLetterOrDigit(c) || c is '_' or '.' or '+' or '-');

    public static string Passthrough(IEnumerable<KeyValuePair<string, FlowValue>> props)
    {
        var builder = new StringBuilder("@{");
        var first = true;
        foreach (var (name, value) in props) {
            if (!first) builder.Append(' ');
            first = false;
            builder.Append(name).Append('=').Append(value.Type switch {
                'e' => Escape(value.Text),
                't' => Json(value.Text),
                'r' => "&" + Json(value.Text),
                _ => Bare(value.Text) ? value.Text : "v" + Json(value.Text)
            });
        }
        return builder.Append('}').ToString();
    }

    public static List<KeyValuePair<string, FlowValue>> ReadPassthrough(string text)
    {
        var result = new List<KeyValuePair<string, FlowValue>>();
        if (!text.StartsWith("@{", StringComparison.Ordinal) || !text.EndsWith('}')) throw new FormatException("expected @{...}: " + text);
        var i = 2;
        while (i < text.Length - 1) {
            var eq = text.IndexOf('=', i);
            if (eq < 0) throw new FormatException("expected Name=value in " + text);
            var name = text[i..eq];
            if (!IsIdentifier(name)) throw new FormatException("bad property name " + name);
            i = eq + 1;
            FlowValue value;
            switch (text[i]) {
                case '`': value = new('e', ReadEscaped(text, ref i)); break;
                case '"': value = new('t', ReadJson(text, ref i)); break;
                case '&': i++; value = new('r', ReadJson(text, ref i)); break;
                case 'v' when i + 1 < text.Length && text[i + 1] == '"': i++; value = new('v', ReadJson(text, ref i)); break;
                default: {
                    var start = i;
                    while (i < text.Length - 1 && text[i] != ' ') i++;
                    value = new('v', text[start..i]);
                    break;
                }
            }
            result.Add(new(name, value));
            if (i < text.Length - 1) {
                if (text[i] != ' ') throw new FormatException("expected a space after " + name + " in " + text);
                i++;
            }
        }
        return result;
    }
}
