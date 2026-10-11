using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core.Delivery;

namespace Anvil.Reading;

// Module index (ssam-module-index/1): every reader-visible element of one capture, read once with ModelReader's rules and
// stored by the SHA-256 of the OML bytes, so listings by kind or name are answered without loading the model.
// Shared by both kernels and the ODC builder (linked there); the facade reads the same files. Build needs a loaded
// model; Parse, Query and the store are pure and never touch a Studio type.
public sealed class ModuleIndex
{
    public const string Schema = "ssam-module-index/1";
    public const int Extractor = 1;
    public const string IdentityScope = "Keys belong to this snapshot. Resolve again after a new capture or save/reload; paths can be ambiguous.";
    public static readonly string[] Roles = ["module", "flow", "screen", "block", "action", "actionRef", "aggregate", "entity",
        "staticEntity", "structure", "attribute", "parameter", "variable", "widget", "event", "flowNode", "expression", "reference", "other"];

    // answers: the reader's KindNames; a kind matches when answers holds it or its I-prefixed form (ModelReader.HasKind).
    // nameProperty: the Name projection of Tree (true: the modelName text, false: propertiesMissing, null: model only).
    private sealed record IndexType(string Kind, string[] Answers, bool? NameProperty)
    {
        public readonly HashSet<string> Set = new(Answers, StringComparer.Ordinal);
    }

    public string Lane { get; private init; } = "";
    public string Adapter { get; private init; } = "";
    public string SourceSha256 { get; private init; } = "";
    public long SourceBytes { get; private init; }
    public string CreatedAt { get; private init; } = "";
    public string ModuleName { get; private init; } = "";
    public string ModuleKey { get; private init; } = "";
    public string ModuleKind { get; private init; } = "";
    public bool Complete { get; private init; }
    public int ReadErrors { get; private init; }
    public int Count => keys.Length;
    private JsonArray errorSamples = [];
    private IndexType[] types = [];
    private string[] keys = [];
    private int[] typeOf = [], parents = [], roleOf = [], childrenTotal = [];
    private string[] names = [];
    private string?[] modelNames = [], labels = [], dataTypes = [];
    private (string Key, int Type, string Name, int Parent)[] ancestors = [];

