using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// C-26 (F-FitBody-27, -41; PLANO F1.3): the short form of a screen aggregate, from="..." join="...", read by ONE parser.
/// Before, three disagreed: the compile split the joins at ';' and took the first source of from as the left side of every
/// join (Verbs.ScreenDocument.AggregateShortForm), the preflight split them at ',' (Preflight/DocumentAggregates.Sources) and
/// the document rules read from= as one token (ScreenDocument.AggregateSources). A chained join (FBExercise, then FBRoutine,
/// then FBRoutineItem on FBRoutineItem.RoutineId = FBRoutine.Id) was written with FBExercise on its left, and the Verify
/// answered "Can't identify 'FBRoutine'" twice; the model was denormalized to get around it.
/// <list type="bullet">
/// <item>from: sources at the top level separated by ','; each <c>Entity</c> (its alias is its name) or <c>Alias=Entity</c>.</item>
/// <item>join: joins separated by ';'; each <c>[Left~]Right on condition</c>, Right being <c>Entity</c> or <c>Alias=Entity</c>.</item>
/// <item>The left side of a join: the one it declares (<c>Left~</c>, as the JOIN of ssam-flow/1 writes A~B), else the one
/// source declared before it (from, then the joins before it) that its condition reads besides its right side, else the first
/// source. A join reads its two sources only (the Verify: "Can't identify" any other): a condition that reads two sources
/// besides its right side, or a declared left side it does not read with another source, is a problem with its fix.</item>
/// </list>
/// </summary>
public static partial class ScreenDocument
{
    internal sealed record AggregateSource(string Alias, string Entity);
    internal sealed record AggregateJoin(string Left, string Right, string Entity, string Condition, bool Declared);
    internal sealed record AggregateShape(IReadOnlyList<AggregateSource> Sources, IReadOnlyList<AggregateJoin> Joins, IReadOnlyList<string> Problems)
    {
        /// <summary>Every source by alias: from= and the right side of each join.</summary>
        public IEnumerable<AggregateSource> All => Sources.Concat(Joins.Select(j => new AggregateSource(j.Right, j.Entity)));
    }

    private static readonly Regex JoinPart = new(@"^\s*(?:([A-Za-z_][A-Za-z0-9_]*)\s*~\s*)?(\S+)\s+on\s+(.+)$", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>The sources and joins of a short-form aggregate. Problems name the part that is not the form (the compile
    /// refuses it with its fix); the rest is still read.</summary>
    internal static AggregateShape ParseAggregate(string? from, string? join)
    {
        var sources = new List<AggregateSource>(); var joins = new List<AggregateJoin>(); var problems = new List<string>();
        foreach (var part in SplitTopLevel(from ?? "", ','))
            sources.Add(Source(part));
        var declared = sources.Select(s => s.Alias).ToList();
        foreach (var part in SplitTopLevel(join ?? "", ';'))
        {
            var m = JoinPart.Match(part);
            if (!m.Success) { problems.Add($"join=\"{part}\" is not '[Left~]<Entity> on <condition>'"); continue; }
            var right = Source(m.Groups[2].Value);
            var condition = m.Groups[3].Value.Trim();
            string left;
            var explicitLeft = m.Groups[1].Success;
            // The sources declared before it that the condition reads (Alias.Attribute), besides its right side.
            var read = declared.Where(d => !string.Equals(d, right.Alias, StringComparison.OrdinalIgnoreCase) && Names(condition, d)).ToList();
            if (explicitLeft)
            {
                left = declared.FirstOrDefault(d => string.Equals(d, m.Groups[1].Value, StringComparison.OrdinalIgnoreCase)) ?? m.Groups[1].Value;
                if (!declared.Contains(left, StringComparer.OrdinalIgnoreCase)) problems.Add($"join=\"{part}\": {left} is no source declared before it (from, or a join before it)");
                else if (read.Any(r => !string.Equals(r, left, StringComparison.OrdinalIgnoreCase)))
                    problems.Add($"join=\"{part}\": its condition reads {string.Join(", ", read.Where(r => !string.Equals(r, left, StringComparison.OrdinalIgnoreCase)))}, which is neither its left side ({left}) nor its right side ({right.Alias}): a join reads its two sources only");
            }
            else
            {
                left = read.Count == 1 ? read[0] : declared.FirstOrDefault() ?? right.Alias;
                if (read.Count > 1)
                    problems.Add($"join=\"{part}\": its condition reads {string.Join(" and ", read)} besides {right.Alias}: a join reads its two sources only (the Verify answers \"Can't identify\" the other)");
            }
            joins.Add(new AggregateJoin(left, right.Alias, right.Entity, condition, explicitLeft));
            declared.Add(right.Alias);
        }
        return new AggregateShape(sources, joins, problems);
    }

    private static AggregateSource Source(string text)
    {
        var part = text.Trim();
        var eq = part.IndexOf('=');
        if (eq > 0 && Regex.IsMatch(part[..eq].Trim(), @"^[A-Za-z_][A-Za-z0-9_]*$")) return new(part[..eq].Trim(), part[(eq + 1)..].Trim());
        var bare = part[(part.LastIndexOf(':') + 1)..];
        return new(bare[(bare.LastIndexOf('.') + 1)..], part);
    }

    // Whether the condition reads an attribute of the source (Alias.X), outside its text literals.
    private static bool Names(string condition, string alias)
    {
        var code = Regex.Replace(condition, "\"(?:[^\"]|\"\")*\"", "\"\"");
        return Regex.IsMatch(code, @"(?<![A-Za-z0-9_.])" + Regex.Escape(alias) + @"\s*\.", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }

    /// <summary>A list split at the top level only (strings and parentheses nest), each part trimmed, the empty ones dropped.</summary>
    internal static List<string> SplitTopLevel(string text, char separator)
    {
        var parts = new List<string>(); var depth = 0; var inString = false; var start = 0;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (inString) { if (c == '"') inString = false; continue; }
            if (c == '"') inString = true;
            else if (c is '(' or '[' or '{') depth++;
            else if (c is ')' or ']' or '}') depth--;
            else if (c == separator && depth == 0) { parts.Add(text[start..i]); start = i + 1; }
        }
        parts.Add(text[start..]);
        return parts.Select(p => p.Trim()).Where(p => p.Length > 0).ToList();
    }
}
