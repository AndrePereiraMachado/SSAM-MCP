using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Ssam.PrivateTransport;

// The caller supplies a one-request broker context over the current-user pipe.
// This owns an isolated HTTP client, never the Studio client or a browser profile.
internal static class PortalPrivateHttp {
    internal static HttpClient NewClient() => new(new HttpClientHandler {
        AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false
    });

    internal static void Validate(PortalCore.WebRequest request, string host, PortalCore.TenantPolicy tenants) {
        PortalCore.CheckHost(host);
        if (!PortalCore.CheckWebRoute(request) || request.Method != "POST" || !request.Path.Contains("/screenservices/"))
            throw new PortalCore.Refusal("NOT_ALLOWED", "Private session handoff accepts an authorized screenservice write only.");
        PortalCore.CheckTenant(tenants, host, request.ConfirmTenant);
        if (request.Path == PortalApiClientSecret.Path && request.OperationId != PortalApiClientSecret.Operation)
            throw new PortalCore.Refusal("NOT_ALLOWED", "API Client creation requires the exact private output operation.");
        if (request.OperationId == PortalApiClientSecret.Operation)
            PortalApiClientSecret.Validate(request,host,DateTimeOffset.UtcNow);
        var conversion=request.OperationId=="mobileExtensibility.convertFile";
        var mobileInput=conversion?"BinaryData":"FileContent";
        if(request.MobileExpectedContent != null && request.OperationId is not ("mobileExtensibility.uploadFile" or "mobileExtensibility.convertFile"))
            throw new PortalCore.Refusal("NOT_ALLOWED", "Content binding applies only to mobile file upload.");
        if(request.OperationId is "mobileExtensibility.uploadFile" or "mobileExtensibility.convertFile" && request.SecretRefs is { Count: > 0 }) {
            var refs=request.SecretRefs;
            if(refs.Count!=1 || refs[0].Pointer!="/inputParameters/"+mobileInput || refs[0].Field!="password"
                || !refs[0].Target.StartsWith("SSAM/ODC3/"+host+"/Setting/",StringComparison.Ordinal)
                || request.Body?["inputParameters"]?[mobileInput]?.GetValue<string>()!=""
                || request.MobileExpectedContent is not JsonObject proof || proof.Count!=2
                || !System.Text.RegularExpressions.Regex.IsMatch((string?)proof["sha256"]??"","^[a-f0-9]{64}$")
                || (int?)proof["byteLength"] is not (>=1 and <=PortalMobileUpload.MaxBytes))
                throw new PortalCore.Refusal("NOT_ALLOWED", "Vault binary upload requires exact private content binding.");
        }
        if (request.OperationId == "mobileExtensibility.saveFile") {
            if (request.Path != "/apps/screenservices/apps/ApplicationMobile/extensibillitysetting/ActionExtensbilitySettingSave_Wrapper"
                || !Guid.TryParseExact(request.MobileUploadOperationUuid, "D", out _) || request.MobileObjectUri == null
                || !PortalMobileUpload.CheckBinding(request.MobileUploadOperationUuid!,request.MobileObjectUri) || request.SecretRefs is { Count: > 0 })
                throw new PortalCore.Refusal("NOT_ALLOWED", "Private mobile save requires its exact opaque upload binding.");
        } else if (request.MobileUploadOperationUuid != null || request.MobileObjectUri != null)
            throw new PortalCore.Refusal("NOT_ALLOWED", "Private upload bindings apply only to the exact native mobile file save.");
    }

