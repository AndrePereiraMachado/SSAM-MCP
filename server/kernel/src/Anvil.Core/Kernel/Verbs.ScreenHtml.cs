using System.Diagnostics;
using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// C2 of the plan "Texto do SSAM": the html op in its edit form. `{"op":"html","data":{"screen","basedOn":{"capture","html"},
/// "edit":["&lt;div k=\"w7\" ...&gt;...&lt;/div&gt;", ...]}}` (or `"html"`: the whole document). The screen is read from the
/// module of the job (ssam-html/1, ScreenHtml); the edit is planned against that reading (ScreenHtmlModule.EditPlan), every
/// problem refused at once; the plan runs through the verbs (create, set, rename, delete, move) on the objects of the reading;
/// the screen is read again and must be the edited text, keys kept, or the op fails and nothing is kept.
/// basedOn.html is the reading the edit was written on. When the screen changed since (another capture), the edit is merged
/// three ways (ScreenHtmlMerge, plan 3.4): base = that reading (its text and k -> ObjectKey table, kept by ssam_map view html in
/// ModuleIndexStore), local = the screen now, foreign = the base with the edit; what only the Studio changed stays, a change of
/// the same element on both sides keeps the edit's (listed in rebased[].conflicts); an element the edit changed that no longer
/// exists is HTML_KEY_FOREIGN with the current text. The delivery's native merge then takes the candidate into the live module.
/// </summary>
public sealed partial class ModelSession
{
    /// <summary>The module reading an html edit uses instead of reading the module again (the battery of edits keeps one per
    /// module and refreshes only the edited root). Null: the edit reads the module.</summary>
    internal ScreenHtmlModule<IObjectSignature>? ScreenHtmlReading { get; set; }
    /// <summary>The module reading after the last html edit (refreshed at its root).</summary>
    internal ScreenHtmlModule<IObjectSignature>? ScreenHtmlAfter { get; private set; }
    /// <summary>The sha256 of the base the job runs on (JobRunner): an edit whose basedOn.capture is another capture is rebased.</summary>
    public string? BaseSha256 { get; set; }

