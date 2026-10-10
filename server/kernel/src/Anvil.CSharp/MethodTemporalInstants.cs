using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private const string DurationOverflow = "TimeSpan overflowed because the duration is too long.";
    private const string DurationNegationOverflow = "Negating the minimum value of a twos complement number is invalid.";
    private const string DateTicksRange = "Ticks must be between DateTime.MinValue.Ticks and DateTime.MaxValue.Ticks. (Parameter 'ticks')";
    private const string DateAdditionRange = "The added or subtracted value results in an un-representable DateTime. (Parameter 'value')";
    private const string UtcOffsetRange = "The UTC time represented when the offset is applied must be between year 0 and 10,000. (Parameter 'offset')";
    private ValueType ExactTemporalType(TemporalKind kind) => model.Data.TemporalType(
        model.Program.Compilation.GetSpecialType(SpecialType.System_Object).ContainingAssembly.GetTypeByMetadataName("System." + kind) ?? throw new InvalidOperationException("Temporal framework type is unavailable"), kind);
    private static string ClockTicks(SourceValue value) => value.Type.Temporal == TemporalKind.DateTimeOffset
        ? "DecimalToLongInteger((" + value.Text + ".UtcTicks + 0.0) + " + value.Text + ".OffsetMinutes * 600000000.0)"
        : value.Text + ".Ticks";
    private SourceValue TemporalField(IFieldReferenceOperation op, JsonArray steps)
    {
        var kind = TemporalModel.Kind(op.Field.ContainingType);
        var type = ExactTemporalType(kind);
        var minimum = kind == TemporalKind.TimeSpan ? long.MinValue : 0;
        var maximum = kind == TemporalKind.TimeSpan ? long.MaxValue : TemporalModel.MaximumDateTimeTicks;
        var ticks = op.Field.Name switch
        {
            "Zero" when kind == TemporalKind.TimeSpan => 0L,
            "MinValue" => minimum, "MaxValue" => maximum,
            "UnixEpoch" when kind is TemporalKind.DateTime or TemporalKind.DateTimeOffset => 621355968000000000L,
            _ => throw Unsupported(op, "Temporal field translation is not defined: " + op.Field)
        };
        return TemporalValue(type, DataModel.Constant(ticks), steps, kind == TemporalKind.DateTime && op.Field.Name == "UnixEpoch" ? "1" : "0");
    }
    private SourceValue ExtendedTemporalProperty(IPropertyReferenceOperation op, JsonArray steps)
    {
        if (op.Instance == null) throw Unsupported(op, "Ambient temporal properties require an explicit clock or timezone dependency");
        var owner = Value(op.Instance, steps); var kind = owner.Type.Temporal;
        if (kind == TemporalKind.None) throw Unsupported(op, "This DateTime value has no exact ticks/Kind carrier; the native Date Time codec is not implemented");
        var ticks = ClockTicks(owner);
        if (op.Property.Name == "Ticks") return new(ticks, TemporalInteger(true));
        if (kind == TemporalKind.TimeSpan)
        {
            var divisor = op.Property.Name switch { "Days" => TemporalModel.TicksPerDay, "Hours" => 36000000000L,
                "Minutes" => TemporalModel.TicksPerMinute, "Seconds" => 10000000L, "Milliseconds" => 10000L,
                "Microseconds" => 10L, "Nanoseconds" => 1L, _ => throw Unsupported(op, "Duration property needs additional numeric semantics: " + op.Property) };
            var divided = "Trunc(" + ticks + " / " + divisor + ".0)";
            var component = op.Property.Name == "Days" ? divided : "Mod(" + divided + ", " + (op.Property.Name == "Hours" ? 24 : op.Property.Name is "Minutes" or "Seconds" ? 60 : op.Property.Name == "Nanoseconds" ? 10 : 1000) + ")";
            return new("DecimalToInteger(" + component + ")" + (op.Property.Name == "Nanoseconds" ? " * 100" : ""), Type(op.Type!));
        }
        if (kind == TemporalKind.DateTimeOffset)
        {
            if (op.Property.Name == "UtcTicks") return TemporalScalar(owner);
            if (op.Property.Name == "Offset") return TemporalValue(ExactTemporalType(TemporalKind.TimeSpan), "DecimalToLongInteger(" + owner.Text + ".OffsetMinutes * 600000000.0)", steps);
            if (op.Property.Name == "UtcDateTime") return TemporalValue(ExactTemporalType(TemporalKind.DateTime), owner.Text + ".UtcTicks", steps, "1");
            if (op.Property.Name == "DateTime") return TemporalValue(ExactTemporalType(TemporalKind.DateTime), ticks, steps);
        }
        if (kind == TemporalKind.DateTime && op.Property.Name == "Kind") return new(owner.Text + ".Kind", Type(op.Type!));
        if (op.Property.Name is "Year" or "Month" or "Day" or "DayOfYear")
        {
            var date = TemporalValue(ExactTemporalType(TemporalKind.DateOnly), Whole(ticks + " / " + TemporalModel.TicksPerDay + ".0"), steps);
            var parts = DateParts(date, steps);
            return new(op.Property.Name switch { "Year" => parts.Year, "Month" => parts.Month, "Day" => parts.Day, _ => parts.DayOfYear }, Type(op.Type!));
        }
        return TemporalClockComponent(ticks, op.Property.Name, Type(op.Type!), op);
    }
    private SourceValue ExtendedTemporalConstruct(IObjectCreationOperation op, ValueType type, JsonArray steps)
    {
        if (op.Arguments.Length == 0) return TemporalValue(type, "0", steps);
        var supported = type.Temporal switch
        {
            TemporalKind.TimeSpan => op.Arguments.Length == 1 && op.Arguments[0].Parameter!.Name == "ticks",
            TemporalKind.DateTime => op.Arguments.Length is 1 or 2 && op.Arguments.Any(a => a.Parameter!.Name == "ticks"),
            TemporalKind.DateTimeOffset => op.Arguments.Length == 2 && op.Arguments.Any(a => a.Parameter!.Name == "ticks"),
            _ => false
        };
        if (!supported) throw Unsupported(op, "Temporal constructor overload is not defined: " + op.Constructor);
        var args = TemporalArguments(op.Arguments, steps); var ticks = args["ticks"].Text;
        if (type.Temporal == TemporalKind.TimeSpan) return TemporalValue(type, ticks, steps);
        string offsetTicks = "0";
        if (type.Temporal == TemporalKind.DateTimeOffset)
        {
            offsetTicks = TemporalScalar(args["offset"]).Text;
            Guard(steps, "Mod(" + offsetTicks + ", 600000000) <> 0", "ArgumentException", "Offset must be specified in whole minutes. (Parameter 'offset')");
            Guard(steps, offsetTicks + " < -504000000000 or " + offsetTicks + " > 504000000000", "ArgumentOutOfRangeException", "Offset must be within plus or minus 14 hours. (Parameter 'offset')");
        }
        Guard(steps, ticks + " < 0 or " + ticks + " > " + TemporalModel.MaximumDateTimeTicks, "ArgumentOutOfRangeException", DateTicksRange);
        if (type.Temporal == TemporalKind.DateTime)
        {
            var kind = args.GetValueOrDefault("kind")?.Text ?? "0";
            Guard(steps, kind + " < 0 or " + kind + " > 2", "ArgumentException", "Invalid DateTimeKind value. (Parameter 'kind')");
            return TemporalValue(type, ticks, steps, kind);
        }
        var utc = Temp(TemporalInteger(true)); Assign(steps, utc.Text, "DecimalToLongInteger((" + ticks + " + 0.0) - " + offsetTicks + ")");
        Guard(steps, utc.Text + " < 0 or " + utc.Text + " > " + TemporalModel.MaximumDateTimeTicks, "ArgumentOutOfRangeException", UtcOffsetRange);
        return TemporalValue(type, utc.Text, steps, Whole(offsetTicks + " / 600000000.0"));
    }
    private SourceValue DurationResult(string expression, JsonArray steps, string message = DurationOverflow)
    {
        var ticks = Temp(Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Decimal)));
        Assign(steps, ticks.Text, expression);
        Guard(steps, ticks.Text + " < -9223372036854775808.0 or " + ticks.Text + " > 9223372036854775807.0", "OverflowException", message);
        return TemporalValue(ExactTemporalType(TemporalKind.TimeSpan), "DecimalToLongInteger(" + ticks.Text + ")", steps);
    }
    private SourceValue ShiftTimestamp(SourceValue owner, string delta, JsonArray steps, string rangeMessage = DateAdditionRange)
    {
        var civil = Temp(Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Decimal)));
        Assign(steps, civil.Text, "(" + ClockTicks(owner) + " + 0.0) + (" + delta + ")");
        Guard(steps, civil.Text + " < 0 or " + civil.Text + " > " + TemporalModel.MaximumDateTimeTicks, "ArgumentOutOfRangeException", rangeMessage);
        if (owner.Type.Temporal == TemporalKind.DateTime)
            return TemporalValue(owner.Type, "DecimalToLongInteger(" + civil.Text + ")", steps, owner.Text + ".Kind");
        var utc = Temp(TemporalInteger(true)); Assign(steps, utc.Text, "DecimalToLongInteger(" + civil.Text + " - " + owner.Text + ".OffsetMinutes * 600000000.0)");
        Guard(steps, utc.Text + " < 0 or " + utc.Text + " > " + TemporalModel.MaximumDateTimeTicks, "ArgumentOutOfRangeException", UtcOffsetRange);
        return TemporalValue(owner.Type, utc.Text, steps, owner.Text + ".OffsetMinutes");
    }
    private SourceValue? TemporalBinary(BinaryOperatorKind operation, SourceValue left, SourceValue right, JsonArray steps, IOperation location)
    {
        if (operation is not (BinaryOperatorKind.Add or BinaryOperatorKind.Subtract)) return null;
        if (left.Type.Temporal == TemporalKind.None && right.Type.Temporal == TemporalKind.None) return null;
        if (left.Type.Nullable || right.Type.Nullable) throw Unsupported(location, "Temporal arithmetic requires lifted presence handling before reading payloads");
        var a = TemporalScalar(left).Text; var b = TemporalScalar(right).Text; var symbol = operation == BinaryOperatorKind.Add ? "+" : "-";
        if (left.Type.Temporal == TemporalKind.TimeSpan && right.Type.Temporal == TemporalKind.TimeSpan)
            return DurationResult("(" + a + " + 0.0) " + symbol + " " + b, steps);
        if (operation == BinaryOperatorKind.Subtract && left.Type.Temporal == right.Type.Temporal && left.Type.Temporal is TemporalKind.DateTimeOffset or TemporalKind.DateTime)
            return DurationResult("(" + a + " + 0.0) - " + b, steps);
        if (left.Type.Temporal is TemporalKind.DateTimeOffset or TemporalKind.DateTime && right.Type.Temporal == TemporalKind.TimeSpan)
            return ShiftTimestamp(left, operation == BinaryOperatorKind.Add ? b : "-(" + b + " + 0.0)", steps,
                location is IBinaryOperation or ICompoundAssignmentOperation ? "The added or subtracted value results in an un-representable DateTime. (Parameter 't')" : DateAdditionRange);
        if (operation == BinaryOperatorKind.Subtract && left.Type.Temporal == TemporalKind.TimeOnly && right.Type.Temporal == TemporalKind.TimeOnly)
            return TemporalValue(ExactTemporalType(TemporalKind.TimeSpan), "DecimalToLongInteger(Mod((" + a + " + 0.0) + " + TemporalModel.TicksPerDay + " - " + b + ", " + TemporalModel.TicksPerDay + "))", steps);
        throw Unsupported(location, "Temporal binary operation has no exact lowering");
    }
    private void RequireTemporalComparisonCompatibility(SourceValue left, SourceValue right, IOperation location)
    {
        if (left.Type.Source.SpecialType == SpecialType.System_DateTime && right.Type.Source.SpecialType == SpecialType.System_DateTime
            && left.Type.Temporal != right.Type.Temporal)
            throw Unsupported(location, "Exact DateTime ticks/Kind values cannot be compared with legacy native Date Time values before a faithful codec exists");
    }
    private SourceValue LiftedTemporalCompound(ICompoundAssignmentOperation op, SourceValue target, SourceValue left, SourceValue right, JsonArray steps)
    {
        if (!target.Type.Nullable) throw Unsupported(op, "Lifted temporal assignment requires an optional target");
        var result = Temp(target.Type); var present = "(" + Present(left) + " and " + Present(right) + ")";
        Assign(steps, result.Text + ".HasValue", present); var branch = new JsonArray();
        var computed = TemporalBinary(op.OperatorKind, Payload(left), Payload(right), branch, op) ?? throw Unsupported(op, "Lifted temporal operator is not defined");
        Store(branch, new(result.Text + ".Value", target.Type with { Nullable = false }), computed, op);
        steps.Add(new JsonObject { ["if"] = present, ["then"] = branch }); Store(steps, target, result, op); return target;
    }
    private SourceValue? TemporalUnary(IUnaryOperation op, SourceValue value, JsonArray steps)
    {
        if (value.Type.Temporal != TemporalKind.TimeSpan) return null;
        if (op.OperatorKind == UnaryOperatorKind.Plus) return value;
        if (op.OperatorKind != UnaryOperatorKind.Minus) throw Unsupported(op, "Duration unary operation is not defined");
        if (!value.Type.Nullable) return DurationResult("-(" + TemporalScalar(value).Text + " + 0.0)", steps, DurationNegationOverflow);
        var result = Temp(Type(op.Type!)); Assign(steps, result.Text + ".HasValue", Present(value)); var branch = new JsonArray();
        var negated = DurationResult("-(" + TemporalScalar(Payload(value)).Text + " + 0.0)", branch, DurationNegationOverflow);
        Assign(branch, result.Text + ".Value", negated.Text); steps.Add(new JsonObject { ["if"] = Present(value), ["then"] = branch }); return result;
    }
    private SourceValue? ExtendedTemporalInvoke(IInvocationOperation op, SourceValue? owner, JsonArray steps)
    {
        var kind = TemporalModel.Kind(op.TargetMethod.ContainingType); var name = op.TargetMethod.Name;
        if (owner is { Type.Temporal: TemporalKind.None }) throw Unsupported(op, "Native Date Time has no exact ticks/Kind codec");
        if (kind is TemporalKind.DateOnly or TemporalKind.TimeOnly && name == "FromDateTime")
        {
            var dateTime = Value(op.Arguments[0].Value, steps);
            if (dateTime.Type.Temporal != TemporalKind.DateTime) throw Unsupported(op, "FromDateTime requires an exact ticks/Kind intermediate; native Date Time conversion is not implemented");
            var ticks = TemporalScalar(dateTime).Text;
            return TemporalValue(ExactTemporalType(kind), kind == TemporalKind.DateOnly ? Whole(ticks + " / " + TemporalModel.TicksPerDay + ".0")
                : "DecimalToLongInteger(Mod(" + ticks + ", " + TemporalModel.TicksPerDay + "))", steps);
        }
        if (kind == TemporalKind.TimeOnly && name == "ToTimeSpan" && op.Arguments.Length == 0)
            return TemporalValue(ExactTemporalType(TemporalKind.TimeSpan), TemporalScalar(owner!).Text, steps);
        if (kind == TemporalKind.TimeSpan && name.StartsWith("From", StringComparison.Ordinal)) return DurationFactory(op, steps);
        if (kind == TemporalKind.DateTimeOffset && name == "AddMinutes" && op.Arguments.Length == 1)
        {
            var argument = op.Arguments[0].Value; string delta;
            if (argument.ConstantValue is { HasValue: true, Value: double value } && double.IsFinite(value))
            {
                if (Math.Abs(value) > 5258964959d) { Guard(steps, "True", "ArgumentOutOfRangeException", "Value to add was out of range. (Parameter 'value')"); delta = "0"; }
                else { var whole = Math.Truncate(value); delta = DataModel.Constant((long)whole * TemporalModel.TicksPerMinute + (long)((value - whole) * TemporalModel.TicksPerMinute)); }
            }
            else if (argument is IConversionOperation { IsImplicit: true, Type.SpecialType: SpecialType.System_Double } converted && converted.Operand.Type is {} source && Range(source) is {} range
                && range.Minimum >= int.MinValue && range.Maximum <= uint.MaxValue)
                delta = "DecimalToLongInteger((" + Value(converted.Operand, steps).Text + " + 0.0) * 600000000.0)";
            else throw Unsupported(argument, "DateTimeOffset.AddMinutes needs a finite constant or an exact integral double conversion; arbitrary double semantics are not implemented");
            return ShiftTimestamp(owner!, delta, steps);
        }
        if (kind is TemporalKind.DateTimeOffset or TemporalKind.DateTime && name == "AddTicks" && op.Arguments.Length == 1)
            return ShiftTimestamp(owner!, Value(op.Arguments[0].Value, steps).Text, steps);
        if (kind is TemporalKind.DateTimeOffset or TemporalKind.DateTime && name is "Add" or "Subtract" && op.Arguments.Length == 1)
        {
            var argument = Value(op.Arguments[0].Value, steps);
            return TemporalBinary(name == "Add" ? BinaryOperatorKind.Add : BinaryOperatorKind.Subtract, owner!, argument, steps, op);
        }
        if (kind == TemporalKind.TimeSpan && name is "Add" or "Subtract" && op.Arguments.Length == 1)
            return TemporalBinary(name == "Add" ? BinaryOperatorKind.Add : BinaryOperatorKind.Subtract, owner!, Value(op.Arguments[0].Value, steps), steps, op);
        if (kind == TemporalKind.TimeSpan && name == "Negate" && op.Arguments.Length == 0)
            return DurationResult("-(" + TemporalScalar(owner!).Text + " + 0.0)", steps, DurationNegationOverflow);
        if (kind == TemporalKind.TimeOnly && name == "Add" && op.Arguments.Length == 1)
        {
            var argument = Value(op.Arguments[0].Value, steps); var day = TemporalModel.TicksPerDay;
            return TemporalValue(owner!.Type, "DecimalToLongInteger(Mod((" + TemporalScalar(owner).Text + " + 0.0) + " + day + " + Mod(" + TemporalScalar(argument).Text + ", " + day + "), " + day + "))", steps);
        }
        if (kind == TemporalKind.DateTimeOffset && name == "EqualsExact" && op.Arguments.Length == 1)
        {
            var right = Value(op.Arguments[0].Value, steps);
            return new("(" + owner!.Text + ".UtcTicks = " + right.Text + ".UtcTicks and " + owner.Text + ".OffsetMinutes = " + right.Text + ".OffsetMinutes)", Type(op.Type!));
        }
        return null;
    }
    private SourceValue DurationFactory(IInvocationOperation op, JsonArray steps)
    {
        if (op.Arguments.Length != 1) throw Unsupported(op, "Duration factory overload is not implemented");
        var argument = op.Arguments[0].Value; var name = op.TargetMethod.Name;
        if (name == "FromTicks") return TemporalValue(ExactTemporalType(TemporalKind.TimeSpan), Value(argument, steps).Text, steps);
        var factor = name switch { "FromDays" => TemporalModel.TicksPerDay, "FromHours" => 36000000000L, "FromMinutes" => TemporalModel.TicksPerMinute,
            "FromSeconds" => 10000000L, "FromMilliseconds" => 10000L, "FromMicroseconds" => 10L, _ => throw Unsupported(op, "Duration factory is not defined") };
        // Newer runtimes bind integer arguments to exact integer overloads, not to double.
        // Follow the bound signature: these overloads reject overflow with ArgumentOutOfRangeException.
        if (op.TargetMethod.Parameters[0].Type.SpecialType is SpecialType.System_Int32 or SpecialType.System_Int64)
        {
            var integer = Snapshot(Value(argument, steps), steps);
            var limit = decimal.Floor((decimal)long.MaxValue / factor);
            Guard(steps, integer.Text + " < -" + DataModel.Constant(limit) + " or " + integer.Text + " > " + DataModel.Constant(limit),
                "ArgumentOutOfRangeException", DurationOverflow);
            return TemporalValue(ExactTemporalType(TemporalKind.TimeSpan), "DecimalToLongInteger((" + integer.Text + " + 0.0) * " + factor + ".0)", steps);
        }
        // Fold only a bound BCL operation over a constant. No authored assembly or method runs.
        if (argument.ConstantValue is { HasValue: true, Value: double constant })
        {
            try
            {
                var duration = name switch { "FromDays" => TimeSpan.FromDays(constant), "FromHours" => TimeSpan.FromHours(constant), "FromMinutes" => TimeSpan.FromMinutes(constant),
                    "FromSeconds" => TimeSpan.FromSeconds(constant), "FromMilliseconds" => TimeSpan.FromMilliseconds(constant), _ => TimeSpan.FromMicroseconds(constant) };
                return TemporalValue(ExactTemporalType(TemporalKind.TimeSpan), DataModel.Constant(duration.Ticks), steps);
            }
            catch (Exception failure) when (failure is OverflowException or ArgumentException)
            { Guard(steps, "True", failure.GetType().Name, failure.Message); return TemporalValue(ExactTemporalType(TemporalKind.TimeSpan), "0", steps); }
        }
        if (argument is not IConversionOperation { IsImplicit: true, Type.SpecialType: SpecialType.System_Double } conversion || conversion.Operand.Type is not {} source || Range(source) is not {} range
            || range.Minimum < int.MinValue || range.Maximum > uint.MaxValue)
            throw Unsupported(argument, "Duration factory double semantics require a constant or a supported exact integral range");
        var value = Snapshot(Value(conversion.Operand, steps), steps); var maximum = decimal.Floor((decimal)long.MaxValue / factor);
        var oddFactor = factor; while (oddFactor % 2 == 0) oddFactor /= 2;
        var validMagnitude = Math.Min(maximum, Math.Max(Math.Abs(range.Minimum), Math.Abs(range.Maximum)));
        if (validMagnitude * oddFactor > 9007199254740992m) throw Unsupported(argument, "Duration factory multiplication may round; IEEE double lowering is required");
        Guard(steps, value.Text + " < -" + DataModel.Constant(maximum) + " or " + value.Text + " > " + DataModel.Constant(maximum), "OverflowException", DurationOverflow);
        return TemporalValue(ExactTemporalType(TemporalKind.TimeSpan), "DecimalToLongInteger((" + value.Text + " + 0.0) * " + factor + ".0)", steps);
    }
}
