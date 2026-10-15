using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>Small edits to the author's source, located by a parsed node rather than a textual function-name guess.</summary>
public static class VerifySourceEdits
{
    public static string? AddFlowArgument(string text, string nodeName, string calleeName, string argument, string value)
    {
        FlowItem action;
        Dictionary<string, int> locations;
        try { action = ModuleFlow.Read(text); locations = FlowParser.NodeLines(text); }
        catch (FormatException) { return null; }
        static string Simple(string name) => name[(Math.Max(name.LastIndexOf('.'), name.LastIndexOf(':')) + 1)..];
        var calls = action.Items.Where(n => n.Kind == "Execute" && n.Prop("Action") is { } target
            && string.Equals(Simple(target), calleeName, StringComparison.OrdinalIgnoreCase)
            && (nodeName.Length == 0 || string.Equals(n.Name, nodeName, StringComparison.OrdinalIgnoreCase))).ToList();
        if (calls.Count != 1 || calls[0].Items.Any(a => a.Role == "argument" && a.Name.Equals(argument, StringComparison.OrdinalIgnoreCase))) return null;
        var call = calls[0];
        if (!locations.TryGetValue(call.Key, out var line)) return null;
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var raw = lines[line - 1];
        var targetText = call.Prop("Action")!;
        var open = raw.IndexOf(targetText + "(", StringComparison.Ordinal);
        if (open < 0) return null;
        open += targetText.Length;
        var close = FlowSyntax.Scan(raw, open + 1, [")"]);
        if (close < 0 || close >= raw.Length || raw[close] != ')') return null;
        lines[line - 1] = raw[..close] + (close == open + 1 ? "" : ", ") + argument + "=" + value + raw[close..];
        var written = string.Join("\n", lines);
        try { ModuleFlow.Read(written); return written; } catch (FormatException) { return null; }
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
