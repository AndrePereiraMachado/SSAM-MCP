using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Ssam.Agent;
using Xunit;

public class CognitoPortalTests
{
    [Theory]
    [InlineData("ok", null)]
    [InlineData("no-session", null)]
    [InlineData("mfa", "CREDENTIAL_AUTH_INTERACTIVE_REQUIRED")]
    [InlineData("bad-b", "CREDENTIAL_AUTH_RESPONSE_INVALID")]
    [InlineData("bad-region", "CREDENTIAL_AUTH_CONTRACT_CHANGED")]
    [InlineData("foreign", "CREDENTIAL_AUTH_ORIGIN_REFUSED")]
    [InlineData("state", "CREDENTIAL_AUTH_STATE_INVALID")]
    [InlineData("issuer", "CREDENTIAL_IDENTITY_TOKEN_INVALID")]
    [InlineData("audience", "CREDENTIAL_IDENTITY_TOKEN_INVALID")]
    [InlineData("subject", "CREDENTIAL_IDENTITY_TOKEN_INVALID")]
    [InlineData("use", "CREDENTIAL_IDENTITY_TOKEN_INVALID")]
    [InlineData("expired", "CREDENTIAL_IDENTITY_TOKEN_INVALID")]
    [InlineData("no-cookie", "CREDENTIAL_LOGIN_FAILED")]
    [InlineData("no-proof", "CREDENTIAL_AUTH_CONTRACT_CHANGED")]
    public async Task SrpLoginRequiresValidTokensStateAndProtectedProof(string mode, string? expected)
    {
        const string origin = "https://tenant.example.test";
        const string realm = "/auth/realms/11111111-1111-1111-1111-111111111111";
        const string client = "abcdefghij123456";
        const string issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Pool";
        using var rsa = RSA.Create(2048); var pub = rsa.ExportParameters(false);
        static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        string Jwt(bool access) {
            var c = new JsonObject { ["iss"] = mode == "issuer" ? "wrong" : issuer, ["sub"] = mode == "subject" && access ? "wrong" : "subject", ["iat"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds(), ["exp"] = DateTimeOffset.UtcNow.AddMinutes(mode == "expired" ? -5 : 5).ToUnixTimeSeconds(), ["token_use"] = mode == "use" ? "wrong" : access ? "access" : "id" };
            if (access) { c["client_id"] = client; c["username"] = "canonical"; }
            else { c["aud"] = mode == "audience" ? "wrong" : client; c["cognito:username"] = "canonical"; }
            var data = B64(Encoding.UTF8.GetBytes("{\"alg\":\"RS256\",\"kid\":\"test\"}")) + "." + B64(Encoding.UTF8.GetBytes(c.ToJsonString()));
            return data + "." + B64(rsa.SignData(Encoding.ASCII.GetBytes(data), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
        }
        var initiated = 0; var responded = 0; var tokenProcessed = 0; var proofRead = false;
        MacHttpResponse Reply(object data, int status = 200, string location = "") => new(status, Encoding.UTF8.GetBytes(data is string s ? s : System.Text.Json.JsonSerializer.Serialize(data)), "application/json", location);
        Task<MacHttpResponse> Transport(Uri uri, string method, CookieContainer jar, byte[]? bytes, string? type, IReadOnlyDictionary<string,string>? headers, CancellationToken ct) {
            var path = uri.AbsolutePath; var body = bytes == null ? null : JsonNode.Parse(bytes);
            if (uri.Host == "cognito-idp.us-east-1.amazonaws.com") {
                if (path.EndsWith("jwks.json")) return Task.FromResult(Reply(new { keys = new[] { new { kid = "test", kty = "RSA", alg = "RS256", n = B64(pub.Modulus!), e = B64(pub.Exponent!) } } }));
                Assert.DoesNotContain("private-password", Encoding.UTF8.GetString(bytes!));
                if (headers!["X-Amz-Target"].EndsWith(".InitiateAuth")) {
                    initiated++; Assert.Equal("USER_SRP_AUTH", body!["AuthFlow"]!.GetValue<string>()); Assert.NotNull(body["AuthParameters"]?["SRP_A"]);
                    return Task.FromResult(Reply(new { ChallengeName = "PASSWORD_VERIFIER", Session = mode == "no-session" ? null : "challenge-session", ChallengeParameters = new { USER_ID_FOR_SRP = "canonical", SRP_B = mode == "bad-b" ? "0" : "5", SALT = "80", SECRET_BLOCK = "c2VjcmV0LWJsb2Nr" } }));
                }
                responded++; Assert.Equal("PASSWORD_VERIFIER", body!["ChallengeName"]!.GetValue<string>()); Assert.Equal("canonical", body["ChallengeResponses"]!["USERNAME"]!.GetValue<string>()); Assert.NotEmpty(body["ChallengeResponses"]!["PASSWORD_CLAIM_SIGNATURE"]!.GetValue<string>());
                if (mode == "mfa") return Task.FromResult(Reply(new { ChallengeName = "SMS_MFA" }));
                return Task.FromResult(Reply(new { AuthenticationResult = new { TokenType = "Bearer", IdToken = Jwt(false), AccessToken = Jwt(true), RefreshToken = "synthetic-refresh-token" } }));
            }
            Assert.Equal("tenant.example.test", uri.Host);
            if (path.EndsWith("moduleversioninfo")) return Task.FromResult(Reply(new { versionToken = "v" }));
            var module = path.Split('/')[1];
            if (path == "/" + module + "/") return Task.FromResult(Reply("<script src='scripts/_osbundle-test.index.js'></script>"));
            if (path.EndsWith(".index.js")) return Task.FromResult(Reply(string.Join(";", new[] { "UnifiedAuthentication.login", "UnifiedAuthentication.oslogin", "UnifiedAuthentication.redirect", "Connections.connections" }.Select(v => "screenName:'" + v + "',import('./flow.js')"))));
            if (path.EndsWith("flow.js")) return Task.FromResult(Reply(string.Join(";", new[] { "authentication/UnifiedAuthentication/login/DataActionGetProviders", "authentication/UnifiedAuthentication/oslogin/DataActionGetRedirect", "authentication/UnifiedAuthentication/login/ActionProcessCognitoToken", "authentication/UnifiedAuthentication/redirect/ActionProcessCodeRedirect", "connections/Connections/connections/DataActionGetProviders" }.Select(a => "'screenservices/" + a + "','v'"))));
            if (path.EndsWith("login/DataActionGetProviders")) return Task.FromResult(Reply(new { data = new { CognitoEnabled = true, CognitoConfig = new { Region = mode == "bad-region" ? "evil.example" : "us-east-1", PoolKey = "us-east-1_Pool", AmplifyClientKey = client, AuthFlow = "USER_SRP_AUTH" } } }));
            if (path.EndsWith("DataActionGetRedirect")) return Task.FromResult(Reply(new { data = new { Url = origin + realm + "/protocol/openid-connect/auth?response_type=code&client_id=unified&redirect_uri=" + Uri.EscapeDataString(origin + "/authentication/redirect") + "&state=initial" } }));
            if (path.EndsWith("/protocol/openid-connect/auth")) return Task.FromResult(Reply("", 302, (mode == "foreign" ? "https://foreign.invalid" : origin) + "/authentication/login?response_type=code&client_id=broker&state=broker-state&redirect_uri=" + Uri.EscapeDataString(origin + realm + "/broker/os-builtin/endpoint")));
            if (path.EndsWith("ActionProcessCognitoToken")) { tokenProcessed++; Assert.Equal("broker", body!["inputParameters"]!["ClientId"]!.GetValue<string>()); return Task.FromResult(Reply(new { AuthCode = "broker-code" })); }
            if (path.EndsWith("/broker/os-builtin/endpoint")) return Task.FromResult(Reply("", 302, origin + "/authentication/redirect?code=final-code&state=" + (mode == "state" ? "wrong" : "initial")));
            if (path.EndsWith("ActionProcessCodeRedirect")) { if (mode != "no-cookie") jar.Add(new Uri(origin), new Cookie("session", "synthetic-cookie", "/")); return Task.FromResult(Reply(new { })); }
            if (path.EndsWith("connections/DataActionGetProviders")) { proofRead = true; return Task.FromResult(Reply(mode == "no-proof" ? "{}" : "{\"data\":{\"Providers\":[]}}")); }
            throw new InvalidOperationException("Unexpected fixture route " + path);
        }
        var task = () => MacCredentialAuth.LoginAsync(new JsonObject { ["host"] = "tenant.example.test", ["service"] = "odc-portal", ["auth"] = "credential", ["profile"] = "p" }, new JsonObject { ["username"] = "owner@example.test", ["password"] = "private-password" }, new CookieContainer(), CancellationToken.None, Transport);
        if (expected == null) { var result = await task(); Assert.True(result["authenticated"]!.GetValue<bool>()); Assert.True(proofRead); }
        else { var error = await Assert.ThrowsAsync<AgentFault>(task); Assert.Equal(expected, error.Code); }
        Assert.InRange(initiated, 0, 1); Assert.InRange(responded, 0, 1);
        if (mode is "issuer" or "audience" or "subject" or "use" or "expired" or "mfa" or "bad-b") Assert.Equal(0, tokenProcessed);
    }
}
