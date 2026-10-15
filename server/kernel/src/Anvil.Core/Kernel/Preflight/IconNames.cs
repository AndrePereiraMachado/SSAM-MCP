using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// motor2 (2026-10-12): the icon names an html op may write, from the bound Studio, for the preflight (no module needed).
/// O11: the FontAwesome 4.7 catalog the Service Studio itself ships (the embedded resource IconResources/icons.json of
/// ServiceStudio.Plugin.NRWidgets: 634 ids and their aliases, with the search words of its picker), read from the plugin file
/// without loading it. ODC: the active library and the conversion table of IconCatalog (when the ODC Studio is bound). No
/// catalog (no Studio): nothing is judged.
/// </summary>
public static class IconNames
{
    /// <summary>The names of a library: valid (ids and aliases), the search words of each id, and the library's name.</summary>
    public sealed record Catalog(string Library, IReadOnlySet<string> Valid, IReadOnlyDictionary<string, IReadOnlyList<string>> Words);

    /// <summary>What a written name is: valid as written; one certain name (a normalization: the rule that says why); or
    /// unknown, with the name a refusal's patch may write when one is meant for certain (<see cref="Suggested"/>: a name of
    /// the table of other libraries, or the one id whose search words have the name) and the closest names for the message.</summary>
    public sealed record Verdict(string Name, bool Valid, string? Certain, string? Rule, IReadOnlyList<string> Closest, string? Suggested = null, string? SuggestedBy = null);

    private static readonly AsyncLocal<Catalog?> OverrideValue = new();

    /// <summary>A catalog for tests (and hosts that read it otherwise), for the current flow only; null reads the bound Studio.</summary>
    public static Catalog? Override { get => OverrideValue.Value; set => OverrideValue.Value = value; }

    private static readonly Lazy<Catalog?> O11 = new(LoadO11);

    public static Catalog? For(string lane)
    {
        if (Override != null) return Override;
        if (lane == "odc")
        {
            if (IconCatalog.Current is not { } table) return null;
            var valid = new HashSet<string>(table.Active, StringComparer.Ordinal);
            return new Catalog(table.Library, valid, new Dictionary<string, IReadOnlyList<string>>());
        }
        return O11.Value;
    }

    /// <summary>The class words around an icon name in other libraries' markup (fa-solid fa-house, fas fa-house, fa fa-home,
    /// material-icons): never the name.</summary>
    private static readonly HashSet<string> StyleClasses = new(StringComparer.OrdinalIgnoreCase)
    {
        "fa", "fas", "far", "fal", "fat", "fad", "fab", "fass", "fa-solid", "fa-regular", "fa-light", "fa-thin", "fa-duotone", "fa-brands", "fa-sharp",
        "fa-fw", "fa-lg", "fa-xs", "fa-sm", "fa-2x", "fa-3x", "fa-4x", "fa-5x", "fa-spin", "fa-pulse", "fa-border", "fa-inverse",
        "material-icons", "material-icons-outlined", "material-icons-round", "material-icons-sharp", "material-symbols-outlined", "material-symbols-rounded", "mdi", "icon",
    };

