using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>
/// A04 of the atritos 2 package: the Verify errors an expression of the logic grammar would raise, judged before any model
/// from what the job declares (and, in JobRunner.CheckAgainstBase, from the base too). Each rule reports only what it can
/// prove: a name, a type or a function it does not know is left to the Verify.
/// <list type="bullet">
/// <item>EXPR_UNKNOWN_IDENTIFIER (ExpressionUnknownObject, InvalidVariable_UnknownObjInVar): `Agg.List.Current.X` where X is
/// not a source (or column) of the aggregate; `Var.Current.T.X` on a `T List` whose Current is already a T; `Call.Out` where
/// the callee has no such output; an attribute the entity does not have; with the base, a root name that is nothing in the
/// action, the job or the module; `Site` in client logic.</item>
/// <item>FUNCTION_ARITY (ExpressionWrongNumberArguments): a built-in called with fewer or more arguments than it takes.</item>
/// <item>OPERAND_TYPES (OperatorIncompatibleTypes, UnaryOperatorIncompatibleType): arithmetic or ordering on an Identifier,
/// arithmetic on a Text (other than +) or a Boolean, a Date Time ordered against a Date inside an aggregate.</item>
/// <item>DB_FUNCTION_IN_AGGREGATE (InvalidArgumentForExternalFunction): a function the database does not run (role check,
/// module function, built-in not available in aggregates) given an attribute of the aggregate's sources.</item>
/// </list>
/// </summary>
public static class ExpressionRules
{
    private static readonly HashSet<string> Globals = new(StringComparer.OrdinalIgnoreCase)
        { "Entities", "Site", "Session", "Roles", "Resources", "Settings", "Request", "Client", "BuiltinClientVariables", "True", "False", "and", "or", "not" };
    private static readonly Regex RoleCheck = new(@"^Check\w+Role$", RegexOptions.Compiled);
    private static readonly HashSet<string> Numeric = new(StringComparer.OrdinalIgnoreCase) { "Integer", "Long Integer", "Decimal", "Currency" };

