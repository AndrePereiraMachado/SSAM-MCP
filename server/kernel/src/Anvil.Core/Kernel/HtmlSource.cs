using System.Text;
namespace Anvil.Core;

/// <summary>One node of the authored page: an element with ordered attributes and children, or a text run. Positions point
/// back at the source so every diagnostic names the line and column the author has to fix.</summary>
public sealed class HtmlNode
{
    public const string TextTag = "#text";
    public string Tag { get; }
    public string SourceTag { get; internal set; }
    public IReadOnlyList<KeyValuePair<string, string>> Attributes { get; }
    public List<HtmlNode> Children { get; } = [];
    public string Text { get; }
    public int Line { get; }
    public int Column { get; }
    public string? SourcePath { get; internal set; }
    /// <summary>On the root of a parsed document: what the parser tolerated and how (a closing tag of a void element).</summary>
    public List<string> Notes { get; } = [];
    public bool IsText => Tag == TextTag;
    public HtmlNode(string tag, IReadOnlyList<KeyValuePair<string, string>> attributes, string text, int line, int column)
    { Tag = tag; SourceTag=tag; Attributes = attributes; Text = text; Line = line; Column = column; }
    public string? Attribute(string name) => Attributes.FirstOrDefault(a => a.Key.Equals(name, StringComparison.OrdinalIgnoreCase)).Value;
    public IEnumerable<HtmlNode> Elements => Children.Where(c => !c.IsText);
    /// <summary>Visible text of this subtree with runs of whitespace collapsed, the way a browser lays out inline content.</summary>
    public string InnerText()
    {
        var sb = new StringBuilder();
        void Walk(HtmlNode n) { if (n.IsText) sb.Append(n.Text); else foreach (var c in n.Children) Walk(c); }
        Walk(this);
        return CollapseSpaces(sb.ToString());
    }
    public string Where => $"line {Line} col {Column} <{(IsText ? "text" : Tag)}>";
    internal static string CollapseSpaces(string text)
    {
        var sb = new StringBuilder(text.Length); var space = false;
        foreach (var ch in text)
        {
            if (char.IsWhiteSpace(ch)) { if (!space && sb.Length > 0) sb.Append(' '); space = true; }
            else { sb.Append(ch); space = false; }
        }
        return sb.ToString().TrimEnd();
    }
    public IEnumerable<HtmlNode> Descendants()
    {
        foreach (var c in Children) { yield return c; foreach (var d in c.Descendants()) yield return d; }
    }
}

/// <summary>
/// Tokenizer and tree builder for the authoring subset of HTML: elements, attributes (quoted or bare), text, comments,
/// doctype, void elements, raw-text elements (style, script) and the optional end tags a hand-written page uses
/// (li, option, p, td, th, tr). Anything else is an error with the line and column, never a silent guess. This is a
/// parser over the language, not a regular expression over the text.
/// </summary>
public static class HtmlSource
{
    private static readonly HashSet<string> Void = new(StringComparer.Ordinal) { "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr" };
    private static readonly HashSet<string> RawText = new(StringComparer.Ordinal) { "style", "script" };
    // Elements whose end tag HTML lets the author omit: they close at the parent's end tag or at the end of the document.
    private static readonly HashSet<string> OptionalEnd = new(StringComparer.Ordinal) { "li", "option", "dt", "dd", "td", "th", "tr", "thead", "tbody", "tfoot", "p" };
    // Opening one of these implicitly closes the same or a sibling element that is still open (HTML optional end tags).
    private static readonly Dictionary<string, string[]> ImpliedClose = new(StringComparer.Ordinal)
    {
        ["li"] = ["li"], ["option"] = ["option"], ["dt"] = ["dt", "dd"], ["dd"] = ["dt", "dd"],
        ["td"] = ["td", "th"], ["th"] = ["td", "th"], ["tr"] = ["td", "th", "tr"], ["tbody"] = ["td", "th", "tr", "thead", "tbody"], ["tfoot"] = ["td", "th", "tr", "tbody"],
        ["p"] = ["p"], ["h1"] = ["p"], ["h2"] = ["p"], ["h3"] = ["p"], ["h4"] = ["p"], ["h5"] = ["p"], ["h6"] = ["p"], ["div"] = ["p"], ["section"] = ["p"], ["article"] = ["p"], ["table"] = ["p"], ["ul"] = ["p"], ["ol"] = ["p"],
    };
    private static readonly Dictionary<string, string> Entities = new(StringComparer.Ordinal) { ["amp"] = "&", ["lt"] = "<", ["gt"] = ">", ["quot"] = "\"", ["apos"] = "'", ["nbsp"] = " ", ["copy"] = "©", ["hellip"] = "…", ["mdash"] = "—", ["ndash"] = "–", ["rarr"] = "→", ["uarr"] = "↑", ["larr"] = "←" };

