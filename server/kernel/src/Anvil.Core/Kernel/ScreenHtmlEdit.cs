using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Reading;

// ssam-html/1, the writing half of a screen that already exists (C2 of the plan "Texto do SSAM"): the model reads a screen or
// block (ScreenHtml, C1), edits the text and sends back only the elements it changed, each with its k; the difference between
// the reading and the edited text, element by element (k), becomes the native moves the platform has (create, set, delete,
// move, reorder), applied over the module the reading came from. Nothing is cleared and recreated: an element the edit did
// not touch keeps its ObjectKey, and so does an element whose properties changed. The result is read again and compared with
// the edited text: the edit is applied only when the text read back is the text sent (ScreenHtmlModule<T>.EditPlan.Verify).
// Free of Studio types: the native moves go through IScreenHtmlWriter (ModelSession implements it over the Model API).
public static class ScreenHtmlEdit
{
    // An html op is an edit of a reading when it carries the edit list, or the base of a reading with the screen it edits (the
    // whole document as the edit), or a base without a document. Everything else that holds a <screen>/<block> is the document
    // form (B1, ScreenDocument.IsDocumentOp): a new screen, which may carry the base of a reading only to keep what its
    // elements with k already had. One rule for the preflight and the apply: the two forms never overlap, so the order in
    // which a caller asks does not matter.
    public static bool IsEdit(JsonObject op) =>
        op["parent"] == null && op["data"] is JsonObject data
        && (data["edit"] != null || data["basedOn"] != null && (data["screen"] != null || !HoldsDocument(data)));

    private static bool HoldsDocument(JsonObject data) =>
        data["html"] is JsonValue html && html.TryGetValue<string>(out var text) && Anvil.Core.ScreenDocument.IsDocument(text);

