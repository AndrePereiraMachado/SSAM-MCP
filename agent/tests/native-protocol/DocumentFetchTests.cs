using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Ssam.Agent;
using Xunit;

// document.fetch (0.4.8-native, r40) in the native core: the protocol cases of the Node agent (document-fetch-cases.json, run by
// agent/agent/tests/document-fetch.test.mjs) against a local HTTP server built from the same routes. No other network.
public class DocumentFetchTests
{
    private static JsonObject Cases()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
        {
            var file = Path.Combine(dir.FullName, "tests", "native-protocol", "document-fetch-cases.json");
            if (File.Exists(file)) return JsonNode.Parse(File.ReadAllText(file))!.AsObject();
        }
        throw new FileNotFoundException("document-fetch-cases.json");
    }

    // A one-request-per-connection HTTP/1.1 server answering the routes of the cases.
    private sealed class CasesServer : IDisposable
    {
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);
        private readonly JsonObject routes;
        private readonly CancellationTokenSource stop = new();
        internal readonly List<(string Method, string Path)> Seen = [];
        internal string Base { get; }
        internal string HostPort { get; }
        internal CasesServer(JsonObject routes)
        {
            this.routes = routes;
            listener.Start();
            HostPort = "127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port;
            Base = "http://" + HostPort;
            _ = Task.Run(Loop);
        }
        internal string Fill(string text) => text.Replace("{base}", Base).Replace("{hostport}", HostPort);
        internal byte[] BodyOf(string route) => Encoding.UTF8.GetBytes(Fill(routes[route]!["body"]!.GetValue<string>()));
        private async Task Loop()
        {
            while (!stop.IsCancellationRequested)
            {
                TcpClient socket;
                try { socket = await listener.AcceptTcpClientAsync(stop.Token); } catch { return; }
                _ = Task.Run(() => Serve(socket));
            }
        }
        private async Task Serve(TcpClient socket)
        {
            using (socket)
            {
                var stream = socket.GetStream();
                var head = new StringBuilder();
                var one = new byte[1];
                while (!head.ToString().EndsWith("\r\n\r\n") && await stream.ReadAsync(one) == 1) head.Append((char)one[0]);
                var lines = head.ToString().Split("\r\n");
                var first = lines[0].Split(' ');
                var headers = lines.Skip(1).Where(l => l.Contains(':')).ToDictionary(l => l[..l.IndexOf(':')].Trim().ToLowerInvariant(), l => l[(l.IndexOf(':') + 1)..].Trim());
                var pathOnly = first.Length > 1 ? first[1].Split('?')[0] : "/";
                lock (Seen) Seen.Add((first[0], pathOnly));
                var route = routes[pathOnly] as JsonObject;
                if (route == null) { await Write(stream, "HTTP/1.1 500 X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return; }
                if (route["delayMs"] is JsonNode delay) { try { await Task.Delay(delay.GetValue<int>(), stop.Token); } catch { return; } }
                var status = route["status"]!.GetValue<int>();
                string body;
                if (route["echoHeaders"] != null)
                    body = new JsonObject { ["cookie"] = headers.GetValueOrDefault("cookie"), ["authorization"] = headers.GetValueOrDefault("authorization"), ["userAgent"] = headers.GetValueOrDefault("user-agent") }.ToJsonString();
                else if (route["fill"] != null)
                    body = route["prefix"]!.GetValue<string>() + new string(route["fill"]!.GetValue<string>()[0], route["size"]!.GetValue<int>() - route["prefix"]!.GetValue<string>().Length);
                else body = route["body"]?.GetValue<string>() ?? "";
                var response = new StringBuilder("HTTP/1.1 " + status + " X\r\nConnection: close\r\n");
                if (route["type"] != null) response.Append("Content-Type: " + route["type"]!.GetValue<string>() + "\r\n");
                if (route["location"] != null) response.Append("Location: " + Fill(route["location"]!.GetValue<string>()) + "\r\n");
                var bytes = Encoding.UTF8.GetBytes(body);
                if (route["chunked"] != null)
                {
                    await Write(stream, response + "Transfer-Encoding: chunked\r\n\r\n");
                    try
                    {
                        for (var i = 0; i < bytes.Length; i += 256)
                        {
                            var n = Math.Min(256, bytes.Length - i);
                            await Write(stream, n.ToString("x") + "\r\n");
                            await stream.WriteAsync(bytes.AsMemory(i, n));
                            await Write(stream, "\r\n");
                        }
                        await Write(stream, "0\r\n\r\n");
                    }
                    catch (IOException) { /* the agent cut it */ }
                    return;
                }
                await Write(stream, response + "Content-Length: " + bytes.Length + "\r\n\r\n");
                try { await stream.WriteAsync(bytes); } catch (IOException) { /* the agent cut it */ }
            }
        }
        private static Task Write(NetworkStream stream, string text) => stream.WriteAsync(Encoding.ASCII.GetBytes(text)).AsTask();
        public void Dispose() { stop.Cancel(); listener.Stop(); }
    }

    [Fact]
    public async Task TheProtocolCasesOfTheNodeAgent()
    {
        var cases = Cases();
        using var server = new CasesServer(cases["routes"]!.AsObject());
        var kind = new DocumentFetch();
        foreach (var c in cases["cases"]!.AsArray().Select(n => n!.AsObject()))
        {
            var name = c["name"]!.GetValue<string>();
            lock (server.Seen) server.Seen.Clear();
            var parameters = JsonNode.Parse(server.Fill(c["params"]!.ToJsonString()))!.AsObject();
            var expect = JsonNode.Parse(server.Fill(c["expect"]!.ToJsonString()))!.AsObject();
            JsonObject? value = null; string? code = null;
            try { value = await kind.Execute(parameters, null, CancellationToken.None); }
            catch (AgentFault fault) { code = fault.Code; Assert.False(fault.Executed ?? true, name + ": a refusal leaves nothing on this machine"); Assert.Matches("^[\\x20-\\x7e]+$", fault.Message); }
            if (expect["code"] != null) Assert.True(expect["code"]!.GetValue<string>() == code, name + ": " + code + " " + value?.ToJsonString());
            else
            {
                Assert.True(code == null, name + ": " + code);
                foreach (var key in new[] { "status", "finalUrl", "contentType", "bytes", "contentBase64" })
                    if (expect[key] != null) Assert.True(expect[key]!.ToJsonString() == value![key]!.ToJsonString(), name + ": " + key + " " + value[key]?.ToJsonString());
                var bytes = Convert.FromBase64String(value!["contentBase64"]!.GetValue<string>());
                Assert.Equal(bytes.Length, value["bytes"]!.GetValue<int>());
                Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(bytes)), value["sha256"]!.GetValue<string>());
                if (expect["bodyOf"] != null) Assert.Equal(server.BodyOf(expect["bodyOf"]!.GetValue<string>()), bytes);
                if (expect["json"] != null) Assert.True(JsonNode.DeepEquals(expect["json"], JsonNode.Parse(bytes)), name + ": " + Encoding.UTF8.GetString(bytes));
                Assert.Equal(new[] { "bytes", "contentBase64", "contentType", "finalUrl", "sha256", "status" }, value.Select(e => e.Key).Order(StringComparer.Ordinal).ToArray());
            }
            // The server may still be writing a cut answer: its count is read once it is settled.
            await Task.Delay(20);
            lock (server.Seen)
            {
                Assert.True(c["requests"]!.GetValue<int>() == server.Seen.Count, name + ": requests " + server.Seen.Count);
                Assert.All(server.Seen, s => Assert.Equal("GET", s.Method));
            }
        }
    }

    [Fact]
    public async Task ThePassedDeadlineRequestsNothing()
    {
        var kind = new DocumentFetch { Now = () => 1000 };
        var fault = await Assert.ThrowsAsync<AgentFault>(() => kind.Execute(new JsonObject { ["url"] = "https://example.test/x.wsdl", ["accept"] = "xml" }, 999, CancellationToken.None));
        Assert.Equal("DOCUMENT_FETCH_FAILED", fault.Code);
    }

}