    /// <summary>Parses a document or fragment into a synthetic root whose children are the top-level nodes.</summary>
    public static HtmlNode Parse(string html) => new Parser(html).Document();

    private sealed class Parser(string text)
    {
        private int _i; private int _line = 1, _col = 1;
        private readonly HtmlNode _root = new("#root", [], "", 1, 1);
        private readonly List<HtmlNode> _open = [];
        private HtmlNode Top => _open.Count == 0 ? _root : _open[^1];
        private bool End => _i >= text.Length;
        private char Peek(int ahead = 0) => _i + ahead < text.Length ? text[_i + ahead] : '\0';
        private bool At(string s) => string.CompareOrdinal(text, _i, s, 0, s.Length) == 0;
        private bool AtIgnoreCase(string s) => _i + s.Length <= text.Length && string.Compare(text, _i, s, 0, s.Length, StringComparison.OrdinalIgnoreCase) == 0;
        private char Take() { var c = text[_i++]; if (c == '\n') { _line++; _col = 1; } else _col++; return c; }
        private InvalidOperationException Error(string message, int? line = null, int? col = null) => new($"html: line {line ?? _line} col {col ?? _col}: {message}");

        public HtmlNode Document()
        {
            while (!End)
            {
                if (Peek() == '<')
                {
                    if (At("<!--")) Comment();
                    else if (AtIgnoreCase("<!doctype")) SkipUntil('>');
                    else if (At("</")) CloseTag();
                    else if (char.IsLetter(Peek(1))) OpenTag();
                    else throw Error("stray '<'; write &lt; for a literal less-than sign");
                }
                else TextRun();
            }
            while (_open.Count > 0 && OptionalEnd.Contains(Top.Tag)) _open.RemoveAt(_open.Count - 1);
            if (_open.Count > 0) throw Error($"unclosed <{Top.Tag}> opened at line {Top.Line} col {Top.Column}", Top.Line, Top.Column);
            return _root;
        }

        private void Comment() { var (l, c) = (_line, _col); var end = text.IndexOf("-->", _i + 4, StringComparison.Ordinal); if (end < 0) throw Error("unterminated comment", l, c); while (_i < end + 3) Take(); }
        private void SkipUntil(char ch) { while (!End && Peek() != ch) Take(); if (End) throw Error("unterminated markup"); Take(); }

        private void TextRun()
        {
            var (l, c) = (_line, _col); var sb = new StringBuilder();
            while (!End && Peek() != '<') sb.Append(Peek() == '&' ? Entity() : Take().ToString());
            Top.Children.Add(new HtmlNode(HtmlNode.TextTag, [], sb.ToString(), l, c));
        }

        private string Entity()
        {
            var semicolon = text.IndexOf(';', _i);
            if (semicolon < 0 || semicolon - _i > 10) { Take(); return "&"; }
            var name = text.Substring(_i + 1, semicolon - _i - 1);
            string? value = null;
            if (name.StartsWith('#'))
            {
                var hex = name.Length > 1 && (name[1] == 'x' || name[1] == 'X');
                if (int.TryParse(name.AsSpan(hex ? 2 : 1), hex ? System.Globalization.NumberStyles.HexNumber : System.Globalization.NumberStyles.Integer, null, out var code) && code > 0 && code <= 0x10FFFF)
                    value = char.ConvertFromUtf32(code);
            }
            else if (Entities.TryGetValue(name, out var known)) value = known;
            if (value == null) { Take(); return "&"; } // unknown entity: the text is preserved as written
            while (_i <= semicolon) Take();
            return value;
        }

