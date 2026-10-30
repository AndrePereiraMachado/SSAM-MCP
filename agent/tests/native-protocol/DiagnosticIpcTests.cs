using System.Buffers.Binary;
using System.Net.Sockets;
using Ssam.Agent;
using Xunit;

public sealed class DiagnosticIpcTests
{
    [Fact]
    public void FramingAndUtf16MatchRuntimeProtocol()
    {
        var payload = DiagnosticIpc.StringBytes("a🌐");
        Assert.Equal(4u, BinaryPrimitives.ReadUInt32LittleEndian(payload));
        var frame = DiagnosticIpc.Message(7, payload);
        Assert.Equal(frame.Length, BinaryPrimitives.ReadUInt16LittleEndian(frame.AsSpan(14)));
        Assert.Equal(4, frame[16]); Assert.Equal(7, frame[17]);
        Assert.Equal("DOTNET_IPC_V1\0", System.Text.Encoding.ASCII.GetString(frame, 0, 14));
        Assert.Throws<DiagnosticFault>(() => DiagnosticIpc.Message(7, new byte[65536]));
    }

    [Fact]
    public async Task ReadsRealDotnetRuntime()
    {
        var endpoint = OperatingSystem.IsWindows() ? $"dotnet-diagnostic-{Environment.ProcessId}" : MacPlatform.Endpoint(Environment.ProcessId)?.Path;
        Assert.NotNull(endpoint);
        var info = await DiagnosticIpc.ProcessInfo(endpoint!, OperatingSystem.IsWindows(), CancellationToken.None);
        Assert.Equal((ulong)Environment.ProcessId, info.Pid);
        Assert.StartsWith("10.", info.ClrVersion);
        Assert.False(string.IsNullOrWhiteSpace(info.EntryPoint));
    }

    [Fact]
    public async Task UnixSocketTransportHandlesFragmentedFramesAndRuntimeRefusal()
    {
        if (!Socket.OSSupportsUnixDomainSockets) return;
        var file = Path.Combine(Path.GetTempPath(), "ssam-" + Guid.NewGuid().ToString("N")[..8]);
        using var listener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        listener.Bind(new UnixDomainSocketEndPoint(file)); listener.Listen(1);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try
        {
            var request = DiagnosticIpc.Request(file, false, 4, null, deadline.Token);
            using var peer = await listener.AcceptAsync(deadline.Token);
            using var wire = new NetworkStream(peer, ownsSocket: false);
            var received = new byte[20]; await wire.ReadExactlyAsync(received, deadline.Token);
            Assert.Equal(DiagnosticIpc.Message(4), received);
            var error = new byte[4]; BinaryPrimitives.WriteUInt32LittleEndian(error, 0x80131387);
            var response = DiagnosticIpc.Message(4, error); response[16] = 0xff; response[17] = 0xff;
            foreach (var value in response) await wire.WriteAsync(new byte[] { value }, deadline.Token);
            var fault = await Assert.ThrowsAsync<DiagnosticFault>(() => request);
            Assert.Equal("IPC_REFUSED", fault.Code); Assert.True(fault.Sent); Assert.Equal(0x80131387u, fault.RuntimeHResult);
        }
        finally { listener.Close(); File.Delete(file); }
    }

    [Fact]
    public void IdentityDecoderRejectsTruncationAndPreservesUnicode()
    {
        using var body = new MemoryStream();
        var identity = new byte[24]; BinaryPrimitives.WriteUInt64LittleEndian(identity, 123);
        body.Write(identity);
        foreach (var word in new[] { "/Applications/Estúdio.app", "osx", "arm64", "ODCStudio", "10.0.1" }) body.Write(DiagnosticIpc.StringBytes(word));
        var bytes = body.ToArray();
        Assert.Equal("/Applications/Estúdio.app", DiagnosticIpc.DecodeIdentity(bytes).CommandLine);
        Assert.Equal("arm64", DiagnosticIpc.DecodeIdentity(bytes).Architecture);
        for (var n = 0; n < bytes.Length; n++) Assert.Throws<DiagnosticFault>(() => DiagnosticIpc.DecodeIdentity(bytes.AsSpan(0, n)));
    }
}
