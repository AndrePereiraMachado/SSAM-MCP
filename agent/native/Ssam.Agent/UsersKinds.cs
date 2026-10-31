using System.Diagnostics;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

// o11.users, the rules of agent/lib/users.mjs in the same order: the Users application of an O11 environment through this machine. The
// administrator's password and new passwords are entries of this Windows account's Credential Manager, typed only in a private window
// (users-vault.ps1, embedded here byte for byte); the session cookies live in this process's memory. The server never builds a POST: it names an
// operation and its ids, and this agent reads the real page, builds the request from the table of UsersPage.cs and shows the person what it
// will send. No field carries a password or a cookie, in either direction. Windows only: elsewhere USERS_PLATFORM_UNAVAILABLE.
// The behaviour is compared with the Node agent's by check-users-flow (tests/native/users.test.mjs), with a stand-in for the helper.
internal sealed partial class UsersKinds
{
    internal const string Name = "o11.users";
    private const int HelperSeconds = 45, PromptWaitMs = 12000, MaxSearch = 256, WindowsMax = 20, RefusalsMax = 3, LoginFailuresMax = 2;
    private const int MaxPageBase64 = (262144 + 2) / 3 * 4 + 8;
    private readonly string dataRoot;
    private readonly string scope;
    // The tests' seams, set only by check-users-flow. Production runs the embedded helper with the system's PowerShell, DNS and clock.
    internal string[]? HelperCommand;
    internal Func<string, Task<string[]>>? Lookup;
    internal Func<DateTimeOffset> Now = () => DateTimeOffset.UtcNow;
    internal bool ForceWindows;
    internal TimeSpan PermitTime = TimeSpan.FromMinutes(5);
    private readonly Dictionary<string, Dictionary<string, string>> jars = new(StringComparer.Ordinal);
    private readonly Dictionary<string, OpenPrompt> prompts = new(StringComparer.Ordinal);
    private readonly object sync = new();

    [GeneratedRegex("^(?=.{1,253}\\z)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\\z", RegexOptions.CultureInvariant)] private static partial Regex HostPattern();
    [GeneratedRegex("^[a-f0-9]{64}\\z", RegexOptions.CultureInvariant)] private static partial Regex EntryPattern();
    [GeneratedRegex("^/Users/(?:(?:Login|User_List|Inactive_Users|User_Show|User_Edit|Group_List|Group_Show|Group_Edit|Application_List|Application_Show|Role_Show|MyInfo)\\.aspx)?\\z", RegexOptions.CultureInvariant)] private static partial Regex PagePattern();
    [GeneratedRegex("^(?:(?:UserId|GroupId|RoleId|ApplicationId)=[1-9][0-9]{0,18})?\\z", RegexOptions.CultureInvariant)] private static partial Regex QueryPattern();
    [GeneratedRegex("[\\\\\\s\\u0000-\\u001f]|%2e|%2f|%5c", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)] private static partial Regex BadUrlPattern();
    [GeneratedRegex("^USERS_[A-Z_]{1,60}\\z", RegexOptions.CultureInvariant)] private static partial Regex CodePattern();
    [GeneratedRegex("^[1-9][0-9]{0,18}\\z", RegexOptions.CultureInvariant)] private static partial Regex IdPattern();

    private sealed class Permit { public required string Host; public required string Action; public string? UserId; public string? Changes; public required string Entry; public DateTimeOffset Until; }
    private sealed class OpenPrompt { public required Process Child; public required string StatusFile; public required string Host; public required string Kind; public string? Entry; public string? Action; public string? UserId; public string? Changes; public bool Applied; public string? Phase; }
    private readonly Dictionary<string, DateTimeOffset> consents = new(StringComparer.Ordinal);
    private readonly List<Permit> permits = [];
    private readonly string promptDir;
    private readonly string failuresFile;
    private readonly string pendingFile;
    private bool forgetFailed;
    private int writing;
    private Task? started;

    internal UsersKinds(string dataRoot, string account = "")
    {
        this.dataRoot = dataRoot;
        scope = Scope(dataRoot, account);
        promptDir = Path.Combine(dataRoot, "private", "users");
        failuresFile = Path.Combine(promptDir, "sign-in-failures.json");
        pendingFile = Path.Combine(promptDir, "passwords-pending");
    }

