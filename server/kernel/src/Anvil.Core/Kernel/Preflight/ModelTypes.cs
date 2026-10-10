using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core.Preflight;

/// <summary>One property of a Model API interface as the preflight judges a `set`: its declared type, whether it is
/// writable, whether it holds an expression (written through expression.Text) and, for an enum, its values.</summary>
public sealed record PropertyFact(string Name, string Type, bool CanWrite, bool IsExpression, string[]? EnumValues);

/// <summary>What a `set` can write on a type: the properties of every interface the name denotes (short names exist in
/// more than one namespace) and of their bases, the one-argument Set&lt;X&gt; setters, the From&lt;X&gt;(text) parsers
/// and the read-only lists edited by an Add&lt;X&gt;/Remove&lt;X&gt; pair.</summary>
public sealed record TypeFacts(string Type, IReadOnlyList<string> Interfaces, IReadOnlyList<PropertyFact> Properties,
    IReadOnlySet<string> Setters, IReadOnlySet<string> Parsers, IReadOnlySet<string> ListEditors, bool IsWidget = false)
{
    /// <summary>Names the verb `set` accepts besides properties (Verbs.Set special cases).</summary>
    private static readonly HashSet<string> Special = new(StringComparer.Ordinal) { "Roles", "StartIndex", "MaxRecords", "AttributeSelection", "Unique" };

    /// <summary>Whether `set` can reach <paramref name="name"/> at all: a property of the type (any of its interfaces), a
    /// setter, a parser, a list editor or one of the verb's special cases. Only a name that is none of these is judged.</summary>
    public bool Knows(string name) => Properties.Any(p => p.Name == name) || Setters.Contains(name) || Parsers.Contains(name)
        || ListEditors.Contains(name) || Special.Contains(name);

    /// <summary>The names `set` writes on this type, closest first by the caller.</summary>
    public IEnumerable<string> Writable() => Properties.Where(p => p.CanWrite || p.IsExpression).Select(p => p.Name)
        .Concat(Setters).Concat(Parsers).Concat(ListEditors).Where(n => n is not ("TranslationBehavior")).Distinct(StringComparer.Ordinal).OrderBy(n => n, StringComparer.Ordinal);
}

/// <summary>
/// Model API facts for the preflight, without a module: the runtime reflection of the lane's Studio when it is bound
/// (the same metadata the verbs use at apply), otherwise, in the O11 lane only, the checked-in catalog
/// (kernel/catalog/model-api-*.json). A name neither knows is unknown, and nothing is judged on it.
/// </summary>
public static class ModelTypes
{
    // Keyed by the number of loaded assemblies too: a plugin or implementation loaded later can only add what a type writes.
    private static readonly ConcurrentDictionary<(string Type, string Lane, int Assemblies), TypeFacts?> Cache = new();

    public static TypeFacts? Of(string type, string lane)
    {
        if (string.IsNullOrWhiteSpace(type)) return null;
        type = KindNames.Normalize(type.Trim());
        return Cache.GetOrAdd((type, lane, ModelAssemblies()), key =>
        {
            // A short name exists in the core API and in the Studio plugins (IExpression is the expression and the Expression
            // widget, IList the list type and the List widget): every interface of the name counts, or nothing is judged.
            var runtime = Runtime(key.Type);
            var catalog = key.Lane == "o11" ? FromCatalog(key.Type) : null;
            if (runtime == null) return catalog;
            return catalog == null ? runtime : Union(runtime, catalog);
        });
    }

    /// <summary>The number of loaded Studio assemblies (ServiceStudio.*, OutSystems.*): what can change what a type writes. The
    /// process also loads assemblies of its own (compiled C# extensions, tests), which must not invalidate the facts.</summary>
    private static int ModelAssemblies() => AppDomain.CurrentDomain.GetAssemblies().Count(a => !a.IsDynamic && a.FullName is { } n
        && (n.StartsWith("ServiceStudio", StringComparison.Ordinal) || n.StartsWith("OutSystems", StringComparison.Ordinal)));

