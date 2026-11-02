using System.Text;
using System.Text.Json.Nodes;
using Ssam.Agent;
using Xunit;

public class PrivatePromptCompletionTests
{
    [Fact]
    public async Task CompletionDuringSignOutCannotRestorePrivateCredential()
    {
        var kind = new CredentialKinds(Path.Combine(Path.GetTempPath(), "r40-signout-race-" + Guid.NewGuid().ToString("N")), "a", new()) { ForceWindows = true };
        kind.ApplyPromptCompletion(Request("prompt"), Completion(), kind.PromptGeneration);
        var pendingGeneration = kind.PromptGeneration;
        kind.Helper = p => {
            Assert.NotNull(p["privateCredential"]);
            kind.ApplyPromptCompletion(Request("prompt"), Completion(), pendingGeneration);
            return Task.FromResult(new JsonObject { ["ok"] = true });
        };
        await kind.Execute(Request("sign-out"), CancellationToken.None);
        kind.Helper = p => { Assert.Null(p["privateCredential"]); return Task.FromResult(new JsonObject { ["ok"] = true }); };
        await kind.Execute(Request(), CancellationToken.None);
    }

    [Fact]
    public async Task SessionChangeAfterPostIsUncertainAndNeverReplayed()
    {
        var kind = new CredentialKinds(Path.Combine(Path.GetTempPath(), "r40-post-race-" + Guid.NewGuid().ToString("N")), "a", new()) { ForceWindows = true, Lookup = _ => Task.FromResult(new[] { "93.184.216.34" }) };
        var sent = 0;
        kind.Helper = p => {
            sent++;
            kind.ApplyPromptCompletion(Request("prompt"), Completion(), kind.PromptGeneration);
            return Task.FromResult(new JsonObject { ["ok"] = true, ["status"] = 200 });
        };
        var request = Request("request"); request["method"] = "POST"; request["url"] = "https://tenant.example.com/ServiceCenter/";
        var failure = await Assert.ThrowsAsync<AgentFault>(() => kind.Execute(request, CancellationToken.None));
        Assert.Equal("CREDENTIAL_SESSION_CHANGED", failure.Code);
        Assert.Null(failure.Executed);
        Assert.Equal(1, sent);
    }

