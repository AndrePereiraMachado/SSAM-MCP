using System.Runtime.Loader;

namespace Anvil.Core;

/// <summary>
/// Binds the process to an ODC Studio installation without copying DLLs (the ODC counterpart of StudioAssemblies):
/// every assembly the kernel references resolves by name from the installation directory. Call once, before
/// touching any Studio type. ANVIL_ODC_STUDIO_DIR overrides the default installation path.
/// </summary>
public static class StudioAssembliesOdc
{
    private static string? _dir;

    public static string Directory => _dir ?? throw new InvalidOperationException("StudioAssembliesOdc.Bind was not called");

    public static string DefaultDirectory =>
        Environment.GetEnvironmentVariable("ANVIL_ODC_STUDIO_DIR")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "OutSystems", "ODC Studio", "ODC Studio");

    public static void Bind(string? studioDirectory = null)
    {
        var dir = studioDirectory ?? DefaultDirectory;
        if (_dir != null)
        {
            if (!string.Equals(_dir, dir, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"already bound to {_dir}");
            return;
        }
        if (!File.Exists(Path.Combine(dir, "OutSystems.ModelAPILoader.dll")))
            throw new DirectoryNotFoundException($"not an ODC Studio directory: {dir}");
        _dir = dir;
        Func<AssemblyLoadContext, System.Reflection.AssemblyName, System.Reflection.Assembly?> resolver = (ctx, name) =>
        {
            var candidate = Path.Combine(dir, name.Name + ".dll");
            return File.Exists(candidate) ? ctx.LoadFromAssemblyPath(candidate) : null;
        };
        AssemblyLoadContext.Default.Resolving += resolver;
        var own = AssemblyLoadContext.GetLoadContext(typeof(StudioAssembliesOdc).Assembly);
        if (own != null && own != AssemblyLoadContext.Default) own.Resolving += resolver;
        // The Reactive widgets plugin (namespace ServiceStudio.Plugin.NRWidgets, e.g. the IExpression widget) is a plain
        // assembly of the ODC install, not a Plugins\ folder as in SS11. Load it now so the kernel's type catalog
        // (ModelApiMetadata.Types) sees the widget interfaces before the first create.
        var widgets = Path.Combine(dir, "OutSystems.Model.Plugin.NRWidgets.dll");
        if (File.Exists(widgets)) (own ?? AssemblyLoadContext.Default).LoadFromAssemblyPath(widgets);
    }

    /// <summary>Version of the installed ODC Studio (file version of ODCStudio.exe, else of the Framework).</summary>
    public static string IdeVersion
    {
        get
        {
            var exe = Path.Combine(Directory, "ODCStudio.exe");
            var file = File.Exists(exe) ? exe : Path.Combine(Directory, "ServiceStudio.Framework.dll");
            return System.Diagnostics.FileVersionInfo.GetVersionInfo(file).FileVersion ?? "odc";
        }
    }
}
