using System.Collections;
using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.CSharp.Tests;

/// <summary>
/// Executes emitted native logic for compiler tests, never source, Roslyn operations, or assemblies.
/// Native records and lists are copied at every assignment and ordinary action boundary. This is
/// deliberately stricter than CLR object aliasing: an arena mutation must have an emitted writeback.
/// This probe is not O11 Verify and does not establish server execution behavior.
/// </summary>
internal sealed class ReferenceGraphProbe
{
    internal sealed class Failure(string kind, string message) : Exception(message)
    {
        public string Kind => kind;
    }

    private enum Flow { Next, Return, Break, Continue }
    private readonly Dictionary<string, JsonObject> actions;
    private readonly Dictionary<string, JsonObject> structures;
    private readonly bool shareNativeListStorage;
    [ThreadStatic] private static bool sharedListCopies;
    internal Func<JsonObject, IReadOnlyDictionary<string, object>, Dictionary<string, object>>? DataEffect { get; set; }
    private int remainingSteps;

    public ReferenceGraphProbe(JsonObject specification, bool shareNativeListStorage = false)
    {
        this.shareNativeListStorage = shareNativeListStorage;
        var snapshot = (JsonObject)specification.DeepClone();
        actions = Objects(snapshot["logic"]?["actions"])
            .ToDictionary(a => Required(a, "name"), StringComparer.Ordinal);
        structures = Objects(snapshot["data"]?["structures"])
            .Concat(Objects(snapshot["data"]?["entities"]))
            .ToDictionary(s => Required(s, "name"), StringComparer.Ordinal);
        foreach (var entity in Objects(snapshot["data"]?["entities"]))
        {
            var fields = entity["attributes"]!.AsArray();
            if (!fields.Any(f => f!["name"]!.ToString() == "Id"))
                fields.Insert(0, new JsonObject { ["name"] = "Id", ["type"] = entity["idType"]?.ToString() ?? "Long Integer" });
        }
    }

    public Dictionary<string, object> Run(string actionName, IReadOnlyDictionary<string, object>? inputs = null)
    {
        remainingSteps = 100_000;
        var previous = sharedListCopies;
        sharedListCopies = shareNativeListStorage;
        try { return Invoke(actionName, inputs ?? new Dictionary<string, object>(), 0); }
        finally { sharedListCopies = previous; }
    }

    private Dictionary<string, object> Invoke(string name, IReadOnlyDictionary<string, object> inputs, int depth)
    {
        if (depth > 128) throw new InvalidOperationException("Unbounded emitted action recursion.");
        if (name == FrameworkIntrinsic.CompareOrdinal.Reference)
            return new() { ["Result"] = (decimal)string.CompareOrdinal((string)inputs["Left"], (string)inputs["Right"]) };
        if (name == FrameworkIntrinsic.Utf16Length.Reference)
            return new Dictionary<string, object> { ["Result"] = (decimal)((string)inputs["Value"]).Length };
        if (name == FrameworkIntrinsic.Trim.Reference)
        {
            var text = (string)inputs["Value"];
            var leading = (bool)inputs["Leading"];
            var trailing = (bool)inputs["Trailing"];
            return new Dictionary<string, object> { ["Result"] = leading
                ? trailing ? text.Trim() : text.TrimStart()
                : trailing ? text.TrimEnd() : text };
        }
        if (!actions.TryGetValue(name, out var action))
            throw new InvalidOperationException("Unsupported emitted action: " + name);

        var values = new Dictionary<string, object>(StringComparer.Ordinal);
        var declaredInputs = Objects(action["inputs"]).ToArray();
        foreach (var parameter in declaredInputs.Concat(Objects(action["outputs"])).Concat(Objects(action["vars"])))
        {
            var parameterName = Required(parameter, "name");
            values.Add(parameterName, Default(Required(parameter, "type"), new HashSet<string>(StringComparer.Ordinal)));
            if (parameter["default"] is { } defaultValue)
                values[parameterName] = Copy(Eval(values, defaultValue.ToString()));
        }
        foreach (var input in inputs)
        {
            if (!declaredInputs.Any(p => Required(p, "name") == input.Key))
                throw new InvalidOperationException($"Unknown emitted input {name}.{input.Key}.");
            values[input.Key] = Copy(input.Value);
        }

        Flow flow;
        try { flow = Steps(action["steps"] as JsonArray, values, depth); }
        catch (ArithmeticException)
        {
            // Real arithmetic failures produced by evaluation follow the emitted
            // native handler. Probe/parser errors stay outside business handling.
            var handler = Objects(action["handlers"]).FirstOrDefault(h => h["exception"]?.ToString() == "@espace/AllExceptions");
            if (handler == null) throw;
            flow = Steps(handler["steps"] as JsonArray, values, depth);
        }
        if (flow is Flow.Break or Flow.Continue)
            throw new InvalidOperationException("Emitted loop control escaped its loop in " + name + ".");
        return Objects(action["outputs"]).ToDictionary(p => Required(p, "name"),
            p => Copy(values[Required(p, "name")]), StringComparer.Ordinal);
    }

