using System.Text.Json.Nodes;
using Ssam.Agent;
using Xunit;

public class CredentialStorageTests
{
    private static string Root() => Path.Combine(Path.GetTempPath(), "credential-storage-" + Guid.NewGuid().ToString("N"));
    private static JsonObject Request(string op) => new() { ["op"] = op, ["host"] = "tenant.example.test", ["service"] = "odc-portal", ["auth"] = "credential" };

    [Fact]
    public async Task StatusPreservesInstalledConnectionCredential()
    {
        if (!OperatingSystem.IsWindows()) return;
        var root = Root();
        Directory.CreateDirectory(Path.Combine(root, "private"));
        var credential = Path.Combine(root, "private", "credential");
        await File.WriteAllTextAsync(credential, "synthetic-connection-credential");
        var kind = new CredentialKinds(root, "fixture", new());
        var result = await kind.Execute(Request("status"), CancellationToken.None);
        Assert.False(result["available"]!.GetValue<bool>());
        Assert.Equal("synthetic-connection-credential", await File.ReadAllTextAsync(credential));
    }

    [Fact]
    public async Task LegacyRetryBrakeIsPreserved()
    {
        var root = Root();
        var legacy = Path.Combine(root, "private", "credential");
        Directory.CreateDirectory(legacy);
        var file = Path.Combine(legacy, "sign-in-failures.json");
        await File.WriteAllTextAsync(file, "invalid-json");
        var called = false;
        var kind = new CredentialKinds(root, "fixture", new()) { ForceWindows = true, Lookup = _ => Task.FromResult(new[] { "93.184.216.34" }), Helper = _ => { called = true; return Task.FromResult(new JsonObject()); } };
        var error = await Assert.ThrowsAsync<AgentFault>(() => kind.Execute(Request("login"), CancellationToken.None));
        Assert.Equal("CREDENTIAL_LOGIN_PAUSED", error.Code);
        Assert.False(called);
        Assert.Equal("invalid-json", await File.ReadAllTextAsync(file));
    }

    [Fact]
    public async Task FailedPromptPreparationReleasesSharedWindow()
    {
        var root = Root();
        Directory.CreateDirectory(root);
        await File.WriteAllTextAsync(Path.Combine(root, "private"), "blocked-directory");
        var runtime = new PrivateSessionRuntime();
        var kind = new CredentialKinds(root, "fixture", runtime) { ForceWindows = true, Lookup = _ => Task.FromResult(new[] { "93.184.216.34" }) };
        await Assert.ThrowsAnyAsync<Exception>(() => kind.Execute(Request("prompt"), CancellationToken.None));
        runtime.TakeWindow(DateTimeOffset.UtcNow, "USERS");
        runtime.TakeWindow(DateTimeOffset.UtcNow, "CREDENTIAL");
    }
}
