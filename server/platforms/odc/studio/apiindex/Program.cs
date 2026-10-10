using System.Diagnostics;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text;
using System.Text.Json;

// Model API index by reflection over the public metadata of the installed ODC Studio assemblies.
// No source is read or decompiled: type names, base types, properties, methods and enum values come from
// the assembly metadata, the same information any IDE shows. Output: docs\model-api\<assembly>.md and .json
// plus INDEX.md. Usage: dotnet run --project studio\apiindex -c Release [-- <studio install dir>]
internal static class Program {
    private static readonly string[] Assemblies = {
        "OutSystems.Model.V1", "OutSystems.Model.Plugin.NRWidgets", "OutSystems.Model.Plugin.Widgets",
        "OutSystems.Model.Plugin.REST", "OutSystems.Model.Plugin.RESTService", "OutSystems.Model.Plugin.SOAP", "OutSystems.ModelAPILoader"
    };

    public static int Main(string[] args) {
        var studio = args.Length > 0 ? args[0] : @"C:\Program Files\OutSystems\ODC Studio\ODC Studio";
        AssemblyLoadContext.Default.Resolving += (context, name) => { var p = Path.Combine(studio, name.Name + ".dll"); return File.Exists(p) ? context.LoadFromAssemblyPath(p) : null; };
        var root = ResolveRoot();
        var output = Path.Combine(root, "docs", "model-api");
        Directory.CreateDirectory(output);
        var version = FileVersionInfo.GetVersionInfo(Path.Combine(studio, "ODCStudio.exe")).FileVersion ?? "unknown";
        var index = new StringBuilder();
        index.AppendLine("# Model API index");
        index.AppendLine();
        index.AppendLine("Generated on " + DateTime.UtcNow.ToString("yyyy-MM-dd") + " by `studio\\apiindex` from the public metadata of the ODC Studio " + version + " assemblies installed at `" + studio + "`, by reflection only. One file per assembly: interfaces, public classes and enums under the `OutSystems.` and `ServiceStudio.Plugin.` namespaces, with declared properties, methods and values. Regenerate after a Studio update.");
        index.AppendLine();
        index.AppendLine("| Assembly | Types | File |");
        index.AppendLine("|---|---:|---|");
        var total = 0;
        foreach (var name in Assemblies) {
            var path = Path.Combine(studio, name + ".dll");
            if (!File.Exists(path)) { index.AppendLine("| " + name + " | missing | |"); continue; }
            var assembly = Assembly.LoadFrom(path);
            Type[] types;
            try { types = assembly.GetExportedTypes(); } catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t != null).ToArray()!; }
            var records = types.Where(Interesting).OrderBy(t => t.Namespace).ThenBy(t => t.Name).Select(Describe).ToList();
            File.WriteAllText(Path.Combine(output, name + ".json"), JsonSerializer.Serialize(records, new JsonSerializerOptions { WriteIndented = false }));
            File.WriteAllText(Path.Combine(output, name + ".md"), Markdown(name, version, records));
            index.AppendLine("| " + name + " | " + records.Count + " | `" + name + ".md` |");
            total += records.Count;
            Console.WriteLine(name + ": " + records.Count + " types");
        }
        index.AppendLine();
        index.AppendLine("Total: " + total + " types. `authoring-api.json` and `screen-api.json` are older per-element extracts kept for reference.");
        File.WriteAllText(Path.Combine(output, "INDEX.md"), index.ToString());
        Console.WriteLine("written to " + output);
        return 0;
    }

    // Model API namespaces: OutSystems.Model.* in the V1 assembly, ServiceStudio.Plugin.* in the widget and
    // integration plugin assemblies (for example ServiceStudio.Plugin.NRWidgets.IContainer).
    private static bool Interesting(Type t) =>
        t.IsPublic && ((t.Namespace ?? "").StartsWith("OutSystems.") || (t.Namespace ?? "").StartsWith("ServiceStudio.Plugin.")) && !t.Name.Contains('<') && t.GetCustomAttribute<CompilerGeneratedAttribute>() == null
        && (t.IsInterface || t.IsEnum || (t.IsClass && !t.IsNested));

    private sealed record Member(string kind, string signature);
    private sealed record TypeRecord(string @namespace, string name, string kind, string[] bases, Member[] members);

    private static TypeRecord Describe(Type t) {
        var kind = t.IsInterface ? "interface" : t.IsEnum ? "enum" : t.IsAbstract && t.IsSealed ? "static class" : "class";
        var bases = new List<string>();
        if (t.IsClass && t.BaseType != null && t.BaseType != typeof(object)) bases.Add(Friendly(t.BaseType));
        if (!t.IsEnum) bases.AddRange(t.GetInterfaces().Where(i => t.IsInterface ? IsDirect(t, i) : true).Select(Friendly).OrderBy(x => x));
        var members = new List<Member>();
        if (t.IsEnum) members.AddRange(Enum.GetNames(t).Select(n => new Member("value", n)));
        else {
            var flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
            foreach (var p in t.GetProperties(flags).OrderBy(p => p.Name))
                members.Add(new Member("property", Friendly(p.PropertyType) + " " + p.Name + (p.GetIndexParameters().Length > 0 ? "[" + string.Join(", ", p.GetIndexParameters().Select(Param)) + "]" : "") + " { " + (p.CanRead ? "get; " : "") + (p.CanWrite ? "set; " : "") + "}"));
            foreach (var e in t.GetEvents(flags).OrderBy(e => e.Name)) members.Add(new Member("event", Friendly(e.EventHandlerType!) + " " + e.Name));
            foreach (var m in t.GetMethods(flags).Where(m => !m.IsSpecialName).OrderBy(m => m.Name).ThenBy(m => m.GetParameters().Length))
                members.Add(new Member("method", Friendly(m.ReturnType) + " " + m.Name + Generic(m) + "(" + string.Join(", ", m.GetParameters().Select(Param)) + ")"));
        }
        return new TypeRecord(t.Namespace ?? "", Friendly(t), kind, bases.ToArray(), members.ToArray());
    }

    // Interfaces re-declare every inherited interface; keep only the ones not implied by another base.
    private static bool IsDirect(Type t, Type i) => !t.GetInterfaces().Any(o => o != i && i.IsAssignableFrom(o));
    private static string Generic(MethodInfo m) => m.IsGenericMethodDefinition ? "<" + string.Join(", ", m.GetGenericArguments().Select(a => a.Name)) + ">" : "";
    private static string Param(ParameterInfo p) => (p.IsOut ? "out " : p.ParameterType.IsByRef ? "ref " : "") + Friendly(p.ParameterType.IsByRef ? p.ParameterType.GetElementType()! : p.ParameterType) + " " + p.Name + (p.HasDefaultValue ? " = " + (p.DefaultValue is null ? "null" : p.DefaultValue is string s ? "\"" + s + "\"" : p.DefaultValue.ToString()) : "");
    private static string Friendly(Type t) {
        if (t.IsArray) return Friendly(t.GetElementType()!) + "[]";
        if (t.IsGenericParameter) return t.Name;
        if (Nullable.GetUnderlyingType(t) is Type u) return Friendly(u) + "?";
        var name = t.IsNested ? Friendly(t.DeclaringType!) + "." + t.Name : t.Name;
        if (t.IsGenericType) name = name[..name.IndexOf('`')] + "<" + string.Join(", ", t.GetGenericArguments().Select(Friendly)) + ">";
        return name switch { "String" => "string", "Boolean" => "bool", "Int32" => "int", "Int64" => "long", "Void" => "void", "Object" => "object", "Double" => "double", "Decimal" => "decimal", "Byte[]" => "byte[]", _ => name };
    }

    private static string Markdown(string assembly, string version, List<TypeRecord> records) {
        var sb = new StringBuilder();
        sb.AppendLine("# " + assembly + " (ODC Studio " + version + ")");
        sb.AppendLine();
        sb.AppendLine("Public metadata by reflection; declared members only, inherited members are on the base types listed after the colon.");
        foreach (var group in records.GroupBy(r => r.@namespace)) {
            sb.AppendLine(); sb.AppendLine("## " + group.Key);
            foreach (var r in group) {
                sb.AppendLine(); sb.AppendLine("### " + r.kind + " " + r.name + (r.bases.Length > 0 ? " : " + string.Join(", ", r.bases) : ""));
                foreach (var m in r.members) sb.AppendLine("- " + (m.kind == "value" ? m.signature : m.signature));
            }
        }
        return sb.ToString();
    }

    private static string ResolveRoot() {
        foreach (var name in new[] { "SSAM_HYBRID_ODC_ROOT", "ODC3_ROOT" }) { var v = Environment.GetEnvironmentVariable(name); if (!string.IsNullOrWhiteSpace(v) && Directory.Exists(v)) return v; }
        for (var d = Path.GetFullPath(AppContext.BaseDirectory); d != null; d = Path.GetDirectoryName(d)) if (Directory.Exists(Path.Combine(d, "studio")) && File.Exists(Path.Combine(d, "README.md"))) return d;
        throw new InvalidOperationException("SSAM Hybrid-ODC root not found above " + AppContext.BaseDirectory);
    }
}
