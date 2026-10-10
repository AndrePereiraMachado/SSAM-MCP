using System.Reflection;
using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// `api --op native --type &lt;Interface&gt;`: the Model API contract of a type AS LOADED IN THIS PROCESS (the Studio the
/// lane binds), by reflection only: every interface whose short or full name matches, with its assembly (file, version),
/// direct bases, properties (own and inherited, with the declaring interface and CanWrite) and declared methods. It is
/// the authoritative source for "which properties are writable on the installed version"; whether the kernel writes
/// them is a verbs question and whether it was proven is a jobs question. Shared by both lanes.
/// </summary>
public static class NativeSurface
{
    public static JsonObject Describe(string typeName)
    {
        var runtime = StudioAdapter.Runtime;
        var wanted = typeName.Contains('.') ? typeName : (typeName.StartsWith('I') ? typeName : "I" + typeName);
        var candidates = ModelApiMetadata.Types(wanted);
        var list = new JsonArray();
        foreach (var t in candidates.OrderBy(t => t.FullName, StringComparer.Ordinal)) list.Add(DescribeType(t));
        return new JsonObject
        {
            ["op"] = "native", ["type"] = typeName, ["platform"] = runtime.Platform, ["ideVersion"] = runtime.IdeVersion, ["studioDirectory"] = runtime.StudioDirectory,
            ["candidates"] = list,
            ["note"] = candidates.Length == 0 ? "no public interface with this name is loaded in this process (use the short name, e.g. IStaticEntity, or the full name)"
                : candidates.Length > 1 ? "several interfaces share this short name: address the one you mean by its full name" : "declared members by reflection over the loaded Studio assemblies; inherited properties list their declaring interface",
        };
    }

    private static JsonObject DescribeType(Type t)
    {
        var asmPath = t.Assembly.Location;
        string? version = null; try { version = string.IsNullOrEmpty(asmPath) ? null : System.Diagnostics.FileVersionInfo.GetVersionInfo(asmPath).FileVersion; } catch { /* metadata only */ }
        var all = t.GetInterfaces();
        var direct = all.Where(i => !all.Any(o => o != i && i.IsAssignableFrom(o))).Select(i => Friendly(i)).OrderBy(x => x, StringComparer.Ordinal);
        var props = new JsonArray(); var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance).OrderBy(p => p.Name, StringComparer.Ordinal))
            if (seen.Add(p.Name)) props.Add(Property(p, t));
        foreach (var i in all.OrderBy(i => i.FullName, StringComparer.Ordinal))
            foreach (var p in i.GetProperties(BindingFlags.Public | BindingFlags.Instance).OrderBy(p => p.Name, StringComparer.Ordinal))
                if (seen.Add(p.Name)) props.Add(Property(p, i));
        var methods = new JsonArray();
        foreach (var m in t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly).Where(m => !m.IsSpecialName).OrderBy(m => m.Name, StringComparer.Ordinal).ThenBy(m => m.GetParameters().Length))
            methods.Add(Friendly(m.ReturnType) + " " + m.Name + (m.IsGenericMethodDefinition ? "<" + string.Join(", ", m.GetGenericArguments().Select(a => a.Name)) + ">" : "") + "(" + string.Join(", ", m.GetParameters().Select(Param)) + ")");
        return new JsonObject
        {
            ["fullName"] = t.FullName, ["namespace"] = t.Namespace, ["name"] = t.Name,
            ["assembly"] = new JsonObject { ["file"] = string.IsNullOrEmpty(asmPath) ? null : Path.GetFileName(asmPath), ["version"] = version },
            ["bases"] = new JsonArray(direct.Select(b => (JsonNode)b).ToArray()),
            ["properties"] = props, ["methods"] = methods,
            ["writable"] = new JsonArray(props.Where(p => p!["canWrite"]!.GetValue<bool>()).Select(p => (JsonNode)p!["name"]!.GetValue<string>()).ToArray()),
        };
    }

    private static JsonObject Property(PropertyInfo p, Type declaredBy) => new()
    {
        ["name"] = p.Name, ["type"] = Friendly(p.PropertyType), ["canRead"] = p.CanRead, ["canWrite"] = p.CanWrite, ["declaredBy"] = declaredBy.FullName,
    };

    private static string Param(ParameterInfo p) => (p.IsOut ? "out " : p.ParameterType.IsByRef ? "ref " : "") + Friendly(p.ParameterType.IsByRef ? p.ParameterType.GetElementType()! : p.ParameterType) + " " + p.Name
        + (p.HasDefaultValue ? " = " + (p.DefaultValue is null ? "null" : p.DefaultValue is string s ? "\"" + s + "\"" : p.DefaultValue.ToString()) : "");

    /// <summary>Qualified names for model types, short C# aliases for primitives, generic arguments expanded.</summary>
    private static string Friendly(Type t)
    {
        if (t.IsArray) return Friendly(t.GetElementType()!) + "[]";
        if (t.IsGenericParameter) return t.Name;
        if (Nullable.GetUnderlyingType(t) is { } u) return Friendly(u) + "?";
        var name = t.IsGenericType ? (t.FullName ?? t.Name)[..(t.FullName ?? t.Name).IndexOf('`')] + "<" + string.Join(", ", t.GetGenericArguments().Select(Friendly)) + ">" : t.FullName ?? t.Name;
        return name switch { "System.String" => "string", "System.Boolean" => "bool", "System.Int32" => "int", "System.Int64" => "long", "System.Void" => "void", "System.Object" => "object", "System.Double" => "double", "System.Decimal" => "decimal", "System.Byte[]" => "byte[]", _ => name };
    }
}
