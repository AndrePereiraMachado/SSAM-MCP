using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Anvil.Cli;

// Public metadata only. App credentials and Studio SSO never enter this protocol.
internal sealed record PublishOmlRequest(string OperationId, string Host, string Module, string ModuleKey,
    string ApplicationKey, int BaseVersionId, string BasePath, string BaseSha256, string CandidatePath,
    string CandidateSha256, string AuthorizationPath, string AuthorizationSha256, string ReceiptDirectory,
    string Message, int? CatalogId = null, int TimeoutSeconds = 300, string Mode = "publish",
    int? ReconcilePublishedVersionId = null);
internal sealed record PublishOmlAuthorization(string OperationId, string Host, string ModuleKey,
    string CandidateSha256, string Scope, string Words, DateTimeOffset GrantedAt);
internal sealed record PublishOmlReceipt(string OperationId, string Digest, string Host, string Module,
    string ModuleKey, string ApplicationKey, string CandidateSha256, int BaseVersionId, string State,
    int VersionId = 0, int ESpaceId = 0, bool Started = false, bool Completed = false,
    bool HasErrors = false, int MessageCount = 0, string? Error = null,
    PublishOmlReconciliation? Reconciliation = null, string? ReconciliationError = null)
{ public bool Ok => State == "published"; }

internal sealed record PublishOmlReconciliation(string Provenance, int PublishedVersionId, string SourceSha256,
    string PriorReceiptPath, string PriorReceiptSha256);
internal sealed record PublishOmlPublishedModule(string Host, string Name, string Key, string ApplicationKey,
    int VersionId, bool IsActive);
internal sealed record PublishOmlPublishedDownload(string Name, string Key, int VersionId, bool IsPublishedVersion,
    string Status, byte[] Binary);
internal sealed record PublishOmlPublishedModel(string Name, string Key);

