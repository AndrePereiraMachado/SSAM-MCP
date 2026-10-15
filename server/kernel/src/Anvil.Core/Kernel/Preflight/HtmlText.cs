using System.Text;
using System.Text.RegularExpressions;

namespace Anvil.Core.Preflight;

/// <summary>
/// motor2 (2026-10-12): the html of an html op read as positions, never re-serialized, so a normalization edits the text the
/// author wrote and nothing else (the order of the attributes, the quotes, the entities and the spaces stay). Lenient on
/// purpose: it reads every form of the op (fragment, page, document) for the rules of <see cref="HtmlDocumentRules"/>; the
/// compiler of the form stays the judge of the syntax. Comments are skipped, &lt;style&gt; and &lt;script&gt; are raw text,
/// a closing tag closes the nearest open element of its name, a void or self-closed element has no children.
/// </summary>
public sealed class HtmlText
{
    /// <summary>An attribute: its name, where its value starts and ends in the text (the quotes excluded) and the value as
    /// written (entities not decoded). <see cref="Start"/>..<see cref="End"/> is the whole attribute (name, = and quotes).</summary>
    public sealed record Attribute(string Name, string Value, int ValueStart, int ValueEnd, int Start, int End);

    /// <summary>An element: its tag (lower case), its open tag [OpenStart, OpenEnd), its attributes, its children and its
    /// texts (positions [start, end) of the text between the tags), and where it ends (after its closing tag, or its open tag).</summary>
    public sealed class Element
    {
        public string Tag { get; init; } = "";
        public int OpenStart { get; init; }
        public int OpenEnd { get; set; }
        public int End { get; set; }
        public List<Attribute> Attributes { get; } = [];
        public List<Element> Children { get; } = [];
        public List<(int Start, int End)> Texts { get; } = [];
        public Element? Parent { get; init; }
        public string? Get(string name) => Attributes.FirstOrDefault(a => a.Name.Equals(name, StringComparison.OrdinalIgnoreCase))?.Value;
        public Attribute? Find(string name) => Attributes.FirstOrDefault(a => a.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
        public IEnumerable<Element> Descendants()
        {
            foreach (var child in Children)
            {
                yield return child;
                foreach (var d in child.Descendants()) yield return d;
            }
        }
    }

    public string Source { get; }
    /// <summary>A synthetic root (tag empty) whose children are the top-level elements.</summary>
    public Element Root { get; }

    private static readonly HashSet<string> Void = new(StringComparer.OrdinalIgnoreCase)
        { "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr" };
    private static readonly HashSet<string> Raw = new(StringComparer.OrdinalIgnoreCase) { "style", "script" };
    private static readonly Regex Document = new(@"^\s*(?:<!--.*?-->\s*)*<(screen|block)[\s/>]", RegexOptions.Singleline | RegexOptions.Compiled);

    /// <summary>The document form of the html op (ssam-html/1): the text starts with one &lt;screen&gt; or &lt;block&gt;.</summary>
    public static bool IsDocument(string? html) => html != null && Document.IsMatch(html);

    private HtmlText(string source)
    {
        Source = source;
        Root = new Element { Tag = "", OpenStart = 0, OpenEnd = 0, End = source.Length };
        Parse();
    }

    public static HtmlText Parse(string source) => new(source);

