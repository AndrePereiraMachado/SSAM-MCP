using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// R3-A piece C, the kernel verb <c>render-document</c> (contract <see cref="Schema"/>, C:\t\r2\agent-preview\DESENHO-PREVIEW-UPLOAD.md
/// 2.4): the screens of a capture as design documents an offline renderer lays out (the agent's <c>screen.render</c>, served by the
/// hosted <c>ssam_render</c>): the runtime's DOM of each screen (ScreenVisual.Predict, the reading of PrototypeRender.ReadRoot through
/// the runtime DOM table: wrappers, data-* attributes, the classes the runtime publishes) with <c>data-ssam-key</c> on every element
/// of a widget, the List sentinels as <c>&lt;template data-ssam-sentinel&gt;</c>, deterministic stand-ins for the data (each List
/// repeats its row three times, an If shows its true branch), and the sheets in the runtime's order (the platform's real sheets of
/// the private store, RuntimeCss; the module's themes; the blocks; the screen) shared by id. No script and no external URL: every
/// url() and link that is not data: becomes "#", every @import is dropped, an element the renderer refuses becomes a template. The
/// probes are the visual check's platform warnings (ScreenVisual families a to e), one per key, breakpoint and property, with the
/// value the author meant (<c>expect</c>): the renderer measures, the server gives the verdict. Without the platform's sheets the
/// document says <c>sheets:"missing"</c>, never a cascade silently approximated.
/// </summary>
public static class RenderDocument
{
    public const string Schema = "ssam-render-document/1";
    /// <summary>F6: every key of the set (documents[].key, data-ssam-key, probes[].key) is in one form, <see cref="SafeKey"/>
    /// ("safe"): a caller turns a model key it has (the @key of ssam_map) into it with the same rule before it compares.</summary>
    public const string KeyForm = "safe";
    public const int MaxDocuments = 8;
    public const int MaxHtmlBytes = 4 * 1024 * 1024;
    public const int MaxStyleBytes = 2 * 1024 * 1024;
    public const int MaxStyles = 16;
    public const int MaxTotalBytes = 12 * 1024 * 1024;

    /// <summary>What the renderer refuses in a document's html (case-insensitive), the same list as the agent's.</summary>
    public static readonly IReadOnlyList<string> RefusedHtml = ["<script", "<iframe", "<frame", "<object", "<embed", "<link", "<base", "<meta http-equiv", "srcdoc=", "javascript:", "vbscript:"];

    private static readonly HashSet<string> RefusedTags = new(StringComparer.OrdinalIgnoreCase) { "script", "iframe", "frame", "frameset", "object", "embed", "link", "base", "meta", "applet", "portal" };
    private static readonly HashSet<string> UrlAttributes = new(StringComparer.OrdinalIgnoreCase) { "href", "src", "srcset", "action", "formaction", "poster", "background", "xlink:href", "data", "cite", "longdesc", "manifest", "ping" };
    private static readonly HashSet<string> VoidTags = new(StringComparer.OrdinalIgnoreCase) { "area", "br", "col", "embed", "hr", "img", "input", "source", "track", "wbr" };

    /// <summary>One style of the document set: an id the documents name, where it comes from and its text (neutralized).</summary>
    public sealed record Style(string Id, string Origin, string Css);

    /// <summary>One screen or block to render: its document id (s1..s8), its name and key, the prediction (in render mode), its
    /// own sheets in the runtime's order (the blocks it places, then itself) and what could not be expanded.</summary>
    public sealed record Root(string Id, string Screen, string? Key, ScreenVisual.Prediction Prediction, IReadOnlyList<Style> Sheets, IReadOnlyList<string> Unexpanded);

    /// <summary>The key a renderer reads (<c>^[A-Za-z0-9_-]{1,80}$</c>): a model key with + and / as - and _ and no padding.</summary>
    public static string SafeKey(string key)
    {
        var text = key.TrimStart('@').Replace('+', '-').Replace('/', '_').TrimEnd('=');
        text = Regex.Replace(text, @"[^A-Za-z0-9_-]", "");
        return text.Length > 80 ? text[..80] : text;
    }

