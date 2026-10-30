using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>One stylesheet of the platform as the runtime serves it before the app's own sheets (R3-A): <see cref="Id"/> its
/// place in <see cref="RuntimeCss.Order"/>, <see cref="Origin"/> what it is and its version ("osui@2.28.1"), <see cref="File"/>
/// the file the published page loads (what a warning names), <see cref="Css"/> the text as served.</summary>
public sealed record PlatformSheet(string Id, string Origin, string File, string Css)
{
    private string? _sha;
    public string Sha256 => _sha ??= RuntimeCss.Sha(Css);
}

/// <summary>The platform sheets of one lane and Studio version, read from the private store (<see cref="RuntimeCss.Load"/>), in
/// the runtime's order. <see cref="Status"/>: "present" (every sheet of <see cref="RuntimeCss.Order"/>), "partial" (some; the
/// absent ones in <see cref="Missing"/>), "missing" (none: the store has no folder for this version, or no store). Never an
/// approximation said as the real cascade: every answer that read them carries <see cref="Describe"/>.</summary>
public sealed record PlatformSheets(string Lane, string? Version, string Status, IReadOnlyList<PlatformSheet> Sheets, IReadOnlyList<string> Missing)
{
    public string? Folder { get; init; }
    public string? Osui { get; init; }
    public string? Runtime { get; init; }
    public string? Why { get; init; }
    public IReadOnlyList<string> Available { get; init; } = [];

    public static PlatformSheets None(string lane, string? version, string why, IReadOnlyList<string>? available = null) =>
        new(lane, version, "missing", [], RuntimeCss.Order.Select(o => o.Id).ToList()) { Why = why, Available = available ?? [] };

    /// <summary>{osui, runtime, sheets: present|partial|missing, version, missing?, why?}: what an answer says of the cascade it judged.</summary>
    public JsonObject Describe()
    {
        var o = new JsonObject { ["osui"] = Osui, ["runtime"] = Runtime, ["sheets"] = Status, ["version"] = Version };
        if (Missing.Count > 0) o["missing"] = new JsonArray(Missing.Select(m => (JsonNode)m).ToArray());
        if (Why != null) o["why"] = Why;
        if (Status != "present" && Available.Count > 0) o["available"] = new JsonArray(Available.Select(a => (JsonNode)a).ToArray());
        return o;
    }
}

/// <summary>
/// R3-A: the real stylesheets of the platform, the cascade the visual check (ScreenVisual.Platform) and render-document read in
/// place of rules written by hand. The OutSystems files never enter Git nor a public image: they live in a private folder,
/// one per lane and Studio version (<c>&lt;root&gt;/&lt;lane&gt;-&lt;version&gt;/</c>, the root in <see cref="EnvRoot"/>), with an
/// index (<c>index.json</c>, schema <see cref="Schema"/>: each sheet's id, origin, file, sha256, bytes and where it was read).
/// This code keeps only the extractor and the index: the order of the runtime (<see cref="Order"/>) and the way each sheet is
/// read from its source, the same way the ODC feature cache is fed (OdcFeatures):
/// <list type="bullet">
/// <item>from the Studio side: the OutSystems UI module (its OML, a producer capture) and its theme (<see cref="FromOml"/>);</item>
/// <item>from the environment: a published page of any app, whose &lt;link rel="stylesheet"&gt; name the runtime's base sheet and
/// the OutSystems UI theme (<see cref="FromPage"/>; app sheets are never kept);</item>
/// <item>from a bundle: a sheet file already on disk (<see cref="FromFile"/>).</item>
/// </list>
/// On the server the same extractor runs at build or start into the private volume the deployment names in
/// <see cref="EnvRoot"/>.
/// </summary>
public static class RuntimeCss
{
    public const string Schema = "ssam-runtime-css/1";
    /// <summary>The root of the private store; unset: <c>%USERPROFILE%\.ssam-hybrid\runtime-css</c>.</summary>
    public const string EnvRoot = "ANVIL_RUNTIME_CSS_DIR";
    public const string IndexFile = "index.json";

    /// <summary>The index of the code: the platform sheets in the order the runtime loads them, before the module's theme, its
    /// blocks and the screen (O11 and ODC Reactive/Mobile: read on published pages, OutSystemsReactWidgets.css then
    /// OutSystemsUI.OutSystemsUI.css).</summary>
    public static readonly IReadOnlyList<(string Id, string File, string What)> Order =
    [
        ("runtime", "OutSystemsReactWidgets.css", "the base stylesheet of the Reactive/Mobile runtime (the widgets' own rules)"),
        ("osui", "OutSystemsUI.OutSystemsUI.css", "the OutSystems UI theme"),
    ];