        private void OpenTag()
        {
            var (l, c) = (_line, _col); Take();
            var sourceTag=Name();var tag = sourceTag.ToLowerInvariant();
            var attributes = new List<KeyValuePair<string, string>>();
            while (true)
            {
                SkipSpaces();
                if (End) throw Error($"unterminated <{tag}>", l, c);
                if (At("/>")) { Take(); Take(); Add(new HtmlNode(tag, attributes, "", l, c){SourceTag=sourceTag}, selfClosed: true); return; }
                if (Peek() == '>') { Take(); break; }
                var prefix = Peek() == '@' ? Take().ToString() : "";
                var name = prefix + Name();
                if (name.Length == 0) throw Error($"invalid character '{Peek()}' in <{tag}>");
                SkipSpaces(); var value = "";
                if (Peek() == '=')
                {
                    Take(); SkipSpaces();
                    if (Peek() == '"' || Peek() == '\'')
                    {
                        var quote = Take(); var sb = new StringBuilder();
                        while (!End && Peek() != quote) sb.Append(Peek() == '&' ? Entity() : Take().ToString());
                        if (End) throw Error($"unterminated attribute value for '{name}' in <{tag}>", l, c);
                        Take(); value = sb.ToString();
                    }
                    else { var sb = new StringBuilder(); while (!End && !char.IsWhiteSpace(Peek()) && Peek() != '>' && !At("/>")) sb.Append(Take()); value = sb.ToString(); }
                }
                if (attributes.Any(a => a.Key.Equals(name, StringComparison.OrdinalIgnoreCase))) throw Error($"duplicate attribute '{name}' in <{tag}>", l, c);
                attributes.Add(new(name.ToLowerInvariant(), value));
            }
            var node = new HtmlNode(tag, attributes, "", l, c){SourceTag=sourceTag};
            if (RawText.Contains(tag))
            {
                Add(node, selfClosed: true);
                var close = "</" + tag; var end = text.IndexOf(close, _i, StringComparison.OrdinalIgnoreCase);
                if (end < 0) throw Error($"unterminated <{tag}>", l, c);
                var (tl, tc) = (_line, _col); var sb = new StringBuilder(); while (_i < end) sb.Append(Take());
                node.Children.Add(new HtmlNode(HtmlNode.TextTag, [], sb.ToString(), tl, tc));
                while (!End && Peek() != '>') Take();
                if (End) throw Error($"unterminated </{tag}>", l, c);
                Take();
                return;
            }
            Add(node, selfClosed: Void.Contains(tag));
        }

        private void Add(HtmlNode node, bool selfClosed)
        {
            if (ImpliedClose.TryGetValue(node.Tag, out var closes))
                while (_open.Count > 0 && closes.Contains(Top.Tag, StringComparer.Ordinal)) _open.RemoveAt(_open.Count - 1);
            Top.Children.Add(node);
            if (!selfClosed) _open.Add(node);
        }

        private void CloseTag()
        {
            var (l, c) = (_line, _col); Take(); Take();
            var tag = Name().ToLowerInvariant(); SkipSpaces();
            if (Peek() != '>') throw Error($"malformed closing tag </{tag}>", l, c);
            Take();
            // A void element has no content, so its closing tag (<hr></hr>, the XHTML habit of a prototype) closes nothing: it is
            // ignored, as the browser ignores it, and said (C13 of the atritos 3 package; lab 23 was refused for </hr>).
            if (Void.Contains(tag)) { _root.Notes.Add($"line {l} col {c}: </{tag}> closes a void element and was ignored; <{tag}> needs no closing tag"); return; }
            var index = _open.FindLastIndex(n => n.Tag == tag);
            if (index < 0) throw Error($"unexpected </{tag}>; open elements: {(_open.Count == 0 ? "none" : string.Join(" > ", _open.Select(n => n.Tag)))}", l, c);
            // Elements above the match only close implicitly when HTML allows their end tag to be omitted.
            for (var k = _open.Count - 1; k > index; k--)
                if (!OptionalEnd.Contains(_open[k].Tag)) throw Error($"</{tag}> closes <{tag}> from line {_open[index].Line} while <{_open[k].Tag}> (line {_open[k].Line} col {_open[k].Column}) is still open", l, c);
            _open.RemoveRange(index, _open.Count - index);
        }

        private string Name()
        {
            var sb = new StringBuilder();
            while (!End && (char.IsLetterOrDigit(Peek()) || Peek() == '-' || Peek() == '_' || Peek() == ':' || Peek() == '.')) sb.Append(Take());
            return sb.ToString();
        }
        private void SkipSpaces() { while (!End && char.IsWhiteSpace(Peek())) Take(); }
    }
}
