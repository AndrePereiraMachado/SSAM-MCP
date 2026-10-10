using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Anvil.Core;

// Catalogo do Model API, gerado por reflexao sobre a OutSystems.Model.V1.dll INSTALADA (nunca do decompilado).
// E o mapa completo do que o Studio sabe criar e editar, versionado por build. Alimenta os verbos genericos,
// os schemas para o agente e o gerador de provas. Regenerar a cada build do Studio; o diff entre builds e
// o primeiro sinal de adaptador quebrado.

public sealed record CatalogProperty(string Name, string Type, bool CanRead, bool CanWrite, bool IsCollection, string? ElementType);
public sealed record CatalogMethod(string Name, string Returns, IReadOnlyList<string> Parameters, bool IsGeneric, string? GenericConstraint);
public sealed record CatalogInterface(
    string Name, string Namespace, IReadOnlyList<string> Bases, IReadOnlyList<CatalogProperty> Properties,
    IReadOnlyList<CatalogMethod> Creates, IReadOnlyList<CatalogMethod> Setters, IReadOnlyList<CatalogMethod> OtherMethods);
public sealed record CatalogEnum(string Name, string Namespace, IReadOnlyList<string> Values);
public sealed record CatalogCreatable(string Type, string Parent, string Via, bool ViaGeneric);
public sealed record ModelCatalog(
    string Assembly, string AssemblyVersion, string StudioDir, string GeneratedAt,
    IReadOnlyList<CatalogInterface> Interfaces, IReadOnlyList<CatalogEnum> Enums, IReadOnlyList<CatalogCreatable> Creatables,
    IReadOnlyDictionary<string, int> Summary);

