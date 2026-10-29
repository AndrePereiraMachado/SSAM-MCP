using System.Reflection;

namespace Anvil.Core;

/// <summary>Sonda de tipos de um assembly do Studio (para o mapa: o que existe abaixo do Model API V1).</summary>
public static class FrameworkProbe
{
    public static object Types(string studioDir, string assembly, string nsFilter, int max = 400)
    {
        var file = Path.Combine(studioDir, assembly + ".dll");
        // R1 item 3: an assembly the Studio folder does not have is ASSEMBLY_NOT_FOUND with the closest names (it came back as
        // CLI_REFUSED with the loader's text and the folder of the installation).
        if (!File.Exists(file))
            throw CommandSurface.NotFound("ASSEMBLY_NOT_FOUND", $"assembly '{assembly}' is not in the Studio's folder", assembly,
                Directory.Exists(studioDir) ? Directory.GetFiles(studioDir, "*.dll").Select(f => Path.GetFileNameWithoutExtension(f)!) : []);
        var asm = Assembly.LoadFrom(file);
        Type[] types;
        try { types = asm.GetTypes(); } catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t != null).ToArray()!; }
        var rows = types.Where(t => (t.IsInterface || (t.IsClass && !t.IsAbstract)) && (t.FullName ?? "").Contains(nsFilter, StringComparison.OrdinalIgnoreCase) && !t.Name.Contains('<'))
            .OrderBy(t => t.FullName).Take(max)
            .Select(t => new
            {
                type = t.FullName,
                isInterface = t.IsInterface,
                isPublic = t.IsPublic,
                bases = string.Join(" > ", Bases(t).Take(3)),
                v1 = string.Join(",", t.GetInterfaces().Where(i => i.Namespace?.StartsWith("OutSystems.Model") == true || i.Namespace?.Contains("Plugin") == true).Select(i => i.Name).Distinct().Take(6)),
                props = string.Join(", ", t.GetProperties().Where(p => p.CanWrite).Select(p => p.Name + ":" + p.PropertyType.Name).Take(40)),
                readonlyProps = string.Join(", ", t.GetProperties().Where(p => !p.CanWrite).Select(p => p.Name + ":" + p.PropertyType.Name).Take(40)),
                setters = string.Join(", ", t.GetMethods().Where(m => m.Name.StartsWith("Set") || m.Name.StartsWith("Create")).Select(m => m.Name + "(" + string.Join(",", m.GetParameters().Select(pp => pp.ParameterType.Name)) + ")").Take(20)),
                ctors = t.GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance).Select(c => (c.IsPublic ? "public" : "nonpublic") + "(" + string.Join(", ", c.GetParameters().Select(p => p.ParameterType.Name + " " + p.Name)) + ")").Take(3).ToList(),
            }).ToList();
        return new { assembly, nsFilter, count = rows.Count, rows };
    }

    private static IEnumerable<string> Bases(Type t) { for (var b = t.BaseType; b != null && b != typeof(object); b = b.BaseType) yield return b.Name; }
}
