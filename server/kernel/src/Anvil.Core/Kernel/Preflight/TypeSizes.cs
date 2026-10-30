using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>
/// R2-C (normalizations, 2026-10-29), the family "a size on a kind that keeps none" (KERNEL K3, type.modifiers): only an
/// attribute of an entity or a structure has a Length and Decimals. A site property (O11), a setting (ODC), an input, an output
/// and a local variable of an action have neither: the Model API writes no Length or Decimals there, so `Decimal(37,8)` or
/// `Text(50)` on one of them was refused one round each, in another phase per form (the site property `set Length`
/// PROPERTY_NOT_WRITABLE in the preflight, a local of a text TYPE_UNRESOLVED at apply, an ODC setting ODC_SETTING_SIZE). The
/// size says nothing the module keeps, and the type without it is the one form the platform takes: dropped and listed
/// (TYPE_SIZE_DROPPED), never refused. Normalized and not refused with a patch because no value of the size changes what the
/// module holds: there is no second reading to choose.
/// <para>The forms: the data text (`site property X: Decimal(37,8)`, `setting X: Text(250)`), the declarations of a logic text
/// (`in`, `out`, `local`, `binding`) and the inputs, outputs and vars of a JSON logic action. An attribute of an entity or a
/// structure keeps its size; a size the grammar does not read (Decimal(a), three numbers) or on another type (Integer(5))
/// stays as written, and its refusal says what is wrong.</para>
/// </summary>
public static class TypeSizes
{
    public const string Rule = "TYPE_SIZE_DROPPED";

