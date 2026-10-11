using System.Collections;
using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anvil.Reading;

// Rich module index (ssam-rich-index/1): for every element of one capture, the properties that hold a value (literals,
// enums, names of the elements they point at), the TEXT of every expression, the arguments of every call (parameter ->
// expression) and every reference the element makes (to a row of this capture; a row under a Reference element stands for
// an element of another module, named by its producer in `references`). Built only on request (it is large), once per
// capture sha256, beside the module index and the digest (ModuleIndexStore.SaveRich); the facade answers searches and
// usages from the file (module-rich.mjs, ssam_map view:"search"/"uses") without .NET and without loading the model.
// Shared by both kernels and the ODC builder (linked there) and free of Studio types: it reads only through ModelReader.
// Deterministic: the same OML bytes give the same file except createdAt (rows by key, then path; properties by name;
// references by target). Nothing is cut: texts are whole. A row's identity across modules is its GlobalKey (<module
// key>*<element key>, both Model APIs): written only when it is not this module's own, which is the case of the
// signatures under a Reference (they carry the producer's module and element keys). Value carriers (an Argument, an
// expression element) speak for their owner: their references are written on it, with the property (arg:<parameter> for
// an argument) as `via`. A boolean property that is False is left out (absent = False),
// as are empty texts, binary contents and the lists that only repeat the element's children.
public sealed class ModuleRichIndex
{
    public const string Schema = "ssam-rich-index/1";
    // The version of what Build writes: a stored rich index of another version is a miss. Raise it on every change.
    public const int Extractor = 1;
    // Property types: e expression text, t literal text, v value (enum, number, True), r reference (Kind:Name of the target,
    // or the list of them), a argument of a call (name: the parameter, text: the expression passed).
    public const string PropertyTypes = "etvra";
    // Properties that only repeat the row (Name, keys; GlobalKey has its own column) or the model's bookkeeping (validity,
    // internal paths, canvas positions, the reverse of connectors and the native referrers, icons, display copies, the ODC
    // Model API's descriptors and editing hints), or point at the element's own frame (owners, the module). Measured on
    // the O11 and ODC fixtures (2026-10-10): they were 2/3 of the bytes and every read error.
    private static readonly HashSet<string> Skipped = new(StringComparer.Ordinal) {
        "Name", "Owner", "OwnerESpace", "ESpace", "Module", "PropertyOwner", "RealPropertyOwner", "Object", "Parent", "Children",
        "Key", "ObjectKey", "GlobalKey", "IsValid", "Root", "HorizontalPosition", "VerticalPosition", "IncomingConnectors", "Icon", "DisplayValue",
        "DisplayName", "ReadableIdentifier", "Referrers", "Referers", "ApplicableCssClasses", "CollectionDescriptor", "PropertyDescriptor",
        "RealPropertyDescriptor", "Descriptor", "IndexInParent", "CanMoveBefore", "CanMoveAfter", "IsInitialized", "Generation" };
    // A reference element of another module: its producer is named by the first of these properties that has a value.
    private static readonly string[] ProducerKeyProperties = ["ESpaceKey", "ModuleKey", "ReferencedESpaceKey", "ReferencedModuleKey", "ProducerKey", "ApplicationKey"];

    private sealed record Row(string Key, int Type, string Name, int Parent, int Role, (int Name, char Type, string Text)[] Props, (int Target, int Via)[] Refs, string? Global);

    public string Lane { get; private init; } = "";
    public string SourceSha256 { get; private init; } = "";
    public long SourceBytes { get; private init; }
    public string CreatedAt { get; private init; } = "";
    public string ModuleName { get; private init; } = "";
    public string ModuleKey { get; private init; } = "";
    public string ModuleKind { get; private init; } = "";
    public bool Complete { get; private init; }
    public int ReadErrors { get; private init; }
    public int Count => rows.Length;
    private JsonArray errorSamples = [];
    private (string Kind, string[] Answers)[] types = [];
    private string[] names = [];
    private Row[] rows = [];
    private (int Row, string Producer, string? ProducerKey)[] references = [];

