using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>An aggregate as the data-access rules read it from the model: its name, the entities of its sources (in order)
/// and the text of its filters.</summary>
internal sealed record AggregateShape(IObjectSignature Node, string Name, IReadOnlyList<AggregateShape.Entity> Entities, IReadOnlyList<string> Filters)
{
    internal sealed record Entity(string Key, string Name, object Model);

    /// <summary>A reference attribute (FK) between two entities: Owner.Attribute -> Target (Mandatory when the attribute is).</summary>
    internal sealed record Link(string Owner, string Attribute, string Target, bool Mandatory)
    {
        public string Text => $"{Owner}.{Attribute} -> {Target}";
        public string Condition => $"{Owner}.{Attribute} = {Target}.Id";
    }

    public static AggregateShape Of(IObjectSignature aggregate)
    {
        var entities = new List<Entity>();
        var filters = new List<string>();
        foreach (var d in aggregate.GetAllDescendantsOfType<IObjectSignature>())
        {
            // IAliasedSource.Source is the entity itself (an IDataSource); `dataSource` is only the name of its Create argument.
            if (ModelSession.Implements(d, "IAliasedSource") && (ModelHost.Prop(d, "Source") ?? ModelHost.Prop(d, "DataSource")) is { } source)
            {
                var key = (source as IObjectSignature)?.ObjectKey?.ToString() ?? "name:" + TypeResolver.Name(source);
                if (TypeResolver.Name(source) is { Length: > 0 } name && entities.All(e => e.Key != key)) entities.Add(new(key, name, source));
            }
            else if (ModelSession.Implements(d, "IFilter") && Text(ModelHost.Prop(d, "Condition")) is { Length: > 0 } condition) filters.Add(condition);
        }
        return new(aggregate, TypeResolver.Name(aggregate) ?? "?", entities, filters);
    }

    internal static string Text(object? value) => value switch { null => "", IExpression e => (e.Text ?? "").Trim(), _ => (value.ToString() ?? "").Trim() };

    /// <summary>The reference attribute from one entity to the other (either direction), or null.</summary>
    public static Link? Relation(Entity a, Entity b) => Relations(a, b).FirstOrDefault();

    /// <summary>Every reference attribute from one entity to the other (either direction).</summary>
    public static IEnumerable<Link> Relations(Entity a, Entity b)
    {
        foreach (var (owner, target) in new[] { (a, b), (b, a) })
            if (ModelHost.Prop(owner.Model, "Attributes") is System.Collections.IEnumerable attributes)
                foreach (var attribute in attributes)
                    if (ModelHost.Prop(attribute, "DataType") is OutSystems.Model.Types.IIdentifierType { Entity: { } points }
                        && ((points as IObjectSignature)?.ObjectKey?.ToString() ?? "name:" + TypeResolver.Name(points)) == target.Key)
                        yield return new(owner.Name, TypeResolver.Name(attribute) ?? "?", target.Name, ModelHost.Prop(attribute, "IsMandatory") is true);
    }

    /// <summary>The name of an entity's identifier attribute (Id when the model does not say).</summary>
    public static string IdentifierOf(Entity e) => ModelHost.Prop(e.Model, "IdentifierAttribute") is { } id && TypeResolver.Name(id) is { Length: > 0 } name ? name : "Id";

    /// <summary>The values the filter conjuncts of this aggregate equate Entity.Attribute to (`E.A = v` or `v = E.A`), normalized.</summary>
    public IReadOnlyList<string> Pins(string entity, string attribute)
    {
        var column = entity + "." + attribute;
        var values = new List<string>();
        foreach (var conjunct in Filters.SelectMany(Conjuncts))
        {
            var at = Equality(conjunct);
            if (at < 0) continue;
            var left = Normal(conjunct[..at]); var right = Normal(conjunct[(at + 1)..]);
            if (left.Equals(column, StringComparison.OrdinalIgnoreCase)) values.Add(right);
            else if (right.Equals(column, StringComparison.OrdinalIgnoreCase)) values.Add(left);
        }
        return values;
    }

    /// <summary>An expression as compared here: no outer parentheses, no blanks, lower case.</summary>
    public static string Normal(string text) => Regex.Replace(Unwrap(text.Trim()), @"\s+", "").ToLowerInvariant();

