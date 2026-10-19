using System.Collections;
using System.Text.Json.Nodes;
using Anvil.Core.Preflight;
using OutSystems.Model;

namespace Anvil.Core;

public sealed partial class ModelSession
{
    private static object? OptionalProperty(object? target, string name)
    {
        try { return target == null ? null : ModelHost.Prop(target, name); } catch { return null; }
    }

    private static string? ExpressionValue(object? value) => value is IExpression expression ? expression.Text : value as string;

    private static (IObjectSignature Call, IObjectSignature Callee, IObjectSignature Input, string InputName)? RequiredArgument(IObjectSignature owner)
    {
        for (var call = owner; call != null; call = call.Parent as IObjectSignature) {
            if (OptionalProperty(call, "Action") is not IObjectSignature callee) continue;
            string? inputName = null;
            for (var part = owner; part != null && !ReferenceEquals(part, call); part = part.Parent as IObjectSignature)
                if (OptionalProperty(part, "Parameter") is IObjectSignature parameter) { inputName = TypeResolver.Name(parameter); break; }
            inputName ??= TypeResolver.Name(owner);
            var input = callee.Children.OfType<IObjectSignature>().FirstOrDefault(p => (Implements(p, "IInputParameter") || Implements(p, "IInputParameterSignature"))
                && TypeResolver.Name(p) == inputName);
            if (input != null && inputName != null) return (call, callee, input, inputName);
        }
        return null;
    }

    private static (int Line, string Argument, string Node, string Callee)? RequiredArgumentFocus(IObjectSignature? owner, JsonObject? source)
    {
        try {
            if (owner == null || source == null || source["op"]?.ToString() != "logic" || RequiredArgument(owner) is not { } required) return null;
            var relative = TextOf(owner, source);
            if (relative == null) return null;
            var inner = "/data" + relative;
            var text = Text(source, inner) ?? Text(source, inner + "/text");
            var node = new KernelModelReader().DisplayOf(required.Call);
            var callee = TypeResolver.Name(required.Callee) ?? "";
            if (text == null || VerifySourceEdits.FlowCallLocation(text, node, callee) is not { } located) return null;
            return (located.Line, required.InputName, node, callee);
        } catch { return null; }
    }

    /// <summary>Corrections determined by the constructed model, still returned as edits of the original source.</summary>
    private static (string Fix, JsonArray Patch, string PatchRule)? ModelSourcePatch(MessageInfo message, IObjectSignature? owner, JsonObject? source, string? opPointer)
    {
        try { return ModelSourcePatchCore(message, owner, source, opPointer); }
        catch { return null; } // A best-effort correction never hides the platform's original diagnostic.
    }

