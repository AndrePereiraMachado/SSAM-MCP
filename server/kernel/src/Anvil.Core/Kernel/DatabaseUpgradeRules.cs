using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.Model.Data;

namespace Anvil.Core;

/// <summary>
/// What the platform's database upgrade (publish) refuses and the Studio verifier (TrueChange) lets through, decided on the
/// EFFECTIVE model (base module + job, read after the apply and before the candidate is saved): a data delivery is refused
/// before the merge with the exact fix, instead of merging and failing at publish. Lane-aware: O11 publishes to SQL
/// Server, ODC to PostgreSQL. Only rules the model alone decides; what depends on rows already in the tables (orphan
/// values under a new constraint, duplicates under a new unique index, type or length conversions) is never guessed here.
///
///  * Cascade paths and cycles (O11 only). A reference attribute with Delete Rule Delete is a
///    `FOREIGN KEY ... ON DELETE CASCADE` (OutSystems 11 "Database Constraints"; Protect is a plain FOREIGN KEY, Ignore has
///    no constraint). SQL Server refuses a constraint that gives a table a second cascade path from another table or closes
///    a cascade cycle (error 1785: a table cannot appear more than once in the cascading actions of one DELETE); two Delete
///    references from one table to the same table are two paths. The publish then stops at "Could not create foreign key
///    constraint ... creating a circular dependency between entities" (OfficePet_CS, 2026-10-04). PostgreSQL accepts both,
///    so ODC never refuses. A self-reference with Delete is TrueChange's own error (InvalidAttribute_BadDeleteRule) and is
///    left to it. References owned by referenced modules join the graph when their signature carries the rule; only
///    conflicts on this module's tables are refused (the only constraints this publish creates).
///  * Columns per table (both lanes): one column per attribute; SQL Server holds 1024 columns per table, PostgreSQL 1600.
///
/// The fix is computed, not guessed: one reference at a time is set aside until no conflict is left (the job's own
/// references first, then the one in most conflicts, then the last hop of the longer path, then by name), so applying
/// every listed change always passes. Covered by DatabaseUpgradeRulesTests (graph, both lanes) and the negative job
/// tests/jobs-negative/data-cascade-multiple-paths.json.
/// </summary>
public static class DatabaseUpgradeRules
{
    public const int SqlServerColumns = 1024, PostgreSqlColumns = 1600;

    /// <summary>A table of this module: a server or static entity (Kind is IServerEntity/IStaticEntity), one column per attribute.</summary>
    public sealed record Table(string Key, string Name, string Kind, int Columns);

    /// <summary>A reference attribute whose Delete Rule is Delete: deleting a Target row deletes the Owner rows that point at
    /// it. Owned: the owner is an entity of this module (its constraint is created by this publish and its rule is editable).</summary>
    public sealed record Cascade(string Owner, string OwnerName, string Attribute, string Target, string TargetName, bool Owned)
    {
        public string Label => OwnerName + "." + Attribute;
    }

    /// <summary>The top-level op of the job that declares an element (for the `op #N (verb ...)` prefix of a refusal).</summary>
    public sealed record Origin(int Op, string Verb);

    private sealed record Conflict(string Source, string Target, IReadOnlyList<Cascade> First, IReadOnlyList<Cascade> Second)
    {
        public bool Cycle => Second.Count == 0;
        public IEnumerable<Cascade> Candidates => (Cycle ? First : [First[^1], Second[^1]]).Where(e => e.Owned);
        public int LengthTo(Cascade edge) => Cycle ? First.Count : First[^1] == edge ? First.Count : Second.Count;
    }

