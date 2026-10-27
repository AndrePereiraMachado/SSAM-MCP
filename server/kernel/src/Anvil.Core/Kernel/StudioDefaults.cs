using System.Globalization;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core.Delivery;
using Anvil.Reading;
using Microsoft.Win32.SafeHandles;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>
/// The defaults of the screen reading (<see cref="ScreenDefaults"/>) of the installed Studio, for the pages of a UI flow. What a
/// fresh element is born with depends on the Studio, on the module it is created in (its kind: a Mobile app's Upload takes
/// images) and on the theme of the UI flow its page is in (its grid and the grid of the themes it is based on: a page of a flow
/// whose theme has no grid is born without one), so a measurement (<see cref="StudioBornValues"/>) answers for one Studio and
/// one context: the settings the module declares (every boolean, enumeration member and number of its Model API, the kind of
/// module among them) and the same of the theme the flow's pages take (the flow's Theme, else the module's default theme) and
/// of every theme it is based on. Nothing else of a flow is in it: the tests measure every flow of a module in itself and in a
/// fresh flow of its context, and they are born the same. The context is measured where it is exactly what the copy has: in a
/// fresh UI flow of a disposable copy of the module, given the theme of the context (<see cref="MeasureContext"/>), never in
/// one of the module's flows (the Model API gives them in another order on each load): the same module, read again, always
/// reads the same text, and whichever flow or module is measured first answers the same for its context.
/// Kept in memory and per user (SSAM_STUDIO_DEFAULTS_ROOT, else %USERPROFILE%\.ssam-hybrid\studio-defaults:
/// &lt;root&gt;\&lt;platform&gt;\studio-defaults.s&lt;schema&gt;-r&lt;recipe&gt;.&lt;identity&gt;.&lt;context&gt;.json, one file per kernel generation,
/// Studio and context, shared by every workspace and process of the user; <see cref="Generation"/>). The identity is the
/// platform, the IDE version, the measuring recipe and the SHA-256 of
/// every assembly of the Studio folder and its subfolders (OutSystems.* and ServiceStudio*, the plugins included): a Studio that
/// updates itself is another identity, measured again on its first reading of a screen. A process whose loaded Studio
/// assemblies are no longer the ones on disk (a resident process that outlived an update) measures for itself and keeps
/// nothing. What is kept is what the Studio gave the fresh elements (born values and roles); which of them are defaults is the
/// reading's rule (ScreenDefaults.FromBorn), applied when they are loaded.
/// A module where the Studio creates no page (no UI flow, screen or block: a service, an agent) has no defaults: the answer
/// says why (<see cref="ScreenDefaults.Note"/>), the reading prints it with every document and the writers refuse with it.
/// </summary>
internal static class StudioDefaults
{
    public const string Schema = "ssam-studio-defaults/3";

    // The bytes each module was loaded from (ModelHost.Load, JobRunner): the disposable copy is loaded from them, never from a
    // module in the middle of a change (what a job changed since is given to the copy: MeasureContext).
    private static readonly ConditionalWeakTable<ESpace, byte[]> Sources = new();
    // The answer each asker got (a UI flow; the module for a new flow), with the context it was for: asked again in the same
    // context it answers at once, in another one (a job gave the flow another theme) it is asked again.
    private sealed record Answer(string Context, ScreenDefaults Defaults);
    private static readonly ConditionalWeakTable<object, Answer> Answers = new();
    // The answer for each context of this process's Studio.
    private static readonly Dictionary<string, ScreenDefaults> ByContext = new(StringComparer.Ordinal);
    private static readonly object Gate = new();
    private static string? identity;
    private static JsonArray? assemblies;
    // Why this process keeps nothing on disk ("" when it does): its loaded Studio is not the one on disk.
    private static string stale = "";
    private static string? rootForTests;

    public static void Remember(ESpace espace, byte[] bytes) => Sources.AddOrUpdate(espace, bytes);