    private object Default(string type, HashSet<string> constructing)
    {
        if (type.EndsWith(" List", StringComparison.Ordinal)) return new List<object>();
        if (type.EndsWith(" Identifier", StringComparison.Ordinal)) return 0m;
        if (structures.TryGetValue(type, out var structure))
        {
            if (!constructing.Add(type))
                throw new InvalidOperationException("Recursive native record without a list boundary: " + type);
            try
            {
                return Objects(structure["attributes"]).ToDictionary(a => Required(a, "name"),
                    a => Default(Required(a, "type"), constructing), StringComparer.Ordinal);
            }
            finally { constructing.Remove(type); }
        }
        return type switch
        {
            "Boolean" => false,
            "Text" or "Email" or "Phone Number" => "",
            "Integer" or "Long Integer" or "Decimal" or "Currency" => 0m,
            "Binary Data" => Array.Empty<byte>(),
            "Date" or "Date Time" => new DateTime(1900, 1, 1),
            "Time" => TimeSpan.Zero,
            _ => throw new InvalidOperationException("Unsupported emitted native type: " + type)
        };
    }

    private Flow Steps(JsonArray? steps, Dictionary<string, object> values, int depth)
    {
        foreach (var node in Objects(steps))
        {
            Tick();
            if (node["assign"] is JsonObject assignments)
            {
                foreach (var assignment in assignments)
                {
                    // Resolve the l-value before its RHS, including every receiver and index.
                    var place = new Expression(values, assignment.Key).Path();
                    place.Write(Eval(values, assignment.Value!.ToString()));
                }
            }
            else if (node["if"] is { } condition)
            {
                var flow = Steps(node[Truth(Eval(values, condition.ToString())) ? "then" : "else"] as JsonArray, values, depth);
                if (flow != Flow.Next) return flow;
            }
            else if (node["switch"] is JsonArray alternatives)
            {
                var selected = Objects(alternatives).FirstOrDefault(arm => Truth(Eval(values, Required(arm, "when"))));
                var flow = Steps((selected == null ? node["otherwise"] : selected["steps"]) as JsonArray, values, depth);
                if (flow is Flow.Return or Flow.Continue) return flow;
            }
            else if (node["while"] is { } conditionLoop)
            {
                while (Truth(Eval(values, conditionLoop.ToString())))
                {
                    Tick();
                    var body = Steps(node["do"] as JsonArray, values, depth);
                    if (body == Flow.Return) return body;
                    if (body == Flow.Break) break;
                    // A continue in a for-loop still runs its emitted increment section.
                    var next = Steps(node["next"] as JsonArray, values, depth);
                    if (next == Flow.Return) return next;
                    if (next == Flow.Break) break;
                }
            }
            else if (node["foreach"] is { } sequence)
            {
                var list = (List<object>)Eval(values, sequence.ToString());
                // Native query lists expose Current on the list, not on its owning action.
                var prior = activeCurrent.GetValueOrDefault(list);
                try
                {
                    foreach (var item in list)
                    {
                        activeCurrent[list] = item;
                        var flow = Steps(node["do"] as JsonArray, values, depth);
                        if (flow == Flow.Return) return flow;
                        if (flow == Flow.Break) break;
                    }
                }
                finally { if (prior == null) activeCurrent.Remove(list); else activeCurrent[list] = prior; }
            }
            else if (node.ContainsKey("get") || node.ContainsKey("create") || node.ContainsKey("update") || node.ContainsKey("delete"))
            {
                if (DataEffect == null) throw new InvalidOperationException("Emitted data operation requires an explicit test data boundary.");
                var arguments = new Dictionary<string, object>(StringComparer.Ordinal);
                if (node["params"] is JsonObject parameters)
                    foreach (var parameter in parameters) arguments.Add(parameter.Key, Copy(Eval(values, Required(parameter.Value!.AsObject(), "value"))));
                foreach (var key in new[] { "record", "id" })
                    if (node[key] is { } expression) arguments.Add(key, Copy(Eval(values, expression.ToString())));
                var response = DataEffect((JsonObject)node.DeepClone(), arguments);
                if (node["as"] is { } name) values[name.ToString()] = Copy(response);
            }
            else if (node["call"] is { } called)
                Call(called.ToString(), node, values, depth);
            else if (node["raise"] is { } raised)
                throw new Failure(raised.ToString(), node["message"] is { } message ? Text(Eval(values, message.ToString())) : "");
            else if (node.ContainsKey("return")) return Flow.Return;
            else if (node.ContainsKey("break")) return Flow.Break;
            else if (node.ContainsKey("continue")) return Flow.Continue;
            else throw new InvalidOperationException("Unsupported emitted step: " + node.ToJsonString());
        }
        return Flow.Next;
    }

