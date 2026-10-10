using System.Diagnostics;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;

// Applied to an ALREADY RUNNING Studio through DiagnosticsClient.ApplyStartupHookAsync.
// No model, window, login, save, publication or validation API is called here.
internal static class StartupHook
{
    private static int initialized;
    public static void Initialize()
    {
        if (Interlocked.Exchange(ref initialized, 1) != 0) return;
        // Return to the runtime diagnostics thread immediately. Assembly loading and
        // initialization belong on a managed background thread, never on its IPC loop.
        try
        {
            new Thread(() =>
            {
                try { Connect(); }
                catch (Exception error) { WriteFailure(error); }
            }) { IsBackground = true, Name = "Anvil.RuntimeConnect" }.Start();
        }
        catch (Exception error) { WriteFailure(error); }
    }

    private static void WriteFailure(Exception error)
    {
        try { File.WriteAllText(typeof(StartupHook).Assembly.Location + ".failure.txt", error.ToString()); } catch { }
    }

    private static void Connect()
    {
        var hook = typeof(StartupHook).Assembly.Location;
        var receipt = hook + ".receipt.json";
        try
        {
            File.WriteAllText(hook + ".started", Environment.ProcessId.ToString());
            using var document = JsonDocument.Parse(File.ReadAllText(hook + ".json"));
            var config = document.RootElement;
            if (config.GetProperty("pid").GetInt32() != Environment.ProcessId ||
                config.GetProperty("startedUtc").GetString() != Process.GetCurrentProcess().StartTime.ToUniversalTime().ToString("O"))
                throw new InvalidOperationException("Hook target does not match this process.");
            var port = config.GetProperty("port").GetInt32();
            if (port < 1024 || port > 65535) throw new InvalidOperationException("Invalid bridge port.");
            var bridgePath = Path.GetFullPath(config.GetProperty("bridgePath").GetString()!);
            var directory = Path.GetDirectoryName(bridgePath)!;
            var assemblies = AppDomain.CurrentDomain.GetAssemblies();
            var existing = assemblies.FirstOrDefault(a => a.GetName().Name == "Anvil.Bridge");
            if (existing != null && !string.Equals(existing.Location, bridgePath, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Anvil.Bridge is already loaded from another path; it will not be replaced.");
            var existingCore = assemblies.FirstOrDefault(a => a.GetName().Name == "Anvil.Core");
            if (existing == null && existingCore != null)
                throw new InvalidOperationException("Anvil.Core is already loaded without its bridge. Loading another version is refused.");
            if (existing == null)
            {
                // Only our assemblies resolve here; the Studio retains its native dependency resolution.
                AssemblyLoadContext.Default.Resolving += (context, name) =>
                {
                    if (!(name.Name?.StartsWith("Anvil.", StringComparison.Ordinal) == true || name.Name == "Esprima")) return null;
                    var file = Path.Combine(directory, name.Name + ".dll");
                    return File.Exists(file) ? context.LoadFromAssemblyPath(file) : null;
                };
                // Local controller authority, not an OutSystems credential. Existing bridges keep their authority.
                Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", config.GetProperty("authorityDir").GetString());
            }
            var bridge = existing ?? AssemblyLoadContext.Default.LoadFromAssemblyPath(bridgePath);
            var start = bridge.GetType("Anvil.Bridge.Server", true)!.GetMethod("Start", new[] { typeof(int) })
                ?? throw new MissingMethodException("Anvil.Bridge.Server.Start(int)");
            start.Invoke(null, new object[] { port });
            File.WriteAllText(receipt, JsonSerializer.Serialize(new { ok = true, pid = Environment.ProcessId, port, bridgePath }));
        }
        catch (Exception error)
        {
            while (error is TargetInvocationException { InnerException: not null }) error = error.InnerException;
            try { File.WriteAllText(receipt, JsonSerializer.Serialize(new { ok = false, error = error.Message })); } catch { }
            // Never propagate a connector failure into the developer's Studio.
        }
    }
}
