using System.Text;
namespace Anvil.Core;

public sealed record CssDeclaration(string Property, string Value, bool Important);
/// <summary>One rule: its selector text as written, the enclosing at-rule prelude (a media query, or null) and its declarations.</summary>
public sealed record CssRule(string Selector, string? AtRule, IReadOnlyList<CssDeclaration> Declarations, int Line, int Column)
{
    public IReadOnlyList<string> EnclosingRules { get; init; } = AtRule == null ? [] : [AtRule];
}

/// <summary>An at-rule whose block is not a list of rules (@keyframes, @font-face): kept verbatim, never scoped. A keyframe
/// name is global, as in the browser; <paramref name="Body"/> is the text between the braces, as written.</summary>
public sealed record CssBlock(string Prelude, string Body, IReadOnlyList<string> EnclosingRules, int Line, int Column);

/// <summary>
/// Parser for the authored stylesheet: comments, nested at-rules (@media, @supports, @container, @layer), statement at-rules
/// (@import, @charset), opaque block at-rules (@keyframes, @font-face), selectors and declaration blocks. Strings,
/// parentheses and escapes are honoured so ';' and '}' inside url() or a quoted value never split a declaration. The
/// stylesheet text itself is preserved verbatim by the caller; this structure exists to validate class references and to
/// report unbalanced or malformed CSS with a position.
/// </summary>
public sealed class CssStylesheet
{
    public static void RequireRenderableInline(string value)
    {
        if(System.Text.RegularExpressions.Regex.IsMatch(value,@"--[A-Za-z_][A-Za-z0-9_-]*\s*:"))
            throw new InvalidOperationException("inline CSS custom properties are not supported by the O11 renderer; bind the concrete property (e.g. width/background-color), or declare CSS variables in the stylesheet");
    }
    /// <summary>The id of the element the Reactive runtime renders the app in: the platform's, never an authored widget id.
    /// The Studio canvas has no such element, so a selector that starts with it is written <see cref="CanvasRoot"/>.</summary>
    public const string ReactContainer = "reactContainer";
    public const string CanvasRoot = ":is(#reactContainer, body)";
    public IReadOnlyList<CssRule> Rules { get; }
    public IReadOnlyList<string> Statements { get; }
    public IReadOnlyList<CssBlock> Blocks { get; }
    private CssStylesheet(List<CssRule> rules, List<string> statements, List<CssBlock>? blocks = null) { Rules = rules; Statements = statements; Blocks = blocks ?? []; }

    /// <summary>Every class name selected anywhere in the stylesheet (".metric" -> "metric"), in first-seen order.</summary>
    public IReadOnlyList<string> ClassNames()
    {
        var seen = new List<string>();
        foreach (var rule in Rules)
            foreach (var name in Classes(rule.Selector))
                if (!seen.Contains(name, StringComparer.Ordinal)) seen.Add(name);
        return seen;
    }

    /// <summary>Every id selected anywhere in the stylesheet ("#status" -> "status"), in first-seen order. OutSystems reserves the
    /// id attribute, so an authored page cannot promise these selectors a target. #reactContainer is the platform's own
    /// element, not an authored id, and is not listed.</summary>
    public IReadOnlyList<string> IdNames()
    {
        var seen = new List<string>();
        foreach (var rule in Rules)
            foreach (var name in Ids(rule.Selector))
                if (name != ReactContainer && !seen.Contains(name, StringComparer.Ordinal)) seen.Add(name);
        return seen;
    }

    /// <summary>Class tokens of a selector list, read token by token (a dot inside a string, an attribute or an escape is not a class).</summary>
    public static IEnumerable<string> Classes(string selector) => Tokens(selector, '.');
    public static IEnumerable<string> Ids(string selector) => Tokens(selector, '#');
    private static IEnumerable<string> Tokens(string selector, char marker) => TokenPositions(selector,marker).Select(p=>selector[p.Start..p.End]);
    private static IEnumerable<(int Start,int End)> TokenPositions(string selector, char marker)
    {
        var i = 0;var brackets=0;
        while (i < selector.Length)
        {
            var ch = selector[i];
            if (ch == '"' || ch == '\'') { var q = ch; i++; while (i < selector.Length && selector[i] != q) i += selector[i] == '\\' ? 2 : 1; i++; continue; }
            if (ch == '[') { brackets++;i++;continue; }
            if (ch == ']') { brackets--;i++;continue; }
            if (ch == '\\') { i += 2; continue; }
            if (brackets==0 && ch == marker && i + 1 < selector.Length && (char.IsLetter(selector[i + 1]) || selector[i + 1] == '_' || selector[i + 1] == '-'))
            {
                var start = ++i; while (i < selector.Length && (char.IsLetterOrDigit(selector[i]) || selector[i] == '_' || selector[i] == '-')) i++;
                yield return (start,i); continue;
            }
            i++;
        }
    }

