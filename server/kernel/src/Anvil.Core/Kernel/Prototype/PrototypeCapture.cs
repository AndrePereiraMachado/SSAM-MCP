using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// The capture of a prototype (IR ssam-prototype-capture/1, docs/PROTOTIPO-NATIVO.md 2.10) as the kernel reads it: only the
/// content-addressed bundle next to capture.json, never the prototype source (2.9). Reading validates the whole document and
/// collects every problem (PROTOTYPE_IR_INVALID, a defect of the SSAM, never of the model): the schema, the closed sets of
/// effects and annotations, the references between views, modals, dimensions, collections and events, and the bundle files,
/// whose sha256 must be the one the IR records. The canonical hash (sorted keys, document order, without timings,
/// engine.node and source.root) is the one data.captureSha256 carries.
/// </summary>
public sealed class PrototypeCapture
{
    public const string Schema = "ssam-prototype-capture/1";
    public const string IrInvalid = "PROTOTYPE_IR_INVALID";
    public const string NameCollision = "PROTOTYPE_NAME_COLLISION";

    public static readonly IReadOnlyList<string> DataKeys = ["source", "entry", "app", "prefix", "mapping", "clock", "tz", "home", "seed", "capture", "captureSha256"];
    public static readonly IReadOnlyList<string> MappingKeys = ["screens", "default", "routes", "shell", "states", "modals", "data", "vendor", "events", "ignore", "names"];
    public static readonly IReadOnlyList<string> Effects = ["navigate", "openPopup", "closePopup", "setDimension", "toggle", "increment", "remove", "update", "insert", "upsert", "insertFrom", "updateFrom", "removeWhere", "validate", "toast"];
    public static readonly IReadOnlyList<string> DataEffects = ["toggle", "increment", "remove", "update", "insert", "upsert", "insertFrom", "updateFrom", "removeWhere"];
    public static readonly IReadOnlyList<string> PredicateOps = ["truthy", "not", "eq", "ne", "gt", "ge", "lt", "le", "in", "contains", "len-ge", "len-le", "len-gt", "len-lt", "and", "or"];

    public JsonObject Json { get; }
    public string CapturePath { get; }
    public string BundleRoot { get; }
    public string Sha256 { get; }
    public string Prefix { get; }
    public bool PrefixRequested { get; }
    public string Lang { get; }
    public bool Portuguese => Lang.StartsWith("pt", StringComparison.OrdinalIgnoreCase);
    public JsonObject Data { get; }
    public JsonObject Mapping { get; }
    public IReadOnlyList<JsonObject> Views { get; }
    public IReadOnlyList<JsonObject> Modals { get; }
    public IReadOnlyList<JsonObject> Events { get; }
    public IReadOnlyList<JsonObject> Dimensions { get; }
    public IReadOnlyList<JsonObject> Collections { get; }
    public IReadOnlyList<JsonObject> Sheets { get; }
    public IReadOnlyList<JsonObject> Assets { get; }
    public JsonObject? Shell { get; }
    public JsonObject Icons { get; }
    public double DefaultStrokeWidth { get; }

    private PrototypeCapture(JsonObject json, string path, string sha, JsonObject data)
    {
        Json = json; CapturePath = path; BundleRoot = System.IO.Path.GetDirectoryName(path)!; Sha256 = sha; Data = data;
        Mapping = data["mapping"] as JsonObject ?? new JsonObject();
        var explicitPrefix = data["prefix"]?.GetValue<string>();
        PrefixRequested = explicitPrefix != null;
        Prefix = explicitPrefix ?? json["app"]?["prefix"]?.GetValue<string>() ?? PrototypeNames.PrefixOf(json["app"]?["title"]?.GetValue<string>(), null);
        Lang = json["app"]?["lang"]?.GetValue<string>() ?? "en";
        Views = Objects(json["views"]); Modals = Objects(json["modals"]); Events = Objects(json["events"]);
        Dimensions = Objects(json["dimensions"]); Collections = Objects(json["store"]?["collections"]);
        Sheets = Objects(json["css"]?["sheets"]); Assets = Objects(json["assets"]);
        Shell = json["shell"] as JsonObject;
        Icons = json["icons"] as JsonObject ?? new JsonObject();
        DefaultStrokeWidth = Icons["defaultStrokeWidth"] is JsonValue d && d.TryGetValue<double>(out var dv) ? dv : 2;
    }