    // The vault scope: this installation and this account of the server. Its entries are its own: another token on this installation
    // inherits nothing, and an SSAM installed on the same Windows account is apart.
    private static string Short(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant()[..16];
    internal static string Scope(string dataRoot, string account = "") => Short(Path.GetFullPath(dataRoot).ToLowerInvariant()) + Short("account|" + account);

    private static AgentFault Invalid(string message) => new("PARAMS_INVALID", message);
    private static string? Word(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
    private const string InternalText = "This name is only reachable inside a private network, and Users administration through the agent works only with environments on the internet. Nothing was sent. Use the Users application of that environment directly.";
    private const string HostText = "host must be the plain DNS name of an environment, like name.example.com: no scheme, port, address or other alphabet";
    // A name only a private network can resolve, a service that resolves to any address it is given.
    private static readonly string[] Internal = [".localhost", ".local", ".localdomain", ".internal", ".intranet", ".lan", ".home", ".corp", ".svc", ".arpa", ".nip.io", ".sslip.io", ".xip.io"];
    private static void CheckHost(string? host)
    {
        if (host == null || !HostPattern().IsMatch(host) || host.Split('.').Any(label => label.StartsWith("xn--", StringComparison.Ordinal))) throw Invalid(HostText);
        var last = host[(host.LastIndexOf('.') + 1)..];
        if (last.Length < 2 || last.StartsWith("0x", StringComparison.Ordinal) || last.All(char.IsAsciiDigit)) throw Invalid(HostText);
        if (Internal.Any(end => host.EndsWith(end, StringComparison.Ordinal))) throw new AgentFault("USERS_HOST_INTERNAL", InternalText, false);
    }
    private static bool PrivateV4(byte[] b, int at = 0)
    {
        byte a0 = b[at], a1 = b[at + 1], a2 = b[at + 2];
        return a0 == 0 || a0 == 10 || a0 == 127 || a0 >= 224 || (a0 == 100 && a1 >= 64 && a1 <= 127) || (a0 == 169 && a1 == 254) || (a0 == 172 && a1 >= 16 && a1 <= 31) || (a0 == 192 && a1 == 168) || (a0 == 192 && a1 == 0 && a2 == 0) || (a0 == 198 && (a1 == 18 || a1 == 19));
    }
    // A resolved address that is not on the internet: this machine, a private network, link-local (cloud metadata), multicast, or an IPv6 form
    // that carries one of those inside it (mapped, compatible, NAT64, 6to4).
    internal static bool IsPrivateAddress(string text)
    {
        if (!IPAddress.TryParse(text, out var address)) return true;
        var b = address.GetAddressBytes();
        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork) return PrivateV4(b);
        bool Zeros(int n) => b.Take(n).All(x => x == 0);
        if (Zeros(16) || (Zeros(15) && b[15] == 1)) return true;
        if ((Zeros(10) && b[10] == 255 && b[11] == 255) || Zeros(12)) return PrivateV4(b, 12);
        if (b[0] == 0 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b) return PrivateV4(b, 12);
        if (b[0] == 0x20 && b[1] == 0x02) return PrivateV4(b, 2);
        return (b[0] & 0xfe) == 0xfc || (b[0] == 0xfe && (b[1] & 0xc0) == 0x80) || (b[0] == 0xfe && (b[1] & 0xc0) == 0xc0) || b[0] == 0xff;
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
    private static int ChangeLimit(string key) => key switch { "name" => 256, "username" or "email" => 250, "phone" => 20, _ => 0 };
    private static void ValidChanges(JsonNode? node, bool needsNew)
    {
        if (node is not JsonObject changes || changes.Count == 0) throw Invalid("changes are name, username, email and phone");
        foreach (var (key, value) in changes)
        {
            if (ChangeLimit(key) == 0) throw Invalid("changes are name, username, email and phone");
            if (!UsersPage.PlainValue(Word(value), ChangeLimit(key))) throw Invalid("changes." + key + " must be plain text: within its limit, one line, no invisible characters or repeated spaces, because the window shows exactly what is sent");
        }
        if (needsNew && (changes["username"] == null || changes["name"] == null)) throw Invalid("a new user needs its name and username");
    }

    // What may run, checked before anything is started.
    internal static void Validate(JsonNode? node)
    {
        if (node is not JsonObject p) throw Invalid("params must be an object");
        var op = Word(p["op"]);
        string[] keys = op switch
        {
            "status" or "forget" => ["op", "host", "kind", "entry"],
            "prompt" => ["op", "host", "kind", "entry", "action", "userId", "changes"],
            "confirm" => ["op", "host", "action"],
            "login" or "sign-out" => ["op", "host"],
            "request" => ["op", "host", "url"],
            "search" => ["op", "host", "inactive", "text"],
            "write" => ["op", "host", "action", "userId", "targetId", "changes", "entry"],
            _ => throw Invalid("op must be status, prompt, confirm, login, request, search, write, forget or sign-out"),
        };
        foreach (var (key, _) in p) if (!keys.Contains(key, StringComparer.Ordinal)) throw Invalid("unknown parameter " + key);
        var host = Word(p["host"]);
        CheckHost(host);
        if (op is "login" or "sign-out") return;
        if (op == "confirm") { if (Word(p["action"]) != "sign-in") throw Invalid("the only yes asked by itself is the sign-in: a write opens its own window"); return; }
        if (op == "request")
        {
            var url = Word(p["url"]);
            var prefix = "https://" + host;
            if (url == null || url.Length > 2048 || !url.StartsWith(prefix + "/", StringComparison.Ordinal) || BadUrlPattern().IsMatch(url)) throw Invalid("url is not a Users page of the host");
            var rest = url[prefix.Length..];
            var mark = rest.IndexOf('?');
            if (rest.Contains('#') || !PagePattern().IsMatch(mark < 0 ? rest : rest[..mark]) || !QueryPattern().IsMatch(mark < 0 ? "" : rest[(mark + 1)..])) throw Invalid("url is not a Users page of the host");
            return;
        }
        if (op == "search")
        {
            if (p["inactive"] != null && !(p["inactive"] is JsonValue flag && flag.TryGetValue<bool>(out _))) throw Invalid("inactive is true or false");
            if (p["text"] != null && (Word(p["text"]) is not { } text || text.Length > MaxSearch)) throw Invalid("text is what to search for");
            return;
        }
        if (op == "write")
        {
            var action = Word(p["action"]);
            if (action == null || !UsersPage.ActionText.ContainsKey(action)) throw Invalid("this operation does not exist in this agent");
            if (action == "create" ? p["userId"] != null : Word(p["userId"]) is not { } userId || !IdPattern().IsMatch(userId)) throw Invalid("userId is a number as text");
            if (action is "grant-role" or "add-group" ? Word(p["targetId"]) is not { } targetId || !IdPattern().IsMatch(targetId) : p["targetId"] != null) throw Invalid("targetId is a number as text, on a role or a group");
            if (action is "update" or "create") ValidChanges(p["changes"], action == "create"); else if (p["changes"] != null) throw Invalid("changes belong to update and create");
            if (action is "create" or "set-password" ? Word(p["entry"]) is not { } entry || !EntryPattern().IsMatch(entry) : p["entry"] != null) throw Invalid("entry names the new password of create or set-password");
            return;
        }
        var kind = p["kind"] == null ? "login" : Word(p["kind"]);
        if (kind != "login" && kind != "password") throw Invalid("kind must be login or password");
        if (kind == "password" ? Word(p["entry"]) is not { } given || !EntryPattern().IsMatch(given) : p["entry"] != null) throw Invalid("entry belongs to kind password, 64 hex");
        if (op == "forget" && kind != "password") throw Invalid("only a new password is forgotten");
        if (op == "prompt")
        {
            if (kind == "login") { if (p["action"] != null || p["userId"] != null || p["changes"] != null) throw Invalid("the sign-in window takes only a host"); return; }
            var purpose = Word(p["action"]);
            if (purpose == "set-password") { if (Word(p["userId"]) is not { } user || !IdPattern().IsMatch(user) || p["changes"] != null) throw Invalid("set-password names the user by its id, and the agent reads who that is"); return; }
            if (purpose != "create") throw Invalid("a new password is for create or set-password");
            if (p["userId"] != null) throw Invalid("a new user has no id");
            ValidChanges(p["changes"], true);
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

    private ProcessStartInfo Start(bool interactive, string mode, string host, JsonObject p, bool redirect, IEnumerable<string>? extra = null)
    {
        var start = new ProcessStartInfo(HelperCommand?[0] ?? PowerShell()) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = redirect, RedirectStandardOutput = redirect, RedirectStandardError = redirect };
        var args = new List<string>();
        if (HelperCommand != null) args.AddRange(HelperCommand.Skip(1));
        else args.AddRange(["-NoLogo", "-NoProfile", interactive ? "-STA" : "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", Helper()]);
        args.AddRange(["-Mode", mode, "-HostName", host, "-Scope", scope]);
        if (Word(p["kind"]) is { } kind) { args.Add("-Kind"); args.Add(kind); }
        if (Word(p["entry"]) is { } entry) { args.Add("-Entry"); args.Add(entry); }
        if (extra != null) args.AddRange(extra);
        foreach (var arg in args) start.ArgumentList.Add(arg);
        return start;
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
        throw code switch
        {
            "USERS_HOST_NOT_AUTHENTICATED" => new AgentFault(code, "No Users administrator is stored for this environment on this machine; nothing was sent.", false),
            "USERS_PAGE_TOO_LARGE" => new AgentFault(code, "This page is larger than a Users page can be; it was not read.", executed),
            "USERS_LOGIN_LAYOUT_CHANGED" => new AgentFault(code, "The sign-in page of this environment is not the one this agent knows; nothing was sent.", false),
            _ => new AgentFault(code, "The private Users request failed; no automatic retry.", executed),
        };
    }
    // What a name resolves to now, with a short cache so a page's requests do not each ask.
    private readonly Dictionary<string, DateTimeOffset> resolved = new(StringComparer.Ordinal);
    private async Task PublicHost(string host, CancellationToken token)
    {
        lock (sync) if (resolved.TryGetValue(host, out var at) && Now() - at < TimeSpan.FromSeconds(60)) return;
        string[] addresses;
        try { addresses = Lookup != null ? await Lookup(host) : (await Dns.GetHostAddressesAsync(host, token)).Select(item => item.ToString()).ToArray(); }
        catch (Exception e) when (e is System.Net.Sockets.SocketException or IOException) { throw new AgentFault("USERS_HOST_UNRESOLVED", "This environment does not resolve, so nothing was sent.", false); }
        if (addresses.Length == 0) throw new AgentFault("USERS_HOST_UNRESOLVED", "This environment does not resolve, so nothing was sent.", false);
        if (addresses.Any(IsPrivateAddress)) throw new AgentFault("USERS_HOST_PRIVATE", "This environment resolves to an address that is not on the internet, so nothing was sent.", false);
        lock (sync) resolved[host] = Now();
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
    // One window at a time; a person who keeps saying no is not asked again for a while; and a ceiling, so a window is never a way to wear a
    // person down. A yes does not count against the second: approving seven changes is work, not pressure. A closed window is a no.
    private bool confirming;
    private readonly List<DateTimeOffset> opened = [], refusals = [];
    private void TakeWindow()
    {
        Settle();
        lock (sync)
        {
            if (confirming || prompts.Count > 0) throw new AgentFault("USERS_WINDOW_BUSY", "Another window of this agent is open: answer that one first.", false);
            opened.RemoveAll(at => Now() - at >= TimeSpan.FromMinutes(10));
            refusals.RemoveAll(at => Now() - at >= TimeSpan.FromMinutes(10));
            if (opened.Count >= WindowsMax || refusals.Count >= RefusalsMax) throw new AgentFault("USERS_WINDOW_LIMIT", "Too many windows in a few minutes, so no other was opened.", false);
            opened.Add(Now());
        }
    }
    private bool HasConsent(string host) { lock (sync) return consents.TryGetValue(host, out var until) && until > Now(); }
    private void NeedConsent(string host) { if (!HasConsent(host)) throw new AgentFault("USERS_LOGIN_CONSENT_REQUIRED", "No person on this machine approved signing in to this environment, so nothing was sent.", false); }
    // The sign-in brake survives a restart: a file of this agent, with a host and a count and nothing else. A try counts before it leaves, whatever
    // happens after, since the password may have reached the site. Only a person's window, or a sign-in that a page then proves, resets it: an answer
    // of the helper can be wrong (a redirect to an error page), and a page alone says nothing about the tries in between.
    private readonly HashSet<string> unproven = new(StringComparer.Ordinal);
    private void TakeLoginTry(string host)
    {
        lock (sync)
        {
            NotPaused(host, true);
            SetFailures(host, FailuresOf(host) + 1);
            unproven.Remove(host);
        }
    }
    private JsonObject ReadFailures()
    {
        try { return JsonNode.Parse(File.ReadAllText(failuresFile)) as JsonObject ?? []; }
        catch (Exception e) when (e is IOException or System.Text.Json.JsonException) { return []; }
    }
    private int FailuresOf(string host) => ReadFailures()[scope + "|" + host] is JsonValue value && value.TryGetValue<int>(out var count) ? count : 0;
    private void SetFailures(string host, int count)
    {
        var all = ReadFailures();
        if (FailuresOf(host) == count) return;
        if (count > 0) all[scope + "|" + host] = count; else all.Remove(scope + "|" + host);
        Directory.CreateDirectory(promptDir);
        File.WriteAllText(failuresFile, all.ToJsonString());
    }
    // A sign-in that said yes may read the page that proves it, even as the last try.
    private void NotPaused(string host, bool tryingAgain = false)
    {
        bool waiting;
        lock (sync) waiting = unproven.Contains(host);
        if (FailuresOf(host) >= LoginFailuresMax && (tryingAgain || !waiting)) throw new AgentFault("USERS_LOGIN_PAUSED", "Signing in failed twice, so it stopped before the Users application locks this administrator. A person signs in again in the window of this agent, or checks the account in the Users application first.", false);
    }
    // A new password in the vault is useful only under its permit. So it leaves by itself when the permit ends, with no other call; and a mark on
    // disk says one may be there, so an agent that closed before that removes it when it starts. Without a mark, starting runs nothing.
    private void ClearPending()
    {
        lock (sync)
        {
            if (forgetFailed || writing > 0 || permits.Count > 0 || prompts.Values.Any(record => record.Kind == "password")) return;
            try { File.Delete(pendingFile); } catch (IOException) { }
        }
    }
    private async Task ExpireLater(Permit permit)
    {
        await Task.Delay(PermitTime);
        await Expire(permit);
    }
    private async Task Expire(Permit permit)
    {
        lock (sync) if (!permits.Contains(permit)) return;
        await Forget(permit.Host, permit.Entry);
    }
    internal Task Startup() { lock (sync) return started ??= SweepOrphans(); }
    private async Task SweepOrphans()
    {
        if (!(OperatingSystem.IsWindows() || ForceWindows) || !File.Exists(pendingFile)) return;
        try
        {
            await Call("sweep", "sweep.invalid", new JsonObject(), "", false, CancellationToken.None);
            File.Delete(pendingFile);
        }
        catch (Exception e) when (e is AgentFault or IOException) { /* the next start */ }
    }
    // What a window the person filled gives: a prompt's status file says saved only after the vault has it.
    private void Settle()
    {
        lock (sync)
            foreach (var (key, record) in prompts.ToList())
            {
                string? phase = null;
                try { phase = File.Exists(record.StatusFile) ? File.ReadAllText(record.StatusFile) : null; } catch (IOException) { }
                if (phase != null) record.Phase = phase;
                if (phase == "saved" && !record.Applied)
                {
                    record.Applied = true;
                    if (record.Kind == "password")
                    {
                        // A second window for the same password replaces the first, and the first one's timer finds nothing.
                        permits.RemoveAll(item => item.Host == record.Host && item.Entry == record.Entry);
                        var permit = new Permit { Host = record.Host, Action = record.Action!, UserId = record.UserId, Changes = record.Changes, Entry = record.Entry!, Until = Now() + PermitTime };
                        permits.Add(permit);
                        _ = ExpireLater(permit);
                    }
                    else { consents[record.Host] = Now().AddHours(8); SetFailures(record.Host, 0); }
                }
                if (record.Child.HasExited)
                {
                    if (!record.Applied) refusals.Add(Now());
                    try { File.Delete(record.StatusFile); } catch (IOException) { }
                    prompts.Remove(key);
                    if (record.Kind == "password") ClearPending();
                }
            }
    }
    // For check-users-flow: every window opened has closed and been read.
    internal async Task WindowsClosed()
    {
        for (var waited = 0; waited < 120000; waited += 20)
        {
            Settle();
            lock (sync) if (prompts.Count == 0) return;
            await Task.Delay(20);
        }
        throw new TimeoutException("a window did not close");
    }
    private static string? ChangesKey(JsonNode? changes) => changes?.ToJsonString();
    private void UsePermit(string host, string action, string? userId, JsonNode? changes, string entry)
    {
        lock (sync)
        {
            var at = permits.FindIndex(item => item.Until > Now() && item.Host == host && item.Action == action && item.Entry == entry && item.UserId == userId && item.Changes == ChangesKey(changes));
            if (at < 0) throw new AgentFault("USERS_CONSENT_REQUIRED", "No person on this machine approved this exact change in a window, so it was not sent.", false);
            permits.RemoveAt(at);
        }
    }
    private async Task Ask(string host, JsonArray rows, CancellationToken token)
    {
        var input = Convert.ToBase64String(Encoding.UTF8.GetBytes(new JsonObject { ["rows"] = rows }.ToJsonString()));
        TakeWindow();
        lock (sync) confirming = true;
        JsonObject answer;
        try { answer = await Call("confirm", host, new JsonObject(), input, false, token, true, 130); }
        catch (AgentFault) { lock (sync) refusals.Add(Now()); throw new AgentFault("USERS_CONFIRMATION_TIMEOUT", "No answer from the person on this machine, so nothing was sent.", false); }
        finally { lock (sync) confirming = false; }
        if (answer["approved"]?.GetValue<bool>() == true) return;
        lock (sync) refusals.Add(Now());
        throw answer["timedOut"]?.GetValue<bool>() == true
            ? new AgentFault("USERS_CONFIRMATION_TIMEOUT", "No answer from the person on this machine, so nothing was sent.", false)
            : new AgentFault("USERS_CONFIRMATION_DECLINED", "The person on this machine declined, so nothing was sent.", false);
    }
    private async Task<JsonObject> StoredLogin(string host, CancellationToken token)
    {
        var stored = await Call("status", host, new JsonObject(), "", false, token);
        if (stored["available"]?.GetValue<bool>() != true) throw new AgentFault("USERS_HOST_NOT_AUTHENTICATED", "No Users administrator is stored for this environment on this machine; nothing was sent.", false);
        return stored;
    }
    private async Task<JsonObject> ConfirmSignIn(string host, CancellationToken token)
    {
        await PublicHost(host, token);
        var stored = await StoredLogin(host, token);
        await Ask(host, new JsonArray(UsersPage.RowOf("Environment", host), UsersPage.RowOf("Signed in as", Word(stored["principal"]) ?? ""), UsersPage.RowOf("What will happen", "Sign in to the Users application of this environment")), token);
        lock (sync) consents[host] = Now().AddHours(8);
        return new JsonObject { ["approved"] = true };
    }
    private async Task<JsonObject> Prompt(string host, JsonObject p, CancellationToken token)
    {
        var kind = Word(p["kind"]) ?? "login";
        var key = host + "|" + kind + "|" + (Word(p["entry"]) ?? "");
        Settle();
        lock (sync)
            if (prompts.ContainsKey(key)) return new JsonObject { ["opened"] = false, ["alreadyOpen"] = true };
        var subject = "";
        var rows = new JsonArray();
        if (kind == "password")
        {
            if (Word(p["action"]) == "set-password")
            {
                // Who this is comes from the environment's own page of that id, never from the request.
                var html = await ReadPage(host, UsersPage.UserPage(Word(p["userId"])!), token);
                var plan = UsersPage.PlanWrite("set-password", host, Word(p["userId"]), null, null, [html]);
                subject = plan.Username ?? "";
                rows = plan.Rows;
            }
            else
            {
                subject = Word(p["changes"]?["username"]) ?? "";
                rows.Add((JsonNode)UsersPage.RowOf("What will happen", UsersPage.ActionText["create"]));
                foreach (var (name, value) in p["changes"]!.AsObject()) rows.Add((JsonNode)UsersPage.RowOf("New " + name, Word(value)));
            }
        }
        TakeWindow();
        Directory.CreateDirectory(promptDir);
        if (kind == "password") File.WriteAllText(pendingFile, "");
        var status = Path.Combine(promptDir, "prompt-" + Guid.NewGuid().ToString("N") + ".status");
        var start = Start(true, "prompt", host, p, false, ["-Subject", subject, "-Rows", Convert.ToBase64String(Encoding.UTF8.GetBytes(rows.ToJsonString())), "-PromptStatusPath", status]);
        Process process;
        try { process = Process.Start(start) ?? throw new IOException("no helper"); }
        catch (Exception e) when (e is IOException or System.ComponentModel.Win32Exception) { throw new AgentFault("USERS_PROMPT_NOT_VISIBLE", "The private window could not be confirmed visible.", null); }
        var record = new OpenPrompt { Child = process, StatusFile = status, Host = host, Kind = kind, Entry = Word(p["entry"]), Action = Word(p["action"]), UserId = Word(p["userId"]), Changes = ChangesKey(p["changes"]) };
        lock (sync) prompts[key] = record;
        // The status file stays until the window closes: it says saved only then.
        process.EnableRaisingEvents = true;
        process.Exited += (_, _) => Settle();
        // A window that was shown counts, even if it has already closed by the time this looks.
        for (var waited = 0; waited < PromptWaitMs; waited += 100)
        {
            Settle();
            if (record.Phase is "visible" or "saved")
            {
                var answer = new JsonObject { ["opened"] = true, ["alreadyOpen"] = false, ["visible"] = true };
                if (record.Phase == "saved") answer["saved"] = true;
                return answer;
            }
            if (process.HasExited) break;
            await Task.Delay(100, token);
        }
        lock (sync) prompts.Remove(key);
        try { File.Delete(status); } catch (IOException) { }
        throw new AgentFault("USERS_PROMPT_NOT_VISIBLE", "The private window could not be confirmed visible.", null);
    }
    private sealed record Answer(JsonNode? Status, string Location, string ContentType, string Body, string Html)
    {
        public JsonObject Json() => new() { ["status"] = Status?.DeepClone(), ["location"] = Location, ["contentType"] = ContentType, ["body"] = Body };
    }
    // One request of this agent, with this agent's session. A page that asks to sign in again ends that session.
    private async Task<Answer> Send(string host, string url, string method, IEnumerable<KeyValuePair<string, string>>? fields, JsonArray? secretRefs, CancellationToken token)
    {
        var pairs = new JsonArray();
        foreach (var (name, value) in fields ?? []) pairs.Add((JsonNode)new JsonArray(name, value));
        var request = new JsonObject { ["url"] = url, ["method"] = method, ["fields"] = pairs, ["secretRefs"] = secretRefs ?? [], ["cookie"] = CookieHeader(host) };
        var input = Convert.ToBase64String(Encoding.UTF8.GetBytes(request.ToJsonString()));
        var page = await Call("request", host, new JsonObject(), input, method == "POST" ? null : false, token);
        var body = Word(page["body"]) ?? "";
        // A larger answer would go through the server's disk as a blob, and stop the server that reads it.
        if (body.Length > MaxPageBase64) throw new AgentFault("USERS_PAGE_TOO_LARGE", "This page is larger than a Users page can be; it was not read.", method == "POST" ? null : false);
        StoreCookies(host, page["setCookie"]);
        var html = Encoding.UTF8.GetString(Convert.FromBase64String(body));
        if (UsersPage.IsLoginPage(html)) lock (sync) { jars.Remove(host); unproven.Remove(host); }
        else if (page["status"] is JsonValue code && code.TryGetValue<int>(out var number) && number == 200)
            lock (sync) if (unproven.Remove(host)) SetFailures(host, 0);
        return new Answer(page["status"], Word(page["location"]) ?? "", Word(page["contentType"]) ?? "", body, html);
    }
    private async Task<string> ReadPage(string host, string route, CancellationToken token)
    {
        var page = await Send(host, "https://" + host + route, "GET", null, null, token);
        if (!(page.Status is JsonValue code && code.TryGetValue<int>(out var number) && number == 200) || UsersPage.IsLoginPage(page.Html)) throw UsersPage.Unknown(route);
        return page.Html;
    }
    private static JsonArray SecretRefs(IEnumerable<string> fields, string? entry) => new(fields.Select(field => (JsonNode?)new JsonObject { ["field"] = field, ["kind"] = "password", ["entry"] = entry, ["part"] = "password" }).ToArray());
    // The operation as this agent will send it. The window comes from this same plan.
    private async Task<JsonObject> WriteOp(string host, JsonObject p, CancellationToken token)
    {
        var action = Word(p["action"])!;
        var userId = Word(p["userId"]);
        var entry = Word(p["entry"]);
        NeedConsent(host);
        NotPaused(host);
        await PublicHost(host, token);
        var passwordOp = action is "create" or "set-password";
        if (passwordOp) { UsePermit(host, action, userId, p["changes"], entry!); lock (sync) writing++; }
        // From here a new password has had its one chance: it leaves the vault however this ends.
        var pending = passwordOp;
        try
        {
            var stored = passwordOp ? null : await StoredLogin(host, token);
            var pages = new List<string>();
            foreach (var route in UsersPage.RoutesOf(action, userId, Word(p["targetId"]))) pages.Add(await ReadPage(host, route, token));
            var plan = UsersPage.PlanWrite(action, host, userId, Word(p["targetId"]), p["changes"] as JsonObject, pages);
            if (action == "deactivate" && Word(stored?["principal"]) is { Length: > 0 } principal && string.Equals(plan.Username, principal, StringComparison.OrdinalIgnoreCase))
                throw new AgentFault("USERS_SELF_LOCKOUT_REFUSED", "The administrator signed in here cannot be deactivated from here.", false);
            if (!passwordOp)
            {
                var rows = new JsonArray(UsersPage.RowOf("Environment", host), UsersPage.RowOf("Signed in as", Word(stored!["principal"]) ?? ""));
                foreach (var row in plan.Rows) rows.Add(row?.DeepClone());
                await Ask(host, rows, token);
            }
            Answer answer;
            if (action == "set-password")
            {
                var shown = await Send(host, plan.Url, "POST", plan.Fields, null, token);
                // The button has gone, so from here nothing can say that nothing was sent.
                UsersPage.Plan save;
                try { save = UsersPage.PlanSavePassword(host, userId!, pages[0], shown.Html); }
                catch (AgentFault) { throw new AgentFault("USERS_PASSWORD_FORM_NOT_KNOWN", "The Set Password button was sent, but what came back is not the password form this agent knows. The new password was not sent.", null); }
                answer = await Send(host, save.Url, "POST", save.Fields, SecretRefs(save.SecretFields, entry), token);
            }
            else answer = await Send(host, plan.Url, "POST", plan.Fields, passwordOp ? SecretRefs(plan.SecretFields, entry) : null, token);
            var value = answer.Json();
            if (passwordOp) { pending = false; lock (sync) writing--; value["passwordForgotten"] = await Forget(host, entry!); }
            return value;
        }
        finally { if (pending) { lock (sync) writing--; await Forget(host, entry!); } }
    }
    private async Task<bool> Forget(string host, string entry)
    {
        lock (sync) permits.RemoveAll(item => item.Host == host && item.Entry == entry);
        try { await Call("forget", host, new JsonObject { ["kind"] = "password", ["entry"] = entry }, "", false, CancellationToken.None); }
        catch (AgentFault) { lock (sync) forgetFailed = true; return false; }
        ClearPending();
        return true;
    }

    internal async Task<JsonNode?> Execute(JsonObject p, CancellationToken token)
    {
        if (!OperatingSystem.IsWindows() && !ForceWindows) throw new AgentFault("USERS_PLATFORM_UNAVAILABLE", "Users administration is not available on this platform.", false);
        Validate(p);
        await Startup();
        Settle();
        List<Permit> due;
        lock (sync) due = permits.Where(item => item.Until <= Now()).ToList();
        foreach (var permit in due) await Expire(permit);
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
                SetFailures(host, 0);
                await Call("sign-out", host, new JsonObject(), "", false, token);
                ClearPending();
                return new JsonObject { ["signedOut"] = true };
            case "confirm":
                return await ConfirmSignIn(host, token);
            case "forget":
                if (!await Forget(host, Word(p["entry"])!)) throw new AgentFault("USERS_PRIVATE_REQUEST_FAILED", "The private Users request failed; no automatic retry.", false);
                return new JsonObject();
            case "prompt":
                await PublicHost(host, token);
                if ((Word(p["kind"]) ?? "login") == "login")
                {
                    // The person decides on a window; a name built to pass for an approved one never gets a window.
                    var hosts = await Call("hosts", host, new JsonObject(), "", false, token);
                    if (LookalikeOf(host, (hosts["hosts"] as JsonArray ?? []).Select(item => Word(item) ?? "").Where(item => item.Length > 0)) != null)
                        throw new AgentFault("USERS_HOST_LOOKALIKE", "This name reads like an environment already approved on this machine, so no window was opened and nothing was sent. If it really is another environment, sign out of the other one first.", false);
                    lock (sync) jars.Remove(host);
                }
                else await StoredLogin(host, token);
                return await Prompt(host, p, token);
        }
        NeedConsent(host);
        NotPaused(host);
        if (op == "write") return await WriteOp(host, p, token);
        await PublicHost(host, token);
        if (op == "login")
        {
            TakeLoginTry(host);
            JsonObject signed;
            // Only a helper that says it sent nothing gives the try back.
            try { signed = await Call("login", host, new JsonObject(), "", null, token); }
            catch (AgentFault e) when (e.Executed == false) { lock (sync) SetFailures(host, Math.Max(0, FailuresOf(host) - 1)); throw; }
            StoreCookies(host, signed["setCookie"]);
            var authenticated = signed["authenticated"]?.GetValue<bool>() == true;
            if (authenticated) lock (sync) unproven.Add(host);
            return new JsonObject { ["authenticated"] = authenticated };
        }
        if (op == "request") return (await Send(host, Word(p["url"])!, "GET", null, null, token)).Json();
        var inactive = p["inactive"] is JsonValue flag && flag.TryGetValue<bool>(out var chosen) && chosen;
        var route = "/Users/" + (inactive ? "Inactive_Users" : "User_List") + ".aspx";
        var search = UsersPage.PlanSearch(host, inactive, Word(p["text"]) ?? "", await ReadPage(host, route, token));
        return (await Send(host, search.Url, "POST", search.Fields, null, token)).Json();
    }
}