    /// <summary>The stylesheet rewritten under one scope class: every selector is prefixed (":root", "html" and "body" become the
    /// scope itself), at-rules are kept, declarations are re-serialized. The page root carries the class, so the theme can hold the
    /// rules without leaking them into other screens.</summary>
    public string Scoped(string scopeClass)
    {
        var sb = new StringBuilder(); IReadOnlyList<string> open = [];
        AppendBlocks(sb);
        foreach (var rule in Rules)
        {
            var common = 0;
            while (common < open.Count && common < rule.EnclosingRules.Count && open[common] == rule.EnclosingRules[common]) common++;
            for (var i = open.Count; i > common; i--) sb.Append("}\n");
            for (var i = common; i < rule.EnclosingRules.Count; i++) sb.Append(rule.EnclosingRules[i]).Append(" {\n");
            open = rule.EnclosingRules;
            var selectors = SplitSelectors(rule.Selector).SelectMany(s => ScopeSelectors(s, scopeClass));
            sb.Append(open.Count > 0 ? "  " : "").Append(string.Join(", ", selectors)).Append(" { ");
            foreach (var d in rule.Declarations) sb.Append(d.Property).Append(": ").Append(d.Value).Append(d.Important ? " !important; " : "; ");
            sb.Append("}\n");
        }
        for (var i = open.Count; i > 0; i--) sb.Append("}\n");
        return sb.ToString().TrimEnd();
    }

    /// <summary>Restrict each selected element to its authoring component. A parent's rules cannot style
    /// internals of a child block; slot content retains its consumer ownership.</summary>
    public string ScopedOwned(string scope, string owner)
    {
        if(Statements.Count>0)throw new InvalidOperationException("Component CSS does not support global statement at-rules: "+string.Join("; ",Statements));
        var scoped = new StringBuilder(); IReadOnlyList<string> open = [];
        AppendBlocks(scoped);
        foreach (var rule in Rules)
        {
            var common = 0;
            while (common < open.Count && common < rule.EnclosingRules.Count && open[common] == rule.EnclosingRules[common]) common++;
            for (var i = open.Count; i > common; i--) scoped.Append("}\n");
            for (var i = common; i < rule.EnclosingRules.Count; i++) scoped.Append(rule.EnclosingRules[i]).Append(" {\n");
            open = rule.EnclosingRules;
            scoped.Append(string.Join(", ", SplitSelectors(rule.Selector).SelectMany(selector => ScopeSelectors(selector, scope)).Select(value => {
                var pseudo = PseudoElementOffset(value);
                return pseudo < 0 ? value + ":where(" + owner + ")" : value[..pseudo] + ":where(" + owner + ")" + value[pseudo..];
            }))).Append(" { ");
            foreach (var d in rule.Declarations) scoped.Append(d.Property).Append(": ").Append(d.Value).Append(d.Important ? " !important; " : "; ");
            scoped.Append("}\n");
        }
        for(var i=open.Count;i>0;i--)scoped.Append("}\n");
        return scoped.ToString();
    }

    /// <summary>The opaque blocks (@keyframes, @font-face) first, in source order, each inside its own enclosing at-rules:
    /// they define names, so their place among the rules does not change what the rules select.</summary>
    private void AppendBlocks(StringBuilder sb)
    {
        foreach (var block in Blocks)
        {
            foreach (var enclosing in block.EnclosingRules) sb.Append(enclosing).Append(" {\n");
            sb.Append(block.Prelude).Append(" {").Append(block.Body).Append("}\n");
            for (var i = 0; i < block.EnclosingRules.Count; i++) sb.Append("}\n");
        }
    }

