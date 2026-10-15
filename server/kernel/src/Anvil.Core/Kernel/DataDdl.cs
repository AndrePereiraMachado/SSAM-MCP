using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anvil.Reading;

// One top-level element of the data text: its key, kind, name, section and the statements that declare it (an entity's
// block also holds its records, indexes, events and sample record).
public sealed record DdlBlock(string Key, string Kind, string Name, string Section, string Text, int Elements);

// Data text (ssam-ddl/1): the module's data as text the model already knows, one to one with the Model API and read back
// without loss (the fixed point: DataDdlCheck parses the text and compares it with the model). DDL in the SQL form for
// entities and static entities (records as `values`), `type X = {…}` for structures and one declaration line for site
// properties (settings in ODC), client and session variables and timers. Types, defaults and values are OutSystems'
// (Text(120), Long Integer, Pedido Identifier, "Novo", CurrDateTime()), written as the Model API keeps them.
// Every element ends its line with `-- @<key>`; `///` lines before an element are its description, whole; the frequent
// properties have their own word (public, label, order, active, update, folder, identifier, auto, required, references …
// on delete, json, default, read-only, secret, action, schedule, priority, timeout) and every other property the Model API
// lets set, with a value other than its default, is written `os:<Property>=<value>`. Nothing is dropped silently: what
// the platform computes (generated actions, identifier types, versions) is not written, and DataDdlCheck verifies it.
// Shared by both kernels and the ODC builder (linked there) and free of Studio types: it reads only through ModelReader.
// Deterministic: the same OML bytes give the same text (elements by name then key, attributes in model order, records in
// identifier order, values in attribute order). Stored beside the module index (<sha256>.<adapter>.ddl.json).
public sealed class DataDdl
{
    public const string Schema = "ssam-ddl/1";
    // The version of what Build writes: a stored text of another version is a miss. Raise it on every change of the text.
    public const int Extractor = 1;
    public static readonly string[] SectionIds = ["entities", "structures", "variables", "timers"];

    public string Lane { get; private init; } = "";
    public string SourceSha256 { get; private init; } = "";
    public long SourceBytes { get; private init; }
    public string CreatedAt { get; private init; } = "";
    public string ModuleName { get; private init; } = "";
    public string ModuleKey { get; private init; } = "";
    // Keyed elements the text declares (entities, attributes, indexes, records, events, structures, structure attributes,
    // variables, timers).
    public int Elements { get; private init; }
    public IReadOnlyList<DdlBlock> Blocks { get; private init; } = [];

    public string Header => "-- " + Schema + " module=" + ModuleName + " lane=" + Lane + " key=@" + ModuleKey + " sourceSha256=" + SourceSha256
        + " elements=" + Elements + "\n";
    // The header, then each block followed by a blank line.
    public string Text => Header + string.Concat(Blocks.Select(b => "\n" + b.Text + "\n"));

    public static DataDdl Build<T>(T root, ModelReader<T> reader, string lane, string sourceSha256, long sourceBytes) where T : class
    {
        var writer = new DdlWriter<T>(root, reader, lane);
        writer.Write();
        return new DataDdl {
            Lane = lane, SourceSha256 = sourceSha256.ToLowerInvariant(), SourceBytes = sourceBytes, CreatedAt = DateTimeOffset.UtcNow.ToString("o"),
            ModuleName = reader.DisplayOf(root), ModuleKey = reader.KeyOf(root), Elements = writer.Elements, Blocks = writer.Blocks
        };
    }

    // The same text under another source: a data text a job keeps as a read under the sha256 of its own text (the basedOn of a
    // next edit, ModelSession.KeepDdlReading).
    public DataDdl WithSource(string sourceSha256) => new() {
        Lane = Lane, SourceSha256 = sourceSha256.ToLowerInvariant(), SourceBytes = SourceBytes, CreatedAt = CreatedAt,
        ModuleName = ModuleName, ModuleKey = ModuleKey, Elements = Elements, Blocks = Blocks };

