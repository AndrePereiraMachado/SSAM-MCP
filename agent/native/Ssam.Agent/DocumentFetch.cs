using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

// document.fetch (0.4.9-native, r40), the rules of agent/lib/document-fetch.mjs in the same order: one integration document (a WSDL,
// an XSD it imports, an OpenAPI document, the JSON answer of a rest-consume sample GET) downloaded HERE, on the user's machine, for a
// hosted SSAM server that never makes a network request for what a job names. params {url, accept: xml|json, maxBytes?, timeoutMs?}:
// only http(s) without user or password, one GET with no cookies, no credentials and no header of the server, at most 5 MB and 30 s
// (never past the call's deadline), at most 5 redirects followed here, each to http(s) again; the answer must be the document asked
// for (XML without DOCTYPE/ENTITY, or JSON); a final status that is not 2xx answers its status with no content.
// Review of r40 (findings 1, 2): sameOrigin true keeps every redirect on the origin asked; a link-local address (169.254.0.0/16,
// fe80::/10, fd00:ec2::254: the machine's cloud metadata) or a metadata name is never requested (the URL, a redirect, a name that
// resolves there, and the address the socket connects to); a redirect never moves from another host into this machine's loopback.
// Unlike the Node agent this client uses the system proxy (as the person's browser); no proxy credential is ever sent.
// -> {finalUrl, status, contentType, bytes, sha256, contentBase64}. The protocol cases are the Node agent's
// (tests/native-protocol/document-fetch-cases.json).
internal sealed partial class DocumentFetch
{
    internal const string Name = "document.fetch";
    internal const int MaxBytes = 5 * 1024 * 1024, DefaultTimeoutMs = 30000, MinTimeoutMs = 1000, MaxRedirects = 5;
    internal const string UserAgent = "SSAM-Agent document fetch";
    private static readonly string[] Keys = ["url", "accept", "maxBytes", "timeoutMs", "sameOrigin"];
    private static readonly HashSet<string> MetadataNames = new(StringComparer.OrdinalIgnoreCase) { "metadata", "metadata.google.internal", "metadata.goog", "instance-data", "instance-data.ec2.internal" };
    private static readonly IPAddress AwsV6Metadata = IPAddress.Parse("fd00:ec2::254");
    // The tests' resolver seam (a name's addresses), else the system's.
    internal Func<string, CancellationToken, Task<IPAddress[]>> Resolve = (host, token) => Dns.GetHostAddressesAsync(host, token);
    private static readonly HashSet<int> Redirects = [301, 302, 303, 307, 308];
    private readonly HttpClient client;
    // The tests' clock seam (the call's deadline is in this machine's clock, milliseconds since the epoch).
    internal Func<long> Now = () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    [GeneratedRegex("<!DOCTYPE|<!ENTITY", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)] private static partial Regex UnsafeXml();

