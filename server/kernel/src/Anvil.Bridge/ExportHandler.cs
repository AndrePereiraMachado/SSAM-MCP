using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Avalonia.Threading;
using OutSystems.Communication;
using OutSystems.Communication.ServiceCenter;
using ServiceStudio.Presenter;

namespace Anvil.Bridge;

/// <summary>
/// Exporta (SO LEITURA) os OMLs do ambiente ao qual o Studio esta ligado, com a sessao que o proprio Studio ja tem
/// (SSO incluido: o token nunca sai do processo). So ListApplications, ListEspaces e Download.
/// export_modules {out_dir, filter?, apps?, max?} inicia em segundo plano; export_status {out_dir} le o status.
/// </summary>
internal static class ExportHandler
{
    private static int _running;

    public static async Task<string> Start(JsonObject? p)
    {
        var outDir = p?["out_dir"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(outDir)) return Server.Fail("export_modules: 'out_dir' is required");
        var filter = p?["filter"]?.GetValue<string>();
        var apps = p?["apps"]?.GetValue<string>()?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var max = p?["max"]?.GetValue<int>() ?? int.MaxValue;
        if (Interlocked.CompareExchange(ref _running, 1, 0) != 0) return Server.Fail("export already running");

        object provider; object loginInfo;
        try
        {
            (provider, loginInfo) = await Ui.Run(() =>
            {
                var agg = Studio.ActiveAggregator() ?? throw new InvalidOperationException("no aggregator presenter: open the environment in the Studio first");
                object prov = agg.ServerCommunicationsProvider ?? throw new InvalidOperationException("no ServerCommunicationsProvider");
                object li = Studio.Prop(prov, "LoginInfo") ?? throw new InvalidOperationException("LoginInfo not available: log in to the environment in the Studio first");
                return (prov, li);
            }, UiGate.Read, "export_modules: read the login");
        }
        catch (Exception ex) { Interlocked.Exchange(ref _running, 0); return Server.Fail(Server.Unwrap(ex)); }

        var full = PathArgs.Absolute("export_modules", "out_dir", outDir);
        Directory.CreateDirectory(full);
        var user = Studio.Prop(loginInfo, "UserName") as string ?? "";
        var hostInfo = Studio.Prop(loginInfo, "HostInfo");
        var host = hostInfo?.ToString() ?? "?";
        var loginType = loginInfo.GetType().Name;
        WriteStatus(full, new JsonObject { ["state"] = "starting", ["host"] = host, ["user"] = user, ["loginType"] = loginType, ["startedAt"] = DateTime.Now.ToString("s") });
        _ = Task.Run(() =>
        {
            try { Run(provider, loginInfo, full, filter, apps, max, host, user, loginType); }
            catch (Exception ex) { WriteStatus(full, new JsonObject { ["state"] = "failed", ["error"] = Server.Unwrap(ex), ["host"] = host }); }
            finally { Interlocked.Exchange(ref _running, 0); }
        });
        return Server.Ok(new JsonObject { ["started"] = true, ["outDir"] = full, ["host"] = host, ["user"] = user, ["loginType"] = loginType, ["statusFile"] = Path.Combine(full, "export-status.json") });
    }

    public static string Status(JsonObject? p)
    {
        var outDir = p?["out_dir"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(outDir)) return Server.Fail("export_status: 'out_dir' is required");
        var f = Path.Combine(PathArgs.Absolute("export_status", "out_dir", outDir), "export-status.json");
        if (!File.Exists(f)) return Server.Fail("no status file yet: " + f);
        return Server.Ok(JsonNode.Parse(File.ReadAllText(f))?.AsObject());
    }

