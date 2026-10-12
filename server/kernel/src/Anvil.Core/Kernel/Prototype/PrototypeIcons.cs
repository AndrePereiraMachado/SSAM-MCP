using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Xml.Linq;

namespace Anvil.Core;

/// <summary>
/// Icon mask classes of the prototype importer (docs/PROTOTIPO-NATIVO.md, 3.5 and 4.1). An icon of the capture (an
/// <c>svg</c> annotated <c>icon:{name, strokeWidth}</c> by the render lane) becomes a <c>span</c> with the original classes plus
/// <c>ssam-icon</c> and one mask class per name and stroke: <c>ssam-icon-&lt;name&gt;</c> when the stroke is
/// <c>icons.defaultStrokeWidth</c>, else <c>ssam-icon-&lt;name&gt;-w&lt;strokeWidth×100&gt;</c> (FarmaVirtual:
/// <c>ssam-icon-plus-w300</c> on the brand mark). The compile lane writes the class with <see cref="ClassName"/>, this lane writes
/// the rule; the two derive the name by the same rule. Width, height, color, vertical-align and flex-shrink keep coming from
/// the prototype's own rules (<c>.icon</c>, <c>.brand-mark .icon</c>…), because the span keeps the svg's classes.
/// </summary>
public static class PrototypeIcons
{
    public sealed record IconUse(string Name, double StrokeWidth);

    /// <summary>The mask class of an icon (3.5).</summary>
    public static string ClassName(string name, double strokeWidth, double defaultStrokeWidth) =>
        Math.Abs(strokeWidth - defaultStrokeWidth) < 1e-9 ? "ssam-icon-" + name
            : "ssam-icon-" + name + "-w" + ((int)Math.Round(strokeWidth * 100, MidpointRounding.AwayFromZero)).ToString(CultureInfo.InvariantCulture);

    /// <summary>The key of <see cref="PrototypeCssResult.IconClasses"/>: the name for the default stroke, name@stroke otherwise.</summary>
    public static string Key(string name, double strokeWidth, double defaultStrokeWidth) =>
        Math.Abs(strokeWidth - defaultStrokeWidth) < 1e-9 ? name : name + "@" + strokeWidth.ToString("0.###", CultureInfo.InvariantCulture);

    public static double DefaultStrokeWidth(JsonObject capture) =>
        Number(capture["icons"]?["defaultStrokeWidth"]) ?? 2;

    /// <summary>Every distinct (name, stroke) of the icons annotated in the capture (shell, views, modals and the explored trees),
    /// ordered by name and stroke so the stylesheet does not depend on the walk.</summary>
    public static IReadOnlyList<IconUse> Uses(JsonObject capture)
    {
        var fallback = DefaultStrokeWidth(capture);
        var found = new HashSet<(string, double)>();
        foreach (var node in PrototypeCss.CaptureNodes(capture))
        {
            if (node["icon"] is not JsonObject icon || icon["name"]?.ToString() is not { Length: > 0 } name) continue;
            found.Add((name, Number(icon["strokeWidth"]) ?? fallback));
        }
        return found.OrderBy(x => x.Item1, StringComparer.Ordinal).ThenBy(x => x.Item2).Select(x => new IconUse(x.Item1, x.Item2)).ToList();
    }

    /// <summary>The icons block (one rule per class) and the classes by key; names missing from <c>icons.set</c> are listed.</summary>
    public static (string Css, IReadOnlyDictionary<string, string> Classes, IReadOnlyList<string> Missing) Masks(JsonObject capture)
    {
        var fallback = DefaultStrokeWidth(capture);
        var set = capture["icons"]?["set"] as JsonObject;
        var css = new StringBuilder();
        var classes = new Dictionary<string, string>(StringComparer.Ordinal);
        var missing = new List<string>();
        foreach (var use in Uses(capture))
        {
            var className = ClassName(use.Name, use.StrokeWidth, fallback);
            classes[Key(use.Name, use.StrokeWidth, fallback)] = className;
            var svg = set?[use.Name] is JsonObject entry ? entry["svg"]?.ToString() : set?[use.Name]?.ToString();
            if (string.IsNullOrEmpty(svg)) { missing.Add(use.Name); continue; }
            var data = "data:image/svg+xml," + PercentEncode(MaskSvg(svg, use.StrokeWidth, set?[use.Name]?["viewBox"]?.ToString()));
            css.Append('.').Append(className).Append("{display:inline-block;background-color:currentColor;")
               .Append("-webkit-mask:url(\"").Append(data).Append("\") center/contain no-repeat;")
               .Append("mask:url(\"").Append(data).Append("\") center/contain no-repeat}\n");
        }
        return (css.ToString(), classes, missing);
    }

    /// <summary>The icon's SVG as a mask image: the root keeps its geometry and paints with the stroke of the instance; the
    /// attributes that only mattered inline (class, aria-*, data-*) go away. The color is irrelevant: the mask reads alpha.</summary>
    public static string MaskSvg(string svg, double strokeWidth, string? viewBox = null)
    {
        var stroke = strokeWidth.ToString("0.###", CultureInfo.InvariantCulture);
        XElement root;
        try { root = XElement.Parse(svg.Contains("xmlns", StringComparison.Ordinal) ? svg : svg.Replace("<svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"", StringComparison.Ordinal)); }
        catch (System.Xml.XmlException)
        {
            // Not well-formed XML (an HTML serialization): set the attribute by text on the root tag only.
            var end = svg.IndexOf('>');
            if (end < 0) return svg;
            var head = System.Text.RegularExpressions.Regex.Replace(svg[..end], @"\sstroke-width=""[^""]*""", "");
            return head + " stroke-width=\"" + stroke + "\"" + svg[end..];
        }
        XNamespace ns = "http://www.w3.org/2000/svg";
        foreach (var attribute in root.Attributes().ToList())
        {
            var name = attribute.Name.LocalName;
            if (name == "class" || name.StartsWith("aria-", StringComparison.Ordinal) || name.StartsWith("data-", StringComparison.Ordinal)) attribute.Remove();
        }
        root.SetAttributeValue("stroke-width", stroke);
        if (root.Attribute("viewBox") == null && viewBox != null) root.SetAttributeValue("viewBox", viewBox);
        if (root.Attribute("fill") == null) root.SetAttributeValue("fill", "none");
        if (root.Attribute("stroke") == null) root.SetAttributeValue("stroke", "#000");
        return root.ToString(SaveOptions.DisableFormatting | SaveOptions.OmitDuplicateNamespaces);
    }

    /// <summary>Percent-encoding for a data: URL inside url("…"): unreserved and a few safe delimiters stay, every other byte
    /// of the UTF-8 text (quotes, &lt;, &gt;, #, %, spaces, non-ASCII) is %XX.</summary>
    public static string PercentEncode(string text)
    {
        var sb = new StringBuilder(text.Length * 2);
        foreach (var b in Encoding.UTF8.GetBytes(text))
        {
            var c = (char)b;
            if (b < 0x80 && (char.IsAsciiLetterOrDigit(c) || "-._~!$&'()*+,;=:@/?".IndexOf(c) >= 0)) sb.Append(c);
            else sb.Append('%').Append(b.ToString("X2", CultureInfo.InvariantCulture));
        }
        return sb.ToString();
    }

    private static double? Number(JsonNode? node)
    {
        if (node is not JsonValue value) return null;
        if (value.TryGetValue<double>(out var d)) return d;
        if (value.TryGetValue<string>(out var s) && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return d;
        return null;
    }
}
