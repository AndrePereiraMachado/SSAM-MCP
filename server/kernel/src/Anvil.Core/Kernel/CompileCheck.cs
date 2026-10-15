using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.Model.Logic.Nodes;

namespace Anvil.Core;

/// <summary>
/// Checagem de compilação (decisão do dono, 2026-10-12: um erro de publicação quer dizer que o SSAM deixou a LLM construir o
/// que o OutSystems não suporta; tudo o que o SSAM diz "entregue" tem de compilar). Deterministic and structural, on the
/// candidate model at the end of every apply (ModelSession.Apply, beside QUERY_IN_LOOP), before the Verify, the save and the
/// merge. Each rule is the invariant the OutSystems compiler needs that the Model API and the Verify (TrueChange) let through,
/// one per class of SSAM-caused publish failure (C:\t\pub\DIAGNOSTICO.md). Every rule is an ERROR (one more failure of the
/// apply's single refusal, with its op, pointer, fix and the verified patch when the fix is certain); nothing is a warning:
/// <list type="bullet">
/// <item>A, sorts (AGGREGATE_SORT_NOT_ATTRIBUTE): a sort that is not dynamic names one attribute of a source of its aggregate
/// or one of its columns (AggregateSortRule); in an aggregate that groups (GROUP BY or AGG), only an attribute a group by column
/// reads (Source.Attribute, or a calculated column grouped by name): the sort lives before the grouping, and SQL orders grouped
/// rows by nothing else (SQL Server error 8127).</item>
/// <item>A, columns (AGGREGATE_COLUMN_NOT_ATTRIBUTE): a group by or aggregated column names one attribute of a source or a
/// column of the same aggregate, as the Studio writes it; an expression goes in a calculated column, grouped or aggregated
/// by name (the published form: AgentOps `GROUP BY RunDay=QueuedDay CALC QueuedDay=...`, another client module `AGG X=Sum(XRow) CALC
/// XRow=If(...)`). The slot is the same IExpression `Attribute` whose expression broke the compiler's AttributeSort. A column
/// that reads no attribute (`AGG Total=Count()`: no data type) is refused too, with the certain fix Count(Source.Id) when the
/// aggregate has one source (the ODC Verify says InvalidAggregateAttribute_NoAttribute; the O11 one only when something reads
/// the column).</item>
/// <item>A, joins (AGGREGATE_JOIN_NOT_NATIVE): a join is Inner (Only With), Left (With or Without) or Full (With), the three
/// the Studio writes (563 joins in the corpus: Inner and Left only), between two different sources of its own aggregate (a
/// source of another aggregate is refused: the ODC Model API refuses that write); every source of an aggregate with more than
/// one is in a join. Right is the Left join with its sources swapped (written so by the text and the logic op when it is the
/// only join); None and a source in no join are refused.</item>
/// <item>E, references (COMPILE_REFERENCE_OUTSIDE_MODULE, COMPILE_REFERENCE_DELETED): every element a created or changed object
/// points at is in this module (its own, or a signature under one of its References) and not deleted.</item>
/// <item>D, SOAP (COMPILE_SOAP_DEFINITION, ModelSession.SoapFindings): a consumed SOAP service is born only from the Studio's
/// import of its WSDL (op soap, o11_deliver): a client, method or structure the job's verbs created, or a WSDL/MetaData a raw
/// set wrote, is refused with the exact import call. The candidate of 2026-10-09 built that way failed in the compiler
/// ("error in XML document (0, 0), Root element is missing"). A lab job that measures the SOAP verbs declares
/// `allowSoapWithoutImport {why}` on the create op: HIGH warning COMPILE_SOAP_DEFINITION_ALLOWED, and the delivery refuses it.</item>
/// </list>
/// The aggregate rules also run over every aggregate of the module the job did not write (Preexisting): a base that already
/// does not compile makes no delivery on top of it compile (VisitaCerta_CS, 2026-10-12: the repair of 15:50 was "entregue"
/// and its publish failed on two If sorts that job did not touch), so the old part is refused too, marked
/// preexisting, with the raw ops that fix it when they are certain. The other classes are refused by rules that already run
/// in the same apply: cascade paths and cycles (DatabaseUpgradeRules, class C) and an extension without a deployable DLL
/// (XIF CompileAction Binaries, class B). `anvil compile-check --oml &lt;capture&gt;` runs the same rules over a whole module:
/// zero findings on every module of the corpus the Studio made (C:\t\html-plan\unique.json).
/// Tests: tests/Anvil.Tests/CompileCheckTests.cs, tests/Anvil.Tests.Odc/CompileCheckOdcTests.cs.
/// </summary>
public static class CompileCheck
{
    public const string ReferenceOutside = "COMPILE_REFERENCE_OUTSIDE_MODULE";
    public const string ReferenceDeleted = "COMPILE_REFERENCE_DELETED";
    public const string SoapDefinition = "COMPILE_SOAP_DEFINITION";
    public const string SoapAllowed = "COMPILE_SOAP_DEFINITION_ALLOWED";
    /// <summary>The lab escape of the SOAP rule, on the op that creates the client: {"why": "..."} (at least 15 characters).
    /// The apply accepts it with a HIGH warning; the delivery never delivers it (a lab measures verbs, it is not a module).</summary>
    public const string SoapAllowKey = "allowSoapWithoutImport";
    public const int MinimumWhy = 15;

    /// <summary>The rules, by code, as the receipts and the CLI name them.</summary>
    public static readonly IReadOnlyList<string> Codes = [AggregateSortRule.Code, AggregateSortRule.ColumnCode, AggregateSortRule.JoinCode, ReferenceOutside, ReferenceDeleted, SoapDefinition];

    // Warning: a HIGH warning of the receipt (only the lab escape of the SOAP rule), never a refusal.
    public sealed record Finding(string Code, IObjectSignature Element, IObjectSignature? Aggregate, string Path, string Message, string Fix, bool Warning = false)
    {
        /// <summary>A part of the module the job did not write (the base already had it).</summary>
        public bool Preexisting { get; init; }
        /// <summary>The raw ops (by @key) that fix it, when the fix is certain: what a job appends to its ops.</summary>
        public JsonArray? Ops { get; init; }
        /// <summary>The op the fix is (the exact import call of a SOAP client), when there is one.</summary>
        public JsonObject? Suggestion { get; init; }
        /// <summary>The property at fault (a raw `set` of it is the op to fix, at its /value), when it is one.</summary>
        public string? Property { get; init; }
        /// <summary>The certain value of <see cref="Property"/>: a raw `set` of it is patched to this value.</summary>
        public string? Replacement { get; init; }
    }

