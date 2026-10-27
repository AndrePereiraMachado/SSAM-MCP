using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private static bool QueryTerminal(IInvocationOperation op) => op.TargetMethod.ContainingType.ToDisplayString() is "System.Linq.Queryable" or "System.Linq.Enumerable"
        && op.TargetMethod.Name is "First" or "FirstOrDefault" or "Single" or "SingleOrDefault" or "ToList" or "ToArray" or "Count" or "Any";
    private IAnonymousFunctionOperation Lambda(IOperation op)
    {
        while (op is IConversionOperation conversion) op = conversion.Operand;
        if (op is IDelegateCreationOperation creation) op = creation.Target;
        return op as IAnonymousFunctionOperation ?? throw Unsupported(op, "A query requires a bound lambda expression");
    }
    private SqlRelation QuerySource(IOperation op, SqlQuery sql)
    {
        while (op is IConversionOperation conversion) op = conversion.Operand;
        if (op is not IInvocationOperation call) throw Unsupported(op, "Query composition is not bound to a request data source");
        if (LogicModel.DataDependency(call.TargetMethod.ContainingType) && call.TargetMethod.Name == "Query")
        {
            if (call.Instance is not IParameterReferenceOperation dependency || !LogicModel.DataDependency(dependency.Parameter.Type))
                throw Unsupported(op, "Query must use the injected data session");
            return sql.From(model.Data.Declaration((INamedTypeSymbol)call.TargetMethod.TypeArguments.Single()));
        }
        if (call.TargetMethod.ContainingType.ToDisplayString() != "System.Linq.Queryable") throw Unsupported(op, "Query provider is not recognized");
        var relation = QuerySource(call.Arguments[0].Value, sql);
        if (relation.Grouping != null)
        {
            if (call.TargetMethod.Name is not ("Where" or "Select" or "OrderBy" or "OrderByDescending" or "ThenBy" or "ThenByDescending" or "Skip" or "Take"))
                throw Unsupported(call, "This operator after grouping needs native sequence lowering");
            relation.NativeOperators.Add(call);
            return relation;
        }
        switch (call.TargetMethod.Name)
        {
            case "Where": sql.Filter(relation, sql.Scalar(sql.Lambda(Lambda(call.Arguments[1].Value), relation.Row), call).Condition); break;
            case "Select": relation = sql.Project(relation, sql.ProjectionLambda(Lambda(call.Arguments[1].Value), relation.Occurrence, relation.Row)); break;
            case "OrderBy": case "OrderByDescending": case "ThenBy": case "ThenByDescending":
                var ordinal = false;
                if (call.Arguments.Length > 2)
                {
                    IOperation comparer = call.Arguments[2].Value;
                    while (comparer is IConversionOperation converted) comparer = converted.Operand;
                    ordinal = comparer is IPropertyReferenceOperation { Property.Name: "Ordinal" } property
                        && property.Property.ContainingType.ToDisplayString() == "System.StringComparer";
                    if (!ordinal) throw Unsupported(comparer, "This query comparer has no semantic SQL translation");
                }
                sql.Sort(relation, sql.Scalar(sql.Lambda(Lambda(call.Arguments[1].Value), relation.Row), call),
                    call.TargetMethod.Name.StartsWith("OrderBy", StringComparison.Ordinal), call.TargetMethod.Name.EndsWith("Descending", StringComparison.Ordinal), ordinal); break;
            case "Skip": case "Take":
                if (relation.Grouping != null) throw Unsupported(call, "Project grouped keys and aggregates before paging groups");
                var count = sql.Count(call.Arguments[1].Value);
                sql.Page(relation, call.TargetMethod.Name == "Skip" ? count : "0", call.TargetMethod.Name == "Take" ? count : null); break;
            case "Join":
                if (call.Arguments.Length != 5) throw Unsupported(call, "This join comparer has no semantic SQL translation");
                var right = QuerySource(call.Arguments[1].Value, sql);
                relation = sql.Join(relation, right, Lambda(call.Arguments[2].Value), Lambda(call.Arguments[3].Value), Lambda(call.Arguments[4].Value), call); break;
            case "GroupBy":
                if (call.Arguments.Length != 2) throw Unsupported(call, "This GroupBy overload needs an element/result selector translation");
                sql.Group(relation, sql.Lambda(Lambda(call.Arguments[1].Value), relation.Row), call.Type!); break;
            default: throw Unsupported(op, "Query operator is not connected yet: " + call.TargetMethod.Name);
        }
        return relation;
    }
    private SourceValue Query(IInvocationOperation op, JsonArray steps)
    {
        var sql = new SqlQuery(this, steps); var relation = QuerySource(op.Arguments[0].Value, sql); var terminal = op.TargetMethod.Name;
        if (relation.Grouping != null) return NativeGroupedQuery(op,relation,sql,steps);
        if (op.Arguments.Length > 1) sql.Filter(relation, sql.Scalar(sql.Lambda(Lambda(op.Arguments[1].Value), relation.Row), op).Condition);
        if (relation.Grouping != null) throw Unsupported(op, "Materializing group objects needs nested collection translation; project their keys and aggregates");
        if (terminal is "First" or "FirstOrDefault" or "Any") sql.Page(relation, "0", "1");
        if (terminal is "Single" or "SingleOrDefault") sql.Page(relation, "0", "2");
        var query = "AvQuery" + (++calls);
        var leaves = relation.Row.Leaves.ToArray(); var columns = new List<(string Name, string Type)>(); var expressions = new List<string>();
        foreach (var (leaf, index) in leaves.Select((leaf, index) => (leaf, index)))
        {
            columns.Add(("AvC" + index, leaf.Type.Native)); expressions.Add(leaf.Scalar.Render() + " AS AvC" + index);
            if (leaf.Type.Nullable)
            {
                columns.Add(("AvHas" + index, "Boolean")); expressions.Add("CASE WHEN " + leaf.Has.Render() + " THEN 1 ELSE 0 END AS AvHas" + index);
            }
        }
        var identities = Managed && terminal is not ("Count" or "Any") && relation.Occurrence.Count > 1
            ? PrepareQueryIdentities(relation.Row, columns, expressions, steps, op) : new Dictionary<object, QueryIdentityCache>(ReferenceEqualityComparer.Instance);
        var output = terminal == "Count" ? model.Data.ScalarSqlRow("Long Integer") : model.Data.ProjectionSqlRow(columns);
        var statement = terminal == "Count" ? "SELECT COUNT(*) FROM (" + relation.Query + ") AvSource"
            : "SELECT " + string.Join(", ", expressions) + " FROM (" + relation.Query + ") AvSource ORDER BY " + string.Join(", ", relation.Order.Select(o => o.Render()));
        steps.Add(new JsonObject { ["get"] = output, ["as"] = query, ["sql"] = true, ["statement"] = statement, ["params"] = sql.Parameters });
        if (terminal == "Any") return new("not " + query + ".List.Empty", Type(op.Type!));
        if (terminal == "Count") return Coerce(new(query + ".List.Current.List.Value", Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Int64))), Type(op.Type!), true, steps, op);
        if (terminal is "Single" or "SingleOrDefault") Guard(steps, query + ".List.Length > 1", "InvalidOperationException", "Sequence contains more than one element.");
        if (terminal is "First" or "Single")
        {
            Guard(steps, query + ".List.Empty", "InvalidOperationException", "Sequence contains no elements.");
            return ReadQueryRow(relation.Row, query + ".List.Current.List", steps, op, identities);
        }
        if (terminal is "FirstOrDefault" or "SingleOrDefault")
        {
            var resultType = Type(op.Type!); if (op.Type!.IsReferenceType && !resultType.IsArenaReference) resultType = resultType with { Nullable = true };
            var result = Temp(resultType); var present = new JsonArray();
            Store(present, result, ReadQueryRow(relation.Row, query + ".List.Current.List", present, op, identities), op);
            if (resultType.Nullable) Assign(steps, result.Text + ".HasValue", "False");
            else Assign(steps, result.Text, StorageDefault(resultType));
            steps.Add(new JsonObject { ["if"] = "not " + query + ".List.Empty", ["then"] = present }); return result;
        }
        var list = EmptyList(Type(op.Type!), steps); var body = new JsonArray(); var declared = variables.Count;
        var item = Coerce(ReadQueryRow(relation.Row, query + ".List.Current.List", body, op, identities), list.Type.Element!, false, body, op);
        // The team rule T1/T2 (FLOW_FOREACH_LIST_ACTION): a loop that only maps the rows of the query into the list is a List
        // action, never a new For Each. When the body only reads columns of the row into the item, the rows are appended with
        // one mapping and the locals the body built them in go with it.
        if (!list.Type.IsArenaReference && MappedRows(query + ".List", item, body) is { } mapping)
        {
            while (variables.Count > declared) variables.RemoveAt(declared);
            steps.Add(new JsonObject { ["call"] = "ListAppendAll", ["as"] = "AvAppend" + (++calls), ["args"] = new JsonObject { ["List"] = list.Text, ["SourceList"] = mapping } });
            return list;
        }
        if (list.Type.IsArenaReference) AppendReferenceList(list, item, body);
        else body.Add(new JsonObject { ["call"] = "ListAppend", ["as"] = "AvAppend" + (++calls), ["args"] = new JsonObject { ["List"] = list.Text, ["Element"] = item.Text } });
        steps.Add(new JsonObject { ["foreach"] = query + ".List", ["do"] = body }); return list;
    }
    private static readonly System.Text.RegularExpressions.Regex RowPath = new(@"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    private static readonly System.Text.RegularExpressions.Regex RowColumn = new(@"^(?<row>.*)\.Av(?<kind>C|Has)(?<n>[0-9]+)$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    private static readonly System.Text.RegularExpressions.Regex TempName = new(@"^AvTemp[0-9]+$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>The mapping of the rows of a query into the list a materialization appends them to (ListAppendAll's SourceList,
    /// "Source mapTo { Field: value, ... }"), when the loop body only copies columns of the current row: the value appended as
    /// it is (a list of values: { Value: column }), or a record (or the presence wrapper of a value) whose attributes each take
    /// one column, in the order of the record's attributes. A member the body builds in a local of its own (a nullable
    /// member's presence wrapper, a record inside the record) and then assigns whole maps through it (Member.HasValue,
    /// Member.Value; Inner.Code). A Value the body sets only under its presence maps its column whole: the query returns that
    /// column NULL when the presence is false, read as the type's default, where the loop kept the previous row's value, which
    /// nothing reads (the presence says there is none). Anything else in the body (a computed value, a check that raises, a
    /// call, a reference) is no mapping: null, and the materialization keeps its For Each.</summary>
    private string? MappedRows(string source, SourceValue item, JsonArray body)
    {
        var current = source + ".Current.";
        // A column of the current row, relative to the item as a mapping reads it. Only columns: a value the body computes
        // (a conversion, a literal) is no copy the proofs have seen in a mapping, and keeps the For Each.
        string? Read(string? expression) => expression != null && expression.StartsWith(current, StringComparison.Ordinal)
            && RowPath.IsMatch(expression[current.Length..]) ? expression[current.Length..] : null;
        var type = item.Type;
        if (Attributes(type) == null) return body.Count == 0 && Plain(type) && Read(item.Text) is { } value ? source + " mapTo { Value: " + value + " }" : null;
        if (body.Count == 0) return null;
        // What the body builds: the item, and the locals it fills from the row before assigning them whole to a member.
        var root = new Dictionary<string, object>(StringComparer.Ordinal);
        var pending = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
        Dictionary<string, object>? Builder(string name, bool create)
        {
            if (name == item.Text) return root;
            if (!TempName.IsMatch(name)) return null;
            if (pending.TryGetValue(name, out var existing)) return existing;
            return create ? pending[name] = new(StringComparer.Ordinal) : null;
        }
        foreach (var step in body)
        {
            if (step is JsonObject { Count: 1 } one && one["assign"] is JsonObject assign)
            {
                foreach (var (target, value) in assign)
                {
                    var dot = target.LastIndexOf('.');
                    if (dot <= 0 || Builder(target[..dot], create: true) is not { } builder) return null;
                    var field = target[(dot + 1)..]; var text = value?.ToString();
                    if (builder.ContainsKey(field)) return null;
                    if (text != null && pending.TryGetValue(text, out var member) && !ReferenceEquals(member, builder)) { pending.Remove(text); builder[field] = member; }
                    else if (Read(text) is { } column) builder[field] = column;
                    else return null;
                }
                continue;
            }
            // A presence wrapper's Value, set only when the row has it (HasValue, assigned before from the paired column).
            if (step is JsonObject { Count: 2 } test && Read(test["if"]?.ToString()) is { } presence
                && test["then"] is JsonArray { Count: 1 } then && then[0] is JsonObject { Count: 1 } inner
                && inner["assign"] is JsonObject { Count: 1 } payload && payload.Single() is var (key, read)
                && key.EndsWith(".Value", StringComparison.Ordinal) && Builder(key[..^".Value".Length], create: false) is { } wrapper
                && wrapper.TryGetValue("HasValue", out var has) && has as string == presence && !wrapper.ContainsKey("Value")
                && Read(read?.ToString()) is { } valueColumn && Paired(presence, valueColumn))
            {
                wrapper["Value"] = valueColumn;
                continue;
            }
            return null;
        }
        var fields = new List<string>();
        if (pending.Count > 0 || root.Count == 0 || !Emit(root, type, "", fields)) return null;
        return source + " mapTo { " + string.Join(", ", fields) + " }";

        // The attributes in the order of the record (recursively for a member built in a local of its own).
        bool Emit(Dictionary<string, object> built, ValueType of, string prefix, List<string> output)
        {
            if (Attributes(of) is not { } attributes || built.Keys.Any(k => !attributes.Any(a => a.Name == k))) return false;
            if (of.Nullable && !built.ContainsKey("HasValue")) return false;
            foreach (var (name, memberType) in attributes)
            {
                if (!built.TryGetValue(name, out var value)) continue;
                if (value is string column) output.Add(prefix + name + ": " + column);
                else if (memberType == null || !Emit((Dictionary<string, object>)value, memberType, prefix + name + ".", output)) return false;
            }
            return true;
        }
        // The presence column of a value and the value's column, as ReadQueryRow reads them (row.AvHasN, row.AvCN).
        static bool Paired(string presence, string value) =>
            RowColumn.Match(presence) is { Success: true } p && RowColumn.Match(value) is { Success: true } v
            && p.Groups["kind"].Value == "Has" && v.Groups["kind"].Value == "C" && p.Groups["n"].Value == v.Groups["n"].Value && p.Groups["row"].Value == v.Groups["row"].Value;
        static bool Plain(ValueType of) => !(of.IsList || of.IsArenaReference || of.IsExceptionReference || of.IsReadOnlyListReference);
    }

    /// <summary>The attributes of a record a mapping writes, in the order the data model declares them, each with its type:
    /// a presence wrapper (HasValue, Value), a structure (its data members), an entity's transport record (its properties).
    /// Null for anything else (a value, an identity, a list, a reference).</summary>
    private IReadOnlyList<(string Name, ValueType? Type)>? Attributes(ValueType of)
    {
        if (of.IsList || of.IsArenaReference || of.IsExceptionReference || of.IsReadOnlyListReference) return null;
        if (of.Nullable) return [("HasValue", null), ("Value", of with { Nullable = false })];
        if (of.IsIdentity) return null;
        return of.Declaration switch
        {
            { Kind: DataKind.Structure } structure => SourceMember.Data(structure.Symbol).Select(m => (structure.Properties[m.Symbol], (ValueType?)Type(m.Type))).ToList(),
            { Kind: DataKind.Entity } entity => DataModel.Properties(entity.Symbol).Select(p => (entity.Properties[p], (ValueType?)Type(p.Type))).ToList(),
            _ => null,
        };
    }
    private SourceValue ReadQueryRow(SqlShape shape, string row, JsonArray steps, IOperation location,
        IReadOnlyDictionary<object, QueryIdentityCache>? identities = null)
    {
        var index = 0;
        var materialized = new Dictionary<SqlShape, SourceValue>(ReferenceEqualityComparer.Instance);
        SourceValue Read(SqlShape current, JsonArray target)
        {
            if (current.Value is { } value)
            {
                var column = index++; return new(row + ".AvC" + column, value.Type, value.Type.Nullable ? row + ".AvHas" + column : null);
            }
            var type = Type(current.Source);
            if (identities is not { Count: > 0 } && type.IsArenaReference && materialized.TryGetValue(current, out var previous))
            {
                index += current.Leaves.Count();
                return previous;
            }
            SourceValue result;
            QueryIdentityCache? cache = null;
            var fill = target;
            if (type.IsArenaReference && current.Origin is { } origin && identities?.TryGetValue(origin.Token, out cache) == true)
            {
                result = ReadQueryIdentity(cache, row, target);
                fill = new JsonArray();
                Store(fill, result, AllocateReference(type, fill), location);
            }
            else result = type.IsArenaReference ? AllocateReference(type, target) : Temp(type with { Nullable = false });
            if (type.IsArenaReference && identities is not { Count: > 0 }) materialized.Add(current, result);
            var declaration = type.Declaration ?? throw Unsupported(location, "Query output record is not declared in the source bundle");
            foreach (var (property, member) in current.Members ?? [])
                Store(fill, RecordMemberTarget(result, property), Read(member, fill), location);
            if (cache != null)
            {
                Assign(fill, cache.Map.Text + "[" + row + "." + cache.Column + " - 1]", result.Text);
                target.Add(new JsonObject { ["if"] = result.Text + ".Index = 0", ["then"] = fill });
            }
            return result;
        }
        return Read(shape, steps);
    }
}

