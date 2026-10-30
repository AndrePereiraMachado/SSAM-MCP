using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// R3-A: the visual check against the platform's REAL cascade. The sheets of the platform (the Reactive/Mobile runtime's base sheet
/// and the OutSystems UI theme, in the runtime's order, RuntimeCss) reach the check as sheets whose <see cref="Sheet.Where"/> is
/// <c>platform:&lt;file&gt;</c> (<see cref="PlatformSheetsOf"/>); the author's sheets (theme, page) come after them, as the runtime
/// loads them. The cascade is computed on the predicted runtime DOM (ScreenVisual.Predict) placed under the page the runtime
/// serves (html &gt; body.&lt;device classes&gt; &gt; #reactContainer &gt; .screen-container &gt; .active-screen), once per breakpoint
/// (<see cref="Viewports"/>: the device classes OutSystems UI puts on body and the widths of its media queries). Five families,
/// each with a stable code, the element (its line and model key), the platform rule that wins (file and selector), the property,
/// the value the author meant (<see cref="Finding.Expect"/>) and the suggested patch (certain when it is unique and checked on the
/// predicted DOM):
/// <list type="bullet">
/// <item>(a) <see cref="PlatformSpecificity"/>: an author declaration loses the same property to a platform rule (specificity,
/// !important) on the runtime element;</item>
/// <item>(b) <see cref="PlatformInherited"/>: a text property the author sets on an ancestor (white-space and its kin) is set again
/// by a platform rule on the element that holds the text (span[data-expression]): the text no longer inherits it;</item>
/// <item>(c) <see cref="PlatformPositional"/>: a positional selector (:first-child, :last-child, :nth-child, :only-child) that the
/// runtime's sentinels (the &lt;script&gt; children of a List) move off the element the author meant (needs no sheet);</item>
/// <item>(d) <see cref="PlatformInjected"/>: a width or margin a runtime class (OSFillParent, ThemeGrid_MarginGutter, OSInline)
/// gives an item of a flex or grid container the author did not write;</item>
/// <item>(e) <see cref="PlatformFixedLayout"/>: a fixed element of the platform's layout (menu, header) that covers the content
/// next to it, or that the platform moves off screen, per breakpoint (a fact of the theme, said as such).</item>
/// </list>
/// Deterministic, no layout engine and no network: every value is read from the cascade, never measured (render-document's
/// probes ask the agent's renderer to confirm or refute each one).
/// </summary>
public static partial class ScreenVisual
{
    public const string PlatformSpecificity = "HTML_PLATFORM_SPECIFICITY";
    public const string PlatformInherited = "HTML_PLATFORM_INHERITED";
    public const string PlatformPositional = "HTML_PLATFORM_POSITIONAL";
    public const string PlatformInjected = "HTML_PLATFORM_INJECTED";
    public const string PlatformFixedLayout = "HTML_PLATFORM_FIXED_LAYOUT";

    /// <summary>The codes of the platform families, in the order (a) to (e).</summary>
    public static readonly IReadOnlyList<string> PlatformCodes = [PlatformSpecificity, PlatformInherited, PlatformPositional, PlatformInjected, PlatformFixedLayout];

    public const string PlatformSheetPrefix = "platform:";

    /// <summary>The place of the OutSystems UI theme among the platform's sheets.</summary>
    public static readonly string OsuiSheet = PlatformSheetPrefix + RuntimeCss.Order.First(o => o.Id == "osui").File;

    /// <summary>Whether a sheet of the check is one of the platform's (RuntimeCss), not the author's.</summary>
    public static bool IsPlatformSheet(Sheet sheet) => sheet.Where.StartsWith(PlatformSheetPrefix, StringComparison.Ordinal);

    /// <summary>The platform sheets as sheets of the check, in the runtime's order (they go before the author's).</summary>
    public static IReadOnlyList<Sheet> PlatformSheetsOf(PlatformSheets platform) =>
        platform.Sheets.Select(s => new Sheet(s.Css, PlatformSheetPrefix + s.File)).ToList();

    /// <summary>One breakpoint: its name, the viewport the media queries read and the classes OutSystems UI's script puts on body
    /// (no script runs in the check nor in the render: they come from here).</summary>
    public sealed record Viewport(string Name, int Width, int Height, IReadOnlyList<string> BodyClasses);

    public static readonly IReadOnlyList<Viewport> Viewports =
    [
        new("desktop", 1366, 768, ["desktop"]),
        new("tablet", 768, 1024, ["tablet", "portrait"]),
        new("phone", 375, 812, ["phone", "portrait"]),
    ];

    public static Viewport ViewportNamed(string name) =>
        Viewports.FirstOrDefault(v => v.Name == name) ?? throw new ArgumentException($"unknown viewport '{name}' (desktop, tablet, phone)");

    /// <summary>The text properties that inherit and change how a text breaks or reads (family b).</summary>
    private static readonly IReadOnlySet<string> InheritedTextProperties = Set("white-space word-break overflow-wrap word-wrap text-transform letter-spacing word-spacing hyphens");

    /// <summary>The computed styles the agent's renderer measures (ssam-render-request/1 probes.properties): a probe on another
    /// property is answered not-observed.</summary>
    public static readonly IReadOnlySet<string> MeasuredProperties = Set("display position visibility opacity white-space overflow overflow-x overflow-y width height min-width max-width "
        + "margin-top margin-right margin-bottom margin-left padding-top padding-right padding-bottom padding-left font-size font-family line-height text-overflow z-index "
        + "flex-grow flex-shrink flex-basis flex-direction flex-wrap justify-content align-items gap grid-template-columns box-sizing top left color background-color "
        + "border-top-width border-right-width border-bottom-width border-left-width");

    /// <summary>The content wrappers of the OutSystems UI layout beside its menu (family e, covers).</summary>
    private static readonly IReadOnlySet<string> LayoutContent = Set("main content main-content");

    /// <summary>The declarations by which an author keeps an element on screen against the rule that moves it off (family e,
    /// hidden): its offset, transform, display or visibility, or a position other than fixed. A width alone keeps nothing (V8).</summary>
    private static readonly IReadOnlySet<string> HorizontalOffsets = Set("left right margin-left margin-right transform translate");
    private static readonly IReadOnlySet<string> VerticalOffsets = Set("top bottom margin-top margin-bottom transform translate");

    /// <summary>V8b, V8c: whether an author declaration contradicts, on the same axis, the property that moved the element off
    /// screen: against left/right (or a horizontal transform) an offset or margin of that axis, a transform or translate, or a
    /// position other than fixed; against top/bottom the same on the vertical axis; against display:none a display other than
    /// none; against visibility:hidden visibility visible. A display of layout, or a vertical offset against a menu moved off by
    /// the left, never keeps it on screen.</summary>
    private static bool KeepsOnScreen((string Longhand, string Property, string Value, bool Important) d, string movedBy, string movedTo) => movedBy switch
    {
        "display" => d.Longhand == "display" && Norm(d.Value) != "none",
        "visibility" => d.Longhand == "visibility" && Norm(d.Value) == "visible",
        "top" or "bottom" => VerticalOffsets.Contains(d.Longhand) || d.Longhand == "position" && Norm(d.Value) != "fixed",
        "transform" when Regex.IsMatch(Norm(movedTo), @"translatey\(") => VerticalOffsets.Contains(d.Longhand) || d.Longhand == "position" && Norm(d.Value) != "fixed",
        _ => HorizontalOffsets.Contains(d.Longhand) || d.Longhand == "position" && Norm(d.Value) != "fixed",
    };

