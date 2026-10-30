using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Anvil.Core.CssTokenizer;

namespace Anvil.Core;

/// <summary>
/// R2-D (the owner's decision of 2026-10-28): the stage "shadowed" of <see cref="CssPipeline"/>, which changes the result in no
/// browser. Since the third round of the review it compares TOKEN STREAMS of one CSS Syntax Level 3 tokenizer
/// (<see cref="CssTokenizer"/>), never normalized text. Two selector lists, two at-rule preludes or two values are equal only
/// when their tokens are, after the only normalizations that change nothing a browser reads: comments removed (the tokenizer
/// drops them), each run of whitespace one whitespace token, whitespace dropped next to a comma or a combinator at the TOP level
/// of a selector (never inside () or []) and at the ends, ASCII-only case folding of property names, at-keywords and CSS-wide
/// keywords, escapes compared by the code point they stand for. A style rule R1 goes when a LATER rule R2 has the same selector
/// list and the same context of at-rules (@media, @supports, @container and a named @layer, in order) and, for EVERY
/// declaration of R1, a declaration of the same property, with an importance at least as high, that every browser applying
/// R1's applies too (<see cref="Covers"/>): the same tokens, the same tokens but for what their urls name, a valid
/// &lt;declaration-value&gt; of the same custom property, or a CSS-wide keyword. A declaration whose value does not tokenize
/// cleanly (a bad string, a bad url, an unmatched bracket) never covers anything. Never touched: @keyframes, @font-face,
/// @import, any other at-rule block, the rules of an anonymous @layer, of @scope or of @starting-style. A sheet this reader and
/// the parser do not both read whole is left as written. Each removal is said in cssStages: {stage:"shadowed", removed, rules
/// (context and selectors, at most 20), more, bytesBefore, bytesAfter}. Pure.
/// </summary>
public static class CssShadowedRules
{
    public const string Stage = "shadowed";

    /// <summary>One declaration: the property as the cascade compares it, the key of its value's tokens (null: the value does
    /// not tokenize cleanly, so it covers nothing), !important, the value's tokens, whether it is a valid
    /// &lt;declaration-value&gt; (a custom property needs it) and its raw text (for the multiset of <see cref="Diff"/>).</summary>
    internal sealed record Declaration(string Property, string? Value, bool Important, IReadOnlyList<Token> Tokens, bool DeclarationValue, string Raw);

    /// <summary>One item of a sheet: a style rule ("rule"), an opaque at-rule block ("block"), a statement ("statement"), a
    /// conditional group (@media, @supports, @container: "group", which goes when the stage empties it) or another nesting
    /// at-rule ("nest": @layer, @scope..., never removed: an empty named layer still orders the layers), with its span in the
    /// text ([Start, End)), its context of at-rules (token keys), its key (the selector list's tokens for a rule), the index of
    /// the group it is in (-1: the top) and how it is named to a person (<see cref="Display"/>, <see cref="Where"/>).
    /// <see cref="Comparable"/>: a rule whose cascade this stage knows and whose selectors tokenize cleanly.</summary>
    internal sealed record Item(int Start, int End, string Kind, string Context, string Key, bool Comparable, IReadOnlyList<Declaration> Declarations,
        int Parent, string Display, string Where);

    /// <summary>The stage as <see cref="CssPipeline.Register"/> takes it: the text without its shadowed rules (null: unchanged).</summary>
    public static string? Normalize(string css, CssPipeline.Context context, List<JsonObject> changes)
    {
        var (text, removed, names) = Remove(css);
        if (removed == 0) return null;
        var change = new JsonObject
        {
            ["stage"] = Stage, ["removed"] = removed,
            ["bytesBefore"] = Encoding.UTF8.GetByteCount(css), ["bytesAfter"] = Encoding.UTF8.GetByteCount(text),
        };
        Listed(change, "rules", "more", names);
        changes.Add(change);
        return text;
    }

    /// <summary>Puts at most <see cref="NamesListed"/> names in <paramref name="key"/> and the count of the others in
    /// <paramref name="moreKey"/>.</summary>
    internal static void Listed(JsonObject into, string key, string moreKey, IReadOnlyList<string> names)
    {
        if (names.Count == 0) return;
        into[key] = new JsonArray(names.Take(NamesListed).Select(n => (JsonNode)n).ToArray());
        if (names.Count > NamesListed) into[moreKey] = names.Count - NamesListed;
    }

