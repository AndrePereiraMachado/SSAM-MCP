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
    public static Link? Relation(Entity a, Entity b)
    {
        foreach (var (owner, target) in new[] { (a, b), (b, a) })
            if (ModelHost.Prop(owner.Model, "Attributes") is System.Collections.IEnumerable attributes)
                foreach (var attribute in attributes)
                    if (ModelHost.Prop(attribute, "DataType") is OutSystems.Model.Types.IIdentifierType { Entity: { } points }
                        && ((points as IObjectSignature)?.ObjectKey?.ToString() ?? "name:" + TypeResolver.Name(points)) == target.Key)
                        return new(owner.Name, TypeResolver.Name(attribute) ?? "?", target.Name, ModelHost.Prop(attribute, "IsMandatory") is true);
        return null;
    }
}

/// <summary>
/// AGGREGATES_MERGEABLE (decisao do dono, 2026-10-09): no mesmo fluxo de action ou na mesma tela/bloco (busca de dados),
/// dois ou mais Aggregates cujas fontes sao entidades ligadas por um atributo de referencia (FK), ou a mesma entidade, e
/// cujos resultados sao usados juntos (lidos por expressoes do mesmo fluxo, inclusive o filtro de um pelo outro, ou ligados
/// na mesma arvore de widgets) sao um aviso HIGH (highWarnings, primeiro no recibo; A03: nunca bloqueia). O aviso nomeia os
/// aggregates, a relacao (Entidade.Atributo -> Entidade) e sugere UM aggregate (fontes + join + filtros somados) como trecho
/// de ops. A mesma entidade com filtros diferentes conta (um aggregate + filtro no cliente, ou um SQL); em telas diferentes
/// nao (o grupo e o dono do aggregate). So os grupos com um aggregate que o job criou ou mudou sao lidos.
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
        var used = shapes.Where(s => expressions.Any(e => !inside[s].Contains(e.Item1) && Reads(e.Item2, s))).ToHashSet();
        // The related pairs among the used ones: the same entity, or a reference attribute between their main entities.
        var edges = new List<(AggregateShape A, AggregateShape B, AggregateShape.Link? Link)>();
        for (var i = 0; i < shapes.Count; i++)
            for (var j = i + 1; j < shapes.Count; j++)
            {
                var a = shapes[i]; var b = shapes[j];
                if (!used.Contains(a) || !used.Contains(b)) continue;
                if (a.Entities[0].Key == b.Entities[0].Key) { edges.Add((a, b, null)); continue; }
                var link = a.Entities.SelectMany(x => b.Entities.Select(y => AggregateShape.Relation(x, y))).FirstOrDefault(l => l != null);
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
            var suggestion = sameEntity ? SameEntitySuggestion(members) : JoinSuggestion(members, links);
            Report("highWarnings", new JsonObject
            {
                ["code"] = AggregateConsolidationRule.Code, ["severity"] = "high", ["op"] = op,
                ["message"] = sameEntity
                    ? $"{names} in '{ownerName}' read the same entity {members[0].Entities[0].Name} with different filters and are used together: one query would do"
                    : $"{names} in '{ownerName}' read related entities ({string.Join("; ", relations)}) and are used together: one aggregate with a join would do",
                ["fix"] = sameEntity
                    ? "fetch once (one aggregate with the filters combined by `or`, or one SQL) and split it with ListFilter in the client; keep separate aggregates only in different screens"
                    : "replace them with the single aggregate of `suggestion` (sources + join + the filters of each) and read its columns where each one was read",
                ["owner"] = ownerName,
                ["aggregates"] = new JsonArray(members.Select(m => (JsonNode)m.Name).ToArray()),
                ["relations"] = new JsonArray(relations.Select(r => (JsonNode)r).ToArray()),
                ["suggestion"] = suggestion,
            });
        }
    }

    private static JsonObject JoinSuggestion(List<AggregateShape> members, List<(AggregateShape A, AggregateShape B, AggregateShape.Link? Link)> links)
    {
        // The main source is the parent side: an entity the references point to and that points to none of the others.
        var related = links.Where(l => l.Link != null).Select(l => l.Link!).ToList();
        var main = related.Select(l => l.Target).FirstOrDefault(t => related.All(l => l.Owner != t)) ?? members[0].Entities[0].Name;
        var sources = new List<string>();
        var joins = new JsonArray();
        // Each link joins one source already in the aggregate (the main one first) to one that is not yet: repeat until none joins.
        var pending = related.ToList();
        for (var progress = true; progress && pending.Count > 0;)
        {
            progress = false;
            foreach (var link in pending.ToList())
            {
                bool In(string entity) => entity == main || sources.Contains(entity);
                if (In(link.Owner) && In(link.Target)) { pending.Remove(link); progress = true; continue; }
                if (!In(link.Owner) && !In(link.Target)) continue;
                var other = In(link.Owner) ? link.Target : link.Owner;
                var left = other == link.Owner ? link.Target : link.Owner;
                sources.Add(other);
                joins.Add(new JsonObject { ["left"] = left, ["right"] = other, ["kind"] = "With or Without", ["condition"] = link.Condition });
                pending.Remove(link); progress = true;
            }
        }
        var names = members.Select(m => m.Name).ToList();
        // A filter that reads another member's output is the join itself: it goes away.
        var where = members.SelectMany(m => m.Filters.Where(f => !names.Any(n => !n.Equals(m.Name, StringComparison.OrdinalIgnoreCase)
            && Regex.IsMatch(f, @"(?<![\w.])" + Regex.Escape(n) + @"\.", RegexOptions.IgnoreCase)))).Distinct().Select(f => (JsonNode)f).ToArray();
        return new JsonObject
        {
            ["get"] = main, ["as"] = "Get" + main + string.Concat(sources.Select(s => "With" + s)),
            ["sources"] = new JsonArray(sources.Select(s => (JsonNode)s).ToArray()), ["joins"] = joins, ["where"] = new JsonArray(where),
        };
    }

    private static JsonObject SameEntitySuggestion(List<AggregateShape> members)
    {
        var entity = members[0].Entities[0].Name;
        var filters = members.Select(m => m.Filters.Count == 0 ? "True" : string.Join(" and ", m.Filters.Select(f => "(" + f + ")"))).ToList();
        return new JsonObject
        {
            ["get"] = entity, ["as"] = "Get" + entity + "s",
            ["where"] = filters.Any(f => f == "True") ? new JsonArray() : new JsonArray((JsonNode)string.Join(" or ", filters.Select(f => "(" + f + ")"))),
            ["split"] = new JsonArray(members.Select((m, i) => (JsonNode)$"{m.Name}: ListFilter(Get{entity}s.List, {filters[i]})").ToArray()),
        };
    }
}
