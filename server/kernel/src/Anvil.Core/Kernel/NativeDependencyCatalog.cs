using System.Collections.ObjectModel;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Anvil.Core;

public enum NativeDependencyKind { Block, ClientAction, ServerAction, ServiceAction, Type }
public enum NativeRecordKind { Structure, Entity }

/// <summary>SourceSymbol is qualified by its source scope (for example file.html::Component::alias).
/// Operational keys are supplied by the controller, never by source imports.</summary>
public sealed record NativeDependencyRequirement(string SourceSymbol, [property: JsonRequired] NativeDependencyKind Kind,
    string ProducerName, string OriginalElementPath);

/// <summary>Provenance advertised by a trusted controller. This pure descriptor performs no acquisition
/// or signature attestation. Keys must already use the adapter's canonical representation.</summary>
public sealed record NativeDependencyProducer(string Binding, string Environment, string ProducerKey,
    string ProducerName, string ReferenceKind, string ModuleType, int PublishedVersion,
    string SignatureHash, string SignatureFileSha256);

[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(NativePrimitive), "primitive")]
[JsonDerivedType(typeof(NativeIdentifier), "identifier")]
[JsonDerivedType(typeof(NativeList), "list")]
[JsonDerivedType(typeof(NativeRecord), "record")]
public abstract record NativeType;
public sealed record NativePrimitive(string Name) : NativeType;
public sealed record NativeIdentifier(string TargetGlobalKey, string StoragePrimitive) : NativeType;
public sealed record NativeList(NativeType Element) : NativeType;
public sealed record NativeRecord(string GlobalKey) : NativeType;

public sealed record NativeParameter(string Name, NativeType Type, [property: JsonRequired] bool Mandatory = false,
    string? DefaultExpression = null, string? OriginalKey = null);
public sealed record NativeField(string Name, NativeType Type, string OriginalKey);

/// <summary>GlobalKey is opaque native identity, not the syntax of NativeReference. Entity definitions
/// carry their identifier's storage primitive so an identifier cannot silently change meaning.</summary>
public sealed record NativeRecordDefinition(string GlobalKey, string Name, [property: JsonRequired] NativeRecordKind NativeKind,
    string NativeReference, IReadOnlyList<NativeField> OrderedFields, string? IdentifierStoragePrimitive = null);
public sealed record NativeEvent(string Name, string OriginalKey, [property: JsonRequired] bool Mandatory,
    IReadOnlyList<NativeParameter> OrderedInputs);
public sealed record NativePlaceholder(string Name, string OriginalKey);

/// <summary>Optional versioned codec metadata. Its payload is opaque here and always returned as a copy.
/// Absence conveys only native signatures; structure names never imply a source-language ABI.</summary>
public sealed class NativeSourceAbi
{
    private readonly JsonObject payload;
    public string Id { get; }
    public int Version { get; }
    public JsonObject Payload => payload.DeepClone().AsObject();
    public NativeSourceAbi(string id, int version, JsonObject payload)
    {
        Id = NativeDependencyCatalog.Text(id, "source ABI id");
        if (version <= 0) throw new ArgumentException("Source ABI version must be positive");
        Version = version;
        ArgumentNullException.ThrowIfNull(payload);
        this.payload = payload.DeepClone().AsObject();
    }
}

public sealed record NativeDependencyBinding(NativeDependencyRequirement Requirement, string ProducerBinding,
    string OriginalElementKey, string NativeReference,
    IReadOnlyList<NativeParameter> OrderedInputs, IReadOnlyList<NativeParameter> OrderedOutputs,
    IReadOnlyDictionary<string, NativeRecordDefinition> ReachableTypes,
    IReadOnlyList<NativeEvent> Events, IReadOnlyList<NativePlaceholder> Placeholders,
    NativeSourceAbi? SourceAbi = null);

