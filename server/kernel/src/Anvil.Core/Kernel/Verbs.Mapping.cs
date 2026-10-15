using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// The Value of an assignment or an argument on a platform that keeps record mappings beside the expression (O11,
/// IRecordMappings): "Source mapTo { Field: value, ... }" writes Source as the expression and each field into the native
/// TypeConversion (one AttributeMapping per attribute of the target type, the others left empty). The text form reads a
/// mapping back the same way (FlowExtractor), so it is the same text both ways.
/// <list type="bullet">
/// <item>A flow text is the whole value: a Value without mapTo over an element that has an authored mapping empties it (the
/// text removed it). A plain Value written by raw verbs or JSON leaves an existing mapping alone; an explicit mapTo writes it.</item>
/// <item>The conversion follows both sides: a new assignment gets its Value before its Variable (FlowDiff writes the props
/// of a part in name order), and a changed Variable can change the target type after the Value is written. A mapping that
/// cannot be written yet waits and is written when another value of the same element is set; a flow text that ends with
/// one still waiting (in text or JSON) is refused with the reason (FLOW_MAPPING_TYPES), and nothing of the job is kept.</item>
/// </list>
/// </summary>
public sealed partial class ModelSession
{
    private readonly Dictionary<object, (string Given, string Source, List<(string Field, string Value)> Fields)> _pendingMappings = new(ReferenceEqualityComparer.Instance);
    // A mapping the platform writes in another form that says the same (IRecordMappings.Equivalent): the value as the text
    // gave it -> the value the action reads with now. The read back of a flow text takes it (and lists it).
    private readonly Dictionary<string, string> _mappingRewrites = new(StringComparer.Ordinal);

    // The fields of a mapping written over the element, in the platform's own form when it has one that says the same. Null
    // when written; otherwise why not yet.
    private string? WriteFields(IRecordMappings mappings, object target, string given, string source, List<(string Field, string Value)> fields)
    {
        var same = mappings.Equivalent(target, fields);
        var why = mappings.Write(target, same ?? fields);
        if (why == null && same != null) _mappingRewrites[given] = same.Count == 0 ? source : FlowMapping.Compose(source, same) ?? given;
        return why;
    }

    private JsonNode SetMappedValue(object target, System.Reflection.PropertyInfo property, IRecordMappings mappings, JsonNode? value, string path)
    {
        var given = value is JsonValue v && v.TryGetValue<string>(out var text) ? text : value?.ToString() ?? "";
        var split = FlowMapping.Split(given);
        // The source goes through the same rules as any expression; the fields are written as given. The expression is
        // written as SetCore writes one: its Text when the element has it, its setter (SetValue) while it has none (new).
        var source = Expression(target, "Value", split?.Source ?? given, path);
        JsonObject result;
        if (property.GetValue(target) is IExpression expression) {
            RememberData(target, "Value", JsonValue.Create(source), path);
            using (NativePerformanceCapture.MeasureSet(target.GetType(), "Value", "expression.Text")) expression.Text = source;
            result = new JsonObject { ["set"] = "Value", ["via"] = "expression.Text" };
        } else {
            var setter = FindMethod(target, "SetValue", 1) ?? throw new InvalidOperationException($"set Value on {Describe(target)}: no expression and no setter");
            var converted = Convert(JsonValue.Create(source), setter.GetParameters()[0].ParameterType);
            RememberValue(target, "Value", Remembered(converted, JsonValue.Create(source)), path);
            using (NativePerformanceCapture.MeasureSet(target.GetType(), "Value", "setter.Invoke")) setter.Invoke(target, [converted]);
            result = new JsonObject { ["set"] = "Value", ["via"] = setter.Name };
        }
        _pendingMappings.Remove(target);
        if (split is { } mapping) {
            if (WriteFields(mappings, target, given, source, mapping.Fields) == null) result["mapping"] = mapping.Fields.Count;
            else { _pendingMappings[target] = (given, source, mapping.Fields); result["mapping"] = "pending"; }
        } else if (_verbatim && mappings.Read(target) is { Authored: true, Fields.Count: > 0 }) {
            // A flow text without mapTo over an authored mapping: the text removed it.
            mappings.Write(target, []);
            result["mapping"] = 0;
        }
        return result;
    }

