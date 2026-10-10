using System.Text.Json;
using Anvil.Cli;
using Xunit;

namespace Anvil.Tests;

public sealed partial class PublishOmlProtocolTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "ssam-publish-policy-" + Guid.NewGuid().ToString("N"));
    private PublishOmlRequest Request()
    {
        var folder = Path.Combine(root, ".local", "operation"); Directory.CreateDirectory(folder);
        var baseline = Path.Combine(folder, "base.oml"); var candidate = Path.Combine(folder, "candidate.oml");
        File.WriteAllText(baseline, "base"); File.WriteAllText(candidate, "candidate");
        var operation = Guid.NewGuid().ToString("D"); var candidateHash = PublishOmlProtocol.FileHash(candidate);
        var authorization = Path.Combine(folder, "authorization.json");
        File.WriteAllText(authorization, JsonSerializer.Serialize(new PublishOmlAuthorization(operation,
            "personal.example.test", new string('A', 22), candidateHash, "ssam-debug-wrapper-create-remove",
            "Publish and remove the temporary debug wrapper.", DateTimeOffset.UtcNow), PublishOmlProtocol.Json));
        return new(operation, "personal.example.test", "Headless_UI", new string('A', 22), new string('B', 22),
            4870, baseline, PublishOmlProtocol.FileHash(baseline), candidate, candidateHash, authorization,
            PublishOmlProtocol.FileHash(authorization), folder, "SSAM Debug REST Create");
    }
    [Fact] public void Exact_metadata_and_authorization_are_validated()
    { var r = Request(); PublishOmlProtocol.Validate(r, root); Assert.Equal(64, PublishOmlProtocol.Digest(r).Length); }
    [Theory]
    [InlineData("SSAM Debug REST Create", "ssam-debug-wrapper-create-remove")]
    [InlineData("SSAM Debug REST Remove", "ssam-debug-wrapper-create-remove")]
    [InlineData("SSAM Debug Context Probe Create", "ssam-debug-context-probe-create-remove")]
    [InlineData("SSAM Debug Context Probe Remove", "ssam-debug-context-probe-create-remove")]
    public void Debug_publication_comments_require_their_exact_authorization_scope(string message, string scope)
    {
        var r = Request() with { Message = message };
        var authorization = JsonSerializer.Deserialize<PublishOmlAuthorization>(File.ReadAllText(r.AuthorizationPath), PublishOmlProtocol.Json)!;
        void WriteScope(string value)
        {
            File.WriteAllText(r.AuthorizationPath, JsonSerializer.Serialize(authorization with { Scope = value }, PublishOmlProtocol.Json));
            r = r with { AuthorizationSha256 = PublishOmlProtocol.FileHash(r.AuthorizationPath) };
        }
        WriteScope(scope); PublishOmlProtocol.Validate(r, root);
        WriteScope(scope == "ssam-debug-wrapper-create-remove" ? "ssam-debug-context-probe-create-remove" : "ssam-debug-wrapper-create-remove");
        Assert.Throws<InvalidOperationException>(() => PublishOmlProtocol.Validate(r, root));
        WriteScope("publish-anything");
        Assert.Throws<InvalidOperationException>(() => PublishOmlProtocol.Validate(r, root));
    }
    [Fact] public void Changed_candidate_or_authorization_fails_closed()
    {
        var r = Request(); File.AppendAllText(r.CandidatePath, "changed");
        Assert.Throws<InvalidOperationException>(() => PublishOmlProtocol.Validate(r, root));
        r = Request(); File.AppendAllText(r.AuthorizationPath, " ");
        Assert.Throws<InvalidOperationException>(() => PublishOmlProtocol.Validate(r, root));
    }
    [Fact] public void Authorization_cannot_be_reused_for_another_module_or_candidate()
    {
        var r = Request();
        Assert.Throws<InvalidOperationException>(() => PublishOmlProtocol.Validate(r with { ModuleKey = new string('C', 22) }, root));
        Assert.Throws<InvalidOperationException>(() => PublishOmlProtocol.Validate(r with { OperationId = Guid.NewGuid().ToString("D") }, root));
    }
    [Fact] public void Traversal_and_generic_publication_are_refused()
    {
        var r = Request();
        Assert.Throws<InvalidOperationException>(() => PublishOmlProtocol.Validate(r with { ReceiptDirectory = Path.Combine(root, ".local", "..", "outside") }, root));
        Assert.Throws<InvalidOperationException>(() => PublishOmlProtocol.Validate(r with { Message = "business change" }, root));
        Assert.Throws<InvalidOperationException>(() => PublishOmlProtocol.Validate(r with { Host = "personal.example.test/path" }, root));
    }
    [Fact] public void Recorded_operation_binds_payload_but_allows_read_only_reconciliation()
    {
        var r = Request(); var receipt = PublishOmlProtocol.New(r, "uncertain");
        PublishOmlProtocol.Match(r with { Mode = "reconcile" }, receipt);
        Assert.Throws<InvalidOperationException>(() => PublishOmlProtocol.Match(r with { BaseVersionId = 999 }, receipt));
        Assert.Throws<InvalidOperationException>(() => PublishOmlProtocol.Match(r with { CandidateSha256 = new string('c', 64) }, receipt));
    }
    [Fact] public void Safe_receipt_has_no_authorization_words_or_native_messages()
    {
        var r = Request(); var path = Path.Combine(r.ReceiptDirectory, "receipt.json");
        PublishOmlProtocol.Save(path, PublishOmlProtocol.New(r, "uncertain", "publish_oml_outcome_uncertain"));
        var text = File.ReadAllText(path);
        Assert.DoesNotContain("Publish and remove", text); Assert.DoesNotContain("authorization", text);
        Assert.DoesNotContain("password", text); Assert.DoesNotContain("messages", text);
        var receipt = JsonSerializer.Deserialize<PublishOmlReceipt>(text, PublishOmlProtocol.Json)!;
        Assert.False(receipt.Ok); Assert.Equal("uncertain", receipt.State);
    }
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }
}