    public static List<JsonObject> Check(JsonArray ops, string? prefix, string lane, JobFacts job, IBaseFacts? model)
    {
        var problems = new List<JsonObject>();
        var builtins = Builtins.For(lane);
        // Familias (C13): the Id base type of the entities the job declares, for the conversion an OPERAND_TYPES patch writes.
        var bases = DocumentAggregates.IdentifierBases(ops);
        foreach (var action in job.Actions)
        {
            var scan = LogicScan.Of(action.Declaration);
            var at = prefix == null ? null : $"{prefix}/{action.Op}/data/actions/{action.Index}";
            var locals = action.Locals.GroupBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First().Type ?? "", StringComparer.OrdinalIgnoreCase);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            void Add(ExpressionSite site, string code, string message, string fix) => Patched(site, code, message, fix, null);
            // A fix that is mechanical carries the RFC 6902 patch that writes the whole expression fixed (never for a sort,
            // whose value also carries its direction).
            void Patched(ExpressionSite site, string code, string message, string fix, string? written)
            {
                if (!seen.Add(code + "|" + site.Pointer + "|" + message)) return;
                var pointer = at == null ? null : at + site.Pointer;
                var patch = written == null || pointer == null || site.Key == "sort" ? null : new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = written });
                problems.Add(JobPreflight.Problem(action.Op, pointer, code, "error", message, fix, patch, "logic"));
            }
            foreach (var whole in scan.Expressions)
            {
                // The source is in the action scope; mapping fields are expressions relative to an item. Keep the whole
                // value in LogicScan for renames/normalizations, but never resolve a field as an action operand or name.
                var mapping = whole.AllowsMapping ? FlowMapping.Split(whole.Text) : null;
                var site = mapping is { } mapped ? whole with { Text = mapped.Source } : whole;
                if (mapping is { } fields)
                    foreach (var (field, value) in fields.Fields)
                        if (ExpressionSyntax.Check(value) is { } fieldSyntax && model == null)
                            Add(whole, "EXPRESSION_SYNTAX", $"mapping field {field}: {value}: {fieldSyntax.Problem}", fieldSyntax.Fix);
                if (ExpressionText.Tokens(site.Text).Any(t => t.Kind == TokenKind.Name && t.Is("mapTo"))) {
                    if (model == null) Add(whole, "EXPRESSION_SYNTAX", $"{whole.Text}: mapTo is only valid as a whole assignment or call argument value",
                        "use mapTo only as a whole assign/argument value: Source mapTo { Field: value }");
                    continue;
                }
                void MappedPatch(ExpressionSite part, string code, string message, string fix, string? written) =>
                    Patched(part, code, message, fix, written != null && mapping is { } original ? FlowMapping.Compose(written, original.Fields) : written);
                // primeira-certa A4: an expression whose syntax does not hold is that problem alone (its tokens mean nothing
                // to the other rules); said once, by the pure pass.
                if (ExpressionSyntax.Check(site.Text) is { } syntax)
                {
                    if (model == null) Add(site, "EXPRESSION_SYNTAX", $"{site.Text}: {syntax.Problem}", syntax.Fix);
                    continue;
                }
                var tokens = ExpressionText.Tokens(site.Text);
                var calls = ExpressionText.Calls(site.Text, tokens);
                if (builtins != null) Arity(site, calls, builtins, job, model, Add);
                if (site.Aggregate != null) DatabaseFunctions(site, calls, builtins, action, job, model, Add);
                Operands(site, tokens, action, locals, scan, job, model, builtins, MappedPatch, bases);
                Identifiers(site, tokens, action, locals, scan, job, model, lane, MappedPatch);
                // `a mod b` (C19): OutSystems has no mod operator. ODC's own rule (OdcPlatformRules) says it there.
                if (!string.Equals(lane, "odc", StringComparison.OrdinalIgnoreCase) && tokens.Any(t => t.Kind == TokenKind.Operator && t.Is("mod")))
                {
                    var written = ExpressionRewrites.Mod(site.Text, ExpressionRewrites.HasMod(lane));
                    MappedPatch(site, "EXPR_UNKNOWN_IDENTIFIER", $"can't identify 'mod' in {site.Text}: OutSystems has no mod operator (the Verify answers ParserUnexpectedElement)",
                        written != null ? $"write {written} (the built-in Mod(n, m) is the remainder)" : "write Mod(n, m), the built-in that returns the remainder", written);
                }
            }
        }
        return problems;
    }

    // ---- FUNCTION_ARITY ---------------------------------------------------------------------------------------------------

    private static void Arity(ExpressionSite site, List<Call> calls, IReadOnlyDictionary<string, BuiltinFact> builtins, JobFacts job, IBaseFacts? model,
        Action<ExpressionSite, string, string, string> add)
    {
        foreach (var call in calls)
        {
            if (!builtins.TryGetValue(call.Name, out var f)) continue;
            // A function of the job or of the module with the same name may be what the expression calls: not judged.
            if (job.Actions.Any(a => string.Equals(a.Name, call.Name, StringComparison.OrdinalIgnoreCase)) || model?.IsFunction(call.Name) == true) continue;
            var n = call.Arguments.Count;
            if (n >= f.Required && n <= f.Total) continue;
            var expected = f.Required == f.Total ? $"{f.Total}" : $"{f.Required} to {f.Total}";
            add(site, "FUNCTION_ARITY", $"{call.Name}({call.Inner}) passes {n} argument(s), and {f.Name} takes {expected}: {f.Signature}",
                $"call it as {f.Signature}");
        }
    }

    // ---- DB_FUNCTION_IN_AGGREGATE -----------------------------------------------------------------------------------------

    private static void DatabaseFunctions(ExpressionSite site, List<Call> calls, IReadOnlyDictionary<string, BuiltinFact>? builtins, ActionFact action,
        JobFacts job, IBaseFacts? model, Action<ExpressionSite, string, string, string> add)
    {
        var aggregate = site.Aggregate!;
        var sources = aggregate.Sources;
        var client = action.IsClientSide && sources.Any(s => job.ClientEntities.Contains(s) || model?.IsClientEntity(s) == true);
        // An attribute of the aggregate: <Source>.<Attribute>, or one of its own columns by name (unless a local has that name).
        var columns = aggregate.Columns.Concat(aggregate.Calculated).Where(c => !action.Locals.Any(l => string.Equals(l.Name, c, StringComparison.OrdinalIgnoreCase))).ToArray();
        foreach (var (message, fix) in DatabaseFindings(calls, aggregate.Name, sources, columns, client, builtins, job, model))
            add(site, "DB_FUNCTION_IN_AGGREGATE", message, fix);
    }

    private static IEnumerable<(string Message, string Fix)> DatabaseFindings(List<Call> calls, string aggregate, IReadOnlyList<string> sources, IReadOnlyList<string> columns,
        bool client, IReadOnlyDictionary<string, BuiltinFact>? builtins, JobFacts job, IBaseFacts? model)
    {
        foreach (var call in calls)
        {
            var attribute = call.ArgumentTokens.SelectMany(a => a).FirstOrDefault(t => t.Kind == TokenKind.Name && !t.Text.StartsWith('.')
                && (t.Segments.Length >= 2 && sources.Contains(t.Segments[0], StringComparer.OrdinalIgnoreCase)
                    || t.Segments.Length == 1 && columns.Contains(t.Segments[0], StringComparer.OrdinalIgnoreCase)));
            if (attribute == null) continue;
            string? why = null;
            if (builtins != null && builtins.TryGetValue(call.Name, out var f))
            {
                if (!(client ? f.ClientAggregates : f.ServerAggregates)) why = $"{f.Name} is not one of the built-ins the database runs in {(client ? "client" : "server")} aggregates";
            }
            else if (RoleCheck.IsMatch(call.Name)) why = $"{call.Name} is a role check, which runs in the application, not in the database";
            else if (job.Actions.Any(a => a.Function && string.Equals(a.Name, call.Name, StringComparison.OrdinalIgnoreCase)) || model?.IsFunction(call.Name) == true)
                why = $"{call.Name} is a function of the module, which runs in the application, not in the database";
            if (why == null) continue;
            yield return ($"'{call.Name}' cannot be executed in the database, so it cannot receive the attribute {attribute.Text} of aggregate {aggregate}: {why}",
                $"compute {call.Name}(...) before the get (a variable or an input the filter compares), or filter the rows after the get; in the aggregate use only attributes, variables and the built-ins the database runs");
        }
    }

    /// <summary>The expressions a raw `set` writes on an element of the base (the correction of a filter by its @key, the real
    /// case of `CheckSS360CustomerRole(RecipientId)`): FUNCTION_ARITY, and DB_FUNCTION_IN_AGGREGATE inside an aggregate.
    /// Only with the base, which says whether the property holds an expression and which aggregate the element is in.</summary>
    public static List<JsonObject> CheckRawSets(JsonArray ops, string? prefix, string lane, JobFacts job, IBaseFacts model)
    {
        var problems = new List<JsonObject>();
        var builtins = Builtins.For(lane);
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "set" || op["value"] is not JsonValue v || !v.TryGetValue<string>(out var text) || string.IsNullOrWhiteSpace(text)) continue;
            var target = op["target"]?.ToString() ?? ""; var prop = op["prop"]?.ToString() ?? "";
            // Both rules judge calls: a value without one is never read (and the base is not walked for it).
            if (!text.Contains('(') || target.StartsWith('$') || model.RawExpression(target, prop) is not { } fact) continue;
            var pointer = prefix == null ? null : $"{prefix}/{i}/value";
            var calls = ExpressionText.Calls(text);
            if (builtins != null)
                foreach (var call in calls)
                    if (builtins.TryGetValue(call.Name, out var f) && model.IsFunction(call.Name) != true && (call.Arguments.Count < f.Required || call.Arguments.Count > f.Total))
                        problems.Add(JobPreflight.Problem(i, pointer, "FUNCTION_ARITY", "error",
                            $"{call.Name}({call.Inner}) passes {call.Arguments.Count} argument(s), and {f.Name} takes {(f.Required == f.Total ? $"{f.Total}" : $"{f.Required} to {f.Total}")}: {f.Signature}",
                            $"call it as {f.Signature}", null, "set"));
            if (fact.Aggregate != null)
                foreach (var (message, fix) in DatabaseFindings(calls, fact.Aggregate, fact.Sources, fact.Columns, fact.Client, builtins, job, model))
                    problems.Add(JobPreflight.Problem(i, pointer, "DB_FUNCTION_IN_AGGREGATE", "error", message, fix, null, "set"));
        }
        return problems;
    }

    // ---- OPERAND_TYPES ----------------------------------------------------------------------------------------------------

    private static readonly HashSet<string> Arithmetic = new(StringComparer.Ordinal) { "+", "-", "*", "/" };
    private static readonly HashSet<string> Ordering = new(StringComparer.Ordinal) { "<", ">", "<=", ">=" };

    private static void Operands(ExpressionSite site, List<Token> tokens, ActionFact action, Dictionary<string, string> locals, LogicScan scan,
        JobFacts job, IBaseFacts? model, IReadOnlyDictionary<string, BuiltinFact>? builtins, Action<ExpressionSite, string, string, string, string?> add,
        IReadOnlyDictionary<string, string> bases)
    {
        string? TypeAt(int index, bool left)
        {
            if (index < 0 || index >= tokens.Count) return null;
            var t = tokens[index];
            if (!left && t.Kind == TokenKind.Name && index + 1 < tokens.Count && tokens[index + 1].Kind == TokenKind.Open)
            {
                if (t.Text.Contains('.')) return null;
                var depth = 0;
                for (var j = index + 1; j < tokens.Count; j++)
                {
                    if (tokens[j].Kind == TokenKind.Open) depth++;
                    else if (tokens[j].Kind == TokenKind.Close && --depth == 0)
                        return j + 1 < tokens.Count && (tokens[j + 1].Kind == TokenKind.OpenIndex || tokens[j + 1].Kind == TokenKind.Other && tokens[j + 1].Text == ".") ? null : CallType(t.Text);
                }
                return null;
            }
            if (left && t.Kind == TokenKind.Close)
            {
                var depth = 0;
                for (var j = index; j >= 0; j--)
                {
                    if (tokens[j].Kind == TokenKind.Close) depth++;
                    else if (tokens[j].Kind == TokenKind.Open && --depth == 0)
                        return j > 0 && tokens[j - 1].Kind == TokenKind.Name && !tokens[j - 1].Text.Contains('.') ? CallType(tokens[j - 1].Text) : null;
                }
                return null;
            }
            // A name next to an index or a call is not a whole operand.
            if (t.Kind == TokenKind.Name && (index + 1 < tokens.Count && tokens[index + 1].Kind is TokenKind.OpenIndex || ExpressionText.Continues(tokens, index) || t.Text.StartsWith('.'))) return null;
            return t.Kind switch
            {
                TokenKind.Text => "Text",
                TokenKind.Number => t.Text.Contains('.') ? "Decimal" : "Integer",
                TokenKind.Date => t.Text.Contains(':') ? (t.Text.Contains('-') ? "Date Time" : "Time") : "Date",
                TokenKind.Name => NameType(t),
                _ => null,
            };
        }
        string? CallType(string name)
        {
            if (job.Actions.Any(a => string.Equals(a.Name, name, StringComparison.OrdinalIgnoreCase))) return null;
            return builtins != null && builtins.TryGetValue(name, out var f) ? Normal(f.ReturnType) : null;
        }
        string? NameType(Token t)
        {
            var parts = t.Segments;
            if (parts.Length == 1)
            {
                if (t.Is("True") || t.Is("False")) return "Boolean";
                return locals.TryGetValue(parts[0], out var declared) ? Normal(declared) : null;
            }
            // <Source>.<Attribute> inside an aggregate: the attribute's type when the entity is known.
            if (site.Aggregate != null && parts.Length == 2 && site.Aggregate.Sources.Contains(parts[0], StringComparer.OrdinalIgnoreCase))
                return Normal(Attributes(parts[0], job, model)?.GetValueOrDefault(parts[1]));
            return null;
        }
        for (var k = 0; k < tokens.Count; k++)
        {
            var t = tokens[k];
            if (t.Kind != TokenKind.Operator) continue;
            var unary = t.Text == "-" && (k == 0 || tokens[k - 1].Kind is TokenKind.Operator or TokenKind.Open or TokenKind.OpenIndex or TokenKind.Comma);
            if (unary)
            {
                var operand = TypeAt(k + 1, left: false);
                if (operand != null && (IsIdentifier(operand) || operand is "Text" or "Boolean"))
                    add(site, "OPERAND_TYPES", $"operator '-' cannot be applied to operand {tokens[k + 1].Text} of type '{operand}'", Conversion(operand, "-"), null);
                continue;
            }
            if (!Arithmetic.Contains(t.Text) && !Ordering.Contains(t.Text)) continue;
            var a = TypeAt(k - 1, left: true); var b = TypeAt(k + 1, left: false);
            if (a == null || b == null) continue;
            var wrong = WrongOperand(t.Text, a, b, site.Aggregate != null);
            if (wrong == null) continue;
            // Familias (C13): an identifier against a number, whose Id base type the job declares (a static entity's Id is an
            // Integer, an entity's a Long Integer): the patch converts that operand, when this Studio runs the conversion there.
            string? written = null;
            if (IsIdentifier(wrong) && Numeric.Contains(wrong == a ? b : a) && tokens[wrong == a ? k - 1 : k + 1] is { Kind: TokenKind.Name } operandToken
                && bases.TryGetValue(wrong[..^" Identifier".Length], out var basis))
            {
                var conversion = basis == "Integer" ? "IdentifierToInteger" : "IdentifierToLongInteger";
                var client = action.IsClientSide && site.Aggregate?.Sources.Any(s => job.ClientEntities.Contains(s) || model?.IsClientEntity(s) == true) == true;
                if (builtins != null && builtins.TryGetValue(conversion, out var f) && (site.Aggregate == null || (client ? f.ClientAggregates : f.ServerAggregates)))
                    written = site.Text[..operandToken.Start] + conversion + "(" + operandToken.Text + ")" + site.Text[(operandToken.Start + operandToken.Text.Length)..];
            }
            add(site, "OPERAND_TYPES", $"cannot apply '{t.Text}' to '{a}' together with '{b}' ({Around(tokens, k)})", written != null ? $"write {written} (the patch)" : Conversion(wrong, t.Text), written);
        }
    }

    /// <summary>The operand type that makes the operator invalid, or null when the pair is valid or not provably invalid.</summary>
    private static string? WrongOperand(string op, string a, string b, bool inAggregate)
    {
        var arithmetic = Arithmetic.Contains(op);
        foreach (var (self, other) in new[] { (a, b), (b, a) })
        {
            if (IsIdentifier(self) && (Numeric.Contains(other) || arithmetic && op != "+")) return self;
            if (arithmetic && op != "+" && self == "Text") return self;
            // Text + Boolean may be a concatenation: only + with a number or a Boolean is provably wrong.
            if (arithmetic && self == "Boolean" && (op != "+" || Numeric.Contains(other) || other == "Boolean")) return self;
            if (arithmetic && self is "Date" or "Date Time" or "Time" && Numeric.Contains(other)) return self;
        }
        // The Studio refuses a Date Time ordered against a Date inside an aggregate (in action logic it is a lint warning).
        if (inAggregate && Ordering.Contains(op) && (a == "Date Time" && b == "Date" || a == "Date" && b == "Date Time")) return "Date Time";
        return null;
    }

    private static bool IsIdentifier(string type) => type == "Identifier" || type.EndsWith(" Identifier", StringComparison.OrdinalIgnoreCase);

    private static string Conversion(string type, string op) => type switch
    {
        _ when IsIdentifier(type) => "convert the identifier first: IdentifierToInteger(x) (IdentifierToLongInteger for a Long Integer id), or compare it with another identifier (IntegerToIdentifier(n), NullIdentifier())",
        "Text" => "convert the text first: TextToInteger(x) or TextToDecimal(x)",
        "Boolean" => "write the number explicitly: If(x, 1, 0)",
        "Date Time" when op is "<" or ">" or "<=" or ">=" => "compare the same type: DateTimeToDate(x) on the Date Time side, or NewDateTime(...) on the Date side",
        _ => "use the date functions: AddDays/AddHours/AddMinutes to move a date, DiffDays/DiffMinutes to subtract two",
    };

    private static string Around(List<Token> tokens, int k)
        => string.Join(" ", tokens.Skip(Math.Max(0, k - 1)).Take(3).Select(t => t.Text));

    private static string? Normal(string? type) => type?.Trim() switch
    {
        null or "" => null,
        "DateTime" => "Date Time",
        "LongInteger" => "Long Integer",
        "EntityReference" or "EntityReferenceLongInteger" or "EntityReferenceInteger" or "EntityReferenceText" => "Identifier",
        "Int" => "Integer",
        "Bool" => "Boolean",
        "String" => "Text",
        "Long Text" => "Text",
        var t => t,
    };

    // ---- EXPR_UNKNOWN_IDENTIFIER ------------------------------------------------------------------------------------------

    /// <summary>The System list actions whose arguments other than List are evaluated per element (Condition, By).</summary>
    private static readonly HashSet<string> ListLambdas = new(StringComparer.OrdinalIgnoreCase) { "ListAll", "ListAny", "ListFilter", "ListIndexOf", "ListSort" };

    /// <summary>The atritos 3 battery (replay of an O11 client migration): `ListIndexOf(GetAarStates.List, FuneralHonorsAarStatus.Label = Status)`
    /// was refused as an unknown 'FuneralHonorsAarStatus', and the Verify of the same delivery accepted it.</summary>
    private static bool IsListLambda(ExpressionSite site)
        => site.Step["call"] is JsonValue call && call.TryGetValue<string>(out var callee) && ListLambdas.Contains(callee.Trim())
            && !site.Key.Equals("List", StringComparison.OrdinalIgnoreCase) && site.Pointer.Contains("/args/", StringComparison.Ordinal);

    private static void Identifiers(ExpressionSite site, List<Token> tokens, ActionFact action, Dictionary<string, string> locals, LogicScan scan,
        JobFacts job, IBaseFacts? model, string lane, Action<ExpressionSite, string, string, string, string?> add)
    {
        for (var k = 0; k < tokens.Count; k++)
        {
            if (!ExpressionText.IsRoot(tokens, k)) continue;
            var t = tokens[k]; var parts = t.Segments;
            if (parts.Length == 0) continue;
            var root = parts[0];
            // Agg.List.Current.X[.Y]: X is a source of the aggregate (or one of its columns); Y an attribute of that source.
            if (scan.Nodes.TryGetValue(root, out var node) && node.Kind == "aggregate" && parts.Length >= 4
                && parts[1].Equals("List", StringComparison.OrdinalIgnoreCase) && parts[2].Equals("Current", StringComparison.OrdinalIgnoreCase))
            {
                CurrentOfAggregate(site, t, node, parts, job, model, (s, c, m, f) => add(s, c, m, f, null));
                continue;
            }
            // Q.List.Current.List.X of a SQL query: the output the logic op creates is named List, its record is the `get` type.
            if (node is { Kind: "sql" } && parts.Length >= 4 && parts[1].Equals("List", StringComparison.OrdinalIgnoreCase) && parts[2].Equals("Current", StringComparison.OrdinalIgnoreCase))
            {
                CurrentOfSql(site, t, node, parts, job, model, add);
                continue;
            }
            // Var.Current.X on a `T List` input, output or variable: Current is a T record (X an attribute of T), or the value
            // itself on a list of a basic type (C19: no member at all).
            if (parts.Length >= 3 && parts[1].Equals("Current", StringComparison.OrdinalIgnoreCase) && locals.TryGetValue(root, out var listType))
            {
                CurrentOfList(site, t, root, listType, parts, 2, job, model, add);
                continue;
            }
            // Call.Out: an output of the callee; Call.Out.Current.X follows the type of that output (of the job, of the base or of
            // a producer's signature in the base: C19, the real case ReadSignals.Signals.Current.Value on a Text List).
            if (scan.Nodes.TryGetValue(root, out var callNode) && callNode.Kind == "call" && parts.Length >= 2 && callNode.Target is { } target)
            {
                var outputs = job.Callee(target, action)?.Outputs ?? model?.Callee(target, action.Declaration)?.Outputs;
                var output = outputs?.FirstOrDefault(o => string.Equals(o.Name, parts[1], StringComparison.OrdinalIgnoreCase));
                if (outputs != null && output == null)
                {
                    // primeira-certa A4: the output the expression meant, when only one can be it (the callee's only output, or
                    // the only one that differs by a few letters or contains the name): the patch writes it.
                    var meant = NameSuggestions.OnlyMatch(parts[1], outputs.Select(o => o.Name).ToList());
                    string Written(string name) => site.Text[..t.Start] + string.Join(".", new[] { root, name }.Concat(parts.Skip(2))) + site.Text[(t.Start + t.Text.Length)..];
                    add(site, "EXPR_UNKNOWN_IDENTIFIER", $"can't identify '{parts[1]}' in {t.Text}: the action {target} that {root} calls has " + (outputs.Count == 0 ? "no outputs" : $"the outputs {Short(outputs.Select(o => o.Name))}"),
                        outputs.Count == 0 ? $"read nothing from {root}, or declare the output in {target}"
                            : meant != null ? $"write {root}.{meant} (the output of {target})" : $"use {root}.<output>: {Closest(parts[1], outputs.Select(o => o.Name))}",
                        meant != null && !t.Text.StartsWith('.') ? Written(meant) : null);
                }
                else if (output != null && parts.Length >= 4 && parts[2].Equals("Current", StringComparison.OrdinalIgnoreCase) && output.Type is { Length: > 0 } outputType)
                    CurrentOfList(site, t, $"{root}.{output.Name}", outputType, parts, 3, job, model, add);
                continue;
            }
            if (locals.ContainsKey(root) || scan.Nodes.ContainsKey(root)) continue;
            // Inside an aggregate its sources and its own columns are names too.
            if (site.Aggregate != null && (site.Aggregate.Sources.Contains(root, StringComparer.OrdinalIgnoreCase)
                || site.Aggregate.Columns.Contains(root, StringComparer.OrdinalIgnoreCase) || site.Aggregate.Calculated.Contains(root, StringComparer.OrdinalIgnoreCase))) continue;
            // Site properties are read on the server (O11); ODC has none. Client logic cannot read them.
            if (root.Equals("Site", StringComparison.OrdinalIgnoreCase) && (action.IsClientSide || lane == "odc") && !job.Names.Contains(root) && model?.HasName(root) != true)
            {
                add(site, "EXPR_UNKNOWN_IDENTIFIER", $"can't identify 'Site' in {t.Text}: " + (lane == "odc" ? "ODC apps have no site properties" : $"site properties are read on the server, and {action.Name} is client logic"),
                    lane == "odc" ? "use a setting (Settings.<Name>) or pass the value as an input" : "read the site property in a server action or a data action and pass the value to the client", null);
                continue;
            }
            // Server logic has a closed scope: its inputs, outputs, local variables and nodes, the roots of the language and the
            // exceptions its handlers catch. Anything else is unknown to the Verify, a name of another action as much as a typo;
            // an entity or structure name is a type, not a value (the real case: `SLADeadlineResult.Value`, `RestauranteId` of
            // another action).
            // The per-element argument of a list action (Condition, By) reads the members of the current element bare, the
            // documented form (`User.Name = Name`): its roots belong to the element, which the job does not type here.
            if (action.IsServerSide && !IsListLambda(site) && !Globals.Contains(root) && !scan.HandledExceptions.Contains(root)
                && !ValueAliases.SystemExceptions.Contains(ValueAliases.SystemExceptionKey(root)))
            {
                // primeira-certa A4: a site property (an ODC setting) of the module or of the job, written without its
                // qualifier: the patch writes Site.<Name> (Settings.<Name>).
                if ((job.Globals.TryGetValue(root, out var declared) ? declared : model?.GlobalOf(root)) is { } qualifier
                    && (qualifier == "Site") == !string.Equals(lane, "odc", StringComparison.OrdinalIgnoreCase))
                {
                    add(site, "EXPR_UNKNOWN_IDENTIFIER", $"can't identify '{root}' in {t.Text}: {root} is a {(qualifier == "Site" ? "site property" : "setting")} of the module, read as {qualifier}.{root}",
                        $"write {qualifier}.{root}", site.Text[..t.Start] + qualifier + "." + site.Text[t.Start..]);
                    continue;
                }
                var candidates = locals.Keys.Concat(scan.Nodes.Keys);
                var type = job.Records.ContainsKey(root) || model?.NamesOnlyTypes(root) == true;
                add(site, "EXPR_UNKNOWN_IDENTIFIER", type
                        ? $"can't identify '{root}' in {t.Text}: {root} is an entity or structure, a type and not a value of {action.Name}"
                        : $"can't identify '{root}' in {t.Text}: it is not an input, output, local variable or node of {action.Name}",
                    type ? $"read it from a value of that type: a variable or input of type {root}, or {Closest(root, candidates)}"
                        : Closest(root, candidates) is var close && close.Length > 0 ? $"use {close}, or declare '{root}' in {action.Name} (inputs/vars)" : $"declare it in {action.Name} (inputs/vars) or name the node that produces it", null);
            }
        }
    }

    /// <summary>`head.Current.&lt;rest&gt;` on a value of type <paramref name="listType"/> (parts[at..] after Current). On a `T List`
    /// of records the member is an attribute of T (`.Current.T.X` is `.Current.X`); on a list of a basic type (Text List,
    /// Integer List, an Identifier List) Current is the value itself and has no member, so `.Current.Value` is `.Current`. A
    /// record whose attributes are unknown here is left to the Verify.</summary>
    private static void CurrentOfList(ExpressionSite site, Token t, string head, string listType, string[] parts, int at, JobFacts job, IBaseFacts? model,
        Action<ExpressionSite, string, string, string, string?> add)
    {
        if (parts.Length <= at || ExpressionRewrites.ListElement(listType) is not { } element) return;
        string Written(string path) => site.Text[..t.Start] + path + site.Text[(t.Start + t.Text.Length)..];
        if (ExpressionRewrites.IsBasic(element))
        {
            var path = $"{head}.Current";
            add(site, "EXPR_UNKNOWN_IDENTIFIER", $"can't identify '{parts[at]}' in {t.Text}: {head} is a {listType}, so {head}.Current is the {element} value itself, with no members",
                $"write {path}", Written(path));
            return;
        }
        if (element.Contains(' ') || Attributes(element, job, model) is not { Count: > 0 } attributes || attributes.ContainsKey(parts[at])) return;
        if (parts.Length > at + 1 && parts[at].Equals(element, StringComparison.OrdinalIgnoreCase) && attributes.ContainsKey(parts[at + 1]))
        {
            var path = $"{head}.Current.{string.Join(".", parts.Skip(at + 1))}";
            add(site, "EXPR_UNKNOWN_IDENTIFIER", $"can't identify '{parts[at]}' in {t.Text}: {head} is a {listType}, so {head}.Current is a {element} record with the attributes {Short(Shown(attributes))}",
                $"write {path} (a list of {element} has the attributes directly)", Written(path));
            return;
        }
        add(site, "EXPR_UNKNOWN_IDENTIFIER", $"can't identify '{parts[at]}' in {t.Text}: {head} is a {listType}, so {head}.Current is a {element} record with the attributes {Short(Shown(attributes))}",
            $"use {head}.Current.<attribute>: {Closest(parts[at], Shown(attributes))}", null);
    }

    /// <summary>`Q.List.Current.List.X` of a SQL query (kernel/AGENTS.md: the logic op names the SQL output List): X is an
    /// attribute of the `get` type. `Q.List.Current.X` with X an attribute of that type misses the List segment (patched);
    /// `Q.List.Current.T.X` is the compiler's own rewrite (LOGIC_CURRENT_REWRITTEN) and is not judged here.</summary>
    private static void CurrentOfSql(ExpressionSite site, Token t, NodeFact node, string[] parts, JobFacts job, IBaseFacts? model,
        Action<ExpressionSite, string, string, string, string?> add)
    {
        var type = node.Step["get"]?.ToString();
        if (string.IsNullOrWhiteSpace(type) || parts[3].Equals(type, StringComparison.OrdinalIgnoreCase)) return;
        if (Attributes(type, job, model) is not { Count: > 0 } attributes) return;
        string Written(string path) => site.Text[..t.Start] + path + site.Text[(t.Start + t.Text.Length)..];
        if (parts[3].Equals("List", StringComparison.OrdinalIgnoreCase))
        {
            if (parts.Length >= 5 && !attributes.ContainsKey(parts[4]))
                add(site, "EXPR_UNKNOWN_IDENTIFIER", $"can't identify '{parts[4]}' in {t.Text}: the SQL {node.Name} returns {type} records, with the attributes {Short(Shown(attributes))}",
                    $"use {node.Name}.List.Current.List.<attribute>: {Closest(parts[4], Shown(attributes))}", null);
            return;
        }
        if (!attributes.ContainsKey(parts[3])) return;
        var path = $"{node.Name}.List.Current.List.{string.Join(".", parts.Skip(3))}";
        add(site, "EXPR_UNKNOWN_IDENTIFIER", $"can't identify '{parts[3]}' in {t.Text}: the output of the SQL {node.Name} is named List, so a field of its record is {node.Name}.List.Current.List.<field>",
            $"write {path}", Written(path));
    }

    private static void CurrentOfAggregate(ExpressionSite site, Token t, NodeFact node, string[] parts, JobFacts job, IBaseFacts? model, Action<ExpressionSite, string, string, string> add)
    {
        var field = parts[3];
        var sources = node.Sources; var columns = node.Columns; var calculated = node.Calculated;
        var fields = (columns.Count > 0 ? columns : sources).Concat(calculated).ToArray();
        if (!fields.Contains(field, StringComparer.OrdinalIgnoreCase))
        {
            string fix;
            if (columns.Count > 0) fix = $"use {node.Name}.List.Current.<column>: {Short(fields)}";
            else
            {
                var owners = sources.Where(s => Attributes(s, job, model)?.ContainsKey(field) == true).ToArray();
                fix = owners.Length == 1 ? $"write {node.Name}.List.Current.{owners[0]}.{string.Join(".", parts.Skip(3))} (an aggregate's Current has one record per source)"
                    : $"write {node.Name}.List.Current.<source>.<attribute>; the sources of {node.Name} are {Short(sources)}" + (calculated.Count > 0 ? $" and its calculated columns {Short(calculated)}" : "");
            }
            add(site, "EXPR_UNKNOWN_IDENTIFIER", $"can't identify '{field}' in {t.Text}: {node.Name}.List.Current has {Short(fields)}", fix);
            return;
        }
        if (parts.Length < 5 || columns.Count > 0 || !sources.Contains(field, StringComparer.OrdinalIgnoreCase)) return;
        var attributes = Attributes(field, job, model);
        if (attributes is { Count: > 0 } && !attributes.ContainsKey(parts[4]))
            add(site, "EXPR_UNKNOWN_IDENTIFIER", $"can't identify '{parts[4]}' in {t.Text}: {field} has the attributes {Short(Shown(attributes))}",
                $"use {node.Name}.List.Current.{field}.<attribute>: {Closest(parts[4], Shown(attributes))}");
    }

    /// <summary>The attributes of a record: as the job declares it, or as the base has it plus every name the job declares
    /// (an attribute the job adds to a module entity before the expression runs counts).</summary>
    internal static IReadOnlyDictionary<string, string>? Attributes(string record, JobFacts job, IBaseFacts? model)
    {
        if (job.Records.TryGetValue(record, out var declared)) return declared;
        if (model?.Attributes(record) is not { } existing) return null;
        var merged = new Dictionary<string, string>(existing, StringComparer.OrdinalIgnoreCase);
        foreach (var name in job.Names) merged.TryAdd(name, "");
        return merged;
    }

    /// <summary>The attributes a message lists: those of the record itself, not the names of the job merged in.</summary>
    private static IEnumerable<string> Shown(IReadOnlyDictionary<string, string> attributes)
        => attributes.Any(a => a.Value.Length > 0) ? attributes.Where(a => a.Value.Length > 0).Select(a => a.Key) : attributes.Keys;

    private static string Short(IEnumerable<string> names)
    {
        var list = names.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        return list.Count == 0 ? "(none)" : string.Join(", ", list.Take(15)) + (list.Count > 15 ? ", ..." : "");
    }

    private static string Closest(string name, IEnumerable<string> pool)
    {
        var closest = NameSuggestions.Closest(name, pool.Distinct(StringComparer.OrdinalIgnoreCase));
        return string.Join(", ", closest.Count > 0 ? closest : pool.Distinct(StringComparer.OrdinalIgnoreCase).Take(8));
    }
}
