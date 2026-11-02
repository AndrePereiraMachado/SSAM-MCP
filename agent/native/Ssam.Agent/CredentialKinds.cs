using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

// Authentication values are local process state. Only Project can return to the channel.
internal sealed class CredentialKinds
{
    internal const string Name = "credential.session";
    private const int MaxBody = 4 * 1024 * 1024;
    private readonly string root, scope;
    private readonly string? runtimeRoot;
    private readonly PrivateSessionRuntime runtime;
    private readonly SemaphoreSlim serial = new(1);
    private readonly Dictionary<string, Session> sessions = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Prompt> prompts = new(StringComparer.Ordinal);
    private readonly Dictionary<string, JsonObject> privateCredentials = new(StringComparer.Ordinal);
    private bool privateWindowPending;
    private long generation;
    internal Func<string, Task<string[]>> Lookup = async host => (await Dns.GetHostAddressesAsync(host)).Select(x => x.ToString()).ToArray();
    internal Func<JsonObject, Task<JsonObject>>? Helper;
    internal bool ForceWindows;
    private sealed class Session { internal JsonNode? State; internal readonly HashSet<string> Secrets = new(StringComparer.Ordinal); }
    private sealed record Prompt(Process Process, string Status, JsonObject Request, long Generation, Task<JsonObject> Completion);
    internal long PromptGeneration => generation;
    internal CredentialKinds(string root, string account, PrivateSessionRuntime runtime, string? runtimeRoot = null)
    {
        this.root = root; this.runtimeRoot = runtimeRoot; scope = UsersKinds.Scope(root, account); this.runtime = runtime;
        runtime.Register(() => { Settle(); return privateWindowPending || prompts.Count > 0; });
    }
    private static string? Text(JsonNode? value) => value is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
    private static bool Flag(JsonNode? value) => value is JsonValue v && v.TryGetValue<bool>(out var flag) && flag;
    private static AgentFault Invalid() => new("PARAMS_INVALID", "The private credential request is invalid.", false);
    private static AgentFault Failed(string code = "CREDENTIAL_REQUEST_FAILED", bool? sent = false) => new(code, "The private credential operation did not complete. No automatic retry was made.", sent);
    private static bool Matches(string? text, string pattern) => text != null && Regex.IsMatch(text, pattern, RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
    private static bool Plain(string? s, int max) => s != null && s.Length <= max && !s.Any(c => c < 32 || c == 127);
    private static bool Profile(string? s) => Matches(s, @"\A(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\z");
    private static bool SecretKey(string s) => Matches(s.ToLowerInvariant(), @"\A(?:password|passwd|client_secret|access_token|refresh_token|id_token|authorization|cookie|set-cookie|csrf|csrftoken|x-csrftoken)\z");
    private static bool ContainsSecretKey(JsonNode? node) => node switch {
        JsonObject o => o.Any(p => SecretKey(p.Key) || ContainsSecretKey(p.Value)),
        JsonArray a => a.Any(ContainsSecretKey), _ => false };
    private static byte[] Base64(string? s)
    {
        if (s == null || s.Length > (MaxBody + 2) / 3 * 4) throw Invalid();
        try { var b = Convert.FromBase64String(s); if (Convert.ToBase64String(b) != s) throw Invalid(); return b; }
        catch (FormatException) { throw Invalid(); }
    }
    internal static void Validate(JsonObject p)
    {
        var op = Text(p["op"]);
        if (op is not ("status" or "prompt" or "login" or "request" or "forget" or "sign-out")) throw Invalid();
        string[] keys = ["op", "host", "service", "auth", "profile"];
        if (op == "prompt") keys = [.. keys, "mode"];
        if (op == "request") keys = [.. keys, "url", "method", "body", "contentType", "accept", "write", "operationId", "authorizeSha256", "secretRefs"];
        if (p.Any(pair => !keys.Contains(pair.Key))) throw Invalid();
        try { UsersKinds.Validate(new JsonObject { ["op"] = "status", ["host"] = p["host"]?.DeepClone() }); }
        catch (AgentFault e) when (e.Code == "USERS_HOST_INTERNAL") { throw Failed("CREDENTIAL_HOST_INTERNAL"); }
        catch (AgentFault) { throw Invalid(); }
        var service = Text(p["service"]); var auth = Text(p["auth"]);
        if (service is not ("service-center" or "odc-portal") || !(service == "service-center" ? new[] { "credential", "basic", "service-token" } : new[] { "credential", "api-client" }).Contains(auth)) throw Invalid();
        if (p.ContainsKey("profile") && !Profile(Text(p["profile"]))) throw Invalid();
        if (p.ContainsKey("mode") && Text(p["mode"]) is not ("credential" or "select-profile")) throw Invalid();
        if (op != "request") return;
        var method = Text(p["method"]); var raw = Text(p["url"]);
        if (method is not ("GET" or "POST" or "PUT" or "PATCH" or "DELETE") || !Plain(raw, 8192)
            || Regex.IsMatch(raw!, @"[\\\s]|%2e|%2f|%5c", RegexOptions.IgnoreCase)
            || !Uri.TryCreate(raw, UriKind.Absolute, out var url) || url.Scheme != "https" || url.Port != 443
            || url.Host != Text(p["host"]) || url.UserInfo.Length != 0 || url.Fragment.Length != 0 || url.AbsoluteUri != raw) throw Invalid();
        if (service == "service-center") {
            if (auth == "credential") { if (!Regex.IsMatch(url.AbsolutePath, @"^/ServiceCenter(?:/|$)", RegexOptions.IgnoreCase)) throw Invalid(); }
            else {
                if (method != "GET" || url.AbsolutePath != "/PerformanceProbe/rest/PerformanceMonitoringAPI/RequestEvents/" || !string.IsNullOrEmpty(Text(p["body"])) || Flag(p["write"])) throw Invalid();
                var pairs = url.Query.TrimStart('?').Split('&').Select(x => x.Split('=', 2)).ToArray();
                if (pairs.Length != 4 || pairs.Any(x => x.Length != 2)) throw Invalid();
                var values = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var pair in pairs) if (!values.TryAdd(Uri.UnescapeDataString(pair[0]), Uri.UnescapeDataString(pair[1]))) throw Invalid();
                if (!values.TryGetValue("EventNames", out var events) || events != "TimerExecuted"
                    || !values.TryGetValue("StartInstant", out var since) || !Matches(since, @"\A\d{4}-\d{2}-\d{2}T.*Z\z") || !DateTimeOffset.TryParse(since, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out var start)
                    || !values.TryGetValue("EndInstant", out var until) || !Matches(until, @"\A\d{4}-\d{2}-\d{2}T.*Z\z") || !DateTimeOffset.TryParse(until, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out var end)
                    || end <= start || end - start > TimeSpan.FromHours(1)
                    || !values.TryGetValue("NumberOfResults", out var limit) || !Matches(limit, @"\A(?:[1-9][0-9]?|100)\z")) throw Invalid();
            }
        }
        if (service == "odc-portal") {
            var moduleMatch = Regex.Match(url.AbsolutePath, @"\A/([a-zA-Z][a-zA-Z0-9_-]*)/");
            var module = moduleMatch.Success ? moduleMatch.Groups[1].Value : "";
            var privateRoute = Regex.IsMatch(url.AbsolutePath, @"\A/(?:api/|[a-zA-Z][a-zA-Z0-9_-]*/(?:screenservices|moduleservices)/)");
            var metadata = method == "GET" && module.Length > 0 && !new[] { "authentication", "identity", "api" }.Contains(module.ToLowerInvariant())
                && (url.AbsolutePath == "/" + module + "/" || Regex.IsMatch(url.AbsolutePath, @"\A/" + Regex.Escape(module) + @"/scripts/[^\\]+\.js\z"));
            if (!privateRoute && !metadata) throw Invalid();
        }
        foreach (var pair in url.Query.TrimStart('?').Split('&')) if (SecretKey(Uri.UnescapeDataString(pair.Split('=')[0]))) throw Invalid();
        if (p.ContainsKey("contentType") && Text(p["contentType"]) is not ("application/json" or "application/x-www-form-urlencoded")) throw Invalid();
        if (p.ContainsKey("accept") && !Plain(Text(p["accept"]), 200)) throw Invalid();
        if (p.ContainsKey("write") && !(p["write"] is JsonValue boolean && boolean.TryGetValue<bool>(out _))) throw Invalid();
        if (p.ContainsKey("operationId") && !Matches(Text(p["operationId"]), @"\A[a-zA-Z0-9_.:-]{1,160}\z")) throw Invalid();
        if (p.ContainsKey("authorizeSha256") && !Matches(Text(p["authorizeSha256"]), @"\A[a-f0-9]{64}\z")) throw Invalid();
        if ((method is "PUT" or "PATCH" or "DELETE") && !Flag(p["write"])) throw Invalid();
        if (Flag(p["write"]) && (p["operationId"] == null || p["authorizeSha256"] == null)) throw Invalid();
        if (p.ContainsKey("secretRefs") && p["secretRefs"] is not JsonArray { Count: 0 }) throw Failed("CREDENTIAL_SECRET_REFS_UNAVAILABLE");
        if (p.ContainsKey("body")) {
            var body = Base64(Text(p["body"]));
            if (body.Length > 0) {
                if (method == "GET" || p["contentType"] == null) throw Invalid();
                string text;
                try { text = new UTF8Encoding(false, true).GetString(body); } catch (DecoderFallbackException) { throw Invalid(); }
                if (Text(p["contentType"]) == "application/json") {
                    try { if (ContainsSecretKey(JsonNode.Parse(text))) throw Invalid(); } catch (System.Text.Json.JsonException) { throw Invalid(); }
                } else foreach (var field in text.Split('&')) if (SecretKey(Uri.UnescapeDataString(field.Split('=')[0]))) throw Invalid();
            }
        }
    }
    private static string Key(JsonObject p) => string.Join('|', Text(p["service"]), Text(p["auth"]), Text(p["host"]), Text(p["profile"]) ?? "default");
    private static string Group(JsonObject p) => string.Join('|', Text(p["service"]), Text(p["auth"]) == "basic" ? "credential" : Text(p["auth"]), Text(p["host"]));
    internal void ApplyPromptCompletion(JsonObject request, string output, long expectedGeneration)
        => ApplyPromptCompletion(request, PrivatePromptCompletion.Parse(output), expectedGeneration);
    private void ApplyPromptCompletion(JsonObject request, JsonObject completion, long expectedGeneration)
    {
        if (generation != expectedGeneration || !Flag(completion["saved"])) return;
        if (!Profile(Text(completion["profile"]))) throw Failed();
        if (request["profile"] != null && Text(request["profile"]) != Text(completion["profile"])) throw Failed();
        generation++; sessions.Clear();
        if (Flag(completion["remembered"])) privateCredentials.Remove(Group(request));
        else privateCredentials[Group(request)] = (JsonObject)completion.DeepClone();
        ResetFailures(Key(request));
    }
    private string FailureFile => Path.Combine(root, "private", "credential", "sign-in-failures.json");
    private string FailureKey(string key) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(scope + "|" + key))).ToLowerInvariant();
    private JsonObject ReadFailures()
    {
        try {
            if (JsonNode.Parse(File.ReadAllText(FailureFile)) is not JsonObject failures
                || failures.Any(pair => pair.Value is not JsonValue value || !value.TryGetValue<int>(out var count) || count < 0))
                throw Failed("CREDENTIAL_LOGIN_PAUSED");
            return failures;
        }
        catch (FileNotFoundException) { return new(); }
        catch (DirectoryNotFoundException) { return new(); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Text.Json.JsonException) { throw Failed("CREDENTIAL_LOGIN_PAUSED"); }
    }
    private void LoginAttempt(string key)
    {
        var failures = ReadFailures(); var id = FailureKey(key);
        var count = failures[id]?.GetValue<int>() ?? 0;
        if (count >= 2) throw Failed("CREDENTIAL_LOGIN_PAUSED");
        failures[id] = count + 1; WriteFailures(failures);
    }
    private void ResetFailures(string key)
    {
        var failures = ReadFailures(); failures.Remove(FailureKey(key)); WriteFailures(failures);
    }
    private void WriteFailures(JsonObject failures)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FailureFile)!);
        var temporary = FailureFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(temporary, failures.ToJsonString()); File.Move(temporary, FailureFile, true);
    }
    private void Settle()
    {
        lock (runtime.Sync) foreach (var (key, prompt) in prompts.ToArray()) {
            if (!prompt.Completion.IsCompleted) continue;
            string phase = ""; try { phase = File.ReadAllText(prompt.Status); } catch (IOException) { }
            if (!prompt.Completion.IsCompletedSuccessfully) runtime.Refusals.Add(DateTimeOffset.UtcNow);
            else {
                try { ApplyPromptCompletion(prompt.Request, prompt.Completion.Result, prompt.Generation); }
                catch { runtime.Refusals.Add(DateTimeOffset.UtcNow); }
            }
            prompts.Remove(key); prompt.Process.Dispose();
            try { File.Delete(prompt.Status); } catch (IOException) { }
        }
    }
    private ProcessStartInfo Start(JsonObject p, string? status = null)
    {
        if (OperatingSystem.IsMacOS()) return MacPrivateBackend.StartInfo();
        var directory = Path.Combine(root, "private", "credential");
        foreach (var file in new[] { "private-dialog.ps1", "private-vault.ps1", "credential-auth.ps1" }) PrivateHelperResources.Write(directory, file);
        var helper = PrivateHelperResources.Write(directory, "credential-vault.ps1");
        var interactive = Text(p["op"]) is "prompt" or "forget";
        var start = new ProcessStartInfo(Path.Combine(Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in new[] { "-NoLogo", "-NoProfile", interactive ? "-STA" : "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-Mode", Text(p["op"])!, "-Scope", scope, "-HostName", Text(p["host"])! }) start.ArgumentList.Add(arg);
        if (status != null) { start.ArgumentList.Add("-PromptStatusPath"); start.ArgumentList.Add(status); }
        return start;
    }
    private static async Task<string> ReadBounded(StreamReader reader, CancellationToken token)
    {
        var text = new StringBuilder(); var buffer = new char[8192]; int n;
        while ((n = await reader.ReadAsync(buffer.AsMemory(), token)) > 0) { if (text.Length + n > 16 * 1024 * 1024) throw Failed(); text.Append(buffer, 0, n); }
        return text.ToString();
    }
    private async Task<JsonObject> Call(JsonObject p, Session session, CancellationToken token)
    {
        var input = (JsonObject)p.DeepClone(); input["privateSession"] = session.State?.DeepClone();
        if (privateCredentials.TryGetValue(Group(p), out var selected) && (p["profile"] == null || Text(p["profile"]) == Text(selected["profile"]))) {
            input["profile"] = selected["profile"]?.DeepClone();
            input["privateCredential"] = selected["privateCredential"]?.DeepClone();
            Secrets(session, selected["privateCredential"]?["password"]);
        }
        if (Helper != null) return await Helper(input);
        if (OperatingSystem.IsMacOS()) return await MacPrivateBackend.ExecuteAsync(MacPrivateBackend.Envelope("credential", Text(p["op"])!, scope, Text(p["host"])!, input, root, runtimeRoot), token);
        using var process = Process.Start(Start(p)) ?? throw Failed();
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token); limit.CancelAfter(TimeSpan.FromSeconds(Text(p["op"]) == "forget" ? 130 : 90));
        try {
            var output = ReadBounded(process.StandardOutput, limit.Token); var errors = ReadBounded(process.StandardError, limit.Token);
            await process.StandardInput.WriteAsync(input.ToJsonString()); process.StandardInput.Close();
            await process.WaitForExitAsync(limit.Token); await errors;
            return JsonNode.Parse(await output) as JsonObject ?? throw Failed();
        } catch { try { if (!process.HasExited) process.Kill(true); } catch (InvalidOperationException) { } throw Failed(sent: Text(p["op"]) == "request" && Text(p["method"]) != "GET" ? null : false); }
    }
    private async Task<JsonObject> Open(JsonObject p, CancellationToken token)
    {
        var key = Key(p); lock (runtime.Sync) if (prompts.ContainsKey(key)) return new() { ["opened"] = false, ["alreadyOpen"] = true };
        lock (runtime.Sync) { runtime.TakeWindow(DateTimeOffset.UtcNow, "CREDENTIAL"); privateWindowPending = true; }
        var directory = Path.Combine(root, "private", "credential"); Directory.CreateDirectory(directory);
        var status = Path.Combine(directory, "prompt-" + Guid.NewGuid().ToString("N") + ".status");
        Process process;
        try { process = Process.Start(Start(p, status)) ?? throw Failed("CREDENTIAL_PROMPT_NOT_VISIBLE"); }
        catch { lock (runtime.Sync) privateWindowPending = false; throw; }
        var completion = PrivatePromptCompletion.Capture(process);
        await process.StandardInput.WriteAsync((OperatingSystem.IsMacOS() ? MacPrivateBackend.Envelope("credential", "prompt", scope, Text(p["host"])!, p, root, runtimeRoot, new JsonObject { ["promptStatusPath"] = status }) : p).ToJsonString()); process.StandardInput.Close();
        lock (runtime.Sync) { prompts[key] = new(process, status, (JsonObject)p.DeepClone(), generation, completion); privateWindowPending = false; }
        for (var i = 0; i < 120; i++) {
            string phase = ""; try { phase = File.ReadAllText(status); } catch (IOException) { }
            if (phase is "visible" or "saved") {
                var answer = new JsonObject { ["opened"] = true, ["alreadyOpen"] = false, ["visible"] = true };
                if (completion.IsCompletedSuccessfully && Flag(completion.Result["saved"])) { answer["saved"] = true; answer["remembered"] = Flag(completion.Result["remembered"]); }
                return answer;
            }
            if (process.HasExited) break; await Task.Delay(100, token);
        }
        throw Failed("CREDENTIAL_PROMPT_NOT_VISIBLE");
    }
    private static void Secrets(Session session, JsonNode? node)
    {
        if (Text(node) is { Length: > 0 } s) { if (s.Length > 65536 || !session.Secrets.Contains(s) && (session.Secrets.Count >= 4096 || session.Secrets.Sum(x => x.Length) + s.Length > MaxBody)) throw Failed("CREDENTIAL_SECRET_LIMIT"); session.Secrets.Add(s); }
        else if (node is JsonArray a) foreach (var item in a) Secrets(session, item);
    }
    private static string Clean(Session session, string value) => RedactText(session.Secrets, value);
    internal static string RedactText(IEnumerable<string> secrets, string value)
    {
        foreach (var secret in secrets.Where(x => x.Length > 0).Distinct().OrderByDescending(x => x.Length)) {
            var variants = new[] { secret, WebUtility.HtmlEncode(secret), WebUtility.HtmlEncode(secret).Replace("&#39;", "&apos;"), Uri.EscapeDataString(secret), WebUtility.UrlEncode(secret), Convert.ToBase64String(Encoding.UTF8.GetBytes(secret)), Convert.ToBase64String(Encoding.Unicode.GetBytes(secret)), secret.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("'", "\\'"), secret.Replace("<", "\\u003c").Replace(">", "\\u003e").Replace("&", "\\u0026") };
            foreach (var variant in variants.Distinct()) value = value.Replace(variant, "[redacted]", StringComparison.OrdinalIgnoreCase);
        }
        return value;
    }
    internal static string? ResponseType(string value)
    {
        var parts = value.Split(';');
        var types = new[] { "text/html", "text/plain", "text/xml", "text/javascript", "application/json", "application/xml", "application/javascript", "application/x-www-form-urlencoded", "application/octet-stream", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/zip", "application/pdf", "image/png", "image/jpeg" };
        if (parts.Length > 2 || !types.Contains(parts[0].Trim(), StringComparer.OrdinalIgnoreCase)) return null;
        if (parts.Length == 1) return parts[0].Trim().ToLowerInvariant();
        var parameter = parts[1].Split('=', 2);
        if (parameter.Length != 2 || !parameter[0].Trim().Equals("charset", StringComparison.OrdinalIgnoreCase)) return null;
        var charset = parameter[1].Trim();
        if (charset.Length >= 2 && (charset[0] == '\"' && charset[^1] == '\"' || charset[0] == '\'' && charset[^1] == '\'')) charset = charset[1..^1];
        return new[] { "utf-8", "utf8", "us-ascii", "ascii", "windows-1252", "iso-8859-1", "utf-16", "utf-16le", "utf-16be" }.Contains(charset, StringComparer.OrdinalIgnoreCase) ? parts[0].Trim().ToLowerInvariant() + "; charset=" + charset.ToLowerInvariant() : null;
    }
    private static string ResponseLocation(string value, string requestUrl, Session session)
    {
        if (value.Length == 0) return "";
        if (!Uri.TryCreate(requestUrl, UriKind.Absolute, out var request) || !Uri.TryCreate(request, value, out var target) || target.Scheme != request.Scheme || target.Host != request.Host || target.Port != request.Port || target.UserInfo.Length > 0) return "";
        try {
            var clean = new UriBuilder(target) {
                Path = Clean(session, target.AbsolutePath).Replace("[redacted]", "%5Bredacted%5D"),
                Query = Clean(session, target.Query.TrimStart('?')).Replace("[redacted]", "%5Bredacted%5D"),
                Fragment = Clean(session, target.Fragment.TrimStart('#')).Replace("[redacted]", "%5Bredacted%5D")
            };
            return clean.Uri.AbsoluteUri;
        } catch (UriFormatException) { return ""; }
    }
    private JsonObject Project(JsonObject p, JsonObject value, Session session)
    {
        string CleanText(string field, int max) => Plain(Text(value[field]), max) ? Clean(session, Text(value[field])!) : "";
        var op = Text(p["op"]);
        if (op == "login") return new() { ["authenticated"] = Flag(value["authenticated"]) };
        if (op is "forget" or "sign-out") { generation++; sessions.Clear(); privateCredentials.Remove(Group(p)); session.Secrets.Clear(); return new() { [op == "forget" ? "forgotten" : "signedOut"] = true }; }
        if (op == "status") {
            var profiles = new JsonArray();
            if (value["profiles"] is JsonArray items) foreach (var item in items.Take(100)) if (Profile(Text(item?["profile"])) && Plain(Text(item?["principal"]), 320)) profiles.Add((JsonNode)new JsonObject { ["profile"] = Text(item!["profile"]), ["principal"] = Clean(session, Text(item["principal"])!) });
            if (Flag(value["available"]) && Profile(Text(value["profile"])) && Plain(Text(value["principal"]), 320)) {
                var active = Text(value["profile"]);
                for (var i = profiles.Count - 1; i >= 0; i--) if (Text(profiles[i]?["profile"]) == active) profiles.RemoveAt(i);
                profiles.Insert(0, new JsonObject { ["profile"] = active, ["principal"] = CleanText("principal", 320) });
            }
            var temporary = privateCredentials.TryGetValue(Group(p), out var selected) && (p["profile"] == null || Text(p["profile"]) == Text(selected["profile"]));
            return new() { ["available"] = Flag(value["available"]), ["authenticated"] = Flag(value["authenticated"]), ["principal"] = CleanText("principal", 320), ["profile"] = Profile(Text(value["profile"])) ? Text(value["profile"]) : null, ["profiles"] = profiles, ["remembered"] = Flag(value["available"]) && !temporary };
        }
        if (!(value["status"] is JsonValue status && status.TryGetValue<int>(out var code) && code is >= 100 and <= 599) || !Plain(Text(value["contentType"]), 200)) throw Failed();
        var bytes = Base64(Text(value["body"]));
        var type = ResponseType(Text(value["contentType"])!);
        if (type == null) throw new AgentFault("CREDENTIAL_RESPONSE_METADATA_INVALID", "The private response contained unsupported metadata. No response content was released.", false);
        var textual = Regex.IsMatch(type, "json|text|xml|javascript|x-www-form-urlencoded", RegexOptions.IgnoreCase);
        Encoding encoding = Encoding.UTF8;
        if (textual) {
            var charset = Regex.Match(type, "charset\\s*=\\s*[\"']?([^;\\s\"']+)", RegexOptions.IgnoreCase);
            if (charset.Success) {
                try { Encoding.RegisterProvider(CodePagesEncodingProvider.Instance); encoding = Encoding.GetEncoding(charset.Groups[1].Value, EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback); }
                catch (ArgumentException) { throw Failed(); }
            }
        }
        string original;
        try { original = encoding.GetString(bytes); } catch (DecoderFallbackException) { throw Failed(); }
        var clean = Clean(session, original);
        if (!textual && (original != clean || Encoding.Unicode.GetString(bytes) != Clean(session, Encoding.Unicode.GetString(bytes)))) throw Failed();
        if (type.Contains("json", StringComparison.OrdinalIgnoreCase) && clean.Trim().Length > 0) {
            try { using var originalDocument = System.Text.Json.JsonDocument.Parse(original); }
            catch (System.Text.Json.JsonException) { throw new AgentFault("CREDENTIAL_RESPONSE_INVALID", "The private response was not valid JSON after private processing. No response content was released.", false); }
            try { using var document = System.Text.Json.JsonDocument.Parse(clean); }
            catch (System.Text.Json.JsonException) { throw new AgentFault("CREDENTIAL_RESPONSE_STRUCTURE_REDACTED", "Sensitive authentication values were removed, but the response structure could not be preserved. No response content was released.", false); }
        }
        var normalizedEncoding = textual && clean != original && encoding.CodePage != Encoding.UTF8.CodePage;
        if (normalizedEncoding) type = Regex.Replace(type, ";?\\s*charset\\s*=\\s*[\"']?[^;\\s\"']+[\"']?", "", RegexOptions.IgnoreCase) + "; charset=utf-8";
        var projected = new JsonObject { ["status"] = code, ["body"] = textual && clean != original ? Convert.ToBase64String(Encoding.UTF8.GetBytes(clean)) : Text(value["body"]), ["contentType"] = type, ["url"] = Text(p["url"]), ["location"] = ResponseLocation(Plain(Text(value["location"]), 8192) ? Text(value["location"])! : "", Text(p["url"])!, session) };
        if (Flag(value["redacted"]) || clean != original)
            projected["notes"] = new JsonArray("Sensitive authentication values were removed from the response.");
        if (type != Text(value["contentType"])) {
            if (projected["notes"] is not JsonArray) projected["notes"] = new JsonArray();
            ((JsonArray)projected["notes"]!).Add((JsonNode?)JsonValue.Create("Response content type was normalized to a recognized media type and charset."));
        }
        if (Text(projected["location"]) != (Text(value["location"]) ?? "")) {
            if (projected["notes"] is not JsonArray) projected["notes"] = new JsonArray();
            ((JsonArray)projected["notes"]!).Add((JsonNode?)JsonValue.Create("Response redirect metadata was normalized or withheld to preserve the approved origin."));
        }
        if (normalizedEncoding) ((JsonArray)projected["notes"]!).Add((JsonNode?)JsonValue.Create("Response text encoding was normalized to UTF-8."));
        return projected;
    }
    internal async Task<JsonObject> Execute(JsonObject p, CancellationToken token)
    {
        if (!OperatingSystem.IsWindows() && !OperatingSystem.IsMacOS() && !ForceWindows) throw Failed("CREDENTIAL_PLATFORM_UNAVAILABLE");
        Validate(p); await serial.WaitAsync(token);
        var writeResponseReceived = false;
        try {
            Settle();
            if (Text(p["op"]) is "prompt" or "login" or "request") {
                string[] addresses; try { addresses = await Lookup(Text(p["host"])!); } catch { throw Failed("CREDENTIAL_HOST_UNRESOLVED"); }
                if (addresses.Length == 0 || addresses.Any(UsersKinds.IsPrivateAddress)) throw Failed("CREDENTIAL_HOST_PRIVATE");
            }
            if (Text(p["op"]) == "prompt") return await Open(p, token);
            var key = Key(p); if (!sessions.TryGetValue(key, out var session)) { if (sessions.Count >= 128) throw Failed("CREDENTIAL_SESSION_LIMIT"); sessions[key] = session = new(); }
            // Revoke pending completions before awaiting sign-out. Its helper still
            // receives the current private credential, but a late popup cannot replace it.
            if (Text(p["op"]) == "sign-out") generation++;
            var expectedGeneration = generation;
            if (Text(p["op"]) == "login") LoginAttempt(key);
            JsonObject value;
            if (Text(p["op"]) == "forget") {
                lock (runtime.Sync) { runtime.TakeWindow(DateTimeOffset.UtcNow, "CREDENTIAL"); privateWindowPending = true; }
                try { value = await Call(p, session, token); }
                finally { lock (runtime.Sync) privateWindowPending = false; }
            } else value = await Call(p, session, token);
            writeResponseReceived = Text(p["op"]) == "request" && Text(p["method"]) != "GET";
            Settle();
            if (generation != expectedGeneration) throw Failed("CREDENTIAL_SESSION_CHANGED");
            if (!Flag(value["ok"])) {
                if (Text(value["code"]) == "CREDENTIAL_SESSION_EXPIRED") session.State = null;
                throw Failed(Matches(Text(value["code"]), @"\ACREDENTIAL_[A-Z_]{1,60}\z") ? Text(value["code"])! : "CREDENTIAL_REQUEST_FAILED", Text(p["op"]) == "request" && Text(p["method"]) != "GET" ? null : false);
            }
            if (Text(p["op"]) is "forget" or "sign-out" || Text(p["op"]) == "login" && Flag(value["authenticated"])) ResetFailures(key);
            if (value.ContainsKey("privateSession")) session.State = value["privateSession"]?.DeepClone();
            Secrets(session, value["secretValues"]);
            foreach (var field in new[] { "secretValues", "password", "token", "accessToken", "refreshToken" }) Secrets(session, value["privateSession"]?[field]);
            if (value["privateSession"]?["cookies"] is JsonArray cookies) foreach (var cookie in cookies) Secrets(session, cookie?["value"]);
            var result = Project(p, value, session);
            if (Text(p["op"]) == "request" && value["status"] is JsonValue httpStatus && httpStatus.TryGetValue<int>(out var statusCode) && statusCode == 401) session.State = null;
            return result;
        } catch (AgentFault error) when (writeResponseReceived) {
            throw Failed(error.Code, null);
        } finally { serial.Release(); }
    }
}
