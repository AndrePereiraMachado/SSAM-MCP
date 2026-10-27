using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core;

/// <summary>Versioned, deterministic adapters into ssam-html/1 and ssam-flow/1, before either compiler binds a name.</summary>
public static class MigrationUiAdapters
{
    public const string Version = "1";
    public const string Rule = "MIGRATION_COMPONENT_NATIVE";

    public static List<JsonObject> Normalize(JsonArray ops, string? prefix)
    {
        var changes = new List<JsonObject>();
        foreach (var (op, index) in ops.OfType<JsonObject>().Select((o, i) => (o, i)).ToArray())
        {
            if (op["op"]?.ToString() != "html" || op["parent"] != null || op["data"]?["html"] is not JsonValue value) continue;
            var source = value.ToString();
            if (!source.Contains("<migration-", StringComparison.Ordinal)) continue;
            Result result;
            try { result = Expand(source); }
            catch (Exception error) when (error is ArgumentException or FormatException or InvalidOperationException) { continue; }
            op["data"]!["html"] = result.Html;
            if (result.Actions.Count > 0) ops.Insert(ops.IndexOf(op), new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = result.Actions.DeepClone() } });
            if (result.Flows.Count > 0) ops.Add(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(result.Flows.Select(x => (JsonNode)x).ToArray()) } });
            changes.Add(Preflight.JobNormalizer.Entry(Rule, prefix + "/" + index + "/data/html", source, result.Html,
                "Migration UI adapters v" + Version + ": native components, validation, downloads and temporal formatting; generated handlers are in the same job."));
        }
        return changes;
    }

    public sealed record Result(string Html, IReadOnlyList<string> Flows, JsonArray Actions);
    public static IEnumerable<JsonObject> Problems(JsonArray ops, string? prefix)
    {
        for (var i = 0; i < ops.Count; i++)
            // An op that is not an object, or a data that is not one, is the job's shape problem, said by the shape rules: never an
            // exception here (CheckJobStaticTests feeds such ops to the static check, integ/proto-into-product).
            if (ops[i] is JsonObject op && op["op"]?.ToString() == "html" && op["data"] is JsonObject data && data["html"] is JsonValue value
                && value.TryGetValue<string>(out var html) && html.Contains("<migration-", StringComparison.Ordinal))
            {
                string? error = null;
                try { Expand(html); }
                catch (Exception e) when (e is ArgumentException or FormatException or InvalidOperationException) { error = e.Message; }
                if (error != null) yield return JobPreflight.Problem(i, prefix + "/" + i + "/data/html", "MIGRATION_COMPONENT_INVALID", "error", error,
                    "Correct the component's declared state, source and native action contract; no partial adapter is applied.");
            }
    }
    public static Result Expand(string source)
    {
        var tree = ScreenHtml.Parse(source);
        var top = tree.Children.Single(n => !n.IsText);
        if (top.Tag is not ("screen" or "block")) throw new ArgumentException("MIGRATION_COMPONENT_ROOT: adapters require a screen or block document");
        var owner = Identifier(top.Get("name"), "owner");
        var flows = new List<string>();
        var helpers = new JsonArray();
        var actions = new List<string>();
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var vars = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var defaults = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var textVars = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var popupActions = new Dictionary<string, (string Open, string Cancel, string Save)>(StringComparer.Ordinal);
        var css = new StringBuilder();

        foreach (var node in ScreenDocument.Descendants(top).Where(n => n.Tag.StartsWith("migration-", StringComparison.Ordinal)).ToList())
        {
            var id = Identifier(node.Get("id"), "component id");
            if (!ids.Add(id)) throw new ArgumentException("MIGRATION_COMPONENT_DUPLICATE: " + id);
            string Action(string suffix, string body, string parameters = "")
            {
                var name = "Migrate" + id + suffix;
                actions.Add(name); flows.Add($"action {owner}.{name}\n{parameters}{body}  end\n"); return name;
            }
            switch (node.Tag)
            {
                case "migration-time":
                {
                    var semantics = Required(node, "semantics");
                    if (semantics is not ("date" or "client-local" or "instant")) throw new ArgumentException("TEMPORAL_SEMANTICS_REQUIRED");
                    var zone = node.Get("zone") ?? "";
                    if (semantics == "instant")
                    {
                        if (zone != "UTC" && !zone.Contains('/')) throw new ArgumentException("TEMPORAL_ZONE_REQUIRED: use an IANA timezone");
                        try { TimeZoneInfo.FindSystemTimeZoneById(zone); }
                        catch (TimeZoneNotFoundException e) { throw new ArgumentException("TEMPORAL_ZONE_INVALID: " + zone, e); }
                    }
                    var format = node.Get("format") ?? (semantics == "date" ? "dd/MM/yyyy" : "dd/MM/yyyy HH:mm");
                    if (!Regex.IsMatch(format, "^(?:yyyy|MM|dd|HH|mm|ss|[-/: .])+$")) throw new ArgumentException("TEMPORAL_FORMAT_INVALID");
                    var value = Required(node, "value");
                    var function = owner + "_FormatTemporal";
                    if (!helpers.Any(h => h?["name"]?.ToString() == function)) helpers.Add(TemporalFunction(function));
                    node.Tag = "span"; Strip(node, "semantics", "zone", "format", "value"); node.Children.Clear();
                    node.Children.Add(new ScreenHtml.Node { Text = "{{ " + function + "(" + value + ", " + ScreenHtml.Literal(semantics) + ", " + ScreenHtml.Literal(zone) + ", " + ScreenHtml.Literal(format) + ") }}" });
                    break;
                }
                case "migration-popup":
                {
                    var show = Identifier(node.Get("show"), "popup show variable"); vars[show] = "Boolean";
                    var open = Action("Open", "  assign " + show + " = True\n");
                    var cancel = Action("Cancel", "  assign " + show + " = False\n");
                    var saveCall = Required(node, "save");
                    if (!ScreenDocument.ParseCall(saveCall, out _, out _)) throw new ArgumentException("MIGRATION_POPUP_SAVE: save must be a native action call");
                    var success = Identifier(node.Get("success"), "save success output");
                    var refresh = (node.Get("refresh") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(x => Identifier(x, "refresh source")).ToList();
                    var valid = node.Get("valid");
                    var indent = valid == null ? "  " : "    ";
                    var save = Action("Save", (valid == null ? "" : "  if " + valid + ":\n") + $"{indent}Saved = {saveCall}\n{indent}if Saved.{success}:\n" + string.Concat(refresh.Select(x => indent + "  refresh " + x + "\n"))
                        + indent + "  assign " + show + " = False\n");
                    popupActions[id] = (open, cancel, save);
                    node.Tag = "popup"; Strip(node, "save", "success", "refresh", "valid");
                    break;
                }
                case "migration-form":
                {
                    var submit = Required(node, "submit");
                    if (!ScreenDocument.ParseCall(submit, out _, out _)) throw new ArgumentException("MIGRATION_FORM_SUBMIT: submit must be a native action call");
                    var handler = Action("Submit", "  if " + id + ".Valid" + (node.Get("valid") is { } valid ? " and (" + valid + ")" : "") + ":\n    " + submit + "\n");
                    var buttons = ScreenDocument.Descendants(node).Where(n => n.Get("data-form-submit") == id).ToArray();
                    if (buttons.Length != 1) throw new ArgumentException("MIGRATION_FORM_SUBMIT: exactly one data-form-submit button is required");
                    if (buttons[0].Tag != "button") throw new ArgumentException("MIGRATION_FORM_SUBMIT: submit must be a native button");
                    Strip(buttons[0], "data-form-submit"); Set(buttons[0], "onclick", handler); Set(buttons[0], "os-onclick.BuiltInValidations", "ValidateAndContinue");
                    node.Tag = "form"; Strip(node, "submit", "valid");
                    break;
                }
                case "migration-tabs":
                case "migration-accordion":
                {
                    var accordion = node.Tag == "migration-accordion";
                    var active = Identifier(node.Get("active"), "active tab variable"); vars[active] = "Integer";
                    var tabs = node.Children.Where(n => !n.IsText).ToList();
                    if (tabs.Count == 0 || tabs.Any(n => n.Tag != (accordion ? "item" : "tab"))) throw new ArgumentException("MIGRATION_TABS: tabs require tab children; accordions require item children");
                    var values = new HashSet<int>(); var header = N("div", ("class", node.Get("header-class") ?? "migration-tab-header"), ("role", "tablist"));
                    var panels = new List<ScreenHtml.Node>();
                    foreach (var tab in tabs)
                    {
                        if (!int.TryParse(tab.Get("value"), NumberStyles.None, CultureInfo.InvariantCulture, out var number) || !values.Add(number)) throw new ArgumentException("MIGRATION_TABS_VALUE: tab values must be unique nonnegative integers");
                        var select = Action("Tab" + number, "  assign " + active + " = " + (accordion ? "If(" + active + " = " + number + ", -1, " + number + ")" : number.ToString()) + "\n");
                        var button = N("button", ("onclick", select), ("class", node.Get("button-class") ?? "migration-tab-button"),
                            ("role", "tab"), ("aria-selected", "{{ If(" + active + " = " + number + ", \"true\", \"false\") }}"));
                        button.Children.Add(new ScreenHtml.Node { Text = Required(tab, "label") }); header.Children.Add(button);
                        var condition = N("div", ("if", active + " = " + number));
                        var panel = N("div", ("class", node.Get("panel-class") ?? "migration-tab-panel"), ("role", "tabpanel"));
                        panel.Children.AddRange(tab.Children); condition.Children.Add(panel); panels.Add(condition);
                        if (accordion) { panels.Insert(panels.Count - 1, button); header.Children.Remove(button); Set(button, "role", "button"); Strip(button, "aria-selected"); Set(button, "aria-expanded", "{{ If(" + active + " = " + number + ", \"true\", \"false\") }}"); }
                    }
                    defaults[active] = tabs[0].Get("value")!;
                    node.Tag = "div"; Strip(node, "active", "header-class", "button-class", "panel-class");
                    node.Children.Clear(); if (!accordion) node.Children.Add(header); node.Children.AddRange(panels);
                    css.AppendLine(".migration-tab-header{display:flex;flex-wrap:nowrap}.migration-tab-panel{min-width:0}");
                    break;
                }
                case "migration-upload":
                {
                    var content = Required(node, "content"); var filename = Required(node, "filename");
                    if (node.Get("max-bytes") == null && node.Get("extensions") == null) { node.Tag = "upload"; break; }
                    if (!int.TryParse(node.Get("max-bytes") ?? "0", out var maxBytes) || maxBytes < 0) throw new ArgumentException("MIGRATION_UPLOAD_SIZE: max-bytes must be a nonnegative integer");
                    var extensions = node.Get("extensions") ?? "";
                    if (extensions.Split(',', StringSplitOptions.RemoveEmptyEntries).Any(e => !Regex.IsMatch(e.Trim(), @"^\.[A-Za-z0-9]+$"))) throw new ArgumentException("MIGRATION_UPLOAD_EXTENSIONS: use comma-separated extensions such as .pdf,.png");
                    var valid = Identifier(node.Get("valid") ?? id + "Valid", "upload validity variable");
                    var error = Identifier(node.Get("error") ?? id + "Error", "upload error variable");
                    vars[valid] = "Boolean"; defaults[valid] = "True"; textVars.Add(error);
                    var helper = owner + "_Validate" + id; helpers.Add(UploadValidation(helper));
                    var handler = Action("Validate", "  Checked = " + helper + "(FileContent=" + content + ", FileName=" + filename + ", MaxBytes=" + maxBytes + ", Extensions=" + ScreenHtml.Literal(extensions) + ")\n  assign " + valid + " = Checked.Valid\n  assign " + error + " = Checked.ErrorText\n  assign " + id + ".Valid = Checked.Valid\n  assign " + id + ".ValidationMessage = Checked.ErrorText\n");
                    node.Tag = "upload"; Strip(node, "max-bytes", "extensions", "valid", "error"); Set(node, "onchange", handler);
                    break;
                }
                case "migration-download":
                {
                    var content = Required(node, "content"); var filename = Required(node, "filename");
                    var helper = owner + "_Download" + id;
                    helpers.Add(DownloadAction(helper));
                    var handler = Action("Download", "  " + helper + "(FileContent=" + content + ", FileName=" + filename + ", MimeType=" + ScreenHtml.Literal(node.Get("mime") ?? "application/octet-stream") + ")\n");
                    node.Tag = "button"; Strip(node, "content", "filename", "mime"); Set(node, "onclick", handler);
                    if (node.Children.Count == 0) node.Children.Add(new ScreenHtml.Node { Text = "Download" });
                    break;
                }
                case "migration-pager":
                {
                    var offset = Identifier(node.Get("offset"), "paging offset variable"); vars[offset] = "Integer";
                    var total = Required(node, "total"); var data = Identifier(node.Get("source"), "paging data source");
                    if (!int.TryParse(node.Get("size"), out var size) || size is < 1 or > 100) throw new ArgumentException("MIGRATION_PAGER_SIZE: size is between 1 and 100");
                    var pages = "Trunc((" + total + " + " + (size - 1) + ") / " + size + ")";
                    var last = "Max(0, (" + pages + " - 1) * " + size + ")";
                    var start = "Max(0, Min(Trunc(" + offset + " / " + size + ") - 2, " + pages + " - 5))";
                    var go = Action("Go", "  assign " + offset + " = Max(0, Min(StartIndex, " + last + "))\n  refresh " + data + "\n", "  in StartIndex: Integer\n");
                    var buttonClass = node.Get("button-class") ?? "migration-page-button";
                    ScreenHtml.Node Button(string text, string target, string enabled) {
                        var b = N("button", ("class", buttonClass), ("onclick", go + "(StartIndex = " + target + ")"), ("enabled", enabled));
                        b.Children.Add(new ScreenHtml.Node { Text = text }); return b;
                    }
                    node.Tag = "div"; Strip(node, "offset", "total", "source", "size", "button-class");
                    node.Children.Clear();
                    var bar = N("div", ("class", "migration-pager-items"));
                    bar.Children.Add(Button("‹", offset + " - " + size, offset + " > 0"));
                    var first = N("div", ("if", start + " > 0")); first.Children.Add(Button("1", "0", offset + " <> 0")); bar.Children.Add(first);
                    var leadingGap = N("div", ("if", start + " > 1")); leadingGap.Children.Add(new ScreenHtml.Node { Text = "…" }); bar.Children.Add(leadingGap);
                    for (var i = 0; i < 5; i++) {
                        var number = "(" + start + " + " + i + ")";
                        var condition = N("div", ("if", number + " < " + pages));
                        condition.Children.Add(Button("{{ IntegerToText(" + number + " + 1) }}", number + " * " + size, number + " * " + size + " <> " + offset));
                        bar.Children.Add(condition);
                    }
                    var trailingGap = N("div", ("if", start + " + 5 < " + pages + " - 1")); trailingGap.Children.Add(new ScreenHtml.Node { Text = "…" }); bar.Children.Add(trailingGap);
                    var lastPage = N("div", ("if", start + " + 5 < " + pages)); lastPage.Children.Add(Button("{{ IntegerToText(" + pages + ") }}", last, offset + " <> " + last)); bar.Children.Add(lastPage);
                    bar.Children.Add(Button("›", offset + " + " + size, offset + " + " + size + " < " + total));
                    node.Children.Add(bar);
                    css.AppendLine(".migration-pager-items{display:flex;align-items:center;flex-wrap:nowrap;gap:8px}");
                    break;
                }
                default: throw new ArgumentException("MIGRATION_COMPONENT_UNKNOWN: " + node.Tag);
            }
        }
        foreach (var node in ScreenDocument.Descendants(top))
            foreach (var attribute in new[] { "data-popup-open", "data-popup-cancel", "data-popup-save" })
                if (node.Get(attribute) is { } popupId)
                {
                    if (!popupActions.TryGetValue(popupId, out var target)) throw new ArgumentException("MIGRATION_POPUP_UNKNOWN: " + popupId);
                    Strip(node, "onclick", "href");
                    node.Attributes.Add(new("onclick", attribute == "data-popup-open" ? target.Open : attribute == "data-popup-cancel" ? target.Cancel : target.Save));
                    if (attribute == "data-popup-save") Set(node, "os-onclick.BuiltInValidations", "ValidateAndContinue");
                    Strip(node, attribute);
                }
        foreach (var (variable, type) in vars)
        {
            var existing = top.Children.FirstOrDefault(n => n.Tag == "var" && n.Get("name") == variable);
            if (existing == null) top.Children.Insert(0, N("var", ("name", variable), ("type", type), ("default", defaults.GetValueOrDefault(variable) ?? (type == "Boolean" ? "False" : "0"))));
            else if (existing.Get("type") != type) throw new ArgumentException("MIGRATION_COMPONENT_STATE_TYPE: " + variable + " must be " + type);
        }
        foreach (var variable in textVars)
        {
            var existing = top.Children.FirstOrDefault(n => n.Tag == "var" && n.Get("name") == variable);
            if (existing == null) top.Children.Insert(0, N("var", ("name", variable), ("type", "Text")));
            else if (existing.Get("type") != "Text") throw new ArgumentException("MIGRATION_COMPONENT_STATE_TYPE: " + variable + " must be Text");
        }
        if (actions.Count > 0) Set(top, "actions", string.Join(',', new[] { top.Get("actions") }.Where(x => !string.IsNullOrEmpty(x)).Concat(actions)));
        if (css.Length > 0) { var style = N("style"); style.Children.Add(new ScreenHtml.Node { Text = css.ToString() }); top.Children.Add(style); }
        return new(Write(top), flows, helpers);
    }

    private static JsonObject TemporalFunction(string name)
    {
        JsonObject Parameter(string n) => new() { ["name"] = n, ["type"] = "Text" };
        var inputs = new[] { "Value", "Semantics", "Zone", "Format" };
        using var reader = new StreamReader(typeof(MigrationUiAdapters).Assembly.GetManifestResourceStream("Anvil.Core.Kernel.TemporalRuntime.js")!);
        return new JsonObject {
            ["name"] = name, ["kind"] = "client", ["function"] = true,
            ["inputs"] = new JsonArray(inputs.Select(n => (JsonNode)Parameter(n)).ToArray()),
            ["outputs"] = new JsonArray(Parameter("Formatted")),
            ["steps"] = new JsonArray(new JsonObject {
                ["node"] = "IJavaScriptNode", ["as"] = "FormatValue",
                ["properties"] = new JsonObject { ["JavaScript"] = reader.ReadToEnd() + "\n$parameters.Formatted = ssamFormatTemporal($parameters.Value, $parameters.Semantics, $parameters.Zone, $parameters.Format);" },
                ["inputs"] = new JsonArray(inputs.Select(n => (JsonNode)Parameter(n)).ToArray()), ["outputs"] = new JsonArray(Parameter("Formatted")),
                ["args"] = new JsonObject(inputs.Select(n => KeyValuePair.Create(n, (JsonNode?)JsonValue.Create(n))))
            }, new JsonObject { ["assign"] = new JsonObject { ["Formatted"] = "FormatValue.Formatted" } })
        };
    }

    private static JsonObject DownloadAction(string name)
    {
        JsonArray Parameters() => new(new JsonObject { ["name"]="FileContent", ["type"]="Binary Data" },
            new JsonObject { ["name"]="FileName", ["type"]="Text" },new JsonObject { ["name"]="MimeType", ["type"]="Text" });
        return new JsonObject { ["name"] = name, ["kind"] = "client", ["inputs"] = Parameters(),
            ["steps"] = new JsonArray(new JsonObject { ["node"]="IJavaScriptNode", ["as"]="Download",
                ["properties"] = new JsonObject { ["JavaScript"] = Preflight.NodeRules.DownloadScript }, ["inputs"] = Parameters(),
                ["args"] = new JsonObject { ["FileContent"]="FileContent", ["FileName"]="FileName", ["MimeType"]="MimeType" } }) };
    }

    private static JsonObject UploadValidation(string name)
    {
        JsonArray Inputs() => new(new JsonObject { ["name"]="FileContent", ["type"]="Binary Data" },
            new JsonObject { ["name"]="FileName", ["type"]="Text" }, new JsonObject { ["name"]="MaxBytes", ["type"]="Integer" }, new JsonObject { ["name"]="Extensions", ["type"]="Text" });
        JsonArray Outputs() => new(new JsonObject { ["name"]="Valid", ["type"]="Boolean" }, new JsonObject { ["name"]="ErrorText", ["type"]="Text" });
        using var reader = new StreamReader(typeof(MigrationUiAdapters).Assembly.GetManifestResourceStream("Anvil.Core.Kernel.UploadValidationRuntime.js")!);
        var script = reader.ReadToEnd() + "\nvar result = ssamValidateUpload($parameters.FileContent, $parameters.FileName, $parameters.MaxBytes, $parameters.Extensions); $parameters.Valid = result.valid; $parameters.ErrorText = result.error;";
        return new JsonObject { ["name"]=name, ["kind"]="client", ["inputs"]=Inputs(), ["outputs"]=Outputs(),
            ["steps"]=new JsonArray(new JsonObject { ["node"]="IJavaScriptNode", ["as"]="CheckFile", ["inputs"]=Inputs(), ["outputs"]=Outputs(),
                ["properties"]=new JsonObject { ["JavaScript"]=script }, ["args"]=new JsonObject { ["FileContent"]="FileContent", ["FileName"]="FileName", ["MaxBytes"]="MaxBytes", ["Extensions"]="Extensions" } },
            new JsonObject { ["assign"]=new JsonObject { ["Valid"]="CheckFile.Valid", ["ErrorText"]="CheckFile.ErrorText" } }) };
    }

    private static ScreenHtml.Node N(string tag, params (string, string)[] attrs) => new() { Tag = tag, Attributes = attrs.Select(x => new KeyValuePair<string, string>(x.Item1, x.Item2)).ToList() };
    private static void Strip(ScreenHtml.Node node, params string[] attrs) => node.Attributes.RemoveAll(a => attrs.Contains(a.Key));
    private static void Set(ScreenHtml.Node node, string name, string value) { Strip(node, name); node.Attributes.Add(new(name, value)); }
    private static string Required(ScreenHtml.Node node, string name) => node.Get(name) is { Length: > 0 } value ? value : throw new ArgumentException("MIGRATION_COMPONENT_ATTRIBUTE: " + node.Tag + " requires " + name);
    private static string Identifier(string? value, string purpose) => value != null && Regex.IsMatch(value, "^[A-Za-z][A-Za-z0-9_]*$") ? value : throw new ArgumentException("MIGRATION_COMPONENT_NAME: invalid " + purpose);
    private static string Escape(string text) => text.Replace("&", "&amp;").Replace("<", "&lt;").Replace("\"", "&quot;");
    private static string Write(ScreenHtml.Node node)
    {
        if (node.IsText) return Escape(node.Text!);
        var open = "<" + node.Tag + string.Concat(node.Attributes.Select(a => " " + a.Key + "=\"" + Escape(a.Value) + "\""));
        if (node.Children.Count == 0) return open + "/>";
        return open + ">" + (node.Tag == "style" ? string.Concat(node.Children.Select(c => c.Text)) : string.Concat(node.Children.Select(Write))) + "</" + node.Tag + ">";
    }
}
