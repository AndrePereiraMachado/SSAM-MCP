using System.Net;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>
/// CX16 (2026-10-15): the names of the screens and blocks of a job, judged before the Studio and the apply from what decides
/// them: the documents (ScreenDocFacts, HtmlText positions; an element edit of a kept reading expanded first), the logic texts
/// of the job (headers, parameters, assignments), the module index, the producers and the UI catalogs (IndexBaseFacts).
/// <list type="bullet">
/// <item>S1 &lt;Block name&gt;: a block of the job, of the module, imported or importable (UI catalog).</item>
/// <item>S2 its contract: slot names, :Input names and the mandatory ones, @Event names.</item>
/// <item>S3 the destination of an event: a screen action of actions=, a screen of the job or of the module.</item>
/// <item>S4 actions= and data-actions=: written by a logic text of the job, or the screen's own in the module.</item>
/// <item>S5 the root of every expression path: data of the document, the module, the job or an import; a TYPE used as a value
/// (`value="Station.Id"`, with the correction from its list or options); `X.List.Current.Entity.Attr` over an `Entity List`
/// output or variable; a type of a producer the job references but does not import (REFERENCE_MISSING).</item>
/// <item>S6 roles=; S7 a new screen or block whose name the module already has (HTML_ROOT_EXISTS).</item>
/// <item>L1-L3 the logic texts against their screen: a data action assigning a screen variable, an output or a screen action
/// input named like the screen's data (NAME_COLLISION: the platform renames it).</item>
/// </list>
/// Never without evidence: a name the index lacks is a warning when the index is not the module the job is applied to
/// (StaticBasis.Fresh); a name the job or a generator may create is never a problem. Every problem: phase static, op,
/// pointer, element (the line of its tag), basis, fix and, when the correction is certain, edit {element, find, with} (an edit
/// of the job's text, html-edits.mjs). Other families plug their rules in through <see cref="Rule"/> (CX17: visual rules).
/// </summary>
public static class DocumentNameRules
{
    /// <summary>A rule over the documents of a job (the hook of other families).</summary>
    public delegate IEnumerable<JsonObject> Rule(Context context);

    public sealed class Document
    {
        public int Op { get; init; }
        public string? Pointer { get; init; }
        public string Name { get; init; } = "";
        public string Kind { get; init; } = "";
        public string Source { get; init; } = "";
        public HtmlText Text { get; init; } = null!;
        public ScreenDocFacts Facts { get; init; } = null!;
        /// <summary>The document of an element edit of an existing root (the edit names it; the job text has no document).</summary>
        public bool Existing { get; init; }
        /// <summary>Element edits only: the k of the elements the edits wrote. An element of the reading outside them (and
        /// outside a written ancestor) is the Studio's own text and is never judged: the live refusal of 20/10 named
        /// 'SelectedValue' of an untouched RangeSlider's @OnChange (a parameter of the producer's event the index does not hold).</summary>
        public IReadOnlySet<string>? Touched { get; init; }
    }

    public sealed class LogicAction
    {
        public int Op { get; init; }
        public string? Pointer { get; init; }
        public string Kind { get; init; } = "";
        public string? Owner { get; init; }
        public string Name { get; init; } = "";
        public Dictionary<string, string> In { get; } = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, string> Out { get; } = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, string> Local { get; } = new(StringComparer.OrdinalIgnoreCase);
        public List<(string Name, string Line)> Assigned { get; } = [];
        public string Header { get; init; } = "";
        public string Element => Owner == null ? Name : Owner + "." + Name;
    }

    public sealed class Context
    {
        public JsonArray Ops { get; init; } = [];
        public string? Prefix { get; init; }
        public string Lane { get; init; } = "o11";
        public IndexBaseFacts Facts { get; init; } = null!;
        public StaticBasis Basis { get; init; } = null!;
        public JobFacts Job { get; init; } = null!;
        public List<Document> Documents { get; } = [];
        public List<LogicAction> Actions { get; } = [];
        /// <summary>Names the job may create outside its documents (declarations, created elements, generators).</summary>
        public HashSet<string> Words { get; init; } = new(StringComparer.OrdinalIgnoreCase);
        public HashSet<string> Whole { get; init; } = new(StringComparer.OrdinalIgnoreCase);
        public List<JsonObject> Skipped { get; init; } = [];
        public List<string> Checked { get; } = [];
        /// <summary>A generator op whose names are not planned (an absent name is then no evidence).</summary>
        public bool Unplanned { get; init; }
    }

    private static readonly HashSet<string> Globals = new(StringComparer.OrdinalIgnoreCase)
        { "True", "False", "and", "or", "not", "like", "Entities", "Site", "Session", "Roles", "Resources", "Settings", "Request", "Client", "BuiltinClientVariables", "Images", "Themes", "NullObject" };
    private static readonly HashSet<string> SystemRoles = new(StringComparer.OrdinalIgnoreCase) { "Anonymous", "Registered" };
    // The attributes whose value is an expression in ssam-html/1 (the rest is text, a literal of the Model API or a name).
    private static readonly HashSet<string> ExpressionAttributes = new(StringComparer.OrdinalIgnoreCase) { "if", "list", "bind", "value", "show", "enabled", "default", "options", "label", "visible" };
    private static readonly Regex Header = new(@"^(server action|service action|client action|data action|preparation|action)[ \t]+(?:([\w/]+)\.)?([A-Za-z_]\w*)", RegexOptions.Compiled);
    private static readonly Regex Parameter = new(@"^\s+(in|out|local)\s+([A-Za-z_]\w*)\s*:\s*([^@\n=]+?)\s*(?:=.*?)?(?:\s@\w+)?\s*$", RegexOptions.Compiled);
    private static readonly Regex Assignment = new(@"^\s*(?:assign\s+)?([A-Za-z_]\w*)(?:\.[A-Za-z_][\w.]*)?\s*=(?!=)", RegexOptions.Compiled);

