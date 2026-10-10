using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    // O11 Length counts Unicode characters; C# string.Length counts UTF-16 code units.
    // The controller binds this fixed BCL primitive, never an authored implementation.
    private SourceValue Utf16Length(SourceValue text, JsonArray steps)
    {
        var intrinsic = FrameworkIntrinsic.Utf16Length;
        var call = "AvUtf16Length" + ++calls;
        steps.Add(new JsonObject { ["call"] = model.Require(intrinsic), ["as"] = call,
            ["args"] = new JsonObject { ["Value"] = text.Text } });
        return new(call + ".Result", Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Int32)));
    }

    private SourceValue TextIntrinsic(IInvocationOperation op, JsonArray steps)
    {
        var name = op.TargetMethod.Name;
        if (op.TargetMethod.IsStatic && name == "CompareOrdinal" && op.TargetMethod.Parameters.Length == 2
            && op.TargetMethod.Parameters.All(parameter => parameter.Type.SpecialType == SpecialType.System_String))
        {
            var values = new SourceValue[2];
            // Roslyn arguments retain source evaluation order; named arguments bind by ordinal.
            for (var index = 0; index < op.Arguments.Length; index++)
            {
                var argument = op.Arguments[index]; var value = Value(argument.Value, steps);
                if (op.Arguments.Skip(index + 1).Any(next => Effects(next.Value))) value = Snapshot(value, steps);
                values[argument.Parameter!.Ordinal] = value;
            }
            var result = Temp(Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Int32)));
            var present = new JsonArray();
            var comparison = OrdinalTextPayloads(Payload(values[0]), Payload(values[1]), present);
            Assign(present, result.Text, comparison.Text);
            var nullLeft = new JsonArray(); Assign(nullLeft, result.Text, "If(" + Present(values[1]) + ", -1, 0)");
            var nullRight = new JsonArray(); Assign(nullRight, result.Text, "1");
            steps.Add(new JsonObject { ["if"] = "not (" + Present(values[0]) + ")", ["then"] = nullLeft,
                ["else"] = new JsonArray(new JsonObject { ["if"] = "not (" + Present(values[1]) + ")", ["then"] = nullRight, ["else"] = present }) });
            return result;
        }
        if (op.TargetMethod.IsStatic && name is "IsNullOrEmpty" or "IsNullOrWhiteSpace" && op.Arguments.Length == 1)
        {
            var text = Value(op.Arguments[0].Value, steps);
            var boolean = Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Boolean));
            if (name == "IsNullOrEmpty")
                return new("(not (" + Present(text) + ") or Length(" + Payload(text).Text + ") = 0)", boolean);
            var result = Temp(boolean);
            Assign(steps, result.Text, "True");
            var present = new JsonArray();
            var trimmed = TrimText(Payload(text), true, true, present);
            Assign(present, result.Text, "Length(" + trimmed.Text + ") = 0");
            steps.Add(new JsonObject { ["if"] = Present(text), ["then"] = present });
            return result;
        }
        if (op.Instance != null && op.Arguments.Length == 0 && name is "Trim" or "TrimStart" or "TrimEnd")
            return TrimText(Dereference(Value(op.Instance, steps), steps), name != "TrimEnd", name != "TrimStart", steps);
        throw Unsupported(op, "String call translation is not defined: " + op.TargetMethod.ToDisplayString());
    }

    private SourceValue TrimText(SourceValue text, bool leading, bool trailing, JsonArray steps)
    {
        var helper = model.Require(FrameworkIntrinsic.Trim);
        var call = "AvTrim" + ++calls;
        steps.Add(new JsonObject { ["call"] = helper, ["as"] = call, ["args"] = new JsonObject {
            ["Value"] = text.Text, ["Leading"] = leading ? "True" : "False", ["Trailing"] = trailing ? "True" : "False" } });
        return TextPayload(call + ".Result");
    }

    // A native formatter/intrinsic produces present text. Label it as a payload;
    // ordinary Coerce adds the source string's presence when the value is stored.
    private SourceValue TextPayload(string expression)
    {
        var type = Type(model.Program.Compilation.GetSpecialType(SpecialType.System_String));
        return new(expression, Managed ? type with { Nullable = false, Category = RuntimeCategory.Value } : type);
    }

    private SourceValue OrdinalTextPayloads(SourceValue left, SourceValue right, JsonArray steps)
    {
        var call = "AvOrdinal" + ++calls;
        steps.Add(new JsonObject { ["call"] = model.Require(FrameworkIntrinsic.CompareOrdinal), ["as"] = call,
            ["args"] = new JsonObject { ["Left"] = left.Text, ["Right"] = right.Text } });
        return new(call + ".Result", Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Int32)));
    }
}
