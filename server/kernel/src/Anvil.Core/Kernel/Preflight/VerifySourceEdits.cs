using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>Small edits to the author's source, located by a parsed node rather than a textual function-name guess.</summary>
public static class VerifySourceEdits
{
    public static string? AddFlowArgument(string text, string nodeName, string calleeName, string argument, string value)
    {
        if (FlowCallLocation(text, nodeName, calleeName) is not { } located) return null;
        var (call, line) = located;
        if (call.Items.Any(a => a.Role == "argument" && a.Name.Equals(argument, StringComparison.OrdinalIgnoreCase))) return null;
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var raw = lines[line - 1];
        var targetText = call.Prop("Action")!;
        var open = raw.IndexOf(targetText + "(", StringComparison.Ordinal);
        if (open < 0) return null;
        open += targetText.Length;
        var close = CallClose(raw, open + 1);
        if (close < 0 || close >= raw.Length || raw[close] != ')') return null;
        var added = argument + "=" + FlowSyntax.Expr(value, [",", ")"]);
        var slots = NamedArgumentSlots(raw, open + 1, close);
        if (slots != null && slots.Count > 0 && slots.Zip(slots.Skip(1), (a, b) => StringComparer.Ordinal.Compare(a.Name, b.Name) < 0).All(sorted => sorted)) {
            var before = slots.FindIndex(s => StringComparer.Ordinal.Compare(argument, s.Name) < 0);
            var spacing = slots.Count > 1 ? raw[(slots[0].End + 1)..slots[1].Start] : " ";
            if (before >= 0) {
                var at = slots[before].Start;
                if (before > 0) spacing = raw[(slots[before - 1].End + 1)..at];
                lines[line - 1] = raw[..at] + added + "," + spacing + raw[at..];
            } else {
                var at = close;
                lines[line - 1] = raw[..at] + "," + spacing + added + raw[at..];
            }
        } else lines[line - 1] = raw[..close] + (string.IsNullOrWhiteSpace(raw[(open + 1)..close]) ? "" : ", ") + added + raw[close..];
        var written = string.Join("\n", lines);
        try { ModuleFlow.Read(written); return written; } catch (FormatException) { return null; }
    }

    // The diagnostic and its edit share this exact selector; duplicate/unresolvable calls never offer a guessed focus.
    internal static (FlowItem Call, int Line)? FlowCallLocation(string text, string nodeName, string calleeName)
    {
        FlowItem action;
        Dictionary<string, int> locations;
        try { action = ModuleFlow.Read(text); locations = FlowParser.NodeLines(text); }
        catch (FormatException) { return null; }
        static string Simple(string name) => name[(Math.Max(name.LastIndexOf('.'), name.LastIndexOf(':')) + 1)..];
        var calls = action.Items.Where(n => n.Kind == "Execute" && n.Prop("Action") is { } target
            && string.Equals(Simple(target), calleeName, StringComparison.OrdinalIgnoreCase)
            && (nodeName.Length == 0 || string.Equals(n.Name, nodeName, StringComparison.OrdinalIgnoreCase))).ToList();
        if (calls.Count != 1 || !locations.TryGetValue(calls[0].Key, out var line)) return null;
        return (calls[0], line);
    }