    // Cold reads (kernel CLIs): the stored text of these bytes, else built from the model the caller loads and stored.
    public static JsonObject Ensure(ModuleIndexStore store, string file, Func<byte[], string, DataDdl> load)
    {
        var bytes = File.ReadAllBytes(file);
        var sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes));
        var ddl = store.LoadDdl(sha256); var built = false;
        if (ddl == null) { ddl = load(bytes, sha256); store.SaveDdl(ddl); built = true; }
        return ddl.Answer(store.DdlPathOf(sha256), built);
    }

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
        foreach (var id in SectionIds) {
            var blocks = Blocks.Where(b => b.Section == id).ToList();
            var bytes = blocks.Sum(b => Encoding.UTF8.GetByteCount(b.Text) + 2);
            sections.Add(new JsonObject { ["id"] = id, ["blocks"] = blocks.Count, ["elements"] = blocks.Sum(b => b.Elements), ["bytes"] = bytes, ["tokens"] = (bytes + 3) / 4 });
        }
        var total = Encoding.UTF8.GetByteCount(Text);
        return new JsonObject { ["schema"] = Schema, ["module"] = ModuleName, ["lane"] = Lane, ["sourceBytes"] = SourceBytes,
            ["elements"] = Elements, ["blocks"] = Blocks.Count, ["bytes"] = total, ["tokens"] = (total + 3) / 4, ["sections"] = sections };
    }

    public byte[] ToJson(string adapter)
    {
        using var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(buffer, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping })) {
            json.WriteStartObject();
            json.WriteString("schema", Schema); json.WriteNumber("extractor", Extractor);
            json.WriteString("lane", Lane); json.WriteString("adapter", adapter);
            json.WriteString("sourceSha256", SourceSha256); json.WriteNumber("sourceBytes", SourceBytes); json.WriteString("createdAt", CreatedAt);
            json.WriteStartObject("module"); json.WriteString("name", ModuleName); json.WriteString("key", ModuleKey); json.WriteEndObject();
            json.WriteNumber("elements", Elements);
            json.WriteStartArray("blocks");
            foreach (var block in Blocks) {
                json.WriteStartObject();
                json.WriteString("key", block.Key); json.WriteString("kind", block.Kind); json.WriteString("name", block.Name);
                json.WriteString("section", block.Section); json.WriteNumber("elements", block.Elements); json.WriteString("text", block.Text);
                json.WriteEndObject();
            }
            json.WriteEndArray();
            json.WriteEndObject();
        }
        return buffer.ToArray();
    }

    // Any identity or shape mismatch throws: the caller treats it as a miss and builds again, never serves it.
    public static DataDdl Parse(byte[] json, string lane, string adapter, string sourceSha256)
    {
        using var document = JsonDocument.Parse(json);
        var top = document.RootElement;
        static string Text(JsonElement element, string property) => element.GetProperty(property).GetString() ?? throw new InvalidDataException(property + " is null");
        if (Text(top, "schema") != Schema || top.GetProperty("extractor").GetInt32() != Extractor || Text(top, "lane") != lane
            || Text(top, "adapter") != adapter || !string.Equals(Text(top, "sourceSha256"), sourceSha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Data text identity does not match this capture");
        var blocks = top.GetProperty("blocks").EnumerateArray().Select(b => new DdlBlock(Text(b, "key"), Text(b, "kind"), Text(b, "name"),
            Text(b, "section"), Text(b, "text"), b.GetProperty("elements").GetInt32())).ToList();
        if (blocks.Any(b => !SectionIds.Contains(b.Section))) throw new InvalidDataException("Data text section unknown to this extractor");
        var module = top.GetProperty("module");
        return new DataDdl {
            Lane = lane, SourceSha256 = Text(top, "sourceSha256").ToLowerInvariant(), SourceBytes = top.GetProperty("sourceBytes").GetInt64(),
            CreatedAt = Text(top, "createdAt"), ModuleName = Text(module, "name"), ModuleKey = Text(module, "key"),
            Elements = top.GetProperty("elements").GetInt32(), Blocks = blocks
        };
    }
}

// The rules both directions share: which properties are identity or bookkeeping, the defaults of every property the text
// names (a property equal to its default is not written; absent, it reads as its default), the words of the frequent
// properties, and the syntax of names, types, texts and expressions. One table, so the printer and the parser cannot
// disagree (the fixed point checks that they do not).
public static class DdlRules
{
    // Identity, position and bookkeeping: the name is the element's own token, the key its comment, the parent and the
    // position its place in the text. Never written as os:.
    public static readonly HashSet<string> Identity = new(StringComparer.Ordinal) {
        "Name", "Owner", "OwnerESpace", "ESpace", "Module", "PropertyOwner", "RealPropertyOwner", "Object", "Parent", "Children",
        "Key", "ObjectKey", "GlobalKey", "IsValid", "Root", "HorizontalPosition", "VerticalPosition", "IncomingConnectors", "Icon", "DisplayValue",
        "DisplayName", "ReadableIdentifier", "Referrers", "Referers", "ApplicableCssClasses", "CollectionDescriptor", "PropertyDescriptor",
        "RealPropertyDescriptor", "Descriptor", "IndexInParent", "CanMoveBefore", "CanMoveAfter", "IsInitialized", "Generation",
        "CreatedBy", "CreatedByAgent", "CreatedByTool", "LastModifiedBy", "LastModifiedByAgent", "LastModifiedByTool",
        "LastModifiedDate", "LastMergedBy", "LastMergedDate", "ModifiedByAgents", "ModifiedByTools", "FullSignatureHash",
        "CompatibilitySignatureHash", "Digest", "ContentDigest", "UniqueId", "Metadata", "TextResources", "TextResourcesIds",
        "WasDeleted", "ParentStructure", "TransactionsManager" };

    // What the platform computes from the element itself: never written, never read back; DataDdlCheck counts them per
    // kind and verifies the ones with a rule (Type is the DataType; LabelOrFirstAttribute is LabelAttribute when set).
    public static readonly Dictionary<string, string> Computed = new(StringComparer.Ordinal) {
        ["Type"] = "the DataType again", ["TypeKind"] = "the shape of a record type", ["ListElementType"] = "the shape of a record type",
        ["EntityKind"] = "the element's kind", ["IsStaticEntity"] = "the element's kind", ["Kind"] = "the element's kind",
        ["IdentifierType"] = "the generated identifier type", ["LabelOrFirstAttribute"] = "LabelAttribute, else an attribute the platform picks",
        ["Fields"] = "the attributes again", ["CreateAction"] = "a generated entity action", ["CreateOrUpdateAction"] = "a generated entity action",
        ["CreateOrUpdateAllAction"] = "a generated entity action", ["DeleteAction"] = "a generated entity action", ["DeleteAllAction"] = "a generated entity action",
        ["GetAction"] = "a generated entity action", ["GetForUpdateAction"] = "a generated entity action", ["UpdateAction"] = "a generated entity action",
        ["WakeTimerAction"] = "the timer's generated wake action" };

    // The elements the text declares, each with its own statement or line.
    public static bool IsEntityKind(string kind) => kind.EndsWith("Entity", StringComparison.Ordinal) && kind != "AnonymousStructure";
    public static bool IsEventKind(string kind) => kind.EndsWith("LifeCycleDatabaseEvent", StringComparison.Ordinal);
    public static readonly HashSet<string> VariableKinds = new(StringComparer.Ordinal) { "SiteProperty", "ClientVariable", "SessionVariable" };

    // The words of an entity kind: "" for ServerEntity, "static" for StaticEntity, the lowercase prefix otherwise.
    public static string EntityWords(string kind) => kind switch {
        "ServerEntity" or "Entity" => "", "StaticEntity" => "static ",
        _ => string.Concat(kind[..^"Entity".Length].Select((c, i) => (i > 0 && char.IsUpper(c) ? " " : "") + char.ToLowerInvariant(c))) + " " };
    public static string EntityKind(string words) => words switch {
        "" => "ServerEntity", "static" => "StaticEntity",
        _ => string.Concat(words.Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(w => char.ToUpperInvariant(w[0]) + w[1..])) + "Entity" };

    // The statement word of a variable kind in each lane (ODC calls site properties settings).
    public static string VariableWords(string kind, string lane) => kind switch {
        "SiteProperty" => lane == "odc" ? "setting" : "site property", "ClientVariable" => "client variable", _ => "session variable" };

    // The context a default depends on: the element's kind and name, its parent's kind, the value of another of its
    // properties (after defaults) and, for an entity, its attributes by name.
    public interface IContext
    {
        string Kind { get; }
        string Name { get; }
        string? ParentKind { get; }
        string? Value(string property);
        IReadOnlyList<string> Attributes { get; }
    }

    // The default of a property: the value it reads as when the text does not write it. Null: no value (an empty text,
    // an unset reference, False).
    public static string? Default(IContext c, string property)
    {
        var entity = IsEntityKind(c.Kind);
        var statik = c.Kind == "StaticEntity";
        string? Attribute(string name) => c.Attributes.FirstOrDefault(a => a == name);
        switch (property) {
            case "IsMultiTenant": return c.Kind is "StaticEntity" ? "No" : "Inherited";
            case "UpdateBehavior": return "Optimized";
            case "ExposeReadOnly" when entity: return "True";
            case "ExposeCreateAndChangeActions" when entity: return statik ? null : "True";
            case "UseTranslations" when statik: return "True";
            case "LabelAttribute" when statik: return Attribute("Label");
            case "OrderByAttribute" when statik: return Attribute("Order");
            case "Label" when entity: return Humanize(c.Name);
            case "LabelPlural" when entity: return Pluralize(c.Value("Label") ?? Humanize(c.Name));
            case "Shareable": return c.Value("Public");
            case "IsAutoNumber" when c.Kind == "EntityAttribute": return "No";
            case "DeleteRule": return c.ParentKind == "StaticEntity" ? "Ignore" : "Protect";
            case "Label" when c.Kind is "EntityAttribute" or "StructureAttribute": return AttributeLabel(c.Name);
            case "Priority" when c.Kind == "Timer": return "Normal";
            case "TimeoutInMinutes" when c.Kind == "Timer": return "20";
            case "CronSchedule" when c.Kind == "Timer": return c.Value("Schedule");
        }
        return null;
    }

    // What a timer's schedule part (ODC: the Schedule child) holds for the timer's schedule text; null when nothing.
    public static string? TimerPart(string kind, string property, string? schedule) => (kind, property) switch {
        ("Schedule", "WhenPublished") => schedule is "WhenPublished" or "When Published" ? "True" : null,
        _ => null };

    // A value the text treats as no value: null, empty, False.
    public static bool Unset(string? value) => value is null or "" or "False";
    public static bool Same(string? a, string? b) => a == b || Unset(a) && Unset(b);

    // OutSystems' label of a name: words split where a lowercase letter meets a capital, before the capital that starts a
    // word after an acronym, before a run of digits and at underscores ("GovernanceSetting" -> "Governance Setting",
    // "CSConfiguration" -> "CS Configuration", "AddressLine1" -> "Address Line 1", "Is_Active" -> "Is Active"); digits
    // stay with the letters that follow them ("Ar156Complete" -> "Ar 156Complete").
    public static string Humanize(string name)
    {
        var text = new StringBuilder(name.Length + 8);
        for (var i = 0; i < name.Length; i++) {
            var c = name[i];
            if (c == '_') { if (text.Length > 0 && text[^1] != ' ') text.Append(' '); continue; }
            if (i > 0 && text.Length > 0 && text[^1] != ' ') {
                var previous = name[i - 1];
                if (char.IsUpper(c) && char.IsLower(previous)
                    || char.IsUpper(c) && char.IsUpper(previous) && i + 1 < name.Length && char.IsLower(name[i + 1])
                    || char.IsDigit(c) && char.IsLetter(previous))
                    text.Append(' ');
            }
            text.Append(c);
        }
        return text.ToString().Trim();
    }

    // The label of an attribute: its name humanized, without a last word "Id", whatever its type ("ProdutoId" -> "Produto",
    // "EventId" -> "Event", "survey_id" -> "survey").
    public static string AttributeLabel(string name)
    {
        var label = Humanize(name);
        return label.Length > 3 && label.EndsWith(" Id", StringComparison.OrdinalIgnoreCase) ? label[..^3] : label;
    }

    public static string Pluralize(string label)
    {
        if (label.Length == 0) return label;
        var lower = label.ToLowerInvariant();
        if (lower.EndsWith('y') && lower.Length > 1 && !"aeiou".Contains(lower[^2])) return label[..^1] + "ies";
        if (lower.EndsWith('s') || lower.EndsWith('x') || lower.EndsWith('z') || lower.EndsWith("ch", StringComparison.Ordinal) || lower.EndsWith("sh", StringComparison.Ordinal) || lower.EndsWith('o'))
            return label + "es";
        return label + "s";
    }

    // ---- syntax ------------------------------------------------------------------------------------------------------

    public static bool IsBareName(string name) =>
        name.Length > 0 && (char.IsLetter(name[0]) || name[0] == '_') && name.All(c => char.IsLetterOrDigit(c) || c == '_');

    // A name: bare, or between brackets with ']' doubled (also "none", the text's word for no value).
    public static string Name(string name) => IsBareName(name) && name != "none" ? name : "[" + name.Replace("]", "]]") + "]";

    // A type name is bare when every word starts with a capital letter (the words the text keeps for itself are lowercase).
    public static string TypeName(string type) =>
        type.Length > 0 && type.Split(' ').All(w => w.Length > 0 && char.IsUpper(w[0]) && IsBareName(w)) ? type : "[" + type.Replace("]", "]]") + "]";

    private static bool Control(string text) => text.Any(c => c < ' ' && c != '\t' || c is '\u2028' or '\u2029' or '\u007f');

    // A text value (label, json, schedule, os:): an OutSystems text literal with '"' doubled; a text with a control
    // character as $"<JSON string>".
    public static string Quote(string text) => Control(text) ? "$" + Json(text) : "\"" + text.Replace("\"", "\"\"") + "\"";

    // An os: value: bare when it is one word of letters, digits and underscores (other than "none"), else quoted.
    public static string Value(string text) => text.Length > 0 && text != "none" && text.All(c => char.IsLetterOrDigit(c) || c == '_') ? text : Quote(text);

    public static string Json(string text) => JsonSerializer.Serialize(text, new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping });

    // An expression as the Model API keeps it: bare when the parser reads exactly it back in that place (no line break,
    // no outer spaces, balanced, no comment mark), else $"<JSON string>".
    public static string Expression(string text, DdlStop stop) =>
        text.Length > 0 && !Control(text) && text.Trim() == text && DdlScanner.ScanExpression(text + Terminator(stop), 0, stop) == (text, text.Length)
            ? text : "$" + Json(text);

    private static string Terminator(DdlStop stop) => stop switch { DdlStop.Item => ",", DdlStop.Field => ";", _ => "\n" };

    // Description lines: "///" alone for an empty line, "/// " and the line otherwise; a text with a control character
    // other than the line break is one line ///$"<JSON string>".
    public static IEnumerable<string> Doc(string text)
    {
        if (text.Replace("\n", "").Any(c => c < ' ' && c != '\t' || c is '\u2028' or '\u2029' or '\u007f')) { yield return "///$" + Json(text); yield break; }
        foreach (var line in text.Split('\n')) yield return line.Length == 0 ? "///" : "/// " + line;
    }
}

