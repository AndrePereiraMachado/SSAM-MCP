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
            "write the edits again on the current text (basedOn.html " + reading.HtmlSha256 + "); it is in data.current");
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
            var rebased = Rebase(reading, basedOn!, edits, pointer);
            edits = rebased.Edits;
            foreach (var note in rebased.Notes) notes.Add(note);
        }
        var plan = module.Edit(reading, edits, pointer);
        if (plan.Refused) throw Refusal(plan.Result);
        var writer = new ScreenHtmlNativeWriter(this);
        plan.Apply(writer);
        if (plan.Refused) throw Refusal(plan.Result);
        var after = module.Refresh(reading.RootKey);
        ScreenHtmlAfter = after;
        plan.Verify(after.Read("@" + reading.RootKey));
        if (plan.Refused) throw Refusal(plan.Result);
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

    private static KernelRefusalException Refusal(ScreenHtmlEditResult result)
    {
        var problems = new JsonArray(result.Problems.Select(p => {
            var problem = JobPreflight.Problem(null, p["pointer"]?.ToString(), p["code"]!.ToString(), "error", p["message"]!.ToString(), p["fix"]?.ToString(),
                p["patch"]?.DeepClone() as JsonArray);
            if (p["k"] is JsonValue k) problem["k"] = k.DeepClone();
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
    private (List<string> Edits, List<JsonObject> Notes) Rebase(ScreenHtmlDocument reading, JsonObject basedOn, List<string> edits, string pointer)
    {
        var html = basedOn["html"]!.ToString();
        var table = StoredReading(basedOn);
        if (table?["keys"] is not JsonObject old) {
            var problem = JobPreflight.Problem(null, "/basedOn", ScreenHtmlEdit.BaseChanged, "error",
                $"{reading.Root} is not the reading {html[..Math.Min(12, html.Length)]} the edit was written on (now {reading.HtmlSha256[..12]}), and that reading's keys are not kept here",
                "write the edit again on the current text (basedOn.html " + reading.HtmlSha256 + "); it is in data.current");
            problem["current"] = new JsonObject { ["html"] = reading.HtmlSha256, ["text"] = reading.Html };
            throw new KernelRefusalException(ScreenHtmlEdit.BaseChanged, problem["message"]!.ToString(), new JsonArray(JobPreflight.PublicProblem(problem)));
        }
        var notes = new List<JsonObject>();
        // The three-way merge (plan 3.4): base = that reading's text, local = the screen now, foreign = the base with the edit.
        if (table["html"] is JsonValue baseText && baseText.TryGetValue<string>(out var baseHtml)) {
            var baseKeys = old.Where(p => p.Value is JsonValue).ToDictionary(p => p.Key, p => p.Value!.ToString(), StringComparer.Ordinal);
            var currentKeys = reading.Keys.GroupBy(k => k.Key).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal);
            var merged = ScreenHtmlMerge.ThreeWay(baseHtml, baseKeys, reading.Html, currentKeys, edits);
            if (merged.Missing.Count > 0) {
                var problems = merged.Missing.Select(k => {
                    var problem = JobPreflight.Problem(null, pointer, ScreenHtmlEdit.KeyForeign, "error",
                        $"k=\"{k}\" of the reading {html[..Math.Min(12, html.Length)]} was changed by the edit and removed from {reading.Root} since that reading",
                        "read the screen again and write the edit on its current text (data.current)");
                    problem["k"] = k;
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
        }
        // No base text kept (an older store): each k through the ObjectKey it named; the edited elements replace the current ones.
        var byObject = reading.Keys.Where(k => !k.Key.Contains('/') && !k.Key.Contains('.') && !k.Key.Contains('~') && k.Key.Length > 0)
            .GroupBy(k => k.Value).ToDictionary(g => g.Key, g => g.First().Key, StringComparer.Ordinal);
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
                    "read the screen again and write the edit on its current text (data.current)");
                problem["k"] = k;
                missing.Add(problem);
            }
            rebased.Add(ScreenHtmlText.Write(parsed));
        }
        if (missing.Count > 0) {
            foreach (var problem in missing) problem["current"] = new JsonObject { ["html"] = reading.HtmlSha256, ["text"] = reading.Html };
            throw new KernelRefusalException(ScreenHtmlEdit.KeyForeign, string.Join(" | ", missing.Select(p => p["message"])), new JsonArray(missing.Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray()));
        }
        notes.Add(new JsonObject { ["from"] = html, ["to"] = reading.HtmlSha256, ["note"] = "the screen changed since the reading: the edit was moved onto the current text by key; what changed elsewhere stays" });
        return (rebased, notes);
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

        public IObjectSignature Create(IObjectSignature parent, string kind, IObjectSignature? block)
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
            var op = new JsonObject { ["op"] = "create", ["parent"] = Alias(parent), ["type"] = "I" + kind, ["as"] = alias };
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
                'r' => value.Target != null && property != "DataType" ? JsonValue.Create(Alias(value.Target)) : JsonValue.Create(value.Name ?? value.Text),
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
