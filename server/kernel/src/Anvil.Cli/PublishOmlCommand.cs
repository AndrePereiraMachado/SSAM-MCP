using System.Diagnostics;
using System.Text.Json;
using Anvil.Core;

namespace Anvil.Cli;

internal static class PublishOmlCommand
{
    internal static object Run(string[] args, Func<string[], HeadlessSession> session, string? workspaceRoot = null)
    {
        PublishOmlRequest? request = null;
        PublishOmlReceipt? receipt = null;
        string? receiptFile = null, targetLock = null;
        FileStream? lockStream = null;
        var submitted = false;
        var receiptOwned = false;
        PublishOmlReceipt? originalUncertain = null;
        byte[]? originalReceiptBytes = null;
        try
        {
            PublishOmlProtocol.Require(!args.Contains("--credentials"), "publish_oml_studio_session_required");
            var at = Array.IndexOf(args, "--request");
            PublishOmlProtocol.Require(at >= 0 && at + 1 < args.Length, "publish_oml_request_required");
            request = JsonSerializer.Deserialize<PublishOmlRequest>(File.ReadAllText(args[at + 1]), PublishOmlProtocol.Json);
            PublishOmlProtocol.Require(request != null, "publish_oml_invalid_request");
            var root = workspaceRoot ?? WorkspaceRoot();
            PublishOmlProtocol.Validate(request!, root);
            receiptFile = Path.Combine(request!.ReceiptDirectory, request.OperationId + ".json");
            if (File.Exists(receiptFile))
            {
                originalReceiptBytes = File.ReadAllBytes(receiptFile);
                receipt = JsonSerializer.Deserialize<PublishOmlReceipt>(originalReceiptBytes, PublishOmlProtocol.Json)!;
                submitted = receipt.State == "uncertain"; // Preserve prior submission uncertainty before every subsequent refusal.
                if (submitted) originalUncertain = receipt;
                PublishOmlProtocol.Match(request, receipt); receiptOwned = true;
                if (request.Mode != "reconcile" || receipt.State != "uncertain") return receipt;
                PublishOmlProtocol.Require(receipt.VersionId > 0 || request.ReconcilePublishedVersionId != null,
                    "publish_oml_unknown_revision_requires_reconciliation");
                PublishOmlProtocol.Require(receipt.VersionId == 0 || request.ReconcilePublishedVersionId == null,
                    "publish_oml_invalid_reconciliation_hint");
            }
            else PublishOmlProtocol.Require(request.Mode == "publish", "publish_oml_operation_not_found");
            var lockDirectory = Path.Combine(root, ".local", "debugger", "o11-publications", "locks");
            Directory.CreateDirectory(lockDirectory);
            targetLock = Path.Combine(lockDirectory, request.Host + "-" + request.ModuleKey + ".json");
            if (File.Exists(targetLock))
            {
                var locked = JsonSerializer.Deserialize<PublishOmlReceipt>(File.ReadAllText(targetLock), PublishOmlProtocol.Json)!;
                PublishOmlProtocol.Match(request, locked);
                PublishOmlProtocol.Require(request.Mode == "reconcile", "publish_oml_target_has_operation");
                lockStream = new FileStream(targetLock, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            }
            else
            {
                PublishOmlProtocol.Require(request.Mode != "reconcile", "publish_oml_original_lock_missing");
                lockStream = new FileStream(targetLock, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
            }
            if (!submitted)
            {
                receipt = PublishOmlProtocol.New(request, "preparing"); receiptOwned = true;
                JsonSerializer.Serialize(lockStream, receipt, PublishOmlProtocol.Json); lockStream.Flush(true);
                PublishOmlProtocol.Save(receiptFile, receipt);
            }
            var connectArgs = new[] { "publish-oml", "--host", request.Host, "--module", request.Module }
                .Concat(args.Skip(1)).Concat(request.Mode == "reconcile" ? new[] { "--read-only" } : Array.Empty<string>()).ToArray();
            using var s = session(connectArgs);
            PublishOmlProtocol.Require(s.Host.Equals(request.Host, StringComparison.OrdinalIgnoreCase), "publish_oml_host_mismatch");
            if (submitted && receipt!.VersionId == 0)
            {
                var output = Path.Combine(request.ReceiptDirectory, "reconciliation", Guid.NewGuid().ToString("N"));
                var model = new ModelHost(Path.Combine(output, "model"));
                ModuleSummary? nativeModule = null;
                var versionId = PublishOmlProtocol.ReadPublishedRevision(request, receipt, () => {
                    nativeModule = s.ListModules(refresh: true).SingleOrDefault(m => m.Key == request.ModuleKey);
                    return nativeModule == null ? null! : new(s.Host, nativeModule.Name, nativeModule.Key,
                        nativeModule.ApplicationKey!, nativeModule.VersionId, nativeModule.IsActive);
                }, (_, version) => {
                    var source = s.Download(nativeModule!, outputDirectory: output, versionId: version);
                    var expectedPath = Path.Combine(output, HeadlessSession.SafeFileName(request.Module) + ".oml");
                    PublishOmlProtocol.Require(source.Status == "ok" && source.FilePath != null
                        && Path.GetFullPath(source.FilePath).Equals(expectedPath, StringComparison.OrdinalIgnoreCase),
                        "publish_oml_reconciliation_source_unavailable");
                    return new(source.Name, source.Key, source.VersionId, source.IsPublishedVersion,
                        source.Status, File.ReadAllBytes(expectedPath));
                }, binary => {
                    var inspected = model.Inspect(binary);
                    return new(inspected.Name, inspected.Key);
                });
                PublishOmlProtocol.Validate(request, root); // Frozen inputs and authorization must still match after native reads.
                var priorFile = PublishOmlProtocol.PreservePriorReceipt(receiptFile, originalReceiptBytes!);
                receipt = PublishOmlProtocol.AdoptPublished(request, receipt, versionId, priorFile,
                    PublishOmlProtocol.Hash(originalReceiptBytes!));
                PublishOmlProtocol.Save(receiptFile, receipt);
                return receipt; // A published-source adoption never calls StartPublish or CheckPublish.
            }
            if (!submitted)
            {
                var current = s.ListModules(refresh: true).SingleOrDefault(m => m.Key == request.ModuleKey);
                PublishOmlProtocol.Require(current != null && current.Name == request.Module && current.IsActive
                    && current.ApplicationKey == request.ApplicationKey && current.VersionId == request.BaseVersionId,
                    "publish_oml_base_version_changed");
                var versions = s.ListVersionIds(request.ModuleKey);
                PublishOmlProtocol.Require(versions.Count > 0 && versions[0] == request.BaseVersionId,
                    "publish_oml_unpublished_revision_present");
                var host = new ModelHost(Path.Combine(request.ReceiptDirectory, "model"));
                // Verify and submit the same immutable snapshot. Never reload a mutable path for StartPublish.
                var baseBytes = File.ReadAllBytes(request.BasePath);
                var candidateBytes = File.ReadAllBytes(request.CandidatePath);
                PublishOmlProtocol.Require(PublishOmlProtocol.Hash(baseBytes) == request.BaseSha256
                    && PublishOmlProtocol.Hash(candidateBytes) == request.CandidateSha256, "publish_oml_source_changed");
                var baseline = host.Inspect(baseBytes);
                var candidate = host.Inspect(candidateBytes);
                PublishOmlProtocol.Require(baseline.Key == request.ModuleKey && candidate.Key == request.ModuleKey
                    && baseline.Name == request.Module && candidate.Name == request.Module && candidate.IsValid,
                    "publish_oml_candidate_invalid");
                if (request.CatalogId is { } catalog) PublishOmlProtocol.Require(s.ListCatalogs().Any(c => c.Id == catalog), "publish_oml_catalog_mismatch");
                receipt = receipt! with { State = "uncertain", Error = "publish_oml_outcome_uncertain" };
                PublishOmlProtocol.Save(receiptFile, receipt); submitted = true;
                var outcome = Publisher.StartPublish(s, candidateBytes, request.ApplicationKey,
                    request.CatalogId, request.Message);
                PublishOmlProtocol.Require(outcome.Key == request.ModuleKey || !outcome.Started, "publish_oml_response_target_mismatch");
                receipt = Update(receipt, outcome);
                PublishOmlProtocol.Save(receiptFile, receipt);
            }
            if (receipt!.Started && !receipt.Completed && !receipt.HasErrors)
            {
                var previous = new PublishOutcome(true, false, false, receipt.ESpaceId, receipt.VersionId,
                    request.ModuleKey, Array.Empty<PublishMessage>(), 0, 0);
                var elapsed = Stopwatch.StartNew();
                while (!previous.Completed && !previous.HasErrors && elapsed.Elapsed.TotalSeconds < request.TimeoutSeconds)
                {
                    Thread.Sleep(1500);
                    previous = Publisher.CheckPublish(s, previous);
                    receipt = Update(receipt, previous);
                    PublishOmlProtocol.Save(receiptFile, receipt);
                }
            }
            if (receipt.Completed && !receipt.HasErrors)
            {
                var current = s.ListModules(refresh: true).SingleOrDefault(m => m.Key == request.ModuleKey);
                if (current?.VersionId == receipt.VersionId && current.ApplicationKey == request.ApplicationKey)
                    receipt = receipt with { State = "published", Error = null };
            }
            PublishOmlProtocol.Save(receiptFile, receipt);
            return receipt;
        }
        catch (Exception error)
        {
            // Native messages may echo authentication or compiler input. Only fixed codes leave this command.
            var code = error is InvalidOperationException && error.Message.StartsWith("publish_oml_", StringComparison.Ordinal)
                && error.Message.All(c => c is >= 'a' and <= 'z' or '_') ? error.Message : "publish_oml_operation_failed";
            if (request == null || receiptFile == null || !receiptOwned)
                return new { ok = false, state = "refused", error = code };
            if (request.Mode == "reconcile" && originalUncertain != null)
            {
                receipt = originalUncertain; // Keep the original receipt and target lock intact on a refused read-only reconciliation.
                return receipt with { ReconciliationError = code };
            }
            receipt = (receipt ?? PublishOmlProtocol.New(request, "refused")) with {
                State = submitted ? "uncertain" : "refused", Error = submitted ? "publish_oml_outcome_uncertain" : code };
            try { PublishOmlProtocol.Save(receiptFile, receipt); } catch { /* Never retry a publication. */ }
            return receipt;
        }
        finally
        {
            lockStream?.Dispose();
            if (lockStream != null && targetLock != null && receipt?.State != "uncertain") File.Delete(targetLock);
        }
    }
    private static PublishOmlReceipt Update(PublishOmlReceipt receipt, PublishOutcome outcome) => receipt with {
        State = outcome.HasErrors || !outcome.Started ? "failed" : "uncertain", Started = outcome.Started,
        Completed = outcome.Completed, HasErrors = outcome.HasErrors, VersionId = outcome.VersionId,
        ESpaceId = outcome.ESpaceId, MessageCount = outcome.Messages.Count,
        Error = outcome.HasErrors || !outcome.Started ? "publish_oml_rejected" : "publish_oml_outcome_uncertain" };
    private static string WorkspaceRoot()
    {
        var directory = new DirectoryInfo(Environment.CurrentDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, ".ssam-workspace.json"))) directory = directory.Parent;
        if (directory == null) throw new InvalidOperationException("publish_oml_workspace_required");
        return directory.FullName;
    }
}
