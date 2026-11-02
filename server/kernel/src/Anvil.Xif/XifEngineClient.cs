using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

namespace Anvil.Xif;

/// <summary>
/// The kernel side of the Integration Studio engine (Anvil.Xif.Engine.exe, net472 x86): one process per stage, one JSON
/// request on stdin, one JSON answer on stdout, a private TEMP under the work folder, no login and no network. The engine is
/// looked for in ANVIL_XIF_ENGINE (a file), next to this assembly (xif-engine\), then in kernel\.local\xif-engine of the
/// checkout; absent: XIF_ENGINE_UNAVAILABLE with every place searched.
/// </summary>
public static class XifEngineClient
{
    public const string ExeName = "Anvil.Xif.Engine.exe";
    public static readonly TimeSpan Timeout = TimeSpan.FromMinutes(10);

    public static IReadOnlyList<string> Candidates()
    {
        var found = new List<string>();
        if (Environment.GetEnvironmentVariable("ANVIL_XIF_ENGINE") is { Length: > 0 } explicitFile) found.Add(explicitFile);
        found.Add(Path.Combine(XifCompiler.Home, "xif-engine", ExeName));
        for (var dir = new DirectoryInfo(XifCompiler.Home); dir != null; dir = dir.Parent)
            if (Directory.Exists(Path.Combine(dir.FullName, "kernel", "src")))
            {
                found.Add(Path.Combine(dir.FullName, "kernel", ".local", "xif-engine", ExeName));
                break;
            }
        return found;
    }

    /// <summary>Set to "1" by a hosted server (executor.mjs hostedSpawnEnv): the engine stages go to the user's SSAM agent,
    /// whose own Integration Studio runs them (kind o11.xif), through the O11 relay of that customer (ANVIL_BRIDGE_PORT, key
    /// ANVIL_AUTHORITY_DIR\bridge.key). No engine process runs on the server, whatever its system.</summary>
    public const string RelayVariable = "ANVIL_XIF_ENGINE_RELAY";
    /// <summary>The relay method the server's O11 relay routes to the agent kind o11.xif (o11-relay.mjs).</summary>
    public const string RelayMethod = "xif_engine";
    /// <summary>The engine's own limit, the mirror of the files both ways and a margin.</summary>
    public static readonly TimeSpan RelayTimeout = TimeSpan.FromMinutes(14);

    /// <summary>The engine of `anvil xif build`: the relay when the hosted server set RelayVariable, else the local process.</summary>
    public static XifBuild.EngineRunner Default => Select(Environment.GetEnvironmentVariable);

    public static XifBuild.EngineRunner Select(Func<string, string?> env)
    {
        if (env(RelayVariable) != "1") return Run;
        return (request, work) =>
        {
            if (!int.TryParse(env("ANVIL_BRIDGE_PORT"), out var port) || port < 1 || port > 65535)
                throw XifRefusal.Single(XifCodes.EngineUnavailable, "The relay to the user's SSAM agent has no port; nothing was generated or sent.", "Connect the user's Service Studio (ssam_connect {lane:\"o11\"}), then call again.");
            string key;
            try { key = File.ReadAllText(Path.Combine(env("ANVIL_AUTHORITY_DIR") ?? "", "bridge.key")).Trim(); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException)
            { throw XifRefusal.Single(XifCodes.EngineUnavailable, "The relay key of this account is missing; nothing was generated or sent.", "Connect the user's Service Studio again (ssam_connect {lane:\"o11\"})."); }
            return RunRelay(request, port, key, RelayTimeout);
        };
    }

