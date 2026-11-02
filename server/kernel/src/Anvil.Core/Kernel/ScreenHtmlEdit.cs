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
// The theme facts (C-14) are in ScreenHtmlEdit.Theme.cs, which the ODC builder compiles with ScreenHtmlModule.cs.
public static partial class ScreenHtmlEdit
{
    // R2-D (the owner's decision of 2026-10-28): data.css in an edit IS the root's own style sheet, as written: it replaces the
    // page's <style> instead of following it (docs/SSAM-HTML.md, Fidelity, CSS; ScreenDocument.OwnSheet, the same rule on a
    // create), through the same verified <style> edit path. The page's <style> it replaces is the one the edit writes: the
    // <style> of a whole document (the one element edits make included), else a <style> edit, else the reading's. A sheet sent
    // again whole is then the sheet, never twice the sheet; a rule left out of it is removed.
    public static List<string> WithCss(IReadOnlyList<string> edits, string css, string? readingHtml = null) => PlaceCss(edits, css, readingHtml).Edits;

    /// <summary>What <see cref="WithCss"/> did: the edits with data.css as the page's &lt;style&gt;; the text of the &lt;style&gt; it
    /// replaced (null: none) and whether that one was the edit's own (a &lt;style&gt; the author sent that is not the reading's).</summary>
    public sealed record CssPlacement(List<string> Edits, string? Replaced, bool ReplacedTheEdits);

    public static CssPlacement PlaceCss(IReadOnlyList<string> edits, string css, string? readingHtml = null)
    {
        if (css.Contains("</style>", StringComparison.OrdinalIgnoreCase))
            throw new FormatException("data.css cannot contain a closing style tag");
        var reading = readingHtml == null ? null : OwnSheetOf(readingHtml);
        var result = edits.ToList();
        for (var i = 0; i < result.Count; i++)
        {
            var tree = ScreenHtml.Parse(result[i]);
            var root = tree.Children.FirstOrDefault(n => !n.IsText);
            // C-14: a <style scope="theme"> edit is a part of the module theme, never the page's own sheet.
            if (root?.Tag is "screen" or "block" || root?.Tag == "style" && !IsThemeStyle(root))
            {
                var own = root.Tag == "style" ? root : OwnStyle(root);
                var was = own == null ? null : StyleText(own);
                if (own != null) { own.Children.Clear(); own.Children.Add(new ScreenHtml.Node { Text = css }); }
                else root.Children.Insert(0, Style(css));
                result[i] = ScreenHtmlText.Write(tree);
                return new CssPlacement(result, was ?? reading, was != null && was != reading);
            }
        }
        result.Add(ScreenHtmlText.Write(Style(css)));
        return new CssPlacement(result, reading, false);
    }

    /// <summary>The CSS of the root's own &lt;style&gt; of a document (a reading or a whole edit), or null when it has none.</summary>
    public static string? OwnSheetOf(string html)
    {
        try { return ScreenHtml.Parse(html).Children.FirstOrDefault(n => !n.IsText) is { } top && (top.Tag == "style" ? (IsThemeStyle(top) ? null : top) : OwnStyle(top)) is { } style ? StyleText(style) : null; }
        catch (FormatException) { return null; }
    }

    /// <summary>The page's own &lt;style&gt; the edits write (a whole document's, else a &lt;style&gt; edit): its edit and its CSS.</summary>
    public static (int Edit, string Css)? OwnSheet(IReadOnlyList<string> edits)
    {
        for (var i = 0; i < edits.Count; i++)
        {
            ScreenHtml.Node? root;
            try { root = ScreenHtml.Parse(edits[i]).Children.FirstOrDefault(n => !n.IsText); } catch (FormatException) { continue; }
            if (root?.Tag is "screen" or "block" && OwnStyle(root) is { } own) return (i, StyleText(own));
            if (root?.Tag == "style" && !IsThemeStyle(root)) return (i, StyleText(root));
        }
        return null;
    }

    /// <summary>The edits with the CSS of the page's own &lt;style&gt; of edit <paramref name="edit"/> written as <paramref name="css"/>.</summary>
    public static List<string> WithOwnSheet(IReadOnlyList<string> edits, int edit, string css)
    {
        var result = edits.ToList();
        var tree = ScreenHtml.Parse(result[edit]);
        var root = tree.Children.First(n => !n.IsText);
        var own = root.Tag == "style" ? root : OwnStyle(root)!;
        own.Children.Clear();
        own.Children.Add(new ScreenHtml.Node { Text = css });
        result[edit] = ScreenHtmlText.Write(tree);
        return result;
    }