    [Theory]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("{\"key\":-1}")]
    [InlineData("{\"key\":\"1\"}")]
    public async Task CorruptRetryMetadataPausesBeforeLogin(string contents)
    {
        var root = Path.Combine(Path.GetTempPath(), "r40-bad-brake-" + Guid.NewGuid().ToString("N"));
        var folder = Path.Combine(root, "private", "credential"); Directory.CreateDirectory(folder);
        File.WriteAllText(Path.Combine(folder, "sign-in-failures.json"), contents);
        var calls = 0;
        var kind = new CredentialKinds(root, "a", new()) { ForceWindows = true, Lookup = _ => Task.FromResult(new[] { "93.184.216.34" }), Helper = _ => { calls++; return Task.FromResult(new JsonObject { ["ok"] = true }); } };
        var failure = await Assert.ThrowsAsync<AgentFault>(() => kind.Execute(Request("login"), CancellationToken.None));
        Assert.Equal("CREDENTIAL_LOGIN_PAUSED", failure.Code);
        Assert.Equal(0, calls);
        Assert.Equal(contents, File.ReadAllText(Path.Combine(folder, "sign-in-failures.json")));
    }
    private static string Profile => new('a', 64);
    private static JsonObject Request(string op = "status", string auth = "credential") => new() { ["op"] = op, ["host"] = "tenant.example.com", ["service"] = "service-center", ["auth"] = auth };
    private static string Completion(bool remembered = false) => new JsonObject {
        ["ok"] = true, ["saved"] = true, ["remembered"] = remembered, ["profile"] = Profile,
        ["principal"] = "person@example.com", ["privateCredential"] = remembered ? null : new JsonObject { ["username"] = "person@example.com", ["password"] = "private-test-sentinel" }
    }.ToJsonString();
    [Theory]
    [InlineData("{}")]
    [InlineData("{\"ok\":true,\"saved\":true,\"remembered\":false}")]
    [InlineData("{\"ok\":true,\"saved\":false,\"remembered\":false,\"privateCredential\":{}}")]
    [InlineData("{\"ok\":true,\"saved\":true,\"remembered\":true,\"privateCredential\":null}")]
    [InlineData("{\"ok\":true,\"saved\":true,\"remembered\":false,\"privateCredential\":{\"username\":\"u\",\"password\":\"s\",\"extra\":1}}")]
    public void RejectsMalformedPrivateCompletion(string raw) => Assert.ThrowsAny<Exception>(() => PrivatePromptCompletion.Parse(raw));

    [Fact]
    public void RejectsOversizeAndAcceptsCancellation()
    {
        Assert.ThrowsAny<Exception>(() => PrivatePromptCompletion.Parse(new string(' ', 32769)));
        Assert.False(PrivatePromptCompletion.Parse("{\"ok\":true,\"saved\":false,\"remembered\":false}")["saved"]!.GetValue<bool>());
    }

    [Fact]
    public async Task EphemeralCredentialStaysPrivateAndSupportsExplicitProfileAndBasicAlias()
    {
        var root = Path.Combine(Path.GetTempPath(), "r40-native-memory-" + Guid.NewGuid().ToString("N"));
        var kind = new CredentialKinds(root, "account-a", new()) { ForceWindows = true };
        kind.ApplyPromptCompletion(Request("prompt"), Completion(), kind.PromptGeneration);
        kind.Helper = p => {
            Assert.Equal("private-test-sentinel", p["privateCredential"]?["password"]?.GetValue<string>());
            Assert.Equal(Profile, p["profile"]?.GetValue<string>());
            return Task.FromResult(new JsonObject { ["ok"] = true, ["available"] = true, ["principal"] = "person@example.com", ["profile"] = Profile });
        };
        foreach (var auth in new[] { "credential", "basic" }) {
            var request = Request(auth: auth); request["profile"] = Profile;
            var result = await kind.Execute(request, CancellationToken.None);
            Assert.True(result["available"]!.GetValue<bool>());
            Assert.False(result["remembered"]!.GetValue<bool>());
            Assert.DoesNotContain("private-test-sentinel", result.ToJsonString());
        }
        foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)) Assert.DoesNotContain("private-test-sentinel", File.ReadAllText(file));
        var restarted = new CredentialKinds(root, "account-a", new()) { ForceWindows = true };
        restarted.Helper = p => { Assert.Null(p["privateCredential"]); return Task.FromResult(new JsonObject { ["ok"] = true }); };
        await restarted.Execute(Request(), CancellationToken.None);
    }

    [Fact]
    public async Task CancellationPreservesMemoryAndSignOutRejectsLateCompletion()
    {
        var kind = new CredentialKinds(Path.Combine(Path.GetTempPath(), "r40-native-cancel-" + Guid.NewGuid().ToString("N")), "a", new()) { ForceWindows = true };
        kind.ApplyPromptCompletion(Request("prompt"), Completion(), kind.PromptGeneration);
        var oldGeneration = kind.PromptGeneration;
        kind.ApplyPromptCompletion(Request("prompt"), "{\"ok\":true,\"saved\":false,\"remembered\":false}", oldGeneration);
        var expected = true;
        kind.Helper = p => { Assert.Equal(expected, p["privateCredential"] != null); return Task.FromResult(new JsonObject { ["ok"] = true }); };
        await kind.Execute(Request(), CancellationToken.None);
        await kind.Execute(Request("sign-out"), CancellationToken.None);
        expected = false;
        kind.ApplyPromptCompletion(Request("prompt"), Completion(), oldGeneration);
        await kind.Execute(Request(), CancellationToken.None);
    }

    [Fact]
    public async Task SecretEchoIsRemovedWithoutHelperRegistration()
    {
        var kind = new CredentialKinds(Path.Combine(Path.GetTempPath(), "r40-native-echo-" + Guid.NewGuid().ToString("N")), "a", new()) { ForceWindows = true, Lookup = _ => Task.FromResult(new[] { "93.184.216.34" }) };
        kind.ApplyPromptCompletion(Request("prompt"), Completion(), kind.PromptGeneration);
        kind.Helper = p => Task.FromResult(new JsonObject { ["ok"] = true, ["status"] = 200, ["contentType"] = "text/plain", ["body"] = Convert.ToBase64String(Encoding.UTF8.GetBytes("private-test-sentinel")), ["url"] = "https://tenant.example.com/ServiceCenter/", ["location"] = "" });
        var request = Request("request"); request["method"] = "GET"; request["url"] = "https://tenant.example.com/ServiceCenter/";
        var result = await kind.Execute(request, CancellationToken.None);
        Assert.Equal("[redacted]", Encoding.UTF8.GetString(Convert.FromBase64String(result["body"]!.GetValue<string>())));
    }

    [Fact]
    public async Task UsersMemoryFlowsThroughProductionCallsAndSignOutDiscardsLatePrompt()
    {
        const string host = "tenant.example.com";
        var kind = new UsersKinds(Path.Combine(Path.GetTempPath(), "r40-native-users-memory-" + Guid.NewGuid().ToString("N")), "a") { ForceWindows = true, Lookup = _ => Task.FromResult(new[] { "93.184.216.34" }) };
        var expected = true; var observed = new List<string>();
        kind.HelperCall = (mode, _, input) => {
            var p = input.Length == 0 ? new JsonObject() : JsonNode.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(input)))!.AsObject();
            if (mode is "status" or "login" or "request" or "sign-out") { observed.Add(mode); Assert.Equal(expected, p["privateCredential"] != null); }
            return Task.FromResult(new JsonObject { ["ok"] = true, ["available"] = expected, ["principal"] = "person@example.com", ["authenticated"] = true,
                ["status"] = 200, ["body"] = Convert.ToBase64String(Encoding.UTF8.GetBytes("<html>private-test-sentinel</html>")), ["setCookie"] = new JsonArray(), ["contentType"] = "text/html", ["location"] = "" });
        };
        kind.ApplyLoginCompletion(host, Completion(), kind.CredentialGeneration(host));
        var generation = kind.CredentialGeneration(host);
        kind.ApplyLoginCompletion(host, "{\"ok\":true,\"saved\":false,\"remembered\":false}", generation);
        JsonObject P(string op) => new() { ["op"] = op, ["host"] = host };
        var status = await kind.Execute(P("status"), CancellationToken.None);
        Assert.False(status!["remembered"]!.GetValue<bool>());
        await kind.Execute(P("login"), CancellationToken.None);
        var request = P("request"); request["url"] = "https://" + host + "/Users/User_List.aspx";
        var response = await kind.Execute(request, CancellationToken.None);
        Assert.Contains("[redacted]", Encoding.UTF8.GetString(Convert.FromBase64String(response!["body"]!.GetValue<string>())));
        Assert.NotNull(response["notes"]);
        await kind.Execute(P("sign-out"), CancellationToken.None);
        expected = false;
        kind.ApplyLoginCompletion(host, Completion(), generation);
        await kind.Execute(P("status"), CancellationToken.None);
        Assert.Contains("login", observed); Assert.Contains("request", observed); Assert.Contains("sign-out", observed);
    }
}