    // Without the module (check-job, the preflight of a job): the shape of the op and the text of every edit, all at once.
    // Pointers relative to op.data.
    public static void Preflight(JsonObject data)
    {
        var problems = new JsonArray();
        void Add(string pointer, string code, string message, string fix) =>
            problems.Add(new JsonObject { ["pointer"] = pointer, ["code"] = code, ["severity"] = "error", ["message"] = message, ["fix"] = fix });
        if (data["screen"] is not JsonValue screen || !screen.TryGetValue<string>(out var name) || name.Length == 0)
            Add("/screen", Invalid, "html edit: 'screen' is required (the screen or block read: name, Kind:Name or @key)", "\"screen\": \"<the name ssam_map view html read>\"");
        if (data["basedOn"] is not JsonObject basedOn || basedOn["html"] is not JsonValue)
            Add("/basedOn", Invalid, "html edit: 'basedOn' {capture, html} is the reading the edit was written on (ssam_map view html answers it)", "\"basedOn\": {\"capture\": \"<sourceSha256>\", \"html\": \"<htmlSha256>\"}");
        var texts = new List<(string Pointer, string Text)>();
        if (data["edits"] != null) {
            // CX16: element edits of the reading. Their shape here; their addresses too when the store keeps the reading (ms, no
            // module), then the document they make is judged as the whole document would be.
            if (data["edit"] != null || data["html"] != null) Add("/edits", Invalid, "html edit: 'edits' (element edits of the reading) goes alone, without 'edit' or 'html'", "keep edits, or send the changed elements whole in edit");
            var shape = HtmlElementEdits.Shape(data["edits"]);
            foreach (var p in shape) problems.Add(p);
            if (shape.Count == 0 && data["edits"] is JsonArray edits && data["basedOn"] is JsonObject on && on["capture"]?.ToString() is { Length: > 0 } capture && on["html"]?.ToString() is { Length: > 0 } read
                && ModuleIndexStore.Default()?.LoadHtmlKeys(capture, read) is { } kept && kept["html"] is JsonValue keptHtml && keptHtml.TryGetValue<string>(out var baseText)) {
                var keys = (kept["keys"] as JsonObject)?.Where(p => p.Value is JsonValue).ToDictionary(p => p.Key, p => p.Value!.ToString(), StringComparer.Ordinal);
                var applied = HtmlElementEdits.Apply(baseText, edits, keys);
                foreach (var p in applied.Problems) problems.Add(p);
                if (applied.Problems.Count == 0) texts.Add(("/edits", applied.Document));
            }
        } else if (data["edit"] is JsonArray list) {
            for (var j = 0; j < list.Count; j++)
                if (list[j] is JsonValue v && v.TryGetValue<string>(out var text)) texts.Add(("/edit/" + j, text));
                else Add("/edit/" + j, Invalid, "each edit is a string: one element of the reading with its k", "\"<div k=\\\"w7\\\" ...>...</div>\"");
            if (list.Count == 0) Add("/edit", Invalid, "html edit: 'edit' is empty", "send the changed elements, each with its k");
        } else if (data["html"] is JsonValue whole && whole.TryGetValue<string>(out var document)) texts.Add(("/html", document));
        else Add("/edit", Invalid, "html edit: 'edit' (the changed elements, each with its k) or 'html' (the whole document) is required", "\"edit\": [\"<div k=\\\"w7\\\" ...>...</div>\"]");
        foreach (var (pointer, text) in texts) {
            try {
                var parsed = ScreenHtml.Parse(text);
                var roots = parsed.Children.Where(c => !c.IsText || c.Text!.Trim().Length > 0).ToList();
                if (roots.Count == 2 && IsIfElse(roots[0], roots[1])) roots.RemoveAt(1);
                if (roots.Count != 1 || roots[0].IsText) { Add(pointer, Invalid, "an edit is one element of the reading with its k (children included), the <style> of the page or the whole document", "send each changed element as its own string"); continue; }
                if (roots[0].Tag is not ("screen" or "block" or "style") && roots[0].Get("k") == null)
                    Add(pointer, NoKey, "<" + roots[0].Tag + "> has no k: an edit names the element of the reading it replaces by its k", "send the parent of the new element (with its k), the new element inside it without k");
                foreach (var (node, _) in ScreenHtmlText.Elements(parsed)) {
                    if (node.Tag == "script") { Add(pointer, Script, "<script> is not part of a page", "remove it; behavior is a native event naming a screen action (onclick=\"Save\")"); continue; }
                    // What a new element (no k) writes new, without the reading: an element with its k is judged against the reading
                    // by the plan at apply (what it already had is kept), which says these again with their patches.
                    if (node.Get("k") != null) continue;
                    // CX17 review 2, M4: a marker of the engine on a new element (the one rule of the three text forms).
                    foreach (var (attribute, value, _) in Anvil.Core.ScreenVisual.AuthorMarkers(node, null))
                        Add(pointer, Anvil.Core.ScreenVisual.ReservedMarker, Anvil.Core.ScreenVisual.ReservedMarkerMessage(attribute, value, false, false), Anvil.Core.ScreenVisual.ReservedMarkerFix(attribute, null) + " (the plan's patch)");
                    foreach (var (attribute, value) in node.Attributes) {
                        if (Anvil.Core.ScreenDocument.ScriptAttribute(attribute, value) != null
                            || (attribute.StartsWith("on", StringComparison.Ordinal) || attribute.StartsWith("html:on", StringComparison.Ordinal)) && !attribute.Contains('.') && !ScreenHtml.TryCall(value, out _, out _) && !Anvil.Core.ScreenDocument.ParseCall(value, out _, out _))
                            Add(pointer, Script, attribute + "=\"" + (value.Length > 80 ? value[..80] + "…" : value) + "\" is JavaScript (L5): an event names its destination, onclick=\"Save\" or onclick=\"Open(Id = Row.Id)\"",
                                Anvil.Core.ScreenDocument.NeedsItsClick(node, attribute) ? Anvil.Core.ScreenDocument.ClickFix(node) : "name a screen action or a screen; the plan's patch removes it");
                        else if (Anvil.Core.ScreenDocument.IsIterationAttribute(attribute))
                            Add(pointer, ForEach, attribute + "=\"" + (value.Length > 80 ? value[..80] + "…" : value) + "\" is the iteration of another framework: a repetition is a List",
                                "list=\"<Source>\" with the row as <Source>.Current inside (the plan's patch, when it compiles)");
                    }
                }
            } catch (FormatException error) { Add(pointer, Invalid, error.Message, "every element closes (or is <x/>), every attribute value is quoted, & is written &amp;"); }
        }
        if (problems.Count > 0)
            throw new Anvil.Core.KernelRefusalException(problems.Count == 1 ? problems[0]!["code"]!.ToString() : "HTML_EDIT_REFUSED",
                string.Join(" | ", problems.Select(p => p!["message"]!.ToString())), problems);
    }

