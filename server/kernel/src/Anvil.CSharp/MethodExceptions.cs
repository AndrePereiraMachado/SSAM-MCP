using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private void RequireBuiltinException(IObjectCreationOperation exception)
    {
        if (!ExceptionTypes.IsException(exception.Type, model.Program.Compilation) || exception.Type!.Locations.Any(item => item.IsInSource) ||
            !ExceptionTypes.Builtins.ContainsKey(exception.Type.ToDisplayString()))
            throw Unsupported(exception, "Exception construction requires a supported BCL constructor; custom/source constructors cannot be replaced by a payload");
        if (exception.Initializer != null)
            throw Unsupported(exception, "Exception object initializers require their member effects to be translated");
    }
    private SourceValue ConstructExceptionValue(IObjectCreationOperation exception, JsonArray steps)
    {
        RequireBuiltinException(exception);
        if (!Managed) throw Unsupported(exception, "Exception values require an invocation-local identity context");
        if (exception.Arguments.Any(a => a.Parameter?.Name is not ("message" or "paramName" or "actualValue" or "innerException")))
            throw Unsupported(exception, "Exception payload translation is not defined for this constructor");
        var arguments = new Dictionary<string, SourceValue>(StringComparer.Ordinal);
        foreach (var argument in exception.Arguments)
        {
            if (argument.Parameter!.Name == "actualValue" && argument.Value.ConstantValue is { HasValue: true, Value: null }) continue;
            var value = argument.Parameter.Name == "actualValue" ? ReferenceArgument(argument.Value, steps) : Value(argument.Value, steps);
            arguments.Add(argument.Parameter.Name, Snapshot(value, steps));
        }
        var supplied = arguments.GetValueOrDefault("message");
        var qualified = exception.Type!.ToDisplayString();
        var defaultMessage = ExceptionTypes.Builtins[qualified].Message;
        var text = supplied == null ? DataModel.Constant(defaultMessage)
            : "If(" + Present(supplied) + ", " + Payload(supplied).Text + ", " + DataModel.Constant(ExceptionTypes.NullMessages[qualified]) + ")";
        var parameter = arguments.GetValueOrDefault("paramName");
        var present = parameter == null ? "False" : Present(parameter);
        var paramName = parameter == null ? "\"\"" : "If(" + present + ", " + Payload(parameter).Text + ", \"\")";
        text = "(" + text + " + If((" + present + ") and Length(" + paramName + ") > 0, \" (Parameter '\" + " + paramName + " + \"')\", \"\"))";
        var actual = arguments.GetValueOrDefault("actualValue");
        if (actual != null)
        {
            if (actual.Type.Native is not ("Integer" or "Long Integer" or "Text" or "Boolean") || actual.Type.IsArenaReference)
                throw Unsupported(exception, "Exception actual-value codec requires a represented scalar");
            text = "(" + text + " + If(" + Present(actual) + ", " + DataModel.Constant("\r\nActual value was ") + " + "
                + ConcatenatedText(actual, exception) + " + \".\", \"\"))";
        }
        var record = CreateReferenceException(steps, qualified, exception.Type.Name, text, paramName, present, actual);
        if (arguments.GetValueOrDefault("innerException") is { } inner)
        {
            if (!inner.Type.IsExceptionReference) throw Unsupported(exception, "InnerException requires an exception identity");
            Assign(steps, record.Text + ".InnerRef", inner.Text + ".Index");
        }
        var reference = Temp(Type(exception.Type));
        steps.Add(new JsonObject { ["call"] = "ListAppend", ["as"] = "AvExceptionAllocate" + ++calls,
            ["args"] = new JsonObject { ["List"] = Context + ".Exceptions", ["Element"] = record.Text } });
        Assign(steps, reference.Text + ".Index", Context + ".Exceptions.Length");
        return reference;
    }
    private static int? ExceptionHResult(string qualified) => ExceptionTypes.Builtins.TryGetValue(qualified, out var known) ? known.HResult : null;
}