    /// <summary>One engine stage through the server's O11 relay: one line {method:"xif_engine", params:request, authorization}
    /// out, one engine answer back (the relay maps the server's files to the agent and the XIF back). The stage only writes
    /// local files on both sides, so a lost answer is a refusal to repeat, never an unknown outcome in the environment.</summary>
    public static JsonObject RunRelay(JsonObject request, int port, string key, TimeSpan timeout)
    {
        string? line;
        try
        {
            using var client = new System.Net.Sockets.TcpClient();
            if (!client.ConnectAsync(System.Net.IPAddress.Loopback, port).Wait(TimeSpan.FromSeconds(10)))
                throw new IOException("the relay did not accept the connection");
            client.ReceiveTimeout = (int)timeout.TotalMilliseconds; client.SendTimeout = 60000;
            using var stream = client.GetStream();
            var payload = new JsonObject { ["method"] = RelayMethod, ["params"] = request.DeepClone(), ["authorization"] = key }.ToJsonString() + "\n";
            stream.Write(Encoding.UTF8.GetBytes(payload));
            stream.Flush();
            using var reader = new StreamReader(stream, new UTF8Encoding(false));
            line = reader.ReadLine();
        }
        catch (Exception error) when (error is IOException or System.Net.Sockets.SocketException or AggregateException or ObjectDisposedException)
        {
            throw XifRefusal.Single(XifCodes.EngineUnavailable, "The user's SSAM agent did not answer the Integration Studio stage (" + Clip(error.Message) + "); nothing was sent to the environment.",
                "Run the same call again; the stage works only on local files.");
        }
        JsonObject? answer = null;
        try { answer = string.IsNullOrWhiteSpace(line) ? null : JsonNode.Parse(line) as JsonObject; } catch (System.Text.Json.JsonException) { }
        if (answer == null)
            throw XifRefusal.Single(XifCodes.EngineUnavailable, "The user's SSAM agent answered nothing readable for the Integration Studio stage; nothing was sent to the environment.",
                "Run the same call again; the stage works only on local files.");
        // The relay's own refusal (the key, a call never delivered): {success:false, executed:false, error:"CODE: text"}.
        if (answer["ok"] == null && answer["success"]?.GetValue<bool>() == false)
        {
            var text = answer["error"]?.ToString() ?? "refused";
            var code = System.Text.RegularExpressions.Regex.Match(text, "^([A-Z][A-Z0-9_]{2,60}): ").Groups[1].Value;
            throw XifRefusal.Single(code.Length > 0 ? code : XifCodes.EngineUnavailable, "The Integration Studio stage did not reach the user's SSAM agent: " + Clip(text) + "; nothing was sent to the environment.",
                "Connect the SSAM agent and the user's Service Studio, then call again.");
        }
        return Answered(answer);
    }

    public static JsonObject Run(JsonObject request, string work)
    {
        var candidates = Candidates();
        var exe = candidates.FirstOrDefault(File.Exists);
        if (exe == null)
            throw new XifRefusal(XifCodes.EngineUnavailable, "The Integration Studio engine host (Anvil.Xif.Engine.exe) is not built on this machine; nothing was generated or sent.",
                [new XifProblem(XifCodes.EngineUnavailable, null, "Anvil.Xif.Engine.exe was not found.", "Run scripts\\setup-dev.ps1 (it builds the engine when Integration Studio is installed) or set ANVIL_XIF_ENGINE.",
                    Detail: new JsonObject { ["searched"] = new JsonArray(candidates.Select(c => (JsonNode)JsonValue.Create(c)!).ToArray()) })]);
        var temp = Path.Combine(work, "engine-temp");
        Directory.CreateDirectory(temp);
        var start = new ProcessStartInfo(exe)
        {
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
            WorkingDirectory = work, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        start.Environment["TEMP"] = temp; start.Environment["TMP"] = temp;
        using var process = Process.Start(start) ?? throw XifRefusal.Single(XifCodes.EngineUnavailable, "The engine process did not start.", "Run scripts\\setup-dev.ps1 again.");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        using (var input = new StreamWriter(process.StandardInput.BaseStream, new UTF8Encoding(false))) input.Write(request.ToJsonString());
        if (!process.WaitForExit((int)Timeout.TotalMilliseconds))
        {
            try { process.Kill(true); } catch (InvalidOperationException) { }
            throw XifRefusal.Single(XifCodes.EngineUnavailable, $"The engine did not answer within {Timeout.TotalMinutes} minutes; nothing was sent.", "Run the same call again; the engine works only on local files.");
        }
        var line = output.Result.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.StartsWith('{'));
        JsonObject? answer = null;
        try { answer = line == null ? null : JsonNode.Parse(line) as JsonObject; } catch (System.Text.Json.JsonException) { }
        if (answer == null)
            throw XifRefusal.Single(XifCodes.EngineUnavailable, "The engine answered nothing readable (" + Clip(error.Result) + ").", "Run scripts\\setup-dev.ps1 again; check that Integration Studio is installed.");
        return Answered(answer);
    }

    /// <summary>An engine answer, local or relayed: ok as it is, else the refusal with every problem it names.</summary>
    private static JsonObject Answered(JsonObject answer)
    {
        if (answer["ok"]?.GetValue<bool>() != true)
        {
            var code = answer["code"]?.ToString() ?? XifCodes.EngineUnavailable;
            var problems = (answer["problems"] as JsonArray)?.OfType<JsonObject>().Select(p => new XifProblem(p["code"]?.ToString() ?? code, p["path"]?.ToString(),
                p["message"]?.ToString() ?? "", p["fix"]?.ToString(), Detail: Without(p, "code", "path", "message", "fix"))).ToList()
                ?? [new XifProblem(code, null, answer["error"]?.ToString() ?? "engine failure", null)];
            throw new XifRefusal(code, answer["error"]?.ToString() ?? code, problems, Without(answer, "ok", "code", "error", "problems"));
        }
        return answer;
    }

    private static JsonObject? Without(JsonObject source, params string[] names)
    {
        var o = new JsonObject();
        foreach (var (name, value) in source) if (!names.Contains(name)) o[name] = value?.DeepClone();
        return o.Count == 0 ? null : o;
    }

    private static string Clip(string text) => text.Length > 300 ? text[..300] : text.Trim();
}