    private static readonly string[] AggregateKinds = ["IAggregate", "IDatabaseAggregate", "IAggregateNode"];
    // Subtrees that never hold an aggregate (the bulk of a module): widgets, expressions, entities, structures, resources,
    // themes and images. The corpus proves the walk finds every aggregate a full sweep finds (compile-check: walk.aggregates).
    private static readonly string[] LeafKinds = ["IWidget", "IExpression", "IEntity", "IStructure", "IResource", "ITheme", "IImage"];
    // Properties that only walk the tree (their target is an ancestor or the module): never a reference of the element.
    private static readonly HashSet<string> Navigation = new(StringComparer.Ordinal) { "Parent", "ESpace", "Module", "RootObject", "Root", "TopParent", "OwnerESpace" };

    // ---- what an object is, once per type ---------------------------------------------------------------------------------

    [Flags]
    internal enum Part { None = 0, Sort = 1, Group = 2, Agg = 4, Calc = 8, Source = 16, Join = 32, Aggregate = 64, Leaf = 128 }
    private static readonly ConcurrentDictionary<Type, Part> Parts = new();

    /// <summary>The aggregate part an object is (interfaces are per type: computed once per type). Leaf: a subtree that never
    /// holds an aggregate (a widget, an expression), skipped by the module walk.</summary>
    internal static Part PartOf(object o) => Parts.GetOrAdd(o.GetType(), _ => Classify(o));

    private static Part Classify(object o)
    {
        var part = Part.None;
        if (ModelSession.Implements(o, "ISort")) part |= Part.Sort;
        if (ModelSession.Implements(o, "IGroupByAttribute")) part |= Part.Group;
        else if (ModelSession.Implements(o, "IAggregateAttribute") || ModelSession.Implements(o, "IAggregatedAttribute")) part |= Part.Agg;
        if (ModelSession.Implements(o, "ICalculatedAttribute")) part |= Part.Calc;
        if (ModelSession.Implements(o, "IAliasedSource")) part |= Part.Source;
        if (ModelSession.Implements(o, "IJoin")) part |= Part.Join;
        if (AggregateKinds.Any(k => ModelSession.Implements(o, k))) part |= Part.Aggregate;
        if (LeafKinds.Any(k => ModelSession.Implements(o, k))) part |= Part.Leaf;
        return part;
    }

    private const Part AggregateParts = Part.Sort | Part.Group | Part.Agg | Part.Source | Part.Join;

    // ---- the rules ----------------------------------------------------------------------------------------------------

    /// <summary>Every violation among <paramref name="objects"/> of the module <paramref name="module"/>. Never throws: an object
    /// it cannot read is skipped. <paramref name="references"/>: rule E too (it reads every property of every object).</summary>
    public static List<Finding> Run(IObjectSignature module, IEnumerable<IObjectSignature> objects, bool references = true)
    {
        var findings = new List<Finding>();
        var root = RootOf(module);
        var scopes = new Dictionary<IObjectSignature, Scope>(ReferenceEqualityComparer.Instance);
        var aggregates = new List<IObjectSignature>();
        var seen = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
        void Add(Finding? finding) { if (finding != null) findings.Add(finding); }
        foreach (var o in objects)
        {
            if (o.WasDeleted) continue;
            try
            {
                var part = PartOf(o);
                if ((part & Part.Aggregate) != 0 && seen.Add(o)) aggregates.Add(o);
                if ((part & AggregateParts) != 0 && AggregateOf(o) is { } aggregate)
                {
                    if (seen.Add(aggregate)) aggregates.Add(aggregate);
                    var scope = ScopeOf(aggregate, scopes);
                    if ((part & Part.Sort) != 0) Add(Sort(o, aggregate, scope));
                    else if ((part & (Part.Group | Part.Agg)) != 0) Add(Column(o, aggregate, scope));
                    else if ((part & Part.Join) != 0) Add(Join(o, aggregate, scope));
                }
                if (references) References(o, root, findings);
            }
            catch { /* an object the check cannot read is not a finding */ }
        }
        foreach (var aggregate in aggregates)
            try { Add(Sources(aggregate, ScopeOf(aggregate, scopes))); } catch { }
        return findings;
    }

    /// <summary>The aggregate rules over every aggregate of the module, except the parts in <paramref name="job"/> (what the job
    /// created or changed, which Run judges): what the base already had, marked Preexisting.</summary>
    public static List<Finding> Preexisting(IObjectSignature module, ISet<IObjectSignature> job)
    {
        var parts = new List<IObjectSignature>();
        foreach (var aggregate in AggregatesOf(module))
            foreach (var d in aggregate.GetAllDescendantsOfType<IObjectSignature>())
                if (!d.WasDeleted && !job.Contains(d) && (PartOf(d) & AggregateParts) != 0) parts.Add(d);
        return Run(module, parts, references: false).Select(f => f with { Preexisting = true }).ToList();
    }

    /// <summary>Every aggregate of the module (aggregate nodes of the flows, screen and block aggregates): a walk of the tree that
    /// skips the subtrees that never hold one (widgets, expressions) and does not enter an aggregate.</summary>
    public static IEnumerable<IObjectSignature> AggregatesOf(IObjectSignature module)
    {
        var pending = new Stack<IObjectSignature>();
        pending.Push(module);
        var visited = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
        while (pending.TryPop(out var node))
        {
            if (!visited.Add(node)) continue;
            IEnumerable<IObjectSignature> children;
            try { children = node.Children.OfType<IObjectSignature>().ToList(); } catch { continue; }
            foreach (var child in children)
            {
                if (child.WasDeleted) continue;
                var part = PartOf(child);
                if ((part & Part.Aggregate) != 0) { yield return child; continue; }
                if ((part & Part.Leaf) != 0) continue;
                pending.Push(child);
            }
        }
    }

    /// <summary>The topmost element of an object's tree (the module, for an element of it).</summary>
    internal static object RootOf(IObjectSignature o)
    {
        object top = o;
        for (object? p = o; p is IObjectSignature s; p = s.Parent) top = s;
        return top;
    }

