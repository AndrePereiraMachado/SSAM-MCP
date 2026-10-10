using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private SourceValue ConcatenationArgument(IOperation operation, JsonArray steps)
    {
        // Built-in string concatenation lowers scalar operands through an implicit object
        // conversion. No object is transported; the existing scalar codecs format the value.
        while (operation is IConversionOperation { IsImplicit: true, OperatorMethod: null, Type.SpecialType: SpecialType.System_Object } conversion)
            operation = conversion.Operand;
        if (operation.ConstantValue is { HasValue: true, Value: null })
            return Absent(Type(model.Program.Compilation.GetSpecialType(SpecialType.System_String)) with { Nullable = true }, steps, operation);
        var value = Value(operation, steps);
        if (value.Type.Source.TypeKind == TypeKind.Enum)
            throw Unsupported(operation, "Enum string concatenation requires source enum formatting; its numeric storage is not its text representation");
        return value;
    }

    private SourceValue Concatenate(SourceValue left, SourceValue right, ValueType type, IBinaryOperation operation, JsonArray steps)
    {
        var expression = "(" + ConcatenatedText(left, operation) + " + " + ConcatenatedText(right, operation) + ")";
        if (Managed) return ManagedText(expression, steps);
        // Concatenation itself always yields present text, even when one or both operands are null.
        return Coerce(new(expression, type with { Nullable = false }), type, false, steps, operation);
    }
}
