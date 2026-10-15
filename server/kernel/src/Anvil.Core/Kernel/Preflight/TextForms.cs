using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>
/// Familias (2026-10-12, VisitaCerta_UI by hand): the text forms the model writes (ssam-ddl/1, ssam-flow/1) with a line the
/// grammar rejects that has one reading. Rewritten in place before any check and listed, never refused; a line that still
/// does not parse after its rewrite keeps the text as written (the parser says why). Only the lines the grammar rejects are
/// touched (the error's own line, one rewrite at a time, kept only when the parse gets past it), so a text that parses is
/// never read in another way. The line numbers stay those of the text as sent (a dropped line is left blank).
/// <list type="bullet">
/// <item>DDL_DECLARATION_NORMALIZED (data text): a line statement (client variable, session variable, site property,
/// setting, timer) ended with ';' (41 declarations of the round of 20:33: "unknown declaration clause ''"); and the default of
/// a variable written as the raw property, os:DefaultValue=v, which is the variable's `= v` (the expression as written: a
/// text in quotes is that text, never the bare words the raw form reads; a quoted value of a typed variable is that type's
/// literal, LITERAL_FOLDED). Only when os:DefaultValue is the statement's last clause.</item>
/// <item>FLOW_END_AFTER_TERMINATOR (logic text): a bare `end` right after `navigate`, `raise` or `end` at the same depth
/// (24 texts of the same round: "unexpected line: end"): the branch already ended, the line is left blank.</item>
/// <item>FLOW_ASSIGN_WRITTEN (logic text): a statement line `Target = value` the grammar rejects (a target with a dot, or a
/// value that is no node) is the assignment `assign Target = value` (the round of 20:34: an assignment indented under the
/// action, after an assign block; "expected '('"). Two assignments in one Assign node or in two run the same way.</item>
/// </list>
/// </summary>
public static class TextForms
{
    public const string DdlDeclaration = "DDL_DECLARATION_NORMALIZED";
    public const string FlowEnd = "FLOW_END_AFTER_TERMINATOR";
    public const string FlowAssign = "FLOW_ASSIGN_WRITTEN";
    public const string FlowKindPrefix = "FLOW_KIND_PREFIX_DROPPED";

