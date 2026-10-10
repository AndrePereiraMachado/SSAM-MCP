using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis.Operations;
using Microsoft.CodeAnalysis;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    internal readonly record struct IntegerRange(decimal Minimum, decimal Maximum, string Modulus)
    {
        public string Min => Minimum.ToString(System.Globalization.CultureInfo.InvariantCulture) + ".0";
        public string Max => Maximum.ToString(System.Globalization.CultureInfo.InvariantCulture) + ".0";
        public string Offset => (-Minimum).ToString(System.Globalization.CultureInfo.InvariantCulture) + ".0";
    }
    internal static IntegerRange? Range(ITypeSymbol type) => type is INamedTypeSymbol { TypeKind: TypeKind.Enum } enumeration
        ? Range(enumeration.EnumUnderlyingType!) : type.SpecialType switch
    {
        SpecialType.System_Byte => new(0, 255, "256.0"), SpecialType.System_SByte => new(-128, 127, "256.0"),
        SpecialType.System_Int16 => new(-32768, 32767, "65536.0"), SpecialType.System_UInt16 => new(0, 65535, "65536.0"),
        SpecialType.System_Int32 => new(int.MinValue, int.MaxValue, "4294967296.0"), SpecialType.System_UInt32 => new(0, uint.MaxValue, "4294967296.0"),
        SpecialType.System_Int64 => new(long.MinValue, long.MaxValue, "18446744073709551616.0"), _ => null
    };
    private SourceValue Numeric(BinaryOperatorKind kind, string left, string right, ValueType type, bool isChecked, JsonArray steps, IOperation source)
    {
        if (type.Nullable || type.Native is not ("Integer" or "Long Integer" or "Decimal") || type.Declaration != null)
            throw Unsupported(source, "Numeric operator requires a supported scalar numeric type");
        var symbol = kind switch { BinaryOperatorKind.Add => "+", BinaryOperatorKind.Subtract => "-", BinaryOperatorKind.Multiply => "*", BinaryOperatorKind.Divide => "/", BinaryOperatorKind.Remainder => "%", _ => null };
        if (symbol == null) throw Unsupported(source, "Numeric operator is not defined: " + kind);
        if (kind is BinaryOperatorKind.Divide or BinaryOperatorKind.Remainder)
        {
            Guard(steps, right + " = 0", "DivideByZeroException", "Attempted to divide by zero.");
            if (type.Source.SpecialType is SpecialType.System_Int32 or SpecialType.System_Int64)
            {
                var minimum = type.Native == "Integer" ? "-2147483648" : "-9223372036854775808.0";
                Guard(steps, "(" + left + " = " + minimum + ") and (" + right + " = -1)", "OverflowException", "Arithmetic operation resulted in an overflow.");
            }
        }
        if(type.Native=="Decimal")
        {
            var action=model.DecimalArithmetic(kind, representedFailure: Managed);var call="AvDecimal"+(++calls);
            steps.Add(new JsonObject {["call"]=action,["as"]=call,["args"]=new JsonObject {["Left"]=left,["Right"]=right}});
            // The primitive contains only this arithmetic expression. Convert its
            // failure at the original call site, where active filters and captured
            // caller state are still available and no source finally has unwound.
            if (Managed) Guard(steps, call + ".AvOverflow", "OverflowException", "Value was either too large or too small for a Decimal.");
            return new(call+".AvResult",type);
        }
        // Decimal intermediates avoid target integer overflow before the source checked/wrapping rule is applied.
        var l = "(" + left + " + 0.0)"; var r = "(" + right + " + 0.0)";
        string expression;
        if (type.Source.SpecialType == SpecialType.System_Int64 && kind == BinaryOperatorKind.Multiply && !ExactDecimalProduct(source))
            throw Unsupported(source, "Int64 multiplication needs word-based overflow lowering");
        if (kind == BinaryOperatorKind.Remainder) expression = "Mod(" + l + ", " + r + ")";
        else expression = "(" + l + " " + symbol + " " + r + ")";
        if (kind == BinaryOperatorKind.Divide) expression = "Trunc(" + expression + ")";
        return Integral(expression, type, isChecked, steps, source);
    }
    // Keep the full source checked/wrapping rule, but only form a Decimal product
    // after interval analysis proves every integer result is exactly representable.
    // Widening conversions preserve narrower source bounds; no business names matter.
    private static bool ExactDecimalProduct(IOperation operation)
    {
        static (decimal Min, decimal Max)? Bounds(IOperation value)
        {
            if (value.Type == null || Range(value.Type) is not {} target) return null;
            if (value.ConstantValue is { HasValue: true, Value: not null } constant)
            { var number = System.Convert.ToDecimal(constant.Value, System.Globalization.CultureInfo.InvariantCulture); return (number, number); }
            if (value is IConversionOperation { OperatorMethod: null } conversion && Bounds(conversion.Operand) is {} operand
                && operand.Min >= target.Minimum && operand.Max <= target.Maximum) return operand;
            return (target.Minimum, target.Maximum);
        }
        var operands = operation switch
        {
            IBinaryOperation binary => (binary.LeftOperand, binary.RightOperand),
            ICompoundAssignmentOperation compound => (compound.Target, compound.Value),
            _ => ((IOperation?)null, (IOperation?)null)
        };
        if (operands.Item1 == null || operands.Item2 == null || Bounds(operands.Item1) is not {} left || Bounds(operands.Item2) is not {} right) return false;
        try
        {
            _ = left.Min * right.Min; _ = left.Min * right.Max;
            _ = left.Max * right.Min; _ = left.Max * right.Max;
            return true;
        }
        catch (OverflowException) { return false; }
    }
    private SourceValue Integral(string expression, ValueType type, bool isChecked, JsonArray steps, IOperation source)
    {
        var wide = type.Native == "Long Integer";
        var range = Range(type.Source) ?? throw Unsupported(source, "Integer range is not defined for " + type.Source);
        var conversion = wide ? "DecimalToLongInteger" : "DecimalToInteger";
        if (isChecked)
        {
            var value = Temp(Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Decimal)));
            Assign(steps, value.Text, expression);
            Guard(steps, value.Text + " < " + range.Min + " or " + value.Text + " > " + range.Max, "OverflowException", "Arithmetic operation resulted in an overflow.");
            return new(conversion + "(" + value.Text + ")", type);
        }
        // Reduce first: an exact product may be Decimal.MaxValue-adjacent, so
        // adding the signed offset before Mod would overflow despite a valid wrap.
        return new(conversion + "(Mod(Mod(Mod(" + expression + ", " + range.Modulus + ") + " + range.Offset + ", " + range.Modulus + ") + " + range.Modulus + ", " + range.Modulus + ") - " + range.Offset + ")", type);
    }
}