    public static ModuleRichIndex Build<T>(T root, ModelReader<T> reader, string lane, string sourceSha256, long sourceBytes) where T : class
    {
        var samples = new JsonArray(); var readErrors = 0; var complete = true;
        void Fail(string reference, string property, Exception error, bool structural) {
            readErrors++; complete &= !structural;
            if (samples.Count < 8) samples.Add(new JsonObject { ["reference"] = reference, ["property"] = property, ["error"] = Clip(error.GetBaseException().Message, 200) });
        }
        var nodes = reader.Walk(root).ToList();
        // The walk parent (the element whose children list holds it): always a row, so every path stays inside the file.
        var parentOf = new Dictionary<T, T>(ReferenceEqualityComparer.Instance);
        var childrenOf = new Dictionary<T, HashSet<T>>(ReferenceEqualityComparer.Instance);
        foreach (var node in nodes) {
            var set = new HashSet<T>(ReferenceEqualityComparer.Instance);
            try { foreach (var child in reader.ChildrenOf(node)) { set.Add(child); parentOf.TryAdd(child, node); } }
            catch (Exception error) { Fail("walk", "Children", error, true); }
            childrenOf[node] = set;
        }
        var described = new Dictionary<T, (string Key, string Kind, string Name, IReadOnlySet<string> Kinds)>(ReferenceEqualityComparer.Instance);
        foreach (var node in nodes)
            try { var d = reader.Describe(node); described[node] = (d.Key, d.Kind, d.Name, d.Kinds); }
            catch (Exception error) { Fail("walk", "Describe", error, true); }
        var kept = nodes.Where(described.ContainsKey).ToList();
        // Ties of key (an element without a key, a key the Model API repeats) are ordered by the readable path, then kind.
        var pathText = new Dictionary<T, string>(ReferenceEqualityComparer.Instance);
        string PathText(T node) {
            if (pathText.TryGetValue(node, out var known)) return known;
            var d = described[node];
            var text = (parentOf.TryGetValue(node, out var parent) && described.ContainsKey(parent) ? PathText(parent) + "/" : "") + d.Kind + ":" + d.Name;
            return pathText[node] = text;
        }
        var order = kept.OrderBy(n => described[n].Key, StringComparer.Ordinal).ThenBy(PathText, StringComparer.Ordinal)
            .ThenBy(n => described[n].Kind, StringComparer.Ordinal).ToList();
        var rowOf = new Dictionary<T, int>(ReferenceEqualityComparer.Instance);
        for (var row = 0; row < order.Count; row++) rowOf[order[row]] = row;

        var types = new List<(string Kind, string[] Answers)>(); var typeIds = new Dictionary<string, int>(StringComparer.Ordinal);
        var typeRoles = new List<int>();
        int TypeOf(string kind, IReadOnlySet<string> kinds) {
            var answers = kinds.Order(StringComparer.Ordinal).ToArray();
            var id = kind + "\n" + string.Join("\n", answers);
            if (!typeIds.TryGetValue(id, out var type)) {
                typeIds[id] = type = types.Count; types.Add((kind, answers));
                typeRoles.Add(ModuleIndex.RoleOf(kind, new HashSet<string>(answers, StringComparer.Ordinal)));
            }
            return type;
        }
        var nameIds = new Dictionary<string, int>(StringComparer.Ordinal); var nameList = new List<string>();
        int NameId(string name) { if (!nameIds.TryGetValue(name, out var id)) { nameIds[name] = id = nameList.Count; nameList.Add(name); } return id; }
        string Display(T node) => described.TryGetValue(node, out var d) ? d.Name : reader.DisplayOf(node);
        string KindName(T node) => (described.TryGetValue(node, out var d) ? d.Kind : reader.KindOf(node)) + ":" + Display(node);
        // A consumer the native graph names that is no row (an expression object): the nearest row above it.
        int RowAbove(T node) {
            var at = node;
            for (var depth = 0; depth < 32 && at != null; depth++) {
                if (rowOf.TryGetValue(at, out var row)) return row;
                T? up; try { up = reader.ParentOf(at); } catch { return -1; }
                at = up!;
            }
            return -1;
        }

        var props = new List<(string Name, char Type, string Text)>[order.Count];
        var refs = new Dictionary<int, string?>[order.Count];
        var rowType = new int[order.Count]; var globals = new string?[order.Count];
        var pending = new List<(int From, int To, string? Via)>();
        var argumentName = new Dictionary<int, string>();
        for (var row = 0; row < order.Count; row++) { props[row] = []; refs[row] = []; }
        for (var row = 0; row < order.Count; row++) {
            var node = order[row]; var key = described[node].Key; var kind = described[node].Kind;
            rowType[row] = TypeOf(kind, described[node].Kinds);
            var argument = kind == "Argument";
            // The element's identity across modules (O11 and ODC: <module key>*<element key>; a reference signature carries its
            // producer's), kept only when it is not this module's own.
            try {
                if (reader.PropertyOf(node, "GlobalKey")?.Invoke()?.ToString() is { Length: > 0 } global && global != reader.KeyOf(root) + "*" + key) globals[row] = global;
            } catch (Exception error) { Fail("@" + key, "GlobalKey", error, false); }
            foreach (var (property, read) in reader.PropertiesOf(node)) {
                if (ModelReader<T>.IsNoise(property) || Skipped.Contains(property)) continue;
                // An argument's parameter and value are written on the call that owns it (type a); the rest of it stays.
                if (argument && property is "Value" or "Parameter") continue;
                object? value;
                try { value = read(); } catch (Exception error) { Fail("@" + key, property, error, false); continue; }
                if (value == null || value is byte[]) continue;
                if (reader.ExpressionText(value) is { } expression) { if (expression.Length > 0) props[row].Add((property, 'e', expression)); continue; }
                switch (value) {
                    case T target:
                        if (ReferenceEquals(target, node) || ReferenceEquals(target, root) || parentOf.TryGetValue(node, out var owner) && ReferenceEquals(owner, target)) continue;
                        props[row].Add((property, 'r', KindName(target)));
                        if (rowOf.TryGetValue(target, out var targetRow)) pending.Add((row, targetRow, property));
                        continue;
                    case string text:
                        if (text.Length > 0) props[row].Add((property, 't', text));
                        continue;
                    case bool flag:
                        if (flag) props[row].Add((property, 'v', "True"));
                        continue;
                    case IEnumerable items: {
                        var listed = new List<T>(); var texts = new List<string>(); var structural = true;
                        foreach (var item in items) {
                            if (item is T element) { listed.Add(element); structural &= childrenOf[node].Contains(element); }
                            else if (item != null && Plain(item) is { Length: > 0 } plain) { texts.Add(plain); structural = false; }
                        }
                        // A list of the element's own children (InputParameters, Attributes...) repeats the rows.
                        if (listed.Count + texts.Count == 0 || structural && texts.Count == 0) continue;
                        if (listed.Count > 0) {
                            // Sets (a screen's Roles) come in another order on each load: ordered by their text.
                            props[row].Add((property, 'r', "[" + string.Join(", ", listed.Select(KindName).Order(StringComparer.Ordinal)) + "]"));
                            foreach (var element in listed) if (rowOf.TryGetValue(element, out var listedRow)) pending.Add((row, listedRow, property));
                        } else props[row].Add((property, 'v', "[" + string.Join(", ", texts) + "]"));
                        continue;
                    }
                    default:
                        if (Plain(value) is { Length: > 0 } other) props[row].Add((property, 'v', other));
                        continue;
                }
            }
            // The arguments of a call (Execute*, navigation, block instance, event handler): parameter -> expression.
            foreach (var child in childrenOf[node]) {
                if (!described.TryGetValue(child, out var c) || c.Kind != "Argument" || !rowOf.TryGetValue(child, out var childRow)) continue;
                try {
                    var parameter = reader.PropertyOf(child, "Parameter")?.Invoke();
                    var name = parameter is T p ? Display(p) : parameter?.ToString() ?? "?";
                    var valueObject = reader.PropertyOf(child, "Value")?.Invoke();
                    var text = valueObject == null ? "" : reader.ExpressionText(valueObject) ?? valueObject.ToString() ?? "";
                    props[row].Add((name, 'a', text));
                    argumentName[childRow] = name;
                    if (parameter is T parameterNode && rowOf.TryGetValue(parameterNode, out var parameterRow)) pending.Add((childRow, parameterRow, "Parameter"));
                } catch (Exception error) { Fail("@" + c.Key, "Argument", error, false); }
            }
        }
        // Value carriers speak for their owner: an argument for the call that holds it (via arg:<parameter>), an expression
        // element for the property of its owner that holds the same text. Their references are the owner's; the expression's
        // own copy of the text is left out (the owner has it).
        var parentRowOf = new int[order.Count];
        for (var row = 0; row < order.Count; row++) parentRowOf[row] = parentOf.TryGetValue(order[row], out var up) && rowOf.TryGetValue(up, out var upRow) ? upRow : -1;
        var lift = new (int Owner, string Via)?[order.Count];
        foreach (var (row, name) in argumentName) if (parentRowOf[row] >= 0) lift[row] = (parentRowOf[row], "arg:" + name);
        for (var row = 0; row < order.Count; row++) {
            var p = parentRowOf[row];
            if (p < 0 || lift[row] != null || ModuleIndex.Roles[typeRoles[rowType[row]]] != "expression") continue;
            if (lift[p] is { } argumentOwner) { lift[row] = argumentOwner; props[row].Clear(); continue; }
            string? via = null;
            foreach (var (_, type, text) in props[row]) {
                if (type is not ('t' or 'e')) continue;
                foreach (var (name, ownerType, ownerText) in props[p].OrderBy(x => x.Name, StringComparer.Ordinal))
                    if (ownerType == 'e' && ownerText == text) { via = name; break; }
                if (via != null) break;
            }
            if (via != null) { lift[row] = (p, via); props[row].Clear(); }
        }
        void Refer(int from, int to, string? via) {
            if (from >= 0 && lift[from] is { } carrier) { from = carrier.Owner; via = carrier.Via; }
            if (from < 0 || to < 0 || from == to || ReferenceEquals(order[to], root)) return;
            if (!refs[from].TryGetValue(to, out var known) || known == null || via != null && string.CompareOrdinal(via, known) < 0) refs[from][to] = via ?? known;
        }
        foreach (var (from, to, via) in pending) Refer(from, to, via);
        // The native graph adds what no property names: the elements an expression uses (a site property in a condition,
        // a variable in an assignment). Its property is the carrier's, else the first expression of the consumer naming it.
        for (var row = 0; row < order.Count; row++) {
            var target = order[row];
            IEnumerable<T> referrers;
            try { referrers = reader.ReferrersOf(target).ToList(); } catch (Exception error) { Fail("@" + described[target].Key, "Referrers", error, false); continue; }
            var name = Display(target);
            foreach (var consumer in referrers) {
                if (consumer == null) continue;
                var from = RowAbove(consumer);
                if (from < 0 || from == row) continue;
                string? via = null;
                if (lift[from] == null && !refs[from].ContainsKey(row) && name.Length > 0)
                    foreach (var (property, type, text) in props[from].OrderBy(p => p.Name, StringComparer.Ordinal))
                        if (type is 'e' or 'a' && text.Contains(name, StringComparison.OrdinalIgnoreCase)) { via = type == 'a' ? "arg:" + property : property; break; }
                Refer(from, row, via);
            }
        }
        var rows = new Row[order.Count];
        for (var row = 0; row < order.Count; row++) {
            var d = described[order[row]];
            var type = rowType[row];
            var ordered = props[row].OrderBy(x => x.Type == 'a' ? 1 : 0).ThenBy(x => x.Name, StringComparer.Ordinal)
                .ThenBy(x => x.Type).ThenBy(x => x.Text, StringComparer.Ordinal).Select(x => (NameId(x.Name), x.Type, x.Text)).ToArray();
            var outgoing = refs[row].OrderBy(r => r.Key).Select(r => (r.Key, r.Value == null ? -1 : NameId(r.Value))).ToArray();
            rows[row] = new Row(d.Key, type, d.Name, parentRowOf[row], typeRoles[type], ordered, outgoing, globals[row]);
        }
        // The property table in first-use order of the ordered rows, so the file does not depend on the read order.
        var renumber = new Dictionary<int, int>(); var table = new List<string>();
        int Renumber(int id) { if (!renumber.TryGetValue(id, out var at)) { renumber[id] = at = table.Count; table.Add(nameList[id]); } return at; }
        for (var row = 0; row < rows.Length; row++)
            rows[row] = rows[row] with { Props = rows[row].Props.Select(x => (Renumber(x.Name), x.Type, x.Text)).ToArray(),
                Refs = rows[row].Refs.Select(r => (r.Target, r.Via < 0 ? -1 : Renumber(r.Via))).ToArray() };
        // Types in first-use order as well.
        var typeRenumber = new Dictionary<int, int>(); var typeTable = new List<(string, string[])>();
        for (var row = 0; row < rows.Length; row++) {
            if (!typeRenumber.TryGetValue(rows[row].Type, out var at)) { typeRenumber[rows[row].Type] = at = typeTable.Count; typeTable.Add(types[rows[row].Type]); }
            rows[row] = rows[row] with { Type = at };
        }
        var referencesTable = new List<(int, string, string?)>();
        for (var row = 0; row < rows.Length; row++) {
            if (typeTable[rows[row].Type].Item1 != "Reference") continue;
            string? producerKey = null;
            foreach (var property in ProducerKeyProperties) {
                var at = Array.FindIndex(rows[row].Props, x => table[x.Name] == property && x.Type is 't' or 'v');
                if (at >= 0) { producerKey = rows[row].Props[at].Text; break; }
            }
            referencesTable.Add((row, rows[row].Name, producerKey));
        }
        return new ModuleRichIndex {
            Lane = lane, SourceSha256 = sourceSha256.ToLowerInvariant(), SourceBytes = sourceBytes, CreatedAt = DateTimeOffset.UtcNow.ToString("o"),
            ModuleName = reader.DisplayOf(root), ModuleKey = reader.KeyOf(root), ModuleKind = reader.KindOf(root),
            Complete = complete, ReadErrors = readErrors, errorSamples = samples, types = typeTable.ToArray(), names = table.ToArray(),
            rows = rows, references = referencesTable.ToArray()
        };
    }

