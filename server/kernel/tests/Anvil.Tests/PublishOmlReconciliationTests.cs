using System.Text;
using System.Text.Json;
using Xunit;

namespace Anvil.Tests;

public sealed partial class PublishOmlProtocolTests
{
    private static Anvil.Cli.PublishOmlPublishedModule Published(Anvil.Cli.PublishOmlRequest r) =>
        new(r.Host, r.Module, r.ModuleKey, r.ApplicationKey, 5808, true);
    private static Anvil.Cli.PublishOmlPublishedDownload Source(Anvil.Cli.PublishOmlRequest r) =>
        new(r.Module, r.ModuleKey, 5808, true, "ok", File.ReadAllBytes(r.CandidatePath));
    private static Anvil.Cli.PublishOmlPublishedModel Model(Anvil.Cli.PublishOmlRequest r) => new(r.Module, r.ModuleKey);
    private Anvil.Cli.PublishOmlRequest ReconciliationRequest() => Request() with {
        Mode = "reconcile", ReconcilePublishedVersionId = 5808 };

    [Fact]
    public void Published_source_reconciliation_reads_exact_revision_and_checks_current_pointer_twice()
    {
        var r = ReconciliationRequest(); var original = Anvil.Cli.PublishOmlProtocol.New(r, "uncertain");
        var calls = new List<string>();
        var version = Anvil.Cli.PublishOmlProtocol.ReadPublishedRevision(r, original,
            () => { calls.Add("current"); return Published(r); },
            (current, requestedVersion) => {
                calls.Add("download"); Assert.Equal(5808, requestedVersion); Assert.Equal(Published(r), current);
                return Source(r);
            }, binary => { calls.Add("inspect"); Assert.Equal(File.ReadAllBytes(r.CandidatePath), binary); return Model(r); });
        Assert.Equal(5808, version);
        Assert.Equal(new[] { "current", "download", "inspect", "current" }, calls);
        Assert.Equal(0, original.VersionId); Assert.Equal("uncertain", original.State);
    }

    [Theory]
    [InlineData("publish", 5808)]
    [InlineData("status", 5808)]
    [InlineData("reconcile", 4870)]
    [InlineData("reconcile", 4869)]
    [InlineData("reconcile", 0)]
    public void Published_revision_hint_is_reconciliation_only_and_cannot_adopt_the_base(string mode, int hint)
    {
        var r = ReconciliationRequest() with { Mode = mode, ReconcilePublishedVersionId = hint };
        Assert.Throws<InvalidOperationException>(() => Anvil.Cli.PublishOmlProtocol.Validate(r, root));
    }

    [Fact]
    public void Reconciliation_hint_does_not_change_original_operation_digest()
    {
        var r = Request(); var original = Anvil.Cli.PublishOmlProtocol.New(r, "uncertain");
        var reconciliation = r with { Mode = "reconcile", ReconcilePublishedVersionId = 5808 };
        Anvil.Cli.PublishOmlProtocol.Validate(reconciliation, root);
        Anvil.Cli.PublishOmlProtocol.Match(reconciliation, original);
        Assert.Equal(Anvil.Cli.PublishOmlProtocol.Digest(r), Anvil.Cli.PublishOmlProtocol.Digest(reconciliation));
        Assert.Throws<InvalidOperationException>(() => Anvil.Cli.PublishOmlProtocol.Match(
            reconciliation with { BaseVersionId = 4868 }, original));
    }

    [Theory]
    [InlineData("host")]
    [InlineData("name")]
    [InlineData("key")]
    [InlineData("application")]
    [InlineData("version")]
    [InlineData("inactive")]
    public void Reconciliation_refuses_another_target_before_downloading(string difference)
    {
        var r = ReconciliationRequest(); var current = Published(r);
        current = difference switch {
            "host" => current with { Host = "other.example.test" },
            "name" => current with { Name = "Other_UI" },
            "key" => current with { Key = new string('C', 22) },
            "application" => current with { ApplicationKey = new string('D', 22) },
            "version" => current with { VersionId = r.BaseVersionId },
            _ => current with { IsActive = false }
        };
        var downloaded = false;
        Assert.Throws<InvalidOperationException>(() => Anvil.Cli.PublishOmlProtocol.ReadPublishedRevision(r,
            Anvil.Cli.PublishOmlProtocol.New(r, "uncertain"), () => current,
            (_, _) => { downloaded = true; return Source(r); }, _ => Model(r)));
        Assert.False(downloaded);
    }