    public JsonObject? View(string key) => Views.FirstOrDefault(v => v["key"]?.ToString() == key);
    public JsonObject? Modal(string key) => Modals.FirstOrDefault(m => m["key"]?.ToString() == key);
    public JsonObject? Dimension(string key) => Dimensions.FirstOrDefault(m => m["key"]?.ToString() == key);
    public JsonObject? Collection(string name) => Collections.FirstOrDefault(c => string.Equals(c["name"]?.ToString(), name, StringComparison.Ordinal));
    public JsonObject? Event(string key) => Events.FirstOrDefault(e => e["key"]?.ToString() == key);
    public bool Mutated(string collection) => Collection(collection)?["mutated"]?.GetValue<bool>() == true;

    internal static IReadOnlyList<JsonObject> Objects(JsonNode? node) => node is JsonArray a ? a.OfType<JsonObject>().ToList() : [];

    /// <summary>Reads and validates the capture named by data.capture. Every problem goes to <paramref name="problems"/>
    /// (pointer relative to the op's data); null when the document cannot be read at all.</summary>
    public static PrototypeCapture? Load(JsonObject data, List<Problem> problems)
    {
        foreach (var key in data.Select(p => p.Key).Where(k => !k.StartsWith('_') && !DataKeys.Contains(k)))
            problems.Add(new("INPUT_INVALID", "/" + key, $"prototype: unknown key '{key}'; closest: '{Closest(key, DataKeys)}'; keys: {string.Join(", ", DataKeys)}", false,
                new JsonArray(new JsonObject { ["op"] = "remove", ["path"] = "/" + key })));
        if (data["mapping"] is JsonObject mapping)
            foreach (var key in mapping.Select(p => p.Key).Where(k => !MappingKeys.Contains(k)))
                problems.Add(new("INPUT_INVALID", "/mapping/" + key, $"prototype: unknown mapping key '{key}'; closest: '{Closest(key, MappingKeys)}'; keys: {string.Join(", ", MappingKeys)}", false, null));
        else if (data["mapping"] != null) problems.Add(new("INPUT_INVALID", "/mapping", "prototype: mapping must be an object", false, null));
        // mapping.names: the name map a PROTOTYPE_NAME_COLLISION gives ("<Owner>/<Name>" or "<Name>" -> a free identifier)
        if (data["mapping"]?["names"] is { } namesNode)
        {
            if (namesNode is not JsonObject names) problems.Add(new("INPUT_INVALID", "/mapping/names", "prototype: mapping.names is an object {\"<Owner>/<Name>\" or \"<Name>\": \"<free name>\"}", false, null));
            else
                foreach (var (key, value) in names)
                    if (value is not JsonValue v || !v.TryGetValue<string>(out var to) || !PrototypeNames.IsWidgetName(to) || key.Length == 0 || key.EndsWith('/'))
                        problems.Add(new("INPUT_INVALID", "/mapping/names/" + key.Replace("~", "~0").Replace("/", "~1"), $"prototype: mapping.names '{key}' must map to an identifier (^[A-Za-z][A-Za-z0-9_]*$), got '{value?.ToJsonString()}'", false, null));
        }
        if (data["prefix"] is { } prefixNode && (prefixNode is not JsonValue pv || !pv.TryGetValue<string>(out var prefixText) || !PrototypeNames.PrefixShape.IsMatch(prefixText)))
            problems.Add(new("INPUT_INVALID", "/prefix", "prototype: prefix must match ^[A-Za-z][A-Za-z0-9]*$", false, null));
        if (data["capture"] is not JsonValue cv || !cv.TryGetValue<string>(out var path) || path.Length == 0)
        {
            problems.Add(new(IrInvalid, "/capture", "prototype: data.capture is missing: the facade writes it (capturePrototype) before the kernel runs; the kernel never reads the prototype source", true, null));
            return null;
        }
        if (!File.Exists(path)) { problems.Add(new(IrInvalid, "/capture", $"prototype: the capture {path} does not exist", true, null)); return null; }
        JsonObject json;
        try { json = JsonNode.Parse(File.ReadAllText(path)) as JsonObject ?? throw new JsonException("not an object"); }
        catch (Exception ex) { problems.Add(new(IrInvalid, "/capture", $"prototype: the capture {path} is not JSON: {ex.Message}", true, null)); return null; }
        var sha = CanonicalSha256(json);
        if (data["captureSha256"] is JsonValue hv && hv.TryGetValue<string>(out var given) && given.Length > 0 && !string.Equals(given, sha, StringComparison.OrdinalIgnoreCase))
            problems.Add(new(IrInvalid, "/captureSha256", $"prototype: the capture hash is {sha}, data.captureSha256 says {given}; the facade recaptures a stale capture before the kernel runs", true, null));
        // the hash is the facade's, over the capture as written; the compiler reads it in its own spelling (PrototypeDialect)
        try { json = PrototypeDialect.Normalize(json); }
        catch (Exception ex) when (ex is InvalidOperationException or FormatException or ArgumentException or KeyNotFoundException or NullReferenceException)
        {
            problems.Add(new(IrInvalid, "/capture", $"prototype: the capture {path} could not be read in the compiler's form: {ex.Message}", true, null));
            return null;
        }
        var capture = new PrototypeCapture(json, Path.GetFullPath(path), sha, data);
        capture.Validate(problems);
        return capture;
    }