    /// <summary>The defaults of every context the module's pages can be in (each UI flow's, and a new flow's), measured now when
    /// this Studio was never measured here for one of them: a job calls it after loading its base, so no op measures inside the
    /// job's command but for a flow the job gives a theme of its own. A failure is kept in the answer the reading gets, never
    /// thrown here.</summary>
    public static void Prepare(ESpace module)
    {
        For(module, null);
        List<IObjectSignature> flows;
        try { flows = new StudioBornValues.Creator(module).Flows(); } catch (Exception) { return; }
        foreach (var flow in flows) For(module, flow);
    }

    /// <summary>The defaults of the installed Studio for the pages of <paramref name="flow"/> (null: a new UI flow of the module):
    /// kept for its context, else measured on a disposable copy of the module. Never thrown: a module without a page, or a
    /// failure, answers <see cref="ScreenDefaults.Unmeasured"/> with the reason.</summary>
    public static ScreenDefaults For(ESpace module, IObjectSignature? flow = null)
    {
        lock (Gate) {
            (string Key, JsonObject Facts) context;
            try { context = ContextOf(module, flow); }
            catch (Exception error) { return ScreenDefaults.Unmeasured("the settings of the module or of the theme of its UI flow could not be read: " + error.GetBaseException().Message); }
            var asker = flow ?? (object)module;
            if (Answers.TryGetValue(asker, out var known) && known.Context == context.Key) return known.Defaults;
            var answer = Compute(module, flow, context);
            Answers.AddOrUpdate(asker, new Answer(context.Key, answer));
            return answer;
        }
    }