    internal DocumentFetch(HttpMessageHandler? handler = null)
    {
        // Never the channel's client: no cookie container, no credentials (default or explicit), redirects followed by hand.
        client = new HttpClient(handler ?? new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, Credentials = null, PreAuthenticate = false,
            DefaultProxyCredentials = null, AutomaticDecompression = DecompressionMethods.All, ConnectCallback = ConnectChecked }, true) { Timeout = Timeout.InfiniteTimeSpan };
    }

    // The socket of a request never reaches a link-local address, whatever the name resolved to (a name that changes its answer).
    private static async ValueTask<Stream> ConnectChecked(SocketsHttpConnectionContext context, CancellationToken token)
    {
        var socket = new System.Net.Sockets.Socket(System.Net.Sockets.SocketType.Stream, System.Net.Sockets.ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(context.DnsEndPoint, token);
            if (socket.RemoteEndPoint is IPEndPoint remote && LinkLocal(remote.Address))
                throw new HttpRequestException("the connection reached a link-local address, which is never requested");
            return new System.Net.Sockets.NetworkStream(socket, true);
        }
        catch { socket.Dispose(); throw; }
    }

    internal static bool LinkLocal(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork) { var b = address.GetAddressBytes(); return b[0] == 169 && b[1] == 254; }
        return address.IsIPv6LinkLocal || address.Equals(AwsV6Metadata);
    }
    internal static bool Loopback(string host)
    {
        var h = host.Trim('[', ']');
        if (h.Equals("localhost", StringComparison.OrdinalIgnoreCase) || h.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase)) return true;
        if (!IPAddress.TryParse(h, out var address)) return false;
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        return IPAddress.IsLoopback(address) || address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any);
    }
    // The host of a URL may be asked: never link-local or a metadata name, nor a name that resolves to a link-local address.
    private async Task<string?> HostProblem(Uri url, CancellationToken token)
    {
        var host = url.IdnHost.TrimEnd('.');
        if (MetadataNames.Contains(host)) return "its host is a link-local or metadata address, which is never requested";
        if (IPAddress.TryParse(host.Trim('[', ']'), out var literal)) return LinkLocal(literal) ? "its host is a link-local or metadata address, which is never requested" : null;
        IPAddress[] addresses;
        try { addresses = await Resolve(host, token); } catch (Exception e) when (e is System.Net.Sockets.SocketException or OperationCanceledException or ArgumentException) { return null; }
        return addresses.Any(LinkLocal) ? "its name resolves to a link-local address, which is never requested" : null;
    }

    private static AgentFault Refuse(string code, string message) => new(code, message);

    // The URL a request may go to: http(s), no user or password; the fragment is never sent.
    internal static Uri Fetchable(string? text, string what = "url")
    {
        if (string.IsNullOrEmpty(text) || !Uri.TryCreate(text, UriKind.Absolute, out var url)) throw Refuse("DOCUMENT_FETCH_URL_REFUSED", what + " is not a URL");
        return Checked(url, what);
    }
    private static Uri Checked(Uri url, string what)
    {
        if (url.Scheme != Uri.UriSchemeHttp && url.Scheme != Uri.UriSchemeHttps) throw Refuse("DOCUMENT_FETCH_URL_REFUSED", what + " uses " + url.Scheme + ": only http and https are downloaded");
        if (!string.IsNullOrEmpty(url.UserInfo)) throw Refuse("DOCUMENT_FETCH_URL_REFUSED", what + " carries a user or password: the agent never sends credentials");
        return string.IsNullOrEmpty(url.Fragment) ? url : new UriBuilder(url) { Fragment = "" }.Uri;
    }

    internal static (Uri Url, string Accept, int MaxBytes, int TimeoutMs, bool SameOrigin) Plan(JsonObject p)
    {
        var extra = p.Select(e => e.Key).Where(k => !Keys.Contains(k)).Take(4).ToArray();
        if (extra.Length > 0) throw StudioKinds.Invalid("document.fetch takes only url, accept, maxBytes, timeoutMs and sameOrigin; not " + string.Join(", ", extra));
        var sameOrigin = p["sameOrigin"] switch { null => false, JsonValue s when s.TryGetValue<bool>(out var flag) => flag, _ => throw StudioKinds.Invalid("sameOrigin must be true or false") };
        var url = p["url"] is JsonValue u && u.TryGetValue<string>(out var text) && text.Length <= 4096 ? text : throw StudioKinds.Invalid("url must be a text of at most 4096 characters");
        var accept = p["accept"] is JsonValue a && a.TryGetValue<string>(out var kind) && kind is "xml" or "json" ? kind : throw StudioKinds.Invalid("accept must be 'xml' or 'json'");
        var max = Whole(p["maxBytes"], MaxBytes);
        if (max is null or < 1 or > MaxBytes) throw StudioKinds.Invalid("maxBytes must be 1 to " + MaxBytes);
        var timeout = Whole(p["timeoutMs"], DefaultTimeoutMs);
        if (timeout is null or < MinTimeoutMs or > DefaultTimeoutMs) throw StudioKinds.Invalid("timeoutMs must be 1000 to " + DefaultTimeoutMs);
        return (Fetchable(url), accept, (int)max, (int)timeout, sameOrigin);
    }
    // A whole number of the JSON (absent: the default; anything else: null).
    private static long? Whole(JsonNode? node, long fallback)
    {
        if (node == null) return fallback;
        if (node is not JsonValue v) return null;
        if (v.TryGetValue<long>(out var l)) return l;
        return v.TryGetValue<double>(out var d) && double.IsFinite(d) && Math.Floor(d) == d && Math.Abs(d) < 9e15 ? (long)d : null;
    }

    // Whether the bytes are the document asked for. -> null | the refusal.
    internal static AgentFault? DocumentProblem(byte[] bytes, string accept)
    {
        var text = Encoding.UTF8.GetString(bytes).TrimStart('﻿');
        if (accept == "xml")
        {
            if (!text.TrimStart().StartsWith('<')) return Refuse("DOCUMENT_FETCH_NOT_DOCUMENT", "the answer is not an XML document");
            return UnsafeXml().IsMatch(text) ? Refuse("DOCUMENT_FETCH_UNSAFE_XML", "the XML declares a DTD or ENTITY, which is never downloaded") : null;
        }
        // The depth of the Node agent's JSON.parse has no small limit: 1024 here (the reader's default is 64).
        try { using var _ = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 1024 }); return null; }
        catch (JsonException) { return Refuse("DOCUMENT_FETCH_NOT_DOCUMENT", "the answer is not a JSON document"); }
    }

    internal async Task<JsonObject> Execute(JsonObject p, long? deadline, CancellationToken token)
    {
        var plan = Plan(p);
        if (await HostProblem(plan.Url, token) is string first) throw Refuse("DOCUMENT_FETCH_URL_REFUSED", plan.Url + " was not requested: " + first);
        var budget = deadline is long due ? Math.Min(plan.TimeoutMs, due - Now()) : plan.TimeoutMs;
        if (budget <= 0) throw Refuse("DOCUMENT_FETCH_FAILED", "the call's deadline has passed; nothing was requested");
        using var timer = CancellationTokenSource.CreateLinkedTokenSource(token);
        timer.CancelAfter(TimeSpan.FromMilliseconds(budget));
        var url = plan.Url;
        var seconds = (int)Math.Round(budget / 1000.0);
        for (var hop = 0; ; hop++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.TryAddWithoutValidation("Accept", plan.Accept == "xml" ? "application/xml, text/xml, application/wsdl+xml, */*;q=0.1" : "application/json, */*;q=0.1");
            request.Headers.TryAddWithoutValidation("User-Agent", UserAgent);
            HttpResponseMessage response;
            try { response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timer.Token); }
            catch (Exception e) when (e is HttpRequestException or OperationCanceledException or IOException)
            {
                throw Refuse("DOCUMENT_FETCH_FAILED", "GET " + url + " failed: " + (timer.IsCancellationRequested ? "no answer in " + seconds + " s" : Clip(e.Message)));
            }
            using (response)
            {
                var status = (int)response.StatusCode;
                if (Redirects.Contains(status))
                {
                    var location = response.Headers.TryGetValues("Location", out var values) ? values.FirstOrDefault() : null;
                    if (string.IsNullOrEmpty(location)) throw Refuse("DOCUMENT_FETCH_REDIRECT_REFUSED", "GET " + url + " answered " + status + " without a Location");
                    if (hop >= MaxRedirects) throw Refuse("DOCUMENT_FETCH_REDIRECT_REFUSED", "GET " + plan.Url + " was redirected more than " + MaxRedirects + " times");
                    if (!Uri.TryCreate(url, location, out var next)) throw Refuse("DOCUMENT_FETCH_REDIRECT_REFUSED", "GET " + url + " redirected to a text that is not a URL");
                    Uri target;
                    try { target = Checked(next, "the redirect"); }
                    catch (AgentFault e) { throw Refuse("DOCUMENT_FETCH_REDIRECT_REFUSED", "GET " + url + " redirected: " + e.Message); }
                    var origin = plan.Url.GetLeftPart(UriPartial.Authority);
                    if (plan.SameOrigin && !string.Equals(target.GetLeftPart(UriPartial.Authority), origin, StringComparison.OrdinalIgnoreCase))
                        throw Refuse("DOCUMENT_FETCH_REDIRECT_REFUSED", "GET " + url + " redirected to another server (" + target.GetLeftPart(UriPartial.Authority) + "), and this download stays on " + origin);
                    if (Loopback(target.Host) && !Loopback(url.Host)) throw Refuse("DOCUMENT_FETCH_REDIRECT_REFUSED", "GET " + url + " redirected into this machine (" + target.Authority + "), which a redirect never does");
                    if (await HostProblem(target, timer.Token) is string hopProblem) throw Refuse("DOCUMENT_FETCH_REDIRECT_REFUSED", "GET " + url + " redirected to " + target.Authority + ": " + hopProblem);
                    url = target;
                    continue;
                }
                var contentType = response.Content.Headers.TryGetValues("Content-Type", out var types) ? string.Join(", ", types) : "";
                if (contentType.Length > 200) contentType = contentType[..200];
                if (status is < 200 or > 299)
                    return Answer(url, status, contentType, []);
                var declared = response.Content.Headers.ContentLength;
                if (declared > plan.MaxBytes) throw Refuse("DOCUMENT_FETCH_TOO_LARGE", "the document declares " + declared + " bytes, more than " + plan.MaxBytes);
                byte[] bytes;
                try
                {
                    await using var stream = await response.Content.ReadAsStreamAsync(timer.Token);
                    using var buffer = new MemoryStream();
                    var chunk = new byte[81920];
                    for (int read; (read = await stream.ReadAsync(chunk, timer.Token)) > 0;)
                    {
                        if (buffer.Length + read > plan.MaxBytes) throw Refuse("DOCUMENT_FETCH_TOO_LARGE", "the document has more than " + plan.MaxBytes + " bytes");
                        buffer.Write(chunk, 0, read);
                    }
                    bytes = buffer.ToArray();
                }
                catch (Exception e) when (e is HttpRequestException or OperationCanceledException or IOException)
                {
                    throw Refuse("DOCUMENT_FETCH_FAILED", "GET " + url + " failed while reading: " + (timer.IsCancellationRequested ? "no answer in " + seconds + " s" : Clip(e.Message)));
                }
                if (DocumentProblem(bytes, plan.Accept) is AgentFault wrong) throw wrong;
                return Answer(url, status, contentType, bytes);
            }
        }
    }

    private static JsonObject Answer(Uri url, int status, string contentType, byte[] bytes) => new()
    {
        ["finalUrl"] = url.AbsoluteUri, ["status"] = status, ["contentType"] = contentType, ["bytes"] = bytes.Length,
        ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(bytes)), ["contentBase64"] = Convert.ToBase64String(bytes),
    };
    private static string Clip(string text) { var line = text.Split('\n')[0]; return line.Length > 200 ? line[..200] : line; }
}