    internal static IObjectSignature? AggregateOf(IObjectSignature o)
    {
        for (var p = o.Parent as IObjectSignature; p != null; p = p.Parent as IObjectSignature)
            if ((PartOf(p) & Part.Aggregate) != 0) return p;
        return null;
    }

    /// <summary>What a part of an aggregate may name: its sources and columns, the keys a grouped aggregate orders by (the
    /// attributes its group by columns read: Source.Attribute or a calculated column), its sources, joins and sorts in model order.</summary>
    internal sealed class Scope
    {
        public readonly List<string> Sources = [], Columns = [];
        public readonly List<IObjectSignature> SourceObjects = [], Joins = [], Sorts = [];
        public readonly List<string> GroupKeys = [];
        public bool Grouped;
    }

    internal static Scope ScopeOf(IObjectSignature aggregate, Dictionary<IObjectSignature, Scope>? scopes = null)
    {
        if (scopes != null && scopes.TryGetValue(aggregate, out var known)) return known;
        var scope = new Scope();
        static void AddName(List<string> list, string name) { if (name.Length > 0 && !list.Contains(name, StringComparer.OrdinalIgnoreCase)) list.Add(name); }
        foreach (var d in aggregate.GetAllDescendantsOfType<IObjectSignature>())
        {
            if (d.WasDeleted) continue;
            var part = PartOf(d);
            if ((part & (AggregateParts | Part.Calc)) == 0) continue;
            var name = TypeResolver.Name(d) ?? "";
            if ((part & Part.Source) != 0) { scope.SourceObjects.Add(d); AddName(scope.Sources, name); }
            if ((part & Part.Join) != 0) scope.Joins.Add(d);
            if ((part & Part.Sort) != 0) scope.Sorts.Add(d);
            if ((part & (Part.Group | Part.Agg | Part.Calc)) != 0) AddName(scope.Columns, name);
            // A sort lives before the grouping (CombineSourcesOperation): it names a source attribute or a calculated column, never
            // a group by or aggregated column ("Can't identify 'Total'", the Verify); SQL then needs that attribute grouped.
            if ((part & Part.Group) != 0)
            {
                scope.Grouped = true;
                if (AggregateSortRule.Plain(AggregateShape.Text(ModelHost.Prop(d, "Attribute"))) is { } grouped) AddName(scope.GroupKeys, grouped);
            }
            else if ((part & Part.Agg) != 0) scope.Grouped = true;
        }
        // ODC: an aliased source stands over the operation that adds it (SourceOperation); that operation is structure, not a
        // second source (FlowExtractor.Aggregate reads them the same way).
        var structure = new HashSet<object>(scope.SourceObjects.Select(s => ModelHost.Prop(s, "SourceOperation")).OfType<object>(), ReferenceEqualityComparer.Instance);
        if (structure.Count > 0) scope.SourceObjects.RemoveAll(s => structure.Contains(s));
        if (scopes != null) scopes[aggregate] = scope;
        return scope;
    }

    private static Finding? Sort(IObjectSignature sort, IObjectSignature aggregate, Scope scope)
    {
        if (ModelHost.Prop(sort, "IsDynamic") is true) return null;
        var text = AggregateShape.Text(ModelHost.Prop(sort, "Attribute"));
        var plain = AggregateSortRule.Plain(text);
        var grouped = plain == null ? null : AggregateSortRule.OutOfGroup(plain, scope.Grouped, scope.GroupKeys);
        var why = plain == null ? "is an expression, not one attribute" : AggregateSortRule.OutOfScope(plain, scope.Sources, scope.Columns) ?? grouped;
        if (why == null) return null;
        var fix = grouped != null ? AggregateSortRule.GroupedFix(scope.GroupKeys) : AggregateSortRule.Fix(text);
        JsonArray? ops = null;
        var key = sort.ObjectKey?.ToString();
        // The certain form, when there is one: what to write instead, and the raw ops that write it.
        if (AggregateSortRule.Normalize(text) is { Steps.Count: > 0 } normal && AggregateSortRule.OutOfScope(normal.Attribute, scope.Sources, scope.Columns) == null
            && AggregateSortRule.OutOfGroup(normal.Attribute, scope.Grouped, scope.GroupKeys) == null)
        {
            var direction = ModelHost.Prop(sort, "SortDirection")?.ToString() ?? "Ascending";
            var wanted = normal.Flip ? AggregateSortRule.Reverse(direction) : direction;
            fix = "write the attribute " + normal.Attribute + " with SortDirection " + wanted + " (" + string.Join("; ", normal.Steps) + ")";
            // The same attribute already orders the rows before this sort: this one adds nothing (the order is the same without it).
            var index = scope.Sorts.FindIndex(s => ReferenceEquals(s, sort));
            var earlier = scope.Sorts.Take(Math.Max(0, index)).Any(s => ModelHost.Prop(s, "IsDynamic") is not true
                && string.Equals(AggregateShape.Text(ModelHost.Prop(s, "Attribute")), normal.Attribute, StringComparison.OrdinalIgnoreCase));
            var later = scope.Sorts.Skip(index + 1).Any(s => ModelHost.Prop(s, "IsDynamic") is not true
                && string.Equals(AggregateShape.Text(ModelHost.Prop(s, "Attribute")), normal.Attribute, StringComparison.OrdinalIgnoreCase));
            if (key != null && earlier) { fix = "delete this sort: " + normal.Attribute + " already orders the rows before it (" + string.Join("; ", normal.Steps) + ")"; ops = [Op("delete", ("target", "@" + key))]; }
            else if (key != null && !later)
            {
                ops = [Op("set", ("target", "@" + key), ("prop", "Attribute"), ("value", normal.Attribute))];
                if (!string.Equals(wanted, direction, StringComparison.OrdinalIgnoreCase)) ops.Add(Op("set", ("target", "@" + key), ("prop", "SortDirection"), ("value", wanted)));
            }
        }
        return new(AggregateSortRule.Code, sort, aggregate, PathOf(sort),
            $"the sort '{text}' of the aggregate {Name(aggregate)} {why}: the Studio sorts by an attribute of a source or by a column of the aggregate (a grouped one by its group by or aggregated columns), and the OutSystems compiler fails on any other sort that is not dynamic (AttributeSort: 'Dump is not a valid invocation for SQLCallFunction', NullReferenceException in Old_IsDynamic)",
            fix) { Ops = ops };
    }

