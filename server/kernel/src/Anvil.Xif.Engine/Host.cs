using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Xml.Linq;

namespace Anvil.Xif.Engine;

/// <summary>
/// The installed Integration Studio driven by reflection, with the surface of XifEngineProbe (checked before any call).
/// model: a blank project (or the current XIF) + the spec -> ProjectVerify -> ProjectSave of the model XIF.
/// final: the model XIF + the merged sources + the compiled DLL as resources -> ProjectVerify -> ProjectSave of the final XIF.
/// Nothing here logs in or calls a server: Preferences.RunningTests is set first, the project unpacks under the caller's
/// private work folder only.
/// </summary>
internal sealed class Host
{
    private const string Core = "OutSystems.IntegrationStudio.Core";
    private const string ModelNs = "OutSystems.IntegrationStudio.Core.Common.Model";
    private readonly List<object> plugins = new List<object>();
    private Assembly? core;

    private Type T(string name) => Find(name) ?? throw new EngineFailure("XIF_ENGINE_UNAVAILABLE", "Integration Studio has no type " + name + ".", null);

    private Type? Find(string name)
    {
        core ??= Assembly.LoadFrom(Path.Combine(Program.Studio, Core + ".dll"));
        var type = core.GetType(name, false);
        if (type != null) return type;
        if (name.StartsWith("OutSystems.IntegrationStudio.Plugin.", StringComparison.Ordinal))
        {
            var assemblyName = name.Substring(0, name.Length - ".Plugin".Length);
            var file = Path.Combine(Program.Studio, "Plugins", assemblyName + ".dll");
            if (File.Exists(file)) return Assembly.LoadFrom(file).GetType(name, false);
        }
        return null;
    }

    public Dictionary<string, object?> Probe()
    {
        var missing = XifEngineProbe.Missing(Find);
        if (missing.Count > 0) throw Unavailable(missing);
        return new Dictionary<string, object?> { ["ok"] = true, ["missing"] = new string[0], ["searched"] = Program.Searched.ToArray(), ["version"] = Program.StudioVersion() };
    }

    public void Require()
    {
        var missing = XifEngineProbe.Missing(Find);
        if (missing.Count > 0) throw Unavailable(missing);
    }

    private static EngineFailure Unavailable(List<string> missing) => new EngineFailure("XIF_ENGINE_UNAVAILABLE",
        "The installed Integration Studio lacks " + missing.Count + " member(s) the engine needs: " + string.Join(", ", missing.Take(8)) + (missing.Count > 8 ? ", ..." : "") + ".",
        "Install or repair Integration Studio 11, or point ANVIL_INTEGRATION_STUDIO_DIR at its folder; nothing was generated or sent.",
        new Dictionary<string, object?> { ["missing"] = missing.ToArray(), ["searched"] = Program.Searched.ToArray() },
        missing.Select(m => new Dictionary<string, object?> { ["code"] = "XIF_ENGINE_UNAVAILABLE", ["path"] = m, ["message"] = "Integration Studio has no " + m + ".", ["fix"] = "Install or repair Integration Studio 11." }).ToList());

    // ---- the aggregator --------------------------------------------------------------------------