    /// <summary>At most this many names are listed; the rest is a count.</summary>
    public const int NamesListed = 20;

    /// <summary>The text without the rules a later rule shadows, how many went and their names (context and selectors, in the
    /// order of the sheet). The text itself (0) when none goes or when the sheet is not read whole.</summary>
    public static (string Css, int Removed, List<string> Names) Remove(string css)
    {
        if (string.IsNullOrEmpty(css)) return (css ?? "", 0, []);
        var items = Read(css);
        if (items == null) return (css, 0, []);
        var later = new Dictionary<string, List<Item>>(StringComparer.Ordinal);
        var gone = new HashSet<int>();
        // From the end: each rule is judged against the rules after it with its selector list and context.
        for (var k = items.Count - 1; k >= 0; k--)
        {
            var rule = items[k];
            if (rule.Kind != "rule" || !rule.Comparable) continue;
            var key = rule.Context + "\u0001" + rule.Key;
            if (!later.TryGetValue(key, out var after)) later[key] = after = [];
            if (after.Any(r2 => Covers(r2, rule))) gone.Add(k);
            after.Add(rule);
        }
        if (gone.Count == 0) return (css, 0, []);
        var removed = gone.Count;
        var names = gone.OrderBy(k => k).Select(k => Name(items[k])).ToList();
        // A conditional group the removals emptied goes with them (an empty @media styles nothing).
        var childrenOf = Enumerable.Range(0, items.Count).Where(c => items[c].Parent >= 0).GroupBy(c => items[c].Parent).ToDictionary(g => g.Key, g => g.ToList());
        for (var changed = true; changed;)
        {
            changed = false;
            foreach (var (g, children) in childrenOf)
                if (items[g].Kind == "group" && !gone.Contains(g) && children.All(gone.Contains)) { gone.Add(g); changed = true; }
        }
        var text = new StringBuilder(css);
        foreach (var k in gone.Where(k => items[k].Parent < 0 || !gone.Contains(items[k].Parent)).OrderByDescending(k => items[k].Start))
        {
            var (start, end) = Span(css, items[k]);
            text.Remove(start, end - start);
        }
        var result = text.ToString();
        // The result is read again: the same items but the removed ones, or the sheet stays as written.
        var again = Read(result);
        if (again == null || again.Count != items.Count - gone.Count) return (css, 0, []);
        return (result, removed, names);
    }

    /// <summary>The rules added and removed between two sheets, as multisets of rules (context, selector list and declarations;
    /// a block or a statement by its tokens): what a write of a whole sheet brings and takes. Null when a sheet is not read.</summary>
    public static (int Added, int Removed, List<string> RemovedNames)? Diff(string? before, string? after)
    {
        var a = Blank(before) ? [] : Read(before!)?.Where(Counted).ToList();
        var b = Blank(after) ? [] : Read(after!)?.Where(Counted).ToList();
        if (a == null || b == null) return null;
        var left = a.GroupBy(Whole).ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
        var added = 0;
        foreach (var item in b)
        {
            var key = Whole(item);
            if (left.TryGetValue(key, out var n) && n > 0) left[key] = n - 1; else added++;
        }
        // The rules of the sheet before that the sheet after does not have, named in the order of the sheet before.
        var names = new List<string>();
        foreach (var item in a)
        {
            var key = Whole(item);
            if (left.TryGetValue(key, out var n) && n > 0) { left[key] = n - 1; names.Add(Name(item)); }
        }
        return (added, names.Count, names);
    }

    /// <summary>The number of rules of a sheet (style rules, blocks and statements), or null when it is not read.</summary>
    public static int? Count(string? css) => Blank(css) ? 0 : Read(css!)?.Count(Counted);

    // A rule, a block or a statement (a group is the context of its rules, not a rule).
    private static bool Counted(Item item) => item.Kind is "rule" or "block" or "statement";

    private static string Whole(Item item) => item.Kind != "rule" ? item.Kind + "\u0001" + item.Context + "\u0001" + item.Key
        : "rule\u0001" + item.Context + "\u0001" + item.Key + "{" + string.Join(";", item.Declarations.Select(d =>
            d.Property.Length + ":" + d.Property + "=" + (d.Value ?? "raw:" + d.Raw) + (d.Important ? "!" : ""))) + "}";

