using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Bridge;

/// <summary>
/// Servidor TCP JSON-lines dentro do Studio. Pedido: {"method": "...", "params": {...}}\n
/// Resposta: {"success": bool, "data": {...}, "error": "..."}\n. Uma conexao por cliente, pedidos em serie.
/// Nunca lanca no arranque do Studio: qualquer falha vai para %LOCALAPPDATA%\Anvil\bridge-<porta>.log.
/// Thin bridge: the same server as the full bridge, with the local credential read by Authority.
/// </summary>
public static class Server
{
    public static string SessionId { get; } = Guid.NewGuid().ToString("N");
    internal static string StateDirectory { get; private set; } = "";
    /// <summary>b&lt;N&gt; when this assembly was loaded from studio\o11\bridge\b&lt;N&gt; of a release-layout pack (the release
    /// hook h1 loads only that folder, after checking every file against the signed manifest); null from bin\o11\bridge
    /// (the development hook). The hook waits for bridge_manifest with this id and the Studio pid.</summary>
    internal static string? BridgeId { get; } = Identify(typeof(Server).Assembly.Location);
    private static readonly Lazy<string?> fileSha256 = new(() =>
    {
        try { using var stream = File.OpenRead(typeof(Server).Assembly.Location); return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant(); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return null; }
    });
    private static TcpListener? _listener;
    private static string _log = "";
    private static string? credential;

    /// <summary>The bridge id of an assembly path: its folder name when it is b&lt;N&gt; (N from 1 to 9999), else null.</summary>
    internal static string? Identify(string? assemblyPath)
    {
        var folder = Path.GetFileName(Path.GetDirectoryName(assemblyPath ?? "") ?? "");
        return Regex.IsMatch(folder, "^b[1-9][0-9]{0,3}$", RegexOptions.CultureInvariant) ? folder : null;
    }

    /// <summary>sha256 (lowercase hex) of this assembly's own file, read once: the agent compares it with the pack.json
    /// entry of the bridge it attached (the version handshake). Null when the file cannot be read.</summary>
    internal static string? FileSha256 => fileSha256.Value;

    /// <summary>Ponto de entrada injetado em App.OnFrameworkInitializationCompleted (the dev hooks Anvil.RuntimeHook and
    /// Anvil.Inject): log under %LOCALAPPDATA%\Anvil, authority from ANVIL_AUTHORITY_DIR (process, then HKCU) or
    /// %LOCALAPPDATA%\Anvil\authority.</summary>
    public static void Start(int port) => Start(port, null, null);

    /// <summary>The release hook's entry point, Start(int, string, string): the log folder and the authority come by
    /// parameter (absolute); empty means the default of Start(int). Given both, nothing is read from the process
    /// environment or LocalAppData. Anvil.Hook.h1 calls it with the agent's private folders (request-b1.json).</summary>
    public static void Start(int port, string? dataDir, string? authorityDir)
    {
        try
        {
            var dir = string.IsNullOrWhiteSpace(dataDir) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Anvil")
                : Path.IsPathFullyQualified(dataDir) ? Path.GetFullPath(dataDir) : throw new InvalidOperationException("dataDir must be an absolute path");
            Directory.CreateDirectory(dir);
            _log = Path.Combine(dir, $"bridge-{port}.log");
            var authority = Authority.ResolveDirectory(authorityDir);
            Authority.Initialize(authority);
            credential = Authority.ReadCredential(authority);
            StateDirectory = Path.Combine(authority, "operations");
            Log($"start requested on {port} (pid {Environment.ProcessId}, bridge {BridgeId ?? "-"})");
            _ = Task.Run(() => Listen(port));
        }
        catch (Exception ex) { try { Log("start failed: " + ex); } catch { } }
    }

    private static async Task Listen(int port)
    {
        try
        {
            _listener = new TcpListener(IPAddress.Loopback, port);
            _listener.Start();
            Log($"listening on {port}");
            while (true)
            {
                var client = await _listener.AcceptTcpClientAsync();
                _ = Task.Run(() => Serve(client));
            }
        }
        catch (Exception ex) { Log("listener failed: " + ex); }
    }

    private static async Task Serve(TcpClient client)
    {
        using (client)
        {
            client.NoDelay = true;
            using var stream = client.GetStream();
            using var reader = new StreamReader(stream, new UTF8Encoding(false));
            using var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
            while (true)
            {
                string? line;
                try { line = await reader.ReadLineAsync(); } catch { break; }
                if (line == null) break;
                if (string.IsNullOrWhiteSpace(line)) continue;
                string response;
                var sw = System.Diagnostics.Stopwatch.StartNew();
                string method = "?";
                var dispatched = false;
                // UI freeze of 2026-10-08 (UiGate.cs, as the full bridge): a step the busy UI thread did not run answers UI_BUSY.
                var scope = UiGate.BeginRequest();
                try
                {
                    var req = JsonNode.Parse(line)?.AsObject() ?? throw new InvalidOperationException("request is not a JSON object");
                    method = req["method"]?.GetValue<string>() ?? throw new InvalidOperationException("missing method");
                    if (method is not ("ping" or "bridge_manifest")) Authority.Require(req, credential);
                    var p = req["params"]?.AsObject();
                    dispatched = true;
                    response = await Dispatch.Handle(method, p);
                }
                catch (UiBusyException busy) { response = UiGate.Reply(busy, scope.Dispatched); }
                catch (Exception ex) { response = dispatched ? Fail(Unwrap(ex)) : NotExecuted(Unwrap(ex)); }
                // A handler that turned a UI_BUSY into a plain failure still answers the code.
                if (scope.Busy is { } seen && IsPlainFailure(response)) response = UiGate.Reply(seen, scope.Dispatched);
                // Environment and Service Center answers carry business data: only their size goes to the log.
                Log(method is "environment_session" or "sc_api" or "sc_web" or "sc_session" or "studio_login"
                    ? $"{method} {sw.ElapsedMilliseconds} ms responseBytes={Encoding.UTF8.GetByteCount(response)}"
                    : $"{method} {sw.ElapsedMilliseconds} ms {(response.Length > 4000 ? response[..4000] : response)}");
                try { await writer.WriteLineAsync(response); } catch { break; }
            }
        }
    }

    public static string Ok(JsonNode? data) => new JsonObject { ["success"] = true, ["data"] = data, ["error"] = null }.ToJsonString();
    public static string NotExecuted(string error) => new JsonObject { ["success"] = false, ["data"] = null, ["error"] = error, ["executed"] = false }.ToJsonString();
    public static string Fail(string error) => new JsonObject { ["success"] = false, ["data"] = null, ["error"] = error }.ToJsonString();

    // success:false without a code of its own (a handler's Fail text).
    private static bool IsPlainFailure(string response)
    {
        try { var reply = JsonNode.Parse(response)?.AsObject(); return reply?["success"]?.GetValue<bool>() == false && reply["code"] == null; }
        catch { return false; }
    }

    public static string Unwrap(Exception ex)
    {
        while (ex is System.Reflection.TargetInvocationException { InnerException: not null } tie) ex = tie.InnerException!;
        while (ex is AggregateException { InnerException: not null } ae) ex = ae.InnerException!;
        return ex.GetType().Name + ": " + ex.Message;
    }

    public static void Log(string s)
    {
        try { File.AppendAllText(_log, $"{DateTime.Now:HH:mm:ss.fff} {s}{Environment.NewLine}"); } catch { }
    }
}