    private static TypeFacts Union(TypeFacts a, TypeFacts b) => new(a.Type, a.Interfaces.Concat(b.Interfaces).Distinct(StringComparer.Ordinal).ToArray(),
        a.Properties.Concat(b.Properties).ToArray(), a.Setters.Concat(b.Setters).ToHashSet(StringComparer.Ordinal),
        a.Parsers.Concat(b.Parsers).ToHashSet(StringComparer.Ordinal), a.ListEditors.Concat(b.ListEditors).ToHashSet(StringComparer.Ordinal), a.IsWidget || b.IsWidget);

    private static readonly HashSet<string> WidgetRoots = new(StringComparer.Ordinal) { "IWidget", "IMobileWidget", "IWebWidget" };

    /// <summary>A widget's concrete class implements more than its interface declares (the Expression widget writes Visible,
    /// which no interface of the name has): the preflight never refuses a property name on a widget; the apply does.</summary>
    private static bool Widget(string name, string? ns) => WidgetRoots.Contains(name.Split('.').Last())
        || (ns ?? name).StartsWith("ServiceStudio.Plugin", StringComparison.Ordinal) || (ns ?? name).StartsWith("OutSystems.Model.Plugin", StringComparison.Ordinal);

    /// <summary>The Model API interfaces of the loaded classes that implement one of <paramref name="found"/>: what an object
    /// of that type really answers to (a concrete class implements more interfaces than the one a job names).</summary>
    private static IEnumerable<Type> Implemented(Type[] found)
        => ClassesNow().Where(c => c.Interfaces.Any(found.Contains)).SelectMany(c => c.Interfaces).Distinct();

    /// <summary>Every concrete class of the loaded model assemblies (core, implementation, plugins) with its Model API
    /// interfaces, read once (after the plugins are loaded).</summary>
    private static readonly ConcurrentDictionary<int, (Type Class, Type[] Interfaces)[]> Classes = new();

