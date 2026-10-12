using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

// One exact native creation response is projected before generic shaping or
// journaling. The one-time secret is delivered only to an injected vault writer.
internal static class PortalApiClientSecret {
    internal const string Operation = "apiClients.create";
    internal const string Path = "/usersaccess/screenservices/usersaccess/APIClients/apiclient/ActionAPIClients_Create";
    private static bool Exact(JsonObject? value, params string[] keys) => value != null
        && value.Count == keys.Length && keys.All(value.ContainsKey);
    internal static string Target(string host, string operationUuid) {
        PortalCore.CheckHost(host);
        if (!Guid.TryParseExact(operationUuid, "D", out var id) || id.ToString() != operationUuid)
            throw new PortalCore.Refusal("BAD_REQUEST", "A canonical creation UUID is required.");
        return "SSAM/ODC3/" + host + "/APIClientFixture/" + operationUuid;
    }
    internal static string Validate(PortalCore.WebRequest request, string host, DateTimeOffset now) {
        var p = request.Body?["inputParameters"] as JsonObject;
        var create = p?["OIDCClientCreate"] as JsonObject;
        if (request.OperationId != Operation || request.Path != Path || request.Method != "POST" || !request.Write
            || request.SecretRefs is {Count: > 0} || !Exact(p,"OIDCClientCreate")
            || !Exact(create,"Name","Description","SecretExpiresAt","IsActive","IsSendSecretExpiryEmail","Permissions")
            || create!["Name"] is not JsonValue name || !name.TryGetValue<string>(out var fixtureName)
            || !Regex.IsMatch(fixtureName, "^SSAMApiClientProof[0-9]{8}[A-Za-z0-9]{0,16}$", RegexOptions.CultureInvariant)
            || create["Description"] is not JsonValue description || !description.TryGetValue<string>(out var text) || text.Length > 200
            || create["IsActive"] is not JsonValue active || !active.TryGetValue<bool>(out var isActive) || !isActive
            || create["IsSendSecretExpiryEmail"] is not JsonValue email || !email.TryGetValue<bool>(out var sendEmail) || sendEmail
            || create["SecretExpiresAt"] is not JsonValue expires || !expires.TryGetValue<string>(out var expiresText)
            || !Regex.IsMatch(expiresText, "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,7})?Z$")
            || !DateTimeOffset.TryParse(expiresText, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var expiry)
            || expiry <= now.AddMinutes(10) || expiry > now.AddDays(2)
            || create["Permissions"] is not JsonObject permissions || !Exact(permissions,"List")
            || permissions["List"] is not JsonArray {Count: 0}
            || request.Body?["screenData"]?["variables"] is not JsonObject {Count: 0}
            || request.Body?["clientVariables"] is not JsonObject {Count: 0})
            throw new PortalCore.Refusal("NOT_ALLOWED", "Only a short-lived own API Client fixture with zero permissions and no notification is supported.");
        return Target(host, request.OperationUuid!);
    }
    internal static JsonObject Capture(JsonObject native, PortalCore.WebRequest request, string host,
        Func<string,string,string,bool> store, Action<JsonObject>? record = null) {
        var data = native["data"] as JsonObject;
        if (native["exception"] != null || native["error"] != null
            || (bool?)native["versionInfo"]?["hasApiVersionChanged"] == true
            || (bool?)native["versionInfo"]?["hasModuleVersionChanged"] == true
            || data?["Key"] is not JsonValue keyValue || !keyValue.TryGetValue<string>(out var key) || !Guid.TryParseExact(key,"D",out _)
            || data["ClientId"] is not JsonValue idValue || !idValue.TryGetValue<string>(out var clientId)
            || !Regex.IsMatch(clientId,"^[A-Za-z0-9_-]{1,128}$",RegexOptions.CultureInvariant)
            || data["ClientSecret"] is not JsonValue secretValue || !secretValue.TryGetValue<string>(out var secret)
            || secret.Length is < 16 or > 512 || secret.Any(char.IsControl) || secret.Any(char.IsWhiteSpace))
            throw new InvalidOperationException("The API Client creation response could not be verified.");
        var proof = new JsonObject { ["key"] = key, ["name"] = (string?)request.Body?["inputParameters"]?["OIDCClientCreate"]?["Name"],
            ["operationUuid"] = request.OperationUuid, ["vaultRef"] = "urn:ssam:api-client:" + request.OperationUuid,
            ["vaultStored"] = false, ["rawValueExposed"] = false, ["responseProjected"] = true };
        // Persist the public remote identity before the one-time secret enters
        // the vault, so a lost answer cannot leave an unidentified local entry.
        record?.Invoke(proof);
        bool stored;
        try { stored = store(Target(host,request.OperationUuid!),clientId,secret); }
        catch { stored = false; }
        // Never copy native fields: unexpected echo fields can contain the secret.
        proof["vaultStored"] = stored;
        record?.Invoke(proof);
        return proof;
    }
}
