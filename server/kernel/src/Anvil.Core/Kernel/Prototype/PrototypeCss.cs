using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// The theme stylesheet of a prototype import (docs/PROTOTIPO-NATIVO.md, 4.1), the <see cref="PrototypeSeams.Css"/> seam.
/// Composed in this order:
/// <list type="number">
/// <item>the hoisted @import statements, in document order (a statement the <see cref="ImportFallback"/> hook resolves is written
/// as the inline @font-face rules it returns);</item>
/// <item><c>/* ssam:prototype ua */</c>: the user-agent rules of the substituted tags, all :where();</item>
/// <item>every prototype sheet of the bundle, verbatim in document order, each after a <c>/* &lt;path&gt; */</c> comment, with only
/// the closed list of rewrites (<see cref="PrototypeRewrites"/>); the sha256 of each bundle file is the IR's, the rule count of
/// the written text equals the original's, the bytes outside the recorded rewrites are the original's, and nothing is ever
/// truncated: any difference is <c>PROTOTYPE_IR_INVALID</c> (an SSAM defect, never the model's);</item>
/// <item><c>/* ssam:prototype icons */</c>: one mask class per icon name and stroke (<see cref="PrototypeIcons"/>);</item>
/// <item><c>/* ssam:prototype adapters */</c>: the runtime adapters (<see cref="PrototypeAdapters"/>).</item>
/// </list>
/// A sheet the IR marks <c>page:&lt;key&gt;</c> (multi-page) is not in the theme: its rewritten text is in
/// <c>Report.pages[&lt;key&gt;]</c> for that screen's StyleSheet. No scoping anywhere.
/// </summary>
public static class PrototypeCss
{
    public const string Refusal = "PROTOTYPE_IR_INVALID";
    public const string UaMarker = "/* ssam:prototype ua */", IconsMarker = "/* ssam:prototype icons */", AdaptersMarker = "/* ssam:prototype adapters */";

    /// <summary>The @font-face fallback of 4.1 item 2: given an @import statement, the inline CSS to write instead (the facade
    /// resolves fonts.googleapis.com through the vendor cache), or null to keep the @import. Null by default.</summary>
    public static Func<string, string?>? ImportFallback { get; set; }

    // The registration the contract asks for (docs/PROTOTIPO-NATIVO.md 7.3): the seams are set when the kernel assembly loads,
    // before any job runs; CA2255 warns against module initializers in libraries in general.
#pragma warning disable CA2255
    [ModuleInitializer]
    internal static void Register()
    {
        PrototypeSeams.Css ??= Compose;
        PrototypeSeams.Render ??= PrototypeRender.Render;
    }
#pragma warning restore CA2255

    /// <summary>The rewrite kinds that change a selector (the others change a URL, an @import or the byte order mark).</summary>
    private static readonly HashSet<string> SelectorKinds = new(StringComparer.Ordinal)
        { PrototypeRewrites.Id, PrototypeRewrites.Tag, PrototypeRewrites.IconSvg, PrototypeRewrites.IconSpan, PrototypeRewrites.Wrapper, PrototypeRewrites.Submit };

    public static PrototypeCssResult Compose(PrototypeCssRequest request)
    {
        var capture = request.Capture;
        var platform = RuntimeDomTable.IsOdc(request.Platform) ? "odc" : "o11";
        var problems = new JsonArray();
        void Problem(string message, string? path = null) => problems.Add(new JsonObject { ["code"] = Refusal, ["ssamDefect"] = true, ["message"] = message, ["path"] = path });

        var substituted = new HashSet<string>(request.SubstitutedTags.Select(t => t.ToLowerInvariant()), StringComparer.Ordinal);
        foreach (var tag in SubstitutedByElementSeam(capture, platform)) substituted.Add(tag);
        var compiled = request.Roots.ToDictionary(r => r.Key, r => PrototypeRender.FromWidgets(Spliced(r.Key, r.Value, request.Roots, platform), platform));
        var chainsCache = new Dictionary<string, IReadOnlyList<IReadOnlyList<string>>>(StringComparer.Ordinal);
        IReadOnlyList<IReadOnlyList<string>> Chains(CompoundSelector compound, string text)
        {
            if (chainsCache.TryGetValue(text, out var cached)) return cached;
            var found = new List<IReadOnlyList<string>>(); var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var tree in compiled.Values)
                foreach (var element in tree.Descendants(includeSelf: true))
                {
                    if (!element.IsElement || element.Runtime != null || !CssSelectors.MatchesCompound(element, compound)) continue;
                    var chain = new List<string>();
                    for (var p = element.Parent; p != null && p.Runtime != null; p = p.Parent) if (p.IsElement) chain.Insert(0, p.RuntimeSelector ?? p.Tag!);
                    if (chain.Count > 0 && keys.Add(string.Join(" > ", chain))) found.Add(chain);
                }
            return chainsCache[text] = found;
        }

