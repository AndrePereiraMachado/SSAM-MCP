using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// R2-D, item 4: a base64 data: image inside the CSS of an html op (data.css, the page's &lt;style&gt;) becomes an image of the
/// module, and the CSS names it by its URL: the Studio warns once per data: URL (InvalidResourceURL_Offline: 92 warnings in one
/// session) and the sheet carries the bytes in its text. Only a url the CSS uses: one in a comment or in a string (content:
/// "...") is text and stays. One image per distinct content, named after its owner and its
/// content (<c>&lt;Owner&gt;Image&lt;8 hex of its sha256&gt;</c>), so the same sheet sent again reuses it; each one is said in the
/// op's styleSheet (images). Never converted, said in imagesKept: a percent-encoded or UTF-8 data: URL (the kernel's own icon
/// masks are written so), a type the module images do not take (only png, jpg, gif and svg), bytes that are not their type,
/// and every data: image on the ODC lane, whose module image URL form is not confirmed yet (PrototypeCss.AssetUrls).
/// </summary>
public static class CssDataUrls
{
    public const string Note = "CSS_DATA_URL_IMAGE";

    /// <summary>One base64 data: image in a CSS text: the whole url(...) token, where it is, its media type and its bytes.</summary>
    public sealed record Found(int Start, int Length, string Token, string Mime, byte[]? Bytes);

    /// <summary>What a data: image becomes: the module image's name, extension and create args, or why it stays.</summary>
    public sealed record Image(string Name, string Extension, JsonObject Args, string? Kept);

    private static readonly Regex DataImage = new(@"url\(\s*(?<q>['""]?)data:(?<mime>image/[A-Za-z0-9.+-]+)(?<params>(?:;[A-Za-z0-9=._-]+)*);base64,(?<data>[A-Za-z0-9+/=\s]*)\k<q>\s*\)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>Every base64 data: image the CSS uses, in order: a url(data:...) token outside comments and strings (one inside
    /// a comment styles nothing; one inside a string, as in content:"...", is text, not a url).</summary>
    public static List<Found> Find(string css)
    {
        var found = new List<Found>();
        if (string.IsNullOrEmpty(css) || css.IndexOf("data:", StringComparison.OrdinalIgnoreCase) < 0) return found;
        var text = TextSpans(css);
        foreach (Match m in DataImage.Matches(css))
        {
            if (text.Any(s => m.Index >= s.Start && m.Index < s.End)) continue;
            byte[]? bytes = null;
            try { bytes = Convert.FromBase64String(Regex.Replace(m.Groups["data"].Value, @"\s+", "")); } catch (FormatException) { }
            found.Add(new Found(m.Index, m.Length, m.Value, m.Groups["mime"].Value.ToLowerInvariant(), bytes));
        }
        return found;
    }

    /// <summary>The module image a data: image becomes (pure): its name after <paramref name="owner"/> and its content, the
    /// extension the URL takes and the args of its create (format, width and height of a raster, read from its bytes).</summary>
    public static Image Describe(Found found, string owner)
    {
        var name = Owner(owner) + "Image" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(found.Bytes ?? [])).ToLowerInvariant()[..8];
        if (found.Bytes is not { Length: > 0 } bytes) return new(name, "", [], "its base64 text does not decode");
        var (extension, format, size) = found.Mime switch
        {
            "image/png" => ("png", "Png", Png(bytes)),
            "image/jpeg" or "image/jpg" or "image/pjpeg" => ("jpg", "Jpg", Jpeg(bytes)),
            "image/gif" => ("gif", "Gif", Gif(bytes)),
            "image/svg+xml" => ("svg", null, Svg(bytes) ? (0, 0) : ((int, int)?)null),
            _ => ("", null, null),
        };
        if (extension.Length == 0) return new(name, "", [], found.Mime + " is not a type of the module images (png, jpg, gif, svg)");
        if (size == null) return new(name, extension, [], "its bytes are not a " + extension + " image");
        var args = new JsonObject { ["binary"] = Convert.ToBase64String(bytes), ["originalPath"] = name + "." + extension };
        if (format != null) { args["format"] = format; args["width"] = size.Value.Item1; args["height"] = size.Value.Item2; }
        return new(name, extension, args, null);
    }

    /// <summary>The text with each data: token replaced by url("<paramref name="urls"/>[token]") (the ones it names).</summary>
    public static string Rewrite(string css, IReadOnlyList<Found> found, IReadOnlyDictionary<string, string> urls)
    {
        var text = new System.Text.StringBuilder(css);
        foreach (var f in found.OrderByDescending(f => f.Start))
            if (urls.TryGetValue(f.Token, out var url)) text.Remove(f.Start, f.Length).Insert(f.Start, "url(\"" + url + "\")");
        return text.ToString();
    }

    // The spans of the comments and of the strings that are text (a string that is the argument of url( is the url): what Find
    // never reads as a url.
    private static List<(int Start, int End)> TextSpans(string css)
    {
        var spans = new List<(int, int)>();
        for (var i = 0; i < css.Length; i++)
        {
            var c = css[i];
            if (c == '\\') { i++; continue; }
            if (c == '/' && i + 1 < css.Length && css[i + 1] == '*')
            {
                var end = css.IndexOf("*/", i + 2, StringComparison.Ordinal);
                var stop = end < 0 ? css.Length : end + 2;
                spans.Add((i, stop));
                i = stop - 1;
                continue;
            }
            if (c is not ('"' or '\'')) continue;
            var start = i;
            for (i++; i < css.Length && css[i] != c && css[i] != '\n'; i++) if (css[i] == '\\') i++;
            var j = start - 1;
            while (j >= 0 && char.IsWhiteSpace(css[j])) j--;
            if (!(j >= 3 && string.Compare(css, j - 3, "url(", 0, 4, StringComparison.OrdinalIgnoreCase) == 0)) spans.Add((start, Math.Min(i + 1, css.Length)));
        }
        return spans;
    }