    public static List<JsonObject> Check(JsonArray ops, string? prefix, string lane, IndexBaseFacts facts, StaticBasis basis, List<JsonObject> skipped, IReadOnlyList<Rule>? more = null)
    {
        var (words, whole) = JobPreflight.JobWords(Declarations(ops));
        JobFacts job;
        try { job = JobFacts.From(ops); } catch { job = new JobFacts(); }   // a declaration the expansion refuses: the preflight says it
        // A generator whose planned names this check cannot list (the screen generator): what rests on a name being absent is
        // a warning in that job (rest-consume's names are in JobWords; entity-actions' are derived by PossiblyCreated).
        var unplanned = ops.OfType<JsonObject>().Any(o => o["op"]?.ToString() == "screen");
        if (unplanned) skipped.Add(new JsonObject { ["class"] = "absence", ["reason"] = "the job has a screen generator op, whose names are not planned here: a name nothing declares is a warning" });
        var context = new Context { Ops = ops, Prefix = prefix, Lane = lane, Facts = facts, Basis = basis, Job = job, Words = words, Whole = whole, Skipped = skipped, Unplanned = unplanned };
        Read(context);
        var problems = new List<JsonObject>();
        foreach (var rule in new Rule[] { Blocks, Events, ScreenActions, Expressions, References, Roles, Roots, LogicScopes }.Concat(more ?? []))
            try { problems.AddRange(rule(context).Where(p => p["untouched"] == null)); }
            catch (Exception error) { skipped.Add(new JsonObject { ["class"] = rule.Method.Name, ["reason"] = "the rule failed: " + error.Message }); }
        return problems;
    }

    // The job without its documents and with its logic texts reduced to their declarations: what the job may create
    // (PossiblyCreated), never the names its expressions only read.
    internal static JsonArray Declarations(JsonArray ops)
    {
        var copy = new JsonArray();
        foreach (var node in ops) {
            if (node is not JsonObject op) { copy.Add(node?.DeepClone()); continue; }
            var kind = op["op"]?.ToString();
            if (kind == "html" && op["parent"] == null) {
                var names = new JsonArray();
                foreach (var facts in new[] { ScreenDocFacts.Of(op, 0) }.OfType<ScreenDocFacts>()) {
                    names.Add(facts.Name);
                    foreach (var (name, _) in facts.Names()) names.Add(name);
                }
                copy.Add(new JsonObject { ["op"] = "html", ["names"] = names });
                continue;
            }
            if (kind == "logic" && op["data"] is JsonObject data && Texts(data).Count > 0) {
                var lines = new JsonArray();
                foreach (var (_, text) in Texts(data))
                    foreach (var line in text.Split('\n'))
                        if (Header.IsMatch(line) || Parameter.IsMatch(line)) lines.Add(line.Trim());
                copy.Add(new JsonObject { ["op"] = "logic", ["declarations"] = lines });
                continue;
            }
            copy.Add(op.DeepClone());
        }
        return copy;
    }

    // ---- reading the job ------------------------------------------------------------------------------------------------

    internal static List<(int Index, string Text)> Texts(JsonObject data)
    {
        var texts = new List<(int, string)>();
        var flow = data["flow"] ?? data["text"];
        if (flow is JsonValue v && v.TryGetValue<string>(out var one)) texts.Add((0, one));
        else if (flow is JsonArray list)
            for (var i = 0; i < list.Count; i++) {
                if (list[i] is JsonValue item && item.TryGetValue<string>(out var text)) texts.Add((i, text));
                else if (list[i] is JsonObject o && o["text"] is JsonValue t && t.TryGetValue<string>(out var inner)) texts.Add((i, inner));
            }
        return texts;
    }

