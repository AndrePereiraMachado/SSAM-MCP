using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core.PreflightRules;

/// <summary>
/// The Values (Options Value) and Labels (Options Text) of a Dropdown are evaluated once per element of its List, in the
/// scope of that element alone: its attributes are the only names there (an aggregate's element is read as
/// Entity.Attribute, a list of records as Attribute). The variables of the screen are not, the list itself included, so
/// `Opts.Current.Value` is refused by the Verify (ExpressionUnknownObject 'Opts', plus a CustomObjectError on the Dropdown
/// for the type the value cannot have). Proved on Haiku_UI on 2026-10-11 (O11 Service Studio 11.55): with the List a
/// `ProbeOption List` variable, `Value`/`Label` pass, `ProbeList.Current.Value` and even a Text screen variable in Labels
/// are refused; job 0314 of the html replay carried 12 + 6 such errors. The rule refuses, from the job alone, a Values or
/// Labels a raw `set` writes as `&lt;List&gt;.Current.&lt;rest&gt;` for the List the same job gives that Dropdown, with the patch
/// that writes `&lt;rest&gt;`. O11 only: the ODC Verify of this case is not proved yet.
/// </summary>
public static class DropdownItemScopeRules
{
    public const string Code = "DROPDOWN_ITEM_SCOPE";
    private static readonly Regex StringLiteral = new("\"(?:[^\"]|\"\")*\"", RegexOptions.CultureInvariant);

    public static IEnumerable<JsonObject> Check(JsonArray ops, string lane)
    {
        if (string.Equals(lane, "odc", StringComparison.OrdinalIgnoreCase) || ops == null) return [];
        // The Dropdowns the job creates: the alias and the typed name a later op may target each with, to the op that creates it.
        var dropdowns = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "create" || op["type"]?.ToString() != "IDropdown") continue;
            if (op["as"]?.ToString() is { Length: > 0 } alias) dropdowns[Key(alias)] = i;
            if (op["name"]?.ToString() is { Length: > 0 } name) dropdowns["IDropdown:" + name] = i;
        }
        if (dropdowns.Count == 0) return [];
        // The List the job gives each of them (the last one written).
        var lists = new Dictionary<int, string>();
        foreach (var op in ops.OfType<JsonObject>())
            if (Set(op, dropdowns, "List") is { } target && Text(op["value"]) is { Length: > 0 } list) lists[target] = list.Trim();
        var problems = new List<JsonObject>();
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            var prop = op["prop"]?.ToString();
            if (prop is not ("Values" or "Labels") || Set(op, dropdowns, prop) is not { } target || !lists.TryGetValue(target, out var list)) continue;
            if (Text(op["value"]) is not { Length: > 0 } value || !ReadsCurrent(list, value)) continue;
            var written = Bare(list, value);
            var pointer = $"/ops/{i}/value";
            problems.Add(new JsonObject
            {
                ["op"] = i, ["pointer"] = pointer, ["code"] = Code, ["severity"] = "error",
                ["message"] = $"{prop} = {value}: the {prop} of a Dropdown is evaluated per element of its List ({list}), where only the element's attributes are names; "
                    + $"{list} itself is not (the Verify answers ExpressionUnknownObject '{Root(list)}' and a CustomObjectError on the Dropdown)",
                ["fix"] = written != null ? $"write {written} (the attribute of the element: Entity.Attribute for an aggregate, Attribute for a list of records)"
                    : $"read the element's attributes without {list}.Current (Entity.Attribute for an aggregate, Attribute for a list of records)",
                ["patch"] = written == null ? null : new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = written }),
            });
        }
        return problems;
    }

    /// <summary>Whether <paramref name="expression"/> reads <paramref name="list"/>.Current outside its text literals.</summary>
    public static bool ReadsCurrent(string list, string expression)
        => StringLiteral.Split(expression).Any(code => CurrentOf(list).IsMatch(code));

    /// <summary>The expression with every <c>&lt;list&gt;.Current.</c> removed outside its text literals (the element's
    /// attributes read bare), or null when a <c>&lt;list&gt;.Current</c> is not followed by a member (no certain rewrite).</summary>
    public static string? Bare(string list, string expression)
    {
        if (!ReadsCurrent(list, expression)) return null;
        var member = new Regex(@"(?<![\p{L}\p{N}_.])" + Pattern(list) + @"\s*\.\s*Current\s*\.\s*(?=[\p{L}_])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        var codes = StringLiteral.Split(expression);
        var literals = StringLiteral.Matches(expression).Select(m => m.Value).Append("").ToArray();
        var written = string.Concat(codes.Select((code, n) => member.Replace(code, "") + literals[n]));
        return ReadsCurrent(list, written) || written.Trim().Length == 0 ? null : written;
    }

    private static Regex CurrentOf(string list) => new(@"(?<![\p{L}\p{N}_.])" + Pattern(list) + @"\s*\.\s*Current(?![\p{L}\p{N}_])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>The List as a pattern: its dotted segments, spaces allowed around the dots (GetItems.List).</summary>
    private static string Pattern(string list) => string.Join(@"\s*\.\s*", list.Split('.').Select(s => Regex.Escape(s.Trim())));

    private static string Root(string list) => list.Split('.')[0].Trim();

    /// <summary>The Dropdown (the op that creates it) a `set` of <paramref name="prop"/> writes, or null.</summary>
    private static int? Set(JsonObject op, Dictionary<string, int> dropdowns, string prop)
        => op["op"]?.ToString() == "set" && op["prop"]?.ToString() == prop && op["target"]?.ToString() is { Length: > 0 } target && dropdowns.TryGetValue(Key(target), out var created) ? created : null;

    private static string Key(string reference) => reference.StartsWith('$') ? reference[1..] : reference;

    private static string? Text(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
}