    // The refusals (plan, 1.7), one answer with every problem.
    public const string Invalid = "HTML_EDIT_INVALID", NoKey = "HTML_EDIT_NO_KEY", Overlap = "HTML_EDIT_OVERLAP", KeyForeign = "HTML_KEY_FOREIGN",
        KeyTwice = "HTML_KEY_TWICE", OpaqueTouched = "HTML_OPAQUE_TOUCHED", Visible = "HTML_VISIBLE", Script = "HTML_SCRIPT", Json = "HTML_JSON",
        NameUnknown = "HTML_NAME_UNKNOWN", NameTaken = "HTML_NAME_TAKEN", DeleteInUse = "HTML_DELETE_IN_USE", SlotUnknown = "HTML_SLOT_UNKNOWN",
        ActionsListed = "HTML_ACTIONS_LISTED", DataNew = "HTML_DATA_NEW", KindChanged = "HTML_KIND_CHANGED", BaseChanged = "HTML_BASE_CHANGED",
        NotApplied = "HTML_EDIT_NOT_APPLIED", ForEach = "HTML_FOREACH", DefaultsMissing = "HTML_STUDIO_DEFAULTS";

    // <div if k="..."> followed by its <div else>: the two halves of one If, sent together.
    internal static bool IsIfElse(ScreenHtml.Node first, ScreenHtml.Node second) =>
        !first.IsText && !second.IsText && first.Tag == "div" && first.Get("if") != null && second.Tag == "div" && second.Attributes is [{ Key: "else" }];

    internal static int Distance(string a, string b)
    {
        a = a.ToUpperInvariant(); b = b.ToUpperInvariant();
        var previous = Enumerable.Range(0, b.Length + 1).ToArray();
        for (var i = 1; i <= a.Length; i++) {
            var row = new int[b.Length + 1]; row[0] = i;
            for (var j = 1; j <= b.Length; j++) row[j] = Math.Min(Math.Min(row[j - 1] + 1, previous[j] + 1), previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
            previous = row;
        }
        return previous[b.Length];
    }

    // The closest names (edit distance), at most three; the one a name certainly means is the only one within a quarter of its
    // letters (the plan's 2.3 rule: distance <= 2, or the same name but for a long common part).
    internal static List<string> Closest(string name, IEnumerable<string> candidates, int max = 3) =>
        candidates.Where(c => c.Length > 0).Distinct(StringComparer.Ordinal).OrderBy(c => Distance(name, c)).ThenBy(c => c, StringComparer.Ordinal).Take(max).ToList();
    internal static string? Certain(string name, IEnumerable<string> candidates)
    {
        var close = candidates.Where(c => c.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase)
            .Where(c => Distance(name, c) <= Math.Min(2, Math.Max(1, Math.Min(name.Length, c.Length) / 4))).ToList();
        return close.Count == 1 ? close[0] : null;
    }
}

// The native moves of an edit. T is the model object of the reader (ModelReader<T>).
public interface IScreenHtmlWriter<T> where T : class
{
    // A widget, run (TextWidget, Expression), extended property, HTML event or data element of `kind` under `parent`, at the end
    // of it. A block instance takes its block, with its placeholders empty.
    T Create(T parent, string kind, T? block);
    void Set(T node, string property, ScreenHtmlValue<T> value);
    // A data element (variable, input): the name, with the expressions that use it rewritten.
    void Rename(T node, string name);
    void Delete(T node);
    // Into another parent (the platform's own move: the node and its subtree may come back as new objects with new keys).
    T Move(T node, T parent);
    // Right after `after` inside the same parent (null: first).
    void Place(T node, T? after);
    // The object that replaced `node` after a move, or null when it was not moved.
    T? Replacement(T node);
}

// A value to write: e expression, t text, b boolean, v value (enum or number), r reference (Target, or Name when the target is
// outside the walk: a type, a system element), l list of references, ? nothing (null).
public readonly record struct ScreenHtmlValue<T>(char Type, string Text, T? Target = null, IReadOnlyList<T>? Targets = null, string? Name = null) where T : class;

public sealed class ScreenHtmlEditResult
{
    public string Root = "", RootKey = "", RootKind = "";
    public string BasedOnHtml = "";
    public List<JsonObject> Problems = [];
    // What ran, in order: {op: create|set|rename|delete|move|place, k, kind?, property?, from?, to?}.
    public List<JsonObject> Ops = [];
    public List<JsonObject> KeyChanged = [];
    public List<JsonObject> VisiblePreserved = [];
    public List<JsonObject> Normalized = [];
    public string EditedHtml = "";
    public ScreenHtmlDocument? After;
    public double PlanMs, ApplyMs, VerifyMs;
    public bool Refused => Problems.Count > 0;

