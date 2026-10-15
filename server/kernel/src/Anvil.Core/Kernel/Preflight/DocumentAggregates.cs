using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// Familias (2026-10-12, VisitaCerta_UI round 38, C13 of C:\t\motor2\CLASSES.md): the OPERAND_TYPES rule of the logic
/// (ExpressionRules) on the filters of the aggregates a screen or block document declares (`&lt;aggregate from where&gt;`,
/// and the long form os-Filter). The Verify answered `Cannot apply '&lt;' operator to 'MockPlace Identifier' together with
/// 'Integer'` one round after the rest. An identifier ordered against a number, or in arithmetic, is refused here with the
/// others; when the identifier's own type is known (the job's spec: a static entity's Id is an Integer, an entity's a Long
/// Integer) the patch writes the conversion the comparison needs (IdentifierToInteger(MockPlace.Id) &lt; 6), on the html as
/// the author sent it, and is proved by the same rule on the patched document (verified), never offered unproved.
/// </summary>
public static class DocumentAggregates
{
    public const string Code = "OPERAND_TYPES";
    private static readonly HashSet<string> Ordering = new(StringComparer.Ordinal) { "<", ">", "<=", ">=" };
    private static readonly HashSet<string> Arithmetic = new(StringComparer.Ordinal) { "-", "*", "/" };
    private static readonly HashSet<string> Numeric = new(StringComparer.OrdinalIgnoreCase) { "Integer", "Long Integer", "Decimal", "Currency" };

    public static List<JsonObject> Check(JsonArray ops, string? prefix, string lane)
    {
        var problems = new List<JsonObject>();
        var docs = ScreenDocFacts.All(ops);
        if (docs.Count == 0) return problems;
        var job = JobFacts.From(ops);
        var bases = IdentifierBases(ops);
        foreach (var doc in docs)
        {
            if (ops[doc.Op] is not JsonObject op || op["data"] is not JsonObject holder) continue;
            var path = prefix == null ? null : $"{prefix}/{doc.Op}/data/html";
            foreach (var aggregate in doc.Declared.Where(d => d.Kind == "aggregate"))
            {
                var sources = Sources(aggregate.Element);
                foreach (var name in new[] { "where", "os-Filter" })
                {
                    if (aggregate.Element.Find(name) is not { } attribute) continue;
                    var expression = HtmlDocumentRules.Decode(attribute.Value);
                    foreach (var finding in Findings(expression, sources, job, bases, lane))
                    {
                        var (line, column) = doc.Text.Position(attribute.Start);
                        JsonArray? patch = null;
                        if (finding.Written is { } written && path != null && Verified(written, sources, job, bases, lane))
                            patch = Patch(holder, doc, aggregate.Name, name, expression, written, path);
                        var problem = JobPreflight.Problem(doc.Op, path, Code, "error",
                            $"html: line {line} col {column}: aggregate {aggregate.Name} of {doc.Name}: {name}=\"{expression}\" cannot apply '{finding.Operator}' to {finding.Operand} ('{finding.Type}') together with '{finding.Other}' (the Verify answers OperatorIncompatibleTypes)",
                            finding.Written != null ? $"write {name}=\"{finding.Written}\" (the patch)" : "convert the identifier first: IdentifierToInteger(x) (IdentifierToLongInteger for a Long Integer id), or compare it with another identifier (IntegerToIdentifier(n))",
                            patch, "html");
                        if (patch != null) problem["_sentPatch"] = true;
                        // The Verify says the same fault on this aggregate (JobRunner.Union: one place).
                        problem["verifyCode"] = "OperatorIncompatibleTypes";
                        problem["element"] = aggregate.Name;
                        problems.Add(problem);
                    }
                }
            }
        }
        return problems;
    }

    /// <summary>The source of each name an aggregate reads: from= (Entity or Alias=Entity, comma separated) and join= (Entity
    /// on ..., comma separated at the top level).</summary>
    private static Dictionary<string, string> Sources(HtmlText.Element element)
    {
        var sources = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        void Add(string part)
        {
            var text = part.Trim();
            var eq = text.IndexOf('=');
            var (alias, entity) = eq > 0 ? (text[..eq].Trim(), text[(eq + 1)..].Trim()) : (text, text);
            if (alias.Length > 0 && entity.Length > 0 && !entity.Contains(' ')) sources[alias] = entity;
        }
        foreach (var part in (HtmlDocumentRules.Decode(element.Get("from") ?? "")).Split(',', StringSplitOptions.RemoveEmptyEntries)) Add(part);
        foreach (var part in (HtmlDocumentRules.Decode(element.Get("join") ?? "")).Split(',', StringSplitOptions.RemoveEmptyEntries))
        {
            var on = part.IndexOf(" on ", StringComparison.OrdinalIgnoreCase);
            Add(on > 0 ? part[..on] : part);
        }
        return sources;
    }