    // The document roots a stylesheet may start from: the scope class stands for them. #reactContainer (and the canvas form
    // CssCompat writes for it) is the Reactive runtime's root, so it is a root here too.
    private static readonly string[] Roots = [CanvasRoot, "#" + ReactContainer, ":root", "html", "body"];

    /// <summary>One selector under the scope. A selector that already starts with the scope token (followed by its end, a
    /// combinator, a class, an id, an attribute or a pseudo-class) already selects inside the scope and stays as written:
    /// prefixing it again selected `.scope .scope`, which matched nothing (C20, the tic-tac-toe board of 2026-10-06).</summary>
    private static string ScopeSelector(string selector, string scope) => string.Join(", ", ScopeSelectors(selector, scope));

    /// <summary>One selector under the scope, as the selectors that replace it (docs/PROTOTIPO-NATIVO.md, 4.3 item 1):
    /// <list type="bullet">
    /// <item>:root, html, body (and the Reactive root) become the scope itself;</item>
    /// <item>a first compound that already is the root (it carries the scope token anywhere: <c>.app</c>, <c>main.app</c>,
    /// <c>[data-x].app</c>, <c>.a.app</c>) is the anchor and stays as written: prefixing it selected <c>.app main.app</c>, an
    /// element inside the root, never the root itself;</item>
    /// <item>a first compound that starts with <c>*</c> covers the root and what is inside it: <c>*</c> becomes
    /// <c>.app, .app *</c> (<c>*:before</c> becomes <c>.app:before, .app *:before</c>), as <c>*</c> covers every element in the
    /// browser;</item>
    /// <item>anything else is prefixed: <c>.app X</c>.</item>
    /// </list></summary>
    internal static IReadOnlyList<string> ScopeSelectors(string selector, string scope)
    {
        var s = selector.Trim();
        static bool Bounded(string s, string head) => s.StartsWith(head, StringComparison.Ordinal) && (s.Length == head.Length || " >+~.#[:".Contains(s[head.Length]));
        foreach (var root in Roots)
            if (Bounded(s, root)) return [scope + s[root.Length..]];
        if (Bounded(s, scope) || FirstCompoundHasToken(s, scope)) return [s];
        if (s.StartsWith('*') && (s.Length == 1 || " >+~.#[:".Contains(s[1])))
            return [scope + s[1..], scope + " " + s];
        return [scope + " " + s];
    }

    /// <summary>True when the first compound of the selector (up to its first combinator, outside brackets, parentheses and
    /// strings) carries the scope's class or id token, whole (".app" in "main.app:hover", not in ".apple").</summary>
    private static bool FirstCompoundHasToken(string selector, string scope)
    {
        if (scope.Length < 2 || scope[0] is not ('.' or '#')) return false;
        var depth = 0; char? quote = null; var end = selector.Length;
        for (var i = 0; i < selector.Length; i++)
        {
            var c = selector[i];
            if (quote != null) { if (c == '\\') i++; else if (c == quote) quote = null; continue; }
            if (c is '"' or '\'') quote = c;
            else if (c == '\\') i++;
            else if (c is '(' or '[') depth++;
            else if (c is ')' or ']') depth--;
            else if (depth == 0 && (char.IsWhiteSpace(c) || c is '>' or '+' or '~')) { end = i; break; }
        }
        var first = selector[..end];
        foreach (var (start, stop) in TokenPositions(first, scope[0]))
            if (string.Equals(first[start..stop], scope[1..], StringComparison.Ordinal)) return true;
        return false;
    }

    /// <summary>Native widgets keep their framework DOM IDs. Resolve authored ID selectors through
    /// component-owned classes, retaining ID specificity with :is rather than overriding native IDs.</summary>
    public CssStylesheet MapIds(IReadOnlyDictionary<string,string> classes)
    {
        return new CssStylesheet(Rules.Select(rule=>
        {
            var selector=new StringBuilder(rule.Selector);
            foreach(var (start,end) in TokenPositions(rule.Selector,'#').Reverse())
            {
                var id=rule.Selector[start..end];
                if(classes.TryGetValue(id,out var name))selector.Remove(start-1,end-start+1).Insert(start-1,":is(#"+id+",."+name+")");
            }
            return rule with {Selector=selector.ToString()};
        }).ToList(),Statements.ToList(),Blocks.ToList());
    }

