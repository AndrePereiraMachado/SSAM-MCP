using System.Security.Cryptography;
using System.Text.Json;

// A single empirically qualified historical incident. The report and every pin
// remain immutable; this never changes an original receipt or publication lock.
internal static class O11NativeNeutralization {
#if ODC
    static readonly bool Enabled = false;
#else
    static readonly bool Enabled = true;
#endif
    internal const string OperationId = "4c7016f0a51445108b185fdcd0109586";
    internal const string Host = "personal-2qqw9srv.outsystemscloud.com";
    internal const string ModuleKey = "Mif02PxcH0K7KiABEHTwMg";
    internal const string ReportSha256 = "6a30a9a8c9d9fa286b6841333fb6520ba825e4eade8a497d72a0693134db9be8";
    static readonly string[] JsonPins = ["nativeReceipt", "controllerReceipt", "publicationRequest", "publicationAuthorization", "publicationReceipt",
        "publishedObservation", "nativePublishCheck", "serviceCenterObservation", "qualificationController", "qualificationNative"];
    static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    static bool Text(JsonElement item, string key, string expected) => item.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String && value.GetString() == expected;
    static bool Bool(JsonElement item, string key, bool expected) => item.TryGetProperty(key, out var value) && value.ValueKind == (expected ? JsonValueKind.True : JsonValueKind.False);

    internal static bool Verify(string debugRoot, string origin, string moduleKey,
        Func<string, byte[]>? read = null, Func<string, string>? fileHash = null, Func<byte[], string>? contentHash = null) {
        if (!Enabled || origin != "https://" + Host || moduleKey != ModuleKey) return false;
        read ??= File.ReadAllBytes;
        contentHash ??= Hash;
        fileHash ??= file => { using var stream = File.OpenRead(file); return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant(); };
        try {
            var root = Path.GetFullPath(debugRoot);
            var localPrefix = Path.GetDirectoryName(root)! + Path.DirectorySeparatorChar;
            bool WithinLocal(string file) => Path.IsPathFullyQualified(file) && Path.GetFullPath(file).StartsWith(localPrefix, StringComparison.OrdinalIgnoreCase);
            var registrationPath = Path.Combine(root, "reconciled-bindings", BlockedBindings.Hash(origin, moduleKey) + ".json");
            var registrationBytes = read(registrationPath); if (registrationBytes.Length > 16384) return false;
            using var registrationDoc = JsonDocument.Parse(registrationBytes); var registration = registrationDoc.RootElement;
            if (!Text(registration, "schema", "ssam-o11-neutralization-registration/1") || !Text(registration, "lane", "o11") ||
                !Text(registration, "host", Host) || !Text(registration, "moduleKey", ModuleKey) || !Text(registration, "operationId", OperationId)) return false;
            var reportPin = registration.GetProperty("report"); var reportPath = reportPin.GetProperty("path").GetString()!;
            if (!WithinLocal(reportPath) || !Text(reportPin, "sha256", ReportSha256) || fileHash(reportPath) != ReportSha256) return false;
            var reportBytes = read(reportPath); if (reportBytes.Length > 1024 * 1024 || contentHash(reportBytes) != ReportSha256) return false;
            using var reportDoc = JsonDocument.Parse(reportBytes); var report = reportDoc.RootElement;
            if (!Text(report, "schema", "ssam-o11-historical-debug-neutralization/1") || !Text(report, "lane", "o11") || !Text(report, "host", Host) ||
                !Text(report, "moduleKey", ModuleKey) || !Text(report, "operationId", OperationId) || !Bool(report, "nativeDebuggerInactive", true) ||
                !Bool(report, "originalReceiptPreserved", true) || !Bool(report, "oldOperationReplayAllowed", false) || !Bool(report, "newBindingOperationsAllowed", true)) return false;
            var publication = report.GetProperty("publication");
            if (!Bool(publication, "desiredPublishedStateConfirmed", true) || !Bool(publication, "publicationOperationIdentityProved", false) ||
                !Bool(publication, "publicationLockReleaseAllowed", false) || publication.GetProperty("publishedVersionId").GetInt32() != 5811) return false;
            var evidence = report.GetProperty("evidence");
            foreach (var name in JsonPins.Append("publishedSnapshot")) {
                var pin = evidence.GetProperty(name); var file = pin.GetProperty("path").GetString()!; var sha = pin.GetProperty("sha256").GetString()!;
                if (!WithinLocal(file) || sha.Length != 64 || fileHash(file) != sha) return false;
            }
            var requestPath = evidence.GetProperty("publicationRequest").GetProperty("path").GetString()!;
            using var requestDoc = JsonDocument.Parse(read(requestPath)); var request = requestDoc.RootElement;
            foreach (var (fileKey, hashKey) in new[] { ("basePath", "baseSha256"), ("candidatePath", "candidateSha256") }) {
                var file = request.GetProperty(fileKey).GetString()!; var sha = request.GetProperty(hashKey).GetString()!;
                if (!WithinLocal(file) || fileHash(file) != sha) return false;
            }
            return fileHash(reportPath) == ReportSha256;
        } catch { return false; }
    }
}
