using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Ssam.Agent;
using Xunit;

public class MacCredentialAuthTests
{
    [Fact]
    public async Task DirectLoginSubmitsOnceThenProvesProtectedPageAndReturnsPrivateState()
    {
        var calls = new List<string>();
        var result = await MacCredentialAuth.LoginAsync(new JsonObject { ["host"] = "tenant.example", ["service"] = "service-center", ["auth"] = "credential", ["profile"] = "test-profile" },
            new JsonObject { ["username"] = "synthetic", ["password"] = "synthetic-secret" }, new CookieContainer(), CancellationToken.None,
            (uri, method, jar, body, type, headers, ct) => {
                calls.Add(method + " " + uri.AbsolutePath);
                if (method == "POST") {
                    Assert.Equal("application/x-www-form-urlencoded", type); Assert.Contains("password=synthetic-secret", Encoding.UTF8.GetString(body!));
                    jar.Add(uri, new Cookie("session", "fake-session-value", "/ServiceCenter/"));
                    return Task.FromResult(new MacHttpResponse(302, [], "text/html", "/ServiceCenter/Home.aspx"));
                }
                return Task.FromResult(new MacHttpResponse(200, Encoding.UTF8.GetBytes(calls.Count == 1 ? Form : "<a href='Logout.aspx'>Logout</a>"), "text/html", ""));
            });
        Assert.Equal(1, calls.Count(c => c.StartsWith("POST", StringComparison.Ordinal)));
        Assert.Equal("GET /ServiceCenter/Error_Logs.aspx", calls[^1]);
        Assert.True(result["authenticated"]!.GetValue<bool>());
        Assert.Equal("synthetic", result["privateSession"]!["principal"]!.GetValue<string>());
        Assert.Single(result["privateSession"]!["cookies"]!.AsArray());
    }
    [Fact]
    public async Task ApiClientOnlyUsesDiscoveredSameHostEndpoint()
    {
        var calls = 0;
        var result = await MacCredentialAuth.LoginAsync(new JsonObject { ["host"] = "tenant.example", ["service"] = "odc-portal", ["auth"] = "api-client", ["profile"] = "p" },
            new JsonObject { ["username"] = "fake-client", ["password"] = "fake-secret" }, new CookieContainer(), CancellationToken.None,
            (uri, method, jar, body, type, headers, ct) => {
                calls++; if (calls == 1) return Task.FromResult(new MacHttpResponse(200, Encoding.UTF8.GetBytes("{\"token_endpoint\":\"https://tenant.example/identity/token\",\"grant_types_supported\":[\"client_credentials\"],\"token_endpoint_auth_methods_supported\":[\"client_secret_post\"]}"), "application/json", ""));
                Assert.Equal("/identity/token", uri.AbsolutePath); Assert.Equal("POST", method);
                return Task.FromResult(new MacHttpResponse(200, Encoding.UTF8.GetBytes("{\"token_type\":\"Bearer\",\"access_token\":\"fake-token\",\"expires_in\":60}"), "application/json", ""));
            });
        Assert.Equal(2, calls); Assert.Equal("fake-token", result["privateSession"]!["token"]!.GetValue<string>());
    }
    [Fact]
    public async Task PasswordSubmissionCannotFallBackToAnotherProvider()
    {
        var calls = 0;
        var fault = await Assert.ThrowsAsync<AgentFault>(() => MacCredentialAuth.LoginAsync(new JsonObject { ["host"] = "tenant.example", ["service"] = "service-center", ["auth"] = "credential" },
            new JsonObject { ["username"] = "fake-user", ["password"] = "fake-password" }, new CookieContainer(), CancellationToken.None,
            (uri, method, jar, body, type, headers, ct) => { calls++; return Task.FromResult(method == "POST" ? new MacHttpResponse(302, [], "text/html", "https://id.outsystems.com/community/login") : new MacHttpResponse(200, Encoding.UTF8.GetBytes(Form), "text/html", "")); }));
        Assert.Equal("CREDENTIAL_AUTH_UNSUPPORTED", fault.Code); Assert.Equal(2, calls);
    }
    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("::1")]
    [InlineData("::ffff:192.168.1.1")]
    [InlineData("10.0.0.1")]
    [InlineData("100.64.0.1")]
    [InlineData("169.254.169.254")]
    [InlineData("172.16.0.1")]
    [InlineData("198.18.0.1")]
    [InlineData("224.0.0.1")]
    [InlineData("fc00::1")]
    [InlineData("2002:7f00:1::1")]
    public void PrivateAndTransitionAddressesAreRefused(string address) => Assert.False(MacCredentialAuth.IsPublicAddress(IPAddress.Parse(address)));

    [Theory]
    [InlineData("http://tenant.example/ServiceCenter/")]
    [InlineData("https://tenant.example:444/ServiceCenter/")]
    [InlineData("https://user@tenant.example/")]
    [InlineData("https://other.example/")]
    [InlineData("https://tenant.example/%2fprivate")]
    [InlineData("https://tenant.example/#fragment")]
    public void AuthenticationOriginIsExact(string url) => Assert.Equal("CREDENTIAL_AUTH_ORIGIN_REFUSED", Assert.Throws<AgentFault>(() => MacCredentialAuth.ValidateUri("tenant.example", url)).Code);

    private const string Form = "<form method='post' action='/ServiceCenter/Login.aspx'><input type='hidden' name='state' value='x&amp;y'><div class='login-form'><input name='username'><input type='password' name='password'><button type='submit' name='sign' value='go'>Sign in</button></div></form>";
    [Fact]
    public void LoginFormPreservesHiddenStateAndFindsScopedFields()
    {
        var plan = MacCredentialAuth.ParseLoginPlan(Form, new Uri("https://tenant.example/ServiceCenter/Login.aspx"));
        Assert.Equal("username", plan.User); Assert.Equal("password", plan.Password);
        Assert.Equal("x&y", plan.Fields["state"]); Assert.Equal("go", plan.Fields["sign"]);
    }
    [Theory]
    [InlineData("<input name='extra'>")]
    [InlineData("<input type='password' name='second'>")]
    [InlineData("<input type='hidden' name='state' value='duplicate'>")]
    [InlineData("<select name='selection'></select>")]
    public void AmbiguousOrUnsupportedFormsDoNotSubmit(string extra)
    {
        var html = Form.Replace("</div>", extra + "</div>");
        Assert.Equal("CREDENTIAL_LOGIN_LAYOUT_CHANGED", Assert.Throws<AgentFault>(() => MacCredentialAuth.ParseLoginPlan(html, new Uri("https://tenant.example/ServiceCenter/Login.aspx"))).Code);
    }
    [Fact]
    public void ExternalFormActionAndScriptSubmissionAreRefused()
    {
        var uri = new Uri("https://tenant.example/ServiceCenter/Login.aspx");
        Assert.Throws<AgentFault>(() => MacCredentialAuth.ParseLoginPlan(Form.Replace("/ServiceCenter/Login.aspx", "https://other.example/"), uri));
        Assert.Throws<AgentFault>(() => MacCredentialAuth.ParseLoginPlan(Form.Replace("name='sign'", "name='sign' onclick='OsAjax()'"), uri));
        Assert.False(MacCredentialAuth.ProtectedServiceCenter(Form + "<a href='Logout.aspx'>Logout</a>"));
        Assert.True(MacCredentialAuth.ProtectedServiceCenter("<a href='Logout.aspx'>Log out</a>"));
    }
    [Fact]
    public void CsrfSupportsCookieAndNestedCookieButRejectsHeaderInjection()
    {
        var uri = new Uri("https://tenant.example/"); var jar = new CookieContainer();
        jar.Add(uri, new Cookie("nr2abc", Uri.EscapeDataString("other=1;crf=safe-value"), "/"));
        Assert.Equal("safe-value", MacCredentialAuth.GetPortalCsrf(jar, uri));
        jar.Add(uri, new Cookie("crf", "direct-value", "/")); Assert.Equal("direct-value", MacCredentialAuth.GetPortalCsrf(jar, uri));
    }
    private static string B64(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    [Fact]
    public void IdentityTokenRequiresSignatureIssuerAudienceNonceSubjectAndTime()
    {
        using var rsa = RSA.Create(2048); var pub = rsa.ExportParameters(false);
        var jwks = new JsonObject { ["keys"] = new JsonArray(new JsonObject { ["kid"] = "test", ["kty"] = "RSA", ["alg"] = "RS256", ["n"] = B64(pub.Modulus!), ["e"] = B64(pub.Exponent!) }) };
        var header = new JsonObject { ["kid"] = "test", ["alg"] = "RS256" };
        var claims = new JsonObject { ["iss"] = "issuer", ["sub"] = "subject", ["aud"] = "client", ["nonce"] = "nonce", ["iat"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds(), ["exp"] = DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeSeconds() };
        string Token() { var input = B64(Encoding.UTF8.GetBytes(header.ToJsonString())) + "." + B64(Encoding.UTF8.GetBytes(claims.ToJsonString())); return input + "." + B64(rsa.SignData(Encoding.ASCII.GetBytes(input), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)); }
        Assert.Equal("subject", MacCredentialAuth.VerifyIdentityJwt(Token(), jwks, "issuer", "client", "nonce", "subject")["sub"]!.GetValue<string>());
        foreach (var field in new[] { "iss", "aud", "nonce", "sub" }) { var old = claims[field]!.DeepClone(); claims[field] = "wrong"; Assert.Throws<AgentFault>(() => MacCredentialAuth.VerifyIdentityJwt(Token(), jwks, "issuer", "client", "nonce", "subject")); claims[field] = old; }
        claims["exp"] = "9999999999"; Assert.Throws<AgentFault>(() => MacCredentialAuth.VerifyIdentityJwt(Token(), jwks, "issuer"));
        claims["exp"] = DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeSeconds(); header["jku"] = "https://attacker.example/keys"; Assert.Throws<AgentFault>(() => MacCredentialAuth.VerifyIdentityJwt(Token(), jwks, "issuer"));
    }
}