    /// <summary>data.css of an html op: its text, or null when it is absent, empty or only whitespace (such a data.css is no
    /// data.css: it never replaces a sheet; an empty &lt;style&gt; edit clears the sheet). A css that is not a string is the
    /// shape's problem (Preflight, HtmlEdit).</summary>
    public static string? DataCss(JsonObject data) =>
        data["css"] is JsonValue value && value.TryGetValue<string>(out var css) ? DataCss(css) : null;

    /// <summary>The one predicate of an absent data.css, for the edit and the document form (ScreenDocument.OwnSheet, the visual
    /// checks): the text, or null when it is null, empty or only whitespace.</summary>
    public static string? DataCss(string? css) => string.IsNullOrWhiteSpace(css) ? null : css;

    /// <summary>An edit that changes only the style sheet: data.css and nothing else to edit (no html; edit and edits absent or
    /// empty). Valid: data.css is the page's whole sheet, the elements stay as they are.</summary>
    public static bool CssOnly(JsonObject data) =>
        DataCss(data) != null && data["html"] == null
        && (data["edit"] == null || data["edit"] is JsonArray { Count: 0 })
        && (data["edits"] == null || data["edits"] is JsonArray { Count: 0 });

    // The root's own <style> (the first child <style> without scope="theme": the one the edit plan writes as its sheet).
    private static ScreenHtml.Node? OwnStyle(ScreenHtml.Node root) => root.Children.FirstOrDefault(n => !n.IsText && n.Tag == "style" && !IsThemeStyle(n));
    private static string StyleText(ScreenHtml.Node style) => string.Concat(style.Children.Select(c => c.Text));
    private static ScreenHtml.Node Style(string text) { var node = new ScreenHtml.Node { Tag = "style" }; node.Children.Add(new ScreenHtml.Node { Text = text }); return node; }

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
        if (data.ContainsKey("css") && (data["css"] is not JsonValue cssValue || !cssValue.TryGetValue<string>(out _)))
            Add("/css", Invalid, "html edit: css must be a string", "send CSS text (it is the page's whole style sheet: it replaces the <style> the screen has), or omit css");
        var texts = new List<(string Pointer, string Text)>();
        // R2-D: data.css alone (no element to edit) changes only the style sheet: nothing else is required.
        if (CssOnly(data)) { }
        else if (data["edits"] != null) {
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
        else Add("/edit", Invalid, "html edit: 'edit' (the changed elements, each with its k), 'html' (the whole document) or 'css' (the whole style sheet) is required", "\"edit\": [\"<div k=\\\"w7\\\" ...>...</div>\"]");
        foreach (var (pointer, text) in texts) {
            try {
                var parsed = ScreenHtml.Parse(text);
                var roots = parsed.Children.Where(c => !c.IsText || c.Text!.Trim().Length > 0).ToList();
                if (roots.Count == 0 && texts.Count > 1) continue;   // F10: an empty edit string is nothing (HTML_DECLARATIONS_FIRST leaves one)
                // F10: several elements in one string are as many edits (the plan lists HTML_EDIT_SPLIT); loose text, or the whole
                // document beside other elements, is no edit.
                var units = Units(roots);
                if (units == null || units.Count > 1 && units.Any(u => u.Element.Tag is "screen" or "block")) { Add(pointer, Invalid, "an edit is one element of the reading with its k (children included), the <style> of the page or the whole document", "send each changed element as its own string"); continue; }
                foreach (var (unit, _) in units)
                    if (unit.Tag is not ("screen" or "block" or "style") && unit.Get("k") == null && !IsDeclaration(unit))
                        Add(pointer, NoKey, "<" + unit.Tag + "> has no k: an edit names the element of the reading it replaces by its k", "send the parent of the new element (with its k), the new element inside it without k");
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
        NotApplied = "HTML_EDIT_NOT_APPLIED", ForEach = "HTML_FOREACH", DefaultsMissing = "HTML_STUDIO_DEFAULTS", NameFixed = "HTML_NAME_FIXED",
        // Half a column of a native Table: its header cell and its row cell are removed and added together.
        TableColumn = "HTML_TABLE_COLUMN",
        // F2: a property the page does not keep (editor state, derived, no setter, not of the kind) and a value its property does
        // not take, both refused before anything is written, named with the element, the property, expected and actual.
        PropertyNotKept = "HTML_PROPERTY_NOT_KEPT", PropertyValue = "HTML_PROPERTY_VALUE",
        // C-03: an event argument in a row of a Traditional list, written through the list widget.
        ListRow = "HTML_LIST_ROW",
        // F10 normalizations of the edit form (listed in normalized, never refused).
        EditSplit = "HTML_EDIT_SPLIT", EventArguments = "HTML_EVENT_ARGUMENTS", BreakContainer = "HTML_BR_CONTAINER",
        TypeUnqualified = "HTML_TYPE_UNQUALIFIED",
        // A declaration without k named like the root's only one of its tag: the edit of that one (review W3-EDIT, 4).
        DeclarationKeyed = "HTML_DECLARATION_KEYED";

    // F10: the elements of one edit string, each with the <div else> that follows its <div if> (one If), or null when loose text
    // is among them. One element is the edit of today; several are as many edits (HTML_EDIT_SPLIT).
    internal static List<(ScreenHtml.Node Element, ScreenHtml.Node? Else)>? Units(IReadOnlyList<ScreenHtml.Node> roots)
    {
        var units = new List<(ScreenHtml.Node, ScreenHtml.Node?)>();
        for (var i = 0; i < roots.Count; i++) {
            if (roots[i].IsText) return null;
            if (i + 1 < roots.Count && IsIfElse(roots[i], roots[i + 1])) { units.Add((roots[i], roots[i + 1])); i++; }
            else units.Add((roots[i], null));
        }
        return units.Count == 0 ? null : units;
    }

    // F10: a declaration of a screen or block (its parent is the root): an input parameter (<input name> without bind), a
    // variable, an aggregate or a block event. Written without k in an edit, it is a new one of the root.
    internal static bool IsDeclaration(ScreenHtml.Node node) =>
        !node.IsText && (node.Tag is "var" or "aggregate" or "event" || node.Tag == "input" && node.Get("name") != null && node.Get("bind") == null);
    internal static int DeclarationRank(ScreenHtml.Node node) => node.Tag switch { "input" => 0, "event" => 1, "var" => 2, _ => 3 };

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

    /// <summary>R2-A: an event never runs a client action (the platform refuses it as the Destination, both lanes); it runs a
    /// screen action of its page that calls it. The exact wrapping of an event written `action` + `call` (its arguments, "" for
    /// none) on <paramref name="root"/>: the logic text of the screen action and the destination the event then writes. One
    /// rule for the edit form, the document form and the static check.</summary>
    public static (string Logic, string Destination) ClientActionWrap(string root, string action, string call = "")
    {
        var args = call.Trim() is { Length: > 0 } written && written.StartsWith('(') ? written : "()";
        var wrapper = action + "Click";
        return ($"action {root}.{wrapper}\n  {action}{args}\n  end\n", wrapper);
    }
}

// The native moves of an edit. T is the model object of the reader (ModelReader<T>).
public interface IScreenHtmlWriter<T> where T : class
{
    // A widget, run (TextWidget, Expression), extended property, HTML event or data element of `kind` under `parent`, at the end
    // of it. A block instance takes its block, with its placeholders empty. The name, when the edit gives one, goes with the
    // creation: the platform names some widgets only then (a Web Block instance: "Widget does not support name changing").
    T Create(T parent, string kind, T? block, string? name = null);
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
    // F8: the Lists of a table part the edit wrote or repaired (ScreenVisual.TableEntry), the receipt's visual.tables.
    public List<JsonObject> Tables = [];
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
        if (Tables.Count > 0) json["visual"] = new JsonObject { ["tables"] = new JsonArray(Tables.Select(o => (JsonNode)o.DeepClone()).ToArray()) };
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
        if (node.Tag == "text") { sb.Append('>').Append(ScreenHtml.EscapeLiteral(string.Concat(node.Children.Select(c => c.Text)))).Append("</text>\n"); return; }
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
                    _ => "<text>" + ScreenHtml.EscapeLiteral(value) + "</text>",
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
