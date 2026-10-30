using System.Buffers.Binary;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>The facts of an image file as its bytes state them: the format (png, jpeg, gif, webp, svg, ico, bmp), the width
/// and the height in pixels.</summary>
public sealed record ImageFacts(string Format, int Width, int Height);

/// <summary>
/// R3-B (KERNEL K6, PlatformLimits asset.format): the format, width and height of an image read from its bytes, for every
/// binary asset the job creates (CreateImage, CreateLocalizedImage, SetImageContent: the Create or Set form that takes
/// `ImageFormat format, int width, int height`). The Studio's own reading failed on PNGs sent with binary and originalPath
/// only ("Image format could not be determined: Condition is false", BankDash 2026-10-28, 4 of 4), and the agent fixed it by
/// reading the IHDR by hand. These are facts of the file, so they are filled and listed (IMAGE_FACTS_FROM_BYTES), never a
/// choice: a value the author wrote that the bytes contradict is refused with both (IMAGE_FACTS_MISMATCH), and bytes of no
/// format the lane stores are refused before the build with the formats it stores (IMAGE_FORMAT_UNKNOWN). Pure.
/// <list type="bullet">
/// <item>PNG: the signature and the IHDR chunk (width, height: 32-bit big-endian at 16 and 20).</item>
/// <item>JPEG: SOI, then the segments up to the first SOFn (not DHT C4, JPG C8, DAC CC): height and width 16-bit big-endian.</item>
/// <item>GIF: GIF87a/GIF89a, the logical screen (16-bit little-endian at 6 and 8).</item>
/// <item>WebP: RIFF....WEBP with its first chunk VP8 (the key frame's 14-bit sizes), VP8L (14-bit sizes minus one, packed)
/// or VP8X (the 24-bit canvas sizes minus one).</item>
/// <item>SVG: the root &lt;svg&gt;'s width and height when both are lengths in px (or no unit), else the width and height of
/// its viewBox; an SVG with neither has no size of its own: unknown, refused with the fix (write a viewBox).</item>
/// <item>ICO (the first image of the directory; 0 is 256) and BMP (the DIB header), read so the refusal names them.</item>
/// </list>
/// </summary>
public static class AssetFacts
{
    public const string FactsRule = "IMAGE_FACTS_FROM_BYTES";
    public const string UnknownFormat = "IMAGE_FORMAT_UNKNOWN";
    public const string Mismatch = "IMAGE_FACTS_MISMATCH";

    /// <summary>The facts of the bytes, or null when they are no image this reader knows (or an SVG without a size).</summary>
    public static ImageFacts? FromBytes(byte[]? bytes)
    {
        if (bytes == null || bytes.Length < 4) return null;
        try
        {
            return Png(bytes) ?? Jpeg(bytes) ?? Gif(bytes) ?? WebP(bytes) ?? Ico(bytes) ?? Bmp(bytes) ?? Svg(bytes);
        }
        // Total (review A3): malformed bytes of any kind give no facts, never an exception (the caller refuses with a code).
        catch (Exception) { return null; }
    }

    /// <summary>The format the bytes start like, even when its size cannot be read ("svg" for an SVG without width, height or
    /// viewBox), or null: the refusal says what the file is.</summary>
    public static string? Sniff(byte[]? bytes)
    {
        if (bytes == null || bytes.Length < 4) return null;
        if (FromBytes(bytes) is { } facts) return facts.Format;
        try { return SvgRoot(bytes) != null ? "svg" : null; } catch (Exception) { return null; }
    }

    /// <summary>The value of the lane's ImageFormat enum a format is stored as (O11: Png, Jpg, Gif, Ico, Svg), from the names
    /// <paramref name="values"/> of that enum; null when the lane stores no such format.</summary>
    /// <summary>The one rule of author-declared facts, read by the preflight (PlatformLimitRules.Check, NormalizeImages) and
    /// the create (ModelSession.ImageFactsFromBytes): when format, width and height are all written, the author's facts win
    /// (the Studio stores them as given) and the bytes are not judged: a contradiction is a note (IMAGE_FACTS_DECLARED),
    /// never a refusal. With any of them left out the bytes are judged and fill the rest.</summary>
    public static bool Declared(System.Text.Json.Nodes.JsonObject args) => args.ContainsKey("format") && args.ContainsKey("width") && args.ContainsKey("height");