    public static ModuleIndex Build<T>(T root, ModelReader<T> reader, string moduleName, string lane, string adapter,
        string sourceSha256, long sourceBytes) where T : class
    {
        var nodes = reader.Walk(root).ToList();
        var described = new (string Key, string Kind, string Name, string ModelName, string? Label, IReadOnlySet<string> Kinds, T? Parent, int Children)?[nodes.Count];
        var samples = new JsonArray(); var readErrors = 0; var complete = true;
        void Fail(string reference, string property, Exception error, bool structural) {
            readErrors++; complete &= !structural;
            if (samples.Count < 8) samples.Add(new JsonObject { ["reference"] = reference, ["property"] = property, ["error"] = Clip(error.GetBaseException().Message, 200) });
        }
        for (var i = 0; i < nodes.Count; i++)
            try { described[i] = reader.Describe(nodes[i]); } catch (Exception error) { Fail("walk#" + i, "Describe", error, true); }
        // Ordinal key order with a stable sort, as Read pages, so offset/max give the model's pages.
        var order = Enumerable.Range(0, nodes.Count).Where(i => described[i] != null).OrderBy(i => described[i]!.Value.Key, StringComparer.Ordinal).ToArray();
        var rowOf = new Dictionary<T, int>(ReferenceEqualityComparer.Instance);
        for (var row = 0; row < order.Length; row++) rowOf[nodes[order[row]]] = row;
        var count = order.Length;
        var keys = new string[count]; var typeOf = new int[count]; var names = new string[count]; var modelNames = new string?[count];
        var labels = new string?[count]; var parents = new int[count]; var roleOf = new int[count]; var dataTypes = new string?[count];
        var childrenTotal = new int[count];
        var types = new List<IndexType>(); var typeRoles = new List<int>(); var typeIds = new Dictionary<(string, int, bool?), int>();
        // Adapters return one set per node type; equal sets from different instances share one answer list.
        var answerOf = new Dictionary<IReadOnlySet<string>, int>(ReferenceEqualityComparer.Instance);
        var answerIds = new Dictionary<string, int>(StringComparer.Ordinal); var answerLists = new List<string[]>();
        int TypeOf(string kind, IReadOnlySet<string> kinds, bool? nameProperty) {
            if (!answerOf.TryGetValue(kinds, out var answers)) {
                var sorted = kinds.Order(StringComparer.Ordinal).ToArray(); var joined = string.Join("\n", sorted);
                if (!answerIds.TryGetValue(joined, out answers)) { answerIds[joined] = answers = answerLists.Count; answerLists.Add(sorted); }
                answerOf[kinds] = answers;
            }
            if (!typeIds.TryGetValue((kind, answers, nameProperty), out var type)) {
                typeIds[(kind, answers, nameProperty)] = type = types.Count;
                types.Add(new(kind, answerLists[answers], nameProperty)); typeRoles.Add(RoleOf(kind, types[type].Set));
            }
            return type;
        }
        // PathOf follows Parent(), which can leave the reader-visible elements (O11: an aggregate's DataTable is the
        // parent of its sources, but no Children list holds it). Such ancestors are kept for paths, never listed:
        // parentRow -2 - i points at ancestors[i].
        var ancestors = new List<(string Key, int Type, string Name, int Parent)>();
        var ancestorOf = new Dictionary<T, int>(ReferenceEqualityComparer.Instance);
        int ParentRef(T? parent) {
            if (parent == null) return -1;
            if (rowOf.TryGetValue(parent, out var row)) return row;
            if (ancestorOf.TryGetValue(parent, out var known)) return -2 - known;
            var d = reader.Describe(parent);
            // Registered before climbing, so a Parent() cycle closes on itself exactly as PathOf's seen set stops it.
            var at = ancestors.Count; ancestorOf[parent] = at; ancestors.Add((d.Key, TypeOf(d.Kind, d.Kinds, null), d.Name, -1));
            ancestors[at] = (d.Key, ancestors[at].Type, d.Name, ParentRef(d.Parent));
            return -2 - at;
        }
        for (var row = 0; row < count; row++) {
            var node = nodes[order[row]]; var d = described[order[row]]!.Value;
            bool? nameProperty; try { nameProperty = reader.NameProjection(node, d.ModelName); } catch { nameProperty = null; }
            var type = TypeOf(d.Kind, d.Kinds, nameProperty);
            keys[row] = d.Key; typeOf[row] = type; names[row] = d.Name; modelNames[row] = d.ModelName == d.Name ? null : d.ModelName;
            labels[row] = d.Label; roleOf[row] = typeRoles[type]; childrenTotal[row] = d.Children; parents[row] = -1;
            try { parents[row] = ParentRef(d.Parent); }
            catch (Exception error) { Fail("@" + d.Key, "Parent", error, true); }
            if (Roles[typeRoles[type]] is "parameter" or "attribute" or "variable")
                try { dataTypes[row] = reader.PropertyText(node, "DataType"); }
                catch (Exception error) { Fail("@" + d.Key, "DataType", error, false); }
        }
        // Only a failure that changes rows, kinds, names or paths makes the index incomplete; DataType is informative.
        return new ModuleIndex {
            Lane = lane, Adapter = adapter, SourceSha256 = sourceSha256.ToLowerInvariant(), SourceBytes = sourceBytes,
            CreatedAt = DateTimeOffset.UtcNow.ToString("o"), ModuleName = moduleName,
            ModuleKey = described.Length > 0 && described[0] is { } top ? top.Key : "", ModuleKind = described.Length > 0 && described[0] is { } head ? head.Kind : "",
            Complete = complete, ReadErrors = readErrors, errorSamples = samples, types = types.ToArray(), keys = keys, typeOf = typeOf,
            names = names, modelNames = modelNames, labels = labels, parents = parents, roleOf = roleOf, dataTypes = dataTypes,
            childrenTotal = childrenTotal, ancestors = ancestors.ToArray()
        };
    }