    private static ScreenDefaults Compute(ESpace module, IObjectSignature? flow, (string Key, JsonObject Facts) context)
    {
        if (ByContext.TryGetValue(context.Key, out var kept)) return kept;
        string id;
        try { id = Identity(); }
        catch (Exception error) { return ScreenDefaults.Unmeasured("the Studio identity could not be read: " + error.GetBaseException().Message, context.Key); }
        if (stale.Length == 0 && CacheFile(id, context.Key) is { } keptFile && Load(keptFile, id, context.Key) is { } stored) return ByContext[context.Key] = stored;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        StudioBornValues.Measured born;
        try {
            var (_, given, why) = MeasureContext(module, flow, context);
            // A copy that cannot be given the context is this module's matter (a theme it cannot make): its asker keeps the
            // reason, the context is not kept.
            if (given == null) return ScreenDefaults.Unmeasured(why, context.Key);
            born = given;
        } catch (Exception error) { return ScreenDefaults.Unmeasured("the Studio could not be measured in this module: " + error.GetBaseException().Message, context.Key); }
        var file = stale.Length == 0 ? CacheFile(id, context.Key) : null;
        // A page (a screen or a block) is what makes a measurement: none means the Studio creates no page in such a module, which
        // is kept too (the next module of this context answers at once).
        var measured = born.Roles.Values.Any(r => r is "screen" or "block");
        var note = measured ? "" : "the installed Studio creates no page in a module like this one (" + string.Join("; ", born.Log.Take(3)) + ")";
        var json = new JsonObject {
            ["schema"] = Schema, ["identity"] = id, ["context"] = context.Key, ["contextFacts"] = context.Facts.DeepClone(),
            ["platform"] = StudioAdapter.Runtime.Platform, ["ideVersion"] = StudioAdapter.Runtime.IdeVersion, ["recipe"] = StudioBornValues.Recipe,
            ["module"] = ModelHost.Prop(module, "Name")?.ToString(), ["flow"] = flow == null ? null : ModelHost.Prop(flow, "Name")?.ToString(),
            ["measured"] = measured, ["note"] = note, ["assemblies"] = assemblies?.DeepClone(), ["measuredMs"] = sw.ElapsedMilliseconds,
            ["born"] = new JsonObject(born.Born.Select(k => KeyValuePair.Create(k.Key, (JsonNode?)new JsonObject(k.Value.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value)))))),
            ["roles"] = new JsonObject(born.Roles.Select(r => KeyValuePair.Create(r.Key, (JsonNode?)r.Value))),
            ["log"] = new JsonArray(born.Log.Select(l => (JsonNode?)l).ToArray()),
        };
        if (file != null) {
            try { DurableJson.WriteBytes(file, Encoding.UTF8.GetBytes(json.ToJsonString())); } catch (Exception) { /* a cache: the next process measures again */ }
        }
        return ByContext[context.Key] = FromJson(json);
    }

    /// <summary>The context of the pages of <paramref name="flow"/> (null: a new UI flow of the module): what a fresh element can
    /// take from where it is created. Every boolean, enumeration member and number the module's Model API declares (the kind of
    /// module, its default transition...) and the same of the theme the flow's pages take (<see cref="ThemeOf"/>: its grid) and of
    /// every theme it is based on (a theme whose grid is Inherited takes its base's), or that there is none; but the state every
    /// model object has (IObjectSignature: validity, deletion; its place among its siblings) and the reading's noise. Key:
    /// SHA-256 of the facts (hex, 8 bytes).</summary>
    internal static (string Key, JsonObject Facts) ContextOf(ESpace module, IObjectSignature? flow)
    {
        var facts = new JsonObject();
        Settings(facts, "module.", module);
        var theme = ThemeOf(module, flow);
        if (theme == null) facts["theme"] = "none";
        var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
        var prefix = "theme.";
        for (var t = theme; t != null && seen.Count < 8 && seen.Add(t); t = ModelHost.Prop(t, "BaseTheme") as IObjectSignature, prefix += "base.")
            Settings(facts, prefix, t);
        var text = string.Join("\n", facts.Select(f => f.Key + "=" + f.Value));
        return (Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..16].ToLowerInvariant(), facts);
    }

    /// <summary>The theme the pages of <paramref name="flow"/> take: its own Theme, else the module's default theme (also for a new
    /// flow, null); null when there is none.</summary>
    internal static IObjectSignature? ThemeOf(ESpace module, IObjectSignature? flow) =>
        (flow != null ? ModelHost.Prop(flow, "Theme") as IObjectSignature : null) ?? ModelHost.Prop(module, "EffectiveDefaultTheme") as IObjectSignature;

    // The state of a model object among its siblings (a fresh copy of a theme sits elsewhere): never a setting.
    private static readonly HashSet<string> Placement = new(StringComparer.Ordinal) { "CanMoveAfter", "CanMoveBefore", "IndexInParent" };

    // The settings of a model object: one property per name (a writable one when an interface declares it so: a signature
    // interface declares the same name read only).
    private static IEnumerable<System.Reflection.PropertyInfo> SettingProperties(Type type) =>
        ModelApiMetadata.Properties(type).Where(p => p.GetIndexParameters().Length == 0).GroupBy(p => p.Name).Select(g => g.FirstOrDefault(p => p.CanWrite) ?? g.First())
            .OrderBy(p => p.Name, StringComparer.Ordinal)
            .Where(p => p.DeclaringType != null && !p.DeclaringType.IsAssignableFrom(typeof(IObjectSignature)) && !ModelReader<IObjectSignature>.IsNoise(p.Name) && !Placement.Contains(p.Name))
            .Where(p => (Nullable.GetUnderlyingType(p.PropertyType) ?? p.PropertyType) is var type
                && (type.IsEnum || Type.GetTypeCode(type) is >= TypeCode.Boolean and <= TypeCode.Decimal and not TypeCode.Char));

    private static void Settings(JsonObject facts, string prefix, object node)
    {
        foreach (var p in SettingProperties(node.GetType())) {
            object? value;
            try { value = p.GetValue(node); } catch (Exception) { continue; }
            facts[prefix + p.Name] = value switch { null => "", bool b => b ? "True" : "False", IFormattable f => f.ToString(null, CultureInfo.InvariantCulture), _ => value.ToString() };
        }
    }

    /// <summary>
    /// A measurement of the context of <paramref name="flow"/> (null: a new UI flow) of the module, never kept. In a disposable copy
    /// of the module (the bytes it was loaded from, else saved now), in a fresh UI flow (of the kind of the flow asked about, else
    /// of the module's flows, else the recipe's) given the theme of the context: the module's default theme leaves its Theme
    /// unset; another theme is the copy's same theme (by key), else (a theme a job made since the bytes) a fresh theme with its
    /// settings and its base; the module's settings a job changed since the bytes are given to the copy too. The flow is never one
    /// of the module's: the Model API gives them in another order on each load, and their pages are in another context when their
    /// theme is another. The context of the fresh flow is then read and checked against the one asked, fact by fact: Born null
    /// with the reason (Why) when the copy could not be given it.
    /// </summary>
    internal static (string Context, StudioBornValues.Measured? Born, string Why) MeasureContext(ESpace module, IObjectSignature? flow, (string Key, JsonObject Facts)? asked = null)
    {
        var context = asked ?? ContextOf(module, flow);
        var bytes = Sources.TryGetValue(module, out var source) ? source : StudioAdapter.Runtime.Save(module);
        var copy = StudioAdapter.Runtime.Load(bytes);
        try {
            var maker = new StudioBornValues.Creator(copy);
            var r = maker.Reader;
            Assign(maker, (IObjectSignature)copy, module);
            var kinds = (flow != null ? [r.KindOf(flow)] : Enumerable.Empty<string>())
                .Concat(maker.Flows().Select(f => r.KindOf(f)).Distinct().Order(StringComparer.Ordinal)).Concat(StudioBornValues.FlowKinds);
            var place = maker.NewFlow(kinds);
            if (place == null) {
                maker.Log.Add("no UI flow could be created in the module: nothing measured");
                return (context.Key, new StudioBornValues.Measured(new(StringComparer.Ordinal), new(StringComparer.Ordinal), maker.Log), "");
            }
            var where = flow == null ? "a new UI flow" : "the UI flow " + ModelHost.Prop(flow, "Name");
            if (ThemeOf(module, flow) is { } theme) {
                var copyDefault = ModelHost.Prop(copy, "EffectiveDefaultTheme") as IObjectSignature;
                var isDefault = copyDefault != null && r.KeyOf(copyDefault) == r.KeyOf(theme);
                var given = isDefault ? copyDefault : Find(maker, theme, module) ?? Replica(maker, theme, module, 0);
                if (given == null || !isDefault && !maker.Set(place, "Theme", given))
                    return (context.Key, null, "the theme of " + where + " (" + ModelHost.Prop(theme, "Name") + ") could not be given to a fresh UI flow of a copy of the module: " + string.Join("; ", maker.Log.TakeLast(3)));
                // What a job changed in that theme since the bytes (its settings, its base).
                Align(maker, given, theme, module, 0);
            }
            var got = ContextOf(copy, place);
            if (got.Key != context.Key) {
                var differ = context.Facts.Select(f => f.Key).Union(got.Facts.Select(f => f.Key)).Order(StringComparer.Ordinal)
                    .Where(k => context.Facts[k]?.ToString() != got.Facts[k]?.ToString()).Take(6)
                    .Select(k => k + " " + (context.Facts[k]?.ToString() ?? "(none)") + " here, " + (got.Facts[k]?.ToString() ?? "(none)") + " in the copy");
                return (context.Key, null, "a fresh UI flow of a copy of the module does not take the context of " + where + ": " + string.Join("; ", differ)
                    + (maker.Log.Count > 0 ? " (" + string.Join("; ", maker.Log.TakeLast(3)) + ")" : ""));
            }
            return (context.Key, StudioBornValues.Measure(maker, place), "");
        }
        finally { StudioAdapter.Runtime.Release(copy); }
    }

    // The copy's element that is this element of the module (the same kind and key along the path from the module: an own theme
    // is a child of the module, a producer's one of its reference), or null.
    private static IObjectSignature? Find(StudioBornValues.Creator maker, IObjectSignature element, ESpace module)
    {
        var r = maker.Reader;
        var path = new List<IObjectSignature>();
        for (var at = element; !ReferenceEquals(at, module); at = r.ParentOf(at)) {
            if (at == null || path.Count > 4) return null;
            path.Add(at);
        }
        path.Reverse();
        IObjectSignature? node = (IObjectSignature)maker.Module;
        foreach (var step in path) {
            var (key, kind) = (r.KeyOf(step), r.KindOf(step));
            node = key.Length == 0 ? null : r.ChildrenOf(node).FirstOrDefault(c => r.KindOf(c) == kind && r.KeyOf(c) == key);
            if (node == null) return null;
        }
        return node;
    }

    // A fresh theme of the copy with the settings and the base of a theme of the module the copy does not have (made since the
    // bytes); null when the Studio refuses to make one.
    private static IObjectSignature? Replica(StudioBornValues.Creator maker, IObjectSignature theme, ESpace module, int depth)
    {
        if (depth > 4 || maker.Make((IObjectSignature)maker.Module, maker.Reader.KindOf(theme)) is not { } made) return null;
        Align(maker, made, theme, module, depth);
        return made;
    }

    // A theme of the copy brought to the base and the settings the module's theme has now (each theme it is based on too). What
    // the Studio refuses is logged; the check of the context names what stays different.
    private static void Align(StudioBornValues.Creator maker, IObjectSignature copyTheme, IObjectSignature theme, ESpace module, int depth)
    {
        var r = maker.Reader;
        var based = ModelHost.Prop(theme, "BaseTheme") as IObjectSignature;
        var copyBased = ModelHost.Prop(copyTheme, "BaseTheme") as IObjectSignature;
        if (based == null ? copyBased != null : copyBased == null || r.KeyOf(copyBased) != r.KeyOf(based)) {
            copyBased = based == null ? null : Find(maker, based, module) ?? Replica(maker, based, module, depth + 1);
            if (based == null || copyBased != null) maker.Set(copyTheme, "BaseTheme", copyBased);
        }
        else if (based != null && copyBased != null && depth < 4) Align(maker, copyBased, based, module, depth + 1);
        Assign(maker, copyTheme, theme);
    }

    // The settings of `source` written on `target` where they differ (a setting can move another: a grid of No sets the columns),
    // until none differs (three passes at most). What the Studio refuses is logged; the check of the context names it.
    private static void Assign(StudioBornValues.Creator maker, IObjectSignature target, object source)
    {
        for (var pass = 0; pass < 3; pass++) {
            var changed = false;
            foreach (var p in SettingProperties(source.GetType()).Where(p => p.CanWrite && p.DeclaringType!.IsInstanceOfType(target))) {
                object? wanted, now;
                try { wanted = p.GetValue(source); now = p.GetValue(target); } catch (Exception) { continue; }
                if (!Equals(wanted, now)) changed |= maker.Set(target, p, wanted);
            }
            if (!changed) return;
        }
    }

    /// <summary>The kept measurement of this Studio for this context, or null (another schema, identity or context, or a file
    /// that does not parse).</summary>
    private static ScreenDefaults? Load(string file, string id, string context)
    {
        try {
            if (!File.Exists(file)) return null;
            var json = JsonNode.Parse(File.ReadAllBytes(file))!.AsObject();
            return json["schema"]?.ToString() == Schema && json["identity"]?.ToString() == id && json["context"]?.ToString() == context ? FromJson(json) : null;
        } catch (Exception) { return null; }
    }

    private static ScreenDefaults FromJson(JsonObject json)
    {
        var context = json["context"]?.ToString() ?? "";
        if (json["measured"]?.GetValue<bool>() != true) return ScreenDefaults.Unmeasured(json["note"]?.ToString() ?? "not measured", context);
        var born = new Dictionary<string, SortedDictionary<string, string>>(StringComparer.Ordinal);
        foreach (var (kind, facts) in json["born"]!.AsObject())
            born[kind] = new SortedDictionary<string, string>(facts!.AsObject().ToDictionary(p => p.Key, p => p.Value!.GetValue<string>()), StringComparer.Ordinal);
        var roles = json["roles"]!.AsObject().ToDictionary(r => r.Key, r => r.Value!.GetValue<string>(), StringComparer.Ordinal);
        return ScreenDefaults.FromBorn(json["identity"]!.GetValue<string>(), born, roles, context);
    }

    /// <summary>The versions in the name of a kept file: the schema of the file and the measuring recipe
    /// (<see cref="StudioBornValues.Recipe"/>), so two kernel releases that share one root never read or overwrite each other's
    /// measurement of one Studio and context (as ModuleIndexStore.Generation does for the module index).</summary>
    internal static string Generation => "s" + Schema[(Schema.LastIndexOf('/') + 1)..] + "-r" + StudioBornValues.Recipe.ToString(CultureInfo.InvariantCulture);

    internal static string CacheFileName(string generation, string id, string context) => "studio-defaults." + generation + "." + id + "." + context + ".json";

    private static string? CacheFile(string id, string context) => CacheDir() is { } dir ? Path.Combine(dir, CacheFileName(Generation, id, context)) : null;

    // SSAM_STUDIO_DEFAULTS_ROOT (absolute), else <profile>\.ssam-hybrid\studio-defaults; one folder per platform. Null without
    // either (nothing is kept on disk: each process measures once per context).
    private static string? CacheDir()
    {
        var configured = rootForTests ?? Environment.GetEnvironmentVariable("SSAM_STUDIO_DEFAULTS_ROOT");
        var profile = Environment.GetEnvironmentVariable("USERPROFILE") is { Length: > 0 } user ? user : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var root = !string.IsNullOrWhiteSpace(configured) ? (Path.IsPathFullyQualified(configured) ? configured : null)
            : profile.Length > 0 ? Path.Combine(profile, ".ssam-hybrid", "studio-defaults") : null;
        return root == null ? null : Path.Combine(root, StudioAdapter.Runtime.Platform);
    }

    /// <summary>Platform, IDE version, recipe and the SHA-256 of every assembly of the Studio folder and its subfolders
    /// (OutSystems.*.dll, ServiceStudio*.dll: the plugins too), by path relative to the folder, in one SHA-256 (hex, 16 bytes).
    /// File hashes are kept per path beside the cache and reused only when the file's size, write time, creation time and NTFS
    /// change time are the same (a content written with its old write time put back still moves the change time); without the
    /// change time every file is hashed. Also checks that the model assemblies this process loaded are the ones on disk (by
    /// MVID): when not, the process keeps nothing on disk.</summary>
    public static string Identity()
    {
        lock (Gate) {
            if (identity != null) return identity;
            var runtime = StudioAdapter.Runtime;
            var dir = runtime.StudioDirectory;
            var memoFile = CacheDir() is { } cacheDir ? Path.Combine(cacheDir, "studio-assemblies.json") : null;
            JsonObject memo;
            try { memo = memoFile != null && File.Exists(memoFile) ? JsonNode.Parse(File.ReadAllBytes(memoFile))!.AsObject() : []; } catch (Exception) { memo = []; }
            var changed = false;
            var list = new JsonArray();
            var files = Directory.Exists(dir)
                ? Directory.EnumerateFiles(dir, "*.dll", SearchOption.AllDirectories).Where(f => IsStudioAssembly(Path.GetFileName(f)))
                    .Select(f => (Path: f, Relative: Path.GetRelativePath(dir, f))).OrderBy(f => f.Relative, StringComparer.OrdinalIgnoreCase).ToList()
                : [];
            foreach (var (path, relative) in files) {
                var stamp = Stamp(path);
                string hash;
                if (stamp != null && memo[path] is JsonObject known && known["stamp"]?.ToString() == stamp && known["sha256"]?.ToString() is { Length: 64 } keptHash) hash = keptHash;
                else {
                    using (var stream = File.OpenRead(path)) hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
                    if (stamp != null) { memo[path] = new JsonObject { ["stamp"] = stamp, ["sha256"] = hash }; changed = true; }
                }
                list.Add(new JsonObject { ["name"] = relative, ["sha256"] = hash });
            }
            if (changed && memoFile != null) {
                try { DurableJson.WriteBytes(memoFile, Encoding.UTF8.GetBytes(memo.ToJsonString())); } catch (Exception) { }
            }
            assemblies = list;
            stale = Stale();
            var text = runtime.Platform + "\n" + runtime.IdeVersion + "\n" + StudioBornValues.Recipe + "\n" + string.Join("\n", list.Select(a => a!["name"] + " " + a["sha256"]));
            return identity = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..32].ToLowerInvariant();
        }
    }

    private static bool IsStudioAssembly(string name) =>
        name.StartsWith("OutSystems.", StringComparison.OrdinalIgnoreCase) || name.StartsWith("ServiceStudio", StringComparison.OrdinalIgnoreCase);

    // Size, write time, creation time and NTFS change time of a file; null when the change time cannot be read (the file is then
    // always hashed).
    internal static string? Stamp(string path)
    {
        try {
            var info = new FileInfo(path);
            using var handle = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (!GetFileInformationByHandleEx(handle, 0 /* FileBasicInfo */, out var basic, (uint)Marshal.SizeOf<FileBasicInfo>())) return null;
            return string.Join(":", info.Length, info.LastWriteTimeUtc.Ticks, basic.CreationTime, basic.ChangeTime);
        } catch (Exception) { return null; }
    }

    // "" when the model assemblies this process loaded (the Model API and the model, which every Studio update rebuilds) are the
    // files on disk, by MVID; else why not.
    private static string Stale()
    {
        try {
            foreach (var assembly in new[] { typeof(IESpace).Assembly, typeof(ESpace).Assembly }.Distinct()) {
                if (assembly.IsDynamic || assembly.Location is not { Length: > 0 } location) continue;
                if (!File.Exists(location)) return Path.GetFileName(location) + " was loaded and is no longer on disk";
                using var stream = File.OpenRead(location);
                using var pe = new PEReader(stream);
                var metadata = pe.GetMetadataReader();
                if (metadata.GetGuid(metadata.GetModuleDefinition().Mvid) != assembly.ManifestModule.ModuleVersionId)
                    return Path.GetFileName(location) + " on disk is not the one this process loaded";
            }
            return "";
        } catch (Exception error) { return "the loaded Studio assemblies could not be checked: " + error.GetBaseException().Message; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileBasicInfo { public long CreationTime, LastAccessTime, LastWriteTime, ChangeTime; public uint FileAttributes; }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int infoClass, out FileBasicInfo info, uint size);

    /// <summary>Why this process keeps nothing on disk ("" when it keeps): its loaded Studio is not the one on disk.</summary>
    internal static string StaleReason { get { Identity(); return stale; } }

    /// <summary>Tests only: forget what this process measured and answered (a new process) and keep the measurements under
    /// <paramref name="root"/> from now on (null: back to SSAM_STUDIO_DEFAULTS_ROOT or the profile).</summary>
    internal static void ResetForTests(string? root = null)
    {
        lock (Gate) { ByContext.Clear(); Answers.Clear(); rootForTests = root; }
    }
}
