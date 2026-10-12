using System.Globalization;
using System.Text;

namespace Anvil.Core;

// ---- selectors: parse, specificity, match ----------------------------------------------------------------------------

public enum SimpleKind { Type, Universal, Id, Class, Attribute, PseudoClass, PseudoElement, Nesting }

/// <summary>One simple selector with its exact place in the selector text (<see cref="Start"/>..<see cref="End"/>), so a
/// rewrite splices the text instead of re-serializing it.</summary>
public sealed class SimpleSelector
{
    public SimpleKind Kind { get; init; }
    /// <summary>Unescaped name: tag, id, class, attribute or pseudo name (lower case for tags and pseudos).</summary>
    public string Name { get; init; } = "";
    public int Start { get; init; }
    public int End { get; set; }
    public string? Op { get; init; }
    public string? Value { get; init; }
    public bool IgnoreCase { get; init; }
    /// <summary>The text between the parentheses of a functional pseudo-class, as written.</summary>
    public string? Args { get; set; }
    public int ArgsStart { get; set; }
    /// <summary>The selector list argument of :is/:where/:not/:has/:matches and of :nth-*(An+B of S).</summary>
    public List<ComplexSelector>? Selectors { get; set; }
    public int NthA { get; set; }
    public int NthB { get; set; }
    public bool HasNth { get; set; }
}

public sealed class CompoundSelector
{
    public List<SimpleSelector> Items { get; } = [];
    public int Start { get; init; }
    public int End { get; set; }
}

/// <summary>A complex selector: compounds joined by combinators (' ', '&gt;', '+', '~'); the first part's combinator is '\0'.
/// <see cref="Leading"/> is the combinator of a relative selector (inside :has), '\0' otherwise.</summary>
public sealed class ComplexSelector
{
    public List<(char Combinator, CompoundSelector Compound)> Parts { get; } = [];
    public int Start { get; init; }
    public int End { get; init; }
    public char Leading { get; set; }
}

/// <summary>
/// The selector engine the prototype lanes share in C#: a parser that keeps positions (Selectors Level 4 syntax the prototypes
/// write: compounds, the four combinators, attribute operators and flags, functional pseudo-classes with selector lists and
/// An+B), the specificity of Selectors 4 (:is/:not/:has take their most specific argument, :where is zero) and a matcher over
/// <see cref="DomNode"/> trees (structural pseudo-classes, :has with relative selectors). Dynamic pseudo-classes (:hover,
/// :focus…) match only when the caller asks (<c>dynamic: true</c>): the rewrite decisions see them as possible, the fidelity
/// sets leave them out (4.4).
/// </summary>
public static class CssSelectors
{
    public static List<ComplexSelector> ParseList(string text, bool relative = false) => new Parser(text).List(0, text.Length, relative);

    public static ComplexSelector ParseComplex(string text)
    {
        var list = ParseList(text);
        if (list.Count != 1) throw new FormatException($"'{text}' is a selector list, not one selector");
        return list[0];
    }

    /// <summary>The specificity of one selector (the most specific of a list).</summary>
    public static (int A, int B, int C) Specificity(string selector) => ParseList(selector).Select(Specificity).Aggregate((0, 0, 0), Max);

    public static (int A, int B, int C) Specificity(ComplexSelector selector)
    {
        var total = (A: 0, B: 0, C: 0);
        foreach (var (_, compound) in selector.Parts)
            foreach (var simple in compound.Items)
            {
                var s = Specificity(simple);
                total = (total.A + s.A, total.B + s.B, total.C + s.C);
            }
        return total;
    }

    private static (int A, int B, int C) Specificity(SimpleSelector simple) => simple.Kind switch
    {
        SimpleKind.Id => (1, 0, 0),
        SimpleKind.Class or SimpleKind.Attribute => (0, 1, 0),
        SimpleKind.Type or SimpleKind.PseudoElement => (0, 0, 1),
        SimpleKind.PseudoClass => simple.Name switch
        {
            "where" => (0, 0, 0),
            "is" or "matches" or "-webkit-any" or "-moz-any" or "not" or "has" => (simple.Selectors ?? []).Select(Specificity).Aggregate((0, 0, 0), Max),
            "nth-child" or "nth-last-child" when simple.Selectors != null => Add((0, 1, 0), simple.Selectors.Select(Specificity).Aggregate((0, 0, 0), Max)),
            _ => (0, 1, 0),
        },
        _ => (0, 0, 0),
    };

    private static (int, int, int) Add((int A, int B, int C) x, (int A, int B, int C) y) => (x.A + y.A, x.B + y.B, x.C + y.C);
    public static (int A, int B, int C) Max((int A, int B, int C) x, (int A, int B, int C) y) =>
        x.A != y.A ? (x.A > y.A ? x : y) : x.B != y.B ? (x.B > y.B ? x : y) : (x.C >= y.C ? x : y);

    /// <summary>Whether <paramref name="element"/> matches any selector of the list.</summary>
    public static bool Matches(DomNode element, string selector, bool dynamic = false) =>
        element.IsElement && ParseList(selector).Any(s => Matches(element, s, dynamic));

    public static bool Matches(DomNode element, ComplexSelector selector, bool dynamic = false) =>
        element.IsElement && MatchAt(selector, selector.Parts.Count - 1, element, dynamic, null);

    /// <summary>Whether the element matches one compound alone (no combinator context): what a rewrite asks of a compiled
    /// element before seeing through its wrappers.</summary>
    public static bool MatchesCompound(DomNode element, CompoundSelector compound, bool dynamic = true) =>
        element.IsElement && MatchCompound(compound, element, dynamic, null);

    /// <summary>Every element of the tree under <paramref name="root"/> (itself included) the selector matches, in document order.</summary>
    public static IEnumerable<DomNode> Select(DomNode root, string selector, bool dynamic = false)
    {
        var list = ParseList(selector);
        return root.Descendants(includeSelf: true).Where(n => n.IsElement && list.Any(s => MatchAt(s, s.Parts.Count - 1, n, dynamic, null)));
    }