    /// <summary>The Id base type of each entity the job's spec declares: Integer for a static entity, Long Integer for an entity.</summary>
    internal static Dictionary<string, string> IdentifierBases(JsonArray ops)
    {
        var bases = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var op in ops.OfType<JsonObject>())
        {
            if (op["op"]?.ToString() != "spec" || op["data"] is not JsonObject source) continue;
            JsonObject data;
            try { data = SpecExpander.Sections(source); } catch { continue; }
            foreach (var record in (data["static"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                if (record["name"]?.ToString() is { Length: > 0 } n) bases[n] = "Integer";
            foreach (var section in new[] { "entities", "clientEntities" })
                foreach (var record in (data[section] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                    if (record["name"]?.ToString() is { Length: > 0 } n && !(record["id"] is JsonValue id && id.TryGetValue<bool>(out var withId) && !withId)) bases[n] = "Long Integer";
        }
        return bases;
    }

    private sealed record Finding(string Operator, string Operand, string Type, string Other, string? Written);

    private static List<Finding> Findings(string expression, IReadOnlyDictionary<string, string> sources, JobFacts job, IReadOnlyDictionary<string, string> bases, string lane)
    {
        var found = new List<Finding>();
        List<Token> tokens;
        try { tokens = ExpressionText.Tokens(expression); } catch { return found; }
        string? TypeOf(int k)
        {
            if (k < 0 || k >= tokens.Count) return null;
            var t = tokens[k];
            // A whole operand only: not part of a call, an index or a longer path.
            if (k + 1 < tokens.Count && tokens[k + 1].Kind is TokenKind.Open or TokenKind.OpenIndex) return null;
            if (k > 0 && tokens[k - 1].Kind is TokenKind.Close or TokenKind.CloseIndex) return null;
            if (t.Kind == TokenKind.Number) return t.Text.Contains('.') ? "Decimal" : "Integer";
            if (t.Kind != TokenKind.Name || t.Text.StartsWith('.') || ExpressionText.Continues(tokens, k)) return null;
            var parts = t.Segments;
            if (parts.Length != 2 || !sources.TryGetValue(parts[0], out var entity)) return null;
            return job.Records.TryGetValue(entity, out var attributes) && attributes.TryGetValue(parts[1], out var type) ? type : null;
        }
        for (var k = 1; k + 1 < tokens.Count; k++)
        {
            var op = tokens[k];
            if (op.Kind != TokenKind.Operator || !(Ordering.Contains(op.Text) || Arithmetic.Contains(op.Text))) continue;
            var a = TypeOf(k - 1); var b = TypeOf(k + 1);
            if (a == null || b == null) continue;
            foreach (var (self, other, at) in new[] { (a, b, k - 1), (b, a, k + 1) })
            {
                if (!IsIdentifier(self) || !(Numeric.Contains(other) || Arithmetic.Contains(op.Text))) continue;
                var entity = self[..^" Identifier".Length];
                string? written = null;
                if (Numeric.Contains(other) && bases.TryGetValue(entity, out var basis))
                {
                    var conversion = basis == "Integer" ? "IdentifierToInteger" : "IdentifierToLongInteger";
                    // Only a conversion this Studio has and runs in the database (an aggregate's filter): else no patch.
                    if (Builtins.Get(conversion, lane) is { ServerAggregates: true })
                        written = expression[..tokens[at].Start] + conversion + "(" + tokens[at].Text + ")" + expression[(tokens[at].Start + tokens[at].Text.Length)..];
                }
                found.Add(new Finding(op.Text, tokens[at].Text, self, other, written));
                break;
            }
        }
        return found;
    }

    private static bool IsIdentifier(string type) => type.EndsWith(" Identifier", StringComparison.OrdinalIgnoreCase);

    /// <summary>The patch proved: the written filter has no finding of this rule left (several findings in one filter get one
    /// patch each, so only a filter whose every finding is fixed by its own patch passes).</summary>
    private static bool Verified(string written, IReadOnlyDictionary<string, string> sources, JobFacts job, IReadOnlyDictionary<string, string> bases, string lane)
        => Findings(written, sources, job, bases, lane).Count == 0;

    /// <summary>The patch over the html as the author sent it: the same aggregate's attribute with the written filter.</summary>
    private static JsonArray? Patch(JsonObject holder, ScreenDocFacts doc, string aggregate, string attributeName, string expression, string written, string path)
    {
        var sent = SentJob.HtmlAsSent(holder) ?? doc.Text.Source;
        var text = HtmlText.Parse(sent);
        var root = text.Root.Children.FirstOrDefault(e => e.Tag is "screen" or "block");
        var element = root?.Children.FirstOrDefault(e => e.Tag == "aggregate" && string.Equals(e.Get("name"), aggregate, StringComparison.Ordinal));
        if (element?.Find(attributeName) is not { } attribute || HtmlDocumentRules.Decode(attribute.Value) != expression) return null;
        var quote = attribute.ValueEnd < sent.Length ? sent[attribute.ValueEnd] : '"';
        var encoded = written.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
        encoded = quote == '"' ? encoded.Replace("\"", "&quot;") : quote == '\'' ? encoded.Replace("'", "&#39;") : encoded;
        return new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = path, ["value"] = HtmlText.Apply(sent, [new(attribute.ValueStart, attribute.ValueEnd - attribute.ValueStart, encoded)]) });
    }
}