    public JsonObject Json(bool withHtml = false)
    {
        var counts = new JsonObject();
        foreach (var group in Ops.GroupBy(o => o["op"]!.ToString()).OrderBy(g => g.Key, StringComparer.Ordinal)) counts[group.Key] = group.Count();
        var json = new JsonObject {
            ["mode"] = "edit", ["schema"] = ScreenHtml.Schema, ["root"] = Root, ["rootKind"] = RootKind, ["basedOn"] = new JsonObject { ["html"] = BasedOnHtml },
            ["applied"] = !Refused, ["counts"] = counts,
            ["ops"] = new JsonArray(Ops.Take(200).Select(o => (JsonNode)o.DeepClone()).ToArray()),
        };
        if (Ops.Count > 200) json["opsTotal"] = Ops.Count;
        if (KeyChanged.Count > 0) json["keyChanged"] = new JsonArray(KeyChanged.Select(o => (JsonNode)o.DeepClone()).ToArray());
        if (VisiblePreserved.Count > 0) json["visiblePreserved"] = new JsonArray(VisiblePreserved.Select(o => (JsonNode)o.DeepClone()).ToArray());
        if (Normalized.Count > 0) json["normalized"] = new JsonArray(Normalized.Select(o => (JsonNode)o.DeepClone()).ToArray());
        if (Problems.Count > 0) json["problems"] = new JsonArray(Problems.Select(o => (JsonNode)o.DeepClone()).ToArray());
        if (After != null) {
            // The next edit is based on this reading: its text, hash and keys come in the answer (one call less).
            json["next"] = new JsonObject { ["html"] = After.HtmlSha256, ["bytes"] = After.Bytes };
            if (withHtml) json["next"]!["text"] = After.Html;
        }
        json["timings"] = new JsonObject { ["planMs"] = Math.Round(PlanMs, 1), ["applyMs"] = Math.Round(ApplyMs, 1), ["verifyMs"] = Math.Round(VerifyMs, 1) };
        return json;
    }
}

// The text of a parsed ssam-html/1 tree, written as the reading writes it (ScreenHtmlModule's Render): the edit engine writes
// the corrected edits of a refusal with it, and the battery writes its edits with it. Write(Parse(text)) == text for every
// text the reading writes.
public static class ScreenHtmlText
{
    public static string Write(ScreenHtml.Node node)
    {
        var sb = new StringBuilder();
        if (node.Tag == "#document") { foreach (var child in node.Children) if (!child.IsText) Render(sb, child, "", true); }
        else Render(sb, node, "", true);
        return sb.ToString();
    }

