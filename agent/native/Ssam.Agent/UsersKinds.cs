using System.Diagnostics;
using System.Net;
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
    private readonly Dictionary<string, OpenPrompt> prompts = new(StringComparer.Ordinal);
    private readonly object sync = new();

    [GeneratedRegex("^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\\z", RegexOptions.CultureInvariant)] private static partial Regex HostPattern();
    [GeneratedRegex("^[a-f0-9]{64}\\z", RegexOptions.CultureInvariant)] private static partial Regex EntryPattern();
    [GeneratedRegex("^(?:[A-Za-z0-9_$]{1,200}[$_])?wt(?:Password|ConfirmPassword|NewPassword)Input\\z", RegexOptions.CultureInvariant)] private static partial Regex FieldPattern();
    [GeneratedRegex("^/Users/(?:(?:Login|User_List|Inactive_Users|User_Show|User_Edit|Group_List|Group_Show|Group_Edit|Application_List|Application_Show|Role_Show|MyInfo)\\.aspx)?\\z", RegexOptions.CultureInvariant)] private static partial Regex PagePattern();
    [GeneratedRegex("^(?:(?:UserId|GroupId|RoleId|ApplicationId)=[1-9][0-9]{0,18})?\\z", RegexOptions.CultureInvariant)] private static partial Regex QueryPattern();
    [GeneratedRegex("[\\\\\\s\\u0000-\\u001f]|%2e|%2f|%5c", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)] private static partial Regex BadUrlPattern();
    [GeneratedRegex("[\\u0000-\\u001f\\u007f]", RegexOptions.CultureInvariant)] private static partial Regex ControlPattern();
    [GeneratedRegex("^USERS_[A-Z_]{1,60}\\z", RegexOptions.CultureInvariant)] private static partial Regex CodePattern();

    [GeneratedRegex("^[1-9][0-9]{0,18}\\z", RegexOptions.CultureInvariant)] private static partial Regex IdPattern();
    [GeneratedRegex("[\\u0000-\\u001f\\u007f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]", RegexOptions.CultureInvariant)] private static partial Regex HiddenPattern();
    private static bool Shown(JsonNode? value, int max) => Word(value) is { } text && text.Length <= max && !HiddenPattern().IsMatch(text);
    // What a person can approve: only these. Deleting and taking access away are not on the list, whatever a server asks.
    private sealed record Action(string Text, string? Page, string? Target);
    private static readonly Dictionary<string, Action> Actions = new(StringComparer.Ordinal)
    {
        ["sign-in"] = new("Sign in to the Users application of this environment", null, null),
        ["update"] = new("Change the details of this user", "User_Edit", null),
        ["activate"] = new("Activate this user", "User_Show", null),
        ["deactivate"] = new("Deactivate this user: the user loses access", "User_Show", null),
        ["grant-role"] = new("Give this role to this user", "User_Show", "Role id"),
        ["add-group"] = new("Add this user to this group: the user gets its roles", "User_Show", "Group id"),
    };
    private sealed class Permit { public required string Host; public required string Page; public int Posts; public DateTimeOffset Until; public string? Entry; }
    private sealed class OpenPrompt { public required Process Child; public required string StatusFile; public required string Host; public required string Kind; public string? Entry; public string? Action; public string? UserId; public bool Applied; }
    private readonly Dictionary<string, DateTimeOffset> consents = new(StringComparer.Ordinal);
    private readonly List<Permit> permits = [];
    private bool HasConsent(string host) { lock (sync) return consents.TryGetValue(host, out var until) && until > DateTimeOffset.UtcNow; }

    internal UsersKinds(string dataRoot, string account = "") { this.dataRoot = dataRoot; scope = Scope(dataRoot, account); }

    // The vault scope: this installation and this account of the server. Its entries are its own: another token on this installation
    // inherits nothing, and an SSAM installed on the same Windows account is apart.
    private static string Short(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant()[..16];
    internal static string Scope(string dataRoot, string account = "") => Short(Path.GetFullPath(dataRoot).ToLowerInvariant()) + Short("account|" + account);

    private static AgentFault Invalid(string message) => new("PARAMS_INVALID", message);
    private static string? Word(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
    // A DNS name of an environment: never an address by number, this machine, a name only an internal network resolves, a service
    // that resolves to any address it is given, or a name written in another alphabet.
    private static readonly string[] Internal = [".localhost", ".local", ".localdomain", ".internal", ".intranet", ".lan", ".home", ".corp", ".svc", ".arpa", ".nip.io", ".sslip.io", ".xip.io"];
    private static bool HostOk(string? host)
    {
        if (host == null || !HostPattern().IsMatch(host) || Internal.Any(end => host.EndsWith(end, StringComparison.Ordinal)) || host.Split('.').Any(label => label.StartsWith("xn--", StringComparison.Ordinal))) return false;
        var last = host[(host.LastIndexOf('.') + 1)..];
        return last.Length >= 2 && !last.StartsWith("0x", StringComparison.Ordinal) && !last.All(char.IsAsciiDigit);
    }

    // A resolved address that is not on the internet: this machine, a private network, link-local (cloud metadata), multicast.
    internal static bool IsPrivateAddress(string text)
    {
        if (!IPAddress.TryParse(text, out var address)) return true;
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        var b = address.GetAddressBytes();
        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
            return b[0] == 0 || b[0] == 10 || b[0] == 127 || b[0] >= 224 || (b[0] == 100 && b[1] >= 64 && b[1] <= 127) || (b[0] == 169 && b[1] == 254) || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168) || (b[0] == 192 && b[1] == 0 && b[2] == 0) || (b[0] == 198 && (b[1] == 18 || b[1] == 19));
        return address.Equals(IPAddress.IPv6Any) || address.Equals(IPAddress.IPv6Loopback) || (b[0] & 0xfe) == 0xfc || (b[0] == 0xfe && (b[1] & 0xc0) == 0x80) || b[0] == 0xff;
    }

    private static int Distance(string a, string b)
    {
        var row = Enumerable.Range(0, b.Length + 1).ToArray();
        for (var i = 1; i <= a.Length; i++)
        {
            var next = new int[b.Length + 1];
            next[0] = i;
            for (var j = 1; j <= b.Length; j++) next[j] = Math.Min(Math.Min(next[j - 1] + 1, row[j] + 1), row[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
            row = next;
        }
        return row[b.Length];
    }

    // A new host that reads like one already approved: inside it, around it, the same first label elsewhere, or one letter away.
    internal static string? LookalikeOf(string host, IEnumerable<string> approved)
    {
        var dot = host.IndexOf('.');
        var first = host[..dot];
        var rest = host[(dot + 1)..];
        return approved.FirstOrDefault(other =>
        {
            if (other == host || other.IndexOf('.') is not (> 0 and var otherDot)) return false;
            var otherFirst = other[..otherDot];
            return host.Contains(other, StringComparison.Ordinal) || other.Contains(host, StringComparison.Ordinal) || first == otherFirst || (rest == other[(otherDot + 1)..] && Distance(first, otherFirst) <= 1);
        });
    }

    // Every request: what the name resolves to now. A short cache, so a page's requests do not each ask.
    private readonly Dictionary<string, DateTimeOffset> resolved = new(StringComparer.Ordinal);
    private async Task PublicHost(string host, CancellationToken token)
    {
        lock (sync) if (resolved.TryGetValue(host, out var at) && DateTimeOffset.UtcNow - at < TimeSpan.FromSeconds(60)) return;
        IPAddress[] addresses;
        try { addresses = await Dns.GetHostAddressesAsync(host, token); }
        catch (System.Net.Sockets.SocketException) { throw new AgentFault("USERS_HOST_UNRESOLVED", "This environment does not resolve, so nothing was sent.", false); }
        if (addresses.Length == 0) throw new AgentFault("USERS_HOST_UNRESOLVED", "This environment does not resolve, so nothing was sent.", false);
        if (addresses.Any(item => IsPrivateAddress(item.ToString()))) throw new AgentFault("USERS_HOST_PRIVATE", "This environment resolves to an address that is not on the internet, so nothing was sent.", false);
        lock (sync) resolved[host] = DateTimeOffset.UtcNow;
    }

    // What may run, checked before anything is started.
    internal static void Validate(JsonNode? node)
    {
        if (node is not JsonObject p) throw Invalid("params must be an object");
        var op = Word(p["op"]);
        string[] keys = op switch
        {
            "status" or "forget" => ["op", "host", "kind", "entry"],
            "prompt" => ["op", "host", "kind", "entry", "subject", "action", "userId"],
            "confirm" => ["op", "host", "action", "userId", "targetId", "labels", "changes"],
            "login" or "sign-out" => ["op", "host"],
            "request" => ["op", "host", "url", "method", "fields", "secretRefs"],
            _ => throw Invalid("op must be status, prompt, confirm, login, request, forget or sign-out"),
        };
        foreach (var (key, _) in p) if (!keys.Contains(key, StringComparer.Ordinal)) throw Invalid("unknown parameter " + key);
        var host = Word(p["host"]);
        if (!HostOk(host)) throw Invalid("host must be the DNS name of an environment");
        if (op is "login" or "sign-out") return;
        if (op == "confirm")
        {
            var action = Word(p["action"]);
            if (action == null || !Actions.TryGetValue(action, out var rule)) throw Invalid("action is not one a person can approve here");
            if (rule.Page != null ? Word(p["userId"]) is not { } userId || !IdPattern().IsMatch(userId) : p["userId"] != null) throw Invalid("userId is a number as text, on a write");
            if (rule.Target != null ? Word(p["targetId"]) is not { } targetId || !IdPattern().IsMatch(targetId) : p["targetId"] != null) throw Invalid("targetId is a number as text, on a role or a group");
            if (p["labels"] != null)
            {
                if (p["labels"] is not JsonObject labels) throw Invalid("labels are one short line each");
                foreach (var (key, value) in labels) if (key is not ("user" or "target") || !Shown(value, 120)) throw Invalid("labels are one short line each");
            }
            if (p["changes"] != null)
            {
                if (action != "update") throw Invalid("changes belong to update");
                if (p["changes"] is not JsonObject changes) throw Invalid("changes are name, username, email and phone, one line each");
                foreach (var (key, value) in changes) if (key is not ("name" or "username" or "email" or "phone") || !Shown(value, 256)) throw Invalid("changes are name, username, email and phone, one line each");
            }
            return;
        }
        if (op != "request")
        {
            var kind = p["kind"] == null ? "login" : Word(p["kind"]);
            if (kind != "login" && kind != "password") throw Invalid("kind must be login or password");
            var entry = Word(p["entry"]);
            if (kind == "password" ? entry == null || !EntryPattern().IsMatch(entry) : p["entry"] != null) throw Invalid("entry belongs to kind password, 64 hex");
            if (op == "forget" && kind != "password") throw Invalid("only a new password is forgotten");
            if (op == "prompt")
            {
                var purpose = Word(p["action"]);
                if (kind == "password" && purpose != "create" && purpose != "set-password") throw Invalid("a new password is for create or set-password");
                if (kind == "login" && (p["action"] != null || p["userId"] != null)) throw Invalid("the sign-in window takes only a host");
                if (purpose == "set-password" ? Word(p["userId"]) is not { } user || !IdPattern().IsMatch(user) : p["userId"] != null) throw Invalid("userId is a number as text, on set-password");
            }
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
        if (page == "/Users/Login.aspx" && method == "POST") throw Invalid("the sign-in is op login");
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
            if (Word(reference["field"]) is not { } field || !FieldPattern().IsMatch(field) || Word(reference["part"]) != "password") throw Invalid("a new password goes only into a password field");
            if (Word(reference["kind"]) != "password" || Word(reference["entry"]) is not { } entry || !EntryPattern().IsMatch(entry) || method != "POST" || page is not ("/Users/User_Edit.aspx" or "/Users/User_Show.aspx")) throw Invalid("a new password goes only into the form of a user");
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

    // What a window the person filled gives: a prompt's status file says saved only after the vault has it.
    private void Settle()
    {
        lock (sync)
            foreach (var (key, record) in prompts.ToList())
            {
                string? phase = null;
                try { phase = File.Exists(record.StatusFile) ? File.ReadAllText(record.StatusFile) : null; } catch (IOException) { }
                if (phase == "saved" && !record.Applied)
                {
                    record.Applied = true;
                    if (record.Kind == "password") permits.Add(new Permit { Host = record.Host, Page = record.Action == "create" ? "/Users/User_Edit.aspx" : "/Users/User_Show.aspx?UserId=" + record.UserId, Posts = 3, Until = DateTimeOffset.UtcNow.AddMinutes(5), Entry = record.Entry });
                    else consents[record.Host] = DateTimeOffset.UtcNow.AddHours(8);
                }
                if (record.Child.HasExited)
                {
                    try { File.Delete(record.StatusFile); } catch (IOException) { }
                    prompts.Remove(key);
                }
            }
    }

    private void UsePermit(string host, string page, List<string> entries)
    {
        lock (sync)
        {
            permits.RemoveAll(item => item.Until <= DateTimeOffset.UtcNow || item.Posts <= 0);
            var permit = permits.FirstOrDefault(item => item.Host == host && item.Page == page && entries.All(entry => item.Entry == entry));
            if (permit == null) throw new AgentFault("USERS_CONSENT_REQUIRED", "No person on this machine approved this change, so it was not sent.", false);
            permit.Posts -= 1;
            if (entries.Count > 0) permit.Posts = 0;
        }
    }

    private async Task<JsonObject> Confirm(string host, JsonObject p, CancellationToken token)
    {
        await PublicHost(host, token);
        var stored = await Call("status", host, new JsonObject(), "", false, token);
        if (stored["available"]?.GetValue<bool>() != true) throw new AgentFault("USERS_HOST_NOT_AUTHENTICATED", "No Users administrator is stored for this environment on this machine; nothing was sent.", false);
        var action = Word(p["action"])!;
        var rule = Actions[action];
        var rows = new JsonArray(Row("Environment", host), Row("Signed in as", Word(stored["principal"]) ?? ""), Row("What will happen", rule.Text));
        if (rule.Page != null) rows.Add((JsonNode)Row("User id", Word(p["userId"])!));
        if (Word(p["labels"]?["user"]) is { } user) rows.Add((JsonNode)Row("User name", user, true));
        if (rule.Target != null) rows.Add((JsonNode)Row(rule.Target, Word(p["targetId"])!));
        if (Word(p["labels"]?["target"]) is { } target) rows.Add((JsonNode)Row(rule.Target!.Replace(" id", " name", StringComparison.Ordinal), target, true));
        if (p["changes"] is JsonObject changes) foreach (var (key, value) in changes) rows.Add((JsonNode)Row("New " + key, Word(value) ?? ""));
        var input = Convert.ToBase64String(Encoding.UTF8.GetBytes(new JsonObject { ["rows"] = rows }.ToJsonString()));
        JsonObject answer;
        try { answer = await Call("confirm", host, new JsonObject(), input, false, token, true, 130); }
        catch (AgentFault) { throw new AgentFault("USERS_CONFIRMATION_TIMEOUT", "No answer from the person on this machine, so nothing was sent.", false); }
        if (answer["approved"]?.GetValue<bool>() != true)
            throw answer["timedOut"]?.GetValue<bool>() == true
                ? new AgentFault("USERS_CONFIRMATION_TIMEOUT", "No answer from the person on this machine, so nothing was sent.", false)
                : new AgentFault("USERS_CONFIRMATION_DECLINED", "The person on this machine declined, so nothing was sent.", false);
        lock (sync)
        {
            if (action == "sign-in") consents[host] = DateTimeOffset.UtcNow.AddHours(8);
            else permits.Add(new Permit { Host = host, Page = "/Users/" + rule.Page + ".aspx?UserId=" + Word(p["userId"]), Posts = 3, Until = DateTimeOffset.UtcNow.AddSeconds(120) });
        }
        return new JsonObject { ["approved"] = true };
    }
    private static JsonObject Row(string label, string value, bool data = false)
    {
        var row = new JsonObject { ["label"] = label, ["value"] = value };
        if (data) row["data"] = true;
        return row;
    }

    private async Task<JsonObject> Call(string mode, string host, JsonObject p, string input, bool? executed, CancellationToken token, bool interactive = false, int seconds = HelperSeconds)
    {
        JsonObject? value = null;
        try
        {
            using var process = Process.Start(Start(interactive, mode, host, p, true)) ?? throw new IOException("no helper");
            var output = process.StandardOutput.ReadToEndAsync(token);
            var errors = process.StandardError.ReadToEndAsync(token);
            await process.StandardInput.WriteAsync(input);
            process.StandardInput.Close();
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
            limit.CancelAfter(TimeSpan.FromSeconds(seconds));
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
            : code == "USERS_PAGE_TOO_LARGE" ? new AgentFault(code, "This page is larger than a Users page can be; it was not read.", executed)
            : code == "USERS_LOGIN_LAYOUT_CHANGED" ? new AgentFault(code, "The sign-in page of this environment is not the one this agent knows; nothing was sent.", false)
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
        Settle();
        lock (sync)
            if (prompts.ContainsKey(key)) return new JsonObject { ["opened"] = false, ["alreadyOpen"] = true };
        var directory = Path.Combine(dataRoot, "private", "users");
        Directory.CreateDirectory(directory);
        var status = Path.Combine(directory, "prompt-" + Guid.NewGuid().ToString("N") + ".status");
        var start = Start(true, "prompt", host, p, false);
        start.ArgumentList.Add("-Subject"); start.ArgumentList.Add(Word(p["subject"]) ?? "");
        start.ArgumentList.Add("-PromptStatusPath"); start.ArgumentList.Add(status);
        Process process;
        try { process = Process.Start(start) ?? throw new IOException("no helper"); }
        catch (Exception e) when (e is IOException or System.ComponentModel.Win32Exception) { throw new AgentFault("USERS_PROMPT_NOT_VISIBLE", "The private window could not be confirmed visible.", null); }
        lock (sync) prompts[key] = new OpenPrompt { Child = process, StatusFile = status, Host = host, Kind = Word(p["kind"]) ?? "login", Entry = Word(p["entry"]), Action = Word(p["action"]), UserId = Word(p["userId"]) };
        // The status file stays until the window closes: it says saved only then.
        process.EnableRaisingEvents = true;
        process.Exited += (_, _) => Settle();
        for (var waited = 0; waited < PromptWaitMs; waited += 100)
        {
            if (File.Exists(status))
            {
                var phase = await File.ReadAllTextAsync(status, token);
                if (phase is "visible" or "saved")
                {
                    Settle();
                    var answer = new JsonObject { ["opened"] = true, ["alreadyOpen"] = false, ["visible"] = true };
                    if (phase == "saved") answer["saved"] = true;
                    return answer;
                }
            }
            if (process.HasExited) break;
            await Task.Delay(100, token);
        }
        Settle();
        lock (sync) prompts.Remove(key);
        try { File.Delete(status); } catch (IOException) { }
        throw new AgentFault("USERS_PROMPT_NOT_VISIBLE", "The private window could not be confirmed visible.", null);
    }

    internal async Task<JsonNode?> Execute(JsonObject p, CancellationToken token)
    {
        if (!OperatingSystem.IsWindows()) throw new AgentFault("USERS_PLATFORM_UNAVAILABLE", "Users administration is not available on this platform.", false);
        Validate(p);
        Settle();
        var op = Word(p["op"])!;
        var host = Word(p["host"])!;
        switch (op)
        {
            case "status":
            {
                var value = await Call("status", host, p, "", false, token);
                return new JsonObject { ["available"] = value["available"]?.GetValue<bool>() == true, ["principal"] = Word(value["principal"]), ["consent"] = HasConsent(host) };
            }
            case "sign-out":
                lock (sync) { jars.Remove(host); consents.Remove(host); permits.RemoveAll(item => item.Host == host); }
                await Call("sign-out", host, new JsonObject(), "", false, token);
                return new JsonObject { ["signedOut"] = true };
            case "confirm":
                return await Confirm(host, p, token);
            case "login":
            {
                if (!HasConsent(host)) throw new AgentFault("USERS_LOGIN_CONSENT_REQUIRED", "No person on this machine approved signing in to this environment, so nothing was sent.", false);
                await PublicHost(host, token);
                var signed = await Call("login", host, new JsonObject(), "", null, token);
                StoreCookies(host, signed["setCookie"]);
                return new JsonObject { ["authenticated"] = signed["authenticated"]?.GetValue<bool>() == true };
            }
            case "forget":
                await Call("forget", host, p, "", false, token);
                return new JsonObject();
            case "prompt":
                await PublicHost(host, token);
                if ((Word(p["kind"]) ?? "login") == "login")
                {
                    // The person decides on a window; a name built to pass for an approved one never gets a window.
                    var hosts = await Call("hosts", host, new JsonObject(), "", false, token);
                    if (LookalikeOf(host, (hosts["hosts"] as JsonArray ?? []).Select(item => Word(item) ?? "").Where(item => item.Length > 0)) != null)
                        throw new AgentFault("USERS_HOST_LOOKALIKE", "This name reads like an environment already approved on this machine, so no window was opened and nothing was sent.", false);
                    lock (sync) jars.Remove(host);
                }
                else
                {
                    var stored = await Call("status", host, new JsonObject(), "", false, token);
                    if (stored["available"]?.GetValue<bool>() != true) throw new AgentFault("USERS_HOST_NOT_AUTHENTICATED", "No Users administrator is stored for this environment on this machine; nothing was sent.", false);
                }
                return await Prompt(host, p, token);
        }
        if (!HasConsent(host)) throw new AgentFault("USERS_LOGIN_CONSENT_REQUIRED", "No person on this machine approved signing in to this environment, so nothing was sent.", false);
        await PublicHost(host, token);
        // Only the two searches post without a yes. Every other form needs the person's yes for this page.
        var refs = (p["secretRefs"] as JsonArray ?? []).Select(item => Word(item?["entry"])!).Distinct().ToList();
        if (Word(p["method"]) == "POST")
        {
            var url = Word(p["url"])!;
            var path = url[("https://" + host).Length..];
            var bare = path.Split('?')[0];
            if (bare is not ("/Users/User_List.aspx" or "/Users/Inactive_Users.aspx") || refs.Count > 0) UsePermit(host, path, refs);
        }
        var request = new JsonObject
        {
            ["url"] = Word(p["url"]), ["method"] = Word(p["method"]), ["fields"] = p["fields"]?.DeepClone() ?? new JsonArray(),
            ["secretRefs"] = p["secretRefs"]?.DeepClone() ?? new JsonArray(), ["cookie"] = CookieHeader(host),
        };
        var input = Convert.ToBase64String(Encoding.UTF8.GetBytes(request.ToJsonString()));
        var passwords = (p["secretRefs"] as JsonArray ?? []).Select(item => Word(item?["entry"])).Where(entry => entry != null).Distinct().ToList();
        var forgotten = true;
        JsonObject page;
        try { page = await Call("request", host, new JsonObject(), input, null, token); }
        finally
        {
            foreach (var entry in passwords)
                try { await Call("forget", host, new JsonObject { ["kind"] = "password", ["entry"] = entry }, "", false, CancellationToken.None); }
                catch (AgentFault) { forgotten = false; }
        }
        StoreCookies(host, page["setCookie"]);
        // The session stays here: the answer has no setCookie. A new password was for this one POST, whatever the server does next.
        var answer = new JsonObject { ["status"] = page["status"]?.DeepClone(), ["location"] = Word(page["location"]) ?? "", ["contentType"] = Word(page["contentType"]) ?? "", ["body"] = Word(page["body"]) ?? "" };
        if (passwords.Count > 0) answer["passwordForgotten"] = forgotten;
        return answer;
    }
}