// Where an expression ends: an attribute or record value (',' or ')' at depth 0), a structure attribute (';'), or a
// declaration line (the end of the line).
public enum DdlStop { Item, Field, Line }

public static class DdlScanner
{
    // The expression that starts at `at` (spaces skipped) and its end: OutSystems text literals ("" inside) and brackets
    // are followed; it stops at depth 0 on the stop marks, a closing bracket of an outer level, or a comment ("--" after a
    // space and before a space or the end of the line). A $"<JSON>" expression is read whole. Returns the text, trimmed of
    // trailing spaces, and the position after it.
    public static (string Text, int End) ScanExpression(string s, int at, DdlStop stop)
    {
        while (at < s.Length && (s[at] == ' ' || s[at] == '\t')) at++;
        if (at + 1 < s.Length && s[at] == '$' && s[at + 1] == '"') return ScanJson(s, at + 1);
        var start = at; var depth = 0;
        for (; at < s.Length; at++) {
            var c = s[at];
            if (c == '"') {
                for (at++; at < s.Length; at++) {
                    if (s[at] != '"') continue;
                    if (at + 1 < s.Length && s[at + 1] == '"') { at++; continue; }
                    break;
                }
                continue;
            }
            if (c is '(' or '[' or '{') { depth++; continue; }
            if (c is ')' or ']' or '}') { if (depth == 0) break; depth--; continue; }
            if (depth > 0) continue;
            if (c == ',' && stop == DdlStop.Item || c == ';' || c == '\n' || c == '\r') break;
            if (c == '-' && at + 1 < s.Length && s[at + 1] == '-' && at > start && s[at - 1] is ' ' or '\t'
                && (at + 2 >= s.Length || s[at + 2] is ' ' or '\t' or '\n' or '\r')) break;
        }
        var end = at;
        while (end > start && (s[end - 1] == ' ' || s[end - 1] == '\t')) end--;
        return (s[start..end], end);
    }