    // Roles are informative (counts, facade summaries); queries match kinds through answers, never through roles.
    // Order matters, measured on both Model APIs: every local action answers IFlow, screens and blocks answer
    // IFlowNode, O11 ServerEntity answers IStaticEntity, the ODC Expression widget answers IExpression.
    internal static int RoleOf(string kind, HashSet<string> answers)
    {
        bool Is(params string[] interfaces) => interfaces.Any(i => answers.Contains("I" + i));
        bool Ends(string suffix) => kind.EndsWith(suffix, StringComparison.Ordinal);
        var role = kind == "ESpace" ? "module"
            : Ends("ActionSignature") ? "actionRef"
            : Ends("Signature") || kind == "Reference" ? "reference"
            : Is("MobileScreen", "WebScreen") ? "screen"
            : Is("MobileBlock", "WebBlock") ? "block"
            : Is("UIFlow", "MobileFlow", "WebFlow") ? "flow"
            : Is("ActionFlow", "ServerAction", "ClientAction", "ScreenAction", "ServiceAction", "DataAction") ? "action"
            : Is("Aggregate") ? "aggregate"
            : kind == "StaticEntity" ? "staticEntity"
            : Is("Entity") ? "entity"
            : kind == "Structure" ? "structure"
            : Is("Attribute") || Ends("Attribute") ? "attribute"
            : Is("Parameter") || Ends("Parameter") ? "parameter"
            : Is("LocalVariable", "ClientVariable") || kind == "SiteProperty" ? "variable"
            : Is("Widget", "MobileWidget", "WebWidget") ? "widget"
            : Is("Event") || Ends("Event") || kind == "EventHandler" ? "event"
            : Is("FlowNode", "ActionNode") || Ends("Node") ? "flowNode"
            : Is("Expression") ? "expression"
            : "other";
        return Array.IndexOf(Roles, role);
    }

    // Reads the index can answer exactly: a kind and/or name listing of the whole module, paged, with no property other
    // than Name. Without --properties Tree prints every property, so that read stays with the model.
    public static bool Answerable(string? path, ReadingOptions options, string[]? select) =>
        select == null && (path is null or "" or "/") && options.IsQuery && options.Text == null && !options.Usages
        && !options.Full && !options.All && options.Properties is { } properties && Projection(properties).All(p => p == "Name");

