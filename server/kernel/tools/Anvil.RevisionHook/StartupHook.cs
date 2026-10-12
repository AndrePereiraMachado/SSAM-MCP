using System.Diagnostics;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text.Json;

// A separately named maintenance revision. Keeps loaded assemblies intact and
// shares exactly the verified Core/SDK instances; never installs a global resolver.
internal static class StartupHook
{
    private static int initialized;
    public static void Initialize()
    {
        if (Interlocked.Exchange(ref initialized, 1) != 0) return;
        new Thread(Attach) { IsBackground = true, Name = "Anvil.ServiceCenterRevision" }.Start();
    }
    private static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
    private static void Attach()
    {
        var hook = typeof(StartupHook).Assembly.Location;
        try {
            using var json = JsonDocument.Parse(File.ReadAllText(hook + ".json"));
            var config = json.RootElement;
            if (config.GetProperty("pid").GetInt32() != Environment.ProcessId
                || config.GetProperty("startedUtc").GetString() != Process.GetCurrentProcess().StartTime.ToUniversalTime().ToString("O"))
                throw new InvalidOperationException();
            var port = config.GetProperty("port").GetInt32();
            if (port < 1024 || port > 65535) throw new InvalidOperationException();
            var bridgePath = Path.GetFullPath(config.GetProperty("bridgePath").GetString()!);
            var hash = config.GetProperty("sha256").GetString();
            if (Hash(bridgePath) != hash) throw new InvalidOperationException();
            var loaded = AppDomain.CurrentDomain.GetAssemblies();
            var core = loaded.FirstOrDefault(a => a.GetName().Name == "Anvil.Core") ?? throw new InvalidOperationException();
            if (Hash(core.Location) != config.GetProperty("loadedCoreSha256").GetString()) throw new InvalidOperationException();
            var context = new Revision(loaded, hash!);
            var bridge = context.LoadFromAssemblyPath(bridgePath);
            bridge.GetType("Anvil.Bridge.Server", true)!.GetMethod("Start", new[] { typeof(int) })!.Invoke(null, new object[] { port });
            File.WriteAllText(hook + ".receipt.json", JsonSerializer.Serialize(new { ok = true, pid = Environment.ProcessId,
                port, bridgePath, isolatedRevision = hash, loadedCoreSha256 = Hash(core.Location) }));
        } catch {
            File.WriteAllText(hook + ".receipt.json", "{\"ok\":false,\"code\":\"REVISION_ATTACH_FAILED\"}");
        }
    }
    private sealed class Revision(Assembly[] shared, string hash) : AssemblyLoadContext("Anvil.ServiceCenter." + hash, false)
    {
        protected override Assembly? Load(AssemblyName name) => name.Name == "Anvil.Bridge" ? null
            : shared.FirstOrDefault(a => a.GetName().Name == name.Name && a.GetName().Version == name.Version);
    }
}