    // The owner's name as the start of an image name: letters, digits and underscores, starting with a letter.
    private static string Owner(string owner)
    {
        var name = new string((owner ?? "").Where(c => char.IsAsciiLetterOrDigit(c) || c == '_').ToArray());
        return name.Length == 0 || !char.IsAsciiLetter(name[0]) ? "Css" + name : name;
    }

    private static (int, int)? Png(byte[] b) =>
        b.Length >= 24 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47 && b[12] == (byte)'I' && b[13] == (byte)'H' && b[14] == (byte)'D' && b[15] == (byte)'R'
            ? (BigEndian(b, 16), BigEndian(b, 20)) : null;

    private static (int, int)? Gif(byte[] b) =>
        b.Length >= 10 && b[0] == (byte)'G' && b[1] == (byte)'I' && b[2] == (byte)'F' ? (b[6] | b[7] << 8, b[8] | b[9] << 8) : null;

    // The frame size of a JPEG: the first SOFn marker (not DHT, JPG or DAC).
    private static (int, int)? Jpeg(byte[] b)
    {
        if (b.Length < 4 || b[0] != 0xFF || b[1] != 0xD8) return null;
        var i = 2;
        while (i + 9 < b.Length)
        {
            if (b[i] != 0xFF) { i++; continue; }
            var marker = b[i + 1];
            if (marker == 0xFF) { i++; continue; }
            if (marker is 0xD8 or 0x01 || marker is >= 0xD0 and <= 0xD7) { i += 2; continue; }
            var length = b[i + 2] << 8 | b[i + 3];
            if (marker is >= 0xC0 and <= 0xCF && marker is not (0xC4 or 0xC8 or 0xCC))
                return (b[i + 7] << 8 | b[i + 8], b[i + 5] << 8 | b[i + 6]);
            if (length < 2) return null;
            i += 2 + length;
        }
        return null;
    }

    private static bool Svg(byte[] b)
    {
        var head = System.Text.Encoding.UTF8.GetString(b, 0, Math.Min(b.Length, 4096));
        return head.Contains("<svg", StringComparison.OrdinalIgnoreCase);
    }

    private static int BigEndian(byte[] b, int at) => b[at] << 24 | b[at + 1] << 16 | b[at + 2] << 8 | b[at + 3];
}

public sealed partial class ModelSession
{
    /// <summary>R2-D: the base64 data: images of a CSS text the html op writes as the own sheet of <paramref name="owner"/>,
    /// made images of this module (created once per content, reused when the module has it) and named by their URL
    /// (/&lt;Module&gt;/img/&lt;Module&gt;.&lt;Image&gt;.&lt;ext&gt;, the published form the module's own CSS uses); what stays a data: URL
    /// and why. Said in <paramref name="said"/> (images, imagesKept). The text itself when it has none.</summary>
    internal string CssDataImages(string css, string owner, JsonObject said)
    {
        var found = CssDataUrls.Find(css);
        if (found.Count == 0) return css;
        var images = new JsonArray();
        var kept = new JsonArray();
        var urls = new Dictionary<string, string>(StringComparer.Ordinal);
        var module = TypeResolver.Name(_es) ?? "";
        foreach (var data in found)
        {
            if (urls.ContainsKey(data.Token)) continue;
            var image = CssDataUrls.Describe(data, owner);
            var why = MessageExpectations.Lane == "odc" ? "the ODC lane: the URL form of a module image is not confirmed yet, so the data: URL stays as written" : image.Kept;
            if (why != null)
            {
                if (kept.Count < 20) kept.Add(new JsonObject { ["mime"] = data.Mime, ["chars"] = data.Token.Length, ["why"] = why });
                continue;
            }
            var exists = Descendants().Any(d => Implements(d, "IImage") && string.Equals(TypeResolver.Name(d), image.Name, StringComparison.OrdinalIgnoreCase));
            if (!exists) ApplyOne(new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IImage", ["name"] = image.Name, ["args"] = image.Args });
            var url = "/" + module + "/img/" + module + "." + image.Name + "." + image.Extension;
            urls[data.Token] = url;
            images.Add(new JsonObject { ["image"] = image.Name, ["url"] = url, ["mime"] = data.Mime, ["bytes"] = data.Bytes?.Length ?? 0, ["created"] = !exists });
        }
        if (images.Count > 0)
        {
            said["images"] = images;
            Note(CssDataUrls.Note, $"{owner}: {images.Count} base64 data: image(s) of its CSS became module images named by their URL ({string.Join(", ", images.Take(4).Select(i => i!["image"]))}{(images.Count > 4 ? ", ..." : "")}): the Studio warned once per data: URL and the sheet carried the bytes");
        }
        if (kept.Count > 0) said["imagesKept"] = kept;
        return urls.Count == 0 ? css : CssDataUrls.Rewrite(css, found, urls);
    }
}
