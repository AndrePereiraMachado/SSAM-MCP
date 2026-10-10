using System.Collections.ObjectModel;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.CSharp;

namespace Anvil.Core.Delivery;

public sealed record FrameworkRuntimePackage(string Id, string Revision, string ArtifactSha256, string? ArtifactPath = null);
public sealed record FrameworkProducerSnapshot(string Binding, string Path, string Sha256, string ProducerKey, string SignatureHash);
public sealed record FrameworkIntrinsicBinding(string Reference, string ProducerBinding, string ElementName,
    string OriginalElementKey, IReadOnlyList<IntrinsicParameter> Inputs, IntrinsicParameter Output);

/// <summary>
/// Task-owned choices made by a trusted controller, never an author-supplied binding manifest.
/// Package provenance and the supplied expected ABI must already have been verified by that controller.
/// This lock checks their consistency and frozen signature files; an interface hash does not attest
/// executable package contents or prove the behavior of the published implementation.
/// </summary>
public sealed class FrozenFrameworkDependencies
{
    public int FormatVersion => 1;
    public string SourceHash { get; }
    public string RequirementsHash { get; }
    public string Environment { get; }
    public string ModuleKey { get; }
    public FrameworkRuntimePackage Package { get; }
    public IReadOnlyList<FrameworkIntrinsic> Requirements { get; }
    public IReadOnlyList<FrameworkProducerSnapshot> Producers { get; }
    public IReadOnlyList<FrameworkIntrinsicBinding> Bindings { get; }
    public string Fingerprint => DurableJson.Hash(ToJson().ToJsonString());

    private FrozenFrameworkDependencies(string sourceHash, IEnumerable<FrameworkIntrinsic> requirements,
        string environment, string moduleKey, FrameworkRuntimePackage package,
        IEnumerable<FrameworkProducerSnapshot> producers, IEnumerable<FrameworkIntrinsicBinding> bindings)
    {
        SourceHash = Sha(sourceHash, "source hash");
        Environment = Text(environment, "environment"); ModuleKey = Key(moduleKey);
        ArgumentNullException.ThrowIfNull(package);
        Package = CopyPackage(package);
        Requirements = CopyRequirements(requirements);
        RequirementsHash = DurableJson.Hash(RequirementsJson(Requirements).ToJsonString());
        ArgumentNullException.ThrowIfNull(producers); ArgumentNullException.ThrowIfNull(bindings);
        Producers = Array.AsReadOnly(producers.Select(p => p == null ? throw new ArgumentException("Null producer") : new FrameworkProducerSnapshot(
            Name(p.Binding), Absolute(p.Path), Sha(p.Sha256, "snapshot SHA-256"), Key(p.ProducerKey), SignatureHash(p.SignatureHash)))
            .OrderBy(p => p.Binding, StringComparer.Ordinal).ToArray());
        Bindings = Array.AsReadOnly(bindings.Select(b => b == null ? throw new ArgumentException("Null intrinsic binding") : new FrameworkIntrinsicBinding(
            Text(b.Reference, "intrinsic reference"), Name(b.ProducerBinding), Name(b.ElementName), Key(b.OriginalElementKey),
            Parameters(b.Inputs), Parameter(b.Output))).OrderBy(b => b.Reference, StringComparer.Ordinal).ToArray());
        ValidateShape(); ValidateArtifacts();
    }

    public static FrozenFrameworkDependencies Create(string sourceHash, IEnumerable<FrameworkIntrinsic> requirements,
        string environment, string moduleKey, FrameworkRuntimePackage package,
        IEnumerable<FrameworkProducerSnapshot> producers, IEnumerable<FrameworkIntrinsicBinding> bindings)
        => new(sourceHash, requirements, environment, moduleKey, package, producers, bindings);

    /// <summary>Compare trusted accepted inputs before reusing a persisted lock; never reselect providers.</summary>
    public void ValidateReuse(string sourceHash, IEnumerable<FrameworkIntrinsic> requirements,
        string environment, string moduleKey, FrameworkRuntimePackage package)
    {
        ArgumentNullException.ThrowIfNull(package);
        ValidateRequirements(sourceHash, requirements);
        if (!Environment.Equals(Text(environment, "environment"), StringComparison.OrdinalIgnoreCase) || ModuleKey != Key(moduleKey))
            throw new InvalidOperationException("Frozen dependencies belong to another target environment/module");
        if (Package != CopyPackage(package))
            throw new InvalidOperationException("Frozen runtime package identity, revision or artifact changed");
        ValidateArtifacts();
    }