    private static Finding? Column(IObjectSignature column, IObjectSignature aggregate, Scope scope)
    {
        var text = AggregateShape.Text(ModelHost.Prop(column, "Attribute"));
        if (text.Length == 0) return EmptyColumn(column, aggregate, scope);
        var self = TypeResolver.Name(column) ?? "";
        var plain = AggregateSortRule.Plain(text);
        var why = plain == null ? "is an expression, not one attribute of a source" : AggregateSortRule.OutOfScope(plain, scope.Sources, scope.Columns.Where(c => !c.Equals(self, StringComparison.OrdinalIgnoreCase)).ToList());
        if (why == null) return null;
        var group = (PartOf(column) & Part.Group) != 0;
        return new(AggregateSortRule.ColumnCode, column, aggregate, PathOf(column),
            $"the {(group ? "group by" : "aggregated")} column {self} of the aggregate {Name(aggregate)} reads '{text}', which {why}: the Studio groups and aggregates attributes of the sources (or columns) only, an expression goes in a calculated column; the compiler builds the GROUP BY and the aggregate function from that slot as it builds a sort, whose expressions it fails on",
            AggregateSortRule.ColumnFix(text, self, group, ModelHost.Prop(column, "AggregationType")?.ToString()));
    }

    /// <summary>A group by or aggregated column whose Attribute is empty (text `AGG Total=Count()`, JSON `"attribute": ""`, a raw
    /// create without its set): no data type, and nothing for the compiler to group or aggregate. The ODC Verify refuses it
    /// (InvalidAggregateAttribute_NoAttribute); the O11 Verify only when an expression reads the column (a column nothing reads
    /// was delivered). Certain fix: Count with one source counts the rows by that source's identifier.</summary>
    private static Finding EmptyColumn(IObjectSignature column, IObjectSignature aggregate, Scope scope)
    {
        var self = TypeResolver.Name(column) ?? "";
        var group = (PartOf(column) & Part.Group) != 0;
        var function = group ? null : ModelHost.Prop(column, "AggregationType")?.ToString();
        var source = scope.SourceObjects.Count == 1 ? TypeResolver.Name(scope.SourceObjects[0]) : null;
        var identifier = source is { Length: > 0 } ? IdentifierOf(scope.SourceObjects[0]) : null;
        var replacement = !group && string.Equals(function, "Count", StringComparison.OrdinalIgnoreCase) && source is { Length: > 0 } && identifier != null ? source + "." + identifier : null;
        var key = column.ObjectKey?.ToString();
        return new(AggregateSortRule.ColumnCode, column, aggregate, PathOf(column),
            $"the {(group ? "group by" : "aggregated")} column {self} of the aggregate {Name(aggregate)} {AggregateSortRule.EmptyColumnWhy}: its Attribute is empty, so the column has no data type and the compiler has nothing to {(group ? "group by" : "aggregate")}; the Studio always names the attribute a column reads (no aggregate of the corpus has a column without one), the ODC Verify refuses it (InvalidAggregateAttribute_NoAttribute) and the O11 Verify sees it only when an expression reads the column",
            AggregateSortRule.EmptyColumnFix(self, group, function, source, identifier))
        {
            Property = "Attribute", Replacement = replacement,
            Ops = replacement != null && key != null ? [Op("set", ("target", "@" + key), ("prop", "Attribute"), ("value", replacement))] : null,
        };
    }

    /// <summary>The name of the identifier attribute of the entity an aliased source reads, or null.</summary>
    internal static string? IdentifierOf(object source)
    {
        try
        {
            if (ModelHost.Prop(source, "Source") is not { } record || ModelHost.Prop(record, "IdentifierAttribute") is not { } identifier) return null;
            return TypeResolver.Name(identifier) is { Length: > 0 } name ? name : null;
        }
        catch { return null; }
    }

    private static Finding? Join(IObjectSignature join, IObjectSignature aggregate, Scope scope)
    {
        var leftSource = ModelHost.Prop(join, "LeftSource");
        var rightSource = ModelHost.Prop(join, "RightSource");
        var left = leftSource is { } l ? Name(l) : "?";
        var right = rightSource is { } r ? Name(r) : "?";
        // A join names two sources of its own aggregate (what its FROM declares): a source of another aggregate is no source of
        // this query (the ODC Model API refuses the write: "IAliasedSource cannot be used as the value for IJoin.LeftSource").
        foreach (var (property, source) in new[] { ("LeftSource", leftSource), ("RightSource", rightSource) })
        {
            if (source is not IObjectSignature element || Under(element, aggregate)) continue;
            var owner = AggregateOf(element) is { } other ? $" (it is a source of the aggregate {Name(other)})" : "";
            return new(AggregateSortRule.JoinCode, join, aggregate, PathOf(join),
                $"the join {left}~{right} of the aggregate {Name(aggregate)} names the source {Name(element)}, which is not a source of this aggregate{owner}: the Studio joins only the sources of the aggregate's own FROM, and the compiler builds the join from them",
                AggregateSortRule.ForeignJoinFix(Name(element), Name(aggregate))) { Property = property };
        }
        if (leftSource != null && ReferenceEquals(leftSource, rightSource))
            return new(AggregateSortRule.JoinCode, join, aggregate, PathOf(join),
                $"the join {left}~{right} of the aggregate {Name(aggregate)} joins the source {left} with itself: the Studio joins two different sources of the aggregate",
                $"join two different sources of {Name(aggregate)}; to join the entity with itself, add it again as a second source (JOIN Inner {left}~{left}2 ON <condition>)") { Property = "RightSource" };
        var type = ModelHost.Prop(join, "JoinType")?.ToString() ?? "";
        if (AggregateSortRule.NativeJoin(type)) return null;
        return new(AggregateSortRule.JoinCode, join, aggregate, PathOf(join),
            $"the join {left}~{right} of the aggregate {Name(aggregate)} is '{type}': the Studio writes only Only With (Inner), With or Without (Left) and With (Full), and nothing proves the compiler builds a {(type.Length > 0 ? type : "None")} join",
            AggregateSortRule.JoinFix(type, left, right, scope.Joins.Count)) { Property = "JoinType" };
    }

    /// <summary>Whether <paramref name="element"/> is in the subtree of <paramref name="ancestor"/>.</summary>
    private static bool Under(IObjectSignature element, IObjectSignature ancestor)
    {
        for (var p = element.Parent as IObjectSignature; p != null; p = p.Parent as IObjectSignature)
            if (ReferenceEquals(p, ancestor)) return true;
        return false;
    }

