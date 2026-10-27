using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;

namespace Ssam.Agent;

// Transport is independent of Electron, Node, dynamic loading and the Studio assemblies.
// An unanswered upstream POST is retried; the corresponding local call is never rerun.
internal sealed class AgentChannel : IDisposable
{
    private readonly HttpClient http;
    private readonly StateStore state;
    private readonly int bridgePort;
    private readonly Blobs blobs;
    private readonly FileKinds files;
    private readonly StudioKinds? studios;
    private readonly JsonObject? pack;
    private JsonNode? kernel;
    private readonly string startedAt = DateTimeOffset.UtcNow.ToString("O");
    private readonly JsonObject? machine;
    private JsonObject? installed;
    private DateTimeOffset installedAt;
    public int PartBytes { get; private set; } = 4 * 1024 * 1024;
    public long MaxFileBytes { get; private set; } = 512 * 1024 * 1024;
    private int inlineMaxBytes = 524288;
    private int maxValueBytes = 16 * 1024 * 1024;
    private readonly object gate = new();
    private readonly Queue<JsonObject> pending = new();
    private readonly HashSet<string> calls = new();
    private readonly List<Task> workers = new();
    private CancellationTokenSource? activeStream;
    private string? channel;
    private int? exitCode;
    private int maxMessageBytes = 1048576;
    private readonly string instance = Guid.NewGuid().ToString();

    public AgentChannel(Uri server, string credential, StateStore state, int bridgePort, string? runtime = null, JsonObject? pack = null)
    {
        this.state = state;
        this.bridgePort = bridgePort;
        this.pack = pack;
        if (runtime != null && pack != null) { studios = new StudioKinds(state.Root, runtime, pack, () => kernel); machine = NativeHost.Machine(); }
        http = new HttpClient(new SocketsHttpHandler {
            AllowAutoRedirect = false, PooledConnectionIdleTimeout = TimeSpan.FromSeconds(2),
            ConnectTimeout = TimeSpan.FromSeconds(10)
        }) { BaseAddress = server, Timeout = Timeout.InfiniteTimeSpan };
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", credential);
        blobs = new Blobs(this);
        files = new FileKinds(state.Root, this, blobs);
    }

    private async Task<HttpResponseMessage> Send(HttpMethod method, string route, JsonNode? body,
        TimeSpan timeout, CancellationToken token, bool stream = false)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(timeout);
        using var request = new HttpRequestMessage(method, route);
        if (body != null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        return await http.SendAsync(request, stream ? HttpCompletionOption.ResponseHeadersRead : HttpCompletionOption.ResponseContentRead, deadline.Token);
    }

    private bool CredentialRefused(HttpStatusCode code)
    {
        if (code is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            exitCode = 2;
            lock (gate) activeStream?.Cancel();
            return true;
        }
        return false;
    }

    private JsonObject Versions()
    {
        if (installed == null || DateTimeOffset.UtcNow - installedAt > TimeSpan.FromMinutes(5)) { installed = studios == null ? new() : NativeHost.Installed(); installedAt = DateTimeOffset.UtcNow; }
        var record = O11Connection.Record(state.Root);
        JsonObject? connection = null;
        if (record != null && StudioKinds.Processes("ServiceStudio.exe").Any(n => StudioKinds.Integer(n?["pid"]) == StudioKinds.Integer(record["pid"])))
            connection = new() { ["pid"] = record["pid"]?.DeepClone(), ["port"] = record["port"]?.DeepClone(), ["startedUtc"] = record["startedUtc"]?.DeepClone(), ["studioVersion"] = record["studioVersion"]?.DeepClone() };
        return new() { ["studios"] = installed.DeepClone(), ["o11Connection"] = connection };
    }
    private JsonObject Hello() {
        var versions = Versions();
        return new() {
        ["t"] = "hello", ["protocol"] = "ssam-agent/1", ["instance"] = instance,
        ["agent"] = new JsonObject {
            ["version"] = "0.4.0-native", ["runtime"] = "native-aot",
            ["platform"] = OperatingSystem.IsWindows() ? "win32" : "darwin",
            ["startedAt"] = startedAt, ["root"] = state.Root, ["machine"] = machine?.DeepClone(),
            ["kinds"] = new JsonArray((studios == null ? new[] { "qualification.bridge", "file.put", "file.get", "file.list", "file.sync" } : StudioKinds.Names.Concat(FileKinds.Names).Append("net.probe").ToArray()).Select(n => (JsonNode?)JsonValue.Create(n)).ToArray())
        },
        ["pack"] = pack == null ? new JsonObject { ["id"] = "native-qualification", ["lanes"] = new JsonArray() } : new JsonObject { ["id"] = pack["id"]?.DeepClone(), ["lanes"] = pack["lanes"]?.DeepClone(), ["odcBridge"] = pack["odcBridge"]?.DeepClone(), ["o11BuiltFor"] = pack["o11BuiltFor"]?.DeepClone(), ["o11Hook"] = pack["o11Hook"]?.DeepClone() },
        ["studios"] = versions["studios"]?.DeepClone(), ["o11Connection"] = versions["o11Connection"]?.DeepClone()
    }; }