    /// <summary>One-based columns around a missing argument's own insertion. Both calls and named slots are parsed,
    /// so occurrences of the argument inside strings or nested calls can never anchor the receipt.</summary>
    internal static (int Before, int After)? FlowArgumentColumns(string before, string after, string nodeName, string calleeName, string argument)
    {
        if (FlowCallLocation(before, nodeName, calleeName) is not { } original
            || FlowCallLocation(after, nodeName, calleeName) is not { } corrected
            || AddFlowArgument(before, nodeName, calleeName, argument, "0") is not { } sample) return null;
        var originalLine = before.Replace("\r\n", "\n").Split('\n')[original.Line - 1];
        var sampleLine = sample.Replace("\r\n", "\n").Split('\n')[original.Line - 1];
        var at = 0;
        while (at < originalLine.Length && at < sampleLine.Length && originalLine[at] == sampleLine[at]) at++;
        var correctedLine = after.Replace("\r\n", "\n").Split('\n')[corrected.Line - 1];
        var target = corrected.Call.Prop("Action")!;
        var open = correctedLine.IndexOf(target + "(", StringComparison.Ordinal);
        if (open < 0) return null;
        open += target.Length;
        var close = CallClose(correctedLine, open + 1);
        if (close < 0) return null;
        var slots = NamedArgumentSlots(correctedLine, open + 1, close);
        if (slots == null) return null;
        var matching = slots.Where(s => s.Name.Equals(argument, StringComparison.OrdinalIgnoreCase)).ToList();
        return matching.Count == 1 ? (at + 1, matching[0].Start + 1) : null;
    }

    private static int CallClose(string line, int start)
    {
        var at = start;
        try {
            while (at < line.Length) {
                var end = FlowSyntax.Scan(line, at, ["`", ")"]);
                if (end < 0 || end >= line.Length) return -1;
                if (line[end] == ')') return end;
                at = end;
                FlowSyntax.ReadEscaped(line, ref at);
            }
        } catch (FormatException) { return -1; }
        return -1;
    }

    // Canonical flow prints named arguments in ordinal order. Insert in that order only when the source already
    // follows it; bare names are the grammar's shorthand for Name=Name. An author's different ordering gets an append.
    private static List<(string Name, int Start, int End)>? NamedArgumentSlots(string line, int start, int close)
    {
        var result = new List<(string Name, int Start, int End)>();
        var at = start;
        try {
            while (at < close) {
                while (at < close && char.IsWhiteSpace(line[at])) at++;
                if (at == close) break;
                var nameStart = at;
                while (at < close && (char.IsLetterOrDigit(line[at]) || line[at] == '_')) at++;
                var name = line[nameStart..at];
                if (!FlowSyntax.IsIdentifier(name)) return null;
                while (at < close && char.IsWhiteSpace(line[at])) at++;
                if (at < close && line[at] == '=') {
                    at++;
                    while (at < close && char.IsWhiteSpace(line[at])) at++;
                    FlowSyntax.ReadExpr(line, ref at, [",", ")"]);
                    while (at < close && char.IsWhiteSpace(line[at])) at++;
                } else if (at < close && line[at] != ',') return null;
                if (at > close || at < 0) return null;
                result.Add((name, nameStart, at));
                if (at == close) break;
                if (line[at] != ',') return null;
                at++;
            }
        } catch (FormatException) { return null; }
        return result;
    }

    /// <summary>Only expression spans inside the named list; event parameter names, literals and nested lists stay intact.</summary>
    public static string? QualifyListValue(string html, string listSource, string unknown, string field)
    {
        var document = HtmlText.Parse(html);
        var lists = document.Root.Descendants().Where(e => e.Get("list") == listSource).ToList();
        if (lists.Count != 1) return null;
        var list = lists[0];
        var edits = new List<HtmlText.Edit>();
        foreach (var element in list.Descendants())
        {
            var nested = false;
            for (var parent = element.Parent; parent != null && !ReferenceEquals(parent, list); parent = parent.Parent)
                if (parent.Get("list") != null) { nested = true; break; }
            if (nested || element.Get("list") != null) continue;
            foreach (var (start, end) in HtmlText.ExpressionSpans(html, element, includeList: false))
                edits.AddRange(HtmlText.RenameRoot(html, start, end, unknown, listSource + ".Current." + field));
        }
        return edits.Count == 0 ? null : HtmlText.Apply(html, edits);
    }

    public static string? TypeDefault(string type) => type.Trim() switch
    {
        "Boolean" => "False",
        "Integer" or "Long Integer" or "Decimal" or "Currency" => "0",
        "Text" or "Long Text" or "Email" or "Phone Number" => "\"\"",
        _ when type.EndsWith(" Identifier", StringComparison.Ordinal) => "NullIdentifier()",
        _ => null,
    };
}
