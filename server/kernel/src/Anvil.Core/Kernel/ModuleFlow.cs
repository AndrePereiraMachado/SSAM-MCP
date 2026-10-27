using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anvil.Reading;

// One action of a module as ssam-flow/1: the text, its id table (n12 -> model key; "start" -> the Start node), what keeps
// it from being the whole action (problems: elements the reader did not claim, properties it could not read or print) and
// the fixed point of the read (the text parsed back gives the same canonical model and prints the same text again).
// Opaque: the nodes written "opaque <Kind>" ("@n5 WaitNode: <why>"), which the text keeps untouched (FlowDiff refuses a
// change to them); the rest of the action is still a fixed point and editable.
public sealed record FlowEntry(string Key, string Kind, string Name, string Text, IReadOnlyDictionary<string, string> Ids,
    IReadOnlyList<string> Problems, bool FixedPoint, int Nodes, int DigestBytes, IReadOnlyList<string>? Opaque = null)
{
    public int Bytes => Encoding.UTF8.GetByteCount(Text);
    // The text's own hash (16 hex of its sha256): what an edit names as basedOn, so it applies only to the text it read.
    public string TextSha => ModuleFlow.TextSha(Text);
}

// The read of one action an edit was written on, kept beside the flow reading of its capture when ssam_map view flow serves
// it (ModuleIndexStore.SaveFlowReading, <sha256>.<adapter>.flow-<textSha>.json; the facade writes the same file): the text,
// its id table (ids -> model keys, "start" -> the Start node) and where it was read. An edit whose basedOn is this textSha
// and that arrives after the action changed is merged three ways with it (FlowMerge).
public sealed record FlowReading(string Lane, string SourceSha256, string ActionKey, string Kind, string Name, string Text, IReadOnlyDictionary<string, string> Ids)
{
    public const string Schema = "ssam-flow-reading/1";
    public string TextSha => ModuleFlow.TextSha(Text);

    public static FlowReading Of(FlowEntry entry, string lane, string sourceSha256) =>
        new(lane, sourceSha256.ToLowerInvariant(), entry.Key, entry.Kind, entry.Name, entry.Text, entry.Ids);

    public byte[] ToJson(string adapter)
    {
        using var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(buffer, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping })) {
            json.WriteStartObject();
            json.WriteString("schema", Schema); json.WriteNumber("extractor", ModuleFlow.Extractor);
            json.WriteString("lane", Lane); json.WriteString("adapter", adapter); json.WriteString("sourceSha256", SourceSha256);
            json.WriteStartObject("action"); json.WriteString("key", ActionKey); json.WriteString("kind", Kind); json.WriteString("name", Name); json.WriteEndObject();
            json.WriteString("textSha", TextSha); json.WriteString("text", Text);
            json.WriteStartObject("ids"); foreach (var (id, key) in Ids.OrderBy(p => p.Key, StringComparer.Ordinal)) json.WriteString(id, key); json.WriteEndObject();
            json.WriteEndObject();
        }
        return buffer.ToArray();
    }

    // Null when the file is of another schema, extractor (another printer reads another text), lane or adapter, or when its
    // text is not the text of that textSha.
    public static FlowReading? Parse(byte[] bytes, string lane, string adapter, string textSha)
    {
        try {
            var json = JsonNode.Parse(bytes)!.AsObject();
            if (json["schema"]?.ToString() != Schema || json["extractor"]?.GetValue<int>() != ModuleFlow.Extractor || json["lane"]?.ToString() != lane
                || json["adapter"]?.ToString() != adapter || json["action"] is not JsonObject action || json["ids"] is not JsonObject ids) return null;
            var text = json["text"]?.GetValue<string>() ?? "";
            if (!string.Equals(ModuleFlow.TextSha(text), textSha, StringComparison.OrdinalIgnoreCase)) return null;
            return new FlowReading(lane, json["sourceSha256"]?.ToString() ?? "", action["key"]?.ToString() ?? "", action["kind"]?.ToString() ?? "",
                action["name"]?.ToString() ?? "", text, ids.ToDictionary(p => p.Key, p => p.Value?.ToString() ?? "", StringComparer.Ordinal));
        } catch (Exception error) when (error is JsonException or InvalidOperationException or FormatException) { return null; }
    }
}

