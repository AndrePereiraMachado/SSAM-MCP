using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

// o11.users, the rules of agent/lib/users.mjs in the same order: the Users application of an O11 environment through this
// machine. The administrator's password and new passwords are entries of this Windows account's Credential Manager, typed only
// in a private window (users-vault.ps1, embedded here byte for byte); the session cookies live in this process's memory. No
// field of this kind carries a password or a cookie, in either direction. The HTTP requests go only to https://<host>/Users/ of
// a host whose administrator the person stored here (the helper checks the vault first), never redirected. Windows only:
// elsewhere the kind answers USERS_PLATFORM_UNAVAILABLE. The table of what passes is shared: tests/native/users.test.mjs.
internal sealed partial class UsersKinds
{
    internal const string Name = "o11.users";
    private const int HelperSeconds = 45, PromptWaitMs = 12000, MaxFields = 2000, MaxFieldChars = 8 * 1024 * 1024, MaxSubject = 256;
    private readonly string dataRoot;
    private readonly string scope;
    private readonly Dictionary<string, Dictionary<string, string>> jars = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Process> prompts = new(StringComparer.Ordinal);
    private readonly object sync = new();

    [GeneratedRegex("^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", RegexOptions.CultureInvariant)] private static partial Regex HostPattern();
    [GeneratedRegex("^[a-f0-9]{64}$", RegexOptions.CultureInvariant)] private static partial Regex EntryPattern();
    [GeneratedRegex("^[A-Za-z0-9_$]{1,256}$", RegexOptions.CultureInvariant)] private static partial Regex FieldPattern();
    [GeneratedRegex("^/Users/(?:(?:Login|User_List|Inactive_Users|User_Show|User_Edit|Group_List|Group_Show|Group_Edit|Application_List|Application_Show|Role_Show|MyInfo)\\.aspx)?$", RegexOptions.CultureInvariant)] private static partial Regex PagePattern();
    [GeneratedRegex("^(?:(?:UserId|GroupId|RoleId|ApplicationId)=[1-9][0-9]{0,18})?$", RegexOptions.CultureInvariant)] private static partial Regex QueryPattern();
    [GeneratedRegex("[\\\\\\s\\u0000-\\u001f]|%2e|%2f|%5c", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)] private static partial Regex BadUrlPattern();
    [GeneratedRegex("[\\u0000-\\u001f\\u007f]", RegexOptions.CultureInvariant)] private static partial Regex ControlPattern();
    [GeneratedRegex("^USERS_[A-Z_]{1,60}$", RegexOptions.CultureInvariant)] private static partial Regex CodePattern();

    internal UsersKinds(string dataRoot) { this.dataRoot = dataRoot; scope = Scope(dataRoot); }