    public void ValidateRequirements(string sourceHash, IEnumerable<FrameworkIntrinsic> requirements)
    {
        if (SourceHash != Sha(sourceHash, "source hash")) throw new InvalidOperationException("Frozen dependencies belong to another source revision");
        if (RequirementsHash != DurableJson.Hash(RequirementsJson(CopyRequirements(requirements)).ToJsonString()))
            throw new InvalidOperationException("Frozen intrinsic requirements changed");
    }

    public void ValidateArtifacts() => _ = NativeTargets();

    public IReadOnlyDictionary<string, string> ProducerBindings()
    {
        ValidateArtifacts();
        return new ReadOnlyDictionary<string, string>(Producers.ToDictionary(p => p.Binding, p => p.Path, StringComparer.OrdinalIgnoreCase));
    }

    /// <summary>Prefix these ordinary reference ops before every generated model edit.</summary>
    public JsonArray ReferenceOperations()
    {
        ValidateArtifacts();
        return new JsonArray(Producers.Select(p => (JsonNode)new JsonObject {
            ["op"] = "reference", ["producer"] = p.Binding,
            ["elements"] = new JsonArray(Bindings.Where(b => b.ProducerBinding == p.Binding).Select(b => "IServerActionSignature:" + b.ElementName)
                .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).Select(s => (JsonNode)JsonValue.Create(s)!).ToArray())
        }).ToArray());
    }

    public IReadOnlyDictionary<string, string> CallBindings() => new ReadOnlyDictionary<string, string>(NativeTargets());

    // Keep vendor model types out of the pure delivery caller's JIT dependencies.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private Dictionary<string, string> NativeTargets()
    {
        if (Package.ArtifactPath is { } artifact && (!File.Exists(artifact) || DeliveryReceipt.Hash(artifact) != Package.ArtifactSha256))
            throw new InvalidOperationException("Frozen runtime package artifact changed or is missing");
        var targets = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var producer in Producers)
        {
            RequireFile(producer);
            var snapshot = NativeReferenceSnapshot.Read(producer.Path);
            snapshot.RequireEnvironment(Environment);
            if (Key(snapshot.ModuleKey) != producer.ProducerKey || snapshot.SignatureHash.ToString("D") != producer.SignatureHash)
                throw new InvalidOperationException("Frozen producer identity/signature changed: " + producer.Binding);
            foreach (var binding in Bindings.Where(b => b.ProducerBinding == producer.Binding))
            {
                var reference = "IServerActionSignature:" + binding.ElementName;
                if (Key(snapshot.Select(reference).Key) != binding.OriginalElementKey)
                    throw new InvalidOperationException("Frozen original action identity differs: " + binding.Reference);
                targets.Add(binding.Reference, snapshot.Bind(reference));
            }
            RequireFile(producer);
        }
        return targets;
    }

    private static void RequireFile(FrameworkProducerSnapshot producer)
    {
        if (!File.Exists(producer.Path) || DeliveryReceipt.Hash(producer.Path) != producer.Sha256)
            throw new InvalidOperationException("Frozen producer snapshot changed or is missing: " + producer.Binding);
    }

    private void ValidateShape()
    {
        if (Producers.Select(p => p.Binding).Distinct(StringComparer.OrdinalIgnoreCase).Count() != Producers.Count ||
            Producers.Select(p => p.ProducerKey).Distinct(StringComparer.Ordinal).Count() != Producers.Count ||
            Producers.Select(p => p.Path).Distinct(StringComparer.OrdinalIgnoreCase).Count() != Producers.Count)
            throw new ArgumentException("Frozen producers must have distinct bindings, identities and files");
        var expected = Requirements.ToDictionary(r => r.Reference, StringComparer.Ordinal);
        if (Bindings.Select(b => b.Reference).Distinct(StringComparer.Ordinal).Count() != Bindings.Count ||
            Bindings.Count != expected.Count || Bindings.Any(b => !expected.ContainsKey(b.Reference)))
            throw new ArgumentException("Intrinsic bindings must match every requirement exactly once, without extras");
        foreach (var binding in Bindings)
        {
            if (!Producers.Any(p => p.Binding == binding.ProducerBinding)) throw new ArgumentException("Unknown producer binding: " + binding.ProducerBinding);
            var requirement = expected[binding.Reference];
            if (!binding.Inputs.SequenceEqual(requirement.Inputs) || binding.Output != requirement.Output)
                throw new ArgumentException("Expected native ABI differs from the intrinsic requirement: " + binding.Reference);
        }
        if (Producers.Any(p => !Bindings.Any(b => b.ProducerBinding == p.Binding))) throw new ArgumentException("Unused frozen producer");
    }

    public JsonObject ToJson() => new() {
        ["formatVersion"] = FormatVersion, ["sourceHash"] = SourceHash, ["requirementsHash"] = RequirementsHash,
        ["environment"] = Environment, ["moduleKey"] = ModuleKey,
        ["package"] = PackageJson(),
        ["requirements"] = RequirementsJson(Requirements),
        ["producers"] = new JsonArray(Producers.Select(p => (JsonNode)new JsonObject {
            ["binding"] = p.Binding, ["path"] = p.Path, ["sha256"] = p.Sha256, ["producerKey"] = p.ProducerKey, ["signatureHash"] = p.SignatureHash }).ToArray()),
        ["bindings"] = new JsonArray(Bindings.Select(b => (JsonNode)new JsonObject {
            ["reference"] = b.Reference, ["producerBinding"] = b.ProducerBinding, ["elementName"] = b.ElementName,
            ["originalElementKey"] = b.OriginalElementKey, ["expectedInputs"] = ParametersJson(b.Inputs), ["expectedOutput"] = ParameterJson(b.Output) }).ToArray())
    };

    public static FrozenFrameworkDependencies FromJson(JsonObject document, string? expectedFingerprint = null)
    {
        Fields(document, "formatVersion", "sourceHash", "requirementsHash", "environment", "moduleKey", "package", "requirements", "producers", "bindings");
        if (document["formatVersion"]!.GetValue<int>() != 1) throw new ArgumentException("Unsupported frozen dependency lock version");
        var package = document["package"]!.AsObject(); Fields(package, package.ContainsKey("artifactPath") ? ["id", "revision", "artifactSha256", "artifactPath"] : ["id", "revision", "artifactSha256"]);
        var requirements = Objects(document, "requirements").Select(r => {
            Fields(r, "id", "version", "inputs", "output");
            return new FrameworkIntrinsic(Value(r, "id"), r["version"]!.GetValue<int>(), ReadParameters(r, "inputs"), ReadParameter(r["output"]!.AsObject()));
        }).ToArray();
        var producers = Objects(document, "producers").Select(p => {
            Fields(p, "binding", "path", "sha256", "producerKey", "signatureHash");
            return new FrameworkProducerSnapshot(Value(p, "binding"), Value(p, "path"), Value(p, "sha256"), Value(p, "producerKey"), Value(p, "signatureHash"));
        }).ToArray();
        var bindings = Objects(document, "bindings").Select(b => {
            Fields(b, "reference", "producerBinding", "elementName", "originalElementKey", "expectedInputs", "expectedOutput");
            return new FrameworkIntrinsicBinding(Value(b, "reference"), Value(b, "producerBinding"), Value(b, "elementName"), Value(b, "originalElementKey"),
                ReadParameters(b, "expectedInputs"), ReadParameter(b["expectedOutput"]!.AsObject()));
        }).ToArray();
        var result = Create(Value(document, "sourceHash"), requirements, Value(document, "environment"), Value(document, "moduleKey"),
            new(Value(package, "id"), Value(package, "revision"), Value(package, "artifactSha256"), package["artifactPath"]?.GetValue<string>()), producers, bindings);
        if (result.RequirementsHash != Sha(Value(document, "requirementsHash"), "requirements hash")) throw new InvalidOperationException("Frozen requirement hash differs");
        if (expectedFingerprint != null && result.Fingerprint != Sha(expectedFingerprint, "lock fingerprint")) throw new InvalidOperationException("Frozen dependency lock changed");
        return result;
    }

    public static FrozenFrameworkDependencies Read(string path, string? expectedFingerprint = null)
    {
        var text = File.ReadAllText(path);
        using var parsed = JsonDocument.Parse(text);
        UniqueProperties(parsed.RootElement);
        return FromJson(JsonNode.Parse(text)!.AsObject(), expectedFingerprint);
    }

    /// <summary>Create a lock, or verify the same lock already exists. Different choices cannot overwrite it.</summary>
    public void Write(string path)
    {
        path = Path.GetFullPath(path); Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using var lease = DurableJson.Lease(path + ".lock");
        ValidateArtifacts();
        if (File.Exists(path)) { _ = Read(path, Fingerprint); return; }
        DurableJson.WriteBytes(path, Encoding.UTF8.GetBytes(ToJson().ToJsonString(new JsonSerializerOptions { WriteIndented = true })));
    }

    private JsonObject PackageJson()
    {
        var result = new JsonObject { ["id"] = Package.Id, ["revision"] = Package.Revision, ["artifactSha256"] = Package.ArtifactSha256 };
        if (Package.ArtifactPath != null) result["artifactPath"] = Package.ArtifactPath;
        return result;
    }
    private static FrameworkRuntimePackage CopyPackage(FrameworkRuntimePackage package)
    {
        var path = package.ArtifactPath;
        if (path != null && !Path.IsPathFullyQualified(path)) throw new ArgumentException("Package artifacts require an absolute path");
        return new(Text(package.Id, "package identity"), Text(package.Revision, "package revision"),
            Sha(package.ArtifactSha256, "package artifact SHA-256"), path == null ? null : Path.GetFullPath(path));
    }
    private static IReadOnlyList<FrameworkIntrinsic> CopyRequirements(IEnumerable<FrameworkIntrinsic> requirements)
    {
        ArgumentNullException.ThrowIfNull(requirements);
        var copy = requirements.Select(r => {
            if (r == null || r.Id == null || r.Version <= 0 || !Regex.IsMatch(r.Id, @"^[A-Za-z_][A-Za-z0-9_.]*$")) throw new ArgumentException("Invalid intrinsic identity/version");
            return new FrameworkIntrinsic(r.Id, r.Version, Parameters(r.Inputs), Parameter(r.Output));
        }).OrderBy(r => r.Reference, StringComparer.Ordinal).ToArray();
        if (copy.Select(r => r.Reference).Distinct(StringComparer.Ordinal).Count() != copy.Length) throw new ArgumentException("Duplicate intrinsic requirement");
        return Array.AsReadOnly(copy);
    }
    private static IReadOnlyList<IntrinsicParameter> Parameters(IEnumerable<IntrinsicParameter> inputs)
    {
        ArgumentNullException.ThrowIfNull(inputs); var copy = inputs.Select(Parameter).ToArray();
        if (copy.Select(p => p.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count() != copy.Length) throw new ArgumentException("Duplicate intrinsic input name");
        return Array.AsReadOnly(copy);
    }
    private static IntrinsicParameter Parameter(IntrinsicParameter parameter)
    {
        ArgumentNullException.ThrowIfNull(parameter);
        return new(Name(parameter.Name), Text(parameter.Type, "intrinsic parameter type"));
    }
    private static JsonArray RequirementsJson(IEnumerable<FrameworkIntrinsic> requirements) => new(requirements.Select(r => (JsonNode)new JsonObject {
        ["id"] = r.Id, ["version"] = r.Version, ["inputs"] = ParametersJson(r.Inputs), ["output"] = ParameterJson(r.Output) }).ToArray());
    private static JsonArray ParametersJson(IEnumerable<IntrinsicParameter> parameters) => new(parameters.Select(p => (JsonNode)ParameterJson(p)).ToArray());
    private static JsonObject ParameterJson(IntrinsicParameter parameter) => new() { ["name"] = parameter.Name, ["type"] = parameter.Type };
    private static IReadOnlyList<IntrinsicParameter> ReadParameters(JsonObject obj, string key) => Objects(obj, key).Select(ReadParameter).ToArray();
    private static IntrinsicParameter ReadParameter(JsonObject parameter) { Fields(parameter, "name", "type"); return new(Value(parameter, "name"), Value(parameter, "type")); }
    private static IEnumerable<JsonObject> Objects(JsonObject obj, string key) => obj[key]!.AsArray().Select(n => n?.AsObject() ?? throw new ArgumentException("Null entry in " + key));
    private static string Value(JsonObject obj, string key) => obj[key]!.GetValue<string>();
    private static void Fields(JsonObject obj, params string[] fields)
    {
        if (obj.Count != fields.Length || obj.Any(p => p.Value == null || !fields.Contains(p.Key, StringComparer.Ordinal))) throw new ArgumentException("Missing, null or unknown frozen dependency fields");
    }
    private static string Text(string value, string field) => !string.IsNullOrWhiteSpace(value) && value == value.Trim() ? value : throw new ArgumentException("Invalid " + field);
    private static string Name(string value) => value != null && JobSources.IsBindingName(value) ? value : throw new ArgumentException("Invalid dependency or parameter name");
    private static string Sha(string value, string field) => value != null && Regex.IsMatch(value, "^[0-9a-fA-F]{64}$") ? value.ToLowerInvariant() : throw new ArgumentException("Invalid " + field);
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static string Key(string value) => Keys.ToStudio(Text(value, "object key"));
    private static string SignatureHash(string value) => Guid.TryParse(value, out var hash) && hash != Guid.Empty ? hash.ToString("D") : throw new ArgumentException("Invalid producer signature hash");
    private static string Absolute(string path) => Path.IsPathFullyQualified(path) && Path.GetExtension(path).Equals(".avsig", StringComparison.OrdinalIgnoreCase)
        ? Path.GetFullPath(path) : throw new ArgumentException("Producer snapshots require an absolute .avsig path");
    private static void UniqueProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in element.EnumerateObject())
            {
                if (!names.Add(property.Name)) throw new ArgumentException("Duplicate frozen dependency JSON property: " + property.Name);
                UniqueProperties(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array) foreach (var child in element.EnumerateArray()) UniqueProperties(child);
    }
}