    private static bool MatchAt(ComplexSelector selector, int index, DomNode element, bool dynamic, DomNode? scope)
    {
        if (!MatchCompound(selector.Parts[index].Compound, element, dynamic, scope)) return false;
        if (index == 0)
            return selector.Leading == '\0' || scope == null || Related(selector.Leading, scope, element);
        switch (selector.Parts[index].Combinator)
        {
            case '>': return element.ParentElement is { } parent && MatchAt(selector, index - 1, parent, dynamic, scope);
            case '+': return element.PreviousElement is { } previous && MatchAt(selector, index - 1, previous, dynamic, scope);
            case '~':
                for (var s = element.PreviousElement; s != null; s = s.PreviousElement) if (MatchAt(selector, index - 1, s, dynamic, scope)) return true;
                return false;
            default:
                for (var a = element.ParentElement; a != null; a = a.ParentElement) if (MatchAt(selector, index - 1, a, dynamic, scope)) return true;
                return false;
        }
    }

    // The relation between the :has anchor and the leftmost compound of its relative selector.
    private static bool Related(char leading, DomNode anchor, DomNode element) => leading switch
    {
        '>' => element.ParentElement == anchor,
        '+' => element.PreviousElement == anchor,
        '~' => element.PreviousSiblings().Contains(anchor),
        _ => element.Ancestors().Contains(anchor),
    };

    private static bool MatchCompound(CompoundSelector compound, DomNode e, bool dynamic, DomNode? scope)
    {
        foreach (var s in compound.Items)
            if (!MatchSimple(s, e, dynamic, scope)) return false;
        return true;
    }

    private static bool MatchSimple(SimpleSelector s, DomNode e, bool dynamic, DomNode? scope)
    {
        switch (s.Kind)
        {
            case SimpleKind.Universal: return true;
            case SimpleKind.Nesting: return false;
            case SimpleKind.Type: return string.Equals(e.Tag, s.Name, StringComparison.OrdinalIgnoreCase);
            case SimpleKind.Id: return e.Attr("id") == s.Name;
            case SimpleKind.Class: return e.Classes.Contains(s.Name);
            case SimpleKind.Attribute: return MatchAttribute(s, e.Attr(s.Name));
            case SimpleKind.PseudoElement: return true;   // the originating element; the fidelity sets leave these selectors out
        }
        switch (s.Name)
        {
            case "is" or "where" or "matches" or "-webkit-any" or "-moz-any": return (s.Selectors ?? []).Any(x => MatchAt(x, x.Parts.Count - 1, e, dynamic, scope));
            case "not": return !(s.Selectors ?? []).Any(x => MatchAt(x, x.Parts.Count - 1, e, dynamic, scope));
            case "has": return (s.Selectors ?? []).Any(x => HasMatch(x, e, dynamic));
            case "first-child": return e.ElementIndex() == 0;
            case "last-child": return e.ElementIndexFromEnd() == 0;
            case "only-child": return e.ElementIndex() == 0 && e.ElementIndexFromEnd() == 0;
            case "first-of-type": return e.TypeIndex() == 0;
            case "last-of-type": return e.TypeIndexFromEnd() == 0;
            case "only-of-type": return e.TypeIndex() == 0 && e.TypeIndexFromEnd() == 0;
            case "nth-child": return s.HasNth && Nth(s, Position(e, s, dynamic, fromEnd: false));
            case "nth-last-child": return s.HasNth && Nth(s, Position(e, s, dynamic, fromEnd: true));
            case "nth-of-type": return s.HasNth && Nth(s, e.TypeIndex() + 1);
            case "nth-last-of-type": return s.HasNth && Nth(s, e.TypeIndexFromEnd() + 1);
            case "empty": return e.Children.All(c => !c.IsElement && string.IsNullOrEmpty(c.Text) && c.Unevaluable == null);
            case "root": return e.ParentElement == null;
            case "scope": return scope == null ? e.ParentElement == null : e == scope;
            case "checked": return e.Attr("checked") != null || (e.Tag == "option" && e.Attr("selected") != null);
            case "disabled": return e.Attr("disabled") != null;
            case "enabled": return e.Tag is "input" or "button" or "select" or "textarea" or "option" or "fieldset" && e.Attr("disabled") == null;
            case "required": return e.Attr("required") != null;
            case "optional": return e.Tag is "input" or "select" or "textarea" && e.Attr("required") == null;
            case "link" or "any-link": return e.Tag is "a" or "area" && e.Attr("href") != null;
            case "open": return e.Attr("open") != null;
            case "lang":
                var lang = (s.Args ?? "").Trim().Trim('"', '\'');
                for (var a = e; a != null; a = a.ParentElement)
                    if (a.Attr("lang") is { } value) return value.Equals(lang, StringComparison.OrdinalIgnoreCase) || value.StartsWith(lang + "-", StringComparison.OrdinalIgnoreCase);
                return false;
            case "dir": return true;
            default: return dynamic;   // :hover, :focus, :focus-visible, :focus-within, :active, :visited, :target, :modal…
        }
    }

    private static bool HasMatch(ComplexSelector relative, DomNode anchor, bool dynamic)
    {
        IEnumerable<DomNode> candidates = relative.Leading is '+' or '~'
            ? anchor.FollowingSiblings().SelectMany(s => s.Descendants(includeSelf: true))
            : anchor.Descendants(includeSelf: false);
        return candidates.Any(c => c.IsElement && MatchAt(relative, relative.Parts.Count - 1, c, dynamic, anchor));
    }

    private static int Position(DomNode e, SimpleSelector s, bool dynamic, bool fromEnd)
    {
        if (s.Selectors == null) return (fromEnd ? e.ElementIndexFromEnd() : e.ElementIndex()) + 1;
        var siblings = e.ParentElement?.Children.Where(c => c.IsElement).ToList() ?? [e];
        if (fromEnd) siblings.Reverse();
        var position = 0;
        foreach (var sibling in siblings)
        {
            if (s.Selectors.Any(x => MatchAt(x, x.Parts.Count - 1, sibling, dynamic, null))) position++;
            if (sibling == e) return s.Selectors.Any(x => MatchAt(x, x.Parts.Count - 1, e, dynamic, null)) ? position : -1;
        }
        return -1;
    }