    private static Finding? Sources(IObjectSignature aggregate, Scope scope)
    {
        if (scope.SourceObjects.Count < 2) return null;
        var joined = new HashSet<object>(ReferenceEqualityComparer.Instance);
        foreach (var join in scope.Joins)
        {
            if (ModelHost.Prop(join, "LeftSource") is { } left) joined.Add(left);
            if (ModelHost.Prop(join, "RightSource") is { } right) joined.Add(right);
        }
        var loose = scope.SourceObjects.FirstOrDefault(s => !joined.Contains(s));
        if (loose == null) return null;
        var other = scope.SourceObjects.First(s => !ReferenceEquals(s, loose));
        return new(AggregateSortRule.JoinCode, loose, aggregate, PathOf(loose),
            $"the source {Name(loose)} of the aggregate {Name(aggregate)} is in no join: the Studio joins every source of an aggregate (Only With, With or Without, With), and nothing proves the compiler builds the product of two sources",
            $"join it to the other sources (JOIN Inner {Name(other)}~{Name(loose)} ON <condition>, or Left for With or Without), or remove the source");
    }

    private static void References(IObjectSignature o, object root, List<Finding> findings)
    {
        foreach (var property in ModelApiMetadata.Properties(o.GetType()))
        {
            if (Navigation.Contains(property.Name) || property.GetIndexParameters().Length > 0) continue;
            var type = property.PropertyType;
            if (!type.IsInterface || typeof(System.Collections.IEnumerable).IsAssignableFrom(type) || typeof(IExpression).IsAssignableFrom(type)) continue;
            object? value;
            try { value = property.GetValue(o); } catch { continue; }
            if (value is not IObjectSignature target || ReferenceEquals(target, o)) continue;
            if (target.WasDeleted)
            {
                findings.Add(new(ReferenceDeleted, o, null, PathOf(o), $"{property.Name} of {PathOf(o)} points at {Name(target)}, which was deleted",
                    "point it at an element that exists (or delete the element that uses the deleted one)"));
                continue;
            }
            if (ReferenceEquals(RootOf(target), root)) continue;
            findings.Add(new(ReferenceOutside, o, null, PathOf(o),
                $"{property.Name} of {PathOf(o)} points at {Name(target)}, which is not an element of this module nor a signature under one of its References: the module the Studio publishes does not have it (\"Unknown {Name(target)}\" after the merge)",
                "add the producer's element to the module's References first (op reference with that element), then point at it"));
        }
    }

    // ---- SOAP (class D) -------------------------------------------------------------------------------------------------

    /// <summary>Whether <paramref name="o"/> is an element of a consumed SOAP service (the Studio's SOAP plugin: the client, its
    /// methods, parameters, structures and static entities), never an exposed one.</summary>
    public static bool SoapConsumer(object o) => o.GetType().GetInterfaces().Any(i => i.Namespace == "ServiceStudio.Plugin.SOAP");

    /// <summary>The finding of a consumed SOAP element the job's verbs created (the topmost one: a client, or a method or structure
    /// under a client the import made), with the exact import call.</summary>
    public static Finding SoapCreated(IObjectSignature element, string lane)
    {
        var client = ModelSession.Implements(element, "ISOAPClient") ? element : Ancestors(element).FirstOrDefault(a => ModelSession.Implements(a, "ISOAPClient")) ?? element;
        var clientName = Name(client);
        var methods = client.Children.OfType<IObjectSignature>().Where(c => !c.WasDeleted && ModelSession.Implements(c, "ISOAPAction")).Select(Name).ToList();
        if (!ReferenceEquals(element, client) && ModelSession.Implements(element, "ISOAPAction")) methods = [Name(element)];
        var what = ReferenceEquals(element, client) ? $"the consumed SOAP service {clientName}" : $"the {Kind(element)} {Name(element)} of the consumed SOAP service {clientName}";
        var odc = string.Equals(lane, "odc", StringComparison.OrdinalIgnoreCase);
        // A new client or a new method: the import brings it (methods); the methods already imported are skipped.
        var suggestion = odc ? null : SoapImport(client, methods, refresh: false);
        var message = $"{what} is created by this job's verbs, not by the Studio's import of its WSDL: the OutSystems compiler builds a consumed SOAP service from the definition the import keeps (the WSDL and its metadata), and a client made element by element failed in the compiler on 2026-10-09 (SSAMSoapLogCore20261009: 'Invalid compiler output ... error in XML document (0, 0)', Root element is missing)";
        var fix = odc
            ? "ODC does not consume SOAP: call the service through a REST facade (op rest with its openapi document) or an External Library that calls it; remove the SOAP elements from the job"
            : $"replace the create ops of {clientName} (and of its methods, parameters and structures) by the native import {suggestion!.ToJsonString()} and deliver it with o11_deliver (the bridge runs the Studio's importer on a copy of the module; ssam_job without the Studio answers INTEGRATION_IMPORT_NEEDS_STUDIO)";
        return new(SoapDefinition, element, null, PathOf(element), message, fix) { Suggestion = suggestion };
    }

    /// <summary>The finding of a WSDL (or its metadata) a raw set wrote on a consumed SOAP service.</summary>
    public static Finding SoapWritten(IObjectSignature client, string property, string lane)
    {
        var odc = string.Equals(lane, "odc", StringComparison.OrdinalIgnoreCase);
        var methods = client.Children.OfType<IObjectSignature>().Where(c => !c.WasDeleted && ModelSession.Implements(c, "ISOAPAction")).Select(Name).ToList();
        var suggestion = odc ? null : SoapImport(client, methods, refresh: true);
        return new(SoapDefinition, client, null, PathOf(client),
            $"the {property} of the consumed SOAP service {Name(client)} is written by a raw set: only the Studio's import writes the definition, with the metadata the compiler reads beside it ('Root element is missing' when they do not match)",
            odc ? "ODC does not consume SOAP: call the service through a REST facade (op rest) or an External Library"
                : $"remove the set and refresh the service through the native import {suggestion!.ToJsonString()} with o11_deliver") { Suggestion = suggestion };
    }