    /// <summary>The box properties a runtime class injects (family d).</summary>
    private static readonly IReadOnlySet<string> InjectedBoxProperties = Set("width min-width max-width margin-top margin-right margin-bottom margin-left");

    // ---- the cascade ------------------------------------------------------------------------------------------------------

    /// <summary>One selector of a rule, with its declarations as longhands, where it comes from and its place in the cascade.</summary>
    internal sealed class CascadeEntry
    {
        public required string Selector { get; init; }
        public required ComplexSelector Complex { get; init; }
        public required (int A, int B, int C) Specificity { get; init; }
        public required IReadOnlyList<string> Media { get; init; }
        public required bool Platform { get; init; }
        public required Sheet Sheet { get; init; }
        public required string SheetText { get; init; }
        public required CssRule Rule { get; init; }
        public required int Order { get; init; }
        /// <summary>F8: the cascade layer of the rule: <see cref="int.MaxValue"/> outside any @layer (the unlayered rules win the
        /// normal declarations of every layer, and lose their !important ones), else the rank of its layer by first appearance.</summary>
        public int Layer { get; init; } = int.MaxValue;
        public string? LayerName { get; init; }
        /// <summary>(longhand, the property as written, the longhand's value, important).</summary>
        public required List<(string Longhand, string Property, string Value, bool Important)> Declarations { get; init; }
        /// <summary>The file and selector a warning names.</summary>
        public string Named => (Platform ? Sheet.Where[PlatformSheetPrefix.Length..] : Sheet.Where) + " " + Selector;
    }

    // The parsed entries of a platform sheet (hundreds of KB, read by every page): by the sheet's text, a few kept.
    private static readonly Dictionary<string, List<(CssRule Rule, string Selector, ComplexSelector Complex)>> PlatformParsed = new(StringComparer.Ordinal);

    private static List<(CssRule Rule, string Selector, ComplexSelector Complex)> SelectorsOf(string css)
    {
        lock (PlatformParsed)
            if (PlatformParsed.TryGetValue(css, out var cached)) return cached;
        var list = new List<(CssRule, string, ComplexSelector)>();
        try
        {
            foreach (var rule in CssStylesheet.Parse(css, lenient: true).Rules)
            {
                if (rule.Declarations.Count == 0) continue;
                foreach (var text in CssStylesheet.SplitSelectors(rule.Selector).Select(x => x.Trim()).Where(x => x.Length > 0))
                {
                    try
                    {
                        if (CssSelectors.ParseList(text) is not [var one]) continue;
                        // A pseudo-element's rule styles the pseudo-element, never the element.
                        if (one.Parts.Any(p => p.Compound.Items.Any(s => s.Kind == SimpleKind.PseudoElement))) continue;
                        list.Add((rule, text, one));
                    }
                    catch (Exception) { /* a selector the engine does not read is not judged */ }
                }
            }
        }
        catch (Exception) { }
        lock (PlatformParsed)
        {
            if (PlatformParsed.Count > 6) PlatformParsed.Clear();
            PlatformParsed[css] = list;
        }
        return list;
    }

    /// <summary>The cascade of a page: the platform's sheets then the author's (theme, then page), indexed by the subject's most
    /// selective simple selector (as a browser's rule hash), matched per element and breakpoint once.</summary>
    internal sealed class Cascade
    {
        private readonly Dictionary<string, List<CascadeEntry>> _index = new(StringComparer.Ordinal);
        private readonly Dictionary<(DomNode, string), List<CascadeEntry>> _matched = new();
        public IReadOnlyList<CascadeEntry> AuthorEntries { get; }
        public bool HasPlatform { get; }
        /// <summary>The OutSystems UI theme is among the platform's sheets (F3: the rules written by hand answer without it).</summary>
        public bool HasOsui { get; }

        /// <summary>The layer a rule is in (its enclosing @layer preludes joined by '.'; an anonymous one is its own), null outside.</summary>
        private static string? LayerOf(IReadOnlyList<string> enclosing, int rule)
        {
            var names = new List<string>();
            foreach (var prelude in enclosing)
            {
                var p = prelude.Trim();
                if (!p.StartsWith("@layer", StringComparison.OrdinalIgnoreCase)) continue;
                var name = p["@layer".Length..].Trim();
                names.Add(name.Length > 0 ? name : "(anonymous " + rule + ")");
            }
            return names.Count == 0 ? null : string.Join(".", names);
        }

        public Cascade(IEnumerable<Sheet> sheets)
        {
            var all = sheets.ToList();
            var ordered = all.Where(IsPlatformSheet).Concat(all.Where(s => !IsPlatformSheet(s) && s.Where != "page")).Concat(all.Where(s => !IsPlatformSheet(s) && s.Where == "page"));
            var order = 0;
            var author = new List<CascadeEntry>();
            var layers = new Dictionary<string, int>(StringComparer.Ordinal);
            int RankOf(string name) => layers.TryGetValue(name, out var rank) ? rank : layers[name] = layers.Count;
            foreach (var sheet in ordered)
            {
                var platform = IsPlatformSheet(sheet);
                HasPlatform |= platform;
                HasOsui |= sheet.Where == OsuiSheet;
                var text = platform ? sheet.Css : WithoutNativeLayout(sheet.Css);
                // the order statements (@layer a, b;) of the sheet name their layers first
                if (text.Contains("@layer", StringComparison.OrdinalIgnoreCase))
                    foreach (Match statement in Regex.Matches(text, @"@layer\s+([\w.\-]+(?:\s*,\s*[\w.\-]+)*)\s*;", RegexOptions.IgnoreCase))
                        foreach (var name in statement.Groups[1].Value.Split(',')) RankOf(name.Trim());
                foreach (var (rule, selector, complex) in SelectorsOf(text))
                {
                    var layerName = LayerOf(rule.EnclosingRules, Id(rule));
                    var entry = new CascadeEntry
                    {
                        Layer = layerName == null ? int.MaxValue : RankOf(layerName), LayerName = layerName,
                        Selector = selector, Complex = complex, Specificity = CssSelectors.Specificity(complex), Media = rule.EnclosingRules,
                        Platform = platform, Sheet = sheet, SheetText = text, Rule = rule, Order = order++,
                        Declarations = rule.Declarations.SelectMany(d => Longhands(d.Property.Trim().ToLowerInvariant(), d.Value.Trim()).Select(l => (l.Longhand, d.Property.Trim().ToLowerInvariant(), l.Value, d.Important))).ToList(),
                    };
                    var key = KeyOf(complex.Parts[^1].Compound);
                    if (!_index.TryGetValue(key, out var bucket)) _index[key] = bucket = [];
                    bucket.Add(entry);
                    if (!platform) author.Add(entry);
                }
            }
            AuthorEntries = author;
        }

        private static string KeyOf(CompoundSelector compound)
        {
            foreach (var s in compound.Items) if (s.Kind == SimpleKind.Id) return "#" + s.Name;
            foreach (var s in compound.Items) if (s.Kind == SimpleKind.Class) return "." + s.Name;
            foreach (var s in compound.Items) if (s.Kind == SimpleKind.Attribute) return "[" + s.Name.ToLowerInvariant();
            foreach (var s in compound.Items) if (s.Kind == SimpleKind.Type) return s.Name.ToLowerInvariant();
            return "*";
        }

