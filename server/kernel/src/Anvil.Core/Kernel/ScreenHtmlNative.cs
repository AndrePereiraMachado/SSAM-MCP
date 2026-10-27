using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Reading;

/// <summary>
/// What a document or an edit writes in HTML that has one native reading, written in it before the page is compiled (the
/// owner's session of 2026-10-12: icons drawn as inline svg, images by URL, an inline style with a binding or a decimal). Each
/// rule is a family, the same in the document form (ModelSession.DocumentCompiler) and in the edit form (ScreenHtmlModule
/// EditPlan), on both lanes, and only on what the text writes new: an element of the reading keeps what it had.
/// <list type="bullet">
/// <item>Any inline &lt;svg&gt; becomes a native element. One painted with currentColor or with one color (an icon) is a
/// &lt;span&gt; with its classes plus <c>ssam-icon</c> and one mask class per drawing, whose rule (the importer's mask,
/// PrototypeIcons) goes to the root's own style sheet; the span keeps the svg's size and the color it painted with. Any other svg
/// (gradients, several colors) is an Image of its own markup (a data URL).</item>
/// <item>&lt;img src&gt; with a URL, a data URL, a file name (logo.svg) or a {{ binding }} is the Image of Type External with
/// that Url; with os-Type="External", a module image in src is dropped (the platform keeps no Image there).</item>
/// <item>style with a binding on a widget whose style is its Custom Style (a text the platform never evaluates) is the
/// attribute style, an extended property, which takes an expression.</item>
/// <item>An inline style value that is a number with a fraction (opacity:0.7, line-height:1.4, flex:.5) is written calc(0.7):
/// the same value for CSS, kept by the runtime, which turns a numeric inline value into a whole number (opacity:0.7 was
/// opacity: 0 on the published page, font-size:11.5px kept).</item>
/// </list>
/// Every change is listed (normalized); a contradiction (a URL in src with another os-Type) is a problem of the same refusal.
/// </summary>
internal static class ScreenHtmlNative
{
    internal sealed class Outcome
    {
        public readonly List<JsonObject> Normalized = [];
        /// <summary>The rules the root's own style sheet needs for the masks (each class once, not already in the sheet).</summary>
        public readonly List<string> Css = [];
        public readonly List<(string Code, int Line, int Column, string Message, string Fix)> Problems = [];
        /// <summary>The one certain correction of a problem, by the place of its element: the attribute and the value it takes
        /// (the compile offers it as the patch, checked by compiling it).</summary>
        public readonly Dictionary<(int Line, int Column), (string Attribute, string Value)> Corrections = [];
        public bool Changed => Normalized.Count > 0;
    }

    /// <summary>What the rules read around an element: its parent (a list's row alias), the data the document declares by name,
    /// the elements by id (what an svg's &lt;use&gt; points at), and what only the module knows (its image names, the attributes of
    /// a record), when the caller has them.</summary>
    internal sealed class Context
    {
        public Func<IEnumerable<string>>? Images;
        public Func<string, IReadOnlyDictionary<string, string>?>? Records;
        private readonly Dictionary<ScreenHtml.Node, ScreenHtml.Node> parents = new(ReferenceEqualityComparer.Instance);
        private readonly Dictionary<string, ScreenHtml.Node> data = new(StringComparer.OrdinalIgnoreCase);
        public readonly Dictionary<string, ScreenHtml.Node> Ids = new(StringComparer.Ordinal);

        public Context(ScreenHtml.Node top)
        {
            void Index(ScreenHtml.Node parent)
            {
                foreach (var child in parent.Children) {
                    if (child.IsText) continue;
                    parents[child] = parent;
                    if (Anvil.Core.ScreenDocument.DataElement(child) && child.Get("name") is { Length: > 0 } name) data.TryAdd(name, child);
                    if (child.Get("id") is { Length: > 0 } id) Ids.TryAdd(id, child);
                    Index(child);
                }
            }
            Index(top);
        }

        public ScreenHtml.Node? Parent(ScreenHtml.Node node) => parents.TryGetValue(node, out var up) ? up : null;
        public ScreenHtml.Node? Data(string name) => data.TryGetValue(name, out var node) ? node : null;
    }

    internal const string IconBase = ":where(.ssam-icon){flex-shrink:0}";

    public const string SvgMask = "SVG_MASK", SvgImage = "SVG_IMAGE", ImageExternal = "IMG_EXTERNAL", ImageSourceDropped = "IMG_SRC_DROPPED",
        StyleExpression = "STYLE_EXPRESSION", StyleNumber = "STYLE_NUMBER", ImageContradiction = "HTML_IMAGE_SOURCE";