    private static HashSet<string> Projection(string properties) =>
        properties.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).ToHashSet(StringComparer.Ordinal);

    // Cold inspect (kernel CLIs): the answer ModelHost.ReadModel gives for this file, from its stored index, or null when
    // the model has to answer. Reads and hashes the actual bytes; nothing here binds a Studio assembly.
    public static JsonObject? ReadStored(ModuleIndexStore? store, string file, string path, ReadingOptions options)
    {
        if (store == null || !Answerable(path, options, null)) return null;
        var sourceSha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(file)));
        if (store.Load(sourceSha256)?.Query(path, options) is not { } data) return null;
        data["sourceSha256"] = sourceSha256;
        data["identityScope"] = IdentityScope;
        return data;
    }

    // The ssam-reading/1 answer ModelReader.Read gives for the same capture, or null when only the model can give it.
    public JsonObject? Query(string path, ReadingOptions options)
    {
        options.Validate();
        if (!Complete || !Answerable(path, options, null)) return null;
        var name = Projection(options.Properties!).Contains("Name");
        var matches = types.Select(t => options.Kind is null or "*" || t.Set.Contains(options.Kind) || t.Set.Contains("I" + options.Kind)).ToArray();
        var entries = new JsonArray(); var count = 0; var kindObserved = false;
        for (var row = 0; row < keys.Length; row++) {
            if (!matches[typeOf[row]]) continue;
            kindObserved = true;
            if (options.Name != null && !string.Equals(names[row], options.Name, StringComparison.OrdinalIgnoreCase)) continue;
            if (count++ < options.Offset || entries.Count >= options.Max) continue;
            if (name && types[typeOf[row]].NameProperty == null) return null;
            entries.Add(Entry(row, name));
        }
        var end = options.Offset + entries.Count;
        return new JsonObject { ["schema"] = "ssam-reading/1", ["path"] = path, ["count"] = count, ["returned"] = entries.Count,
            ["offset"] = options.Offset, ["omitted"] = count - entries.Count, ["truncated"] = count != entries.Count,
            ["nextOffset"] = end < count ? end : null, ["kindObserved"] = kindObserved,
            ["notices"] = kindObserved ? new JsonArray() : new JsonArray(ModelReader<object>.KindNotObserved),
            ["searchComplete"] = true, ["propertyReadErrors"] = 0, ["errorSamples"] = new JsonArray(), ["entries"] = entries };
    }

    // Tree(node, options, 0) with a Name-only or empty projection.
    private JsonObject Entry(int row, bool nameProjected)
    {
        var type = types[typeOf[row]]; var modelName = modelNames[row] ?? names[row];
        var properties = new JsonObject(); var omitted = new JsonObject(); var missing = new JsonArray();
        if (nameProjected && type.NameProperty == false) missing.Add("Name");
        else if (nameProjected && modelName.Length > 0) {
            // The same omission as ModelReader.Tree, with the continuation that reads the property in full (C19).
            if (modelName.Length > 400) omitted["Name:text"] = new JsonObject { ["reason"] = "characters", ["total"] = modelName.Length, ["shown"] = 400,
                ["continuation"] = new JsonObject { ["path"] = "@" + keys[row], ["properties"] = "Name", ["full"] = true } };
            properties["Name"] = Clip(modelName, 400);
        }
        return new JsonObject { ["kind"] = type.Kind, ["name"] = names[row], ["modelName"] = modelName, ["label"] = labels[row],
            ["key"] = keys[row], ["reference"] = "@" + keys[row], ["path"] = PathOf(row), ["properties"] = properties,
            ["propertyReferences"] = new JsonObject(), ["propertiesOmitted"] = omitted, ["propertyErrors"] = new JsonObject(),
            ["propertiesMissing"] = missing, ["children"] = new JsonArray(), ["childrenTotal"] = childrenTotal[row],
            ["childrenOmitted"] = childrenTotal[row] };
    }

    // ModelReader.PathOf over parent references: every ancestor that has a parent, clipped at 80 characters.
    // A reference is a row (>= 0), no parent (-1) or ancestors[-2 - reference].
    private string PathOf(int row)
    {
        var parts = new List<string>(); var seen = new HashSet<int>();
        for (var at = row; at != -1 && ParentOf(at) != -1 && seen.Add(at); at = ParentOf(at))
            parts.Add(at >= 0 ? types[typeOf[at]].Kind + ":" + Clip(names[at], 80)
                : types[ancestors[-2 - at].Type].Kind + ":" + Clip(ancestors[-2 - at].Name, 80));
        parts.Reverse(); return string.Join("/", parts);
    }

    private int ParentOf(int at) => at >= 0 ? parents[at] : ancestors[-2 - at].Parent;

    public JsonObject Counts()
    {
        var byRole = new JsonObject();
        foreach (var group in roleOf.GroupBy(r => r).OrderBy(g => g.Key)) byRole[Roles[group.Key]] = group.Count();
        var byKind = new JsonObject();
        foreach (var group in typeOf.GroupBy(t => types[t].Kind).OrderBy(g => g.Key, StringComparer.Ordinal)) byKind[group.Key] = group.Count();
        return new JsonObject { ["elements"] = keys.Length, ["byKind"] = byKind, ["byRole"] = byRole };
    }

    public byte[] ToJson()
    {
        using var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(buffer, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping })) {
            json.WriteStartObject();
            json.WriteString("schema", Schema); json.WriteNumber("extractor", Extractor);
            json.WriteString("lane", Lane); json.WriteString("adapter", Adapter);
            json.WriteString("sourceSha256", SourceSha256); json.WriteNumber("sourceBytes", SourceBytes); json.WriteString("createdAt", CreatedAt);
            json.WriteStartObject("module");
            json.WriteString("name", ModuleName); json.WriteString("key", ModuleKey); json.WriteString("kind", ModuleKind);
            json.WriteEndObject();
            json.WriteBoolean("complete", Complete); json.WriteNumber("readErrors", ReadErrors);
            json.WritePropertyName("errorSamples"); errorSamples.WriteTo(json);
            json.WritePropertyName("counts"); Counts().WriteTo(json);
            json.WriteStartArray("roles"); foreach (var role in Roles) json.WriteStringValue(role); json.WriteEndArray();
            json.WriteStartArray("types");
            foreach (var type in types) {
                json.WriteStartObject(); json.WriteString("kind", type.Kind);
                json.WriteStartArray("answers"); foreach (var answer in type.Answers) json.WriteStringValue(answer); json.WriteEndArray();
                if (type.NameProperty is { } projected) json.WriteBoolean("nameProperty", projected); else json.WriteNull("nameProperty");
                json.WriteEndObject();
            }
            json.WriteEndArray();
            json.WriteStartArray("rows");
            for (var row = 0; row < keys.Length; row++) {
                json.WriteStartArray();
                json.WriteStringValue(keys[row]); json.WriteNumberValue(typeOf[row]); json.WriteStringValue(names[row]);
                WriteText(json, modelNames[row]); WriteText(json, labels[row]);
                json.WriteNumberValue(parents[row]); json.WriteNumberValue(roleOf[row]); WriteText(json, dataTypes[row]);
                json.WriteNumberValue(childrenTotal[row]);
                json.WriteEndArray();
            }
            json.WriteEndArray();
            json.WriteStartArray("ancestors");
            foreach (var (key, type, name, parent) in ancestors) {
                json.WriteStartArray();
                json.WriteStringValue(key); json.WriteNumberValue(type); json.WriteStringValue(name); json.WriteNumberValue(parent);
                json.WriteEndArray();
            }
            json.WriteEndArray();
            json.WriteEndObject();
        }
        return buffer.ToArray();
    }

    private static void WriteText(Utf8JsonWriter json, string? text) { if (text == null) json.WriteNullValue(); else json.WriteStringValue(text); }

    // Any identity or shape mismatch throws: the caller treats it as a miss and rebuilds, never serves it.
    public static ModuleIndex Parse(byte[] json, string lane, string adapter, string sourceSha256)
    {
        using var document = JsonDocument.Parse(json);
        var top = document.RootElement;
        static string Text(JsonElement element, string property) => element.GetProperty(property).GetString() ?? throw new InvalidDataException(property + " is null");
        static string Item(JsonElement array, int at) => array[at].GetString() ?? throw new InvalidDataException("column " + at + " is null");
        static string? Optional(JsonElement element) => element.ValueKind == JsonValueKind.Null ? null : element.GetString();
        if (Text(top, "schema") != Schema || top.GetProperty("extractor").GetInt32() != Extractor || Text(top, "lane") != lane
            || Text(top, "adapter") != adapter || !string.Equals(Text(top, "sourceSha256"), sourceSha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Module index identity does not match this capture");
        if (!top.GetProperty("roles").EnumerateArray().Select(r => r.GetString()).SequenceEqual(Roles))
            throw new InvalidDataException("Module index roles differ from this extractor");
        var module = top.GetProperty("module");
        var types = top.GetProperty("types").EnumerateArray().Select(t => new IndexType(Text(t, "kind"),
            t.GetProperty("answers").EnumerateArray().Select(a => a.GetString() ?? throw new InvalidDataException("answer is null")).ToArray(),
            t.TryGetProperty("nameProperty", out var projected) && projected.ValueKind is JsonValueKind.True or JsonValueKind.False ? projected.GetBoolean() : null)).ToArray();
        var rows = top.GetProperty("rows");
        var count = rows.GetArrayLength();
        var above = top.GetProperty("ancestors");
        var ancestors = new (string Key, int Type, string Name, int Parent)[above.GetArrayLength()];
        bool Reference(int parent) => parent >= -1 - ancestors.Length && parent < count;
        var at = 0;
        foreach (var item in above.EnumerateArray()) {
            if (item.GetArrayLength() != 4) throw new InvalidDataException("Module index ancestor " + at + " is malformed");
            ancestors[at] = (Item(item, 0), item[1].GetInt32(), Item(item, 2), item[3].GetInt32());
            if (ancestors[at].Type < 0 || ancestors[at].Type >= types.Length || !Reference(ancestors[at].Parent))
                throw new InvalidDataException("Module index ancestor " + at + " is out of range");
            at++;
        }
        var index = new ModuleIndex {
            Lane = lane, Adapter = adapter, SourceSha256 = Text(top, "sourceSha256").ToLowerInvariant(), SourceBytes = top.GetProperty("sourceBytes").GetInt64(),
            CreatedAt = Text(top, "createdAt"), ModuleName = Text(module, "name"), ModuleKey = Text(module, "key"), ModuleKind = Text(module, "kind"),
            Complete = top.GetProperty("complete").GetBoolean(), ReadErrors = top.GetProperty("readErrors").GetInt32(),
            errorSamples = JsonNode.Parse(top.GetProperty("errorSamples").GetRawText())!.AsArray(), types = types, ancestors = ancestors,
            keys = new string[count], typeOf = new int[count], names = new string[count], modelNames = new string?[count],
            labels = new string?[count], parents = new int[count], roleOf = new int[count], dataTypes = new string?[count], childrenTotal = new int[count]
        };
        var row = 0;
        foreach (var item in rows.EnumerateArray()) {
            if (item.GetArrayLength() != 9) throw new InvalidDataException("Module index row " + row + " is malformed");
            index.keys[row] = Item(item, 0); index.typeOf[row] = item[1].GetInt32(); index.names[row] = Item(item, 2);
            index.modelNames[row] = Optional(item[3]); index.labels[row] = Optional(item[4]);
            index.parents[row] = item[5].GetInt32(); index.roleOf[row] = item[6].GetInt32();
            index.dataTypes[row] = Optional(item[7]); index.childrenTotal[row] = item[8].GetInt32();
            if (index.typeOf[row] < 0 || index.typeOf[row] >= types.Length || !Reference(index.parents[row])
                || index.roleOf[row] < 0 || index.roleOf[row] >= Roles.Length || index.childrenTotal[row] < 0
                || row > 0 && string.CompareOrdinal(index.keys[row - 1], index.keys[row]) > 0)
                throw new InvalidDataException("Module index row " + row + " is out of range or out of key order");
            row++;
        }
        return index;
    }

    private static string Clip(string text, int max) => text.Length > max ? text[..max] + "…" : text;
}

// One folder of indexes per lane: <root>\v1\<lane>\<sha256>.<adapter>.json, and beside each the module digest
// <sha256>.<adapter>.digest.json (ModuleDigest: valid for the same schema, extractor, lane, adapter and sha256) and, when
// asked for, the rich index <sha256>.<adapter>.rich.json (ModuleRichIndex, the same rule). A cache: written atomically,
// trimmed to the budget by oldest write (indexes, digests and rich indexes together), and any file that fails validation
// is a miss.
public sealed class ModuleIndexStore(string root, string lane, string adapter, long budget = 512L * 1024 * 1024)
{
    public string Root => root;
    public string Lane => lane;
    public string Adapter => adapter;

    // SSAM_MODULE_INDEX_ROOT (absolute), else <workspace>\.local\module-index for the nearest .ssam-workspace.json above
    // this assembly: after StudioAssemblies.Bind, O11's AppContext.BaseDirectory is the Studio folder. Lane and adapter
    // follow the build this file is compiled into. Null when neither applies: reads then work as without an index.
    public static ModuleIndexStore? Default()
    {
        var (lane, adapter) = typeof(ModuleIndexStore).Assembly.GetName().Name switch {
            "Anvil.Core" => ("o11", "kernel"), "Anvil.Core.Odc" => ("odc", "kernel"), "ODC3.Builder" => ("odc", "builder"), _ => ("", "") };
        if (lane == "") return null;
        var configured = Environment.GetEnvironmentVariable("SSAM_MODULE_INDEX_ROOT");
        if (!string.IsNullOrWhiteSpace(configured)) return Path.IsPathFullyQualified(configured) ? new(configured, lane, adapter) : null;
        foreach (var start in new[] { Path.GetDirectoryName(typeof(ModuleIndexStore).Assembly.Location), AppContext.BaseDirectory })
            for (var directory = string.IsNullOrEmpty(start) ? null : Path.GetFullPath(start); directory != null; directory = Path.GetDirectoryName(directory))
                if (File.Exists(Path.Combine(directory, ".ssam-workspace.json"))) return new(Path.Combine(directory, ".local", "module-index"), lane, adapter);
        return null;
    }

    public string PathOf(string sourceSha256) => Path.Combine(root, "v1", lane, sourceSha256.ToLowerInvariant() + "." + adapter + ".json");

    public ModuleIndex? Load(string sourceSha256)
    {
        var file = PathOf(sourceSha256);
        try { return File.Exists(file) ? ModuleIndex.Parse(File.ReadAllBytes(file), lane, adapter, sourceSha256) : null; }
        catch { return null; }
    }

    public string Save(ModuleIndex index)
    {
        if (index.Lane != lane || index.Adapter != adapter) throw new ArgumentException("Module index belongs to " + index.Lane + "/" + index.Adapter);
        var file = PathOf(index.SourceSha256);
        DurableJson.WriteBytes(file, index.ToJson());
        Trim(file);
        return file;
    }

    public string DigestPathOf(string sourceSha256) => Path.Combine(root, "v1", lane, sourceSha256.ToLowerInvariant() + "." + adapter + ".digest.json");

    public ModuleDigest? LoadDigest(string sourceSha256)
    {
        var file = DigestPathOf(sourceSha256);
        try { return File.Exists(file) ? ModuleDigest.Parse(File.ReadAllBytes(file), lane, adapter, sourceSha256) : null; }
        catch { return null; }
    }

    public string SaveDigest(ModuleDigest digest)
    {
        if (digest.Lane != lane) throw new ArgumentException("Module digest belongs to the " + digest.Lane + " lane");
        var file = DigestPathOf(digest.SourceSha256);
        DurableJson.WriteBytes(file, digest.ToJson(adapter));
        Trim(file);
        return file;
    }

    // The rich index (ModuleRichIndex, built only on request) beside them: <sha256>.<adapter>.rich.json.
    public string RichPathOf(string sourceSha256) => Path.Combine(root, "v1", lane, sourceSha256.ToLowerInvariant() + "." + adapter + ".rich.json");

    public ModuleRichIndex? LoadRich(string sourceSha256)
    {
        var file = RichPathOf(sourceSha256);
        try { return File.Exists(file) ? ModuleRichIndex.Parse(File.ReadAllBytes(file), lane, adapter, sourceSha256) : null; }
        catch { return null; }
    }

    public string SaveRich(ModuleRichIndex rich)
    {
        if (rich.Lane != lane) throw new ArgumentException("Rich module index belongs to the " + rich.Lane + " lane");
        var file = RichPathOf(rich.SourceSha256);
        DurableJson.WriteBytes(file, rich.ToJson(adapter));
        Trim(file);
        return file;
    }

    private void Trim(string keep)
    {
        var files = new DirectoryInfo(Path.GetDirectoryName(keep)!).GetFiles().OrderBy(f => f.LastWriteTimeUtc).ToList();
        var total = files.Sum(f => f.Length);
        foreach (var file in files) {
            if (total <= budget) break;
            if (string.Equals(file.FullName, keep, StringComparison.OrdinalIgnoreCase)) continue;
            // Another process may be reading or replacing it; the next write trims again.
            try { file.Delete(); total -= file.Length; } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