    // The mapping waiting for this element, written now that another of its values is set; null when none is waiting for it
    // or it still cannot be written.
    private JsonNode? WritePendingMapping(object target)
    {
        if (!_pendingMappings.TryGetValue(target, out var pending) || StudioAdapter.Runtime.Mappings is not { } mappings) return null;
        if (WriteFields(mappings, target, pending.Given, pending.Source, pending.Fields) != null) return null;
        _pendingMappings.Remove(target);
        return pending.Fields.Count;
    }

    // JSON writes the same native conversions as the text form. List every explicit mapping replaced by the platform's
    // equivalent form, at its original assign/argument pointer, before the per-op rewrite table is cleared.
    private void ReportJsonMappings(JsonObject data)
    {
        var declarations = data["actions"] as JsonArray ?? [];
        var sent = _applyOps != null && _applyIndex >= 0 && _applyIndex < _applyOps.Count
            ? _applyOps[_applyIndex]?["data"]?["actions"] as JsonArray ?? declarations : declarations;
        foreach (var declaration in declarations.OfType<JsonObject>()) {
            var index = sent.ToList().FindIndex(a => a?["name"]?.ToString() == declaration["name"]?.ToString()
                && a is JsonObject candidate && LogicOrder.Owner(candidate) == LogicOrder.Owner(declaration));
            if (index < 0) continue;
            foreach (var site in Preflight.LogicScan.Of(declaration).Expressions.Where(s => s.AllowsMapping))
                if (_mappingRewrites.TryGetValue(site.Text, out var written) && written != site.Text)
                    Normalized([Preflight.JobNormalizer.Entry("FLOW_MAPPING_PLATFORM", $"{OpsPointer ?? "/ops"}/{_applyIndex}/data/actions/{index}{site.Pointer}",
                        site.Text, written, "the explicit mapping is equivalent to the platform's native conversion: " + written)]);
        }
    }

    // At the end of text or JSON logic: every mapping still waiting is written once more (both sides are set by now); one that still
    // cannot be written refuses the text with the reason. A mapping over a value with no conversion at all (the platform takes
    // it as the target's type: a row of one record of the target's type, `Q.List.Current`) that copies every attribute of the
    // target from that record is the plain value, which is what the expression already holds (FLOW_MAPPING_PLATFORM).
    private void FlushPendingMappings(string pointer, FlowItem? action = null, IFlowTypes? types = null)
    {
        if (_pendingMappings.Count == 0 || StudioAdapter.Runtime.Mappings is not { } mappings) return;
        var left = new List<string>();
        foreach (var (target, pending) in _pendingMappings.ToList()) {
            if (WriteFields(mappings, target, pending.Given, pending.Source, pending.Fields) is not { } why) continue;
            if (action != null && types != null && mappings.Read(target) == null
                && ModelHost.Prop(target, "Variable") is IExpression variable && PlainRecord(action, variable.Text, pending.Source, pending.Fields, types)) {
                _mappingRewrites[pending.Given] = pending.Source;
                continue;
            }
            left.Add(pending.Source + " mapTo { " + string.Join(", ", pending.Fields.Select(f => f.Field + ": " + f.Value)) + " }: " + why);
        }
        _pendingMappings.Clear();
        if (left.Count == 0) return;
        throw new KernelRefusalException("FLOW_MAPPING_TYPES", "logic: " + left.Count + " mapping(s) cannot be written: " + string.Join(" | ", left),
            new JsonArray(left.Select(problem => (JsonNode)JobPreflight.PublicProblem(JobPreflight.Problem(null, pointer, "FLOW_MAPPING_TYPES", "error", problem,
                "map a record (or list) of one type to a record (or list) of another, naming attributes of the target type; the same type needs no mapTo"))).ToArray()));
    }
}