    private static (string Fix, JsonArray Patch, string PatchRule)? ModelSourcePatchCore(MessageInfo message, IObjectSignature? owner, JsonObject? source, string? opPointer)
    {
        if (owner == null || source == null || opPointer == null) return null;
        if (message.Id == "ArgumentRequiredExpression" && source["op"]?.ToString() == "logic")
        {
            if (RequiredArgument(owner) is { } required)
            {
                var (call, callee, input, inputName) = required;
                var value = ExpressionValue(OptionalProperty(input, "DefaultValue"));
                var declaredDefault = !string.IsNullOrWhiteSpace(value);
                if (string.IsNullOrWhiteSpace(value))
                    value = VerifySourceEdits.TypeDefault(UiCatalog.TypeName(OptionalProperty(input, "DataType")) ?? "");
                if (value == null) return null;
                var relative = TextOf(owner, source);
                if (relative == null) return null;
                var inner = "/data" + relative;
                var text = Text(source, inner);
                if (text == null) { inner += "/text"; text = Text(source, inner); }
                if (text == null) return null;
                var written = VerifySourceEdits.AddFlowArgument(text, new KernelModelReader().DisplayOf(call), TypeResolver.Name(callee) ?? "", inputName!, value);
                if (written == null) return null;
                return ($"pass {inputName}={value}, " + (declaredDefault ? "the input's declared default" : "a type default to review; this input declares no default"),
                    ReplaceSource(opPointer + inner, written), declaredDefault ? "REQUIRED_ARGUMENT_DEFAULT" : "REQUIRED_ARGUMENT_TYPE_DEFAULT");
            }
        }
        if (message.Id == "ExpressionUnknownObject" && source["op"]?.ToString() == "html" && Unknown(message) is { } unknown)
        {
            for (var list = owner; list != null; list = list.Parent as IObjectSignature)
            {
                if (!Implements(list, "IList") || ExpressionValue(OptionalProperty(list, "Source")) is not { Length: > 0 } listSource) continue;
                // A simple list variable provides an unambiguous record type. Aggregates and expressions need their own rules.
                if (!System.Text.RegularExpressions.Regex.IsMatch(listSource, @"^[A-Za-z_][A-Za-z0-9_]*$")) return null;
                IObjectSignature? variable = null;
                for (var scope = list.Parent as IObjectSignature; scope != null && variable == null; scope = scope.Parent as IObjectSignature)
                    variable = scope.Children.OfType<IObjectSignature>().FirstOrDefault(v => TypeResolver.Name(v) == listSource && OptionalProperty(v, "DataType") != null);
                if (OptionalProperty(variable, "DataType") is not OutSystems.Model.Types.IListType type) return null;
                var attributes = (OptionalProperty(type.ElementType, "Attributes") as IEnumerable)?.Cast<object>().ToList() ?? [];
                var field = attributes.Select(a => TypeResolver.Name(a)).OfType<string>().FirstOrDefault(n => n.Equals(unknown, StringComparison.OrdinalIgnoreCase));
                if (field == null)
                {
                    // An owner-qualified identifier (OrderId inside Orders) reads the current record's Id.
                    var ids = attributes.Select(a => TypeResolver.Name(a)).OfType<string>().Where(n => n.Equals("Id", StringComparison.OrdinalIgnoreCase)).ToList();
                    var stem = unknown.EndsWith("Id", StringComparison.OrdinalIgnoreCase) ? unknown[..^2] : "";
                    var typeName = UiCatalog.TypeName(type.ElementType) ?? "";
                    if (ids.Count == 1 && stem.Length > 0 && (listSource.Contains(stem, StringComparison.OrdinalIgnoreCase) || typeName.Contains(stem, StringComparison.OrdinalIgnoreCase))) field = ids[0];
                }
                if (field == null) return null;
                var inner = source["data"]?["html"] is JsonValue ? "/data/html" : source["html"] is JsonValue ? "/html" : null;
                if (inner == null || Text(source, inner) is not { } html) return null;
                var written = VerifySourceEdits.QualifyListValue(html, listSource, unknown, field);
                if (written == null) return null;
                return ($"use {listSource}.Current.{field}, the attribute of the current list item", ReplaceSource(opPointer + inner, written), "LIST_ITEM_QUALIFIED");
            }
        }
        return null;
    }

    private static JsonArray ReplaceSource(string path, string value) => new(new JsonObject { ["op"] = "replace", ["path"] = path, ["value"] = value });

    private static void RememberSourceEdits(JsonObject source, string opPointer, JsonArray edits, Dictionary<string, string> finalText)
    {
        foreach (var edit in edits.OfType<JsonObject>())
        {
            if (edit["path"]?.ToString() is not { } path || !path.StartsWith(opPointer + "/", StringComparison.Ordinal) || edit["value"] is not JsonValue v || !v.TryGetValue<string>(out var text)) continue;
            var pieces = path[(opPointer.Length + 1)..].Split('/');
            JsonNode? node = source;
            for (var k = 0; k < pieces.Length - 1; k++)
                node = node is JsonArray array ? array[int.Parse(pieces[k])] : node?[pieces[k]];
            if (node is JsonArray list) list[int.Parse(pieces[^1])] = text;
            else if (node is JsonObject obj) obj[pieces[^1]] = text;
            else continue;
            finalText[path] = text;
        }
    }
}