    private JsonNode HtmlEdit(JsonObject op)
    {
        var data = op["data"]!.AsObject();
        var refusals = new List<JsonObject>();
        void Shape(string pointer, string message, string fix) => refusals.Add(JobPreflight.Problem(null, pointer, ScreenHtmlEdit.Invalid, "error", message, fix));
        var target = data["screen"] is JsonValue s && s.TryGetValue<string>(out var screenName) && screenName.Length > 0 ? screenName : null;
        if (target == null) Shape("/screen", "html edit: 'screen' is required (the screen or block read: name, Kind:Name or @key)", "\"screen\": \"<the name ssam_map view html read>\"");
        List<string> edits; string pointer;
        // CX16: element edits of the reading (HtmlElementEdits): the whole document they make is the one edit of today's path.
        var elementEdits = data["edits"] != null ? data["edits"] as JsonArray ?? new JsonArray() : null;
        if (data["edits"] != null) {
            edits = []; pointer = "/edits";
            if (data["edit"] != null || data["html"] != null)
                Shape("/edits", "html edit: 'edits' (element edits of the reading) goes alone, without 'edit' or 'html'", "keep edits, or send the changed elements whole in edit");
            foreach (var p in HtmlElementEdits.Shape(data["edits"])) refusals.Add(Kernel(p));
        }
        else if (data["edit"] is JsonArray list) { edits = list.Select(e => e is JsonValue v && v.TryGetValue<string>(out var t) ? t : "").ToList(); pointer = "/edit"; }
        else if (data["html"] is JsonValue whole && whole.TryGetValue<string>(out var document)) { edits = [document]; pointer = "/html"; }
        else { edits = []; pointer = "/edit"; Shape("/edit", "html edit: 'edit' (the changed elements, each with its k) or 'html' (the whole document) is required", "\"edit\": [\"<div k=\\\"w7\\\" ...>...</div>\"]"); }
        var basedOn = data["basedOn"] as JsonObject;
        var baseHtml = basedOn?["html"]?.ToString();
        if (baseHtml is not { Length: > 0 }) Shape("/basedOn", "html edit: 'basedOn' {capture, html} is the reading the edit was written on (ssam_map view html answers it)", "\"basedOn\": {\"capture\": \"<sourceSha256>\", \"html\": \"<htmlSha256>\"}");
        if (refusals.Count > 0) throw new KernelRefusalException(ScreenHtmlEdit.Invalid, string.Join(" | ", refusals.Select(p => p["message"])), new JsonArray(refusals.Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray()));

        var module = ScreenHtmlReading ?? ScreenHtml.Module((IObjectSignature)_espace, new KernelModelReader());
        var reading = module.Read(target!);
        var notes = new JsonArray();
        JsonObject? elementNote = null;
        Dictionary<string, int>? editOf = null;
        Dictionary<string, string>? baseKeys = null;
        if (elementEdits != null) {
            // The base of the edits: the reading itself, the reading the store kept, or the job's capture before its first op.
            string baseText;
            if (reading.HtmlSha256 == baseHtml) { baseText = reading.Html; baseKeys = reading.Keys.GroupBy(k => k.Key).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal); }
            else if (StoredReading(basedOn!) is { } stored && stored["html"] is JsonValue kept && kept.TryGetValue<string>(out var keptText)) {
                baseText = keptText;
                baseKeys = (stored["keys"] as JsonObject)?.Where(p => p.Value is JsonValue).ToDictionary(p => p.Key, p => p.Value!.ToString(), StringComparer.Ordinal);
            }
            else throw BaseChanged(reading, baseHtml!, StoredReading(basedOn!)?["keys"] as JsonObject, elementEdits);
            var applied = HtmlElementEdits.Apply(baseText, elementEdits, baseKeys, out editOf);
            if (applied.Problems.Count > 0)
                throw new KernelRefusalException(applied.Problems.Select(p => p["code"]!.ToString()).Distinct().Count() == 1 ? applied.Problems[0]["code"]!.ToString() : "HTML_EDIT_REFUSED",
                    "html edits of " + reading.Root + " refused: " + string.Join(" | ", applied.Problems.Take(6).Select(p => "[" + p["code"] + "] " + p["message"])),
                    new JsonArray(applied.Problems.Select(p => (JsonNode)Kernel(p)).ToArray()));
            edits = [applied.Document];
            elementNote = new JsonObject { ["rule"] = "html-element-edits", ["at"] = "/edits", ["from"] = baseHtml![..Math.Min(12, baseHtml.Length)],
                ["edits"] = elementEdits.Count, ["touched"] = new JsonArray(applied.Touched.Select(k => (JsonNode)k).ToArray()) };
            // "id": null in a set removes the name (written id=""), as the contract of set says; said here, since the text it makes
            // writes id="" where the edit wrote null (the review of round 2, A2).
            var cleared = elementEdits.OfType<JsonObject>().Where(e => e["set"] is JsonValue && e["attributes"] is JsonObject a && a.ContainsKey("id") && a["id"] == null)
                .Select(e => (JsonNode)e["set"]!.ToString()).ToArray();
            if (cleared.Length > 0)
                elementNote["names"] = new JsonObject { ["cleared"] = new JsonArray(cleared),
                    ["note"] = "\"id\": null removes the name: written id=\"\" (an element whose text leaves its id out keeps the name it has)" };
        }
        if (data.ContainsKey("css"))
        {
            try
            {
                if (data["css"] is not JsonValue cssValue || !cssValue.TryGetValue<string>(out var css))
                    throw new FormatException("data.css must be a string");
                // After the page's <style> (the edit's, else the reading's), as the document form writes it.
                edits = ScreenHtmlEdit.WithCss(edits, css, reading.Html);
            }
            catch (FormatException ex)
            {
                throw new KernelRefusalException(ScreenHtmlEdit.Invalid, ex.Message,
                    new JsonArray(JobPreflight.Problem(null, "/css", ScreenHtmlEdit.Invalid, "error", ex.Message, "send data.css as CSS text without a closing style tag; it follows the page's <style> in its style sheet")));
            }
        }
        try { return HtmlEditPlanned(module, reading, data, basedOn!, baseHtml!, edits, pointer, notes, elementNote); }
        catch (KernelRefusalException refusal) when (elementEdits != null) { throw ForElementEdits(refusal, reading, editOf, baseKeys); }
    }

    // A problem of the element edits engine (pointers relative to op.data) as the kernel publishes it.
    private static JsonObject Kernel(JsonObject p)
    {
        var problem = JobPreflight.Problem(null, p["pointer"]?.ToString(), p["code"]!.ToString(), "error", p["message"]!.ToString(), p["fix"]?.ToString());
        foreach (var key in new[] { "element", "candidates", "lines", "occurrences" }) if (p[key] != null) problem[key] = p[key]!.DeepClone();
        return JobPreflight.PublicProblem(problem);
    }

    // The reading kept for basedOn {capture, html} (its text and k -> ObjectKey table): the store's, else the job's capture
    // before its first op (_htmlAtStart), else null. The same lookup the rebase does.
    private JsonObject? StoredReading(JsonObject basedOn)
    {
        var capture = basedOn["capture"]?.ToString() ?? "";
        var html = basedOn["html"]!.ToString();
        var table = capture.Length > 0 ? ModuleIndexStore.Default()?.LoadHtmlKeys(capture, html, BaseSha256) : null;
        if (table?["keys"] is not JsonObject && _htmlAtStart != null && _htmlAtStart.TryGetValue(html, out var atStart)
            && string.Equals(capture, BaseSha256, StringComparison.OrdinalIgnoreCase))
            table = new JsonObject {
                ["keys"] = new JsonObject(atStart.Keys.GroupBy(k => k.Key).Select(g => KeyValuePair.Create(g.Key, (JsonNode?)g.First().Value))),
                ["html"] = atStart.Html };
        return table;
    }

    // Element edits whose reading is not kept here and whose screen changed since: HTML_BASE_CHANGED as for the edit form, with
    // the current text of each element they address (by ObjectKey, when the key table of that reading is kept).
    private static KernelRefusalException BaseChanged(ScreenHtmlDocument reading, string html, JsonObject? oldKeys, JsonArray edits)
    {
        var problem = JobPreflight.Problem(null, "/basedOn", ScreenHtmlEdit.BaseChanged, "error",
            $"{reading.Root} is not the reading {html[..Math.Min(12, html.Length)]} the edits were written on (now {reading.HtmlSha256[..12]}), and that reading is not kept here",
            "write the edits again on the current text (basedOn.html " + reading.HtmlSha256 + "); it is current.text of this problem");
        var current = new JsonObject { ["html"] = reading.HtmlSha256, ["text"] = reading.Html };
        if (oldKeys != null) {
            var byObject = reading.Keys.Where(k => k.Key.Length > 0 && !k.Key.Contains('~')).GroupBy(k => k.Value).ToDictionary(g => g.Key, g => g.First().Key, StringComparer.Ordinal);
            var elements = new JsonArray();
            foreach (var (j, address) in HtmlElementEdits.Addresses(edits)) {
                var objectKey = address.StartsWith('@') ? address[1..] : oldKeys[address]?.ToString();
                var k = objectKey != null && byObject.TryGetValue(objectKey, out var now) ? now : null;
                elements.Add(new JsonObject { ["address"] = address, ["edit"] = j, ["k"] = k, ["text"] = k == null ? null : HtmlElementEdits.ElementText(reading.Html, k) });
            }
            current["elements"] = elements;
        }
        problem["current"] = current;
        return new KernelRefusalException(ScreenHtmlEdit.BaseChanged, problem["message"]!.ToString(), new JsonArray(JobPreflight.PublicProblem(problem)));
    }

    // A refusal of the plan of the document the element edits made: a problem on a k an edit touched names that edit (edit: j,
    // its pointer); the others point at the list. A patch of the plan (a corrected edit list of the edit form) becomes the edit
    // form with that list.
    private static KernelRefusalException ForElementEdits(KernelRefusalException refusal, ScreenHtmlDocument reading, Dictionary<string, int>? editOf, Dictionary<string, string>? baseKeys)
    {
        if (refusal.Problems is not { Count: > 0 } problems || editOf == null) return refusal;
        // The plan names the k of the screen now: back to the k of the base through the ObjectKey (the same k when not rebased).
        var baseOfObject = (baseKeys ?? []).Where(p => p.Key.Length > 0).GroupBy(p => p.Value).ToDictionary(g => g.Key, g => g.First().Key, StringComparer.Ordinal);
        var currentKeys = reading.Keys.GroupBy(k => k.Key).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal);
        var mapped = new JsonArray();
        foreach (var node in problems) {
            if (node is not JsonObject p) { mapped.Add(node?.DeepClone()); continue; }
            var copy = p.DeepClone().AsObject();
            if (copy["pointer"]?.ToString() is { } at && (at == "/edits" || at.StartsWith("/edits/", StringComparison.Ordinal))) {
                var k = copy["k"]?.ToString();
                var baseK = k != null && currentKeys.TryGetValue(k, out var objectKey) && baseOfObject.TryGetValue(objectKey, out var was) ? was : k;
                if (baseK != null && editOf.TryGetValue(baseK, out var j)) { copy["edit"] = j; copy["pointer"] = "/edits/" + j; }
                else copy["pointer"] = "/edits";
            }
            if (copy["patch"] is JsonArray patch && patch.Count == 1 && patch[0] is JsonObject replace && replace["op"]?.ToString() == "replace" && replace["value"] is JsonArray corrected)
                copy["patch"] = new JsonArray(new JsonObject { ["op"] = "remove", ["path"] = "/edits" },
                    new JsonObject { ["op"] = "add", ["path"] = "/edit", ["value"] = corrected.DeepClone() });
            mapped.Add(copy);
        }
        return new KernelRefusalException(refusal.Code, refusal.Message, mapped);
    }

    private JsonNode HtmlEditPlanned(ScreenHtmlModule<IObjectSignature> module, ScreenHtmlDocument reading, JsonObject data, JsonObject basedOn, string baseHtml,
        List<string> edits, string pointer, JsonArray notes, JsonObject? elementNote)
    {
        if (reading.HtmlSha256 != baseHtml) {
            // The screen is not the one the edit was written on: rebased through the key table of that reading.
            var rebased = Rebase(module, reading, basedOn!, data, edits, pointer);
            edits = rebased.Edits;
            foreach (var note in rebased.Notes) notes.Add(note);
        }
        // CX17 review 3, M6/M7: the theme the screen shows, so the plan decides the markers of the engine again on a screen of the op
        // (review 4, N1: a block, the themes of the screens that show it, read now).
        ScreenVisual.PageTheme? pageTheme = null;
        try { if (Resolve("@" + reading.RootKey) is IObjectSignature shown) pageTheme = RootThemeOf(shown); } catch (KeyNotFoundException) { }
        var plan = module.Edit(reading, edits, pointer, pageTheme);
        if (plan.Refused) throw Refusal(plan.Result);
        var writer = new ScreenHtmlNativeWriter(this);
        plan.Apply(writer);
        if (plan.Refused) throw Refusal(plan.Result);
        var after = module.Refresh(reading.RootKey);
        ScreenHtmlAfter = after;
        plan.Verify(after.Read("@" + reading.RootKey));
        if (plan.Refused) throw Refusal(plan.Result);
        // A page that carries markers of the engine (its own as the plan wrote them, or a marked block it places) needs the native
        // layout block in every theme it shows now (written once per theme, said; a theme of another module said with the markers
        // that have no effect there): review 4, N2, whoever wrote the markers and whatever theme they were written for.
        try {
            if (Resolve("@" + reading.RootKey) is IObjectSignature marked && (plan.CarriesMarkers || MarkedBlocksOn(marked).Count > 0))
                foreach (var layout in InstallNativeLayouts(marked)) plan.Result.Normalized.Add(layout);
        } catch (KeyNotFoundException) { }
        // A new Verify message under the edited screen that no nearer write explains is this op's (an expression the edit wrote in
        // an element it kept: the review of 2026-10-12 found them with no op and no pointer).
        try { if (Resolve("@" + reading.RootKey) is IObjectSignature root) Anchor(root); } catch (KeyNotFoundException) { }
        // Inline svg the edit turned into icon spans: the theme the screen shows has its svg and span selectors widened to them.
        JsonObject? iconTheme = null;
        if (plan.IconsConverted) try { if (Resolve("@" + reading.RootKey) is IObjectSignature edited) iconTheme = WidenIconTheme(edited).Report; } catch (KeyNotFoundException) { }
        var answer = plan.Result.Json(withHtml: data["answer"]?.ToString() == "html");
        answer["screen"] = reading.Root;
        if (iconTheme != null) answer["iconTheme"] = iconTheme;
        if (notes.Count > 0) answer["rebased"] = notes;
        if (elementNote != null) answer["normalizations"] = new JsonArray(elementNote);
        return answer;
    }

    // The patch of a plan replaces the edit list at the op's pointer; at /html (the html form: the whole document) that list is the
    // corrected document, one text, written back as the string the form takes. As an array it made an op the job refused, so a
    // refusal of the html form never had a patch that passes (round 4 of fix/data-table).
    private static JsonArray? HtmlFormPatch(JsonNode? patch)
    {
        if (patch?.DeepClone() is not JsonArray steps) return null;
        foreach (var step in steps.OfType<JsonObject>())
            if (step["op"]?.ToString() == "replace" && step["path"]?.ToString() == "/html" && step["value"] is JsonArray { Count: 1 } list
                && list[0] is JsonValue text && text.TryGetValue<string>(out var document))
                step["value"] = document;
        return steps;
    }

    private static KernelRefusalException Refusal(ScreenHtmlEditResult result)
    {
        var problems = new JsonArray(result.Problems.Select(p => {
            var problem = JobPreflight.Problem(null, p["pointer"]?.ToString(), p["code"]!.ToString(), "error", p["message"]!.ToString(), p["fix"]?.ToString(),
                HtmlFormPatch(p["patch"]));
            if (p["k"] is JsonValue k) problem["k"] = k.DeepClone();
            // F2: what a refusal of a property says of it (the element's kind, the property and its attribute, expected and actual,
            // the one next call; the Verify's differences one by one).
            foreach (var field in new[] { "kind", "property", "attribute", "expected", "actual", "next", "differences" })
                if (p[field] is { } value) problem[field] = value.DeepClone();
            return (JsonNode)JobPreflight.PublicProblem(problem);
        }).ToArray());
        var code = result.Problems.Select(p => p["code"]!.ToString()).Distinct().Count() == 1 ? result.Problems[0]["code"]!.ToString() : "HTML_EDIT_REFUSED";
        return new KernelRefusalException(code, "html edit of " + result.Root + " refused: " + string.Join(" | ", result.Problems.Take(6).Select(p => "[" + p["code"] + "] " + p["message"])), problems);
    }

    // The readings of the screens the html edits of the job name, as the job's capture has them before its first op (by htmlSha256),
    // when an edit is written on that capture and an earlier op of the same job writes: a logic op that adds a screen action
    // changes the screen's actions list, and the edit, written on the capture, was refused HTML_BASE_CHANGED without a patch
    // whenever the store did not keep that reading (the review of rounds 1 and 2: o1, m1). The edit is then merged three ways with
    // that reading, as with a reading the store kept: what the earlier op changed stays.
    private Dictionary<string, (string Html, IReadOnlyList<KeyValuePair<string, string>> Keys)>? _htmlAtStart;

    private Dictionary<string, (string Html, IReadOnlyList<KeyValuePair<string, string>> Keys)>? HtmlReadingsAtStart(JsonArray ops)
    {
        if (BaseSha256 == null) return null;
        List<string>? targets = null;
        var wrote = false;
        foreach (var node in ops) {
            if (node is not JsonObject op) continue;
            var verb = op["op"]?.ToString();
            if (verb == "html" && wrote && Anvil.Reading.ScreenHtmlEdit.IsEdit(op) && op["data"]?["basedOn"]?["capture"]?.ToString() is { } capture
                && string.Equals(capture, BaseSha256, StringComparison.OrdinalIgnoreCase) && op["data"]?["screen"]?.ToString() is { Length: > 0 } screen)
                (targets ??= []).Add(screen);
            if (verb is not ("get" or "find" or "dump" or "usages" or "layout")) wrote = true;
        }
        if (targets == null) return null;
        var readings = new Dictionary<string, (string, IReadOnlyList<KeyValuePair<string, string>>)>(StringComparer.OrdinalIgnoreCase);
        try {
            var module = ScreenHtmlReading ?? ScreenHtml.Module((IObjectSignature)_espace, new KernelModelReader());
            foreach (var target in targets.Distinct(StringComparer.Ordinal)) {
                try { var reading = module.Read(target); readings[reading.HtmlSha256] = (reading.Html, reading.Keys); }
                catch (Exception) { }   // a screen the capture cannot read: the edit is judged as before (the store or HTML_BASE_CHANGED)
            }
        } catch (Exception) { return null; }
        return readings;
    }

    /// <summary>The edits of an older reading moved onto the current one: merged three ways with the text of that reading when the
    /// store kept it, or when it is the reading of the job's own capture before its first op (_htmlAtStart; the whole merged
    /// document, in the current k); else each k through the ObjectKey it named (the key table of basedOn, kept beside the
    /// capture's index by ssam_map view html) to the k the current reading gives that object.</summary>
    private (List<string> Edits, List<JsonObject> Notes) Rebase(ScreenHtmlModule<IObjectSignature> module, ScreenHtmlDocument reading, JsonObject basedOn, JsonObject data,
        List<string> edits, string pointer)
    {
        var html = basedOn["html"]!.ToString();
        var table = StoredReading(basedOn);
        if (table?["keys"] is not JsonObject old) {
            var problem = JobPreflight.Problem(null, "/basedOn", ScreenHtmlEdit.BaseChanged, "error",
                $"{reading.Root} is not the reading {html[..Math.Min(12, html.Length)]} the edit was written on (now {reading.HtmlSha256[..12]}), and that reading's keys are not kept here",
                "write the edit again on the current text (basedOn.html " + reading.HtmlSha256 + "); it is current.text of this problem");
            problem["current"] = new JsonObject { ["html"] = reading.HtmlSha256, ["text"] = reading.Html };
            throw new KernelRefusalException(ScreenHtmlEdit.BaseChanged, problem["message"]!.ToString(), new JsonArray(JobPreflight.PublicProblem(problem)));
        }
        // The edit was written on the capture this job runs on: what changed the screen since is an earlier op of this job.
        var sameJob = BaseSha256 != null && string.Equals(basedOn["capture"]?.ToString(), BaseSha256, StringComparison.OrdinalIgnoreCase);
        return RebaseEdits(reading, html, old, table["html"] is JsonValue kept && kept.TryGetValue<string>(out var keptText) ? keptText : null, edits, pointer,
            data["edits"] as JsonArray, sameJob, BaseSha256,
            corrected => {
                // The element edits on the current text, planned (never written): the patch goes only when they plan clean; else their
                // own problems go in the same refusal (one refusal with everything).
                var applied = HtmlElementEdits.Apply(reading.Html, corrected, reading.Keys.GroupBy(k => k.Key).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal));
                return applied.Problems.Count > 0 ? null : module.Edit(reading, [applied.Document], "/edits").Result.Problems.ToList();
            });
    }

    /// <summary>Where an element k of an older reading is in the current text when the platform's move gave it a new key: the one
    /// element of the current text with the same tag and the same name (id), or, without a name, the one with the same text
    /// (without k); null when there is none or more than one.</summary>
    internal static (string K, string Parent)? MovedSince(string baseHtml, string k, string currentHtml)
    {
        try {
            var before = ScreenHtmlText.Elements(ScreenHtml.Parse(baseHtml)).Select(x => x.Node).ToList();
            var old = before.FirstOrDefault(n => n.Get("k") == k);
            if (old == null) return null;
            // One element of that signature in the reading too: a twin is never taken for the element.
            bool Same(ScreenHtml.Node n, string? name, string whole) => n.Tag == old.Tag && (name != null ? n.Get("id") == name : ScreenHtmlText.WithoutKeys(ScreenHtmlText.Write(n)) == whole);
            var current = ScreenHtml.Parse(currentHtml);
            var parents = ScreenHtmlText.Parents(current);
            var id = old.Get("id");
            var text = ScreenHtmlText.WithoutKeys(ScreenHtmlText.Write(old));
            if (before.Count(n => n.Get("k") != null && Same(n, id, text)) != 1) return null;
            var hits = ScreenHtmlText.Elements(current).Select(x => x.Node).Where(n => n.Get("k") != null && Same(n, id, text)).ToList();
            if (hits.Count != 1) return null;
            var up = parents.GetValueOrDefault(hits[0]);
            while (up != null && up.Get("k") == null && parents.ContainsKey(up)) up = parents[up];
            var parent = up == null ? "the root" : up.Get("k") is { } pk ? "k=\"" + pk + "\" (<" + up.Tag + (up.Get("class") is { } c ? " class=\"" + c + "\"" : "") + ">)" : "<" + up.Tag + ">";
            return (hits[0].Get("k")!, parent);
        } catch (FormatException) { return null; }
    }

    /// <summary>The rebase of an edit written on an older reading (Rebase, free of the session for its tests): the three-way merge
    /// with that reading's text when it is kept; else, or when the merge cannot lay the edit over it (ScreenHtmlMerge.Result.Why),
    /// only an edit of elements (the edit form) moves onto the current text, each k through the ObjectKey it named, the sent
    /// elements replacing the current ones whole. A whole document written on that reading (the document form, and the one the
    /// element edits make) is never planned in place of the screen: it would write the reading back over what changed since
    /// (the review of fix/html-edit-names, A1: with a native Table, the merge gave nothing and the edit undid an earlier op of
    /// its job). It is HTML_BASE_CHANGED once, with the current text, the next step and, for element edits whose addresses all
    /// name an element of the screen now, the checked patch that writes them on the current text.</summary>
    internal static (List<string> Edits, List<JsonObject> Notes) RebaseEdits(ScreenHtmlDocument reading, string html, JsonObject old, string? baseHtml, List<string> edits,
        string pointer, JsonArray? elementEdits, bool sameJob, string? jobCapture, Func<JsonArray, List<JsonObject>?>? planProblems)
    {
        var notes = new List<JsonObject>();
        string? why = null;
        // The three-way merge (plan 3.4): base = that reading's text, local = the screen now, foreign = the base with the edit.
        if (baseHtml != null) {
            var baseKeys = old.Where(p => p.Value is JsonValue).ToDictionary(p => p.Key, p => p.Value!.ToString(), StringComparer.Ordinal);
            var currentKeys = reading.Keys.GroupBy(k => k.Key).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal);
            var merged = ScreenHtmlMerge.ThreeWay(baseHtml, baseKeys, reading.Html, currentKeys, edits);
            if (merged.Missing.Count > 0) {
                var problems = merged.Missing.Select(k => {
                    // F2: an element the platform's move gave a new key since that reading is the same element (its tag, its name, or
                    // its whole text): it was moved, and the problem says where it is now, never that it was removed.
                    var moved = MovedSince(baseHtml, k, reading.Html);
                    var problem = JobPreflight.Problem(null, pointer, ScreenHtmlEdit.KeyForeign, "error",
                        moved is { } now
                            ? $"k=\"{k}\" of the reading {html[..Math.Min(12, html.Length)]} was moved since that reading (the platform's move gives a moved element a new key): it is k=\"{now.K}\" now, inside {now.Parent}"
                            : $"k=\"{k}\" of the reading {html[..Math.Min(12, html.Length)]} was changed by the edit and removed from {reading.Root} since that reading",
                        moved is { } there ? $"write the edit on the screen's current text, with k=\"{there.K}\" for that element (current.text of this problem)"
                            : "write the edit on the screen's current text (current.text of this problem)");
                    problem["k"] = k;
                    if (moved is { } to) { problem["movedTo"] = to.K; problem["movedInto"] = to.Parent; }
                    problem["current"] = new JsonObject { ["html"] = reading.HtmlSha256, ["text"] = reading.Html };
                    return (JsonNode)JobPreflight.PublicProblem(problem);
                }).ToArray();
                throw new KernelRefusalException(ScreenHtmlEdit.KeyForeign, string.Join(" | ", problems.Select(p => p!["message"])), new JsonArray(problems));
            }
            if (merged.Document != null) {
                var note = new JsonObject { ["from"] = html, ["to"] = reading.HtmlSha256, ["merge"] = "three-way",
                    ["note"] = "the screen changed since the reading: the edit was merged with what changed (base = that reading, local = the screen now); what only the Studio changed stays" };
                if (merged.Conflicts.Count > 0) {
                    note["conflicts"] = new JsonArray(merged.Conflicts.Select(c => (JsonNode)c).ToArray());
                    note["rule"] = "a change of the same element in the edit and in the Studio keeps the delivery's version";
                }
                notes.Add(note);
                return ([merged.Document], notes);
            }
            why = merged.Why;
        }
        var byObject = reading.Keys.Where(k => !k.Key.Contains('/') && !k.Key.Contains('.') && !k.Key.Contains('~') && k.Key.Length > 0)
            .GroupBy(k => k.Value).ToDictionary(g => g.Key, g => g.First().Key, StringComparer.Ordinal);
        var because = why == null ? "that reading's text is not kept here (only its key table)" : "the three-way merge could not lay it over that reading: " + why;
        // A whole document written on that reading: refused, once, with everything to go on.
        if (edits.Any(IsWholeDocument)) throw WholeDocumentRebased(reading, html, old, byObject, because, elementEdits, sameJob, jobCapture, planProblems);
        // An edit of elements: each k through the ObjectKey it named; the edited elements replace the current ones.
        var rebased = new List<string>(); var missing = new List<JsonObject>();
        for (var j = 0; j < edits.Count; j++) {
            ScreenHtml.Node parsed;
            try { parsed = ScreenHtml.Parse(edits[j]); } catch { rebased.Add(edits[j]); continue; }
            foreach (var (node, _) in ScreenHtmlText.Elements(parsed)) {
                if (node.Get("k") is not { } k) continue;
                var objectKey = old[k]?.ToString();
                if (objectKey != null && byObject.TryGetValue(objectKey, out var now)) {
                    node.Attributes[node.Attributes.FindIndex(a => a.Key == "k")] = new("k", now);
                    continue;
                }
                var problem = JobPreflight.Problem(null, pointer == "/html" ? pointer : pointer + "/" + j, ScreenHtmlEdit.KeyForeign, "error",
                    $"k=\"{k}\" of the reading {html[..Math.Min(12, html.Length)]} names an element of {reading.Root} that no longer exists",
                    "write the edit on the screen's current text (current.text of this problem)");
                problem["k"] = k;
                missing.Add(problem);
            }
            rebased.Add(ScreenHtmlText.Write(parsed));
        }
        if (missing.Count > 0) {
            foreach (var problem in missing) problem["current"] = new JsonObject { ["html"] = reading.HtmlSha256, ["text"] = reading.Html };
            throw new KernelRefusalException(ScreenHtmlEdit.KeyForeign, string.Join(" | ", missing.Select(p => p["message"])), new JsonArray(missing.Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray()));
        }
        notes.Add(new JsonObject { ["from"] = html, ["to"] = reading.HtmlSha256, ["merge"] = "by-key", ["because"] = because,
            ["note"] = "the screen changed since the reading: each element the edit sent replaced the one with its ObjectKey, whole (a change made inside it since is the edit's); what changed in the other elements stays" });
        return (rebased, notes);
    }

    // The edit is the whole document (<screen> or <block>), not one element of it.
    private static bool IsWholeDocument(string edit)
    {
        try { return ScreenHtml.Parse(edit).Children.FirstOrDefault(c => !c.IsText) is { Tag: "screen" or "block" }; }
        catch (FormatException) { return false; }
    }

    private static KernelRefusalException WholeDocumentRebased(ScreenHtmlDocument reading, string html, JsonObject old, Dictionary<string, string> byObject, string because,
        JsonArray? elementEdits, bool sameJob, string? jobCapture, Func<JsonArray, List<JsonObject>?>? planProblems)
    {
        var (form, was) = elementEdits != null ? ("the element edits (the document they make on it)", "were") : ("the whole document", "was");
        var since = sameJob ? "an earlier op of this job changed it" : "it changed since";
        var next = new JsonObject { ["capture"] = jobCapture, ["html"] = reading.HtmlSha256 };
        var problem = JobPreflight.Problem(null, "/basedOn", ScreenHtmlEdit.BaseChanged, "error",
            $"{reading.Root} is not the reading {html[..Math.Min(12, html.Length)]} {form} {was} written on ({since}; now {reading.HtmlSha256[..12]}), and {because}: "
            + $"{form} would write that reading back over what changed, so nothing is written",
            sameJob
                ? $"when an earlier html op of this job changed {reading.Root}, make this change in that op (one html op per screen and job); else send in 'edit' only the elements it changes, each whole with its k: each replaces the element with its ObjectKey and the rest of the screen stays as the earlier ops left it"
                : $"write the edit again on the current text (current.text, basedOn {{\"capture\": \"{jobCapture}\", \"html\": \"{reading.HtmlSha256}\"}}), or send in 'edit' only the elements it changes, each whole with its k: each replaces the element with its ObjectKey (a change made inside it since is the edit's) and the rest of the screen stays");
        var current = new JsonObject { ["html"] = reading.HtmlSha256, ["text"] = reading.Html };
        var extra = new List<JsonObject>();
        if (elementEdits != null) {
            // Each element the edits address, as the screen has it now (by ObjectKey).
            var elements = new JsonArray();
            foreach (var (j, address) in HtmlElementEdits.Addresses(elementEdits)) {
                var objectKey = address.StartsWith('@') ? address[1..] : old[address]?.ToString();
                var k = objectKey != null && byObject.TryGetValue(objectKey, out var now) ? now : null;
                elements.Add(new JsonObject { ["address"] = address, ["edit"] = j, ["k"] = k, ["text"] = k == null ? null : HtmlElementEdits.ElementText(reading.Html, k) });
            }
            current["elements"] = elements;
            // The same edits on the current text: each address through its ObjectKey, the k written in a replaced element too. Only
            // when every one names an element of the screen now, no edit finds a text (the text is the reading's), and they plan clean.
            if (RebasedElementEdits(elementEdits, old, byObject) is { } corrected && planProblems?.Invoke(corrected) is { } own) {
                if (own.Count == 0) {
                    problem["patch"] = new JsonArray(
                        new JsonObject { ["op"] = "replace", ["path"] = "/basedOn", ["value"] = next.DeepClone() },
                        new JsonObject { ["op"] = "replace", ["path"] = "/edits", ["value"] = corrected });
                    problem["fix"] = problem["fix"] + "; the patch writes the same edits on the current text (each address the element with its ObjectKey now), checked to plan clean";
                } else {
                    // On the current text the same edits have problems of their own: said now, in this refusal, never after it.
                    current["edits"] = corrected;
                    problem["fix"] = problem["fix"] + "; on the current text the same edits (current.edits) have " + own.Count.ToString(System.Globalization.CultureInfo.InvariantCulture)
                        + " problem(s) of their own, listed with this refusal: correct them in the same call";
                    foreach (var p in own) extra.Add(JobPreflight.Problem(null, "/edits", p["code"]!.ToString(), "error", p["message"]!.ToString(), p["fix"]?.ToString()));
                }
            }
        }
        problem["current"] = current;
        problem["next"] = new JsonObject { ["basedOn"] = next };
        var problems = new JsonArray(JobPreflight.PublicProblem(problem));
        foreach (var p in extra) problems.Add(JobPreflight.PublicProblem(p));
        return new KernelRefusalException(ScreenHtmlEdit.BaseChanged, problem["message"]!.ToString(), problems);
    }

    // Element edits of an older reading written on the current one: every address (and every k a replaced element writes) through
    // the ObjectKey of the older reading's key table; null when one names no element of the screen now or an edit finds a text.
    private static JsonArray? RebasedElementEdits(JsonArray edits, JsonObject old, Dictionary<string, string> byObject)
    {
        string? Now(string k) => old[k]?.ToString() is { } objectKey && byObject.TryGetValue(objectKey, out var now) ? now : null;
        string? Address(string address)
        {
            if (address == "/" || address.StartsWith('@')) return address;
            var cut = address.IndexOfAny(['/', '.']);
            var k = cut < 0 ? address : address[..cut];
            return Now(k) is { } now ? now + (cut < 0 ? "" : address[cut..]) : null;
        }
        var corrected = new JsonArray();
        foreach (var node in edits) {
            if (node is not JsonObject edit || edit["find"] != null) return null;
            var copy = edit.DeepClone().AsObject();
            foreach (var key in new[] { "set", "replace", "delete", "after", "before", "into", "move" })
                if (copy[key] is JsonValue v && v.TryGetValue<string>(out var address) && address.Length > 0) {
                    if (Address(address) is not { } now) return null;
                    copy[key] = now;
                }
            if (copy["replace"] != null && copy["with"] is JsonValue w && w.TryGetValue<string>(out var text)) {
                ScreenHtml.Node parsed;
                try { parsed = ScreenHtml.Parse(text); } catch (FormatException) { return null; }
                foreach (var (element, _) in ScreenHtmlText.Elements(parsed)) {
                    if (element.Get("k") is not { } k) continue;
                    if (Now(k) is not { } now) return null;
                    element.Attributes[element.Attributes.FindIndex(a => a.Key == "k")] = new("k", now);
                }
                copy["with"] = ScreenHtmlText.Write(parsed);
            }
            corrected.Add(copy);
        }
        return corrected;
    }

    /// <summary>The native moves of an html edit, through the verbs (each one the op the receipt names): handles for the objects of
    /// the reading, never a lookup by name.</summary>
    private sealed class ScreenHtmlNativeWriter(ModelSession session) : IScreenHtmlWriter<IObjectSignature>
    {
        private readonly Dictionary<object, string> aliases = new(ReferenceEqualityComparer.Instance);
        private int next;

        private string Alias(object o)
        {
            if (aliases.TryGetValue(o, out var alias)) return alias;
            alias = "$ssam.html." + (++next).ToString(System.Globalization.CultureInfo.InvariantCulture);
            aliases[o] = alias;
            session.Register(alias, o);
            return alias;
        }

        public IObjectSignature Create(IObjectSignature parent, string kind, IObjectSignature? block, string? name = null)
        {
            if (kind == "Event") {
                // An HTML event of an element (onfocus, onblur...): the element's own factory, as the prototype importer builds it.
                var create = AllMethods(parent).Where(m => m.Name == "CreateEvent").OrderBy(m => m.GetParameters().Length).FirstOrDefault() ?? throw new InvalidOperationException(Describe(parent) + " takes no HTML events");
                var made = create.Invoke(parent, create.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray()) as IObjectSignature
                    ?? throw new InvalidOperationException(Describe(parent) + " created no event");
                session.Anchor(made, created: true);
                return made;
            }
            var alias = "$ssam.html." + (++next).ToString(System.Globalization.CultureInfo.InvariantCulture);
            var type = "I" + kind;
            for (IObjectSignature? owner = parent; owner != null; owner = owner.Parent as IObjectSignature)
                if (Implements(owner, "IWebScreen") || Implements(owner, "IWebBlock") || Implements(owner,"IMobileScreen") || Implements(owner,"IMobileBlock")) {
                    // An O11 Reactive/Mobile screen also exposes the shared web interface: its own interface decides first.
                    var mobile = Implements(owner,"IMobileScreen") || Implements(owner,"IMobileBlock");
                    var web = !mobile && (Implements(owner,"IWebScreen") || Implements(owner,"IWebBlock"));
                    if (kind is "TextWidget" or "IfWidget") type = "OutSystems.Model.UI." + (web ? "Web" : "Mobile") + ".Widgets.I" + kind;
                    else if (kind is "Form" or "Label") type = "ServiceStudio.Plugin." + (web ? "Widgets" : "NRWidgets") + ".I" + kind;
                    break;
                }
            var op = new JsonObject { ["op"] = "create", ["parent"] = Alias(parent), ["type"] = type, ["as"] = alias };
            if (name != null) op["name"] = name;
            if (block != null) { op["source"] = Alias(block); op["empty"] = true; }
            session.ApplyOne(op);
            var created = (IObjectSignature)session.Resolve(alias);
            aliases[created] = alias;
            return created;
        }

        public void Set(IObjectSignature node, string property, ScreenHtmlValue<IObjectSignature> value)
        {
            JsonNode? written = value.Type switch {
                'b' => JsonValue.Create(value.Text == "True"),
                '?' => null,
                // A reference the plan resolved is written as that object, a type too: by its name the platform's type parser
                // takes the first element of that name, which is another one when a producer has a homonym (a local structure
                // and a producer's of the same name; receipts 092b8162, 645face7, 82bf05af of 18-22/10). A type outside the walk
                // (Text List, an Identifier) has no object here and is written by its name.
                'r' => value.Target != null ? JsonValue.Create(Alias(value.Target)) : JsonValue.Create(value.Name ?? value.Text),
                'l' => new JsonArray((value.Targets ?? []).Select(t => (JsonNode)JsonValue.Create(Alias(t))!)
                    .Concat((value.Name ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(n => (JsonNode)JsonValue.Create(n)!)).ToArray()),
                _ => JsonValue.Create(value.Text),
            };
            session.ApplyOne(new JsonObject { ["op"] = "set", ["target"] = Alias(node), ["prop"] = property, ["value"] = written });
        }

        public void Rename(IObjectSignature node, string name) => session.ApplyOne(new JsonObject { ["op"] = "rename", ["target"] = Alias(node), ["name"] = name });

        public void Delete(IObjectSignature node) => session.ApplyOne(new JsonObject { ["op"] = "delete", ["target"] = Alias(node), ["force"] = true });

        public IObjectSignature Move(IObjectSignature node, IObjectSignature parent)
        {
            var alias = Alias(node);
            session.ApplyOne(new JsonObject { ["op"] = "move", ["target"] = alias, ["into"] = Alias(parent) });
            var moved = (IObjectSignature)session.Resolve(alias);
            aliases[moved] = alias;
            return moved;
        }

        public void Place(IObjectSignature node, IObjectSignature? after)
        {
            var op = new JsonObject { ["op"] = "move", ["target"] = Alias(node) };
            if (after == null) op["first"] = true; else op["after"] = Alias(after);
            session.ApplyOne(op);
        }

        public IObjectSignature? Replacement(IObjectSignature node) => (node as ServiceStudio.Model.AbstractObject)?.TryGetReplacement() as IObjectSignature;
    }
}