    /// <summary>How a removed rule is named in cssStages and styleSheet: its context of at-rules and its selector list.</summary>
    internal static string Name(Item item)
    {
        var what = item.Kind == "rule" ? item.Display : item.Display.Length > 80 ? item.Display[..79] + "…" : item.Display;
        return item.Where.Length == 0 ? what : item.Where + " " + what;
    }

    // The span a removed rule takes: the rule, then the spaces after it up to and including the line break; and when the rule
    // starts its line, the indentation before it (the whole line goes).
    private static (int Start, int End) Span(string css, Item rule)
    {
        var end = rule.End;
        while (end < css.Length && css[end] is ' ' or '\t') end++;
        if (end < css.Length && css[end] == '\r') end++;
        if (end < css.Length && css[end] == '\n') end++;
        var start = rule.Start;
        var lineStart = start;
        while (lineStart > 0 && css[lineStart - 1] is ' ' or '\t') lineStart--;
        if ((lineStart == 0 || css[lineStart - 1] == '\n') && (end == css.Length || css[end - 1] == '\n')) start = lineStart;
        return (start, end);
    }

    // ---- the cascade --------------------------------------------------------------------------------------------------

    // The strict rule: R2 (later, same selector list and context) covers R1 only when, for each declaration of R1, R2 declares
    // the property with an importance at least as high and a value every browser applying R1's applies too.
    private static bool Covers(Item r2, Item r1)
    {
        foreach (var d1 in r1.Declarations)
            if (!r2.Declarations.Any(d2 => d2.Property == d1.Property && (d2.Important || !d1.Important) && Applies(d1, d2)))
                return false;
        return true;
    }

    // Whether a browser that applies d1 also applies d2: (a) the same tokens; (b) the same tokens but for what their urls name;
    // (c) a non-empty valid <declaration-value> of the same custom property; (d) a CSS-wide keyword. A value that does not
    // tokenize cleanly covers nothing, and nothing covers it.
    private static bool Applies(Declaration d1, Declaration d2)
    {
        if (d1.Value == null || d2.Value == null) return false;
        var custom = d1.Property.StartsWith("--", StringComparison.Ordinal);
        if (custom) return d2.DeclarationValue && (d2.Value == d1.Value || d2.Tokens.Count > 0);
        if (d2.Value == d1.Value) return true;
        if (d2.Tokens is [{ Kind: Kind.Ident } only] && AsciiLower(only.Value) is "inherit" or "initial" or "unset") return true;
        return UrlKey(d1.Tokens) is { } a && UrlKey(d2.Tokens) is { } b && a == b;
    }

    // The tokens with each url (a url token, or url( with one string) as one mark; null when the value has none.
    private static string? UrlKey(IReadOnlyList<Token> tokens)
    {
        var marked = new List<Token>();
        var any = false;
        for (var i = 0; i < tokens.Count; i++)
        {
            var t = tokens[i];
            if (t.Kind == Kind.Url) { marked.Add(new Token(Kind.Url, "")); any = true; continue; }
            if (t.Kind == Kind.Function && AsciiLower(t.Value) == "url")
            {
                var j = i + 1;
                while (j < tokens.Count && tokens[j].Kind == Kind.Whitespace) j++;
                var k = j + 1;
                while (k < tokens.Count && tokens[k].Kind == Kind.Whitespace) k++;
                if (j < tokens.Count && tokens[j].Kind == Kind.String && k < tokens.Count && tokens[k].Kind == Kind.CloseParen)
                {
                    marked.Add(new Token(Kind.Url, "")); any = true; i = k; continue;
                }
            }
            marked.Add(t);
        }
        return any ? Key(marked) : null;
    }

    // ---- keys -----------------------------------------------------------------------------------------------------------

    // CSS whitespace (CSS Syntax 3, 4.2): space, tab, line feed, carriage return and form feed, nothing else.
    internal static bool IsCssSpace(char c) => c is ' ' or '\t' or '\n' or '\r' or '\f';