    // A JSON string literal starting at the quote; returns its value and the position after the closing quote.
    public static (string Text, int End) ScanJson(string s, int at)
    {
        if (at >= s.Length || s[at] != '"') throw new FormatException("expected a JSON string");
        var end = at + 1;
        for (; end < s.Length; end++) {
            if (s[end] == '\\') { end++; continue; }
            if (s[end] == '"') break;
        }
        if (end >= s.Length) throw new FormatException("unterminated JSON string");
        return (JsonSerializer.Deserialize<string>(s[at..(end + 1)]) ?? "", end + 1);
    }
}

internal sealed class DdlWriter<T>(T root, ModelReader<T> reader, string lane) where T : class
{
    public readonly List<DdlBlock> Blocks = [];
    public int Elements { get; private set; }
    private int blockElements;
    private ModelReader<T> R => reader;

    public void Write()
    {
        var top = Sorted(reader.ChildrenOf(root)).ToList();
        foreach (var entity in top.Where(IsEntity)) Add(entity, "entities", Entity);
        foreach (var structure in Structures()) Add(structure, "structures", Structure);
        foreach (var variable in top.Where(n => DdlRules.VariableKinds.Contains(reader.KindOf(n)))) Add(variable, "variables", Variable);
        foreach (var timer in top.Where(n => reader.KindOf(n) == "Timer")) Add(timer, "timers", Timer);
    }

    private void Add(T node, string section, Func<T, string> render)
    {
        blockElements = 0;
        var text = render(node);
        Blocks.Add(new(reader.KeyOf(node), reader.KindOf(node), reader.DisplayOf(node), section, text, blockElements));
    }

    private bool IsEntity(T node) => reader.IsKind(node, "Entity") && DdlRules.IsEntityKind(reader.KindOf(node))
        && !reader.KindOf(node).EndsWith("Signature", StringComparison.Ordinal);

    // Every structure of the module that is not another module's (top level, and those an integration holds).
    private IEnumerable<T> Structures()
    {
        var found = new List<T>();
        void Visit(T node) {
            foreach (var child in reader.ChildrenOf(node)) {
                var kind = reader.KindOf(child);
                if (kind == "Reference") continue;
                if (kind == "Structure") found.Add(child);
                else if (!IsEntity(child) && !kind.EndsWith("Signature", StringComparison.Ordinal)) Visit(child);
            }
        }
        Visit(root);
        return Sorted(found);
    }