    private void Parse()
    {
        var s = Source;
        var stack = new Stack<Element>();
        stack.Push(Root);
        var i = 0; var textStart = 0;
        void Text(int end) { if (end > textStart) stack.Peek().Texts.Add((textStart, end)); }
        while (i < s.Length)
        {
            if (s[i] != '<') { i++; continue; }
            if (string.CompareOrdinal(s, i, "<!--", 0, 4) == 0)
            {
                Text(i);
                var close = s.IndexOf("-->", i + 4, StringComparison.Ordinal);
                i = close < 0 ? s.Length : close + 3; textStart = i; continue;
            }
            if (i + 1 < s.Length && s[i + 1] == '/')
            {
                var nameEnd = i + 2;
                while (nameEnd < s.Length && (char.IsLetterOrDigit(s[nameEnd]) || s[nameEnd] is '-' or '_' or ':' or '.')) nameEnd++;
                var name = s[(i + 2)..nameEnd];
                var gt = s.IndexOf('>', nameEnd);
                if (name.Length == 0 || gt < 0) { i++; continue; }
                Text(i);
                var end = gt + 1;
                if (stack.Any(e => e.Tag.Equals(name, StringComparison.OrdinalIgnoreCase)))
                    while (stack.Count > 1)
                    {
                        var open = stack.Pop();
                        open.End = end;
                        if (open.Tag.Equals(name, StringComparison.OrdinalIgnoreCase)) break;
                    }
                i = end; textStart = i; continue;
            }
            if (i + 1 >= s.Length || !(char.IsLetter(s[i + 1]) || s[i + 1] == '_')) { i++; continue; }
            Text(i);
            var tagEnd = i + 1;
            while (tagEnd < s.Length && (char.IsLetterOrDigit(s[tagEnd]) || s[tagEnd] is '-' or '_' or ':' or '.')) tagEnd++;
            var element = new Element { Tag = s[(i + 1)..tagEnd], OpenStart = i, Parent = stack.Peek() };
            var k = tagEnd; var selfClosed = false;
            while (k < s.Length)
            {
                while (k < s.Length && char.IsWhiteSpace(s[k])) k++;
                if (k >= s.Length) break;
                if (s[k] == '>') { k++; break; }
                if (s[k] == '/' && k + 1 < s.Length && s[k + 1] == '>') { selfClosed = true; k += 2; break; }
                var nameStart = k;
                while (k < s.Length && !char.IsWhiteSpace(s[k]) && s[k] is not ('=' or '>') && !(s[k] == '/' && k + 1 < s.Length && s[k + 1] == '>')) k++;
                var attrName = s[nameStart..k];
                if (attrName.Length == 0) { k++; continue; }
                var probe = k;
                while (probe < s.Length && char.IsWhiteSpace(s[probe])) probe++;
                if (probe < s.Length && s[probe] == '=')
                {
                    probe++;
                    while (probe < s.Length && char.IsWhiteSpace(s[probe])) probe++;
                    if (probe < s.Length && s[probe] is '"' or '\'')
                    {
                        var quote = s[probe];
                        var close = s.IndexOf(quote, probe + 1);
                        if (close < 0) close = s.Length;
                        element.Attributes.Add(new Attribute(attrName, s[(probe + 1)..close], probe + 1, close, nameStart, Math.Min(s.Length, close + 1)));
                        k = Math.Min(s.Length, close + 1);
                    }
                    else
                    {
                        var vs = probe;
                        while (probe < s.Length && !char.IsWhiteSpace(s[probe]) && s[probe] != '>') probe++;
                        element.Attributes.Add(new Attribute(attrName, s[vs..probe], vs, probe, nameStart, probe));
                        k = probe;
                    }
                }
                else element.Attributes.Add(new Attribute(attrName, "", k, k, nameStart, k));
            }
            element.OpenEnd = k; element.End = k;
            stack.Peek().Children.Add(element);
            i = k; textStart = i;
            if (selfClosed || Void.Contains(element.Tag)) continue;
            if (Raw.Contains(element.Tag))
            {
                var close = s.IndexOf("</" + element.Tag, i, StringComparison.OrdinalIgnoreCase);
                var gt = close < 0 ? -1 : s.IndexOf('>', close);
                element.End = gt < 0 ? s.Length : gt + 1;
                i = element.End; textStart = i;
                continue;
            }
            stack.Push(element);
        }
        Text(s.Length);
        while (stack.Count > 1) stack.Pop().End = s.Length;
    }

    /// <summary>Every element of the text, in document order.</summary>
    public IEnumerable<Element> Elements() => Root.Descendants();

