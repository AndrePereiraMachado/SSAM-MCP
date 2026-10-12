using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Ssam.PrivateTransport;

// One request's own broker session, delivered over a current-user-only local pipe.
// Never reads Studio/browser cookies, persists session material, or authenticates
// another principal. The caller still validates the destination, operation and
// authorization before resolving any vault secret or sending HTTP.
internal sealed record PrivateHttpContext(string Cookie, string Csrf)
{
    public override string ToString() => "PrivateHttpContext [redacted]";
    internal const int MaximumBytes = 65536;
    internal static string PipeName(string id)
    {
        if (!Guid.TryParseExact(id, "D", out _)) throw Invalid();
        return "SSAM-PrivateHttp-" + id.ToLowerInvariant();
    }

    internal static async Task<PrivateHttpContext> Receive(string pipeId, string requestSha256,
        string host, string principal, CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsWindows()) throw Invalid();
        using var pipe = new NamedPipeServerStream(PipeName(pipeId), PipeDirection.In, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.WaitForConnectionAsync(cancellationToken);
        var prefix = new byte[4];
        await pipe.ReadExactlyAsync(prefix, cancellationToken);
        var length = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(prefix);
        if (length is < 1 or > MaximumBytes) throw Invalid();
        var bytes = new byte[length];
        try {
            await pipe.ReadExactlyAsync(bytes, cancellationToken);
            return Parse(bytes, requestSha256, host, principal, DateTimeOffset.UtcNow);
        } finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    internal static PrivateHttpContext Parse(byte[] bytes, string requestSha256, string host,
        string principal, DateTimeOffset now)
    {
        // Keep every rejection static: context values are never exception text.
        try {
            if (bytes.Length is < 1 or > MaximumBytes || string.IsNullOrWhiteSpace(principal)) throw Invalid();
            var context = JsonNode.Parse(bytes) as JsonObject ?? throw Invalid();
            var allowed = new HashSet<string>(StringComparer.Ordinal) {
                "schema", "requestSha256", "host", "principal", "issuedAt", "expiresAt", "cookie", "csrf"
            };
            if (context.Count != allowed.Count || context.Any(p => !allowed.Contains(p.Key))) throw Invalid();
            string Value(string key) => context[key]?.GetValue<string>() ?? throw Invalid();
            if (Value("schema") != "ssam-private-http-context/1"
                || !System.Text.RegularExpressions.Regex.IsMatch(requestSha256, "^[a-f0-9]{64}$")
                || Value("requestSha256") != requestSha256 || Value("host") != host
                || !string.Equals(Value("principal").Trim(), principal.Trim(), StringComparison.OrdinalIgnoreCase)) throw Invalid();
            if (!DateTimeOffset.TryParseExact(Value("issuedAt"), "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AssumeUniversal, out var issued)
                || !DateTimeOffset.TryParseExact(Value("expiresAt"), "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AssumeUniversal, out var expires)
                || issued > now.AddSeconds(5) || expires <= now || expires <= issued || expires - issued > TimeSpan.FromSeconds(30)) throw Invalid();
            var cookie = Value("cookie"); var csrf = Value("csrf");
            if (cookie.Length is < 1 or > 48000 || csrf.Length > 4096
                || cookie.Any(c => c < 32 || c == 127) || csrf.Any(c => c < 32 || c == 127)) throw Invalid();
            return new PrivateHttpContext(cookie, csrf);
        } catch { throw Invalid(); }
    }

    private static InvalidOperationException Invalid() => new("Private HTTP context unavailable or outside this request's scope.");
}