    /// <summary>Every refusal of the effective model, one line per change to make plus the reason; empty when the
    /// database upgrade of this lane accepts the data model. `origin(entity, attribute?)` names the op of the job.</summary>
    public static List<string> Refusals(IReadOnlyList<Table> tables, IReadOnlyList<Cascade> cascades, string lane, Func<string, string?, Origin?> origin)
    {
        var lines = new List<string>();
        var (database, limit) = lane == "odc" ? ("PostgreSQL", PostgreSqlColumns) : ("SQL Server", SqlServerColumns);
        foreach (var table in tables.Where(t => t.Columns > limit).OrderBy(t => t.Name, StringComparer.Ordinal))
            lines.Add($"{Prefix(origin(table.Name, null), table.Name)}: entity {table.Name} has {table.Columns} attributes and the database upgrade creates one column per attribute; "
                + $"{database} ({lane.ToUpperInvariant()}) holds at most {limit} columns per table, so the publish fails creating {table.Name}. Keep {table.Name} at {limit} attributes or fewer: "
                + $"move the others to a 1:1 entity whose Id is \"{table.Name} Identifier\". Nothing was delivered: change the job and deliver it again.");
        if (lane != "odc")
        {
            var kinds = tables.ToDictionary(t => t.Key, t => t.Kind, StringComparer.Ordinal);
            var fixes = CascadeFixes(cascades, kinds.Keys.ToHashSet(StringComparer.Ordinal), e => origin(e.OwnerName, e.Attribute) != null);
            foreach (var (fix, conflicts) in fixes)
            {
                var at = origin(fix.OwnerName, fix.Attribute);
                var change = at?.Verb == "spec"
                    ? $"in the spec, \"deleteRule\":\"Ignore\" (or \"Protect\") on attribute {fix.Attribute} of {fix.OwnerName}"
                    : $"{{\"op\":\"set\",\"target\":\"{kinds.GetValueOrDefault(fix.Owner, "IServerEntity")}:{fix.OwnerName}/{fix.Attribute}\",\"prop\":\"DeleteRule\",\"value\":\"Ignore\"}} (or \"Protect\")";
                lines.Add($"{Prefix(at, fix.Label)}: {fix.Label}: set Delete Rule to Ignore or Protect; {string.Join("; ", conflicts.Select(Describe))}. "
                    + $"Change: {change}; the other Delete rules stay.");
            }
            if (fixes.Count > 0)
                lines.Add("Why: on O11 a reference with Delete Rule Delete is a FOREIGN KEY ... ON DELETE CASCADE, and SQL Server refuses a constraint that gives a table a second cascade path "
                    + "from another table or closes a cascade cycle (error 1785); the publish stops at the database upgrade with \"Could not create foreign key constraint ... creating a circular "
                    + "dependency between entities\". TrueChange does not check it and ODC (PostgreSQL) accepts it; Protect and Ignore never cascade. Nothing was delivered: change the job and deliver it again.");
        }
        return lines;

        static string Prefix(Origin? at, string element) => at is { } o ? $"op #{o.Op} ({o.Verb} {element})" : $"{element} (already in the module, not set by this job)";
    }

    /// <summary>The references the O11 refusal asks to change, in order (tests check that the rest always passes).</summary>
    internal static List<Cascade> Fixes(IReadOnlyList<Cascade> cascades, ISet<string> tables) => CascadeFixes(cascades, tables, _ => false).Select(f => f.Fix).ToList();

    /// <summary>The references to set to Ignore/Protect, in order, each with the conflicts it removes; empty when SQL Server
    /// accepts every cascade. Each round recomputes the conflicts without the references already set aside.</summary>
    private static List<(Cascade Fix, List<Conflict> Conflicts)> CascadeFixes(IReadOnlyList<Cascade> cascades, ISet<string> tables, Func<Cascade, bool> declaredByJob)
    {
        var remaining = cascades.Where(e => e.Owner != e.Target).ToList();   // a self-reference is TrueChange's error
        var fixes = new List<(Cascade, List<Conflict>)>();
        for (var conflicts = Conflicts(remaining, tables); conflicts.Count > 0; conflicts = Conflicts(remaining, tables))
        {
            var pick = conflicts.SelectMany(c => c.Candidates).Distinct()
                .OrderBy(e => declaredByJob(e) ? 0 : 1)
                .ThenByDescending(e => conflicts.Count(c => c.Candidates.Contains(e)))
                .ThenByDescending(e => conflicts.Where(c => c.Candidates.Contains(e)).Max(c => c.LengthTo(e)))
                .ThenBy(e => e.Label, StringComparer.Ordinal).ThenBy(e => e.Owner, StringComparer.Ordinal)
                .First();
            fixes.Add((pick, conflicts.Where(c => c.Candidates.Contains(pick)).ToList()));
            remaining.Remove(pick);
        }
        return fixes;
    }

