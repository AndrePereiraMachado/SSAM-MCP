using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// The mechanical rewrites of C19 (atritos 3 package), one pure place for the preflight rules that report them with their
/// patch (ExpressionRules, OdcPlatformRules) and for the pass that applies them (<see cref="Apply"/>):
/// <list type="bullet">
/// <item><c>a mod b</c> is <c>Mod(a, b)</c> where the lane has the built-in Mod, else <c>(a - Trunc(a / b) * b)</c>; mod binds
/// like * and / (left to right), so <c>i + 1 mod 3</c> is <c>i + Mod(1, 3)</c> and <c>a * b mod c</c> is <c>Mod(a * b, c)</c>.
/// The agents of an O11 client migration wrote it 32 times (O11: ParserUnexpectedElement), the QuizLive session on ODC too.</item>
/// <item><c>X.Current.Value</c> on a list of a basic type (Text List, Integer List, ...) is <c>X.Current</c>: the Current of such a
/// list is the value itself (ExpressionUnknownObject, 111 messages, <c>ReadSignals.Signals.Current.Value</c>).</item>
/// </list>
/// </summary>
public static class ExpressionRewrites
{
    /// <summary>One rewrite: where (a JSON pointer in the job), the text before and after.</summary>
    public sealed record Rewrite(string Path, string From, string To);

    private static readonly HashSet<string> Basic = new(StringComparer.OrdinalIgnoreCase)
    {
        "Text", "Integer", "Long Integer", "LongInteger", "Decimal", "Boolean", "Date", "Time", "Date Time", "DateTime", "Currency",
        "Email", "Phone Number", "PhoneNumber", "Binary Data", "BinaryData", "Long Text",
    };

    /// <summary>The element type of a `T List` declaration, or null when the type is not a list.</summary>
    public static string? ListElement(string? type)
    {
        var t = type?.Trim() ?? "";
        if (!t.EndsWith(" List", StringComparison.OrdinalIgnoreCase)) return null;
        var element = t[..^" List".Length].Trim();
        return element.Length == 0 ? null : element;
    }

    /// <summary>A basic type (Text, Integer, ..., an Identifier): the Current of a list of it is the value, with no members.</summary>
    public static bool IsBasic(string type) => Basic.Contains(type.Trim()) || type.Trim().EndsWith(" Identifier", StringComparison.OrdinalIgnoreCase);

    /// <summary>Whether the lane has the built-in Mod (the Studio's registry, or the checked-in O11 catalog).</summary>
    public static bool HasMod(string lane) => Builtins.Get("Mod", lane) != null;

    /// <summary>The expression with every `a mod b` written with the function, or null when it has none (or its parentheses do
    /// not balance: the Studio's parser judges that text).</summary>
    public static string? Mod(string text, bool hasModFunction)
    {
        var tokens = ExpressionText.Tokens(text);
        if (!tokens.Any(IsMod)) return null;
        try { return new ModWriter(text, tokens, hasModFunction).Render(0, tokens.Count); }
        catch (InvalidOperationException) { return null; }
    }

    private static bool IsMod(Token t) => t.Kind == TokenKind.Operator && t.Is("mod");

    private sealed class ModWriter(string text, List<Token> tokens, bool function)
    {
        private string Source(int from, int to) => from >= to ? "" : text[tokens[from].Start..(tokens[to - 1].Start + tokens[to - 1].Text.Length)];

        private int Close(int open)
        {
            var depth = 0;
            for (var k = open; k < tokens.Count; k++)
            {
                if (tokens[k].Kind is TokenKind.Open or TokenKind.OpenIndex) depth++;
                else if (tokens[k].Kind is TokenKind.Close or TokenKind.CloseIndex && --depth == 0) return k;
            }
            throw new InvalidOperationException("unbalanced");
        }