    internal static string Scope(string dataRoot) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(dataRoot).ToLowerInvariant()))).ToLowerInvariant()[..16];

    private static AgentFault Invalid(string message) => new("PARAMS_INVALID", message);
    private static string? Word(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
    private static bool HostOk(string? host)
    {
        if (host == null || !HostPattern().IsMatch(host) || host.EndsWith(".localhost", StringComparison.Ordinal)) return false;
        var last = host[(host.LastIndexOf('.') + 1)..];
        return !last.StartsWith("0x", StringComparison.Ordinal) && !last.All(char.IsAsciiDigit);
    }

    // What may run, checked before anything is started.
    internal static void Validate(JsonNode? node)
    {
        if (node is not JsonObject p) throw Invalid("params must be an object");
        var op = Word(p["op"]);
        string[] keys = op switch
        {
            "status" or "forget" => ["op", "host", "kind", "entry"],
            "prompt" => ["op", "host", "kind", "entry", "subject"],
            "request" => ["op", "host", "url", "method", "fields", "secretRefs"],
            _ => throw Invalid("op must be status, prompt, request or forget"),
        };
        foreach (var (key, _) in p) if (!keys.Contains(key, StringComparer.Ordinal)) throw Invalid("unknown parameter " + key);
        var host = Word(p["host"]);
        if (!HostOk(host)) throw Invalid("host must be the DNS name of an environment");
        if (op != "request")
        {
            var kind = p["kind"] == null ? "login" : Word(p["kind"]);
            if (kind != "login" && kind != "password") throw Invalid("kind must be login or password");
            var entry = Word(p["entry"]);
            if (kind == "password" ? entry == null || !EntryPattern().IsMatch(entry) : p["entry"] != null) throw Invalid("entry belongs to kind password, 64 hex");
            if (op == "forget" && kind != "password") throw Invalid("only a new password is forgotten");
            if (p["subject"] != null && (Word(p["subject"]) is not { } subject || subject.Length > MaxSubject || ControlPattern().IsMatch(subject))) throw Invalid("subject must be one line of at most 256 characters");
            return;
        }
        var url = Word(p["url"]);
        var prefix = "https://" + host;
        if (url == null || url.Length > 2048 || !url.StartsWith(prefix + "/", StringComparison.Ordinal) || BadUrlPattern().IsMatch(url)) throw Invalid("url is not a Users page of the host");
        var rest = url[prefix.Length..];
        var mark = rest.IndexOf('?');
        var page = mark < 0 ? rest : rest[..mark];
        var query = mark < 0 ? "" : rest[(mark + 1)..];
        if (rest.Contains('#') || !PagePattern().IsMatch(page) || !QueryPattern().IsMatch(query)) throw Invalid("url is not a Users page of the host");
        var method = Word(p["method"]);
        if (method != "GET" && method != "POST") throw Invalid("method must be GET or POST");
        if (p["fields"] != null)
        {
            if (p["fields"] is not JsonArray fields || fields.Count > MaxFields) throw Invalid("fields must be [name, value] texts");
            long total = 0;
            foreach (var field in fields)
            {
                if (field is not JsonArray { Count: 2 } pair || Word(pair[0]) is not { } name || Word(pair[1]) is not { } value) throw Invalid("fields must be [name, value] texts");
                total += name.Length + value.Length;
            }
            if (total > MaxFieldChars) throw Invalid("fields are too large");
        }
        if (p["secretRefs"] == null) return;
        if (p["secretRefs"] is not JsonArray refs || refs.Count > 2) throw Invalid("at most 2 secretRefs");
        foreach (var item in refs)
        {
            if (item is not JsonObject reference || reference.Any(pair => pair.Key is not ("field" or "kind" or "entry" or "part"))) throw Invalid("secretRefs take field, kind, entry and part");
            var part = Word(reference["part"]);
            if (Word(reference["field"]) is not { } field || !FieldPattern().IsMatch(field) || (part != "username" && part != "password")) throw Invalid("invalid secret field");
            var kind = Word(reference["kind"]);
            if (kind == "login") { if (reference["entry"] != null || page != "/Users/Login.aspx" || method != "POST") throw Invalid("the login goes only to the login page"); }
            else if (kind != "password" || Word(reference["entry"]) is not { } entry || !EntryPattern().IsMatch(entry) || part != "password" || method != "POST") throw Invalid("invalid secret reference");
        }
    }

    internal static byte[] HelperBytes()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("users-vault.ps1") ?? throw new AgentFault("USERS_PRIVATE_REQUEST_FAILED", "The private Users helper is missing from this agent.");
        using var bytes = new MemoryStream();
        stream.CopyTo(bytes);
        return bytes.ToArray();
    }

    // The helper as a file of this installation's private folder, rewritten whenever it is not these exact bytes.
    private string Helper()
    {
        var bytes = HelperBytes();
        var directory = Path.Combine(dataRoot, "private", "users");
        Directory.CreateDirectory(directory);
        var file = Path.Combine(directory, "vault-" + Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()[..16] + ".ps1");
        if (!File.Exists(file) || !File.ReadAllBytes(file).AsSpan().SequenceEqual(bytes))
        {
            var temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllBytes(temporary, bytes);
            File.Move(temporary, file, true);
        }
        return file;
    }

    private static string PowerShell() => Path.Combine(Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

    private ProcessStartInfo Start(bool interactive, string mode, string host, JsonObject p, bool redirect)
    {
        var start = new ProcessStartInfo(PowerShell()) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = redirect, RedirectStandardOutput = redirect, RedirectStandardError = redirect };
        var args = new List<string> { "-NoLogo", "-NoProfile", interactive ? "-STA" : "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", Helper(), "-Mode", mode, "-HostName", host, "-Scope", scope };
        if (Word(p["kind"]) is { } kind) { args.Add("-Kind"); args.Add(kind); }
        if (Word(p["entry"]) is { } entry) { args.Add("-Entry"); args.Add(entry); }
        foreach (var arg in args) start.ArgumentList.Add(arg);
        return start;
    }

    private async Task<JsonObject> Call(string mode, string host, JsonObject p, string input, bool? executed, CancellationToken token)
    {
        JsonObject? value = null;
        try
        {
            using var process = Process.Start(Start(false, mode, host, p, true)) ?? throw new IOException("no helper");
            var output = process.StandardOutput.ReadToEndAsync(token);
            var errors = process.StandardError.ReadToEndAsync(token);
            await process.StandardInput.WriteAsync(input);
            process.StandardInput.Close();
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
            limit.CancelAfter(TimeSpan.FromSeconds(HelperSeconds));
            try { await process.WaitForExitAsync(limit.Token); }
            catch (OperationCanceledException) { try { process.Kill(true); } catch (InvalidOperationException) { } throw; }
            await errors;
            var line = (await output).Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).LastOrDefault();
            value = line == null ? null : JsonNode.Parse(line) as JsonObject;
        }
        catch (Exception e) when (e is IOException or System.ComponentModel.Win32Exception or OperationCanceledException or System.Text.Json.JsonException)
        {
            throw new AgentFault("USERS_PRIVATE_REQUEST_FAILED", "The private Users helper did not finish; no automatic retry.", executed);
        }
        if (value?["ok"] is JsonValue ok && ok.TryGetValue<bool>(out var done) && done) return value;
        var code = Word(value?["code"]) is { } said && CodePattern().IsMatch(said) ? said : "USERS_PRIVATE_REQUEST_FAILED";
        throw code == "USERS_HOST_NOT_AUTHENTICATED"
            ? new AgentFault(code, "No Users administrator is stored for this environment on this machine; nothing was sent.", false)
            : new AgentFault(code, "The private Users request failed; no automatic retry.", executed);
    }

    private string CookieHeader(string host)
    {
        lock (sync) return jars.TryGetValue(host, out var jar) ? string.Join("; ", jar.Select(pair => pair.Key + "=" + pair.Value)) : "";
    }

    private void StoreCookies(string host, JsonNode? encoded)
    {
        if (encoded is not JsonArray items) return;
        lock (sync)
            foreach (var item in items)
            {
                string first;
                try { first = Encoding.UTF8.GetString(Convert.FromBase64String(Word(item) ?? "")).Split(';')[0]; } catch (FormatException) { continue; }
                var mark = first.IndexOf('=');
                if (mark <= 0) continue;
                if (!jars.TryGetValue(host, out var jar)) jars[host] = jar = new(StringComparer.Ordinal);
                var name = first[..mark].Trim();
                var value = first[(mark + 1)..].Trim();
                if (value.Length > 0) jar[name] = value; else jar.Remove(name);
            }
    }

    private async Task<JsonObject> Prompt(string host, JsonObject p, CancellationToken token)
    {
        var key = host + "|" + (Word(p["kind"]) ?? "login") + "|" + (Word(p["entry"]) ?? "");
        lock (sync)
            if (prompts.TryGetValue(key, out var open) && !open.HasExited) return new JsonObject { ["opened"] = false, ["alreadyOpen"] = true };
        var directory = Path.Combine(dataRoot, "private", "users");
        Directory.CreateDirectory(directory);
        var status = Path.Combine(directory, "prompt-" + Guid.NewGuid().ToString("N") + ".status");
        var start = Start(true, "prompt", host, p, false);
        start.ArgumentList.Add("-Subject"); start.ArgumentList.Add(Word(p["subject"]) ?? "");
        start.ArgumentList.Add("-PromptStatusPath"); start.ArgumentList.Add(status);
        Process process;
        try { process = Process.Start(start) ?? throw new IOException("no helper"); }
        catch (Exception e) when (e is IOException or System.ComponentModel.Win32Exception) { throw new AgentFault("USERS_PROMPT_NOT_VISIBLE", "The private window could not be confirmed visible.", null); }
        lock (sync) prompts[key] = process;
        try
        {
            for (var waited = 0; waited < PromptWaitMs; waited += 100)
            {
                if (File.Exists(status))
                {
                    var phase = await File.ReadAllTextAsync(status, token);
                    if (phase is "visible" or "saved")
                    {
                        var answer = new JsonObject { ["opened"] = true, ["alreadyOpen"] = false, ["visible"] = true };
                        if (phase == "saved") answer["saved"] = true;
                        return answer;
                    }
                }
                if (process.HasExited) break;
                await Task.Delay(100, token);
            }
        }
        finally { try { File.Delete(status); } catch (IOException) { } }
        throw new AgentFault("USERS_PROMPT_NOT_VISIBLE", "The private window could not be confirmed visible.", null);
    }

    internal async Task<JsonNode?> Execute(JsonObject p, CancellationToken token)
    {
        if (!OperatingSystem.IsWindows()) throw new AgentFault("USERS_PLATFORM_UNAVAILABLE", "Users administration is not available on this platform.", false);
        Validate(p);
        var op = Word(p["op"])!;
        var host = Word(p["host"])!;
        switch (op)
        {
            case "status":
            {
                var value = await Call("status", host, p, "", false, token);
                return new JsonObject { ["available"] = value["available"]?.GetValue<bool>() == true, ["principal"] = Word(value["principal"]) };
            }
            case "forget":
                await Call("forget", host, p, "", false, token);
                return new JsonObject();
            case "prompt":
                if ((Word(p["kind"]) ?? "login") == "login") lock (sync) jars.Remove(host);
                return await Prompt(host, p, token);
        }
        var request = new JsonObject
        {
            ["url"] = Word(p["url"]), ["method"] = Word(p["method"]), ["fields"] = p["fields"]?.DeepClone() ?? new JsonArray(),
            ["secretRefs"] = p["secretRefs"]?.DeepClone() ?? new JsonArray(), ["cookie"] = CookieHeader(host),
        };
        var input = Convert.ToBase64String(Encoding.UTF8.GetBytes(request.ToJsonString()));
        var page = await Call("request", host, new JsonObject(), input, null, token);
        StoreCookies(host, page["setCookie"]);
        // The session stays here: the answer has no setCookie.
        return new JsonObject { ["status"] = page["status"]?.DeepClone(), ["location"] = Word(page["location"]) ?? "", ["contentType"] = Word(page["contentType"]) ?? "", ["body"] = Word(page["body"]) ?? "" };
    }
}
