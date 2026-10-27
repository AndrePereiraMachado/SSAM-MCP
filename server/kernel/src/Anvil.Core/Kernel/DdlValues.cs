using System.Globalization;
using System.Text.Json.Nodes;

namespace Anvil.Reading;

// DL2 convergence: a value of the data text in the form the module stores it. The way back compares the text with the module's
// own text (DataDdl), which writes what the model stores; a value written in another form the set verb accepts (the schedule
// "When Published", which the set stores as WhenPublished; an enum value in another case or as the Studio shows it; a flag in
// another case; a number with a sign, leading zeros or spaces) is the same value, never a difference, or the edit compiles to
// the same set on every round and is refused (DDL_NOT_CONVERGED). One rule, the set verb's own (TimerScheduleValue,
// ValueAliases and the parse of the property's type, ModelSession.Convert), for the compile (DdlCompiler), the fixed-point
// check (DdlCheck) and the set itself, so they cannot disagree. A value the type does not parse is left as written: the set
// then refuses it, naming the element, the property and the values it takes.
public static class DdlValues
{
    // The value of `property` of an element of `kind` in the module's stored form; `stored` is the type of the property in the
    // model (null when unknown: then only the rules of the text itself, the schedule and the Studio's names of enum values).
    public static string? Canonical(string kind, string property, string? value, Type? stored)
    {
        if (value == null) return null;
        if (property == "Schedule" && kind == "Timer") {
            try {
                var (prop, text) = Anvil.Core.TimerScheduleValue.Prepare(JsonValue.Create(value), supportsCron: false);
                if (prop == "Schedule") value = text;
            } catch (InvalidOperationException) { }
        }
        value = Anvil.Core.ValueAliases.Normalize(property, value);
        var type = stored == null ? null : Nullable.GetUnderlyingType(stored) ?? stored;
        return type == null ? value : Native(value, type) ?? value;
    }

    // Both values the same in the module's stored form (and no value, empty and False the same, as DdlRules.Same).
    public static bool Same(string kind, string property, string? a, string? b, Type? stored) =>
        DdlRules.Same(a, b) || DdlRules.Same(Canonical(kind, property, a, stored), Canonical(kind, property, b, stored));

    // The value parsed by the type as the set verb parses it (ModelSession.Convert), written back as the data text writes the
    // model's value (DdlModel.Text: True/False, the enum's name, the number's text); null when the type does not parse it or
    // is not one of these (an expression, a reference, a type: their text is the stored form).
    public static string? Native(string value, Type type)
    {
        if (type == typeof(string)) return value;
        if (type == typeof(bool)) return bool.TryParse(value, out var flag) ? (flag ? "True" : "False") : null;
        if (type == typeof(int)) return int.TryParse(value, NumberStyles.Integer, CultureInfo.CurrentCulture, out var i) ? i.ToString() : null;
        if (type == typeof(long)) return long.TryParse(value, NumberStyles.Integer, CultureInfo.CurrentCulture, out var l) ? l.ToString() : null;
        if (type == typeof(decimal)) return decimal.TryParse(value, NumberStyles.Number, CultureInfo.CurrentCulture, out var d) ? d.ToString() : null;
        if (type.IsEnum) return EnumName(type, value) is { } name ? Enum.Parse(type, name).ToString() : null;
        return null;
    }

    // A flag of the text as the set verb reads it for the property's native type: a Boolean takes True/False in any case
    // (bool.Parse; never Yes/No), an enum flag its own names in any case (AutoNumber: No, Yes, YesIfEmpty; any but No is set);
    // without the type, only the text's own words (`required` writes True, `auto` writes Yes). Null: not a value of the type
    // (or none): never a flag set, and the set refuses it, naming the element and the property.
    public static bool? Flag(string? value, Type? type)
    {
        if (value == null) return null;
        var t = type == null ? null : Nullable.GetUnderlyingType(type) ?? type;
        if (t == typeof(bool)) return bool.TryParse(value, out var flag) ? flag : null;
        if (t != null && t.IsEnum) return EnumName(t, value) is { } name ? !string.Equals(name, "No", StringComparison.Ordinal) : null;
        return value switch { "True" or "Yes" => true, "False" or "No" => false, _ => null };
    }

    public static bool IsSet(string? value, Type? type) => Flag(value, type) == true;

    // A flag written in the property's native form (what a rule that fills one writes): True/False for a Boolean, the enum's
    // Yes/No for an enum flag; without the type, the text's word for it.
    public static string FlagText(bool set, Type? type, string word)
    {
        var t = type == null ? null : Nullable.GetUnderlyingType(type) ?? type;
        if (t == typeof(bool)) return set ? "True" : "False";
        if (t != null && t.IsEnum && EnumName(t, set ? "Yes" : "No") is { } name) return name;
        return set ? word : word == "Yes" ? "No" : "False";
    }

    // The name of the enum value `text` names: the same name in any case (what the set verb accepts); null when none does.
    public static string? EnumName(Type type, string text) =>
        Enum.GetNames(type).FirstOrDefault(n => string.Equals(n, text, StringComparison.OrdinalIgnoreCase));
}
