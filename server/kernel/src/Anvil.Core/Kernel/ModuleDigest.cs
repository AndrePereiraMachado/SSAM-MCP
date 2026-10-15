using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anvil.Reading;

// The element a block of the digest renders: its key, kind and name, the folder it sits in (actions, structures) and, for a
// static entity, how many of its last lines are records (the facade folds them on the overview page).
public sealed record DigestEntry(string Key, string Kind, string Name, string? Folder = null, int Records = 0);

// One action of the module, with signature only, for the index of the overview page: inputs and outputs with their types,
// what it calls (Execute nodes of its flow) and which actions of this module call it.
public sealed record DigestAction(string Key, string Kind, string Name, string Section, string? Folder, bool Public, bool Function,
    string Inputs, string Outputs, IReadOnlyList<string> Calls, IReadOnlyList<string> CalledBy);

// One section of a module digest: one block per top-level element, each block headed by the element's @key.
public sealed record DigestSection(string Id, string Title, int Count, IReadOnlyList<string> Blocks, IReadOnlyList<DigestEntry> Entries)
{
    public string Text => "## " + Title + " (" + Count + ")\n" + string.Concat(Blocks.Select(b => b + "\n"));
    public int Bytes => Encoding.UTF8.GetByteCount(Text);
}

// Module digest (ssam-digest/1): the whole module as compact text, built once per capture so the model reads it once and
// works in its own context; inspect by @key only to go deeper. Shared by both kernels and free of Studio types (it reads
// only through ModelReader), so the ODC builder can link it like ModuleIndex. Deterministic: the same OML bytes give the
// same text (no clock, top-level elements ordered by name then key, flows in connector order, members in model order).
// Nothing is cut silently: a clipped text says how many characters it left out (an expression also names the @key that
// holds it whole), and the coverage section counts every element and names each kind that was not rendered.
// Stored beside the module index (ModuleIndexStore.SaveDigest): <sha256>.<adapter>.digest.json, valid only for the same
// schema, Extractor, lane, adapter and sha256; the facade pages it (module-map.mjs, ssam_map view:"digest").
public sealed class ModuleDigest
{
    public const string Schema = "ssam-digest/1";
    // The version of what Build writes: a stored digest of another version is a miss. Raise it on every change of the text.
    public const int Extractor = 3;
    public static readonly string[] SectionIds = ["module", "entities", "structures", "variables", "roles", "exceptions",
        "actions", "timers", "integrations", "ui", "coverage"];

    public string Lane { get; private init; } = "";
    public string SourceSha256 { get; private init; } = "";
    public long SourceBytes { get; private init; }
    public string CreatedAt { get; private init; } = "";
    public string ModuleName { get; private init; } = "";
    public string ModuleKey { get; private init; } = "";
    public string ModuleKind { get; private init; } = "";
    public int Elements { get; private init; }
    public int NotRendered { get; private init; }
    public int Clipped { get; private init; }
    public int ReadErrors { get; private init; }
    public IReadOnlyList<DigestSection> Sections { get; private init; } = [];
    public IReadOnlyList<DigestAction> Actions { get; private init; } = [];

    public string Text => string.Concat(Sections.Select(s => s.Text));

    public DigestSection Section(string id) => Sections.Single(s => s.Id == id);

    public static ModuleDigest Build<T>(T root, ModelReader<T> reader, string lane, string sourceSha256, long sourceBytes) where T : class
    {
        var writer = new DigestWriter<T>(root, reader, lane, sourceSha256.ToLowerInvariant(), sourceBytes);
        var sections = writer.Write();
        return new ModuleDigest {
            Lane = lane, SourceSha256 = sourceSha256.ToLowerInvariant(), SourceBytes = sourceBytes, CreatedAt = DateTimeOffset.UtcNow.ToString("o"),
            ModuleName = reader.DisplayOf(root), ModuleKey = reader.KeyOf(root), ModuleKind = writer.ModuleType,
            Elements = writer.Elements, NotRendered = writer.NotRenderedCount, Clipped = writer.Clips, ReadErrors = writer.ReadErrors,
            Sections = sections, Actions = writer.ActionIndex()
        };
    }

    // The digest text of every action with a flow, by key, as the digest renders it (indentation of its block removed).
    internal static IReadOnlyDictionary<string, string> ActionTexts<T>(T root, ModelReader<T> reader, string lane) where T : class
    {
        var writer = new DigestWriter<T>(root, reader, lane, "", 0);
        writer.Write();
        return writer.ActionTexts;
    }

