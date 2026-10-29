using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

// screen.render: the checks of a request (ssam-render-request/1) and of the worker's facts (ssam-render-facts/1), the rules,
// limits, codes and texts of agent/lib/render-request.mjs. White space is the JavaScript set (WS below) on both sides, so
// both implementations read the same document the same way.
internal static class RenderRequest
{
    internal const string Kind = "screen.render";
    internal const string RequestSchema = "ssam-render-request/1";
    internal const string FactsSchema = "ssam-render-facts/1";
    internal const int Protocol = 1;
    private const int MiB = 1024 * 1024;
    internal const int Documents = 8, HtmlBytes = 4 * MiB, Styles = 16, CssBytes = 2 * MiB, PackageBytes = 12 * MiB, Viewports = 3, MinWidth = 320, MaxWidth = 2560,
        MinHeight = 480, MaxHeight = 4096, BodyClasses = 8, Keys = 400, Properties = 24, MaxElements = 3000, DefaultMaxElements = 1500, MinQuality = 40, MaxQuality = 90,
        MinEdge = 320, MaxEdge = 1920, MinTimeoutMs = 5000, MaxTimeoutMs = 90000, DefaultTimeoutMs = 60000, Images = 9, ImageBytes = MiB, ValueBytes = 12 * MiB,
        StyleText = 200, Fonts = 50, FontName = 100, Errors = 50;
    internal static readonly string[] AllowedProperties = ["display", "position", "visibility", "opacity", "white-space", "overflow", "overflow-x", "overflow-y",
        "width", "height", "min-width", "max-width", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right",
        "padding-bottom", "padding-left", "font-size", "font-family", "line-height", "text-overflow", "z-index", "flex-direction", "flex-wrap", "flex-grow",
        "flex-shrink", "flex-basis", "justify-content", "align-items", "gap", "grid-template-columns", "box-sizing", "top", "left", "color",
        "background-color", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width"];
    private static readonly string[] ErrorCodes = ["LOAD_FAILED", "MEASURE_FAILED", "RENDER_TIMEOUT", "IMAGE_FAILED"];
    private const string WS = @"[\t\n\v\f\r    -     　﻿]";
    private const RegexOptions I = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
    private static readonly Regex Id = new("^[a-z0-9-]{1,40}$", RegexOptions.CultureInvariant);
    private static readonly Regex KeyPattern = new("^[A-Za-z0-9_-]{1,80}$", RegexOptions.CultureInvariant);
    private static readonly Regex ClassPattern = new("^[A-Za-z_-][A-Za-z0-9_-]{0,63}$", RegexOptions.CultureInvariant);
    private static readonly Regex TagPattern = new("^[a-z][a-z0-9-]{0,40}$", RegexOptions.CultureInvariant);
    private static readonly Regex Sha = new("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> UrlAttributes = ["href", "src", "srcset", "imagesrcset", "action", "formaction", "poster", "background", "data", "cite", "longdesc", "usemap",
        "manifest", "ping", "xlink:href", "lowsrc", "dynsrc", "codebase", "icon", "profile"];
    private static readonly Regex ForbiddenUrl = new(@"^(?:https?:|file:|ftp:|//|\\\\)", I);
    private static readonly Regex ForbiddenTag = new("<(?:script|iframe|frame|object|embed|link|base)", I);
    private static readonly Regex MetaRefresh = new("<meta[^>]*http-equiv", I);
    private static readonly Regex SrcDoc = new("srcdoc" + WS + "*=", I);
    private static readonly Regex ScriptUrl = new("javascript:|vbscript:", I);
    private static readonly Regex StyleElement = new(@"<style\b[^>]*>([\s\S]*?)(?:</style" + WS + "*>|$)", I);
    private static readonly Regex OnAttribute = new("^on[a-z]+$", RegexOptions.CultureInvariant);
    private static readonly Regex Spaces = new(WS + "+", RegexOptions.CultureInvariant);

    private static AgentFault Invalid(string message) => new("RENDER_REQUEST_INVALID", message);
    private static AgentFault Refused(string message) => new("RENDER_DOCUMENT_REFUSED", message);
    private static AgentFault Failed(string message) => new("RENDER_FAILED", "The render worker returned an invalid result: " + message);
    internal static string Sha256(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    private static bool JsSpace(char c) => (char.IsWhiteSpace(c) && c != '\u0085') || c == '﻿';
    private static string JsTrim(string text) { var start = 0; var end = text.Length; while (start < end && JsSpace(text[start])) start++; while (end > start && JsSpace(text[end - 1])) end--; return text[start..end]; }
    private static string Quote(string key) { var text = JsonValue.Create(key).ToJsonString(); return text.Length > 60 ? text[..60] : text; }

    private static JsonObject Only(JsonNode? node, string[] keys, string where)
    {
        if (node is not JsonObject value) throw Invalid($"{where} must be an object");
        foreach (var pair in value) if (!keys.Contains(pair.Key)) throw Invalid($"{where} has an unknown field {Quote(pair.Key)}");
        return value;
    }
    private static bool Int(JsonNode? node, long min, long max, out long value)
    {
        value = 0;
        return node is JsonValue v && v.GetValueKind() == System.Text.Json.JsonValueKind.Number && v.TryGetValue(out value) && value >= min && value <= max;
    }
    private static string? Text(JsonNode? node) => node is JsonValue v && v.GetValueKind() == System.Text.Json.JsonValueKind.String ? v.GetValue<string>() : null;
    private static bool Missing(JsonObject o, string key) => !o.ContainsKey(key) || o[key] == null;

    // ---- CSS read as tokens (CSS Syntax 3), the reader of agent/lib/render-request.mjs cssTargets: comments skipped,
    // strings and identifiers with escapes decoded before they are compared, ASCII case ignored; targets are the body of an
    // unquoted url(), strings inside the image functions, strings and urls of an @import prelude, and strings and
    // identifiers in a custom property value.
    private static readonly HashSet<string> ImageFunctions = ["url", "src", "image-set", "-webkit-image-set", "image", "-webkit-image", "cross-fade", "-webkit-cross-fade", "element", "-moz-element"];
    private static bool CssSpace(char c) => c is ' ' or '\t' or '\n' or '\r' or '\f';
    private static bool CssSpaceAt(string s, int i) => i < s.Length && CssSpace(s[i]);
    private static string AsciiLower(string s) => string.Concat(s.Select(c => c is >= 'A' and <= 'Z' ? (char)(c + 32) : c));
    private static string CssTrim(string s) { int a = 0, b = s.Length; while (a < b && CssSpace(s[a])) a++; while (b > a && CssSpace(s[b - 1])) b--; return s[a..b]; }
    private static bool IsHex(string s, int i) => i < s.Length && char.IsAsciiHexDigit(s[i]);
    private static bool IdentStart(string s, int i) => i < s.Length && (char.IsAsciiLetter(s[i]) || s[i] is '_' or '-' || s[i] >= 0x80);
    private static bool IdentChar(string s, int i) => i < s.Length && (char.IsAsciiLetterOrDigit(s[i]) || s[i] is '_' or '-' || s[i] >= 0x80);
    private static bool ValidEscape(string s, int i) => i + 1 < s.Length && s[i] == '\\' && s[i + 1] is not ('\n' or '\r' or '\f');
    private static (string Text, int Next) ReadEscape(string s, int i)
    {
        var j = i + 1;
        if (IsHex(s, j))
        {
            var start = j;
            while (j - start < 6 && IsHex(s, j)) j++;
            var code = int.Parse(s[start..j], System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture);
            if (j + 1 < s.Length && s[j] == '\r' && s[j + 1] == '\n') j += 2; else if (CssSpaceAt(s, j)) j++;
            return (code == 0 || code > 0x10FFFF || code is >= 0xD800 and <= 0xDFFF ? "\uFFFD" : char.ConvertFromUtf32(code), j);
        }
        if (j >= s.Length) return ("\uFFFD", j);
        var width = char.IsHighSurrogate(s[j]) && j + 1 < s.Length && char.IsLowSurrogate(s[j + 1]) ? 2 : 1;
        return (s.Substring(j, width), j + width);
    }
    private static readonly HashSet<string> TextFunctions = ["attr", "counter", "counters"];
    // Every declaration by its grammatical shape at any depth and in any block: an item that starts with an identifier and
    // ':' is a declaration up to ';' or '}'; ended by '{' it was a selector and its strings are dropped (render-request.mjs
    // cssTargets has the full rule).
    internal static List<(string Value, bool Url)> CssTargets(string css, bool declarations = false)
    {
        _ = declarations;
        var targets = new List<(string, bool)>();
        var pending = new List<(string, bool)>();
        var stack = new List<string>();
        var mode = "start"; var property = ""; string? at = null;
        bool InImage() => stack.Any(ImageFunctions.Contains);
        bool InText() => stack.Any(TextFunctions.Contains);
        void End(bool commit) { if (commit && mode == "value") targets.AddRange(pending); pending.Clear(); mode = "start"; property = ""; at = null; }
        void Consider(string value, bool isUrl)
        {
            if (at == "import") { targets.Add((value, true)); return; }
            if (mode != "value") return;
            if (InImage() || isUrl) { pending.Add((value, true)); return; }
            if (InText()) return;
            if (property is "content" or "quotes" && stack.Count == 0) return;
            pending.Add((value, false));
        }
        void Other() { if (stack.Count == 0 && mode is "start" or "ident") mode = "other"; }
        (string, int) ReadName(int start)
        {
            var name = new StringBuilder(); var i = start;
            while (i < css.Length)
            {
                if (IdentChar(css, i)) { name.Append(css[i++]); continue; }
                if (ValidEscape(css, i)) { var (text, next) = ReadEscape(css, i); name.Append(text); i = next; continue; }
                break;
            }
            return (name.ToString(), i);
        }
        var i = 0;
        while (i < css.Length)
        {
            var c = css[i];
            if (c == '/' && i + 1 < css.Length && css[i + 1] == '*') { var close = css.IndexOf("*/", i + 2, StringComparison.Ordinal); i = close < 0 ? css.Length : close + 2; continue; }
            if (c is '"' or '\'')
            {
                var value = new StringBuilder(); var j = i + 1;
                while (j < css.Length && css[j] != c)
                {
                    if (css[j] is '\n' or '\r' or '\f') break;
                    if (css[j] == '\\')
                    {
                        if (j + 1 >= css.Length) { j++; continue; }
                        if (css[j + 1] is '\n' or '\f') { j += 2; continue; }
                        if (css[j + 1] == '\r') { j += j + 2 < css.Length && css[j + 2] == '\n' ? 3 : 2; continue; }
                        var (text, next) = ReadEscape(css, j); value.Append(text); j = next; continue;
                    }
                    value.Append(css[j++]);
                }
                i = j < css.Length && css[j] == c ? j + 1 : j;
                Consider(value.ToString(), false);
                Other();
                continue;
            }
            if (c == '@')
            {
                var (name, next) = ReadName(i + 1);
                if (name.Length > 0) { if (stack.Count == 0 && mode == "start") { at = AsciiLower(name); mode = "other"; } else Other(); i = next; continue; }
            }
            if (IdentStart(css, i) || ValidEscape(css, i) || c == '-' && (IdentStart(css, i + 1) || ValidEscape(css, i + 1)))
            {
                var (name, next) = ReadName(i);
                if (name.Length > 0 && next > i)
                {
                    i = next;
                    if (i < css.Length && css[i] == '(')
                    {
                        var lower = AsciiLower(name); i++;
                        Other();
                        if (lower == "url")
                        {
                            var j = i; while (CssSpaceAt(css, j)) j++;
                            if (j >= css.Length || css[j] is not ('"' or '\''))
                            {
                                var value = new StringBuilder();
                                while (j < css.Length && css[j] != ')')
                                {
                                    if (ValidEscape(css, j)) { var (text, next2) = ReadEscape(css, j); value.Append(text); j = next2; }
                                    else value.Append(css[j++]);
                                }
                                i = j < css.Length ? j + 1 : j;
                                if (at != "namespace") Consider(CssTrim(value.ToString()), true);
                                continue;
                            }
                        }
                        stack.Add(lower);
                        continue;
                    }
                    if (stack.Count == 0 && mode == "start") { mode = "ident"; property = AsciiLower(name); } else Other();
                    continue;
                }
            }
            if (c == '(') { Other(); stack.Add(""); }
            else if (c == ')') { if (stack.Count > 0) stack.RemoveAt(stack.Count - 1); }
            else if (stack.Count == 0)
            {
                if (c == ':' && mode == "ident") mode = "value";
                else if (c is ';' or '}') End(true);
                else if (c == '{') End(false);
                else if (!CssSpace(c)) Other();
            }
            i++;
        }
        End(true);
        return targets;
    }    private static readonly Regex Outside = new("^(?:https?|file|ftp):", I);
    private static readonly Regex Scheme = new("^[A-Za-z][A-Za-z0-9+.-]*:", RegexOptions.CultureInvariant);
    private static readonly Regex DataImage = new("^data:image/", I);
    private static bool TargetRefused((string Value, bool Url) target)
    {
        var text = CssTrim(target.Value.Replace('\\', '/'));
        if (text.StartsWith("//", StringComparison.Ordinal) || Outside.IsMatch(text)) return true;
        return target.Url && Scheme.IsMatch(text) && !DataImage.IsMatch(text);
    }
    private static string? CssProblem(string css, bool declarations = false)
    {
        foreach (var target in CssTargets(css, declarations))
            if (TargetRefused(target)) return target.Url ? "a url, image or @import to an outside address" : "an outside address in a custom property";
        return null;
    }

    private static readonly Dictionary<string, string> Named = new(StringComparer.Ordinal) { ["amp"] = "&", ["lt"] = "<", ["gt"] = ">", ["quot"] = "\"", ["apos"] = "'", ["colon"] = ":",
        ["sol"] = "/", ["bsol"] = "\\", ["lpar"] = "(", ["rpar"] = ")", ["Tab"] = "\t", ["NewLine"] = "\n", ["period"] = ".", ["num"] = "#", ["percnt"] = "%", ["commat"] = "@",
        ["semi"] = ";", ["AMP"] = "&", ["LT"] = "<", ["GT"] = ">", ["QUOT"] = "\"" };
    private static readonly Regex Entity = new("&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));?|&([A-Za-z]+);", RegexOptions.CultureInvariant);
    internal static string DecodeEntities(string text) => Entity.Replace(text, m =>
    {
        if (m.Groups[3].Success) return Named.TryGetValue(m.Groups[3].Value, out var named) ? named : m.Value;
        var digits = m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value;
        var ok = long.TryParse(digits, m.Groups[1].Success ? System.Globalization.NumberStyles.HexNumber : System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var code);
        return !ok || code == 0 || code > 0x10FFFF || code is >= 0xD800 and <= 0xDFFF ? "\uFFFD" : char.ConvertFromUtf32((int)code);
    });

    private static IEnumerable<(string Name, string? Value)> Attributes(string html)
    {
        static bool Space(char c) => c is ' ' or '\t' or '\n' or '\r' or '\f';
        for (var i = 0; i < html.Length; i++)
        {
            if (html[i] != '<' || i + 1 >= html.Length || !char.IsAsciiLetter(html[i + 1])) continue;
            var j = i + 1;
            while (j < html.Length && !Space(html[j]) && html[j] != '/' && html[j] != '>') j++;
            while (true)
            {
                while (j < html.Length && (Space(html[j]) || html[j] == '/')) j++;
                if (j >= html.Length || html[j] == '>') break;
                var start = j;
                j++;
                while (j < html.Length && !Space(html[j]) && html[j] != '/' && html[j] != '>' && html[j] != '=') j++;
                var name = html[start..j].ToLowerInvariant();
                while (j < html.Length && Space(html[j])) j++;
                string? value = null;
                if (j < html.Length && html[j] == '=')
                {
                    j++;
                    while (j < html.Length && Space(html[j])) j++;
                    if (j < html.Length && html[j] is '"' or '\'')
                    {
                        var end = html.IndexOf(html[j], j + 1);
                        value = html[(j + 1)..(end < 0 ? html.Length : end)]; j = end < 0 ? html.Length : end + 1;
                    }
                    else { var from = j; while (j < html.Length && !Space(html[j]) && html[j] != '>') j++; value = html[from..j]; }
                }
                yield return (name, value);
            }
            i = j;
        }
    }

    internal static string? DocumentProblem(string html)
    {
        var tag = ForbiddenTag.Match(html);
        if (tag.Success) return $"a {tag.Value[1..].ToLowerInvariant()} element";
        if (MetaRefresh.IsMatch(html)) return "a meta http-equiv element";
        if (SrcDoc.IsMatch(html)) return "a srcdoc attribute";
        if (ScriptUrl.IsMatch(html.Replace("\t", "").Replace("\n", "").Replace("\r", ""))) return "a javascript: or vbscript: address";
        foreach (var (name, raw) in Attributes(html))
        {
            if (OnAttribute.IsMatch(name)) return $"an {name} attribute";
            var value = raw;
            if (value == null) continue;
            value = DecodeEntities(value);
            if (ScriptUrl.IsMatch(value.Replace("\t", "").Replace("\n", "").Replace("\r", ""))) return "a javascript: or vbscript: address";
            if (UrlAttributes.Contains(name))
            {
                var urls = name is "srcset" or "imagesrcset" ? value.Split(',').Select(part => Spaces.Split(JsTrim(part))[0]) : [JsTrim(value)];
                if (urls.Any(url => ForbiddenUrl.IsMatch(url))) return $"an outside address in a {name} attribute";
            }
            if (name == "style" && CssProblem(value, true) is string css) return css + " in a style attribute";
        }
        foreach (Match match in StyleElement.Matches(html)) if (CssProblem(match.Groups[1].Value) is string css) return css + " in a style element";
        return null;
    }

    internal static string? StyleProblem(string css)
    {
        if (css.Contains("</style", StringComparison.OrdinalIgnoreCase)) return "a </style> end tag";
        if (ScriptUrl.IsMatch(css.Replace("\t", "").Replace("\n", "").Replace("\r", ""))) return "a javascript: or vbscript: address";
        return CssProblem(css);
    }

    // The request with its defaults, or the refusal (the order of render-request.mjs).
    internal static JsonObject Validate(JsonNode? node, bool documentRules = true)
    {
        var request = Only(node, ["schema", "styles", "documents", "viewports", "probes", "image", "timeoutMs"], "The request");
        if (Text(request["schema"]) != RequestSchema) throw Invalid($"schema must be {RequestSchema}");
        var styles = Missing(request, "styles") ? new JsonArray() : request["styles"] as JsonArray;
        if (styles == null || styles.Count > Styles) throw Invalid($"styles must be an array of at most {Styles}");
        long total = 0;
        var styleIds = new HashSet<string>();
        var normalizedStyles = new JsonArray();
        foreach (var item in styles)
        {
            var style = Only(item, ["id", "sha256", "css"], "A style");
            var id = Text(style["id"]);
            if (id == null || !Id.IsMatch(id) || !styleIds.Add(id)) throw Invalid("A style id must be unique and match ^[a-z0-9-]{1,40}$");
            var css = Text(style["css"]) ?? throw Invalid($"The style {id} has no css text");
            var bytes = Encoding.UTF8.GetByteCount(css);
            if (bytes > CssBytes) throw Invalid($"The style {id} has {bytes} bytes, above {CssBytes}");
            var hash = Text(style["sha256"]);
            if (hash == null || !Sha.IsMatch(hash) || Sha256(css) != hash) throw Invalid($"The style {id} does not match its sha256");
            total += bytes;
            normalizedStyles.Add((JsonNode)new JsonObject { ["id"] = id, ["sha256"] = hash, ["css"] = css });
        }
        if (request["documents"] is not JsonArray documents || documents.Count < 1 || documents.Count > Documents) throw Invalid($"documents must be an array of 1 to {Documents}");
        var documentIds = new HashSet<string>();
        var normalizedDocuments = new JsonArray();
        foreach (var item in documents)
        {
            var document = Only(item, ["id", "sha256", "html", "styles"], "A document");
            var id = Text(document["id"]);
            if (id == null || !Id.IsMatch(id) || !documentIds.Add(id)) throw Invalid("A document id must be unique and match ^[a-z0-9-]{1,40}$");
            var html = Text(document["html"]) ?? throw Invalid($"The document {id} has no html text");
            var bytes = Encoding.UTF8.GetByteCount(html);
            if (bytes > HtmlBytes) throw Invalid($"The document {id} has {bytes} bytes, above {HtmlBytes}");
            var hash = Text(document["sha256"]);
            if (hash == null || !Sha.IsMatch(hash) || Sha256(html) != hash) throw Invalid($"The document {id} does not match its sha256");
            var uses = Missing(document, "styles") ? new JsonArray() : document["styles"] as JsonArray;
            var names = uses?.Select(Text).ToList() ?? [];
            if (uses == null || uses.Count > Styles || names.Distinct().Count() != names.Count || names.Any(n => n == null || !styleIds.Contains(n)))
                throw Invalid($"The document {id} names a style that is not in the request");
            total += bytes;
            normalizedDocuments.Add((JsonNode)new JsonObject { ["id"] = id, ["sha256"] = hash, ["html"] = html,
                ["styles"] = new JsonArray(names.Select(n => (JsonNode?)JsonValue.Create(n)).ToArray()) });
        }
        if (total > PackageBytes) throw Invalid($"The documents and styles have {total} bytes, above {PackageBytes}");
        if (request["viewports"] is not JsonArray viewports || viewports.Count < 1 || viewports.Count > Viewports) throw Invalid($"viewports must be an array of 1 to {Viewports}");
        var viewportNames = new HashSet<string>();
        var normalizedViewports = new JsonArray();
        foreach (var item in viewports)
        {
            var viewport = Only(item, ["name", "width", "height", "bodyClasses"], "A viewport");
            var name = Text(viewport["name"]);
            if (name == null || !Id.IsMatch(name) || !viewportNames.Add(name)) throw Invalid("A viewport name must be unique and match ^[a-z0-9-]{1,40}$");
            if (!Int(viewport["width"], MinWidth, MaxWidth, out var width) || !Int(viewport["height"], MinHeight, MaxHeight, out var height))
                throw Invalid($"The viewport {name} must be {MinWidth}-{MaxWidth} wide and {MinHeight}-{MaxHeight} high");
            var classes = Missing(viewport, "bodyClasses") ? new JsonArray() : viewport["bodyClasses"] as JsonArray;
            if (classes == null || classes.Count > BodyClasses || classes.Any(c => Text(c) is not string text || !ClassPattern.IsMatch(text)))
                throw Invalid($"The viewport {name} has more than {BodyClasses} body classes or a class that is not a plain name");
            normalizedViewports.Add((JsonNode)new JsonObject { ["name"] = name, ["width"] = width, ["height"] = height,
                ["bodyClasses"] = new JsonArray(classes.Select(c => (JsonNode?)JsonValue.Create(Text(c))).ToArray()) });
        }
        var probes = Missing(request, "probes") ? new JsonObject() : Only(request["probes"], ["keys", "properties", "maxElements"], "probes");
        JsonNode keys;
        if (Missing(probes, "keys") || Text(probes["keys"]) == "all") keys = JsonValue.Create("all");
        else if (probes["keys"] is JsonArray list && list.Count <= Keys && list.All(k => Text(k) is string key && KeyPattern.IsMatch(key)))
            keys = new JsonArray(list.Select(k => (JsonNode?)JsonValue.Create(Text(k))).ToArray());
        else throw Invalid($"probes.keys must be \"all\" or at most {Keys} keys matching ^[A-Za-z0-9_-]{{1,80}}$");
        var properties = Missing(probes, "properties") ? new JsonArray() : probes["properties"] as JsonArray;
        var propertyNames = properties?.Select(Text).ToList() ?? [];
        if (properties == null || properties.Count > Properties || propertyNames.Any(n => n == null || !AllowedProperties.Contains(n)) || propertyNames.Distinct().Count() != propertyNames.Count)
            throw Invalid($"probes.properties must be at most {Properties} distinct names of the allowed list");
        long maxElements = DefaultMaxElements;
        if (!Missing(probes, "maxElements") && !Int(probes["maxElements"], 1, MaxElements, out maxElements)) throw Invalid($"probes.maxElements must be an integer from 1 to {MaxElements}");
        JsonNode? image = null;
        if (!Missing(request, "image"))
        {
            var asked = Only(request["image"], ["format", "quality", "maxEdge", "fullPage"], "image");
            if (Text(asked["format"]) != "jpeg" || !Int(asked["quality"], MinQuality, MaxQuality, out var quality) || !Int(asked["maxEdge"], MinEdge, MaxEdge, out var edge)
                || asked["fullPage"] is not JsonValue full || full.GetValueKind() is not (System.Text.Json.JsonValueKind.True or System.Text.Json.JsonValueKind.False))
                throw Invalid($"image must be null or {{format:\"jpeg\", quality:{MinQuality}-{MaxQuality}, maxEdge:{MinEdge}-{MaxEdge}, fullPage:boolean}}");
            image = new JsonObject { ["format"] = "jpeg", ["quality"] = quality, ["maxEdge"] = edge, ["fullPage"] = full.GetValue<bool>() };
        }
        long timeoutMs = DefaultTimeoutMs;
        if (!Missing(request, "timeoutMs") && !Int(request["timeoutMs"], MinTimeoutMs, MaxTimeoutMs, out timeoutMs)) throw Invalid($"timeoutMs must be an integer from {MinTimeoutMs} to {MaxTimeoutMs}");
        if (documentRules)
        {
            foreach (var style in normalizedStyles) if (StyleProblem(style!["css"]!.GetValue<string>()) is string problem) throw Refused($"The style {style["id"]!.GetValue<string>()} has {problem}");
            foreach (var document in normalizedDocuments) if (DocumentProblem(document!["html"]!.GetValue<string>()) is string problem) throw Refused($"The document {document["id"]!.GetValue<string>()} has {problem}");
        }
        return new JsonObject { ["schema"] = RequestSchema, ["styles"] = normalizedStyles, ["documents"] = normalizedDocuments, ["viewports"] = normalizedViewports,
            ["probes"] = new JsonObject { ["keys"] = keys, ["properties"] = new JsonArray(propertyNames.Select(n => (JsonNode?)JsonValue.Create(n)).ToArray()), ["maxElements"] = maxElements },
            ["image"] = image, ["timeoutMs"] = timeoutMs };
    }

    // ---- the worker's facts, as render-request.mjs validateRenderFacts checks them.
    private static double Finite(JsonNode? node, string where) =>
        node is JsonValue v && v.GetValueKind() == System.Text.Json.JsonValueKind.Number && v.TryGetValue<double>(out var d) && double.IsFinite(d) ? d : throw Failed($"{where} is not a finite number");
    private static long Count(JsonNode? node, string where) => node is JsonValue v && v.GetValueKind() == System.Text.Json.JsonValueKind.Number && v.TryGetValue<long>(out var n) && n >= 0 ? n : throw Failed($"{where} is not a count");
    private static bool Bool(JsonNode? node, string where) => node is JsonValue v && v.GetValueKind() is System.Text.Json.JsonValueKind.True or System.Text.Json.JsonValueKind.False ? v.GetValue<bool>() : throw Failed($"{where} is not true or false");
    private static string Short(JsonNode? node, int max, string where) => Text(node) is string s && s.Length <= max && !s.Any(c => c < 32) ? s : throw Failed($"{where} is not a short text");
    private static JsonNode? Number(double value) => value == Math.Floor(value) && Math.Abs(value) < 9007199254740992 ? JsonValue.Create((long)value) : JsonValue.Create(value);

    private static JsonObject Element(JsonNode? node, JsonObject request, HashSet<string>? keySet, string where)
    {
        if (node is not JsonObject value) throw Failed($"{where} is not an object");
        var k = Text(value["k"]);
        if (k == null || !KeyPattern.IsMatch(k) || keySet != null && !keySet.Contains(k)) throw Failed($"{where} names a key that the request did not ask for");
        if (value["box"] is not JsonArray box || box.Count != 4) throw Failed($"{where}.box is not four numbers");
        JsonNode? Who(JsonNode? other, string name)
        {
            if (other == null) return null;
            if (other is not JsonObject o) throw Failed($"{where}.{name} is not an object");
            if (o["k"] != null && (Text(o["k"]) is not string key || !KeyPattern.IsMatch(key))) throw Failed($"{where}.{name}.k is not a key");
            if (Text(o["tag"]) is not string tag || !TagPattern.IsMatch(tag)) throw Failed($"{where}.{name}.tag is not a tag name");
            var classes = Missing(o, "classes") ? new JsonArray() : o["classes"] as JsonArray;
            if (classes == null || classes.Count > 3 || classes.Any(c => Text(c) is not string text || !ClassPattern.IsMatch(text))) throw Failed($"{where}.{name}.classes is not at most 3 class names");
            return new JsonObject { ["k"] = Text(o["k"]), ["tag"] = tag, ["classes"] = new JsonArray(classes.Select(c => (JsonNode?)JsonValue.Create(Text(c))).ToArray()) };
        }
        var styles = new JsonObject();
        if (value["styles"] != null)
        {
            if (value["styles"] is not JsonObject given) throw Failed($"{where}.styles is not an object");
            var asked = request["probes"]!["properties"]!.AsArray().Select(n => n!.GetValue<string>()).ToHashSet();
            foreach (var pair in given)
            {
                if (!asked.Contains(pair.Key)) continue;
                var text = Text(pair.Value) ?? throw Failed($"{where}.styles.{pair.Key} is not text");
                styles[pair.Key] = text.Length > StyleText ? text[..StyleText] : text;
            }
        }
        return new JsonObject { ["k"] = k, ["box"] = new JsonArray(box.Select((n, i) => Number(Finite(n, $"{where}.box[{i}]"))).ToArray()), ["visible"] = Bool(value["visible"], $"{where}.visible"),
            ["coveredBy"] = Who(value["coveredBy"], "coveredBy"), ["clippedBy"] = Who(value["clippedBy"], "clippedBy"), ["lines"] = Count(value["lines"], $"{where}.lines"),
            ["textLength"] = Count(value["textLength"], $"{where}.textLength"), ["overflowX"] = Bool(value["overflowX"], $"{where}.overflowX"), ["styles"] = styles };
    }

    internal static JsonObject ValidateFacts(JsonNode? node, JsonObject request)
    {
        if (node is not JsonObject facts || Text(facts["schema"]) != FactsSchema) throw Failed($"schema is not {FactsSchema}");
        if (facts["engine"] is not JsonObject engine || engine["protocol"] is not JsonValue protocol || !protocol.TryGetValue<long>(out var p) || p != Protocol) throw Failed($"engine.protocol is not {Protocol}");
        var byId = request["documents"]!.AsArray().ToDictionary(d => d!["id"]!.GetValue<string>(), d => d!.AsObject());
        var byName = request["viewports"]!.AsArray().ToDictionary(v => v!["name"]!.GetValue<string>(), v => v!.AsObject());
        var keySet = request["probes"]!["keys"] is JsonArray list ? list.Select(k => k!.GetValue<string>()).ToHashSet() : null;
        var maxElements = request["probes"]!["maxElements"]!.GetValue<long>();
        var askedImage = request["image"] as JsonObject;
        if (facts["documents"] is not JsonArray documents || documents.Count > byId.Count) throw Failed("documents is not a list of the requested documents");
        if (facts["images"] != null && facts["images"] is not JsonArray) throw Failed("images is not a list");
        var rawImages = facts["images"] as JsonArray ?? [];
        var images = new JsonArray(); var omitted = new JsonArray();
        var seen = new HashSet<string>();
        var outDocuments = new JsonArray();
        for (var d = 0; d < documents.Count; d++)
        {
            var where = $"documents[{d}]";
            if (documents[d] is not JsonObject document || Text(document["id"]) is not string id || !byId.ContainsKey(id) || !seen.Add(id)) throw Failed($"{where} is not a requested document");
            if (document["viewports"] is not JsonArray views || views.Count > byName.Count) throw Failed($"{where}.viewports is not a list of the requested viewports");
            var viewSeen = new HashSet<string>();
            var outViews = new JsonArray();
            for (var v = 0; v < views.Count; v++)
            {
                var at = $"{where}.viewports[{v}]";
                if (views[v] is not JsonObject view || Text(view["name"]) is not string name || !byName.ContainsKey(name) || !viewSeen.Add(name)) throw Failed($"{at} is not a requested viewport");
                var asked = byName[name];
                if (view["page"] is not JsonObject page) throw Failed($"{at}.page is not an object");
                var fonts = view["fonts"]?["missing"] == null ? new JsonArray() : view["fonts"]!["missing"] as JsonArray;
                if (fonts == null || fonts.Count > Fonts) throw Failed($"{at}.fonts.missing is not a list");
                if (view["elements"] is not JsonArray elements) throw Failed($"{at}.elements is not a list");
                var truncated = view["truncated"] is JsonValue tv && tv.GetValueKind() == System.Text.Json.JsonValueKind.True;
                var kept = elements.Take((int)Math.Min(elements.Count, maxElements)).ToList();
                if (elements.Count > maxElements) truncated = true;
                JsonNode? imageIndex = null;
                if (view["image"] != null)
                {
                    var raw = view["image"] is JsonValue iv && iv.TryGetValue<long>(out var index) && index >= 0 && index < rawImages.Count ? rawImages[(int)index] : null;
                    if (raw == null) throw Failed($"{at}.image is not an index of images");
                    if (askedImage != null)
                    {
                        var (checkedImage, reason) = ImageOf(raw, id, name, askedImage, $"images[{view["image"]}]");
                        if (reason != null || images.Count >= Images) omitted.Add((JsonNode)new JsonObject { ["document"] = id, ["viewport"] = name, ["reason"] = reason ?? "too-many" });
                        else { imageIndex = images.Count; images.Add((JsonNode)checkedImage!); }
                    }
                }
                outViews.Add((JsonNode)new JsonObject { ["name"] = name, ["width"] = asked["width"]!.DeepClone(), ["height"] = asked["height"]!.DeepClone(),
                    ["ms"] = Count(Number(Math.Round(Finite(view["ms"], $"{at}.ms"), MidpointRounding.AwayFromZero)), $"{at}.ms"),
                    ["page"] = new JsonObject { ["scrollWidth"] = Number(Finite(page["scrollWidth"], $"{at}.page.scrollWidth")), ["scrollHeight"] = Number(Finite(page["scrollHeight"], $"{at}.page.scrollHeight")),
                        ["overflowX"] = Bool(page["overflowX"], $"{at}.page.overflowX") },
                    ["fonts"] = new JsonObject { ["missing"] = new JsonArray(fonts.Select((f, i) => (JsonNode?)JsonValue.Create(Short(f, FontName, $"{at}.fonts.missing[{i}]"))).ToArray()) },
                    ["elements"] = new JsonArray(kept.Select((e, i) => (JsonNode?)Element(e, request, keySet, $"{at}.elements[{i}]")).ToArray()), ["truncated"] = truncated, ["image"] = imageIndex });
            }
            var errors = document["errors"] == null ? new JsonArray() : document["errors"] as JsonArray;
            if (errors == null || errors.Count > Errors) throw Failed($"{where}.errors is not a list");
            var outErrors = new JsonArray();
            for (var e = 0; e < errors.Count; e++)
            {
                if (errors[e] is not JsonObject error || Text(error["code"]) is not string code || !ErrorCodes.Contains(code)
                    || error["viewport"] != null && (Text(error["viewport"]) is not string viewport || !byName.ContainsKey(viewport))) throw Failed($"{where}.errors[{e}] is not a known error");
                outErrors.Add((JsonNode)new JsonObject { ["code"] = code, ["viewport"] = Text(error["viewport"]) });
            }
            outDocuments.Add((JsonNode)new JsonObject { ["id"] = id, ["sha256"] = byId[id]["sha256"]!.DeepClone(), ["viewports"] = outViews, ["errors"] = outErrors });
        }
        var result = new JsonObject { ["schema"] = FactsSchema, ["engine"] = new JsonObject { ["name"] = Short(engine["name"] ?? "electron", 40, "engine.name"),
            ["version"] = Short(engine["version"] ?? "", 40, "engine.version"), ["chromium"] = Short(engine["chromium"] ?? "", 40, "engine.chromium"), ["protocol"] = Protocol },
            ["documents"] = outDocuments, ["images"] = images };
        if (omitted.Count > 0) result["imagesOmitted"] = omitted;
        var bytes = Encoding.UTF8.GetByteCount(result.ToJsonString());
        if (bytes > ValueBytes) throw new AgentFault("VALUE_TOO_LARGE", $"The render facts have {bytes} bytes, above {ValueBytes}");
        return result;
    }

    private static readonly Regex Base64 = new("^[A-Za-z0-9+/]*={0,2}$", RegexOptions.CultureInvariant);
    private static (JsonObject? Image, string? Omitted) ImageOf(JsonNode? node, string document, string viewport, JsonObject asked, string where)
    {
        if (node is not JsonObject raw || Text(raw["document"]) != document || Text(raw["viewport"]) != viewport || Text(raw["mime"]) != "image/jpeg"
            || Text(raw["base64"]) is not string base64 || !Base64.IsMatch(base64)) throw Failed($"{where} is not a JPEG of {document}/{viewport}");
        var edge = asked["maxEdge"]!.GetValue<long>();
        if (!Int(raw["width"], 1, edge, out var width) || !Int(raw["height"], 1, edge, out var height)) throw Failed($"{where} is larger than maxEdge");
        byte[] bytes;
        try { bytes = Convert.FromBase64String(base64); } catch (FormatException) { throw Failed($"{where} is not a JPEG of {document}/{viewport}"); }
        if (bytes.Length > ImageBytes) return (null, "too-large");
        if (bytes.Length < 3 || bytes[0] != 0xff || bytes[1] != 0xd8 || bytes[2] != 0xff) throw Failed($"{where} is not a JPEG");
        var hash = Convert.ToHexStringLower(SHA256.HashData(bytes));
        if (Text(raw["sha256"]) != hash) throw Failed($"{where} does not match its sha256");
        return (new JsonObject { ["document"] = document, ["viewport"] = viewport, ["mime"] = "image/jpeg", ["width"] = width, ["height"] = height, ["sha256"] = hash, ["base64"] = base64 }, null);
    }
}