    private static bool Nth(SimpleSelector s, int position)
    {
        if (position < 1) return false;
        if (s.NthA == 0) return position == s.NthB;
        var n = (position - s.NthB) / (double)s.NthA;
        return n >= 0 && Math.Abs(n - Math.Round(n)) < 1e-9;
    }

    private static bool MatchAttribute(SimpleSelector s, string? value)
    {
        if (value == null) return false;
        if (s.Op == null) return true;
        var expected = s.Value ?? "";
        var comparison = s.IgnoreCase ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        return s.Op switch
        {
            "=" => string.Equals(value, expected, comparison),
            "~=" => expected.Length > 0 && value.Split((char[])[' ', '\t', '\n', '\r', '\f'], StringSplitOptions.RemoveEmptyEntries).Any(v => string.Equals(v, expected, comparison)),
            "|=" => string.Equals(value, expected, comparison) || value.StartsWith(expected + "-", comparison),
            "^=" => expected.Length > 0 && value.StartsWith(expected, comparison),
            "$=" => expected.Length > 0 && value.EndsWith(expected, comparison),
            "*=" => expected.Length > 0 && value.Contains(expected, comparison),
            _ => false,
        };
    }

    public static bool IsPositional(SimpleSelector s) => s.Kind == SimpleKind.PseudoClass && s.Name is "first-child" or "last-child" or "only-child"
        or "nth-child" or "nth-last-child" or "first-of-type" or "last-of-type" or "only-of-type" or "nth-of-type" or "nth-last-of-type";

    private static readonly HashSet<string> LegacyPseudoElements = new(StringComparer.OrdinalIgnoreCase) { "before", "after", "first-line", "first-letter" };
    private static readonly HashSet<string> SelectorArguments = new(StringComparer.Ordinal) { "is", "where", "not", "has", "matches", "-webkit-any", "-moz-any" };

    private sealed class Parser(string s)
    {
        private int _i;
        private FormatException Fail(string message) => new($"selector '{s}': {message} at {_i}");

        public List<ComplexSelector> List(int from, int to, bool relative)
        {
            var list = new List<ComplexSelector>();
            foreach (var (a, b) in Split(from, to)) list.Add(Complex(a, b, relative));
            return list;
        }

        private IEnumerable<(int, int)> Split(int from, int to)
        {
            var depth = 0; var start = from; char? quote = null;
            for (var i = from; i < to; i++)
            {
                var c = s[i];
                if (quote != null) { if (c == '\\') i++; else if (c == quote) quote = null; continue; }
                if (c is '"' or '\'') quote = c;
                else if (c == '\\') i++;
                else if (c is '(' or '[') depth++;
                else if (c is ')' or ']') depth--;
                else if (c == ',' && depth == 0) { yield return (start, i); start = i + 1; }
            }
            yield return (start, to);
        }

        private ComplexSelector Complex(int from, int to, bool relative)
        {
            _i = from; Space(to);
            var complex = new ComplexSelector { Start = from, End = to };
            if (relative)
            {
                if (_i < to && s[_i] is '>' or '+' or '~') { complex.Leading = s[_i]; _i++; Space(to); }
                else complex.Leading = ' ';
            }
            var combinator = '\0';
            while (_i < to)
            {
                var compound = Compound(to);
                if (compound.Items.Count == 0) throw Fail("empty compound");
                complex.Parts.Add((combinator, compound));
                var spaced = Space(to);
                if (_i >= to) break;
                if (s[_i] is '>' or '+' or '~') { combinator = s[_i]; _i++; Space(to); if (_i >= to) throw Fail("combinator without a compound"); }
                else if (spaced) combinator = ' ';
                else throw Fail($"unexpected '{s[_i]}'");
            }
            if (complex.Parts.Count == 0) throw Fail("empty selector");
            return complex;
        }

        private bool Space(int to)
        {
            var any = false;
            while (_i < to)
            {
                if (char.IsWhiteSpace(s[_i])) { _i++; any = true; continue; }
                if (s[_i] == '/' && _i + 1 < to && s[_i + 1] == '*')
                {
                    var end = s.IndexOf("*/", _i + 2, StringComparison.Ordinal);
                    _i = end < 0 || end + 2 > to ? to : end + 2; any = true; continue;
                }
                break;
            }
            return any;
        }

        private CompoundSelector Compound(int to)
        {
            var compound = new CompoundSelector { Start = _i };
            while (_i < to && !char.IsWhiteSpace(s[_i]) && s[_i] is not ('>' or '+' or '~' or ',') && !(s[_i] == '/' && _i + 1 < to && s[_i + 1] == '*'))
            {
                var start = _i; var c = s[_i];
                if (c == '*') { _i++; compound.Items.Add(new SimpleSelector { Kind = SimpleKind.Universal, Name = "*", Start = start, End = _i }); }
                else if (c == '&') { _i++; compound.Items.Add(new SimpleSelector { Kind = SimpleKind.Nesting, Name = "&", Start = start, End = _i }); }
                else if (c == '#') { _i++; var name = Ident(to); compound.Items.Add(new SimpleSelector { Kind = SimpleKind.Id, Name = name, Start = start, End = _i }); }
                else if (c == '.') { _i++; var name = Ident(to); compound.Items.Add(new SimpleSelector { Kind = SimpleKind.Class, Name = name, Start = start, End = _i }); }
                else if (c == '[') compound.Items.Add(Attribute(to));
                else if (c == ':') compound.Items.Add(Pseudo(to));
                else if (IdentStart(c) || c == '\\') { var name = Ident(to); compound.Items.Add(new SimpleSelector { Kind = SimpleKind.Type, Name = name.ToLowerInvariant(), Start = start, End = _i }); }
                else throw Fail($"unexpected '{c}'");
            }
            compound.End = _i;
            return compound;
        }