    public static void Normalize(JsonArray ops, string? prefix, string lane, List<JsonObject> done)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["data"] is not JsonObject data) continue;
            var at = prefix == null ? null : $"{prefix}/{i}";
            try
            {
                if (op["op"]?.ToString() == "spec" && data["ddl"] is JsonValue dv && dv.TryGetValue<string>(out var ddl)
                    && Ddl(ddl, lane, at == null ? null : at + "/data/ddl", done) is { } written)
                    data["ddl"] = written;
                if (op["op"]?.ToString() == "logic" && data.ContainsKey("flow"))
                    FlowTexts.Rewrite(data, at, (text, path) => Flow(text, path, done));
            }
            catch { /* a normalization never refuses: the checks judge what stays */ }
        }
    }

    // ---- ssam-ddl/1 ------------------------------------------------------------------------------------------------------

    private static readonly Regex LineStatement = new(@"^\s*(client variable|session variable|site property|setting|timer)\s", RegexOptions.Compiled);
    private static readonly Regex VariableStatement = new(@"^\s*(client variable|session variable|site property|setting)\s+([A-Za-z_][A-Za-z0-9_]*|\[[^\]]*\])\s*(?::\s*(\[[^\]]*\]|[A-Z][A-Za-z0-9_]*(?: [A-Z][A-Za-z0-9_]*)*))?", RegexOptions.Compiled);

    private static string? Ddl(string text, string lane, string? path, List<JsonObject> done)
    {
        var closed = DdlTypeBraceNormalization.Normalize(text, lane, path, done);
        if (closed != null) text = closed;
        var lf = text.Replace("\r\n", "\n");
        var lines = lf.Split('\n');
        var errorLines = Errors(lf, lane);
        var changed = new Dictionary<int, (string From, string Why)>();
        for (var k = 0; k < lines.Length; k++)
        {
            var line = lines[k];
            if (!LineStatement.IsMatch(line)) continue;
            var written = line;
            var why = new List<string>();
            // os:DefaultValue=v as the last clause of a variable: the variable's `= v`.
            if (VariableStatement.Match(written) is { Success: true } v && OsDefault(written, v.Groups[3].Success ? v.Groups[3].Value : null) is { } rewritten)
            {
                why.Add("os:DefaultValue=v is the variable's default, written `= v` (the expression as written)"
                    + (TrailingSemicolon(written) != null ? "; a line statement ends at the end of its line, the ';' is dropped" : ""));
                written = rewritten;
            }
            // A ';' that ends a line statement, on a line the grammar rejects.
            if (errorLines.Contains(k + 1) && TrailingSemicolon(written) is { } cut)
            {
                written = cut;
                why.Add("a line statement ends at the end of its line; the ';' is dropped");
            }
            if (written == line) continue;
            changed[k] = (line, string.Join("; ", why));
            lines[k] = written;
        }
        if (changed.Count == 0) return closed;
        // Kept only where the line parses now (a rewrite never trades one error for another).
        var after = Errors(string.Join("\n", lines), lane);
        foreach (var k in changed.Keys.ToList())
            if (after.Contains(k + 1)) { lines[k] = changed[k].From; changed.Remove(k); }
        if (changed.Count == 0) return closed;
        foreach (var (k, (from, why)) in changed.OrderBy(c => c.Key))
            done.Add(JobNormalizer.Entry(DdlDeclaration, path, from.Trim(), lines[k].Trim(), $"line {k + 1}: {why}"));
        return string.Join("\n", lines);
    }

    /// <summary>The lines (1-based) the data text's parse refuses; empty when it parses.</summary>
    private static HashSet<int> Errors(string text, string lane)
    {
        try { DdlParser.Parse(text, lane); return []; }
        catch (DdlParseException error) { return error.Errors.Select(e => e.Line).ToHashSet(); }
        catch { return []; }
    }

    /// <summary>The line without the ';' that ends it (outside texts, before a `-- ` comment), or null.</summary>
    private static string? TrailingSemicolon(string line)
    {
        var end = CodeEnd(line);
        var code = line[..end].TrimEnd();
        if (!code.EndsWith(';')) return null;
        var cut = code[..^1].TrimEnd();
        return cut + (end < line.Length ? " " + line[end..].TrimStart() : "");
    }

    /// <summary>Where the code of a data line ends: at a `--` comment outside quotes (or the end of the line).</summary>
    private static int CodeEnd(string line)
    {
        var quoted = false;
        for (var i = 0; i < line.Length; i++)
        {
            if (line[i] == '"') { quoted = !quoted; continue; }
            if (!quoted && line[i] == '-' && i + 1 < line.Length && line[i + 1] == '-' && (i == 0 || line[i - 1] == ' ')) return i;
        }
        return line.Length;
    }

    private static readonly HashSet<string> TextTypes = new(StringComparer.OrdinalIgnoreCase) { "Text", "Long Text", "Email", "Phone Number" };

    /// <summary>The variable line with its last clause os:DefaultValue=v written `= v`, or null when it has none (or other
    /// clauses follow it, or a quoted value of a typed variable has no literal of that type).</summary>
    private static string? OsDefault(string line, string? type)
    {
        var end = CodeEnd(line);
        var code = line[..end];
        var at = code.IndexOf(" os:DefaultValue=", StringComparison.Ordinal);
        if (at < 0) return null;
        var start = at + " os:DefaultValue=".Length;
        var value = code[start..].TrimEnd();
        if (value.EndsWith(';')) value = value[..^1].TrimEnd();
        if (value.Length == 0) return null;
        // The value runs to the end of the code: one expression (a text with its quotes, a call, a number), nothing after it.
        var (scanned, stop) = DdlScanner.ScanExpression(value + "\n", 0, DdlStop.Line);
        if (scanned.Trim() != value || stop != value.Length) return null;
        var quoted = value.Length >= 2 && value[0] == '"' && value[^1] == '"';
        if (quoted && type != null && !TextTypes.Contains(type.Trim()) && LiteralFolding.Fold(value, type) is not { } typed) return null;
        return code[..at] + " = " + value + (end < line.Length ? " " + line[end..].TrimStart() : "");
    }

    // ---- ssam-flow/1 -----------------------------------------------------------------------------------------------------

    private static readonly Regex LineError = new(@"^line (\d+): ", RegexOptions.Compiled);
    private static readonly Regex Assignment = new(@"^(?<target>[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]*\])*) = (?<value>.+)$", RegexOptions.Compiled);
    // The words a statement line of the grammar starts with: such a line is never an assignment (a whole word, so a target
    // named endDate or assignedTo is not one of them).
    private static readonly Regex Keyword = new(@"^(?:(?:if|switch|foreach|assign|end|raise|navigate|refresh|message|trigger|opaque|node|aggregate|javascript|sql|on|in|out|local|next|case|otherwise|unreached)\b|//|->|@\{|\||JSONSerialize\(|JSONDeserialize\()", RegexOptions.Compiled);

    private static string? Flow(string text, string? path, List<JsonObject> done)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var changed = false;
        for (var guard = 0; guard < lines.Length * 2; guard++)
        {
            var failures = Failures(string.Join("\n", lines));
            var corrected = false;
            foreach (var line in failures)
            {
                if (line < 1 || line > lines.Length) continue;
                var raw = lines[line - 1];
                var depth = raw.Length - raw.TrimStart(' ').Length;
                var body = raw.Trim();
                string? written = null; string? rule = null; string? why = null;
                if (DropKindPrefixes(raw) is { } untyped)
                {
                    written = untyped; rule = FlowKindPrefix;
                    why = $"line {line}: an internal I<Kind>: prefix is omitted from the action name in ssam-flow/1";
                }
                else if (body == "end" && Terminator(lines, line - 1, depth) is { } ended)
                {
                    written = ""; rule = FlowEnd;
                    why = $"line {line}: `end` after `{ended.Kind}` (line {ended.Line}), which already ends the branch: the line is dropped";
                }
                else if (Assignment.Match(body) is { Success: true } m && !Keyword.IsMatch(body) && !NamedNode(m.Groups["target"].Value, m.Groups["value"].Value))
                {
                    written = raw[..depth] + "assign " + body; rule = FlowAssign;
                    why = $"line {line}: `{m.Groups["target"].Value} = ...` is an assignment, written `assign {m.Groups["target"].Value} = ...`";
                }
                if (written == null) continue;
                var before = lines[line - 1];
                lines[line - 1] = written;
                // The collecting parse can prove this line even when an unrelated earlier line is invalid.
                var after = Failures(string.Join("\n", lines));
                if (after.Contains(line) || after.Any(next => next < line && !failures.Contains(next))) { lines[line - 1] = before; continue; }
                changed = true;
                var entry = JobNormalizer.Entry(rule!, path, before.Trim(), written.Trim().Length == 0 ? null : written.Trim(), why!);
                entry["line"] = line;
                done.Add(entry);
                corrected = true;
                break;
            }
            if (!corrected) break;
        }
        return changed ? string.Join("\n", lines) : null;
    }

    // A node line: [Name = ]Callee(...) or [Name = ]<node kind> ... (FlowParser.Head). The node kinds in any case (junction
    // 24-1-final, with tx-visitacerta's rule: `R = Aggregate FROM ...` is a malformed node line, never an assignment).
    private static readonly Regex NodeValue = new(@"^(?:\(System\)\.)?(?:I\w*:)?[A-Za-z_][A-Za-z0-9_.]*\s*\(|^(?:aggregate|sql|javascript|node|opaque|JSONSerialize\(|JSONDeserialize\()", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex KindPrefix = new(@"(?<!\w)I[A-Z][A-Za-z0-9]*:(?=[A-Za-z_]\w*)", RegexOptions.Compiled);

    // Only code is rewritten: quoted literals and the printed node label after two spaces + # keep their exact text.
    private static string? DropKindPrefixes(string line)
    {
        var result = new System.Text.StringBuilder(line.Length);
        var start = 0;
        var changed = false;
        for (var i = 0; i <= line.Length; i++)
        {
            var quote = i < line.Length && line[i] == '"';
            var label = i + 2 < line.Length && line[i] == ' ' && line[i + 1] == ' ' && line[i + 2] == '#';
            if (i < line.Length && !quote && !label) continue;
            var code = line[start..i];
            var rewritten = KindPrefix.Replace(code, "");
            changed |= code != rewritten;
            result.Append(rewritten);
            if (label) { result.Append(line[i..]); break; }
            if (quote)
            {
                var end = i + 1;
                while (end < line.Length)
                {
                    if (line[end] == '"')
                    {
                        if (end + 1 < line.Length && line[end + 1] == '"') { end += 2; continue; }
                        end++; break;
                    }
                    if (line[end] == '\\' && end + 1 < line.Length) end++;
                    end++;
                }
                result.Append(line[i..end]);
                i = end - 1;
                start = end;
            }
        }
        return changed ? result.ToString() : null;
    }

    /// <summary>Whether `Target = value` may also be a node named Target (an identifier target and a value that starts like a
    /// node: a call, an aggregate, a SQL...): then it has two readings and is never rewritten. A target with a dot or an index
    /// is never a node's name.</summary>
    private static bool NamedNode(string target, string value) => !target.Contains('.') && !target.Contains('[') && NodeValue.IsMatch(value.TrimStart());

    /// <summary>Every failing line the parser can identify, including lines after an independent syntax error.</summary>
    private static IReadOnlyList<int> Failures(string text)
    {
        try { ModuleFlow.Read(text); return []; }
        catch (FlowSyntaxException error) { return error.Errors.Select(Line).OfType<int>().Distinct().ToArray(); }
        catch (FormatException error) { return Line(error.Message) is { } line ? [line] : []; }
        catch { return []; }
        static int? Line(string message) => LineError.Match(message) is { Success: true } m ? int.Parse(m.Groups[1].Value) : null;
    }

    /// <summary>The terminator (navigate, raise, end, a node that ends) the line before <paramref name="index"/> at the same
    /// depth is, skipping the lines under it; null when that line starts the block or is no terminator.</summary>
    private static (string Kind, int Line)? Terminator(string[] lines, int index, int depth)
    {
        for (var k = index - 1; k >= 0; k--)
        {
            var line = lines[k];
            if (line.Trim().Length == 0) continue;
            var d = line.Length - line.TrimStart(' ').Length;
            if (d > depth) continue;
            if (d < depth) return null;
            var body = line.Trim();
            var head = FlowSyntax.SplitKey(body, out var split, out _) ? split : body;
            if (head.StartsWith("navigate ", StringComparison.Ordinal)) return ("navigate", k + 1);
            if (head.StartsWith("raise ", StringComparison.Ordinal)) return ("raise", k + 1);
            if (head == "end" || head.StartsWith("end  # ", StringComparison.Ordinal)) return ("end", k + 1);
            if ((head.StartsWith("node ", StringComparison.Ordinal) || head.StartsWith("opaque ", StringComparison.Ordinal) || head.Contains(" = node ", StringComparison.Ordinal) || head.Contains(" = opaque ", StringComparison.Ordinal))
                && Regex.IsMatch(head, @" end(  # .*)?$")) return ("end", k + 1);
            return null;
        }
        return null;
    }
}

/// <summary>The texts of a logic op's data.flow (a text, a list of texts, a list of {text, basedOn}), rewritten in place.</summary>
public static class FlowTexts
{
    /// <summary>Each text through <paramref name="rewrite"/> (text, pointer of the text in the job) and written back when it
    /// returns a new one.</summary>
    public static void Rewrite(JsonObject data, string? opPointer, Func<string, string?, string?> rewrite)
    {
        switch (data["flow"])
        {
            case JsonValue single when single.TryGetValue<string>(out var text):
                if (rewrite(text, opPointer == null ? null : opPointer + "/data/flow") is { } one) data["flow"] = one;
                break;
            case JsonArray items:
                for (var i = 0; i < items.Count; i++)
                {
                    var at = opPointer == null ? null : $"{opPointer}/data/flow/{i}";
                    if (items[i] is JsonValue v && v.TryGetValue<string>(out var t) && rewrite(t, at) is { } written) items[i] = written;
                    else if (items[i] is JsonObject o && o["text"] is JsonValue tv && tv.TryGetValue<string>(out var ot) && rewrite(ot, at) is { } itemText) o["text"] = itemText;
                }
                break;
        }
    }
}
