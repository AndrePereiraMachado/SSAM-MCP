using System.Security.Cryptography;
using System.Text.Json;

// A manifest is the only input a bridge command needs. It binds one module, one hash-checked
// base, one hash-checked immutable candidate and one fresh evidence directory.
// A new attempt is a new manifest, never a new bridge assembly.
internal sealed class Manifest {
    public string Schema { get; set; } = "odc3-manifest/1";
    public string Feature { get; set; } = "";
    public string Module { get; set; } = "";
    public string ModuleKey { get; set; } = "";
    // No default tenant or author: a manifest names both (the kernel and the builder take them from the snapshot, the
    // catalog or tenants.json), and Load refuses one that does not. No customer text is compiled into the bridge.
    public string Tenant { get; set; } = "";
    public string Author { get; set; } = "";
    public string BasePath { get; set; } = "";
    public string BaseSha256 { get; set; } = "";
    public string BaseCapturedAt { get; set; } = "";
    public string CandidatePath { get; set; } = "";
    public string CandidateSha256 { get; set; } = "";
    public string[] Owners { get; set; } = Array.Empty<string>();
    public string EvidenceDir { get; set; } = "";
    public int MaxBaseAgeMinutes { get; set; } = 60;
    public string[] Changes { get; set; } = Array.Empty<string>();
    public string? BuilderReceipt { get; set; }
    public bool Smoke { get; set; }
    public string? PublishAuthorization { get; set; }
    public int? ExpectedPublishedRevision { get; set; }
    // A creation manifest carries a whole new module as its candidate and no base: the bridge command
    // "create" uploads it as a new asset of the tenant, with the user's explicit authorization text.
    public bool Create { get; set; }
    public string? CreateAuthorization { get; set; }
    // Producer model the candidate was built against, when the feature added a dependency.
    public string? ProducerPath { get; set; }
    public string? ProducerSha256 { get; set; }

    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true, WriteIndented = true };

    public static Manifest Load(string path) {
        var full = Path.GetFullPath(path);
        var manifest = JsonSerializer.Deserialize<Manifest>(File.ReadAllText(full), Json) ?? throw new InvalidOperationException("Manifest could not be read: " + full);
        Require(manifest.Schema == "odc3-manifest/1", "Unsupported manifest schema: " + manifest.Schema);
        var required = new List<(string, string)> { ("module", manifest.Module), ("moduleKey", manifest.ModuleKey), ("candidatePath", manifest.CandidatePath), ("candidateSha256", manifest.CandidateSha256), ("evidenceDir", manifest.EvidenceDir), ("author", manifest.Author), ("tenant", manifest.Tenant) };
        if (!manifest.Create) required.AddRange(new[] { ("basePath", manifest.BasePath), ("baseSha256", manifest.BaseSha256) });
        foreach (var (name, value) in required)
            Require(!string.IsNullOrWhiteSpace(value), "Manifest field is required: " + name);
        Require(!manifest.Smoke && !Path.GetFileName(manifest.CandidatePath).StartsWith("DO-NOT", StringComparison.OrdinalIgnoreCase), "DO-NOT-DELIVER candidates never enter preview, merge or publish.");
        return manifest;
    }

    public void Save(string path) => File.WriteAllText(path, JsonSerializer.Serialize(this, Json));
    public static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));

    public byte[] ReadBase() {
        var bytes = File.ReadAllBytes(BasePath);
        Require(Hash(bytes) == BaseSha256, "Captured base changed on disk: " + Path.GetFileName(BasePath));
        return bytes;
    }

    public byte[] ReadCandidate() {
        var bytes = File.ReadAllBytes(CandidatePath);
        Require(Hash(bytes) == CandidateSha256, "Candidate changed on disk: " + Path.GetFileName(CandidatePath));
        return bytes;
    }

    public DateTimeOffset CapturedAt() =>
        DateTimeOffset.TryParse(BaseCapturedAt, null, System.Globalization.DateTimeStyles.AssumeUniversal, out var parsed) ? parsed : new DateTimeOffset(File.GetLastWriteTimeUtc(BasePath), TimeSpan.Zero);

    public TimeSpan BaseAge() => DateTimeOffset.UtcNow - CapturedAt();

    public void RequireFreshBase() =>
        Require(BaseAge() <= TimeSpan.FromMinutes(MaxBaseAgeMinutes), "Captured base is older than " + MaxBaseAgeMinutes + " minutes; capture a new snapshot and rebuild the candidate.");

    private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
}
