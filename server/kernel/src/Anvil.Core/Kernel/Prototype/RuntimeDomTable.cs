using System.Text;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>Whether a row of the runtime DOM table was read from a published page (evidence) or is still a reasoned guess
/// waiting for stage 0 (docs/PROTOTIPO-NATIVO.md, section 4.2). Every widget rendered through an inferred row is listed in
/// <c>fidelity.runtimeUnverified</c>, never hidden.</summary>
public enum RuntimeStatus { Evidence, Inferred }

/// <summary>An element the runtime puts around (or in place of) a widget's own element. <paramref name="Role"/>: "wrapper"
/// (no role in the prototype's layout: the adapters give it display:contents and the rewrites see through it), "backdrop"
/// (the popup overlay, which keeps its own box), "box" (the popup dialog box, display:contents).</summary>
public sealed record RuntimeWrapper(string Tag, IReadOnlyList<(string Name, string Value)> Attributes, IReadOnlyList<string> Classes, string Role = "wrapper")
{
    /// <summary>The CSS selector of this element alone: tag, runtime attributes (presence), classes.</summary>
    public string Selector => RuntimeDomTable.SelectorOf(Tag, Attributes, Classes);
}

/// <summary>A class the runtime adds from a property value. <paramref name="AvoidWith"/>: the property value that keeps the class
/// away (the compile lane writes it, 3.2); null when no value avoids it, and then <paramref name="Neutralize"/> is the rule of the
/// evidence that cancels it in the adapters block.</summary>
public sealed record RuntimeClass(string Class, string Property, string? When, string? AvoidWith, string? Neutralize, RuntimeStatus Status, string Evidence);

/// <summary>One widget type as the runtime renders it.
/// <paramref name="Element"/>: the tag, "{Tag}" for the widget's Tag property (IAdvancedHtml, IList in Custom mode), "#text" for a
/// bare text node, or null when the widget renders no element of its own (IIfWidget, the content of a block instance).
/// <paramref name="Transparent"/>: the element exists only at runtime (a block instance, a placeholder): its children are the
/// prototype's elements, so it behaves as a wrapper. <paramref name="Wrappers"/>: elements around the element, outermost first.
/// <paramref name="IdRule"/>: "name" (id = the widget Name), "none", or "block" (inside a block the runtime prefixes the id; the
/// exact rule comes from stage 0).</summary>
public sealed record RuntimeDomRow(
    string Widget,
    string? Element,
    IReadOnlyList<(string Name, string Value)> Attributes,
    string IdRule,
    IReadOnlyList<RuntimeClass> Classes,
    IReadOnlyList<RuntimeWrapper> Wrappers,
    RuntimeStatus Status,
    string Evidence,
    bool Transparent = false);

/// <summary>
/// The DOM the OutSystems runtime adds to each widget, per platform, frozen from evidence (docs/PROTOTIPO-NATIVO.md, 4.2): plain
/// C# data, no embedded resource. One table feeds the CSS rewrites (4.1 items 5 and 6), the adapters, the property values that
/// avoid runtime classes and the renderer of the fidelity measure (4.4). Stage 0 (the integrator, read only) adds rows here
/// without code changes; <see cref="Schema"/> is the shape of <c>docs/evidencias/runtime-dom-&lt;platform&gt;.json</c> and
/// <see cref="FromEvidence"/> reads it back, so the evidence file and these rows are checked against each other.
/// </summary>
public static class RuntimeDomTable
{
    private static (string, string)[] A(params (string, string)[] pairs) => pairs;
    private static readonly (string, string)[] None = [];
    private static readonly string[] NoClasses = [];
    private static readonly RuntimeClass[] NoRuntimeClasses = [];
    private static readonly RuntimeWrapper[] NoWrappers = [];

