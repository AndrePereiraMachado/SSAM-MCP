using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Ssam.PrivateTransport;

namespace Anvil.Bridge;

// Broker-owned authentication is handed over for one request. The Studio never
// exports its own cookies and vault values never leave this native process.
internal static class ScPrivateHttp
{
    internal const string Capability = "sc_private_http:secretRefs";

    internal static (string Host, string Principal, string Pipe, string Hash, ScWebRequest Request) Parse(JsonObject p)
    {
        var allowed = new HashSet<string> { "host", "principal", "contextPipeId", "requestSha256", "requestJson" };
        if (p.Count != allowed.Count || p.Any(x => !allowed.Contains(x.Key))) throw Invalid();
        var host = ScGuard.Host(ScGuard.Text(p, "host"));
        var principal = ScGuard.Text(p, "principal") ?? throw Invalid();
        var pipe = ScGuard.Text(p, "contextPipeId") ?? throw Invalid();
        var hash = ScGuard.Text(p, "requestSha256") ?? throw Invalid();
        var json = ScGuard.Text(p, "requestJson") ?? throw Invalid();
        if (string.IsNullOrWhiteSpace(principal) || principal.Length > 320 || json.Length > 2 * 1024 * 1024) throw Invalid();
        _ = PrivateHttpContext.PipeName(pipe);
        if (Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json))).ToLowerInvariant() != hash) throw Invalid();
        var parameters = JsonNode.Parse(json) as JsonObject ?? throw Invalid();
        if (parameters["host"]?.ToString() != host) throw Invalid();
        return (host, principal, pipe, hash, ScWebRequest.Parse(parameters, host));
    }

    internal static async Task<JsonObject> Execute(string host, string principal, ScWebRequest request,
        PrivateHttpContext context, IScVault vault, Func<Task<string?>> currentPrincipal,
        HttpMessageHandler handler, CancellationToken cancellationToken,
        Func<IReadOnlyList<string>, CancellationToken, Task>? publishCookies = null)
    {
        await CheckPrincipal(principal, currentPrincipal);
        var injected = ScSecretRefs.Resolve(request.SecretRefs, vault);
        var sessionMask = new ScInjected(context.Cookie.Split(';').Select(pair => pair[(pair.IndexOf('=') + 1)..].Trim())
            .Append(context.Csrf).Where(value => value.Length > 0)
            .Select(value => KeyValuePair.Create("session", value)).ToArray());
        try {
            using var client = new HttpClient(handler, disposeHandler: false) { Timeout = Timeout.InfiniteTimeSpan };
            using var message = new HttpRequestMessage(new HttpMethod(request.Method), request.Url);
            message.Headers.TryAddWithoutValidation("Cookie", context.Cookie);
            message.Headers.TryAddWithoutValidation("Accept", request.Accept == "html" ? "text/html" : "*/*");
            message.Headers.TryAddWithoutValidation("User-Agent", "SSAM-Hybrid-O11/1");
            var form = injected.Apply(request.Form);
            if (form != null) message.Content = new FormUrlEncodedContent(form.SelectMany(field =>
                (field.Value is JsonArray array ? array : new JsonArray(field.Value?.DeepClone()))
                    .Select(value => KeyValuePair.Create(field.Key, value?.ToString() ?? ""))));
            await CheckPrincipal(principal, currentPrincipal);
            if (request.OperationId != null) ScLedger.Claim(request.OperationId);
            using var response = await client.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            // A tool-owned session can rotate even on a GET. No header/value
            // leaves the native process; observe the missing propagation and
            // protect any response echo of the newly issued authentication.
            var cookieUpdates = response.Headers.TryGetValues("Set-Cookie", out var cookies) ? cookies.ToArray() : [];
            if (publishCookies != null) {
                await CheckPrincipal(principal, currentPrincipal);
                await publishCookies(cookieUpdates, cancellationToken);
            }
            var responseMask = new ScInjected(cookieUpdates.Select(header => header.Split(';', 2)[0])
                .Where(pair => pair.IndexOf('=') > 0).Select(pair => pair[(pair.IndexOf('=') + 1)..].Trim())
                .Where(value => value.Length > 0).Select(value => KeyValuePair.Create("session", value)).ToArray());
            var status = (int)response.StatusCode;
            if (status is >= 300 and < 400)
                throw new ScFailure(request.Write ? ScCodes.Uncertain : ScCodes.WebSignInRequired,
                    "Service Center redirected the request; nothing was replayed or followed.", true);
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var output = new MemoryStream();
            var buffer = new byte[8192];
            var limit = request.Accept == "html" ? 4 * 1024 * 1024 : 16 * 1024 * 1024;
            int size;
            while ((size = await stream.ReadAsync(buffer, cancellationToken)) > 0) {
                if (output.Length + size > limit) throw new ScFailure(request.Write ? ScCodes.Uncertain : ScCodes.RemoteError,
                    "Service Center response exceeded its size limit; no request was repeated.", true);
                output.Write(buffer, 0, size);
            }
            var contentType = response.Content.Headers.ContentType?.ToString() ?? "";
            var page = new JsonObject { ["status"] = status, ["finalUrl"] = request.Url,
                ["contentType"] = contentType, ["redirected"] = false };
            var responseBytes = output.ToArray();
            var text = Encoding.UTF8.GetString(responseBytes);
            var safeText = responseMask.Mask(sessionMask.Mask(text));
            // Same as the sc_web page script: an HTML answer to a file request is a
            // page (error, sign-in), returned masked so the caller can classify it.
            if (request.Accept == "html" || contentType.Contains("html", StringComparison.OrdinalIgnoreCase)) page["html"] = safeText;
            else {
                if (safeText != text) throw new ScFailure(request.Write ? ScCodes.Uncertain : ScCodes.RemoteError,
                    "Service Center returned session material in a binary response; its body was dropped.", true);
                page["bodyBase64"] = Convert.ToBase64String(responseBytes);
            }
            var result = ScWebResult.Fetch(host, request.Method, request.Write, page.ToJsonString(), injected);
            result["transport"] = "private-http"; result["windowCreated"] = false;
            result["sessionCookieUpdatesObserved"] = cookieUpdates.Length > 0;
            result["sessionCookieUpdatesApplied"] = publishCookies != null;
            result["operationId"] = request.OperationId; result["write"] = request.Write;
            return result;
        } catch (ScFailure error) { throw injected.Mask(sessionMask.Mask(error)); }
        catch { throw new ScFailure(request.Write ? ScCodes.Uncertain : ScCodes.RemoteError,
            "Private Service Center HTTP did not complete; nothing was resent.", true); }
    }

    internal static async Task CheckPrincipal(string expected, Func<Task<string?>> current)
    {
        if (!string.Equals(expected.Trim(), (await current())?.Trim(), StringComparison.OrdinalIgnoreCase))
            throw new ScFailure(ScCodes.StudioNotSignedIn, "The selected Studio identity changed; nothing was sent.");
    }

    private static ScFailure Invalid() => new(ScCodes.BadRequest, "Private HTTP request is invalid; nothing was sent.");
}
