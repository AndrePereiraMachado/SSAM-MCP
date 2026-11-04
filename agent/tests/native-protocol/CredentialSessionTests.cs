using System.Text;
using System.Text.Json.Nodes;
using Ssam.Agent;
using Xunit;

public class CredentialSessionTests
{
    private static JsonObject Request(string op = "status") => new() { ["op"] = op, ["host"] = "tenant.example.com", ["service"] = "service-center", ["auth"] = "credential" };
    [Theory]
    [InlineData("password")]
    [InlineData("cookie")]
    [InlineData("token")]
    public void RejectsSecretArguments(string field)
    {
        var p = Request(); p[field] = "sentinel";
        Assert.Throws<AgentFault>(() => CredentialKinds.Validate(p));
    }
    [Theory]
    [InlineData("https://other.example.com/ServiceCenter/")]
    [InlineData("https://tenant.example.com/Users/")]
    [InlineData("https://tenant.example.com/ServiceCenter/%2e%2e/private")]
    [InlineData("https://tenant.example.com/ServiceCenter/?access_token=value")]
    public void RejectsDestinations(string url)
    {
        var p = Request("request"); p["url"] = url; p["method"] = "GET";
        Assert.Throws<AgentFault>(() => CredentialKinds.Validate(p));
    }
    [Fact]
    public async Task PrivateStateNeverLeavesAndEchoesAreRedacted()
    {
        const string secret = "r40-native-secret-sentinel";
        var runtime = new PrivateSessionRuntime();
        var kind = new CredentialKinds(Path.Combine(Path.GetTempPath(), "r40-native-fixture"), "fixture", runtime) { ForceWindows = true, Lookup = _ => Task.FromResult(new[] { "93.184.216.34" }) };
        var count = 0;
        kind.Helper = p => {
            if (count++ == 0) return Task.FromResult(new JsonObject { ["ok"] = true, ["authenticated"] = true, ["privateSession"] = new JsonObject { ["token"] = secret }, ["secretValues"] = new JsonArray(secret) });
            Assert.Equal(secret, p["privateSession"]?["token"]?.GetValue<string>());
            return Task.FromResult(new JsonObject { ["ok"] = true, ["status"] = 200, ["contentType"] = "text/html", ["body"] = Convert.ToBase64String(Encoding.UTF8.GetBytes("echo " + secret)), ["location"] = "/" + secret, ["url"] = "https://tenant.example.com/ServiceCenter/" });
        };
        var login = await kind.Execute(Request("login"), CancellationToken.None);
        Assert.DoesNotContain(secret, login.ToJsonString());
        var request = Request("request"); request["url"] = "https://tenant.example.com/ServiceCenter/"; request["method"] = "GET";
        var response = await kind.Execute(request, CancellationToken.None);
        Assert.DoesNotContain(secret, response.ToJsonString());
        Assert.Equal("echo [redacted]", Encoding.UTF8.GetString(Convert.FromBase64String(response["body"]!.GetValue<string>())));
        Assert.Null(response["privateSession"]);
    }
    [Fact]
    public void WindowBudgetIsSharedByFamilies()
    {
        var runtime = new PrivateSessionRuntime(); runtime.Register(() => true);
        Assert.Throws<AgentFault>(() => runtime.TakeWindow(DateTimeOffset.UtcNow, "CREDENTIAL"));
        Assert.Throws<AgentFault>(() => runtime.TakeWindow(DateTimeOffset.UtcNow, "USERS"));
    }
    [Fact]
    public async Task NonUtf8PageIsPreservedOrExplicitlyNormalizedWhenRedacted()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        var latin = Encoding.GetEncoding(1252);
        var kind = new CredentialKinds(Path.Combine(Path.GetTempPath(), "r40-native-charset-" + Guid.NewGuid().ToString("N")), "fixture", new()) { ForceWindows = true, Lookup = _ => Task.FromResult(new[] { "93.184.216.34" }) };
        var redact = false;
        var payload = Convert.ToBase64String(latin.GetBytes("café €"));
        kind.Helper = _ => Task.FromResult(new JsonObject { ["ok"] = true, ["status"] = 200, ["body"] = payload, ["contentType"] = "text/html; charset=windows-1252", ["url"] = "https://tenant.example.com/ServiceCenter/", ["location"] = "", ["secretValues"] = redact ? new JsonArray("café") : new JsonArray() });
        var request = Request("request"); request["url"] = "https://tenant.example.com/ServiceCenter/"; request["method"] = "GET";
        var first = await kind.Execute(request, CancellationToken.None);
        Assert.Equal(payload, first["body"]!.GetValue<string>());
        redact = true;
        var second = await kind.Execute(request, CancellationToken.None);
        Assert.Equal("[redacted] €", Encoding.UTF8.GetString(Convert.FromBase64String(second["body"]!.GetValue<string>())));
        Assert.Contains("charset=utf-8", second["contentType"]!.GetValue<string>());
        Assert.Contains("normalized to UTF-8", second["notes"]!.ToJsonString());
    }
    [Fact]
    public async Task LoginBrakeSurvivesANewKindInstance()
    {
        var root = Path.Combine(Path.GetTempPath(), "r40-native-brake-" + Guid.NewGuid().ToString("N"));
        var calls = 0;
        CredentialKinds Make() => new(root, "fixture", new()) { ForceWindows = true, Lookup = _ => Task.FromResult(new[] { "93.184.216.34" }), Helper = _ => { calls++; return Task.FromResult(new JsonObject { ["ok"] = false, ["code"] = "CREDENTIAL_LOGIN_FAILED" }); } };
        var kind = Make();
        await Assert.ThrowsAsync<AgentFault>(() => kind.Execute(Request("login"), CancellationToken.None));
        await Assert.ThrowsAsync<AgentFault>(() => kind.Execute(Request("login"), CancellationToken.None));
        var error = await Assert.ThrowsAsync<AgentFault>(() => Make().Execute(Request("login"), CancellationToken.None));
        Assert.Equal("CREDENTIAL_LOGIN_PAUSED", error.Code);
        Assert.Equal(2, calls);
    }

    [Theory]
    [InlineData("a")]
    [InlineData("1")]
    public async Task ShortCookiePreservesPublicRoutingAndMime(string secret)
    {
        var kind = new CredentialKinds(Path.Combine(Path.GetTempPath(), "r40-short-cookie-" + Guid.NewGuid().ToString("N")), "fixture", new()) { ForceWindows = true, Lookup = _ => Task.FromResult(new[] { "93.184.216.34" }) };
        kind.Helper = _ => Task.FromResult(new JsonObject { ["ok"] = true, ["status"] = 200, ["contentType"] = "application/json; charset=utf-8", ["url"] = "https://hostile.invalid/private", ["body"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(new JsonObject { ["x"] = secret }.ToJsonString())), ["secretValues"] = new JsonArray(secret) });
        var request = Request("request"); request["url"] = "https://tenant.example.com/ServiceCenter/"; request["method"] = "GET";
        var result = await kind.Execute(request, CancellationToken.None);
        Assert.Equal(request["url"]!.GetValue<string>(), result["url"]!.GetValue<string>());
        Assert.Equal("application/json; charset=utf-8", result["contentType"]!.GetValue<string>());
        Assert.Equal("[redacted]", JsonNode.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(result["body"]!.GetValue<string>())))!["x"]!.GetValue<string>());
        Assert.NotNull(result["notes"]);
    }
    [Theory]
    [InlineData("application/json", "{\"value\":1}", "CREDENTIAL_RESPONSE_STRUCTURE_REDACTED")]
    [InlineData("application/json; secret=private-value", "{}", "CREDENTIAL_RESPONSE_METADATA_INVALID")]
    [InlineData("application/json", "not-json", "CREDENTIAL_RESPONSE_INVALID")]
    public async Task UnsafeResponseStructureIsFixedRefusal(string type, string body, string code)
    {
        var kind = new CredentialKinds(Path.Combine(Path.GetTempPath(), "r40-structure-" + Guid.NewGuid().ToString("N")), "fixture", new()) { ForceWindows = true, Lookup = _ => Task.FromResult(new[] { "93.184.216.34" }) };
        kind.Helper = _ => Task.FromResult(new JsonObject { ["ok"] = true, ["status"] = 200, ["contentType"] = type, ["body"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(body)), ["secretValues"] = new JsonArray("1") });
        var request = Request("request"); request["url"] = "https://tenant.example.com/ServiceCenter/"; request["method"] = "GET";
        var error = await Assert.ThrowsAsync<AgentFault>(() => kind.Execute(request, CancellationToken.None));
        Assert.Equal(code, error.Code);
        request["method"] = "POST";
        error = await Assert.ThrowsAsync<AgentFault>(() => kind.Execute(request, CancellationToken.None));
        Assert.Equal(code, error.Code); Assert.Null(error.Executed);
    }

    [Theory]
    [InlineData("/ServiceCenter/?x=private-token", true)]
    [InlineData("https://other.invalid/?x=private-token", false)]
    [InlineData("https://[invalid/", false)]
    public async Task RedirectMetadataIsSafeAndMimeIsCanonical(string location, bool expectedLocation)
    {
        var kind = new CredentialKinds(Path.Combine(Path.GetTempPath(), "r40-redirect-" + Guid.NewGuid().ToString("N")), "fixture", new()) { ForceWindows = true, Lookup = _ => Task.FromResult(new[] { "93.184.216.34" }) };
        kind.Helper = _ => Task.FromResult(new JsonObject { ["ok"] = true, ["status"] = 200, ["contentType"] = "Application/JSON; Charset=UTF-8", ["body"] = Convert.ToBase64String(Encoding.UTF8.GetBytes("{}")), ["location"] = location, ["secretValues"] = new JsonArray("private-token") });
        var request = Request("request"); request["url"] = "https://tenant.example.com/ServiceCenter/"; request["method"] = "GET";
        var result = await kind.Execute(request, CancellationToken.None);
        Assert.Equal("application/json; charset=utf-8", result["contentType"]!.GetValue<string>());
        Assert.Contains("content type was normalized", result["notes"]!.ToJsonString());
        var output = result["location"]!.GetValue<string>(); Assert.Equal(expectedLocation, output.Length > 0);
        if (expectedLocation) { Assert.Equal("tenant.example.com", new Uri(output).Host); Assert.DoesNotContain("private-token", output); }
    }
}