// The flow reading of a module (ssam-flow/1): every action with a flow (server, service, client, screen and data actions
// of this module) as text that is also a source form. Built once per capture beside the module index and the digest
// (ModuleIndexStore.SaveFlow, <sha256>.<adapter>.flow.json) by the lane's kernel reader; the facade serves it by element
// (module-flow.mjs, ssam_map view:"flow"). The digest stays the module's reading; this is the action's own text, whole.
// Deterministic: the same OML bytes give the same texts and ids. The fixed point of every action is proven when the file
// is built (Check) and stored with it: an action that is not a fixed point is still read, never written back from text.
public sealed class ModuleFlow
{
    public const string Schema = FlowPrinter.Schema;
    // The version of what Build writes: a stored flow of another version is a miss. Raise it on every change of the text.
    // 2: opaque nodes (LG2); a part keeps its model key. 3: the Start node is always @start (a comment attached to it).
    // 4: Call= only for the kind of call the flow does not pick by default. 5: the O11 record mapping of an assignment or
    // argument (its TypeConversion) is part of its Value, Source mapTo { Field: value }. 6: the header of a screen, block or
    // data action names its owner (action Home.Save, FlowOwners); 6 also invalidates the 5 each of those changes wrote alone.
    // 7: an ODC empty mapping (Source mapTo {  }, the conversion the platform makes on its own) is written as its source.
    // 9: Traditional Preparation is an owned flow with its native fixed name and identity.
    public const int Extractor = 9;
    public static readonly HashSet<string> ActionKinds = new(StringComparer.Ordinal) { "ServerAction", "ServiceAction", "ClientAction", "ScreenAction", "DataAction", "Preparation" };

    public string Lane { get; private init; } = "";
    public string SourceSha256 { get; private init; } = "";
    public long SourceBytes { get; private init; }
    public string CreatedAt { get; private init; } = "";
    public string ModuleName { get; private init; } = "";
    public string ModuleKey { get; private init; } = "";
    public IReadOnlyList<FlowEntry> Actions { get; private init; } = [];
    // Values the rules leave out (derived, editor state, duplicates), by rule: what the text does not carry, counted.
    public IReadOnlyDictionary<string, int> NotWritten { get; private init; } = new Dictionary<string, int>();

    // The text of one action (the printer) and the action of a text (the parser): ids map the text's ids to model keys.
    // fixedIds (model key -> id): print with the ids of a read (an element of another key is written with its key as id).
    public static FlowDocument Print(FlowItem action, IReadOnlyDictionary<string, string>? fixedIds = null) => FlowPrinter.Print(action, fixedIds);
    public static FlowItem Read(string text, IReadOnlyDictionary<string, string>? ids = null) => FlowParser.Parse(text, ids);

    // One action of a loaded module as the canonical model, with what keeps it from being whole (problems).
    public static FlowItem Extract<T>(T root, ModelReader<T> reader, T action, out IReadOnlyList<string> problems) where T : class
    {
        var item = new FlowExtractor<T>(reader, root).Action(action, out var found);
        problems = found;
        return item;
    }

