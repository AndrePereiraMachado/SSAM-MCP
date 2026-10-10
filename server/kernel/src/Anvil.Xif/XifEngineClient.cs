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