    public const string DeclaredNote = "IMAGE_FACTS_DECLARED";

    public static string? EnumValue(string format, IEnumerable<string> values)
    {
        var names = values.ToList();
        string[] candidates = format switch
        {
            "jpeg" => ["Jpg", "Jpeg"],
            "png" => ["Png"], "gif" => ["Gif"], "ico" => ["Ico", "Icon"], "svg" => ["Svg"], "webp" => ["WebP", "Webp"], "bmp" => ["Bmp"],
            _ => [],
        };
        return candidates.Select(c => names.FirstOrDefault(n => string.Equals(n, c, StringComparison.OrdinalIgnoreCase))).FirstOrDefault(n => n != null);
    }

    /// <summary>The formats a lane stores, by the lane's ImageFormat enum (IImage.OriginalFormat): the bound Studio's, else for
    /// O11 the catalog's; without the "Unknown" value. Null when neither knows it (an ODC job checked without its Studio).</summary>
    public static IReadOnlyList<string>? Formats(string lane)
    {
        var facts = Preflight.ModelTypes.Of("IImage", lane);
        var values = facts?.Properties.FirstOrDefault(p => p.Name == "OriginalFormat" && p.EnumValues != null)?.EnumValues;
        return values?.Where(v => !v.Equals("Unknown", StringComparison.OrdinalIgnoreCase)).ToList();
    }

    // ---- readers ----------------------------------------------------------------------------------------------------------

    private static ImageFacts? Png(byte[] b)
    {
        ReadOnlySpan<byte> signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        if (b.Length < 24 || !b.AsSpan(0, 8).SequenceEqual(signature) || Encoding.ASCII.GetString(b, 12, 4) != "IHDR") return null;
        return Sized("png", BinaryPrimitives.ReadInt32BigEndian(b.AsSpan(16)), BinaryPrimitives.ReadInt32BigEndian(b.AsSpan(20)));
    }

    private static ImageFacts? Jpeg(byte[] b)
    {
        if (b.Length < 4 || b[0] != 0xFF || b[1] != 0xD8) return null;
        var at = 2;
        while (at + 4 <= b.Length)
        {
            if (b[at] != 0xFF) return null;
            var marker = b[at + 1];
            if (marker == 0xFF) { at++; continue; }   // fill byte
            if (marker is 0xD8 or 0x01 || marker is >= 0xD0 and <= 0xD7) { at += 2; continue; }   // no length
            if (marker is 0xD9 or 0xDA) return null;   // the end, or the scan, before any frame
            var length = BinaryPrimitives.ReadUInt16BigEndian(b.AsSpan(at + 2));
            if (marker is >= 0xC0 and <= 0xCF && marker is not (0xC4 or 0xC8 or 0xCC))
            {
                if (at + 9 > b.Length) return null;
                return Sized("jpeg", BinaryPrimitives.ReadUInt16BigEndian(b.AsSpan(at + 7)), BinaryPrimitives.ReadUInt16BigEndian(b.AsSpan(at + 5)));
            }
            if (length < 2) return null;
            at += 2 + length;
        }
        return null;
    }

    private static ImageFacts? Gif(byte[] b)
    {
        if (b.Length < 10) return null;
        var head = Encoding.ASCII.GetString(b, 0, 6);
        if (head is not ("GIF87a" or "GIF89a")) return null;
        return Sized("gif", BinaryPrimitives.ReadUInt16LittleEndian(b.AsSpan(6)), BinaryPrimitives.ReadUInt16LittleEndian(b.AsSpan(8)));
    }