    private static int PseudoElementOffset(string selector)
    {
        var depth=0;char? quote=null;
        for(var i=0;i<selector.Length-1;i++)
        {
            var c=selector[i];
            if(quote!=null){if(c=='\\')i++;else if(c==quote)quote=null;continue;}
            if(c is '\'' or '"'){quote=c;continue;}
            if(c is '(' or '[')depth++;
            else if(c is ')' or ']')depth--;
            else if(depth==0 && c==':' && selector[i+1]==':')return i;
        }
        return -1;
    }

    /// <summary>Splits a selector list on the commas that are not inside strings, brackets or parentheses.</summary>
    public static IEnumerable<string> SplitSelectors(string selector)
    {
        var depth = 0; var start = 0; char? quote = null;
        for (var i = 0; i < selector.Length; i++)
        {
            var ch = selector[i];
            if (quote != null) { if (ch == '\\') i++; else if (ch == quote) quote = null; continue; }
            if (ch == '"' || ch == '\'') quote = ch;
            else if (ch == '(' || ch == '[') depth++;
            else if (ch == ')' || ch == ']') depth--;
            else if (ch == ',' && depth == 0) { yield return selector[start..i].Trim(); start = i + 1; }
        }
        yield return selector[start..].Trim();
    }

    public static CssStylesheet Parse(string css) => Parse(css, lenient: false);

    /// <summary>The stylesheet parsed. <paramref name="lenient"/>: an at-rule block this parser does not model (@page,
    /// @property, @counter-style, @font-feature-values, @view-transition…) is kept whole as an opaque block instead of being
    /// refused, the way a browser keeps it; the prototype importer counts a sheet this way. The text itself is <see cref="Text"/>,
    /// verbatim.</summary>
    public static CssStylesheet Parse(string css, bool lenient)
    {
        var rules = new List<CssRule>(); var statements = new List<string>(); var blocks = new List<CssBlock>();
        new Parser(css, rules, statements, blocks) { Lenient = lenient }.Sheet([], 0);
        return new CssStylesheet(rules, statements, blocks) { Text = css };
    }

    /// <summary>The text the stylesheet was parsed from, verbatim (null for a stylesheet built by a rewrite).</summary>
    public string? Text { get; private init; }

    /// <summary>The number of rules by this parser: style rules (inside at-rules too), opaque blocks (@keyframes, @font-face and,
    /// leniently, any other at-rule block) and statements (@import, @charset, @layer a, b;). Comparing it for two texts is how a
    /// rewrite proves it lost no rule.</summary>
    public int RuleCount => Rules.Count + Blocks.Count + Statements.Count;

    /// <summary><see cref="RuleCount"/> of a text, never truncated and never throwing: the lenient parse, and when the text is
    /// beyond it (CSS nesting, a malformed tail), the same count by a tolerant walk that balances strings, comments and braces.</summary>
    public static int CountRules(string css)
    {
        try { return Parse(css, lenient: true).RuleCount; }
        catch (InvalidOperationException) { return TolerantCount(css, 0, css.Length); }
    }

    private static int TolerantCount(string css, int i, int end)
    {
        var count = 0;
        while (i < end)
        {
            while (i < end && (char.IsWhiteSpace(css[i]) || css[i] == '﻿')) i++;
            if (i + 1 < end && css[i] == '/' && css[i + 1] == '*') { var close = css.IndexOf("*/", i + 2, StringComparison.Ordinal); i = close < 0 ? end : close + 2; continue; }
            if (i >= end) break;
            if (css[i] == '}') { i++; continue; }
            var start = i; var depth = 0;
            while (i < end)
            {
                var c = css[i];
                if (c == '/' && i + 1 < end && css[i + 1] == '*') { var close = css.IndexOf("*/", i + 2, StringComparison.Ordinal); i = close < 0 ? end : close + 2; continue; }
                if (c is '"' or '\'') { var q = c; i++; while (i < end && css[i] != q) i += css[i] == '\\' ? 2 : 1; i++; continue; }
                if (c is '(' or '[') depth++;
                else if (c is ')' or ']') depth--;
                else if (depth == 0 && c is '{' or ';' or '}') break;
                i++;
            }
            if (i >= end) { if (css[start..end].Trim().Length > 0) count++; break; }
            if (css[i] == ';') { count++; i++; continue; }
            if (css[i] == '}') continue;
            var prelude = css[start..i].TrimStart();
            var blockStart = i + 1; depth = 0; i = blockStart;
            while (i < end)
            {
                var c = css[i];
                if (c == '/' && i + 1 < end && css[i + 1] == '*') { var close = css.IndexOf("*/", i + 2, StringComparison.Ordinal); i = close < 0 ? end : close + 2; continue; }
                if (c is '"' or '\'') { var q = c; i++; while (i < end && css[i] != q) i += css[i] == '\\' ? 2 : 1; i++; continue; }
                if (c == '{') depth++;
                else if (c == '}') { if (depth == 0) break; depth--; }
                i++;
            }
            var blockEnd = Math.Min(i, end);
            if (prelude.StartsWith('@') && (prelude.StartsWith("@media", StringComparison.OrdinalIgnoreCase) || prelude.StartsWith("@supports", StringComparison.OrdinalIgnoreCase)
                || prelude.StartsWith("@container", StringComparison.OrdinalIgnoreCase) || prelude.StartsWith("@layer", StringComparison.OrdinalIgnoreCase)))
                count += TolerantCount(css, blockStart, blockEnd);
            else count++;
            i = blockEnd + 1;
        }
        return count;
    }