    internal static string TrimCss(string text)
    {
        int start = 0, end = text.Length;
        while (start < end && IsCssSpace(text[start])) start++;
        while (end > start && IsCssSpace(text[end - 1])) end--;
        return start == 0 && end == text.Length ? text : text[start..end];
    }

    private static bool Blank(string? text) => text == null || text.All(IsCssSpace);
    private static readonly Regex Spaces = new("[ \t\n\r\f]+", RegexOptions.Compiled);

    // How a selector or a prelude is shown to a person: as written, its runs of CSS whitespace one space.
    private static string Shown(string raw) => TrimCss(Spaces.Replace(raw, " "));

    // The tokens without whitespace at the ends, each run of whitespace tokens (a comment between two spaces leaves two) one.
    private static List<Token> Trimmed(List<Token> tokens)
    {
        var start = 0; var end = tokens.Count;
        while (start < end && tokens[start].Kind == Kind.Whitespace) start++;
        while (end > start && tokens[end - 1].Kind == Kind.Whitespace) end--;
        var kept = new List<Token>(end - start);
        for (var i = start; i < end; i++)
            if (!(tokens[i].Kind == Kind.Whitespace && kept.Count > 0 && kept[^1].Kind == Kind.Whitespace)) kept.Add(tokens[i]);
        return kept;
    }

    /// <summary>The key of a selector list: its tokens, without the whitespace next to a comma or a combinator (&gt; + ~) at the
    /// top level (never inside () or []) and at the ends. Null when it does not tokenize cleanly.</summary>
    internal static string? SelectorKey(string raw)
    {
        var result = Tokenize(raw);
        if (!result.Clean) return null;
        var tokens = Trimmed(result.Tokens);
        var depth = 0;
        var depths = new int[tokens.Count];
        for (var i = 0; i < tokens.Count; i++)
        {
            var t = tokens[i];
            if (t.Kind is Kind.CloseParen or Kind.CloseSquare or Kind.CloseCurly) depth--;
            depths[i] = depth;
            if (t.Kind is Kind.OpenParen or Kind.Function or Kind.OpenSquare or Kind.OpenCurly) depth++;
            if (depth < 0) return null;
        }
        if (depth != 0) return null;
        static bool Joint(Token t) => t.Kind == Kind.Comma || t.IsDelim('>') || t.IsDelim('+') || t.IsDelim('~');
        var kept = new List<Token>();
        for (var i = 0; i < tokens.Count; i++)
        {
            if (tokens[i].Kind == Kind.Whitespace && depths[i] == 0
                && (i > 0 && depths[i - 1] == 0 && Joint(tokens[i - 1]) || i + 1 < tokens.Count && depths[i + 1] == 0 && Joint(tokens[i + 1])))
                continue;
            kept.Add(tokens[i]);
        }
        return Key(kept);
    }

    /// <summary>The key of an at-rule prelude: its tokens, trimmed, the at-keyword folded to ASCII lower case; whitespace
    /// anywhere else stays (one token per run). Null when it does not tokenize cleanly.</summary>
    internal static string? PreludeKey(string raw)
    {
        var result = Tokenize(raw);
        if (!result.Clean) return null;
        var tokens = Trimmed(result.Tokens);
        if (tokens.Count > 0 && tokens[0].Kind == Kind.AtKeyword) tokens[0] = tokens[0] with { Value = AsciiLower(tokens[0].Value) };
        return Key(tokens);
    }

    // The at-keyword a prelude starts with ("@media"), ASCII lower case; "" when it starts with none.
    private static string AtName(string raw)
    {
        var tokens = Trimmed(Tokenize(raw).Tokens);
        return tokens.Count > 0 && tokens[0].Kind == Kind.AtKeyword ? "@" + AsciiLower(tokens[0].Value) : "";
    }

