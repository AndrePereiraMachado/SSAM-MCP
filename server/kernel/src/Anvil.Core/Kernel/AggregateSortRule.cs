using System.Globalization;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// The aggregate sort as the Studio writes it (publish error P0 of 2026-10-12, VisitaCerta_CS): a sort that is not dynamic
/// names ONE attribute of a source of its aggregate (`Source.Attribute`) or one of its columns (a calculated, group by or
/// aggregated column), and its direction is only SortDirection. The Studio's editor offers nothing else; the Model API takes any
/// typed expression in ISort.Attribute, the Verify accepts it, and the OutSystems compiler fails on it (AttributeSort sees a root
/// that is not an attribute and goes down GenerateDynamicOrderByNode: "Dump is not a valid invocation for SQLCallFunction" for
/// `-IdentifierToLongInteger(X.Id)`, a NullReferenceException in AttributeSort.get_Old_IsDynamic for `If(...)`).
/// An expression sort exists only as a dynamic sort (IsDynamic, a Text expression with the ORDER BY).
/// <list type="bullet">
/// <item>Normalize: the forms whose meaning is one attribute and a direction, rewritten to it (certain): a direction word
/// (`X DESC`, `X asc`, any case), a minus sign (`-X`: descending), parentheses, a conversion that keeps the order
/// (`IdentifierToLongInteger(X)`, ...), and `If(C, a, b)` with C a reference and a, b two different number literals (C
/// descending when a &lt; b: the rows where C holds come first). Any combination: `-IdentifierToLongInteger(X.Id)` is X.Id
/// descending.</item>
/// <item>Everything else (an If over a variable, arithmetic, a function that changes the order) is not one attribute: refused
/// with the fix (a column with the expression and the sort by the column, or a dynamic sort), never guessed.</item>
/// <item>OutOfScope: a plain name must be a source of the same aggregate (two segments) or one of its columns (one segment); a
/// variable (`SortMode`) is a plain name that is neither.</item>
/// </list>
/// Writers: the flow text (FlowDiff.Sorts.cs, before the diff, so the action reads back as the normalized text), the raw `set`
/// of ISort.Attribute and every expander that writes through it (ModelSession.SortAttribute in AggregateSortRule.Model.cs: JSON
/// logic, html, screen, prototype). The checagem de compilação (CompileCheck.cs) refuses what is left, on the candidate, before
/// anything is saved.
/// This file is text only (no model, no preflight, no catalog): the ODC builder links it with FlowParse.cs. What reads the
/// model or the built-in catalog lives in AggregateSortRule.Model.cs, compiled by Anvil.Core and Anvil.Core.Odc only.
/// </summary>
public static partial class AggregateSortRule
{
    /// <summary>The platform and SQL names of a join, shared by JSON logic and flow text.</summary>
    public static string? JoinKindOf(string text)
        => Regex.Replace(text, @"[\s_-]+", "").ToLowerInvariant() switch
        {
            "onlywith" or "inner" or "innerjoin" => "Inner",
            "withorwithout" or "left" or "leftjoin" or "leftouter" or "leftouterjoin" => "Left",
            "with" or "full" or "fulljoin" or "fullouter" or "fullouterjoin" => "Full",
            "right" or "rightjoin" or "rightouter" or "rightouterjoin" => "Right",
            "none" => "None",
            _ => null,
        };
    public const string Code = "AGGREGATE_SORT_NOT_ATTRIBUTE";
    public const string ColumnCode = "AGGREGATE_COLUMN_NOT_ATTRIBUTE";
    public const string NormalizedCode = "AGGREGATE_SORT_NORMALIZED";

    /// <summary>A sort key as one attribute: the attribute, whether the direction is reversed, and the rules that got there
    /// (empty: the text was already the attribute).</summary>
    public sealed record Key(string Attribute, bool Flip, IReadOnlyList<string> Steps);