    private static void Read(Context c)
    {
        for (var i = 0; i < c.Ops.Count; i++) {
            if (c.Ops[i] is not JsonObject op) continue;
            var kind = op["op"]?.ToString();
            if (kind == "html" && op["parent"] == null && ScreenDocFacts.Of(op, i) is { } facts) {
                // CX16 r2 (A2): the whole document with screen and basedOn edits that screen (ScreenHtmlEdit.IsEdit, the rule of the
                // apply): judged as an existing root, as the element edits are (no S7, a name it had is the module's).
                c.Documents.Add(new Document { Op = i, Pointer = At(c, i, "/data/html"), Name = facts.Name, Kind = facts.Kind, Source = ScreenDocFacts.Html(op)!, Text = facts.Text, Facts = facts, Existing = facts.Edit });
                continue;
            }
            if (kind == "html" && op["data"] is JsonObject edit && edit["edits"] is JsonArray edits && edit["basedOn"] is JsonObject on) {
                // An element edit: judged on the document it makes of the reading the store keeps (or skipped).
                var kept = on["capture"]?.ToString() is { Length: > 0 } capture && on["html"]?.ToString() is { Length: > 0 } html ? ModuleIndexStore.Default()?.LoadHtmlKeys(capture, html) : null;
                if (kept?["html"] is not JsonValue text || !text.TryGetValue<string>(out var reading)) {
                    c.Skipped.Add(new JsonObject { ["class"] = "S1-S7", ["op"] = i, ["reason"] = "the reading the element edits were written on is not kept here: judged at apply" });
                    continue;
                }
                var keys = (kept["keys"] as JsonObject)?.Where(p => p.Value is JsonValue).ToDictionary(p => p.Key, p => p.Value!.ToString(), StringComparer.Ordinal);
                var applied = HtmlElementEdits.Apply(reading, edits, keys);
                if (applied.Problems.Count > 0) continue;   // the preflight says them
                if (ScreenDocFacts.Of(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = applied.Document } }, i) is { } made)
                    c.Documents.Add(new Document { Op = i, Pointer = At(c, i, "/data/edits"), Name = made.Name, Kind = made.Kind, Source = applied.Document, Text = made.Text, Facts = made, Existing = true,
                        Touched = new HashSet<string>(applied.Touched, StringComparer.Ordinal) });
                continue;
            }
            if (kind == "html" && op["data"] is JsonObject old && old["edit"] != null)
                c.Skipped.Add(new JsonObject { ["class"] = "S1-S7", ["op"] = i, ["reason"] = "an edit of whole elements (edit) is judged with its reading at apply" });
            if (kind == "logic" && op["data"] is JsonObject data)
                foreach (var (index, text) in Texts(data)) ReadLogic(c, i, index, text, data["flow"] is JsonArray ? "/data/flow/" + index : data["flow"] != null ? "/data/flow" : "/data/text");
        }
    }

    private static void ReadLogic(Context c, int op, int index, string text, string at)
    {
        LogicAction? current = null;
        var assignIndent = -1;
        foreach (var raw in text.Replace("\r\n", "\n").Split('\n')) {
            var line = raw.TrimEnd();
            if (line.Length == 0) continue;
            var header = Header.Match(line);
            if (header.Success) {
                current = new LogicAction { Op = op, Pointer = At(c, op, at), Kind = header.Groups[1].Value, Owner = header.Groups[2].Success ? header.Groups[2].Value.Split('/').Last() : null,
                    Name = header.Groups[3].Value, Header = line };
                c.Actions.Add(current);
                assignIndent = -1;
                continue;
            }
            if (current == null) continue;
            var parameter = Parameter.Match(line);
            if (parameter.Success && Indent(line) <= 2) {
                var table = parameter.Groups[1].Value switch { "in" => current.In, "out" => current.Out, _ => current.Local };
                table[parameter.Groups[2].Value] = parameter.Groups[3].Value.Trim();
                continue;
            }
            var trimmed = line.Trim();
            if (assignIndent >= 0 && Indent(line) <= assignIndent) assignIndent = -1;
            if (trimmed == "assign") { assignIndent = Indent(line); continue; }
            if (trimmed.StartsWith("assign ", StringComparison.Ordinal) && Assignment.Match(trimmed) is { Success: true } single) { current.Assigned.Add((single.Groups[1].Value, trimmed)); continue; }
            if (assignIndent >= 0 && Assignment.Match(line) is { Success: true } assigned) current.Assigned.Add((assigned.Groups[1].Value, trimmed));
        }
    }

    private static int Indent(string line) { var n = 0; while (n < line.Length && line[n] is ' ' or '\t') n++; return n; }
    private static string? At(Context c, int op, string rest) => c.Prefix == null ? null : c.Prefix + "/" + op + rest;

    // ---- problems -------------------------------------------------------------------------------------------------------

    // absence: the problem rests on a name the index lacks (a warning unless the index is the module the job is applied to).
    // uncertain: the source itself is not proof (a UI catalog of a version the module may not import): always a warning.
    private static JsonObject Problem(Context c, Document d, HtmlText.Element? at, string code, string message, string fix, string basis, bool absence, JsonObject? edit = null, IEnumerable<string>? candidates = null, bool uncertain = false)
    {
        var where = at == null ? "" : " (line " + d.Text.Position(at.OpenStart).Line + " col " + d.Text.Position(at.OpenStart).Column + ")";
        var severity = uncertain || absence && (!c.Facts.Fresh || c.Unplanned) ? "warning" : "error";
        var problem = JobPreflight.Problem(d.Op, d.Pointer, code, severity, $"{d.Kind} {d.Name}: {message}{where}", fix, null, "html");
        problem["phase"] = "static";
        problem["basis"] = basis;
        if (at != null) problem["element"] = Clip(TagOf(d, at));
        if (candidates != null && candidates.Any()) problem["candidates"] = new JsonArray(candidates.Select(x => (JsonNode)x).ToArray());
        if (edit != null && !d.Existing) problem["edit"] = edit;
        if (at != null && !Judged(d, at)) problem["untouched"] = true;   // dropped by the runner: the Studio's own text
        return problem;
    }

    // Element edits: an element the edits wrote (its k in Touched), one under such an element, or a new one (no k). Any
    // other element is the reading's own text, already accepted by the Studio.
    private static bool Judged(Document d, HtmlText.Element at)
    {
        if (d.Touched == null) return true;
        for (var e = at; e != null; e = e.Parent) {
            var k = e.Get("k");
            if (k == null) { if (ReferenceEquals(e, at)) return true; continue; }
            if (d.Touched.Contains(k)) return true;
        }
        return false;
    }

    private static JsonObject Problem(Context c, LogicAction a, string code, string message, string fix, string basis)
    {
        var problem = JobPreflight.Problem(a.Op, a.Pointer, code, "error", $"{a.Kind} {a.Element}: {message}", fix, null, "logic");
        problem["phase"] = "static";
        problem["basis"] = basis;
        problem["element"] = a.Header;
        return problem;
    }

    private static string TagOf(Document d, HtmlText.Element e) => d.Source[e.OpenStart..Math.Min(d.Source.Length, e.OpenEnd)];
    private static string Clip(string text) => text.Length > 200 ? text[..200] + "…" : text;

    // The certain correction as an edit of the job's text: the smallest text around [start, end) that is once in the document
    // (the attribute, the open tag, the element), with the replacement inside it; null when none is once.
    private static JsonObject? EditOf(Document d, HtmlText.Element e, int start, int end, string replacement)
    {
        var attribute = e.Attributes.FirstOrDefault(a => a.Start <= start && end <= a.End);
        foreach (var (from, to) in new[] { attribute == null ? (-1, -1) : (attribute.Start, attribute.End), (e.OpenStart, e.OpenEnd), (e.OpenStart, e.End) }) {
            if (from < 0 || from > start || to < end) continue;
            var find = d.Source[from..to];
            if (Occurrences(d.Source, find) != 1) continue;
            return new JsonObject { ["element"] = d.Name, ["find"] = find, ["with"] = find[..(start - from)] + replacement + find[(end - from)..] };
        }
        return null;
    }

    private static int Occurrences(string text, string find)
    {
        var n = 0;
        for (var at = text.IndexOf(find, StringComparison.Ordinal); at >= 0 && n < 2; at = text.IndexOf(find, at + 1, StringComparison.Ordinal)) n++;
        return n;
    }

    // ---- S1, S2: blocks -------------------------------------------------------------------------------------------------

    private sealed record Contract(string Source, bool Certain, HashSet<string> Inputs, HashSet<string> Mandatory, HashSet<string> Events, HashSet<string> Placeholders);

    private static Dictionary<string, Contract> Contracts(Context c)
    {
        var contracts = new Dictionary<string, Contract>(StringComparer.OrdinalIgnoreCase);
        static HashSet<string> Set(IEnumerable<string> names) => new(names, StringComparer.OrdinalIgnoreCase);
        foreach (var catalog in c.Basis.UiCatalogs)
            foreach (var block in catalog.Catalog.Blocks.Where(b => b.Public))
                contracts.TryAdd(block.Name, new Contract("ui-catalog " + catalog.Library + (catalog.Version != null ? "-" + catalog.Version : ""), catalog.VersionMatches,
                    Set(block.Inputs.Select(p => p.Name)), Set(block.Inputs.Where(p => p.Mandatory).Select(p => p.Name)), Set(block.Events.Select(e => e.Name)), Set(block.Placeholders.Select(p => p.Name))));
        foreach (var d in c.Documents.Where(d => d.Kind == "block")) {
            var placeholders = d.Text.Elements().Where(e => e.Tag.Equals("placeholder", StringComparison.OrdinalIgnoreCase) && e.Get("name") != null).Select(e => e.Get("name")!);
            contracts[d.Name] = new Contract("job", true, Set(d.Facts.Inputs.Select(i => i.Name)),
                Set(d.Facts.Inputs.Where(i => i.Element.Get("mandatory") is { } m && m.Equals("True", StringComparison.OrdinalIgnoreCase)).Select(i => i.Name)),
                Set(d.Facts.Declared.Where(x => x.Kind == "event").Select(x => x.Name)), Set(placeholders));
        }
        return contracts;
    }

    private static IEnumerable<JsonObject> Blocks(Context c)
    {
        c.Checked.Add("S1"); c.Checked.Add("S2");
        var contracts = Contracts(c);
        var known = new HashSet<string>(contracts.Keys, StringComparer.OrdinalIgnoreCase);
        foreach (var name in c.Facts.Roots("block")) known.Add(name);
        // The blocks the module imports (its index's reference rows, the digest, the job's reference ops) and the producers'.
        foreach (var name in c.Facts.NamesOf(IndexBaseFacts.BlockKind.IsMatch)) known.Add(name);
        foreach (var name in c.Facts.ProducerNames("block")) known.Add(name);
        foreach (var d in c.Documents)
            foreach (var e in d.Text.Elements().Where(e => e.Tag == "Block")) {
                var name = e.Get("name");
                if (string.IsNullOrEmpty(name) || name.Contains(':') || name.StartsWith('@')) continue;
                var shortName = name.Split('.').Last();
                if (!known.Contains(shortName) && !JobPreflight.PossiblyCreated(shortName, c.Words, c.Whole)) {
                    var near = ScreenHtmlEdit.Closest(shortName, known);
                    var certain = ScreenHtmlEdit.Certain(shortName, known);
                    var attribute = e.Find("name")!;
                    yield return Problem(c, d, e, ScreenHtmlEdit.NameUnknown, $"block '{name}' is not a block of this job, of the module, of its references or of the UI catalogs",
                        certain != null ? $"name=\"{certain}\"" : near.Count > 0 ? "one of " + string.Join(", ", near) : "write the <block> in this job, or reference the module that has it",
                        "module-index+ui-catalog", absence: true, certain == null ? null : EditOf(d, e, attribute.ValueStart, attribute.ValueEnd, certain), near);
                    continue;
                }
                if (!contracts.TryGetValue(shortName, out var contract)) continue;
                var uncertain = !contract.Certain;
                var absence = contract.Source == "module-index";
                foreach (var a in e.Attributes) {
                    if (a.Name.StartsWith(':') && !contract.Inputs.Contains(a.Name[1..]))
                        yield return Problem(c, d, e, "ARGUMENT_UNKNOWN", $"block {shortName} has no input '{a.Name[1..]}' (inputs: {string.Join(", ", contract.Inputs.Order())})",
                            ScreenHtmlEdit.Certain(a.Name[1..], contract.Inputs) is { } input ? $":{input}=" : "use one of its inputs", contract.Source, absence,
                            ScreenHtmlEdit.Certain(a.Name[1..], contract.Inputs) is { } fixedInput ? EditOf(d, e, a.Start + 1, a.Start + a.Name.Length, fixedInput) : null, uncertain: uncertain);
                    if (a.Name.StartsWith('@') && contract.Events.Count > 0 && !contract.Events.Contains(a.Name[1..]))
                        yield return Problem(c, d, e, ScreenHtmlEdit.NameUnknown, $"block {shortName} has no event '{a.Name[1..]}' (events: {string.Join(", ", contract.Events.Order())})",
                            "use one of its events", contract.Source, absence, uncertain: uncertain);
                }
                foreach (var missing in contract.Mandatory.Where(m => e.Find(":" + m) == null))
                    yield return Problem(c, d, e, "REQUIRED_ARGUMENT", $"block {shortName} needs its mandatory input '{missing}'", $":{missing}=\"<expression>\"", contract.Source, absence, uncertain: uncertain);
                foreach (var slot in e.Children.Where(x => x.Tag == "slot" && x.Get("name") is { Length: > 0 }))
                    if (contract.Placeholders.Count > 0 && !contract.Placeholders.Contains(slot.Get("name")!))
                        yield return Problem(c, d, slot, ScreenHtmlEdit.SlotUnknown, $"block {shortName} has no placeholder '{slot.Get("name")}' (placeholders: {string.Join(", ", contract.Placeholders.Order())})",
                            ScreenHtmlEdit.Certain(slot.Get("name")!, contract.Placeholders) is { } p ? $"<slot name=\"{p}\">" : "use one of its placeholders", contract.Source, absence,
                            ScreenHtmlEdit.Certain(slot.Get("name")!, contract.Placeholders) is { } placeholder ? EditOf(d, slot, slot.Find("name")!.ValueStart, slot.Find("name")!.ValueEnd, placeholder) : null, uncertain: uncertain);
            }
    }

    private static IEnumerable<(string Name, string Kind)> KindsNamed(Context c, Func<string, bool> kind)
    {
        foreach (var producer in c.Facts.Imported)
            foreach (var typed in producer.Value) {
                var colon = typed.IndexOf(':');
                if (colon > 0 && kind(typed[..colon])) yield return (typed[(colon + 1)..], typed[..colon]);
            }
        if (c.Basis.Digest is { } digest)
            foreach (var (_, k, name) in IndexBaseFacts.DigestReferences(digest)) if (kind(k)) yield return (name, k);
    }

    // ---- S3: events -----------------------------------------------------------------------------------------------------

    private static IEnumerable<JsonObject> Events(Context c)
    {
        c.Checked.Add("S3");
        var screens = new HashSet<string>(c.Documents.Where(d => d.Kind == "screen").Select(d => d.Name), StringComparer.OrdinalIgnoreCase);
        foreach (var name in c.Facts.Roots("screen")) screens.Add(name);
        // The screens the module imports (reference rows of the index, digest, reference ops) and the producers'.
        foreach (var name in c.Facts.NamesOf(IndexBaseFacts.ScreenKind.IsMatch)) screens.Add(name);
        foreach (var name in c.Facts.ProducerNames("screen")) screens.Add(name);
        foreach (var d in c.Documents) {
            // A screen action of actions=, or (in a block) an event the block declares (its handler is the caller's).
            var actions = new HashSet<string>(d.Facts.Actions.Concat(d.Facts.Declared.Where(x => x.Kind == "event").Select(x => x.Name)), StringComparer.OrdinalIgnoreCase);
            foreach (var e in d.Text.Elements())
                foreach (var a in e.Attributes) {
                    if (!(a.Name.StartsWith("on", StringComparison.OrdinalIgnoreCase) || a.Name.StartsWith('@')) || a.Name.Contains('.')) continue;
                    var value = WebUtility.HtmlDecode(a.Value).Trim();
                    var open = value.IndexOf('(');
                    var target = (open < 0 ? value : value[..open]).Trim().TrimEnd(';');
                    if (target.Length == 0 || !Regex.IsMatch(target, @"^[A-Za-z_]\w*$")) continue;   // qualified or not a destination: the apply judges it
                    if (actions.Contains(target) || screens.Contains(target) || JobPreflight.PossiblyCreated(target, c.Words, c.Whole)) continue;
                    var certain = ScreenHtmlEdit.Certain(target, actions);
                    var start = a.ValueStart + a.Value.IndexOf(target, StringComparison.Ordinal);
                    yield return Problem(c, d, e, ScreenHtmlEdit.NameUnknown, $"{a.Name}=\"{target}\": no screen action of actions= and no screen is named '{target}'",
                        certain != null ? $"{a.Name}=\"{certain}\"" : $"list it in actions= and write action {d.Name}.{target} in a logic text of this job, or name a screen",
                        // absence: a name the basis lacks (a warning unless the index is the module the job is applied to, Problem). Before
                        // 20/10/2026 this passed HasIndex, so WITHOUT an index the problem was an error: the opposite of the skip note.
                        "job+module-index", absence: true, certain == null || start < a.ValueStart ? null : EditOf(d, e, start, start + target.Length, certain),
                        ScreenHtmlEdit.Closest(target, actions.Concat(screens)));
                }
        }
    }

    // ---- S4: actions= and data-actions= ---------------------------------------------------------------------------------

    private static IEnumerable<JsonObject> ScreenActions(Context c)
    {
        c.Checked.Add("S4");
        foreach (var d in c.Documents) {
            var root = c.Facts.Root(d.Name, d.Kind == "block");
            var existing = root?.Children.Where(x => x.Key.Contains("Action", StringComparison.Ordinal) || x.Key.Contains("Preparation", StringComparison.Ordinal)).SelectMany(x => x.Value).ToHashSet(StringComparer.OrdinalIgnoreCase) ?? [];
            foreach (var (list, data) in new[] { (d.Facts.Actions, false), (d.Facts.DataActions, true) })
                foreach (var name in list) {
                    var written = c.Actions.Any(a => (a.Kind == "data action") == data && a.Name.Equals(name, StringComparison.OrdinalIgnoreCase) && string.Equals(a.Owner, d.Name, StringComparison.OrdinalIgnoreCase))
                        || c.Job.Actions.Any(a => a.Name.Equals(name, StringComparison.OrdinalIgnoreCase) && a.Owner.EndsWith(":" + d.Name, StringComparison.OrdinalIgnoreCase))
                        || c.Ops.OfType<JsonObject>().Any(o => o["op"]?.ToString() == "create" && string.Equals(o["name"]?.ToString(), name, StringComparison.OrdinalIgnoreCase))
                        // The Preparation of a Traditional screen: its text names the screen (`preparation Screen`), not the action.
                        || name.Equals("Preparation", StringComparison.OrdinalIgnoreCase) && c.Actions.Any(a => a.Kind == "preparation"
                            && (a.Name.Equals(d.Name, StringComparison.OrdinalIgnoreCase) || string.Equals(a.Owner, d.Name, StringComparison.OrdinalIgnoreCase)));
                    if (written || existing.Contains(name)) continue;
                    var attribute = d.Facts.Root.Find(data ? "data-actions" : "actions");
                    yield return Problem(c, d, d.Facts.Root, ScreenHtmlEdit.NameUnknown,
                        $"{(data ? "data action" : "screen action")} '{name}' is listed in {(data ? "data-actions" : "actions")}= but no logic text of this job writes it" + (root != null ? " and the screen has none" : ""),
                        $"write \"{(data ? "data action" : "action")} {d.Name}.{name}\" in a logic text of this job (also: [{{part:\"logic\", text}}]), or take it out of {(data ? "data-actions" : "actions")}=",
                        "job" + (d.Existing ? "+module-index" : ""), absence: d.Existing);
                }
        }
    }

    // ---- S5: the roots of the expressions -------------------------------------------------------------------------------

    private static IEnumerable<JsonObject> Expressions(Context c)
    {
        c.Checked.Add("S5");
        var records = new HashSet<string>(c.Job.Records.Keys, StringComparer.OrdinalIgnoreCase);
        foreach (var d in c.Documents) {
            var scope = new HashSet<string>(d.Facts.Names().Select(n => n.Name), StringComparer.OrdinalIgnoreCase);
            foreach (var e in d.Text.Elements()) {
                if (e.Get("id") is { Length: > 0 } id) scope.Add(id);
                if (e.Get("as") is { Length: > 0 } alias) scope.Add(alias);
                if (e.Get("name") is { Length: > 0 } named && e.Tag is "input" or "var" or "aggregate" or "event") scope.Add(named);
            }
            var outputs = Outputs(c, d);
            var reported = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var e in d.Text.Elements()) {
                if (e.Tag.Equals("aggregate", StringComparison.OrdinalIgnoreCase) || e.Tag is "style" or "script") continue;
                // The value and label of a dropdown are read on the row of its options: a record of an Entity List is the entity
                // (bare attributes; `Entity.Attr` is the type as a value), the row of an aggregate names its sources
                // (`Entity.Attr`); a source this check cannot type is left to the apply.
                var rowOfOptions = e.Get("options") is { Length: > 0 } options && outputs.TryGetValue(options, out var optionsRecord) ? optionsRecord : null;
                foreach (var (start, end, attribute) in Spans(d, e)) {
                    var expression = WebUtility.HtmlDecode(d.Source[start..end]);
                    if (expression != d.Source[start..end]) continue;   // entities: positions would not map; the apply judges it
                    var relative = e.Get("options") != null && attribute is "value" or "label";
                    if (relative && rowOfOptions == null) continue;
                    List<Token> tokens;
                    try { tokens = ExpressionText.Tokens(expression); } catch { continue; }
                    for (var i = 0; i < tokens.Count; i++) {
                        if (!ExpressionText.IsRoot(tokens, i)) continue;
                        if (relative && !tokens[i].Segments[0].Equals(rowOfOptions, StringComparison.OrdinalIgnoreCase)) continue;
                        var segments = tokens[i].Segments;
                        if (segments.Length == 0) continue;
                        var root = segments[0];
                        if (Globals.Contains(root) || c.Facts.Imported.ContainsKey(root) || c.Basis.Module?.ModuleName == root) continue;
                        if (scope.Contains(root)) {
                            if (PathOverList(c, d, e, outputs, segments, start + tokens[i].Start, tokens[i].Text) is { } wrong) yield return wrong;
                            continue;
                        }
                        // A type used as a value: positive evidence (the job's reference or spec, or the index, says it is a type).
                        if (records.Contains(root) || c.Facts.NamesOnlyTypes(root)) {
                            if (!reported.Add("type|" + root + "|" + e.OpenStart + "|" + start)) continue;
                            var source = SourceOf(d, e);
                            var at = start + tokens[i].Start;
                            var replacement = source == null ? null : source + ".Current";
                            yield return Problem(c, d, e, ScreenHtmlEdit.NameUnknown,
                                $"{attribute}: '{root}' is a type (an entity or structure), not a value: '{tokens[i].Text}'" + (source != null ? $"; the row of {source} is {source}.Current" : ""),
                                replacement != null ? $"write {replacement}{tokens[i].Text[root.Length..]}" : $"read the value from the data of the screen (a list's Current, a variable of type {root})",
                                records.Contains(root) ? "job" : "reference+module-index", absence: false,
                                replacement == null ? null : EditOf(d, e, at, at + root.Length, replacement));
                            continue;
                        }
                        if (c.Facts.TopLevel(root) || JobPreflight.PossiblyCreated(root, c.Words, c.Whole)) continue;
                        if (!reported.Add("name|" + root + "|" + e.OpenStart)) continue;
                        var near = ScreenHtmlEdit.Closest(root, scope);
                        var certain = ScreenHtmlEdit.Certain(root, scope);
                        var tokenAt = start + tokens[i].Start;
                        yield return Problem(c, d, e, ScreenHtmlEdit.NameUnknown, $"{attribute}: no variable, input, aggregate, data action or element of the {d.Kind} and nothing of the module is named '{root}'",
                            certain != null ? $"write {certain}" : $"declare it (<var name=\"{root}\" type=\"...\">) or use one of the {d.Kind}'s data" + (near.Count > 0 ? ": " + string.Join(", ", near) : ""),
                            "job+module-index", absence: true, certain == null ? null : EditOf(d, e, tokenAt, tokenAt + root.Length, certain), near);
                    }
                }
            }
        }
    }

    // The expression spans of an element the rules read: expression attributes, :Input, the arguments of events, the {{ }} of
    // texts and of text attributes. (start, end, attribute name).
    private static IEnumerable<(int Start, int End, string Attribute)> Spans(Document d, HtmlText.Element e)
    {
        foreach (var a in e.Attributes) {
            if (a.Name.StartsWith("os-", StringComparison.OrdinalIgnoreCase) || a.Name.Equals("k", StringComparison.Ordinal)) continue;
            if (HtmlText.IsEvent(a.Name)) {
                if (HtmlText.CallArguments(a.Value) is { } arguments) foreach (var argument in arguments) yield return (a.ValueStart + argument.ValueStart, a.ValueStart + argument.ValueEnd, a.Name);
                continue;
            }
            if (a.Name.StartsWith(':') || ExpressionAttributes.Contains(a.Name)) {
                if (a.Value.Contains("{{", StringComparison.Ordinal)) foreach (var (s, t) in HtmlText.Bindings(d.Source, a.ValueStart, a.ValueEnd)) yield return (s, t, a.Name);
                else yield return (a.ValueStart, a.ValueEnd, a.Name);
                continue;
            }
            foreach (var (s, t) in HtmlText.Bindings(d.Source, a.ValueStart, a.ValueEnd)) yield return (s, t, a.Name);
        }
        foreach (var (start, end) in e.Texts)
            foreach (var (s, t) in HtmlText.Bindings(d.Source, start, end)) yield return (s, t, "{{ }}");
    }

    // The list a row of this element comes from: its own options= or list=, else the nearest list= around it.
    private static string? SourceOf(Document d, HtmlText.Element e)
    {
        if (e.Get("options") is { Length: > 0 } options && Regex.IsMatch(options, @"^[A-Za-z_][\w.]*$")) return options;
        for (var p = e; p != null && p.Tag.Length > 0; p = p.Parent)
            if (p.Get("list") is { Length: > 0 } list && Regex.IsMatch(list, @"^[A-Za-z_][\w.]*$")) return list;
        return null;
    }

    // The lists of records the document reads by name: an output of its data actions (the job's logic texts) or a variable or
    // input of type `Entity List` -> the entity.
    private static Dictionary<string, string> Outputs(Context c, Document d)
    {
        var lists = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        static string? Of(string type) => Regex.Match(type, @"^([A-Za-z_]\w*)\s+List$") is { Success: true } m ? m.Groups[1].Value : null;
        foreach (var a in c.Actions.Where(a => a.Kind == "data action" && string.Equals(a.Owner, d.Name, StringComparison.OrdinalIgnoreCase)))
            foreach (var (name, type) in a.Out) if (Of(type) is { } record) lists[a.Name + "." + name] = record;
        foreach (var data in d.Facts.Declared.Where(x => x.Kind is "var" or "input" && x.Type != null))
            if (Of(data.Type!) is { } record) lists[data.Name] = record;
        return lists;
    }

    // `X.List.Current.Entity.Attr` over a list of Entity records (not an aggregate, whose row names its sources): the row is
    // the entity, `.Current.Attr`. Certain when the entity has no attribute of its own name.
    private static JsonObject? PathOverList(Context c, Document d, HtmlText.Element e, Dictionary<string, string> lists, string[] segments, int at, string text)
    {
        for (var n = 0; n + 2 < segments.Length; n++) {
            var list = string.Join(".", segments[..(n + 1)]);
            if (!lists.TryGetValue(list, out var record) || !segments[n + 1].Equals("Current", StringComparison.OrdinalIgnoreCase)
                || !segments[n + 2].Equals(record, StringComparison.OrdinalIgnoreCase)) continue;
            var attributes = c.Job.Records.TryGetValue(record, out var declared) ? declared : c.Facts.Attributes(record);
            var known = attributes != null && !attributes.ContainsKey(record);
            var wrong = "." + segments[n + 1] + "." + segments[n + 2];
            var offset = text.IndexOf(wrong, StringComparison.OrdinalIgnoreCase);
            var edit = known && offset >= 0 ? EditOf(d, e, at + offset, at + offset + wrong.Length, "." + segments[n + 1]) : null;
            return Problem(c, d, e, ScreenHtmlEdit.NameUnknown,
                $"'{text}': the row of {list} is a {record} (a {record} List), so {list}.Current has no '{segments[n + 2]}'",
                $"write {list}.Current.{string.Join(".", segments[(n + 3)..])}", known ? "job+reference" : "job", absence: !known, edit);
        }
        return null;
    }

    // ---- S5: a type of a producer the job references but does not import -----------------------------------------------

    public const string ReferenceMissing = "REFERENCE_MISSING";
    private static readonly HashSet<string> BasicTypes = new(StringComparer.OrdinalIgnoreCase)
        { "Text", "Integer", "Long Integer", "Decimal", "Boolean", "Date", "Time", "Date Time", "DateTime", "Currency", "Email", "Phone Number", "Binary Data", "Object", "Record", "List" };

    private static IEnumerable<JsonObject> References(Context c)
    {
        c.Checked.Add("S5-reference");
        if (c.Basis.Producers.Count == 0) { c.Skipped.Add(new JsonObject { ["class"] = "S5-reference", ["reason"] = "no producer index: a type the reference op lacks is not looked up" }); yield break; }
        var uses = new List<(string Type, Func<string, string, JsonObject> Problem)>();
        foreach (var d in c.Documents)
            foreach (var data in d.Facts.Declared.Where(x => x.Type != null))
                uses.Add((data.Type!, (message, fix) => Problem(c, d, data.Element, ReferenceMissing, message, fix, "producer-index", absence: true)));
        foreach (var a in c.Actions)
            foreach (var (_, type) in a.In.Concat(a.Out).Concat(a.Local))
                uses.Add((type, (message, fix) => { var p = Problem(c, a, ReferenceMissing, message, fix, "producer-index"); if (!c.Facts.Fresh) p["severity"] = "warning"; return p; }));
        var reported = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (written, problem) in uses) {
            var type = Regex.Replace(written.Trim(), @"\s+(List|Identifier)$", "", RegexOptions.IgnoreCase).Trim();
            if (type.Length == 0 || BasicTypes.Contains(type) || type.Contains(' ') || type.Contains('.') || c.Job.Records.ContainsKey(type) || c.Facts.KindsOf(type).Count > 0
                || JobPreflight.PossiblyCreated(type, new HashSet<string>(StringComparer.OrdinalIgnoreCase), c.Whole)) continue;
            var owners = c.Basis.Producers.Where(p => c.Facts.Imported.ContainsKey(p.Name) && p.Index != null)
                .Select(p => (p.Name, Row: p.Index!.Rows().FirstOrDefault(r => string.Equals(r.Name, type, StringComparison.OrdinalIgnoreCase) && (r.Role is "entity" or "staticEntity" or "structure"))))
                .Where(x => x.Row != null).ToList();
            if (owners.Count == 0 || !reported.Add(type)) continue;
            var kind = owners[0].Row!.Role switch { "staticEntity" => "IStaticEntity", "structure" => "IStructure", _ => "IServerEntity" };
            var p = problem($"'{type}' is a {owners[0].Row!.Role} of {string.Join(", ", owners.Select(o => o.Name))}, which this job references, but its reference op does not import it",
                $"add \"{kind}:{type}\" to the elements of the reference op of {owners[0].Name}");
            var at = c.Ops.Select((o, i) => (o, i)).FirstOrDefault(x => x.o is JsonObject r && r["op"]?.ToString() == "reference" && string.Equals(r["producer"]?.ToString(), owners[0].Name, StringComparison.OrdinalIgnoreCase));
            if (owners.Count == 1 && at.o != null && c.Prefix != null)
                p["patch"] = new JsonArray(new JsonObject { ["op"] = "add", ["path"] = c.Prefix + "/" + at.i + "/elements/-", ["value"] = kind + ":" + type });
            yield return p;
        }
    }

    // ---- S6: roles ------------------------------------------------------------------------------------------------------

    private static IEnumerable<JsonObject> Roles(Context c)
    {
        c.Checked.Add("S6");
        foreach (var d in c.Documents.Where(d => d.Kind == "screen")) {
            foreach (var role in ScreenDocFacts.List(d.Facts.Root.Get("roles"))) {
                if (SystemRoles.Contains(role) || c.Facts.KindsOf(role).Any(k => k.StartsWith("Role", StringComparison.Ordinal)) || JobPreflight.PossiblyCreated(role, c.Words, c.Whole)) continue;
                yield return Problem(c, d, d.Facts.Root, ScreenHtmlEdit.NameUnknown, $"role '{role}' is not a role of the module, of its references or of this job",
                    "create it (ddl: role " + role + ") or reference it (reference op: IRole:" + role + ")", "module-index+reference", absence: true,
                    candidates: ScreenHtmlEdit.Closest(role, KindsNamed(c, k => k.StartsWith("Role", StringComparison.Ordinal)).Select(x => x.Name)));
            }
        }
    }

    // ---- S7: a new root whose name the module has -----------------------------------------------------------------------

    private static IEnumerable<JsonObject> Roots(Context c)
    {
        c.Checked.Add("S7");
        if (!c.Facts.HasIndex) yield break;
        var taken = new HashSet<string>(c.Facts.Roots("screen").Concat(c.Facts.Roots("block")), StringComparer.OrdinalIgnoreCase);
        var removed = c.Ops.OfType<JsonObject>().Where(o => o["op"]?.ToString() is "delete" or "rename").Select(o => o["target"]?.ToString() ?? "").ToList();
        foreach (var d in c.Documents.Where(d => !d.Existing && taken.Contains(d.Name))) {
            if (removed.Any(t => t.EndsWith(":" + d.Name, StringComparison.OrdinalIgnoreCase) || t.EndsWith("/" + d.Name, StringComparison.OrdinalIgnoreCase))) continue;
            yield return Problem(c, d, d.Facts.Root, ScreenDocument.RootExists, $"the module already has a screen or block named '{d.Name}': the document form creates a new one (the Studio would name it {d.Name}2)",
                "give it another name, or change the existing one through its reading (ssam_map view html) and element edits", "module-index", absence: true);
        }
    }

    // ---- L1-L3: the logic texts against their screen --------------------------------------------------------------------

    private static IEnumerable<JsonObject> LogicScopes(Context c)
    {
        c.Checked.Add("L1-L3");
        // The logic ops in the JSON form (data.actions): their data actions' outputs (L2; the inputs of a screen action are
        // ScopeRenames', in the preflight).
        foreach (var fact in c.Job.Actions.Where(a => a.Kind == "data")) {
            var d = c.Documents.FirstOrDefault(x => fact.Owner.EndsWith(":" + x.Name, StringComparison.OrdinalIgnoreCase));
            if (d == null) continue;
            var data = d.Facts.Declared.Select(x => x.Name).Concat(d.Facts.DataActions).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var at = c.Prefix == null ? null : $"{c.Prefix}/{fact.Op}/data/actions/{fact.Index}";
            var names = fact.Kind == "data" ? fact.Outputs.Select(o => o.Name).Where(o => !o.Equals(fact.Name, StringComparison.OrdinalIgnoreCase)) : fact.Inputs.Select(i => i.Name);
            foreach (var name in names.Where(data.Contains)) {
                var problem = JobPreflight.Problem(fact.Op, at, "NAME_COLLISION", "error",
                    fact.Kind == "data" ? $"data action {d.Name}.{fact.Name}: output '{name}' has the name of a data element of {d.Kind} {d.Name} (they share one scope; the Studio renames it)"
                        : $"action {d.Name}.{fact.Name}: input '{name}' has the name of a data element of {d.Kind} {d.Name}: the Studio renames it {name}2 and the events that pass {name} no longer match",
                    fact.Kind == "data" ? $"rename the output (e.g. {fact.Name}{name})" : $"rename the input (e.g. {name}Value) and the arguments that pass it", null, "logic");
                problem["phase"] = "static"; problem["basis"] = "job";
                yield return problem;
            }
        }
        foreach (var a in c.Actions.Where(a => a.Owner != null)) {
            var d = c.Documents.FirstOrDefault(x => x.Name.Equals(a.Owner, StringComparison.OrdinalIgnoreCase));
            if (d == null) continue;
            var variables = d.Facts.Variables.Select(v => v.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var data = d.Facts.Declared.Select(x => x.Name).Concat(d.Facts.DataActions).ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (a.Kind == "data action") {
                foreach (var (name, line) in a.Assigned.DistinctBy(x => x.Name, StringComparer.OrdinalIgnoreCase))
                    if (variables.Contains(name) && !a.Out.ContainsKey(name) && !a.Local.ContainsKey(name) && !a.In.ContainsKey(name))
                        yield return Problem(c, a, "EXPR_UNKNOWN_IDENTIFIER", $"assigns '{name}', a local variable of {d.Kind} {d.Name}: a data action does not see the {d.Kind}'s local variables ({line})",
                            $"set '{name}' in the screen action that refreshes {a.Name} (or after its data is fetched), or make it an output of {a.Name}", "job");
                foreach (var name in a.Out.Keys.Where(o => data.Contains(o) && !o.Equals(a.Name, StringComparison.OrdinalIgnoreCase)))
                    yield return Problem(c, a, "NAME_COLLISION", $"output '{name}' has the name of a data element of {d.Kind} {d.Name} (they share one scope; the Studio renames it)",
                        $"rename the output (e.g. {a.Name}{name})", "job");
            } else if (a.Kind == "action") {
                foreach (var name in a.In.Keys.Where(data.Contains))
                    yield return Problem(c, a, "NAME_COLLISION", $"input '{name}' has the name of a data element of {d.Kind} {d.Name}: the Studio renames it {name}2 and the events that pass {name} no longer match",
                        $"rename the input (e.g. {name}Value) and the arguments that pass it", "job");
            }
        }
    }
}
