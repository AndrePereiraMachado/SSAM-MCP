using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Xilium.CefGlue;

namespace Anvil.Bridge;

/// <summary>Same-profile HTTP through CEF's network service. No Window, WebView,
/// navigation, script execution or cookie export. Credentials stay in the Studio.</summary>
internal static class ScHttpHandler
{
    public const string Capability = "sc_http:studioSession";
    private static readonly SemaphoreSlim Gate = new(1);
    private static readonly IScVault Vault = new ScWindowsVault();
    private static readonly TimeSpan LoginTimeout = TimeSpan.FromSeconds(15);

    public static async Task<string> Handle(JsonObject? parameters)
    {
        try {
            if (parameters == null) throw new ScFailure(ScCodes.BadRequest, "sc_http parameters are required");
            var host = ScGuard.Host(ScGuard.Text(parameters, "host"));
            var action = ScGuard.Text(parameters, "action");
            if (!await ScApiHandler.StudioSignedIn(host)) throw new ScFailure(ScCodes.StudioNotSignedIn, "The Studio has no authenticated session on the requested host.");
            if (!await Gate.WaitAsync(LoginTimeout)) throw new ScFailure(ScCodes.RemoteError, "Native Service Center HTTP queue deadline elapsed; nothing was sent.");
            try {
                var clock = Stopwatch.StartNew();
                JsonObject body;
                if (action == "fetch") body = await Fetch(host, ScWebRequest.Parse(parameters, host));
                else if (action is "status" or "login" or "open") {
                    // A protected read proves the existing web session. An expired
                    // session never falls back to creating a window or a login dialog.
                    var response = await Exchange(ScWebPaths.Root(host) + "Error_Logs.aspx", "GET", null, LoginTimeout, 4 * 1024 * 1024);
                    var signedIn = ScWebResult.ProtectedHtml(host, response.Url, response.Status, response.Html);
                    if (!signedIn && action != "status") throw new ScFailure(ScCodes.WebSignInNeedsLogin, "The native Service Center HTTP session is expired or unavailable; no window was opened.");
                    body = new JsonObject { ["signedIn"] = signedIn, ["open"] = false, ["windowCreated"] = false, ["transport"] = "studio-http", ["submitted"] = false };
                } else if (action == "close") {
                    // This adapter owns no browser/profile: do not erase shared cookies.
                    body = new JsonObject { ["closed"] = true, ["cookiesDeleted"] = false, ["windowCreated"] = false };
                } else throw new ScFailure(ScCodes.BadRequest, "Unknown sc_http action");
                return ScReply.Ok("studio-http", host, null, clock.ElapsedMilliseconds, body);
            } finally { Gate.Release(); }
        } catch (ScFailure failure) { return ScReply.Fail(failure); }
        catch { return ScReply.Fail(new ScFailure(ScCodes.StudioUnavailable, "Native Service Center HTTP transport is unavailable.")); }
    }

    private static async Task<JsonObject> Fetch(string host, ScWebRequest request)
    {
        var injected = ScSecretRefs.Resolve(request.SecretRefs, Vault);
        var form = injected.Apply(request.Form);
        if (request.OperationId != null) ScLedger.Claim(request.OperationId);
        try {
            var response = await Exchange(request.Url, request.Method, form, request.Timeout, request.Accept == "html" ? 4 * 1024 * 1024 : 16 * 1024 * 1024);
            var page = new JsonObject { ["status"] = response.Status, ["finalUrl"] = response.Url,
                ["contentType"] = response.ContentType, ["redirected"] = false };
            if (response.Status is >= 300 and < 400) {
                // Never automatically replay a postback or follow an identity redirect.
                throw new ScFailure(request.Write ? ScCodes.Uncertain : ScCodes.WebSignInRequired,
                    "Service Center redirected the request. No replay or interactive login was attempted.", true,
                    new JsonObject { ["signInRequired"] = true, ["outcome"] = request.Write ? "uncertain" : "not-read" });
            }
            if (request.Accept == "html") page["html"] = response.Html;
            else page["bodyBase64"] = Convert.ToBase64String(response.Bytes);
            var body = ScWebResult.Fetch(host, request.Method, request.Write, page.ToJsonString(), injected);
            body["write"] = request.Write; body["operationId"] = request.OperationId;
            body["transport"] = "studio-http"; body["windowCreated"] = false;
            return body;
        } catch (ScFailure error) { throw injected.Mask(error); }
        catch {
            throw new ScFailure(request.Write ? ScCodes.Uncertain : ScCodes.RemoteError,
                "Native Service Center HTTP request did not complete; nothing was resent.", true);
        }
    }

