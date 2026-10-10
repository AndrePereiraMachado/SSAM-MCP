using System.Text.Json.Nodes;

namespace Anvil.CSharp;

internal sealed partial class ReferenceModel
{
    // Validate the fixed exception schema before invoking any source method. These are
    // ordinary native conditions and list loops, not execution of transmitted code.
    private static void ValidateExceptionGraph(JsonArray steps, Func<string, string> variable,
        Func<string, string, JsonObject> set, Action<JsonArray, string> guard,
        Action<JsonArray, string, Action<JsonArray, string>> loop)
    {
        const string arena = "AvGraphIn.Exceptions";
        loop(steps, arena + ".Length", (body, index) => {
            var cell = arena + "[" + index + "]";
            string Named(string name) => cell + ".TypeName = " + DataModel.Constant("System." + name);
            var argument = "(" + string.Join(" or ", new[] { Named("ArgumentException"), Named("ArgumentNullException"), Named("ArgumentOutOfRangeException") }) + ")";
            guard(body, "not (" + string.Join(" or ", ExceptionTypes.Builtins.Keys.Select(name => cell + ".TypeName = " + DataModel.Constant(name))) + ")");
            guard(body, cell + ".InnerRef < 0 or " + cell + ".InnerRef > " + arena + ".Length");
            guard(body, "not " + cell + ".HasHResult");
            guard(body, "(not " + cell + ".HasParamName and " + cell + ".ParamName <> \"\") or (" + cell + ".HasParamName and not " + argument + ")");
            guard(body, cell + ".HasActualValue and not (" + Named("ArgumentOutOfRangeException") + ")");
            guard(body, cell + ".InnerRef <> 0 and not (" + Named("ArgumentException") + ") and (" + cell + ".HasParamName or " + cell + ".HasActualValue)");
            var tags = new[] { ("System.Int32", "ActualValueInteger", "0"), ("System.Int64", "ActualValueLong", "0"),
                ("System.String", "ActualValueText", "\"\""), ("System.Boolean", "ActualValueBoolean", "False") };
            guard(body, "(" + cell + ".HasActualValue and not (" + string.Join(" or ", tags.Select(tag => cell + ".ActualValueType = " + DataModel.Constant(tag.Item1)))
                + ")) or (not " + cell + ".HasActualValue and " + cell + ".ActualValueType <> \"\")");
            foreach (var (tag, field, empty) in tags)
                guard(body, "(not " + cell + ".HasActualValue or " + cell + ".ActualValueType <> " + DataModel.Constant(tag) + ") and " + cell + "." + field + " <> " + empty);

            // The source runtime's complete Message is represented, including the
            // supported BCL parameter/actual-value suffix. Reject impossible payloads.
            var suffix = variable("Text");
            var actual = "If(" + cell + ".ActualValueType = \"System.Int32\", IntegerToText(" + cell + ".ActualValueInteger), "
                + "If(" + cell + ".ActualValueType = \"System.Int64\", LongIntegerToText(" + cell + ".ActualValueLong), "
                + "If(" + cell + ".ActualValueType = \"System.Boolean\", If(" + cell + ".ActualValueBoolean, \"True\", \"False\"), " + cell + ".ActualValueText)))";
            body.Add(set(suffix, "If(" + cell + ".HasParamName and Length(" + cell + ".ParamName) > 0, \" (Parameter '\" + " + cell + ".ParamName + \"')\", \"\")"
                + " + If(" + cell + ".HasActualValue, " + DataModel.Constant("\r\nActual value was ") + " + " + actual + " + \".\", \"\")"));
            guard(body, "Length(" + cell + ".Message) < Length(" + suffix + ")");
            guard(body, "Substr(" + cell + ".Message, Length(" + cell + ".Message) - Length(" + suffix + "), Length(" + suffix + ")) <> " + suffix);
        });
        // A linear color walk accepts shared/forward inners and rejects cycles. An
        // exception cannot have a cyclic inner through the supported constructors.
        var colors = variable("Integer List"); var current = variable("Integer");
        var append = "AvGraphExceptionColor";
        loop(steps, arena + ".Length", (body, _) => body.Add(new JsonObject {
            ["call"] = "ListAppend", ["as"] = append, ["args"] = new JsonObject { ["List"] = colors, ["Element"] = "0" } }));
        loop(steps, arena + ".Length", (body, index) => {
            body.Add(set(current, index + " + 1"));
            var walk = new JsonArray(set(colors + "[" + current + " - 1]", "1"), set(current, arena + "[" + current + " - 1].InnerRef"));
            body.Add(new JsonObject { ["while"] = current + " > 0 and " + colors + "[" + current + " - 1] = 0", ["do"] = walk });
            var present = new JsonArray(); guard(present, colors + "[" + current + " - 1] = 1");
            body.Add(new JsonObject { ["if"] = current + " > 0", ["then"] = present });
            body.Add(set(current, index + " + 1"));
            body.Add(new JsonObject { ["while"] = current + " > 0 and " + colors + "[" + current + " - 1] = 1",
                ["do"] = new JsonArray(set(colors + "[" + current + " - 1]", "2"), set(current, arena + "[" + current + " - 1].InnerRef")) });
        });
    }
}