    /// <summary>The 1-based line and column of an offset (for the messages).</summary>
    public (int Line, int Column) Position(int offset)
    {
        var line = 1; var column = 1;
        for (var k = 0; k < offset && k < Source.Length; k++)
        {
            if (Source[k] == '\n') { line++; column = 1; }
            else column++;
        }
        return (line, column);
    }

    /// <summary>The spans [start, end) of every {{ expression }} inside [from, to) (the braces excluded).</summary>
    public static IEnumerable<(int Start, int End)> Bindings(string text, int from, int to)
    {
        var k = from;
        while (k < to)
        {
            var open = text.IndexOf("{{", k, to - k, StringComparison.Ordinal);
            if (open < 0) yield break;
            var close = text.IndexOf("}}", open + 2, to - open - 2, StringComparison.Ordinal);
            if (close < 0) yield break;
            yield return (open + 2, close);
            k = close + 2;
        }
    }

    // ---- expressions of an element ---------------------------------------------------------------------------------------

    /// <summary>The attributes whose whole value is text for the page (only their {{ }} are expressions).</summary>
    private static readonly HashSet<string> TextAttributes = new(StringComparer.OrdinalIgnoreCase)
        { "class", "style", "id", "name", "type", "title", "role", "placeholder", "href", "src", "alt", "for", "lang", "dir", "flow", "roles", "description", "actions", "data-actions", "as", "k", "icon", "weight", "size" };