    private sealed record Response(int Status, string Url, string ContentType, byte[] Bytes)
    { public string Html => Encoding.UTF8.GetString(Bytes); }
    private sealed class Work(Action run) : CefTask { protected override void Execute() => run(); }
    private static async Task<Response> Exchange(string url, string method, JsonObject? form, TimeSpan timeout, int limit)
    {
        var completion = new TaskCompletionSource<Response>(TaskCreationOptions.RunContinuationsAsynchronously);
        CefUrlRequest? pending = null;
        var cancelled = 0;
        CefRuntime.PostTask(CefThreadId.UI, new Work(() => {
            if (Volatile.Read(ref cancelled) != 0) return;
            try {
                using var message = CefRequest.Create();
                message.Url = url; message.Method = method; message.FirstPartyForCookies = url;
                message.Options = CefUrlRequestOptions.AllowStoredCredentials | CefUrlRequestOptions.StopOnRedirect
                    | CefUrlRequestOptions.DisableCache | CefUrlRequestOptions.NoRetryOn5XX;
                if (form != null) {
                    var fields = form.SelectMany(field => (field.Value is JsonArray list ? list : new JsonArray(field.Value?.DeepClone()))
                        .Select(value => new KeyValuePair<string, string>(field.Key, value?.ToString() ?? "")));
                    var bytes = new FormUrlEncodedContent(fields).ReadAsByteArrayAsync().GetAwaiter().GetResult();
                    using var data = CefPostData.Create(); using var element = CefPostDataElement.Create();
                    element.SetToBytes(bytes); data.Add(element); message.PostData = data;
                    message.SetHeaderByName("Content-Type", "application/x-www-form-urlencoded", true);
                }
                pending = CefUrlRequest.Create(message, new Receiver(completion, limit), null);
            } catch { completion.TrySetException(new InvalidOperationException("Native HTTP start failed")); }
        }));
        try { return await completion.Task.WaitAsync(timeout); }
        finally {
            Interlocked.Exchange(ref cancelled, 1);
            if (!completion.Task.IsCompleted) CefRuntime.PostTask(CefThreadId.UI, new Work(() => pending?.Cancel()));
        }
    }
    private sealed class Receiver(TaskCompletionSource<Response> completion, int limit) : CefUrlRequestClient
    {
        private readonly MemoryStream bytes = new();
        protected override void OnUploadProgress(CefUrlRequest request, long current, long total) { }
        protected override void OnDownloadProgress(CefUrlRequest request, long current, long total) { if (current > limit) request.Cancel(); }
        protected override void OnDownloadData(CefUrlRequest request, Stream data)
        {
            var chunk = new byte[8192]; int size;
            while ((size = data.Read(chunk, 0, chunk.Length)) > 0) {
                if (bytes.Length + size > limit) { request.Cancel(); return; }
                bytes.Write(chunk, 0, size);
            }
        }
        protected override void OnRequestComplete(CefUrlRequest request)
        {
            try {
                using var response = request.GetResponse();
                if (response == null || (request.RequestStatus != CefUrlRequestStatus.Success && response.Status is not (>= 300 and < 400)))
                    completion.TrySetException(new InvalidOperationException("Native HTTP request failed"));
                else completion.TrySetResult(new Response(response.Status, response.Url, response.GetHeaderByName("Content-Type") ?? "", bytes.ToArray()));
            } catch { completion.TrySetException(new InvalidOperationException("Native HTTP response failed")); }
            finally { bytes.Dispose(); request.Dispose(); }
        }
    }
}