    // Enums, numbers and dates in the invariant culture; an object whose text is only its type name says nothing.
    private static string? Plain(object value)
    {
        var text = value is IFormattable formattable ? formattable.ToString(null, CultureInfo.InvariantCulture) : value.ToString();
        return text == null || text == value.GetType().FullName ? null : text;
    }

    public JsonObject Counts()
    {
        int Props(char type) => rows.Sum(r => r.Props.Count(p => p.Type == type));
        return new JsonObject { ["elements"] = rows.Length, ["properties"] = rows.Sum(r => r.Props.Length), ["expressions"] = Props('e'),
            ["arguments"] = Props('a'), ["references"] = rows.Sum(r => r.Refs.Length), ["moduleReferences"] = references.Length };
    }

    // Cold reads (kernel CLIs): the stored rich index of these bytes, else built from the model the caller loads and stored.
    // load is called only on a miss; the answer names the file and whether it was built.
    public static JsonObject Ensure(ModuleIndexStore store, string file, Func<byte[], string, ModuleRichIndex> load)
    {
        var bytes = File.ReadAllBytes(file);
        var sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes));
        var rich = store.LoadRich(sha256); var built = false;
        if (rich == null) { rich = load(bytes, sha256); store.SaveRich(rich); built = true; }
        return rich.Answer(store.RichPathOf(sha256), built);
    }

    // The reader's answer to {"rich":"ensure"}: where the facade reads it, and what it holds.
    public JsonObject Answer(string path, bool built) => new() {
        ["schema"] = Schema, ["extractor"] = Extractor, ["module"] = ModuleName, ["lane"] = Lane, ["sourceSha256"] = SourceSha256,
        ["sourceBytes"] = SourceBytes, ["path"] = path, ["bytes"] = File.Exists(path) ? new FileInfo(path).Length : 0, ["built"] = built,
        ["complete"] = Complete, ["readErrors"] = ReadErrors, ["counts"] = Counts() };

    public byte[] ToJson(string adapter)
    {
        using var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(buffer, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping })) {
            json.WriteStartObject();
            json.WriteString("schema", Schema); json.WriteNumber("extractor", Extractor);
            json.WriteString("lane", Lane); json.WriteString("adapter", adapter);
            json.WriteString("sourceSha256", SourceSha256); json.WriteNumber("sourceBytes", SourceBytes); json.WriteString("createdAt", CreatedAt);
            json.WriteStartObject("module");
            json.WriteString("name", ModuleName); json.WriteString("key", ModuleKey); json.WriteString("kind", ModuleKind);
            json.WriteEndObject();
            json.WriteBoolean("complete", Complete); json.WriteNumber("readErrors", ReadErrors);
            json.WritePropertyName("errorSamples"); errorSamples.WriteTo(json);
            json.WritePropertyName("counts"); Counts().WriteTo(json);
            json.WriteStartArray("roles"); foreach (var role in ModuleIndex.Roles) json.WriteStringValue(role); json.WriteEndArray();
            json.WriteString("propertyTypes", PropertyTypes);
            json.WriteStartArray("types");
            foreach (var (kind, answers) in types) {
                json.WriteStartObject(); json.WriteString("kind", kind);
                json.WriteStartArray("answers"); foreach (var answer in answers) json.WriteStringValue(answer); json.WriteEndArray();
                json.WriteEndObject();
            }
            json.WriteEndArray();
            json.WriteStartArray("names"); foreach (var name in names) json.WriteStringValue(name); json.WriteEndArray();
            json.WriteStartArray("references");
            foreach (var (row, producer, producerKey) in references) {
                json.WriteStartArray(); json.WriteNumberValue(row); json.WriteStringValue(producer);
                if (producerKey == null) json.WriteNullValue(); else json.WriteStringValue(producerKey);
                json.WriteEndArray();
            }
            json.WriteEndArray();
            json.WriteStartArray("rows");
            foreach (var row in rows) {
                json.WriteStartArray();
                json.WriteStringValue(row.Key); json.WriteNumberValue(row.Type); json.WriteStringValue(row.Name);
                json.WriteNumberValue(row.Parent); json.WriteNumberValue(row.Role);
                json.WriteStartArray();
                foreach (var (name, type, text) in row.Props) {
                    json.WriteStartArray(); json.WriteNumberValue(name); json.WriteStringValue(type.ToString()); json.WriteStringValue(text); json.WriteEndArray();
                }
                json.WriteEndArray();
                json.WriteStartArray();
                foreach (var (target, via) in row.Refs) { json.WriteStartArray(); json.WriteNumberValue(target); json.WriteNumberValue(via); json.WriteEndArray(); }
                json.WriteEndArray();
                if (row.Global == null) json.WriteNullValue(); else json.WriteStringValue(row.Global);
                json.WriteEndArray();
            }
            json.WriteEndArray();
            json.WriteEndObject();
        }
        return buffer.ToArray();
    }

    // Any identity or shape mismatch throws: the caller treats it as a miss and builds again, never serves it.
    public static ModuleRichIndex Parse(byte[] json, string lane, string adapter, string sourceSha256)
    {
        using var document = JsonDocument.Parse(json);
        var top = document.RootElement;
        static string Text(JsonElement element, string property) => element.GetProperty(property).GetString() ?? throw new InvalidDataException(property + " is null");
        static string Item(JsonElement array, int at) => array[at].GetString() ?? throw new InvalidDataException("column " + at + " is null");
        if (Text(top, "schema") != Schema || top.GetProperty("extractor").GetInt32() != Extractor || Text(top, "lane") != lane
            || Text(top, "adapter") != adapter || !string.Equals(Text(top, "sourceSha256"), sourceSha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Rich module index identity does not match this capture");
        if (!top.GetProperty("roles").EnumerateArray().Select(r => r.GetString()).SequenceEqual(ModuleIndex.Roles) || Text(top, "propertyTypes") != PropertyTypes)
            throw new InvalidDataException("Rich module index roles or property types differ from this extractor");
        var types = top.GetProperty("types").EnumerateArray().Select(t => (Text(t, "kind"),
            t.GetProperty("answers").EnumerateArray().Select(a => a.GetString() ?? throw new InvalidDataException("answer is null")).ToArray())).ToArray();
        var names = top.GetProperty("names").EnumerateArray().Select(n => n.GetString() ?? throw new InvalidDataException("name is null")).ToArray();
        var count = top.GetProperty("rows").GetArrayLength();
        var rows = new Row[count]; var at = 0;
        foreach (var item in top.GetProperty("rows").EnumerateArray()) {
            if (item.GetArrayLength() != 8) throw new InvalidDataException("Rich module index row " + at + " is malformed");
            var props = item[5].EnumerateArray().Select(p => (p[0].GetInt32(), (Item(p, 1) is [var c] ? c : '?'), Item(p, 2))).ToArray();
            var refs = item[6].EnumerateArray().Select(r => (r[0].GetInt32(), r[1].GetInt32())).ToArray();
            var row = new Row(Item(item, 0), item[1].GetInt32(), Item(item, 2), item[3].GetInt32(), item[4].GetInt32(), props, refs,
                item[7].ValueKind == JsonValueKind.Null ? null : item[7].GetString());
            if (row.Type < 0 || row.Type >= types.Length || row.Parent < -1 || row.Parent >= count || row.Role < 0 || row.Role >= ModuleIndex.Roles.Length
                || props.Any(p => p.Item1 < 0 || p.Item1 >= names.Length || !PropertyTypes.Contains(p.Item2))
                || refs.Any(r => r.Item1 < 0 || r.Item1 >= count || r.Item2 < -1 || r.Item2 >= names.Length)
                || at > 0 && string.CompareOrdinal(rows[at - 1].Key, row.Key) > 0)
                throw new InvalidDataException("Rich module index row " + at + " is out of range or out of key order");
            rows[at++] = row;
        }
        var references = top.GetProperty("references").EnumerateArray().Select(r => (r[0].GetInt32(), Item(r, 1),
            r[2].ValueKind == JsonValueKind.Null ? null : r[2].GetString())).ToArray();
        if (references.Any(r => r.Item1 < 0 || r.Item1 >= count)) throw new InvalidDataException("Rich module index reference out of range");
        var module = top.GetProperty("module");
        return new ModuleRichIndex {
            Lane = lane, SourceSha256 = Text(top, "sourceSha256").ToLowerInvariant(), SourceBytes = top.GetProperty("sourceBytes").GetInt64(),
            CreatedAt = Text(top, "createdAt"), ModuleName = Text(module, "name"), ModuleKey = Text(module, "key"), ModuleKind = Text(module, "kind"),
            Complete = top.GetProperty("complete").GetBoolean(), ReadErrors = top.GetProperty("readErrors").GetInt32(),
            errorSamples = JsonNode.Parse(top.GetProperty("errorSamples").GetRawText())!.AsArray(),
            types = types, names = names, rows = rows, references = references
        };
    }

    private static string Clip(string text, int max) => text.Length > max ? text[..max] + "…" : text;
}