    // ---- statements ----------------------------------------------------------------------------------------------------

    private string Entity(T entity)
    {
        var kind = reader.KindOf(entity);
        var text = new StringBuilder();
        Doc(text, entity, "");
        var attributes = Attributes(entity);
        var names = attributes.Select(reader.NameOf).ToList();
        var context = Context(entity, null, names);
        text.Append("create ").Append(DdlRules.EntityWords(kind)).Append("entity ").Append(DdlRules.Name(reader.NameOf(entity)));
        if (Flag(entity, "Public")) text.Append(" public");
        Reference(text, entity, context, "LabelAttribute", "label");
        Reference(text, entity, context, "OrderByAttribute", "order");
        Reference(text, entity, context, "IsActiveAttribute", "active");
        if (Has(entity, "UpdateBehavior") && Norm(entity, "UpdateBehavior") is var update && !DdlRules.Same(update, DdlRules.Default(context, "UpdateBehavior")))
            text.Append(" update ").Append(update?.ToLowerInvariant() ?? "none");
        if (Norm(entity, "Folder") is { } folder) text.Append(" folder ").Append(DdlRules.Name(folder));
        Others(text, entity, context, EntityWords);
        text.Append(" (").Append(Key(entity)).Append('\n');
        var identifier = Raw(entity, "Identifier") as T ?? Raw(entity, "IdentifierAttribute") as T;
        for (var i = 0; i < attributes.Count; i++) {
            var attribute = attributes[i];
            Doc(text, attribute, "  ");
            text.Append("  ").Append(Attribute(attribute, entity, ReferenceEquals(attribute, identifier)));
            text.Append(i < attributes.Count - 1 ? "," : "").Append(Key(attribute)).Append('\n');
        }
        var records = Records(entity);
        if (records.Count == 0) text.Append(");");
        else {
            text.Append(")\nvalues\n");
            for (var i = 0; i < records.Count; i++)
                text.Append("  ").Append(Record(records[i], attributes)).Append(i < records.Count - 1 ? "," : ";").Append(Key(records[i])).Append(i < records.Count - 1 ? "\n" : "");
        }
        // Entity events with a handler (ODC), the sample record when it holds a value (ODC), then the indexes.
        foreach (var child in reader.ChildrenOf(entity).Where(c => DdlRules.IsEventKind(reader.KindOf(c))).OrderBy(reader.KindOf, StringComparer.Ordinal))
            if (Event(child, entity) is { } line) text.Append('\n').Append(line);
        foreach (var child in reader.ChildrenOf(entity).Where(c => reader.KindOf(c) == "Record" && kind != "StaticEntity"))
            if (Values(child, attributes) is { Length: > 0 } values) {
                Elements++; blockElements++;
                text.Append("\nsample ").Append(DdlRules.Name(reader.NameOf(entity))).Append(" (").Append(values).Append(");").Append(Key(child));
            }
        foreach (var index in Indexes(entity)) text.Append('\n').Append(Index(index, entity));
        Elements++; blockElements++;
        return text.ToString();
    }

    private static readonly HashSet<string> EntityWords = new(StringComparer.Ordinal) {
        "Description", "Public", "LabelAttribute", "OrderByAttribute", "IsActiveAttribute", "UpdateBehavior", "Folder", "Identifier", "IdentifierAttribute" };

    private List<T> Attributes(T owner) =>
        Listed(owner, "Attributes", c => reader.KindOf(c) is "EntityAttribute" or "StructureAttribute");

    private List<T> Records(T entity) =>
        reader.KindOf(entity) == "StaticEntity" || Flag(entity, "IsStaticEntity")
            ? reader.ChildrenOf(entity).Where(c => reader.IsKind(c, "Record")).OrderBy(r => Norm(r, "Identifier") ?? reader.DisplayOf(r), StringComparer.Ordinal)
                .ThenBy(reader.KeyOf, StringComparer.Ordinal).ToList()
            : [];

    private string Attribute(T attribute, T entity, bool identifier)
    {
        var type = Raw(attribute, "DataType") as T;
        var identifierType = type != null && reader.KindOf(type) == "IdentifierType";
        var context = Context(attribute, entity, []);
        var text = new StringBuilder(DdlRules.Name(reader.NameOf(attribute))).Append(' ').Append(Type(attribute));
        if (identifier) text.Append(" identifier");
        if (Norm(attribute, "IsAutoNumber") is "Yes" or "True") text.Append(" auto");
        if (Flag(attribute, "IsMandatory")) text.Append(" required");
        if (identifierType) text.Append(" references ").Append(DdlRules.Name(Norm(type!, "Entity") ?? IdentifierEntity(reader.DisplayOf(type!))))
            .Append(" on delete ").Append(Norm(attribute, "DeleteRule") ?? DdlRules.Default(context, "DeleteRule"));
        Label(text, attribute, context);
        if (Norm(attribute, "NameInJSON") is { } json) text.Append(" json ").Append(DdlRules.Quote(json));
        Others(text, attribute, context, identifierType ? AttributeWords : AttributeWordsNoReference);
        if (Norm(attribute, "DefaultValue") is { } value) text.Append(" default ").Append(DdlRules.Expression(value, DdlStop.Item));
        Elements++; blockElements++;
        return text.ToString();
    }

    private static string IdentifierEntity(string type) => type.EndsWith(" Identifier", StringComparison.Ordinal) ? type[..^" Identifier".Length] : type;

    private static readonly HashSet<string> AttributeWords = new(StringComparer.Ordinal) {
        "Description", "DataType", "Length", "Decimals", "IsAutoNumber", "IsMandatory", "DeleteRule", "Label", "NameInJSON", "DefaultValue" };
    private static readonly HashSet<string> AttributeWordsNoReference = new(AttributeWords.Where(w => w != "DeleteRule"), StringComparer.Ordinal);