        private static bool IdentStart(char c) => char.IsLetter(c) || c == '_' || c == '-' || c >= 0x80;
        private static bool IdentChar(char c) => char.IsLetterOrDigit(c) || c == '_' || c == '-' || c >= 0x80;

        private string Ident(int to)
        {
            var sb = new StringBuilder();
            while (_i < to)
            {
                var c = s[_i];
                if (c == '\\' && _i + 1 < to)
                {
                    _i++;
                    var hex = 0; var value = 0;
                    while (hex < 6 && _i < to && Uri.IsHexDigit(s[_i])) { value = value * 16 + Convert.ToInt32(s[_i].ToString(), 16); _i++; hex++; }
                    if (hex > 0) { if (_i < to && s[_i] == ' ') _i++; sb.Append(char.ConvertFromUtf32(value is 0 or > 0x10FFFF ? 0xFFFD : value)); }
                    else { sb.Append(s[_i]); _i++; }
                    continue;
                }
                if (!IdentChar(c)) break;
                sb.Append(c); _i++;
            }
            if (sb.Length == 0) throw Fail("expected a name");
            return sb.ToString();
        }

        private SimpleSelector Attribute(int to)
        {
            var start = _i; _i++;
            Space(to);
            var name = Ident(to);
            if (_i < to && s[_i] == '|' && _i + 1 < to && s[_i + 1] != '=') { _i++; name = Ident(to); }   // namespace prefix
            Space(to);
            string? op = null; string? value = null; var ignoreCase = false;
            if (_i < to && s[_i] != ']')
            {
                if (s[_i] == '=') { op = "="; _i++; }
                else if (_i + 1 < to && s[_i + 1] == '=' && s[_i] is '~' or '|' or '^' or '$' or '*') { op = s[_i] + "="; _i += 2; }
                else throw Fail("bad attribute operator");
                Space(to);
                if (_i < to && s[_i] is '"' or '\'')
                {
                    var q = s[_i++]; var sb = new StringBuilder();
                    while (_i < to && s[_i] != q) { if (s[_i] == '\\' && _i + 1 < to) { _i++; } sb.Append(s[_i]); _i++; }
                    if (_i >= to) throw Fail("unterminated string");
                    _i++; value = sb.ToString();
                }
                else value = Ident(to);
                Space(to);
                if (_i < to && s[_i] is 'i' or 'I' or 's' or 'S') { ignoreCase = s[_i] is 'i' or 'I'; _i++; Space(to); }
            }
            if (_i >= to || s[_i] != ']') throw Fail("expected ']'");
            _i++;
            return new SimpleSelector { Kind = SimpleKind.Attribute, Name = name.ToLowerInvariant(), Op = op, Value = value, IgnoreCase = ignoreCase, Start = start, End = _i };
        }

        private SimpleSelector Pseudo(int to)
        {
            var start = _i; _i++;
            var element = false;
            if (_i < to && s[_i] == ':') { element = true; _i++; }
            var name = Ident(to).ToLowerInvariant();
            if (!element && LegacyPseudoElements.Contains(name)) element = true;
            var simple = new SimpleSelector { Kind = element ? SimpleKind.PseudoElement : SimpleKind.PseudoClass, Name = name, Start = start, End = _i };
            if (_i < to && s[_i] == '(')
            {
                var open = _i; var depth = 0; char? quote = null;
                for (; _i < to; _i++)
                {
                    var c = s[_i];
                    if (quote != null) { if (c == '\\') _i++; else if (c == quote) quote = null; continue; }
                    if (c is '"' or '\'') quote = c;
                    else if (c == '(') depth++;
                    else if (c == ')' && --depth == 0) break;
                }
                if (_i >= to) throw Fail("unbalanced parentheses");
                simple.ArgsStart = open + 1; simple.Args = s[(open + 1).._i];
                _i++; simple.End = _i;
                var resume = _i;
                if (!element && SelectorArguments.Contains(name))
                    simple.Selectors = List(open + 1, resume - 1, relative: name == "has");
                else if (!element && name.StartsWith("nth-", StringComparison.Ordinal))
                {
                    var args = simple.Args;
                    var of = OfKeyword(args);
                    if (of >= 0 && name is "nth-child" or "nth-last-child")
                    {
                        simple.Selectors = List(open + 1 + of + 2, resume - 1, relative: false);
                        args = args[..of];
                    }
                    if (TryNth(args, out var a, out var b)) { simple.NthA = a; simple.NthB = b; simple.HasNth = true; }
                }
                _i = resume;
            }
            return simple;
        }

        private static int OfKeyword(string args)
        {
            for (var k = 0; k + 2 <= args.Length; k++)
                if (string.Compare(args, k, "of", 0, 2, StringComparison.OrdinalIgnoreCase) == 0
                    && (k == 0 || char.IsWhiteSpace(args[k - 1])) && (k + 2 == args.Length || char.IsWhiteSpace(args[k + 2]))) return k;
            return -1;
        }
    }

    /// <summary>An+B of Selectors 3 ("odd", "even", "3", "-n+3", "2n + 1").</summary>
    public static bool TryNth(string text, out int a, out int b)
    {
        a = 0; b = 0;
        var t = new string(text.Where(c => !char.IsWhiteSpace(c)).ToArray()).ToLowerInvariant();
        if (t == "odd") { a = 2; b = 1; return true; }
        if (t == "even") { a = 2; b = 0; return true; }
        var n = t.IndexOf('n');
        if (n < 0) return int.TryParse(t, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out b);
        var head = t[..n];
        a = head switch { "" or "+" => 1, "-" => -1, _ => int.TryParse(head, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var v) ? v : int.MinValue };
        if (a == int.MinValue) return false;
        var tail = t[(n + 1)..];
        return tail.Length == 0 || int.TryParse(tail, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out b);
    }
}

// ---- the closed list of rewrites (4.1) -------------------------------------------------------------------------------