    public async Task<int> RunAsync(CancellationToken token)
    {
        using var operations = CancellationTokenSource.CreateLinkedTokenSource(token);
        var attempt = 0;
        var quickHelloUsed = false;
        try
        {
            while (!token.IsCancellationRequested && exitCode == null)
            {
                var opened = false;
                var helloSucceeded = false;
                var connectedAt = DateTimeOffset.UtcNow;
                double retryAfter = 0;
                try
                {
                    state.Write("connecting");
                    using var hello = await Send(HttpMethod.Post, "agent/v1/hello", Hello(), TimeSpan.FromSeconds(15), token);
                    if (CredentialRefused(hello.StatusCode)) break;
                    if (hello.StatusCode == HttpStatusCode.Conflict) { exitCode = 4; break; }
                    retryAfter = hello.Headers.RetryAfter?.Delta?.TotalMilliseconds ?? 0;
                    if (hello.StatusCode != HttpStatusCode.OK) throw new IOException("hello refused");
                    var welcome = JsonNode.Parse(await hello.Content.ReadAsStringAsync(token));
                    var id = welcome?["channel"]?.GetValue<string>();
                    if (welcome?["t"]?.GetValue<string>() != "welcome" || id == null ||
                        id.Length != 32 || id.Any(c => !(c is >= '0' and <= '9' or >= 'a' and <= 'f')))
                        throw new IOException("Invalid welcome");
                    channel = id;
                    kernel = welcome?["kernel"]?.DeepClone();
                    maxMessageBytes = Math.Clamp(welcome?["maxMessageBytes"]?.GetValue<int>() ?? 1048576, 1024, 16 * 1024 * 1024);
                    PartBytes = Math.Clamp(welcome?["partBytes"]?.GetValue<int>() ?? 4194304, 1, 4194304);
                    MaxFileBytes = Math.Clamp(welcome?["maxFileBytes"]?.GetValue<long>() ?? 536870912, 0, 536870912);
                    inlineMaxBytes = Math.Clamp(welcome?["inlineMaxBytes"]?.GetValue<int>() ?? 524288, 1, 524288);
                    maxValueBytes = Math.Clamp(welcome?["maxValueBytes"]?.GetValue<int>() ?? 16777216, 1, 16777216);
                    helloSucceeded = true;
                    using var streamLifetime = CancellationTokenSource.CreateLinkedTokenSource(token);
                    lock (gate) activeStream = streamLifetime;
                    using var response = await Send(HttpMethod.Get, "agent/v1/stream?channel=" + id, null,
                        TimeSpan.FromSeconds(15), streamLifetime.Token, true);
                    if (CredentialRefused(response.StatusCode)) break;
                    if (response.StatusCode != HttpStatusCode.OK) throw new IOException("stream refused");
                    opened = true; quickHelloUsed = false;
                    connectedAt = DateTimeOffset.UtcNow;
                    state.Write("connected");
                    var flush = FlushLoop(id, streamLifetime);
                    try
                    {
                        await using var body = await response.Content.ReadAsStreamAsync(streamLifetime.Token);
                        var reader = new BoundedLines(body, maxMessageBytes);
                        while (exitCode == null)
                        {
                            using var dead = CancellationTokenSource.CreateLinkedTokenSource(streamLifetime.Token);
                            dead.CancelAfter(TimeSpan.FromSeconds(45));
                            var line = await reader.ReadAsync(dead.Token);
                            if (line == null) break;
                            JsonObject? message;
                            try { message = JsonNode.Parse(line) as JsonObject; } catch { continue; }
                            switch (message?["t"]?.GetValue<string>())
                            {
                                case "ping":
                                    state.Write("connected");
                                    Track(Pong(id, message["seq"]?.DeepClone(), streamLifetime.Token));
                                    break;
                                case "call":
                                    Receive(message, operations.Token);
                                    break;
                                case "close":
                                    exitCode = message["reason"]?.GetValue<string>() switch {
                                        "revoked" or "expired" or "rotated" => 2, "replaced" => 3, _ => null };
                                    throw new IOException("channel closed");
                            }
                        }
                    }
                    finally
                    {
                        await streamLifetime.CancelAsync();
                        await flush;
                        lock (gate) activeStream = null;
                    }
                }
                catch (Exception e) when (e is IOException or HttpRequestException or OperationCanceledException or System.Text.Json.JsonException or InvalidOperationException)
                {
                    lock (gate) activeStream = null;
                    // No exception text: network diagnostics may contain authorization material.
                }
                if (token.IsCancellationRequested || exitCode != null) break;
                if (helloSucceeded && !opened && !quickHelloUsed) { quickHelloUsed = true; continue; }
                if (opened && DateTimeOffset.UtcNow - connectedAt >= TimeSpan.FromSeconds(60)) attempt = 0;
                state.Write("reconnecting");
                var backoff = Math.Min(30000, 1000 * Math.Pow(2, Math.Min(attempt++, 5))) * (0.8 + Random.Shared.NextDouble() * 0.4);
                await Task.Delay(TimeSpan.FromMilliseconds(Math.Min(300000, Math.Max(backoff, retryAfter))), token);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        finally
        {
            await operations.CancelAsync();
            Task[] active;
            lock (gate) active = workers.ToArray();
            try { await Task.WhenAll(active).WaitAsync(TimeSpan.FromSeconds(1)); } catch (Exception e) when (e is TimeoutException or OperationCanceledException) { }
            if (token.IsCancellationRequested && channel != null)
            {
                try { using var goodbye = await Send(HttpMethod.Delete, "agent/v1/channel?channel=" + channel, null, TimeSpan.FromSeconds(3), CancellationToken.None); }
                catch (Exception e) when (e is HttpRequestException or OperationCanceledException) { }
            }
            state.Write("stopped", exitCode ?? 0);
        }
        return exitCode ?? 0;
    }

    private void Track(Task task)
    {
        lock (gate) { workers.RemoveAll(t => t.IsCompleted); workers.Add(task); }
    }

    private void Receive(JsonObject call, CancellationToken token)
    {
        var id = call["id"]?.GetValue<string>();
        if (string.IsNullOrEmpty(id) || id.Length > 128) return;
        lock (gate)
        {
            if (!calls.Add(id)) { pending.Enqueue(new JsonObject { ["t"] = "accepted", ["id"] = id }); return; }
            pending.Enqueue(new JsonObject { ["t"] = "accepted", ["id"] = id });
        }
        Track(Execute(id, call, token));
    }

    private async Task Execute(string id, JsonObject call, CancellationToken token)
    {
        JsonObject result;
        var sent = false;
        var kind = call["kind"]?.GetValue<string>();
        try
        {
            if (!(kind == "qualification.bridge" && studios == null) && !FileKinds.Names.Contains(kind) && !(studios != null && (StudioKinds.Names.Contains(kind) || kind == "net.probe")))
                throw new AgentFault("KIND_NOT_ALLOWED", "This kind is not available on the agent");
            var parameters = call["params"];
            if (call["paramsBlob"] != null)
            {
                var temporary = Path.Combine(state.Private, "tmp", Guid.NewGuid().ToString("N") + ".json");
                try
                {
                    await blobs.Download(BlobRef.Parse(call["paramsBlob"], PartBytes, MaxFileBytes), temporary, token);
                    parameters = JsonNode.Parse(await File.ReadAllTextAsync(temporary, token));
                }
                finally { if (File.Exists(temporary)) File.Delete(temporary); }
            }
            if (parameters != null && parameters is not JsonObject) throw new AgentFault("PARAMS_INVALID", "params must be an object");
            JsonNode? value;
            if (FileKinds.Names.Contains(kind)) value = await files.Execute(kind!, (JsonObject?)parameters ?? new JsonObject(), token);
            else if (kind == "net.probe") value = await NetworkProbe((JsonObject?)parameters ?? new(), token);
            else if (studios != null) value = await studios.Execute(kind!, (JsonObject?)parameters ?? new(), token);
            else
            {
            // Fixed read-only method and local port; the server cannot choose a host, credential, method or executable.
            using var socket = new TcpClient();
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
            deadline.CancelAfter(TimeSpan.FromSeconds(5));
            await socket.ConnectAsync(IPAddress.Loopback, bridgePort, deadline.Token);
            var wire = socket.GetStream();
            sent = true;
            await wire.WriteAsync(Encoding.UTF8.GetBytes("{\"method\":\"ping\",\"params\":{}}\n"), deadline.Token);
            var line = await new BoundedLines(wire, 1048576).ReadAsync(deadline.Token);
            value = JsonNode.Parse(line ?? throw new IOException("No reply"));
            }
            result = new JsonObject { ["t"] = "result", ["id"] = id, ["ok"] = true, ["value"] = value };
            if (Encoding.UTF8.GetByteCount(result.ToJsonString()) > inlineMaxBytes)
            {
                var bytes = Encoding.UTF8.GetBytes(value?.ToJsonString() ?? "null");
                if (bytes.Length > maxValueBytes) throw new AgentFault("VALUE_TOO_LARGE", "Result exceeds the negotiated limit", null);
                using var source = new MemoryStream(bytes);
                result = new JsonObject { ["t"] = "result", ["id"] = id, ["ok"] = true, ["valueBlob"] = (await blobs.Upload(source, token)).Json() };
            }
        }
        catch (Exception e) when (e is AgentFault or PathRefusal)
        {
            result = new JsonObject { ["t"] = "result", ["id"] = id, ["ok"] = false,
                ["error"] = new JsonObject { ["code"] = e is AgentFault fault ? fault.Code : ((PathRefusal)e).Code,
                    ["message"] = e.Message, ["executed"] = e is AgentFault f ? f.Executed : false } };
            if (e is AgentFault { Sent: not null } sentFault) result["error"]!["sent"] = sentFault.Sent;
        }
        catch (Exception e) when (e is ArgumentException or IOException or SocketException or OperationCanceledException or System.Text.Json.JsonException)
        {
            result = new JsonObject { ["t"] = "result", ["id"] = id, ["ok"] = false,
                ["error"] = new JsonObject { ["code"] = e is ArgumentException or System.Text.Json.JsonException ? "PARAMS_INVALID" : kind == "qualification.bridge" ? "BRIDGE_TRANSPORT" : "AGENT_IO_ERROR",
                    ["message"] = "The local operation could not complete",
                    ["executed"] = sent || kind != "qualification.bridge" ? null : JsonValue.Create(false) } };
        }
        catch (Exception)
        {
            result = new JsonObject { ["t"] = "result", ["id"] = id, ["ok"] = false,
                ["error"] = new JsonObject { ["code"] = "AGENT_ERROR", ["message"] = "Local operation failed", ["executed"] = null } };
        }
        lock (gate) pending.Enqueue(result);
    }

    private async Task Pong(string id, JsonNode? seq, CancellationToken token)
    {
        try
        {
            using var reply = await Send(HttpMethod.Post, "agent/v1/messages?channel=" + id,
                new JsonObject { ["messages"] = new JsonArray(new JsonObject { ["t"] = "pong", ["seq"] = seq, ["versions"] = Versions() }) },
                TimeSpan.FromSeconds(10), token);
            CredentialRefused(reply.StatusCode);
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException) { }
    }

    private async Task FlushLoop(string id, CancellationTokenSource lifetime)
    {
        var failures = 0;
        try
        {
            while (!lifetime.IsCancellationRequested && exitCode == null)
            {
                JsonObject? first;
                lock (gate) first = pending.TryPeek(out var item) ? item : null;
                if (first == null) { await Task.Delay(20, lifetime.Token); continue; }
                var body = new JsonObject { ["messages"] = new JsonArray(first.DeepClone()) };
                var size = Encoding.UTF8.GetByteCount(body.ToJsonString());
                int status = 0;
                try
                {
                    using var reply = await Send(HttpMethod.Post, "agent/v1/messages?channel=" + id, body,
                        TimeSpan.FromSeconds(10 + Math.Ceiling(size / 65536d)), lifetime.Token);
                    status = (int)reply.StatusCode;
                    if (CredentialRefused(reply.StatusCode)) { await lifetime.CancelAsync(); return; }
                }
                catch (HttpRequestException) { }
                catch (OperationCanceledException) when (!lifetime.IsCancellationRequested) { }
                if (status is 200 or 204 or 413)
                {
                    lock (gate) {
                        pending.Dequeue();
                        if (first["t"]?.GetValue<string>() == "result") calls.Remove(first["id"]!.GetValue<string>());
                    }
                    failures = 0;
                }
                else if (status == 404) { await lifetime.CancelAsync(); return; }
                else await Task.Delay(Math.Min(30000, 1000 << Math.Min(failures++, 5)), lifetime.Token);
            }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
    }

    public void Dispose() => http.Dispose();

    private async Task<JsonNode> NetworkProbe(JsonObject p, CancellationToken token)
    {
        var groups = p["probes"] as JsonArray ?? (p["probes"] == null ? new JsonArray(new JsonObject { ["bytes"] = 1024, ["count"] = 8 }, new JsonObject { ["bytes"] = 1048576, ["count"] = 2 }) : throw StudioKinds.Invalid("probes must be an array"));
        var budget = StudioKinds.Integer(p["budgetMs"], 4500);
        var plan = groups.Select(n => (Bytes: StudioKinds.Integer(n?["bytes"]), Count: StudioKinds.Integer(n?["count"]))).OrderBy(n => n.Bytes).ToArray();
        if (budget is < 500 or > 15000 || plan.Length is < 1 or > 4 || plan.Any(n => n.Bytes is < 1 or > 2097152 || n.Count is < 1 or > 16) || plan.Sum(n => n.Count) > 24 || plan.Sum(n => (long)n.Bytes * n.Count) > 8388608) throw StudioKinds.Invalid("Network probe limits exceeded");
        var start = System.Diagnostics.Stopwatch.StartNew();
        var results = new JsonArray();
        for (var i = 0; i < plan.Length; i++)
        {
            var group = plan[i];
            var left = budget - start.ElapsedMilliseconds;
            if (left <= 0)
            {
                for (var j = 0; j < group.Count; j++) results.Add((JsonNode)new JsonObject { ["id"] = null, ["bytes"] = group.Bytes, ["ms"] = 0, ["ok"] = false, ["status"] = 0, ["error"] = "budget" });
                continue;
            }
            using var window = CancellationTokenSource.CreateLinkedTokenSource(token);
            window.CancelAfter(TimeSpan.FromMilliseconds(i == plan.Length - 1 ? left : Math.Min(left, Math.Max(250, budget * .4))));
            var batch = await Task.WhenAll(Enumerable.Range(0, group.Count).Select(async _ =>
            {
                var id = Guid.NewGuid().ToString("N");
                var watch = System.Diagnostics.Stopwatch.StartNew();
                var result = new JsonObject { ["id"] = id, ["bytes"] = group.Bytes, ["ok"] = false, ["status"] = 0 };
                using var client = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false }) { BaseAddress = http.BaseAddress, Timeout = Timeout.InfiniteTimeSpan };
                client.DefaultRequestHeaders.Authorization = http.DefaultRequestHeaders.Authorization;
                try
                {
                    using var body = new ByteArrayContent(System.Security.Cryptography.RandomNumberGenerator.GetBytes(group.Bytes));
                    body.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
                    using var reply = await client.PutAsync($"agent/v1/probe/{id}?channel={channel}", body, window.Token);
                    result["status"] = (int)reply.StatusCode; result["ok"] = reply.StatusCode == HttpStatusCode.OK;
                    var value = JsonNode.Parse(await reply.Content.ReadAsStringAsync(window.Token));
                    if (StudioKinds.Text(value?["via"]) is string via) result["via"] = via[..Math.Min(via.Length, 64)];
                    if (value?["ms"] is JsonValue ms && ms.TryGetValue<double>(out var serverMs) && double.IsFinite(serverMs)) result["serverMs"] = serverMs;
                }
                catch (Exception e) when (e is HttpRequestException or OperationCanceledException or System.Text.Json.JsonException) { result["error"] = window.IsCancellationRequested ? "budget" : "transport"; }
                result["ms"] = watch.ElapsedMilliseconds; return result;
            }));
            foreach (var result in batch) results.Add((JsonNode)result);
        }
        return new JsonObject { ["budgetMs"] = budget, ["ms"] = start.ElapsedMilliseconds, ["probes"] = results };
    }

    // A failed part retries on an independent handler, not a stale pooled connection.
    public async Task<PartReply> Part(HttpMethod method, string transfer, int index, byte[]? body,
        Dictionary<string, string>? headers, int limit, bool fresh, CancellationToken token)
    {
        var id = channel ?? throw new AgentFault("BLOB_TRANSFER_FAILED", "The channel is unavailable");
        using var separate = fresh ? new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false, ConnectTimeout = TimeSpan.FromSeconds(10) }) {
            BaseAddress = http.BaseAddress, Timeout = Timeout.InfiniteTimeSpan } : null;
        if (separate != null) separate.DefaultRequestHeaders.Authorization = http.DefaultRequestHeaders.Authorization;
        var client = separate ?? http;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(10 + Math.Ceiling((body?.Length ?? limit) / 65536d)));
        using var request = new HttpRequestMessage(method, $"agent/v1/blobs/{transfer}/{index}?channel={id}");
        if (body != null) { request.Content = new ByteArrayContent(body); request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream"); }
        if (headers != null) foreach (var header in headers) request.Headers.Add(header.Key, header.Value);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
        if (method != HttpMethod.Get || response.StatusCode != HttpStatusCode.OK)
            return new PartReply((int)response.StatusCode, [], null);
        using var result = new MemoryStream();
        await using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
        var buffer = new byte[8192];
        int count;
        while ((count = await stream.ReadAsync(buffer, deadline.Token)) > 0)
        {
            if (result.Length + count > limit) throw new AgentFault("BLOB_HASH_MISMATCH", "A file part exceeds its declared size");
            result.Write(buffer, 0, count);
        }
        var hash = response.Headers.TryGetValues("x-ssam-part-sha256", out var values) ? values.FirstOrDefault() : null;
        return new PartReply((int)response.StatusCode, result.ToArray(), hash);
    }
}

// Both a complete line and an unfinished line are bounded in bytes before JSON parsing.
internal sealed class BoundedLines(Stream stream, int limit)
{
    private readonly byte[] buffer = new byte[8192];
    private int offset;
    private int available;
    public async Task<string?> ReadAsync(CancellationToken token)
    {
        using var line = new MemoryStream();
        while (true)
        {
            if (offset == available) {
                available = await stream.ReadAsync(buffer, token); offset = 0;
                if (available == 0) return null;
            }
            var end = Array.IndexOf(buffer, (byte)'\n', offset, available - offset);
            var count = (end < 0 ? available : end) - offset;
            if (line.Length + count > limit) throw new IOException("Line too large");
            line.Write(buffer, offset, count); offset += count;
            if (end >= 0) { offset++; return Encoding.UTF8.GetString(line.ToArray()); }
        }
    }
}