    private static ImageFacts? WebP(byte[] b)
    {
        if (b.Length < 30 || Encoding.ASCII.GetString(b, 0, 4) != "RIFF" || Encoding.ASCII.GetString(b, 8, 4) != "WEBP") return null;
        switch (Encoding.ASCII.GetString(b, 12, 4))
        {
            case "VP8 ":
                // The key frame: a 3-byte tag, the start code 9D 01 2A, then the 14-bit width and height.
                if (b[23] != 0x9D || b[24] != 0x01 || b[25] != 0x2A) return null;
                return Sized("webp", BinaryPrimitives.ReadUInt16LittleEndian(b.AsSpan(26)) & 0x3FFF, BinaryPrimitives.ReadUInt16LittleEndian(b.AsSpan(28)) & 0x3FFF);
            case "VP8L":
                if (b[20] != 0x2F) return null;
                var bits = BinaryPrimitives.ReadUInt32LittleEndian(b.AsSpan(21));
                return Sized("webp", (int)(bits & 0x3FFF) + 1, (int)((bits >> 14) & 0x3FFF) + 1);
            case "VP8X":
                return Sized("webp", (b[24] | b[25] << 8 | b[26] << 16) + 1, (b[27] | b[28] << 8 | b[29] << 16) + 1);
            default:
                return null;
        }
    }

    private static ImageFacts? Ico(byte[] b)
    {
        if (b.Length < 22 || b[0] != 0 || b[1] != 0 || b[2] != 1 || b[3] != 0 || BinaryPrimitives.ReadUInt16LittleEndian(b.AsSpan(4)) == 0) return null;
        return Sized("ico", b[6] == 0 ? 256 : b[6], b[7] == 0 ? 256 : b[7]);
    }

    private static ImageFacts? Bmp(byte[] b)
    {
        if (b.Length < 26 || b[0] != (byte)'B' || b[1] != (byte)'M') return null;
        // A top-down BMP stores a negative height; int.MinValue has no positive counterpart: bounded in long, then refused.
        long height = BinaryPrimitives.ReadInt32LittleEndian(b.AsSpan(22));
        return Sized("bmp", BinaryPrimitives.ReadInt32LittleEndian(b.AsSpan(18)), height < 0 ? -height : height);
    }

    private static readonly Regex SvgOpen = new(@"<svg\b[^>]*>", RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.Singleline);
    private static readonly Regex Length = new(@"^\s*([0-9]+(?:\.[0-9]+)?)\s*(px)?\s*$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static string? SvgRoot(byte[] b)
    {
        var head = Encoding.UTF8.GetString(b, 0, Math.Min(b.Length, 64 * 1024)).TrimStart('﻿', ' ', '\t', '\r', '\n');
        if (!(head.StartsWith('<'))) return null;
        var open = SvgOpen.Match(head);
        return open.Success ? open.Value : null;
    }

    private static ImageFacts? Svg(byte[] b)
    {
        if (SvgRoot(b) is not { } root) return null;
        static string? Attribute(string tag, string name)
        {
            var m = Regex.Match(tag, @"(?<![\w:-])" + name + @"\s*=\s*(""([^""]*)""|'([^']*)')", RegexOptions.IgnoreCase);
            return m.Success ? (m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value) : null;
        }
        static int? Pixels(string? value) => value != null && Length.Match(value) is { Success: true } m
            && double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) && v > 0 ? (int)Math.Round(v) : null;
        if (Pixels(Attribute(root, "width")) is { } width && Pixels(Attribute(root, "height")) is { } height) return Sized("svg", width, height);
        if (Attribute(root, "viewBox") is { } box)
        {
            var parts = box.Split([' ', ',', '\t', '\r', '\n'], StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 4 && double.TryParse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture, out var w) && double.TryParse(parts[3], NumberStyles.Float, CultureInfo.InvariantCulture, out var h) && w > 0 && h > 0)
                return Sized("svg", (int)Math.Round(w), (int)Math.Round(h));
        }
        return null;
    }

    private static ImageFacts? Sized(string format, long width, long height)
        => width > 0 && height > 0 && width <= int.MaxValue && height <= int.MaxValue ? new ImageFacts(format, (int)width, (int)height) : null;
}