    /// <summary>
    /// Conflicts SQL Server refuses, on this module's tables: from each source table, a depth-first walk of the cascades
    /// (in name order) keeps the first path that reaches each table. Reaching it again by a path that leaves the source by
    /// another reference is a second cascade path (the two paths share only their ends); reaching a table that is on the
    /// current path is a cycle. A second arrival whose path leaves the source by the same reference diverges further down
    /// and is reported from that table's own walk.
    /// </summary>
    private static List<Conflict> Conflicts(IReadOnlyList<Cascade> edges, ISet<string> tables)
    {
        var outgoing = edges.GroupBy(e => e.Target, StringComparer.Ordinal).ToDictionary(g => g.Key,
            g => g.OrderBy(e => e.Label, StringComparer.Ordinal).ThenBy(e => e.Owner, StringComparer.Ordinal).ToList(), StringComparer.Ordinal);
        var names = edges.Select(e => (e.Target, e.TargetName)).Concat(edges.Select(e => (e.Owner, e.OwnerName)))
            .GroupBy(x => x.Item1, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First().Item2, StringComparer.Ordinal);
        var found = new List<Conflict>();
        var cycles = new HashSet<string>(StringComparer.Ordinal);
        foreach (var source in outgoing.Keys.OrderBy(k => names[k], StringComparer.Ordinal).ThenBy(k => k, StringComparer.Ordinal))
        {
            var first = new Dictionary<string, List<Cascade>>(StringComparer.Ordinal);
            var path = new List<Cascade>();
            var onPath = new List<string> { source };
            Walk(source);

            void Walk(string node)
            {
                foreach (var edge in outgoing.GetValueOrDefault(node) ?? [])
                {
                    var current = path.Append(edge).ToList();
                    var at = onPath.IndexOf(edge.Owner);
                    if (at >= 0)
                    {
                        var cycle = current.Skip(at).ToList();
                        if (tables.Contains(edge.Owner) && cycles.Add(string.Join("|", cycle.Select(e => e.Owner + "/" + e.Attribute).Order(StringComparer.Ordinal))))
                            found.Add(new Conflict(edge.Owner, edge.Owner, cycle, []));
                        continue;
                    }
                    if (first.TryGetValue(edge.Owner, out var earlier))
                    {
                        if (earlier[0] != current[0] && tables.Contains(edge.Owner)) found.Add(new Conflict(source, edge.Owner, earlier, current));
                        continue;
                    }
                    first[edge.Owner] = current;
                    path.Add(edge); onPath.Add(edge.Owner);
                    Walk(edge.Owner);
                    path.RemoveAt(path.Count - 1); onPath.RemoveAt(onPath.Count - 1);
                }
            }
        }
        return found.Where(c => c.Candidates.Any()).ToList();
    }

    private static string Describe(Conflict c) => c.Cycle
        ? $"cascade cycle {Chain(c.First[0].TargetName, c.First)}"
        : $"{c.First[0].TargetName} reaches {c.First[^1].OwnerName} by two cascade paths: {Chain(c.First[0].TargetName, c.First)} and {Chain(c.Second[0].TargetName, c.Second)}";

    private static string Chain(string start, IReadOnlyList<Cascade> path)
        => start + string.Concat(path.Select(e => "->" + e.OwnerName)) + " [" + string.Join(", ", path.Select(e => e.Label)) + "]";

