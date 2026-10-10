using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// A04 NAME_COLLISION, the part the job alone decides: two inputs, outputs or local variables of one action with the same
/// name, or a parameter named like a root of the expression language (O11: Site, Entities; ODC: Entities). The Studio
/// renames the newcomer in silence (Site becomes Site2, Categorias becomes Categorias2), every expression that names it then
/// reads the other element, and the Verify fails far away (InvalidDataAction_OutputMustBeSet). The collisions with what
/// the module already has are judged at apply, where the Studio's own rename is observed (ModelSession.Create).
/// </summary>
public static class NameRules
{
    public static List<JsonObject> Check(JsonArray ops, string? prefix, string lane, JobFacts job)
    {
        var reserved = lane == "odc" ? new[] { "Entities" } : new[] { "Site", "Entities" };
        var problems = new List<JsonObject>();
        foreach (var action in job.Actions)
        {
            var at = prefix == null ? null : $"{prefix}/{action.Op}/data/actions/{action.Index}";
            var seen = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var (section, list) in new[] { ("inputs", action.Inputs), ("outputs", action.Outputs), ("vars", action.Vars) })
                foreach (var p in list)
                {
                    var pointer = at == null ? null : $"{at}/{section}/{p.Index}/name";
                    if (seen.TryGetValue(p.Name, out var first))
                        problems.Add(JobPreflight.Problem(action.Op, pointer, "NAME_COLLISION", "error",
                            $"{section[..^1]} '{p.Name}' of {action.Name} collides with the {first} of the same name: the Studio renames it to {Free(p.Name, seen.Keys)}, and every expression that names '{p.Name}' reads the first one",
                            $"give it another name, or use the existing {first} '{p.Name}'", null, "logic"));
                    else if (reserved.FirstOrDefault(r => string.Equals(r, p.Name, StringComparison.OrdinalIgnoreCase)) is { } root)
                        problems.Add(JobPreflight.Problem(action.Op, pointer, "NAME_COLLISION", "error",
                            $"{section[..^1]} '{p.Name}' of {action.Name} has the name of the expression root {root}: the Studio renames it to {root}2, and '{p.Name}' in an expression still means {root}",
                            $"name it for what it holds (e.g. \"{p.Name}Info\")", null, "logic"));
                    seen.TryAdd(p.Name, section[..^1]);
                }
            // A node named like a root: `Site.List.Empty` reads the site properties, not the aggregate (the real case: an
            // aggregate named Site, then `Can't identify 'List'`).
            foreach (var (name, node) in LogicScan.Of(action.Declaration).Nodes)
                if (reserved.FirstOrDefault(r => string.Equals(r, name, StringComparison.OrdinalIgnoreCase)) is { } root)
                    problems.Add(JobPreflight.Problem(action.Op, at == null ? null : at + node.Pointer + (node.Kind == "handler" ? "/name" : node.Step.ContainsKey("as") ? "/as" : ""), "NAME_COLLISION", "error",
                        $"node '{name}' of {action.Name} has the name of the expression root {root}: '{name}.' in an expression reads {root}, never the node",
                        $"name the node for what it returns (e.g. \"as\": \"Get{name}s\")", null, "logic"));
        }
        return problems;
    }

    /// <summary>The name the Studio gives a newcomer: the first free numbered name.</summary>
    internal static string Free(string name, IEnumerable<string> taken)
    {
        var set = new HashSet<string>(taken, StringComparer.OrdinalIgnoreCase);
        for (var n = 2; ; n++) if (!set.Contains(name + n)) return name + n;
    }
}
