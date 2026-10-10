using System.Reflection;
using System.Runtime.Loader;

/// <summary>
/// Startup hook do .NET (DOTNET_STARTUP_HOOKS): roda antes do Main do Service Studio, so no processo iniciado por
/// scripts/open_studio_hook.ps1. Espera o app Avalonia subir e chama Anvil.Bridge.Server.Start(porta), o mesmo ponto de
/// entrada que o patch do clone chama em App.OnFrameworkInitializationCompleted.
/// Nunca lanca: uma falha aqui so deixa o Studio sem ponte e vai para %LOCALAPPDATA%\Anvil\startuphook-&lt;porta&gt;.log.
/// </summary>
internal static class StartupHook
{
    private static string log = "";

    public static void Initialize()
    {
        try
        {
            var portText = Environment.GetEnvironmentVariable("ANVIL_BRIDGE_PORT");
            var bridgeDir = Environment.GetEnvironmentVariable("ANVIL_BRIDGE_DIR");
            // Os filhos do Studio (compilador, crash handler, outro Studio) nao herdam o hook nem a configuracao.
            Environment.SetEnvironmentVariable("DOTNET_STARTUP_HOOKS", null);
            Environment.SetEnvironmentVariable("ANVIL_BRIDGE_PORT", null);
            Environment.SetEnvironmentVariable("ANVIL_BRIDGE_DIR", null);
            if (!int.TryParse(portText, out var port) || string.IsNullOrEmpty(bridgeDir) || !Directory.Exists(bridgeDir)) return;
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Anvil");
            Directory.CreateDirectory(dir);
            log = Path.Combine(dir, $"startuphook-{port}.log");
            Log($"hook loaded in pid {Environment.ProcessId}; bridge dir {bridgeDir}");
            // Nossas DLLs ficam fora da instalacao: so resolvem daqui quando o host nao tem o assembly (sem duplicar tipos do host).
            AssemblyLoadContext.Default.Resolving += (context, name) =>
            {
                var candidate = Path.Combine(bridgeDir, name.Name + ".dll");
                return File.Exists(candidate) ? context.LoadFromAssemblyPath(candidate) : null;
            };
            var thread = new Thread(() => StartWhenReady(port, bridgeDir)) { IsBackground = true, Name = "Anvil.StartupHook" };
            thread.Start();
        }
        catch (Exception ex) { Log("initialize failed: " + ex); }
    }

    private static void StartWhenReady(int port, string bridgeDir)
    {
        try
        {
            var deadline = DateTime.UtcNow.AddMinutes(5);
            while (DateTime.UtcNow < deadline)
            {
                if (ApplicationReady()) break;
                Thread.Sleep(500);
            }
            if (!ApplicationReady()) { Log("Avalonia application did not start in 5 minutes; bridge not started"); return; }
            Thread.Sleep(2000);   // deixa o OnFrameworkInitializationCompleted do Studio terminar
            var bridge = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(bridgeDir, "Anvil.Bridge.dll"));
            var start = bridge.GetType("Anvil.Bridge.Server", throwOnError: true)!.GetMethod("Start", BindingFlags.Public | BindingFlags.Static, new[] { typeof(int) })
                        ?? throw new MissingMethodException("Anvil.Bridge.Server.Start(int)");
            start.Invoke(null, new object[] { port });
            Log($"Anvil.Bridge.Server.Start({port}) called");
        }
        catch (Exception ex) { Log("start failed: " + ex); }
    }

    // Application.Current do Avalonia, lido por reflexao para o hook nao depender da versao do Studio.
    private static bool ApplicationReady()
    {
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (asm.GetName().Name != "Avalonia.Controls") continue;
            var app = asm.GetType("Avalonia.Application")?.GetProperty("Current", BindingFlags.Public | BindingFlags.Static)?.GetValue(null);
            return app != null;
        }
        return false;
    }

    private static void Log(string s)
    {
        try { if (log.Length > 0) File.AppendAllText(log, $"{DateTime.Now:HH:mm:ss.fff} {s}{Environment.NewLine}"); } catch { }
    }
}