    // Evidence of 0.1: browser reads in the rollout of the official MCP run on Haiku_UI/FarmaVirtual (2026-10-10) and the
    // OSBlockWidget selectors of two client stylesheets of kernel/tests/html.
    private const string Rollout = "outerHTML read in the browser, rollout 2026-10-10T00-54-57 (Haiku_UI/FarmaVirtual)";
    private const string ClientCss = "two client stylesheets of kernel/tests/html: approval (.av-badges>.OSBlockWidget), mass casualty ([data-block*=\"MC_\"])";
    private const string Stage0 = "stage 0 (docs/PROTOTIPO-NATIVO.md 4.2): no published instance read yet";
    private const string Competitor = "neutralization the official MCP run needed: C:\\Users\\andre\\.codex\\native-farmavirtual (visual-audit.txt items 5 and 13)";

    private static RuntimeDomRow[] Common(RuntimeStatus proven) =>
    [
        new("ILink", "a", A(("data-link", ""), ("href", "#")), "name", NoRuntimeClasses, NoWrappers, proven, proven == RuntimeStatus.Evidence ? Rollout + ": <a data-link=\"\" class=\"brand\" href=\"#\" id=\"Link8\">" : Stage0),
        new("IAdvancedHtml", "{Tag}", A(("data-advancedhtml", "")), "name", NoRuntimeClasses, NoWrappers, proven, proven == RuntimeStatus.Evidence ? Rollout + ": <span data-advancedhtml=\"\" class=\"brand-mark\" id=\"Element11\">" : Stage0),
        new("IContainer", "div", A(("data-container", "")), "name",
            [new RuntimeClass("OSInline", "Width", "(default)", null, ":where(div.OSInline){display:block}", proven, proven == RuntimeStatus.Evidence ? Rollout + ": <div data-container=\"\" class=\"icon OSInline\">; " + Competitor : Stage0),
             new RuntimeClass("ThemeGrid_MarginGutter", "MarginLeft", "(default)", null, ":where(.ThemeGrid_MarginGutter){margin-left:0}", proven, proven == RuntimeStatus.Evidence ? Rollout + ": <div data-container=\"\" class=\"OSInline ThemeGrid_MarginGutter\" id=\"Container14\">; " + Competitor : Stage0)],
            NoWrappers, proven, proven == RuntimeStatus.Evidence ? Rollout + " (when the two classes appear exactly: stage 0)" : Stage0),
        new("ITextWidget", "#text", None, "none", NoRuntimeClasses, NoWrappers, proven, proven == RuntimeStatus.Evidence ? Rollout + ": Farma<span …>Virtual</span> (text without wrapper)" : Stage0),
        new("ICheckbox", "input", A(("data-checkbox", ""), ("class", ""), ("type", "checkbox")), "name", NoRuntimeClasses,
            [new RuntimeWrapper("span", None, NoClasses)], proven, proven == RuntimeStatus.Evidence ? Rollout + ": <span><input data-checkbox=\"\" class=\"\" type=\"checkbox\" id=\"Input161\"></span>" : Stage0),
        new("IMobileBlockInstanceWidget", "div", A(("class", "OSBlockWidget"), ("data-block", "")), "none", NoRuntimeClasses, NoWrappers, proven,
            proven == RuntimeStatus.Evidence ? ClientCss + ": div.OSBlockWidget[data-block]" : Stage0, Transparent: true),
        // Inferred until stage 0 (4.2): the widgets with no published instance read yet.
        new("IIfWidget", null, None, "none", NoRuntimeClasses, NoWrappers, RuntimeStatus.Inferred, Stage0 + "; an If renders only the branch"),
        new("IExpression", "span", A(("data-expression", "")), "name", NoRuntimeClasses, NoWrappers, RuntimeStatus.Inferred, Stage0),
        new("IButton", "button", A(("data-button", ""), ("type", "button")), "name", NoRuntimeClasses, NoWrappers, RuntimeStatus.Inferred, Stage0),
        new("IInput", "input", A(("data-input", "")), "name", NoRuntimeClasses, NoWrappers, RuntimeStatus.Inferred, Stage0),
        new("ITextArea", "textarea", A(("data-textarea", "")), "name", NoRuntimeClasses, NoWrappers, RuntimeStatus.Inferred, Stage0),
        new("IDropdown", "select", A(("data-dropdown", "")), "name", NoRuntimeClasses,
            [new RuntimeWrapper("div", A(("data-dropdown-wrapper", "")), NoClasses)], RuntimeStatus.Inferred, Stage0 + "; visual-audit.txt item 4 (wrapper and a second arrow)"),
        new("IForm", "form", A(("data-form", ""), ("novalidate", "")), "name", NoRuntimeClasses, NoWrappers, RuntimeStatus.Inferred, Stage0),
        new("IList", "{Tag}", A(("data-list", "")), "name", NoRuntimeClasses, NoWrappers, RuntimeStatus.Inferred, Stage0 + "; Mode = Custom with Tag"),
        new("IPopup", null, None, "none", NoRuntimeClasses,
            [new RuntimeWrapper("div", None, ["popup-backdrop"], "backdrop"), new RuntimeWrapper("div", A(("data-popup", ""), ("role", "dialog")), ["popup-dialog"], "box")],
            RuntimeStatus.Inferred, Stage0),
        new("IPlaceholderWidget", "div", A(("data-placeholder", "")), "none", NoRuntimeClasses, NoWrappers, RuntimeStatus.Inferred, Stage0, Transparent: true),
        new("IPlaceholderContentWidget", null, None, "none", NoRuntimeClasses, NoWrappers, RuntimeStatus.Inferred, Stage0),
        new("IImage", "img", A(("data-image", "")), "name", NoRuntimeClasses, NoWrappers, RuntimeStatus.Inferred, Stage0),
        new("ILabel", "label", A(("data-label", "")), "name", NoRuntimeClasses, NoWrappers, RuntimeStatus.Inferred, Stage0),
        new("IRadioGroup", "div", A(("data-radio-group", "")), "name", NoRuntimeClasses, NoWrappers, RuntimeStatus.Inferred, Stage0),
        new("IRadioButton", "input", A(("data-radio-button", ""), ("type", "radio")), "name", NoRuntimeClasses, NoWrappers, RuntimeStatus.Inferred, Stage0),
    ];