    /// <summary>The store's root folder.</summary>
    public static string Root => Environment.GetEnvironmentVariable(EnvRoot) is { Length: > 0 } root ? root
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".ssam-hybrid", "runtime-css");

    public static string Sha(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text ?? ""))).ToLowerInvariant();

    /// <summary>The folder name of a lane and version.</summary>
    public static string FolderName(string lane, string version) => Lane(lane) + "-" + version;

    private static string Lane(string lane) => RuntimeDomTable.IsOdc(lane) ? "odc" : "o11";

    private static readonly Dictionary<string, (DateTime Stamp, PlatformSheets Sheets)> Loaded = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The platform sheets of a lane for a Studio version (default: the bound Studio's, FunctionCatalog.StudioVersion),
    /// from <paramref name="root"/> (default <see cref="Root"/>): the folder of that exact version, else the longest version
    /// folder that is a dotted prefix of it ("11.55.92" serves 11.55.92.x); a root that is itself a version folder (an index.json
    /// at its top, the pinned form of a deployment) serves its lane. Each sheet is checked against its sha256 in the index; one
    /// that differs is left out and named. Read once per folder and index write time.</summary>
    public static PlatformSheets Load(string lane, string? version = null, string? root = null)
    {
        lane = Lane(lane);
        root ??= Root;
        try { version ??= StudioVersion(); } catch (Exception) { version = null; }
        if (!Directory.Exists(root)) return PlatformSheets.None(lane, version, $"no platform stylesheet store at {EnvRoot} (run anvil runtime-css extract)");
        string? folder = null;
        if (File.Exists(Path.Combine(root, IndexFile))) folder = root;
        var available = Directory.EnumerateDirectories(root, lane + "-*").Select(d => Path.GetFileName(d)!).Order(StringComparer.Ordinal).ToList();
        if (folder == null && version != null)
            folder = available.Where(name => Matches(name[(lane.Length + 1)..], version)).OrderByDescending(n => n.Length).Select(n => Path.Combine(root, n)).FirstOrDefault();
        if (folder == null || !File.Exists(Path.Combine(folder, IndexFile)))
            return PlatformSheets.None(lane, version, version == null ? "the Studio version is unknown" : $"the store has no folder for {lane} {version}", available);
        var index = Path.Combine(folder, IndexFile);
        var stamp = File.GetLastWriteTimeUtc(index);
        lock (Loaded)
            if (Loaded.TryGetValue(index, out var cached) && cached.Stamp == stamp) return cached.Sheets;
        var sheets = Read(folder, lane, version) with { Available = available };
        lock (Loaded) Loaded[index] = (stamp, sheets);
        return sheets;
    }

    private static bool Matches(string folderVersion, string version) =>
        string.Equals(folderVersion, version, StringComparison.OrdinalIgnoreCase) || version.StartsWith(folderVersion + ".", StringComparison.OrdinalIgnoreCase);

    private static string StudioVersion() => FunctionCatalog.StudioVersion;

    /// <summary>A version folder read and checked (its index, each sheet's bytes against its sha256).</summary>
    public static PlatformSheets Read(string folder, string lane, string? version)
    {
        JsonObject index;
        try { index = JsonNode.Parse(File.ReadAllText(Path.Combine(folder, IndexFile)))!.AsObject(); }
        catch (Exception error) { return PlatformSheets.None(lane, version, "the store's index could not be read: " + error.Message); }
        if (index["schema"]?.ToString() != Schema) return PlatformSheets.None(lane, version, $"the store's index is not {Schema}");
        var indexLane = index["lane"]?.ToString();
        if (indexLane != null && Lane(indexLane) != lane) return PlatformSheets.None(lane, version, $"the store's folder is of the {indexLane} lane");
        var byId = (index["sheets"] as JsonArray ?? []).OfType<JsonObject>().Where(s => s["id"] != null).GroupBy(s => s["id"]!.ToString()).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        var sheets = new List<PlatformSheet>();
        var missing = new List<string>();
        var problems = new List<string>();
        foreach (var (id, file, _) in Order)
        {
            if (!byId.TryGetValue(id, out var entry)) { missing.Add(id); continue; }
            var path = Path.Combine(folder, entry["path"]?.ToString() ?? id + ".css");
            if (!File.Exists(path)) { missing.Add(id); problems.Add($"{id}: its file is not in the store"); continue; }
            var css = File.ReadAllText(path, Encoding.UTF8);
            if (entry["sha256"]?.ToString() is { } sha && !string.Equals(sha, Sha(css), StringComparison.OrdinalIgnoreCase))
            {
                missing.Add(id); problems.Add($"{id}: its bytes differ from the index (sha256)"); continue;
            }
            sheets.Add(new PlatformSheet(id, entry["origin"]?.ToString() ?? id, entry["file"]?.ToString() ?? file, css));
        }
        var status = sheets.Count == 0 ? "missing" : missing.Count == 0 ? "present" : "partial";
        return new PlatformSheets(lane, index["version"]?.ToString() ?? version, status, sheets, missing)
        {
            Folder = folder, Osui = index["osui"]?.ToString(), Runtime = index["runtime"]?.ToString(),
            Why = problems.Count > 0 ? string.Join("; ", problems) : missing.Count > 0 ? "the store has no " + string.Join(", ", missing) + " sheet for this version" : null,
        };
    }

    // ---- the extractor ----------------------------------------------------------------------------------------------------

    /// <summary>The OutSystems UI version a sheet names in its leading comments ("OutSystems UI 2.28.1"), null when it names none.</summary>
    public static string? OsuiVersion(string css)
    {
        var head = css.Length > 4000 ? css[..4000] : css;
        var m = Regex.Match(head, @"OutSystems\s*UI[^0-9\r\n]{0,24}(\d+\.\d+\.\d+)", RegexOptions.IgnoreCase);
        return m.Success ? m.Groups[1].Value : null;
    }

    /// <summary>The OutSystems UI theme of a module file (the OutSystems UI module's OML or a capture of it): the theme named
    /// <paramref name="theme"/> (default "OutSystemsUI"), its stylesheet as the runtime serves it (the effective value: Theme Editor
    /// half and the author half composed).</summary>
    public static PlatformSheet FromOml(ModelHost host, string omlPath, string? theme = null, string? osuiVersion = null)
    {
        var module = host.Load(omlPath);
        try
        {
            var es = (OutSystems.Model.IESpace)module;
            var moduleName = TypeResolver.Name(es) ?? Path.GetFileNameWithoutExtension(omlPath);
            var wanted = theme ?? "OutSystemsUI";
            foreach (var t in es.MobileThemes)
            {
                if (!string.Equals(TypeResolver.Name(t), wanted, StringComparison.Ordinal)) continue;
                // As served: the effective value (the Theme Editor half and the author half composed), else the interface's text.
                var css = ThemeCss.Of(t)?.EffectiveValue is { Length: > 0 } effective ? effective : t.StyleSheet ?? "";
                if (css.Length == 0) throw new InvalidOperationException($"the theme {wanted} of {moduleName} has no stylesheet");
                var version = osuiVersion ?? OsuiVersion(css);
                return new PlatformSheet("osui", "osui@" + (version ?? "unknown"), moduleName + "." + wanted + ".css", css);
            }
            throw new InvalidOperationException($"{moduleName} has no theme {wanted} (themes: {string.Join(", ", es.MobileThemes.Cast<object>().Select(TypeResolver.Name))})");
        }
        finally { ModelHost.Release(module); }
    }

    /// <summary>A sheet file of a bundle: its id is one of <see cref="Order"/>.</summary>
    public static PlatformSheet FromFile(string id, string path, string? origin = null)
    {
        var known = Order.FirstOrDefault(o => o.Id == id);
        if (known.Id == null) throw new ArgumentException($"unknown platform sheet '{id}' (one of {string.Join(", ", Order.Select(o => o.Id))})");
        var css = File.ReadAllText(path, Encoding.UTF8);
        return new PlatformSheet(id, origin ?? (id == "osui" ? "osui@" + (OsuiVersion(css) ?? "unknown") : "platform:" + id), known.File, css);
    }

    private static readonly Regex LinkTag = new(@"<link\b[^>]*>", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex Href = new(@"\bhref\s*=\s*(?:""([^""]*)""|'([^']*)'|([^\s>]+))", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>The platform sheets a published page loads: each &lt;link rel="stylesheet"&gt; whose file is one of
    /// <see cref="Order"/> (by name, the query left out), fetched with <paramref name="fetch"/> (an absolute URL, its text).
    /// The app's own sheets (its theme, its screens) are never fetched nor kept.</summary>
    public static IReadOnlyList<PlatformSheet> FromPage(string html, Uri page, Func<Uri, string> fetch, string runtimeVersion)
    {
        var found = new List<PlatformSheet>();
        foreach (Match link in LinkTag.Matches(html))
        {
            if (!Regex.IsMatch(link.Value, @"\brel\s*=\s*[""']?stylesheet", RegexOptions.IgnoreCase)) continue;
            var href = Href.Match(link.Value) is { Success: true } h ? (h.Groups[1].Success ? h.Groups[1].Value : h.Groups[2].Success ? h.Groups[2].Value : h.Groups[3].Value) : null;
            if (string.IsNullOrEmpty(href)) continue;
            var url = new Uri(page, System.Net.WebUtility.HtmlDecode(href));
            var file = Path.GetFileName(url.AbsolutePath);
            var known = Order.FirstOrDefault(o => string.Equals(o.File, file, StringComparison.OrdinalIgnoreCase));
            if (known.Id == null || found.Any(f => f.Id == known.Id)) continue;
            var css = fetch(url);
            found.Add(new PlatformSheet(known.Id, known.Id == "osui" ? "osui@" + (OsuiVersion(css) ?? "unknown") : "platform:reactive-runtime@" + runtimeVersion, known.File, css));
        }
        return found;
    }

    /// <summary>Writes the sheets into the version folder of the store (merged with the sheets it has: a sheet read again
    /// replaces its own entry), the index last. Refused inside a Git working tree: the OutSystems files never enter Git.</summary>
    public static JsonObject Write(string root, string lane, string version, IReadOnlyList<PlatformSheet> sheets, IReadOnlyDictionary<string, string> sources)
    {
        if (!Regex.IsMatch(version, @"^\d+(\.\d+){1,3}$")) throw new ArgumentException($"version '{version}' is not a dotted Studio version (11.55.92)");
        var full = Path.GetFullPath(root);
        for (var dir = new DirectoryInfo(full); dir != null; dir = dir.Parent)
            if (Directory.Exists(Path.Combine(dir.FullName, ".git")) || File.Exists(Path.Combine(dir.FullName, ".git")))
                throw new InvalidOperationException($"the store {full} is inside the Git working tree {dir.FullName}: the OutSystems stylesheets never enter Git; choose a private folder");
        lane = Lane(lane);
        var folder = Path.Combine(full, FolderName(lane, version));
        Directory.CreateDirectory(folder);
        var indexPath = Path.Combine(folder, IndexFile);
        var entries = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        JsonObject? old = null;
        if (File.Exists(indexPath)) try { old = JsonNode.Parse(File.ReadAllText(indexPath))!.AsObject(); } catch (Exception) { }
        foreach (var e in (old?["sheets"] as JsonArray ?? []).OfType<JsonObject>()) if (e["id"]?.ToString() is { } id) entries[id] = (JsonObject)e.DeepClone();
        foreach (var sheet in sheets)
        {
            if (!Order.Any(o => o.Id == sheet.Id)) throw new ArgumentException($"unknown platform sheet '{sheet.Id}'");
            var file = sheet.Id + ".css";
            var temp = Path.Combine(folder, file + ".tmp");
            File.WriteAllText(temp, sheet.Css, new UTF8Encoding(false));
            File.Move(temp, Path.Combine(folder, file), overwrite: true);
            entries[sheet.Id] = new JsonObject
            {
                ["id"] = sheet.Id, ["origin"] = sheet.Origin, ["file"] = sheet.File, ["path"] = file, ["sha256"] = sheet.Sha256,
                ["bytes"] = Encoding.UTF8.GetByteCount(sheet.Css), ["source"] = sources.GetValueOrDefault(sheet.Id), ["extracted"] = DateTime.UtcNow.ToString("o"),
            };
        }
        var osui = entries.GetValueOrDefault("osui")?["origin"]?.ToString() is { } o && o.StartsWith("osui@", StringComparison.Ordinal) ? o["osui@".Length..] : old?["osui"]?.ToString();
        var index = new JsonObject
        {
            ["schema"] = Schema, ["lane"] = lane, ["version"] = version, ["osui"] = osui,
            ["runtime"] = old?["runtime"]?.ToString() ?? version,
            ["order"] = new JsonArray(Order.Select(x => (JsonNode)x.Id).ToArray()),
            ["sheets"] = new JsonArray(Order.Where(x => entries.ContainsKey(x.Id)).Select(x => (JsonNode)entries[x.Id]).ToArray()),
            ["updated"] = DateTime.UtcNow.ToString("o"),
        };
        var tempIndex = indexPath + ".tmp";
        File.WriteAllText(tempIndex, index.ToJsonString(new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));
        File.Move(tempIndex, indexPath, overwrite: true);
        var read = Read(folder, lane, version);
        return new JsonObject
        {
            ["folder"] = folder, ["index"] = indexPath, ["status"] = read.Status, ["platform"] = read.Describe(),
            ["sheets"] = new JsonArray(index["sheets"]!.AsArray().Select(s => (JsonNode)new JsonObject
            {
                ["id"] = s!["id"]!.ToString(), ["file"] = s["file"]?.ToString(), ["origin"] = s["origin"]?.ToString(), ["bytes"] = s["bytes"]?.GetValue<int>(), ["sha256"] = s["sha256"]?.ToString(),
            }).ToArray()),
        };
    }
}
