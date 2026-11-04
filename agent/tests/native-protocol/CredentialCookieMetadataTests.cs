using Ssam.Agent;
using Xunit;
using System.Text;
using System.Text.Json.Nodes;

public class CredentialCookieMetadataTests
{
    [Theory]
    [InlineData("TenantGeo", "US", false)]
    [InlineData("TenantPortfolio", "3", false)]
    [InlineData("TenantRing", "1", false)]
    [InlineData("TenantPref", "tenant", false)]
    [InlineData("TenantDomain", "tenant.outsystems.dev", false)]
    [InlineData("TenantAccessId", "tenant", true)]
    [InlineData("TenantAccess", "1", true)]
    [InlineData("TenantGeo", "US\n", true)]
    [InlineData("tenantgeo", "US", true)]
    [InlineData("TenantPortfolio", "1234567", true)]
    [InlineData("TenantRing", "secret-token", true)]
    [InlineData("session", "US", true)]
    [InlineData("osvisitaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "1", false)]
    [InlineData("osvisitaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0", false)]
    [InlineData("osvisitaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "1\n", true)]
    [InlineData("osvisitaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaax", "1", true)]
    [InlineData("osvisitaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "private-token", true)]
    [InlineData("osVisit", "1", true)]
    [InlineData("ASP.NET_SessionId", "1", true)]
    public void OnlyKnownBoundedMetadataIsPublic(string name, string value, bool expected)
        => Assert.Equal(expected, CookieSensitivity.IsSensitive(name, value));

    [Theory]
    [InlineData("odc-portal", "/monitoring/")]
    [InlineData("service-center", "/ServiceCenter/")]
    public async Task PublicMetadataDoesNotCorruptResponsesAndSessionTokensRemainSecret(string service, string path)
    {
        var root = Path.Combine(Path.GetTempPath(), "cookie-metadata-" + Guid.NewGuid().ToString("N"));
        var kind = new CredentialKinds(root, "fixture", new()) { ForceWindows = true, Lookup = _ => Task.FromResult(new[] { "93.184.216.34" }) };
        JsonObject Request(string op) => new() { ["op"] = op, ["host"] = "tenant.example.com", ["service"] = service, ["auth"] = "credential" };
        kind.Helper = p => Task.FromResult(p["op"]!.GetValue<string>() == "login"
            ? new JsonObject { ["ok"] = true, ["authenticated"] = true, ["privateSession"] = new JsonObject { ["cookies"] = new JsonArray(
                new JsonObject { ["name"] = "TenantGeo", ["value"] = "US" },
                new JsonObject { ["name"] = "TenantRing", ["value"] = "1" },
                new JsonObject { ["name"] = "osvisitaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ["value"] = "1" },
                new JsonObject { ["name"] = "TenantAccess", ["value"] = "private-token" }) } }
            : new JsonObject { ["ok"] = true, ["status"] = 200, ["contentType"] = "application/json", ["body"] = Convert.ToBase64String(Encoding.UTF8.GetBytes("{\"UserId\":\"app-123\",\"TotalResults\":19,\"echo\":\"private-token\"}")) });
        await kind.Execute(Request("login"), CancellationToken.None);
        var request = Request("request"); request["url"] = "https://tenant.example.com" + path; request["method"] = "GET";
        var response = await kind.Execute(request, CancellationToken.None);
        var body = Encoding.UTF8.GetString(Convert.FromBase64String(response["body"]!.GetValue<string>()));
        Assert.Equal("{\"UserId\":\"app-123\",\"TotalResults\":19,\"echo\":\"[redacted]\"}", body);
        Assert.Null(response["privateSession"]);
    }
}