    /// <summary>The body classes OutSystems UI's script puts per breakpoint (the renderer runs no page script).</summary>
    public static JsonObject BodyClasses(IEnumerable<string> viewports) =>
        new(viewports.Select(v => KeyValuePair.Create(v, (JsonNode?)new JsonArray(ScreenVisual.ViewportNamed(v).BodyClasses.Select(c => (JsonNode)c).ToArray()))));

    /// <summary>The document set of <see cref="Schema"/> from screens already predicted (the verb reads them from a capture,
    /// <see cref="FromOml"/>; the tests build them).</summary>
    public static JsonObject Compose(string lane, string module, string? sourceSha256, IReadOnlyList<Root> roots, IReadOnlyList<Style> themes, PlatformSheets platform, IReadOnlyList<string> viewports)
    {
        if (roots.Count is 0 or > MaxDocuments) throw new ArgumentException($"render-document: 1 to {MaxDocuments} screens");
        foreach (var v in viewports) ScreenVisual.ViewportNamed(v);
        lane = RuntimeDomTable.IsOdc(lane) ? "odc" : "o11";
        var styles = new List<Style>();
        void AddStyle(Style s) { if (!styles.Any(x => x.Id == s.Id)) styles.Add(s with { Css = NeutralizeCss(s.Css) }); }
        foreach (var sheet in platform.Sheets) AddStyle(new Style(sheet.Id, sheet.Origin, sheet.Css));
        foreach (var theme in themes) AddStyle(theme);
        var documents = new JsonArray();
        var probes = new JsonArray();
        var platformSheets = ScreenVisual.PlatformSheetsOf(platform);
        foreach (var root in roots)
        {
            if (!Regex.IsMatch(root.Id, "^[a-z0-9-]{1,40}$")) throw new ArgumentException($"render-document: the document id '{root.Id}' is not ^[a-z0-9-]{{1,40}}$");
            foreach (var sheet in root.Sheets) AddStyle(sheet);
            var html = Html(root);
            documents.Add(new JsonObject
            {
                ["id"] = root.Id, ["screen"] = root.Screen, ["key"] = root.Key == null ? null : SafeKey(root.Key),
                ["html"] = html, ["sha256"] = RuntimeCss.Sha(html),
                ["styles"] = new JsonArray(platform.Sheets.Select(s => s.Id).Concat(themes.Select(t => t.Id)).Concat(root.Sheets.Select(s => s.Id)).Distinct(StringComparer.Ordinal).Select(id => (JsonNode)id).ToArray()),
                ["bodyClasses"] = BodyClasses(viewports),
                ["sampleData"] = "synthetic",
                ["unexpanded"] = new JsonArray(root.Unexpanded.Select(u => (JsonNode)u).ToArray()),
            });
            foreach (var probe in Probes(root, lane, platformSheets, themes, viewports)) probes.Add(probe);
        }
        var described = platform.Describe();
        var document = new JsonObject
        {
            ["schema"] = Schema, ["keyForm"] = KeyForm, ["lane"] = lane, ["module"] = module, ["sourceSha256"] = sourceSha256,
            ["platform"] = new JsonObject { ["osui"] = platform.Osui, ["runtime"] = platform.Runtime ?? platform.Version, ["sheets"] = platform.Status == "present" ? "present" : platform.Status == "partial" ? "partial" : "missing" },
            ["styles"] = new JsonArray(styles.Select(s => (JsonNode)new JsonObject { ["id"] = s.Id, ["origin"] = s.Origin, ["sha256"] = RuntimeCss.Sha(s.Css), ["css"] = s.Css }).ToArray()),
            ["documents"] = documents,
            ["probes"] = probes,
        };
        if (described["missing"] is JsonArray missing) document["platform"]!["missing"] = missing.DeepClone();
        if (described["why"] is { } why) document["platform"]!["why"] = why.DeepClone();
        if (platform.Status != "present")
            document["warnings"] = new JsonArray(new JsonObject
            {
                ["code"] = "RENDER_PLATFORM_SHEETS_MISSING",
                ["message"] = $"the platform's stylesheets of {lane} {platform.Version ?? "(unknown version)"} are {platform.Status} in the private store: the render does not hold for the platform's cascade",
            });
        var problems = Validate(document);
        if (problems.Count > 0) throw new InvalidOperationException("render-document: " + string.Join("; ", problems));
        return document;
    }