    public static bool IsTextAttribute(string name) => TextAttributes.Contains(name) || name.StartsWith("aria-", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("data-", StringComparison.OrdinalIgnoreCase);

    /// <summary>An event attribute (on*, @*, html:on*): its value is a destination call, Target(P = expression, ...).</summary>
    public static bool IsEvent(string name) => name.StartsWith("on", StringComparison.OrdinalIgnoreCase) || name.StartsWith('@')
        || name.StartsWith("html:on", StringComparison.OrdinalIgnoreCase);

    /// <summary>The spans [start, end) of an element's own expressions: each attribute (the whole value; the {{ }} of a text
    /// attribute; the argument expressions of an event's call, never the names of its parameters) and the {{ }} of its own
    /// texts. <paramref name="includeList"/>: the source of the element's list= (read in the scope around it) too.</summary>
    public static IEnumerable<(int Start, int End)> ExpressionSpans(string html, Element element, bool includeList = true)
    {
        foreach (var a in element.Attributes)
        {
            if (a.Name.Equals("list", StringComparison.OrdinalIgnoreCase) && !includeList) continue;
            if (a.Name.Equals("as", StringComparison.OrdinalIgnoreCase)) continue;
            if (IsEvent(a.Name) && CallArguments(a.Value) is { } arguments)
            {
                foreach (var argument in arguments) yield return (a.ValueStart + argument.ValueStart, a.ValueStart + argument.ValueEnd);
                continue;
            }
            // The title of a screen is an expression (the title= of any other element is text for the page).
            var screenTitle = a.Name.Equals("title", StringComparison.OrdinalIgnoreCase) && element.Tag.Equals("screen", StringComparison.OrdinalIgnoreCase);
            if (IsTextAttribute(a.Name) && !screenTitle) foreach (var b in Bindings(html, a.ValueStart, a.ValueEnd)) yield return b;
            else yield return (a.ValueStart, a.ValueEnd);
        }
        foreach (var (start, end) in element.Texts)
            foreach (var b in Bindings(html, start, end)) yield return b;
    }

    // ---- edits ----------------------------------------------------------------------------------------------------------

    /// <summary>One edit of the text: replace [Start, Start + Length) by Text.</summary>
    public sealed record Edit(int Start, int Length, string Text);

    /// <summary>The text with the edits applied (none may overlap; the later ones first).</summary>
    public static string Apply(string text, IEnumerable<Edit> edits)
    {
        var sb = new StringBuilder(text);
        foreach (var e in edits.OrderByDescending(e => e.Start).ThenByDescending(e => e.Length)) sb.Remove(e.Start, e.Length).Insert(e.Start, e.Text);
        return sb.ToString();
    }

    // A text literal of the expression language as the html carries it: "..." ("" inside), or &quot;...&quot; in an attribute.
    private static readonly Regex Literal = new("&quot;.*?&quot;|\"(?:[^\"]|\"\")*\"", RegexOptions.Compiled | RegexOptions.Singleline);

    /// <summary>The edits that rename the root <paramref name="name"/> of the paths in the expression [from, to) of
    /// <paramref name="text"/> (outside its text literals): `name` and `name.X` become <paramref name="to"/> and `to.X`. A
    /// member (`.name`), a longer name (`names`) and a call (`name(`) are not the root.</summary>
    public static IEnumerable<Edit> RenameRoot(string text, int from, int to, string name, string replacement)
    {
        var span = text[from..to];
        var masked = Literal.Replace(span, m => new string(' ', m.Length));
        var pattern = new Regex(@"(?<![\p{L}\p{N}_.$@])" + Regex.Escape(name) + @"(?![\p{L}\p{N}_])(?!\s*\()", RegexOptions.IgnoreCase);
        foreach (Match m in pattern.Matches(masked)) yield return new Edit(from + m.Index, m.Length, replacement);
    }

    /// <summary>The edits that rename the member <paramref name="member"/> of the path root <paramref name="root"/>
    /// (`root.member` becomes `root.replacement`) in the expression [from, to), outside its text literals.</summary>
    public static IEnumerable<Edit> RenameMember(string text, int from, int to, string root, string member, string replacement)
    {
        var span = text[from..to];
        var masked = Literal.Replace(span, m => new string(' ', m.Length));
        var pattern = new Regex(@"(?<![\p{L}\p{N}_.$@])" + Regex.Escape(root) + @"\s*\.\s*(" + Regex.Escape(member) + @")(?![\p{L}\p{N}_])", RegexOptions.IgnoreCase);
        foreach (Match m in pattern.Matches(masked)) yield return new Edit(from + m.Groups[1].Index, m.Groups[1].Length, replacement);
    }

    /// <summary>The edits that write the row of a List for its alias in the expression [from, to) (outside its text literals):
    /// `name.X` becomes <paramref name="member"/>(X) (an aggregate's row names its entity first) and `name` alone
    /// <paramref name="row"/>. A member (`.name`), a longer name and a call (`name(`) are not the alias.</summary>
    public static IEnumerable<Edit> RenameRow(string text, int from, int to, string name, string row, Func<string, string> member)
    {
        var span = text[from..to];
        var masked = Literal.Replace(span, m => new string(' ', m.Length));
        var pattern = new Regex(@"(?<![\p{L}\p{N}_.$@])" + Regex.Escape(name) + @"(?:\s*\.\s*([\p{L}_][\p{L}\p{N}_]*))?(?![\p{L}\p{N}_])(?!\s*\()", RegexOptions.IgnoreCase);
        foreach (Match m in pattern.Matches(masked))
            yield return new Edit(from + m.Index, m.Length, m.Groups[1].Success ? member(m.Groups[1].Value) : row);
    }

    /// <summary>One argument of an event's destination call: the parameter's name and where it starts (null and -1 when the
    /// arguments go by position), and the span [ValueStart, ValueEnd) of its expression, relative to the value as written.</summary>
    public sealed record Argument(string? Name, int NameStart, int ValueStart, int ValueEnd);

    private static readonly Regex Target = new(@"^\s*[A-Za-z_@~][A-Za-z0-9_:.@#+/=~\-]*\s*$", RegexOptions.Compiled);
    private static readonly Regex NamedArgument = new(@"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)", RegexOptions.Compiled);

    /// <summary>The arguments of an event value written as its destination call (ScreenDocument.ParseCall's forms):
    /// `Target(P = expression, ...)` by name, `Target(expression, ...)` by position, with positions in the value as written (a
    /// text literal is "..." or &amp;quot;...&amp;quot;). Empty for a bare `Target` or `Target()`; null when the value is no
    /// call (then the whole value is an expression). Only the top level of the call: `If(Filtro = "", ...)` inside an argument
    /// is part of its expression, never a name.</summary>
    public static List<Argument>? CallArguments(string value)
    {
        var open = value.IndexOf('(');
        var head = (open < 0 ? value : value[..open]).TrimEnd().TrimEnd(';');
        if (!Target.IsMatch(head)) return null;
        if (open < 0) return [];
        var parts = new List<(int Start, int End)>();
        var depth = 0; var start = open + 1; var close = -1;
        for (var k = open; k < value.Length; k++)
        {
            if (QuoteLength(value, k) is var quote and > 0) { k = AfterLiteral(value, k, quote) - 1; continue; }
            var c = value[k];
            if (c is '(' or '[') depth++;
            else if (c is ')' or ']')
            {
                if (--depth == 0) { close = k; parts.Add((start, k)); break; }
            }
            else if (c == ',' && depth == 1) { parts.Add((start, k)); start = k + 1; }
        }
        if (close < 0 || value[(close + 1)..].Trim().TrimEnd(';').Trim().Length > 0) return null;
        if (parts.Count == 1 && value[parts[0].Start..parts[0].End].Trim().Length == 0) return [];
        (int Start, int End) Trimmed((int Start, int End) p)
        {
            var (s, e) = p;
            while (s < e && char.IsWhiteSpace(value[s])) s++;
            while (e > s && char.IsWhiteSpace(value[e - 1])) e--;
            return (s, e);
        }
        var named = parts.Select(p => (Part: p, Match: NamedArgument.Match(value[p.Start..p.End]))).ToList();
        if (named.All(n => n.Match.Success))
            return named.Select(n =>
            {
                var (s, e) = Trimmed((n.Part.Start + n.Match.Length, n.Part.End));
                return new Argument(n.Match.Groups[1].Value, n.Part.Start + n.Match.Groups[1].Index, s, e);
            }).ToList();
        return parts.Select(p => { var (s, e) = Trimmed(p); return new Argument(null, -1, s, e); }).ToList();
    }

    /// <summary>The length of the quote of a text literal that starts at <paramref name="at"/>: 1 for ", 6 for &amp;quot;, 0 for none.</summary>
    private static int QuoteLength(string text, int at)
        => text[at] == '"' ? 1 : string.CompareOrdinal(text, at, "&quot;", 0, 6) == 0 ? 6 : 0;

    /// <summary>The offset after the text literal that starts at <paramref name="at"/> (its doubled quotes inside it).</summary>
    private static int AfterLiteral(string text, int at, int quote)
    {
        var mark = quote == 1 ? "\"" : "&quot;";
        var k = at + quote;
        while (k < text.Length)
        {
            var next = text.IndexOf(mark, k, StringComparison.Ordinal);
            if (next < 0) return text.Length;
            if (string.CompareOrdinal(text, next + quote, mark, 0, quote) == 0) { k = next + 2 * quote; continue; }
            return next + quote;
        }
        return text.Length;
    }

    /// <summary>Whether the root <paramref name="name"/> is read in the expression (outside its literals).</summary>
    public static bool ReadsRoot(string expression, string name) => RenameRoot(expression, 0, expression.Length, name, name).Any();

    /// <summary>The expression with the root renamed (see <see cref="RenameRoot"/>).</summary>
    public static string WithRoot(string expression, string name, string replacement) => Apply(expression, RenameRoot(expression, 0, expression.Length, name, replacement));

    /// <summary>The expression with root.member renamed (see <see cref="RenameMember"/>).</summary>
    public static string WithMember(string expression, string root, string member, string replacement) => Apply(expression, RenameMember(expression, 0, expression.Length, root, member, replacement));
}
