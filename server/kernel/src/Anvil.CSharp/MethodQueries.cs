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
        var list = EmptyList(Type(op.Type!), steps); var body = new JsonArray();
        var item = Coerce(ReadQueryRow(relation.Row, query + ".List.Current.List", body, op, identities), list.Type.Element!, false, body, op);
        if (list.Type.IsArenaReference) AppendReferenceList(list, item, body);
        else body.Add(new JsonObject { ["call"] = "ListAppend", ["as"] = "AvAppend" + (++calls), ["args"] = new JsonObject { ["List"] = list.Text, ["Element"] = item.Text } });
        steps.Add(new JsonObject { ["foreach"] = query + ".List", ["do"] = body }); return list;
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

