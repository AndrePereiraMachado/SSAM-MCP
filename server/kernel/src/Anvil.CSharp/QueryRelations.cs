using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private sealed partial class SqlQuery
    {
        public SqlRelation From(DataType entity)
        {
            if (entity.Kind is not (DataKind.Entity or DataKind.Catalog)) throw SourceProgram.Error("AVCS310", "Query requires an entity or fixed catalog", entity.Symbol);
            var columns = new List<ValueType>(); var expressions = new List<string>(); var members = new List<(IPropertySymbol, SqlShape)>();
            foreach (var property in DataModel.Properties(entity.Symbol))
            {
                var type = Type(property.Type); var field = "{" + entity.Name + "}.[" + compiler.Model.Data.StorageName(entity, property) + "]";
                if (type.Declaration is { Kind: DataKind.Enum } enumeration && !type.IsIdentity)
                    field = "(SELECT AvEnum.[AvValue] FROM {" + enumeration.Name + "} AvEnum WHERE AvEnum.[Id] = " + field + ")";
                if (type.Nullable) field = "CASE WHEN {" + entity.Name + "}.[" + DataModel.Presence(entity, property) + "] = 1 THEN " + field + " ELSE NULL END";
                var index = columns.Count; columns.Add(type); expressions.Add(field + " AS AvC" + index);
                members.Add((property, Leaf(new(SqlExpression.At(index), type))));
            }
            var key = columns.Count; columns.Add(Primitive(SpecialType.System_Int64)); expressions.Add("{" + entity.Name + "}.[Id] AS AvC" + key);
            var occurrence = new[] { SqlExpression.At(key) };
            var origin = entity.Symbol.IsReferenceType ? new SqlObjectOrigin(new object(), occurrence) : null;
            return new("SELECT " + string.Join(", ", expressions) + " FROM {" + entity.Name + "}", columns,
                new(entity.Symbol, Members: members, Origin: origin), [new(SqlExpression.At(key))]) { Occurrence = occurrence };
        }
        public void Filter(SqlRelation relation, SqlExpression predicate)
        {
            relation.Query = "SELECT " + relation.SelectColumns() + " FROM (" + relation.Query + ") AvSource WHERE " + predicate.Render();
        }
        public void Sort(SqlRelation relation, SqlValue term, bool replace, bool descending, bool ordinal)
        {
            if (replace) { relation.Stable = relation.Order.ToList(); relation.Ordering = []; }
            if (term.Type.Nullable) relation.Ordering.Add(new(F("CASE WHEN {0} THEN 1 ELSE 0 END", term.Has), descending));
            relation.Ordering.Add(new(ordinal ? F("({0} COLLATE Latin1_General_100_BIN2)", term.Scalar) : term.Scalar, descending));
            if (ordinal) relation.Ordering.Add(new(F("DATALENGTH({0})", term.Scalar), descending));
        }
        public void Page(SqlRelation relation, string skip, string? take)
        {
            var sorted = "SELECT " + relation.SelectColumns() + ", ROW_NUMBER() OVER (ORDER BY " + string.Join(", ", relation.Order.Select(o => o.Render())) + ") AvOrdinal FROM (" + relation.Query + ") AvSource";
            relation.Query = "SELECT " + relation.SelectColumns("AvPage") + " FROM (" + sorted + ") AvPage WHERE AvPage.AvOrdinal > " + skip
                + (take == null ? "" : " AND AvPage.AvOrdinal <= (CAST(" + skip + " AS BIGINT) + CAST(" + take + " AS BIGINT))");
        }
        public SqlRelation Project(SqlRelation input, SqlShape shape)
        {
            var columns = new List<ValueType>(input.Columns);
            var expressions = input.Columns.Select((_, i) => "AvSource.AvC" + i).ToList();
            SqlValue Materialize(SqlValue value)
            {
                if (value.Scalar.Column >= 0) return value;
                var index = columns.Count; columns.Add(value.Type); expressions.Add(value.Scalar.Render() + " AS AvC" + index);
                return value with { Expression = SqlExpression.At(index), Predicate = false };
            }
            var row = shape.Map(Materialize);
            var query = "SELECT " + string.Join(", ", expressions) + " FROM (" + input.Query + ") AvSource";
            return new(query, columns, row, input.Stable) { Ordering = input.Ordering, Occurrence = input.Occurrence };
        }
        public SqlRelation Join(SqlRelation left, SqlRelation right, IAnonymousFunctionOperation leftKey, IAnonymousFunctionOperation rightKey,
            IAnonymousFunctionOperation selector, IOperation location)
        {
            if (left.Grouping != null || right.Grouping != null) throw compiler.Unsupported(location, "Project grouped keys and aggregates before joining groups");
            var offset = left.Columns.Count; var rightRow = right.Row.Offset(offset);
            var a = Lambda(leftKey, left.Row); var b = Lambda(rightKey, rightRow); var condition = KeyEqual(a, b, location);
            // Enumerable Join omits a null scalar key. Null fields within a composite key still compare equal.
            if (a.Value != null && b.Value != null) condition = F("({0}) AND ({1}) AND ({2})", a.Value.Has, b.Value.Has, condition);
            var columns = new List<ValueType>(left.Columns.Concat(right.Columns));
            var source = "SELECT " + left.SelectColumns("AvLeft") + ", " + string.Join(", ", right.Columns.Select((_, i) => "AvRight.AvC" + i + " AS AvC" + (i + offset)))
                + " FROM (" + left.Query + ") AvLeft INNER JOIN (" + right.Query + ") AvRight ON "
                + RenderJoin(condition, offset);
            var occurrence = left.Occurrence.Concat(right.Occurrence.Select(key => key.Offset(offset))).ToArray();
            var row = ProjectionLambda(selector, occurrence, left.Row, rightRow);
            var joined = new SqlRelation(source, columns, row, left.Order.Concat(right.Order.Select(o => o.Offset(offset))).ToList())
                { Occurrence = occurrence };
            return Project(joined, row);
        }
        private static string RenderJoin(SqlExpression expression, int offset)
        {
            if (expression.Column >= 0) return expression.Column < offset ? "AvLeft.AvC" + expression.Column : "AvRight.AvC" + (expression.Column - offset);
            return expression.Arguments.Length == 0 ? expression.Template
                : string.Format(System.Globalization.CultureInfo.InvariantCulture, expression.Template, expression.Arguments.Select(a => (object)RenderJoin(a, offset)).ToArray());
        }
        public void Group(SqlRelation relation, SqlShape key, ITypeSymbol queryType)
        {
            if (relation.Grouping != null) throw SourceProgram.Error("AVCS310", "Project grouped keys before another grouping", queryType);
            var projected = new List<string> { relation.SelectColumns() };
            // Every key is a source column, including captures and typed nulls. SQL Server
            // rejects a parameter-only GROUP BY; a global aggregate also creates a spurious
            // group for an empty input. Materialization preserves ordinary grouping semantics.
            key = key.Map(v =>
            {
                var scalar = v.Type.Native == "Text" ? F("({0} COLLATE Latin1_General_100_BIN2)", v.Scalar) : v.Scalar;
                if (scalar.Column >= 0) return v;
                var column = relation.Columns.Count;
                relation.Columns.Add(v.Type);
                projected.Add(scalar.Render() + " AS AvC" + column);
                return v with { Expression = SqlExpression.At(column), Predicate = false };
            });
            var ordinal = relation.Columns.Count;
            relation.Query = "SELECT " + string.Join(", ", projected) + ", ROW_NUMBER() OVER (ORDER BY " + string.Join(", ", relation.Order.Select(o => o.Render()))
                + ") AS AvC" + ordinal + " FROM (" + relation.Query + ") AvSource";
            relation.Columns.Add(Primitive(SpecialType.System_Int64));
            var group = new SqlGroup(key, relation.Row, SqlExpression.At(ordinal));
            relation.Grouping = group;
            relation.Ordering = []; relation.Stable = [];
        }
    }
}