/// <summary>Immutable, pure catalog derived from frozen native signatures by a trusted controller.
/// Validates consistency and complete type closure, not signature bytes, runtime compatibility,
/// published behavior or codec support. It never loads SDK assemblies or accesses files/network.</summary>
public sealed class NativeDependencyCatalog
{
    public const int CurrentFormatVersion = 1;
    public int FormatVersion => CurrentFormatVersion;
    public IReadOnlyList<NativeDependencyProducer> Producers { get; }
    public IReadOnlyList<NativeDependencyBinding> Bindings { get; }
    private readonly IReadOnlyDictionary<string, NativeDependencyBinding> bySourceSymbol;
    public string Fingerprint => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(ToJson().ToJsonString()))).ToLowerInvariant();

    public NativeDependencyCatalog(IEnumerable<NativeDependencyProducer> producers, IEnumerable<NativeDependencyBinding> bindings)
    {
        ArgumentNullException.ThrowIfNull(producers); ArgumentNullException.ThrowIfNull(bindings);
        Producers = Array.AsReadOnly(producers.Select(CopyProducer).OrderBy(p => p.Binding, StringComparer.Ordinal).ToArray());
        Bindings = Array.AsReadOnly(bindings.Select(CopyBinding).OrderBy(b => b.Requirement.SourceSymbol, StringComparer.Ordinal).ToArray());
        Unique(Producers, p => p.Binding, "producer binding", StringComparer.OrdinalIgnoreCase);
        Unique(Producers, p => p.ProducerKey, "producer identity");
        Unique(Producers, p => p.ProducerName, "producer name", StringComparer.OrdinalIgnoreCase);
        Unique(Bindings, b => b.Requirement.SourceSymbol, "source symbol");
        if (Producers.Select(p => p.Environment).Distinct(StringComparer.OrdinalIgnoreCase).Skip(1).Any())
            throw new ArgumentException("A native catalog cannot mix producer environments");
        ValidateBindings();
        bySourceSymbol = new ReadOnlyDictionary<string, NativeDependencyBinding>(Bindings.ToDictionary(b => b.Requirement.SourceSymbol, StringComparer.Ordinal));
    }

    public NativeDependencyBinding Resolve(NativeDependencyRequirement requirement)
    {
        var expected = CopyRequirement(requirement);
        if (!bySourceSymbol.TryGetValue(expected.SourceSymbol, out var found))
            throw new KeyNotFoundException("Unresolved native source symbol: " + expected.SourceSymbol);
        if (found.Requirement != expected)
            throw new ArgumentException("Native source symbol belongs to a different requirement: " + expected.SourceSymbol);
        return found;
    }

    public JsonObject ToJson() => Canonical(JsonSerializer.SerializeToNode(
        new Document(CurrentFormatVersion, Producers, Bindings), JsonOptions)!)!.AsObject();

    public static NativeDependencyCatalog FromJson(JsonObject document)
    {
        ArgumentNullException.ThrowIfNull(document);
        var parsed = document.Deserialize<Document>(JsonOptions) ?? throw new ArgumentException("Empty native catalog");
        if (parsed.FormatVersion != CurrentFormatVersion) throw new ArgumentException("Unsupported native catalog format version");
        return new(parsed.Producers, parsed.Bindings);
    }

    private void ValidateBindings()
    {
        var producers = Producers.ToDictionary(p => p.Binding, StringComparer.Ordinal);
        var producerKeys = Producers.ToDictionary(p => p.ProducerKey, StringComparer.Ordinal);

        var definitions = new Dictionary<string, string>(StringComparer.Ordinal);
        var nativeTypes = new Dictionary<string, string>(StringComparer.Ordinal);
        var elementKinds = new Dictionary<string, string>(StringComparer.Ordinal);
        var exports = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var aliases = new Dictionary<string, string>(StringComparer.Ordinal);
        var originalPaths = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var binding in Bindings)
        {
            if (!producers.TryGetValue(binding.ProducerBinding, out var producer))
                throw new ArgumentException("Unknown producer binding: " + binding.ProducerBinding);
            if (binding.Requirement.ProducerName != producer.ProducerName)
                throw new ArgumentException("Requirement producer name differs from its frozen producer: " + binding.Requirement.SourceSymbol);
            var target = ParseReference(binding.NativeReference);
            if (target.Producer != producer.ProducerKey || target.Element != binding.OriginalElementKey || !AllowedReference(binding.Requirement.Kind, target.Type))
                throw new ArgumentException("Native reference differs from the required kind or original identity: " + binding.Requirement.SourceSymbol);

            Consistent(elementKinds, target.Producer + "/" + target.Element, target.Type, "native element kind");
            Consistent(exports, producer.ProducerKey + ":" + binding.Requirement.Kind + ":" + binding.Requirement.OriginalElementPath,
                binding.NativeReference, "native export path");
            Consistent(aliases, binding.NativeReference, BindingSignature(binding), "alias signature");
            Consistent(originalPaths, binding.NativeReference, binding.Requirement.OriginalElementPath, "original element path");
            foreach (var pair in binding.ReachableTypes)
            {
                var definition = pair.Value;
                if (pair.Key != definition.GlobalKey) throw new ArgumentException("Type dictionary key differs from its global identity: " + pair.Key);
                var identity = ParseReference(definition.NativeReference);
                if (!producerKeys.TryGetValue(identity.Producer, out var typeProducer))
                    throw new ArgumentException("Type closure uses an unknown producer: " + definition.NativeReference);
                if (identity.Type != (definition.NativeKind == NativeRecordKind.Structure ? "IStructureSignature" : "IEntitySignature"))
                    throw new ArgumentException("Named type native kind differs from its reference: " + definition.GlobalKey);

                Consistent(elementKinds, identity.Producer + "/" + identity.Element, identity.Type, "native element kind");
                Consistent(definitions, definition.GlobalKey, Serialize(definition), "global type schema");
                Consistent(nativeTypes, definition.NativeReference, definition.GlobalKey, "native type identity");
            }
            ValidateClosure(binding);
        }
        // Signature closure can require auxiliary producers absent from the source-visible type graph.
    }

    private static void ValidateClosure(NativeDependencyBinding binding)
    {
        var visited = new HashSet<string>(StringComparer.Ordinal);
        void VisitType(NativeType type)
        {
            switch (type)
            {
                case NativeList list: VisitType(list.Element); break;
                case NativeRecord record: VisitRecord(record.GlobalKey); break;
                case NativeIdentifier identifier:
                    var entity = VisitRecord(identifier.TargetGlobalKey);
                    if (entity.NativeKind != NativeRecordKind.Entity || entity.IdentifierStoragePrimitive != identifier.StoragePrimitive)
                        throw new ArgumentException("Identifier target or storage primitive differs: " + identifier.TargetGlobalKey);
                    break;
            }
        }
        NativeRecordDefinition VisitRecord(string globalKey)
        {
            if (!binding.ReachableTypes.TryGetValue(globalKey, out var definition))
                throw new ArgumentException("Incomplete native type closure: " + globalKey);
            if (visited.Add(globalKey)) foreach (var field in definition.OrderedFields) VisitType(field.Type);
            return definition;
        }
        foreach (var parameter in binding.OrderedInputs.Concat(binding.OrderedOutputs).Concat(binding.Events.SelectMany(e => e.OrderedInputs)))
            VisitType(parameter.Type);
        if (binding.Requirement.Kind == NativeDependencyKind.Type)
        {
            var roots = binding.ReachableTypes.Values.Where(d => d.NativeReference == binding.NativeReference).ToArray();
            if (roots.Length != 1) throw new ArgumentException("A type import must have exactly one matching root definition");
            VisitRecord(roots[0].GlobalKey);
        }
        if (visited.Count != binding.ReachableTypes.Count) throw new ArgumentException("Unreachable definitions in native type closure");
    }

    private static NativeDependencyProducer CopyProducer(NativeDependencyProducer p)
    {
        ArgumentNullException.ThrowIfNull(p);
        var kind = Text(p.ReferenceKind, "reference kind");
        if (kind is not ("eSpace" or "Extension")) throw new ArgumentException("Unknown native reference kind: " + kind);
        var moduleType = Text(p.ModuleType, "module type");
        if (!ModuleTypes.Contains(moduleType) || moduleType == "Unknown" && kind != "Extension")
            throw new ArgumentException("Unknown native module type: " + moduleType);
        if (p.PublishedVersion <= 0) throw new ArgumentException("Native published version must be positive");
        if (!Guid.TryParse(p.SignatureHash, out var signatureHash) || signatureHash == Guid.Empty)
            throw new ArgumentException("Invalid native signature hash");
        if (p.SignatureFileSha256 == null || !Regex.IsMatch(p.SignatureFileSha256, "^[a-fA-F0-9]{64}$"))
            throw new ArgumentException("Invalid native signature file SHA-256");
        return new(Name(p.Binding), Text(p.Environment, "environment"), Key(p.ProducerKey), Text(p.ProducerName, "producer name"),
            kind, moduleType, p.PublishedVersion, signatureHash.ToString("D"), p.SignatureFileSha256.ToLowerInvariant());
    }

    private static NativeDependencyRequirement CopyRequirement(NativeDependencyRequirement r)
    {
        ArgumentNullException.ThrowIfNull(r);
        if (!Enum.IsDefined(r.Kind)) throw new ArgumentException("Unknown native dependency kind");
        var symbol = Text(r.SourceSymbol, "source symbol");
        if (symbol.Split("::", StringSplitOptions.None) is not { Length: >= 2 } segments || segments.Any(string.IsNullOrWhiteSpace))
            throw new ArgumentException("Native source symbol must be qualified by its source scope");
        var path = Text(r.OriginalElementPath, "original element path");
        var parts = path.Split('/');
        if (parts.Length != (r.Kind == NativeDependencyKind.Block ? 2 : 1) || parts.Any(p => p is "." or ".." || string.IsNullOrWhiteSpace(p)))
            throw new ArgumentException("Native element path must name an export, or Flow/Block for a block");
        return new(symbol, r.Kind, Text(r.ProducerName, "producer name"), path);
    }

    private static NativeDependencyBinding CopyBinding(NativeDependencyBinding b)
    {
        ArgumentNullException.ThrowIfNull(b); ArgumentNullException.ThrowIfNull(b.ReachableTypes);
        var requirement = CopyRequirement(b.Requirement);
        var definitions = new Dictionary<string, NativeRecordDefinition>(StringComparer.Ordinal);
        foreach (var pair in b.ReachableTypes.OrderBy(p => p.Key, StringComparer.Ordinal))
        {
            var d = pair.Value; ArgumentNullException.ThrowIfNull(d);
            if (!Enum.IsDefined(d.NativeKind)) throw new ArgumentException("Unknown native record kind");
            var fields = CopyList(d.OrderedFields, f => { ArgumentNullException.ThrowIfNull(f); return new NativeField(Name(f.Name), CopyType(f.Type), Key(f.OriginalKey)); });
            Unique(fields, f => f.Name, "field name", StringComparer.OrdinalIgnoreCase); Unique(fields, f => f.OriginalKey, "field identity");
            if (d.NativeKind == NativeRecordKind.Entity && d.IdentifierStoragePrimitive == null || d.NativeKind == NativeRecordKind.Structure && d.IdentifierStoragePrimitive != null)
                throw new ArgumentException("Only an entity must declare identifier storage primitive");
            definitions.Add(Text(pair.Key, "global type key"), new(Text(d.GlobalKey, "global type key"), Name(d.Name), d.NativeKind,
                Text(d.NativeReference, "native type reference"), fields, d.IdentifierStoragePrimitive == null ? null : Primitive(d.IdentifierStoragePrimitive)));
        }
        var inputs = CopyParameters(b.OrderedInputs); var outputs = CopyParameters(b.OrderedOutputs);
        var events = CopyList(b.Events, e => { ArgumentNullException.ThrowIfNull(e); return new NativeEvent(Name(e.Name), Key(e.OriginalKey), e.Mandatory, CopyParameters(e.OrderedInputs)); });
        var placeholders = CopyList(b.Placeholders, p => { ArgumentNullException.ThrowIfNull(p); return new NativePlaceholder(Name(p.Name), Key(p.OriginalKey)); });
        Unique(events, e => e.Name, "event name", StringComparer.OrdinalIgnoreCase); Unique(events, e => e.OriginalKey, "event identity");
        Unique(placeholders, p => p.Name, "placeholder name", StringComparer.OrdinalIgnoreCase); Unique(placeholders, p => p.OriginalKey, "placeholder identity");
        if (requirement.Kind != NativeDependencyKind.Block && (events.Count > 0 || placeholders.Count > 0))
            throw new ArgumentException("Only block imports can declare events or placeholders");
        if (requirement.Kind == NativeDependencyKind.Type && (inputs.Count > 0 || outputs.Count > 0))
            throw new ArgumentException("A type import cannot declare action parameters");
        return new(requirement, Name(b.ProducerBinding), Key(b.OriginalElementKey), Text(b.NativeReference, "native reference"), inputs, outputs,
            new ReadOnlyDictionary<string, NativeRecordDefinition>(definitions), events, placeholders,
            b.SourceAbi == null ? null : new(b.SourceAbi.Id, b.SourceAbi.Version, b.SourceAbi.Payload));
    }

    private static IReadOnlyList<NativeParameter> CopyParameters(IReadOnlyList<NativeParameter> parameters)
    {
        var result = CopyList(parameters, p => { ArgumentNullException.ThrowIfNull(p); return new NativeParameter(Name(p.Name), CopyType(p.Type), p.Mandatory,
            p.DefaultExpression, p.OriginalKey == null ? null : Key(p.OriginalKey)); });
        Unique(result, p => p.Name, "parameter name", StringComparer.OrdinalIgnoreCase);
        Unique(result.Where(p => p.OriginalKey != null), p => p.OriginalKey!, "parameter identity");
        return result;
    }
    private static NativeType CopyType(NativeType type, int depth = 0)
    {
        if (depth > 64) throw new ArgumentException("Native list type nesting exceeds 64 levels");
        return type switch {
            NativePrimitive p => new NativePrimitive(Primitive(p.Name)),
            NativeIdentifier i => new NativeIdentifier(Text(i.TargetGlobalKey, "identifier target global key"), Primitive(i.StoragePrimitive)),
            NativeRecord r => new NativeRecord(Text(r.GlobalKey, "record global key")),
            NativeList l => new NativeList(CopyType(l.Element, depth + 1)),
            _ => throw new ArgumentException("Null or unsupported native type")
        };
    }

    private static (string Type, string Producer, string Element) ParseReference(string reference)
    {
        var parts = reference.Split(":@", StringSplitOptions.None);
        var keys = parts.Length == 2 ? parts[1].Split('/') : [];
        if (keys.Length != 2) throw new ArgumentException("Expected native Type:@producerKey/originalElementKey");
        return (parts[0], Key(keys[0]), Key(keys[1]));
    }
    private static bool AllowedReference(NativeDependencyKind kind, string type) => kind switch {
        NativeDependencyKind.Block => type is "IMobileBlockSignature" or "IWebBlockSignature",
        NativeDependencyKind.ClientAction => type == "IClientActionSignature",
        NativeDependencyKind.ServerAction => type == "IServerActionSignature",
        NativeDependencyKind.ServiceAction => type == "IServiceActionSignature",
        NativeDependencyKind.Type => type is "IStructureSignature" or "IEntitySignature",
        _ => false
    };
    private static string BindingSignature(NativeDependencyBinding b) => Serialize(new {
        b.OrderedInputs, b.OrderedOutputs, b.ReachableTypes, b.Events, b.Placeholders, b.SourceAbi
    });
    private static string Serialize<T>(T value) => Canonical(JsonSerializer.SerializeToNode(value, JsonOptions))!.ToJsonString();
    private static JsonNode? Canonical(JsonNode? node) => node switch {
        JsonObject obj => new JsonObject(obj.OrderBy(p => p.Key == "kind" ? 0 : 1).ThenBy(p => p.Key, StringComparer.Ordinal).Select(p => KeyValuePair.Create(p.Key, Canonical(p.Value)))),
        JsonArray array => new JsonArray(array.Select(Canonical).ToArray()),
        _ => node?.DeepClone()
    };
    private static IReadOnlyList<TOut> CopyList<TIn, TOut>(IReadOnlyList<TIn> items, Func<TIn, TOut> copy)
    { ArgumentNullException.ThrowIfNull(items); return Array.AsReadOnly(items.Select(copy).ToArray()); }
    private static void Unique<T>(IEnumerable<T> values, Func<T, string> key, string kind, StringComparer? comparer = null)
    {
        var found = new HashSet<string>(comparer ?? StringComparer.Ordinal);
        foreach (var value in values) if (!found.Add(key(value))) throw new ArgumentException("Ambiguous native " + kind + ": " + key(value));
    }
    private static void Consistent(Dictionary<string, string> values, string key, string value, string kind)
    {
        if (values.TryGetValue(key, out var previous) && previous != value) throw new ArgumentException("Conflicting " + kind + ": " + key);
        values[key] = value;
    }
    internal static string Text(string value, string kind) => !string.IsNullOrWhiteSpace(value) && value == value.Trim() && !value.Any(char.IsControl)
        ? value : throw new ArgumentException("Invalid native " + kind);
    private static string Name(string value) => Regex.IsMatch(Text(value, "name"), "^[A-Za-z_][A-Za-z0-9_]*$")
        ? value : throw new ArgumentException("Invalid native name: " + value);
    private static string Key(string value) => Text(value, "identity").IndexOfAny(['/', ':', '@']) < 0
        && !value.Any(char.IsWhiteSpace) ? value : throw new ArgumentException("Native keys must use canonical key tokens");
    private static string Primitive(string value) => PrimitiveNames.Contains(value)
        ? value : throw new ArgumentException("Unknown native primitive: " + value);
    private static readonly HashSet<string> PrimitiveNames = new(StringComparer.Ordinal) {
        "Text", "Integer", "Long Integer", "Decimal", "Boolean", "Date", "Time", "Date Time", "Currency", "Email", "Phone Number", "Binary Data", "Object"
    };
    private static readonly HashSet<string> ModuleTypes = new(StringComparer.Ordinal) {
        "WebResponsive", "Mobile", "Service", "Unknown", "CrossDevice", "MobileLibrary", "ReactiveLibrary", "WebResponsiveLibrary"
    };
    private static readonly JsonSerializerOptions JsonOptions = new() {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false) }
    };
    private sealed record Document(int FormatVersion, IReadOnlyList<NativeDependencyProducer> Producers, IReadOnlyList<NativeDependencyBinding> Bindings);
}