    /// <summary>At-rules whose block holds no style rules: the browser takes them as a whole (a keyframe list, a font face).</summary>
    public static bool IsOpaqueAtRule(string prelude)
    {
        var p = prelude.TrimStart();
        return p.StartsWith("@keyframes", StringComparison.OrdinalIgnoreCase) || p.StartsWith("@-webkit-keyframes", StringComparison.OrdinalIgnoreCase)
            || p.StartsWith("@-moz-keyframes", StringComparison.OrdinalIgnoreCase) || p.StartsWith("@font-face", StringComparison.OrdinalIgnoreCase);
    }

    private sealed class Parser(string text, List<CssRule> rules, List<string> statements, List<CssBlock> blocks)
    {
        public bool Lenient { get; init; }
        private int _i; private int _line = 1, _col = 1;
        private bool End => _i >= text.Length;
        private char Peek(int ahead = 0) => _i + ahead < text.Length ? text[_i + ahead] : '\0';
        private char Take() { var c = text[_i++]; if (c == '\n') { _line++; _col = 1; } else _col++; return c; }
        private static InvalidOperationException Error(string message, int line, int col) => new($"css: line {line} col {col}: {message}");

        /// <summary>Parses rules until the closing brace of the enclosing block (depth > 0) or the end of the text.</summary>
        public void Sheet(IReadOnlyList<string> enclosing, int depth)
        {
            while (true)
            {
                Trivia();
                if (End) { if (depth > 0) throw Error("unexpected end of stylesheet inside a block", _line, _col); return; }
                if (Peek() == '}') { if (depth == 0) throw Error("unexpected '}'", _line, _col); Take(); return; }
                var (l, c) = (_line, _col);
                var prelude = Prelude();
                if (End) throw Error($"expected '{{' after '{prelude.Trim()}'", l, c);
                if (Peek() == ';') { Take(); if (!prelude.TrimStart().StartsWith('@')) throw Error($"'{prelude.Trim()}' is not a rule: expected '{{'", l, c); statements.Add(prelude.Trim()); continue; }
                Take(); // '{'
                if (IsNestingAtRule(prelude)) { Sheet([.. enclosing, prelude.Trim()], depth + 1); continue; }
                if (IsOpaqueAtRule(prelude)) { blocks.Add(new CssBlock(HtmlNode.CollapseSpaces(prelude), Opaque(l, c), enclosing, l, c)); continue; }
                if (prelude.TrimStart().StartsWith('@'))
                {
                    if (!Lenient) throw Error($"unsupported at-rule '{prelude.Trim()}'", l, c);
                    blocks.Add(new CssBlock(HtmlNode.CollapseSpaces(prelude), Opaque(l, c), enclosing, l, c));
                    continue;
                }
                rules.Add(new CssRule(HtmlNode.CollapseSpaces(prelude), enclosing.LastOrDefault(), Declarations(l, c), l, c) { EnclosingRules = enclosing });
            }
        }