    // Cold reads (kernel CLIs, builder): the stored digest of these bytes, else built from the model the caller loads and
    // stored. load is called only on a miss; the answer names the file and whether it was built.
    public static JsonObject Ensure(ModuleIndexStore store, string file, Func<byte[], string, ModuleDigest> load)
    {
        var bytes = File.ReadAllBytes(file);
        var sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes));
        var digest = store.LoadDigest(sha256); var built = false;
        if (digest == null) { digest = load(bytes, sha256); store.SaveDigest(digest); built = true; }
        return digest.Answer(store.DigestPathOf(sha256), built);
    }

    // The reader's answer to {"digest":"ensure"}: where the facade reads it, and its size per section.
    public JsonObject Answer(string path, bool built)
    {
        var answer = Sizes();
        answer["path"] = path; answer["sourceSha256"] = SourceSha256; answer["built"] = built; answer["extractor"] = Extractor;
        return answer;
    }

    // Size per section: UTF-8 bytes and estimated tokens (bytes / 4, rounded up).
    public JsonObject Sizes()
    {
        var sections = new JsonArray();
        foreach (var section in Sections) {
            var bytes = section.Bytes;
            sections.Add(new JsonObject { ["id"] = section.Id, ["count"] = section.Count, ["blocks"] = section.Blocks.Count,
                ["bytes"] = bytes, ["tokens"] = (bytes + 3) / 4 });
        }
        var total = Encoding.UTF8.GetByteCount(Text);
        return new JsonObject { ["schema"] = Schema, ["module"] = ModuleName, ["lane"] = Lane, ["sourceBytes"] = SourceBytes,
            ["elements"] = Elements, ["bytes"] = total, ["tokens"] = (total + 3) / 4, ["notRendered"] = NotRendered,
            ["clipped"] = Clipped, ["readErrors"] = ReadErrors, ["actions"] = Actions.Count, ["sections"] = sections };
    }

    // The stored form: every block with its entry, and the action index. Text is rebuilt from the blocks, byte for byte.
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
            json.WriteNumber("elements", Elements); json.WriteNumber("notRendered", NotRendered);
            json.WriteNumber("clipped", Clipped); json.WriteNumber("readErrors", ReadErrors);
            json.WriteStartArray("sections");
            foreach (var section in Sections) {
                json.WriteStartObject();
                json.WriteString("id", section.Id); json.WriteString("title", section.Title); json.WriteNumber("count", section.Count);
                json.WriteStartArray("blocks");
                for (var i = 0; i < section.Blocks.Count; i++) {
                    var entry = section.Entries[i];
                    json.WriteStartObject();
                    json.WriteString("key", entry.Key); json.WriteString("kind", entry.Kind); json.WriteString("name", entry.Name);
                    if (entry.Folder != null) json.WriteString("folder", entry.Folder);
                    if (entry.Records > 0) json.WriteNumber("records", entry.Records);
                    json.WriteString("text", section.Blocks[i]);
                    json.WriteEndObject();
                }
                json.WriteEndArray();
                json.WriteEndObject();
            }
            json.WriteEndArray();
            json.WriteStartArray("actions");
            foreach (var action in Actions) {
                json.WriteStartObject();
                json.WriteString("key", action.Key); json.WriteString("kind", action.Kind); json.WriteString("name", action.Name);
                json.WriteString("section", action.Section);
                if (action.Folder != null) json.WriteString("folder", action.Folder);
                json.WriteBoolean("public", action.Public); json.WriteBoolean("function", action.Function);
                json.WriteString("in", action.Inputs); json.WriteString("out", action.Outputs);
                json.WriteStartArray("calls"); foreach (var call in action.Calls) json.WriteStringValue(call); json.WriteEndArray();
                json.WriteStartArray("calledBy"); foreach (var caller in action.CalledBy) json.WriteStringValue(caller); json.WriteEndArray();
                json.WriteEndObject();
            }
            json.WriteEndArray();
            json.WriteEndObject();
        }
        return buffer.ToArray();
    }

    // Any identity or shape mismatch throws: the caller treats it as a miss and builds again, never serves it.
    public static ModuleDigest Parse(byte[] json, string lane, string adapter, string sourceSha256)
    {
        using var document = JsonDocument.Parse(json);
        var top = document.RootElement;
        static string Text(JsonElement element, string property) => element.GetProperty(property).GetString() ?? throw new InvalidDataException(property + " is null");
        static string? Optional(JsonElement element, string property) => element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        if (Text(top, "schema") != Schema || top.GetProperty("extractor").GetInt32() != Extractor || Text(top, "lane") != lane
            || Text(top, "adapter") != adapter || !string.Equals(Text(top, "sourceSha256"), sourceSha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Module digest identity does not match this capture");
        var sections = new List<DigestSection>();
        foreach (var section in top.GetProperty("sections").EnumerateArray()) {
            var blocks = new List<string>(); var entries = new List<DigestEntry>();
            foreach (var block in section.GetProperty("blocks").EnumerateArray()) {
                blocks.Add(Text(block, "text"));
                entries.Add(new(Text(block, "key"), Text(block, "kind"), Text(block, "name"), Optional(block, "folder"),
                    block.TryGetProperty("records", out var records) ? records.GetInt32() : 0));
            }
            sections.Add(new(Text(section, "id"), Text(section, "title"), section.GetProperty("count").GetInt32(), blocks, entries));
        }
        if (!sections.Select(s => s.Id).SequenceEqual(SectionIds)) throw new InvalidDataException("Module digest sections differ from this extractor");
        var actions = top.GetProperty("actions").EnumerateArray().Select(a => new DigestAction(Text(a, "key"), Text(a, "kind"), Text(a, "name"),
            Text(a, "section"), Optional(a, "folder"), a.GetProperty("public").GetBoolean(), a.GetProperty("function").GetBoolean(),
            Text(a, "in"), Text(a, "out"),
            a.GetProperty("calls").EnumerateArray().Select(c => c.GetString() ?? throw new InvalidDataException("call is null")).ToList(),
            a.GetProperty("calledBy").EnumerateArray().Select(c => c.GetString() ?? throw new InvalidDataException("caller is null")).ToList())).ToList();
        var module = top.GetProperty("module");
        return new ModuleDigest {
            Lane = lane, SourceSha256 = Text(top, "sourceSha256").ToLowerInvariant(), SourceBytes = top.GetProperty("sourceBytes").GetInt64(),
            CreatedAt = Text(top, "createdAt"), ModuleName = Text(module, "name"), ModuleKey = Text(module, "key"), ModuleKind = Text(module, "kind"),
            Elements = top.GetProperty("elements").GetInt32(), NotRendered = top.GetProperty("notRendered").GetInt32(),
            Clipped = top.GetProperty("clipped").GetInt32(), ReadErrors = top.GetProperty("readErrors").GetInt32(),
            Sections = sections, Actions = actions
        };
    }
}

internal sealed class DigestWriter<T>(T root, ModelReader<T> reader, string lane, string sourceSha256, long sourceBytes) where T : class
{
    // An expression is clipped only past ExpressionMax, and the clip names the @key that holds it whole.
    private const int DescriptionMax = 160, ExpressionMax = 2000, ScriptMax = 160, TextMax = 80;
    private static readonly string[] Lifecycle = ["OnInitialize", "OnReady", "OnRender", "OnParametersChanged", "OnDestroy", "OnAfterFetch"];
    private static readonly string[] Integrations = ["RestClient", "RestService", "SOAPClient", "SOAPService", "SoapClient", "SoapService", "WebReference", "WebService"];
    // Value carriers: their text is rendered through the property of the element that owns them. The ODC Model API also
    // lists the parts of a list or record literal ([...], {...}) under the expression that holds them.
    private static readonly HashSet<string> ValueKinds = new(StringComparer.Ordinal) {
        "Expression", "TextBasedExpression", "TypeConversionExpression", "ActionConnector", "CommentConnector", "RecordLiteralField", "ImplicitParameter",
        "ListLiteralExpression", "ListLiteralItem", "RecordLiteralExpression" };
    private static readonly HashSet<string> BuiltIn = new(StringComparer.Ordinal) {
        "BasicType", "Type", "ListType", "GenericType", "AnonymousStructure", "SystemException", "RoleException", "PreviousScreen", "AbstractionsManager", "IdentifierType",
        "RoleSignature", "StructureSignature", "StaticEntitySignature" };

    private readonly HashSet<T> covered = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<T, string> folded = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<T, T> parentOf = new(ReferenceEqualityComparer.Instance);
    private readonly List<T> all = [];
    private ModelReader<T> R => reader;
    public int Elements => all.Count;
    public int Clips { get; private set; }
    public int ReadErrors { get; private set; }
    public int NotRenderedCount { get; private set; }
    public string ModuleType { get; private set; } = "";

    // The action index: every action rendered with a flow, by the scope it was rendered in, and the calls of its flow.
    private sealed class ActionInfo(T node, string name, string section, string? folder)
    {
        public readonly T Node = node;
        public readonly string Name = name, Section = section;
        public readonly string? Folder = folder;
        public string Inputs = "", Outputs = "";
        public readonly List<T> Calls = [];
    }
    private readonly List<ActionInfo> actions = [];
    // The text of every action rendered with a flow, by key, without the indentation of the block that holds it (the
    // flow reading, ModuleFlow, compares its size per action with it).
    internal readonly Dictionary<string, string> ActionTexts = new(StringComparer.Ordinal);
    private readonly Stack<ActionInfo> owners = new();
    private string scope = "", sectionId = "";
    private int records;

    // Kinds the digest names but does not render: their elements are folded with this reason.
    private static readonly Dictionary<string, string> Unrendered = new(StringComparer.Ordinal) {
        ["Folder"] = "folders (each block names its folder)", ["Resource"] = "themes, resources and diagrams",
        ["MobileTheme"] = "themes, resources and diagrams", ["WebTheme"] = "themes, resources and diagrams", ["Theme"] = "themes, resources and diagrams",
        ["ThemeValues"] = "themes, resources and diagrams", ["Image"] = "themes, resources and diagrams", ["EntityDiagram"] = "themes, resources and diagrams" };

    public IReadOnlyList<DigestSection> Write()
    {
        foreach (var node in reader.Walk(root)) {
            all.Add(node);
            foreach (var child in reader.ChildrenOf(node)) parentOf.TryAdd(child, node);
        }
        covered.Add(root);
        ModuleType = S(root, "ESpaceType") ?? S(root, "Kind") ?? reader.KindOf(root);
        var top = Sorted(reader.ChildrenOf(root)).ToList();
        foreach (var node in top) if (BuiltIn.Contains(reader.KindOf(node))) Fold(node, "built-in and derived types");
        var sections = new List<DigestSection> {
            ModuleSection(top),
            Section("entities", "entities", top.Where(IsEntity), Entity),
            Section("structures", "structures", top.Where(n => reader.KindOf(n) == "Structure"), Structure),
            Section("variables", "site properties and client/session variables", top.Where(IsVariable), Variable),
            Section("roles", "roles", top.Where(n => reader.IsKind(n, "Role") && !reader.KindOf(n).EndsWith("Signature", StringComparison.Ordinal)), Role),
            Section("exceptions", "user exceptions", top.Where(n => reader.KindOf(n) == "UserException"), Exception),
            Section("actions", "actions", top.Where(n => reader.IsKind(n, "Action")).OrderBy(n => ActionRank(reader.KindOf(n))), n => Action(n, "")),
            Section("timers", "timers", top.Where(n => reader.KindOf(n) == "Timer"), Timer),
            Section("integrations", "REST and SOAP, consumed and exposed", Sorted(all.Where(IsIntegration)), Integration),
            UiSection(top.Where(IsFlow))
        };
        // Top-level kinds named, never rendered (folders, themes, resources): after the sections, so a folder that holds
        // rendered elements never hides them.
        foreach (var node in top) if (Unrendered.TryGetValue(reader.KindOf(node), out var reason)) Fold(node, reason);
        sections.Add(Coverage());
        return sections;
    }

    // Callers by key: an action of this module is called by every rendered flow whose Execute node targets it.
    public IReadOnlyList<DigestAction> ActionIndex()
    {
        var callers = new Dictionary<string, SortedSet<string>>(StringComparer.Ordinal);
        foreach (var action in actions)
            foreach (var callee in action.Calls) {
                var key = reader.KeyOf(callee);
                if (!callers.TryGetValue(key, out var set)) callers[key] = set = new(StringComparer.Ordinal);
                set.Add(action.Name);
            }
        return actions.Select(a => new DigestAction(reader.KeyOf(a.Node), reader.KindOf(a.Node), a.Name, a.Section, a.Folder,
            Flag(a.Node, "Public"), Flag(a.Node, "Function"), a.Inputs, a.Outputs,
            a.Calls.Select(Callee).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList(),
            callers.TryGetValue(reader.KeyOf(a.Node), out var by) ? by.ToList() : [])).ToList();
    }

    // ---- sections --------------------------------------------------------------------------------------------------

    private DigestSection ModuleSection(List<T> top)
    {
        var head = new StringBuilder();
        head.Append(ModuleDigest.Schema).Append(" module=").Append(reader.DisplayOf(root)).Append(" type=").Append(ModuleType)
            .Append(" lane=").Append(lane).Append(" key=@").Append(reader.KeyOf(root)).Append(" sourceSha256=").Append(sourceSha256)
            .Append(" sourceBytes=").Append(sourceBytes).Append(" elements=").Append(all.Count).Append('\n');
        if (Description(root) is { } description) head.Append(description).Append('\n');
        head.Append("legend: each block starts with the element and its @key (inspect path \"@<key>\" with this sourceSha256). ")
            .Append("'name: Type'; '?' optional input; req mandatory; auto autonumber; '->Entity delete=Rule' foreign key. ")
            .Append("Flows follow the connectors from Start; '[n]' marks a step that is reached again by '-> [n]'. Branches never fall through: ")
            .Append("an indented if block ends in end, raise, navigate, '-> [n]' or next (loop), and the false branch continues below it at the same level. ")
            .Append("A bare call argument passes the variable of the same name. ")
            .Append("Descriptions only on top-level elements; '…(+N)' marks N characters left out ('…(+N @key)': inspect that @key with full:true for the whole text); ")
            .Append("the coverage section counts every element.");
        var blocks = new List<string> { head.ToString() };
        var entries = new List<DigestEntry> { new(reader.KeyOf(root), reader.KindOf(root), reader.DisplayOf(root)) };
        var references = top.Where(n => reader.KindOf(n) == "Reference").ToList();
        foreach (var reference in references) { blocks.Add(Reference(reference)); entries.Add(Entry(reference)); }
        return new DigestSection("module", "module and references", references.Count, blocks, entries);
    }

    private string Reference(T reference)
    {
        covered.Add(reference);
        var groups = new SortedDictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var signature in reader.ChildrenOf(reference)) {
            Fold(signature, "reference signatures");
            var kind = reader.KindOf(signature);
            if (kind.EndsWith("Signature", StringComparison.Ordinal)) kind = kind[..^"Signature".Length];
            if (!groups.TryGetValue(kind, out var names)) groups[kind] = names = [];
            names.Add(reader.DisplayOf(signature));
        }
        var line = new StringBuilder("reference ").Append(reader.DisplayOf(reference)).Append(Key(reference));
        if ((S(reference, "ModuleType") ?? S(reference, "ESpaceType")) is { } type) line.Append(" (").Append(type).Append(')');
        foreach (var (kind, names) in groups)
            line.Append("\n  ").Append(kind).Append(": ").Append(string.Join(", ", names.Order(StringComparer.Ordinal)));
        return line.ToString();
    }

    private string Entity(T entity)
    {
        covered.Add(entity);
        var kind = reader.KindOf(entity);
        var isStatic = kind == "StaticEntity" || Flag(entity, "IsStaticEntity");
        var text = new StringBuilder(isStatic ? "static entity " : "entity ").Append(reader.DisplayOf(entity)).Append(Key(entity));
        Flags(text, entity, ("Public", "public"), ("ExposeReadOnly", "read-only"));
        if (S(entity, "IsMultiTenant") is "True" or "Yes") text.Append(" multi-tenant");
        if (!isStatic && kind != "ServerEntity" && kind != "Entity") text.Append(" (").Append(kind).Append(')');
        AppendDescription(text, entity);
        var records = new List<T>(); var events = new List<string>();
        bool IsAttribute(T child) => reader.KindOf(child) == "EntityAttribute" || reader.IsKind(child, "EntityAttribute") && !reader.KindOf(child).EndsWith("Signature", StringComparison.Ordinal);
        foreach (var attribute in Listed(entity, "Attributes", IsAttribute)) text.Append("\n  ").Append(Attribute(attribute));
        foreach (var child in reader.ChildrenOf(entity)) {
            var childKind = reader.KindOf(child);
            if (IsAttribute(child)) continue;
            if (reader.IsKind(child, "Record")) {
                if (isStatic) records.Add(child); else Fold(child, "sample records");
            } else if (childKind == "EntityActionSignature") Fold(child, "generated actions");
            else if (childKind == "IdentifierType") Fold(child, "built-in and derived types");
            else if (childKind == "EntityVersion") Fold(child, "entity version markers");
            else if (childKind.EndsWith("LifeCycleDatabaseEvent", StringComparison.Ordinal)) {
                // ODC entity events: rendered when they call something, folded when empty.
                var handler = S(child, "Destination") ?? S(child, "Handler");
                if (handler == null) { Fold(child, "empty entity events"); continue; }
                covered.Add(child);
                var arguments = Arguments(child);
                events.Add("on " + childKind[2..^"LifeCycleDatabaseEvent".Length] + " -> " + handler + (arguments.Length > 0 ? "(" + arguments + ")" : ""));
            }
        }
        foreach (var line in events.Order(StringComparer.Ordinal)) text.Append("\n  ").Append(line);
        var indexes = reader.Indexes(entity);
        if (indexes != null) {
            foreach (var child in reader.ChildrenOf(entity)) if (reader.KindOf(child) == "EntityIndex") CoverTree(child);
            // The Model API enumerates indexes in a different order on each load: ordered by name, the text is stable.
            foreach (var (name, unique, auto, attributes) in indexes.Where(i => !i.Auto).OrderBy(i => i.Name, StringComparer.Ordinal))
                text.Append("\n  index ").Append(name).Append(unique ? " unique" : "").Append(" (").Append(string.Join(", ", attributes)).Append(')');
            if (indexes.Count(i => i.Auto) is var generated and > 0) text.Append("\n  indexes generated by the platform: ").Append(generated);
        } else foreach (var index in Sorted(reader.ChildrenOf(entity).Where(c => reader.KindOf(c) == "EntityIndex"))) {
            CoverTree(index);
            if (Flag(index, "AutoGenerated")) continue;
            var columns = reader.ChildrenOf(index).Select(a => S(a, "Attribute") ?? "?");
            text.Append("\n  index ").Append(reader.DisplayOf(index)).Append(Flag(index, "Unique") ? " unique" : "").Append(" (").Append(string.Join(", ", columns)).Append(')');
        }
        // Records also come in a different order on each load: ordered by identifier. They are the block's last lines
        // (DigestEntry.Records): the overview page shows the first ones and says where the others are.
        foreach (var record in records.OrderBy(r => S(r, "Identifier") ?? reader.DisplayOf(r), StringComparer.Ordinal).ThenBy(reader.KeyOf, StringComparer.Ordinal)) {
            Cover(record);
            // Record values come in a different order on each load: ordered by attribute name, the text is stable.
            var values = reader.ChildrenOf(record).Select(v => { Cover(v); return (S(v, "Attribute") ?? "?") + "=" + Expr(v, "Value"); }).Order(StringComparer.Ordinal);
            text.Append("\n  record ").Append(OneLine(S(record, "Identifier") ?? reader.DisplayOf(record))).Append(": ").Append(string.Join(", ", values));
        }
        this.records = records.Count;
        return text.ToString();
    }

    private string Attribute(T attribute)
    {
        covered.Add(attribute);
        var text = new StringBuilder(reader.DisplayOf(attribute)).Append(": ").Append(TypeOf(attribute));
        if (Flag(attribute, "IsMandatory")) text.Append(" req");
        if (S(attribute, "IsAutoNumber") is "Yes" or "True") text.Append(" auto");
        else if (Ref(attribute, "DataType") is { } type && reader.KindOf(type) == "IdentifierType") {
            text.Append(" ->").Append(S(type, "Entity") ?? reader.DisplayOf(type));
            if (S(attribute, "DeleteRule") is { } rule) text.Append(" delete=").Append(rule);
        }
        if (Expr(attribute, "DefaultValue") is { Length: > 0 } value) text.Append(" =").Append(value);
        return text.ToString();
    }

    private string Structure(T structure)
    {
        covered.Add(structure);
        var text = new StringBuilder("structure ").Append(reader.DisplayOf(structure)).Append(Key(structure));
        Flags(text, structure, ("Public", "public"));
        AppendDescription(text, structure);
        var attributes = Listed(structure, "Attributes", c => reader.KindOf(c).EndsWith("Attribute", StringComparison.Ordinal)).Select(Attribute).ToList();
        if (attributes.Count > 0) text.Append("\n  ").Append(string.Join("; ", attributes));
        return text.ToString();
    }

    private bool IsVariable(T node) => reader.KindOf(node) is "SiteProperty" or "ClientVariable" or "SessionVariable";

    private string Variable(T variable)
    {
        covered.Add(variable);
        var label = reader.KindOf(variable) switch { "SiteProperty" => "site property ", "ClientVariable" => "client variable ", _ => "session variable " };
        var text = new StringBuilder(label).Append(reader.DisplayOf(variable)).Append(Key(variable)).Append(": ").Append(TypeOf(variable));
        if (Expr(variable, "DefaultValue") is { Length: > 0 } value) text.Append(" =").Append(value);
        Flags(text, variable, ("IsReadOnly", "read-only"), ("IsSecret", "secret"));
        AppendDescription(text, variable);
        return text.ToString();
    }

    private string Role(T role)
    {
        covered.Add(role);
        var text = new StringBuilder("role ").Append(reader.DisplayOf(role)).Append(Key(role));
        Flags(text, role, ("Public", "public"), ("IsPersistent", "persistent"));
        AppendDescription(text, role);
        foreach (var child in reader.ChildrenOf(role)) Fold(child, "generated actions");
        return text.ToString();
    }

    private string Exception(T exception)
    {
        covered.Add(exception);
        var text = new StringBuilder("exception ").Append(reader.DisplayOf(exception)).Append(Key(exception));
        Flags(text, exception, ("Public", "public"));
        AppendDescription(text, exception);
        return text.ToString();
    }

    private string Timer(T timer)
    {
        covered.Add(timer);
        var text = new StringBuilder("timer ").Append(reader.DisplayOf(timer)).Append(Key(timer))
            .Append(" action=").Append(S(timer, "Action") ?? "?");
        if (S(timer, "Schedule") is { Length: > 0 } schedule) text.Append(" schedule=\"").Append(schedule).Append('"');
        if (S(timer, "Priority") is { } priority) text.Append(" priority=").Append(priority);
        if (S(timer, "TimeoutInMinutes") is { } timeout) text.Append(" timeout=").Append(timeout).Append("min");
        AppendDescription(text, timer);
        foreach (var child in reader.ChildrenOf(timer)) {
            if (reader.KindOf(child) == "Argument") Cover(child); else Fold(child, "generated actions");
        }
        if (Arguments(timer) is { Length: > 0 } arguments) text.Append("\n  arguments ").Append(arguments);
        return text.ToString();
    }

    private bool IsIntegration(T node) =>
        !ReferenceEquals(node, root) && !folded.ContainsKey(node) && Integrations.Any(k => reader.KindOf(node) == k || reader.IsKind(node, k));

    private string Integration(T service)
    {
        var outer = scope;
        scope = reader.DisplayOf(service);
        try { return IntegrationText(service); } finally { scope = outer; }
    }

    private string IntegrationText(T service)
    {
        covered.Add(service);
        var kind = reader.KindOf(service);
        var text = new StringBuilder(kind switch {
            "RestClient" => "rest consumed ", "RestService" => "rest exposed ", _ when kind.Contains("Client", StringComparison.Ordinal) || kind == "WebReference" => "soap consumed ",
            _ => "soap exposed " }).Append(reader.DisplayOf(service)).Append(Key(service));
        foreach (var property in new[] { "BaseURL", "URL", "Url", "EndpointURL" })
            if (S(service, property) is { Length: > 0 } url) { text.Append(' ').Append(property).Append('=').Append(url); break; }
        AppendDescription(text, service);
        foreach (var child in Sorted(reader.ChildrenOf(service))) {
            var childKind = reader.KindOf(child);
            if (reader.IsKind(child, "Action") || S(child, "HTTPMethod") != null || reader.ChildrenOf(child).Any(c => reader.KindOf(c) == "StartNode")) {
                var method = new StringBuilder();
                if (S(child, "HTTPMethod") is { } http) method.Append(http).Append(' ').Append(S(child, "URLPath") ?? "").Append(' ');
                text.Append("\n  ").Append(method).Append(Action(child, "  ").TrimStart());
            } else if (childKind.EndsWith("Structure", StringComparison.Ordinal)) text.Append("\n  ").Append(Structure(child));
            else if (childKind == "ExtendedProperty") { Cover(child); text.Append("\n  header ").Append(S(child, "Property") ?? reader.DisplayOf(child)).Append('=').Append(Expr(child, "Value")); }
        }
        // Signatures the platform derives from the service definition (REST callback structures and parameters).
        foreach (var node in reader.Walk(service).ToList())
            if (!covered.Contains(node) && reader.KindOf(node).EndsWith("Signature", StringComparison.Ordinal)) Fold(node, "generated REST signatures");
        return text.ToString();
    }

    private bool IsFlow(T node) => reader.IsKind(node, "UIFlow") || reader.KindOf(node) is "MobileFlow" or "WebFlow" or "UIFlow";

    // One block per screen, block, email, flow action or external site; the flow itself only when it has comments.
    private DigestSection UiSection(IEnumerable<T> flows)
    {
        sectionId = "ui";
        var blocks = new List<string>(); var entries = new List<DigestEntry>();
        foreach (var (node, text) in flows.SelectMany(Flow)) { blocks.Add(text); entries.Add(Entry(node)); }
        return new DigestSection("ui", "screens, blocks and emails", blocks.Count, blocks, entries);
    }

    private IEnumerable<(T Node, string Text)> Flow(T flow)
    {
        covered.Add(flow);
        var flowName = reader.DisplayOf(flow);
        var comments = reader.ChildrenOf(flow).Where(c => reader.KindOf(c) == "CommentNode").Select(Comment).ToList();
        if (comments.Count > 0) yield return (flow, "flow " + flowName + Key(flow) + "\n" + string.Join("\n", comments.Select(c => "  " + c)));
        foreach (var node in Sorted(reader.ChildrenOf(flow))) {
            var kind = reader.KindOf(node);
            if (kind == "CommentNode") continue;
            if (reader.IsKind(node, "MobileScreen") || reader.IsKind(node, "WebScreen") || reader.IsKind(node, "MobileBlock") || reader.IsKind(node, "WebBlock") || kind is "MobileEmail" or "WebEmail" or "Email")
                yield return (node, Screen(node, flowName));
            else if (reader.IsKind(node, "Action") || kind == "OnExceptionAction" || reader.ChildrenOf(node).Any(c => IsNodeKind(reader.KindOf(c)))) {
                scope = flowName;
                var text = flowName + "/" + Action(node, "");
                scope = "";
                yield return (node, text);
            } else if (kind == "ExternalSite") {
                covered.Add(node);
                foreach (var parameter in reader.ChildrenOf(node)) Cover(parameter);
                yield return (node, "external site " + flowName + "/" + reader.DisplayOf(node) + Key(node));
            }
        }
    }

    private string Screen(T screen, string flowName)
    {
        var outer = scope;
        scope = flowName + "/" + reader.DisplayOf(screen);
        try { return ScreenText(screen, flowName); } finally { scope = outer; }
    }

    private string ScreenText(T screen, string flowName)
    {
        covered.Add(screen);
        var kind = reader.KindOf(screen);
        var label = reader.IsKind(screen, "MobileBlock") || reader.IsKind(screen, "WebBlock") ? "block " : kind.Contains("Email", StringComparison.Ordinal) ? "email " : "screen ";
        var text = new StringBuilder(label).Append(flowName).Append('/').Append(reader.DisplayOf(screen)).Append(Key(screen));
        Flags(text, screen, ("Public", "public"), ("AnonymousAccess", "anonymous"));
        if (Raw(screen, "Roles") is System.Collections.IEnumerable roles and not string) {
            // A set: the Model API gives it in a different order on each load.
            var names = roles.OfType<T>().Select(reader.DisplayOf).Order(StringComparer.Ordinal).ToList();
            if (names.Count > 0) text.Append(" roles=").Append(string.Join(",", names));
        }
        if (Expr(screen, "Title") is { Length: > 0 } title) text.Append(" title=").Append(title);
        if (Expr(screen, "Subject") is { Length: > 0 } subject) text.Append(" subject=").Append(subject);
        AppendDescription(text, screen);
        Signature(text, screen, "  ");
        foreach (var property in Lifecycle)
            if (Ref(screen, property) is { } handler) {
                Cover(handler);
                var arguments = Arguments(handler);
                if (S(handler, "Destination") is { } destination) text.Append("\n  on ").Append(property[2..]).Append(" -> ").Append(destination).Append(arguments.Length > 0 ? "(" + arguments + ")" : "");
            }
        var children = reader.ChildrenOf(screen).ToList();
        foreach (var child in Sorted(children.Where(c => reader.KindOf(c) == "BlockEvent"))) {
            covered.Add(child);
            var parameters = Listed(child, "InputParameters", _ => true).Select(p => { Cover(p); return reader.DisplayOf(p) + ": " + TypeOf(p); });
            text.Append("\n  event ").Append(reader.DisplayOf(child)).Append('(').Append(string.Join("; ", parameters)).Append(')')
                .Append(Flag(child, "IsMandatory") ? " req" : "");
        }
        foreach (var aggregate in Sorted(children.Where(c => reader.IsKind(c, "Aggregate")))) {
            covered.Add(aggregate);
            text.Append("\n  aggregate ").Append(reader.DisplayOf(aggregate)).Append(Key(aggregate));
            if (S(aggregate, "Fetch") is { } fetch) text.Append(" fetch=").Append(fetch);
            text.Append(" = ").Append(Query(aggregate));
        }
        foreach (var action in Sorted(children.Where(c => reader.IsKind(c, "Action") || reader.KindOf(c) is "Preparation" or "DataAction")))
            text.Append("\n  ").Append(Action(action, "  "));
        var widgets = new List<string>(); var named = collapsedNames = [];
        foreach (var child in children.Where(c => reader.IsKind(c, "Widget"))) Widget(child, 2, widgets);
        collapsedNames = null;
        if (widgets.Count > 0) text.Append("\n  widgets:\n").Append(string.Join("\n", widgets));
        // G13: the named widgets the tree above collapses, in tree order, a few per line.
        if (named.Count > 0) text.Append("\n  named containers:").Append(string.Concat(named.Chunk(8).Select(c => "\n    " + string.Join(", ", c))));
        foreach (var child in children.Where(c => reader.KindOf(c) == "UILifeCycleEvent")) Cover(child);
        return text.ToString();
    }

    private DigestSection Coverage()
    {
        var rendered = 0; var values = 0; var notRendered = new SortedDictionary<string, int>(StringComparer.Ordinal);
        var foldedBy = new SortedDictionary<string, int>(StringComparer.Ordinal);
        var within = new Dictionary<T, bool>(ReferenceEqualityComparer.Instance);
        bool UnderCovered(T node) {
            if (within.TryGetValue(node, out var known)) return known;
            var result = parentOf.TryGetValue(node, out var parent) && (covered.Contains(parent) || folded.ContainsKey(parent) || UnderCovered(parent));
            within[node] = result;
            return result;
        }
        foreach (var node in all) {
            if (covered.Contains(node)) { rendered++; continue; }
            if (folded.TryGetValue(node, out var reason)) { foldedBy[reason] = foldedBy.GetValueOrDefault(reason) + 1; continue; }
            var kind = reader.KindOf(node);
            if (ValueKinds.Contains(kind) && !reader.IsKind(node, "Widget") && UnderCovered(node)) { values++; continue; }
            notRendered[kind] = notRendered.GetValueOrDefault(kind) + 1;
        }
        NotRenderedCount = notRendered.Values.Sum();
        var text = new StringBuilder("elements ").Append(all.Count).Append(": rendered ").Append(rendered).Append(", values ").Append(values)
            .Append(" (expressions and connectors shown through their owner), folded ").Append(foldedBy.Values.Sum());
        if (foldedBy.Count > 0) text.Append(" (").Append(string.Join(", ", foldedBy.Select(f => f.Key + " " + f.Value))).Append(')');
        text.Append(", not rendered ").Append(NotRenderedCount);
        if (notRendered.Count > 0) text.Append(": ").Append(string.Join(", ", notRendered.OrderByDescending(n => n.Value).ThenBy(n => n.Key, StringComparer.Ordinal)
            .Select(n => n.Key + ":" + n.Value)));
        text.Append("\nclipped texts ").Append(Clips).Append("; property read errors ").Append(ReadErrors);
        if (readErrors.Count > 0) text.Append(" (").Append(string.Join(", ", readErrors.Select(e => e.Key + ":" + e.Value))).Append(", read as empty)");
        text
            .Append(". Not rendered and folded elements are read with inspect (by kind or @key).");
        return new DigestSection("coverage", "coverage", all.Count, [text.ToString()], [new(reader.KeyOf(root), reader.KindOf(root), "coverage")]);
    }

    // ---- actions and flows -----------------------------------------------------------------------------------------

    private static int ActionRank(string kind) => kind switch { "ServiceAction" => 0, "ServerAction" => 1, "ClientAction" => 2, _ => 3 };

    private string ActionLabel(T action) => reader.KindOf(action) switch {
        "ServerAction" => "server action ", "ServiceAction" => "service action ", "ClientAction" => "client action ",
        "ScreenAction" => "action ", "DataAction" => "data action ", "Preparation" => "preparation ",
        "OnExceptionAction" => "on exception ", var kind => Words(kind) + " " };

    // Signature and pseudocode of an action (or anything with a flow); indent is the block's own indentation.
    private string Action(T action, string indent)
    {
        covered.Add(action);
        var info = new ActionInfo(action, (scope.Length > 0 ? scope + "/" : "") + reader.DisplayOf(action), sectionId, FolderOf(action));
        actions.Add(info); owners.Push(info);
        try {
            var text = new StringBuilder(ActionLabel(action)).Append(reader.DisplayOf(action)).Append(Key(action));
            Flags(text, action, ("Public", "public"), ("Function", "function"));
            if (S(action, "Fetch") is { } fetch) text.Append(" fetch=").Append(fetch);
            if (indent.Length == 0) AppendDescription(text, action);
            (info.Inputs, info.Outputs) = Signature(text, action, indent + "  ");
            // Events of the action itself (a data action's OnAfterFetch): the handler it calls, as a screen's lifecycle.
            foreach (var property in Lifecycle)
                if (Ref(action, property) is { } handler && reader.KindOf(handler) == "UILifeCycleEvent") {
                    Cover(handler);
                    var arguments = Arguments(handler);
                    if (S(handler, "Destination") is { } destination)
                        text.Append('\n').Append(indent).Append("  on ").Append(property[2..]).Append(" -> ").Append(destination).Append(arguments.Length > 0 ? "(" + arguments + ")" : "");
                }
            foreach (var child in reader.ChildrenOf(action).Where(c => reader.KindOf(c) == "UILifeCycleEvent")) { Cover(child); Arguments(child); }
            foreach (var line in FlowLines(action)) text.Append('\n').Append(indent).Append("  ").Append(line);
            var result = text.ToString();
            ActionTexts[reader.KeyOf(action)] = indent.Length == 0 ? result : result.Replace("\n" + indent, "\n");
            return result;
        } finally { owners.Pop(); }
    }

    // Writes the in/out/local lines and answers the inputs and outputs as the action index shows them.
    private (string Inputs, string Outputs) Signature(StringBuilder text, T owner, string indent)
    {
        bool IsInput(T child) { var kind = reader.KindOf(child);
            return kind is "InputParameter" or "RestActionInput" or "RestServiceActionInput" || kind.EndsWith("InputParameter", StringComparison.Ordinal) && !kind.StartsWith("SQL", StringComparison.Ordinal); }
        var inputs = Listed(owner, "InputParameters", IsInput).Select(child => {
            covered.Add(child);
            var place = S(child, "InputPlacement") is { } placement ? " " + placement.Replace("Placement", "").ToLowerInvariant() : "";
            return reader.DisplayOf(child) + (S(child, "IsMandatory") == "False" ? "?" : "") + ": " + TypeOf(child) + place;
        }).ToList();
        var outputs = Listed(owner, "OutputParameters", c => reader.KindOf(c) is "OutputParameter" or "RestActionOutput" or "RestServiceActionOutput")
            .Select(child => { covered.Add(child); return reader.DisplayOf(child) + ": " + TypeOf(child); }).ToList();
        var locals = Listed(owner, "LocalVariables", c => reader.KindOf(c) == "LocalVariable").Select(child => {
            covered.Add(child);
            var value = Expr(child, "DefaultValue");
            return reader.DisplayOf(child) + ": " + TypeOf(child) + (value is { Length: > 0 } ? " =" + value : "");
        }).ToList();
        if (inputs.Count > 0) text.Append('\n').Append(indent).Append("in ").Append(string.Join("; ", inputs));
        if (outputs.Count > 0) text.Append('\n').Append(indent).Append("out ").Append(string.Join("; ", outputs));
        if (locals.Count > 0) text.Append('\n').Append(indent).Append("local ").Append(string.Join("; ", locals));
        return (string.Join("; ", inputs), string.Join("; ", outputs));
    }

    private static bool IsNodeKind(string kind) => kind.EndsWith("Node", StringComparison.Ordinal);

    // Pseudocode from the Start node, then the exception handlers, then the nodes no connector reaches. Rendered twice:
    // the first pass finds the steps reached again, which the second pass labels.
    private List<string> FlowLines(T owner)
    {
        var nodes = reader.ChildrenOf(owner).Where(n => IsNodeKind(reader.KindOf(n))).ToList();
        var lines = new List<string>();
        lines.AddRange(nodes.Where(n => reader.KindOf(n) == "CommentNode").Select(Comment).Order(StringComparer.Ordinal));
        if (nodes.All(n => reader.KindOf(n) == "CommentNode")) return lines;
        var jumped = new HashSet<T>(ReferenceEqualityComparer.Instance);
        new FlowPass(this, nodes, jumped, null).Run();
        var labels = new Dictionary<T, int>(ReferenceEqualityComparer.Instance);
        var pass = new FlowPass(this, nodes, jumped, labels);
        pass.Run();
        lines.AddRange(pass.Lines);
        var unreached = Sorted(nodes.Where(n => !pass.Visited.Contains(n) && reader.KindOf(n) is not ("CommentNode" or "StartNode" or "ExceptionHandlerNode"))).ToList();
        foreach (var node in unreached) Cover(node);
        if (unreached.Count > 0) lines.Add("unreached: " + string.Join("; ", unreached.Select(n => reader.KindOf(n) + " " + reader.DisplayOf(n) + Key(n) + Unreached(n))));
        return lines;
    }

    // What an unreached step would do, so its arguments and expressions are read too: " {step}".
    private string Unreached(T node)
    {
        var text = reader.KindOf(node) switch {
            "IfNode" => "if " + Expr(node, "Condition"), "ForEachNode" => "foreach " + Expr(node, "RecordList"),
            "RaiseExceptionNode" => "raise " + (S(node, "Exception") ?? "?") + "(" + Expr(node, "ExceptionMessage") + ")",
            "SwitchNode" or "EndNode" => "",
            _ => string.Join(" | ", Step(node))
        };
        return text.Length > 0 ? " {" + text + "}" : "";
    }

    private sealed class FlowPass(DigestWriter<T> w, List<T> nodes, HashSet<T> jumped, Dictionary<T, int>? labels)
    {
        public readonly List<string> Lines = [];
        public readonly HashSet<T> Visited = new(ReferenceEqualityComparer.Instance);
        private readonly HashSet<T> members = new(nodes, ReferenceEqualityComparer.Instance);

        public void Run()
        {
            foreach (var start in nodes.Where(n => w.R.KindOf(n) == "StartNode")) Steps(start, 0, null);
            foreach (var handler in w.Sorted(nodes.Where(n => w.R.KindOf(n) == "ExceptionHandlerNode"))) {
                w.covered.Add(handler); Visited.Add(handler);
                var flags = (w.Flag(handler, "AbortTransaction") ? " abort" : "") + (w.Flag(handler, "LogError") ? " log" : "");
                Line(0, "on exception " + (w.S(handler, "Exception") ?? "?") + flags + ":");
                Steps(w.Ref(handler, "Target"), 1, null);
            }
        }

        private void Line(int depth, string text) => Lines.Add(new string(' ', depth * 2) + text);

        private string Prefix(T node)
        {
            if (labels == null || !jumped.Contains(node)) return "";
            if (!labels.TryGetValue(node, out var label)) labels[node] = label = labels.Count + 1;
            return "[" + label + "] ";
        }

        // Branches never fall through: each one runs to end, raise, a jump or the next iteration, so the false branch of
        // an if continues at the if's own depth. stopDepth is the depth of the loop body that stop closes.
        private void Steps(T? node, int depth, T? stop, int stopDepth = -1)
        {
            while (node != null) {
                if (ReferenceEquals(node, stop)) { if (depth > stopDepth) Line(depth, "next"); return; }
                var kind = w.R.KindOf(node);
                if (!members.Contains(node)) { Line(depth, "-> " + kind + " " + w.R.DisplayOf(node) + w.Key(node)); return; }
                if (kind == "EndNode") { Visited.Add(node); w.covered.Add(node); if (depth > 0) Line(depth, "end"); return; }
                if (!Visited.Add(node)) {
                    jumped.Add(node);
                    Line(depth, labels != null && labels.TryGetValue(node, out var label) ? "-> [" + label + "]" : "-> [?]");
                    return;
                }
                w.covered.Add(node);
                var prefix = Prefix(node) + (w.Flag(node, "IsDisabled") ? "(disabled) " : "");
                switch (kind) {
                    case "StartNode": node = w.Ref(node, "Target"); continue;
                    case "IfNode":
                        Line(depth, prefix + "if " + w.Expr(node, "Condition") + ":" + w.LabelNote(node));
                        if (w.Ref(node, "TrueTarget") is { } whenTrue) Steps(whenTrue, depth + 1, stop, stopDepth); else Line(depth + 1, "-> (no connector)");
                        node = w.Ref(node, "FalseTarget");
                        if (node == null) Line(depth, "-> (no connector)");
                        continue;
                    case "SwitchNode":
                        Line(depth, prefix + "switch:" + w.LabelNote(node));
                        foreach (var condition in w.Listed(node, "Conditions", c => w.R.KindOf(c) == "SwitchCondition")) {
                            w.covered.Add(condition);
                            Line(depth + 1, "case " + w.Expr(condition, "Value") + ":");
                            Steps(w.Ref(condition, "Target"), depth + 2, stop, stopDepth);
                        }
                        Line(depth + 1, "otherwise:");
                        Steps(w.Ref(node, "OtherwiseTarget"), depth + 2, stop, stopDepth);
                        return;
                    case "ForEachNode":
                        var maximum = w.Expr(node, "MaximumIterations");
                        Line(depth, prefix + "foreach " + w.Expr(node, "RecordList") + (maximum is { Length: > 0 } ? " max " + maximum : "") + ":" + w.LabelNote(node));
                        Steps(w.Ref(node, "CycleTarget"), depth + 1, node, depth + 1);
                        node = w.Ref(node, "Target");
                        continue;
                    case "RaiseExceptionNode":
                        Line(depth, prefix + "raise " + (w.S(node, "Exception") ?? "?") + "(" + w.Expr(node, "ExceptionMessage") + ")");
                        return;
                    default:
                        var lines = w.Step(node);
                        for (var i = 0; i < lines.Count; i++) Line(depth, (i == 0 ? prefix : "") + lines[i]);
                        // A node without a Target property ends the flow by design (navigate); an empty Target is a gap.
                        var next = w.Ref(node, "Target");
                        if (next == null && w.R.PropertyOf(node, "Target") != null) Line(depth, "-> (no connector)");
                        node = next;
                        continue;
                }
            }
        }
    }

    private string LabelNote(T node) => S(node, "Label") is { Length: > 0 } label ? "  # " + OneLine(label) : "";

    // One flow step that continues to its Target; a SQL statement follows on its own lines, each marked '| '.
    private List<string> Step(T node)
    {
        var kind = reader.KindOf(node);
        var name = reader.NameOf(node);
        var assigned = name.Length > 0 ? name + " = " : "";
        switch (kind) {
            case "AssignNode": {
                var lines = new List<string>();
                foreach (var assignment in Listed(node, "Assignments", c => reader.KindOf(c) == "Assignment")) {
                    covered.Add(assignment);
                    lines.Add(Expr(assignment, "Variable") + " = " + Expr(assignment, "Value"));
                }
                if (lines.Count == 0) lines.Add("assign (empty)");
                lines[0] += LabelNote(node);
                return lines;
            }
            case "AggregateNode": return [assigned + "aggregate " + Query(node)];
            case "SQLNode": {
                var text = new StringBuilder(assigned).Append("sql(").Append(Arguments(node)).Append(')');
                var outputs = reader.ChildrenOf(node).Where(c => reader.KindOf(c) == "SQLOutput").Select(o => { Cover(o); return S(o, "EntityOrStructure") ?? "?"; }).ToList();
                foreach (var parameter in reader.ChildrenOf(node).Where(c => reader.KindOf(c) == "SQLInputParameter")) {
                    covered.Add(parameter);
                    if (Flag(parameter, "ExpandInline")) text.Append(" inline:").Append(reader.DisplayOf(parameter));
                }
                if (outputs.Count > 0) text.Append(" -> ").Append(string.Join(", ", outputs));
                if (S(node, "MaxRecords") is { Length: > 0 } max) text.Append(" max ").Append(max);
                var lines = new List<string> { text.ToString() };
                var statement = (S(node, "Statement") ?? "").Replace("\r\n", "\n").TrimEnd();
                lines.AddRange(statement.Split('\n').Select(l => "| " + l.TrimEnd()));
                return lines;
            }
            case "JSONSerializeNode": return [assigned + "JSONSerialize(" + Expr(node, "Data") + ")"];
            case "JSONDeserializeNode": return [assigned + "JSONDeserialize(" + Expr(node, "JSONString") + ") as " + TypeOf(node)];
            case "JavaScriptNode": {
                foreach (var parameter in reader.ChildrenOf(node).Where(c => reader.KindOf(c) is "InputParameter" or "OutputParameter")) Cover(parameter);
                var outputs = reader.ChildrenOf(node).Where(c => reader.KindOf(c) == "OutputParameter").Select(reader.DisplayOf).ToList();
                var script = OneLine(S(node, "JavaScript") ?? S(node, "Script") ?? "");
                return [assigned + "javascript(" + Arguments(node) + ")" + (outputs.Count > 0 ? " -> " + string.Join(", ", outputs) : "") + ": " + Clip(script, ScriptMax, node)];
            }
            case "MessageNode": return ["message " + (S(node, "Type") ?? S(node, "MessageType") ?? "") + ": " + Expr(node, "Message")];
            case "DestinationNode": return ["navigate " + (S(node, "Destination") ?? "?") + "(" + Arguments(node) + ")"];
            case "RefreshDataNode": return ["refresh " + (S(node, "DataSource") ?? S(node, "DataSet") ?? S(node, "Aggregate") ?? S(node, "Source") ?? "?")];
            case "AjaxRefreshNode": return ["ajax refresh " + (S(node, "WidgetOrWebBlock") ?? S(node, "Widget") ?? "?")];
            case "TriggerNode": return ["trigger " + (S(node, "Event") ?? "?") + "(" + Arguments(node) + ")"];
            case "CommentNode": return [Comment(node)];
        }
        if (kind.StartsWith("Execute", StringComparison.Ordinal) && Ref(node, "Action") is { } action) {
            if (owners.TryPeek(out var owner)) owner.Calls.Add(action);
            return [assigned + Callee(action) + "(" + Arguments(node) + ")"];
        }
        return [Generic(node, assigned)];
    }

    private static readonly HashSet<string> GenericNoise = new(StringComparer.Ordinal) {
        "Target", "Connectors", "Name", "Label", "Arguments", "IsDisabled", "Object", "Owner", "OwnerESpace", "Parent",
        "PropertyOwner", "RealPropertyOwner", "AsFullAggregate", "AsDatabaseAggregate" };

    // Any other step: its kind and every expression or reference it holds, except connectors and owners.
    private string Generic(T node, string assigned)
    {
        var parts = new List<string>();
        foreach (var (property, read) in reader.PropertiesOf(node)) {
            if (GenericNoise.Contains(property) || parts.Count >= 12) continue;
            object? value;
            try { value = read(); } catch { continue; } // probing every property: a failure is not a read error
            if (value == null) continue;
            if (reader.ExpressionText(value) is { Length: > 0 } expression) parts.Add(property + "=" + Clip(OneLine(expression), ExpressionMax, node));
            else if (value is T reference && !ReferenceEquals(reference, node)) parts.Add(property + "=" + reader.DisplayOf(reference));
        }
        foreach (var child in reader.ChildrenOf(node).Where(c => reader.KindOf(c) == "Argument")) Cover(child);
        var arguments = Arguments(node);
        return assigned + Words(reader.KindOf(node)) + (arguments.Length > 0 ? "(" + arguments + ")" : "") + (parts.Count > 0 ? " " + string.Join(" ", parts) : "");
    }

    private string Callee(T action) =>
        parentOf.TryGetValue(action, out var owner) && reader.KindOf(owner) == "Reference" ? reader.DisplayOf(owner) + "." + reader.DisplayOf(action) : reader.DisplayOf(action);

    private string Arguments(T node)
    {
        var parts = new List<string>();
        foreach (var argument in reader.ChildrenOf(node).Where(c => reader.KindOf(c) == "Argument")) {
            covered.Add(argument);
            var value = Expr(argument, "Value");
            var parameter = S(argument, "Parameter") ?? "?";
            if (value.Length > 0) parts.Add(value == parameter ? parameter : parameter + "=" + value);
        }
        // Arguments are named and come in a different order on each load: ordered by parameter, the text is stable.
        return string.Join(", ", parts.Order(StringComparer.Ordinal));
    }

    // FROM/JOIN/WHERE/GROUP BY/AGG/CALC/SORT/MAX of an aggregate. Every operation below it is covered. Sources, joins,
    // filters, groups and columns are sets, and even the aggregate's own lists come in a different order on each load:
    // they are ordered by their text. Sorts keep the order of the aggregate's Sorts list (it decides the result).
    private string Query(T aggregate)
    {
        var found = new Dictionary<string, List<T>>(StringComparer.Ordinal);
        void Visit(T node) {
            foreach (var child in reader.ChildrenOf(node)) {
                covered.Add(child);
                var kind = reader.KindOf(child);
                if (!found.TryGetValue(kind, out var list)) found[kind] = list = [];
                list.Add(child);
                Visit(child);
            }
        }
        Visit(aggregate);
        List<string> Part(string kind, string[] properties, Func<T, string> render, bool ordered = false)
        {
            foreach (var property in properties)
                if (ordered && Raw(aggregate, property) is System.Collections.IEnumerable items and not string) return items.OfType<T>().Select(render).ToList();
            return (found.GetValueOrDefault(kind) ?? []).Select(render).Order(StringComparer.Ordinal).ToList();
        }
        var sources = Part("AliasedSource", ["Sources"], child => {
            var entity = S(child, "Source") ?? "?"; var alias = reader.DisplayOf(child);
            return alias == entity ? entity : alias + "=" + entity; }).Distinct().ToList();
        var joins = Part("Join", ["Joins"], child => (S(child, "JoinType") ?? "") + " " + (S(child, "LeftSource") ?? "?") + "~" + (S(child, "RightSource") ?? "?") + " ON " + Expr(child, "Condition"));
        var filters = Part("Filter", ["Filters"], child => "(" + Expr(child, "Condition") + ")");
        var groups = Part("GroupByAttribute", ["GroupByAttributes"], child => Expr(child, "Attribute"));
        var aggregates = Part("AggregateAttribute", ["AggregateAttributes", "AggregatedAttributes"],
            child => reader.DisplayOf(child) + "=" + S(child, "AggregationType") + "(" + Expr(child, "Attribute") + ")");
        var calculated = Part("CalculatedAttribute", ["CalculatedAttributes"], child => reader.DisplayOf(child) + "=" + Expr(child, "Value"));
        var sorts = Part("Sort", ["Sorts"], child => (Expr(child, "Attribute") is { Length: > 0 } attribute ? attribute : "?")
            + (S(child, "SortDirection") == "Descending" ? " desc" : "") + (Flag(child, "IsDynamic") ? " dynamic" : ""), ordered: true);
        var text = new StringBuilder("FROM ").Append(string.Join(", ", sources));
        if (joins.Count > 0) text.Append(" JOIN ").Append(string.Join(" | ", joins));
        if (filters.Count > 0) text.Append(" WHERE ").Append(string.Join(" AND ", filters));
        if (groups.Count > 0) text.Append(" GROUP BY ").Append(string.Join(", ", groups));
        if (aggregates.Count > 0) text.Append(" AGG ").Append(string.Join(", ", aggregates));
        if (calculated.Count > 0) text.Append(" CALC ").Append(string.Join(", ", calculated));
        if (sorts.Count > 0) text.Append(" SORT ").Append(string.Join(", ", sorts));
        if (S(aggregate, "MaxRecords") is { Length: > 0 } max) text.Append(" MAX ").Append(max);
        return text.ToString();
    }

    private string Comment(T comment)
    {
        covered.Add(comment);
        return "// " + Clip(OneLine(S(comment, "Text") ?? ""), DescriptionMax);
    }

    // ---- widgets -----------------------------------------------------------------------------------------------------

    private static string Base(string kind) => kind.Length > "Widget".Length && kind.EndsWith("Widget", StringComparison.Ordinal) ? kind[..^"Widget".Length] : kind;

    // G13 (FarmaVirtual 10/10/2026): every named widget's @key is in the digest. After a merge the digest named the widgets
    // without keys, and the named containers the job had mounted not at all, so ten ssam_map {name} calls followed
    // (120-128, 132). A widget with a line carries its key there: Named " Name @key" after the kind word, NameNote
    // "  # Name @key" at the end of a line whose text is not the name (if, button, link, label, text). A named widget the
    // tree collapses (a container, a placeholder, an html element) keeps the tree as it was and goes to the "named
    // containers" lines of its screen or block (collapsedNames): a line of its own and the indentation of its children were
    // 56% of the 27.9% the digest of that capture grew by. A named image or icon is never folded as decoration. What a line
    // folds in carries its key on that line, after "inside": the named widgets within a button, link, label, image, icon or
    // hN (CoverTree draws none of them: 24 of the 776 named widgets of that capture, IfFv41 in a button, Icon4 in a link)
    // and the empty placeholders of a block instance (in the screen's list, two instances of one block read alike).
    private string Named(T widget, string name) => name.Length > 0 ? " " + name + Key(widget) : "";
    private string NameNote(T widget, string name) => name.Length > 0 ? "  # " + name + Key(widget) : "";
    private List<string>? collapsedNames;
    private void Collapsed(T widget, string name) { if (name.Length > 0) collapsedNames?.Add(name + Key(widget)); }
    // noted: the line already ends with a "  # Name @key" note.
    private static string Inside(List<string> items, bool noted) => items.Count == 0 ? "" : (noted ? ";" : "  #") + " inside " + string.Join(", ", items);
    private List<string> NamedWithin(T widget) =>
        reader.Walk(widget).Skip(1).Where(d => reader.IsKind(d, "Widget") && reader.NameOf(d).Length > 0).Select(d => reader.NameOf(d) + Key(d)).ToList();

    private void Widget(T widget, int depth, List<string> lines)
    {
        covered.Add(widget);
        var pad = new string(' ', depth * 2);
        var kind = reader.KindOf(widget);
        var basic = Base(kind);
        var name = reader.NameOf(widget);
        var events = Events(widget);
        var visible = Text(Raw(widget, "Visible", quiet: true)) is { Length: > 0 } v && v != "True" ? " visible=(" + Clip(OneLine(v), ExpressionMax, widget) + ")" : "";
        void Children(int at) { foreach (var child in reader.ChildrenOf(widget)) Member(child, at, lines); }
        if (reader.IsKind(widget, "IfWidget") || basic == "If") {
            lines.Add(pad + "if " + Expr(widget, "Condition") + ":" + NameNote(widget, name));
            var whenTrue = Ref(widget, "TrueBranch"); var whenFalse = Ref(widget, "FalseBranch");
            foreach (var branch in reader.ChildrenOf(widget).Where(c => reader.KindOf(c) == "IfBranchWidget")) covered.Add(branch);
            if (whenTrue != null) foreach (var child in reader.ChildrenOf(whenTrue)) Member(child, depth + 1, lines);
            if (whenFalse != null && reader.ChildrenOf(whenFalse).Any(c => reader.IsKind(c, "Widget"))) {
                lines.Add(pad + "else:");
                foreach (var child in reader.ChildrenOf(whenFalse)) Member(child, depth + 1, lines);
            } else if (whenFalse != null) foreach (var child in reader.ChildrenOf(whenFalse)) Member(child, depth + 1, lines);
            return;
        }
        if (kind.Contains("BlockInstance", StringComparison.Ordinal)) {
            // A placeholder of the block is where content mounts: its key on its own line, or on the line of its block
            // instance when it is empty.
            bool Empty(T placeholder) => !reader.ChildrenOf(placeholder).Any(c => reader.IsKind(c, "Widget"));
            var empty = reader.ChildrenOf(widget).Where(c => reader.KindOf(c) == "PlaceholderContentWidget" && Empty(c))
                .Select(c => "[" + reader.DisplayOf(c) + "]" + Key(c)).ToList();
            lines.Add(pad + "block " + (Ref(widget, "SourceBlock") is { } source ? Callee(source) : "?") + "(" + Arguments(widget) + ")" + events + visible
                + NameNote(widget, name) + Inside(empty, name.Length > 0));
            foreach (var child in reader.ChildrenOf(widget)) {
                if (reader.KindOf(child) == "PlaceholderContentWidget") {
                    covered.Add(child);
                    if (Empty(child)) {
                        foreach (var inner in reader.ChildrenOf(child)) Member(inner, depth + 1, lines);
                        continue;
                    }
                    lines.Add(pad + "  [" + reader.DisplayOf(child) + "]" + Key(child) + ":");
                    foreach (var inner in reader.ChildrenOf(child)) Member(inner, depth + 2, lines);
                } else Member(child, depth + 1, lines);
            }
            return;
        }
        if (reader.IsKind(widget, "List") || S(widget, "Source") is { Length: > 0 } && basic is "List" or "TableRecords" or "ListRecords" or "Table" or "Gallery") {
            lines.Add(pad + "list " + name + (name.Length > 0 ? Key(widget) : "") + " source=" + Expr(widget, "Source") + events + visible + ":");
            Children(depth + 1);
            return;
        }
        if (basic is "Popup" or "Form" or "EditRecord") {
            lines.Add(pad + basic.ToLowerInvariant() + Named(widget, name) + (basic == "Popup" ? " show=" + Expr(widget, "ShowPopup") : "") + events + visible + ":");
            Children(depth + 1);
            return;
        }
        if (S(widget, "Variable") is { Length: > 0 }) {
            var list = S(widget, "List") is { Length: > 0 } source ? " list=" + source : "";
            var mandatory = S(widget, "Mandatory") is { Length: > 0 } m && m != "False" ? " mandatory" + (m == "True" ? "" : "=(" + Expr(widget, "Mandatory") + ")") : "";
            lines.Add(pad + basic.ToLowerInvariant() + Named(widget, name) + " var=" + Expr(widget, "Variable") + list + mandatory + events + visible + Enabled(widget));
            Children(depth + 1);
            return;
        }
        if (reader.IsKind(widget, "Button") || reader.IsKind(widget, "Link") || basic is "Button" or "Link") {
            var label = Expr(widget, "Label") is { Length: > 0 } text ? text : "\"" + Clip(TextOf(widget), TextMax) + "\"";
            lines.Add(pad + basic.ToLowerInvariant() + " " + label + events + visible + Enabled(widget) + NameNote(widget, name) + Inside(NamedWithin(widget), name.Length > 0));
            CoverTree(widget);
            return;
        }
        switch (basic) {
            case "Text":
                if (S(widget, "Text") is { Length: > 0 } t) lines.Add(pad + "text \"" + Clip(OneLine(t), TextMax) + "\"" + visible + NameNote(widget, name));
                Children(depth);
                return;
            case "Expression" or "InlineExpression":
                // A literal (the ODC Studio writes a label or button text as an Expression widget) reads as text.
                lines.Add(pad + (Literal(Expr(widget, "Value")) is { } literal ? "text \"" + Clip(literal, TextMax) + "\"" : "expr " + Expr(widget, "Value")) + visible + NameNote(widget, name));
                Children(depth);
                return;
            case "Image" or "Icon":
                var within = NamedWithin(widget);
                if (events.Length == 0 && visible.Length == 0 && name.Length == 0 && within.Count == 0) { covered.Remove(widget); Fold(widget, "decoration (images, icons)"); return; }
                lines.Add(pad + basic.ToLowerInvariant() + Named(widget, name) + events + visible + Inside(within, false));
                CoverTree(widget);
                return;
            case "Label":
                lines.Add(pad + "label \"" + Clip(TextOf(widget), TextMax) + "\"" + visible + NameNote(widget, name) + Inside(NamedWithin(widget), name.Length > 0));
                CoverTree(widget);
                return;
        }
        if (basic == "AdvancedHtml" && S(widget, "Tag") is { } tag && tag.Length == 2 && tag[0] == 'h' && char.IsDigit(tag[1])) {
            lines.Add(pad + tag + " \"" + Clip(TextOf(widget), TextMax) + "\"" + visible + NameNote(widget, name) + Inside(NamedWithin(widget), name.Length > 0));
            CoverTree(widget);
            return;
        }
        var hasWidgets = reader.ChildrenOf(widget).Any(c => reader.IsKind(c, "Widget"));
        if (hasWidgets) {
            // Containers, placeholders and branches are collapsed: their children stay at the same depth unless the
            // container itself has a condition or an event.
            if (visible.Length > 0 || events.Length > 0) {
                lines.Add(pad + basic.ToLowerInvariant() + Named(widget, name) + events + visible + ":");
                Children(depth + 1);
            } else { Collapsed(widget, name); Children(depth); }
            return;
        }
        if (basic is "Container" or "Placeholder" or "Content" or "PlaceholderContent" or "IfBranch" or "MobileWidget" or "WebWidget" && events.Length == 0 && visible.Length == 0) {
            Collapsed(widget, name);
            Children(depth);
            return;
        }
        lines.Add(pad + basic.ToLowerInvariant() + Named(widget, name) + events + visible);
        Children(depth + 1);
    }

    // A child of a widget: another widget, or a part of it (event, style, argument, value).
    private void Member(T child, int depth, List<string> lines)
    {
        if (reader.IsKind(child, "Widget")) { Widget(child, depth, lines); return; }
        var kind = reader.KindOf(child);
        if (kind == "ExtendedProperty") Fold(child, "widget style and attributes");
        else if (HasHandler(child) || kind == "Argument") Cover(child);
    }

    private bool HasHandler(T node) => reader.PropertyOf(node, "Destination") != null || reader.PropertyOf(node, "Handler") != null
        || reader.IsKind(node, "Event") || reader.IsKind(node, "EventHandler");

    // Events of a widget: every child that names a destination or handler (OnClick, OnChange, block events, DOM events).
    private string Events(T widget)
    {
        var parts = new List<string>();
        foreach (var child in reader.ChildrenOf(widget)) {
            if (!HasHandler(child)) continue;
            covered.Add(child);
            // The parameters the platform gives the event (a table's OnSort ClickedColumn): part of the event, not the page.
            foreach (var parameter in reader.ChildrenOf(child).Where(c => reader.KindOf(c) == "InputParameter")) Cover(parameter);
            var destination = S(child, "Destination") ?? S(child, "Handler");
            if (destination == null) continue;
            var name = S(child, "Event") is { Length: > 0 } e ? e : reader.NameOf(child) is { Length: > 0 } n ? n : reader.KindOf(child);
            var arguments = Arguments(child);
            parts.Add(" on " + name + "->" + destination + (arguments.Length > 0 ? "(" + arguments + ")" : ""));
        }
        return string.Concat(parts.Order(StringComparer.Ordinal));
    }

    private string Enabled(T widget) => Text(Raw(widget, "Enabled", quiet: true)) is { Length: > 0 } e && e != "True" ? " enabled=(" + Clip(OneLine(e), ExpressionMax, widget) + ")" : "";

    // Visible text of a widget: its text widgets and expressions, in order.
    private string TextOf(T widget)
    {
        var parts = new List<string>();
        void Visit(T node) {
            foreach (var child in reader.ChildrenOf(node)) {
                if (!reader.IsKind(child, "Widget")) continue;
                var basic = Base(reader.KindOf(child));
                if (basic == "Text" && S(child, "Text") is { Length: > 0 } text) parts.Add(OneLine(text));
                else if (basic is "Expression" or "InlineExpression") parts.Add(Literal(Expr(child, "Value")) ?? "[" + Expr(child, "Value") + "]");
                Visit(child);
            }
        }
        Visit(widget);
        return string.Join(" ", parts);
    }

    // ---- helpers -----------------------------------------------------------------------------------------------------

    private DigestSection Section(string id, string title, IEnumerable<T> nodes, Func<T, string> render)
    {
        sectionId = id;
        var blocks = new List<string>(); var entries = new List<DigestEntry>();
        foreach (var node in nodes) {
            records = 0;
            blocks.Add(render(node));
            entries.Add(Entry(node, records));
        }
        return new DigestSection(id, title, blocks.Count, blocks, entries);
    }

    private DigestEntry Entry(T node, int recordLines = 0) => new(reader.KeyOf(node), reader.KindOf(node), reader.DisplayOf(node), FolderOf(node), recordLines);

    // The folder an action, structure or entity sits in (the Model API's Folder property), by name.
    private string? FolderOf(T node) => Text(Raw(node, "Folder", quiet: true)) is { Length: > 0 } folder ? OneLine(folder) : null;

    // Children in the order of the model's own list property (InputParameters, Assignments, Conditions, Attributes...);
    // the plain child enumeration of the Model API can differ between two loads of the same bytes. Without the property,
    // the children in name order.
    private List<T> Listed(T node, string property, Func<T, bool> filter) =>
        Raw(node, property, quiet: true) is System.Collections.IEnumerable items and not string
            ? items.OfType<T>().Where(filter).ToList()
            : Sorted(reader.ChildrenOf(node).Where(filter)).ToList();

    private IEnumerable<T> Sorted(IEnumerable<T> nodes) =>
        nodes.OrderBy(reader.DisplayOf, StringComparer.Ordinal).ThenBy(reader.KeyOf, StringComparer.Ordinal);

    private bool IsEntity(T node) => reader.IsKind(node, "Entity") && reader.KindOf(node) is not "AnonymousStructure" && !reader.KindOf(node).EndsWith("Signature", StringComparison.Ordinal);

    private string Key(T node) => " @" + reader.KeyOf(node);

    private void Cover(T node) { covered.Add(node); foreach (var child in reader.ChildrenOf(node)) if (ValueKinds.Contains(reader.KindOf(child))) covered.Add(child); }

    // A widget rendered as one line (button, link, label): its text, events and arguments are in that line; styles fold.
    private void CoverTree(T node)
    {
        foreach (var descendant in reader.Walk(node)) {
            if (folded.ContainsKey(descendant) || covered.Contains(descendant)) continue;
            if (reader.KindOf(descendant) == "ExtendedProperty") Fold(descendant, "widget style and attributes"); else covered.Add(descendant);
        }
    }

    private void Fold(T node, string reason)
    {
        foreach (var descendant in reader.Walk(node))
            if (!covered.Contains(descendant)) folded.TryAdd(descendant, reason);
    }

    private readonly SortedDictionary<string, int> readErrors = new(StringComparer.Ordinal);

    private void ReadError(T node, string property)
    {
        ReadErrors++;
        var at = reader.KindOf(node) + "." + property;
        readErrors[at] = readErrors.GetValueOrDefault(at) + 1;
    }

    // quiet: an optional property probed on any kind (list properties, Visible, Enabled); its failure is not a read error.
    private object? Raw(T node, string property, bool quiet = false)
    {
        if (reader.PropertyOf(node, property) is not { } read) return null;
        try { return read(); } catch { if (!quiet) ReadError(node, property); return null; }
    }

    private string? Text(object? value) => value switch {
        null => null,
        string text => text,
        _ when reader.ExpressionText(value) is { } expression => expression,
        T reference => reader.DisplayOf(reference),
        System.Collections.IEnumerable => null,
        _ => value.ToString()
    };

    // The text of a plain text literal ("Quotes"), or null for any other expression. A label or button whose text is an
    // Expression widget with a literal then reads "Quotes", never ["Quotes"] (the digest's own mark of an expression).
    private static string? Literal(string expression) =>
        expression.Length >= 2 && expression[0] == '"' && expression[^1] == '"' && expression.IndexOf('"', 1) == expression.Length - 1
            ? expression[1..^1] : null;

    private string? S(T node, string property) => Text(Raw(node, property));

    private T? Ref(T node, string property) => Raw(node, property) as T;

    private bool Flag(T node, string property) => S(node, property) is "True" or "Yes";

    private string Expr(T node, string property) => Clip(OneLine(S(node, property) ?? ""), ExpressionMax, node);

    private string TypeOf(T node)
    {
        var type = Text(Raw(node, "DataType")) ?? S(node, "Type") ?? "?";
        if (type == "Text" && S(node, "Length") is { Length: > 0 } length) type += "(" + length + ")";
        else if (type == "Decimal" && S(node, "Length") is { Length: > 0 } digits && S(node, "Decimals") is { Length: > 0 } decimals) type += "(" + digits + "," + decimals + ")";
        return type;
    }

    private void Flags(StringBuilder text, T node, params (string Property, string Word)[] flags)
    {
        foreach (var (property, word) in flags) if (Flag(node, property)) text.Append(' ').Append(word);
    }

    private string? Description(T node) => S(node, "Description") is { Length: > 0 } description ? "\"" + Clip(OneLine(description), DescriptionMax) + "\"" : null;

    private void AppendDescription(StringBuilder text, T node) { if (Description(node) is { } description) text.Append(' ').Append(description); }

    private static string Words(string kind) => string.Concat(kind.Select((c, i) => i > 0 && char.IsUpper(c) && !char.IsUpper(kind[i - 1]) ? " " + char.ToLowerInvariant(c) : char.ToLowerInvariant(c).ToString()));

    private static string OneLine(string text)
    {
        var builder = new StringBuilder(text.Length); var space = false;
        foreach (var c in text) {
            if (char.IsWhiteSpace(c)) { space = builder.Length > 0; continue; }
            if (space) { builder.Append(' '); space = false; }
            builder.Append(c);
        }
        return builder.ToString();
    }

    // owner: the element that holds the whole text, named in the clip so a read by @key (full:true) gets the rest.
    private string Clip(string text, int max, T? owner = null)
    {
        if (text.Length <= max) return text;
        Clips++;
        return text[..max] + "…(+" + (text.Length - max) + (owner != null ? " @" + reader.KeyOf(owner) : "") + ")";
    }
}