    /// <summary>The names other libraries give an icon the FontAwesome 4.7 of the Service Studio names otherwise (Material
    /// Icons, Font Awesome 5/6), for a refusal's patch: the meaning, never the spelling (schedule is a clock, not shekel). A
    /// name whose target the active catalog does not have is not used.</summary>
    private static readonly Dictionary<string, string> Table = new(StringComparer.OrdinalIgnoreCase)
    {
        // Material Icons
        ["schedule"] = "clock-o", ["access-time"] = "clock-o", ["alarm"] = "clock-o", ["punch-clock"] = "clock-o", ["watch-later"] = "clock-o", ["query-builder"] = "clock-o",
        ["access-alarm"] = "clock-o", ["more-time"] = "clock-o",
        ["today"] = "calendar", ["event"] = "calendar", ["calendar-today"] = "calendar", ["date-range"] = "calendar", ["event-note"] = "calendar", ["calendar-month"] = "calendar",
        ["event-available"] = "calendar-check-o",
        ["visibility"] = "eye", ["visibility-off"] = "eye-slash",
        ["more-vert"] = "ellipsis-v", ["more-horiz"] = "ellipsis-h",
        ["person"] = "user", ["account-circle"] = "user", ["account-box"] = "user", ["face"] = "user", ["person-outline"] = "user",
        ["person-add"] = "user-plus", ["group"] = "users", ["people"] = "users", ["groups"] = "users",
        ["delete"] = "trash", ["delete-outline"] = "trash-o", ["delete-forever"] = "trash",
        ["add"] = "plus", ["add-circle"] = "plus-circle", ["add-circle-outline"] = "plus-circle", ["remove"] = "minus", ["remove-circle"] = "minus-circle",
        ["logout"] = "sign-out", ["exit-to-app"] = "sign-out", ["login"] = "sign-in",
        ["settings"] = "cog", ["tune"] = "sliders",
        ["close"] = "times", ["clear"] = "times", ["cancel"] = "times-circle", ["highlight-off"] = "times-circle",
        ["done"] = "check", ["done-all"] = "check", ["check-circle"] = "check-circle", ["check-circle-outline"] = "check-circle-o", ["task-alt"] = "check-circle",
        ["menu"] = "bars",
        ["arrow-back"] = "arrow-left", ["arrow-forward"] = "arrow-right", ["arrow-upward"] = "arrow-up", ["arrow-downward"] = "arrow-down",
        ["expand-more"] = "chevron-down", ["expand-less"] = "chevron-up", ["keyboard-arrow-down"] = "chevron-down", ["keyboard-arrow-up"] = "chevron-up",
        ["keyboard-arrow-left"] = "chevron-left", ["keyboard-arrow-right"] = "chevron-right", ["navigate-before"] = "chevron-left", ["navigate-next"] = "chevron-right",
        ["arrow-back-ios"] = "chevron-left", ["arrow-forward-ios"] = "chevron-right",
        ["info-outline"] = "info-circle", ["error"] = "exclamation-circle", ["error-outline"] = "exclamation-circle", ["report-problem"] = "exclamation-triangle",
        ["help"] = "question-circle", ["help-outline"] = "question-circle",
        ["create"] = "pencil", ["mode-edit"] = "pencil", ["edit-note"] = "pencil-square-o",
        ["email"] = "envelope", ["mail"] = "envelope", ["mail-outline"] = "envelope-o", ["call"] = "phone",
        ["notifications"] = "bell", ["notifications-none"] = "bell-o", ["notifications-active"] = "bell",
        ["favorite"] = "heart", ["favorite-border"] = "heart-o", ["star-border"] = "star-o",
        ["attach-file"] = "paperclip", ["cloud-upload"] = "cloud-upload", ["cloud-download"] = "cloud-download", ["file-download"] = "download", ["file-upload"] = "upload",
        ["description"] = "file-text-o", ["article"] = "file-text-o", ["insert-drive-file"] = "file-o", ["picture-as-pdf"] = "file-pdf-o",
        ["folder-open"] = "folder-open",
        ["work"] = "briefcase", ["work-outline"] = "briefcase",
        ["place"] = "map-marker", ["location-on"] = "map-marker", ["room"] = "map-marker",
        ["shopping-cart"] = "shopping-cart", ["add-shopping-cart"] = "cart-plus", ["payment"] = "credit-card", ["credit-card"] = "credit-card", ["attach-money"] = "usd",
        ["view-list"] = "th-list", ["view-module"] = "th-large", ["filter-list"] = "filter",
        ["sync"] = "refresh", ["autorenew"] = "refresh", ["lock-open"] = "unlock", ["restore"] = "history", ["hourglass-empty"] = "hourglass-o",
        ["photo"] = "picture-o", ["camera-alt"] = "camera", ["photo-camera"] = "camera",
        ["restaurant"] = "cutlery", ["local-dining"] = "cutlery", ["lunch-dining"] = "cutlery", ["local-cafe"] = "coffee", ["free-breakfast"] = "coffee",
        ["light-mode"] = "sun-o", ["dark-mode"] = "moon-o",
        ["open-in-new"] = "external-link", ["launch"] = "external-link", ["redo"] = "repeat", ["block"] = "ban",
        ["label"] = "tag", ["local-offer"] = "tag", ["vpn-key"] = "key", ["security"] = "shield", ["flash-on"] = "bolt",
        ["thumb-up"] = "thumbs-up", ["thumb-down"] = "thumbs-down", ["business"] = "building", ["apartment"] = "building",
        ["public"] = "globe", ["language"] = "globe", ["chat"] = "comments", ["forum"] = "comments", ["question-answer"] = "comments", ["chat-bubble"] = "comment",
        // Font Awesome 5/6 names of icons FontAwesome 4.7 names otherwise
        ["house"] = "home", ["xmark"] = "times", ["magnifying-glass"] = "search", ["gears"] = "cogs", ["pen"] = "pencil", ["pen-to-square"] = "pencil-square-o",
        ["trash-can"] = "trash-o", ["right-from-bracket"] = "sign-out", ["arrow-right-from-bracket"] = "sign-out", ["right-to-bracket"] = "sign-in",
        ["arrow-right-to-bracket"] = "sign-in", ["circle-user"] = "user", ["user-large"] = "user", ["circle-check"] = "check-circle", ["circle-xmark"] = "times-circle",
        ["circle-info"] = "info-circle", ["circle-question"] = "question-circle", ["circle-exclamation"] = "exclamation-circle",
        ["triangle-exclamation"] = "exclamation-triangle", ["ellipsis-vertical"] = "ellipsis-v", ["ellipsis"] = "ellipsis-h", ["calendar-days"] = "calendar",
        ["calendar-day"] = "calendar", ["floppy-disk"] = "floppy-o", ["file-lines"] = "file-text-o", ["arrow-rotate-right"] = "repeat", ["rotate-right"] = "repeat",
        ["location-dot"] = "map-marker", ["cart-shopping"] = "shopping-cart", ["dollar-sign"] = "usd", ["table-list"] = "th-list", ["table-cells-large"] = "th-large",
        ["up-right-from-square"] = "external-link", ["arrow-up-right-from-square"] = "external-link", ["utensils"] = "cutlery", ["mug-saucer"] = "coffee",
        ["sun"] = "sun-o", ["moon"] = "moon-o", ["shield-halved"] = "shield", ["user-group"] = "users", ["earth-americas"] = "globe",
    };

