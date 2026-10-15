using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>A type whose next declaration (or end of text) follows valid fields has one missing closing brace.
/// Each proposed closure must parse as exactly that one type; an invalid field is never hidden by the rewrite.</summary>
public static class DdlTypeBraceNormalization
{
    public const string Rule = "DDL_TYPE_BRACE_ADDED";
    private static readonly Regex TypeStart = new(@"^\s*type\s+.+\s*=\s*\{", RegexOptions.CultureInvariant);
    private static readonly Regex Declaration = new(@"^\s*(?:type|create|site property|setting|client variable|session variable|timer|on|sample|drop)\s+", RegexOptions.CultureInvariant);

    public static string? Normalize(string text, string lane, string? path, List<JsonObject> done)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n').ToList();
        var additions = new List<(int Start, int Before, string Name)>();
        for (var start = 0; start < lines.Count; start++)
        {
            if (!TypeStart.IsMatch(lines[start])) continue;
            var end = start + 1;
            while (end < lines.Count && !Declaration.IsMatch(lines[end])) end++;
            // Descriptions immediately before the next declaration belong to that declaration, not the last field.
            var before = end;
            while (before > start + 1 && (string.IsNullOrWhiteSpace(lines[before - 1]) || lines[before - 1].TrimStart().StartsWith("///", StringComparison.Ordinal))) before--;
            var block = string.Join("\n", lines.Skip(start).Take(before - start));
            if (Parses(block, lane) != null) continue;
            if (Parses(block + "\n}", lane) is not { } parsed) continue;
            additions.Add((start, before, parsed.Name));
        }
        if (additions.Count == 0) return null;
        foreach (var edit in additions.OrderByDescending(e => e.Before)) lines.Insert(edit.Before, "}");
        foreach (var edit in additions)
        {
            var entry = JobNormalizer.Entry(Rule, path, $"line {edit.Start + 1}: {text.Replace("\r\n", "\n").Split('\n')[edit.Start].Trim()}", "}",
                $"line {edit.Before + 1}: close type {edit.Name} before the next declaration or end of text; its fields parse unchanged");
            entry["line"] = edit.Before + 1;
            done.Add(entry);
        }
        return string.Join("\n", lines);
    }

    private static DdlElement? Parses(string block, string lane)
    {
        try
        {
            var doc = DdlParser.Parse(block, lane);
            return doc.Elements.Count == 1 && doc.Elements[0].Kind == "Structure" ? doc.Elements[0] : null;
        }
        catch (DdlParseException) { return null; }
    }
}