    // A declaration from its raw name and value: the property (a custom one as written, any other in ASCII lower case), the
    // value's tokens without the final !important and the whitespace at the ends, and whether they are clean.
    private static Declaration Declare(string rawName, string rawValue)
    {
        var raw = rawName + ":" + rawValue;
        var name = Trimmed(Tokenize(rawName) is { Clean: true } n ? n.Tokens : []);
        var property = name is [{ Kind: Kind.Ident } ident] ? ident.Value.StartsWith("--", StringComparison.Ordinal) ? ident.Value : AsciiLower(ident.Value) : "\u0000" + rawName;
        var result = Tokenize(rawValue);
        var tokens = Trimmed(result.Tokens);
        var important = false;
        if (tokens.Count >= 2 && tokens[^1].Kind == Kind.Ident && AsciiLower(tokens[^1].Value) == "important")
        {
            var j = tokens.Count - 2;
            while (j >= 0 && tokens[j].Kind == Kind.Whitespace) j--;
            if (j >= 0 && tokens[j].IsDelim('!')) { important = true; tokens = Trimmed(tokens.GetRange(0, j)); }
        }
        // Brackets matched (a function opens one), and for a <declaration-value> no "!" at the top level.
        var stack = new Stack<Kind>();
        var balanced = true;
        var topBang = false;
        foreach (var t in tokens)
        {
            if (t.Kind is Kind.OpenParen or Kind.Function) stack.Push(Kind.CloseParen);
            else if (t.Kind == Kind.OpenSquare) stack.Push(Kind.CloseSquare);
            else if (t.Kind == Kind.OpenCurly) stack.Push(Kind.CloseCurly);
            else if (t.Kind is Kind.CloseParen or Kind.CloseSquare or Kind.CloseCurly)
            {
                if (stack.Count == 0 || stack.Pop() != t.Kind) { balanced = false; break; }
            }
            else if (stack.Count == 0 && (t.IsDelim('!') || t.Kind == Kind.Semicolon)) topBang = true;
        }
        var clean = result.Clean && balanced && stack.Count == 0 && !property.StartsWith('\u0000');
        return new Declaration(property, clean ? Key(tokens) : null, important, tokens, clean && !topBang, raw);
    }

    // ---- the reader ---------------------------------------------------------------------------------------------------

    /// <summary>The items of a sheet in order, or null when it is not read whole here AND by the parser (CssStylesheet, lenient):
    /// the same style rules, in the same order, with as many declarations.</summary>
    internal static List<Item>? Read(string css)
    {
        List<Item> items;
        try { items = new Reader(css).Sheet(); }
        catch (FormatException) { return null; }
        CssStylesheet parsed;
        try { parsed = CssStylesheet.Parse(css, lenient: true); }
        catch (InvalidOperationException) { return null; }
        var rules = items.Where(i => i.Kind == "rule").ToList();
        if (rules.Count != parsed.Rules.Count) return null;
        for (var k = 0; k < rules.Count; k++)
            if (rules[k].Declarations.Count != parsed.Rules[k].Declarations.Count) return null;
        return items;
    }

    private sealed class Reader(string text)
    {
        private int _i;
        private int _anonymous;
        private readonly List<Item> _items = [];
        private bool End => _i >= text.Length;
        private char At(int ahead = 0) => _i + ahead < text.Length ? text[_i + ahead] : '\0';
        private static FormatException Stop() => new("not read whole");

        public List<Item> Sheet() { Block("", "", comparable: true, depth: 0, parent: -1); return _items; }