    private void Call(string name, JsonObject node, Dictionary<string, object> values, int depth)
    {
        var args = node["args"] as JsonObject ?? new JsonObject();
        Dictionary<string, object> outputs;
        if (name is "ListAppend" or "ListAppendAll" or "ListRemove" or "ListReplace" or "ListClear")
        {
            var listPlace = new Expression(values, Required(args, "List")).Path();
            if (listPlace.Read() is not List<object> list)
                throw new InvalidOperationException(name + " requires a native list path.");
            switch (name)
            {
                case "ListAppend":
                    list.Add(Copy(Eval(values, Required(args, "Element"))));
                    break;
                case "ListReplace":
                    var position = Index(Eval(values, Required(args, "Position")));
                    var element = Copy(Eval(values, Required(args, "Element")));
                    list[position] = element;
                    break;
                case "ListAppendAll":
                    list.AddRange(((List<object>)Eval(values, Required(args, "SourceList"))).Select(Copy));
                    break;
                case "ListRemove":
                    list.RemoveAt(Index(Eval(values, Required(args, "Position"))));
                    break;
                case "ListClear":
                    list.Clear();
                    break;
            }
            outputs = new Dictionary<string, object>(StringComparer.Ordinal);
        }
        else
        {
            // Copy each argument independently, even if two expressions read the same record/list.
            var arguments = args.ToDictionary(p => p.Key, p => Copy(Eval(values, p.Value!.ToString())), StringComparer.Ordinal);
            outputs = Invoke(name, arguments, depth + 1);
        }
        if (node["as"] is { } alias) values[alias.ToString()] = Copy(outputs);
    }

    private void Tick()
    {
        if (--remainingSteps < 0) throw new InvalidOperationException("Unbounded emitted logic exceeded the probe step limit.");
    }

    private static IEnumerable<JsonObject> Objects(JsonNode? node)
        => node is JsonArray array ? array.Select(item => item as JsonObject
            ?? throw new InvalidOperationException("Expected an emitted object.")) : Enumerable.Empty<JsonObject>();

    private static string Required(JsonObject node, string key)
        => node[key]?.ToString() ?? throw new InvalidOperationException("Missing emitted property: " + key);

    private static object Copy(object value)
    {
        if (value is null) return null!;
        if (sharedListCopies && value is List<object>) return value;
        if (value is byte[] bytes) return bytes.ToArray();
        if (value is IReadOnlyDictionary<string, object> readOnly)
            return readOnly.ToDictionary(p => p.Key, p => Copy(p.Value), StringComparer.Ordinal);
        if (value is IDictionary dictionary)
        {
            var copied = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (DictionaryEntry entry in dictionary)
                copied.Add((string)entry.Key, Copy(entry.Value!));
            return copied;
        }
        if (value is IEnumerable sequence && value is not string)
            return sequence.Cast<object>().Select(Copy).ToList();
        if (value is byte or sbyte or short or ushort or int or uint or long or ulong or decimal)
            return Convert.ToDecimal(value, CultureInfo.InvariantCulture);
        if (value is bool or string or DateTime or TimeSpan) return value;
        throw new InvalidOperationException("Unsupported probe value: " + value.GetType().FullName);
    }