    private void Label(StringBuilder text, T node, DdlRules.IContext context)
    {
        if (Has(node, "Label") && Norm(node, "Label") is var label && !DdlRules.Same(label, DdlRules.Default(context, "Label")))
            text.Append(" label ").Append(label == null ? "none" : DdlRules.Quote(label));
    }

    // Type(Length,Decimals): the Model API's DataType by name, then Length and Decimals when set.
    private string Type(T node)
    {
        var type = Raw(node, "DataType") is T reference ? reader.DisplayOf(reference) : Norm(node, "DataType");
        var text = new StringBuilder(type == null ? "none" : DdlRules.TypeName(type));
        var length = Norm(node, "Length"); var decimals = Norm(node, "Decimals");
        if (length != null || decimals != null) text.Append('(').Append(Size(length)).Append(decimals != null ? "," + Size(decimals) : "").Append(')');
        return text.ToString();
    }

    private static string Size(string? value) => value == null ? "" : value.All(char.IsDigit) && value.Length > 0 ? value : DdlRules.Quote(value);

    private string Record(T record, List<T> attributes)
    {
        Elements++; blockElements++;
        return DdlRules.Name(Norm(record, "Identifier") ?? reader.DisplayOf(record)) + " (" + Values(record, attributes) + ")" + OthersText(record, Context(record, null, []), RecordWords);
    }

    private static readonly HashSet<string> RecordWords = new(StringComparer.Ordinal) { "Identifier" };

    // A record's values in the order of the entity's attributes, without the empty ones: Attribute = expression.
    private string Values(T record, List<T> attributes)
    {
        var position = attributes.Select((a, i) => (reader.NameOf(a), i)).GroupBy(x => x.Item1).ToDictionary(g => g.Key, g => g.First().i, StringComparer.Ordinal);
        var values = new List<(int At, string Text)>();
        foreach (var value in reader.ChildrenOf(record)) {
            if (reader.KindOf(value) != "RecordAttributeValue") continue;
            var attribute = Raw(value, "Attribute") is T a ? reader.NameOf(a) : Norm(value, "Attribute") ?? "?";
            if (Norm(value, "Value") is not { } text) continue;
            values.Add((position.GetValueOrDefault(attribute, int.MaxValue), DdlRules.Name(attribute) + " = " + DdlRules.Expression(text, DdlStop.Item)));
        }
        return string.Join(", ", values.OrderBy(v => v.At).ThenBy(v => v.Text, StringComparer.Ordinal).Select(v => v.Text));
    }

    // on create|update|delete <Entity> -> Handler(Parameter = expression, …); only when the event calls something.
    private string? Event(T @event, T entity)
    {
        var kind = reader.KindOf(@event);
        var handler = Norm(@event, "Destination") ?? Norm(@event, "Handler");
        var others = OthersText(@event, Context(@event, entity, []), EventWords);
        if (handler == null && others.Length == 0) return null;
        Elements++; blockElements++;
        var name = kind[2..^"LifeCycleDatabaseEvent".Length].ToLowerInvariant();
        return "on " + name + " " + DdlRules.Name(reader.NameOf(entity)) + " -> " + (handler == null ? "none" : DdlRules.Name(handler))
            + "(" + Arguments(@event) + ")" + others + ";" + Key(@event);
    }

    private static readonly HashSet<string> EventWords = new(StringComparer.Ordinal) { "Destination", "Handler" };

    private string Arguments(T node)
    {
        var parts = new List<string>();
        foreach (var argument in reader.ChildrenOf(node).Where(c => reader.KindOf(c) == "Argument")) {
            if (Norm(argument, "Value") is not { } value) continue;
            parts.Add(DdlRules.Name(Raw(argument, "Parameter") is T p ? reader.NameOf(p) : Norm(argument, "Parameter") ?? "?") + " = " + DdlRules.Expression(value, DdlStop.Item));
        }
        return string.Join(", ", parts.Order(StringComparer.Ordinal));
    }

    // create [unique] index Name on Entity (A, B); the indexes the platform generates are not written.
    private IEnumerable<T> Indexes(T entity) =>
        (reader.IndexNodes(entity) ?? reader.ChildrenOf(entity).Where(c => reader.KindOf(c) == "EntityIndex").ToList())
            .Where(i => !DdlModel.IndexOf(reader, entity, i).Auto).OrderBy(reader.NameOf, StringComparer.Ordinal).ThenBy(reader.KeyOf, StringComparer.Ordinal);

    private string Index(T index, T entity)
    {
        Elements++; blockElements++;
        var (unique, _, columns) = DdlModel.IndexOf(reader, entity, index);
        return "create " + (unique ? "unique " : "") + "index " + DdlRules.Name(reader.NameOf(index)) + " on " + DdlRules.Name(reader.NameOf(entity))
            + " (" + string.Join(", ", columns.Select(DdlRules.Name)) + ")" + OthersText(index, Context(index, entity, []), IndexWords) + ";" + Key(index);
    }

    private static readonly HashSet<string> IndexWords = new(StringComparer.Ordinal) { "Unique", "AutoGenerated", "IndexAttributes", "Attributes" };

