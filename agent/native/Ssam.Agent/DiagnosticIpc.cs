using System.Buffers.Binary;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Text;

namespace Ssam.Agent;

internal sealed class DiagnosticFault(string code, string message, bool sent = false, uint? hresult = null) : Exception(message)
{
    public string Code { get; } = code;
    public bool Sent { get; } = sent;
    public uint? RuntimeHResult { get; } = hresult;
}

internal sealed record RuntimeIdentity(ulong Pid, string Cookie, string? CommandLine, string? OS, string? Architecture, string? EntryPoint, string? ClrVersion);

// The same DOTNET_IPC_V1 protocol as agent/lib/dotnet-ipc.mjs. macOS uses a
// Unix socket; Windows transport permits tests against a real .NET process here.
// No attach is retried after bytes may have been sent.
internal static class DiagnosticIpc
{
    internal const int HeaderBytes = 20;
    private static readonly byte[] Magic = Encoding.ASCII.GetBytes("DOTNET_IPC_V1\0");

    internal static byte[] StringBytes(string? value)
    {
        if (value == null) return new byte[4];
        var text = Encoding.Unicode.GetBytes(value + "\0");
        var bytes = new byte[4 + text.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(bytes, checked((uint)(text.Length / 2)));
        text.CopyTo(bytes, 4); return bytes;
    }
    internal static byte[] Message(byte command, byte[]? payload = null)
    {
        payload ??= [];
        if (payload.Length > ushort.MaxValue - HeaderBytes) throw new DiagnosticFault("IPC_MESSAGE_TOO_LARGE", "The diagnostic request exceeds its frame limit");
        var result = new byte[HeaderBytes + payload.Length];
        Magic.CopyTo(result, 0);
        BinaryPrimitives.WriteUInt16LittleEndian(result.AsSpan(14), (ushort)result.Length);
        result[16] = 4; result[17] = command;
        payload.CopyTo(result, HeaderBytes); return result;
    }
    internal static RuntimeIdentity DecodeIdentity(ReadOnlySpan<byte> payload)
    {
        if (payload.Length < 24) throw BadReply();
        var pid = BinaryPrimitives.ReadUInt64LittleEndian(payload);
        var cookie = Convert.ToHexStringLower(payload.Slice(8, 16));
        var at = 24; var strings = new string?[5];
        for (var i = 0; i < strings.Length; i++)
        {
            if (payload.Length - at < 4) throw BadReply();
            var units = BinaryPrimitives.ReadUInt32LittleEndian(payload[at..]); at += 4;
            if (units > (payload.Length - at) / 2) throw BadReply();
            if (units == 0) continue;
            var length = checked((int)units * 2);
            if (payload[at + length - 1] != 0 || payload[at + length - 2] != 0) throw BadReply();
            strings[i] = Encoding.Unicode.GetString(payload.Slice(at, length - 2)); at += length;
        }
        return new(pid, cookie, strings[0], strings[1], strings[2], strings[3], strings[4]);
    }
    private static DiagnosticFault BadReply() => new("IPC_BAD_REPLY", "The diagnostic endpoint returned an invalid or incomplete frame", true);

    internal static async Task<byte[]> Request(string endpoint, bool windowsPipe, byte command, byte[]? payload, CancellationToken token, int timeoutMs = 20000)
    {
        var message = Message(command, payload);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(timeoutMs);
        Stream? stream = null;
        var sent = false;
        try
        {
            if (windowsPipe)
            {
                var pipe = new NamedPipeClientStream(".", endpoint, PipeDirection.InOut, PipeOptions.Asynchronous);
                stream = pipe;
                await pipe.ConnectAsync(deadline.Token);
            }
            else
            {
                if (!Path.IsPathFullyQualified(endpoint)) throw new DiagnosticFault("IPC_ABSENT", "An absolute local socket path is required");
                var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                try { await socket.ConnectAsync(new UnixDomainSocketEndPoint(endpoint), deadline.Token); }
                catch { socket.Dispose(); throw; }
                stream = new NetworkStream(socket, ownsSocket: true);
            }
            sent = true;
            await stream.WriteAsync(message, deadline.Token);
            var header = new byte[HeaderBytes];
            await stream.ReadExactlyAsync(header, deadline.Token);
            if (!header.AsSpan(0, Magic.Length).SequenceEqual(Magic)) throw BadReply();
            var size = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(14));
            if (size < HeaderBytes || header[16] != 0xff || header[17] is not (0 or 0xff)) throw BadReply();
            var body = new byte[size - HeaderBytes];
            await stream.ReadExactlyAsync(body, deadline.Token);
            if (header[17] == 0xff)
            {
                if (body.Length < 4) throw BadReply();
                var error = BinaryPrimitives.ReadUInt32LittleEndian(body);
                throw new DiagnosticFault("IPC_REFUSED", $"The runtime refused the diagnostic request (0x{error:x8})", true, error);
            }
            return body;
        }
        catch (EndOfStreamException) { throw new DiagnosticFault("IPC_NO_REPLY", "The diagnostic endpoint closed before its complete reply", sent); }
        catch (OperationCanceledException) { throw new DiagnosticFault("IPC_TIMEOUT", "The diagnostic endpoint did not answer before the deadline", sent); }
        catch (Exception e) when (e is SocketException or IOException) { throw new DiagnosticFault(sent ? "IPC_TRANSPORT" : "IPC_ABSENT", "The local diagnostic connection failed", sent); }
        finally { if (stream != null) await stream.DisposeAsync(); }
    }
    internal static async Task<RuntimeIdentity> ProcessInfo(string endpoint, bool windowsPipe, CancellationToken token) =>
        DecodeIdentity(await Request(endpoint, windowsPipe, 4, null, token, 10000));
    internal static async Task ApplyHook(string endpoint, bool windowsPipe, string hook, CancellationToken token)
    {
        if (!Path.IsPathFullyQualified(hook) || !File.Exists(hook)) throw new DiagnosticFault("IPC_INVALID_HOOK", "The installed hook must exist at an absolute path");
        var response = await Request(endpoint, windowsPipe, 7, StringBytes(hook), token);
        if (response.Length is > 0 and < 4) throw BadReply();
        if (response.Length >= 4 && BinaryPrimitives.ReadUInt32LittleEndian(response) is var error && error != 0)
            throw new DiagnosticFault("IPC_REFUSED", $"The runtime refused the hook (0x{error:x8})", true, error);
    }

    internal static IEnumerable<(string Path, long StartSeconds)> UnixEndpoints(int pid, IEnumerable<string> folders)
    {
        var prefix = $"dotnet-diagnostic-{pid}-";
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var found = new List<(string Path, long StartSeconds, DateTime Modified)>();
        foreach (var folder in folders)
        {
            if (!Path.IsPathFullyQualified(folder) || !Directory.Exists(folder)) continue;
            try
            {
                foreach (var file in Directory.EnumerateFileSystemEntries(folder, prefix + "*-socket"))
                {
                    var name = Path.GetFileName(file);
                    if (!long.TryParse(name[prefix.Length..^7], out var seconds) || seconds <= 0 || !seen.Add(file)) continue;
                    found.Add((file, seconds, File.GetLastWriteTimeUtc(file)));
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        }
        return found.OrderByDescending(n => n.Modified).Select(n => (n.Path, n.StartSeconds));
    }
}
