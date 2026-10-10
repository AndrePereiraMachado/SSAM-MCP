using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>
/// The model plugins a module requires (its OML header's RequiredModelPlugins; MobileUI in the tenant's Mobile app
/// templates and in every app cloned from them) are binaries of the tenant: the ODC Studio downloads them
/// (AssetManagementService.GetAssetBinary, decompiled IModelPluginProvider) into its plugin cache,
/// &lt;PluginsDirectory&gt;\&lt;AssemblyName&gt;-&lt;Version&gt;.xif, whenever it opens or creates a module that needs one.
/// Headless, the Model API looks only next to the entry assembly and then raises ModelServices.ResolveModelPlugin; this
/// answers it from the Studio's cache: first the folders a caller named (the Studio's own PluginsDirectory, which the
/// bridge reports and create-app receives as --plugins-dir), then ANVIL_ODC_PLUGINS_DIR or
/// %LocalAppData%\OutSystems\ODC Studio\Plugins. The kernel registers it (OdcRuntime.Ensure) and so does ODC3.Builder,
/// whose reader serves ssam_map and studio_inspect (linked source). A plugin that cannot be loaded is refused in one line
/// that names it, the folders and what to do (<see cref="Refusal"/>).
/// </summary>
public static class OdcModelPlugins
{
    private static readonly object Gate = new();
    private static readonly List<string> Named = [];
    private static IModelServices? _registered;

    public static string CacheDirectory =>
        Environment.GetEnvironmentVariable("ANVIL_ODC_PLUGINS_DIR")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OutSystems", "ODC Studio", "Plugins");

    /// <summary>The folders searched, in order: the ones a caller named (the latest first), then <see cref="CacheDirectory"/>.</summary>
    public static IReadOnlyList<string> Directories
    {
        get { lock (Gate) return Named.Append(CacheDirectory).Distinct(StringComparer.OrdinalIgnoreCase).ToArray(); }
    }

    /// <summary>A folder searched before the others for the rest of the process: the Studio's PluginsDirectory.</summary>
    public static void AddDirectory(string directory)
    {
        var full = Path.GetFullPath(directory);
        lock (Gate)
        {
            Named.RemoveAll(d => string.Equals(d, full, StringComparison.OrdinalIgnoreCase));
            Named.Insert(0, full);
        }
    }

    /// <summary>The cached file of a plugin version, in the Studio's naming (AssemblyName-Version.xif), or null.</summary>
    public static string? Find(string assemblyName, Version version) =>
        Directories.Select(d => Path.Combine(d, assemblyName + "-" + version + ".xif")).FirstOrDefault(File.Exists);

    /// <summary>Answers ResolveModelPlugin once per ModelServices (the Model API keeps one per process).</summary>
    internal static void Register(IModelServices services)
    {
        lock (Gate)
        {
            if (ReferenceEquals(_registered, services)) return;
            _registered = services;
        }
        services.ResolveModelPlugin += (_, args) =>
            Find(args.PluginInformation.AssemblyName, args.PluginInformation.AssemblyVersion) is { } xif ? services.LoadModelPlugin(xif) : null;
    }

    /// <summary>The one-line refusal for a load or clone that failed on its required model plugins (the native message
    /// puts each plugin on a line of its own, and the facade shows only the first line), or null for any other failure.
    /// <paramref name="what"/> names what required them ("the template", "the module").</summary>
    public static OdcModelPluginMissingException? Refusal(Exception error, string what)
    {
        for (var e = error; e != null; e = e.InnerException)
            if (e is ESpace.MissingRequiredModelPluginsException missing)
                return new OdcModelPluginMissingException(what + " requires model plugins that could not be loaded from the ODC Studio's plugin cache ("
                    + string.Join("; ", Directories) + "): "
                    + string.Join(", ", missing.MissingPlugins.Select(p => p.Plugin.AssemblyName + " " + p.Plugin.AssemblyVersion + " (" + OneLine(p.Reason) + ")"))
                    + ". The ODC Studio downloads a model plugin into that cache when it opens an app that uses it: open any app built on it"
                    + " (a Mobile UI app for MobileUI) in the ODC Studio once, then repeat.");
        return null;
    }

    private static string OneLine(string? text) => string.Join(" ", (text ?? "").Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)).Trim();
}

/// <summary>A required model plugin is missing from the plugin folders (or cannot be loaded): nothing was written. The CLI
/// error envelope names the innermost exception's type, so this one carries no inner exception: the envelope names it,
/// which is how the facade tells it from other refusals (MODEL_PLUGIN_MISSING).</summary>
public sealed class OdcModelPluginMissingException(string message) : InvalidOperationException(message);