internal static class PublishOmlProtocol
{
    internal static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };
    private static readonly Regex Key = new("^[A-Za-z0-9_+]{22}$");
    private static readonly Regex Name = new("^[A-Za-z_][A-Za-z0-9_]{0,120}$");
    private static readonly Regex Sha = new("^[a-f0-9]{64}$");
    private static string? ScopeFor(string message) => message switch
    {
        "SSAM Debug REST Create" or "SSAM Debug REST Remove" => "ssam-debug-wrapper-create-remove",
        "SSAM Debug Context Probe Create" or "SSAM Debug Context Probe Remove" => "ssam-debug-context-probe-create-remove",
        _ => null
    };
    internal static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    internal static string FileHash(string file) => Hash(File.ReadAllBytes(file));
    internal static string Digest(PublishOmlRequest r) => Hash(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new {
        r.Host, r.Module, r.ModuleKey, r.ApplicationKey, r.BaseVersionId, r.BaseSha256,
        r.CandidateSha256, r.Message, r.CatalogId }, Json)));
    internal static void Require(bool value, string code) { if (!value) throw new InvalidOperationException(code); }
    internal static string Within(string root, string path)
    {
        var full = Path.GetFullPath(path);
        var prefix = Path.GetFullPath(Path.Combine(root, ".local")) + Path.DirectorySeparatorChar;
        Require(full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase), "publish_oml_path_outside_local");
        return full;
    }
    internal static void Validate(PublishOmlRequest r, string root)
    {
        Require(Guid.TryParseExact(r.OperationId, "D", out _) && r.OperationId == r.OperationId.ToLowerInvariant()
            && Name.IsMatch(r.Module) && Key.IsMatch(r.ModuleKey) && Key.IsMatch(r.ApplicationKey)
            && Uri.TryCreate("https://" + r.Host + "/", UriKind.Absolute, out var uri) && uri.Host == r.Host
            && uri.Authority == r.Host && uri.AbsolutePath == "/" && uri.UserInfo == "" && uri.Query == ""
            && uri.Fragment == "" && r.BaseVersionId > 0 && Sha.IsMatch(r.BaseSha256)
            && Sha.IsMatch(r.CandidateSha256) && Sha.IsMatch(r.AuthorizationSha256)
            && r.TimeoutSeconds is >= 5 and <= 600 && (r.CatalogId == null || r.CatalogId > 0)
            && r.Mode is "publish" or "status" or "reconcile"
            && ScopeFor(r.Message) != null, "publish_oml_invalid_request");
        Require(r.ReconcilePublishedVersionId == null || r.Mode == "reconcile"
            && r.ReconcilePublishedVersionId > r.BaseVersionId, "publish_oml_invalid_reconciliation_hint");
        foreach (var path in new[] { r.BasePath, r.CandidatePath, r.AuthorizationPath, r.ReceiptDirectory }) Within(root, path);
        Require(FileHash(r.BasePath) == r.BaseSha256 && FileHash(r.CandidatePath) == r.CandidateSha256,
            "publish_oml_source_changed");
        Require(FileHash(r.AuthorizationPath) == r.AuthorizationSha256, "publish_oml_authorization_changed");
        var authorization = JsonSerializer.Deserialize<PublishOmlAuthorization>(File.ReadAllText(r.AuthorizationPath), Json);
        Require(authorization != null && authorization.OperationId == r.OperationId && authorization.Host == r.Host
            && authorization.ModuleKey == r.ModuleKey && authorization.CandidateSha256 == r.CandidateSha256
            && authorization.Scope == ScopeFor(r.Message) && !string.IsNullOrWhiteSpace(authorization.Words)
            && authorization.Words.Length <= 2000 && authorization.GrantedAt <= DateTimeOffset.UtcNow.AddSeconds(30),
            "publish_oml_authorization_required");
    }
    internal static PublishOmlReceipt New(PublishOmlRequest r, string state, string? error = null) => new(
        r.OperationId, Digest(r), r.Host, r.Module, r.ModuleKey, r.ApplicationKey, r.CandidateSha256,
        r.BaseVersionId, state, Error: error);
    internal static void Match(PublishOmlRequest r, PublishOmlReceipt receipt) => Require(
        receipt.OperationId == r.OperationId && receipt.Digest == Digest(r), "publish_oml_operation_conflict");

    // These callbacks expose only reads. Adoption never starts or polls a publication.
    internal static int ReadPublishedRevision(PublishOmlRequest r, PublishOmlReceipt receipt,
        Func<PublishOmlPublishedModule> current, Func<PublishOmlPublishedModule, int, PublishOmlPublishedDownload> download,
        Func<byte[], PublishOmlPublishedModel> inspect)
    {
        Match(r, receipt);
        Require(r.Mode == "reconcile" && receipt.State == "uncertain" && receipt.VersionId == 0
            && r.ReconcilePublishedVersionId is > 0 && r.ReconcilePublishedVersionId > r.BaseVersionId,
            "publish_oml_invalid_reconciliation_hint");
        var versionId = r.ReconcilePublishedVersionId!.Value;
        void MatchCurrent(PublishOmlPublishedModule value) => Require(value != null
            && value.Host == r.Host && value.Name == r.Module && value.Key == r.ModuleKey
            && value.ApplicationKey == r.ApplicationKey && value.IsActive && value.VersionId == versionId,
            "publish_oml_reconciliation_target_changed");
        var before = current(); MatchCurrent(before);
        var source = download(before, versionId);
        Require(source != null && source.Status == "ok" && source.Name == r.Module && source.Key == r.ModuleKey
            && source.VersionId == versionId && source.IsPublishedVersion && source.Binary is { Length: > 0 },
            "publish_oml_reconciliation_source_unavailable");
        Require(Hash(source.Binary) == r.CandidateSha256, "publish_oml_reconciliation_source_mismatch");
        var model = inspect(source.Binary);
        Require(model != null && model.Key == r.ModuleKey && model.Name == r.Module,
            "publish_oml_reconciliation_model_mismatch");
        MatchCurrent(current());
        Require(Hash(source.Binary) == r.CandidateSha256, "publish_oml_reconciliation_source_mismatch");
        return versionId;
    }

    internal static PublishOmlReceipt AdoptPublished(PublishOmlRequest r, PublishOmlReceipt receipt, int versionId,
        string priorReceiptPath, string priorReceiptSha256)
    {
        Match(r, receipt);
        Require(receipt.State == "uncertain" && receipt.VersionId == 0 && r.Mode == "reconcile"
            && r.ReconcilePublishedVersionId == versionId && versionId > r.BaseVersionId,
            "publish_oml_invalid_reconciliation_hint");
        Require(Sha.IsMatch(priorReceiptSha256) && FileHash(priorReceiptPath) == priorReceiptSha256,
            "publish_oml_prior_receipt_changed");
        var prior = JsonSerializer.Deserialize<PublishOmlReceipt>(File.ReadAllText(priorReceiptPath), Json);
        Require(prior == receipt, "publish_oml_prior_receipt_changed");
        return receipt with { State = "published", Started = true, Completed = true, HasErrors = false,
            VersionId = versionId, Error = null, ReconciliationError = null,
            Reconciliation = new("native-published-source", versionId, r.CandidateSha256,
                priorReceiptPath, priorReceiptSha256) };
    }

    internal static string PreservePriorReceipt(string receiptFile, byte[] original)
    {
        Require(FileHash(receiptFile) == Hash(original), "publish_oml_prior_receipt_changed");
        var priorFile = Path.Combine(Path.GetDirectoryName(receiptFile)!, Path.GetFileNameWithoutExtension(receiptFile) + ".uncertain.json");
        if (!File.Exists(priorFile))
        {
            using var stream = new FileStream(priorFile, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            stream.Write(original); stream.Flush(true);
        }
        Require(FileHash(priorFile) == Hash(original), "publish_oml_prior_receipt_changed");
        return priorFile;
    }
    internal static void Save(string file, PublishOmlReceipt receipt)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        { JsonSerializer.Serialize(stream, receipt, Json); stream.Flush(true); }
        File.Move(temporary, file, true);
    }
}