    /// <summary>The op soap that imports (or refreshes) the methods of a client, as the deliver takes it.</summary>
    private static JsonObject SoapImport(IObjectSignature client, IReadOnlyList<string> methods, bool refresh)
    {
        var location = ModelHost.Prop(client, "WSDLLocation") as string;
        var uri = ModelHost.Prop(client, "DefaultUri") as string;
        var wsdl = location is { Length: > 0 } ? location : uri is { Length: > 0 } ? uri + (uri.Contains('?') ? "" : "?WSDL") : "<url or absolute path of the service's WSDL>";
        var names = new JsonArray((methods.Count > 0 ? methods : ["<Operation>"]).Select(m => (JsonNode)m).ToArray());
        var data = new JsonObject { ["wsdl"] = wsdl, ["client"] = Name(client), [refresh ? "refresh" : "methods"] = names };
        return new JsonObject { ["op"] = "soap", ["data"] = data };
    }

    /// <summary>The why of a valid lab escape on <paramref name="op"/>, or null (absent, or too short: then <paramref name="invalid"/> says why).</summary>
    public static string? SoapEscape(JsonObject? op, out string? invalid)
    {
        invalid = null;
        if (op?[SoapAllowKey] is not { } flag) return null;
        var why = flag is JsonObject o && o["why"] is JsonValue w && w.TryGetValue<string>(out var text) ? text.Trim() : null;
        if (why != null && why.Length >= MinimumWhy) return why;
        invalid = $"{SoapAllowKey} needs {{\"why\": \"<at least {MinimumWhy} characters>\"}}";
        return null;
    }

    private static IEnumerable<IObjectSignature> Ancestors(IObjectSignature o)
    {
        for (var p = o.Parent as IObjectSignature; p != null; p = p.Parent as IObjectSignature) yield return p;
    }

    private static string Name(object o) => TypeResolver.Name(o) is { Length: > 0 } name ? name : o.GetType().Name;

    private static JsonObject Op(string verb, params (string Key, string Value)[] fields)
    {
        var op = new JsonObject { ["op"] = verb };
        foreach (var (key, value) in fields) op[key] = value;
        return op;
    }

    /// <summary>Kind:Name/... from the module down to the element.</summary>
    internal static string PathOf(IObjectSignature o)
    {
        var levels = new List<string>();
        for (var p = o; p != null && p.Parent is IObjectSignature; p = p.Parent as IObjectSignature)
            levels.Add(Kind(p) + ":" + (TypeResolver.Name(p) ?? ""));
        levels.Reverse();
        return string.Join("/", levels);
    }

    private static string Kind(object o)
    {
        var name = o.GetType().Name;
        return name.StartsWith("I", StringComparison.Ordinal) && name.Length > 1 && char.IsUpper(name[1]) ? name[1..] : name;
    }

    // ---- the CLI and the tests ----------------------------------------------------------------------------------------