/// <summary>One recorded rewrite: the original text at <see cref="Offset"/> (length <see cref="Length"/>) became
/// <see cref="Replacement"/>. Outside these spans the rewritten sheet is the original byte for byte (<c>css.verbatim</c>).</summary>
public sealed record CssRewrite(IReadOnlyList<string> Kinds, int Offset, int Length, string Replacement, int Line, int Column, string From);

/// <summary>What the rewrites need from the compile lane and the runtime table.</summary>
public sealed record RewriteOptions
{
    public string Platform { get; init; } = "o11";
    /// <summary>Asset path of the capture ("assets/products.png") → module image URL (3.6).</summary>
    public IReadOnlyDictionary<string, string> AssetUrls { get; init; } = new Dictionary<string, string>();
    /// <summary>url() text as written in the sheet → asset path (the capture's <c>css.sheets[].urls</c>).</summary>
    public IReadOnlyDictionary<string, string> UrlAssets { get; init; } = new Dictionary<string, string>();
    public IReadOnlyDictionary<string, string> IdClasses { get; init; } = new Dictionary<string, string>();
    public IReadOnlySet<string> SubstitutedTags { get; init; } = new HashSet<string>();
    /// <summary>The runtime spans of the table (<see cref="RuntimeDomTable.RuntimeSpans"/>).</summary>
    public IReadOnlyList<string> RuntimeSpans { get; init; } = [];
    /// <summary>Given a compound (already rewritten, without positional pseudo-classes and pseudo-elements), the distinct chains
    /// of runtime wrappers (outermost first) around compiled elements it can match; empty when none (4.1 item 6).</summary>
    public Func<CompoundSelector, string, IReadOnlyList<IReadOnlyList<string>>>? Wrappers { get; init; }
}

/// <summary>A rewritten sheet: the text, every rewrite, the @import statements taken out for the top of the theme, the
/// declarations of <c>dialog::backdrop</c> rules (with their enclosing at-rules) for the popup adapter, and what could not be
/// parsed (kept verbatim, listed).</summary>
public sealed class SheetRewrite
{
    public string Text { get; init; } = "";
    public List<CssRewrite> Rewrites { get; } = [];
    public List<CssCompat.Import> Imports { get; } = [];
    public List<(IReadOnlyList<string> Enclosing, string Declarations)> Backdrops { get; } = [];
    public List<string> Unparsed { get; } = [];
    public List<string> UnmappedUrls { get; } = [];
}

/// <summary>
/// The closed list of CSS rewrites of the prototype importer (docs/PROTOTIPO-NATIVO.md, 4.1). Every rewrite keeps the original
/// specificity (:is() counts its most specific argument, :where() counts zero) and touches only its own span of text:
/// <list type="number">
/// <item>url() of a local asset → the module image URL (3.6);</item>
/// <item>top-level @import, from any line (a minified line of 27 thousand characters included) → taken out for the top of the
/// theme, found by the parser, never by a line regex;</item>
/// <item><c>#id</c> → <c>:is(#id, .ssam-id-&lt;id&gt;)</c>;</item>
/// <item>substituted tag T → <c>:is(T, :where(.ssam-tag-T))</c>, T[open] included; T::backdrop goes to item 8;</item>
/// <item><c>svg</c> → <c>:is(svg, :where(.ssam-icon))</c> and <c>span</c> → <c>span:not(:where(.ssam-icon, &lt;runtime spans&gt;))</c>;</item>
/// <item>wrapper-transparent combinators and positional pseudo-classes, where a compound can match a compiled element the runtime
/// wraps: <c>X &gt; Y</c> → <c>:is(X &gt; Y, X &gt; :where(W) &gt; Y)</c>, <c>Y:pc</c> → its variant <c>:where(W):pc &gt; Y</c>;</item>
/// <item><c>[type=submit]</c> → <c>:is([type=submit], :where(.ssam-submit))</c>;</item>
/// <item><c>dialog::backdrop</c> → its declarations on the popup backdrop (the adapters block); the rule itself stays as written.</item>
/// </list>
/// No scoping: :root, html, body, * and every other selector stay as in the browser.
/// </summary>
public static class PrototypeRewrites
{
    public const string AssetUrl = "asset-url", ImportHoist = "import-hoist", Id = "id", Tag = "tag", IconSvg = "icon-svg",
        IconSpan = "icon-span", Wrapper = "wrapper", Submit = "submit", Backdrop = "backdrop", Bom = "bom";

    /// <summary>The kinds in the order of the closed list (the receipt counts them in this order).</summary>
    public static readonly IReadOnlyList<string> Kinds = [AssetUrl, ImportHoist, Id, Tag, IconSvg, IconSpan, Wrapper, Submit, Backdrop, Bom];

    private sealed record Edit(int Offset, int Length, string Replacement, IReadOnlyList<string> Kinds);

    public static SheetRewrite Rewrite(string css, RewriteOptions options)
    {
        var edits = new List<Edit>();
        var result = new SheetRewriteBuilder(css, options, edits);
        if (css.Length > 0 && css[0] == '﻿') edits.Add(new Edit(0, 1, "", [Bom]));
        result.Walk(css.Length > 0 && css[0] == '﻿' ? 1 : 0, css.Length, [], topLevel: true);
        var ordered = edits.OrderBy(e => e.Offset).ToList();
        var sb = new StringBuilder(css.Length + 256);
        var at = 0;
        var output = new SheetRewrite { Text = "" };
        foreach (var edit in ordered)
        {
            sb.Append(css, at, edit.Offset - at).Append(edit.Replacement);
            var (line, column) = Position(css, edit.Offset);
            output.Rewrites.Add(new CssRewrite(edit.Kinds, edit.Offset, edit.Length, edit.Replacement, line, column, css.Substring(edit.Offset, edit.Length)));
            at = edit.Offset + edit.Length;
        }
        sb.Append(css, at, css.Length - at);
        var final = new SheetRewrite { Text = sb.ToString() };
        final.Rewrites.AddRange(output.Rewrites);
        final.Imports.AddRange(result.Imports);
        final.Backdrops.AddRange(result.Backdrops);
        final.Unparsed.AddRange(result.Unparsed);
        final.UnmappedUrls.AddRange(result.UnmappedUrls);
        return final;
    }

