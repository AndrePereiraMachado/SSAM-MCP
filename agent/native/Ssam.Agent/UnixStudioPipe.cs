using System.Collections.Concurrent;
using System.Net.Sockets;
using System.Text;

namespace Ssam.Agent;

// A Unix NamedPipeServerStream accepts queued clients even while it is serving
// another operation. Serialize locally and require a new socket inode before
// writing the next command. Never retry after any write may have reached Studio.
internal sealed class UnixStudioPipe(Func<string, string?> identity)
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> served = new(StringComparer.Ordinal);
    internal async Task<string> Call(string[] candidates, string[] words, int connectMs, int replyMs, CancellationToken token)
    {
        if (candidates.Any(p => Encoding.UTF8.GetByteCount(p) > 103)) throw Fault("PIPE_TRANSPORT", "The Studio socket path is too long", false);
        var end = Environment.TickCount64 + connectMs;
        var busy = false; var stalled = false;
        do
        {
            token.ThrowIfCancellationRequested();
            busy = false;
            foreach (var file in candidates)
            {
                var current = identity(file);
                if (current == null) continue;
                var gate = gates.GetOrAdd(file, _ => new SemaphoreSlim(1));
                if (!await gate.WaitAsync(0, token)) { busy = true; break; }
                try
                {
                    if (served.TryGetValue(file, out var previous) && previous == current) break;
                    using var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
                    var sent = false;
                    try
                    {
                        deadline.CancelAfter((int)Math.Clamp(end - Environment.TickCount64, 250, int.MaxValue));
                        await socket.ConnectAsync(new UnixDomainSocketEndPoint(file), deadline.Token);
                        if (identity(file) != current) continue;
                        deadline.CancelAfter(replyMs);
                        using var stream = new NetworkStream(socket, ownsSocket: false);
                        sent = true; served[file] = current;
                        await stream.WriteAsync(Encoding.UTF8.GetBytes(string.Join(' ', words) + "\n"), deadline.Token);
                        return (await new BoundedLines(stream, 256 * 1024 * 1024).ReadAsync(deadline.Token))?.TrimEnd('\r')
                            ?? throw Fault("PIPE_NO_REPLY", "The Studio closed without a reply; inspect its evidence before retrying", true);
                    }
                    catch (OperationCanceledException) when (!token.IsCancellationRequested)
                    {
                        if (sent) throw Fault("PIPE_REPLY_TIMEOUT", "The Studio may still be executing; inspect its evidence before retrying", true);
                        stalled = true;
                    }
                    catch (SocketException e) when (!sent && e.SocketErrorCode is SocketError.ConnectionRefused or SocketError.AddressNotAvailable or SocketError.HostNotFound) { }
                    catch (SocketException) { throw Fault("PIPE_TRANSPORT", "The Studio socket failed", sent); }
                    catch (IOException) { throw Fault("PIPE_TRANSPORT", "The Studio socket failed", sent); }
                    catch (OperationCanceledException) { throw Fault("CANCELLED", "The Studio request was cancelled", sent); }
                }
                finally { gate.Release(); }
                break;
            }
            if (Environment.TickCount64 < end) await Task.Delay((int)Math.Clamp(end - Environment.TickCount64, 1, 50), token);
        } while (Environment.TickCount64 < end);
        throw Fault(busy ? "BRIDGE_BUSY" : stalled ? "PIPE_CONNECT_TIMEOUT" : "BRIDGE_NOT_ATTACHED", busy ? "A Studio command is still running; wait or inspect its evidence" : "No fresh Studio socket accepted the connection", false);
    }
    private static AgentFault Fault(string code, string message, bool sent) => new(code, message, sent ? null : false) { Sent = sent };
}