    private static object Eval(Dictionary<string, object> values, string text) => new Expression(values, text).Evaluate();
    private static decimal Number(object value)
        => value is byte or sbyte or short or ushort or int or uint or long or ulong or decimal
            ? Convert.ToDecimal(value, CultureInfo.InvariantCulture)
            : throw new InvalidOperationException("Expected an emitted numeric value.");
    private static bool Truth(object value) => value is bool boolean ? boolean : Number(value) != 0;
    private static string Text(object value) => Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
    private static int Index(object value)
    {
        var number = Number(value);
        if (number != decimal.Truncate(number)) throw new InvalidOperationException("A native list index must be an integer.");
        return checked((int)number);
    }

    [ThreadStatic] private static Dictionary<List<object>, object>? currentRows;
    private static Dictionary<List<object>, object> activeCurrent => currentRows ??= new(ReferenceEqualityComparer.Instance);
    private static object Member(object owner, string member)
    {
        if (owner is Dictionary<string, object> fields && fields.TryGetValue(member, out var value)) return value;
        if (owner is List<object> list && member == "Length") return (decimal)list.Count;
        if (owner is List<object> rows && member == "Empty") return rows.Count == 0;
        if (owner is List<object> items && member == "Current") return activeCurrent.TryGetValue(items, out var current) ? current : items[0];
        if (owner is string text && member == "Length") return (decimal)text.Length;
        throw new InvalidOperationException("Unknown emitted member: " + member);
    }

    private static object Item(object owner, object index)
        => owner is List<object> list ? list[Index(index)]
            : throw new InvalidOperationException("Emitted indexing requires a native list.");

    private sealed class Place(object owner, object key)
    {
        public object Read() => key is string member ? Member(owner, member) : Item(owner, key);
        public void Write(object value)
        {
            var copy = Copy(value);
            if (owner is Dictionary<string, object> fields && key is string member && fields.ContainsKey(member))
                fields[member] = copy;
            else if (owner is List<object> list && key is int index) list[index] = copy;
            else throw new InvalidOperationException("Unknown emitted assignment target: " + key);
        }
    }

    private sealed class Expression
    {
        private static readonly Regex Token = new("\\G\\s*(\"(?:\"\"|[^\"])*\"|[A-Za-z_][A-Za-z_0-9]*|[0-9]+(?:\\.[0-9]+)?|<>|<=|>=|[.\\[\\]()+*/%,=<>-])", RegexOptions.CultureInvariant);
        private readonly Dictionary<string, object> values;
        private readonly string source;
        private readonly List<string> tokens = [];
        private int position;

        public Expression(Dictionary<string, object> values, string source)
        {
            this.values = values;
            this.source = source;
            for (var offset = 0; offset < source.Length;)
            {
                if (string.IsNullOrWhiteSpace(source[offset..])) break;
                var match = Token.Match(source, offset);
                if (!match.Success) throw Error("Unsupported expression token at " + offset);
                tokens.Add(match.Groups[1].Value);
                offset += match.Length;
            }
        }

        public object Evaluate()
        {
            var expression = Parse();
            End();
            return expression();
        }

        public Place Path()
        {
            var name = Take();
            if (!IsName(name)) throw Error("Expected an assignment root");
            var place = new Place(values, name);
            while (Peek() is "." or "[")
            {
                var owner = place.Read();
                if (Take() == ".")
                {
                    var member = Take();
                    if (!IsName(member)) throw Error("Expected a member name");
                    place = new Place(owner, member);
                }
                else
                {
                    var index = Parse();
                    Expect("]");
                    place = new Place(owner, Index(index()));
                }
            }
            End();
            return place;
        }