    /// <summary>`compile-check --oml &lt;capture&gt;` (both CLIs): the rules over every element of one module; what it finds, by code,
    /// how many elements each rule read, and the module walk the apply uses for the old parts (aggregates found by it and by a
    /// full sweep: they must be the same).</summary>
    public static JsonObject Module(ModelHost host, byte[] oml, string label, int max = 40)
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var espace = host.Load(oml);
        try
        {
            var root = (IObjectSignature)espace;
            var all = root.GetAllDescendantsOfType<IObjectSignature>().ToList();
            var loaded = clock.Elapsed.TotalMilliseconds;
            var findings = Run(root, all);
            var checkedAt = clock.Elapsed.TotalMilliseconds;
            var walked = AggregatesOf(root).ToList();
            var walk = clock.Elapsed.TotalMilliseconds;
            var old = Preexisting(root, new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance));
            var preexisting = clock.Elapsed.TotalMilliseconds;
            int Count(Part part) => all.Count(o => !o.WasDeleted && (PartOf(o) & part) != 0);
            return new JsonObject
            {
                ["label"] = label, ["objects"] = all.Count,
                ["read"] = new JsonObject
                {
                    ["sorts"] = Count(Part.Sort), ["columns"] = Count(Part.Group | Part.Agg), ["joins"] = Count(Part.Join), ["aggregates"] = Count(Part.Aggregate),
                    ["soapClients"] = all.Count(o => !o.WasDeleted && ModelSession.Implements(o, "ISOAPClient")),
                },
                ["walk"] = new JsonObject { ["aggregates"] = walked.Count, ["preexisting"] = old.Count },
                ["findings"] = findings.Count(f => !f.Warning), ["warnings"] = findings.Count(f => f.Warning),
                ["byCode"] = new JsonObject(findings.GroupBy(f => f.Code).OrderBy(g => g.Key, StringComparer.Ordinal).Select(g => KeyValuePair.Create(g.Key, (JsonNode?)g.Count()))),
                ["list"] = new JsonArray(findings.Take(max).Select(f => (JsonNode)ToJson(f)).ToArray()),
                ["ms"] = new JsonObject
                {
                    ["load"] = Math.Round(loaded), ["check"] = Math.Round(checkedAt - loaded), ["walk"] = Math.Round(walk - checkedAt), ["preexisting"] = Math.Round(preexisting - checkedAt),
                },
            };
        }
        finally { ModelHost.Release(espace); }
    }

    /// <summary>The sorts of one module in model order: {aggregate, attribute, direction, dynamic} (what a writer left).</summary>
    public static JsonArray SortsOf(ModelHost host, byte[] oml)
    {
        var espace = host.Load(oml);
        try
        {
            return new JsonArray(((IObjectSignature)espace).GetAllDescendantsOfType<IObjectSignature>().Where(o => !o.WasDeleted && (PartOf(o) & Part.Sort) != 0)
                .Select(s => (JsonNode)new JsonObject
                {
                    ["aggregate"] = AggregateOf(s) is { } a ? TypeResolver.Name(a) : null, ["attribute"] = AggregateShape.Text(ModelHost.Prop(s, "Attribute")),
                    ["direction"] = ModelHost.Prop(s, "SortDirection")?.ToString(), ["dynamic"] = ModelHost.Prop(s, "IsDynamic") is true,
                }).ToArray());
        }
        finally { ModelHost.Release(espace); }
    }

    /// <summary>The parts of the aggregates of one module, for the tests: {aggregate, kind (join, group, agg, calc), name, value,
    /// type (the join type), left, right}.</summary>
    public static JsonArray PartsOf(ModelHost host, byte[] oml)
    {
        var espace = host.Load(oml);
        try
        {
            var result = new JsonArray();
            foreach (var o in ((IObjectSignature)espace).GetAllDescendantsOfType<IObjectSignature>())
            {
                if (o.WasDeleted) continue;
                var part = PartOf(o);
                var kind = (part & Part.Join) != 0 ? "join" : (part & Part.Group) != 0 ? "group" : (part & Part.Agg) != 0 ? "agg" : (part & Part.Calc) != 0 ? "calc" : null;
                if (kind == null) continue;
                result.Add(new JsonObject
                {
                    ["aggregate"] = AggregateOf(o) is { } a ? TypeResolver.Name(a) : null, ["kind"] = kind, ["name"] = TypeResolver.Name(o),
                    ["value"] = AggregateShape.Text(ModelHost.Prop(o, kind == "calc" ? "Value" : kind == "join" ? "Condition" : "Attribute")),
                    ["type"] = kind == "join" ? ModelHost.Prop(o, "JoinType")?.ToString() : kind == "agg" ? ModelHost.Prop(o, "AggregationType")?.ToString() : null,
                    ["left"] = kind == "join" && ModelHost.Prop(o, "LeftSource") is { } l ? TypeResolver.Name(l) : null,
                    ["right"] = kind == "join" && ModelHost.Prop(o, "RightSource") is { } r ? TypeResolver.Name(r) : null,
                });
            }
            return result;
        }
        finally { ModelHost.Release(espace); }
    }

    /// <summary>Rule E without a job (the writers never produce it; the rule is the net): a consumer module whose Execute node is
    /// pointed, outside the verbs, at an action of another loaded module. The findings, or null when the model itself refuses
    /// the write (then there is nothing to find). Used by the tests only.</summary>
    internal static JsonArray? ForeignReferenceProbe(ModelHost host, byte[] oml)
    {
        var consumer = host.Load(oml);
        var producer = host.Load(oml);
        try
        {
            new ModelSession(producer).Apply(JsonNode.Parse("""[{"op":"create","parent":"@espace","type":"IServerAction","name":"Foreign"}]""")!.AsArray());
            var foreign = ((IObjectSignature)producer).GetAllDescendantsOfType<IObjectSignature>().First(o => TypeResolver.Name(o) == "Foreign");
            var session = new ModelSession(consumer);
            session.Apply(JsonNode.Parse("""[{"op":"logic","data":{"actions":[{"name":"Local","steps":[]},{"name":"Caller","steps":[{"call":"Local"}]}]}}]""")!.AsArray());
            var root = (IObjectSignature)consumer;
            var call = root.GetAllDescendantsOfType<IObjectSignature>().First(o => o is IFlowNode && ModelHost.Prop(o, "Action") is IObjectSignature);
            if (Run(root, [call]).Count > 0) throw new InvalidOperationException("the local call was already a finding");
            var property = ModelApiMetadata.Properties(call.GetType()).First(p => p.Name == "Action" && p.CanWrite);
            try { session.Mutate("point at the producer", () => property.SetValue(call, foreign)); }
            catch { return null; }
            if (!ReferenceEquals(ModelHost.Prop(call, "Action"), foreign)) return null;
            return new JsonArray(Run(root, [call]).Select(f => (JsonNode)ToJson(f)).ToArray());
        }
        finally { ModelHost.Release(consumer); ModelHost.Release(producer); }
    }

    /// <summary>A base that already has what the compiler cannot build, for the tests: <paramref name="ops"/> applied without the
    /// footprint (so without the checagem de compilação, as an older release wrote them) and saved to <paramref name="output"/>.</summary>
    public static void WriteUnchecked(ModelHost host, byte[] oml, JsonArray ops, string output)
    {
        var espace = host.Load(oml);
        try
        {
            new ModelSession(espace).Apply(ops);
            File.WriteAllBytes(output, host.Save(espace));
        }
        finally { ModelHost.Release(espace); }
    }

    /// <summary>A finding as the CLI and the receipts write it.</summary>
    public static JsonObject ToJson(Finding finding)
    {
        var json = new JsonObject
        {
            ["code"] = finding.Code, ["severity"] = finding.Warning ? "high" : "error", ["path"] = finding.Path, ["key"] = finding.Element.ObjectKey?.ToString(),
            ["message"] = finding.Message, ["fix"] = finding.Fix,
        };
        if (finding.Preexisting) json["preexisting"] = true;
        if (finding.Ops != null) json["ops"] = finding.Ops.DeepClone();
        if (finding.Suggestion != null) json["suggestion"] = finding.Suggestion.DeepClone();
        return json;
    }
}

