using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private sealed partial class SqlQuery
    {
        private readonly MethodCompiler compiler;
        private readonly JsonArray effects;
        private readonly Dictionary<IParameterSymbol, SqlShape> bindings = new(SymbolEqualityComparer.Default);
        private IReadOnlyList<SqlExpression>? projectionOccurrence;
        public JsonObject Parameters { get; } = [];
        public SqlQuery(MethodCompiler compiler, JsonArray effects) { this.compiler = compiler; this.effects = effects; }
        private static SqlExpression F(string template, params SqlExpression[] arguments) => SqlExpression.Of(template, arguments);
        // SQL values describe persisted columns, not invocation-local reference cells.
        private ValueType Type(ITypeSymbol type) => compiler.Model.Data.Type(type, type);
        private ValueType Primitive(SpecialType type) => Type(compiler.Model.Program.Compilation.GetSpecialType(type));
        private static SqlShape Leaf(SqlValue value) => new(value.Type.Source, value);
        public SqlValue Scalar(SqlShape shape, IOperation location) => shape.Value ?? throw compiler.Unsupported(location, "A scalar query value is required");
        public string Bind(SourceValue value)
        {
            if (value.Type.IsList || value.Type.Declaration is { Kind: not DataKind.Enum } && !value.Type.IsIdentity)
                throw new ArgumentException("SQL parameter requires a scalar value");
            var name = "AvP" + Parameters.Count; Parameters[name] = new JsonObject { ["type"] = value.Type.Native, ["value"] = value.Text }; return "@" + name;
        }
        public string Count(IOperation argument)
        {
            var value = compiler.Value(argument, effects);
            return Bind(new(argument.ConstantValue is { HasValue: true, Value: int constant }
                ? Math.Max(0, constant).ToString(System.Globalization.CultureInfo.InvariantCulture)
                : "If(" + value.Text + " < 0, 0, " + value.Text + ")", value.Type));
        }
        public SqlShape Lambda(IAnonymousFunctionOperation lambda, params SqlShape[] arguments)
        {
            if (lambda.Symbol.Parameters.Length != arguments.Length) throw compiler.Unsupported(lambda, "Query lambda arity does not match its row bindings");
            var returned = lambda.Body.Operations.OfType<IReturnOperation>().SingleOrDefault()?.ReturnedValue
                ?? throw compiler.Unsupported(lambda, "Query requires an expression lambda");
            var previous = lambda.Symbol.Parameters.Select(p => bindings.GetValueOrDefault(p)).ToArray();
            for (var i = 0; i < arguments.Length; i++) bindings[lambda.Symbol.Parameters[i]] = arguments[i];
            try { return Expression(returned); }
            finally
            {
                for (var i = 0; i < arguments.Length; i++)
                    if (previous[i] is { } old) bindings[lambda.Symbol.Parameters[i]] = old; else bindings.Remove(lambda.Symbol.Parameters[i]);
            }
        }
        public SqlShape ProjectionLambda(IAnonymousFunctionOperation lambda, IReadOnlyList<SqlExpression> occurrence, params SqlShape[] arguments)
        {
            var previous = projectionOccurrence;
            projectionOccurrence = occurrence;
            try { return Lambda(lambda, arguments); }
            finally { projectionOccurrence = previous; }
        }
        private SqlShape ConstructedShape(ITypeSymbol source, IReadOnlyList<(IPropertySymbol Property, SqlShape Shape)> members)
        {
            var origin = source.IsReferenceType && projectionOccurrence != null
                ? new SqlObjectOrigin(new object(), projectionOccurrence.ToArray()) : null;
            return new(source, Members: members, Origin: origin);
        }
        private SqlShape Construct(IObjectCreationOperation creation)
        {
            var type = Type(creation.Type!);
            var declaration = type.Declaration;
            if (declaration == null || type.IsIdentity || type.Nullable || type.IsList
                || declaration.Symbol.TypeKind != TypeKind.Class && !declaration.Symbol.IsRecord)
                throw compiler.Unsupported(creation, "Query construction requires a declared class or record");
            var constructor = creation.Constructor;
            if (constructor == null || !constructor.IsImplicitlyDeclared && !constructor.DeclaringSyntaxReferences
                    .Any(reference => reference.GetSyntax() is RecordDeclarationSyntax { ParameterList: not null }))
                throw compiler.Unsupported(creation, "Query construction requires an implicit constructor or a positional record constructor; executable constructors need per-row translation");
            if (constructor.Parameters.Length != 0 && !declaration.Symbol.IsRecord)
                throw compiler.Unsupported(creation, "Query class construction requires an implicit parameterless constructor");
            if (declaration.Symbol.StaticConstructors.Length != 0)
                throw compiler.Unsupported(creation, "Query construction cannot move type-initialization effects into SQL");

            var properties = DataModel.Properties(declaration.Symbol).ToArray();
            var represented = new HashSet<IPropertySymbol>(properties, SymbolEqualityComparer.Default);
            foreach (var member in SourceMember.Of(declaration.Symbol))
            {
                if (member.Symbol is not IPropertySymbol property || !represented.Contains(property))
                    throw compiler.Unsupported(creation, "Query construction supports represented public auto-properties; fields and unrepresented members need a projection codec");
                if (property.DeclaringSyntaxReferences.Any(reference => reference.GetSyntax() is PropertyDeclarationSyntax syntax
                        && (syntax.ExpressionBody != null || syntax.AccessorList?.Accessors.Any(accessor => accessor.Body != null || accessor.ExpressionBody != null) == true)))
                    throw compiler.Unsupported(creation, "Query construction cannot ignore executable property accessors");
                if (member.Initializer is { } initializer && !compiler.Model.Program.Model(initializer).GetConstantValue(initializer).HasValue)
                    throw compiler.Unsupported(creation, "Query construction supports only constant declaration initializers; executable initializers need per-row translation");
            }

            var values = new Dictionary<IPropertySymbol, SqlShape>(SymbolEqualityComparer.Default);
            foreach (var argument in creation.Arguments)
            {
                var property = properties.SingleOrDefault(property => property.Name == argument.Parameter?.Name)
                    ?? throw compiler.Unsupported(argument, "Query constructor parameters must correspond to represented record properties");
                values[property] = Expression(argument.Value);
            }
            foreach (var initializer in creation.Initializer?.Initializers ?? [])
            {
                if (initializer is not ISimpleAssignmentOperation { Target: IPropertyReferenceOperation property } assignment
                    || property.Property.IsIndexer || !represented.Contains(property.Property))
                    throw compiler.Unsupported(initializer, "Query object initializers require direct assignments to represented auto-properties");
                values[property.Property] = Expression(assignment.Value);
            }
            var missing = properties.Where(property => !values.ContainsKey(property)).Select(property => property.Name).ToArray();
            if (missing.Length != 0)
                throw compiler.Unsupported(creation, "Query construction must populate every represented property; omitted members need default-value translation: " + string.Join(", ", missing));
            return ConstructedShape(creation.Type!, properties.Select(property => (property, values[property])).ToArray());
        }
        private bool UsesRow(IOperation op) => op is IParameterReferenceOperation parameter && bindings.ContainsKey(parameter.Parameter) || op.ChildOperations.Any(UsesRow);
        private SqlShape Capture(IOperation op)
        {
            if (op is IConversionOperation { Type: INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T },
                Operand.ConstantValue: { HasValue: true, Value: not null } } lifted)
                return Leaf(new(SqlExpression.Raw(Bind(compiler.Value(lifted.Operand,effects))),Type(op.Type!)));
            if (Effects(op)) throw compiler.Unsupported(op, "Captured query effects cannot be moved outside per-row evaluation");
            var value = compiler.Value(op, effects);
            if(value.Type.Temporal != TemporalKind.None) throw compiler.Unsupported(op, "Temporal SQL parameter codecs are not implemented" );
            var payload = Payload(value); var expression = SqlExpression.Raw(Bind(payload));
            if (value.Type.Nullable)
            {
                var present = Bind(new(Present(value), Primitive(SpecialType.System_Boolean)));
                expression = F("CASE WHEN " + present + " = 1 THEN {0} ELSE NULL END", expression);
            }
            return Leaf(new(expression, value.Type));
        }
        private SqlValue Value(IOperation op) => Scalar(Expression(op), op);
        private SqlShape Expression(IOperation op)
        {
            if (op.ConstantValue is { HasValue: true, Value: null })
            {
                var type = op.Type == null ? Primitive(SpecialType.System_String) with { Nullable = true } : Type(op.Type);
                var storage = type.Native switch
                {
                    "Text" => "NVARCHAR(MAX)", "Integer" => "INT", "Long Integer" => "BIGINT",
                    "Decimal" => "DECIMAL(37,8)", "Boolean" => "BIT", "Date" => "DATE", "Time" => "TIME",
                    "Date Time" => "DATETIME2", "Binary Data" => "VARBINARY(MAX)",
                    _ when type.IsIdentity => "BIGINT",
                    _ => throw compiler.Unsupported(op, "A null query literal requires a scalar SQL storage type")
                };
                return Leaf(new(SqlExpression.Raw("CAST(NULL AS " + storage + ")"), type, IsNull: true));
            }
            if (op is IParameterReferenceOperation parameter && bindings.TryGetValue(parameter.Parameter, out var row)) return row;
            if (op is IAnonymousObjectCreationOperation anonymous)
                return ConstructedShape(anonymous.Type!, anonymous.Initializers.Select(initializer =>
                {
                    var assignment = (ISimpleAssignmentOperation)initializer;
                    return (((IPropertyReferenceOperation)assignment.Target).Property, Expression(assignment.Value));
                }).ToArray());
            if (op is IObjectCreationOperation created)
                return Construct(created);
            if (!UsesRow(op)) return Capture(op);
            if (op is IConversionOperation conversion)
            {
                var operand = Expression(conversion.Operand);
                if (operand.Value is not { } value) return operand;
                var target = Type(conversion.Type!);
                if (conversion.OperatorMethod != null && conversion.OperatorMethod.ContainingType.SpecialType != SpecialType.System_Decimal)
                    throw compiler.Unsupported(op, "Query conversion needs a bound scalar translation");
                if (Range(target.Source) is { } to && Range(value.Type.Source) is { } from && (to.Minimum > from.Minimum || to.Maximum < from.Maximum))
                    throw compiler.Unsupported(op, "A per-row narrowing conversion needs range/exception propagation");
                return Leaf(value with { Type = target });
            }
            if (op is IPropertyReferenceOperation property)
            {
                var owner = Expression(property.Instance!);
                var member = owner.Members?.FirstOrDefault(m => SymbolEqualityComparer.Default.Equals(m.Property, property.Property));
                if (member is { Shape: not null }) return member.Value.Shape;
                var scalar = Scalar(owner, op);
                if (property.Property.ContainingType.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T && property.Property.Name == "HasValue")
                    return Leaf(new(scalar.Has, Type(property.Type!), Predicate: true));
                if (scalar.Type.IsIdentity && property.Property.Name == "Value") return Leaf(scalar with { Type = Type(property.Type!) });
                if (scalar.Type.IsIdentity && property.Property.Name == "IsEmpty")
                    return Leaf(new(F("({0} = 0)", scalar.Scalar), Type(property.Type!), Predicate: true));
                throw compiler.Unsupported(op, "Query member is not bound: " + property.Property.ToDisplayString());
            }
            if (op is ICoalesceOperation coalesce)
            {
                var left = Value(coalesce.Value); var right = Value(coalesce.WhenNull);
                return Leaf(new(F("CASE WHEN {0} THEN {1} ELSE {2} END", left.Has, left.Scalar, right.Scalar), Type(op.Type!)));
            }
            if (op is IConditionalOperation conditional)
                return Leaf(new(F("CASE WHEN {0} THEN {1} ELSE {2} END", Value(conditional.Condition).Condition, Value(conditional.WhenTrue).Scalar, Value(conditional.WhenFalse!).Scalar), Type(op.Type!)));
            if (op is IUnaryOperation unary)
            {
                var operand = Value(unary.Operand);
                if (unary.OperatorKind == UnaryOperatorKind.Not) return Leaf(new(F("NOT ({0})", operand.Condition), Type(op.Type!), Predicate: true));
                if (unary.OperatorKind == UnaryOperatorKind.Minus && operand.Type.Native == "Decimal")
                    return Leaf(new(F("(-{0})", operand.Scalar), Type(op.Type!)));
            }
            if (op is IBinaryOperation binary)
            {
                var left = Value(binary.LeftOperand); var right = Value(binary.RightOperand); var type = Type(binary.Type!);
                if (binary.OperatorKind is BinaryOperatorKind.ConditionalAnd or BinaryOperatorKind.And or BinaryOperatorKind.ConditionalOr or BinaryOperatorKind.Or)
                    return Leaf(new(F(binary.OperatorKind is BinaryOperatorKind.And or BinaryOperatorKind.ConditionalAnd ? "({0}) AND ({1})" : "({0}) OR ({1})", left.Condition, right.Condition), type, Predicate: true));
                if (binary.OperatorKind is BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals)
                {
                    var equal = Equal(left, right);
                    return Leaf(new(binary.OperatorKind == BinaryOperatorKind.Equals ? equal : F("NOT ({0})", equal), type, Predicate: true));
                }
                var symbol = binary.OperatorKind switch { BinaryOperatorKind.LessThan => "<", BinaryOperatorKind.LessThanOrEqual => "<=", BinaryOperatorKind.GreaterThan => ">", BinaryOperatorKind.GreaterThanOrEqual => ">=", _ => null };
                if (symbol != null) return Leaf(new(F("({0}) AND ({1}) AND ({2} " + symbol + " {3})", left.Has, right.Has, left.Scalar, right.Scalar), type, Predicate: true));
                symbol = binary.OperatorKind switch { BinaryOperatorKind.Add => "+", BinaryOperatorKind.Subtract => "-", _ => null };
                if (symbol != null && type.Native == "Decimal") return Leaf(new(F("({0} " + symbol + " {1})", left.Scalar, right.Scalar), type));
                throw compiler.Unsupported(op, "Per-row numeric query operation needs provider range/exception semantics");
            }
            throw compiler.Unsupported(op, "Query expression is not translated: " + op.Kind);
        }
        private static SqlExpression Equal(SqlValue left, SqlValue right)
        {
            if (left.IsNull) return F("NOT ({0})", right.Has);
            if (right.IsNull) return F("NOT ({0})", left.Has);
            var same = left.Type.Native == "Text" && right.Type.Native == "Text"
                ? F("(({0} COLLATE Latin1_General_100_BIN2) = ({1} COLLATE Latin1_General_100_BIN2) AND DATALENGTH({0}) = DATALENGTH({1}))", left.Scalar, right.Scalar)
                : F("({0} = {1})", left.Scalar, right.Scalar);
            return F("((({0}) AND ({1}) AND ({2})) OR (NOT ({0}) AND NOT ({1})))", left.Has, right.Has, same);
        }
        private SqlExpression KeyEqual(SqlShape left, SqlShape right, IOperation location)
        {
            if (left.Value is { } a && right.Value is { } b) return Equal(a, b);
            if (left.Members?.Count != right.Members?.Count || left.Members == null || right.Members == null)
                throw compiler.Unsupported(location, "Join key shapes differ");
            return left.Members.Zip(right.Members).Select(pair => KeyEqual(pair.First.Shape, pair.Second.Shape, location))
                .Aggregate((a, b) => F("({0}) AND ({1})", a, b));
        }
    }
}

