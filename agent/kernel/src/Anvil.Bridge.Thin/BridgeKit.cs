using System.Reflection;
using System.Text.Json.Nodes;
using OutSystems.ObjectKeys;

namespace Anvil.Bridge;

/// <summary>Generic plumbing the shared files need (docs/O11-BRIDGE-FINA.md section 2.4). Same surface as the full
/// bridge's BridgeKit, which delegates to the kernel; here each body is a copy (object keys, absolute paths, reflection
/// projection of Studio DTOs, interface properties, dialog classification), proved equal by the thin parity tests.</summary>
internal static class BridgeKit
{
    /// <summary>Studio base64 form or REST GUID form of the same object key.</summary>
    public static ObjectKey ParseKey(string key)
    {
        if (Guid.TryParse(key, out var g)) return ObjectKey.NewKey(g);
        return ObjectKey.Parse(key) ?? throw new FormatException("not an object key: " + key);
    }

    /// <summary>The form the REST URLs and the database take (ObjectKey.ToString("DB")).</summary>
    public static string DbKey(string key) => ParseKey(key).ToString("DB");

    /// <summary>The canonical Studio form (the one in the inventory and in OMLs).</summary>
    public static string StudioKey(string key) => ParseKey(key).ToString();

    /// <summary>Paths given to the bridge must be ABSOLUTE: the Studio process directory is its installation folder, so a
    /// relative path would land there. The error names the verb, the parameter, the value and the current directory.</summary>
    public static string Absolute(string verb, string param, string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new ArgumentException($"{verb}: '{param}' is required and must be an absolute path");
        if (!Path.IsPathFullyQualified(value))
            throw new ArgumentException(
                $"{verb}: '{param}' must be an absolute path, got '{value}'. A relative path would be resolved against the Studio process directory " +
                $"({Environment.CurrentDirectory}), not against your repository: pass the full path (e.g. C:\\...\\{value.Replace('/', '\\')})");
        return Path.GetFullPath(value);
    }

    /// <summary>Reflection projection of the Studio DTOs (structs with fields, ObjectKey, enums, arrays), tolerant of
    /// throwing getters.</summary>
    public static JsonNode? Project(object? value) => Project(value, 0);

    private static JsonNode? Project(object? o, int depth)
    {
        if (o == null) return null;
        if (depth > 4) return JsonValue.Create(o.ToString());
        switch (o)
        {
            case string s: return JsonValue.Create(s);
            case bool b: return JsonValue.Create(b);
            case int i: return JsonValue.Create(i);
            case long l: return JsonValue.Create(l);
            case decimal d: return JsonValue.Create(d);
            case double dd: return JsonValue.Create(dd);
            case DateTime dt: return JsonValue.Create(dt.ToString("o"));
            case byte[] bytes: return JsonValue.Create($"<{bytes.Length} bytes>");
            case Enum e: return JsonValue.Create(e.ToString());
            case Version v: return JsonValue.Create(v.ToString());
        }
        var type = o.GetType();
        if (type.FullName == "OutSystems.ObjectKeys.ObjectKey" || type.BaseType?.FullName == "OutSystems.ObjectKeys.ObjectKey")
            return JsonValue.Create(o.ToString());
        if (o is System.Collections.IEnumerable seq)
        {
            var arr = new JsonArray();
            foreach (var item in seq) arr.Add(Project(item, depth + 1));
            return arr;
        }
        var obj = new JsonObject();
        foreach (var p in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (!p.CanRead || p.GetIndexParameters().Length > 0) continue;
            try { obj[p.Name] = Project(p.GetValue(o), depth + 1); }
            catch (Exception ex) { obj[p.Name] = JsonValue.Create("<error " + (ex.InnerException ?? ex).GetType().Name + ">"); }
        }
        foreach (var f in type.GetFields(BindingFlags.Public | BindingFlags.Instance))
        {
            try { obj[f.Name] = Project(f.GetValue(o), depth + 1); }
            catch (Exception ex) { obj[f.Name] = JsonValue.Create("<error " + (ex.InnerException ?? ex).GetType().Name + ">"); }
        }
        return obj;
    }