    public sealed record Problem(string Code, string Pointer, string Message, bool SsamDefect, JsonArray? Patch, string? IrPath = null);

    private void Validate(List<Problem> problems)
    {
        void Bad(string irPath, string message) => problems.Add(new(IrInvalid, "/capture", $"prototype: capture {irPath}: {message}", true, null, irPath));
        if (Json["schema"]?.ToString() != Schema) Bad("/schema", $"schema must be {Schema}, got '{Json["schema"]}'");
        if (!PrototypeNames.PrefixShape.IsMatch(Prefix)) Bad("/app/prefix", $"prefix '{Prefix}' must match ^[A-Za-z][A-Za-z0-9]*$");
        if (Views.Count == 0) Bad("/views", "a capture has at least one view");
        var viewKeys = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < Views.Count; i++)
        {
            var v = Views[i]; var at = $"/views/{i}";
            if (v["key"]?.ToString() is not { Length: > 0 } key) { Bad(at + "/key", "missing"); continue; }
            if (!viewKeys.Add(key)) Bad(at + "/key", $"view {key} is declared twice");
            if (v["name"]?.ToString() is not { Length: > 0 } name || !PrototypeNames.IsWidgetName(name)) Bad(at + "/name", $"view {key}: name must be a PascalCase identifier, got '{v["name"]}'");
            if (v["root"] is not JsonObject root) Bad(at + "/root", $"view {key}: root is missing"); else Node(root, at + "/root", Bad);
            foreach (var (p, j) in Objects(v["params"]).Select((p, j) => (p, j)))
                if (p["name"]?.ToString() is not { Length: > 0 } || p["type"]?.ToString() is not ("Integer" or "Text" or "Decimal" or "Boolean")) Bad($"{at}/params/{j}", "a view parameter has name and type Integer|Text|Decimal|Boolean");
        }
        if (Views.Count(v => v["default"]?.GetValue<bool>() == true) > 1) Bad("/views", "more than one view is default");
        var modalKeys = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < Modals.Count; i++)
        {
            var m = Modals[i]; var at = $"/modals/{i}";
            if (m["key"]?.ToString() is not { Length: > 0 } key) { Bad(at + "/key", "missing"); continue; }
            if (!modalKeys.Add(key)) Bad(at + "/key", $"modal {key} is declared twice");
            if (m["name"]?.ToString() is not { Length: > 0 } name || !PrototypeNames.IsWidgetName(name)) Bad(at + "/name", $"modal {key}: name must be a PascalCase identifier");
            if (m["root"] is not JsonObject root) Bad(at + "/root", $"modal {key}: root is missing"); else Node(root, at + "/root", Bad);
            foreach (var (o, j) in Objects(m["openedFrom"]).Select((o, j) => (o, j)))
                if (o["view"]?.ToString() is { } view && !viewKeys.Contains(view)) Bad($"{at}/openedFrom/{j}/view", $"view {view} is not a view of the capture");
            if (m["record"] is JsonObject record && record["collection"]?.ToString() is { } rc && Collection(rc) == null) Bad(at + "/record/collection", $"collection {rc} is not in the store");
        }
        var dims = new HashSet<string>(Dimensions.Select(d => d["key"]?.ToString() ?? ""), StringComparer.Ordinal);
        for (var i = 0; i < Dimensions.Count; i++)
        {
            var d = Dimensions[i]; var at = $"/dimensions/{i}";
            if (d["key"]?.ToString() is not { Length: > 0 }) Bad(at + "/key", "missing");
            if (d["name"]?.ToString() is not { Length: > 0 } dn || !PrototypeNames.IsWidgetName(dn)) Bad(at + "/name", "a dimension has a PascalCase name");
            if (d["type"]?.ToString() is not ("Integer" or "Text" or "Boolean" or "Decimal")) Bad(at + "/type", "type must be Integer|Text|Boolean|Decimal");
            if (d["scope"]?.ToString() is not ("global" or "screen")) Bad(at + "/scope", "scope must be global or screen");
        }
        var collections = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < Collections.Count; i++)
        {
            var c = Collections[i]; var at = $"/store/collections/{i}";
            if (c["name"]?.ToString() is not { Length: > 0 } name || !PrototypeNames.IsWidgetName(name)) { Bad(at + "/name", "a collection has a PascalCase name"); continue; }
            if (!collections.Add(name)) Bad(at + "/name", $"collection {name} is declared twice");
            var fields = Objects(c["fields"]);
            if (!fields.Any(f => f["name"]?.ToString() == (c["key"]?.ToString() ?? "Id"))) Bad(at + "/key", $"collection {name}: the key {c["key"] ?? "Id"} is not a field");
            foreach (var (f, j) in fields.Select((f, j) => (f, j)))
                if (f["type"]?.ToString() is not ("Integer" or "Decimal" or "Boolean" or "DateTime" or "Text")) Bad($"{at}/fields/{j}/type", "type must be Integer|Decimal|Boolean|DateTime|Text");
        }
        foreach (var c in Collections)
            foreach (var (r, j) in Objects(c["references"]).Select((r, j) => (r, j)))
                if (r["collection"]?.ToString() is { } target && !collections.Contains(target)) Bad($"/store/collections/{c["name"]}/references/{j}", $"collection {target} is not in the store");
        var eventKeys = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < Events.Count; i++)
        {
            var e = Events[i]; var at = $"/events/{i}";
            if (e["key"]?.ToString() is not { Length: > 0 } key) { Bad(at + "/key", "missing"); continue; }
            if (!eventKeys.Add(key)) Bad(at + "/key", $"event {key} is declared twice");
            if (e["view"]?.ToString() is { } view && !viewKeys.Contains(view)) Bad(at + "/view", $"view {view} is not a view of the capture");
            if (e["modal"]?.ToString() is { } modal && !modalKeys.Contains(modal)) Bad(at + "/modal", $"modal {modal} is not a modal of the capture");
            var lists = new List<(JsonArray List, string At)>();
            if (e["effects"] is JsonArray effects) lists.Add((effects, at + "/effects"));
            foreach (var (c, j) in Objects(e["cases"]).Select((c, j) => (c, j)))
            {
                if (c["effects"] is JsonArray ce) lists.Add((ce, $"{at}/cases/{j}/effects")); else Bad($"{at}/cases/{j}", "a case has effects");
                if (c["when"] is JsonObject when) Predicate(when, $"{at}/cases/{j}/when", Bad);
            }
            if (lists.Count == 0) Bad(at, $"event {key} has no effects");
            foreach (var (list, listAt) in lists)
                for (var j = 0; j < list.Count; j++)
                {
                    if (list[j] is not JsonObject effect) { Bad($"{listAt}/{j}", "an effect is an object"); continue; }
                    var kind = effect["kind"]?.ToString();
                    if (kind == null || !Effects.Contains(kind)) { Bad($"{listAt}/{j}/kind", $"effect '{kind}' is not one of {string.Join(", ", Effects)}"); continue; }
                    if (kind == "navigate" && effect["view"]?.ToString() is { } nv && !viewKeys.Contains(nv)) Bad($"{listAt}/{j}/view", $"view {nv} is not a view of the capture");
                    if (kind is "openPopup" && (effect["modal"]?.ToString() is not { } om || !modalKeys.Contains(om))) Bad($"{listAt}/{j}/modal", $"modal {effect["modal"]} is not a modal of the capture");
                    if (kind == "setDimension" && (effect["dimension"]?.ToString() is not { } dk || !dims.Contains(dk))) Bad($"{listAt}/{j}/dimension", $"dimension {effect["dimension"]} is not a dimension of the capture");
                    var collectionKeys = kind is "insertFrom" or "updateFrom" ? new[] { "target", "source" } : kind == "removeWhere" ? new[] { "target" } : DataEffects.Contains(kind) ? new[] { "collection" } : [];
                    foreach (var collectionKey in collectionKeys)
                        if (effect[collectionKey] is not JsonValue cv2 || !cv2.TryGetValue<string>(out var cn) || !collections.Contains(cn)) Bad($"{listAt}/{j}/{collectionKey}", $"collection {effect[collectionKey]?.ToJsonString() ?? "(missing)"} is not in the store");
                }
        }
        foreach (var view in Views)
            foreach (var key in EventsOf(view["root"])) if (!eventKeys.Contains(key)) Bad($"/views/{view["key"]}", $"a node names event {key}, which is not in events");
        foreach (var modal in Modals)
            foreach (var key in EventsOf(modal["root"])) if (!eventKeys.Contains(key)) Bad($"/modals/{modal["key"]}", $"a node names event {key}, which is not in events");
        if (Shell != null)
        {
            if (Shell["root"] is not JsonObject root) Bad("/shell/root", "the shell has a root"); else Node(root, "/shell/root", Bad);
            foreach (var (n, j) in Objects(Shell["after"]).Select((n, j) => (n, j))) Node(n, $"/shell/after/{j}", Bad);
        }
        // the bundle: every sheet and asset the IR names is there, with its sha256
        foreach (var (sheet, i) in Sheets.Select((s, i) => (s, i)))
            Bundle(sheet, $"/css/sheets/{i}", Bad);
        foreach (var (asset, i) in Assets.Select((s, i) => (s, i)))
            Bundle(asset, $"/assets/{i}", Bad);
    }

    private void Bundle(JsonObject entry, string at, Action<string, string> bad)
    {
        if (entry["bundle"]?.ToString() is not { Length: > 0 } relative) { bad(at + "/bundle", "missing"); return; }
        var file = BundleFile(relative);
        if (file == null || !File.Exists(file)) { bad(at + "/bundle", $"{relative} is not in the bundle next to capture.json"); return; }
        var actual = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))).ToLowerInvariant();
        if (!string.Equals(actual, entry["sha256"]?.ToString(), StringComparison.OrdinalIgnoreCase))
            bad(at + "/sha256", $"{relative} has sha256 {actual}, the IR says {entry["sha256"]}");
    }

    /// <summary>The absolute path of a bundle file, only inside the bundle root (relative paths, no escape upwards).</summary>
    public string? BundleFile(string relative)
    {
        if (Path.IsPathRooted(relative)) return null;
        var full = Path.GetFullPath(Path.Combine(BundleRoot, relative));
        return full.StartsWith(Path.GetFullPath(BundleRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ? full : null;
    }

    public string SheetText(JsonObject sheet) => File.ReadAllText(BundleFile(sheet["bundle"]!.ToString())!);
    public byte[] AssetBytes(JsonObject asset) => File.ReadAllBytes(BundleFile(asset["bundle"]!.ToString())!);

    private static readonly string[] Annotations = ["icon", "list", "if", "else", "classExpr", "attrExpr", "expr", "events", "control", "nav", "viewExpr", "placeholder", "toast", "message"];

    private static void Node(JsonObject node, string at, Action<string, string> bad, int depth = 0)
    {
        if (depth > 200) { bad(at, "nesting deeper than 200"); return; }
        if (node["k"]?.ToString() is not { Length: > 0 }) bad(at + "/k", "every node has a key k");
        if (node["x"] != null) { if (node["x"] is not JsonValue) bad(at + "/x", "text must be a string"); return; }
        if (node["t"]?.ToString() is not { Length: > 0 } tag) { bad(at + "/t", "an element node has t (tag) and a text node x"); return; }
        if (node["a"] is JsonArray attrs)
            foreach (var pair in attrs)
                if (pair is not JsonArray p || p.Count != 2 || p[0] is not JsonValue || p[1] is not JsonValue) { bad(at + "/a", "attributes are [name, value] pairs of strings"); break; }
        if (node["if"] is JsonObject iff) Predicate(iff, at + "/if", bad);
        if (node["list"] is JsonObject list)
        {
            if (list["template"] is not JsonObject template) bad(at + "/list/template", "a list has its item template");
            else Node(template, at + "/list/template", bad, depth + 1);
            if (list["collection"] == null && list["snapshot"] is not JsonObject) bad(at + "/list", "a list has a collection or a snapshot");
            if (list["mode"]?.ToString() is not ("self" or "wrap")) bad(at + "/list/mode", "mode must be self or wrap");
            if (list["filter"] is JsonObject filter) Predicate(filter, at + "/list/filter", bad);
        }
        if (node["else"] is JsonArray otherwise) foreach (var (n, j) in otherwise.OfType<JsonObject>().Select((n, j) => (n, j))) Node(n, $"{at}/else/{j}", bad, depth + 1);
        if (tag == "svg" && node["icon"] is JsonObject icon && icon["name"]?.ToString() is not { Length: > 0 }) bad(at + "/icon/name", "an icon has a name");
        if (node["c"] is JsonArray children)
            for (var i = 0; i < children.Count; i++)
                if (children[i] is JsonObject child) Node(child, $"{at}/c/{i}", bad, depth + 1); else bad($"{at}/c/{i}", "a child is a node object");
    }

    private static void Predicate(JsonObject pred, string at, Action<string, string> bad)
    {
        var op = pred["op"]?.ToString();
        if (op == null || !PredicateOps.Contains(op)) { bad(at + "/op", $"predicate op '{op}' is not one of {string.Join(", ", PredicateOps)}"); return; }
        if (op is "and" or "or" or "not")
        {
            if (pred["a"] is not JsonArray a || a.Count == 0) { bad(at + "/a", $"{op} has a list a of predicates"); return; }
            foreach (var (p, i) in a.OfType<JsonObject>().Select((p, i) => (p, i))) Predicate(p, $"{at}/a/{i}", bad);
        }
    }

    internal static IEnumerable<string> EventsOf(JsonNode? node)
    {
        if (node is not JsonObject o) yield break;
        foreach (var e in o["events"] as JsonArray ?? []) if (e?.ToString() is { } key) yield return key;
        foreach (var c in o["c"] as JsonArray ?? []) foreach (var k in EventsOf(c)) yield return k;
        foreach (var c in o["else"] as JsonArray ?? []) foreach (var k in EventsOf(c)) yield return k;
        if (o["list"]?["template"] is JsonObject t) foreach (var k in EventsOf(t)) yield return k;
        if (o["toast"]?["template"] is JsonObject tt) foreach (var k in EventsOf(tt)) yield return k;
    }

    // ---- canonical JSON and hash --------------------------------------------------------------------------------------------

    /// <summary>sha256 of the canonical JSON of the IR: keys sorted (ordinal), arrays in order, without timings, engine.node and
    /// source.root (2.1); strings escaped as JavaScript's JSON.stringify escapes them and numbers as written.</summary>
    public static string CanonicalSha256(JsonObject capture)
    {
        var copy = capture.DeepClone().AsObject();
        copy.Remove("timings");
        if (copy["engine"] is JsonObject engine) engine.Remove("node");
        if (copy["source"] is JsonObject source) source.Remove("root");
        var sb = new StringBuilder();
        Canonical(copy, sb);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()))).ToLowerInvariant();
    }

    public static string Canonical(JsonNode? node)
    {
        var sb = new StringBuilder(); Canonical(node, sb); return sb.ToString();
    }

    private static void Canonical(JsonNode? node, StringBuilder sb)
    {
        switch (node)
        {
            case null: sb.Append("null"); break;
            case JsonObject o:
                sb.Append('{');
                var first = true;
                foreach (var (key, value) in o.OrderBy(p => p.Key, StringComparer.Ordinal))
                {
                    if (!first) sb.Append(','); first = false;
                    Quote(key, sb); sb.Append(':'); Canonical(value, sb);
                }
                sb.Append('}');
                break;
            case JsonArray a:
                sb.Append('[');
                for (var i = 0; i < a.Count; i++) { if (i > 0) sb.Append(','); Canonical(a[i], sb); }
                sb.Append(']');
                break;
            case JsonValue v:
                var element = v.TryGetValue<JsonElement>(out var parsed) ? parsed : JsonDocument.Parse(v.ToJsonString()).RootElement;
                switch (element.ValueKind)
                {
                    case JsonValueKind.String: Quote(element.GetString()!, sb); break;
                    case JsonValueKind.True: sb.Append("true"); break;
                    case JsonValueKind.False: sb.Append("false"); break;
                    case JsonValueKind.Null: sb.Append("null"); break;
                    case JsonValueKind.Number: sb.Append(JsNumber(element)); break;
                    default: sb.Append(element.GetRawText()); break;
                }
                break;
        }
    }

    /// <summary>A number as JavaScript prints it: integers as digits, others in the shortest round-trip form.</summary>
    private static string JsNumber(JsonElement element)
    {
        var raw = element.GetRawText();
        if (long.TryParse(raw, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var whole)) return whole.ToString(CultureInfo.InvariantCulture);
        var d = element.GetDouble();
        if (Math.Floor(d) == d && Math.Abs(d) < 1e21) return d.ToString("0", CultureInfo.InvariantCulture);
        var r = d.ToString("R", CultureInfo.InvariantCulture);
        if (r.Contains('E'))
        {
            var parts = r.Split('E');
            var exp = int.Parse(parts[1], CultureInfo.InvariantCulture);
            r = parts[0] + "e" + (exp >= 0 ? "+" : "-") + Math.Abs(exp).ToString(CultureInfo.InvariantCulture);
        }
        return r;
    }

    private static void Quote(string s, StringBuilder sb)
    {
        sb.Append('"');
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else if (char.IsHighSurrogate(c) && (i + 1 >= s.Length || !char.IsLowSurrogate(s[i + 1]))) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else if (char.IsLowSurrogate(c) && (i == 0 || !char.IsHighSurrogate(s[i - 1]))) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }

    private static string Closest(string key, IEnumerable<string> known)
        => known.OrderBy(k => Distance(key.ToLowerInvariant(), k.ToLowerInvariant())).ThenBy(k => k, StringComparer.Ordinal).First();

    private static int Distance(string a, string b)
    {
        var d = new int[a.Length + 1, b.Length + 1];
        for (var i = 0; i <= a.Length; i++) d[i, 0] = i;
        for (var j = 0; j <= b.Length; j++) d[0, j] = j;
        for (var i = 1; i <= a.Length; i++)
            for (var j = 1; j <= b.Length; j++)
                d[i, j] = Math.Min(Math.Min(d[i - 1, j] + 1, d[i, j - 1] + 1), d[i - 1, j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
        return d[a.Length, b.Length];
    }
}
