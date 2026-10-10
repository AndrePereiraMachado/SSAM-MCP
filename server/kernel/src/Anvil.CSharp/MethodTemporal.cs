using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private ValueType TemporalInteger(bool wide = false) => Type(model.Program.Compilation.GetSpecialType(wide ? SpecialType.System_Int64 : SpecialType.System_Int32));
    private SourceValue TemporalScalar(SourceValue value) => value.Type.Temporal == TemporalKind.None ? value
        : new(value.Text + "." + TemporalModel.Field(value.Type.Temporal), TemporalInteger(value.Type.Temporal != TemporalKind.DateOnly));
    private SourceValue TemporalValue(ValueType type, string scalar, JsonArray steps, string auxiliary = "0")
    {
        var result = Temp(type);
        Assign(steps, result.Text + "." + TemporalModel.Field(type.Temporal), scalar);
        if (type.Temporal == TemporalKind.DateTimeOffset) Assign(steps, result.Text + ".OffsetMinutes", auxiliary);
        if (type.Temporal == TemporalKind.DateTime) Assign(steps, result.Text + ".Kind", auxiliary);
        return result;
    }
    private static string Whole(string expression) => "DecimalToInteger(Trunc(" + expression + "))";
    private static string BeforeYear(string year) => "(365 * (" + year + " - 1) + " + Whole("(" + year + " - 1) / 4.0")
        + " - " + Whole("(" + year + " - 1) / 100.0") + " + " + Whole("(" + year + " - 1) / 400.0") + ")";
    private static string Leap(string year) => "(Mod(" + year + ", 4) = 0 and (Mod(" + year + ", 100) <> 0 or Mod(" + year + ", 400) = 0))";
    private static string BeforeMonth(string month, string year)
    {
        int[] starts = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
        var text = "334";
        for (var i = 10; i >= 0; i--) text = "If(" + month + " = " + (i + 1) + ", " + starts[i] + ", " + text + ")";
        return "(" + text + " + If(" + month + " > 2 and " + Leap(year) + ", 1, 0))";
    }
    private static string MonthDays(string month, string year) => "If(" + month + " = 2, If(" + Leap(year)
        + ", 29, 28), If(" + month + " = 4 or " + month + " = 6 or " + month + " = 9 or " + month + " = 11, 30, 31))";
    private (string Year, string Month, string Day, string DayOfYear) DateParts(SourceValue date, JsonArray steps)
    {
        var dayNumber = TemporalScalar(date).Text;
        var low = Temp(TemporalInteger()); var high = Temp(TemporalInteger()); var mid = Temp(TemporalInteger());
        Assign(steps, low.Text, "1"); Assign(steps, high.Text, "10000");
        var search = new JsonArray(); Assign(search, mid.Text, Whole("(" + low.Text + " + " + high.Text + ") / 2.0"));
        search.Add(new JsonObject { ["if"] = BeforeYear(mid.Text) + " <= " + dayNumber,
            ["then"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { [low.Text] = mid.Text } }),
            ["else"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { [high.Text] = mid.Text } }) });
        steps.Add(new JsonObject { ["while"] = high.Text + " - " + low.Text + " > 1", ["do"] = search });
        var dayOfYear = Temp(TemporalInteger()); Assign(steps, dayOfYear.Text, dayNumber + " - " + BeforeYear(low.Text) + " + 1");
        var month = Temp(TemporalInteger()); var day = Temp(TemporalInteger());
        Assign(steps, month.Text, "1"); Assign(steps, day.Text, dayOfYear.Text);
        var advance = new JsonArray(); Assign(advance, day.Text, day.Text + " - " + MonthDays(month.Text, low.Text));
        Assign(advance, month.Text, month.Text + " + 1");
        steps.Add(new JsonObject { ["while"] = day.Text + " > " + MonthDays(month.Text, low.Text), ["do"] = advance });
        return (low.Text, month.Text, day.Text, dayOfYear.Text);
    }
    private SourceValue TemporalProperty(IPropertyReferenceOperation op, JsonArray steps)
    {
        var kind = TemporalModel.Kind(op.Property.ContainingType);
        if (kind is TemporalKind.TimeSpan or TemporalKind.DateTimeOffset or TemporalKind.DateTime) return ExtendedTemporalProperty(op, steps);
        if (op.Instance == null)
        {
            var maximum = kind == TemporalKind.DateOnly ? TemporalModel.MaximumDayNumber : TemporalModel.TicksPerDay - 1;
            return op.Property.Name switch
            {
                "MinValue" => TemporalValue(Type(op.Type!), "0", steps),
                "MaxValue" => TemporalValue(Type(op.Type!), DataModel.Constant(maximum), steps),
                _ => throw Unsupported(op, "Temporal static property is not defined: " + op.Property)
            };
        }
        var owner = Value(op.Instance, steps); var scalar = TemporalScalar(owner);
        if (op.Property.Name == TemporalModel.Field(kind)) return scalar;
        if (kind == TemporalKind.DateOnly)
        {
            // DayOfWeek is a framework enum, not an authored static-entity declaration.
            if (op.Property.Name == "DayOfWeek") throw Unsupported(op, "Framework enum transport is not implemented");
            var parts = DateParts(owner, steps);
            return new(op.Property.Name switch { "Year" => parts.Year, "Month" => parts.Month, "Day" => parts.Day,
                "DayOfYear" => parts.DayOfYear, _ => throw Unsupported(op, "DateOnly property is not defined: " + op.Property) }, Type(op.Type!));
        }
        return TemporalClockComponent(scalar.Text, op.Property.Name, Type(op.Type!), op);
    }
    private SourceValue TemporalClockComponent(string ticks, string name, ValueType type, IOperation location)
    {
        var divisor = name switch { "Hour" => 36_000_000_000L, "Minute" => 600_000_000L,
            "Second" => 10_000_000L, "Millisecond" => 10_000L, "Microsecond" => 10L, "Nanosecond" => 1L,
            _ => throw Unsupported(location, "Clock property is not defined: " + name) };
        var modulus = name switch { "Hour" => 24, "Minute" or "Second" => 60, "Nanosecond" => 10, _ => 1000 };
        var component = Whole("Mod(Trunc(" + ticks + " / " + divisor + ".0), " + modulus + ")");
        return new(name == "Nanosecond" ? "(" + component + " * 100)" : component, type);
    }
    private Dictionary<string, SourceValue> TemporalArguments(IEnumerable<IArgumentOperation> arguments, JsonArray steps)
    {
        var result = new Dictionary<string, SourceValue>(StringComparer.Ordinal);
        foreach (var argument in arguments) result.Add(argument.Parameter!.Name, Snapshot(Value(argument.Value, steps), steps));
        return result;
    }
    private SourceValue TemporalConstruct(IObjectCreationOperation op, JsonArray steps)
    {
        var type = Type(op.Type!);
        if (op.Arguments.Length == 0) return TemporalValue(type, "0", steps);
        if (type.Temporal is TemporalKind.TimeSpan or TemporalKind.DateTimeOffset or TemporalKind.DateTime) return ExtendedTemporalConstruct(op, type, steps);
        if (op.Arguments.Any(a => Range(a.Parameter!.Type) == null)) throw Unsupported(op, "Temporal constructor overload is not defined: " + op.Constructor);
        var args = TemporalArguments(op.Arguments, steps);
        if (type.Temporal == TemporalKind.DateOnly && args.Count == 3)
        {
            var year = args["year"].Text; var month = args["month"].Text; var day = args["day"].Text;
            Guard(steps, year + " < 1 or " + year + " > 9999 or " + month + " < 1 or " + month + " > 12 or " + day + " < 1 or " + day + " > " + MonthDays(month, year),
                "ArgumentOutOfRangeException", "Year, Month, and Day parameters describe an un-representable DateTime.");
            return TemporalValue(type, BeforeYear(year) + " + " + BeforeMonth(month, year) + " + " + day + " - 1", steps);
        }
        if (type.Temporal == TemporalKind.TimeOnly && args.Count == 1 && args.TryGetValue("ticks", out var ticks))
        {
            Guard(steps, ticks.Text + " < 0 or " + ticks.Text + " >= " + TemporalModel.TicksPerDay, "ArgumentOutOfRangeException",
                "Ticks must be between 0 and and TimeOnly.MaxValue.Ticks. (Parameter 'ticks')");
            return TemporalValue(type, ticks.Text, steps);
        }
        if (type.Temporal == TemporalKind.TimeOnly && args.TryGetValue("hour", out var hour) && args.TryGetValue("minute", out var minute))
        {
            var second = args.GetValueOrDefault("second")?.Text ?? "0";
            Guard(steps, hour.Text + " < 0 or " + hour.Text + " > 23 or " + minute.Text + " < 0 or " + minute.Text + " > 59 or " + second + " < 0 or " + second + " > 59",
                "ArgumentOutOfRangeException", "Hour, Minute, and Second parameters describe an un-representable DateTime.");
            var expression = "(" + hour.Text + " * 36000000000.0 + " + minute.Text + " * 600000000.0 + " + second + " * 10000000.0)";
            foreach (var name in new[] { "millisecond", "microsecond" })
            {
                if (!args.TryGetValue(name, out var component)) continue;
                Guard(steps, component.Text + " < 0 or " + component.Text + " > 999", "ArgumentOutOfRangeException",
                    "Valid values are between 0 and 999, inclusive. (Parameter '" + name + "')");
                expression += " + " + component.Text + (name == "millisecond" ? " * 10000.0" : " * 10.0");
            }
            return TemporalValue(type, "DecimalToLongInteger(" + expression + ")", steps);
        }
        throw Unsupported(op, "Temporal constructor overload is not defined: " + op.Constructor);
    }
    private SourceValue TemporalInvoke(IInvocationOperation op, JsonArray steps)
    {
        var kind = TemporalModel.Kind(op.TargetMethod.ContainingType);
        var owner = op.Instance == null ? null : Snapshot(Value(op.Instance, steps), steps);
        if (op.TargetMethod.Name == "ToString") return TemporalFormat(op, owner!, steps);
        if (ExtendedTemporalInvoke(op, owner, steps) is {} extended) return extended;
        if (kind == TemporalKind.TimeOnly && op.TargetMethod.Name is "AddMinutes" or "AddHours" && op.Arguments.Length == 1)
        {
            var factor = op.TargetMethod.Name == "AddMinutes" ? 600_000_000L : 36_000_000_000L;
            var delta = ExactTemporalUnitTicks(op.Arguments[0].Value, factor, steps);
            var tick = TemporalScalar(owner!).Text; var day = TemporalModel.TicksPerDay;
            return TemporalValue(Type(op.Type!), "DecimalToLongInteger(Mod((" + tick + " + 0.0) + " + day + " + Mod(" + delta + ", " + day + "), " + day + "))", steps);
        }
        if (op.Arguments.Any(a => a.Parameter!.RefKind != RefKind.None || a.Parameter.Type.SpecialType == SpecialType.System_Object))
            throw Unsupported(op, "Temporal overload is not defined: " + op.TargetMethod);
        var args = TemporalArguments(op.Arguments, steps);
        if (kind == TemporalKind.DateOnly && op.TargetMethod.Name == "FromDayNumber" && args.Count == 1)
        {
            var days = args["dayNumber"].Text;
            steps.Add(new JsonObject { ["if"] = days + " < 0 or " + days + " > " + TemporalModel.MaximumDayNumber,
                ["then"] = new JsonArray(new JsonObject { ["raise"] = model.Exception("ArgumentOutOfRangeException"),
                    ["message"] = DataModel.Constant("Day number must be between 0 and DateOnly.MaxValue.DayNumber. (Parameter 'dayNumber')\r\nActual value was ") + " + IntegerToText(" + days + ") + \".\"" }) });
            return TemporalValue(Type(op.Type!), days, steps);
        }
        if (kind == TemporalKind.DateOnly && op.TargetMethod.Name == "AddDays" && args.Count == 1)
        {
            var sum = Temp(Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Decimal)));
            Assign(steps, sum.Text, "(" + TemporalScalar(owner!).Text + " + 0.0) + " + args["value"].Text);
            Guard(steps, sum.Text + " < 0 or " + sum.Text + " > " + TemporalModel.MaximumDayNumber, "ArgumentOutOfRangeException", "Value to add was out of range. (Parameter 'value')");
            return TemporalValue(Type(op.Type!), "DecimalToInteger(" + sum.Text + ")", steps);
        }
        if (kind == TemporalKind.TimeOnly && op.TargetMethod.Name == "IsBetween" && args.Count == 2)
        {
            var value = TemporalScalar(owner!).Text; var start = TemporalScalar(args["start"]).Text; var end = TemporalScalar(args["end"]).Text;
            return new("If(" + start + " <= " + end + ", " + value + " >= " + start + " and " + value + " < " + end
                + ", " + value + " >= " + start + " or " + value + " < " + end + ")", Type(op.Type!));
        }
        if (owner != null && args.Count == 1 && args.Values.Single().Type.Temporal == kind)
        {
            var a = TemporalScalar(owner).Text; var b = TemporalScalar(args.Values.Single()).Text;
            if (op.TargetMethod.Name == "Equals") return new("(" + a + " = " + b + ")", Type(op.Type!));
            if (op.TargetMethod.Name == "CompareTo") return new("If(" + a + " < " + b + ", -1, If(" + a + " > " + b + ", 1, 0))", Type(op.Type!));
        }
        throw Unsupported(op, "Temporal call translation is not defined: " + op.TargetMethod);
    }
    // TimeOnly multiplies its double argument before converting to ticks. Emit integer
    // arithmetic only when that multiplication is provably exact for the entire source
    // integral type. This includes every Int32 minute displacement, but not arbitrary
    // Int32 hours or Int64 values. 600,000,000 = 2^9 * 1,171,875: multiplying
    // any Int32 magnitude by the odd factor needs at most 52 significant bits,
    // below double's 53-bit precision; the final tick product also fits Int64.
    // Constants retain the CLR double multiplication.
    private string ExactTemporalUnitTicks(IOperation argument, long factor, JsonArray steps)
    {
        if (argument.ConstantValue is { HasValue: true, Value: double value })
        {
            var ticks = value * factor;
            if (double.IsFinite(ticks) && ticks >= long.MinValue && ticks < 9223372036854775808.0)
                return DataModel.Constant((long)ticks);
            throw Unsupported(argument, "Temporal double-to-ticks conversion is outside the defined Int64 range");
        }
        if (argument is IConversionOperation { IsImplicit: true, Type.SpecialType: SpecialType.System_Double } conversion
            && conversion.Operand.Type is {} source && Range(source) is {} range)
        {
            var oddFactor = factor; while (oddFactor % 2 == 0) oddFactor /= 2;
            var maximum = Math.Max(Math.Abs(range.Minimum), Math.Abs(range.Maximum));
            if (maximum * oddFactor <= 9007199254740992m && maximum * factor <= long.MaxValue)
                return "DecimalToLongInteger((" + Value(conversion.Operand, steps).Text + " + 0.0) * " + factor + ".0)";
        }
        throw Unsupported(argument, "Temporal addition requires a constant or an integral source range whose double-to-ticks multiplication is exact");
    }
    private SourceValue TemporalFormat(IInvocationOperation op, SourceValue owner, JsonArray steps)
    {
        var formatArgument = op.Arguments.FirstOrDefault(a => a.Parameter?.Name == "format");
        var provider = op.Arguments.FirstOrDefault(a => a.Parameter?.Name is "provider" or "formatProvider")?.Value;
        while (provider is IConversionOperation conversion) provider = conversion.Operand;
        var kind = owner.Type.Temporal;
        if (kind is TemporalKind.None or TemporalKind.TimeSpan || formatArgument?.Value.ConstantValue.Value is not string format
            || provider is not IPropertyReferenceOperation { Instance: null, Property.Name: "InvariantCulture" } culture
            || culture.Property.ContainingType.ToDisplayString() != "System.Globalization.CultureInfo" || culture.Property.ContainingType.Locations.Any(l => l.IsInSource))
            throw Unsupported(op, "Temporal formatting requires an exact date/clock value, a constant supported numeric format and CultureInfo.InvariantCulture");
        if (format is "O" or "o") format = kind switch
        {
            TemporalKind.DateOnly => "yyyy-MM-dd", TemporalKind.TimeOnly => "HH:mm:ss.fffffff",
            TemporalKind.DateTimeOffset => "yyyy-MM-dd'T'HH:mm:ss.fffffffzzz",
            _ => throw Unsupported(op, "DateTime roundtrip formatting requires its Kind/timezone codec")
        };
        if (format.Length < 2) throw Unsupported(op, "Temporal standard format is not implemented: " + format);
        (string Year, string Month, string Day, string DayOfYear)? parts = null;
        var clockTicks = kind == TemporalKind.DateOnly ? "0" : ClockTicks(owner);
        string DateComponent(char token)
        {
            if (kind == TemporalKind.TimeOnly) throw Unsupported(op, "TimeOnly has no civil date component");
            if (parts == null)
            {
                var date = kind == TemporalKind.DateOnly ? owner : TemporalValue(ExactTemporalType(TemporalKind.DateOnly), Whole(clockTicks + " / " + TemporalModel.TicksPerDay + ".0"), steps);
                parts = DateParts(date, steps);
            }
            return token == 'y' ? parts.Value.Year : token == 'M' ? parts.Value.Month : parts.Value.Day;
        }
        static string Pad(string component, int count)
        {
            var text = "IntegerToText(" + component + ")";
            return count == 1 ? text : "(If(Length(" + text + ") < " + count + ", Substr(" + DataModel.Constant(new string('0', count))
                + ", 0, " + count + " - Length(" + text + ")), \"\") + " + text + ")";
        }
        var output = new List<string>(); var literal = new StringBuilder();
        void Flush() { if (literal.Length > 0) { output.Add(DataModel.Constant(literal.ToString())); literal.Clear(); } }
        for (var i = 0; i < format.Length;)
        {
            var c = format[i++];
            if (c == '\\') { if (i == format.Length) throw Unsupported(op, "Incomplete format escape"); literal.Append(format[i++]); continue; }
            if (c is '\'' or '"')
            {
                var closed = false;
                while (i < format.Length) { var quoted = format[i++]; if (quoted == c) { closed = true; break; }
                    if (quoted == '\\') { if (i == format.Length) break; quoted = format[i++]; } literal.Append(quoted); }
                if (!closed) throw Unsupported(op, "Unterminated format literal"); continue;
            }
            if (c is not ('y' or 'M' or 'd' or 'H' or 'm' or 's' or 'f' or 'z'))
            {
                if (char.IsLetter(c) || c == '%' || c == ':' && kind == TemporalKind.DateOnly || c == '/' && kind == TemporalKind.TimeOnly)
                    throw Unsupported(op, "Temporal format token is not implemented: " + c);
                literal.Append(c); continue;
            }
            Flush(); var count = 1; while (i < format.Length && format[i] == c) { count++; i++; }
            if (c is 'y' or 'M' or 'd')
            {
                if (count > 16 || c != 'y' && count > 2) throw Unsupported(op, "Temporal format token is not implemented: " + new string(c, count));
                var component = DateComponent(c); if (c == 'y' && count <= 2) component = "Mod(" + component + ", 100)";
                output.Add(Pad(component, count)); continue;
            }
            if (kind == TemporalKind.DateOnly) throw Unsupported(op, "DateOnly has no clock or offset component");
            if (c == 'f')
            {
                if (count > 7) throw Unsupported(op, "Temporal fractional seconds support at most seven digits");
                var divisor = 1; for (var digit = count; digit < 7; digit++) divisor *= 10;
                output.Add(Pad(Whole("Mod(" + clockTicks + ", 10000000) / " + divisor + ".0"), count)); continue;
            }
            if (c == 'z')
            {
                if (kind != TemporalKind.DateTimeOffset || count > 3) throw Unsupported(op, "Offset formatting requires a DateTimeOffset carrier and z/zz/zzz");
                var offset = owner.Text + ".OffsetMinutes";
                var sign = "If(" + offset + " < 0, \"-\", \"+\")";
                var hours = Pad(Whole("Abs(" + offset + ") / 60.0"), Math.Min(2, count));
                output.Add("(" + sign + " + " + hours + (count == 3 ? " + \":\" + " + Pad(Whole("Mod(Abs(" + offset + "), 60)"), 2) : "") + ")"); continue;
            }
            if (count > 2) throw Unsupported(op, "Numeric clock format supports one or two digits");
            var name = c == 'H' ? "Hour" : c == 'm' ? "Minute" : "Second";
            output.Add(Pad(TemporalClockComponent(clockTicks, name, TemporalInteger(), op).Text, count));
        }
        Flush(); return TextPayload(output.Count == 0 ? "\"\"" : "(" + string.Join(" + ", output) + ")");
    }
}
