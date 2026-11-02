using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

// document.fetch (0.4.8-native, r40), the rules of agent/lib/document-fetch.mjs in the same order: one integration document (a WSDL,
// an XSD it imports, an OpenAPI document, the JSON answer of a rest-consume sample GET) downloaded HERE, on the user's machine, for a
// hosted SSAM server that never makes a network request for what a job names. params {url, accept: xml|json, maxBytes?, timeoutMs?}:
// only http(s) without user or password, one GET with no cookies, no credentials and no header of the server, at most 5 MB and 30 s
// (never past the call's deadline), at most 5 redirects followed here, each to http(s) again; the answer must be the document asked
// for (XML without DOCTYPE/ENTITY, or JSON); a final status that is not 2xx answers its status with no content.
// -> {finalUrl, status, contentType, bytes, sha256, contentBase64}. The protocol cases are the Node agent's
// (tests/native-protocol/document-fetch-cases.json).
internal sealed partial class DocumentFetch
{
    internal const string Name = "document.fetch";
    internal const int MaxBytes = 5 * 1024 * 1024, DefaultTimeoutMs = 30000, MinTimeoutMs = 1000, MaxRedirects = 5;
    internal const string UserAgent = "SSAM-Agent document fetch";
    private static readonly string[] Keys = ["url", "accept", "maxBytes", "timeoutMs"];
    private static readonly HashSet<int> Redirects = [301, 302, 303, 307, 308];
    private readonly HttpClient client;
    // The tests' clock seam (the call's deadline is in this machine's clock, milliseconds since the epoch).
    internal Func<long> Now = () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    [GeneratedRegex("<!DOCTYPE|<!ENTITY", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)] private static partial Regex UnsafeXml();

    internal DocumentFetch(HttpMessageHandler? handler = null)
    {
        // Never the channel's client: no cookie container, no credentials (default or explicit), redirects followed by hand.
        client = new HttpClient(handler ?? new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, Credentials = null, PreAuthenticate = false,
            DefaultProxyCredentials = null, AutomaticDecompression = DecompressionMethods.All }, true) { Timeout = Timeout.InfiniteTimeSpan };
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

    internal static (Uri Url, string Accept, int MaxBytes, int TimeoutMs) Plan(JsonObject p)
    {
        var extra = p.Select(e => e.Key).Where(k => !Keys.Contains(k)).Take(4).ToArray();
        if (extra.Length > 0) throw StudioKinds.Invalid("document.fetch takes only url, accept, maxBytes and timeoutMs; not " + string.Join(", ", extra));
        var url = p["url"] is JsonValue u && u.TryGetValue<string>(out var text) && text.Length <= 4096 ? text : throw StudioKinds.Invalid("url must be a text of at most 4096 characters");
        var accept = p["accept"] is JsonValue a && a.TryGetValue<string>(out var kind) && kind is "xml" or "json" ? kind : throw StudioKinds.Invalid("accept must be 'xml' or 'json'");
        var max = Whole(p["maxBytes"], MaxBytes);
        if (max is null or < 1 or > MaxBytes) throw StudioKinds.Invalid("maxBytes must be 1 to " + MaxBytes);
        var timeout = Whole(p["timeoutMs"], DefaultTimeoutMs);
        if (timeout is null or < MinTimeoutMs or > DefaultTimeoutMs) throw StudioKinds.Invalid("timeoutMs must be 1000 to " + DefaultTimeoutMs);
        return (Fetchable(url), accept, (int)max, (int)timeout);
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
        try { using var _ = JsonDocument.Parse(text); return null; }
        catch (JsonException) { return Refuse("DOCUMENT_FETCH_NOT_DOCUMENT", "the answer is not a JSON document"); }
    }

    internal async Task<JsonObject> Execute(JsonObject p, long? deadline, CancellationToken token)
    {
        var plan = Plan(p);
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
                    try { url = Checked(next, "the redirect"); }
                    catch (AgentFault e) { throw Refuse("DOCUMENT_FETCH_REDIRECT_REFUSED", "GET " + url + " redirected: " + e.Message); }
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