        private void Block(string context, string where, bool comparable, int depth, int parent)
        {
            while (true)
            {
                Trivia();
                if (End) { if (depth > 0) throw Stop(); return; }
                if (At() == '}') { if (depth == 0) throw Stop(); _i++; return; }
                var start = _i;
                var parens = 0;
                while (!End)
                {
                    var c = At();
                    if (c == '/' && At(1) == '*') { Comment(); continue; }
                    if (c is '"' or '\'') { Quoted(); continue; }
                    if (c == '\\') { _i += 2; continue; }
                    if (c == '(') parens++;
                    else if (c == ')') parens--;
                    else if (parens == 0 && c is '{' or ';') break;
                    else if (c == '}') throw Stop();
                    _i++;
                }
                if (End) throw Stop();
                var raw = text[start.._i];
                var prelude = TrimCss(raw);
                if (At() == ';')
                {
                    _i++;
                    if (!prelude.StartsWith('@')) throw Stop();
                    _items.Add(new Item(start, _i, "statement", context, PreludeKey(raw) ?? "raw:" + prelude, false, [], parent, Shown(raw), where));
                    continue;
                }
                _i++; // '{'
                if (prelude.StartsWith('@'))
                {
                    var name = AtName(raw);
                    var key = PreludeKey(raw);
                    if (name is "@media" or "@supports" or "@container" or "@layer" or "@scope" or "@starting-style" or "@document")
                    {
                        // An anonymous @layer is a layer of its own each time; @scope and its kind change the cascade; a prelude
                        // that does not tokenize cleanly is not known: their rules are never compared.
                        var anonymous = name == "@layer" && Trimmed(Tokenize(raw).Tokens).Count == 1;
                        var known = name is "@media" or "@supports" or "@container" or "@layer" && !anonymous && key != null;
                        var group = _items.Count;
                        _items.Add(new Item(start, -1, name is "@media" or "@supports" or "@container" ? "group" : "nest", context, key ?? "raw:" + prelude, false, [], parent, Shown(raw), where));
                        Block(context + "\u0002" + (anonymous ? "@layer#" + (++_anonymous) : key ?? "raw#" + (++_anonymous)),
                            (where.Length == 0 ? "" : where + " ") + (anonymous ? "@layer" : Shown(raw)), comparable && known, depth + 1, group);
                        _items[group] = _items[group] with { End = _i };
                    }
                    else
                    {
                        // @keyframes, @font-face, @page, @property and any other at-rule block: taken whole, never touched.
                        var body = _i;
                        Opaque();
                        var bodyKey = Tokenize(text[body..(_i - 1)]) is { Clean: true } b ? Key(Trimmed(b.Tokens)) : "raw:" + text[body..(_i - 1)];
                        _items.Add(new Item(start, _i, "block", context, (key ?? "raw:" + prelude) + "{" + bodyKey + "}", false, [], parent, Shown(raw), where));
                    }
                    continue;
                }
                var declarations = Declarations();
                var selectors = SelectorKey(raw);
                _items.Add(new Item(start, _i, "rule", context, selectors ?? "raw:" + raw, comparable && selectors != null, declarations, parent, Shown(raw), where));
            }
        }

        private List<Declaration> Declarations()
        {
            var list = new List<Declaration>();
            while (true)
            {
                Trivia();
                if (End) throw Stop();
                if (At() == '}') { _i++; return list; }
                if (At() == ';') { _i++; continue; }
                var nameStart = _i;
                while (!End && At() is not (':' or ';' or '}' or '{' or '"' or '\'')) _i++;
                if (End || At() != ':') throw Stop();   // CSS nesting, a declaration without a value: not read here
                var rawName = text[nameStart.._i];
                if (TrimCss(rawName).Length == 0 || rawName.Contains("/*", StringComparison.Ordinal)) throw Stop();
                _i++;
                var valueStart = _i;
                var parens = 0;
                while (!End)
                {
                    var c = At();
                    if (c == '/' && At(1) == '*') { Comment(); continue; }
                    if (c is '"' or '\'') { Quoted(); continue; }
                    if (c == '\\') { _i += 2; continue; }
                    if (c == '(') parens++;
                    else if (c == ')') parens--;
                    else if (parens == 0 && c is ';' or '}') break;
                    else if (c == '{') throw Stop();
                    _i++;
                }
                if (End || parens != 0) throw Stop();
                list.Add(Declare(rawName, text[valueStart.._i]));
            }
        }

        private void Opaque()
        {
            var depth = 0;
            while (true)
            {
                if (End) throw Stop();
                var c = At();
                if (c == '/' && At(1) == '*') { Comment(); continue; }
                if (c is '"' or '\'') { Quoted(); continue; }
                if (c == '\\') { _i += 2; continue; }
                _i++;
                if (c == '{') depth++;
                else if (c == '}') { if (depth == 0) return; depth--; }
            }
        }

        private void Quoted()
        {
            var q = At();
            _i++;
            while (!End && At() != q) _i += At() == '\\' ? 2 : 1;
            if (End) throw Stop();
            _i++;
        }

        private void Comment()
        {
            var end = text.IndexOf("*/", _i + 2, StringComparison.Ordinal);
            if (end < 0) throw Stop();
            _i = end + 2;
        }

        private void Trivia()
        {
            while (!End)
            {
                // CSS whitespace; a byte order mark only where the sheet starts.
                if (IsCssSpace(At()) || _i == 0 && At() == '﻿') { _i++; continue; }
                if (At() == '/' && At(1) == '*') { Comment(); continue; }
                return;
            }
        }
    }
}
