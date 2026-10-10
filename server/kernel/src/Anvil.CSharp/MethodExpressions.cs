using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private static bool Effects(IOperation op) => op is IInvocationOperation or IAssignmentOperation or IIncrementOrDecrementOperation or IArrayElementReferenceOperation
        || op is IBinaryOperation binary && (binary.IsChecked || binary.Type?.SpecialType == SpecialType.System_Decimal || binary.OperatorKind is BinaryOperatorKind.Divide or BinaryOperatorKind.Remainder)
        || op is IConversionOperation { IsChecked: true }
        || op is IPropertyReferenceOperation property && (property.Property.IsIndexer
            || property.Property.Name == "Value" && property.Property.ContainingType.OriginalDefinition.ToDisplayString() != "Anvil.Authoring.Id<T>")
        || op.ChildOperations.Any(Effects);
    private SourceValue Value(IOperation op, JsonArray steps, bool discard = false)
    {
        if (NativeQueryValue(op,steps) is { } queryValue) return queryValue;
        if (op.ConstantValue is { HasValue: true, Value: not null } constant && op.Type != null)
        {
            var type = Type(op.Type);
            return type.Category == RuntimeCategory.TextReference ? ManagedText(DataModel.Constant(constant.Value), steps) : new(DataModel.Constant(constant.Value), type);
        }
        switch (op)
        {
            case IInstanceReferenceOperation instance when instance.ReferenceKind == InstanceReferenceKind.ContainingTypeInstance && !method.Symbol.IsStatic:
                return new(ControlFrame == null ? method.Receiver : CapturedReceiverPath(), Type(method.Symbol.ContainingType));
            case IParameterReferenceOperation parameter:
                return boundValues.TryGetValue(parameter.Parameter,out var bound)?bound:new(ControlFrame == null ? method.Parameter(parameter.Parameter) : CapturedPath(parameter.Parameter, parameter.Parameter.Type), Type(parameter.Parameter.Type));
            case ILocalReferenceOperation local: return new(Local(local.Local), Type(local.Local.Type));
            case IConversionOperation conversion: return Convert(conversion, steps);
            case IParenthesizedOperation parenthesized: return Value(parenthesized.Operand, steps, discard);
            case IBinaryOperation binary: return Binary(binary, steps);
            case IUnaryOperation unary:
                var operand = Value(unary.Operand, steps);
                if (TemporalUnary(unary, operand, steps) is {} temporalUnary) return temporalUnary;
                if (operand.Type.Nullable) throw Unsupported(op, "Lifted unary operations require nullable lowering");
                return unary.OperatorKind switch
                {
                    UnaryOperatorKind.Not when operand.Type.Native == "Boolean" => new("not (" + operand.Text + ")", Type(unary.Type!)),
                    UnaryOperatorKind.Plus => operand,
                    UnaryOperatorKind.Minus => Numeric(BinaryOperatorKind.Subtract, "0", operand.Text, Type(unary.Type!), unary.IsChecked, steps, unary),
                    _ => throw Unsupported(op)
                };
            case ISimpleAssignmentOperation assignment:
                var target = Target(assignment.Target, steps); var value = Value(assignment.Value, steps);
                Store(steps, target, value, assignment); return LoadTarget(target, steps);
            case ICompoundAssignmentOperation assignment:
                var compoundTarget = Target(assignment.Target, steps); var before = LoadTarget(compoundTarget, steps);
                if (Effects(assignment.Value)) before = Snapshot(before, steps);
                var right = Value(assignment.Value, steps);
                if ((before.Type.Nullable || right.Type.Nullable) && (before.Type.Temporal != TemporalKind.None || right.Type.Temporal != TemporalKind.None))
                    return LoadTarget(LiftedTemporalCompound(assignment, compoundTarget, before, right, steps), steps);
                var computed = TemporalBinary(assignment.OperatorKind, before, right, steps, assignment)
                    ?? Numeric(assignment.OperatorKind, before.Text, right.Text, compoundTarget.Type, assignment.IsChecked, steps, assignment);
                Store(steps, compoundTarget, computed, assignment); return LoadTarget(compoundTarget, steps);
            case IIncrementOrDecrementOperation increment:
                var counter = Target(increment.Target, steps);
                var loaded = LoadTarget(counter, steps);
                var old = increment.IsPostfix && !discard ? Snapshot(loaded, steps) : loaded;
                var changed = Numeric(increment.Kind == OperationKind.Increment ? BinaryOperatorKind.Add : BinaryOperatorKind.Subtract,
                    loaded.Text, "1", counter.Type, increment.IsChecked, steps, increment);
                Store(steps, counter, changed, increment); return increment.IsPostfix ? old : LoadTarget(counter, steps);
            case IConditionalOperation conditional:
                var test = Value(conditional.Condition, steps); var yes = new JsonArray(); var no = new JsonArray();
                var result = Temp(Type(conditional.Type!));
                Store(yes, result, Value(conditional.WhenTrue, yes), conditional);
                Store(no, result, Value(conditional.WhenFalse!, no), conditional);
                steps.Add(new JsonObject { ["if"] = test.Text, ["then"] = yes, ["else"] = no }); return result;
            case IConditionalAccessOperation access: return ConditionalAccess(access, steps, discard);
            case IConditionalAccessInstanceOperation instance: return ConditionalInstance(instance);
            case ICoalesceOperation coalesce: return Coalesce(coalesce, steps);
            case ISwitchExpressionOperation selection: return SwitchExpression(selection, steps);
            case IIsPatternOperation pattern:
                return new(Pattern(Snapshot(Value(pattern.Value, steps), steps), pattern.Pattern, steps), Type(pattern.Type!));
            case IFieldReferenceOperation field when field.Field.IsStatic && TemporalModel.Kind(field.Field.ContainingType) != TemporalKind.None:
                return TemporalField(field, steps);
            case IFieldReferenceOperation field: return Field(field, steps);
            case IPropertyReferenceOperation property: return Property(property, steps);
            case IArrayElementReferenceOperation element:
                if (element.Indices.Length != 1) throw Unsupported(op);
                return Element(Value(element.ArrayReference, steps), element.Indices[0], steps, op);
            case IInvocationOperation invocation: return Invoke(invocation, steps);
            case IDelegateCreationOperation closure: return CreateClosure(closure, steps);
            case IObjectCreationOperation created: return Construct(created, steps);
            case IAnonymousObjectCreationOperation anonymous:
                var anonymousType=Type(anonymous.Type!);var record=anonymousType.IsArenaReference ? AllocateReference(anonymousType, steps) : Temp(anonymousType);
                foreach(var initializer in anonymous.Initializers.Cast<ISimpleAssignmentOperation>())
                {
                    var property=((IPropertyReferenceOperation)initializer.Target).Property;
                    var declared=DataModel.Properties(anonymousType.Declaration!.Symbol).Single(member=>member.Name==property.Name);
                    var initialized = Value(initializer.Value, steps);
                    if (anonymousType.IsArenaReference)
                        WritePlace(new ObjectFieldPlace(record, declared, Type(declared.Type)), Coerce(initialized, Type(declared.Type), false, steps, initializer), steps);
                    else Store(steps,new(record.Text+"."+anonymousType.Declaration.Properties[declared],Type(declared.Type)),initialized,initializer);
                }
                return record;
            case IArrayCreationOperation array when array.Initializer!=null:
                return NewList(Type(array.Type!),array.Initializer.ElementValues,steps,array);
            case IArrayCreationOperation array:
                return NewSizedArray(array, steps);
            case IDefaultValueOperation defaultValue:
                var defaultType=Type(defaultValue.Type!);
                if(defaultType.Nullable || defaultType.IsArenaReference || defaultType.IsExceptionReference) return Absent(defaultType,steps,op);
                if(defaultType.Temporal != TemporalKind.None) return TemporalValue(defaultType, "0", steps);
                if(defaultType.IsIdentity) return new("NullIdentifier()",defaultType);
                if(defaultType.Native is "Integer" or "Long Integer" or "Decimal" or "Boolean") return new(defaultType.Native=="Boolean"?"False":"0",defaultType);
                throw Unsupported(op,"Default value needs a source representation");
            case IWithOperation with:
                var original=Value(with.Operand,steps);
                if (original.Type.IsArenaReference)
                {
                    var cell = ReadCell(original, steps); var referenceCopy = AllocateReference(original.Type, steps);
                    Assign(steps, CellPath(referenceCopy), cell.Text); InitializeReference(referenceCopy, with.Initializer, steps); return referenceCopy;
                }
                original=Coerce(original,Type(with.Type!) with {Nullable=false},false,steps,with); var copy=Snapshot(original,steps);
                Initialize(copy,with.Initializer,steps); return copy;
            default: throw Unsupported(op);
        }
    }
    private SourceValue Target(IOperation op, JsonArray steps)
    {
        if (op is ILocalReferenceOperation or IParameterReferenceOperation)
            return Value(op, steps);
        if (Managed && op is IPropertyReferenceOperation or IFieldReferenceOperation or IArrayElementReferenceOperation) return ReferenceTarget(op, steps);
        if (op is IPropertyReferenceOperation or IFieldReferenceOperation or IArrayElementReferenceOperation)
            throw Unsupported(op,"Object/collection mutation requires reference-effect tracking; it must not become a silent value copy");
        throw Unsupported(op, "Assignment target has no native l-value translation");
    }
    private SourceValue Field(IFieldReferenceOperation op, JsonArray steps)
    {
        if (op.Instance == null) throw Unsupported(op, "Static field translation is not defined: " + op.Field.ToDisplayString());
        var owner = Value(op.Instance, steps);
        if (owner.Type.IsArenaReference) return ReadPlace(new ObjectFieldPlace(owner, op.Field, Type(op.Type!)), steps);
        owner = Dereference(owner, steps);
        if (owner.Type.Declaration is { Kind: DataKind.Structure } record)
            return new(owner.Text + "." + record.Properties[op.Field], Type(op.Field.Type));
        throw Unsupported(op, "Field requires a represented data member");
    }
    private SourceValue Property(IPropertyReferenceOperation op, JsonArray steps)
    {
        if (ExceptionProperty(op, steps) is { } exception) return exception;
        if (TemporalModel.Kind(op.Property.ContainingType) != TemporalKind.None) return TemporalProperty(op, steps);
        if (op.Instance == null) throw Unsupported(op, "Static property translation is not defined: " + op.Property.ToDisplayString());
        var owner = Value(op.Instance, steps);
        if (owner.Type.IsArenaReference)
        {
            if (owner.Type.IsList)
            {
                if (op.Property.Name is "Count" or "Length") return new(ReadCell(owner, steps).Text + ".Items.Length", Type(op.Type!));
                if (op.Property.Name == "Capacity" && owner.Type.Source is not IArrayTypeSymbol)
                    return new(ReadCell(owner, steps).Text + ".Capacity", Type(op.Type!));
                if (op.Property.IsIndexer && op.Arguments.Length == 1) return Element(owner, op.Arguments[0].Value, steps, op);
            }
            return ReadPlace(new ObjectFieldPlace(owner, op.Property, Type(op.Type!)), steps);
        }
        if (owner.Type.Nullable)
        {
            if (op.Property.ContainingType.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T)
            {
                if (op.Property.Name == "HasValue") return new(Present(owner), Type(op.Type!));
                if (op.Property.Name == "Value")
                {
                    Guard(steps, "not (" + Present(owner) + ")", "InvalidOperationException", "Nullable object must have a value.");
                    return Payload(owner);
                }
            }
            if (!owner.Type.Source.IsReferenceType) throw Unsupported(op, "Nullable member has no defined translation");
            owner = Dereference(owner, steps);
        }
        if (owner.Type.IsList)
        {
            if (op.Property.Name is "Count" or "Length") return new(owner.Text + ".Length", Type(op.Type!));
            if (op.Property.IsIndexer && op.Arguments.Length == 1) return Element(owner, op.Arguments[0].Value, steps, op);
        }
        if (op.Property.ContainingType.SpecialType == SpecialType.System_String && op.Property.Name == "Length")
            return Utf16Length(owner, steps);
        if(owner.Type.IsIdentity&&op.Property.Name=="IsEmpty") return new(owner.Text+" = NullIdentifier()",Type(op.Type!));
        if(owner.Type.IsIdentity&&op.Property.Name=="Value") return new((ShortIdentity(owner.Type)?"IdentifierToInteger(":"IdentifierToLongInteger(")+owner.Text+")",Type(op.Type!));
        if(owner.Storage) return StorageMember(owner,op.Property,steps);
        if (owner.Type.Declaration is { } record)
            return new(owner.Text + "." + record.Properties[op.Property], Type(op.Property.Type));
        throw Unsupported(op, "Property translation is not defined: " + op.Property.ToDisplayString());
    }
    private SourceValue Element(SourceValue owner, IOperation index, JsonArray steps, IOperation location)
    {
        if (owner.Type.IsArenaReference)
        {
            var receiver = CaptureReference(owner, steps); var at = Snapshot(Value(index, steps), steps);
            return ReadPlace(new CollectionElementPlace(receiver, at, receiver.Type.Element!), steps);
        }
        owner = Dereference(owner, steps);
        if (!owner.Type.IsList || owner.Type.Nullable) throw Unsupported(location, "Indexing requires a non-null typed list");
        if (Effects(index)) owner = Snapshot(owner, steps);
        var position = Value(index, steps);
        if (!index.ConstantValue.HasValue) position = Snapshot(position, steps);
        Guard(steps, position.Text + " < 0 or " + position.Text + " >= " + owner.Text + ".Length", "ArgumentOutOfRangeException", "Index is outside the collection.");
        return new(owner.Text + "[" + position.Text + "]", owner.Type.Element!);
    }
    private SourceValue Convert(IConversionOperation op, JsonArray steps)
    {
        if (op.OperatorMethod != null && op.OperatorMethod.ContainingType.SpecialType != SpecialType.System_Decimal)
            throw Unsupported(op, "User-defined conversion requires a bound action");
        var target = Type(op.Type!);
        if(op.Operand.ConstantValue is {HasValue:true,Value:null}) return Absent(target,steps,op);
        var value = Value(op.Operand, steps);
        if (op.IsTryCast && value.Type.IsReadOnlyListReference && ReadOnlyListTypes.ConcreteKind(target.Source) is 1 or 2)
        {
            if (!SymbolEqualityComparer.Default.Equals(value.Type.Element!.Source, target.Element?.Source))
                throw Unsupported(op, "Read-only list conversions require the exact element type; covariance is not represented");
            var result = Temp(target);
            Assign(steps, result.Text + ".Index", "If(" + value.Text + ".Kind = " + ReadOnlyListTypes.ConcreteKind(target.Source) + ", " + value.Text + ".Index, 0)");
            return result;
        }
        return Coerce(value,target,op.IsChecked,steps,op);
    }
    private SourceValue Binary(IBinaryOperation op, JsonArray steps)
    {
        if (op.LeftOperand.Type?.TypeKind == TypeKind.Delegate || op.RightOperand.Type?.TypeKind == TypeKind.Delegate)
            throw Unsupported(op, "Delegate equality/multicast semantics require a delegate identity codec; compiled target/frame equality is not substituted");
        if (NullComparison(op, steps) is { } comparison) return comparison;
        if (ExceptionIdentityComparison(op, steps) is { } exceptionIdentity) return exceptionIdentity;
        static IOperation IdentityOperand(IOperation value) => value is IConversionOperation { IsImplicit: true, Type.SpecialType: SpecialType.System_Object } conversion
            ? IdentityOperand(conversion.Operand) : value;
        if (op.OperatorMethod == null && op.OperatorKind is BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals
            && (ReadOnlyListTypes.Is(IdentityOperand(op.LeftOperand).Type!) || ReadOnlyListTypes.Is(IdentityOperand(op.RightOperand).Type!)))
        {
            var first = ReferenceArgument(op.LeftOperand, steps);
            if (Effects(op.RightOperand)) first = Snapshot(first, steps);
            var second = ReferenceArgument(op.RightOperand, steps);
            var identity = ReferenceIdentity(first, second, steps, op);
            return new(op.OperatorKind == BinaryOperatorKind.Equals ? "(" + identity + ")" : "not (" + identity + ")", Type(op.Type!));
        }
        var textConcat = op.Type?.SpecialType == SpecialType.System_String && op.OperatorKind == BinaryOperatorKind.Add;
        var left = textConcat ? ConcatenationArgument(op.LeftOperand, steps) : Value(op.LeftOperand, steps);
        if (op.OperatorKind is BinaryOperatorKind.ConditionalAnd or BinaryOperatorKind.ConditionalOr)
        {
            var result = Snapshot(left, steps); var branch = new JsonArray();
            Assign(branch, result.Text, Value(op.RightOperand, branch).Text);
            steps.Add(new JsonObject { ["if"] = (op.OperatorKind == BinaryOperatorKind.ConditionalOr ? "not (" + left.Text + ")" : left.Text), ["then"] = branch });
            return result;
        }
        if (Effects(op.RightOperand)) left = Snapshot(left, steps);
        var right = textConcat ? ConcatenationArgument(op.RightOperand, steps) : op.RightOperand.ConstantValue is {HasValue:true,Value:null} ? Absent(left.Type with {Nullable=true},steps,op.RightOperand) : Value(op.RightOperand, steps); var type = Type(op.Type!);
        if (textConcat)
            return Concatenate(left, right, type, op, steps);
        if (left.Type.IsExceptionReference || right.Type.IsExceptionReference)
        {
            if (!left.Type.IsExceptionReference || !right.Type.IsExceptionReference || op.OperatorMethod != null ||
                op.OperatorKind is not (BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals))
                throw Unsupported(op, "Exception values support reference identity comparison only");
            return new(left.Text + ".Index" + (op.OperatorKind == BinaryOperatorKind.Equals ? " = " : " <> ") + right.Text + ".Index", type);
        }
        if (left.Type.IsArenaReference || right.Type.IsArenaReference)
        {
            if (op.OperatorKind is not (BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals) || op.OperatorMethod != null && !left.IsNull && !right.IsNull)
                throw Unsupported(op, "Record value equality and non-identity reference operators need their source semantics");
            var equal = ReferenceIdentity(left, right, steps, op);
            return new(op.OperatorKind == BinaryOperatorKind.Equals ? "(" + equal + ")" : "not (" + equal + ")", type);
        }
        if (left.Type.Nullable || right.Type.Nullable) return LiftedBinary(op,left,right,steps);
        if (op.OperatorKind is BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals or BinaryOperatorKind.LessThan or BinaryOperatorKind.LessThanOrEqual or BinaryOperatorKind.GreaterThan or BinaryOperatorKind.GreaterThanOrEqual)
        {
            if (left.Type.IsList || left.Type.Declaration is { Kind: DataKind.Structure or DataKind.Entity or DataKind.Catalog }&&!left.Type.IsIdentity)
                throw Unsupported(op, "Record/reference equality requires a semantic equality translation");
            RequireTemporalComparisonCompatibility(left, right, op);
            left = TemporalScalar(left); right = TemporalScalar(right);
            var symbol = op.OperatorKind switch { BinaryOperatorKind.Equals => "=", BinaryOperatorKind.NotEquals => "<>", BinaryOperatorKind.LessThan => "<", BinaryOperatorKind.LessThanOrEqual => "<=", BinaryOperatorKind.GreaterThan => ">", _ => ">=" };
            return new("(" + left.Text + " " + symbol + " " + right.Text + ")", type);
        }
        if (type.Native == "Boolean" && op.OperatorKind is BinaryOperatorKind.And or BinaryOperatorKind.Or or BinaryOperatorKind.ExclusiveOr)
            return new("(" + left.Text + (op.OperatorKind == BinaryOperatorKind.And ? " and " : op.OperatorKind == BinaryOperatorKind.Or ? " or " : " <> ") + right.Text + ")", type);
        if (type.Native == "Text" && op.OperatorKind == BinaryOperatorKind.Add && left.Type.Native == "Text" && right.Type.Native == "Text")
            return new("(" + left.Text + " + " + right.Text + ")", type);
        return TemporalBinary(op.OperatorKind, left, right, steps, op)
            ?? Numeric(op.OperatorKind, left.Text, right.Text, type, op.IsChecked, steps, op);
    }
    private SourceValue Invoke(IInvocationOperation op, JsonArray steps)
    {
        if (op.TargetMethod.MethodKind == MethodKind.DelegateInvoke) return InvokeClosure(op, steps);
        if (ExceptionReferenceInvocation(op, steps) is { } exception) return exception;
        if (ReferenceInvocation(op, steps) is { } reference) return reference;
        if(QueryTerminal(op)) return Query(op,steps);
        if(LogicModel.DataDependency(op.TargetMethod.ContainingType)) return DataCall(op,steps);
        if (!model.HasMethod(op.TargetMethod)) return Intrinsic(op, steps);
        var target = model.Method(op.TargetMethod); var arguments = new JsonObject();
        SourceValue? receiver = null;
        if (target.HasReceiver)
        {
            if (op.Instance == null) throw Unsupported(op, "Instance helper requires a receiver");
            // Capture once, before arguments can mutate/rebind the receiver expression.
            receiver = Snapshot(Value(op.Instance, steps), steps);
            if (!receiver.Type.IsArenaReference || !SymbolEqualityComparer.Default.Equals(
                receiver.Type.Source.WithNullableAnnotation(NullableAnnotation.NotAnnotated), target.Symbol.ContainingType))
                throw Unsupported(op, "Instance helper requires its exact source class receiver; inherited/struct dispatch is not defined");
            arguments[target.Receiver] = receiver.Text;
        }
        for (var index = 0; index < op.Arguments.Length; index++)
        {
            var argument = op.Arguments[index];
            if(LogicModel.DataDependency(argument.Parameter!.Type))
            {
                if(argument.Value is not IParameterReferenceOperation dependency||!LogicModel.DataDependency(dependency.Parameter.Type)) throw Unsupported(argument,"Data dependency must come from the request context");
                continue;
            }
            var value = Value(argument.Value, steps);
            if (op.Arguments.Skip(index + 1).Any(a => Effects(a.Value))) value = Snapshot(value, steps);
            arguments[target.Parameter(argument.Parameter!)] = Coerce(value,Type(argument.Parameter!.Type),false,steps,argument).Text;
        }
        // C# evaluates every argument before dereferencing even a null receiver.
        if (receiver != null) CheckReference(receiver, steps);
        var name = "AvCall" + ++calls;
        if (Managed) arguments["AvContextIn"] = Context;
        if (target.Symbol.MethodKind == MethodKind.LocalFunction)
            arguments["AvClosureFrame"] = FrameIndex((IMethodSymbol)target.Symbol.ContainingSymbol);
        steps.Add(new JsonObject { ["call"] = model.References.MethodName(target), ["as"] = name, ["args"] = arguments });
        if (Managed) PropagateReferenceCall(name, steps);
        return new(name + "." + target.Result, target.Symbol.ReturnsVoid ? Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Boolean)) : Type(op.Type!));
    }
    private SourceValue Intrinsic(IInvocationOperation op, JsonArray steps)
    {
        if (TemporalModel.Kind(op.TargetMethod.ContainingType) != TemporalKind.None) return TemporalInvoke(op, steps);
        if (op.TargetMethod.ContainingType.SpecialType == SpecialType.System_String) return TextIntrinsic(op, steps);
        if (op.TargetMethod.ContainingType.ToDisplayString() == "System.Math")
        {
            var args = op.Arguments.Select(a => Value(a.Value, steps)).ToArray(); var type = Type(op.Type!);
            if (op.TargetMethod.Name is "Abs" or "Min" or "Max" && args.All(a => !a.Type.Nullable))
            {
                var text = op.TargetMethod.Name + "(" + string.Join(", ", args.Select(a => a.Text)) + ")";
                return type.Native is "Integer" or "Long Integer" ? Integral(text, type, true, steps, op) : new(text, type);
            }
            if (op.TargetMethod.Name == "Truncate" && args.Length == 1) return new("Trunc(" + args[0].Text + ")", type);
        }
        throw Unsupported(op, "Call translation is not defined: " + op.TargetMethod.ToDisplayString());
    }
    private SourceValue Construct(IObjectCreationOperation op, JsonArray steps)
    {
        if (ExceptionTypes.IsException(op.Type, model.Program.Compilation)) return ConstructExceptionValue(op, steps);
        if (TemporalModel.Kind(op.Type!) == TemporalKind.DateTime) return ExtendedTemporalConstruct(op, ExactTemporalType(TemporalKind.DateTime), steps);
        var type = Type(op.Type!);
        if (type.IsArenaReference) return ConstructReference(op, type, steps);
        if(type.Temporal != TemporalKind.None) return TemporalConstruct(op, steps);
        if(type.IsList)return NewList(op,type,steps);
        if(type.IsIdentity&&op.Arguments.Length==1)
        {
            var value=Value(op.Arguments[0].Value,steps);
            if(ShortIdentity(type)) value=Coerce(value,Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Int32)),true,steps,op);
            return new((ShortIdentity(type)?"IntegerToIdentifier(":"LongIntegerToIdentifier(")+value.Text+")",type);
        }
        if (type.Declaration is not { Kind: DataKind.Structure or DataKind.Entity } record || !record.Symbol.IsRecord || type.Nullable||type.IsIdentity)
            throw Unsupported(op, "Construction currently requires a non-null transport record");
        var result = Temp(type);
        foreach (var argument in op.Arguments)
        {
            var property = record.Symbol.GetMembers(argument.Parameter!.Name).OfType<IPropertySymbol>().SingleOrDefault()
                ?? throw Unsupported(op, "Record constructor parameter does not match a property");
            Store(steps,new(result.Text + "." + record.Properties[property],Type(property.Type)),Value(argument.Value,steps),argument);
        }
        if (op.Initializer != null) Initialize(result,op.Initializer,steps);
        return result;
    }
    private void Initialize(SourceValue value,IObjectOrCollectionInitializerOperation initializer,JsonArray steps)
    {
        if (value.Type.IsArenaReference) { InitializeReference(value, initializer, steps); return; }
        value=Coerce(value,value.Type with {Nullable=false},false,steps,initializer);
        var record=value.Type.Declaration??throw Unsupported(initializer);
        foreach(var expression in initializer.Initializers)
        {
            if(expression is not ISimpleAssignmentOperation {Target:IPropertyReferenceOperation property} assignment) throw Unsupported(expression,"Initializer requires bound property assignments");
            Store(steps,new(value.Text+"."+record.Properties[property.Property],Type(property.Property.Type)),Value(assignment.Value,steps),assignment);
        }
    }
}
