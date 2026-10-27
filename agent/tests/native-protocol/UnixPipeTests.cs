using System.Net.Sockets;
using System.Text;
using Ssam.Agent;
using Xunit;

public sealed class UnixPipeTests
{
    [Fact]
    public async Task SerializesCommandsAndRequiresNewSocketBeforeSendingAgain()
    {
        var file = Path.Combine(Path.GetTempPath(), "ssam-" + Guid.NewGuid().ToString("N")[..8]);
        string? identity = "socket-1";
        var client = new UnixStudioPipe(_ => identity);
        using var listener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        listener.Bind(new UnixDomainSocketEndPoint(file)); listener.Listen(1);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try
        {
            var first = client.Call([file], ["status"], 500, 2000, deadline.Token);
            using var peer = await listener.AcceptAsync(deadline.Token);
            using var wire = new NetworkStream(peer, false);
            var request = new byte[7]; await wire.ReadExactlyAsync(request, deadline.Token);
            Assert.Equal("status\n", Encoding.UTF8.GetString(request));
            var busy = await Assert.ThrowsAsync<AgentFault>(() => client.Call([file], ["stop"], 50, 2000, deadline.Token));
            Assert.Equal("BRIDGE_BUSY", busy.Code); Assert.False(busy.Sent);
            await wire.WriteAsync("ok\n"u8.ToArray(), deadline.Token);
            Assert.Equal("ok", await first);
            var old = await Assert.ThrowsAsync<AgentFault>(() => client.Call([file], ["stop"], 50, 2000, deadline.Token));
            Assert.Equal("BRIDGE_NOT_ATTACHED", old.Code); Assert.False(old.Sent);
            Assert.Equal(0, peer.Available);
            identity = "socket-2";
            var next = client.Call([file], ["status"], 500, 50, deadline.Token);
            using var second = await listener.AcceptAsync(deadline.Token);
            using var secondWire = new NetworkStream(second, false);
            await secondWire.ReadExactlyAsync(request, deadline.Token);
            var timeout = await Assert.ThrowsAsync<AgentFault>(() => next);
            Assert.Equal("PIPE_REPLY_TIMEOUT", timeout.Code); Assert.True(timeout.Sent); Assert.Null(timeout.Executed);
            var noRepeat = await Assert.ThrowsAsync<AgentFault>(() => client.Call([file], ["status"], 50, 1000, deadline.Token));
            Assert.False(noRepeat.Sent);
        }
        finally { listener.Close(); File.Delete(file); }
    }

    [Theory]
    [InlineData("/")]
    [InlineData("/Users/test")]
    [InlineData("/Users/test/Library/Agent")]
    [InlineData("/Users/test/Downloads/Agent")]
    [InlineData("/tmp/agent")]
    [InlineData("/Applications/Agent")]
    [InlineData("relative")]
    public void RefusesUnsafeMacDataRoots(string root) => Assert.Throws<ArgumentException>(() => MacPlatform.CheckRoot(root, "/Users/test"));

    [Fact]
    public void AcceptsDedicatedMacDataRoot() => MacPlatform.CheckRoot("/Users/test/SSAM-Agent", "/Users/test");
}