        /// <summary>The entries that match an element at a breakpoint, in cascade order (uncached when <paramref name="fresh"/>: the
        /// element was changed to ask what the cascade would be).</summary>
        public List<CascadeEntry> Matched(DomNode element, Viewport viewport, bool fresh = false)
        {
            if (!fresh && _matched.TryGetValue((element, viewport.Name), out var cached)) return cached;
            var keys = new List<string> { "*", element.Tag ?? "" };
            if (element.Attr("id") is { Length: > 0 } id) keys.Add("#" + id);
            foreach (var c in element.Classes) keys.Add("." + c);
            foreach (var (name, _) in element.Attributes) keys.Add("[" + name.ToLowerInvariant());
            var found = new List<CascadeEntry>();
            foreach (var key in keys.Distinct(StringComparer.Ordinal))
                if (_index.TryGetValue(key, out var bucket))
                    foreach (var entry in bucket)
                        if (MediaApplies(entry.Media, viewport) && M(element, entry.Complex)) found.Add(entry);
            found.Sort((x, y) => x.Order.CompareTo(y.Order));
            var distinct = found.Distinct().ToList();
            if (!fresh) _matched[(element, viewport.Name)] = distinct;
            return distinct;
        }

        /// <summary>The declaration that wins a longhand on an element (important first, then specificity, then order).</summary>
        public (CascadeEntry Entry, string Property, string Value, bool Important)? Winner(DomNode element, string longhand, Viewport viewport, Func<CascadeEntry, bool>? only = null, bool fresh = false)
        {
            (CascadeEntry Entry, string Property, string Value, bool Important)? best = null;
            foreach (var entry in Matched(element, viewport, fresh))
            {
                if (only != null && !only(entry)) continue;
                foreach (var d in entry.Declarations)
                {
                    if (d.Longhand != longhand) continue;
                    if (best is not { } b || Beats(entry, d.Important, b.Entry, b.Important)) best = (entry, d.Property, d.Value, d.Important);
                }
            }
            return best;
        }

        public static bool Beats(CascadeEntry entry, bool important, CascadeEntry other, bool otherImportant)
        {
            if (important != otherImportant) return important;
            // F8: layers before specificity; the unlayered win the normal declarations, the earlier layers the !important ones
            var layer = entry.Layer.CompareTo(other.Layer);
            if (layer != 0) return important ? layer < 0 : layer > 0;
            var c = entry.Specificity.CompareTo(other.Specificity);
            return c != 0 ? c > 0 : entry.Order >= other.Order;
        }

        /// <summary>F4: the value a longhand computes to on an element from its winning declaration (var() resolved; inherit, unset,
        /// revert and revert-layer read as the browser does: the parent's value for an inherited property or inherit, the initial
        /// value otherwise; initial is the property's initial value); with no declaration, the parent's for an inherited property,
        /// else the initial value. Lower case, spaces collapsed.</summary>
        public string ValueOf(DomNode element, string longhand, Viewport viewport, (CascadeEntry Entry, string Property, string Value, bool Important)? winner = null, int depth = 0)
        {
            winner ??= Winner(element, longhand, viewport);
            var parent = element.ParentElement;
            string FromParent() => parent != null && depth < 64 ? ValueOf(parent, longhand, viewport, null, depth + 1) : Initial(longhand);
            if (winner is not { } w) return Inherits(longhand) ? FromParent() : Initial(longhand);
            var value = Norm(Resolve(w.Value, element, viewport));
            return value switch
            {
                "inherit" => FromParent(),
                "unset" or "revert" or "revert-layer" => Inherits(longhand) ? FromParent() : Initial(longhand),
                "initial" => Initial(longhand),
                _ => value,
            };
        }

        /// <summary>A value with var() resolved through the custom properties the element and its ancestors inherit.</summary>
        public string Resolve(string value, DomNode element, Viewport viewport)
        {
            for (var guard = 0; guard < 8 && value.Contains("var(", StringComparison.Ordinal); guard++)
            {
                var m = Regex.Match(value, @"var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)");
                if (!m.Success) break;
                string? found = null;
                for (var at = element; at != null && found == null; at = at.ParentElement)
                    found = Winner(at, m.Groups[1].Value, viewport)?.Value;
                found ??= m.Groups[2].Success ? m.Groups[2].Value.Trim() : "";
                value = value[..m.Index] + found + value[(m.Index + m.Length)..];
            }
            return value.Trim();
        }
    }

    /// <summary>A shorthand's longhands with their values (margin, padding, inset by side; flex, overflow, gap, background, the
    /// logical margins), the property itself otherwise.</summary>
    internal static IEnumerable<(string Longhand, string Value)> Longhands(string property, string value)
    {
        string[] Sides(string v)
        {
            var parts = SplitValue(v);
            return parts.Count switch
            {
                1 => [parts[0], parts[0], parts[0], parts[0]],
                2 => [parts[0], parts[1], parts[0], parts[1]],
                3 => [parts[0], parts[1], parts[2], parts[1]],
                >= 4 => [parts[0], parts[1], parts[2], parts[3]],
                _ => [v, v, v, v],
            };
        }
        switch (property)
        {
            case "margin" or "padding":
            {
                var s = Sides(value);
                return [(property + "-top", s[0]), (property + "-right", s[1]), (property + "-bottom", s[2]), (property + "-left", s[3])];
            }
            case "inset":
            {
                var s = Sides(value);
                return [("top", s[0]), ("right", s[1]), ("bottom", s[2]), ("left", s[3])];
            }
            case "margin-inline" or "padding-inline":
            {
                var parts = SplitValue(value);
                var b = property[..property.IndexOf('-')];
                return [(b + "-left", parts.Count > 0 ? parts[0] : value), (b + "-right", parts.Count > 1 ? parts[1] : parts.Count > 0 ? parts[0] : value)];
            }
            case "margin-block" or "padding-block":
            {
                var parts = SplitValue(value);
                var b = property[..property.IndexOf('-')];
                return [(b + "-top", parts.Count > 0 ? parts[0] : value), (b + "-bottom", parts.Count > 1 ? parts[1] : parts.Count > 0 ? parts[0] : value)];
            }
            case "margin-inline-start": return [("margin-left", value)];
            case "margin-inline-end": return [("margin-right", value)];
            case "padding-inline-start": return [("padding-left", value)];
            case "padding-inline-end": return [("padding-right", value)];
            case "flex": return [("flex-grow", value), ("flex-shrink", value), ("flex-basis", value)];
            case "overflow": return [("overflow-x", value), ("overflow-y", value)];
            case "gap" or "grid-gap": return [("row-gap", value), ("column-gap", value)];
            case "background": return [("background-color", value), ("background-image", value)];
            case "word-wrap": return [("overflow-wrap", value)];
            default: return [(property, value)];
        }
    }

    private static List<string> SplitValue(string value)
    {
        var parts = new List<string>();
        var depth = 0; var start = 0;
        for (var i = 0; i <= value.Length; i++)
        {
            if (i < value.Length && value[i] == '(') depth++;
            else if (i < value.Length && value[i] == ')') depth--;
            else if (i == value.Length || char.IsWhiteSpace(value[i]) && depth == 0)
            {
                if (i > start) parts.Add(value[start..i]);
                start = i + 1;
            }
        }
        return parts;
    }