    private string Structure(T structure)
    {
        var text = new StringBuilder();
        Doc(text, structure, "");
        var context = Context(structure, null, []);
        text.Append("type ").Append(DdlRules.Name(reader.NameOf(structure)));
        if (Flag(structure, "Public")) text.Append(" public");
        if (Norm(structure, "Folder") is { } folder) text.Append(" folder ").Append(DdlRules.Name(folder));
        Others(text, structure, context, StructureWords);
        text.Append(" = {").Append(Key(structure)).Append('\n');
        foreach (var attribute in Attributes(structure)) {
            Doc(text, attribute, "  ");
            var attributeContext = Context(attribute, structure, []);
            text.Append("  ").Append(DdlRules.Name(reader.NameOf(attribute))).Append(": ").Append(Type(attribute));
            if (Flag(attribute, "IsMandatory")) text.Append(" required");
            Label(text, attribute, attributeContext);
            if (Norm(attribute, "NameInJSON") is { } json) text.Append(" json ").Append(DdlRules.Quote(json));
            Others(text, attribute, attributeContext, AttributeWordsNoReference);
            if (Norm(attribute, "DefaultValue") is { } value) text.Append(" default ").Append(DdlRules.Expression(value, DdlStop.Field));
            text.Append(';').Append(Key(attribute)).Append('\n');
            Elements++; blockElements++;
        }
        text.Append('}');
        Elements++; blockElements++;
        return text.ToString();
    }

    private static readonly HashSet<string> StructureWords = new(StringComparer.Ordinal) { "Description", "Public", "Folder" };

    private string Variable(T variable)
    {
        var text = new StringBuilder();
        Doc(text, variable, "");
        var kind = reader.KindOf(variable);
        text.Append(DdlRules.VariableWords(kind, lane)).Append(' ').Append(DdlRules.Name(reader.NameOf(variable)));
        if (Raw(variable, "DataType") != null) text.Append(": ").Append(Type(variable));
        var context = Context(variable, null, []);
        if (Flag(variable, "IsReadOnly")) text.Append(" read-only");
        if (Flag(variable, "IsSecret")) text.Append(" secret");
        if (Norm(variable, "Folder") is { } folder) text.Append(" folder ").Append(DdlRules.Name(folder));
        Others(text, variable, context, VariableWordsSet);
        if (Norm(variable, "DefaultValue") is { } value) text.Append(" = ").Append(DdlRules.Expression(value, DdlStop.Line));
        text.Append(Key(variable));
        Elements++; blockElements++;
        return text.ToString();
    }

    private static readonly HashSet<string> VariableWordsSet = new(StringComparer.Ordinal) {
        "Description", "DataType", "Length", "Decimals", "IsReadOnly", "IsSecret", "Folder", "DefaultValue" };

    private string Timer(T timer)
    {
        var text = new StringBuilder();
        Doc(text, timer, "");
        var context = Context(timer, null, []);
        text.Append("timer ").Append(DdlRules.Name(reader.NameOf(timer)));
        text.Append(" action ").Append(Norm(timer, "Action") is { } action ? DdlRules.Name(action) : "none");
        if (Norm(timer, "Schedule") is { } schedule) text.Append(" schedule ").Append(DdlRules.Quote(schedule));
        if (Has(timer, "CronSchedule") && Norm(timer, "CronSchedule") is var cron && !DdlRules.Same(cron, DdlRules.Default(context, "CronSchedule")))
            text.Append(" cron ").Append(cron == null ? "none" : DdlRules.Quote(cron));
        if (Has(timer, "Priority") && Norm(timer, "Priority") is var priority && !DdlRules.Same(priority, DdlRules.Default(context, "Priority"))) text.Append(" priority ").Append(priority ?? "none");
        if (Has(timer, "TimeoutInMinutes") && Norm(timer, "TimeoutInMinutes") is var timeout && !DdlRules.Same(timeout, DdlRules.Default(context, "TimeoutInMinutes"))) text.Append(" timeout ").Append(timeout ?? "none");
        if (Norm(timer, "Folder") is { } folder) text.Append(" folder ").Append(DdlRules.Name(folder));
        Others(text, timer, context, TimerWords);
        if (Arguments(timer) is { Length: > 0 } arguments) text.Append(" with (").Append(arguments).Append(')');
        text.Append(Key(timer));
        Elements++; blockElements++;
        return text.ToString();
    }

    private static readonly HashSet<string> TimerWords = new(StringComparer.Ordinal) {
        "Description", "Action", "Schedule", "CronSchedule", "Priority", "TimeoutInMinutes", "Folder" };

    // ---- every other property: os:<Property>=<value> -------------------------------------------------------------------

    private void Others(StringBuilder text, T node, DdlRules.IContext context, HashSet<string> words) => text.Append(OthersText(node, context, words));

    // The properties the Model API lets set that have no word of their own and differ from their default, by name.
    private string OthersText(T node, DdlRules.IContext context, HashSet<string> words)
    {
        var parts = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var (property, value) in DdlModel.Compared(reader, node)) {
            if (words.Contains(property)) continue;
            if (DdlRules.Same(value, DdlRules.Default(context, property))) continue;
            parts[property] = value == null ? "none" : DdlRules.Value(value);
        }
        return string.Concat(parts.Select(p => " os:" + p.Key + "=" + p.Value));
    }

    // ---- helpers -----------------------------------------------------------------------------------------------------

    private DdlRules.IContext Context(T node, T? parent, IReadOnlyList<string> attributes) =>
        new DdlModel.Context<T>(reader, node, parent, attributes);

    private void Reference(StringBuilder text, T node, DdlRules.IContext context, string property, string word)
    {
        if (!Has(node, property)) return;
        var value = Norm(node, property);
        if (!DdlRules.Same(value, DdlRules.Default(context, property))) text.Append(' ').Append(word).Append(' ').Append(value == null ? "none" : DdlRules.Name(value));
    }

    private void Doc(StringBuilder text, T node, string indent)
    {
        if (Norm(node, "Description") is not { } description) return;
        foreach (var line in DdlRules.Doc(description)) text.Append(indent).Append(line).Append('\n');
    }

    private string Key(T node) => " -- @" + reader.KeyOf(node);

    // The children in the order of the element's list property (Attributes), then any child it leaves out, never dropped.
    private List<T> Listed(T node, string property, Func<T, bool> filter)
    {
        var children = reader.ChildrenOf(node).Where(filter).ToList();
        if (Raw(node, property, quiet: true) is not System.Collections.IEnumerable items || items is string) return children;
        var listed = items.OfType<T>().Where(c => children.Contains(c)).ToList();
        return [.. listed, .. children.Where(c => !listed.Contains(c))];
    }

    private IEnumerable<T> Sorted(IEnumerable<T> nodes) =>
        nodes.OrderBy(reader.DisplayOf, StringComparer.Ordinal).ThenBy(reader.KeyOf, StringComparer.Ordinal);

    private object? Raw(T node, string property, bool quiet = true) => DdlModel.Raw(reader, node, property);
    private string? Norm(T node, string property) => DdlModel.Text(reader, Raw(node, property));
    private bool Flag(T node, string property) => Norm(node, property) is "True" or "Yes";
    private bool Has(T node, string property) => reader.PropertyOf(node, property) != null;
}

