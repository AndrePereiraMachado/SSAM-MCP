using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// What the installed Model API puts on a widget it creates, per platform (docs/PROTOTIPO-NATIVO.md 3.2, "padroes do Model API
/// zerados"), and what the importer resets: the default caption children of buttons, links and labels, the sample items of a radio
/// group, the default Style (btn btn-primary, form-control, list list-group, popup-dialog...: the prototype's class replaces it) and
/// the Adaptive left margin that makes the runtime add ThemeGrid_MarginGutter. Width stays as created until the runtime DOM table
/// (etapa 0, 4.2) proves which value adds no class (a line not observed yet would be marked Inferred). <see cref="Observe"/>
/// creates one of each widget in a copy of a module and reads the same facts back, so a test of each lane (Anvil.Tests and
/// Anvil.Tests.Odc) compares this table with the installed Studio.
/// </summary>
public static class PrototypeWidgetDefaults
{
    public sealed record Defaults(string? Style, string? Width, string? MarginLeft, IReadOnlyList<string> Children, bool Inferred = false);

    /// <summary>The defaults observed in Service Studio 11.55.91 (O11) and ODC Studio (odc), per widget type (null: the property is
    /// unset on a new widget).</summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyDictionary<string, Defaults>> Table = new Dictionary<string, IReadOnlyDictionary<string, Defaults>>(StringComparer.Ordinal)
    {
        ["o11"] = new Dictionary<string, Defaults>(StringComparer.Ordinal)
        {
            ["IContainer"] = new(null, "(fill parent)", null, []),
            ["IAdvancedHtml"] = new(null, "(fill parent)", null, []),
            ["IButton"] = new("\"btn btn-primary\"", null, "Adaptive", ["Text"]),
            ["ILink"] = new(null, null, "Adaptive", ["Text"]),
            ["IExpression"] = new(null, null, "Adaptive", []),
            ["IInput"] = new("\"form-control\"", "(fill parent)", null, []),
            ["ICheckbox"] = new("\"checkbox\"", null, "Adaptive", []),
            ["IDropdown"] = new("\"dropdown\"", null, "Adaptive", []),
            ["ITextArea"] = new("\"form-control\"", "(fill parent)", null, []),
            ["IForm"] = new("\"form card\"", "(fill parent)", null, []),
            ["IList"] = new("\"list list-group\"", "(fill parent)", null, []),
            ["IPopup"] = new("\"popup-dialog\"", "(fill parent)", null, []),
            ["IImage"] = new(null, null, "Adaptive", []),
            ["ILabel"] = new(null, "(fill parent)", null, ["Text"]),
            ["IRadioGroup"] = new("\"radio-group\"", "(fill parent)", null, ["RadioButton", "RadioButton", "RadioButton"]),
        },
        ["odc"] = new Dictionary<string, Defaults>(StringComparer.Ordinal)
        {
            ["IContainer"] = new(null, "(fill parent)", null, []),
            ["IAdvancedHtml"] = new(null, "(fill parent)", null, []),
            ["IButton"] = new("\"btn btn-primary\"", null, "Adaptive", ["Text"]),
            ["ILink"] = new(null, null, "Adaptive", ["Text"]),
            ["IExpression"] = new(null, null, "Adaptive", []),
            ["IInput"] = new("\"form-control\"", "(fill parent)", null, []),
            ["ICheckbox"] = new("\"checkbox\"", null, "Adaptive", []),
            ["IDropdown"] = new("\"dropdown\"", null, "Adaptive", []),
            ["ITextArea"] = new("\"form-control\"", "(fill parent)", null, []),
            ["IForm"] = new("\"form card\"", "(fill parent)", null, []),
            ["IList"] = new("\"list list-group\"", "(fill parent)", null, []),
            ["IPopup"] = new("\"popup-dialog\"", "(fill parent)", null, []),
            ["IImage"] = new(null, null, "Adaptive", []),
            ["ILabel"] = new(null, "(fill parent)", null, ["Text"]),
            ["IRadioGroup"] = new("\"radio-group\"", "(fill parent)", null, []),
        },
    };

    /// <summary>The widget types the importer creates and the table covers.</summary>
    public static IEnumerable<string> Types => Table["o11"].Keys;

    /// <summary>Resets the defaults of a widget just created: default children deleted, the left margin that adds a grid class
    /// cleared, the default Style emptied (the spec writes the prototype's class right after).</summary>
    public static void Reset(object widget, string type, string platform, Func<object, string, object?> prop, Action<object, string, object?> set, Action<object> delete)
    {
        if (!Table.TryGetValue(platform, out var table) || !table.TryGetValue(type, out var defaults)) return;
        if (defaults.Children.Count > 0 && widget is IObjectSignature sig)
        {
            foreach (var child in DefaultChildren(sig).ToList()) delete(child);
        }
        if (defaults.MarginLeft is { Length: > 0 })
        {
            try { set(widget, "MarginLeft", ""); } catch { /* the property is not writable on this platform: the css lane's adapter neutralizes the class */ }
        }
        if (defaults.Style != null && prop(widget, "Style") is IExpression style) style.Text = "\"\"";
    }

    /// <summary>The children a widget is born with that the importer replaces: the caption Text of a button, link or label (beside
    /// it in O11, inside its Content in ODC) and the sample radio buttons.</summary>
    internal static IEnumerable<object> DefaultChildren(IObjectSignature widget)
    {
        foreach (var child in widget.Children.OfType<IObjectSignature>())
        {
            var name = child.GetType().Name;
            if (name is "Text" or "RadioButton") yield return child;
            else if (child.GetType().GetInterfaces().Any(i => i.Name == "IContent"))
                foreach (var inner in child.Children.OfType<IObjectSignature>().Where(c => c.GetType().Name is "Text")) yield return inner;
        }
    }

    /// <summary>The defaults the installed Model API gives to each widget type of the table, read from widgets created in a screen
    /// of <paramref name="omlPath"/> (a copy; nothing is saved): Style, Width, MarginLeft and the default children.</summary>
    public static JsonObject Observe(string omlPath, string work, string platform)
    {
        var host = new ModelHost(work);
        var espace = host.Load(omlPath);
        try { return ModelSession.ObservePrototypeDefaults(espace, platform); }
        finally { ModelHost.Release(espace); }
    }

    /// <summary>The differences between an observation and the table (empty when they agree).</summary>
    public static List<string> Diff(JsonObject observed, string platform)
    {
        var diffs = new List<string>();
        var table = Table[platform];
        foreach (var (type, d) in table)
        {
            if (observed[type] is not JsonObject o) { diffs.Add($"{type}: not created by the installed Model API"); continue; }
            string? Text(string key) => o[key]?.ToString();
            if (d.Style != (Text("Style") is { Length: > 0 } s ? s : null)) diffs.Add($"{type}.Style: table {d.Style ?? "(none)"}, installed {Text("Style") ?? "(none)"}");
            if (d.Width != Text("Width")) diffs.Add($"{type}.Width: table {d.Width ?? "(none)"}, installed {Text("Width") ?? "(none)"}");
            if (d.MarginLeft != Text("MarginLeft")) diffs.Add($"{type}.MarginLeft: table {d.MarginLeft ?? "(none)"}, installed {Text("MarginLeft") ?? "(none)"}");
            var children = (o["Children"] as JsonArray ?? []).Select(c => c!.ToString()).ToList();
            if (!d.Children.SequenceEqual(children)) diffs.Add($"{type}.Children: table [{string.Join(", ", d.Children)}], installed [{string.Join(", ", children)}]");
        }
        return diffs;
    }
}
