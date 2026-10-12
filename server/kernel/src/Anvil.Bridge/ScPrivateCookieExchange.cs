using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text.Json;
using Ssam.PrivateTransport;

namespace Anvil.Bridge;

// Duplex exchange for this tool-owned request only. The OS restricts both
// directions to the current user. No cookie goes through bridge JSON or logs.
internal sealed class ScPrivateCookieExchange : IDisposable
{
    private readonly NamedPipeServerStream pipe;
    private readonly string hash, host, principal, url;
    internal PrivateHttpContext Context { get; }
    private ScPrivateCookieExchange(NamedPipeServerStream pipe, PrivateHttpContext context,
        string hash, string host, string principal, string url)
        => (this.pipe, Context, this.hash, this.host, this.principal, this.url) = (pipe, context, hash, host, principal, url);
    internal static string Name(string id)
    {
        if (!Guid.TryParseExact(id, "D", out _)) throw Invalid();
        return "SSAM-O11-CookieExchange-" + id.ToLowerInvariant();
    }
    internal static async Task<ScPrivateCookieExchange> Receive(string id, string hash, string host,
        string principal, string url, CancellationToken ct)
    {
        if (!OperatingSystem.IsWindows()) throw Invalid();
        var pipe = new NamedPipeServerStream(Name(id), PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        try {
            await pipe.WaitForConnectionAsync(ct);
            var prefix = new byte[4]; await pipe.ReadExactlyAsync(prefix, ct);
            var size = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(prefix);
            if (size is < 1 or > PrivateHttpContext.MaximumBytes) throw Invalid();
            var bytes = new byte[size];
            try {
                await pipe.ReadExactlyAsync(bytes, ct);
                return new(pipe, PrivateHttpContext.Parse(bytes, hash, host, principal, DateTimeOffset.UtcNow), hash, host, principal, url);
            } finally { CryptographicOperations.ZeroMemory(bytes); }
        } catch { pipe.Dispose(); throw Invalid(); }
    }
    internal async Task Publish(IReadOnlyList<string> cookies, CancellationToken ct)
    {
        if (cookies.Count > 64 || cookies.Any(c => c.Length > 48000 || c.Any(ch => ch < 32 || ch == 127))) throw Invalid();
        var now = DateTimeOffset.UtcNow;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new { schema = "ssam-o11-cookie-update/1", requestSha256 = hash,
            host, principal, url, issuedAt = now.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),
            expiresAt = now.AddSeconds(30).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"), cookies });
        try {
            if (bytes.Length > PrivateHttpContext.MaximumBytes) throw Invalid();
            var prefix = new byte[4]; System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(prefix, bytes.Length);
            await pipe.WriteAsync(prefix, ct); await pipe.WriteAsync(bytes, ct); await pipe.FlushAsync(ct);
            var ack = new byte[1]; await pipe.ReadExactlyAsync(ack, ct);
            if (ack[0] != 1) throw Invalid();
        } finally { CryptographicOperations.ZeroMemory(bytes); }
    }
    public void Dispose() => pipe.Dispose();
    public override string ToString() => "ScPrivateCookieExchange [redacted]";
    private static InvalidOperationException Invalid() => new("Private cookie exchange unavailable.");
}
