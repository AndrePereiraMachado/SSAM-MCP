using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

internal static class CredentialSessionLifetime
{
    internal const string Note = "The private Portal session lifetime is limited to its access-token expiry.";
    // Unverified JWT claims can only shorten cache lifetime, never grant access.
    internal static bool Limit(JsonNode? state)
    {
        if (state is not JsonObject o || o["expiresAt"] is not JsonValue end || !end.TryGetValue<long>(out var until)) return false;
        var original = until;
        if (o["cookies"] is JsonArray cookies) foreach (var cookie in cookies) {
            if (cookie?["name"] is not JsonValue name || !name.TryGetValue<string>(out var n) || n is not ("TenantAccess" or "TenantAccessId")) continue;
            if (cookie?["value"] is not JsonValue value || !value.TryGetValue<string>(out var token) || token.Length > 65536) continue;
            try {
                var parts = token.Split('.');
                if (parts.Length != 3 || !Regex.IsMatch(parts[1], @"\A[A-Za-z0-9_-]+\z", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1))) continue;
                var payload = parts[1].Replace('-', '+').Replace('_', '/');
                payload = payload.PadRight((payload.Length + 3) / 4 * 4, '=');
                var claims = JsonNode.Parse(Convert.FromBase64String(payload));
                if (claims?["exp"] is JsonValue expiry && expiry.TryGetValue<long>(out var seconds) && seconds > 0 && seconds <= 9007199254740L)
                    until = Math.Min(until, seconds * 1000);
            } catch (Exception e) when (e is FormatException or System.Text.Json.JsonException or InvalidOperationException) { }
        }
        o["expiresAt"] = until;
        return until < original;
    }
}