    /// <summary><c>css.verbatim</c>: the rewritten text is the original with exactly the recorded spans replaced, in order and
    /// without overlap; anything else (a byte lost, moved or added) is false.</summary>
    public static bool Verbatim(string original, string rewritten, IReadOnlyList<CssRewrite> rewrites)
    {
        var at = 0; var output = 0;
        foreach (var r in rewrites.OrderBy(r => r.Offset))
        {
            if (r.Offset < at || r.Offset + r.Length > original.Length) return false;
            var same = r.Offset - at;
            if (output + same > rewritten.Length || string.CompareOrdinal(original, at, rewritten, output, same) != 0) return false;
            output += same;
            if (string.CompareOrdinal(original, r.Offset, r.From, 0, r.Length) != 0) return false;
            if (output + r.Replacement.Length > rewritten.Length || string.CompareOrdinal(rewritten, output, r.Replacement, 0, r.Replacement.Length) != 0) return false;
            output += r.Replacement.Length;
            at = r.Offset + r.Length;
        }
        var rest = original.Length - at;
        return output + rest == rewritten.Length && string.CompareOrdinal(original, at, rewritten, output, rest) == 0;
    }

    /// <summary>The counts per kind, in the order of <see cref="Kinds"/>, kinds without rewrites left out.</summary>
    public static IReadOnlyList<(string Kind, int Count)> Counts(IEnumerable<CssRewrite> rewrites)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var r in rewrites) foreach (var k in r.Kinds) counts[k] = counts.GetValueOrDefault(k) + 1;
        return Kinds.Where(counts.ContainsKey).Select(k => (k, counts[k])).ToList();
    }

    /// <summary>One selector (not a list) rewritten by items 3 to 7, with the kinds applied; the text itself when none applies.
    /// <paramref name="backdrop"/> is true for a <c>dialog::backdrop</c> compound (item 8).</summary>
    public static string RewriteSelector(string selector, RewriteOptions options, List<string> kinds, out bool backdrop)
    {
        backdrop = false;
        ComplexSelector complex;
        try { complex = CssSelectors.ParseComplex(selector); }
        catch (FormatException) { kinds.Add("unparsed"); return selector; }
        var edits = new List<(int Start, int End, string Text, string Kind)>();
        var hasBackdrop = false;
        void Visit(ComplexSelector c)
        {
            foreach (var (_, compound) in c.Parts)
            {
                var isBackdrop = compound.Items.Any(s => s.Kind == SimpleKind.PseudoElement && s.Name == "backdrop");
                foreach (var s in compound.Items)
                {
                    var raw = selector[s.Start..s.End];
                    switch (s.Kind)
                    {
                        case SimpleKind.Id when s.Name != CssStylesheet.ReactContainer:
                            var cls = options.IdClasses.TryGetValue(s.Name, out var mapped) ? mapped : "ssam-id-" + s.Name;
                            edits.Add((s.Start, s.End, ":is(" + raw + ", ." + cls + ")", Id));
                            break;
                        case SimpleKind.Type when s.Name == "dialog" && isBackdrop:
                            hasBackdrop = true;
                            break;
                        case SimpleKind.Type when s.Name == "svg":
                            edits.Add((s.Start, s.End, ":is(" + raw + ", :where(.ssam-icon" + (options.SubstitutedTags.Contains("svg") ? ", .ssam-tag-svg" : "") + "))", IconSvg));
                            break;
                        case SimpleKind.Type when options.SubstitutedTags.Contains(s.Name) && !isBackdrop:
                            edits.Add((s.Start, s.End, ":is(" + raw + ", :where(.ssam-tag-" + s.Name + "))", Tag));
                            break;
                        case SimpleKind.Type when s.Name == "span":
                            edits.Add((s.End, s.End, ":not(:where(" + string.Join(", ", new[] { ".ssam-icon" }.Concat(options.RuntimeSpans)) + "))", IconSpan));
                            break;
                        case SimpleKind.Attribute when s.Name == "type" && s.Op == "=" && string.Equals(s.Value, "submit", StringComparison.OrdinalIgnoreCase):
                            edits.Add((s.Start, s.End, ":is(" + raw + ", :where(.ssam-submit))", Submit));
                            break;
                    }
                    if (s.Selectors != null) foreach (var inner in s.Selectors) Visit(inner);
                }
            }
        }
        Visit(complex);
        backdrop = hasBackdrop;
        if (hasBackdrop) kinds.Add(Backdrop);
        var text = selector;
        foreach (var e in edits.OrderByDescending(e => e.Start).ThenByDescending(e => e.End))
        {
            text = text[..e.Start] + e.Text + text[e.End..];
            kinds.Add(e.Kind);
        }
        if (options.Wrappers != null && !hasBackdrop)
        {
            var wrapped = WrapperTransparent(text, options.Wrappers);
            if (wrapped != text) { text = wrapped; kinds.Add(Wrapper); }
        }
        return text;
    }

    /// <summary>Item 6 on one selector. Left to right, each compound that follows a child or sibling combinator, or that carries
    /// a positional pseudo-class, and that can match a compiled element the runtime wraps, becomes
    /// <c>:is(P C Y, P C :where(W):pc &gt; Y')</c> where P is everything to its left (so the relation of P keeps holding),
    /// Y' is Y without its positional pseudo-classes and a pseudo-element stays outside the :is().</summary>
    public static string WrapperTransparent(string selector, Func<CompoundSelector, string, IReadOnlyList<IReadOnlyList<string>>> wrappers)
    {
        var text = selector; var from = 0;
        for (var guard = 0; guard < 64; guard++)
        {
            ComplexSelector complex;
            try { complex = CssSelectors.ParseComplex(text); } catch (FormatException) { return selector; }
            var changed = false;
            for (var j = from; j < complex.Parts.Count; j++)
            {
                var (combinator, y) = complex.Parts[j];
                var positional = y.Items.Where(CssSelectors.IsPositional).ToList();
                var related = j > 0 && combinator is '>' or '+' or '~';
                if (!related && positional.Count == 0) continue;
                var pseudoElements = y.Items.Where(s => s.Kind == SimpleKind.PseudoElement).ToList();
                if (pseudoElements.Count > 0 && j != complex.Parts.Count - 1) continue;
                string Without(IEnumerable<SimpleSelector> drop)
                {
                    var sb = new StringBuilder();
                    var skip = drop.ToHashSet();
                    foreach (var s in y.Items) if (!skip.Contains(s)) sb.Append(text, s.Start, s.End - s.Start);
                    return sb.ToString();
                }
                var core = Without(pseudoElements);
                var bare = Without(pseudoElements.Concat(positional));
                CompoundSelector probe;
                try { probe = CssSelectors.ParseComplex(bare.Length == 0 ? "*" : bare).Parts[0].Compound; } catch (FormatException) { continue; }
                var chains = wrappers(probe, bare.Length == 0 ? "*" : bare);
                if (chains.Count == 0) continue;
                var prefix = j > 0 ? text[complex.Parts[0].Compound.Start..complex.Parts[j - 1].Compound.End] : "";
                var joint = j > 0 ? (combinator == ' ' ? " " : " " + combinator + " ") : "";
                var positionalText = string.Concat(positional.Select(s => text[s.Start..s.End]));
                var alternatives = new List<string> { prefix + joint + core };
                foreach (var chain in chains)
                {
                    var sb = new StringBuilder();
                    sb.Append(prefix).Append(joint);
                    for (var w = 0; w < chain.Count; w++)
                    {
                        sb.Append(":where(").Append(chain[w]).Append(')');
                        if (w == 0) sb.Append(positionalText);
                        sb.Append(" > ");
                    }
                    sb.Append(bare.Length == 0 ? "*" : bare);
                    var alternative = sb.ToString();
                    if (!alternatives.Contains(alternative)) alternatives.Add(alternative);
                }
                var compound = ":is(" + string.Join(", ", alternatives) + ")" + string.Concat(pseudoElements.Select(s => text[s.Start..s.End]));
                var head = text[..complex.Parts[0].Compound.Start];
                text = head + compound + text[y.End..];
                from = 1;
                changed = true;
                break;
            }
            if (!changed) return text;
        }
        return text;
    }

    private static (int Line, int Column) Position(string text, int index)
    {
        int line = 1, column = 1;
        for (var i = 0; i < index && i < text.Length; i++) { if (text[i] == '\n') { line++; column = 1; } else column++; }
        return (line, column);
    }

    /// <summary>The walk over the sheet text: statements, nesting at-rules, opaque blocks and style rules; the edits are
    /// recorded against the original offsets.</summary>
    private sealed class SheetRewriteBuilder(string css, RewriteOptions options, List<Edit> edits)
    {
        public List<CssCompat.Import> Imports { get; } = [];
        public List<(IReadOnlyList<string> Enclosing, string Declarations)> Backdrops { get; } = [];
        public List<string> Unparsed { get; } = [];
        public List<string> UnmappedUrls { get; } = [];
        private bool _rule;

        public void Walk(int i, int end, IReadOnlyList<string> enclosing, bool topLevel)
        {
            while (i < end)
            {
                i = SkipTrivia(i, end);
                if (i >= end) return;
                if (css[i] == '}') { i++; continue; }   // a stray brace: the parser of the verification reports it
                var preludeEnd = PreludeEnd(i, end);
                if (preludeEnd >= end) return;
                if (css[preludeEnd] == '}') { i = preludeEnd; continue; }
                var prelude = css[i..preludeEnd];
                var trimmed = prelude.Trim();
                if (css[preludeEnd] == ';')
                {
                    if (topLevel && trimmed.StartsWith("@import", StringComparison.OrdinalIgnoreCase))
                    {
                        var stop = preludeEnd + 1;
                        if (stop < css.Length && css[stop] == '\r') stop++;
                        if (stop < css.Length && css[stop] == '\n') stop++;
                        var (line, column) = Position(css, i);
                        Imports.Add(new CssCompat.Import(css[i..(preludeEnd + 1)].Trim(), line, column, _rule));
                        edits.Add(new Edit(i, stop - i, "", [ImportHoist]));
                    }
                    i = preludeEnd + 1;
                    continue;
                }
                var blockStart = preludeEnd + 1;
                var blockEnd = BlockEnd(blockStart, end);   // just after the closing brace
                var inner = Math.Max(blockStart, blockEnd - 1);
                if (trimmed.StartsWith('@'))
                {
                    if (IsNesting(trimmed)) Walk(blockStart, inner, [.. enclosing, HtmlNode.CollapseSpaces(trimmed)], topLevel: false);
                    else if (trimmed.StartsWith("@font-face", StringComparison.OrdinalIgnoreCase)) Urls(blockStart, inner);
                    // @keyframes, @page, @property, @counter-style and the rest stay as written.
                }
                else
                {
                    Selectors(i, preludeEnd, blockStart, inner, enclosing);
                    Urls(blockStart, inner);
                }
                _rule = true;
                i = blockEnd;
            }
        }

        private static bool IsNesting(string prelude) =>
            prelude.StartsWith("@media", StringComparison.OrdinalIgnoreCase) || prelude.StartsWith("@supports", StringComparison.OrdinalIgnoreCase)
            || prelude.StartsWith("@container", StringComparison.OrdinalIgnoreCase) || prelude.StartsWith("@layer", StringComparison.OrdinalIgnoreCase)
            || prelude.StartsWith("@document", StringComparison.OrdinalIgnoreCase) || prelude.StartsWith("@scope", StringComparison.OrdinalIgnoreCase)
            || prelude.StartsWith("@starting-style", StringComparison.OrdinalIgnoreCase);

        private void Selectors(int from, int to, int blockStart, int blockEnd, IReadOnlyList<string> enclosing)
        {
            var depth = 0; var start = from; char? quote = null; var backdrop = false;
            void Part(int a, int b)
            {
                var raw = css[a..b];
                var lead = raw.Length - raw.TrimStart().Length;
                var selector = raw.Trim();
                if (selector.Length == 0) return;
                var kinds = new List<string>();
                var written = RewriteSelector(selector, options, kinds, out var isBackdrop);
                backdrop |= isBackdrop;
                if (kinds.Remove("unparsed")) Unparsed.Add(HtmlNode.CollapseSpaces(selector));
                if (written != selector) edits.Add(new Edit(a + lead, selector.Length, written, kinds));
                else if (isBackdrop) edits.Add(new Edit(a + lead, 0, "", [Backdrop]));
            }
            for (var k = from; k < to; k++)
            {
                var c = css[k];
                if (quote != null) { if (c == '\\') k++; else if (c == quote) quote = null; continue; }
                if (c == '/' && k + 1 < to && css[k + 1] == '*') { var close = css.IndexOf("*/", k + 2, StringComparison.Ordinal); k = close < 0 ? to : close + 1; continue; }
                if (c is '"' or '\'') quote = c;
                else if (c == '\\') k++;
                else if (c is '(' or '[') depth++;
                else if (c is ')' or ']') depth--;
                else if (c == ',' && depth == 0) { Part(start, k); start = k + 1; }
            }
            Part(start, to);
            if (backdrop) Backdrops.Add((enclosing, css[blockStart..blockEnd]));
        }

        /// <summary>url(…) of a local asset in a declaration block → the module image URL, keeping the quotes as written.</summary>
        private void Urls(int from, int to)
        {
            var i = from;
            while (i < to)
            {
                var c = css[i];
                if (c == '/' && i + 1 < to && css[i + 1] == '*') { var close = css.IndexOf("*/", i + 2, StringComparison.Ordinal); i = close < 0 ? to : close + 2; continue; }
                if (c is '"' or '\'') { var q = c; i++; while (i < to && css[i] != q) i += css[i] == '\\' ? 2 : 1; i++; continue; }
                if ((c is 'u' or 'U') && i + 4 <= to && string.Compare(css, i, "url(", 0, 4, StringComparison.OrdinalIgnoreCase) == 0
                    && (i == from || !(char.IsLetterOrDigit(css[i - 1]) || css[i - 1] is '-' or '_')))
                {
                    var open = i + 4; var k = open;
                    while (k < to && char.IsWhiteSpace(css[k])) k++;
                    int valueStart, valueEnd, close;
                    if (k < to && css[k] is '"' or '\'')
                    {
                        var q = css[k]; valueStart = k + 1; var m = valueStart;
                        while (m < to && css[m] != q) m += css[m] == '\\' ? 2 : 1;
                        valueEnd = Math.Min(m, to); close = css.IndexOf(')', Math.Min(m + 1, to));
                    }
                    else { valueStart = k; close = css.IndexOf(')', k); valueEnd = close < 0 ? to : close; while (valueEnd > valueStart && char.IsWhiteSpace(css[valueEnd - 1])) valueEnd--; }
                    if (close < 0 || close > to) return;
                    var raw = css[valueStart..valueEnd];
                    if (Resolve(raw) is { } url) edits.Add(new Edit(valueStart, valueEnd - valueStart, url, [AssetUrl]));
                    else if (!raw.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && !raw.Contains("://", StringComparison.Ordinal) && !raw.StartsWith('#') && raw.Length > 0 && !raw.StartsWith("//", StringComparison.Ordinal))
                        UnmappedUrls.Add(raw);
                    i = close + 1;
                    continue;
                }
                i++;
            }
        }

        private string? Resolve(string raw)
        {
            if (options.UrlAssets.TryGetValue(raw, out var asset) && options.AssetUrls.TryGetValue(asset, out var url)) return url;
            var normalized = raw.StartsWith("./", StringComparison.Ordinal) ? raw[2..] : raw;
            var hash = normalized.IndexOfAny(['?', '#']);
            if (hash >= 0) normalized = normalized[..hash];
            return options.AssetUrls.TryGetValue(normalized, out var direct) ? direct : null;
        }

        private int SkipTrivia(int i, int end)
        {
            while (i < end)
            {
                if (char.IsWhiteSpace(css[i])) { i++; continue; }
                if (css[i] == '/' && i + 1 < end && css[i + 1] == '*') { var close = css.IndexOf("*/", i + 2, StringComparison.Ordinal); i = close < 0 ? end : close + 2; continue; }
                if (css[i] == '<' && string.CompareOrdinal(css, i, "<!--", 0, 4) == 0) { i += 4; continue; }
                if (css[i] == '-' && string.CompareOrdinal(css, i, "-->", 0, 3) == 0) { i += 3; continue; }
                break;
            }
            return i;
        }

        private int PreludeEnd(int i, int end)
        {
            var depth = 0;
            while (i < end)
            {
                var c = css[i];
                if (c == '/' && i + 1 < end && css[i + 1] == '*') { var close = css.IndexOf("*/", i + 2, StringComparison.Ordinal); i = close < 0 ? end : close + 2; continue; }
                if (c is '"' or '\'') { var q = c; i++; while (i < end && css[i] != q) i += css[i] == '\\' ? 2 : 1; i++; continue; }
                if (c == '\\') { i += 2; continue; }
                if (c is '(' or '[') depth++;
                else if (c is ')' or ']') depth--;
                else if (depth == 0 && c is '{' or ';' or '}') return i;
                i++;
            }
            return end;
        }

        private int BlockEnd(int i, int end)
        {
            var depth = 0;
            while (i < end)
            {
                var c = css[i];
                if (c == '/' && i + 1 < end && css[i + 1] == '*') { var close = css.IndexOf("*/", i + 2, StringComparison.Ordinal); i = close < 0 ? end : close + 2; continue; }
                if (c is '"' or '\'') { var q = c; i++; while (i < end && css[i] != q) i += css[i] == '\\' ? 2 : 1; i++; continue; }
                if (c == '\\') { i += 2; continue; }
                if (c == '{') depth++;
                else if (c == '}') { if (depth == 0) return i + 1; depth--; }
                i++;
            }
            return end;
        }
    }
}