    private static readonly RuntimeDomRow[] O11Rows = Common(RuntimeStatus.Evidence);
    // ODC: the same Reactive runtime, but no published ODC page has been read yet: every row waits for stage 0.
    private static readonly RuntimeDomRow[] OdcRows = Common(RuntimeStatus.Inferred);

    /// <summary>The rows of a platform ("o11" or "odc").</summary>
    public static IReadOnlyList<RuntimeDomRow> Rows(string platform) => IsOdc(platform) ? OdcRows : O11Rows;

    public static bool IsOdc(string platform) => string.Equals(platform, "odc", StringComparison.OrdinalIgnoreCase);

    /// <summary>The row of a widget type ("IContainer" or "Container"), or null when the table has none.</summary>
    public static RuntimeDomRow? Row(string platform, string widget)
    {
        var name = widget.StartsWith('I') && widget.Length > 1 && char.IsUpper(widget[1]) ? widget : "I" + widget;
        foreach (var row in Rows(platform)) if (row.Widget == name) return row;
        // Model API names that differ from the vocabulary (IText for a text widget, IBlockInstanceWidget on ODC).
        return name switch
        {
            "IText" => Row(platform, "ITextWidget"),
            "IBlockInstanceWidget" or "IWebBlockInstanceWidget" => Row(platform, "IMobileBlockInstanceWidget"),
            "IInlineExpression" => Row(platform, "IExpression"),
            _ => null,
        };
    }

    /// <summary>The popup's overlay selector (the target of the prototype's <c>dialog::backdrop</c> declarations, 4.1 item 8)
    /// and its dialog box selector.</summary>
    public static (string Backdrop, string Box) Popup(string platform)
    {
        var row = Row(platform, "IPopup")!;
        return (row.Wrappers.First(w => w.Role == "backdrop").Selector, row.Wrappers.First(w => w.Role == "box").Selector);
    }

