using System.Collections.Concurrent;
using System.Reflection;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>Cache immutable reflection metadata only. Never keeps a module or a model object alive.</summary>
internal static class ModelApiMetadata
{
    private static readonly ConcurrentDictionary<Assembly, Type[]> Exported = new();
    private static readonly ConcurrentDictionary<(string Name, int Assemblies), Type[]> Candidates = new();
    private static readonly ConcurrentDictionary<Type, MethodInfo[]> MethodsByType = new();
    private static readonly ConcurrentDictionary<(Type Parent, string Name, int Assemblies), (MethodInfo Method, bool Generic, Type Target)[]> CreatePlans = new();
    private static readonly ConcurrentDictionary<Type, PropertyInfo[]> PropertiesByType = new();

    private static Type[] PublicTypes(Assembly assembly)
    {
        // Do not cache failed loads: dependencies can become available later in the process.
        if (Exported.TryGetValue(assembly, out var types)) return types;
        try { types = assembly.GetExportedTypes(); Exported.TryAdd(assembly, types); return types; }
        catch { return []; }
    }

    public static Type[] Types(string name)
    {
        var assemblies = AppDomain.CurrentDomain.GetAssemblies();
        var key = (name, assemblies.Length);
        if (Candidates.TryGetValue(key, out var cached)) return cached;
        var result = Types(name, assemblies);
        // Misses are not retained; plugin dependencies may have failed to load on this attempt.
        if (result.Length > 0) Candidates.TryAdd(key, result);
        return result;
    }

    /// <summary>The interfaces named <paramref name="name"/> among <paramref name="assemblies"/> (the Model API first),
    /// else in the Studio's model plugins, uncached. NativeProbe passes the assemblies of a fresh `api --op native`
    /// process, so a type it answers late in a batch is looked up as a process of its own would.</summary>
    internal static Type[] Types(string name, IReadOnlyCollection<Assembly> assemblies)
    {
        var api = typeof(IESpace).Assembly;
        bool Match(Type t) => t.IsInterface && (t.Name == name || t.FullName == name);
        var found = PublicTypes(api).Where(Match).ToList();
        foreach (var assembly in assemblies.Where(a => !a.IsDynamic && a != api))
            found.AddRange(PublicTypes(assembly).Where(Match));
        if (found.Count == 0)
        {
            var root = StudioAdapter.Runtime.StudioDirectory;
            var plugins = Path.Combine(root, "Plugins");
            IEnumerable<string> files = Directory.Exists(plugins)
                ? Directory.EnumerateFiles(plugins, "ServiceStudio.Plugin.*.dll", SearchOption.AllDirectories)
                : Enumerable.Empty<string>();
            // ODC keeps the model plugins (REST, RESTService, SOAP, Widgets) beside the Studio executable; a job loads them
            // with the model, `api --op native` has no model and has to look there (catalog request C-001).
            if (Directory.Exists(root))
                files = files.Concat(Directory.EnumerateFiles(root, "OutSystems.Model.Plugin.*.dll", SearchOption.TopDirectoryOnly));
            foreach (var path in files)
                try
                {
                    var assembly = System.Runtime.Loader.AssemblyLoadContext.Default.LoadFromAssemblyPath(path);
                    found.AddRange(PublicTypes(assembly).Where(Match));
                }
                catch { }
        }
        return found.Distinct().ToArray();
    }

    private static string? aggregateColumnType;
    /// <summary>The interface of an aggregated (Count/Sum/Max/Min/Avg) aggregate column: IAggregateAttribute in Service
    /// Studio 11, IAggregatedAttribute in ODC Studio (same DisplayName). The O11 name is tried first, so the O11 lane never
    /// takes the plugin fallback; one process is one lane, so the answer is kept.</summary>
    public static string AggregateColumnType => aggregateColumnType ??=
        Types("IAggregateAttribute").Length > 0 ? "IAggregateAttribute" : "IAggregatedAttribute";

    public static IReadOnlyList<(MethodInfo Method, bool Generic, Type Target)> Creation(Type parent, string name,
        Func<List<(MethodInfo Method, bool Generic, Type Target)>> build)
        => CreatePlans.GetOrAdd((parent, name, AppDomain.CurrentDomain.GetAssemblies().Length), _ => build().ToArray());

    public static MethodInfo[] Methods(Type type) => MethodsByType.GetOrAdd(type, t =>
        t.GetInterfaces().Where(IsModelApi).SelectMany(i => i.GetMethods().Select(m => (Interface: i, Method: m)))
            .DistinctBy(x => x.Interface.FullName + "|" + x.Method.ToString()).Select(x => x.Method)
            .Concat(TraditionalWidgetMetadata.Methods(t)).ToArray());

    public static PropertyInfo[] Properties(Type type) => PropertiesByType.GetOrAdd(type, t =>
        t.GetInterfaces().Where(IsModelApi).SelectMany(i => i.GetProperties().Select(p => (Interface: i, Property: p)))
            .DistinctBy(x => x.Interface.FullName + "|" + x.Property.Name).Select(x => x.Property)
            .Concat(TraditionalWidgetMetadata.Properties(t)).ToArray());

    private static bool IsModelApi(Type type) => type.Namespace != null &&
        (type.Namespace.StartsWith("OutSystems.Model", StringComparison.Ordinal) || type.Namespace.StartsWith("ServiceStudio.Plugin", StringComparison.Ordinal));
}