    [Theory]
    [InlineData("hash")]
    [InlineData("unpublished")]
    [InlineData("version")]
    [InlineData("key")]
    [InlineData("name")]
    [InlineData("status")]
    [InlineData("empty")]
    public void Reconciliation_refuses_mismatched_or_unpublished_downloads(string difference)
    {
        var r = ReconciliationRequest(); var source = Source(r);
        source = difference switch {
            "hash" => source with { Binary = Encoding.UTF8.GetBytes("another candidate") },
            "unpublished" => source with { IsPublishedVersion = false },
            "version" => source with { VersionId = r.BaseVersionId },
            "key" => source with { Key = new string('C', 22) },
            "name" => source with { Name = "Other_UI" },
            "status" => source with { Status = "exception: private payload" },
            _ => source with { Binary = Array.Empty<byte>() }
        };
        var inspected = false;
        Assert.Throws<InvalidOperationException>(() => Anvil.Cli.PublishOmlProtocol.ReadPublishedRevision(r,
            Anvil.Cli.PublishOmlProtocol.New(r, "uncertain"), () => Published(r), (_, _) => source,
            _ => { inspected = true; return Model(r); }));
        Assert.False(inspected);
    }

    [Fact]
    public void Reconciliation_refuses_native_model_identity_mismatch()
    {
        var r = ReconciliationRequest();
        Assert.Throws<InvalidOperationException>(() => Anvil.Cli.PublishOmlProtocol.ReadPublishedRevision(r,
            Anvil.Cli.PublishOmlProtocol.New(r, "uncertain"), () => Published(r), (_, _) => Source(r),
            _ => Model(r) with { Key = new string('C', 22) }));
    }

    [Fact]
    public void Reconciliation_refuses_a_revision_race_after_reading_the_exact_candidate()
    {
        var r = ReconciliationRequest(); var reads = 0;
        Assert.Throws<InvalidOperationException>(() => Anvil.Cli.PublishOmlProtocol.ReadPublishedRevision(r,
            Anvil.Cli.PublishOmlProtocol.New(r, "uncertain"),
            () => ++reads == 1 ? Published(r) : Published(r) with { VersionId = 5809 },
            (_, _) => Source(r), _ => Model(r)));
        Assert.Equal(2, reads);
    }

    [Fact]
    public void Reconciliation_rechecks_exact_download_bytes_after_native_inspection()
    {
        var r = ReconciliationRequest(); var source = Source(r);
        Assert.Throws<InvalidOperationException>(() => Anvil.Cli.PublishOmlProtocol.ReadPublishedRevision(r,
            Anvil.Cli.PublishOmlProtocol.New(r, "uncertain"), () => Published(r), (_, _) => source,
            binary => { binary[0] ^= 1; return Model(r); }));
    }