    /// <summary>The elements the runtime renders as <c>span</c> that have no counterpart in the prototype, as the arguments of
    /// <c>span:not(:where(.ssam-icon, …))</c> (4.1 item 5): runtime attributes of a span element (IExpression) and span wrappers
    /// written by what they hold (the checkbox wrapper: <c>:has(&gt; [data-checkbox])</c>).</summary>
    public static IReadOnlyList<string> RuntimeSpans(string platform)
    {
        var found = new List<string>();
        foreach (var row in Rows(platform))
        {
            if (row.Element == "span" && row.Widget is not ("IAdvancedHtml" or "ILink"))
                found.Add(SelectorOf("", row.Attributes.Where(a => a.Name.StartsWith("data-", StringComparison.Ordinal)).ToList(), NoClasses));
            foreach (var wrapper in row.Wrappers.Where(w => w.Tag == "span"))
            {
                var inner = row.Attributes.FirstOrDefault(a => a.Name.StartsWith("data-", StringComparison.Ordinal));
                if (inner.Name != null) found.Add(":has(> [" + inner.Name + "])");
            }
        }
        return found.Distinct(StringComparer.Ordinal).ToList();
    }

    /// <summary>The selector of a row's own element: its tag (none for "{Tag}"), the runtime data-* attributes and the fixed
    /// classes the runtime always writes (the class attribute of the row).</summary>
    public static string ElementSelector(RuntimeDomRow row)
    {
        var fixedClasses = row.Attributes.Where(a => a.Name == "class").SelectMany(a => a.Value.Split(' ', StringSplitOptions.RemoveEmptyEntries)).ToList();
        var tag = row.Element is null or "#text" || row.Element.StartsWith('{') ? "" : row.Element;
        return SelectorOf(tag, row.Attributes.Where(a => a.Name.StartsWith("data-", StringComparison.Ordinal)).ToList(), fixedClasses);
    }

    /// <summary>tag + .class + [attr] (presence), as written in a selector. The class attribute is not a presence test.</summary>
    public static string SelectorOf(string tag, IReadOnlyList<(string Name, string Value)> attributes, IReadOnlyList<string> classes)
    {
        var sb = new StringBuilder(tag);
        foreach (var cls in classes) sb.Append('.').Append(cls);
        foreach (var (name, _) in attributes) if (name != "class" && name != "type" && name != "href" && name != "role" && name != "novalidate") sb.Append('[').Append(name).Append(']');
        return sb.ToString();
    }

    /// <summary>Widgets rendered through an inferred row, for <c>fidelity.runtimeUnverified</c>.</summary>
    public static bool Unverified(string platform, string widget) => Row(platform, widget) is not { Status: RuntimeStatus.Evidence };

    // ---- stage 0 ---------------------------------------------------------------------------------------------------------

    /// <summary>The shape of the stage 0 evidence file (<c>docs/evidencias/runtime-dom-o11.json</c>, <c>runtime-dom-odc.json</c>):
    /// one entry per widget with the outerHTML read and the fields of a row; plus the stylesheets that define the runtime
    /// classes (<c>OSInline</c>, <c>ThemeGrid_*</c>, <c>OSFillParent</c>, <c>popup-*</c>).</summary>
    public static JsonObject Schema() => new()
    {
        ["schema"] = "ssam-runtime-dom/1",
        ["fields"] = new JsonObject
        {
            ["platform"] = "o11 | odc",
            ["captured"] = "ISO-8601 UTC of the read",
            ["source"] = "the published page read (URL without query)",
            ["rows"] = new JsonArray(new JsonObject
            {
                ["widget"] = "Model API type, e.g. IContainer",
                ["element"] = "tag | {Tag} | #text | null",
                ["attributes"] = "[[name, value]] the runtime adds",
                ["id"] = "name | none | block",
                ["classes"] = "[{class, property, when, avoidWith, neutralize}]",
                ["wrappers"] = "[{tag, attributes, classes, role: wrapper|backdrop|box}] outermost first",
                ["transparent"] = "true when the element exists only at runtime (block instance, placeholder)",
                ["outerHTML"] = "the instance read, verbatim",
                ["status"] = "evidence",
            }),
            ["sheets"] = new JsonArray(new JsonObject { ["href"] = "stylesheet URL", ["defines"] = "[class names]" }),
        },
    };