    internal static async Task<JsonObject> Send(HttpClient client, PortalCore.WebRequest request,
        PrivateHttpContext context, string host, string user, PortalCore.TenantPolicy tenants,
        PortalCore.Places places, PortalCore.VaultReader vault, CancellationToken cancellationToken,
        Func<HttpClient>? mobileDownloadClient = null, Func<string,string,string,bool>? apiClientVaultWriter = null) {
        string? reservation = null; bool sent = false;
        byte[]? body = null;
        var masks = new List<string>();
        var started = DateTimeOffset.UtcNow;
        try {
            Validate(request, host, tenants);
            var apiClientCreate = request.OperationId == PortalApiClientSecret.Operation;
            if (apiClientCreate && (apiClientVaultWriter == null || vault(PortalApiClientSecret.Target(host,request.OperationUuid!)) != null))
                throw new PortalCore.Refusal("NOT_ALLOWED", "A new private vault destination and a native writer are required before API Client creation.");
            // Authentication was proved by the broker's protected read and is
            // bound to the native principal by PrivateHttpContext.Receive.
            // Match that broker's HTTP contract: forward CSRF when supplied;
            // never fabricate one or require browser-only cookie formats.
            masks.Add(context.Cookie); if (context.Csrf.Length > 0) masks.Add(context.Csrf);
            foreach (var cookie in context.Cookie.Split(';')) {
                var index = cookie.IndexOf('=');
                if (index < 0 || cookie[(index + 1)..].Trim() is not { Length: > 0 } value) continue;
                var name = cookie[..index].Trim();
                // Public routing flags must not corrupt typed DTO values such
                // as stage order "0". Unknown cookie values remain private.
                var publicRouting = name switch {
                    "TenantDomain" => value == host,
                    "TenantPref" => value == host.Split('.')[0],
                    "TenantGeo" => System.Text.RegularExpressions.Regex.IsMatch(value, "^[A-Z]{2}$"),
                    "TenantRing" => System.Text.RegularExpressions.Regex.IsMatch(value, "^\\d{1,2}$"),
                    "TenantPortfolio" => value is "0" or "1",
                    _ => false
                };
                if (!publicRouting) {
                    masks.Add(value); masks.Add(Uri.UnescapeDataString(value));
                    masks.Add(System.Net.WebUtility.HtmlEncode(value)); masks.Add(Uri.EscapeDataString(value));
                }
            }
            var (placedRequest, placed) = PortalCore.PlaceWebSecrets(request, host, true, vault);
            masks.AddRange(placed);
            var conversion=request.OperationId=="mobileExtensibility.convertFile";
            var mobileInput=conversion?"BinaryData":"FileContent";
            if(request.OperationId is "mobileExtensibility.uploadFile" or "mobileExtensibility.convertFile" && request.SecretRefs is { Count: >0 }) {
                byte[] content;
                var encoded=(string?)placedRequest.Body?["inputParameters"]?[mobileInput]??"";
                try { content=Convert.FromBase64String(encoded); } catch { throw new PortalCore.Refusal("NOT_ALLOWED","Vault binary content is invalid."); }
                try {
                    if(content.Length!=(int?)request.MobileExpectedContent?["byteLength"] || Convert.ToBase64String(content)!=encoded
                        || Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant()!=(string?)request.MobileExpectedContent?["sha256"])
                        throw new PortalCore.Refusal("NOT_ALLOWED","Vault binary content changed from its approved hash. Nothing was sent.");
                } finally { CryptographicOperations.ZeroMemory(content); }
            }
            var mobileSave = request.OperationId == "mobileExtensibility.saveFile";
            if (mobileSave) {
                var p = request.Body?["inputParameters"];
                var setting = p?["ExtensibilitySettingInfo"]?["Setting"];
                if (p?["RequiresDecoding"]?.GetValue<bool>() != false || setting?["DataType"]?.GetValue<string>() != "BinaryUrl"
                    || setting?["IsSecret"] is not JsonValue secretFlag || !secretFlag.TryGetValue<bool>(out _) || setting?["ValueOrigin"]?.GetValue<string>() != "Override"
                    || setting?["Value"]?.GetValue<string>() != "") throw new PortalCore.Refusal("NOT_ALLOWED", "Native binary save needs its existing setting and an empty private URI placeholder.");
                var signed = PortalMobileUpload.Resolve(request.MobileUploadOperationUuid!, host, user, request.MobileObjectUri!, DateTimeOffset.UtcNow, false);
                masks.Add(signed);
                var copy = placedRequest.Body!.DeepClone();
                copy["inputParameters"]!["ExtensibilitySettingInfo"]!["Setting"]!["Value"] = signed;
                placedRequest = placedRequest with { Body = copy };
            }
            body = Encoding.UTF8.GetBytes(placedRequest.Body?.ToJsonString() ?? "{}");
            using var message = new HttpRequestMessage(HttpMethod.Post, new Uri("https://" + host + request.Path));
            if (!PortalCore.SameHost(message.RequestUri, host))
                throw new PortalCore.Refusal("HOST_MISMATCH", "Private HTTP request left its authenticated tenant.");
            message.Headers.Add("Cookie", context.Cookie);
            if (context.Csrf.Length > 0) message.Headers.Add("x-csrftoken", context.Csrf);
            message.Headers.Add("outsystems-client-env", "browser");
            message.Headers.Add("Origin", "https://" + host);
            message.Headers.Referrer = new Uri("https://" + host + "/" + request.Path.Split('/')[1] + "/");
            message.Headers.Accept.ParseAdd("application/json");
            message.Content = new ByteArrayContent(body);
            message.Content.Headers.ContentType = new("application/json") { CharSet = "utf-8" };
            cancellationToken.ThrowIfCancellationRequested();
            reservation = PortalCore.Reserve(places.WritesDir, request.OperationUuid!, new JsonObject {
                ["state"] = "sending", ["at"] = started.ToString("o"), ["operationUuid"] = request.OperationUuid,
                ["operationId"] = request.OperationId, ["host"] = host, ["path"] = request.Path, ["user"] = user,
                ["authorizeSha256"] = request.AuthorizeSha256,
                ["bodySha256"] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(request.Body?.ToJsonString() ?? "{}"))).ToLowerInvariant(),
                ["secretRefs"] = PortalCore.SecretRefsRecord(request.SecretRefs), ["source"] = "private-session-pipe"
            });
            if (mobileSave) PortalMobileUpload.Resolve(request.MobileUploadOperationUuid!, host, user, request.MobileObjectUri!, DateTimeOffset.UtcNow, true);
            sent = true;
            using var response = await client.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            JsonObject result; string state;
            var status = (int)response.StatusCode;
            if (status is >= 300 and < 400) {
                result = PortalCore.Fail("UNCERTAIN", "The private HTTP write returned a redirect. Reconcile by a read; never resend.");
                result["status"] = status; state = "uncertain";
            } else if (!(response.Content.Headers.ContentType?.MediaType?.Contains("json", StringComparison.OrdinalIgnoreCase) ?? false)) {
                // Never return or store unknown binary content that may echo a secret.
                result = PortalCore.Fail("UNCERTAIN", "The private HTTP write did not return the required JSON response. Reconcile by a read; never resend.");
                result["status"] = status; state = "uncertain";
            } else {
                if (apiClientCreate) {
                    if (!PortalCore.SameHost(response.RequestMessage?.RequestUri,host))
                        throw new InvalidOperationException("Private response left its tenant.");
                    JsonObject projected;
                    if (status == 200) {
                        if (response.Content.Headers.ContentLength > 32768) throw new InvalidOperationException("Private response exceeded budget.");
                        var json = await response.Content.ReadAsStringAsync(cancellationToken);
                        if (json.Length > 32768) throw new InvalidOperationException("Private response exceeded budget.");
                        var native = JsonNode.Parse(json) as JsonObject ?? throw new InvalidOperationException("Private response unavailable.");
                        var proof = PortalApiClientSecret.Capture(native,request,host,apiClientVaultWriter!,
                            proof=>PortalApiClientCleanup.Record(places.WritesDir,host,user,request,proof));
                        projected = new JsonObject { ["data"] = new JsonObject { ["ApiClientProof"] = proof } };
                    } else {
                        // Reject or reconcile by status only. Unknown error fields
                        // must never echo a newly generated or supplied credential.
                        projected = new JsonObject();
                    }
                    response.Content.Dispose();
                    response.Content = new StringContent(projected.ToJsonString(), Encoding.UTF8, "application/json");
                }
                if (request.OperationId is "mobileExtensibility.uploadFile" or "mobileExtensibility.convertFile") {
                    var nativeAction=conversion?"ActionBinaryToBase64":"ActionFileUpload_Wrapper";
                    if (request.Path != "/apps/screenservices/apps/ApplicationMobile/extensibillitysetting/"+nativeAction || status != 200)
                        throw new InvalidOperationException("Private mobile upload contract unavailable.");
                    var json = await response.Content.ReadAsStringAsync(cancellationToken);
                    if (json.Length > (conversion?1400000:32768)) throw new InvalidOperationException("Private upload response exceeds budget.");
                    var native = JsonNode.Parse(json) as JsonObject;
                    if (native?["exception"] != null || native?["error"] != null
                        || (bool?)native?["versionInfo"]?["hasApiVersionChanged"] == true
                        || (bool?)native?["versionInfo"]?["hasModuleVersionChanged"] == true
                        || native?["data"]?[conversion?"Base64":"DownloadURL"] is not JsonValue link || !link.TryGetValue<string>(out var signedUri)
                        || placedRequest.Body?["inputParameters"]?[mobileInput] is not JsonValue payload || !payload.TryGetValue<string>(out var base64))
                        throw new InvalidOperationException("Private upload response unavailable.");
                    JsonObject proof;
                    if(conversion)proof=PortalMobileUpload.CaptureBase64(host,user,request.OperationUuid!,base64,signedUri,DateTimeOffset.UtcNow);
                    else {
                        using var download = (mobileDownloadClient ?? NewClient)();
                        proof=await PortalMobileUpload.Capture(host,user,request.OperationUuid!,base64,signedUri,download,DateTimeOffset.UtcNow,cancellationToken);
                    }
                    // Only the typed proof leaves Studio. Even an unexpected
                    // top-level native field must not echo the file contents.
                    var publicAnswer=new JsonObject { ["data"]=new JsonObject { ["UploadProof"]=proof } };
                    response.Content.Dispose();
                    response.Content = new StringContent(publicAnswer.ToJsonString(), Encoding.UTF8, "application/json");
                }
                if (apiClientCreate) {
                    // No native headers or generic response fields cross this
                    // boundary, even when a server echoes a credential there.
                    if (status == 200) {
                        var safeBody = JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
                        result = new JsonObject { ["ok"] = true, ["source"] = "private-session-pipe", ["host"] = host,
                            ["user"] = user, ["status"] = status, ["body"] = safeBody };
                        state = "accepted";
                    } else {
                        state = status >= 500 ? "uncertain" : "rejected";
                        result = PortalCore.Fail(status >= 500 ? "UNCERTAIN" : "REMOTE_ERROR", "The API Client creation returned HTTP " + status + ".");
                        result["status"] = status;
                    }
                } else (result, state) = await PortalCore.Shape(response, host, user, true, places, reservation, masks, cancellationToken);
                if (apiClientCreate && status == 200 && (bool?)result["body"]?["data"]?["ApiClientProof"]?["vaultStored"] != true) {
                    result["ok"] = false; result["code"] = "UNCERTAIN"; state = "uncertain";
                }
                if (result["bodyOmitted"] != null || result["bodyError"] != null) {
                    result["ok"] = false; result["code"] = "UNCERTAIN"; state = "uncertain";
                }
            }
            result["sent"] = true; result["elapsedMs"] = (long)(DateTimeOffset.UtcNow - started).TotalMilliseconds;
            result["operationUuid"] = request.OperationUuid;
            PortalCore.MaskAnswer(result, masks);
            PortalCore.Settle(reservation, state, result);
            return result;
        } catch (Exception error) {
            var result = !sent && error is PortalCore.Refusal refusal
                ? PortalCore.Fail(refusal.Code, refusal.Message, refusal.Gate)
                : PortalCore.Fail(sent ? "UNCERTAIN" : "HEADLESS_AUTH_UNAVAILABLE", sent
                    ? "Private HTTP transport lost the write outcome. Reconcile by a read; never resend."
                    : "Private HTTP context or transport was unavailable before send.");
            result["sent"] = sent;
            PortalCore.MaskAnswer(result, masks);
            PortalCore.Settle(reservation, sent ? "uncertain" : "refused", result);
            return result;
        } finally { if (body != null) CryptographicOperations.ZeroMemory(body); }
    }
}