        private Func<object> Parse(int minimum = 1)
        {
            var token = Take();
            Func<object> left;
            if (token == "(") { left = Parse(); Expect(")"); }
            else if (token == "-" || token.Equals("not", StringComparison.OrdinalIgnoreCase))
            {
                var operand = Parse(6);
                left = token == "-" ? () => -Number(operand()) : () => !Truth(operand());
            }
            else if (token.StartsWith('"')) left = () => token[1..^1].Replace("\"\"", "\"");
            else if (decimal.TryParse(token, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var number)) left = () => number;
            else if (token.Equals("true", StringComparison.OrdinalIgnoreCase)) left = () => true;
            else if (token.Equals("false", StringComparison.OrdinalIgnoreCase)) left = () => false;
            else if (IsName(token) && Peek() == "(")
            {
                Take();
                var arguments = new List<Func<object>>();
                if (Peek() != ")")
                {
                    do
                    {
                        arguments.Add(Parse());
                        if (Peek() != ",") break;
                        Take();
                    } while (true);
                }
                Expect(")");
                left = () => Function(token, arguments);
            }
            else if (IsName(token)) left = () => Member(values, token);
            else throw Error("Expected an expression, found " + token);

            while (Peek() is "." or "[")
            {
                var receiver = left;
                if (Take() == ".")
                {
                    var member = Take();
                    if (!IsName(member)) throw Error("Expected a member name");
                    left = () => Member(receiver(), member);
                }
                else
                {
                    var index = Parse();
                    Expect("]");
                    left = () => Item(receiver(), index());
                }
            }
            while (Priority(Peek()) >= minimum)
            {
                var operation = Take().ToLowerInvariant();
                var before = left;
                var right = Parse(Priority(operation) + 1);
                left = () => Apply(operation, before, right);
            }
            return left;
        }

        private static object Function(string name, IReadOnlyList<Func<object>> args) => name switch
        {
            "If" => Truth(args[0]()) ? args[1]() : args[2](),
            "Mod" => Number(args[0]()) % Number(args[1]()),
            "Trunc" => decimal.Truncate(Number(args[0]())),
            "DecimalToInteger" or "DecimalToLongInteger" => decimal.Round(Number(args[0]()), 0, MidpointRounding.ToEven),
            "IntegerToLongInteger" or "IntegerToDecimal" or "LongIntegerToDecimal" => Number(args[0]()),
            "IntegerToIdentifier" or "LongIntegerToIdentifier" or "IdentifierToInteger" or "IdentifierToLongInteger" => Number(args[0]()),
            "IntegerToText" or "LongIntegerToText" or "DecimalToText" => Text(args[0]()),
            "BooleanToText" => Truth(args[0]()) ? "True" : "False",
            "TextToInteger" or "TextToLongInteger" or "TextToDecimal" => decimal.Parse(Text(args[0]()), CultureInfo.InvariantCulture),
            "Length" => args[0]() switch { string text => (decimal)text.EnumerateRunes().Count(), List<object> list => (decimal)list.Count, _ => throw new InvalidOperationException("Length requires text or a list.") },
            "Abs" => Math.Abs(Number(args[0]())),
            "Substr" => Text(args[0]()).Substring(Index(args[1]()), Index(args[2]())),
            "Chr" => ((char)Index(args[0]())).ToString(),
            "NullIdentifier" => 0m,
            _ => throw new InvalidOperationException("Unsupported emitted function: " + name)
        };

        private static object Apply(string operation, Func<object> left, Func<object> right)
        {
            if (operation == "and") return Truth(left()) && Truth(right());
            if (operation == "or") return Truth(left()) || Truth(right());
            var a = left();
            var b = right();
            if (operation == "=") return Equals(a, b);
            if (operation == "<>") return !Equals(a, b);
            if (operation == "+" && (a is string || b is string)) return Text(a) + Text(b);
            var x = Number(a);
            var y = Number(b);
            return operation switch
            {
                "+" => x + y, "-" => x - y, "*" => x * y, "/" => x / y, "%" => x % y,
                "<" => x < y, ">" => x > y, "<=" => x <= y, ">=" => x >= y,
                _ => throw new InvalidOperationException("Unsupported emitted operator: " + operation)
            };
        }

        private static int Priority(string token) => token.ToLowerInvariant() switch
        {
            "or" => 1, "and" => 2, "=" or "<>" or "<" or ">" or "<=" or ">=" => 3,
            "+" or "-" => 4, "*" or "/" or "%" => 5, _ => 0
        };
        private static bool IsName(string token) => token.Length > 0 && (char.IsLetter(token[0]) || token[0] == '_');
        private string Peek() => position < tokens.Count ? tokens[position] : "";
        private string Take() => position < tokens.Count ? tokens[position++] : throw Error("Unexpected end of expression");
        private void Expect(string token) { if (Take() != token) throw Error("Expected " + token); }
        private void End() { if (position != tokens.Count) throw Error("Trailing expression token: " + Peek()); }
        private InvalidOperationException Error(string message) => new(message + " in " + source);
    }
}