    /// <summary>A property by name on the concrete type or on any interface: the Model API implements several properties
    /// explicitly through the interface, invisible to GetType().GetProperty.</summary>
    public static object? InterfaceProp(object o, string name)
    {
        var t = o.GetType();
        var p = t.GetProperty(name);
        if (p != null) { try { return p.GetValue(o); } catch { return null; } }
        foreach (var i in t.GetInterfaces())
        {
            var ip = i.GetProperty(name);
            if (ip != null) { try { return ip.GetValue(o); } catch { return null; } }
        }
        return null;
    }

    public const string ManageDependencies = "ManageDependencies";
    public const string MergeEditor = "MergeEditor";
    public const string Recovery = "Recovery";
    private const string MessageBox = "MessageBox";
    public const string Progress = "Progress", Modal = "Modal", WebDialog = "WebDialog";

    private static readonly string[] ProgressWords = { "opening", "loading", "downloading", "uploading", "please wait", "connecting", "checking", "publishing", "preparing" };

    /// <summary>A modal presenter blocks only when it is of a known kind; unknown ones (login, progress) are transient.</summary>
    public static bool IsBlockingPresenterKind(string kind) => kind is ManageDependencies or MergeEditor;

    /// <summary>The kind of a blocking presenter from its interface and type names.</summary>
    public static string ClassifyPresenter(IEnumerable<string> interfaceNames, string typeName)
    {
        var set = new HashSet<string>(interfaceNames, StringComparer.Ordinal);
        if (set.Contains("IAddRemoveReferencesPresenter")) return ManageDependencies;
        if (set.Contains("IMergeEditorPresenter")) return MergeEditor;
        return Modal + ":" + typeName;
    }

    /// <summary>The kind of an owned window from its title and visible texts.</summary>
    public static string ClassifyWindow(string? title, IEnumerable<string> texts)
    {
        var all = string.Join(" | ", texts.Prepend(title ?? ""));
        var hasButton = all.Contains("[Button]", StringComparison.Ordinal);
        if (!hasButton && string.Equals(title?.Trim(), "Progress", StringComparison.OrdinalIgnoreCase)) return Progress;
        if (!hasButton && (ProgressWords.Any(w => all.Contains(w, StringComparison.OrdinalIgnoreCase)) || all.Contains('%'))) return Progress;
        if (all.Contains("Discard", StringComparison.OrdinalIgnoreCase) && all.Contains("Open", StringComparison.OrdinalIgnoreCase)) return Recovery;
        if (all.Contains("Manage Dependencies", StringComparison.OrdinalIgnoreCase) || all.Contains("dependencies", StringComparison.OrdinalIgnoreCase)
            || all.Contains("references", StringComparison.OrdinalIgnoreCase) || all.Contains("[Button] Apply", StringComparison.OrdinalIgnoreCase)) return ManageDependencies;
        if (all.Contains("[Button] OK", StringComparison.OrdinalIgnoreCase) || all.Contains("[Button] Cancel", StringComparison.OrdinalIgnoreCase) || all.Contains("[Button] Yes", StringComparison.OrdinalIgnoreCase)) return MessageBox;
        return Modal;
    }

    /// <summary>The sentence that teaches the next step, by kind.</summary>
    public static string DialogHint(string kind) => kind switch
    {
        Recovery => "the Studio recovery dialog (Open | Discard) is open: `python scripts/cdp_pages.py --click Discard` (or Open) and retry",
        ManageDependencies => "the references dialog is open (a producer was republished with incompatible changes): `python scripts/cdp_pages.py` shows its buttons; `--click \"Manage Dependencies\"` then Apply updates the references, `--click Cancel` opens without updating; then retry; never restart the Studio for this",
        MergeEditor => "a merge editor is open in the Studio: finish or cancel it and retry",
        WebDialog => "a web dialog is open in the Studio (its text is not visible to the bridge): `python scripts/cdp_pages.py` lists its text and buttons; `--click <Button>` answers it (recovery after a kill: Discard or Open); then retry",
        _ => "a dialog is open in the Studio: read it with `windows` or `python scripts/cdp_pages.py`, answer it, and retry",
    };

    /// <summary>ScGuard.Corporate without corporateHosts in the customer's config.json: the thin bridge of the hosted pack
    /// knows none of the customer's environments, so it counts every host as corporate (fail closed). A write then needs
    /// corporateInstruction:true, which the server sends only after the user's explicit instruction for that environment.
    /// The full bridge counts no host.</summary>
    public const bool CorporateWhenUnconfigured = true;
}