    /// <summary>Whether the at-rules around a rule apply at a breakpoint: @media by its width, orientation and media type (print
    /// never), @supports always, @container never (no container is known), @layer as the rule's own.</summary>
    internal static bool MediaApplies(IReadOnlyList<string> enclosing, Viewport viewport)
    {
        foreach (var prelude in enclosing)
        {
            var p = prelude.Trim();
            if (p.StartsWith("@container", StringComparison.OrdinalIgnoreCase)) return false;
            if (!p.StartsWith("@media", StringComparison.OrdinalIgnoreCase)) continue;
            var queries = p["@media".Length..].Split(',');
            if (!queries.Any(q => QueryApplies(q, viewport))) return false;
        }
        return true;
    }

    private static bool QueryApplies(string query, Viewport viewport)
    {
        var q = query.Trim().ToLowerInvariant();
        var negate = q.StartsWith("not ", StringComparison.Ordinal);
        if (negate) q = q[4..];
        var ok = true;
        if (Regex.IsMatch(q, @"^\s*(only\s+)?print\b")) ok = false;
        foreach (Match m in Regex.Matches(q, @"\(\s*(min|max)-(width|height)\s*:\s*([\d.]+)\s*(px|em|rem)?\s*\)"))
        {
            var n = double.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture) * (m.Groups[4].Value is "em" or "rem" ? 16 : 1);
            var size = m.Groups[2].Value == "width" ? viewport.Width : viewport.Height;
            if (m.Groups[1].Value == "min" ? size < n : size > n) ok = false;
        }
        foreach (Match m in Regex.Matches(q, @"\(\s*orientation\s*:\s*(portrait|landscape)\s*\)"))
            if ((m.Groups[1].Value == "portrait") != (viewport.Height >= viewport.Width)) ok = false;
        return negate ? !ok : ok;
    }

    // ---- the page the runtime serves around the screen ----------------------------------------------------------------------

    /// <summary>The predicted DOM cloned under the page the runtime serves (html &gt; body &gt; #reactContainer &gt;
    /// .screen-container &gt; .active-screen), with the map from each predicted node to its clone. The body's classes are set per
    /// breakpoint (<see cref="SetBody"/>).</summary>
    internal sealed class Page
    {
        public DomNode Html { get; }
        public DomNode Body { get; }
        public Dictionary<DomNode, DomNode> Clones { get; } = new(ReferenceEqualityComparer.Instance);

        public Page(DomNode predicted)
        {
            Html = DomNode.Element("html");
            Body = Html.Add(DomNode.Element("body"));
            var react = Body.Add(DomNode.Element("div")); react.SetAttr("id", CssStylesheet.ReactContainer);
            var container = react.Add(DomNode.Element("div")); container.SetAttr("class", "screen-container");
            var active = container.Add(DomNode.Element("div")); active.SetAttr("class", "active-screen");
            foreach (var child in predicted.IsElement ? new List<DomNode> { predicted } : predicted.Children) active.Add(Clone(child, Clones, null));
        }

        public void SetBody(Viewport viewport) => Body.SetAttr("class", string.Join(" ", viewport.BodyClasses));
    }

    /// <summary>A deep copy of a node (its attributes and the reading's marks), recorded in <paramref name="map"/>; the nodes
    /// <paramref name="skip"/> says are left out (the sentinels, for the author's view of a List).</summary>
    internal static DomNode Clone(DomNode node, Dictionary<DomNode, DomNode> map, Func<DomNode, bool>? skip)
    {
        var copy = node.IsElement ? DomNode.Element(node.Tag!) : node.Text != null ? DomNode.TextNode(node.Text) : DomNode.Fragment();
        if (node.Unevaluable != null) copy.Unevaluable = node.Unevaluable;
        foreach (var a in node.Attributes) copy.Attributes.Add(a);
        copy.K = node.K; copy.Runtime = node.Runtime; copy.RuntimeSelector = node.RuntimeSelector; copy.Widget = node.Widget; copy.Name = node.Name; copy.ObjectKey = node.ObjectKey;
        map[node] = copy;
        foreach (var child in node.Children)
            if (skip == null || !skip(child)) copy.Add(Clone(child, map, skip));
        return copy;
    }

    /// <summary>A sentinel of a List: the &lt;script&gt; the runtime renders first and last among its rows.</summary>
    internal static bool IsSentinel(DomNode node) => node.IsElement && node.Tag is "script" or "template" && node.Runtime == "IList";

    // ---- the families ---------------------------------------------------------------------------------------------------

    /// <summary>The model key a finding names: the element's, else its nearest ancestor's (a runtime element has none).</summary>
    private static string? KeyOf(DomNode element)
    {
        for (var e = element; e != null; e = e.ParentElement) if (e.ObjectKey != null) return e.ObjectKey;
        return null;
    }

    // One rule, whichever of its selectors matched (".tablet .x, .phone .x" is one finding).
    private static int Id(CssRule rule) => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(rule);

    /// <summary>The properties that inherit (the text properties, color and font, visibility, cursor, direction).</summary>
    private static readonly IReadOnlySet<string> InheritedProperties = Set("white-space word-break overflow-wrap word-wrap text-transform letter-spacing word-spacing hyphens "
        + "color font font-family font-size font-style font-weight font-variant line-height text-align text-indent visibility cursor direction quotes list-style list-style-type tab-size");

    internal static bool Inherits(string longhand) => InheritedProperties.Contains(longhand) || longhand.StartsWith("--", StringComparison.Ordinal);

    /// <summary>F7: two values the browser computes alike: equal text, lengths equal in px (0 = 0px, 1rem = 16px) or colors equal
    /// in rgba (#fff = #ffffff = white).</summary>
    internal static bool Same(string a, string b)
    {
        a = Norm(a); b = Norm(b);
        if (a == b) return true;
        if (Length(a) is { } x && Length(b) is { } y) return Math.Abs(x - y) < 0.01;
        if (Color(a) is { } c && Color(b) is { } d) return c == d;
        return false;
    }

    private static readonly Dictionary<string, (int, int, int, double)> NamedColors = new(StringComparer.Ordinal)
    {
        ["black"] = (0, 0, 0, 1), ["white"] = (255, 255, 255, 1), ["red"] = (255, 0, 0, 1), ["green"] = (0, 128, 0, 1), ["blue"] = (0, 0, 255, 1),
        ["gray"] = (128, 128, 128, 1), ["grey"] = (128, 128, 128, 1), ["silver"] = (192, 192, 192, 1), ["yellow"] = (255, 255, 0, 1), ["navy"] = (0, 0, 128, 1),
        ["orange"] = (255, 165, 0, 1), ["purple"] = (128, 0, 128, 1), ["transparent"] = (0, 0, 0, 0),
    };

    /// <summary>A color as (r, g, b, a): #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() with numbers, a few names; null otherwise.</summary>
    internal static (int R, int G, int B, double A)? Color(string value)
    {
        var v = Norm(value);
        if (NamedColors.TryGetValue(v, out var named)) return named;
        var hex = Regex.Match(v, "^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$");
        if (hex.Success)
        {
            var h = hex.Groups[1].Value;
            if (h.Length <= 4) h = string.Concat(h.Select(ch => new string(ch, 2)));
            int Byte(int i) => Convert.ToInt32(h.Substring(i, 2), 16);
            return (Byte(0), Byte(2), Byte(4), h.Length == 8 ? Math.Round(Byte(6) / 255.0, 3) : 1);
        }
        var rgb = Regex.Match(v, @"^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)$");
        if (!rgb.Success) return null;
        var alpha = rgb.Groups[4].Success ? double.Parse(rgb.Groups[4].Value, CultureInfo.InvariantCulture) / (rgb.Groups[5].Value == "%" ? 100 : 1) : 1;
        return (int.Parse(rgb.Groups[1].Value, CultureInfo.InvariantCulture), int.Parse(rgb.Groups[2].Value, CultureInfo.InvariantCulture), int.Parse(rgb.Groups[3].Value, CultureInfo.InvariantCulture), Math.Round(alpha, 3));
    }

    /// <summary>The properties whose computed value is a length in px (getComputedStyle answers px, never auto).</summary>
    private static readonly IReadOnlySet<string> LengthProperties = Set("width height min-width min-height max-width max-height margin-top margin-right margin-bottom margin-left "
        + "padding-top padding-right padding-bottom padding-left top right bottom left font-size row-gap column-gap gap flex-basis border-top-width border-right-width border-bottom-width border-left-width");

    /// <summary>F5: a value in the form getComputedStyle answers it, for a probe's expect: a length in px ("0" → "0px", "1rem" →
    /// "16px"), a color as rgb()/rgba(), a keyword as written; null when the value has no computed form the renderer gives back
    /// (auto, a percentage or an unresolved calc of a length property, a var()).</summary>
    public static string? ComputedForm(string longhand, string? value)
    {
        if (value == null) return null;
        var v = Norm(value);
        if (v.Length == 0 || v.Contains("var(", StringComparison.Ordinal)) return null;
        if (Length(v) is { } px) return px.ToString("0.###", CultureInfo.InvariantCulture) + "px";
        if (LengthProperties.Contains(longhand)) return null;
        if (Color(v) is { } c) return c.A >= 1 ? $"rgb({c.R}, {c.G}, {c.B})" : $"rgba({c.R}, {c.G}, {c.B}, {c.A.ToString("0.###", CultureInfo.InvariantCulture)})";
        return Regex.IsMatch(v, "^[a-z-]+$") && v is not ("inherit" or "initial" or "unset" or "revert" or "revert-layer") ? v : null;
    }

    private static string Norm(string value) => Regex.Replace(value.Trim().ToLowerInvariant(), @"\s+", " ").Replace(" !important", "", StringComparison.Ordinal);

    private static string Initial(string longhand) => longhand switch
    {
        "width" or "height" or "min-width" or "min-height" or "flex-basis" => "auto",
        "max-width" or "max-height" => "none",
        "white-space" or "word-break" or "overflow-wrap" or "letter-spacing" or "word-spacing" => "normal",
        "text-transform" => "none",
        "hyphens" => "manual",
        "position" => "static",
        "left" or "right" or "top" or "bottom" => "auto",
        "transform" => "none",
        "visibility" => "visible",
        "display" => "block",
        _ when longhand.StartsWith("margin", StringComparison.Ordinal) || longhand.StartsWith("padding", StringComparison.Ordinal) => "0",
        _ => "initial",
    };

    /// <summary>The selector with its subject compound raised until it wins over <paramref name="over"/> (an author rule comes
    /// after the platform's sheets: an equal specificity wins): first the runtime's own data-* attribute of the element (the
    /// platform's way to name it), then the subject's own class or attribute again. Null when no such raise exists (an id wins).</summary>
    private static string? Boost(string selector, ComplexSelector complex, DomNode element, (int A, int B, int C) over)
    {
        var subject = complex.Parts[^1].Compound;
        if (CssSelectors.Specificity(complex).A < over.A) return null;
        if (CssSelectors.Specificity(complex).CompareTo(over) >= 0) return selector;
        var pieces = new List<string>();
        if (element.Attributes.FirstOrDefault(a => a.Name.StartsWith("data-", StringComparison.Ordinal) && !a.Name.StartsWith("data-ssam", StringComparison.Ordinal)).Name is { } attribute
            && !selector.Contains("[" + attribute, StringComparison.Ordinal)) pieces.Add("[" + attribute + "]");
        var own = subject.Items.FirstOrDefault(s => s.Kind is SimpleKind.Class or SimpleKind.Attribute);
        var repeat = own != null ? selector[own.Start..own.End]
            : element.Classes.FirstOrDefault(c => !c.Contains('"')) is { } cls ? "." + CssIdent(cls)
            : pieces.FirstOrDefault();
        if (repeat == null) return null;
        // the raise goes before the subject's pseudo-classes (where it reads as a part of the compound)
        var insertAt = subject.Items.FirstOrDefault(s => s.Kind is SimpleKind.PseudoClass)?.Start ?? subject.End;
        var text = selector;
        for (var i = 0; i < 6; i++)
        {
            var piece = i < pieces.Count ? pieces[i] : repeat;
            text = text[..insertAt] + piece + text[insertAt..];
            insertAt += piece.Length;
            if (CssSelectors.Specificity(text).CompareTo(over) >= 0) return text;
        }
        return null;
    }

    private static string? BoostText(string selector, DomNode element, (int A, int B, int C) over)
    {
        try { return Boost(selector, CssSelectors.ParseComplex(selector), element, over); }
        catch (Exception) { return null; }
    }

    private static string CssIdent(string name) => Regex.Replace(name, @"[^A-Za-z0-9_-]", m => "\\" + m.Value);

    /// <summary>The compound of an element as a selector names it: its tag, its classes without quotes and its runtime data-*
    /// attributes (never the engine's data-ssam-*).</summary>
    private static string CompoundOf(DomNode element)
    {
        var sb = new StringBuilder(element.Tag);
        foreach (var c in element.Classes.Where(c => !c.Contains('"') && !c.StartsWith("input-", StringComparison.Ordinal))) sb.Append('.').Append(CssIdent(c));
        foreach (var (name, _) in element.Attributes.Where(a => a.Name.StartsWith("data-", StringComparison.Ordinal) && !a.Name.StartsWith("data-ssam", StringComparison.Ordinal))) sb.Append('[').Append(name).Append(']');
        return sb.ToString();
    }

    /// <summary>(c) The positional selectors of the author that the runtime's List sentinels move: each selector with
    /// :first-child, :last-child, :only-child, :nth-child or :nth-last-child whose matches on the predicted DOM differ from the
    /// author's elements it meant, and match them again once the sentinels are left out. The patch counts the rows only
    /// (<c>:nth-child(1 of :not(script))</c>), checked on the predicted DOM. Needs no platform sheet.</summary>
    internal static List<Finding> PositionalFindings(CheckInput input, IEnumerable<(CssRule Rule, Sheet Sheet, string Text, List<(string Text, ComplexSelector Complex)> Selectors)> rules)
    {
        var findings = new List<Finding>();
        var counterparts = input.Counterparts;
        if (counterparts.Count == 0 || !input.Predicted.Root.Descendants(includeSelf: false).Any(IsSentinel)) return findings;
        var withoutSentinels = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
        Clone(input.Predicted.Root, withoutSentinels, IsSentinel);
        foreach (var (rule, sheet, sheetText, selectors) in rules)
            foreach (var (selector, complex) in selectors)
            {
                var positional = complex.Parts.SelectMany(p => p.Compound.Items).Where(s => s.Kind == SimpleKind.PseudoClass && s.Name is "first-child" or "last-child" or "only-child" or "nth-child" or "nth-last-child" && s.Selectors == null).ToList();
                if (positional.Count == 0) continue;
                var meant = counterparts.Where(p => M(p.Key, complex)).Select(p => p.Value).ToHashSet(ReferenceEqualityComparer.Instance);
                var got = counterparts.Values.Where(p => M(p, complex)).ToHashSet(ReferenceEqualityComparer.Instance);
                if (meant.SetEquals(got)) continue;
                // the sentinels are the cause: without them the selector matches what the author meant
                if (!counterparts.Values.All(p => M(withoutSentinels[p], complex) == meant.Contains(p))) continue;
                var text = selector;
                foreach (var s in positional.OrderByDescending(s => s.Start))
                {
                    var args = (s.Args ?? "").Trim();
                    var rewritten = s.Name switch
                    {
                        "first-child" => ":nth-child(1 of :not(script))",
                        "last-child" => ":nth-last-child(1 of :not(script))",
                        "only-child" => ":nth-child(1 of :not(script)):nth-last-child(1 of :not(script))",
                        _ => ":" + s.Name + "(" + args + " of :not(script))",
                    };
                    text = text[..s.Start] + rewritten + text[s.End..];
                }
                var ok = false;
                try { var patched = CssSelectors.ParseComplex(text); ok = counterparts.Values.All(p => M(p, patched) == meant.Contains(p)); } catch (Exception) { }
                var lost = meant.Except(got).Cast<DomNode>().FirstOrDefault();
                var gained = got.Except(meant).Cast<DomNode>().FirstOrDefault();
                var element = lost ?? gained!;
                // the property a renderer measures (MeasuredProperties), else the rule's first
                var first = rule.Declarations.FirstOrDefault(d => MeasuredProperties.Contains(d.Property.Trim().ToLowerInvariant())) ?? rule.Declarations.FirstOrDefault();
                findings.Add(new Finding(PlatformPositional, input.Root, Line(input, element), selector, ok ? text : null,
                    $"{selector} counts the List's rows with the runtime's sentinels (<script> first and last among them): on the runtime it "
                    + (lost != null ? $"misses {RuntimePath(lost)}" : $"also matches {RuntimePath(gained!)}") + ", which it does not as written", "positional")
                {
                    Sheet = sheet.Where, RuleText = RuleSource(sheetText, rule), Key = KeyOf(element), Property = first?.Property, Expect = first?.Value.Trim(),
                    Winner = "runtime List sentinels <script>", Viewports = Viewports.Select(v => v.Name).ToList(),
                    Candidates = ok ? [] : [text],
                });
            }
        return findings;
    }

    /// <summary>(a), (b), (d), (e): the author's page against the platform's cascade on the predicted DOM, per breakpoint.</summary>
    internal static List<Finding> PlatformFindings(CheckInput input)
    {
        var findings = new List<Finding>();
        var cascade = new Cascade(input.Sheets);
        var page = new Page(input.Predicted.Root);
        // the author's element of each runtime element (by the clone), and the runtime element of each author element
        var authorOf = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
        foreach (var (author, predicted) in input.Counterparts)
            if (page.Clones.TryGetValue(predicted, out var clone)) authorOf[clone] = author;
        var injectedClasses = RuntimeDomTable.Rows(input.Platform).SelectMany(r => r.Classes).Select(c => c.Class).ToHashSet(StringComparer.Ordinal);
        var byKey = new Dictionary<string, Finding>(StringComparer.Ordinal);
        void Add(string key, Finding finding, Viewport viewport)
        {
            if (byKey.TryGetValue(key, out var seen)) { if (!seen.Viewports.Contains(viewport.Name)) seen.Viewports.Add(viewport.Name); return; }
            finding.Viewports.Add(viewport.Name);
            byKey[key] = finding;
            findings.Add(finding);
        }
        var elements = page.Html.Descendants(includeSelf: true).Where(n => n.IsElement).ToList();
        foreach (var viewport in Viewports)
        {
            page.SetBody(viewport);
            foreach (var p in elements)
            {
                var author = authorOf.GetValueOrDefault(p);
                // (a) specificity: each property the author declares on the element, lost to a platform rule
                if (author != null && cascade.HasPlatform)
                {
                    var matched = cascade.Matched(p, viewport);
                    var lost = new Dictionary<(CascadeEntry Author, CascadeEntry Platform), List<(string Property, string Expect)>>();
                    foreach (var longhand in matched.Where(e => !e.Platform).SelectMany(e => e.Declarations.Select(d => d.Longhand)).Where(l => !l.StartsWith("--", StringComparison.Ordinal)).Distinct(StringComparer.Ordinal))
                    {
                        var mine = cascade.Winner(p, longhand, viewport, e => !e.Platform);
                        var best = cascade.Winner(p, longhand, viewport);
                        if (mine is not { } a || best is not { } w || !w.Entry.Platform) continue;
                        if (Same(cascade.ValueOf(p, longhand, viewport, a), cascade.ValueOf(p, longhand, viewport, w))) continue;
                        if (!lost.TryGetValue((a.Entry, w.Entry), out var list)) lost[(a.Entry, w.Entry)] = list = [];
                        if (!list.Any(x => x.Property == a.Property)) list.Add((a.Property, a.Value));
                    }
                    foreach (var ((mine, winner), properties) in lost)
                    {
                        var important = winner.Declarations.Any(d => d.Important && properties.Any(x => Longhands(x.Property, "").Any(l => l.Longhand == d.Longhand)));
                        // F8: a rule in a @layer loses to the platform's unlayered rule whatever its specificity: no raise wins it
                        var byLayer = !important && mine.Layer != winner.Layer;
                        var right = important || byLayer ? null : Boost(mine.Selector, mine.Complex, p, winner.Specificity);
                        var ok = right != null && SafeMatches(p, right);
                        var names = string.Join(", ", properties.Select(x => x.Property));
                        var declared = string.Join(";", properties.Select(x => x.Property + ":" + x.Expect));
                        Add($"a|{mine.Order}|{mine.Selector}|{Id(winner.Rule)}", new Finding(PlatformSpecificity, input.Root, Line(input, author), mine.Selector, ok ? right : null,
                            $"{mine.Selector} {SpecText(mine.Specificity)}{(mine.LayerName != null ? " in @layer " + mine.LayerName : "")} loses {names} to {winner.Named} {SpecText(winner.Specificity)}{(important ? " !important" : "")}{(winner.LayerName == null && byLayer ? " (unlayered)" : "")} on the runtime {RuntimePath(p)}"
                            + (ok ? "; the patch adds the selector that wins beside it" : important ? "; the platform's declaration is !important" : byLayer ? "; a layered rule loses to an unlayered one at any specificity: the candidate is the rule outside the @layer" : ""), "specificity")
                        {
                            Sheet = mine.Sheet.Where, RuleText = RuleSource(mine.SheetText, mine.Rule), AddSelector = true, Key = KeyOf(p), Property = properties[0].Property,
                            Expect = properties[0].Expect, Winner = winner.Named,
                            Candidates = ok ? [] : important ? [mine.Selector + "{" + string.Join(";", properties.Select(x => x.Property + ":" + x.Expect + "!important")) + "}"]
                                : byLayer ? [mine.Selector + "{" + declared + "}"] : [],
                        }, viewport);
                    }
                }
                // (b) inheritance: a text property the author meant on an ancestor, set again by the platform on the text's element
                if (cascade.HasPlatform && p.Children.Any(c => !c.IsElement && c.Text is { } t && t.Trim().Length > 0))
                    foreach (var longhand in InheritedTextProperties)
                    {
                        if (cascade.Winner(p, longhand, viewport) is not { Entry.Platform: true } w) continue;
                        (CascadeEntry Entry, string Property, string Value, bool Important)? meant = null;
                        DomNode? holder = null;
                        foreach (var up in p.Ancestors())
                        {
                            if (cascade.Winner(up, longhand, viewport) is not { } on) continue;
                            if (!on.Entry.Platform) { meant = on; holder = up; }
                            break;
                        }
                        if (meant is not { } m || holder == null) continue;
                        // F4: what each side computes to (inherit, unset, revert of the platform read as the browser does)
                        var meantValue = cascade.ValueOf(holder, longhand, viewport, m);
                        if (Same(meantValue, cascade.ValueOf(p, longhand, viewport, w))) continue;
                        var scope = m.Entry.Selector;
                        var subject = p.RuntimeSelector ?? CompoundOf(p);
                        var right = scope + " " + subject;
                        var boosted = BoostText(right, p, w.Entry.Specificity);
                        var ok = boosted != null && SafeMatches(p, boosted) && !w.Important;
                        var element = authorOf.GetValueOrDefault(p) ?? p.Ancestors().Select(a => authorOf.GetValueOrDefault(a)).FirstOrDefault(a => a != null) ?? p;
                        Add($"b|{m.Entry.Order}|{w.Entry.Order}|{longhand}|{subject}", new Finding(PlatformInherited, input.Root, Line(input, element), m.Entry.Selector, ok ? boosted : null,
                            $"{m.Entry.Selector} sets {m.Property}:{m.Value} for its text, but {w.Entry.Named} sets {w.Property}:{w.Value} on the runtime's {RuntimePath(p)} that holds the text: the text does not inherit the author's value", "inheritance")
                        {
                            Sheet = m.Entry.Sheet.Where, RuleText = RuleSource(m.Entry.SheetText, m.Entry.Rule), Key = KeyOf(p), Property = longhand, Expect = meantValue, Winner = w.Entry.Named,
                            Append = ok ? boosted + "{" + longhand + ":inherit}" : null,
                            Candidates = ok ? [] : [right + "{" + longhand + ":inherit" + (w.Important ? "!important" : "") + "}"],
                        }, viewport);
                    }
                // (d) a width or margin a runtime class gives an item of a flex or grid container
                if (author != null)
                {
                    var injected = p.Classes.Where(c => injectedClasses.Contains(c) && !author.Classes.Contains(c)).ToList();
                    if (injected.Count > 0 && p.ParentElement is { } parent && IsLayoutDisplay(cascade.Winner(parent, "display", viewport)?.Value))
                        foreach (var longhand in InjectedBoxProperties)
                        {
                            if (cascade.Winner(p, longhand, viewport) is not { } w) continue;
                            var classes = w.Entry.Complex.Parts.SelectMany(x => x.Compound.Items).Where(s => s.Kind == SimpleKind.Class).Select(s => s.Name).ToList();
                            var by = injected.FirstOrDefault(classes.Contains);
                            if (by == null) continue;
                            var actual = cascade.ValueOf(p, longhand, viewport, w);
                            // the value without the runtime's classes; the author's own when a rule of the page declares it
                            var saved = p.Attr("class") ?? "";
                            p.SetAttr("class", string.Join(" ", p.Classes.Where(c => !injected.Contains(c))));
                            string expect;
                            string? authored0 = null;
                            try
                            {
                                var without = cascade.Winner(p, longhand, viewport, fresh: true);
                                expect = without is { } wo ? cascade.ValueOf(p, longhand, viewport, wo) : Initial(longhand);
                                if (without is { Entry.Platform: false }) authored0 = expect;
                            }
                            finally { p.SetAttr("class", saved); }
                            if (Same(actual, expect)) continue;
                            var authored = author.Classes.Where(c => !c.Contains('"')).Select(c => "." + CssIdent(c)).ToList();
                            var subject = (authored.Count > 0 ? string.Concat(authored) : p.Tag) + "." + CssIdent(by);
                            var boosted = BoostText(subject, p, w.Entry.Specificity);
                            var ok = boosted != null && SafeMatches(p, boosted) && !w.Important && authored.Count > 0;
                            var holder = cascade.Matched(p, viewport).LastOrDefault(e => !e.Platform);
                            var fix = boosted + "{" + longhand + ":" + expect + "}";
                            Add($"d|{p.GetHashCode()}|{longhand}|{w.Entry.Order}", new Finding(PlatformInjected, input.Root, Line(input, author), CompoundOf(p), ok ? boosted : null,
                                $"the runtime adds .{by} to {RuntimePath(p)}, an item of a flex or grid container: {w.Entry.Named} gives it {longhand}:{actual} (the page alone gives {expect})", "injected")
                            {
                                Sheet = holder?.Sheet.Where, RuleText = holder != null && ok ? RuleSource(holder.SheetText, holder.Rule) : null, Key = KeyOf(p), Property = longhand,
                                // F5: the author's declared value when there is one, else what the runtime class must not give
                                Expect = authored0, ExpectNot = actual, Winner = w.Entry.Named, Append = ok && holder != null ? fix : null, Candidates = ok ? [] : [fix],
                            }, viewport);
                        }
                }
                // (e) a fixed element of the platform's layout: off screen, or covering the content beside it
                if (cascade.HasPlatform && cascade.Winner(p, "position", viewport) is { Entry.Platform: true } fixedBy && Norm(fixedBy.Value) == "fixed"
                    && p.Descendants(includeSelf: false).Any(d => d.IsElement && authorOf.ContainsKey(d) || !d.IsElement && d.Text is { } tx && tx.Trim().Length > 0))
                {
                    var off = OffScreen(cascade, p, viewport);
                    var element = authorOf.GetValueOrDefault(p) ?? p.Descendants(includeSelf: false).Select(d => authorOf.GetValueOrDefault(d)).FirstOrDefault(a => a != null) ?? p;
                    if (off != null)
                    {
                        // F1: the platform moving its menu off screen at a device class is the designed behavior (the menu toggle opens
                        // it): said only when the author lays that element out at this breakpoint, never with a patch that undoes it
                        var lays = cascade.Matched(p, viewport).FirstOrDefault(e => !e.Platform && e.Declarations.Any(d => KeepsOnScreen(d, off.Value.Property, off.Value.Value)));
                        if (lays != null)
                            Add($"e|hidden|{p.GetHashCode()}|{Id(off.Value.Entry.Rule)}", new Finding(PlatformFixedLayout, input.Root, Line(input, element), CompoundOf(p), null,
                                $"at {viewport.Name} {off.Value.Entry.Named} sets {off.Value.Property}:{off.Value.Value} on the fixed {RuntimePath(p)} ({fixedBy.Entry.Named}): its content is off screen until the platform's menu toggle opens it, while {lays.Named} lays it out as always shown (a fact of the theme: keep the menu toggle on the page, or lay the element out per device class)", "hidden")
                            {
                                Key = KeyOf(p), Property = off.Value.Property, ExpectNot = cascade.ValueOf(p, off.Value.Property, viewport, off), Winner = off.Value.Entry.Named,
                            }, viewport);
                    }
                    else if (Covers(cascade, p, viewport) is { } cover)
                    {
                        var covered = authorOf.GetValueOrDefault(cover.Content) ?? cover.Content;
                        var fix = "." + viewport.BodyClasses[0] + " " + CompoundOf(cover.Content) + "{" + cover.Property + ":" + cover.Size + "px}";
                        Add($"e|covers|{p.GetHashCode()}|{cover.Content.GetHashCode()}", new Finding(PlatformFixedLayout, input.Root, Line(input, covered), CompoundOf(cover.Content), null,
                            $"at {viewport.Name} the fixed {RuntimePath(p)} ({fixedBy.Entry.Named}, {cover.Size}px on the {cover.Side}) covers {RuntimePath(cover.Content)}, whose {cover.Property} is {cover.Offset}px (a fact of the theme)", "covers")
                        {
                            // the renderer confirms it by what covers the element at its center (ssam_render's verdict on coveredBy)
                            Key = KeyOf(cover.Content), Property = "coveredBy", Expect = null, Winner = fixedBy.Entry.Named, Candidates = [fix],
                        }, viewport);
                    }
                }
            }
        }
        return findings;
    }

    /// <summary>The declaration that moves a fixed element off screen at a breakpoint (display none, visibility hidden, a negative
    /// translate or offset), null when it shows.</summary>
    private static (CascadeEntry Entry, string Property, string Value, bool Important)? OffScreen(Cascade cascade, DomNode element, Viewport viewport)
    {
        foreach (var property in new[] { "display", "visibility", "transform", "left", "right", "top" })
        {
            if (cascade.Winner(element, property, viewport) is not { Entry.Platform: true } w) continue;
            var value = Norm(cascade.Resolve(w.Value, element, viewport));
            var hidden = property switch
            {
                "display" => value == "none",
                "visibility" => value == "hidden",
                "transform" => Regex.IsMatch(value, @"translate(x|y|3d)?\(\s*-"),
                // a top beyond the viewport's height moves the box below it; a negative one above it
                "top" => Length(value) is { } top && (top < 0 || top >= viewport.Height),
                // a negative offset (left:calc(-1 * var(--side-menu-size)) at tablet) whose size reaches the element's width
                _ => Length(value) is < 0,
            };
            if (hidden) return w;
        }
        return null;
    }

    /// <summary>The content beside a fixed element that it covers: the first sibling with content (not fixed itself) whose offset on
    /// the fixed element's side (its margin and padding and its ancestors' up to the common parent) is under the fixed element's
    /// size. Null when a size or an offset is not a length the cascade gives (a calc, a percentage).</summary>
    private static (DomNode Content, string Side, string Property, double Size, double Offset)? Covers(Cascade cascade, DomNode element, Viewport viewport)
    {
        double? Px(DomNode on, string property)
        {
            var w = cascade.Winner(on, property, viewport);
            if (w == null) return property.StartsWith("margin", StringComparison.Ordinal) || property.StartsWith("padding", StringComparison.Ordinal) ? 0 : null;
            return Length(cascade.Resolve(w.Value.Value, on, viewport));
        }
        string? Value(string property) => cascade.Winner(element, property, viewport) is { } w ? Norm(cascade.Resolve(w.Value, element, viewport)) : null;
        var right = Value("right"); var left = Value("left"); var top = Value("top");
        var side = right is "0" or "0px" && left is null or "auto" ? "right" : top is "0" or "0px" && Value("width") is "100%" ? "top" : "left";
        var size = side == "top" ? Px(element, "height") : Px(element, "width");
        if (size is not > 0) return null;
        var parent = element.ParentElement;
        if (parent == null) return null;
        // F1: only inside the layout the verifier knows (OutSystems UI's .layout with its .main/.content/.main-content beside the
        // menu); any other wrapper (a block instance of another module, an unknown container) may hold the offset: silence
        if (!parent.Ancestors().Prepend(parent).Any(a => a.Classes.Contains("layout"))) return null;
        foreach (var sibling in parent.Children.Where(c => c.IsElement && c != element && !IsSentinel(c) && c.Classes.Overlaps(LayoutContent)))
        {
            if (cascade.Winner(sibling, "position", viewport) is { } sp && Norm(sp.Value) is "fixed" or "absolute") continue;
            if (!sibling.Descendants(includeSelf: false).Any(d => !d.IsElement && d.Text is { } t && t.Trim().Length > 0 || d.IsElement && d.ObjectKey != null)) continue;
            var edge = side == "top" ? "top" : side;
            var offset = 0.0;
            var known = true;
            foreach (var on in new[] { parent, sibling })
            {
                var margin = on == parent ? 0 : Px(on, "margin-" + edge);
                var padding = Px(on, "padding-" + edge);
                if (margin == null || padding == null) { known = false; break; }
                offset += margin.Value + padding.Value;
            }
            if (!known) return null;
            if (offset + 0.5 < size.Value) return (sibling, side, (side == "top" ? "margin-top" : "margin-" + side), size.Value, offset);
            return null;
        }
        return null;
    }

    /// <summary>A length in px (px, rem and em at 16px, a bare 0), null otherwise.</summary>
    internal static double? Length(string value)
    {
        var text = value.Trim().ToLowerInvariant();
        if (text.StartsWith("calc(", StringComparison.Ordinal) && text.EndsWith(')')) return Calc(text[5..^1]);
        var m = Regex.Match(text, @"^(-?[\d.]+)(px|rem|em)?$");
        if (!m.Success) return null;
        if (!double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var n)) return null;
        if (m.Groups[2].Value.Length == 0 && n != 0) return null;
        return m.Groups[2].Value is "rem" or "em" ? n * 16 : n;
    }

    /// <summary>A calc() of lengths and numbers with + - * / and parentheses (no percentage: it needs a box); null otherwise.</summary>
    private static double? Calc(string expression)
    {
        var tokens = Regex.Matches(expression, @"\s*(-?[\d.]+(?:px|rem|em)?|[-+*/()]|calc\()").Select(m => m.Groups[1].Value).ToList();
        if (string.Concat(tokens).Length != Regex.Replace(expression, @"\s+", "").Length) return null;
        var at = 0;
        (double Value, bool Length)? Sum()
        {
            var left = Product();
            while (left != null && at < tokens.Count && tokens[at] is "+" or "-")
            {
                var op = tokens[at++];
                var right = Product();
                if (right == null) return null;
                left = (op == "+" ? left.Value.Value + right.Value.Value : left.Value.Value - right.Value.Value, left.Value.Length || right.Value.Length);
            }
            return left;
        }
        (double Value, bool Length)? Product()
        {
            var left = Atom();
            while (left != null && at < tokens.Count && tokens[at] is "*" or "/")
            {
                var op = tokens[at++];
                var right = Atom();
                if (right == null || op == "/" && right.Value.Value == 0) return null;
                left = (op == "*" ? left.Value.Value * right.Value.Value : left.Value.Value / right.Value.Value, left.Value.Length || right.Value.Length);
            }
            return left;
        }
        (double Value, bool Length)? Atom()
        {
            if (at >= tokens.Count) return null;
            var t = tokens[at++];
            if (t is "(" or "calc(")
            {
                var inner = Sum();
                if (inner == null || at >= tokens.Count || tokens[at++] != ")") return null;
                return inner;
            }
            var m = Regex.Match(t, @"^(-?[\d.]+)(px|rem|em)?$");
            if (!m.Success || !double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var n)) return null;
            return (m.Groups[2].Value is "rem" or "em" ? n * 16 : n, m.Groups[2].Value.Length > 0);
        }
        var result = Sum();
        return result is { } r && at == tokens.Count && (r.Length || r.Value == 0) ? r.Value : null;
    }
}