    // visit: every action's canonical model as it is read (the corpus test counts what the text carries).
    public static ModuleFlow Build<T>(T root, ModelReader<T> reader, string lane, string sourceSha256, long sourceBytes, Action<FlowItem>? visit = null) where T : class
    {
        var digest = ModuleDigest.ActionTexts(root, reader, lane);
        var extractor = new FlowExtractor<T>(reader, root);
        var entries = new List<FlowEntry>();
        foreach (var node in reader.Walk(root)) {
            var kind = reader.KindOf(node);
            if (!ActionKinds.Contains(kind) || UnderReference(reader, node, root)) continue;
            var item = extractor.Action(node, out var problems);
            visit?.Invoke(item);
            var owner = Owner(reader, node, root);
            entries.Add(Entry(item, owner.Length > 0 ? owner + "/" + item.Name : item.Name, problems,
                digest.TryGetValue(reader.KeyOf(node), out var text) ? Encoding.UTF8.GetByteCount(text) : 0));
        }
        return new ModuleFlow {
            Lane = lane, SourceSha256 = sourceSha256.ToLowerInvariant(), SourceBytes = sourceBytes, CreatedAt = DateTimeOffset.UtcNow.ToString("o"),
            ModuleName = reader.DisplayOf(root), ModuleKey = reader.KeyOf(root),
            Actions = entries.OrderBy(e => e.Name, StringComparer.Ordinal).ThenBy(e => e.Key, StringComparer.Ordinal).ToList(),
            NotWritten = new SortedDictionary<string, int>(extractor.NotWritten, StringComparer.Ordinal)
        };
    }

    // ---- the selective reading (S10, 24/10/2026) ---------------------------------------------------------------------------
    // Some actions of a module, by selectors, without building the others: the same extractor and the same entry as Build
    // (same text, ids and textSha), named as Build names them. Never a ModuleFlow that could be stored as the module's: its
    // own schema, partial:true, what was not built counted, and the catalog of every action (key, kind, name; no body).
    public const string SelectionSchema = "ssam-flow-selection/1";
    public const string SignaturesSchema = "ssam-action-signatures/1";
    public const int MaxSelectors = 1000;

    // Every action Build reads (not below a reference), with the name Build gives its entry, in Build's order (name, key).
    // An action body declares no action and a reference holds none of this module's: the walk descends into neither.
    public static List<(T Node, string Key, string Kind, string Name)> Catalog<T>(T root, ModelReader<T> reader) where T : class
    {
        var found = new List<(T Node, string Key, string Kind, string Name)>();
        var pending = new Stack<T>(); pending.Push(root);
        var visited = new HashSet<T>(ReferenceEqualityComparer.Instance);
        while (pending.TryPop(out var node)) {
            if (!visited.Add(node)) continue;
            var kind = reader.KindOf(node);
            if (kind == "Reference" && !ReferenceEquals(node, root)) continue;
            if (ActionKinds.Contains(kind) && !ReferenceEquals(node, root)) {
                var owner = Owner(reader, node, root);
                // FlowExtractor.Action: a Preparation is named Preparation whatever the model displays.
                var name = kind == "Preparation" ? "Preparation" : reader.DisplayOf(node);
                found.Add((node, reader.KeyOf(node), kind, owner.Length > 0 ? owner + "/" + name : name));
                continue;
            }
            foreach (var child in reader.ChildrenOf(node).Reverse()) pending.Push(child);
        }
        return found.OrderBy(e => e.Name, StringComparer.Ordinal).ThenBy(e => e.Key, StringComparer.Ordinal).ToList();
    }

    // Whether a selector may name an action: a superset of the facade's resolution (module-flow.mjs findActions: @key or key,
    // the full name, Owner.Action, the last segment; exact, then without case), which resolves among the actions built.
    public static bool MayName(string key, string name, string selector)
    {
        var text = selector.Trim();
        if (key == (text.StartsWith('@') ? text[1..] : text)) return true;
        if (text.StartsWith('@')) return false;
        var tails = new List<string> { "/" + text };
        var dot = text.LastIndexOf('.');
        if (dot > 0 && !text.StartsWith('(')) tails.Add("/" + text[..dot] + "/" + text[(dot + 1)..]);
        var full = "/" + name;
        return tails.Any(tail => full.EndsWith(tail, StringComparison.OrdinalIgnoreCase)
            || full.ToLowerInvariant().EndsWith(tail.ToLowerInvariant(), StringComparison.Ordinal));
    }