    /// <summary>R3-D (review A1, pending A6): the kind of the Model API each form declares, the data text's site property (an
    /// ODC setting) and the declaration words of a logic text (in, out, local, binding: a parameter of an SQL) and of a JSON
    /// action (inputs, outputs, vars). The platform limits table (PlatformLimits, type.size.none) says which keep no size: the
    /// form drops it only then, so the table and this normalization are one list.</summary>
    public static readonly IReadOnlyDictionary<string, string> Kinds = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["SiteProperty"] = "SiteProperty", ["in"] = "InputParameter", ["out"] = "OutputParameter", ["local"] = "LocalVariable", ["binding"] = "SQLInputParameter",
    };

    /// <summary>The form declares a kind the table says keeps no Length or Decimals.</summary>
    public static bool Drops(string form) => Kinds.TryGetValue(form, out var kind) && PlatformLimits.KeepsSize(kind) == false;

    // A basic type that takes a size, written with one: Text(50), Decimal(37,8), Decimal(18, 2).
    private static readonly Regex Sized = new(@"^\s*(Text|Decimal)\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\)\s*$", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    // The same inside a declaration line of a logic text: `  local Total: Decimal(37,8) = 0`.
    private static readonly Regex Declaration = new(@"^(\s*(?:in|out|local|binding)\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*)(Text|Decimal)\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\)(?=\s|$)", RegexOptions.Compiled);
    // The type of a data text line with its size: `: Text(250)`, `: Decimal(18,2)` (the first one of the line).
    private static readonly Regex DdlSized = new(@"(:[ \t]*(?:Text|Decimal))[ \t]*\([ \t]*\d+[ \t]*(?:,[ \t]*\d+[ \t]*)?\)", RegexOptions.Compiled);

    public static void Normalize(JsonArray ops, string? prefix, string lane, List<JsonObject> done)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["data"] is not JsonObject data) continue;
            var at = prefix == null ? null : $"{prefix}/{i}";
            switch (op["op"]?.ToString())
            {
                case "spec" when data["ddl"] is JsonValue v && v.TryGetValue<string>(out var ddl):
                    if (DataText(ddl, lane, at == null ? null : at + "/data/ddl", done) is { } written) data["ddl"] = written;
                    break;
                case "logic":
                    if (data["actions"] is JsonArray actions) Actions(actions, at, done);
                    if (data.ContainsKey("flow")) FlowTexts.Rewrite(data, at, (text, path) => LogicText(text, path, done));
                    break;
            }
        }
    }

    /// <summary>The type without its size when it is a basic type written with one (Decimal(37,8) is Decimal), else null.</summary>
    public static string? Unsized(string type) => Sized.Match(type) is { Success: true } m ? Canonical(m.Groups[1].Value) : null;

    private static string Canonical(string basic) => basic.Equals("text", StringComparison.OrdinalIgnoreCase) ? "Text" : "Decimal";

    private static string Where(string lane, string kind) => kind switch
    {
        "SiteProperty" => lane == "odc" ? "an ODC setting" : "a site property",
        "in" => "an input", "out" => "an output", "binding" => "a binding", _ => "a local variable",
    };

    private static string Why(string what) =>
        $"{what} keeps no Length or Decimals (only an attribute of an entity or a structure has them): the size says nothing the module keeps";

    // ---- the data text --------------------------------------------------------------------------------------------------

    private static string? DataText(string text, string lane, string? path, List<JsonObject> done)
    {
        if (!text.Contains('(')) return null;
        DdlDocument document;
        try { document = DdlParser.Parse(text, lane); } catch { return null; }   // its own refusal says why
        var sized = document.Elements.Where(e => Drops(e.Kind) && !e.Drop && (e.Props.ContainsKey("Length") || e.Props.ContainsKey("Decimals"))).ToList();
        if (sized.Count == 0) return null;
        var lines = text.Split('\n');
        var entries = new List<JsonObject>();
        foreach (var element in sized)
        {
            if (element.Line < 1 || element.Line > lines.Length) return null;
            var before = lines[element.Line - 1];
            var after = DdlSized.Replace(before, m => m.Groups[1].Value, 1);
            if (after == before) return null;
            lines[element.Line - 1] = after;
            var size = element.Props.TryGetValue("Decimals", out var decimals) && decimals != null
                ? $"{element.Props.GetValueOrDefault("Length")},{decimals}" : element.Props.GetValueOrDefault("Length");
            var entry = JobNormalizer.Entry(Rule, path, $"line {element.Line}: {before.Trim()}", after.Trim(),
                $"line {element.Line}: {Why(Where(lane, element.Kind))}; {element.Name} is {element.Props.GetValueOrDefault("DataType")} (the size ({size}) is dropped)");
            entry["line"] = element.Line;
            entries.Add(entry);
        }
        var written = string.Join('\n', lines);
        // Kept only when the text reads again with no size on those lines.
        try
        {
            var again = DdlParser.Parse(written, lane);
            if (again.Elements.Any(e => Drops(e.Kind) && !e.Drop && (e.Props.ContainsKey("Length") || e.Props.ContainsKey("Decimals")))) return null;
        }
        catch { return null; }
        done.AddRange(entries);
        return written;
    }

    // ---- the logic text -------------------------------------------------------------------------------------------------

    private static string? LogicText(string text, string? path, List<JsonObject> done)
    {
        if (!text.Contains('(')) return null;
        var lines = text.Split('\n');
        var changed = false;
        for (var n = 0; n < lines.Length; n++)
        {
            if (Declaration.Match(lines[n]) is not { Success: true } m) continue;
            var keyword = m.Groups[1].Value.Split((char[]?)null, 2, StringSplitOptions.RemoveEmptyEntries)[0];
            if (!Drops(keyword)) continue;
            var before = lines[n];
            var type = Canonical(m.Groups[2].Value);
            var after = m.Groups[1].Value + type + before[(m.Index + m.Length)..];
            lines[n] = after;
            changed = true;
            var entry = JobNormalizer.Entry(Rule, path, $"line {n + 1}: {before.Trim()}", after.Trim(),
                $"line {n + 1}: {Why(Where("", keyword))}; the type is {type}");
            entry["line"] = n + 1;
            done.Add(entry);
        }
        return changed ? string.Join('\n', lines) : null;
    }

    // ---- JSON logic actions -----------------------------------------------------------------------------------------------

    private static void Actions(JsonArray actions, string? at, List<JsonObject> done)
    {
        for (var a = 0; a < actions.Count; a++)
        {
            if (actions[a] is not JsonObject action) continue;
            foreach (var (section, kind) in new[] { ("inputs", "in"), ("outputs", "out"), ("vars", "local") })
            {
                if (!Drops(kind)) continue;
                if (action[section] is not JsonArray parameters) continue;
                for (var p = 0; p < parameters.Count; p++)
                {
                    if (parameters[p] is not JsonObject parameter || parameter["type"] is not JsonValue tv || !tv.TryGetValue<string>(out var type) || Unsized(type) is not { } unsized) continue;
                    parameter["type"] = unsized;
                    done.Add(JobNormalizer.Entry(Rule, at == null ? null : $"{at}/data/actions/{a}/{section}/{p}/type", type, unsized,
                        $"{Why(Where("", kind))}; {parameter["name"]} of {action["name"]} is {unsized}"));
                }
            }
        }
    }
}