    /// <summary>The probes of one root: its prediction checked as the module's (the author's view is the runtime's DOM without
    /// the List sentinels), each platform warning with a key and a property, per breakpoint it is seen at.</summary>
    private static IEnumerable<JsonObject> Probes(Root root, string lane, IReadOnlyList<ScreenVisual.Sheet> platformSheets, IReadOnlyList<Style> themes, IReadOnlyList<string> viewports)
    {
        var map = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
        var author = ScreenVisual.Clone(root.Prediction.Root, map, ScreenVisual.IsSentinel);
        var counterparts = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
        // the module never writes the classes the runtime adds from a property (OSFillParent: Width (fill parent)): its view is
        // the element without them
        var injected = RuntimeDomTable.Rows(lane).SelectMany(r => r.Classes).Select(c => c.Class).ToHashSet(StringComparer.Ordinal);
        foreach (var (original, clone) in map)
        {
            if (!clone.IsElement || original.ObjectKey == null) continue;
            counterparts[clone] = original;
            if (clone.Classes.Any(injected.Contains)) clone.SetAttr("class", string.Join(" ", clone.Classes.Where(c => !injected.Contains(c))));
        }
        var sheets = platformSheets.Concat(themes.Select(t => new ScreenVisual.Sheet(t.Css, "theme"))).Concat(root.Sheets.Select(s => new ScreenVisual.Sheet(s.Css, "page"))).ToList();
        var input = new ScreenVisual.CheckInput(root.Screen, author, new Dictionary<DomNode, ScreenHtml.Node>(ReferenceEqualityComparer.Instance), root.Prediction, counterparts, sheets, lane, "");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var f in ScreenVisual.Check(input).Where(f => ScreenVisual.PlatformCodes.Contains(f.Code) && f.Key != null && f.Property != null))
            foreach (var viewport in (f.Viewports.Count > 0 ? f.Viewports : viewports.ToList()).Where(viewports.Contains))
            {
                var key = SafeKey(f.Key!);
                if (key.Length == 0 || !seen.Add(key + "|" + viewport + "|" + f.Property + "|" + f.Code)) continue;
                // F5: expect and expectNot in the form getComputedStyle answers; a probe with neither (no computed form) is not sent
                var expect = ScreenVisual.ComputedForm(f.Property!, f.Expect);
                var expectNot = ScreenVisual.ComputedForm(f.Property!, f.ExpectNot);
                if (f.Property != "coveredBy" && expect == null && expectNot == null) continue;
                var probe = new JsonObject
                {
                    ["key"] = key, ["viewport"] = viewport, ["property"] = f.Property, ["warning"] = f.Code,
                    ["document"] = root.Id, ["winner"] = f.Winner, ["patch"] = ForViewport(f.Append ?? f.Right ?? f.Candidates.FirstOrDefault(), f, viewport),
                };
                // an expect the probe has not is left out, never null (a reader that compares String(expect) would confirm "null")
                if (expect != null) probe["expect"] = expect;
                if (expectNot != null) probe["expectNot"] = expectNot;
                yield return probe;
            }
    }

    // A patch of a breakpoint (a fixed layout element's) is scoped by that breakpoint's device class.
    private static string? ForViewport(string? patch, ScreenVisual.Finding f, string viewport)
    {
        if (patch == null || f.Code != ScreenVisual.PlatformFixedLayout) return patch;
        foreach (var v in ScreenVisual.Viewports)
            if (patch.StartsWith("." + v.BodyClasses[0] + " ", StringComparison.Ordinal))
                return "." + ScreenVisual.ViewportNamed(viewport).BodyClasses[0] + patch[(v.BodyClasses[0].Length + 1)..];
        return patch;
    }

    // ---- the html ---------------------------------------------------------------------------------------------------------

    private static string Html(Root root)
    {
        var sb = new StringBuilder("<!doctype html><html><head><meta charset=\"utf-8\"></head><body>");
        sb.Append("<div id=\"").Append(CssStylesheet.ReactContainer).Append("\"><div class=\"screen-container\"><div class=\"active-screen\" data-ssam-screen=\"").Append(Attr(root.Screen)).Append("\">");
        foreach (var child in root.Prediction.Root.Children) Write(child, sb);
        sb.Append("</div></div></div></body></html>");
        var html = sb.ToString();
        if (Encoding.UTF8.GetByteCount(html) > MaxHtmlBytes) throw new InvalidOperationException($"render-document: the document of {root.Screen} is over {MaxHtmlBytes} bytes");
        return html;
    }

    private static void Write(DomNode node, StringBuilder sb)
    {
        if (!node.IsElement)
        {
            if (node.Text != null) sb.Append(Text(node.Text));
            foreach (var child in node.Children) Write(child, sb);
            return;
        }
        var tag = node.Tag!;
        var attributes = node.Attributes.ToList();
        if (ScreenVisual.IsSentinel(node))
        {
            // the List's sentinel: an element sibling of the rows as the runtime's <script>, inert
            sb.Append("<template data-ssam-sentinel=\"\"");
            foreach (var (name, value) in attributes.Where(a => a.Name == "style")) sb.Append(' ').Append(name).Append("=\"").Append(Attr(NeutralizeCss(value, declarations: true))).Append('"');
            sb.Append("></template>");
            return;
        }
        var refused = RefusedTags.Contains(tag) || !Regex.IsMatch(tag, "^[a-z][a-z0-9-]*$");
        if (refused) { sb.Append("<template data-ssam-neutralized=\"").Append(Attr(tag)).Append("\"></template>"); return; }
        sb.Append('<').Append(tag);
        foreach (var (name, value) in attributes)
        {
            var lower = name.ToLowerInvariant();
            if (!Regex.IsMatch(lower, @"^[a-z_:][a-z0-9_:.-]*$") || lower.StartsWith("on", StringComparison.Ordinal) || lower is "srcdoc" or "data-ssam-key") continue;
            var v = value;
            if (UrlAttributes.Contains(lower) && !v.StartsWith('#') && !v.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase)) v = "#";
            if (lower == "style") v = NeutralizeCss(v, declarations: true);
            sb.Append(' ').Append(lower).Append("=\"").Append(Attr(v)).Append('"');
        }
        if (node.ObjectKey != null && SafeKey(node.ObjectKey) is { Length: > 0 } key) sb.Append(" data-ssam-key=\"").Append(key).Append('"');
        sb.Append('>');
        if (VoidTags.Contains(tag)) return;
        foreach (var child in node.Children) Write(child, sb);
        sb.Append("</").Append(tag).Append('>');
    }

    // Text and attribute values: escaped, and every word the renderer refuses broken by an entity (the text of a screen with a
    // url, "javascript:" or "on…=" reads the same and never trips the renderer's checks).
    private static string Text(string text) => Defuse(text.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;"));

    private static string Attr(string text) => Defuse(text.Replace("&", "&amp;").Replace("\"", "&quot;").Replace("<", "&lt;").Replace(">", "&gt;"));

    private static string Defuse(string text) => Regex.Replace(text.Replace("=", "&#61;"), @"(?i)(javascript|vbscript):", "$1&#58;");

    // ---- the css ------------------------------------------------------------------------------------------------------------

    /// <summary>A stylesheet with no reach outside the document: @import dropped, every url() that is not data: made "#".</summary>
    public static string NeutralizeCss(string css, bool declarations = false)
    {
        // F2: on the token stream (CssReach), escapes decoded: u\72l(), image-set("…"), src("…") and @import are read as CSS reads them
        var text = CssReach.Neutralize(css, declarations);
        return Regex.Replace(text, @"(?i)(javascript|vbscript):", "$1-");
    }

    /// <summary>The renderer's checks of a document set (the same rules as the agent's ssam-render-request/1): the refused words
    /// of the html, event attributes, external URLs in a URL attribute or in a sheet, the sizes and counts. Empty when it holds.</summary>
    public static List<string> Validate(JsonObject document)
    {
        var problems = new List<string>();
        var total = 0;
        var styles = document["styles"] as JsonArray ?? [];
        if (styles.Count > MaxStyles) problems.Add($"{styles.Count} styles (at most {MaxStyles})");
        foreach (var style in styles.OfType<JsonObject>())
        {
            var css = style["css"]?.ToString() ?? "";
            var bytes = Encoding.UTF8.GetByteCount(css);
            total += bytes;
            if (bytes > MaxStyleBytes) problems.Add($"style {style["id"]}: {bytes} bytes (at most {MaxStyleBytes})");
            if (CssReach.External(css).Count > 0) problems.Add($"style {style["id"]}: an external URL");
        }
        var documents = document["documents"] as JsonArray ?? [];
        if (documents.Count is 0 or > MaxDocuments) problems.Add($"{documents.Count} documents (1 to {MaxDocuments})");
        foreach (var d in documents.OfType<JsonObject>())
        {
            var html = d["html"]?.ToString() ?? "";
            total += Encoding.UTF8.GetByteCount(html);
            foreach (var word in RefusedHtml)
                if (html.Contains(word, StringComparison.OrdinalIgnoreCase)) problems.Add($"document {d["id"]}: '{word}'");
            if (Regex.IsMatch(html, @"(?i)<[^>]*\son[a-z]+\s*=")) problems.Add($"document {d["id"]}: an event attribute");
            if (Regex.IsMatch(html, @"(?i)\s(?:href|src|srcset|action|formaction|poster|background|xlink:href|data|cite)\s*=\s*['""]?\s*(https?:|file:|ftp:|//|\\\\)")) problems.Add($"document {d["id"]}: an external URL");
            if (Regex.IsMatch(html, @"(?i)url\(\s*['""]?\s*(https?:|file:|ftp:|//|\\\\)")) problems.Add($"document {d["id"]}: an external URL in a style");
            // F2: every style attribute read as CSS (its entities decoded first)
            foreach (Match style in Regex.Matches(html, @"(?i)\sstyle\s*=\s*(?:""([^""]*)""|'([^']*)')"))
                if (CssReach.External(System.Net.WebUtility.HtmlDecode(style.Groups[1].Success ? style.Groups[1].Value : style.Groups[2].Value), declarations: true).Count > 0)
                { problems.Add($"document {d["id"]}: an external URL in a style attribute"); break; }
            if (d["sha256"]?.ToString() != RuntimeCss.Sha(html)) problems.Add($"document {d["id"]}: sha256");
        }
        if (total > MaxTotalBytes) problems.Add($"{total} bytes in all (at most {MaxTotalBytes})");
        return problems;
    }

    // ---- from a capture ----------------------------------------------------------------------------------------------------

    /// <summary>The verb: the screens of a capture (by name or @key; screens and blocks of its flows) rendered against the platform
    /// sheets of the store, with the producers' captures that expand the blocks of other modules.</summary>
    public static JsonObject FromOml(ModelHost host, string omlPath, string lane, IReadOnlyList<string> screens, IReadOnlyList<string> viewports, PlatformSheets platform, IReadOnlyList<string> producers)
    {
        if (screens.Count is 0 or > MaxDocuments) throw new ArgumentException($"render-document: 1 to {MaxDocuments} screens");
        var loaded = new List<ServiceStudio.Model.ESpace>();
        var module = host.Load(omlPath);
        try
        {
            var reader = new KernelModelReader();
            var top = (OutSystems.Model.IObjectSignature)module;
            var es = (OutSystems.Model.IESpace)module;
            var moduleName = TypeResolver.Name(es) ?? Path.GetFileNameWithoutExtension(omlPath);
            var producerBlocks = new Dictionary<string, IObjectSignature>(StringComparer.Ordinal);
            foreach (var path in producers)
            {
                var producer = host.Load(path);
                loaded.Add(producer);
                foreach (var (_, block, _) in RootsOf(reader, (OutSystems.Model.IObjectSignature)producer).Where(r => r.Kind == "MobileBlock"))
                    producerBlocks.TryAdd(reader.NameOf(block), block);
            }
            var roots = RootsOf(reader, top).ToList();
            var themes = ThemesOf(es, roots.Select(r => r.Root).FirstOrDefault());
            var built = new List<Root>();
            var index = 0;
            foreach (var wanted in screens)
            {
                var key = wanted.StartsWith('@') ? wanted[1..] : null;
                var found = roots.FirstOrDefault(r => key != null ? reader.KeyOf(r.Root) == key : string.Equals(reader.NameOf(r.Root), wanted, StringComparison.Ordinal));
                if (found.Root == null) throw new ArgumentException($"render-document: no screen or block {wanted} in {moduleName} (screens: {string.Join(", ", roots.Where(r => r.Kind == "MobileScreen").Select(r => reader.NameOf(r.Root)).Take(20))})");
                var render = new ScreenVisual.RenderMode { ExternalBlock = block => block is IObjectSignature b ? producerBlocks.GetValueOrDefault(reader.NameOf(b)) : null };
                var prediction = ScreenVisual.Predict(reader, found.Root, lane, render);
                var sheets = new List<Style>();
                foreach (var block in render.Blocks.OfType<IObjectSignature>())
                    if (OwnCss(block) is { Length: > 0 } css) sheets.Add(new Style("block-" + Slug(reader.NameOf(block)), "block:" + reader.NameOf(block), css));
                var id = "s" + (++index);
                if (OwnCss(found.Root) is { Length: > 0 } screenCss) sheets.Add(new Style("screen-" + id, "screen:" + reader.NameOf(found.Root), screenCss));
                built.Add(new Root(id, reader.NameOf(found.Root), reader.KeyOf(found.Root), prediction, sheets, render.Unexpanded));
            }
            return Compose(lane, moduleName, Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(omlPath))).ToLowerInvariant(), built, themes, platform, viewports);
        }
        finally
        {
            ModelHost.Release(module);
            foreach (var producer in loaded) ModelHost.Release(producer);
        }
    }

    private static IEnumerable<(string Kind, IObjectSignature Root, IObjectSignature Flow)> RootsOf(KernelModelReader reader, OutSystems.Model.IObjectSignature top)
    {
        foreach (var flow in reader.ChildrenOf(top).Where(c => reader.KindOf(c) is "MobileFlow" or "WebFlow"))
            foreach (var root in reader.ChildrenOf(flow).Where(c => reader.KindOf(c) is "MobileScreen" or "MobileBlock"))
                yield return (reader.KindOf(root), root, flow);
    }

    /// <summary>The module's themes the screen loads, base first (the effective value of each: the Theme Editor half and the
    /// author's), up to a theme of another module (OutSystems UI is the platform's sheet).</summary>
    private static List<Style> ThemesOf(OutSystems.Model.IESpace es, object? firstRoot)
    {
        var themes = new List<Style>();
        var flow = (firstRoot as OutSystems.Model.IObjectSignature)?.Parent as OutSystems.Model.IObjectSignature;
        var shown = (flow != null ? PrototypeBuilder.Prop(flow, "Theme") as OutSystems.Model.IObjectSignature : null) ?? es.DefaultMobileTheme as OutSystems.Model.IObjectSignature;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var at = shown; at != null && seen.Add(at.ObjectKey?.ToString() ?? ""); )
        {
            var theme = es.MobileThemes.FirstOrDefault(t => t.ObjectKey?.ToString() == at.ObjectKey?.ToString());
            if (theme == null) break;
            var css = ThemeCss.Of(theme)?.EffectiveValue is { Length: > 0 } effective ? effective : theme.StyleSheet ?? "";
            themes.Insert(0, new Style("theme-" + Slug(TypeResolver.Name(theme) ?? "theme"), "theme:" + TypeResolver.Name(theme), css));
            at = PrototypeBuilder.Prop(theme, "BaseTheme") as OutSystems.Model.IObjectSignature;
        }
        return themes;
    }

    private static string? OwnCss(object root) => ThemeCss.Of(root)?.EffectiveValue;

    private static string Slug(string name)
    {
        var slug = Regex.Replace(name.ToLowerInvariant(), "[^a-z0-9-]+", "-").Trim('-');
        return slug.Length == 0 ? "x" : slug.Length > 30 ? slug[..30] : slug;
    }
}