        /// <summary>The tokens [from, to) as text: as written when no mod is among them, rebuilt otherwise.</summary>
        public string Render(int from, int to)
        {
            if (!tokens.Skip(from).Take(to - from).Any(IsMod)) return Source(from, to);
            var items = new List<(bool Operator, string Text)>();
            var operand = true;
            var k = from;
            while (k < to)
            {
                var t = tokens[k];
                if (!operand && t.Kind == TokenKind.Operator) { items.Add((true, t.Text)); operand = true; k++; continue; }
                if (operand && t.Kind == TokenKind.Operator && t.Is("not")) { items.Add((true, t.Text)); k++; continue; }
                var prefix = "";
                while (k < to && tokens[k].Kind == TokenKind.Operator && tokens[k].Text == "-") { prefix += "-"; k++; }
                if (k >= to) throw new InvalidOperationException("operand expected");
                string body;
                if (tokens[k].Kind == TokenKind.Open) { var close = Close(k); body = "(" + Render(k + 1, close) + ")"; k = close + 1; }
                else if (tokens[k].Kind == TokenKind.Name && k + 1 < to && tokens[k + 1].Kind == TokenKind.Open)
                {
                    var close = Close(k + 1);
                    body = tokens[k].Text + "(" + Arguments(k + 2, close) + ")";
                    k = close + 1;
                }
                else if (tokens[k].Kind is TokenKind.Name or TokenKind.Number or TokenKind.Text or TokenKind.Date) { body = tokens[k].Text; k++; }
                else throw new InvalidOperationException("operand expected");
                // what continues the operand: an index, a member after it
                while (k < to && (tokens[k].Kind == TokenKind.OpenIndex || tokens[k].Kind == TokenKind.Other && tokens[k].Text == "."
                    || tokens[k].Kind == TokenKind.Name && tokens[k].Text.StartsWith('.') || tokens[k].Kind == TokenKind.Name && k > 0 && tokens[k - 1].Kind == TokenKind.Other && tokens[k - 1].Text == "."))
                {
                    if (tokens[k].Kind == TokenKind.OpenIndex) { var close = Close(k); body += "[" + Render(k + 1, close) + "]"; k = close + 1; }
                    else { body += tokens[k].Text; k++; }
                }
                items.Add((false, prefix + body));
                operand = false;
            }
            var output = new List<string>();
            for (var i = 0; i < items.Count;)
            {
                if (items[i].Operator) { output.Add(items[i].Text); i++; continue; }
                var term = items[i].Text; i++;
                while (i + 1 < items.Count && items[i].Operator && !items[i + 1].Operator && (items[i].Text is "*" or "/" || items[i].Text.Equals("mod", StringComparison.OrdinalIgnoreCase)))
                {
                    var right = items[i + 1].Text;
                    term = items[i].Text.Equals("mod", StringComparison.OrdinalIgnoreCase)
                        ? function ? $"Mod({term}, {right})" : $"({term} - Trunc({term} / {right}) * {right})"
                        : $"{term} {items[i].Text} {right}";
                    i += 2;
                }
                output.Add(term);
            }
            return string.Join(" ", output);
        }

        private string Arguments(int from, int close)
        {
            var parts = new List<string>(); var start = from; var depth = 0;
            for (var k = from; k < close; k++)
            {
                if (tokens[k].Kind is TokenKind.Open or TokenKind.OpenIndex) depth++;
                else if (tokens[k].Kind is TokenKind.Close or TokenKind.CloseIndex) depth--;
                else if (tokens[k].Kind == TokenKind.Comma && depth == 0) { parts.Add(Render(start, k)); start = k + 1; }
            }
            if (close > from) parts.Add(Render(start, close));
            return string.Join(", ", parts);
        }
    }

    /// <summary>The expression with `X.Current.&lt;member&gt;` written `X.Current` for every X the caller says is a list of a basic
    /// type (<paramref name="basicList"/>: the path before `.Current`, e.g. `Signals` or `ReadSignals.Signals`).</summary>
    public static string? BasicCurrent(string text, Func<string, bool> basicList)
    {
        var tokens = ExpressionText.Tokens(text);
        string? result = null; var shift = 0;
        foreach (var t in tokens)
        {
            if (t.Kind != TokenKind.Name || t.Text.StartsWith('.')) continue;
            var parts = t.Segments;
            for (var c = 1; c + 1 < parts.Length; c++)
            {
                if (!parts[c].Equals("Current", StringComparison.OrdinalIgnoreCase) || !basicList(string.Join(".", parts.Take(c)))) continue;
                var written = string.Join(".", parts.Take(c + 1));
                result ??= text;
                result = result[..(t.Start + shift)] + written + result[(t.Start + shift + t.Text.Length)..];
                shift += written.Length - t.Text.Length;
                break;
            }
        }
        return result;
    }