    /// <summary>Writes every rule over the elements under <paramref name="top"/> that the text writes new. <paramref name="edited"/>:
    /// the element is the text's (in the document form every one; in an edit, the elements of the edits). <paramref name="readOf"/>:
    /// the element of the reading with the same k, or null for a new one (an attribute equal to the reading's is kept as it is).
    /// <paramref name="isReference"/>: the value names an element of the module (an image of src). <paramref name="sheet"/>: the root's
    /// style sheet as it is (a mask class it already defines needs no rule).
    /// <para><paramref name="images"/>: the names of the module's images (a file name in src names one); <paramref name="records"/>:
    /// the attributes of a record by its name (the type of a bound src); <paramref name="themeSheet"/>: the CSS of the theme the
    /// page shows (a rule for the inside of an svg there is lost too).</para></summary>
    public static Outcome Apply(ScreenHtml.Node top, Func<ScreenHtml.Node, bool> edited, Func<ScreenHtml.Node, ScreenHtml.Node?> readOf,
        Func<string, bool> isReference, string? sheet, Func<IEnumerable<string>>? images = null, Func<string, IReadOnlyDictionary<string, string>?>? records = null,
        string? themeSheet = null)
    {
        var outcome = new Outcome();
        var defined = Anvil.Core.ScreenDocument.CssClasses(sheet);
        if (sheet?.Contains(IconBase, StringComparison.Ordinal) == true) defined.Add(IconBase);
        var context = new Context(top) { Images = images, Records = records };
        NormalizeListAliases(top, edited, outcome);
        var converted = new List<ScreenHtml.Node>();
        Walk(top, edited, readOf, isReference, defined, outcome, context, converted);
        // Integration 24-1 familias (review): a rule that styles the inside of an svg (.icon path { stroke: red }, svg circle) in
        // the document's or the theme's CSS has nothing to style once the svg is a native icon or an image (the importer reads
        // the computed style; a hand-written page does not): a problem of the same refusal, once per selector.
        if (converted.Count > 0) {
            var first = converted[0];
            foreach (var (selector, where) in InnerSelectors(sheet).Select(s => (s, "the page's CSS")).Concat(InnerSelectors(themeSheet).Select(s => (s, "the theme's CSS"))).DistinctBy(x => x.Item1))
                outcome.Problems.Add((SvgInnerCss, first.Line, first.Column,
                    $"{where} styles the inside of an svg ({Clip(selector)}), and the {converted.Count} inline svg(s) of this text become a native icon (a span with a mask) or an image, with no {InnerTag(selector)} inside: that rule would style nothing",
                    "paint the svg itself (fill/stroke on the <svg> or its shapes, or color on its element for an icon in currentColor), and remove the rule for its inside"));
        }
        return outcome;
    }

    // An edit may introduce a List alias after the job-level document normalizer has run.
    // Keep the same AliasRow and expression lexer as that normalizer, without recreating keyed nodes.
    private static void NormalizeListAliases(ScreenHtml.Node top, Func<ScreenHtml.Node, bool> edited, Outcome outcome)
    {
        string Rename(string value, Dictionary<string, (string Row, Func<string, string> Member)> scope)
        {
            foreach (var (alias, row) in scope)
                value = Anvil.Core.Preflight.HtmlText.Apply(value, Anvil.Core.Preflight.HtmlText.RenameRow(value, 0, value.Length, alias, row.Row, row.Member));
            return value;
        }
        string Bindings(string value, Dictionary<string, (string Row, Func<string, string> Member)> scope)
        {
            if (ScreenHtml.Bindings(value, out _) is not { } parts) return value;
            return string.Concat(parts.Select(p => p.Expression ? "{{ " + Rename(p.Text, scope) + " }}" : p.Text));
        }
        void Walk(ScreenHtml.Node node, Dictionary<string, (string Row, Func<string, string> Member)> outer, bool parentEdited)
        {
            if (node.Tag is "text" or "style" or "script" or "os-opaque") return;
            if (node.IsText) { if (parentEdited && outer.Count > 0) node.Text = Bindings(node.Text!, outer); return; }
            var scope = outer;
            if (node.Get("list") is { } source && node.Get("as") is { } alias && edited(node))
            {
                var row = Anvil.Core.ScreenDocument.AliasRow(Rename(source, outer), top);
                if (row.Certain)
                {
                    scope = new(outer, StringComparer.OrdinalIgnoreCase) { [alias] = (row.Row, row.Member) };
                    node.Attributes.RemoveAll(a => a.Key == "as");
                    outcome.Normalized.Add(new JsonObject { ["code"] = Anvil.Core.Preflight.HtmlDocumentRules.ListAlias, ["alias"] = alias, ["row"] = row.Row });
                }
            }
            if (edited(node) && scope.Count > 0)
                for (var i = 0; i < node.Attributes.Count; i++)
                {
                    var (key, value) = node.Attributes[i]; var rewritten = value;
                    if (value.Contains("{{", StringComparison.Ordinal)) rewritten = Bindings(value, scope);
                    else if (key.StartsWith("on", StringComparison.Ordinal) || key.StartsWith("html:on", StringComparison.Ordinal) || key.StartsWith('@'))
                    {
                        if (Anvil.Core.Preflight.HtmlText.CallArguments(value) is { } args)
                            rewritten = Anvil.Core.Preflight.HtmlText.Apply(value, args.SelectMany(a => scope.SelectMany(s => Anvil.Core.Preflight.HtmlText.RenameRow(value, a.ValueStart, a.ValueEnd, s.Key, s.Value.Row, s.Value.Member))));
                    }
                    else if (key is "if" or "list" or "bind" or "show" or "options" or "value" or "enabled" or "mandatory" || key.StartsWith("os-", StringComparison.Ordinal) || key.StartsWith(':'))
                        rewritten = Rename(value, key == "list" ? outer : scope);
                    if (rewritten != value) node.Attributes[i] = new(key, rewritten);
                }
            foreach (var child in node.Children) Walk(child, scope, edited(node));
        }
        Walk(top, new(StringComparer.OrdinalIgnoreCase), false);
    }

    public const string SvgInnerCss = "HTML_SVG_INNER_CSS", SvgUseExternal = "HTML_SVG_USE", SvgUseInlined = "SVG_USE_INLINED";