    // Without the k of every element: the same page whatever the numbering of its reading.
    private static readonly Regex KeyAttribute = new(" k=\"[^\"]*\"", RegexOptions.Compiled);
    public static string WithoutKeys(string html) => KeyAttribute.Replace(html, "");

    private static bool Bare(KeyValuePair<string, string> attribute) => attribute.Value.Length == 0 && attribute.Key is "html" or "else";

    private static void Render(StringBuilder sb, ScreenHtml.Node node, string indent, bool root)
    {
        sb.Append(indent).Append('<').Append(node.Tag);
        foreach (var attribute in node.Attributes) {
            sb.Append(' ');
            if (Bare(attribute)) sb.Append(attribute.Key); else sb.Append(ScreenHtml.Attribute(attribute.Key, attribute.Value));
        }
        if (node.Tag == "style") { sb.Append('>').Append(string.Concat(node.Children.Select(c => c.Text))).Append("</style>\n"); return; }
        if (node.Tag == "text") { sb.Append('>').Append(ScreenHtml.Escape(string.Concat(node.Children.Select(c => c.Text)), true)).Append("</text>\n"); return; }
        // The runs of the text (ScreenHtml.Runs: a line each, the whitespace beside an inline element kept), each written on its
        // own line in the form that reads back as the same run (ScreenHtml.RunForm).
        var runs = ScreenHtml.Runs(node).ToLookup(r => r.Source, ReferenceEqualityComparer.Instance);
        var lines = new List<object>();
        foreach (var child in node.Children) {
            if (!child.IsText) { lines.Add(child); continue; }
            foreach (var run in runs[child]) {
                var (form, value) = ScreenHtml.RunForm(run.Text);
                lines.Add(form switch {
                    'p' => ScreenHtml.Escape(value, true),
                    'x' => "{{ " + ScreenHtml.Escape(value, true) + " }}",
                    _ => "<text>" + ScreenHtml.Escape(value, true) + "</text>",
                });
            }
        }
        if (lines.Count == 0) { sb.Append("/>\n"); return; }
        if (lines is [string run1] && !run1.StartsWith("<text>", StringComparison.Ordinal)) { sb.Append('>').Append(run1).Append("</").Append(node.Tag).Append(">\n"); return; }
        sb.Append(">\n");
        var inner = root ? "" : indent + " ";
        foreach (var line in lines)
            if (line is ScreenHtml.Node element) Render(sb, element, inner, false);
            else sb.Append(inner).Append((string)line).Append('\n');
        sb.Append(indent).Append("</").Append(node.Tag).Append(">\n");
    }

    public static ScreenHtml.Node Clone(ScreenHtml.Node node)
    {
        var copy = new ScreenHtml.Node { Tag = node.Tag, Text = node.Text, Line = node.Line, Column = node.Column };
        copy.Attributes.AddRange(node.Attributes);
        foreach (var child in node.Children) copy.Children.Add(Clone(child));
        return copy;
    }

    // The parent of every element of a tree (by reference).
    public static Dictionary<ScreenHtml.Node, ScreenHtml.Node> Parents(ScreenHtml.Node root)
    {
        var parents = new Dictionary<ScreenHtml.Node, ScreenHtml.Node>(ReferenceEqualityComparer.Instance);
        foreach (var (node, parent) in Elements(root)) if (parent != null) parents[node] = parent;
        return parents;
    }

    // Every element of a tree with its parent, depth first, in the order of the text.
    public static IEnumerable<(ScreenHtml.Node Node, ScreenHtml.Node? Parent)> Elements(ScreenHtml.Node root, ScreenHtml.Node? parent = null)
    {
        if (root.IsText) yield break;
        yield return (root, parent);
        foreach (var child in root.Children)
            foreach (var pair in Elements(child, root)) yield return pair;
    }
}