    private object Open(string name, string unpack)
    {
        var preferences = T("OutSystems.IntegrationStudio.Core.Preferences.Preferences");
        preferences.GetField("RunningTests", BindingFlags.Public | BindingFlags.Static)?.SetValue(null, true);
        // ProjectLoad writes its lock to %TEMP%\Integration Studio\<key>.lock and expects the folder (the Integration Studio
        // application creates it); the caller's private TEMP starts empty.
        Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "Integration Studio"));
        // Aggregator(bool preventUsingTasks) is its only constructor; true keeps the one-shot process free of background tasks.
        var aggregator = R.New(T("OutSystems.IntegrationStudio.Core.Aggregator.Aggregator"), true);
        foreach (var plugin in new[] { "UserDefined", "Net" })
        {
            var type = T("OutSystems.IntegrationStudio.Plugin." + plugin + ".Core.Plugin");
            var instance = R.New(type, aggregator);
            R.Call(aggregator, "AddPlugin", instance);
            plugins.Add(instance);
        }
        R.Set(aggregator, "ProjectName", name);
        R.Call(aggregator, "ProjectCreateBlank");
        Directory.CreateDirectory(unpack);
        R.Set(R.Get(aggregator, "IProject")!, "UnpackLocation", unpack.EndsWith("\\", StringComparison.Ordinal) ? unpack : unpack + "\\");
        return aggregator;
    }

    private void Load(object aggregator, string path)
    {
        var upgrader = R.New(T(ModelNs + ".XIF.Upgrader"), path);
        var document = R.Get(upgrader, "XmlDocument") as XDocument;
        foreach (var resource in document?.Root?.Element("Resources")?.Elements("Resource") ?? Enumerable.Empty<XElement>())
        {
            var directory = ((string?)resource.Attribute("Path") ?? "").Replace('/', '\\').TrimStart('\\');
            var filename = (string?)resource.Attribute("Filename") ?? "";
            if (directory.IndexOf(':') >= 0 || directory.Split('\\').Any(s => s == ".." || s == ".") || filename.Length == 0 || filename.IndexOfAny(new[] { '/', '\\', ':' }) >= 0 || filename == "..")
                throw new EngineFailure("XIF_VERIFY_FAILED", "The XIF has an unsafe resource path: " + directory + filename + ".", "Use a package saved by Integration Studio or by SSAM.");
        }
        var storedHash = (string?)document?.Root?.Attribute("Hash");
        var reports = Reports(R.Call(aggregator, "ProjectLoad", upgrader) as IList);
        var project = R.Get(aggregator, "IProject")!;
        if (!string.IsNullOrEmpty(storedHash)) R.Set(project, "Hash", storedHash);
        Fail("load", reports);
        foreach (var technology in R.List(project, "ITechnologies"))
            if (!plugins.Any(p => R.Call(p, "IsThisYours", technology) is true))
                throw new EngineFailure("XIF_ENGINE_UNAVAILABLE", "The extension uses a technology no installed plugin handles: " + R.Get(technology, "PluginKey") + ".", "Install the Integration Studio plugins of this extension.");
    }

    private List<Dictionary<string, object?>> Reports(IList? reports)
    {
        var found = new List<Dictionary<string, object?>>();
        foreach (var report in reports?.Cast<object>() ?? Enumerable.Empty<object>())
            found.Add(new Dictionary<string, object?> { ["type"] = R.Get(report, "Type")?.ToString(), ["id"] = R.Get(report, "Id")?.ToString(), ["detail"] = R.Get(report, "Detail")?.ToString() });
        return found;
    }

    private static void Fail(string stage, List<Dictionary<string, object?>> reports)
    {
        var errors = reports.Where(r => string.Equals(r["type"] as string, "Error", StringComparison.OrdinalIgnoreCase)).ToList();
        if (errors.Count == 0) return;
        throw new EngineFailure("XIF_VERIFY_FAILED", "Integration Studio reports " + errors.Count + " error(s) at " + stage + ": " + (errors[0]["detail"] ?? errors[0]["id"]) + ".",
            "Fix the spec where each report points; nothing was sent.", new Dictionary<string, object?> { ["stage"] = stage, ["reports"] = reports },
            errors.Select(e => new Dictionary<string, object?> { ["code"] = "XIF_VERIFY_FAILED", ["path"] = e["id"], ["message"] = e["detail"] ?? e["id"], ["fix"] = "Fix the element this report names." }).ToList());
    }

    // ---- model ---------------------------------------------------------------------------------

    public Dictionary<string, object?> Model(Dictionary<string, object?> request)
    {
        var work = Absolute(Text(request, "work"), "work");
        var output = Absolute(Text(request, "output"), "output");
        if (File.Exists(output)) throw new EngineFailure("XIF_ENGINE_REQUEST", "output already exists.", "Use a new work folder.");
        var spec = request.TryGetValue("spec", out var s) ? s as Dictionary<string, object?> : null;
        if (spec == null) throw new EngineFailure("XIF_ENGINE_REQUEST", "spec is required.", null);
        var name = Text(spec, "name");
        var aggregator = Open(name, Path.Combine(work, "model-unpack"));
        var project = R.Get(aggregator, "IProject")!;
        var basePath = request.TryGetValue("base", out var b) ? b as string : null;
        if (!string.IsNullOrEmpty(basePath))
        {
            // A folder of its own: the facade downloads the base to <work>\base\<name>.xif, and copying a file onto itself is
            // an IOException "in use by another process" (every edit failed that way on 2026-10-07).
            var copy = Path.Combine(work, "model-base", Path.GetFileName(basePath));
            Directory.CreateDirectory(Path.GetDirectoryName(copy)!);
            File.Copy(basePath, copy, true);
            Load(aggregator, copy);
            project = R.Get(aggregator, "IProject")!;
            if (!string.Equals(R.Get(project, "Name") as string, name, StringComparison.Ordinal))
                throw new EngineFailure("XIF_VERIFY_FAILED", "The current extension is " + R.Get(project, "Name") + ", not " + name + ".", "Keep the name of the extension.");
        }
        else R.Set(project, "Name", name);
        if (spec.TryGetValue("description", out var description) && description is string d) R.Set(project, "Description", d);
        if (R.List(project, "ITechnologies").Count == 0)
            foreach (var plugin in plugins) R.Call(project, "AddITechnology", R.Call(plugin, "CreateITechnology"));
        var user = R.List(project, "ITechnologies").FirstOrDefault(t => (R.Get(t, "PluginKey") as string ?? "").IndexOf("UserDefined", StringComparison.Ordinal) >= 0)
            ?? throw new EngineFailure("XIF_ENGINE_UNAVAILABLE", "The project has no user-defined technology.", "Repair Integration Studio.");
        Apply(project, user, spec);
        foreach (var reference in Items(request, "references").OfType<string>())
            Resource(project, "Bin\\" + Path.GetFileName(reference), File.ReadAllBytes(reference), "Binaries");
        var verify = Reports(R.Call(aggregator, "ProjectVerify") as IList);
        Fail("verify", verify);
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        var resources = Path.Combine(work, "model-resources");
        Directory.CreateDirectory(resources);
        var saved = Reports(R.Call(aggregator, "ProjectSave", output, resources) as IList);
        Fail("save", saved);
        R.Call(aggregator, "ProjectClose");
        return new Dictionary<string, object?> { ["ok"] = true, ["xif"] = output, ["sha256"] = Sha256(File.ReadAllBytes(output)), ["reports"] = verify.Concat(saved).ToList() };
    }

    private void Apply(object project, object user, Dictionary<string, object?> spec)
    {
        var structures = Items(spec, "structures").OfType<Dictionary<string, object?>>().ToList();
        foreach (var s in structures)
        {
            var name = Text(s, "name");
            if (!R.List(user, "IStructures").Any(x => (string?)R.Get(x, "Name") == name))
            {
                var structure = R.Call(user, "CreateIStructure")!;
                R.Set(structure, "Name", name);
                R.Call(user, "AddIStructure", structure);
            }
        }
        foreach (var s in structures)
        {
            var structure = R.List(user, "IStructures").Single(x => (string?)R.Get(x, "Name") == Text(s, "name"));
            if (s.TryGetValue("description", out var description) && description is string d) R.Set(structure, "Description", d);
            foreach (var a in Items(s, "attributes").OfType<Dictionary<string, object?>>())
            {
                var name = Text(a, "name");
                var attribute = R.List(structure, "IAttributes").FirstOrDefault(x => (string?)R.Get(x, "Name") == name);
                if (attribute == null) { attribute = R.Call(structure, "CreateIAttribute")!; R.Set(attribute, "Name", name); R.Call(structure, "AddIAttribute", attribute); }
                var (dataType, recordType) = TypeOf(Text(a, "type"), user);
                R.Set(attribute, "DataType", dataType); R.Set(attribute, "IRecordType", recordType);
                R.Set(attribute, "Mandatory", a.TryGetValue("mandatory", out var m) && m is true);
                if (a.TryGetValue("length", out var length) && length is int l) R.Set(attribute, "Length", l);
                if (a.TryGetValue("decimals", out var decimals) && decimals is int dd) R.Set(attribute, "Decimals", dd);
                if (a.TryGetValue("default", out var def) && def is string df) R.Set(attribute, "DefaultValue", df);
                if (a.TryGetValue("description", out var ad) && ad is string ads) R.Set(attribute, "Description", ads);
            }
        }
        foreach (var a in Items(spec, "actions").OfType<Dictionary<string, object?>>())
        {
            var name = Text(a, "name");
            var action = R.List(user, "IActions").FirstOrDefault(x => (string?)R.Get(x, "Name") == name);
            if (action == null) { action = R.Call(user, "CreateIAction")!; R.Set(action, "Name", name); R.Call(user, "AddIAction", action); }
            if (a.TryGetValue("description", out var description) && description is string d) R.Set(action, "Description", d);
            R.Set(action, "Function", a.TryGetValue("isFunction", out var f) && f is true);
            if (a.TryGetValue("body", out var body) && body is string text) R.Set(action, "Body", text);
            var inputs = Items(a, "inputs").OfType<Dictionary<string, object?>>().ToList();
            var outputs = Items(a, "outputs").OfType<Dictionary<string, object?>>().ToList();
            var names = inputs.Concat(outputs).Select(p => Text(p, "name")).ToList();
            foreach (var old in R.List(action, "IParameters").Where(p => !names.Contains((string?)R.Get(p, "Name") ?? "")).ToList()) R.Call(action, "RemoveIParameter", old);
            var index = 0;
            foreach (var (parameters, input) in new[] { (inputs, true), (outputs, false) })
                foreach (var p in parameters)
                {
                    var pname = Text(p, "name");
                    var parameter = R.List(action, "IParameters").FirstOrDefault(x => (string?)R.Get(x, "Name") == pname);
                    if (parameter == null) { parameter = R.Call(action, "CreateIParameter")!; R.Set(parameter, "Name", pname); R.Call(action, "AddIParameter", parameter); }
                    R.Call(action, "MoveIParameter", parameter, index++);
                    R.Set(parameter, "Input", input);
                    var (dataType, recordType) = TypeOf(Text(p, "type"), user);
                    R.Set(parameter, "DataType", dataType); R.Set(parameter, "IRecordType", recordType);
                    R.Set(parameter, "Mandatory", input && (!p.TryGetValue("mandatory", out var mandatory) || mandatory is true));
                    if (p.TryGetValue("default", out var def) && def is string df) R.Set(parameter, "DefaultValue", df);
                    if (p.TryGetValue("description", out var pd) && pd is string pds) R.Set(parameter, "Description", pds);
                }
        }
        if (spec.TryGetValue("remove", out var remove) && remove is Dictionary<string, object?> removing)
        {
            foreach (var name in Items(removing, "actions").OfType<string>())
                foreach (var action in R.List(user, "IActions").Where(x => string.Equals((string?)R.Get(x, "Name"), name, StringComparison.OrdinalIgnoreCase)).ToList()) R.Call(user, "RemoveIAction", action);
            foreach (var name in Items(removing, "structures").OfType<string>())
                foreach (var structure in R.List(user, "IStructures").Where(x => string.Equals((string?)R.Get(x, "Name"), name, StringComparison.OrdinalIgnoreCase)).ToList()) R.Call(user, "RemoveIStructure", structure);
            foreach (var path in Items(removing, "resources").OfType<string>())
            {
                var full = "\\" + path.Replace('/', '\\').TrimStart('\\');
                foreach (var resource in R.List(project, "IResources").Where(r => string.Equals(R.Get(r, "FullPath") as string, full, StringComparison.OrdinalIgnoreCase)).ToList()) R.Call(project, "RemoveIResource", resource);
            }
        }
        foreach (var r in Items(spec, "resources").OfType<Dictionary<string, object?>>())
        {
            var path = Text(r, "path");
            var bytes = r.TryGetValue("file", out var file) && file is string f ? File.ReadAllBytes(f) : System.Text.Encoding.UTF8.GetBytes(r.TryGetValue("text", out var t) && t is string tt ? tt : "");
            Resource(project, path, bytes, r.TryGetValue("deploy", out var deploy) && deploy is string dp ? dp : "Ignore");
        }
    }

    /// <summary>The data type object (and record type for structures) of a canonical spec type.</summary>
    private (object DataType, object? RecordType) TypeOf(string type, object user)
    {
        var list = type.EndsWith(" List", StringComparison.Ordinal);
        var element = list ? type.Substring(0, type.Length - 5) : type;
        if (!list && Array.IndexOf(XifEngineProbe.DataTypes, element) >= 0 && element != "Record" && element != "RecordList")
            return (R.New(T(XifEngineProbe.DataType(element))), null);
        var structure = R.List(user, "IStructures").FirstOrDefault(s => (string?)R.Get(s, "Name") == element)
            ?? throw new EngineFailure("XIF_VERIFY_FAILED", "Unknown type " + type + ".", "Declare the structure " + element + " in structures.");
        var recordType = R.New(T(ModelNs + ".Project.Technology.Type.RecordType.RecordType"));
        R.Call(recordType, "AddRecord", structure);
        return (R.New(T(XifEngineProbe.DataType(list ? "RecordList" : "Record"))), recordType);
    }

    /// <summary>Adds or replaces the resource at path (relative, backslashes) with these bytes and deploy mode.</summary>
    private void Resource(object project, string relative, byte[] bytes, string deploy)
    {
        var clean = relative.Replace('/', '\\').TrimStart('\\');
        var directory = Path.GetDirectoryName(clean) ?? "";
        var path = "\\" + (directory.Length == 0 ? "" : directory.Trim('\\') + "\\");
        var name = Path.GetFileName(clean);
        var resource = R.List(project, "IResources").FirstOrDefault(r => string.Equals(R.Get(r, "FullPath") as string, path + name, StringComparison.OrdinalIgnoreCase));
        if (resource == null)
        {
            resource = R.New(T(ModelNs + ".Project.Resource.Resource"));
            R.Set(resource, "Name", name); R.Set(resource, "Path", path);
            R.Call(project, "AddIResource", resource);
        }
        var actionType = T(ModelNs + ".Project.Resource.ResourceCompileAction");
        R.Set(resource, "CompileAction", Enum.Parse(actionType, deploy, false));
        R.Set(resource, "Data", bytes);
        R.Set(resource, "LastModified", new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        R.Call(resource, "Unpack");
    }

    // ---- final ---------------------------------------------------------------------------------

    public Dictionary<string, object?> Final(Dictionary<string, object?> request)
    {
        var work = Absolute(Text(request, "work"), "work");
        var output = Absolute(Text(request, "output"), "output");
        var model = Absolute(Text(request, "model"), "model");
        var dll = Absolute(Text(request, "dll"), "dll");
        var name = Text(request, "name");
        if (File.Exists(output)) throw new EngineFailure("XIF_ENGINE_REQUEST", "output already exists.", "Use a new work folder.");
        var aggregator = Open(name, Path.Combine(work, "final-unpack"));
        var copy = Path.Combine(work, "final-model", Path.GetFileName(model));
        Directory.CreateDirectory(Path.GetDirectoryName(copy)!);
        File.Copy(model, copy, true);
        Load(aggregator, copy);
        var project = R.Get(aggregator, "IProject")!;
        foreach (var source in Items(request, "sources").OfType<Dictionary<string, object?>>())
            Resource(project, Text(source, "path"), File.ReadAllBytes(Absolute(Text(source, "file"), "sources.file")), "Ignore");
        // The compiled DLL where Integration Studio keeps it: \Source\NET\Bin\OutSystems.Nss<Name>.dll, CompileAction Binaries,
        // so the platform deploys it to the extension's bin and consumers compile against it (with Ignore every consumer
        // failed with CS0006 "Metadata file 'bin\OutSystems.Nss<Name>.dll' could not be found"). An existing resource of that
        // name keeps its folder and gets Binaries too.
        var dllName = Path.GetFileName(dll);
        var existing = R.List(project, "IResources").FirstOrDefault(r => string.Equals(R.Get(r, "Name") as string, dllName, StringComparison.OrdinalIgnoreCase));
        if (existing != null)
        {
            R.Set(existing, "CompileAction", Enum.Parse(T(ModelNs + ".Project.Resource.ResourceCompileAction"), "Binaries", false));
            R.Set(existing, "Data", File.ReadAllBytes(dll));
            R.Call(existing, "Unpack");
        }
        else Resource(project, "Source\\NET\\Bin\\" + dllName, File.ReadAllBytes(dll), "Binaries");
        var verify = Reports(R.Call(aggregator, "ProjectVerify") as IList);
        Fail("verify", verify);
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        var saved = Reports(R.Call(aggregator, "ProjectSave", output, null) as IList);
        Fail("save", saved);
        R.Call(aggregator, "ProjectClose");
        return new Dictionary<string, object?> { ["ok"] = true, ["xif"] = output, ["sha256"] = Sha256(File.ReadAllBytes(output)), ["reports"] = verify.Concat(saved).ToList() };
    }

    // ---- request helpers -----------------------------------------------------------------------

    private static string Text(Dictionary<string, object?> o, string name) =>
        o.TryGetValue(name, out var v) && v is string s && s.Length > 0 ? s : throw new EngineFailure("XIF_ENGINE_REQUEST", name + " is required.", null);

    private static IEnumerable<object?> Items(Dictionary<string, object?> o, string name) =>
        o.TryGetValue(name, out var v) && v is IEnumerable list && v is not string ? list.Cast<object?>() : Enumerable.Empty<object?>();

    private static string Absolute(string path, string name)
    {
        if (!Path.IsPathRooted(path) || path.StartsWith("\\\\", StringComparison.Ordinal))
            throw new EngineFailure("XIF_ENGINE_REQUEST", name + " must be an absolute local path.", null);
        return Path.GetFullPath(path);
    }

    private static string Sha256(byte[] bytes)
    {
        using var sha = SHA256.Create();
        return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
    }
}

