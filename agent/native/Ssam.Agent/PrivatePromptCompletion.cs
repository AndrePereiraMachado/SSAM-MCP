using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

// This type never crosses the Agent channel. Only phase metadata may be written
// to a status file; the optional credential travels on private process pipes.
internal static class PrivatePromptCompletion
{
    internal const int MaxBytes = 32768;
    private static Exception Invalid() => new InvalidDataException("Invalid private prompt completion.");
    internal static JsonObject Parse(string text)
    {
        if (Encoding.UTF8.GetByteCount(text) > MaxBytes) throw Invalid();
        JsonObject value;
        try { value = JsonNode.Parse(text) as JsonObject ?? throw Invalid(); } catch { throw Invalid(); }
        string[] keys = ["ok", "saved", "remembered", "profile", "principal", "privateCredential"];
        if (value.Any(x => !keys.Contains(x.Key)) || value["ok"] is not JsonValue ok || !ok.TryGetValue<bool>(out var valid) || !valid
            || value["saved"] is not JsonValue saved || !saved.TryGetValue<bool>(out var accepted)
            || value["remembered"] is not JsonValue remembered || !remembered.TryGetValue<bool>(out var persisted)) throw Invalid();
        if (!accepted) { if (value.ContainsKey("privateCredential")) throw Invalid(); return new() { ["ok"] = true, ["saved"] = false, ["remembered"] = false }; }
        if (value.ContainsKey("profile") && (value["profile"] is not JsonValue profile || !profile.TryGetValue<string>(out var id) || !Regex.IsMatch(id, @"\A(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\z"))) throw Invalid();
        if (value.ContainsKey("principal") && (value["principal"] is not JsonValue namedPrincipal || !namedPrincipal.TryGetValue<string>(out var name) || name.Length > 1024 || name.Any(c => c < 32 || c == 127))) throw Invalid();
        if (persisted) { if (value.ContainsKey("privateCredential")) throw Invalid(); return value; }
        if (value["privateCredential"] is not JsonObject credential || credential.Count != 2
            || credential["username"] is not JsonValue user || !user.TryGetValue<string>(out var username)
            || credential["password"] is not JsonValue pass || !pass.TryGetValue<string>(out var password)
            || username.Length is < 1 or > 1024 || username.Any(c => c < 32 || c == 127) || password.Length is < 1 or > 8192) throw Invalid();
        if (value.ContainsKey("principal") && (value["principal"] is not JsonValue principal || !principal.TryGetValue<string>(out var named) || named != username)) throw Invalid();
        return value;
    }
    internal static async Task<JsonObject> Capture(Process process)
    {
        try {
            var output = Read(process.StandardOutput); var errors = Drain(process.StandardError);
            await process.WaitForExitAsync();
            var text = await output; await errors;
            if (process.ExitCode != 0) throw Invalid();
            return Parse(text);
        } catch { throw Invalid(); }
    }
    private static async Task<string> Read(StreamReader reader)
    {
        var text = new StringBuilder(); var buffer = new char[2048]; int count; var tooLarge = false;
        while ((count = await reader.ReadAsync(buffer)) > 0) {
            if (text.Length + count > MaxBytes) tooLarge = true;
            if (!tooLarge) text.Append(buffer, 0, count);
        }
        if (tooLarge) throw Invalid();
        return text.ToString();
    }
    private static async Task Drain(StreamReader reader)
    {
        var buffer = new char[2048]; while (await reader.ReadAsync(buffer) > 0) { }
    }
}