    private static void CheckSelectors(IReadOnlyList<string> selectors, string field)
    {
        if (selectors.Count < 1 || selectors.Count > MaxSelectors || selectors.Any(string.IsNullOrWhiteSpace))
            throw new ArgumentException(field + " must contain 1 to " + MaxSelectors + " non-empty selectors");
    }

    public static JsonObject BuildSelected<T>(T root, ModelReader<T> reader, string lane, string adapter, string sourceSha256, long sourceBytes,
        IReadOnlyList<string> selectors) where T : class
    {
        CheckSelectors(selectors, "flowElements");
        var catalog = Catalog(root, reader);
        var extractor = new FlowExtractor<T>(reader, root);
        var entries = new List<FlowEntry>();
        foreach (var action in catalog.Where(a => selectors.Any(s => MayName(a.Key, a.Name, s)))) {
            var item = extractor.Action(action.Node, out var problems);
            // digestBytes compares the text with the digest of the whole module, which is not built here.
            entries.Add(Entry(item, action.Name, problems, 0));
        }
        var selected = new ModuleFlow {
            Lane = lane, SourceSha256 = sourceSha256.ToLowerInvariant(), SourceBytes = sourceBytes, CreatedAt = DateTimeOffset.UtcNow.ToString("o"),
            ModuleName = reader.DisplayOf(root), ModuleKey = reader.KeyOf(root), Actions = entries,
            NotWritten = new SortedDictionary<string, int>(extractor.NotWritten, StringComparer.Ordinal) };
        var answer = JsonNode.Parse(selected.ToJson(adapter))!.AsObject();
        answer["schema"] = SelectionSchema;
        answer["partial"] = true;
        answer["scope"] = new JsonObject {
            ["completeModule"] = false, ["availableActions"] = catalog.Count, ["builtActions"] = entries.Count,
            ["notBuilt"] = new JsonObject { ["actions"] = catalog.Count - entries.Count,
                ["what"] = "the text, ids, fixed point and digestBytes of every action not requested (digestBytes is 0 here); notWritten counts the built ones only" },
            ["requested"] = new JsonArray(selectors.Select(s => (JsonNode)JsonValue.Create(s)!).ToArray()) };
        answer["catalog"] = new JsonArray(catalog.Select(a => (JsonNode)new JsonObject { ["key"] = a.Key, ["kind"] = a.Kind, ["name"] = a.Name }).ToArray());
        return answer;
    }

    // The contracts (inputs and outputs) of some actions, no body read: FlowExtractor.Signature. complete only when every
    // selector names one action and every contract read without a problem.
    public static JsonObject BuildSignatures<T>(T root, ModelReader<T> reader, string lane, string sourceSha256, long sourceBytes,
        IReadOnlyList<string> selectors) where T : class
    {
        CheckSelectors(selectors, "signatureElements");
        var catalog = Catalog(root, reader);
        var extractor = new FlowExtractor<T>(reader, root);
        var actions = new JsonArray();
        foreach (var action in catalog.Where(a => selectors.Any(s => MayName(a.Key, a.Name, s)))) {
            var item = extractor.Signature(action.Node, out var problems);
            JsonArray Parameters(string role) => new(item.Items.Where(p => p.Role == role).Select(p => (JsonNode)new JsonObject {
                ["key"] = p.Key, ["name"] = p.Name, ["type"] = p.Prop("DataType"),
                ["mandatory"] = role == "in" ? p.Prop("IsMandatory") != "False" : null,
                ["default"] = role == "in" ? p.Prop("DefaultValue") : null }).ToArray());
            actions.Add(new JsonObject {
                ["key"] = action.Key, ["kind"] = action.Kind, ["name"] = action.Name, ["owner"] = item.Owner,
                ["contractSha256"] = problems.Count == 0 ? SignatureSha(item) : null,
                ["inputs"] = Parameters("in"), ["outputs"] = Parameters("out"),
                ["problems"] = new JsonArray(problems.Select(p => (JsonNode)JsonValue.Create(p)!).ToArray()) });
        }
        var selections = new JsonArray(selectors.Select(s => {
            var keys = catalog.Where(a => MayName(a.Key, a.Name, s)).Select(a => a.Key).ToArray();
            return (JsonNode)new JsonObject { ["selector"] = s, ["status"] = keys.Length == 0 ? "missing" : keys.Length == 1 ? "resolved" : "ambiguous",
                ["keys"] = new JsonArray(keys.Select(k => (JsonNode)JsonValue.Create(k)!).ToArray()) };
        }).ToArray());
        return new JsonObject {
            ["schema"] = SignaturesSchema, ["extractor"] = Extractor, ["lane"] = lane, ["sourceSha256"] = sourceSha256.ToLowerInvariant(), ["sourceBytes"] = sourceBytes,
            ["module"] = new JsonObject { ["name"] = reader.DisplayOf(root), ["key"] = reader.KeyOf(root) },
            ["partial"] = true,
            ["scope"] = new JsonObject { ["completeModule"] = false, ["bodiesRead"] = false, ["availableActions"] = catalog.Count },
            ["complete"] = selections.All(s => s!["status"]!.ToString() == "resolved") && actions.All(a => a!["problems"]!.AsArray().Count == 0),
            ["selections"] = selections, ["actions"] = actions };
    }