    private static readonly Regex PlainPath = new(@"^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)?$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex DirectionWord = new(@"^(.*?\S)\s+(asc|ascending|desc|descending)$", RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnoreCase | RegexOptions.Singleline);
    private static readonly Regex CallHead = new(@"^([\p{L}_][\p{L}\p{N}_]*)\s*\(", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex NumberLiteral = new(@"^-?\s*\d+(?:\.\d+)?$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>The built-in conversions whose result orders the rows as their argument does (strictly monotonic). A conversion
    /// to Text is not one ("10" sorts before "9").</summary>
    public static readonly IReadOnlySet<string> OrderPreserving = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "IdentifierToLongInteger", "IdentifierToInteger", "IntegerToIdentifier", "LongIntegerToIdentifier",
        "IntegerToLongInteger", "LongIntegerToInteger", "IntegerToDecimal", "LongIntegerToDecimal",
    };

    /// <summary>The text as a plain reference (`Name` or `Source.Attribute`), trimmed; null when it is anything else.</summary>
    public static string? Plain(string? text)
    {
        var trimmed = (text ?? "").Trim();
        return PlainPath.IsMatch(trimmed) ? trimmed : null;
    }

    /// <summary>The sort key as one attribute, or null when the text is not certainly one (an expression the kernel will not
    /// guess at). A plain text is itself with no steps.</summary>
    public static Key? Normalize(string? text)
    {
        var s = (text ?? "").Trim();
        var flip = false;
        var steps = new List<string>();
        for (var round = 0; round < 32 && s.Length > 0; round++)
        {
            if (Plain(s) is { } plain) return new(plain, flip, steps);
            if (DirectionWord.Match(s) is { Success: true } word)
            {
                var descending = word.Groups[2].Value.StartsWith("d", StringComparison.OrdinalIgnoreCase);
                if (descending) flip = !flip;
                steps.Add("'" + word.Groups[2].Value + "' is the direction (SortDirection " + (descending ? "Descending" : "Ascending") + "), not part of the attribute");
                s = word.Groups[1].Value.Trim();
                continue;
            }
            if (s[0] == '(' && Closing(s, 0) == s.Length - 1)
            {
                steps.Add("parentheses around the attribute");
                s = s[1..^1].Trim();
                continue;
            }
            if (s[0] == '-')
            {
                flip = !flip;
                steps.Add("a minus sign before the attribute is the descending direction");
                s = s[1..].Trim();
                continue;
            }
            if (s[0] == '+') { s = s[1..].Trim(); continue; }
            if (CallHead.Match(s) is { Success: true } call && Closing(s, call.Length - 1) == s.Length - 1)
            {
                var name = call.Groups[1].Value;
                var arguments = Arguments(s[call.Length..^1]);
                if (OrderPreserving.Contains(name) && arguments.Count == 1)
                {
                    steps.Add(name + "() keeps the order of its argument");
                    s = arguments[0];
                    continue;
                }
                if (name.Equals("If", StringComparison.OrdinalIgnoreCase) && arguments.Count == 3 && Plain(arguments[0]) is { } condition
                    && Number(arguments[1]) is { } whenTrue && Number(arguments[2]) is { } whenFalse && whenTrue != whenFalse)
                {
                    // Ascending by If(C, a, b): with a < b the rows where C holds come first, which is C descending (True > False).
                    if (whenTrue < whenFalse) flip = !flip;
                    steps.Add("If(" + condition + ", " + arguments[1].Trim() + ", " + arguments[2].Trim() + ") orders the rows by " + condition
                        + (whenTrue < whenFalse ? " descending (True first)" : " ascending (False first)"));
                    s = condition;
                    continue;
                }
            }
            return null;
        }
        return null;
    }

    /// <summary>Why a plain attribute is not one of this aggregate's (null when it is): two segments name a source, one segment
    /// names a column. Names have no case.</summary>
    public static string? OutOfScope(string attribute, IReadOnlyCollection<string> sources, IReadOnlyCollection<string> columns)
    {
        var dot = attribute.IndexOf('.');
        if (dot > 0)
        {
            var source = attribute[..dot];
            if (sources.Contains(source, StringComparer.OrdinalIgnoreCase)) return null;
            return "'" + source + "' is not a source of this aggregate" + (sources.Count > 0 ? " (sources: " + string.Join(", ", sources) + ")" : "");
        }
        if (columns.Contains(attribute, StringComparer.OrdinalIgnoreCase)) return null;
        return "'" + attribute + "' is not a column of this aggregate" + (columns.Count > 0 ? " (columns: " + string.Join(", ", columns) + ")" : " (it has no calculated, group by or aggregated column)")
            + " nor Source.Attribute";
    }

    /// <summary>The fix of a sort that is not one attribute.</summary>
    public static string Fix(string text) =>
        "a sort that is not dynamic names one attribute of a source (Source.Attribute, `desc` for the descending order) or one column of the aggregate; "
        + "for an order computed by an expression such as " + Shorten(text) + ", add a calculated column with that expression (CALC SortKey=<expression>) and sort by it (SORT SortKey), "
        + "or write a dynamic sort: a Text expression with the ORDER BY of the query (e.g. \"{Entity}.[Attribute] DESC\") marked dynamic";

    /// <summary>The fix of a group by or aggregated column whose attribute is not one attribute of a source: the expression as a
    /// calculated column (named after the column, `Row` appended, as a client module's published `AGG X=Sum(XRow) CALC XRow=...`), grouped
    /// or aggregated by name.</summary>
    public static string ColumnFix(string text, string column, bool group, string? function = null)
    {
        var calc = (column.Length > 0 ? column : "Value") + "Row";
        return "a group by or aggregated column names one attribute of a source (Source.Attribute) or a column of the aggregate; for " + Shorten(text)
            + ", add a calculated column with the expression and " + (group ? "group by" : "aggregate") + " that column: CALC " + calc + "=" + Shorten(text) + " and "
            + (group ? "GROUP BY " + (column.Length > 0 ? column + "=" : "") + calc : "AGG " + column + "=" + (function is { Length: > 0 } f ? f : "Sum") + "(" + calc + ")");
    }

    /// <summary>What a group by or aggregated column with an empty Attribute is (`AGG Total=Count()`).</summary>
    public const string EmptyColumnWhy = "reads no attribute";

    /// <summary>Where a grouped aggregate is written on ODC: the text reads it back opaque, so its fix names the logic op.</summary>
    public const string OdcGroupedByLogic = "; on ODC a grouped aggregate is written by the logic op (get with columns), the text reads it back opaque";

    /// <summary>The fix of a group by or aggregated column that reads no attribute: the attribute it reads. Count counts the rows
    /// of each group by the identifier of a source (<paramref name="source"/>, with its <paramref name="identifier"/>, when the
    /// aggregate has one source); Sum, Max, Min and Avg name the attribute they total; a group by column the one it groups by.</summary>
    public static string EmptyColumnFix(string column, bool group, string? function, string? source, string? identifier)
    {
        var name = column.Length > 0 ? column : "Value";
        var from = source is { Length: > 0 } ? source : "<Source>";
        if (group) return "a group by column names the attribute it groups by: GROUP BY " + name + "=" + from + ".<Attribute>";
        var aggregation = function is { Length: > 0 } f ? f : "Count";
        return aggregation.Equals("Count", StringComparison.OrdinalIgnoreCase)
            ? "an aggregated column names the attribute it reads, and Count counts the rows of each group by the identifier of a source: AGG " + name + "=Count(" + from + "." + (identifier ?? "Id") + ")"
            : "an aggregated column names the attribute it reads: AGG " + name + "=" + aggregation + "(" + from + ".<Attribute>), the attribute it totals";
    }

    /// <summary>The fix of a join that names a source of another aggregate (no patch: the source to add, its alias and its
    /// condition are the author's).</summary>
    public static string ForeignJoinFix(string source, string aggregate) =>
        $"the source {source} is not of {aggregate}: add it to the FROM of {aggregate} (a source of its own) and join that one; no patch (which source, its alias and its condition are yours)";

    /// <summary>Why a plain attribute cannot order a grouped aggregate (null when it can, or when the aggregate does not group).
    /// The sort lives before the grouping (CombineSourcesOperation, where a group by or aggregated column does not exist yet: the
    /// Verify says "Can't identify"), and SQL orders grouped rows only by what the GROUP BY gives (SQL Server error 8127): the
    /// keys are the attributes the group by columns read (Source.Attribute, or a calculated column grouped by name).</summary>
    public static string? OutOfGroup(string attribute, bool grouped, IReadOnlyCollection<string> keys)
    {
        if (!grouped || keys.Contains(attribute, StringComparer.OrdinalIgnoreCase)) return null;
        return "'" + attribute + "' is not an attribute the aggregate groups by, and the aggregate groups its rows (GROUP BY or AGG): SQL orders grouped rows only by what the GROUP BY gives (SQL Server error 8127, not contained in an aggregate function or the GROUP BY clause)"
            + (keys.Count > 0 ? " (it can sort by: " + string.Join(", ", keys) + ")" : " (it groups by no attribute it could sort by)");
    }

    /// <summary>The fix of a sort a grouped aggregate cannot order by.</summary>
    public static string GroupedFix(IReadOnlyCollection<string> keys) =>
        "a grouped aggregate sorts by an attribute it groups by (GROUP BY Source.Attribute, or a calculated column grouped by name): " + (keys.Count > 0 ? "SORT one of " + string.Join(", ", keys) : "it has none")
        + "; to order by an aggregated column or another attribute, sort the list after the get (ListSort), or group by that attribute too";

    // ---- joins ------------------------------------------------------------------------------------------------------------

    public const string JoinCode = "AGGREGATE_JOIN_NOT_NATIVE";
    public const string JoinNormalizedCode = "AGGREGATE_JOIN_NORMALIZED";

    /// <summary>The join types the Studio writes: Only With (Inner), With or Without (Left), With (Full).</summary>
    public static bool NativeJoin(string? type) => type is "Inner" or "Left" or "Full";

    /// <summary>The fix of a join type the Studio never writes.</summary>
    public static string JoinFix(string type, string left, string right, int joins) => type == "Right"
        ? $"write it as the Left join with the two sources swapped: JOIN Left {right}~{left} ON <the same condition> (With or Without keeps every {right}){(joins > 1 ? "; with more than one join, check that the order of the joins still reads the rows you want" : "")}"
        : "choose the join the Studio offers: Inner (Only With), Left (With or Without) or Full (With)";

    private static string Shorten(string text) { var t = text.Trim(); return t.Length > 80 ? t[..77] + "..." : t; }

    /// <summary>The other direction.</summary>
    public static string Reverse(string? direction) => string.Equals(direction, "Descending", StringComparison.OrdinalIgnoreCase) ? "Ascending" : "Descending";

    private static double? Number(string text)
    {
        var t = text.Trim().Replace(" ", "");
        return NumberLiteral.IsMatch(t) && double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : null;
    }

    /// <summary>The index of the parenthesis that closes the one at <paramref name="open"/> (text literals skipped), or -1.</summary>
    internal static int Closing(string text, int open)
    {
        var depth = 0;
        for (var i = open; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '"')
            {
                for (i++; i < text.Length; i++)
                    if (text[i] == '"') { if (i + 1 < text.Length && text[i + 1] == '"') i++; else break; }
                continue;
            }
            if (c == '(') depth++;
            else if (c == ')' && --depth == 0) return i;
        }
        return -1;
    }

    /// <summary>The arguments of a call, split at the commas of its top level (literals and parentheses nest), trimmed.</summary>
    internal static List<string> Arguments(string inner)
    {
        var result = new List<string>();
        var depth = 0; var start = 0;
        for (var i = 0; i < inner.Length; i++)
        {
            var c = inner[i];
            if (c == '"')
            {
                for (i++; i < inner.Length; i++)
                    if (inner[i] == '"') { if (i + 1 < inner.Length && inner[i + 1] == '"') i++; else break; }
                continue;
            }
            if (c == '(') depth++;
            else if (c == ')') depth--;
            else if (c == ',' && depth == 0) { result.Add(inner[start..i].Trim()); start = i + 1; }
        }
        if (inner.Trim().Length > 0) result.Add(inner[start..].Trim());
        return result;
    }
}