        var (assetUrls, assetReport) = AssetUrls(request, platform);
        var sheets = (capture["css"]?["sheets"] as JsonArray ?? []).OfType<JsonObject>()
            .Select((s, i) => (Sheet: s, Order: s["order"] is JsonValue v && v.TryGetValue<int>(out var o) ? o : i)).OrderBy(x => x.Order).Select(x => x.Sheet).ToList();
        var themeParts = new List<(string Path, SheetRewrite Rewrite)>();
        var imports = new List<CssCompat.Import>();
        var backdrops = new List<(IReadOnlyList<string>, string)>();
        var allRewrites = new List<CssRewrite>();
        var sheetReports = new JsonArray(); var pages = new JsonObject();
        var unparsed = new JsonArray(); var unmapped = new JsonArray();
        var totalRules = 0; var verbatim = true;
        foreach (var sheet in sheets)
        {
            var path = sheet["path"]?.ToString() ?? sheet["bundle"]?.ToString() ?? "(inline)";
            var bundle = sheet["bundle"]?.ToString();
            if (string.IsNullOrEmpty(bundle)) { Problem($"sheet {path} has no bundle file in the capture", "/css/sheets"); continue; }
            var file = System.IO.Path.GetFullPath(System.IO.Path.Combine(request.BundleRoot, bundle));
            if (!File.Exists(file)) { Problem($"sheet {path}: bundle file {bundle} is missing", "/css/sheets"); continue; }
            var bytes = File.ReadAllBytes(file);
            var sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            if (sheet["sha256"]?.ToString() is { Length: > 0 } expected && !string.Equals(expected, sha, StringComparison.OrdinalIgnoreCase))
            { Problem($"sheet {path}: sha256 of {bundle} is {sha}, the capture says {expected}", "/css/sheets"); continue; }
            var text = Encoding.UTF8.GetString(bytes);
            var urlAssets = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var url in sheet["urls"] as JsonArray ?? [])
                if (url?["raw"]?.ToString() is { } raw && url["asset"]?.ToString() is { } asset) urlAssets[raw] = asset;
            var options = new RewriteOptions
            {
                Platform = platform, AssetUrls = assetUrls, UrlAssets = urlAssets, IdClasses = request.IdClasses,
                SubstitutedTags = substituted, RuntimeSpans = RuntimeDomTable.RuntimeSpans(platform), Wrappers = compiled.Count > 0 ? Chains : null,
            };
            var rewrite = PrototypeRewrites.Rewrite(text, options);
            var before = CssStylesheet.CountRules(text);
            var after = CssStylesheet.CountRules(rewrite.Text) + rewrite.Imports.Count;
            var exact = PrototypeRewrites.Verbatim(text, rewrite.Text, rewrite.Rewrites);
            if (before != after) Problem($"sheet {path}: the written text has {after} rules, the original {before} (no rule may be lost)", "/css/sheets");
            if (!exact) Problem($"sheet {path}: the written text differs from the original outside the recorded rewrites", "/css/sheets");
            verbatim &= exact && before == after;
            totalRules += before;
            allRewrites.AddRange(rewrite.Rewrites);
            foreach (var u in rewrite.Unparsed) unparsed.Add(new JsonObject { ["sheet"] = path, ["selector"] = u });
            foreach (var u in rewrite.UnmappedUrls) unmapped.Add(new JsonObject { ["sheet"] = path, ["url"] = u });
            sheetReports.Add(new JsonObject
            {
                ["path"] = path, ["bundle"] = bundle, ["sha256"] = sha, ["bytes"] = bytes.Length, ["rules"] = before, ["rulesWritten"] = after,
                ["captureRules"] = sheet["rules"]?.DeepClone(), ["verbatim"] = exact && before == after,
                ["rewrites"] = CountsJson(rewrite.Rewrites), ["origin"] = sheet["origin"]?.DeepClone(),
            });
            if (sheet["page"]?.ToString() is { Length: > 0 } page)
            {
                pages[page] = (rewrite.Imports.Count > 0 ? string.Join("\n", rewrite.Imports.Select(i => Inline(i.Statement))) + "\n" : "") + rewrite.Text;
                continue;
            }
            imports.AddRange(rewrite.Imports);
            backdrops.AddRange(rewrite.Backdrops);
            themeParts.Add((path, rewrite));
        }

        var (ua, uaTags) = PrototypeAdapters.UserAgent(substituted);
        var (icons, iconClasses, missingIcons) = PrototypeIcons.Masks(capture);
        var (adapters, adapterReport) = PrototypeAdapters.Adapters(platform, request.Roots, backdrops);
        var css = new StringBuilder();
        // The @import statements that stay come first (a browser ignores an @import after any rule), then the @font-face
        // rules the fallback hook wrote for the others.
        var written = imports.Select(i => (Statement: i.Statement, Inline: Inline(i.Statement))).ToList();
        foreach (var (statement, inline) in written) if (inline == statement) css.Append(statement).Append('\n');
        foreach (var (statement, inline) in written) if (inline != statement) css.Append(inline).Append('\n');
        css.Append(UaMarker).Append('\n').Append(ua);
        foreach (var (path, rewrite) in themeParts)
        {
            css.Append("/* ").Append(path.Replace("*/", "* /", StringComparison.Ordinal)).Append(" */\n").Append(rewrite.Text);
            if (!rewrite.Text.EndsWith('\n')) css.Append('\n');
        }
        css.Append(IconsMarker).Append('\n').Append(icons);
        css.Append(AdaptersMarker).Append('\n').Append(adapters);
        var styleSheet = css.ToString();
        var (importsFirst, first) = ThemeCss.ImportsFirst(styleSheet);
        if (imports.Count > 0 && !importsFirst) Problem($"the composed stylesheet does not start with its @import statements (first statement: {first})");
        if (problems.Count > 0)
            throw new KernelRefusalException(Refusal, "prototype css: " + string.Join("; ", problems.Select(p => p!["message"]!.ToString())), problems);

        var report = new JsonObject
        {
            ["verbatim"] = verbatim,
            ["rules"] = totalRules,
            ["rewrites"] = CountsJson(allRewrites),
            ["sheets"] = sheetReports,
            ["imports"] = new JsonArray(imports.Select(i => (JsonNode)i.Statement).ToArray()),
            ["importsFirst"] = importsFirst,
            ["substitutedTags"] = new JsonArray(substituted.Order(StringComparer.Ordinal).Select(t => (JsonNode)t).ToArray()),
            ["ua"] = new JsonArray(uaTags.Select(t => (JsonNode)t).ToArray()),
            ["icons"] = new JsonObject { ["classes"] = iconClasses.Count, ["names"] = PrototypeIcons.Uses(capture).Select(u => u.Name).Distinct().Count(), ["missing"] = new JsonArray(missingIcons.Select(m => (JsonNode)m).ToArray()) },
            ["adapters"] = adapterReport,
            ["unparsedSelectors"] = unparsed,
            ["unmappedUrls"] = unmapped,
            ["assetUrls"] = assetReport,
            ["pages"] = pages,
            ["chars"] = styleSheet.Length,
            // every selector a rewrite changed, as written and as rewritten: the fidelity measure matches the rewritten one on
            // the native tree (4.4 step 3 b); the op moves it to prototype-dom.json, out of the receipt
            ["selectors"] = new JsonArray(allRewrites.Where(r => r.Kinds.Any(SelectorKinds.Contains)).Select(r => (r.From, r.Replacement)).Distinct()
                .Select(r => (JsonNode)new JsonObject { ["original"] = r.From, ["rewritten"] = r.Replacement }).ToArray()),
        };
        return new PrototypeCssResult(styleSheet, iconClasses, report);
    }

    /// <summary>The module image URL of each asset (3.6): the compile lane's when it gives one; on O11 otherwise the published
    /// form <c>/&lt;Module&gt;/img/&lt;Module&gt;.&lt;Image&gt;.&lt;ext&gt;</c> with the image named <c>&lt;Prefix&gt;&lt;Name&gt;</c> (3.5:
    /// products.png → FarmaVirtualProducts). ODC derives none until stage 0 confirms its form: the url stays as written and is
    /// listed with the cause, for the compile lane to refuse.</summary>
    internal static (IReadOnlyDictionary<string, string> Urls, JsonArray Report) AssetUrls(PrototypeCssRequest request, string platform)
    {
        var urls = new Dictionary<string, string>(request.AssetUrls, StringComparer.Ordinal);
        var report = new JsonArray();
        var prefix = request.Capture["app"]?["prefix"]?.ToString() ?? "";
        foreach (var asset in (request.Capture["assets"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (asset["path"]?.ToString() is not { Length: > 0 } path) continue;
            if (urls.TryGetValue(path, out var given)) { report.Add(new JsonObject { ["asset"] = path, ["url"] = given, ["source"] = "request" }); continue; }
            if (RuntimeDomTable.IsOdc(platform))
            {
                report.Add(new JsonObject { ["asset"] = path, ["url"] = null, ["source"] = "unconfirmed", ["why"] = "the ODC image URL form is confirmed at stage 0 (3.6); without it the url stays as written" });
                continue;
            }
            var file = System.IO.Path.GetFileName(path);
            var ext = System.IO.Path.GetExtension(file).TrimStart('.');
            var name = asset["name"]?.ToString() is { Length: > 0 } n ? n : Pascal(System.IO.Path.GetFileNameWithoutExtension(file));
            var image = name.StartsWith(prefix, StringComparison.Ordinal) ? name : prefix + name;
            var url = "/" + request.ModuleName + "/img/" + request.ModuleName + "." + image + (ext.Length > 0 ? "." + ext : "");
            urls[path] = url;
            report.Add(new JsonObject { ["asset"] = path, ["url"] = url, ["source"] = "derived" });
        }
        return (urls, report);
    }

    private static string Pascal(string text) => string.Concat(text.Split(['-', '_', ' ', '.'], StringSplitOptions.RemoveEmptyEntries)
        .Select(p => char.ToUpperInvariant(p[0]) + p[1..]));

    /// <summary>A view as the runtime nests it: its shell block instance holds the shell's tree, and the view's content sits in
    /// the shell's placeholder, so a wrapper chain is the real one (the placeholder between main and the view's first
    /// elements, the block instance around the shell's root).</summary>
    internal static WidgetNode Spliced(string key, WidgetNode root, IReadOnlyDictionary<string, WidgetNode> roots, string platform)
    {
        if (!key.StartsWith("v:", StringComparison.Ordinal) || !roots.TryGetValue("shell", out var shell)) return root;
        if (RuntimeDomTable.Row(platform, root.W)?.Widget != "IMobileBlockInstanceWidget") return root;
        WidgetNode Fill(WidgetNode node) => RuntimeDomTable.Row(platform, node.W)?.Widget == "IPlaceholderWidget"
            ? node with { Children = root.Children }
            : node with { Children = node.Children.Select(Fill).ToList(), Else = node.Else?.Select(Fill).ToList() };
        var body = RuntimeDomTable.Row(platform, shell.W)?.Widget == "IMobileBlockInstanceWidget" ? shell.Children : [shell];
        return root with { Children = body.Select(Fill).ToList() };
    }

    private static string Inline(string statement) => ImportFallback?.Invoke(statement) is { Length: > 0 } inline ? inline.TrimEnd() : statement;

    private static JsonArray CountsJson(IEnumerable<CssRewrite> rewrites) =>
        new(PrototypeRewrites.Counts(rewrites).Select(c => (JsonNode)new JsonObject { ["kind"] = c.Kind, ["count"] = c.Count }).ToArray());

    /// <summary>Tags of the capture the html lane's element map substitutes on this platform (<see cref="PrototypeSeams.Element"/>),
    /// so a tag is rewritten exactly when the compiled widget carries <c>ssam-tag-*</c>.</summary>
    private static IEnumerable<string> SubstitutedByElementSeam(JsonObject capture, string platform)
    {
        if (PrototypeSeams.Element is not { } element) yield break;
        var tags = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in CaptureNodes(capture)) if (node["t"]?.ToString() is { Length: > 0 } t) tags.Add(t.ToLowerInvariant());
        foreach (var tag in tags.Order(StringComparer.Ordinal))
        {
            ElementMapping? mapping = null;
            try { mapping = element(new ElementRequest(platform, tag, [], false, tag == "svg", false, false)); } catch (Exception) { }
            if (mapping?.SubstitutedFrom is { Length: > 0 } from) yield return from.ToLowerInvariant();
        }
    }

    /// <summary>Every node object of the capture (shell, views, modals, explored trees), through children, else branches and
    /// list templates, each once; a root given as the sha of a tree is followed into <c>trees</c>.</summary>
    public static IEnumerable<JsonObject> CaptureNodes(JsonObject capture)
    {
        var trees = capture["trees"] as JsonObject;
        var seen = new HashSet<JsonObject>(ReferenceEqualityComparer.Instance);
        var stack = new Stack<JsonNode?>();
        void Root(JsonNode? root)
        {
            if (root is JsonValue v && v.TryGetValue<string>(out var sha) && trees?[sha] is JsonObject tree) stack.Push(tree);
            else stack.Push(root);
        }
        Root(capture["shell"]?["root"]);
        foreach (var view in capture["views"] as JsonArray ?? []) Root(view?["root"]);
        foreach (var modal in capture["modals"] as JsonArray ?? []) Root(modal?["root"]);
        if (trees != null) foreach (var (_, tree) in trees) Root(tree);
        var ordered = new List<JsonObject>();
        while (stack.Count > 0)
        {
            if (stack.Pop() is not JsonObject node || !seen.Add(node)) continue;
            ordered.Add(node);
            var next = new List<JsonNode?>();
            foreach (var child in node["c"] as JsonArray ?? []) next.Add(child);
            if (node["if"] is JsonObject cond && cond["else"] is JsonNode otherwise) next.Add(otherwise);
            if (node["else"] is JsonNode alt) next.Add(alt);
            if (node["list"] is JsonObject list && list["template"] is JsonNode template) next.Add(template);
            for (var k = next.Count - 1; k >= 0; k--) stack.Push(next[k]);
        }
        return ordered;
    }
}
