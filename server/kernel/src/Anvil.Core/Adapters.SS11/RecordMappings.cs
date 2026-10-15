using OutSystems.Model;
using ServiceStudio.Model;
using ServiceStudio.Model.Interfaces;

namespace Anvil.Core;

/// <summary>
/// The record mapping of Service Studio 11 (IRecordMappings): an Assignment or an Argument (both IObjectWithTypeConversions)
/// keeps its mapping in ValueTypeConversion, a ServiceStudio.Model.TypeConversion that is no child of the element and no
/// property of the Model API interfaces (OutSystems.Model.*), so neither the module index nor the flow reader saw it. The
/// conversion lists one AttributeMapping per attribute of the target type: TargetValue (the attribute) and SourceValue (its
/// source expression, relative to the source record or item). The Studio creates the conversion as soon as the value's type
/// differs from the target's and keeps the mappings while the type stays (measured 2026-10-12 on Service Studio 11.55.91:
/// retarget, rewrite of the value, RefreshTypeConversions(true), save and load). IsUserVisible tells the conversion the
/// developer fills from the automatic one (a SQL list wrapped in its structure, an aggregate record narrowed to its entity).
/// </summary>
internal sealed class Ss11RecordMappings : IRecordMappings
{
    public bool Owns(object element) => element is Assignment or Argument;

    // The third owner of a conversion, the Send Email node (its AttachmentsTypeConversion), is read only so that the flow
    // reader can tell a node it does not carry whole (FlowExtractor makes it opaque); the text never writes it.
    private static TypeConversion? Conversion(object element) => element switch {
        Assignment assignment => assignment.ValueTypeConversion,
        Argument argument => argument.ValueTypeConversion,
        IObjectWithTypeConversions other => other.GetType().GetProperty("AttachmentsTypeConversion")?.GetValue(other) as TypeConversion,
        _ => null };

    private static string Text(object? expression) => expression is IExpression e ? e.Text ?? "" : "";

    public Anvil.Reading.NativeMapping? Read(object element)
    {
        if (Conversion(element) is not { } conversion) return null;
        if (!conversion.IsUserVisible) return new(false, []);
        var fields = new List<(string Field, string Value)>();
        foreach (var mapping in conversion.AttributesMappings) {
            var source = Text(mapping.SourceValue?.Value);
            if (source.Length > 0) fields.Add((Text(mapping.TargetValue?.Value), source));
        }
        return new(true, fields);
    }