    /// <summary>The name written without the class words of another library's markup (fa-solid fa-house: house), or as is.</summary>
    private static string Bare(string name)
    {
        var words = name.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        var left = words.Where(w => !StyleClasses.Contains(w)).ToList();
        var bare = left.Count == 1 ? left[0] : name;
        foreach (var prefix in new[] { "fa-", "icon-", "mdi-" })
            if (bare.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && bare.Length > prefix.Length) { bare = bare[prefix.Length..]; break; }
        return bare;
    }

    /// <summary>The verdict of a name. Certain (a normalization): the name in another case; written with class words or a
    /// class prefix (fa-home, "fa fa-home", "fa-solid fa-home"); with _ or spaces for - (arrow_left); the outline form X-o when
    /// only it exists (clock: clock-o). ODC: a name the conversion table maps is valid (the apply converts it, IconCatalog).
    /// Anything else is unknown. Its patch (Suggested) only when the meaning is certain: the table of the names Material Icons
    /// and Font Awesome 5/6 give the icon (schedule: clock-o), or the search words of the catalog (logout: sign-out, add: plus,
    /// event: calendar), when one id has the word or the ids that have it are the variants of one (plus, plus-circle,
    /// plus-square). Never by spelling alone (schedule is not shekel); the closest by spelling only name options.</summary>
    public static Verdict Judge(string written, Catalog catalog, string lane)
    {
        var name = written.Trim();
        if (catalog.Valid.Contains(name)) return new(name, true, null, null, []);
        if (lane == "odc" && IconCatalog.Current is { } table && table.Conversion.ContainsKey(name)) return new(name, true, null, null, []);
        string? Valid(string candidate) => catalog.Valid.FirstOrDefault(v => v.Equals(candidate, StringComparison.OrdinalIgnoreCase));
        var bare = Bare(name);
        var dashed = bare.Replace('_', '-').Replace(' ', '-');
        if (Valid(name) is { } cased) return new(name, false, cased, "the same icon in the catalog's case", []);
        if (!string.Equals(bare, name, StringComparison.Ordinal) && Valid(bare) is { } unprefixed) return new(name, false, unprefixed, "the icon name without the class words of the markup", []);
        if (!string.Equals(dashed, bare, StringComparison.Ordinal) && Valid(dashed) is { } withDashes) return new(name, false, withDashes, "the icon name written with - as the catalog writes it", []);
        if (lane == "o11" && Valid(dashed + "-o") is { } outline && Valid(dashed) == null) return new(name, false, outline, $"{catalog.Library} names this icon {outline} (its outline form; there is no {dashed})", []);
        var spaced = dashed.Replace('-', ' ');
        var hits = catalog.Words.Where(w => w.Value.Any(word => word.Equals(dashed, StringComparison.OrdinalIgnoreCase) || word.Equals(spaced, StringComparison.OrdinalIgnoreCase)))
            .Select(w => w.Key).OrderBy(k => k.Length).ThenBy(k => k, StringComparer.Ordinal).ToList();
        var searched = catalog.Words.Where(w => w.Value.Any(word => word.Equals(dashed, StringComparison.OrdinalIgnoreCase)) || w.Key.Contains(dashed, StringComparison.OrdinalIgnoreCase))
            .Select(w => w.Key).OrderBy(k => NameSuggestions.Distance(dashed.ToUpperInvariant(), k.ToUpperInvariant())).ThenBy(k => k, StringComparer.Ordinal).Take(4).ToList();
        string? suggested = null; string? by = null;
        if (Table.TryGetValue(dashed, out var meant) && Valid(meant) is { } fromTable) { suggested = fromTable; by = $"'{dashed}' in Material Icons or Font Awesome 5/6 is {fromTable} in {catalog.Library}"; }
        else if (hits.Count == 1) { suggested = hits[0]; by = $"the search words of {hits[0]} have '{dashed}'"; }
        else if (hits.Count > 1 && hits.FirstOrDefault(h => hits.All(o => o == h || o.Split('-').Contains(h, StringComparer.Ordinal))) is { } stem)
        { suggested = stem; by = $"the search words of {stem} (and its variants {string.Join(", ", hits.Where(h => h != stem).Take(3))}) have '{dashed}'"; }
        var closest = (suggested != null ? new[] { suggested } : Array.Empty<string>()).Concat(hits).Concat(searched).Concat(NameSuggestions.Closest(dashed, catalog.Valid, 6))
            .Distinct(StringComparer.Ordinal).Take(4).ToList();
        return new(name, false, null, null, closest, suggested, by);
    }