    // Only the contract: no body, positions or descriptions of the nodes.
    internal static string SignatureSha(FlowItem signature) =>
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(signature.Canon()))).ToLowerInvariant();

    // Print, parse back, compare: the fixed point of one action. name: where it lives and its name (Flow/Screen/Action).
    public static FlowEntry Entry(FlowItem item, string name, IReadOnlyList<string> found, int digestBytes)
    {
        var document = FlowPrinter.Print(item);
        var problems = found.Concat(document.Unprintable.Select(u => "not printed: " + u)).ToList();
        var check = Check(item, document);
        if (check != null) problems.Add(check);
        var ids = new SortedDictionary<string, string>(document.Keys.ToDictionary(p => p.Key, p => p.Value), StringComparer.Ordinal);
        var idOf = document.Keys.ToDictionary(p => p.Value, p => p.Key, StringComparer.Ordinal);
        var opaque = item.Items.Where(i => i.Role == "node" && i.Opaque)
            .Select(i => "@" + idOf.GetValueOrDefault(i.Key, i.Key) + " " + i.Kind + ": " + string.Join("; ", i.OpaqueReasons ?? [])).ToList();
        return new FlowEntry(item.Key, item.Kind, name, document.Text, ids, problems, problems.Count == 0,
            item.Items.Count(i => i.Role == "node"), digestBytes, opaque.Count > 0 ? opaque : null);
    }

    // 16 hex of the sha256 of the text (UTF-8): FlowEntry.TextSha, and the basedOn an edit names.
    public static string TextSha(string text) =>
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..16].ToLowerInvariant();

    // Null when the text parses back to the same model and prints the same text; else the first difference.
    public static string? Check(FlowItem item, FlowDocument document)
    {
        FlowItem parsed;
        try { parsed = FlowParser.Parse(document.Text, document.Keys); }
        catch (FormatException error) { return "not read back: " + error.Message; }
        var expected = item.Canon(); var actual = parsed.Canon();
        if (expected != actual) return "read back differs: " + FirstDifference(expected, actual);
        var again = FlowPrinter.Print(parsed);
        if (again.Text != document.Text) return "printed again differs: " + FirstDifference(document.Text, again.Text);
        return null;
    }

    private static string FirstDifference(string expected, string actual)
    {
        var a = expected.Split('\n'); var b = actual.Split('\n');
        for (var i = 0; i < Math.Max(a.Length, b.Length); i++) {
            var x = i < a.Length ? a[i] : "(end)"; var y = i < b.Length ? b[i] : "(end)";
            if (x != y) return "line " + (i + 1) + ": expected " + Clip(x) + " | got " + Clip(y);
        }
        return "(same lines)";
    }

    private static string Clip(string text) => text.Length <= 300 ? text : text[..300] + "…";

    private static bool UnderReference<T>(ModelReader<T> reader, T node, T root) where T : class
    {
        for (var at = reader.ParentOf(node); at != null && !ReferenceEquals(at, root); at = reader.ParentOf(at))
            if (reader.KindOf(at) == "Reference") return true;
        return false;
    }

    // Flow/Screen for a screen or block action, "" for a module action.
    private static string Owner<T>(ModelReader<T> reader, T node, T root) where T : class
    {
        var path = new List<string>();
        for (var at = reader.ParentOf(node); at != null && !ReferenceEquals(at, root); at = reader.ParentOf(at)) path.Insert(0, reader.DisplayOf(at));
        return string.Join("/", path);
    }

    // ---- results ---------------------------------------------------------------------------------------------------------

    public JsonObject Summary()
    {
        var fixedPoint = Actions.Count(a => a.FixedPoint);
        var problems = new SortedDictionary<string, int>(StringComparer.Ordinal);
        foreach (var action in Actions) foreach (var problem in action.Problems.Select(Category).Distinct()) problems[problem] = problems.GetValueOrDefault(problem) + 1;
        var ratios = Actions.Where(a => a.DigestBytes > 0).Select(a => (double)a.Bytes / a.DigestBytes).Order().ToList();
        double Quantile(double q) => ratios.Count == 0 ? 0 : ratios[Math.Min(ratios.Count - 1, (int)Math.Floor(q * ratios.Count))];
        var flowBytes = Actions.Sum(a => (long)a.Bytes); var digestBytes = Actions.Sum(a => (long)a.DigestBytes);
        return new JsonObject {
            ["schema"] = Schema, ["module"] = ModuleName, ["lane"] = Lane, ["sourceSha256"] = SourceSha256,
            ["actions"] = Actions.Count, ["nodes"] = Actions.Sum(a => a.Nodes), ["fixedPoint"] = fixedPoint,
            ["fixedPointNodes"] = Actions.Where(a => a.FixedPoint).Sum(a => a.Nodes),
            ["problems"] = new JsonObject(problems.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
            ["notWritten"] = new JsonObject(NotWritten.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
            ["bytes"] = new JsonObject { ["flow"] = flowBytes, ["digest"] = digestBytes, ["ratio"] = digestBytes == 0 ? 0 : Math.Round((double)flowBytes / digestBytes, 4),
                ["perActionMedian"] = Math.Round(Quantile(0.5), 4), ["perActionP90"] = Math.Round(Quantile(0.9), 4),
                ["actionsAbove125"] = ratios.Count(r => r > 1.25) } };
    }

    // The kind of a problem without its particulars (counts per kind).
    public static string Category(string problem)
    {
        var text = problem;
        var at = text.IndexOf(" @", StringComparison.Ordinal); if (at > 0) text = text[..at];
        at = text.IndexOf(": ", StringComparison.Ordinal);
        if (at > 0 && !text.StartsWith("not printed", StringComparison.Ordinal) && !text.StartsWith("read error", StringComparison.Ordinal)) text = text[..at];
        return text.Length > 120 ? text[..120] : text;
    }

    // ---- the stored form ----------------------------------------------------------------------------------------------

    public byte[] ToJson(string adapter)
    {
        using var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(buffer, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping })) {
            json.WriteStartObject();
            json.WriteString("schema", Schema); json.WriteNumber("extractor", Extractor);
            json.WriteString("lane", Lane); json.WriteString("adapter", adapter);
            json.WriteString("sourceSha256", SourceSha256); json.WriteNumber("sourceBytes", SourceBytes); json.WriteString("createdAt", CreatedAt);
            json.WriteStartObject("module"); json.WriteString("name", ModuleName); json.WriteString("key", ModuleKey); json.WriteEndObject();
            json.WriteStartObject("notWritten"); foreach (var (rule, count) in NotWritten) json.WriteNumber(rule, count); json.WriteEndObject();
            json.WriteStartArray("actions");
            foreach (var action in Actions) {
                json.WriteStartObject();
                json.WriteString("key", action.Key); json.WriteString("kind", action.Kind); json.WriteString("name", action.Name);
                json.WriteBoolean("fixedPoint", action.FixedPoint); json.WriteNumber("nodes", action.Nodes); json.WriteNumber("digestBytes", action.DigestBytes);
                json.WriteString("text", action.Text);
                json.WriteStartObject("ids"); foreach (var (id, key) in action.Ids) json.WriteString(id, key); json.WriteEndObject();
                json.WriteStartArray("problems"); foreach (var problem in action.Problems) json.WriteStringValue(problem); json.WriteEndArray();
                if (action.Opaque is { Count: > 0 } opaque) { json.WriteStartArray("opaque"); foreach (var node in opaque) json.WriteStringValue(node); json.WriteEndArray(); }
                json.WriteEndObject();
            }
            json.WriteEndArray();
            json.WriteEndObject();
        }
        return buffer.ToArray();
    }

    // Any identity or shape mismatch throws: the caller treats it as a miss and builds again.
    public static ModuleFlow Parse(byte[] json, string lane, string adapter, string sourceSha256)
    {
        using var document = JsonDocument.Parse(json);
        var top = document.RootElement;
        static string Text(JsonElement element, string property) => element.GetProperty(property).GetString() ?? throw new InvalidDataException(property + " is null");
        if (Text(top, "schema") != Schema || top.GetProperty("extractor").GetInt32() != Extractor || Text(top, "lane") != lane
            || Text(top, "adapter") != adapter || !string.Equals(Text(top, "sourceSha256"), sourceSha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Module flow identity does not match this capture");
        var actions = top.GetProperty("actions").EnumerateArray().Select(a => new FlowEntry(Text(a, "key"), Text(a, "kind"), Text(a, "name"), Text(a, "text"),
            a.GetProperty("ids").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString() ?? "", StringComparer.Ordinal),
            a.GetProperty("problems").EnumerateArray().Select(p => p.GetString() ?? "").ToList(),
            a.GetProperty("fixedPoint").GetBoolean(), a.GetProperty("nodes").GetInt32(), a.GetProperty("digestBytes").GetInt32(),
            a.TryGetProperty("opaque", out var opaque) ? opaque.EnumerateArray().Select(p => p.GetString() ?? "").ToList() : null)).ToList();
        var module = top.GetProperty("module");
        return new ModuleFlow {
            Lane = lane, SourceSha256 = Text(top, "sourceSha256").ToLowerInvariant(), SourceBytes = top.GetProperty("sourceBytes").GetInt64(),
            CreatedAt = Text(top, "createdAt"), ModuleName = Text(module, "name"), ModuleKey = Text(module, "key"), Actions = actions,
            NotWritten = top.GetProperty("notWritten").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetInt32(), StringComparer.Ordinal) };
    }

    // Cold reads (kernel CLIs): the stored flow of these bytes, else built from the model the caller loads and stored.
    public static (ModuleFlow Flow, string Path, bool Built) Ensure(ModuleIndexStore store, string file, Func<byte[], string, ModuleFlow> load)
    {
        var bytes = File.ReadAllBytes(file);
        var sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes));
        var flow = store.LoadFlow(sha256); var built = false;
        if (flow == null) { flow = load(bytes, sha256); store.SaveFlow(flow); built = true; }
        return (flow, store.FlowPathOf(sha256), built);
    }

    // The reader's answer to {"flow":"ensure"}: where the facade reads it, and its counts.
    public JsonObject Answer(string path, bool built)
    {
        var answer = Summary();
        answer["path"] = path; answer["built"] = built; answer["extractor"] = Extractor;
        return answer;
    }
}