/// <summary>Reflection over public members of the runtime type and of its interfaces (explicit implementations included).</summary>
internal static class R
{
    private const BindingFlags Flags = BindingFlags.Public | BindingFlags.Instance;

    private static IEnumerable<Type> Types(object target) => new[] { target.GetType() }.Concat(target.GetType().GetInterfaces());

    private static bool Accepts(ParameterInfo[] parameters, object?[] args) =>
        parameters.Length == args.Length && parameters.Select((p, i) => args[i] == null ? !p.ParameterType.IsValueType : p.ParameterType.IsInstanceOfType(args[i])).All(x => x);

    /// <summary>A new instance through the public constructor that takes exactly these arguments. Never Activator: its
    /// (Type, bool) overload means nonPublic and silently asks for a parameterless constructor.</summary>
    public static object New(Type type, params object?[] args)
    {
        var constructor = type.GetConstructors().FirstOrDefault(c => Accepts(c.GetParameters(), args))
            ?? throw new EngineFailure("XIF_ENGINE_UNAVAILABLE", type.Name + " has no public constructor (" + string.Join(", ", args.Select(a => a?.GetType().Name ?? "null")) + "); it has "
                + string.Join(" | ", type.GetConstructors().Select(c => "(" + string.Join(", ", c.GetParameters().Select(p => p.ParameterType.Name)) + ")")) + ".",
                "Install or repair Integration Studio 11; nothing was generated or sent.");
        return constructor.Invoke(args);
    }