        private bool IsNestingAtRule(string prelude)
        {
            var p = prelude.TrimStart();
            return p.StartsWith("@media", StringComparison.OrdinalIgnoreCase) || p.StartsWith("@supports", StringComparison.OrdinalIgnoreCase)
                || p.StartsWith("@container", StringComparison.OrdinalIgnoreCase) || p.StartsWith("@layer", StringComparison.OrdinalIgnoreCase)
                || Lenient && (p.StartsWith("@scope", StringComparison.OrdinalIgnoreCase) || p.StartsWith("@starting-style", StringComparison.OrdinalIgnoreCase)
                    || p.StartsWith("@document", StringComparison.OrdinalIgnoreCase));
        }

        private string Prelude()
        {
            var sb = new StringBuilder();
            while (!End && Peek() != '{' && Peek() != ';')
            {
                if (Peek() == '/' && Peek(1) == '*') { Trivia(); sb.Append(' '); continue; }
                if (Peek() == '"' || Peek() == '\'') { Quoted(sb); continue; }
                if (Peek() == '}') throw Error($"unexpected '}}' in selector '{sb.ToString().Trim()}'", _line, _col);
                sb.Append(Take());
            }
            return sb.ToString();
        }

        private List<CssDeclaration> Declarations(int ruleLine, int ruleCol)
        {
            var list = new List<CssDeclaration>();
            while (true)
            {
                Trivia();
                if (End) throw Error("unterminated declaration block", ruleLine, ruleCol);
                if (Peek() == '}') { Take(); return list; }
                if (Peek() == ';') { Take(); continue; }
                var (l, c) = (_line, _col); var name = new StringBuilder();
                while (!End && Peek() != ':' && Peek() != ';' && Peek() != '}') name.Append(Take());
                if (Peek() != ':') throw Error($"expected ':' after property '{name.ToString().Trim()}'", l, c);
                Take();
                var value = new StringBuilder(); var parens = 0;
                while (!End && !((Peek() == ';' || Peek() == '}') && parens == 0))
                {
                    if (Peek() == '/' && Peek(1) == '*') { Trivia(); continue; }
                    if (Peek() == '"' || Peek() == '\'') { Quoted(value); continue; }
                    if (Peek() == '(') parens++; else if (Peek() == ')') parens--;
                    value.Append(Take());
                }
                if (parens != 0) throw Error($"unbalanced parentheses in value of '{name.ToString().Trim()}'", l, c);
                var raw = value.ToString().Trim(); var important = raw.EndsWith("!important", StringComparison.OrdinalIgnoreCase);
                if (important) raw = raw[..^"!important".Length].TrimEnd();
                var property = name.ToString().Trim();
                if (property.Length == 0) throw Error("declaration without a property name", l, c);
                list.Add(new CssDeclaration(property, raw, important));
            }
        }

        /// <summary>The text of an opaque block up to its closing brace (consumed), braces, strings and comments balanced.</summary>
        private string Opaque(int line, int col)
        {
            var sb = new StringBuilder(); var depth = 0;
            while (true)
            {
                if (End) throw Error("unterminated at-rule block", line, col);
                if (Peek() == '/' && Peek(1) == '*') { var start = _i; Trivia(); sb.Append(text, start, _i - start); continue; }
                if (Peek() == '"' || Peek() == '\'') { Quoted(sb); continue; }
                if (Peek() == '{') depth++;
                else if (Peek() == '}') { if (depth == 0) { Take(); return sb.ToString(); } depth--; }
                sb.Append(Take());
            }
        }

        private void Quoted(StringBuilder sb)
        {
            var q = Take(); sb.Append(q); var (l, c) = (_line, _col);
            while (!End && Peek() != q) { if (Peek() == '\\') { sb.Append(Take()); if (End) break; } sb.Append(Take()); }
            if (End) throw Error("unterminated string", l, c);
            sb.Append(Take());
        }

        private void Trivia()
        {
            while (!End)
            {
                if (char.IsWhiteSpace(Peek()) || Peek() == '﻿') { Take(); continue; }
                if (Peek() == '/' && Peek(1) == '*')
                {
                    var (l, c) = (_line, _col); var end = text.IndexOf("*/", _i + 2, StringComparison.Ordinal);
                    if (end < 0) throw Error("unterminated comment", l, c);
                    while (_i < end + 2) Take();
                    continue;
                }
                return;
            }
        }
    }
}