    /// <summary>
    /// The top-level op of the job that declares the entity (attribute null) or the reference attribute: a spec entity or
    /// attribute, a raw create of either, a raw `set` of the attribute's DeleteRule/DataType by path or alias. The op that
    /// sets the Delete Rule wins over the one that only declares the attribute; the last op wins among equals. Null: the
    /// element is the base module's, untouched by the job (a rename in the job also reads as untouched).
    /// </summary>
    public static Origin? Declared(JsonArray ops, string entity, string? attribute)
    {
        Origin? declared = null, rule = null;
        var entityAliases = new HashSet<string>(StringComparer.Ordinal);
        var attributeAliases = new HashSet<string>(StringComparer.Ordinal);
        bool Same(JsonNode? node, string name) => string.Equals(node?.ToString(), name, StringComparison.OrdinalIgnoreCase);
        (string Entity, string? Attribute)? Path(string? reference)
        {
            if (reference == null || reference.StartsWith('$') || reference.StartsWith('@')) return null;
            var colon = reference.IndexOf(':');
            if (colon < 0 || colon > 0 && !reference[..colon].Contains("Entity", StringComparison.Ordinal)) return null;
            var parts = reference[(colon + 1)..].Split('/');
            return parts.Length switch { 1 => (parts[0], null), 2 => (parts[0], parts[1]), _ => null };
        }
        bool IsEntity(string? reference) => reference != null && (entityAliases.Contains(reference) || Path(reference) is { Attribute: null } p && string.Equals(p.Entity, entity, StringComparison.OrdinalIgnoreCase));
        bool IsAttribute(string? reference) => reference != null && (attributeAliases.Contains(reference)
            || Path(reference) is { Attribute: { } a } p && string.Equals(p.Entity, entity, StringComparison.OrdinalIgnoreCase) && string.Equals(a, attribute, StringComparison.OrdinalIgnoreCase));
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            switch (op["op"]?.ToString())
            {
                case "spec":
                    foreach (var group in new[] { "static", "entities" })
                    foreach (var definition in op["data"]?[group]?.AsArray().OfType<JsonObject>() ?? [])
                    {
                        if (!Same(definition["name"], entity)) continue;
                        if (attribute == null) { declared = new(i, "spec"); continue; }
                        if (definition["attributes"]?.AsArray().OfType<JsonObject>().LastOrDefault(a => Same(a["name"], attribute)) is not { } field) continue;
                        declared = new(i, "spec");
                        if (field["deleteRule"] != null) rule = new(i, "spec");
                    }
                    break;
                case "create":
                    var type = op["type"]?.ToString();
                    if (type is "IServerEntity" or "IStaticEntity" && Same(op["name"], entity))
                    {
                        if (op["as"]?.ToString() is { } alias) entityAliases.Add(alias);
                        if (attribute == null) declared = new(i, "create");
                    }
                    else if (type == "IEntityAttribute" && IsEntity(op["parent"]?.ToString()))
                    {
                        if (attribute == null) declared = new(i, "create");
                        else if (Same(op["name"], attribute))
                        {
                            if (op["as"]?.ToString() is { } alias) attributeAliases.Add(alias);
                            declared = new(i, "create");
                        }
                    }
                    break;
                case "set" when attribute != null && op["prop"]?.ToString() is "DeleteRule" or "DataType" && IsAttribute(op["target"]?.ToString()):
                    declared = new(i, "set");
                    if (op["prop"]!.ToString() == "DeleteRule") rule = new(i, "set");
                    break;
            }
        }
        return rule ?? declared;
    }
}

/// <summary>The model reading of <see cref="DatabaseUpgradeRules"/>: this module's tables and every Delete reference the
/// loaded model knows (its own entities and the signatures of the referenced ones).</summary>
public sealed partial class ModelSession
{
    public List<string> DatabaseUpgradeRefusals(JsonArray ops, string lane)
    {
        var tables = new List<DatabaseUpgradeRules.Table>();
        var cascades = new List<DatabaseUpgradeRules.Cascade>();
        static string Key(object entity) => (entity as IObjectSignature)?.ObjectKey?.ToString() ?? "name:" + TypeResolver.Name(entity);
        static bool Client(object entity) => ShortType(entity).Contains("Client", StringComparison.Ordinal) || ModelHost.Prop(entity, "EntityKind")?.ToString() == "Client";
        void Read(IEntitySignature entity, bool owned)
        {
            var name = TypeResolver.Name(entity) ?? "?";
            var attributes = entity.Attributes.ToList();
            if (owned) tables.Add(new(Key(entity), name, ShortType(entity), attributes.Count));
            foreach (var attribute in attributes)
                if (ModelHost.Prop(attribute, "DataType") is OutSystems.Model.Types.IIdentifierType { Entity: { } target }
                    && ModelHost.Prop(attribute, "DeleteRule")?.ToString() == "Delete")
                    cascades.Add(new(Key(entity), name, TypeResolver.Name(attribute) ?? "?", Key(target), TypeResolver.Name(target) ?? "?", owned));
        }
        // The kind is the element's own interface: one implementation class serves server, static and client entities.
        foreach (var entity in _es.GetAllDescendantsOfType<IEntity>())
            if (ShortType(entity) is "IServerEntity" or "IStaticEntity" && UiCatalog.Prop(entity, "WasDeleted") is not true) Read(entity, owned: true);
        foreach (var reference in _es.References)
            foreach (var entity in reference.Entities)
                if (!Client(entity)) Read(entity, owned: false);
        return DatabaseUpgradeRules.Refusals(tables, cascades, lane, (entity, attribute) => DatabaseUpgradeRules.Declared(ops, entity, attribute));
    }
}