public sealed partial class ModelSession
{
    /// <summary>The checagem de compilação of one apply (CompileCheck): what this job created or changed, its SOAP elements, and
    /// the aggregates of the module it did not write (preexisting); each violation is one more failure of the apply's refusal,
    /// with its op, the pointer of its step when the op declares it, the fix and the patch when it is certain. A job that only
    /// reads is not judged (it delivers nothing). Never throws.</summary>
    private void CompileCheckReview(JsonArray ops, List<ApplyFailure> failures)
    {
        if (!_footprintBegun) return;
        if (!ops.OfType<JsonObject>().Any(o => o["op"]?.ToString() is not ("get" or "find" or "dump" or "usages" or "layout"))) return;
        using var timing = NativePerformanceCapture.Measure("apply.compileCheck");
        List<CompileCheck.Finding> findings;
        try
        {
            var (created, changed) = JobObjects();
            var mine = new HashSet<IObjectSignature>(created.Concat(changed), ReferenceEqualityComparer.Instance);
            findings = CompileCheck.Run((IObjectSignature)_es, mine);
            findings.AddRange(SoapFindings(created, changed, ops));
            var said = new HashSet<(string, IObjectSignature)>(findings.Select(f => (f.Code, f.Element)));
            findings.AddRange(CompileCheck.Preexisting((IObjectSignature)_es, mine).Where(f => !said.Contains((f.Code, f.Element))));
        }
        catch { return; }
        foreach (var finding in findings.Where(f => f.Warning))
            Report("highWarnings", new JsonObject
            {
                ["code"] = finding.Code, ["severity"] = "high", ["op"] = OriginOp(finding.Element, ops), ["message"] = finding.Message, ["fix"] = finding.Fix,
                ["owner"] = finding.Aggregate is { } a ? NodeName(a) : null, ["element"] = finding.Path, ["check"] = "compile",
            });
        var firstWrite = Math.Max(0, ops.Select((x, n) => (x, n)).FirstOrDefault(p => p.x?["op"]?.ToString() is not ("get" or "find" or "dump" or "usages" or "layout")).n);
        foreach (var finding in findings.Where(f => !f.Warning && f.Preexisting)) failures.Add(PreexistingFailure(finding, ops, firstWrite));
        foreach (var finding in findings.Where(f => !f.Warning && !f.Preexisting))
        {
            // A raw `set` of the value at fault is the op to fix (its /value), else the op that created the element.
            var written = finding.Property != null ? SetOpOf(finding.Element, finding.Property, ops)
                : finding.Code is AggregateSortRule.Code or AggregateSortRule.ColumnCode ? SetOpOf(finding.Element, "Attribute", ops)
                : finding.Code == AggregateSortRule.JoinCode ? SetOpOf(finding.Element, "JoinType", ops) : null;
            var origin = written ?? OriginOp(finding.Element, ops);
            var op = origin ?? firstWrite;
            var source = op < ops.Count ? ops[op] as JsonObject : null;
            var kind = source?["op"]?.ToString() ?? "op";
            var node = finding.Aggregate is { } aggregate ? (aggregate is IFlowNode ? aggregate : aggregate.Parent as IObjectSignature is { } p && p is IFlowNode ? p : aggregate) : finding.Element;
            var pointer = written != null ? "/value" : FlowOwner(finding.Element) is { } owner ? StepPointer(source, NodeName(owner), NodeName(node)) : null;
            // The pointer relative to the op's data (the apply's refusal rebases it onto the job), else the op itself.
            // The certain value of a raw set: the patch writes it at that set's /value (the op itself; the refusal rebases it).
            var patch = written != null && finding.Replacement != null ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = "/value", ["value"] = finding.Replacement }) : null;
            var problem = JobPreflight.Problem(op, pointer, finding.Code, "error", finding.Message, finding.Fix, patch);
            problem["element"] = finding.Path;
            problem["check"] = "compile";
            if (finding.Suggestion != null) problem["suggestion"] = finding.Suggestion.DeepClone();
            failures.Add(new ApplyFailure(op, kind, source ?? new JsonObject(),
                new KernelRefusalException(finding.Code, $"op #{op} ({kind} {NodeName(finding.Element)}): [{finding.Code}] {finding.Message}. Fix: {finding.Fix}", new JsonArray(problem))));
        }
    }

    /// <summary>A part the base already had that the compiler cannot build: refused like the job's own (a delivery on top of it
    /// does not compile), marked preexisting, with the raw ops that fix it appended to the job as its patch when certain.</summary>
    private ApplyFailure PreexistingFailure(CompileCheck.Finding finding, JsonArray ops, int op)
    {
        var message = "the module already has it (no op of this job wrote it), and no delivery on top of it compiles: " + finding.Message;
        var fix = finding.Fix + (finding.Ops is { Count: > 0 } ready ? "; append these ops to the job: " + ready.ToJsonString() : "");
        var problem = JobPreflight.Problem(op, null, finding.Code, "error", message, fix);
        problem["phase"] = "apply";
        problem["preexisting"] = true;
        problem["element"] = finding.Path;
        problem["key"] = finding.Element.ObjectKey?.ToString();
        problem["check"] = "compile";
        if (finding.Ops is { Count: > 0 } append)
        {
            problem["ops"] = append.DeepClone();
            if (OpsPointer != null)
                problem["patch"] = new JsonArray(append.Select(o => (JsonNode)new JsonObject { ["op"] = "add", ["path"] = OpsPointer + "/-", ["value"] = o!.DeepClone() }).ToArray());
        }
        var kind = op < ops.Count ? ops[op]?["op"]?.ToString() ?? "op" : "op";
        return new ApplyFailure(op, kind, op < ops.Count && ops[op] is JsonObject source ? source : new JsonObject(),
            new KernelRefusalException(finding.Code, $"[{finding.Code}] (preexisting) {message}. Fix: {fix}", new JsonArray(problem.DeepClone())), [problem]);
    }

    /// <summary>Class D: the consumed SOAP elements this job's verbs created (the topmost of each subtree; a lab escape on its
    /// create op makes it a HIGH warning), and every WSDL or MetaData a raw set wrote on a client.</summary>
    private IEnumerable<CompileCheck.Finding> SoapFindings(HashSet<IObjectSignature> created, HashSet<IObjectSignature> changed, JsonArray ops)
    {
        foreach (var element in created)
        {
            if (element.WasDeleted || !CompileCheck.SoapConsumer(element) || element.Parent is IObjectSignature parent && created.Contains(parent) && CompileCheck.SoapConsumer(parent)) continue;
            var finding = CompileCheck.SoapCreated(element, Lane);
            var origin = OriginOp(element, ops);
            var why = CompileCheck.SoapEscape(origin is { } at && at < ops.Count ? ops[at] as JsonObject : null, out var invalid);
            if (why != null)
                yield return finding with { Code = CompileCheck.SoapAllowed, Warning = true, Message = finding.Message + $"; accepted for a lab by {CompileCheck.SoapAllowKey} on op #{origin}: {why} (never delivered)" };
            else
                yield return invalid == null ? finding : finding with { Message = finding.Message + "; " + invalid };
        }
        foreach (var client in created.Concat(changed))
        {
            if (client.WasDeleted || !Implements(client, "ISOAPClient") || created.Contains(client)) continue;
            foreach (var property in new[] { "WSDL", "MetaData" })
                if (SetOpOf(client, property, ops) != null) yield return CompileCheck.SoapWritten(client, property, Lane);
        }
    }

    /// <summary>The last raw `set` of <paramref name="prop"/> on the element (by its alias or @key), or null.</summary>
    private int? SetOpOf(IObjectSignature element, string prop, JsonArray ops)
    {
        var key = element.ObjectKey?.ToString();
        for (var i = ops.Count - 1; i >= 0; i--)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "set" || op["prop"]?.ToString() != prop || op["target"]?.ToString() is not { Length: > 0 } target) continue;
            if (key != null && target == "@" + key) return i;
            if ((_handles.TryGetValue(target, out var handle) || AliasCounterpart(target) is { } other && _handles.TryGetValue(other, out handle)) && ReferenceEquals(handle, element)) return i;
            // Any other reference form (Type:Name, a path): resolved again on the candidate.
            try { if (!target.StartsWith('$') && ReferenceEquals(Resolve(target), element)) return i; } catch { /* it no longer resolves: not this element */ }
        }
        return null;
    }
}
