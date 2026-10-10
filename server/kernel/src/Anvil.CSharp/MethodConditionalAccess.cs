using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private readonly Stack<SourceValue> conditionalReceivers = new();

    private SourceValue ConditionalInstance(IConditionalAccessInstanceOperation operation)
        => conditionalReceivers.TryPeek(out var receiver) ? receiver
            : throw Unsupported(operation, "Conditional-access instance has no enclosing receiver");

    private SourceValue ConditionalAccess(IConditionalAccessOperation operation, JsonArray steps, bool discard)
    {
        // The receiver may itself use an outer conditional instance. Capture it before pushing
        // this binding, and before evaluating arguments that can replace its source location.
        var receiver = Snapshot(Value(operation.Operation, steps), steps);
        if (!receiver.Type.Nullable && !receiver.Type.IsArenaReference)
            throw Unsupported(operation.Operation, "Conditional access requires represented null presence; a non-null annotation cannot provide a reference boundary codec");
        var isVoid = operation.Type == null || operation.Type.SpecialType == SpecialType.System_Void;
        var result = isVoid ? null : Absent(Type(operation.Type!), steps, operation);
        var present = new JsonArray();
        conditionalReceivers.Push(Payload(receiver));
        try
        {
            var value = Value(operation.WhenNotNull, present, discard: isVoid || discard);
            if (result != null) Store(present, result, value, operation.WhenNotNull);
        }
        finally { conditionalReceivers.Pop(); }
        steps.Add(new JsonObject { ["if"] = Present(receiver), ["then"] = present });
        // A void conditional access is used only for its emitted effects.
        return result ?? new("False", Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Boolean)));
    }

    private SourceValue? NullComparison(IBinaryOperation operation, JsonArray steps)
    {
        if (operation.OperatorKind is not (BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals)) return null;
        var leftNull = operation.LeftOperand.ConstantValue is { HasValue: true, Value: null };
        var rightNull = operation.RightOperand.ConstantValue is { HasValue: true, Value: null };
        if (!leftNull && !rightNull) return null;
        if (!operation.IsLifted && operation.OperatorMethod is { } custom && custom.ContainingType.SpecialType != SpecialType.System_String)
        {
            // The synthesized record equality operator has the standard null behavior. An
            // authored overload may execute arbitrary logic even when an operand is null.
            if (!custom.IsImplicitlyDeclared || !custom.ContainingType.IsRecord)
                throw Unsupported(operation, "Null comparison with a user-defined operator requires its bound implementation");
        }
        var operand = leftNull ? operation.RightOperand : operation.LeftOperand;
        // Roslyn may bind built-in reference equality through object. Inspect the original
        // typed reference instead of inventing an object transport or erasing user conversion.
        while (operand is IConversionOperation { OperatorMethod: null } conversion &&
            conversion.Type?.SpecialType == SpecialType.System_Object && conversion.Conversion.IsReference)
            operand = conversion.Operand;
        var value = Value(operand, steps);
        var present = Present(value);
        return new(operation.OperatorKind == BinaryOperatorKind.Equals ? "not (" + present + ")" : present, Type(operation.Type!));
    }
}