// How the text reads the model: a property's value as text, and the properties it compares (and writes as os:).
public static class DdlModel
{
    public static object? Raw<T>(ModelReader<T> reader, T node, string property) where T : class
    {
        if (reader.PropertyOf(node, property) is not { } read) return null;
        try { return read(); } catch { return null; }
    }

    // The text of a value: an expression's text, a referenced element's name, True/False, an enum's or number's text.
    // Empty texts and lists are no value here (lists are compared by Compared).
    public static string? Text<T>(ModelReader<T> reader, object? value) where T : class => value switch {
        null => null,
        string text => text.Length == 0 ? null : text,
        bool flag => flag ? "True" : "False",
        _ when reader.ExpressionText(value) is { } expression => expression.Length == 0 ? null : expression,
        T reference => reader.DisplayOf(reference) is { Length: > 0 } name ? name : reader.KindOf(reference) + ":",
        System.Collections.IEnumerable => null,
        _ => value.ToString() is { Length: > 0 } other ? other : null
    };

    // The properties of an element the text accounts for, with their values as text: every property of the Model API
    // except identity and bookkeeping (DdlRules.Identity), what the platform computes (DdlRules.Computed), lists of the
    // element's own children (they are the children) and references to the element itself, its parent, the module or an
    // element it holds other than an attribute (its generated actions, versions, events, sample record, schedule: each is
    // its own element or computed). A reference reads as the referenced element's name; a list of other elements as
    // [A, B] in name order.
    public static IEnumerable<(string Property, string? Value)> Compared<T>(ModelReader<T> reader, T node) where T : class
    {
        var children = new HashSet<T>(reader.ChildrenOf(node), ReferenceEqualityComparer.Instance);
        var parent = reader.ParentOf(node);
        foreach (var (property, read) in reader.PropertiesOf(node)) {
            if (DdlRules.Identity.Contains(property) || DdlRules.Computed.ContainsKey(property)) continue;
            object? value;
            try { value = read(); } catch { continue; }
            // An expression first: O11 keeps one as an element under its owner (DefaultValue, Length, a record's Value).
            if (value != null && reader.ExpressionText(value) is { } expression) { yield return (property, expression.Length == 0 ? null : expression); continue; }
            if (value is T target) {
                if (ReferenceEquals(target, node) || ReferenceEquals(target, parent)) continue;
                if ((children.Contains(target) || Holds(reader, node, target)) && reader.KindOf(target) is not ("EntityAttribute" or "StructureAttribute")) continue;
                yield return (property, Text(reader, value));
                continue;
            }
            if (value is System.Collections.IEnumerable items and not string && reader.ExpressionText(value) == null) {
                var listed = items.Cast<object?>().ToList();
                if (listed.All(i => i is T t && (children.Contains(t) || Holds(reader, node, t)))) continue;
                yield return (property, "[" + string.Join(", ", listed.Select(i => Text(reader, i) ?? "").Order(StringComparer.Ordinal)) + "]");
                continue;
            }
            yield return (property, Text(reader, value));
        }
    }

    // An index: unique, generated by the platform, and its columns in order. O11 keeps them outside the Model API's
    // properties (ModelReader.Indexes); ODC lists them as children with EntityIndexAttribute parts.
    public static (bool Unique, bool Auto, List<string> Columns) IndexOf<T>(ModelReader<T> reader, T entity, T index) where T : class
    {
        if (reader.Indexes(entity) is { } tuples && tuples.Any(t => t.Name == reader.NameOf(index))) {
            var tuple = tuples.First(t => t.Name == reader.NameOf(index));
            return (tuple.Unique, tuple.Auto, tuple.Attributes.ToList());
        }
        var listed = Raw(reader, index, "IndexAttributes") ?? Raw(reader, index, "Attributes");
        IEnumerable<T> parts = listed is System.Collections.IEnumerable items and not string ? items.OfType<T>() : reader.ChildrenOf(index);
        return (Text(reader, Raw(reader, index, "Unique")) == "True", Text(reader, Raw(reader, index, "AutoGenerated")) == "True",
            parts.Select(p => Raw(reader, p, "Attribute") is T a ? reader.NameOf(a) : "?").ToList());
    }

    private static bool Holds<T>(ModelReader<T> reader, T node, T target) where T : class
    {
        for (var at = reader.ParentOf(target); at != null; at = reader.ParentOf(at)) if (ReferenceEquals(at, node)) return true;
        return false;
    }

    // The defaults' context over the model.
    internal sealed class Context<T>(ModelReader<T> reader, T node, T? parent, IReadOnlyList<string> attributes) : DdlRules.IContext where T : class
    {
        public string Kind => reader.KindOf(node);
        public string Name => reader.NameOf(node);
        public string? ParentKind => parent != null ? reader.KindOf(parent) : reader.ParentOf(node) is { } up ? reader.KindOf(up) : null;
        public string? Value(string property) => Text(reader, Raw(reader, node, property));
        public IReadOnlyList<string> Attributes => attributes.Count > 0 || !DdlRules.IsEntityKind(Kind) ? attributes
            : reader.ChildrenOf(node).Where(c => reader.KindOf(c) == "EntityAttribute").Select(reader.NameOf).ToList();
    }
}