public static class Catalog
{
    /// <summary>Reflete sobre a OutSystems.Model.V1.dll da pasta do Studio ligada por StudioAssemblies.Bind.</summary>
    public static ModelCatalog Extract(string studioDir)
    {
        var asm = Assembly.LoadFrom(Path.Combine(studioDir, "OutSystems.Model.V1.dll"));
        var typeList = asm.GetExportedTypes().ToList();
        // widgets do Reactive/Mobile: interfaces dos plugins do Studio que implementam IMobileWidget/IWebWidget
        var plugins = Path.Combine(studioDir, "Plugins");
        if (Directory.Exists(plugins))
            foreach (var f in Directory.EnumerateFiles(plugins, "ServiceStudio.Plugin.*.dll", SearchOption.AllDirectories))
            {
                try
                {
                    var pa = Assembly.LoadFrom(f);
                    // widgets (IMobileWidget/IWebWidget) e qualquer interface de plugin que estenda o Model API (REST: IRestClient, IRestAction...)
                    typeList.AddRange(pa.GetExportedTypes().Where(t => t.IsInterface && t.GetInterfaces().Any(i => i.Name is "IMobileWidget" or "IWebWidget" or "IWidget" || (i.Namespace?.StartsWith("OutSystems.Model", StringComparison.Ordinal) ?? false))));
                }
                catch { }
            }
        var types = typeList.ToArray();
        var interfaces = new List<CatalogInterface>();
        var enums = new List<CatalogEnum>();
        foreach (var t in types.OrderBy(t => t.FullName))
        {
            if (t.IsEnum) { enums.Add(new CatalogEnum(t.Name, t.Namespace ?? "", Enum.GetNames(t))); continue; }
            if (!t.IsInterface) continue;
            var props = t.GetProperties().Select(p =>
            {
                var (isColl, elem) = CollectionOf(p.PropertyType);
                return new CatalogProperty(p.Name, TypeName(p.PropertyType), p.CanRead, p.CanWrite, isColl, elem);
            }).OrderBy(p => p.Name).ToList();
            var methods = t.GetMethods().Where(m => !m.IsSpecialName).ToList();
            CatalogMethod M(MethodInfo m)
            {
                string? constraint = null;
                if (m.IsGenericMethodDefinition)
                {
                    var g = m.GetGenericArguments()[0];
                    constraint = string.Join("&", g.GetGenericParameterConstraints().Select(TypeName));
                }
                return new CatalogMethod(m.Name, TypeName(m.ReturnType), m.GetParameters().Select(p => $"{TypeName(p.ParameterType)} {p.Name}" + (p.HasDefaultValue ? "?" : "")).ToList(), m.IsGenericMethodDefinition, constraint);
            }
            interfaces.Add(new CatalogInterface(TypeName(t), t.Namespace ?? "", t.GetInterfaces().Select(TypeName).OrderBy(x => x).ToList(), props,
                methods.Where(m => m.Name.StartsWith("Create", StringComparison.Ordinal)).Select(M).OrderBy(m => m.Name).ToList(),
                methods.Where(m => m.Name.StartsWith("Set", StringComparison.Ordinal)).Select(M).OrderBy(m => m.Name).ToList(),
                methods.Where(m => !m.Name.StartsWith("Create", StringComparison.Ordinal) && !m.Name.StartsWith("Set", StringComparison.Ordinal)).Select(M).OrderBy(m => m.Name).ToList()));
        }

        // criaveis: (tipo filho, pai, metodo). Create tipado = retorno; Create<T> = todo I* que satisfaz a restricao.
        var creatables = new List<CatalogCreatable>();
        foreach (var i in interfaces)
            foreach (var c in i.Creates)
            {
                if (!c.IsGeneric) { creatables.Add(new CatalogCreatable(c.Returns, i.Name, c.Name, false)); continue; }
                var constraint = c.GenericConstraint ?? "";
                foreach (var cand in interfaces)
                    if (cand.Name != constraint && (cand.Bases.Contains(constraint) || cand.Name == constraint))
                        creatables.Add(new CatalogCreatable(cand.Name, i.Name, c.Name + "<T>", true));
            }
        creatables = creatables.Distinct().OrderBy(c => c.Parent).ThenBy(c => c.Type).ToList();
        var summary = new Dictionary<string, int>
        {
            ["interfaces"] = interfaces.Count, ["enums"] = enums.Count, ["properties"] = interfaces.Sum(i => i.Properties.Count),
            ["writableProperties"] = interfaces.Sum(i => i.Properties.Count(p => p.CanWrite)), ["createMethods"] = interfaces.Sum(i => i.Creates.Count),
            ["creatablePairs"] = creatables.Count, ["creatableTypes"] = creatables.Select(c => c.Type).Distinct().Count(),
            ["actionNodes"] = creatables.Count(c => c.Parent.EndsWith(".IAction") && c.Type.Contains(".Nodes.")), ["widgets"] = creatables.Count(c => c.Via.StartsWith("CreateWidget")),
        };
        return new ModelCatalog(asm.GetName().Name ?? "", asm.GetName().Version?.ToString() ?? "", studioDir, DateTime.Now.ToString("s"), interfaces, enums, creatables, summary);
    }

    public static string ToJson(ModelCatalog c) => JsonSerializer.Serialize(c, new JsonSerializerOptions { WriteIndented = true, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull });

    private static string TypeName(Type t)
    {
        if (t.IsGenericType)
        {
            var name = t.Name[..t.Name.IndexOf('`')];
            return name + "<" + string.Join(",", t.GetGenericArguments().Select(TypeName)) + ">";
        }
        if (t.IsGenericParameter) return t.Name;
        return t.Namespace != null && (t.Namespace.StartsWith("OutSystems.", StringComparison.Ordinal) || t.Namespace.StartsWith("ServiceStudio.Plugin", StringComparison.Ordinal)) ? t.Namespace + "." + t.Name : t.Name;
    }

    private static (bool, string?) CollectionOf(Type t)
    {
        if (t == typeof(string)) return (false, null);
        var ie = t.IsGenericType && t.GetGenericTypeDefinition() == typeof(IEnumerable<>) ? t
            : t.GetInterfaces().FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>));
        return ie != null ? (true, TypeName(ie.GetGenericArguments()[0])) : (false, null);
    }
}
