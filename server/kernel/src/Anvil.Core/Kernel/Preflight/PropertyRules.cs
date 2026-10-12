using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>The verb ops a compact op expands into (spec, logic), kept with the op and, for a logic op checked one action
/// at a time, the action index: the property rules read the `set` ops the apply would run.</summary>
public sealed record Expansion(int Op, int? Action, IReadOnlyList<JsonObject> Ops);

/// <summary>
/// A02 items 2 and 3, in the pure preflight: a `set` whose target type is known (the type of the `create` that made its
/// alias, or the kind of a `Kind:Name`) is judged against the Model API of that type, in the raw ops and in what spec and
/// logic expand into.
/// <list type="bullet">
/// <item>ENUM_VALUE_INVALID: the property is an enum on every interface the type names, and the value is none of its values
/// (the apply refused it before, one op per round: `Invalid Sort value 'Contract.Id DESC'; allowed: Ascending, Descending`).</item>
/// <item>PROPERTY_NOT_WRITABLE: the type has no property, setter, parser or list editor of that name at all (the apply
/// refused it: `IScreenAction 'OnInitialize' has no writable property or setter 'Destination'`), with the closest writable ones.</item>
/// </list>
/// A target whose type is unknown (an @key, a path) is left to the apply, which collects every failure (ModelSession.Apply).
/// </summary>
public static class PropertyRules
{
    public static List<JsonObject> Check(JsonArray ops, string? prefix, string lane, IReadOnlyList<Expansion> expansions)
    {
        var problems = new List<JsonObject>();
        var aliases = new Dictionary<string, string>(StringComparer.Ordinal);
        void Remember(JsonObject op)
        {
            if (op["op"]?.ToString() == "create" && op["as"] is JsonValue a && a.TryGetValue<string>(out var alias) && op["type"]?.ToString() is { Length: > 0 } type)
                aliases[alias] = type;
        }
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            Remember(op);
            if (op["op"]?.ToString() == "set") Judge(op, i, prefix == null ? null : $"{prefix}/{i}", raw: true);
            foreach (var expansion in expansions.Where(e => e.Op == i))
            {
                var at = prefix == null ? null : expansion.Action is { } action ? $"{prefix}/{i}/data/actions/{action}" : $"{prefix}/{i}/data";
                // In order: an alias names what the latest create registered (a parameter and a node can share one).
                foreach (var expanded in expansion.Ops)
                {
                    Remember(expanded);
                    if (expanded["op"]?.ToString() == "set") Judge(expanded, i, at, raw: false);
                }
            }
        }
        return problems;

        void Judge(JsonObject set, int op, string? pointer, bool raw)
        {
            var target = set["target"]?.ToString() ?? ""; var prop = set["prop"]?.ToString() ?? "";
            if (prop.Length == 0) return;
            var type = TypeOf(target, aliases);
            if (type == null || ModelTypes.Of(type, lane) is not { } facts) return;
            var shown = ShortType(type);
            var kind = raw ? "set" : ops[op]?["op"]?.ToString() ?? "op";
            // lentidao 2026-10-12 (cause 2): a documentation property the type has no way to write (IUserException.Description)
            // is dropped with a warning (JobNormalizer.PropertyDropped): the apply drops it too, never refuses it.
            if (JobNormalizer.Droppable(prop) && !facts.IsWidget && (!facts.Knows(prop) || !facts.Writable().Contains(prop, StringComparer.Ordinal)))
            {
                var at = raw && pointer != null ? pointer + "/prop" : pointer;
                var warning = JobPreflight.Problem(op, at, JobNormalizer.PropertyDropped, "warning",
                    $"{shown} {Named(target)}has no way to write '{prop}' (a documentation property)" + (raw ? "" : $" (set {prop} on {target}, expanded from this op)")
                        + ": the set is dropped and nothing else of the job changes",
                    "nothing to change: the set is dropped (this kind of element keeps no " + prop + ")", null, kind);
                // The entry of the answer's normalizations (JobPreflight.Analyze moves it there; never published with the warning).
                warning["_normalization"] = JobNormalizer.Dropped(at, shown, prop, target);
                problems.Add(warning);
                return;
            }
            if (!facts.Knows(prop))
            {
                // A widget's class writes more than its interfaces declare: its property names are judged at apply only.
                if (facts.IsWidget) return;
                var writable = facts.Properties.Where(p => p.CanWrite).Select(p => p.Name).Distinct(StringComparer.Ordinal).OrderBy(n => n, StringComparer.Ordinal).ToArray();
                var expressions = facts.Properties.Where(p => !p.CanWrite && p.IsExpression).Select(p => p.Name).Distinct(StringComparer.Ordinal).OrderBy(n => n, StringComparer.Ordinal).ToArray();
                var similar = NameSuggestions.Closest(prop, facts.Writable());
                // The same wording as the apply's refusal (Verbs.PropertyError), so a reader of either finds the same lists.
                problems.Add(JobPreflight.Problem(op, raw && pointer != null ? pointer + "/prop" : pointer, "PROPERTY_NOT_WRITABLE", "error",
                    $"{shown} {Named(target)}has no writable property or setter '{prop}'" + (raw ? "" : $" (set {prop} on {target}, expanded from this op)")
                        + $". Writable: {string.Join(", ", writable)}; expression.Text: {string.Join(", ", expressions)}; Set<X>: {string.Join(", ", facts.Setters.Order(StringComparer.Ordinal))}; similar: {string.Join(", ", similar)}; see {DataPreflight.ApiContract(shown)}",
                    $"write one of: {string.Join(", ", similar)}", null, kind));
                return;
            }
            if (set["value"] is not JsonValue v || !v.TryGetValue<string>(out var value)) return;
            var candidates = facts.Properties.Where(p => p.Name == prop).ToArray();
            if (candidates.Length == 0 || candidates.Any(p => p.EnumValues == null)) return;
            var allowed = candidates.SelectMany(p => p.EnumValues!).Distinct(StringComparer.Ordinal).ToArray();
            var stored = ValueAliases.Normalize(prop, value);
            if (allowed.Contains(stored, StringComparer.OrdinalIgnoreCase)) return;
            var enumName = candidates[0].Type.Split('.').Last();
            problems.Add(JobPreflight.Problem(op, raw && pointer != null ? pointer + "/value" : pointer, "ENUM_VALUE_INVALID", "error",
                $"{target}.{prop} value '{value}' invalid; allowed: {string.Join(", ", allowed)}; see {DataPreflight.ApiContract(enumName)}",
                $"use one of: {string.Join(", ", allowed)}", null, kind));
        }
    }

    /// <summary>The type a target denotes without a model: the type of the create that registered the alias, or the kind of
    /// a `Kind:Name` that names no child; null for keys, paths and kind-less names.</summary>
    internal static string? TypeOf(string target, IReadOnlyDictionary<string, string> aliases)
    {
        if (aliases.TryGetValue(target, out var type)) return type;
        // C30: an alias with or without its $ is the same alias.
        if (ModelSession.AliasCounterpart(target) is { } other && aliases.TryGetValue(other, out type)) return type;
        if (target.StartsWith('@') || target.StartsWith('$') || target.Contains('/')) return null;
        var colon = target.IndexOf(':');
        if (colon <= 0) return null;
        var kind = KindNames.Normalize(target[..colon]);
        return KindNames.LooksLikeInterface(kind) || kind.Contains('.') ? kind : null;
    }

    private static string ShortType(string type) => type.Split('.').Last();
    private static string Named(string target) => target.Contains(':') && !target.Contains('/') ? $"'{target[(target.IndexOf(':') + 1)..]}' " : "";
}
