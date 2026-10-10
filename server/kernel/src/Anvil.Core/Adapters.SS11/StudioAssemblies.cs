using System.Runtime.Loader;

namespace Anvil.Core;

/// <summary>
/// Liga o processo a uma instalacao do Service Studio SEM copiar DLLs.
/// Chamar UMA vez, antes de tocar em qualquer tipo do Studio.
///
/// Por que dois mecanismos: o AssemblyLoader do Studio monta caminhos a partir do
/// base directory do processo (ServiceStudio.Common:515) para BuiltInBehaviors,
/// Presenter, Model.Implementation.* e plugins; tudo o mais resolve por nome via
/// AssemblyLoadContext.Resolving.
/// </summary>
public static class StudioAssemblies
{
    private static string? _dir;

    public static string Directory => _dir ?? throw new InvalidOperationException("StudioAssemblies.Bind was not called");

    public static string DefaultDirectory =>
        Environment.GetEnvironmentVariable("ANVIL_STUDIO_DIR")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "OutSystems", "Service Studio 11 - Anvil 4516", "Service Studio");

    public static void Bind(string? studioDirectory = null)
    {
        var dir = studioDirectory ?? DefaultDirectory;
        if (_dir != null)
        {
            if (!string.Equals(_dir, dir, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"already bound to {_dir}");
            return;
        }
        if (!File.Exists(Path.Combine(dir, "ServiceStudio.Framework.dll")))
            throw new DirectoryNotFoundException($"not a Service Studio directory: {dir}");
        _dir = dir;
        AppDomain.CurrentDomain.SetData("APP_CONTEXT_BASE_DIRECTORY", dir);
        Func<AssemblyLoadContext, System.Reflection.AssemblyName, System.Reflection.Assembly?> resolver = (ctx, name) =>
        {
            var candidate = Path.Combine(dir, name.Name + ".dll");
            return File.Exists(candidate) ? ctx.LoadFromAssemblyPath(candidate) : null;
        };
        AssemblyLoadContext.Default.Resolving += resolver;
        // hosts de teste (xunit) carregam o codigo num contexto proprio: cobrir o contexto desta biblioteca tambem
        var own = AssemblyLoadContext.GetLoadContext(typeof(StudioAssemblies).Assembly);
        if (own != null && own != AssemblyLoadContext.Default) own.Resolving += resolver;
    }

    /// <summary>Versao do IDE que o handshake anuncia (a do Framework da instalacao).</summary>
    public static string IdeVersion =>
        System.Diagnostics.FileVersionInfo.GetVersionInfo(Path.Combine(Directory, "ServiceStudio.Framework.dll")).FileVersion
        ?? "11.55.69.64809";
}