    // The tags inside an svg that a selector may name (a type selector, never a class or an id of that spelling).
    private static readonly Regex InnerTagPattern = new(@"(?<![\w.#:\-\[""'])(path|circle|rect|ellipse|line|polyline|polygon|g|use|symbol|defs|stop|tspan)(?![\w\-(])", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>The selectors of a stylesheet that name an element inside an svg (path, circle, g, ...), as written.</summary>
    internal static List<string> InnerSelectors(string? css)
    {
        var found = new List<string>();
        if (string.IsNullOrWhiteSpace(css)) return found;
        var text = Regex.Replace(css, @"/\*.*?\*/", "", RegexOptions.Singleline);
        var start = 0;
        for (var i = 0; i < text.Length; i++) {
            if (text[i] == '}' || text[i] == ';') { start = i + 1; continue; }
            if (text[i] != '{') continue;
            var prelude = text[start..i].Trim();
            start = i + 1;
            if (prelude.StartsWith('@') || prelude.Length == 0) continue;
            // Keyframe stops (from, to, 40%) are no selectors.
            if (Regex.IsMatch(prelude, @"^(from|to|\d+(\.\d+)?%)(\s*,\s*(from|to|\d+(\.\d+)?%))*$", RegexOptions.IgnoreCase)) continue;
            foreach (var selector in prelude.Split(',').Select(s => s.Trim()))
                if (InnerTagPattern.IsMatch(Regex.Replace(selector, @"\[[^\]]*\]|""[^""]*""|'[^']*'", ""))) found.Add(selector);
        }
        return found;
    }

    private static string InnerTag(string selector) => InnerTagPattern.Match(selector) is { Success: true } m ? m.Value.ToLowerInvariant() : "shape";

    private static void Walk(ScreenHtml.Node parent, Func<ScreenHtml.Node, bool> edited, Func<ScreenHtml.Node, ScreenHtml.Node?> readOf,
        Func<string, bool> isReference, HashSet<string> defined, Outcome outcome, Context context, List<ScreenHtml.Node> converted)
    {
        for (var i = 0; i < parent.Children.Count; i++) {
            var node = parent.Children[i];
            if (node.IsText || node.Tag is "style" or "text" or "os-opaque" || Anvil.Core.ScreenDocument.DataElement(node)) continue;
            var mine = edited(node);
            var read = mine ? readOf(node) : null;
            if (node.Tag == "svg" && mine && read == null) {
                converted.Add(node);
                parent.Children[i] = node = Svg(node, defined, outcome, context);
                if (node.Tag == "span") continue;
            }
            if (mine) Attributes(node, read, isReference, outcome, context);
            Walk(node, edited, readOf, isReference, defined, outcome, context, converted);
        }
    }

    // ---- attributes of an element the text writes ------------------------------------------------------------------------
    private static bool Fresh(ScreenHtml.Node node, ScreenHtml.Node? read, string attribute) => read == null || read.Get(attribute) != node.Get(attribute);

    private static void Attributes(ScreenHtml.Node node, ScreenHtml.Node? read, Func<string, bool> isReference, Outcome outcome, Context context)
    {
        if (node.Get("required") == "" && Fresh(node, read, "required"))
        {
            var at = node.Attributes.FindIndex(a => a.Key == "required");
            node.Attributes[at] = new("required", "True");
            Note(outcome, "HTML_BOOLEAN_ATTRIBUTE", node, "required", "", "True", "an empty HTML boolean attribute means True, never an empty native expression");
        }
        if (node.Tag == "img") Image(node, read, isReference, outcome, context);
        var kind = ScreenHtmlTables.KindOf(node, out _);
        // style with a binding where style is the Custom Style (a text): the attribute style takes the expression.
        if (node.Get("style") is { } style && Fresh(node, read, "style") && ScreenHtml.HasBinding(style) && node.Get("ext:style") == null
            && ScreenHtmlTables.Reverse(kind, ScreenHtmlModuleMode.Widget).TryGetValue("style", out var property) && property == "CustomStyle") {
            var at = node.Attributes.FindIndex(a => a.Key == "style");
            node.Attributes[at] = new("ext:style", style);
            Note(outcome, StyleExpression, node, "style", style, "ext:style",
                "style holds a binding: the Custom Style of a " + kind + " is text the platform never evaluates, the attribute style (an extended property) takes the expression");
        }
        foreach (var name in new[] { "style", "ext:style", "os-CustomStyle" }) {
            if (node.Get(name) is not { } value || !Fresh(node, read, name)) continue;
            var survived = Survive(value);
            if (survived == value) continue;
            var at = node.Attributes.FindIndex(a => a.Key == name);
            node.Attributes[at] = new(name, survived);
            Note(outcome, StyleNumber, node, name, value, survived,
                "an inline value with a fraction is written calc(n): the same value, which the runtime keeps (it turns a numeric inline value into a whole number)");
        }
    }

    // ---- images ----------------------------------------------------------------------------------------------------------
    // Integration 24-1 familias (review): only a scheme (http:, https:, data:, blob:), a network path (//) or an absolute path (/)
    // is a place with one reading (External). A file name without a scheme (logo.png, assets/logo.png, ./img/a.jpg) is the
    // prototype's name of an image: the module image of that base name (no folder, no extension) when there is one, else a
    // problem with the nearest image names (a relative URL would be a 404 on the published app).
    private static readonly Regex Url = new(@"^(?:https?:|data:|blob:|//|/(?!/))", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex ImageFile = new(@"^[^:{}""?#]*\.(?:svg|png|jpe?g|gif|webp|ico|bmp|avif)(?:[?#].*)?$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>A src that is a place, not a module image: a URL with a scheme, a data URL, a network or an absolute path.</summary>
    internal static bool IsUrl(string value) => Url.IsMatch(value.Trim());

    /// <summary>A file name without a scheme (logo.png, assets/logo.png, ./img/a.jpg): the base name it names (logo), else null.</summary>
    internal static string? FileBase(string value)
    {
        var text = value.Trim();
        if (IsUrl(text) || !ImageFile.IsMatch(text)) return null;
        var path = text.Split('?', '#')[0];
        var name = path[(path.LastIndexOfAny(['/', '\\']) + 1)..];
        var dot = name.LastIndexOf('.');
        var stem = dot > 0 ? name[..dot] : name;
        return stem.Length > 0 ? stem : null;
    }

    public const string ImageFileName = "IMG_FILE_IMAGE", ImageFileUnknown = "HTML_IMAGE_FILE", ImageBindingType = "HTML_IMAGE_BINDING";

    private static void Image(ScreenHtml.Node node, ScreenHtml.Node? read, Func<string, bool> isReference, Outcome outcome, Context context)
    {
        if (node.Get("src") is not { } src || !Fresh(node, read, "src") && !Fresh(node, read, "os-Type")) return;
        var type = node.Get("os-Type");
        // A file name of the prototype: the module image of its base name, or the problem with the nearest names (and the patch
        // when one is nearest).
        if (!ScreenHtml.HasBinding(src) && !isReference(src.Trim()) && FileBase(src) is { } stem && type is null or "Static")
        {
            var images = context.Images?.Invoke()?.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            var same = images?.FirstOrDefault(i => string.Equals(i, stem, StringComparison.OrdinalIgnoreCase))
                ?? (isReference("Image:" + stem) ? stem : null);
            if (same != null)
            {
                node.Attributes[node.Attributes.FindIndex(a => a.Key == "src")] = new("src", same);
                Note(outcome, ImageFileName, node, "src", src, same, "a file name without a scheme names the module image of its base name (" + same + "); a relative URL would not exist on the published app");
                return;
            }
            var near = images is { Count: > 0 } ? Anvil.Core.ScreenDocument.Nearest(stem, images) : [];
            outcome.Problems.Add((ImageFileUnknown, node.Line, node.Column,
                $"<img src=\"{Clip(src)}\"> is a file name: the module has no image named '{stem}'" + (near.Count > 0 ? "; nearest: " + string.Join(", ", near) : ""),
                near.Count == 1 ? $"src=\"{near[0]}\" (the patch), or a URL with its scheme (https://...)" : "name a module image in src (its name, no folder or extension), or write a URL with its scheme (https://...)"));
            if (near.Count == 1) outcome.Corrections[(node.Line, node.Column)] = ("src", near[0]);
            // Said once: the compile does not read the file name again as a name of the module.
            node.Attributes.RemoveAll(a => a.Key == "src");
            return;
        }
        var reference = !ScreenHtml.HasBinding(src) && isReference(src.Trim());
        if (reference) {
            if (type != "External") return;
            node.Attributes.RemoveAll(a => a.Key == "src");
            Note(outcome, ImageSourceDropped, node, "src", src, null, "os-Type=\"External\" shows the Url: the platform keeps no module image there, so src goes");
            return;
        }
        var bound = ScreenHtml.HasBinding(src);
        if (!bound && !IsUrl(src)) return;   // a name the module does not have: the compile says so, with the nearest names
        // A binding is chosen by the type of its expression: Binary Data is the binary content (Type Binary, ImageContent), a
        // text is the Url (External); without a type this side knows, two readings: refused, both forms in the fix.
        if (bound && type is null or "Binary") {
            var expression = ScreenHtml.Unsugar(src);
            var kind = SrcType(expression, node, context);
            if (kind == "Binary Data") {
                if (node.Get("url") != null || node.Get("os-ImageContent") is { } content && content != expression) {
                    outcome.Problems.Add((ImageContradiction, node.Line, node.Column, $"<img> has two sources: src=\"{Clip(src)}\" (Binary Data) and another one", "keep one: src or os-ImageContent"));
                    return;
                }
                var place = node.Attributes.FindIndex(a => a.Key == "src");
                node.Attributes.RemoveAt(place);
                if (node.Get("os-ImageContent") == null) node.Attributes.Insert(place, new("os-ImageContent", expression));
                if (type == null) node.Attributes.Insert(place + 1, new("os-Type", "Binary"));
                Note(outcome, ImageExternal, node, "src", src, "os-Type=\"Binary\" os-ImageContent=" + Clip(expression), "a binding of Binary Data in src is the Image of Type Binary with that content");
                return;
            }
            if (type == "Binary") return;   // the author's own Type: the compile writes src as it is, the Verify judges it
            if (kind != "Text") {
                outcome.Problems.Add((ImageBindingType, node.Line, node.Column,
                    $"<img src=\"{Clip(src)}\">: " + (kind == null ? "the type of the expression is not known here" : "the expression is " + kind) + ", and src takes a URL (Text) or a binary content (Binary Data)",
                    $"write url=\"{Clip(expression)}\" os-Type=\"External\" for a URL, or os-Type=\"Binary\" os-ImageContent=\"{Clip(expression)}\" for a Binary Data"));
                return;
            }
        }
        if (type != null && type != "External") {
            outcome.Problems.Add((ImageContradiction, node.Line, node.Column, $"<img src=\"{Clip(src)}\"> is a URL, but os-Type=\"{type}\" shows {(type == "Binary" ? "binary content" : "a module image")}",
                "remove os-Type (a URL is the Image of Type External), or name a module image in src"));
            return;
        }
        var url = bound ? ScreenHtml.Unsugar(src) : ScreenHtml.Literal(src.Trim());
        if (node.Get("url") is { } existing && existing != url) {
            outcome.Problems.Add((ImageContradiction, node.Line, node.Column, $"<img> has two sources: src=\"{Clip(src)}\" and url=\"{Clip(existing)}\"", "keep one: src (a URL or a module image) or url (an expression)"));
            return;
        }
        var at = node.Attributes.FindIndex(a => a.Key == "src");
        node.Attributes.RemoveAt(at);
        if (node.Get("url") == null) node.Attributes.Insert(at, new("url", url));
        if (type == null) node.Attributes.Insert(at + 1, new("os-Type", "External"));
        Note(outcome, ImageExternal, node, "src", src, "os-Type=\"External\" url=" + Clip(url), "a URL with its scheme, a data URL or a binding of a text in src is the Image of Type External with that Url");
    }

    /// <summary>The type of the expression of a bound src, as far as the document and the records tell it: "Text" for anything
    /// with a text literal (a concatenation), the type of a path through a variable, an input, an aggregate's current row or a
    /// list's row (and the attributes of their records); null when unknown here.</summary>
    internal static string? SrcType(string expression, ScreenHtml.Node at, Context context)
    {
        List<Anvil.Core.Preflight.Token> tokens;
        try { tokens = Anvil.Core.Preflight.ExpressionText.Tokens(expression); } catch { return null; }
        if (tokens.Any(t => t.Kind == Anvil.Core.Preflight.TokenKind.Text)) return "Text";
        if (tokens.Count != 1 || tokens[0].Kind != Anvil.Core.Preflight.TokenKind.Name) return null;
        var segments = tokens[0].Text.Split('.').ToList();
        // The row of a list (list="Source" as="Row", or Source.Current): its source's current row.
        for (var up = at; up != null; up = context.Parent(up))
            if (up.Get("as") is { } alias && alias.Equals(segments[0], StringComparison.Ordinal) && up.Get("list") is { } source) {
                segments = [.. source.Split('.'), "Current", .. segments.Skip(1)];
                break;
            }
        var data = context.Data(segments[0]);
        if (data == null) return null;
        string? type; var next = 1;
        if (data.Tag == "aggregate") {
            if (segments.Count < 3 || segments[1] != "List" || segments[2] != "Current") return null;
            var sources = (data.Get("from") ?? "").Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                .Select(s => s.Contains('=') ? (Alias: s[..s.IndexOf('=')].Trim(), Entity: s[(s.IndexOf('=') + 1)..].Trim()) : (Alias: s, Entity: s)).ToList();
            next = 3;
            if (segments.Count > 3 && sources.FirstOrDefault(s => s.Alias.Equals(segments[3], StringComparison.OrdinalIgnoreCase)) is { Entity: { } named } && named.Length > 0) { type = named; next = 4; }
            else if (sources.Count == 1) type = sources[0].Entity;
            else return null;
        }
        else type = data.Get("type");
        for (var k = next; k < segments.Count && type != null; k++) {
            var attributes = context.Records?.Invoke(type);
            if (attributes != null && attributes.TryGetValue(segments[k], out var attributeType)) type = attributeType;
            else if (context.Records?.Invoke(segments[k]) != null && k == next) type = segments[k];   // the record of one entity, by its name
            else return null;
        }
        return type?.Replace(" ", "").ToLowerInvariant() switch
        {
            null => null,
            "binarydata" or "binary" => "Binary Data",
            "text" or "email" or "phonenumber" => "Text",
            _ => type,
        };
    }

    // ---- svg -------------------------------------------------------------------------------------------------------------
    private static readonly HashSet<string> NotIcon = new(StringComparer.OrdinalIgnoreCase)
        { "image", "use", "lineargradient", "radialgradient", "pattern", "foreignobject", "style", "script", "mask", "filter" };
    private static readonly HashSet<string> Paints = new(StringComparer.OrdinalIgnoreCase) { "", "none", "currentcolor", "transparent" };
    private static readonly Regex LiteralColor = new(@"^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+)$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    // The attributes of the svg root that are its drawing (they go to the mask or the image, never to the element that replaces it).
    private static readonly HashSet<string> Drawing = new(StringComparer.OrdinalIgnoreCase)
        { "xmlns", "viewBox", "width", "height", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
          "stroke-dashoffset", "stroke-opacity", "fill-opacity", "fill-rule", "clip-rule", "preserveAspectRatio", "version", "x", "y", "focusable", "overflow" };

    // The shapes an svg draws; a line has no inside to fill.
    private static readonly HashSet<string> Shapes = new(StringComparer.OrdinalIgnoreCase) { "path", "circle", "rect", "ellipse", "line", "polyline", "polygon" };

    /// <summary>What an svg paints with, each shape with the paint it inherits (the SVG defaults where nothing is written: fill
    /// black, no stroke; currentColor is the nearest color attribute when one is written): <see cref="Paint.Colors"/> the literal
    /// colors, <see cref="Paint.Current"/> whether any shape paints in currentColor, <see cref="Paint.Icon"/> false when it can be no
    /// icon (a gradient, a pattern, an image, text, an inline style, a use, no shape).</summary>
    internal sealed record Paint(HashSet<string> Colors, bool Current, bool Icon);

    internal static Paint PaintOf(ScreenHtml.Node svg)
    {
        var colors = new HashSet<string>(StringComparer.OrdinalIgnoreCase); var current = false; var icon = true; var shapes = 0;
        void Use(string value, string? color)
        {
            if (Paints.Contains(value) && !value.Equals("currentColor", StringComparison.OrdinalIgnoreCase)) return;
            if (value.Equals("currentColor", StringComparison.OrdinalIgnoreCase)) {
                if (color != null && !color.Equals("currentColor", StringComparison.OrdinalIgnoreCase) && LiteralColor.IsMatch(color)) colors.Add(color); else current = true;
                return;
            }
            if (LiteralColor.IsMatch(value)) colors.Add(value); else icon = false;
        }
        void Visit(ScreenHtml.Node node, string? fill, string? stroke, string? color)
        {
            if (node.IsText) return;
            if (NotIcon.Contains(node.Tag) || node.Tag.Equals("text", StringComparison.OrdinalIgnoreCase) || node.Get("style") != null) icon = false;
            fill = node.Get("fill")?.Trim() ?? fill; stroke = node.Get("stroke")?.Trim() ?? stroke; color = node.Get("color")?.Trim() ?? color;
            if (Shapes.Contains(node.Tag)) {
                shapes++;
                if (!node.Tag.Equals("line", StringComparison.OrdinalIgnoreCase)) Use(fill ?? "#000", color);
                Use(stroke ?? "none", color);
            }
            foreach (var child in node.Children) Visit(child, fill, stroke, color);
        }
        Visit(svg, null, null, null);
        return new Paint(colors, current, icon && shapes > 0);
    }

    /// <summary>The one color an svg paints with: "" for currentColor (an icon), the literal color when every shape paints with that
    /// one color (with nothing written, the SVG's own black, #000), null when it is no icon (a gradient, a pattern, an image, text,
    /// an inline style, two colors, or currentColor beside a literal color: an image, where currentColor has no text color).</summary>
    internal static string? IconColor(ScreenHtml.Node svg)
    {
        var paint = PaintOf(svg);
        if (!paint.Icon) return null;
        if (paint.Current) return paint.Colors.Count == 0 ? "" : null;
        return paint.Colors.Count == 1 ? paint.Colors.First() : paint.Colors.Count == 0 ? null : null;
    }

    private static ScreenHtml.Node Svg(ScreenHtml.Node svg, HashSet<string> defined, Outcome outcome, Context context)
    {
        // A <use> draws what it points at: inside the svg it goes with it; elsewhere in the document (a sprite) it is copied in
        // (its one reading); a file or a name the document does not have leaves the drawing empty: a problem.
        ScreenHtml.Node? defs = null;
        foreach (var (use, _) in ScreenHtmlText.Elements(svg).Where(e => e.Node.Tag.Equals("use", StringComparison.OrdinalIgnoreCase)).ToList()) {
            var href = (use.Get("href") ?? use.Get("xlink:href"))?.Trim();
            if (string.IsNullOrEmpty(href)) continue;
            var id = href.StartsWith('#') ? href[1..] : null;
            if (id != null && ScreenHtmlText.Elements(svg).Any(e => e.Node.Get("id") == id)) continue;
            if (id != null && context.Ids.TryGetValue(id, out var target) && !ReferenceEquals(target, svg)) {
                if (defs == null) { defs = new ScreenHtml.Node { Tag = "defs", Line = svg.Line, Column = svg.Column }; svg.Children.Insert(0, defs); }
                if (!defs.Children.Any(c => c.Get("id") == id)) defs.Children.Add(Copy(target));
                Note(outcome, SvgUseInlined, svg, "use", href, "<defs> with #" + id, "an svg's <use href=\"#" + id + "\"> draws an element of the page: copied into the svg, so its image has the drawing");
                continue;
            }
            outcome.Problems.Add((SvgUseExternal, svg.Line, svg.Column,
                $"<svg> draws <use href=\"{Clip(href)}\">, which is " + (id != null ? "no element of this document" : "another file") + ": as a native icon or image the svg would be empty",
                "write the drawing in the svg (its paths), or an <i icon=\"...\"> of the icon library"));
        }
        var paint = PaintOf(svg);
        var color = IconColor(svg);
        var size = Size(svg);
        if (color != null) {
            var mask = MaskMarkup(svg, color.Length > 0);
            var data = "data:image/svg+xml," + Anvil.Core.PrototypeIcons.PercentEncode(mask);
            var name = "ssam-icon-svg-" + Fnv(mask);
            // An svg keeps its size in a flex row (a replaced element never shrinks below it); the span that replaces it, by this
            // rule (zero specificity: the author's own rules still win).
            if (defined.Add(IconBase)) outcome.Css.Add(IconBase);
            if (defined.Add(name))
                outcome.Css.Add("." + name + "{display:inline-block;background-color:currentColor;-webkit-mask:url(\"" + data + "\") center/contain no-repeat;mask:url(\"" + data + "\") center/contain no-repeat}");
            var span = new ScreenHtml.Node { Tag = "span", Line = svg.Line, Column = svg.Column };
            Keep(svg, span);
            var classes = (svg.Get("class") ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
            foreach (var c in new[] { "ssam-icon", name }) if (!classes.Contains(c)) classes.Add(c);
            Set(span, "class", string.Join(" ", classes));
            var style = size.Concat(color.Length > 0 ? ["color:" + color] : []).ToList();
            if (svg.Get("style") is { Length: > 0 } own) style.Add(own.Trim().TrimEnd(';'));
            if (style.Count > 0) Set(span, "style", string.Join(";", style));
            Note(outcome, SvgMask, svg, "svg", null, "<span class=\"" + string.Join(" ", classes) + "\">",
                "an svg drawn with " + (color.Length > 0 ? "one color (" + color + ")" : "currentColor") + " is an icon: a span with the mask class " + name + " (its rule in the root's style sheet) and the svg's size and color");
            return span;
        }
        var markup = Markup(svg, keepAll: true);
        var img = new ScreenHtml.Node { Tag = "img", Line = svg.Line, Column = svg.Column };
        img.Attributes.Add(new("src", "data:image/svg+xml," + Anvil.Core.PrototypeIcons.PercentEncode(markup)));
        Keep(svg, img);
        var imgStyle = size.ToList();
        if (svg.Get("style") is { Length: > 0 } inline) imgStyle.Add(inline.Trim().TrimEnd(';'));
        if (imgStyle.Count > 0) Set(img, "style", string.Join(";", imgStyle));
        Note(outcome, SvgImage, svg, "svg", null, "<img src=\"data:image/svg+xml,...\">",
            "an svg with several colors, gradients or images is the Image of its own markup (a data URL, Type External)"
            + (paint.Current ? "; NOTE: what it paints in currentColor is black in an image (an image has no text color): write that color in its fill or stroke" : ""));
        if (paint.Current) outcome.Normalized[^1]["currentColorLost"] = true;
        return img;
    }

    private static ScreenHtml.Node Copy(ScreenHtml.Node node)
    {
        var copy = new ScreenHtml.Node { Tag = node.Tag, Text = node.Text, Line = node.Line, Column = node.Column };
        copy.Attributes.AddRange(node.Attributes);
        foreach (var child in node.Children) copy.Children.Add(Copy(child));
        return copy;
    }

    // The attributes of the svg that are the element's, not its drawing (class, id, role, aria-*, title, data-*, its events).
    private static void Keep(ScreenHtml.Node svg, ScreenHtml.Node to)
    {
        foreach (var (name, value) in svg.Attributes)
            if (!Drawing.Contains(name) && !name.StartsWith("xmlns:", StringComparison.Ordinal) && name is not ("class" or "style")) to.Attributes.Add(new(name, value));
        // The svg's <title> is its accessible name.
        if (to.Get("aria-label") == null && svg.Children.FirstOrDefault(c => !c.IsText && c.Tag == "title") is { } title
            && string.Concat(title.Children.Where(c => c.IsText).Select(c => c.Text)).Trim() is { Length: > 0 } label) {
            to.Attributes.Add(new("aria-label", label));
            if (to.Get("role") == null) to.Attributes.Add(new("role", "img"));
        }
    }

    private static void Set(ScreenHtml.Node node, string name, string value)
    {
        var at = node.Attributes.FindIndex(a => a.Key == name);
        if (at >= 0) node.Attributes[at] = new(name, value); else node.Attributes.Add(new(name, value));
    }

    // The size the svg had (its width and height attributes) as inline style: a number is pixels.
    private static List<string> Size(ScreenHtml.Node svg)
    {
        var size = new List<string>();
        foreach (var axis in new[] { "width", "height" })
            if (svg.Get(axis)?.Trim() is { Length: > 0 } value && Regex.IsMatch(value, @"^\d+(\.\d+)?(px|em|rem|%|vh|vw)?$"))
                size.Add(axis + ":" + (char.IsDigit(value[^1]) ? value + "px" : value));
        return size;
    }

    // The svg as a mask image: its drawing as written (the root keeps xmlns, viewBox and its paints), what was only for the page
    // (class, id, style, aria, events) left out. A one-color svg paints black where it painted that color (the mask reads alpha),
    // and the SVG defaults are written on its root (fill black, no stroke) as the importer does.
    private static string MaskMarkup(ScreenHtml.Node svg, bool literal)
    {
        var root = new ScreenHtml.Node { Tag = "svg" };
        foreach (var (name, value) in svg.Attributes) if (Drawing.Contains(name) || name.StartsWith("xmlns:", StringComparison.Ordinal)) root.Attributes.Add(new(name, value));
        if (root.Get("xmlns") == null) root.Attributes.Insert(0, new("xmlns", "http://www.w3.org/2000/svg"));
        if (root.Get("viewBox") == null && double.TryParse(svg.Get("width")?.Replace("px", ""), NumberStyles.Float, CultureInfo.InvariantCulture, out var w)
            && double.TryParse(svg.Get("height")?.Replace("px", ""), NumberStyles.Float, CultureInfo.InvariantCulture, out var h))
            root.Attributes.Add(new("viewBox", "0 0 " + w.ToString(CultureInfo.InvariantCulture) + " " + h.ToString(CultureInfo.InvariantCulture)));
        if (literal) {
            if (root.Get("fill") == null) root.Attributes.Add(new("fill", "#000"));
            if (root.Get("stroke") == null) root.Attributes.Add(new("stroke", "none"));
        }
        root.Children.AddRange(svg.Children.Where(c => c.IsText || c.Tag != "title"));
        var markup = Markup(root, keepAll: true);
        // The one color of a drawn shape is the mask's black.
        return literal ? Regex.Replace(markup, @"(fill|stroke|color|stop-color)=""(?!none""|currentColor""|transparent"")[^""]*""", "$1=\"#000\"", RegexOptions.IgnoreCase) : markup;
    }

    // The XML of an svg subtree (the parser keeps tag and attribute names as written: viewBox, linearGradient).
    private static string Markup(ScreenHtml.Node node, bool keepAll)
    {
        var sb = new StringBuilder();
        void Write(ScreenHtml.Node n, bool root)
        {
            if (n.IsText) { sb.Append(Xml(n.Text!, false)); return; }
            sb.Append('<').Append(n.Tag);
            if (root && n.Get("xmlns") == null) sb.Append(" xmlns=\"http://www.w3.org/2000/svg\"");
            foreach (var (name, value) in n.Attributes) {
                if (!keepAll && root && !Drawing.Contains(name)) continue;
                sb.Append(' ').Append(name).Append("=\"").Append(Xml(value, true)).Append('"');
            }
            if (n.Children.Count == 0) { sb.Append("/>"); return; }
            sb.Append('>');
            foreach (var c in n.Children) Write(c, false);
            sb.Append("</").Append(n.Tag).Append('>');
        }
        Write(node, true);
        return Regex.Replace(sb.ToString(), @">\s+<", "><");
    }

    private static string Xml(string text, bool attribute)
    {
        var sb = new StringBuilder(text.Length);
        foreach (var c in text)
            sb.Append(c switch { '&' => "&amp;", '<' => "&lt;", '>' => "&gt;", '"' when attribute => "&quot;", _ => c.ToString() });
        return sb.ToString();
    }

    private static string Fnv(string text)
    {
        var hash = 0x811c9dc5u;
        foreach (var c in text) { hash ^= c; hash *= 0x01000193u; }
        return hash.ToString("x8", CultureInfo.InvariantCulture);
    }

    /// <summary>A stylesheet whose selectors svg also match the icon spans (:is(svg, :where(.ssam-icon)), the specificity of svg) and
    /// whose selectors span leave them out (span:not(:where(.ssam-icon))): the importer's item 5 (PrototypeRewrites, IconsOnly), so a
    /// rule the author wrote for the svg icons (".nav-item svg { width: 18px }") styles the spans that replace them. Idempotent.</summary>
    internal static string WidenIconSelectors(string css) =>
        css.Length == 0 ? css : Anvil.Core.PrototypeRewrites.Rewrite(css, new Anvil.Core.RewriteOptions { IconsOnly = true }).Text;

    // ---- inline style numbers ----------------------------------------------------------------------------------------------
    private static readonly Regex Number = new(@"^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$", RegexOptions.Compiled);
    private static readonly Regex Whole = new(@"^[+-]?\d+(\.0*)?$", RegexOptions.Compiled);

    /// <summary>An inline style with every declaration whose value is a number with a fraction (or an exponent) written calc(n), the
    /// same value for CSS; the bindings ({{ }}) and every other value as written.</summary>
    internal static string Survive(string style)
    {
        if (style.IndexOfAny(['.', 'e', 'E']) < 0) return style;
        // The bindings are no CSS: masked while the declarations are read.
        var bindings = new List<string>();
        var masked = Regex.Replace(style, @"\{\{.*?\}\}", m => { bindings.Add(m.Value); return "\u0001" + (bindings.Count - 1).ToString(CultureInfo.InvariantCulture) + "\u0001"; }, RegexOptions.Singleline);
        var sb = new StringBuilder();
        var depth = 0; var quote = '\0'; var start = 0;
        void Declaration(int end)
        {
            var text = masked[start..end];
            var colon = text.IndexOf(':');
            if (colon > 0) {
                var value = text[(colon + 1)..];
                var trimmed = value.Trim();
                if (Number.IsMatch(trimmed) && !Whole.IsMatch(trimmed)) {
                    var lead = value[..(value.Length - value.TrimStart().Length)];
                    var tail = value[value.TrimEnd().Length..];
                    text = text[..(colon + 1)] + lead + "calc(" + trimmed + ")" + tail;
                }
            }
            sb.Append(text);
        }
        for (var i = 0; i < masked.Length; i++) {
            var c = masked[i];
            if (quote != '\0') { if (c == quote) quote = '\0'; continue; }
            if (c is '"' or '\'') quote = c;
            else if (c == '(') depth++;
            else if (c == ')') depth--;
            else if (c == ';' && depth == 0) { Declaration(i); sb.Append(';'); start = i + 1; }
        }
        Declaration(masked.Length);
        return Regex.Replace(sb.ToString(), "\u0001(\\d+)\u0001", m => bindings[int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture)]);
    }

    private static void Note(Outcome outcome, string code, ScreenHtml.Node node, string attribute, string? from, string? to, string why) =>
        outcome.Normalized.Add(new JsonObject { ["code"] = code, ["line"] = node.Line, ["column"] = node.Column, ["element"] = node.Tag, ["attribute"] = attribute,
            ["from"] = from == null ? null : Clip(from), ["to"] = to == null ? null : Clip(to), ["note"] = why });

    private static string Clip(string text) => text.Length > 120 ? text[..120] + "…" : text;
}