    public static object? Get(object target, string name)
    {
        foreach (var type in Types(target))
            if (type.GetProperty(name, Flags) is { CanRead: true } property && property.GetIndexParameters().Length == 0) return property.GetValue(target, null);
        throw new EngineFailure("XIF_ENGINE_UNAVAILABLE", target.GetType().Name + " has no readable " + name + ".", "Install or repair Integration Studio 11.");
    }

    public static void Set(object target, string name, object? value)
    {
        foreach (var type in Types(target))
            if (type.GetProperty(name, Flags) is { CanWrite: true } property) { property.SetValue(target, value, null); return; }
        throw new EngineFailure("XIF_ENGINE_UNAVAILABLE", target.GetType().Name + " has no writable " + name + ".", "Install or repair Integration Studio 11.");
    }

    public static object? Call(object target, string name, params object?[] args)
    {
        foreach (var type in Types(target))
            foreach (var method in type.GetMethods(Flags).Where(m => m.Name == name && Accepts(m.GetParameters(), args)))
                return method.Invoke(target, args);
        throw new EngineFailure("XIF_ENGINE_UNAVAILABLE", target.GetType().Name + " has no method " + name + "(" + args.Length + ").", "Install or repair Integration Studio 11.");
    }

    public static List<object> List(object target, string name) => (Get(target, name) as IEnumerable)?.Cast<object>().ToList() ?? new List<object>();
}