    public string? Write(object element, IReadOnlyList<(string Field, string Value)> fields)
    {
        var conversion = Conversion(element);
        if (conversion == null && fields.Count > 0 && element is IObjectWithTypeConversions owner) {
            owner.RefreshTypeConversions(true);
            conversion = Conversion(element);
            // A value that names the output of a call node the same command created (GetSrc.Row) was resolved with the scope
            // the action had before the node: the scope caches of the action and its parts are dropped and the value read again,
            // so it has its type and the conversion follows.
            if (conversion == null && ModelHost.Prop(element, "Value") is IExpression { Text: { Length: > 0 } text } value) {
                ModelSession.RefreshScopes(element);
                value.Text = "";
                value.Text = text;
                owner.RefreshTypeConversions(true);
                conversion = Conversion(element);
            }
        }
        if (conversion == null)
            return fields.Count == 0 ? null : Describe(element) + " has no record conversion: its value and its target are not two different record (or list) types";
        var mappings = conversion.AttributesMappings.ToList();
        // An automatic conversion with no attribute to map (a SQL list wrapped in its structure) takes no mapping. One the
        // Studio maps by itself (a record whose attributes the target has under the same names: each from its namesake)
        // takes one: written, it becomes the developer's (IsUserVisible), unless it is that same default mapping.
        if (!conversion.IsUserVisible && fields.Count == 0) return null;
        // No fields over the developer's mapping: the value without a mapping. Where the Studio has a mapping of its own
        // (each attribute from its namesake) that one comes back and the conversion is automatic again; otherwise every
        // attribute is left empty (and the Verify says the mapping is missing).
        if (fields.Count == 0) {
            foreach (var mapping in mappings) mapping.SourceValue!.SetValue(Text(mapping.TargetValue?.Value));
            if (conversion.IsUserVisible) foreach (var mapping in mappings) mapping.SourceValue!.SetValue("");
            return null;
        }
        if (!conversion.IsUserVisible && mappings.Count == 0)
            return Describe(element) + ": " + conversion.SourceElementType + " converts to " + conversion.TargetElementType
                + " by itself (the Studio's automatic conversion, which has no mapping): write the value without mapTo";
        // Every field is checked before anything is written.
        var wanted = new Dictionary<AttributeMapping, string>(ReferenceEqualityComparer.Instance);
        foreach (var (field, value) in fields) {
            var mapping = mappings.FirstOrDefault(m => string.Equals(Text(m.TargetValue?.Value), field, StringComparison.Ordinal))
                ?? mappings.FirstOrDefault(m => string.Equals(Text(m.TargetValue?.Value), field, StringComparison.OrdinalIgnoreCase));
            if (mapping == null)
                return Describe(element) + ": " + conversion.TargetElementType + " has no attribute " + field + " (its attributes: "
                    + string.Join(", ", mappings.Select(m => Text(m.TargetValue?.Value))) + ")";
            if (!wanted.TryAdd(mapping, value)) return Describe(element) + ": the attribute " + field + " is mapped twice";
        }
        // A mandatory attribute of the target left empty is what the Verify refuses (AttributeMappingRequiredExpression, the Id of
        // an entity): refused here, with the value that fills it.
        var empty = mappings.Where(m => m.IsMandatory && !wanted.ContainsKey(m)).ToList();
        if (empty.Count > 0)
            return Describe(element) + ": the mandatory attribute" + (empty.Count > 1 ? "s " : " ") + string.Join(", ", empty.Select(m => Text(m.TargetValue?.Value)))
                + " of " + conversion.TargetElementType + " would be left empty, which the Verify refuses (AttributeMappingRequiredExpression): map "
                + (empty.Count > 1 ? "them" : "it") + " too, e.g. " + string.Join(", ", empty.Select(m => Text(m.TargetValue?.Value) + ": " + (Fill(m, conversion) ?? "<a value of its type>")));
        foreach (var mapping in mappings) {
            var value = wanted.GetValueOrDefault(mapping, "");
            if (Text(mapping.SourceValue?.Value) != value) mapping.SourceValue!.SetValue(value);
        }
        // The fields are the mapping the Studio derives by itself: the conversion stays automatic and reads as the plain value.
        if (!conversion.IsUserVisible && fields.Count > 0)
            return Describe(element) + ": the mapping is the one the Studio makes by itself (each attribute from the attribute of the same name): write the value without mapTo";
        return null;
    }

    public IReadOnlyList<(string Field, string Value)>? Equivalent(object element, IReadOnlyList<(string Field, string Value)> fields)
    {
        if (fields.Count == 0) return null;
        var conversion = Conversion(element);
        if (conversion == null && element is IObjectWithTypeConversions owner) {
            owner.RefreshTypeConversions(true);
            conversion = Conversion(element);
        }
        if (conversion == null) return null;
        var mappings = conversion.AttributesMappings.ToList();
        // Explicitly spelling the complete mapping the platform already supplies changes no value. Keep that automatic
        // conversion and let the caller list the normalization to the plain source. A partial, empty or swapped field is
        // not equivalent: it still has to be written and checked as an authored mapping.
        if (!conversion.IsUserVisible && mappings.Count > 0 && fields.Count == mappings.Count
            && mappings.All(mapping => fields.Count(field =>
                string.Equals(field.Field, Text(mapping.TargetValue?.Value), StringComparison.OrdinalIgnoreCase)
                && field.Value.Length > 0 && string.Equals(field.Value, Text(mapping.SourceValue?.Value), StringComparison.OrdinalIgnoreCase)) == 1)) return [];
        // The two conversions that have no mapping attribute by attribute: the automatic one (no mapping at all) and the one
        // that maps the target element whole (its one mapping is Value).
        var automatic = !conversion.IsUserVisible && mappings.Count == 0;
        var whole = mappings.Count == 1 && Text(mappings[0].TargetValue?.Value) == "Value";
        if (!automatic && !whole) return null;
        var target = Names(conversion.TargetElementType);
        var holders = Names(conversion.SourceElementType);
        if (target.Count == 0 || holders.Count == 0 || fields.Count != target.Count) return null;
        // Every attribute of the target once, each from its namesake in the same record of the item.
        string? record = null;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (field, value) in fields) {
            var dot = value.LastIndexOf('.');
            if (dot <= 0 || !target.Contains(field) || !seen.Add(field) || !string.Equals(value[(dot + 1)..], field, StringComparison.OrdinalIgnoreCase)) return null;
            var holder = value[..dot];
            if (record == null) record = holder;
            else if (!string.Equals(record, holder, StringComparison.Ordinal)) return null;
        }
        if (record == null || !holders.Contains(record)) return null;
        // The automatic conversion narrows a row of one record (its only attribute) to it; the whole-element mapping is the
        // Studio's own choice of the record of the target's type (the source it fills by itself).
        if (automatic) return holders.Count == 1 ? [] : null;
        return string.Equals(Text(mappings[0].SourceValue?.Value), record, StringComparison.Ordinal) ? [("Value", record)] : null;