    /// <summary>Parses the icons.json of a FontAwesome catalog (ids, aliases, filter words).</summary>
    public static Catalog FromJson(string library, string json)
    {
        var valid = new HashSet<string>(StringComparer.Ordinal);
        var words = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        foreach (var icon in (JsonNode.Parse(json) as JsonArray ?? new JsonArray()).OfType<JsonObject>())
        {
            if (icon["id"]?.ToString() is not { Length: > 0 } id) continue;
            valid.Add(id);
            var aliases = (icon["aliases"] as JsonArray ?? new JsonArray()).Select(a => a?.ToString()).OfType<string>().ToList();
            foreach (var alias in aliases) valid.Add(alias);
            words[id] = aliases.Concat((icon["filter"] as JsonArray ?? new JsonArray()).Select(a => a?.ToString()).OfType<string>())
                .Append(icon["name"]?.ToString() ?? id).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        }
        return new Catalog(library, valid, words);
    }

    private const string Resource = "IconResources.icons.json";

    private static Catalog? LoadO11()
    {
        try
        {
            var roots = new List<string>();
            try { roots.Add(StudioAdapter.Runtime.StudioDirectory); } catch { }
            if (Environment.GetEnvironmentVariable("ANVIL_STUDIO_DIR") is { Length: > 0 } bound) roots.Add(bound);
            foreach (var root in roots.Where(Directory.Exists).Distinct(StringComparer.OrdinalIgnoreCase))
            {
                var plugins = Path.Combine(root, "Plugins");
                if (!Directory.Exists(plugins)) continue;
                foreach (var file in Directory.EnumerateFiles(plugins, "ServiceStudio.Plugin.NRWidgets.dll", SearchOption.AllDirectories))
                    if (ReadResource(file, Resource) is { } json) return FromJson("FontAwesome 4.7 (Service Studio)", json);
            }
        }
        catch { /* no catalog: nothing is judged */ }
        return null;
    }

    /// <summary>The text of an embedded resource whose name ends with <paramref name="suffix"/>, read from the file's metadata
    /// (the assembly is never loaded), or null.</summary>
    internal static string? ReadResource(string assemblyPath, string suffix)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        if (!pe.HasMetadata || pe.PEHeaders.CorHeader is not { } cor) return null;
        var reader = pe.GetMetadataReader();
        foreach (var handle in reader.ManifestResources)
        {
            var resource = reader.GetManifestResource(handle);
            if (!resource.Implementation.IsNil) continue;
            if (!reader.GetString(resource.Name).EndsWith(suffix, StringComparison.Ordinal)) continue;
            var section = pe.GetSectionData(cor.ResourcesDirectory.RelativeVirtualAddress);
            var blob = section.GetReader((int)resource.Offset, section.Length - (int)resource.Offset);
            var length = blob.ReadInt32();
            var bytes = blob.ReadBytes(length);
            return System.Text.Encoding.UTF8.GetString(bytes).TrimStart('﻿');
        }
        return null;
    }
}