    private static string Unwrap(string t)
    {
        while (t.Length > 1 && t[0] == '(' && t[^1] == ')' && Closes(t) == t.Length - 1) t = t[1..^1].Trim();
        return t;
    }

    // The index of the parenthesis that closes the one at 0 (outside quotes), or -1.
    private static int Closes(string t)
    {
        var depth = 0; var quoted = false;
        for (var i = 0; i < t.Length; i++)
        {
            var c = t[i];
            if (c == '"') quoted = !quoted;
            else if (quoted) continue;
            else if (c == '(') depth++;
            else if (c == ')' && --depth == 0) return i;
        }
        return -1;
    }

    // The top-level `and` parts of a condition (outside parentheses and quotes).
    private static IEnumerable<string> Conjuncts(string condition)
    {
        var t = Unwrap(condition.Trim());
        var depth = 0; var quoted = false; var start = 0;
        for (var i = 0; i < t.Length; i++)
        {
            var c = t[i];
            if (c == '"') quoted = !quoted;
            else if (quoted) continue;
            else if (c == '(') depth++;
            else if (c == ')') depth--;
            else if (depth == 0 && i > 0 && char.IsWhiteSpace(t[i - 1]) && i + 4 <= t.Length
                && string.Compare(t, i, "and", 0, 3, StringComparison.OrdinalIgnoreCase) == 0 && char.IsWhiteSpace(t[i + 3]))
            {
                yield return Unwrap(t[start..i].Trim());
                start = i + 3;
            }
        }
        yield return Unwrap(t[start..].Trim());
    }

    // The index of the single top-level `=` of an equality (not <=, >=, <>), or -1.
    private static int Equality(string conjunct)
    {
        var depth = 0; var quoted = false; var found = -1;
        for (var i = 0; i < conjunct.Length; i++)
        {
            var c = conjunct[i];
            if (c == '"') quoted = !quoted;
            else if (quoted) continue;
            else if (c == '(') depth++;
            else if (c == ')') depth--;
            else if (depth == 0 && c is '<' or '>') return -1;
            else if (depth == 0 && c == '=') { if (found >= 0) return -1; found = i; }
        }
        return found;
    }
}

/// <summary>
/// AGGREGATES_MERGEABLE (owner's decision, 2026-10-09): in the same action flow or the same screen/block (data fetching),
/// two or more Aggregates whose sources are entities linked by a reference attribute (FK), or the same entity, and whose
/// results are used together (read by expressions of the same flow, including the filter of one by the other, or bound in
/// the same widget tree) are a HIGH warning (highWarnings, first in the receipt; A03: it never blocks). The warning names the
/// aggregates and the relation (Entity.Attribute -> Entity) as candidates for review. Related sources do not prove
/// equivalence: locks, authorization, dependencies, paging and cardinality need a semantic analysis. It emits no
/// replacement operations and removes no filters. Only the groups with an aggregate the job created or changed are read.
/// </summary>
public static class AggregateConsolidationRule
{
    public const string Code = "AGGREGATES_MERGEABLE";
}

public sealed partial class ModelSession
{
    /// <summary>AGGREGATES_MERGEABLE over the aggregate groups (same owner) this job touched; every finding goes to the
    /// receipt (highWarnings). Never throws.</summary>
    private void AggregateConsolidationReview(JsonArray ops)
    {
        if (!_footprintBegun) return;
        HashSet<IObjectSignature> created, changed;
        try { (created, changed) = JobObjects(); } catch { return; }
        finally { _dataAccessObjects = null; }
        bool InJob(IObjectSignature o) => created.Contains(o) || changed.Contains(o);
        var groups = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
        foreach (var o in created.Concat(changed))
            for (IObjectSignature? p = o; p != null; p = p.Parent as IObjectSignature)
                if (Implements(p, "IAggregate") || p is OutSystems.Model.Logic.Nodes.IAggregateNode)
                {
                    if (AggregateOwner(p) is { WasDeleted: false } owner) groups.Add(owner);
                    break;
                }
        foreach (var owner in groups)
        {
            try { Consolidate(owner, ops, InJob); } catch { /* a group it cannot read gives no warning */ }
        }
    }