    private static void Run(object provider, object loginInfo, string outDir, string? filter, string[]? apps, int max, string host, string user, string loginType)
    {
        var sw = Stopwatch.StartNew();
        var secret = loginInfo.GetType().GetMethod("GetSecretForWebServiceRequest", Type.EmptyTypes)?.Invoke(loginInfo, null) as string
                     ?? throw new InvalidOperationException("GetSecretForWebServiceRequest not available");
        var sc = ServiceCenterApi(provider) ?? throw new InvalidOperationException("IServiceCenter not reachable from the provider");
        var appsArr = sc.ListApplications(user, secret, false);
        var modsArr = sc.ListEspaces(user, secret);
        var appList = appsArr.Select(a => Json.Project(a)).ToList();
        var modList = modsArr.Select(m => Json.Project(m)).ToList();
        File.WriteAllText(Path.Combine(outDir, "inventory.json"), new JsonObject
        {
            ["host"] = host, ["user"] = user, ["loginType"] = loginType, ["exportedAt"] = DateTime.Now.ToString("s"),
            ["applications"] = new JsonArray(appList.Select(x => (JsonNode)x).ToArray()), ["modules"] = new JsonArray(modList.Select(x => (JsonNode)x).ToArray()),
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));

        var appKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (apps is { Length: > 0 })
            foreach (var a in appsArr)
                if (apps.Any(x => string.Equals(x, a.Name, StringComparison.OrdinalIgnoreCase) || x == a.Key?.ToString())) appKeys.Add(a.Key?.ToString() ?? "");
        var selected = modsArr.Where(m =>
        {
            if (!string.IsNullOrEmpty(filter) && !(m.Name ?? "").Contains(filter, StringComparison.OrdinalIgnoreCase)) return false;
            if (appKeys.Count > 0 && !appKeys.Contains(m.ApplicationKey?.ToString() ?? "")) return false;
            return true;
        }).Take(max).ToList();

        var omlDir = Path.Combine(outDir, "oml"); Directory.CreateDirectory(omlDir);
        int done = 0, failed = 0; long bytes = 0; var results = new JsonArray();
        foreach (var m in selected)
        {
            var t = sw.ElapsedMilliseconds;
            try
            {
                var data = sc.Download(user, secret, m.VersionId, m.Key?.ToString() ?? "", CancellationToken.None, out _, out _, out _, out var message, out var success);
                if (data == null || data.Length == 0 || !success)
                {
                    failed++;
                    results.Add(new JsonObject { ["name"] = m.Name, ["versionId"] = m.VersionId, ["status"] = "empty", ["message"] = message?.ToString() });
                }
                else
                {
                    var file = Path.Combine(omlDir, SafeFileName(m.Name ?? "module") + ".oml");
                    File.WriteAllBytes(file, data); done++; bytes += data.Length;
                    results.Add(new JsonObject { ["name"] = m.Name, ["versionId"] = m.VersionId, ["bytes"] = data.Length, ["file"] = file, ["ms"] = sw.ElapsedMilliseconds - t });
                }
            }
            catch (Exception ex) { failed++; results.Add(new JsonObject { ["name"] = m.Name, ["versionId"] = m.VersionId, ["status"] = "failed", ["message"] = Server.Unwrap(ex) }); }
            if ((done + failed) % 5 == 0)
                WriteStatus(outDir, new JsonObject { ["state"] = "running", ["host"] = host, ["selected"] = selected.Count, ["done"] = done, ["failed"] = failed, ["bytes"] = bytes, ["elapsedMs"] = sw.ElapsedMilliseconds });
        }
        File.WriteAllText(Path.Combine(outDir, "downloads.json"), results.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        WriteStatus(outDir, new JsonObject { ["state"] = "done", ["host"] = host, ["applications"] = appList.Count, ["modules"] = modList.Count, ["selected"] = selected.Count, ["done"] = done, ["failed"] = failed, ["bytes"] = bytes, ["elapsedMs"] = sw.ElapsedMilliseconds });
    }

    /// <summary>IServiceCenter do provider (Studio.ServiceCenterApi, shared with the thin bridge).</summary>
    internal static IServiceCenter? ServiceCenterApi(object provider) => Studio.ServiceCenterApi(provider);

    private static void WriteStatus(string outDir, JsonObject status) { try { File.WriteAllText(Path.Combine(outDir, "export-status.json"), status.ToJsonString()); } catch { } }
    private static string SafeFileName(string name) { foreach (var ch in Path.GetInvalidFileNameChars()) name = name.Replace(ch, '_'); return name; }
}