    [Fact]
    public void Published_adoption_preserves_exact_original_receipt_and_records_only_safe_provenance()
    {
        var r = ReconciliationRequest(); var receipt = Anvil.Cli.PublishOmlProtocol.New(r, "uncertain", "publish_oml_outcome_uncertain");
        var file = Path.Combine(r.ReceiptDirectory, r.OperationId + ".json");
        Anvil.Cli.PublishOmlProtocol.Save(file, receipt); var original = File.ReadAllBytes(file);
        var priorFile = Anvil.Cli.PublishOmlProtocol.PreservePriorReceipt(file, original);
        Assert.Equal(original, File.ReadAllBytes(priorFile));
        Assert.Equal(priorFile, Anvil.Cli.PublishOmlProtocol.PreservePriorReceipt(file, original));
        var adopted = Anvil.Cli.PublishOmlProtocol.AdoptPublished(r, receipt, 5808, priorFile, Anvil.Cli.PublishOmlProtocol.Hash(original));
        Assert.Equal("published", adopted.State); Assert.True(adopted.Started); Assert.True(adopted.Completed);
        Assert.Null(adopted.Error); Assert.Equal(5808, adopted.VersionId);
        Assert.Equal("native-published-source", adopted.Reconciliation!.Provenance);
        Assert.Equal(r.CandidateSha256, adopted.Reconciliation.SourceSha256);
        Assert.Equal(original, File.ReadAllBytes(file));
        var text = JsonSerializer.Serialize(adopted, Anvil.Cli.PublishOmlProtocol.Json);
        Assert.DoesNotContain("password", text); Assert.DoesNotContain("username", text); Assert.DoesNotContain("Publish and remove", text);
        File.AppendAllText(priorFile, "tampered");
        Assert.Throws<InvalidOperationException>(() => Anvil.Cli.PublishOmlProtocol.AdoptPublished(r, receipt, 5808,
            priorFile, Anvil.Cli.PublishOmlProtocol.Hash(original)));
        Assert.Throws<InvalidOperationException>(() => Anvil.Cli.PublishOmlProtocol.PreservePriorReceipt(file, original));
    }

    [Theory]
    [InlineData("missing-hint")]
    [InlineData("missing-lock")]
    [InlineData("session-refused")]
    public void Command_refusal_preserves_uncertain_receipt_and_lock_without_starting_publication(string reason)
    {
        var r = ReconciliationRequest();
        if (reason == "missing-hint") r = r with { ReconcilePublishedVersionId = null };
        var receipt = Anvil.Cli.PublishOmlProtocol.New(r, "uncertain", "publish_oml_outcome_uncertain");
        var receiptFile = Path.Combine(r.ReceiptDirectory, r.OperationId + ".json");
        Anvil.Cli.PublishOmlProtocol.Save(receiptFile, receipt); var original = File.ReadAllBytes(receiptFile);
        var lockFile = Path.Combine(root, ".local", "debugger", "o11-publications", "locks", r.Host + "-" + r.ModuleKey + ".json");
        if (reason != "missing-lock") Anvil.Cli.PublishOmlProtocol.Save(lockFile, Anvil.Cli.PublishOmlProtocol.New(r, "preparing"));
        var locked = File.Exists(lockFile) ? File.ReadAllBytes(lockFile) : null;
        var requestFile = Path.Combine(r.ReceiptDirectory, "request.json");
        File.WriteAllText(requestFile, JsonSerializer.Serialize(r, Anvil.Cli.PublishOmlProtocol.Json));
        var sessionCalls = 0;
        var result = Assert.IsType<Anvil.Cli.PublishOmlReceipt>(Anvil.Cli.PublishOmlCommand.Run(new[] { "publish-oml", "--request", requestFile }, args => {
            sessionCalls++; Assert.Contains("--read-only", args);
            throw new InvalidOperationException("private synthetic password must stay private");
        }, root));
        Assert.Equal("uncertain", result.State); Assert.Equal(0, result.VersionId);
        Assert.Equal("publish_oml_outcome_uncertain", result.Error);
        Assert.Equal(reason switch {
            "missing-hint" => "publish_oml_unknown_revision_requires_reconciliation",
            "missing-lock" => "publish_oml_original_lock_missing",
            _ => "publish_oml_operation_failed"
        }, result.ReconciliationError);
        Assert.Equal(reason == "session-refused" ? 1 : 0, sessionCalls);
        Assert.Equal(original, File.ReadAllBytes(receiptFile));
        if (locked == null) Assert.False(File.Exists(lockFile)); else Assert.Equal(locked, File.ReadAllBytes(lockFile));
        Assert.False(File.Exists(Path.Combine(r.ReceiptDirectory, r.OperationId + ".uncertain.json")));
        Assert.DoesNotContain("private synthetic", JsonSerializer.Serialize(result, Anvil.Cli.PublishOmlProtocol.Json));
    }
}
