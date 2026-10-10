using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.CSharp;

namespace Anvil.Core.Delivery;

/// <summary>Task-owned compilation, including sources without runtime dependencies. The
/// authored files, compiler binaries, generated contract/ABI and runtime choice are one
/// immutable decision. Reading requires the fingerprint already recorded by the controller.</summary>
public sealed class FrozenCSharpCompilation
{
    public const int CurrentFormatVersion = 1;
    internal const string PublicProfile = "public";
    internal const string GraphProfile = "reference-graph-2-staged";
    private readonly JsonObject document;
    private static readonly JsonSerializerOptions Options = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow };

    private FrozenCSharpCompilation(JsonObject value)
    {
        document = value.DeepClone().AsObject();
        RequireKeys(document, ["formatVersion", "profile", "environment", "moduleKey", "source", "sourceHash", "compiler", "runtimeFingerprint", "compilation"]);
        if (document["formatVersion"]?.GetValue<int>() != CurrentFormatVersion || Profile is not (PublicProfile or GraphProfile))
            throw new ArgumentException("Unsupported frozen C# compilation format/profile");
        _ = Text(Environment, "environment"); _ = Text(ModuleKey, "module identity"); _ = Sha(SourceHash, "source hash");
        if (RuntimeFingerprint != null) _ = Sha(RuntimeFingerprint, "runtime fingerprint");
        var canonical = SourceBundle.Canonical(document["source"] ?? throw new ArgumentException("Missing frozen C# source"));
        if (!JsonNode.DeepEquals(canonical, document["source"])) throw new ArgumentException("Frozen C# source is not canonical");
        if (document["compiler"] is not JsonObject { Count: > 0 } compiler) throw new ArgumentException("Missing C# compiler stamp");
        foreach (var part in compiler) { _ = Text(part.Key, "compiler assembly"); _ = Sha(part.Value!.ToString(), "compiler binary hash"); }
        var parts = document["compilation"]?.AsObject() ?? throw new ArgumentException("Missing C# compilation parts");
        RequireKeys(parts, ["specification", "sourceMap", "retiredStructures", "requiredIntrinsics", "sourceAbis"]);
        if (parts["specification"] is not JsonObject || new[] { "sourceMap", "retiredStructures", "requiredIntrinsics", "sourceAbis" }.Any(key => parts[key] is not JsonArray))
            throw new ArgumentException("Invalid frozen C# compilation parts");
        // The payload is parsed once here; subsequent consumers receive independent copies.
        _ = Compilation;
    }

    public string Profile => document["profile"]!.ToString();
    public string Environment => document["environment"]!.ToString();
    public string ModuleKey => document["moduleKey"]!.ToString();
    public string SourceHash => document["sourceHash"]!.ToString();
    public string? RuntimeFingerprint => document["runtimeFingerprint"]?.ToString();
    public string Fingerprint => DurableJson.Hash(document.ToJsonString());
    public JsonObject Source => document["source"]!.DeepClone().AsObject();
    public JsonObject ToJson() => document.DeepClone().AsObject();
    public CompilationResult Compilation
    {
        get
        {
            var parts = document["compilation"]!.DeepClone().AsObject();
            var requirements = parts["requiredIntrinsics"]!.AsArray().Select(node => node!.Deserialize<FrameworkIntrinsic>(Options)!).ToArray();
            return new(parts["specification"]!.AsObject(), parts["sourceMap"]!.AsArray(), SourceHash,
                parts["retiredStructures"]!.AsArray(), requirements, parts["sourceAbis"]!.AsArray());
        }
    }

    public static FrozenCSharpCompilation Create(JsonNode source, string environment, string moduleKey, FrozenFrameworkDependencies? runtime = null)
        => Capture(source, CSharpCompiler.Compile(SourceBundle.From(source)), PublicProfile, environment, moduleKey, runtime);

    internal static FrozenCSharpCompilation Capture(JsonNode source, CompilationResult compiled, string profile,
        string environment, string moduleKey, FrozenFrameworkDependencies? runtime)
    {
        if (runtime != null) runtime.ValidateReuse(compiled.SourceHash, compiled.RequiredIntrinsics ?? [], environment, moduleKey, runtime.Package);
        else if (compiled.RequiredIntrinsics is { Count: > 0 }) throw new InvalidOperationException("C# compilation requires its frozen runtime choice");
        return new(new JsonObject { ["formatVersion"] = CurrentFormatVersion, ["profile"] = profile,
            ["environment"] = environment, ["moduleKey"] = moduleKey, ["source"] = SourceBundle.Canonical(source),
            ["sourceHash"] = compiled.SourceHash, ["compiler"] = CompilerStamp(), ["runtimeFingerprint"] = runtime?.Fingerprint,
            ["compilation"] = new JsonObject {
                ["specification"] = compiled.Specification.DeepClone(), ["sourceMap"] = compiled.SourceMap.DeepClone(),
                ["retiredStructures"] = compiled.RetiredStructures?.DeepClone() ?? new JsonArray(),
                ["sourceAbis"] = compiled.SourceAbis?.DeepClone() ?? new JsonArray(),
                ["requiredIntrinsics"] = JsonSerializer.SerializeToNode((compiled.RequiredIntrinsics ?? []).Select(requirement =>
                    new { requirement.Id, requirement.Version, requirement.Inputs, requirement.Output }), Options)
            } });
    }

    public void ValidateReuse(JsonNode source, string environment, string moduleKey, FrozenFrameworkDependencies? runtime = null)
    {
        ValidateInputs(source, environment, moduleKey);
        ValidateRuntime(environment, moduleKey, runtime);
    }
    private void ValidateRuntime(string environment, string moduleKey, FrozenFrameworkDependencies? runtime)
    {
        if (RuntimeFingerprint != runtime?.Fingerprint)
            throw new InvalidOperationException("Frozen C# compilation requires the original runtime decision");
        if (runtime != null) runtime.ValidateReuse(SourceHash, Compilation.RequiredIntrinsics ?? [], environment, moduleKey, runtime.Package);
        else if (Compilation.RequiredIntrinsics is { Count: > 0 })
            throw new InvalidOperationException("Frozen C# compilation requires its runtime dependencies");
    }
    internal void ValidateInputs(JsonNode source, string environment, string moduleKey)
    {
        if (!JsonNode.DeepEquals(SourceBundle.Canonical(source), document["source"]))
            throw new InvalidOperationException("Frozen C# compilation belongs to another source revision");
        if (!Environment.Equals(environment, StringComparison.OrdinalIgnoreCase) || ModuleKey != moduleKey)
            throw new InvalidOperationException("Frozen C# compilation belongs to another environment/module");
        if (!JsonNode.DeepEquals(document["compiler"], CompilerStamp()))
            throw new InvalidOperationException("C# compiler binaries changed; the original compilation cannot be silently replaced");
    }

    public CompilationResult Bind(FrozenFrameworkDependencies? runtime)
    {
        ValidateReuse(Source, Environment, ModuleKey, runtime);
        var compiled = Compilation;
        return runtime == null ? compiled : FrameworkIntrinsic.Bind(compiled, runtime.CallBindings());
    }
    // Import reads the originally compiled contract; it never resumes model writes or
    // recompiles old source with a newer compiler. Only a verified delivery export uses
    // this path. Replay/autoria retain the strict current-binary check above.
    internal CompilationResult ReadBound(string environment, string moduleKey, FrozenFrameworkDependencies? runtime)
    {
        if (!Environment.Equals(environment, StringComparison.OrdinalIgnoreCase) || ModuleKey != moduleKey)
            throw new InvalidOperationException("Frozen C# export belongs to another environment/module");
        ValidateRuntime(environment, moduleKey, runtime);
        var compiled = Compilation;
        return runtime == null ? compiled : FrameworkIntrinsic.Bind(compiled, runtime.CallBindings());
    }
    public static FrozenCSharpCompilation FromJson(JsonObject value, string expectedFingerprint)
    {
        var frozen = new FrozenCSharpCompilation(value);
        if (frozen.Fingerprint != Sha(expectedFingerprint, "compilation fingerprint"))
            throw new InvalidOperationException("Frozen C# compilation fingerprint changed");
        return frozen;
    }
    public static FrozenCSharpCompilation Read(string path, string expectedFingerprint)
        => FromJson(DurableJson.Read(path), expectedFingerprint);
    public void Write(string path)
    {
        if (File.Exists(path)) { _ = Read(path, Fingerprint); return; }
        DurableJson.Write(path, document);
    }
    private static JsonObject CompilerStamp()
    {
        var assemblies = new[] { typeof(FrozenCSharpCompilation).Assembly, typeof(CSharpCompiler).Assembly,
            typeof(Anvil.Authoring.EntityAttribute).Assembly, typeof(Microsoft.CodeAnalysis.Compilation).Assembly,
            typeof(Microsoft.CodeAnalysis.CSharp.CSharpCompilation).Assembly, typeof(object).Assembly };
        return new JsonObject(assemblies.OrderBy(assembly => assembly.GetName().Name, StringComparer.Ordinal).Select(assembly =>
            KeyValuePair.Create(assembly.GetName().Name!, (JsonNode?)JsonValue.Create(BinaryHash(assembly)))));
    }
    private static string BinaryHash(Assembly assembly) => !string.IsNullOrEmpty(assembly.Location)
        ? Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()
        : throw new InvalidOperationException("C# compiler stamp requires a file-backed assembly: " + assembly.GetName().Name);
    private static string Text(string value, string kind) => !string.IsNullOrWhiteSpace(value) && value == value.Trim() && !value.Any(char.IsControl)
        ? value : throw new ArgumentException("Invalid frozen C# " + kind);
    private static string Sha(string value, string kind) => value is { Length: 64 } && value.All(Uri.IsHexDigit)
        ? value.ToLowerInvariant() : throw new ArgumentException("Invalid frozen C# " + kind);
    private static void RequireKeys(JsonObject value, string[] keys)
    {
        if (value.Count != keys.Length || keys.Any(key => !value.ContainsKey(key))) throw new ArgumentException("Invalid frozen C# compilation fields");
    }
}