    private static (Type Class, Type[] Interfaces)[] ClassesNow() => Classes.GetOrAdd(ModelAssemblies(), _ =>
    {
        var classes = new List<(Type, Type[])>();
        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (assembly.IsDynamic) continue;
            var name = assembly.GetName().Name ?? "";
            if (!name.StartsWith("ServiceStudio", StringComparison.Ordinal) && !name.StartsWith("OutSystems", StringComparison.Ordinal)) continue;
            // The model's classes live in the model, framework and plugin assemblies; the rest of the Studio has none.
            if (!name.Contains("Model", StringComparison.Ordinal) && !name.Contains("Plugin", StringComparison.Ordinal) && !name.Contains("Framework", StringComparison.Ordinal)) continue;
            Type[] types;
            try { types = assembly.GetTypes(); }
            catch (ReflectionTypeLoadException ex) { types = ex.Types.OfType<Type>().ToArray(); }
            catch { continue; }
            foreach (var t in types)
            {
                try
                {
                    if (!t.IsClass || t.IsAbstract) continue;
                    var interfaces = t.GetInterfaces().Where(i => i.Namespace != null && (i.Namespace.StartsWith("OutSystems.Model", StringComparison.Ordinal)
                        || i.Namespace.StartsWith("ServiceStudio.Plugin", StringComparison.Ordinal))).ToArray();
                    if (interfaces.Length > 0) classes.Add((t, interfaces));
                }
                catch { /* a type that cannot load says nothing */ }
            }
        }
        return classes.ToArray();
    });

    // ---- runtime ------------------------------------------------------------------------------------------------------

    /// <summary>The interfaces of the Studio plugins by short name, read once (the widgets of Reactive and Mobile live there:
    /// Plugins/**/ServiceStudio.Plugin.*.dll in O11, OutSystems.Model.Plugin.*.dll beside the ODC Studio). Null when any of
    /// them cannot be read: then what the runtime knows is incomplete, and nothing is judged on it.</summary>
    private static readonly Lazy<Dictionary<string, Type[]>?> PluginInterfaces = new(() =>
    {
        try
        {
            var root = StudioAdapter.Runtime.StudioDirectory;
            if (!Directory.Exists(root)) return null;
            var plugins = Path.Combine(root, "Plugins");
            var files = (Directory.Exists(plugins) ? Directory.EnumerateFiles(plugins, "ServiceStudio.Plugin.*.dll", SearchOption.AllDirectories) : [])
                .Concat(Directory.EnumerateFiles(root, "OutSystems.Model.Plugin.*.dll", SearchOption.TopDirectoryOnly));
            var found = new List<Type>();
            foreach (var path in files)
            {
                var assembly = System.Runtime.Loader.AssemblyLoadContext.Default.LoadFromAssemblyPath(path);
                Type[] types;
                try { types = assembly.GetExportedTypes(); }
                catch (ReflectionTypeLoadException ex) { types = ex.Types.OfType<Type>().ToArray(); }
                found.AddRange(types.Where(t => t.IsInterface));
            }
            return found.GroupBy(t => t.Name, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.ToArray(), StringComparer.Ordinal);
        }
        catch { return null; }
    });

    private static TypeFacts? Runtime(string type)
    {
        Type[] found;
        try { found = ModelApiMetadata.Types(type); }
        catch { return null; }   // the lane's Studio is not bound in this process (check-job without a Studio)
        if (PluginInterfaces.Value is not { } plugins) return null;
        var shortName = type.Split('.').Last();
        found = found.Concat(plugins.TryGetValue(shortName, out var more) ? more.Where(t => t.Name == type || t.FullName == type) : []).Distinct().ToArray();
        if (found.Length == 0) return null;
        var all = found.SelectMany(t => new[] { t }.Concat(t.GetInterfaces())).Concat(Implemented(found)).Distinct().ToArray();
        var properties = new List<PropertyFact>();
        foreach (var t in all)
            foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                var pt = Nullable.GetUnderlyingType(p.PropertyType) ?? p.PropertyType;
                properties.Add(new PropertyFact(p.Name, pt.FullName ?? pt.Name, p.CanWrite,
                    typeof(IExpression).IsAssignableFrom(pt), pt.IsEnum ? Enum.GetNames(pt) : null));
            }
        var methods = all.SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Instance)).ToArray();
        var setters = methods.Where(m => m.Name.StartsWith("Set", StringComparison.Ordinal) && m.Name.Length > 3 && m.GetParameters().Length == 1)
            .Select(m => m.Name[3..]).ToHashSet(StringComparer.Ordinal);
        var parsers = methods.Where(m => m.Name.StartsWith("From", StringComparison.Ordinal) && m.Name.Length > 4 && m.GetParameters() is [{ ParameterType: var s }] && s == typeof(string))
            .Select(m => m.Name[4..]).ToHashSet(StringComparer.Ordinal);
        var editors = new HashSet<string>(StringComparer.Ordinal);
        foreach (var t in all)
            foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                if (p.CanWrite || !p.PropertyType.IsGenericType || p.PropertyType.GetGenericTypeDefinition() != typeof(IEnumerable<>)) continue;
                var array = p.PropertyType.GetGenericArguments()[0].MakeArrayType();
                bool Pair(string verb) => methods.Count(m => m.Name.StartsWith(verb, StringComparison.Ordinal) && m.GetParameters() is [{ ParameterType: var a }] && a == array) == 1;
                if (Pair("Add") && Pair("Remove")) editors.Add(p.Name);
            }
        return new TypeFacts(type, found.Select(t => t.FullName ?? t.Name).ToArray(), properties, setters, parsers, editors,
            all.Any(t => Widget(t.Name, t.Namespace)));
    }

    // ---- catalog (O11) --------------------------------------------------------------------------------------------------

    private static TypeFacts? FromCatalog(string type)
    {
        var interfaces = ApiCatalog.Data?["Interfaces"] as JsonArray;
        if (interfaces == null) return null;
        var byName = interfaces.OfType<JsonObject>().GroupBy(i => i["Name"]!.ToString(), StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        var roots = byName.Values.Where(i => i["Name"]!.ToString() == type || i["Name"]!.ToString().Split('.').Last() == type).ToArray();
        if (roots.Length == 0) return null;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var all = new List<JsonObject>();
        void Add(JsonObject i)
        {
            if (!seen.Add(i["Name"]!.ToString())) return;
            all.Add(i);
            foreach (var b in i["Bases"] as JsonArray ?? new JsonArray())
                if (b?.ToString() is { } baseName && byName.TryGetValue(baseName, out var next)) Add(next);
        }
        foreach (var r in roots) Add(r);
        var properties = new List<PropertyFact>();
        foreach (var i in all)
            foreach (var p in (i["Properties"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
            {
                var pt = p["Type"]?.ToString() ?? "";
                if (pt.StartsWith("Nullable<", StringComparison.Ordinal)) pt = pt["Nullable<".Length..].TrimEnd('>');
                properties.Add(new PropertyFact(p["Name"]!.ToString(), pt, p["CanWrite"]?.GetValue<bool>() == true,
                    pt == "OutSystems.Model.IExpression", ApiCatalog.EnumValues(pt)));
            }
        IEnumerable<JsonObject> Methods(string section) => all.SelectMany(i => (i[section] as JsonArray ?? new JsonArray()).OfType<JsonObject>());
        var setters = Methods("Setters").Where(m => m["Name"]!.ToString().Length > 3 && (m["Parameters"] as JsonArray)?.Count == 1)
            .Select(m => m["Name"]!.ToString()[3..]).ToHashSet(StringComparer.Ordinal);
        var others = Methods("OtherMethods").ToArray();
        var parsers = others.Where(m => m["Name"]!.ToString().StartsWith("From", StringComparison.Ordinal) && m["Name"]!.ToString().Length > 4
                && (m["Parameters"] as JsonArray) is [{ } only] && only.ToString().StartsWith("String ", StringComparison.Ordinal))
            .Select(m => m["Name"]!.ToString()[4..]).ToHashSet(StringComparer.Ordinal);
        var editors = new HashSet<string>(StringComparer.Ordinal);
        foreach (var i in all)
            foreach (var p in (i["Properties"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
            {
                if (p["CanWrite"]?.GetValue<bool>() == true || p["ElementType"]?.ToString() is not { Length: > 0 } element) continue;
                bool Pair(string verb) => others.Count(m => m["Name"]!.ToString().StartsWith(verb, StringComparison.Ordinal)
                    && (m["Parameters"] as JsonArray) is [{ } only] && only.ToString().StartsWith(element + "[] ", StringComparison.Ordinal)) == 1;
                if (Pair("Add") && Pair("Remove")) editors.Add(p["Name"]!.ToString());
            }
        return new TypeFacts(type, roots.Select(r => r["Name"]!.ToString()).ToArray(), properties, setters, parsers, editors,
            all.Any(i => Widget(i["Name"]!.ToString(), i["Namespace"]?.ToString())));
    }
}

/// <summary>
/// A27: the kind of a `Kind:Name` reference written with or without the leading I of its Model API interface
/// (`ServerActionSignature:X` is `IServerActionSignature:X`). A kind is completed only when the interface exists under the
/// completed name and not under the written one, so a word before a colon that names no interface stays as written.
/// </summary>
public static class KindNames
{
    private static readonly ConcurrentDictionary<string, string> Cache = new(StringComparer.Ordinal);
    private static readonly Lazy<HashSet<string>> CatalogNames = new(() =>
        (ApiCatalog.Data?["Interfaces"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .Select(i => i["Name"]!.ToString().Split('.').Last()).ToHashSet(StringComparer.Ordinal));

    /// <summary>A name in the Model API convention: I followed by an upper-case letter.</summary>
    public static bool LooksLikeInterface(string kind) => kind.Length > 1 && kind[0] == 'I' && char.IsUpper(kind[1]);

    public static string Normalize(string kind)
    {
        if (kind.Length == 0 || kind.Contains('.') || LooksLikeInterface(kind) || !char.IsLetter(kind[0])) return kind;
        return Cache.GetOrAdd(kind, k => Known("I" + k) && !Known(k) ? "I" + k : k);
    }

    /// <summary>Whether a Model API interface has this short name: the checked-in catalog, then the bound Studio.</summary>
    public static bool Known(string name)
    {
        if (CatalogNames.Value.Contains(name)) return true;
        try { return ModelApiMetadata.Types(name).Length > 0; }
        catch { return false; }
    }
}