    /// <summary>The owner that groups aggregates: the action of a flow node (its parent), else the screen/block/preparation.</summary>
    private static IObjectSignature? AggregateOwner(IObjectSignature aggregate)
    {
        var node = aggregate;
        if (node is not IFlowNode && node.Parent is IFlowNode flowNode) node = (IObjectSignature)flowNode;
        return node.Parent as IObjectSignature;
    }

    /// <summary>A link between x (a source of a) and y (a source of b) that the filters do not follow: the target's identifier is
    /// equated to a value that is neither the owner side's reference attribute value nor read from the owner aggregate, so no
    /// join over the link reads the same rows. Unpinned sources, a dependent filter and both ends equated to one value (the
    /// record and the records that reference it) keep the warning.</summary>
    private static bool Independent(AggregateShape a, AggregateShape b, AggregateShape.Link link, AggregateShape.Entity x, AggregateShape.Entity y)
    {
        if (x.Name.Equals(y.Name, StringComparison.OrdinalIgnoreCase)) return false;
        var (ownerShape, targetShape, targetEntity) = x.Name.Equals(link.Owner, StringComparison.OrdinalIgnoreCase) ? (a, b, y) : (b, a, x);
        var targetKeys = targetShape.Pins(link.Target, AggregateShape.IdentifierOf(targetEntity));
        if (targetKeys.Count == 0) return false;
        var readsOwner = new Regex(@"(?<![\w.])" + Regex.Escape(ownerShape.Name.ToLowerInvariant()) + @"\.");
        if (targetKeys.Any(k => readsOwner.IsMatch(k))) return false;
        var ownerKeys = ownerShape.Pins(link.Owner, link.Attribute);
        return !targetKeys.Any(ownerKeys.Contains);
    }