        static HashSet<string> Names(object? type) =>
            (type != null && ModelHost.Prop(type, "Attributes") is System.Collections.IEnumerable attributes ? attributes.OfType<object>() : [])
                .Select(a => ModelHost.Prop(a, "Name")?.ToString() ?? "").Where(n => n.Length > 0).ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    // The value that fills a mandatory attribute when nothing of the source is meant for it: NullIdentifier() for the identifier
    // of an entity (or any identifier), the empty value of a basic type; null when the type says none. The attribute is the
    // object the target names (when the model answers it), else the identifier of the target's entity by name.
    private static string? Fill(AttributeMapping mapping, TypeConversion conversion)
    {
        var name = Text(mapping.TargetValue?.Value);
        try {
            var attribute = Referred(mapping.TargetValue).Concat(Referred(mapping.TargetValue?.Value)).FirstOrDefault(o => ModelHost.Prop(o, "DataType") != null);
            if (attribute != null) {
                if (attribute is IObjectSignature { Parent: IObjectSignature owner } && ReferenceEquals(ModelHost.Prop(owner, "IdentifierAttribute"), attribute)) return "NullIdentifier()";
                var type = ModelHost.Prop(attribute, "DataType") is { } dataType ? TypeResolver.Name(dataType) ?? dataType.ToString() ?? "" : "";
                if (Empty(type) is { } empty) return empty;
            }
            foreach (var property in new[] { "Entity", "EntityOrStructure", "Record", "Type", "Element" })
                if (ModelHost.Prop(conversion.TargetElementType, property) is { } record && ModelHost.Prop(record, "IdentifierAttribute") is { } identifier
                    && string.Equals(TypeResolver.Name(identifier), name, StringComparison.Ordinal)) return "NullIdentifier()";
        } catch (Exception) { }
        // An entity's identifier is named Id (the Studio's convention, and the Verify names it so).
        return name == "Id" ? "NullIdentifier()" : null;

        static IEnumerable<object> Referred(object? holder) =>
            holder != null && ModelHost.Prop(holder, "ReferedObjects") is System.Collections.IEnumerable referred ? referred.OfType<object>() : [];
        static string? Empty(string type) => type switch {
            _ when type.EndsWith("Identifier", StringComparison.Ordinal) => "NullIdentifier()",
            "Text" or "Email" or "Phone Number" or "Long Text" => "\"\"",
            "Integer" or "Long Integer" or "Decimal" or "Currency" => "0",
            "Boolean" => "False",
            "Date" => "NullDate()",
            "Time" => "NullTime()",
            "Date Time" => "#1900-01-01 00:00:00#",
            _ => null };
    }

    private static string Describe(object element) => element switch {
        Assignment assignment => "the assignment " + Text(ModelHost.Prop(assignment, "Variable")) + " = " + Text(ModelHost.Prop(assignment, "Value")),
        Argument argument => "the argument " + (ModelHost.Prop(argument, "Parameter") is IObjectSignature parameter ? ModelHost.Prop(parameter, "Name") : "?") + " = " + Text(ModelHost.Prop(argument, "Value")),
        _ => element.GetType().Name };
}
