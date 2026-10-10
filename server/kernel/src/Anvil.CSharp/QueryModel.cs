using Microsoft.CodeAnalysis;
using System.Globalization;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    // SQL column identities are rebound recursively; parameter values and literals never are.
    private sealed record SqlExpression(string Template, SqlExpression[] Arguments, int Column = -1)
    {
        public static SqlExpression Raw(string text) => new(text, []);
        public static SqlExpression At(int column) => new("", [], column);
        public static SqlExpression Of(string template, params SqlExpression[] arguments) => new(template, arguments);
        public string Render(string alias = "AvSource") => Column >= 0 ? alias + ".AvC" + Column
            : Arguments.Length == 0 ? Template : string.Format(CultureInfo.InvariantCulture, Template, Arguments.Select(a => (object)a.Render(alias)).ToArray());
        public SqlExpression Offset(int count) => Column >= 0 ? At(Column + count)
            : this with { Arguments = Arguments.Select(a => a.Offset(count)).ToArray() };
    }
    private sealed record SqlValue(SqlExpression Expression, ValueType Type, bool Predicate = false, bool IsNull = false)
    {
        public SqlExpression Scalar => Predicate ? SqlExpression.Of("CASE WHEN {0} THEN 1 ELSE 0 END", Expression) : Expression;
        public SqlExpression Condition => Predicate ? Expression : SqlExpression.Of("({0} = 1)", Expression);
        public SqlExpression Has => Type.Nullable ? SqlExpression.Of("({0} IS NOT NULL)", Scalar) : SqlExpression.Raw("1 = 1");
    }
    // Token identifies one source or construction occurrence within one query plan.
    // Keys distinguish its sequence elements without joining independent query roots.
    private sealed record SqlObjectOrigin(object Token, IReadOnlyList<SqlExpression> Keys);
    private sealed record SqlShape(ITypeSymbol Source, SqlValue? Value = null,
        IReadOnlyList<(IPropertySymbol Property, SqlShape Shape)>? Members = null, SqlObjectOrigin? Origin = null)
    {
        public IEnumerable<SqlValue> Leaves => Value != null ? [Value] : (Members ?? []).SelectMany(m => m.Shape.Leaves);
        public SqlShape Map(Func<SqlValue, SqlValue> map, Func<SqlExpression, SqlExpression>? mapOriginKey = null)
        {
            var mapped = new Dictionary<SqlShape, SqlShape>(ReferenceEqualityComparer.Instance);
            SqlShape Visit(SqlShape shape)
            {
                if (mapped.TryGetValue(shape, out var prior)) return prior;
                var result = shape.Value != null ? shape with { Value = map(shape.Value) }
                    : shape with { Members = shape.Members?.Select(m => (m.Property, Visit(m.Shape))).ToArray() };
                if (shape.Origin is { } origin && mapOriginKey != null)
                    result = result with { Origin = origin with { Keys = origin.Keys.Select(mapOriginKey).ToArray() } };
                mapped.Add(shape, result); return result;
            }
            return Visit(this);
        }
        public SqlShape Offset(int count) => Map(v => v with { Expression = v.Expression.Offset(count) }, key => key.Offset(count));
    }
    private sealed record SqlOrder(SqlExpression Expression, bool Descending = false)
    {
        public string Render(string alias = "AvSource") => Expression.Render(alias) + (Descending ? " DESC" : " ASC");
        public SqlOrder Offset(int count) => this with { Expression = Expression.Offset(count) };
    }
    private sealed class SqlRelation(string query, List<ValueType> columns, SqlShape row, List<SqlOrder> stable)
    {
        public string Query { get; set; } = query;
        public List<ValueType> Columns { get; } = columns;
        public SqlShape Row { get; set; } = row;
        public List<SqlOrder> Ordering { get; set; } = [];
        public List<SqlOrder> Stable { get; set; } = stable;
        // Unlike ordering, this tuple continues to identify an element after sorting
        // or projecting only a subset of the visible source fields.
        public IReadOnlyList<SqlExpression> Occurrence { get; init; } = [];
        public SqlGroup? Grouping { get; set; }
        public List<Microsoft.CodeAnalysis.Operations.IInvocationOperation> NativeOperators { get; } = [];
        public IEnumerable<SqlOrder> Order => Ordering.Concat(Stable).DistinctBy(o => o.Render());
        public string SelectColumns(string alias = "AvSource") => string.Join(", ", Columns.Select((_, i) => alias + ".AvC" + i));
    }
    private sealed record SqlGroup(SqlShape Key, SqlShape Element, SqlExpression Ordinal);
}