    private void Consolidate(IObjectSignature owner, JsonArray ops, Func<IObjectSignature, bool> inJob)
    {
        // The aggregates of the owner: flow nodes of an action, or the screen aggregates of a screen/block (not nested owners).
        var aggregates = owner.GetAllDescendantsOfType<IObjectSignature>()
            .Where(d => !d.WasDeleted && (d is OutSystems.Model.Logic.Nodes.IAggregateNode || Implements(d, "IAggregate")) && ReferenceEquals(AggregateOwner(d), owner))
            .GroupBy(d => (IObjectSignature)(d is IFlowNode || d.Parent is not IFlowNode ? d : (IObjectSignature)d.Parent!), ReferenceEqualityComparer.Instance)
            .Select(g => (IObjectSignature)g.Key!).ToList();
        if (aggregates.Count < 2) return;
        var shapes = aggregates.Select(AggregateShape.Of).Where(s => s.Entities.Count > 0).OrderBy(s => s.Name, StringComparer.Ordinal).ToList();
        if (shapes.Count < 2) return;
        bool Touched(AggregateShape s) => inJob(s.Node) || s.Node.GetAllDescendantsOfType<IObjectSignature>().Any(inJob);
        if (!shapes.Any(Touched)) return;
        // Which aggregates the owner's expressions read (outside each aggregate's own subtree), and which read each other.
        var expressions = owner.GetAllDescendantsOfType<IObjectSignature>().OfType<IExpression>().Select(e => ((IObjectSignature)e, AggregateShape.Text(e))).Where(e => e.Item2.Length > 0).ToList();
        var inside = shapes.ToDictionary(s => s, s => new HashSet<IObjectSignature>(s.Node.GetAllDescendantsOfType<IObjectSignature>(), ReferenceEqualityComparer.Instance));
        bool Reads(string text, AggregateShape s) => Regex.IsMatch(text, @"(?<![\w.])" + Regex.Escape(s.Name) + @"\.", RegexOptions.IgnoreCase);
        // gen-screen (2026-10-13): the options of a Dropdown (its List) are a lookup of every record of the target, not data used
        // with the page's: merged into the page's aggregate by a join they would lose the options no row references. An
        // aggregate read only there is not used together with the others.
        // The expression of a widget property sits in its custom property (named as the property) under the widget.
        static bool Options(IObjectSignature expression)
        {
            var property = expression.Parent as IObjectSignature;
            if (property == null || ModelHost.Prop(property, "Name") as string != "List") return false;
            return property.Parent is IObjectSignature widget && widget.GetType().GetInterfaces().Any(i => i.Name is "IDropdown" or "IDropdownSignature");
        }
        var used = shapes.Where(s => expressions.Any(e => !inside[s].Contains(e.Item1) && !Options(e.Item1) && Reads(e.Item2, s))).ToHashSet();
        // The related pairs among the used ones: the same entity, or a reference attribute between their main entities.
        var edges = new List<(AggregateShape A, AggregateShape B, AggregateShape.Link? Link)>();
        for (var i = 0; i < shapes.Count; i++)
            for (var j = i + 1; j < shapes.Count; j++)
            {
                var a = shapes[i]; var b = shapes[j];
                if (!used.Contains(a) || !used.Contains(b)) continue;
                if (a.Entities[0].Key == b.Entities[0].Key) { edges.Add((a, b, null)); continue; }
                // A reference between the sources relates the two only when their filters follow it (blind test F2, 2026-11-02:
                // Save<E> of entity-actions checks that the NEW reference exists, Author.Id = BookRecord.AuthorId, and reads the
                // STORED record, Book.Id = BookRecord.Id; a join over Book.AuthorId -> Author reads the stored book's author,
                // another record, so the two are no candidates).
                var link = a.Entities.SelectMany(x => b.Entities.SelectMany(y => AggregateShape.Relations(x, y).Select(l => (Link: l, X: x, Y: y))))
                    .Where(l => !Independent(a, b, l.Link, l.X, l.Y)).Select(l => l.Link).FirstOrDefault();
                if (link != null) edges.Add((a, b, link));
            }
        if (edges.Count == 0) return;
        // One warning per connected group of related aggregates.
        var component = new Dictionary<AggregateShape, int>();
        var next = 0;
        foreach (var (a, b, _) in edges)
        {
            var ca = component.TryGetValue(a, out var x) ? x : -1; var cb = component.TryGetValue(b, out var y) ? y : -1;
            if (ca < 0 && cb < 0) { component[a] = component[b] = next++; }
            else if (ca < 0) component[a] = cb;
            else if (cb < 0) component[b] = ca;
            else if (ca != cb) foreach (var k in component.Where(p => p.Value == cb).Select(p => p.Key).ToList()) component[k] = ca;
        }
        var ownerName = NodeName(owner);
        foreach (var group in component.GroupBy(p => p.Value))
        {
            var members = shapes.Where(s => group.Any(p => p.Key == s)).ToList();
            var links = edges.Where(e => members.Contains(e.A)).ToList();
            var sameEntity = links.All(l => l.Link == null);
            var relations = links.Select(l => l.Link?.Text ?? $"{l.A.Name} and {l.B.Name} read the same entity {l.A.Entities[0].Name}").Distinct().ToList();
            var names = string.Join(", ", members.Select(m => m.Name));
            var touched = members.FirstOrDefault(Touched) ?? members[0];
            var op = OriginOp(touched.Node, ops);
            Report("highWarnings", new JsonObject
            {
                ["code"] = AggregateConsolidationRule.Code, ["severity"] = "high", ["op"] = op,
                ["message"] = sameEntity
                    ? $"{names} in '{ownerName}' read the same entity {members[0].Entities[0].Name}; consolidation requires semantic review"
                    : $"{names} in '{ownerName}' read related entities ({string.Join("; ", relations)}); consolidation requires semantic review",
                ["decision"] = "requires-semantic-review",
                ["fix"] = "Keep the queries unchanged unless equivalence is proved for authorization, transaction/lock boundaries, intervening writes and calls, dependent filters, ordering, independent pagination and counts, and join cardinality. Do not combine filters with OR, remove dependent filters, or replace paginated collections with a join based on this warning alone.",
                ["owner"] = ownerName,
                ["aggregates"] = new JsonArray(members.Select(m => (JsonNode)m.Name).ToArray()),
                ["relations"] = new JsonArray(relations.Select(r => (JsonNode)r).ToArray()),
            });
        }
    }

}