    /// <summary>Applies both rewrites to the logic expressions and to the expression properties a raw `set` writes, in place,
    /// and returns what changed (the receipt's expressionRewrites, <c>[{path, from, to}]</c>). The `.Current.Value` rewrite
    /// follows what the job declares (inputs, outputs and variables of the action; outputs of a callee of the job) and what
    /// <paramref name="model"/> says of a callee of the base or of a producer. Never throws: an expression it cannot read stays.</summary>
    public static List<Rewrite> Apply(JsonArray ops, string lane, string? prefix = "/ops", IBaseFacts? model = null)
    {
        var done = new List<Rewrite>();
        var function = HasMod(lane);
        var job = JobFacts.From(ops);
        foreach (var action in job.Actions)
        {
            LogicScan scan;
            try { scan = LogicScan.Of(action.Declaration); }
            catch { continue; }
            var lists = action.Locals.Where(l => ListElement(l.Type) is { } e && IsBasic(e)).Select(l => l.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
            bool BasicList(string path)
            {
                if (lists.Contains(path)) return true;
                var dot = path.IndexOf('.');
                if (dot < 0 || !scan.Nodes.TryGetValue(path[..dot], out var node) || node.Kind != "call" || node.Target is not { } target) return false;
                var outputs = job.Callee(target, action)?.Outputs ?? model?.Callee(target, action.Declaration)?.Outputs;
                var output = outputs?.FirstOrDefault(o => o.Name.Equals(path[(dot + 1)..], StringComparison.OrdinalIgnoreCase));
                return ListElement(output?.Type) is { } element && IsBasic(element);
            }
            foreach (var site in scan.Expressions)
            {
                var text = site.Text;
                var written = BasicCurrent(text, BasicList) ?? text;
                written = Mod(written, function) ?? written;
                if (written == text || !Write(action.Declaration, site.Pointer, text, written)) continue;
                done.Add(new Rewrite($"{prefix}/{action.Op}/data/actions/{action.Index}{site.Pointer}", text, written));
            }
        }
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "set" || op["prop"]?.ToString() is not ("Value" or "Condition" or "Expression" or "DefaultValue" or "Visible" or "Enabled" or "Style")
                || op["value"] is not JsonValue v || !v.TryGetValue<string>(out var text)) continue;
            if (Mod(text, function) is not { } written) continue;
            op["value"] = written;
            done.Add(new Rewrite($"{prefix}/{i}/value", text, written));
        }
        return done;
    }

    /// <summary>Writes <paramref name="value"/> at <paramref name="pointer"/> (relative to the action) when the string there is
    /// exactly the expression read (a sort with its direction, for one, is not rewritten).</summary>
    internal static bool Write(JsonObject action, string pointer, string expected, string value)
    {
        var segments = pointer.Split('/', StringSplitOptions.RemoveEmptyEntries).Select(s => s.Replace("~1", "/").Replace("~0", "~")).ToArray();
        JsonNode? node = action;
        for (var k = 0; k < segments.Length - 1; k++)
            node = node switch
            {
                JsonObject o => o[segments[k]],
                JsonArray a when int.TryParse(segments[k], out var index) && index < a.Count => a[index],
                _ => null,
            };
        var last = segments[^1];
        switch (node)
        {
            case JsonObject o when o[last] is JsonValue v && v.TryGetValue<string>(out var s) && s == expected: o[last] = value; return true;
            case JsonArray a when int.TryParse(last, out var index) && index < a.Count && a[index] is JsonValue v && v.TryGetValue<string>(out var s) && s == expected: a[index] = value; return true;
            default: return false;
        }
    }
}
