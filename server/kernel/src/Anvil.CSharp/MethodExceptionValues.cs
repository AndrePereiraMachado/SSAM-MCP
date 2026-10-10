using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private void CheckExceptionReference(SourceValue value, JsonArray steps)
    {
        if (!value.Type.IsExceptionReference) throw new InvalidOperationException("Expected a typed exception identity");
        Guard(steps, value.Text + ".Index = 0", "NullReferenceException", "Object reference not set to an instance of an object.");
        Guard(steps, value.Text + ".Index < 0 or " + value.Text + ".Index > " + Context + ".Exceptions.Length",
            "InvalidOperationException", "Exception does not belong to this invocation.");
    }
    private SourceValue ExceptionRecord(SourceValue reference, JsonArray steps)
    {
        CheckExceptionReference(reference, steps);
        return Snapshot(new(Context + ".Exceptions[" + reference.Text + ".Index - 1]", NativeType(model.References.ExceptionType)), steps);
    }
    private void ThrowExceptionReference(SourceValue reference, JsonArray steps, bool check)
    {
        if (!reference.Type.IsExceptionReference) throw new InvalidOperationException("Throw requires a typed exception identity");
        if (check) CheckExceptionReference(reference, steps);
        // Throwing a value does not allocate or copy it. A later catch/rethrow can keep
        // this same identity independently of the variable that originally held it.
        Assign(steps, "AvCompletion.ExceptionRef", reference.Text + ".Index");
        FinishReference(steps, 2);
    }
    private SourceValue? ExceptionProperty(IPropertyReferenceOperation operation, JsonArray steps)
    {
        if (operation.Property.Name == "Name" && operation.Instance is IInvocationOperation invocation &&
            invocation.TargetMethod.Name == "GetType" && invocation.TargetMethod.Parameters.Length == 0 &&
            (invocation.TargetMethod.ContainingType.SpecialType == SpecialType.System_Object || ExceptionTypes.IsException(invocation.TargetMethod.ContainingType, model.Program.Compilation)) &&
            invocation.Instance != null && ExceptionTypes.IsException(invocation.Instance.Type, model.Program.Compilation))
        {
            var record = ExceptionRecord(Value(invocation.Instance, steps), steps);
            Guard(steps, "not (" + string.Join(" or ", ExceptionTypes.Builtins.Keys.Select(qualified => record.Text + ".TypeName = " + DataModel.Constant(qualified))) + ")",
                "InvalidOperationException", "Exception type has no supported source metadata.");
            var name = DataModel.Constant("Exception");
            foreach (var qualified in ExceptionTypes.Builtins.Keys.OrderDescending(StringComparer.Ordinal))
            {
                var symbol = model.Program.Compilation.GetSpecialType(SpecialType.System_Object).ContainingAssembly.GetTypeByMetadataName(qualified)!;
                name = "If(" + record.Text + ".TypeName = " + DataModel.Constant(qualified) + ", " + DataModel.Constant(symbol.Name) + ", " + name + ")";
            }
            return ManagedText(name, steps);
        }
        if (operation.Instance == null || !ExceptionTypes.IsException(operation.Instance.Type, model.Program.Compilation)) return null;
        var value = ExceptionRecord(Value(operation.Instance, steps), steps);
        switch (operation.Property.Name)
        {
            case "Message": return ManagedText(value.Text + ".Message", steps);
            case "HResult": return new(value.Text + ".HResult", Type(operation.Type!));
            case "InnerException":
                var inner = Temp(Type(operation.Type!)); Assign(steps, inner.Text + ".Index", value.Text + ".InnerRef"); return inner;
            default: throw Unsupported(operation, "Exception member has no identity-preserving lowering: " + operation.Property.Name);
        }
    }
    private SourceValue? ExceptionReferenceInvocation(IInvocationOperation invocation, JsonArray steps)
    {
        if (invocation.TargetMethod.ContainingType.SpecialType != SpecialType.System_Object || invocation.TargetMethod.Name != "ReferenceEquals") return null;
        var operands = invocation.Arguments.Select(argument => ExceptionOperand(argument.Value)).ToArray();
        if (!operands.Any(operand => ExceptionTypes.IsException(operand.Type, model.Program.Compilation))) return null;
        return ExceptionEquals(operands, steps, invocation);
    }
    private static IOperation ExceptionOperand(IOperation argument)
    {
        while (argument is IConversionOperation { IsImplicit: true, OperatorMethod: null, Type.SpecialType: SpecialType.System_Object } conversion)
            argument = conversion.Operand;
        return argument;
    }
    private SourceValue? ExceptionIdentityComparison(IBinaryOperation operation, JsonArray steps)
    {
        if (operation.OperatorKind is not (BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals) || operation.OperatorMethod != null) return null;
        var operands = new[] { ExceptionOperand(operation.LeftOperand), ExceptionOperand(operation.RightOperand) };
        if (!operands.Any(operand => ExceptionTypes.IsException(operand.Type, model.Program.Compilation))) return null;
        var equal = ExceptionEquals(operands, steps, operation);
        return operation.OperatorKind == BinaryOperatorKind.Equals ? equal : equal with { Text = "not (" + equal.Text + ")" };
    }
    private SourceValue ExceptionEquals(IOperation[] operands, JsonArray steps, IOperation operation)
    {
        SourceValue Argument(IOperation argument) => argument.ConstantValue is { HasValue: true, Value: null }
            ? Absent(Type(ExceptionTypes.Root(model.Program.Compilation)), steps, argument) : Value(argument, steps);
        var left = Snapshot(Argument(operands[0]), steps); var right = Argument(operands[1]);
        if ((!left.Type.IsExceptionReference && !left.Type.IsArenaReference) || (!right.Type.IsExceptionReference && !right.Type.IsArenaReference))
            throw Unsupported(operation, "ReferenceEquals requires represented exception/object identities");
        var equal = left.Type.IsExceptionReference && right.Type.IsExceptionReference ? left.Text + ".Index = " + right.Text + ".Index"
            : left.Text + ".Index = 0 and " + right.Text + ".Index = 0";
        return new("(" + equal + ")", Type(operation.Type!));
    }
}