    /// <summary>The rows of an evidence file (schema <see cref="Schema"/>), so stage 0 can compare them with <see cref="Rows"/>.</summary>
    public static IReadOnlyList<RuntimeDomRow> FromEvidence(JsonObject evidence)
    {
        static List<(string, string)> Pairs(JsonNode? node) => node is JsonArray array
            ? array.OfType<JsonArray>().Where(p => p.Count == 2).Select(p => (p[0]!.ToString(), p[1]?.ToString() ?? "")).ToList() : [];
        var rows = new List<RuntimeDomRow>();
        foreach (var item in evidence["rows"] as JsonArray ?? [])
        {
            if (item is not JsonObject row || row["widget"]?.ToString() is not { Length: > 0 } widget) continue;
            var status = row["status"]?.ToString() == "evidence" ? RuntimeStatus.Evidence : RuntimeStatus.Inferred;
            var reference = row["outerHTML"]?.ToString() ?? row["evidence"]?.ToString() ?? "";
            var classes = (row["classes"] as JsonArray ?? []).OfType<JsonObject>().Select(c => new RuntimeClass(
                c["class"]?.ToString() ?? "", c["property"]?.ToString() ?? "", c["when"]?.ToString(), c["avoidWith"]?.ToString(),
                c["neutralize"]?.ToString(), status, reference)).ToList();
            var wrappers = (row["wrappers"] as JsonArray ?? []).OfType<JsonObject>().Select(w => new RuntimeWrapper(
                w["tag"]?.ToString() ?? "div", Pairs(w["attributes"]), (w["classes"] as JsonArray ?? []).Select(c => c!.ToString()).ToList(),
                w["role"]?.ToString() ?? "wrapper")).ToList();
            rows.Add(new RuntimeDomRow(widget, row["element"]?.ToString(), Pairs(row["attributes"]), row["id"]?.ToString() ?? "name",
                classes, wrappers, status, reference, row["transparent"]?.GetValue<bool>() == true));
        }
        return rows;
    }

    /// <summary>The table as evidence JSON (the same schema), for the receipt and for stage 0 to diff.</summary>
    public static JsonObject ToJson(string platform) => new()
    {
        ["schema"] = "ssam-runtime-dom/1",
        ["platform"] = IsOdc(platform) ? "odc" : "o11",
        ["rows"] = new JsonArray(Rows(platform).Select(r => (JsonNode)new JsonObject
        {
            ["widget"] = r.Widget,
            ["element"] = r.Element,
            ["attributes"] = new JsonArray(r.Attributes.Select(a => (JsonNode)new JsonArray(a.Name, a.Value)).ToArray()),
            ["id"] = r.IdRule,
            ["classes"] = new JsonArray(r.Classes.Select(c => (JsonNode)new JsonObject
            {
                ["class"] = c.Class, ["property"] = c.Property, ["when"] = c.When, ["avoidWith"] = c.AvoidWith, ["neutralize"] = c.Neutralize,
            }).ToArray()),
            ["wrappers"] = new JsonArray(r.Wrappers.Select(w => (JsonNode)new JsonObject
            {
                ["tag"] = w.Tag,
                ["attributes"] = new JsonArray(w.Attributes.Select(a => (JsonNode)new JsonArray(a.Name, a.Value)).ToArray()),
                ["classes"] = new JsonArray(w.Classes.Select(c => (JsonNode)c).ToArray()),
                ["role"] = w.Role,
            }).ToArray()),
            ["transparent"] = r.Transparent,
            ["status"] = r.Status == RuntimeStatus.Evidence ? "evidence" : "inferred",
            ["evidence"] = r.Evidence,
        }).ToArray()),
    };
}
