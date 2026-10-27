using System.Text;
using System.Text.RegularExpressions;

namespace Anvil.Core.Preflight;

/// <summary>What fills an attribute in the job's own html: a Date Time of client-side code marked UTC, one with no mark, or
/// anything else (a text made on the server, a value of unknown type).</summary>
public enum Filler { Other = 0, ClientDateTime = 1, ClientDateTimeMarkedUtc = 2 }

/// <summary>What the job tells the script lint: the markers of the elements whose content the runtime writes (the runtime DOM
/// table), the data-* attributes the runtime itself manages, the attributes the job's html puts on an element that shows an
/// expression (<paramref name="Shown"/>), the attributes it binds (<paramref name="Bound"/>) and what fills each one.</summary>
public sealed record ScriptContext(IReadOnlyCollection<string> RuntimeMarkers, IReadOnlySet<string> RuntimeAttributes, IReadOnlySet<string> Shown,
    IReadOnlySet<string> Bound, IReadOnlyDictionary<string, Filler> Fillers);

/// <summary>
/// T9: one client script (a JavaScript node, a module Script, a page script) read token by token, once: strings, template
/// texts, regular expressions and comments are never code; names resolve in their own function scope (a name bound twice in
/// one scope is ambiguous: at most a warning). What the script does against the runtime that renders the page:
/// <list type="bullet">
/// <item>DATETIME_TZ_REINTERPRETED: new Date / Date.parse of an attribute's text (read directly or through a variable; never
/// arithmetic). An error when the job fills that attribute with a Date Time of client-side code marked UTC, or fills it with one
/// and the script appends the UTC mark; a warning when the job does not write it and its name (a whole word utc) or the script
/// says UTC.</item>
/// <item>DOM_MUTATION_OF_RUNTIME: an observer of the whole document with subtree (a warning when the script disconnects it); text
/// or markup written on elements a selector picks by a runtime marker or a shown attribute (an error when the marker is on the
/// element itself, a warning when only on an ancestor); attributes written there (an error only for the attributes the runtime
/// renders, a warning for the others).</item>
/// <item>JS_RUNTIME_DUPLICATE: the device classes toggled on body; a write of the content of meta[name=viewport] (a warning when
/// it locks the zoom or is computed).</item>
/// </list>
/// </summary>
public static class ClientScriptLint
{
    public sealed record Finding(string Code, string Severity, string Message, string Fix);

    public static IReadOnlyList<string> DeviceClasses => LogicLint.RuntimeDeviceClasses;

    private enum K { Ident, Punct, Str, Num, Other }
    private readonly record struct Tok(K Kind, string Text, bool Line);

    private static readonly string[] Puncts = ["===", "!==", "**=", "...", "<<=", ">>=", ">>>", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.",
        "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "++", "--", "**", "<<", ">>"];
    private static readonly HashSet<string> RegexAfterWords = new(StringComparer.Ordinal) { "return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await" };
    private static readonly HashSet<string> ControlWords = new(StringComparer.Ordinal) { "if", "for", "while", "switch", "catch", "with", "return", "typeof", "new", "delete", "void", "await", "yield", "in", "of", "do", "else" };
    private static readonly HashSet<string> QueryCalls = new(StringComparer.Ordinal) { "querySelectorAll", "querySelector", "getElementsByClassName", "getElementsByTagName", "closest" };
    private static readonly HashSet<string> TextProperties = new(StringComparer.Ordinal) { "textContent", "innerText", "innerHTML", "outerHTML", "nodeValue" };
    private static readonly HashSet<string> MarkupCalls = new(StringComparer.Ordinal) { "insertAdjacentHTML", "replaceChildren", "replaceWith" };
    private static readonly HashSet<string> AttributeCalls = new(StringComparer.Ordinal) { "setAttribute", "removeAttribute", "toggleAttribute" };
    private static readonly HashSet<string> ClassCalls = new(StringComparer.Ordinal) { "add", "remove", "toggle", "replace" };
    /// <summary>The attributes the runtime renders on a widget's element (with the runtime's data-* markers and the job's bound ones).</summary>
    private static readonly HashSet<string> ManagedAttributes = new(StringComparer.OrdinalIgnoreCase) { "class", "style", "id", "value", "checked", "disabled", "hidden", "href", "src", "alt", "title", "placeholder", "type", "name", "for", "selected", "readonly" };
    private static readonly Regex UtcAfter = new(@"^\s*(?:\.\d+)?(?:Z|(?i:UTC|GMT)|[+-]00:?00)(?![A-Za-z0-9])", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex ZoomLock = new(@"user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=\s*1(?:\.0)?(?![\d.])", RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>A name that holds the word utc whole (data-started-utc, utc_time, startedUtc), never inside another word (outcome).</summary>
    public static bool HasUtcWord(string name)
    {
        var kebab = Kebab(name);
        foreach (var part in kebab.Split(['-', '_'], StringSplitOptions.RemoveEmptyEntries))
            if (part.Equals("utc", StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    /// <summary>A camelCase name as the attribute it reads (dataset.startedUtc is data-started-utc's key).</summary>
    public static string Kebab(string key)
    {
        var text = new StringBuilder(key.Length + 4);
        for (var i = 0; i < key.Length; i++)
        {
            var c = key[i];
            if (char.IsUpper(c) && i > 0 && (char.IsLower(key[i - 1]) || char.IsDigit(key[i - 1]))) text.Append('-');
            text.Append(char.ToLowerInvariant(c));
        }
        return text.ToString();
    }

    // ---- the script, read once ---------------------------------------------------------------------------------------------------

    private sealed class Script
    {
        public readonly List<Tok> T;
        public readonly int[] Match;
        public readonly int[] ScopeOf;
        public readonly List<int> Parent = [-1];
        // (scope, name) -> the binding: where each value it is given starts and ends (end exclusive), and the receiver of a
        // forEach / for..of it is the item of.
        public readonly Dictionary<(int, string), Binding> Bindings = [];

        public Script(string code)
        {
            T = Tokens(code);
            Match = Matches(T);
            ScopeOf = new int[T.Count];
            Scopes();
            Declarations();
        }

        public bool Is(int k, string text) => k >= 0 && k < T.Count && T[k].Kind is K.Punct or K.Ident && T[k].Text == text;
        public bool IsIdent(int k) => k >= 0 && k < T.Count && T[k].Kind == K.Ident;
        public string? StringAt(int k) => k >= 0 && k < T.Count && T[k].Kind == K.Str ? T[k].Text : null;

        private static List<Tok> Tokens(string s)
        {
            var list = new List<Tok>(s.Length / 5 + 4);
            var i = 0; var line = false;
            while (i < s.Length)
            {
                var c = s[i];
                if (c == '\n') { line = true; i++; continue; }
                if (char.IsWhiteSpace(c)) { i++; continue; }
                if (c == '/' && i + 1 < s.Length && s[i + 1] == '/') { while (i < s.Length && s[i] != '\n') i++; continue; }
                if (c == '/' && i + 1 < s.Length && s[i + 1] == '*')
                {
                    var end = s.IndexOf("*/", i + 2, StringComparison.Ordinal);
                    if (end < 0) break;
                    if (s.AsSpan(i, end - i).Contains('\n')) line = true;
                    i = end + 2;
                    continue;
                }
                if (c is '\'' or '"')
                {
                    var text = new StringBuilder(); i++;
                    while (i < s.Length && s[i] != c && s[i] != '\n')
                    {
                        if (s[i] == '\\' && i + 1 < s.Length) { text.Append(s[i + 1] switch { 'n' => '\n', 't' => '\t', var e => e }); i += 2; continue; }
                        text.Append(s[i++]);
                    }
                    i++;
                    list.Add(new(K.Str, text.ToString(), line)); line = false;
                    continue;
                }
                if (c == '`')
                {
                    // A template text: its literal parts are text; the code of its ${ } parts is left out (never a selector).
                    var text = new StringBuilder(); i++; var depth = 0;
                    while (i < s.Length && !(depth == 0 && s[i] == '`'))
                    {
                        if (s[i] == '\\' && i + 1 < s.Length) { if (depth == 0) text.Append(s[i + 1]); i += 2; continue; }
                        if (s[i] == '$' && i + 1 < s.Length && s[i + 1] == '{') { depth++; i += 2; continue; }
                        if (depth > 0 && s[i] == '{') depth++;
                        else if (depth > 0 && s[i] == '}') depth--;
                        else if (depth == 0) text.Append(s[i]);
                        i++;
                    }
                    i++;
                    list.Add(new(K.Str, text.ToString(), line)); line = false;
                    continue;
                }
                var start = i;
                if (char.IsDigit(c) || c == '.' && i + 1 < s.Length && char.IsDigit(s[i + 1]))
                {
                    while (i < s.Length && (char.IsLetterOrDigit(s[i]) || s[i] is '.' or '_')) i++;
                    list.Add(new(K.Num, s[start..i], line)); line = false;
                    continue;
                }
                if (char.IsLetter(c) || c is '_' or '$')
                {
                    while (i < s.Length && (char.IsLetterOrDigit(s[i]) || s[i] is '_' or '$')) i++;
                    list.Add(new(K.Ident, s[start..i], line)); line = false;
                    continue;
                }
                if (c == '/' && RegexMayStart(list))
                {
                    i++; var inClass = false;
                    while (i < s.Length && s[i] != '\n')
                    {
                        if (s[i] == '\\') { i += 2; continue; }
                        if (s[i] == '[') inClass = true;
                        else if (s[i] == ']') inClass = false;
                        else if (s[i] == '/' && !inClass) break;
                        i++;
                    }
                    i++;
                    while (i < s.Length && char.IsLetter(s[i])) i++;
                    list.Add(new(K.Other, "/regex/", line)); line = false;
                    continue;
                }
                var punct = Puncts.FirstOrDefault(p => string.CompareOrdinal(s, i, p, 0, p.Length) == 0) ?? c.ToString();
                i += punct.Length;
                list.Add(new(K.Punct, punct, line)); line = false;
            }
            return list;
        }

        private static bool RegexMayStart(List<Tok> list)
        {
            if (list.Count == 0) return true;
            var last = list[^1];
            return last.Kind switch
            {
                K.Num or K.Str or K.Other => false,
                K.Ident => RegexAfterWords.Contains(last.Text),
                _ => last.Text is not (")" or "]" or "}"),
            };
        }

        private static int[] Matches(List<Tok> t)
        {
            var match = Enumerable.Repeat(-1, t.Count).ToArray();
            var open = new Stack<int>();
            for (var k = 0; k < t.Count; k++)
            {
                if (t[k].Kind != K.Punct) continue;
                switch (t[k].Text)
                {
                    case "(" or "[" or "{": open.Push(k); break;
                    case ")" or "]" or "}":
                        if (open.Count > 0) { var o = open.Pop(); match[o] = k; match[k] = o; }
                        break;
                }
            }
            return match;
        }

        // ---- scopes: every function body (declarations, methods, arrows) is one; blocks are not ------------------------------

        private readonly List<(int Start, int End, List<int> Params)> functions = [];
        public readonly Dictionary<int, int> ParamScope = [];

        private void Scopes()
        {
            for (var k = 0; k < T.Count; k++)
            {
                if (Is(k, "{") && Match[k] > k)
                {
                    if (Is(k - 1, ")") && Match[k - 1] >= 0)
                    {
                        var open = Match[k - 1];
                        if (IsIdent(open - 1) && !ControlWords.Contains(T[open - 1].Text)) functions.Add((k, Match[k], ParamsIn(open, k - 1)));
                    }
                    else if (Is(k - 1, "=>")) functions.Add((k, Match[k], ArrowParams(k - 1)));
                }
                else if (Is(k, "=>") && k + 1 < T.Count && !Is(k + 1, "{")) functions.Add((k + 1, ExpressionEnd(k + 1), ArrowParams(k)));
            }
            functions.Sort((a, b) => a.Start != b.Start ? a.Start.CompareTo(b.Start) : b.End.CompareTo(a.End));
            var active = new Stack<(int End, int Id)>();
            var next = 0;
            for (var k = 0; k < T.Count; k++)
            {
                while (active.Count > 0 && active.Peek().End < k) active.Pop();
                while (next < functions.Count && functions[next].Start == k)
                {
                    var id = Parent.Count;
                    Parent.Add(active.Count > 0 ? active.Peek().Id : 0);
                    foreach (var p in functions[next].Params) ParamScope[p] = id;
                    active.Push((functions[next].End, id));
                    next++;
                }
                ScopeOf[k] = active.Count > 0 ? active.Peek().Id : 0;
            }
        }

        private List<int> ParamsIn(int open, int close)
        {
            var list = new List<int>();
            for (var j = open + 1; j < close; j++)
            {
                if (Is(j, "(") || Is(j, "[") || Is(j, "{")) { j = Match[j] < 0 ? close : Match[j]; continue; }
                if (IsIdent(j) && (Is(j - 1, "(") || Is(j - 1, ",") || Is(j - 1, "...")) && (Is(j + 1, ",") || Is(j + 1, ")") || Is(j + 1, "="))) list.Add(j);
            }
            return list;
        }

        private List<int> ArrowParams(int arrow)
        {
            if (Is(arrow - 1, ")") && Match[arrow - 1] >= 0) return ParamsIn(Match[arrow - 1], arrow - 1);
            return IsIdent(arrow - 1) ? [arrow - 1] : [];
        }

        /// <summary>The last token of an expression that starts at <paramref name="from"/> (an arrow's body).</summary>
        private int ExpressionEnd(int from)
        {
            for (var j = from; j < T.Count; j++)
            {
                if (Is(j, "(") || Is(j, "[") || Is(j, "{")) { if (Match[j] < 0) return T.Count - 1; j = Match[j]; continue; }
                if (Is(j, ")") || Is(j, "]") || Is(j, "}") || Is(j, ",") || Is(j, ";")) return j - 1;
            }
            return T.Count - 1;
        }

        /// <summary>Where a statement that starts at <paramref name="from"/> ends (exclusive): a ; or , of its depth, the end of its
        /// block, or a new line that starts another statement.</summary>
        public int StatementEnd(int from)
        {
            for (var j = from; j < T.Count; j++)
            {
                if (Is(j, "(") || Is(j, "[") || Is(j, "{")) { if (Match[j] < 0) return T.Count; j = Match[j]; continue; }
                if (Is(j, ")") || Is(j, "]") || Is(j, "}") || Is(j, ";") || Is(j, ",")) return j;
                if (j > from && T[j].Line && T[j].Kind == K.Ident && (T[j - 1].Kind is K.Ident or K.Num or K.Str || Is(j - 1, ")") || Is(j - 1, "]") || Is(j - 1, "}"))) return j;
            }
            return T.Count;
        }

        // ---- bindings ---------------------------------------------------------------------------------------------------------------

        public sealed class Binding
        {
            public readonly List<(int Start, int End)> Values = [];
            public (int Start, int End)? ItemOf;
            public bool Param;
        }

        private Binding Declare(int scope, string name)
        {
            if (!Bindings.TryGetValue((scope, name), out var b)) Bindings[(scope, name)] = b = new Binding();
            return b;
        }

        public Binding? Resolve(string name, int scope)
        {
            for (var s = scope; s >= 0; s = Parent[s])
                if (Bindings.TryGetValue((s, name), out var b)) return b;
            return Bindings.TryGetValue((-1, name), out var global) ? global : null;
        }

        private void Declarations()
        {
            foreach (var (p, scope) in ParamScope) Declare(scope, T[p].Text).Param = true;
            for (var k = 0; k < T.Count; k++)
            {
                if (IsIdent(k) && T[k].Text is "var" or "let" or "const")
                {
                    var j = k + 1;
                    while (IsIdent(j))
                    {
                        var binding = Declare(ScopeOf[k], T[j].Text);
                        if (Is(j + 1, "="))
                        {
                            var end = StatementEnd(j + 2);
                            binding.Values.Add((j + 2, end));
                            j = end;
                        }
                        else j++;
                        // for (const item of list): the item of the list.
                        if (Is(j, "of") && Is(k - 1, "(") && Match[k - 1] > j) { binding.ItemOf = (j + 1, Match[k - 1]); break; }
                        if (!Is(j, ",")) break;
                        j++;
                    }
                    continue;
                }
                if (IsIdent(k) && T[k].Text == "function" && IsIdent(k + 1)) Declare(ScopeOf[k], T[k + 1].Text).Values.Add((k, k + 1));
                // A plain assignment of a name (never a member, never a comparison or an arrow).
                if (IsIdent(k) && Is(k + 1, "=") && !Is(k - 1, ".") && !Is(k - 1, "?.") && !(IsIdent(k - 1) && T[k - 1].Text is "var" or "let" or "const"))
                {
                    var binding = Resolve(T[k].Text, ScopeOf[k]) ?? Declare(-1, T[k].Text);
                    binding.Values.Add((k + 2, StatementEnd(k + 2)));
                }
                // receiver.forEach(function (item) ...) / (item) => / item =>: the item of the receiver.
                if (Is(k, "forEach") && Is(k - 1, ".") && Is(k + 1, "("))
                {
                    var item = -1;
                    if (Is(k + 2, "function"))
                    {
                        var open = IsIdent(k + 3) && Is(k + 4, "(") ? k + 4 : Is(k + 3, "(") ? k + 3 : -1;
                        if (open > 0 && IsIdent(open + 1)) item = open + 1;
                    }
                    else if (Is(k + 2, "(") && IsIdent(k + 3)) item = k + 3;
                    else if (IsIdent(k + 2) && Is(k + 3, "=>")) item = k + 2;
                    if (item > 0 && ParamScope.TryGetValue(item, out var scope))
                        Declare(scope, T[item].Text).ItemOf = (ChainStart(k - 2), k - 1);
                }
            }
        }

        /// <summary>The first token of the member/call chain that ends at <paramref name="end"/> (a.b(c)[d].e).</summary>
        public int ChainStart(int end)
        {
            var j = end;
            for (var guard = 0; j >= 0 && guard < 256; guard++)
            {
                if ((Is(j, ")") || Is(j, "]")) && Match[j] >= 0)
                {
                    var open = Match[j];
                    if (open > 0 && (IsIdent(open - 1) && !ControlWords.Contains(T[open - 1].Text) || Is(open - 1, ")") || Is(open - 1, "]"))) { j = open - 1; continue; }
                    return open;
                }
                if (T[j].Kind is K.Ident or K.Str or K.Num)
                {
                    if (j >= 2 && (Is(j - 1, ".") || Is(j - 1, "?."))) { j -= 2; continue; }
                    if (Is(j - 1, "new")) return j - 1;
                    return j;
                }
                return j;
            }
            return Math.Max(j, 0);
        }

        /// <summary>The top-level arguments of the call whose ( is at <paramref name="open"/>: (start, end exclusive) each.</summary>
        public List<(int Start, int End)> Arguments(int open)
        {
            var list = new List<(int, int)>();
            var close = Match[open];
            if (close < 0) return list;
            var start = open + 1;
            for (var j = open + 1; j < close; j++)
            {
                if (Is(j, "(") || Is(j, "[") || Is(j, "{")) { j = Match[j] < 0 ? close : Match[j]; continue; }
                if (Is(j, ",")) { list.Add((start, j)); start = j + 1; }
            }
            if (close > start) list.Add((start, close));
            return list;
        }
    }

    // ---- what an expression of the script holds -----------------------------------------------------------------------------------

    private enum O { Unknown, Other, Query, Created, Body, Root, Document, Read, Ambiguous }
    private readonly record struct Origin(O Kind, string Text = "", bool Viewport = false);

    private static Origin Classify(Script s, int start, int end, int depth = 0)
    {
        if (end <= start || depth > 6) return new(O.Unknown);
        var t = s.T;
        // Array.from(x), [...x]: x.
        if (end - start > 4 && s.Is(start, "Array") && s.Is(start + 1, ".") && s.Is(start + 2, "from") && s.Is(start + 3, "(") && s.Match[start + 3] == end - 1)
            return Classify(s, start + 4, end - 1, depth + 1);
        if (s.Is(start, "[") && s.Match[start] == end - 1 && s.Is(start + 1, "...")) return Classify(s, start + 2, end - 1, depth + 1);
        if (end - start == 1 && s.IsIdent(start))
        {
            if (t[start].Text == "document") return new(O.Document);
            return Resolve(s, t[start].Text, s.ScopeOf[start], depth + 1);
        }
        if (end - start == 3 && s.Is(start, "document") && s.Is(start + 1, "."))
        {
            if (s.Is(start + 2, "body")) return new(O.Body);
            if (s.Is(start + 2, "documentElement")) return new(O.Root);
        }
        // ... .querySelector('x') / .createElement('x') / .getAttribute('x') as the whole expression.
        if (s.Is(end - 1, ")") && s.Match[end - 1] > start && s.IsIdent(s.Match[end - 1] - 1) && s.Is(s.Match[end - 1] - 2, "."))
        {
            var open = s.Match[end - 1]; var name = t[open - 1].Text;
            var argument = open + 2 == end - 1 ? s.StringAt(open + 1) : null;
            if (argument != null && QueryCalls.Contains(name))
                return argument.Trim() switch { "body" => new(O.Body), "html" => new(O.Root), var selector => new(O.Query, selector, IsViewportSelector(selector)) };
            if (argument != null && name == "createElement" && s.Is(open - 3, "document")) return new(O.Created, argument.ToLowerInvariant());
            if (name == "getAttribute" && s.Arguments(open) is [var first, ..] && first.End - first.Start == 1 && s.StringAt(first.Start) is { } attribute) return new(O.Read, attribute);
        }
        if (end - start >= 3 && s.Is(end - 2, ".") && s.IsIdent(end - 1) && s.Is(end - 3, "dataset")) return new(O.Read, "data-" + Kebab(t[end - 1].Text));
        if (end - start >= 4 && s.Is(end - 1, "]") && s.Is(end - 3, "[") && s.Is(end - 4, "dataset") && s.StringAt(end - 2) is { } key) return new(O.Read, "data-" + Kebab(key));
        return new(O.Other);
    }

    private static Origin Resolve(Script s, string name, int scope, int depth)
    {
        var binding = s.Resolve(name, scope);
        if (binding == null) return new(O.Unknown);
        var found = new List<Origin>();
        if (binding.ItemOf is { } list)
        {
            var of = Classify(s, list.Start, list.End, depth + 1);
            found.Add(of.Kind == O.Query ? of : new(O.Other));
        }
        foreach (var (start, end) in binding.Values) found.Add(Classify(s, start, end, depth + 1));
        if (found.Count == 0) return new(binding.Param ? O.Unknown : O.Other);
        var viewport = found.All(o => o.Viewport || o.Kind == O.Created && o.Text == "meta") && found.Any(o => o.Viewport);
        if (found.All(o => o.Kind == found[0].Kind && o.Text == found[0].Text)) return found[0] with { Viewport = found[0].Viewport || viewport };
        if (viewport) return new(O.Query, "meta[name=viewport]", true);
        var owned = found.FirstOrDefault(o => o.Kind is O.Query or O.Read);
        return new(O.Ambiguous, owned.Text);
    }

    private static bool IsViewportSelector(string selector) =>
        Regex.Replace(selector, @"[\s'""]", "").Contains("meta[name=viewport]", StringComparison.OrdinalIgnoreCase);

    // ---- selectors: where a marker stands ---------------------------------------------------------------------------------------

    private enum Own { None, Ancestor, Subject }

    /// <summary>Whether a selector picks elements by an owned attribute on the element itself (its last compound) or only on an
    /// ancestor; the strongest over its comma list.</summary>
    private static (Own Where, string Attribute) Ownership(string selector, IReadOnlyCollection<string> owned)
    {
        var best = (Own.None, "");
        foreach (var complex in Split(selector, ','))
        {
            var compounds = Compounds(complex);
            for (var c = 0; c < compounds.Count; c++)
            {
                foreach (var name in AttributeNames(compounds[c]))
                {
                    if (!owned.Contains(name)) continue;
                    var where = c == compounds.Count - 1 ? Own.Subject : Own.Ancestor;
                    if (where > best.Item1) best = (where, name);
                }
            }
        }
        return best;
    }

    private static List<string> Split(string text, char separator)
    {
        var parts = new List<string>(); var depth = 0; var quote = '\0'; var start = 0;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (quote != '\0') { if (c == quote) quote = '\0'; continue; }
            if (c is '"' or '\'') quote = c;
            else if (c is '[' or '(') depth++;
            else if (c is ']' or ')') depth--;
            else if (c == separator && depth == 0) { parts.Add(text[start..i]); start = i + 1; }
        }
        parts.Add(text[start..]);
        return parts;
    }

    private static List<string> Compounds(string complex)
    {
        var parts = new List<string>(); var depth = 0; var quote = '\0'; var current = new StringBuilder();
        foreach (var c in complex)
        {
            if (quote != '\0') { current.Append(c); if (c == quote) quote = '\0'; continue; }
            if (c is '"' or '\'') { quote = c; current.Append(c); continue; }
            if (c is '[' or '(') depth++;
            if (c is ']' or ')') depth--;
            if (depth == 0 && (char.IsWhiteSpace(c) || c is '>' or '+' or '~'))
            {
                if (current.Length > 0) { parts.Add(current.ToString()); current.Clear(); }
                continue;
            }
            current.Append(c);
        }
        if (current.Length > 0) parts.Add(current.ToString());
        return parts;
    }

    private static IEnumerable<string> AttributeNames(string compound)
    {
        for (var i = compound.IndexOf('['); i >= 0; i = compound.IndexOf('[', i + 1))
        {
            var j = i + 1;
            while (j < compound.Length && char.IsWhiteSpace(compound[j])) j++;
            var start = j;
            while (j < compound.Length && (char.IsLetterOrDigit(compound[j]) || compound[j] is '-' or '_' or ':')) j++;
            if (j > start) yield return compound[start..j];
        }
    }

    // ---- the findings -----------------------------------------------------------------------------------------------------------

    public static IReadOnlyList<Finding> Lint(string code, ScriptContext context)
    {
        var s = new Script(code);
        var t = s.T;
        var found = new List<Finding>();
        var said = new HashSet<string>(StringComparer.Ordinal);
        void Add(string kind, string severity, string message, string fix) { if (said.Add(kind + "|" + severity + "|" + message)) found.Add(new(kind, severity, message, fix)); }
        var owned = context.RuntimeMarkers.Concat(context.Shown).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var disconnects = false;
        for (var k = 0; k + 2 < t.Count; k++) if (s.Is(k, ".") && s.Is(k + 1, "disconnect") && s.Is(k + 2, "(")) { disconnects = true; break; }
        var deviceClasses = new SortedSet<string>(StringComparer.Ordinal);
        var viewportFlagged = new HashSet<Script.Binding>();
        // A created meta named viewport by the script (m.name = 'viewport' / m.setAttribute('name', 'viewport')).
        for (var k = 1; k + 3 < t.Count; k++)
        {
            if (!s.Is(k, ".") || !s.IsIdent(k - 1)) continue;
            var viewportName = s.Is(k + 1, "name") && s.Is(k + 2, "=") && s.StringAt(k + 3) is { } v && v.Trim().Equals("viewport", StringComparison.OrdinalIgnoreCase)
                || s.Is(k + 1, "setAttribute") && s.Is(k + 2, "(") && s.StringAt(k + 3)?.Trim() == "name" && s.Is(k + 4, ",") && s.StringAt(k + 5)?.Trim().Equals("viewport", StringComparison.OrdinalIgnoreCase) == true;
            if (viewportName && s.Resolve(t[k - 1].Text, s.ScopeOf[k - 1]) is { } named) viewportFlagged.Add(named);
        }
        bool IsViewport(int start, int end)
        {
            var origin = Classify(s, start, end);
            if (origin.Viewport) return true;
            if (end - start == 1 && s.IsIdent(start) && s.Resolve(t[start].Text, s.ScopeOf[start]) is { } b && viewportFlagged.Contains(b))
                return origin.Kind is O.Created or O.Ambiguous || origin.Kind == O.Query && origin.Viewport;
            return false;
        }

        for (var k = 0; k < t.Count; k++)
        {
            // ---- member uses: receiver . name ...
            if (s.Is(k, ".") && k > 0 && k + 1 < t.Count && s.IsIdent(k + 1))
            {
                var name = t[k + 1].Text;
                var receiverStart = s.ChainStart(k - 1);
                var assigned = s.Is(k + 2, "=") || s.Is(k + 2, "+=");
                var called = s.Is(k + 2, "(");
                if (TextProperties.Contains(name) && assigned || MarkupCalls.Contains(name) && called)
                    Write(s, receiverStart, k, name, null, context, owned, Add);
                else if (AttributeCalls.Contains(name) && called)
                {
                    var attribute = s.StringAt(k + 3) is { } a && (s.Is(k + 4, ",") || s.Is(k + 4, ")")) ? a : null;
                    if (name == "setAttribute" && attribute?.Trim() == "content" && IsViewport(receiverStart, k))
                        Viewport(s, k + 5, context, Add);
                    else Write(s, receiverStart, k, name, attribute ?? "", context, owned, Add);
                }
                else if (name == "className" && assigned)
                {
                    if (Classify(s, receiverStart, k).Kind == O.Body) Words(s, k + 3, s.StatementEnd(k + 3), deviceClasses);
                    else Write(s, receiverStart, k, "className", "class", context, owned, Add);
                }
                else if (name == "content" && s.Is(k + 2, "=") && IsViewport(receiverStart, k)) Viewport(s, k + 3, context, Add);
                else if (name == "classList" && s.Is(k + 2, ".") && s.IsIdent(k + 3) && ClassCalls.Contains(t[k + 3].Text) && s.Is(k + 4, "(")
                         && Classify(s, receiverStart, k).Kind == O.Body)
                {
                    foreach (var (start, end) in s.Arguments(k + 4))
                        if (end - start == 1 && s.StringAt(start) is { } word && DeviceClasses.Contains(word.Trim().ToLowerInvariant())) deviceClasses.Add(word.Trim().ToLowerInvariant());
                }
                else if (name == "observe" && called && s.Arguments(k + 2) is [var target, var options, ..])
                {
                    var kind = Classify(s, target.Start, target.End).Kind;
                    if (kind is O.Body or O.Root or O.Document && Subtree(s, options))
                    {
                        var what = string.Concat(t.Skip(target.Start).Take(target.End - target.Start).Select(x => x.Text));
                        if (disconnects)
                            Add(ReactiveClientRules.DomMutation, "warning",
                                $"the script observes {what} with subtree:true until it disconnects: until then every render of the runtime (each data fetch, each keystroke in an input) runs its callback",
                                "keep it if it disconnects as soon as its condition holds; better, observe only the element the script owns, or act in the screen's or block's OnReady or OnRender event");
                        else
                            Add(ReactiveClientRules.DomMutation, "error",
                                $"the script observes {what} with subtree:true and never disconnects: every render of the runtime (each data fetch, each keystroke in an input) runs its callback, and a callback that writes the page triggers itself again",
                                "drop the MutationObserver: bind what it adjusts in the widgets (their expressions, Style Classes and Visible), or run the adjustment from the screen's or block's OnRender event on the elements it owns");
                    }
                }
            }
            // ---- new Date(x) / Date.parse(x) of an attribute's text
            var parse = s.Is(k, "new") && s.Is(k + 1, "Date") && s.Is(k + 2, "(") ? k + 2 : s.Is(k, "Date") && s.Is(k + 1, ".") && s.Is(k + 2, "parse") && s.Is(k + 3, "(") ? k + 3 : -1;
            if (parse > 0 && s.Arguments(parse) is [var only]) DateParse(s, only, context, Add);
            // ---- jQuery: $(document.body).addClass('phone') / $('body')...
            if ((s.Is(k, "$") || s.Is(k, "jQuery")) && s.Is(k + 1, "(") && s.Match[k + 1] > k + 1)
            {
                var close = s.Match[k + 1];
                var body = s.StringAt(k + 2)?.Trim() == "body" && close == k + 3 || Classify(s, k + 2, close).Kind == O.Body;
                if (body && s.Is(close + 1, ".") && s.IsIdent(close + 2) && t[close + 2].Text is "addClass" or "removeClass" or "toggleClass" && s.Is(close + 3, "(")
                    && s.StringAt(close + 4) is { } words)
                    foreach (var word in words.Split(' ', StringSplitOptions.RemoveEmptyEntries)) if (DeviceClasses.Contains(word.ToLowerInvariant())) deviceClasses.Add(word.ToLowerInvariant());
            }
        }
        if (deviceClasses.Count > 0)
            Add(ReactiveClientRules.RuntimeDuplicate, "error",
                $"the script sets the device classes {string.Join(", ", deviceClasses)} on body: the runtime's UI framework already keeps them there by its own breakpoints, and two writers with different breakpoints disagree on resize",
                "remove the class toggling and style with the runtime's classes (.phone, .tablet, .desktop, .portrait, .landscape on body) as they are");
        return found;

        void Words(Script s2, int start, int end, SortedSet<string> into)
        {
            for (var j = start; j < end; j++)
                if (s2.StringAt(j) is { } text)
                    foreach (var word in Regex.Split(text, @"[^A-Za-z]+")) if (DeviceClasses.Contains(word.ToLowerInvariant())) into.Add(word.ToLowerInvariant());
        }
    }

    private static bool Subtree(Script s, (int Start, int End) options)
    {
        if (!s.Is(options.Start, "{")) return false;
        for (var j = options.Start + 1; j + 2 < options.End; j++)
            if (s.Is(j, "subtree") && s.Is(j + 1, ":") && (s.Is(j + 2, "true") || s.Is(j + 2, "!") && s.T[j + 3].Text == "0" || s.T[j + 2].Kind == K.Num && s.T[j + 2].Text == "1")) return true;
        return false;
    }

    private static void Write(Script s, int receiverStart, int dot, string property, string? attribute, ScriptContext context, HashSet<string> owned,
        Action<string, string, string, string> add)
    {
        var origin = Classify(s, receiverStart, dot);
        if (origin.Kind is not (O.Query or O.Ambiguous) || origin.Text.Length == 0) return;
        var (where, marker) = Ownership(origin.Text, owned);
        if (where == Own.None) return;
        var target = string.Concat(s.T.Skip(receiverStart).Take(dot - receiverStart).Select(x => x.Kind == K.Str ? "'" + x.Text + "'" : x.Text));
        var bind = "bind the value in the widget instead (its expression, an attribute written {{ expression }}, or its Style Classes) and remove the write; a script writes only elements it creates itself or containers the job leaves empty";
        if (origin.Kind == O.Ambiguous)
        {
            add(ReactiveClientRules.DomMutation, "warning",
                $"the script writes {property} through '{target}', which holds the elements '{origin.Text}' selects on one path and another value on another: on that path the write overwrites what the runtime renders",
                "give each element its own variable, and " + bind);
            return;
        }
        var managed = attribute == null || attribute.Length > 0 && (ManagedAttributes.Contains(attribute) || context.RuntimeAttributes.Contains(attribute) || context.Bound.Contains(attribute) || owned.Contains(attribute));
        if (attribute != null && !managed)
        {
            add(ReactiveClientRules.DomMutation, "warning",
                $"the script {(attribute.Length == 0 ? "sets an attribute it computes" : $"sets the attribute '{attribute}'")} on the elements '{origin.Text}' selects ([{marker}]: the runtime renders them): the runtime does not render '{(attribute.Length == 0 ? "it" : attribute)}', but it drops it whenever it renders those elements again",
                "keep it if the script applies it again after each render (the screen's OnRender event), or write the attribute in the widget with {{ expression }}");
            return;
        }
        if (where == Own.Subject)
            add(ReactiveClientRules.DomMutation, "error",
                $"the script writes {(attribute == null ? property : $"the attribute '{attribute}'")} of the elements '{origin.Text}' selects: [{marker}] is on elements the runtime renders (an expression, a list or a block), so the write overwrites what the runtime shows and is lost or fought on its next render",
                bind);
        else
            add(ReactiveClientRules.DomMutation, "warning",
                $"the script writes {(attribute == null ? property : $"the attribute '{attribute}'")} of '{origin.Text}', inside what the runtime renders ([{marker}] on an ancestor): if the runtime renders that element too, its next render overwrites the write",
                "keep it if the target is a container the job owns and leaves empty (a chart or map host); otherwise " + bind);
    }

    private static void Viewport(Script s, int valueStart, ScriptContext context, Action<string, string, string, string> add)
    {
        var end = s.StatementEnd(valueStart);
        var value = end - valueStart == 1 ? s.StringAt(valueStart) : null;
        if (value == null)
            add(ReactiveClientRules.RuntimeDuplicate, "warning",
                "the script writes the content of meta[name=viewport] with a value it computes: the runtime writes the page's viewport itself, and a second writer changes zoom and scaling under it",
                "keep it only if the page must change its viewport at run time; otherwise remove it (the viewport comes from the runtime's layout)");
        else if (ZoomLock.IsMatch(value))
            add(ReactiveClientRules.RuntimeDuplicate, "warning",
                $"the script sets the viewport to '{value}', which locks the zoom (a kiosk or full-screen page): the runtime writes the viewport too",
                "keep it if the page must lock the zoom; otherwise remove it (the viewport comes from the runtime's layout)");
        else
            add(ReactiveClientRules.RuntimeDuplicate, "error",
                $"the script rewrites meta[name=viewport] (content '{value}'): the runtime writes the page's viewport itself, and a second writer changes zoom and scaling under it",
                "remove the viewport rewrite; the application's viewport comes from the runtime (the layout of its template)");
    }

    private static void DateParse(Script s, (int Start, int End) argument, ScriptContext context, Action<string, string, string, string> add)
    {
        var t = s.T;
        // Arithmetic or a number is a time value in milliseconds, never a text to read.
        for (var j = argument.Start; j < argument.End; j++)
            if (t[j].Kind == K.Num || t[j].Kind == K.Punct && t[j].Text is "*" or "-" or "/" or "%" || s.Is(j, "now") || s.Is(j, "getTime") || s.Is(j, "valueOf")) return;
        var marked = false;
        var reads = new List<(string Attribute, bool Ambiguous)>();
        foreach (var (start, end) in Terms(s, argument))
        {
            if (end - start == 1 && s.StringAt(start) is { } literal) { if (UtcAfter.IsMatch(literal)) marked = true; continue; }
            var origin = Classify(s, start, end);
            // A variable that holds the text (or the text trimmed), read once.
            if (origin.Kind == O.Other && end - start > 2 && s.Is(end - 1, ")") && s.IsIdent(s.Match[end - 1] - 1) && s.T[s.Match[end - 1] - 1].Text is "trim" or "toString" or "valueOf")
                origin = Classify(s, start, s.Match[end - 1] - 2);
            if (origin.Kind == O.Read) reads.Add((origin.Text, false));
            else if (origin.Kind == O.Ambiguous && origin.Text.Length > 0) reads.Add((origin.Text, true));
        }
        foreach (var (attribute, ambiguous) in reads)
        {
            var filler = context.Fillers.TryGetValue(attribute, out var f) ? f : (Filler?)null;
            var certain = !ambiguous && (filler == Filler.ClientDateTimeMarkedUtc || filler == Filler.ClientDateTime && marked);
            var why = filler == Filler.ClientDateTimeMarkedUtc ? "which this job fills with a Date Time of client-side code marked UTC"
                : filler == Filler.ClientDateTime && marked ? "which this job fills with a Date Time of client-side code, and the script marks it UTC"
                : null;
            if (why != null)
                add(ReactiveClientRules.DateTimeReinterpreted, certain ? "error" : "warning",
                    $"the script parses as a Date (new Date / Date.parse) the attribute '{attribute}', {why}: the text holds the browser's local time, so reading it as UTC shifts it a second time",
                    $"show the Date Time in the widget's own expression, FormatDateTime(<the Date Time>, \"<display mask>\"), and remove '{attribute}' and the part of the script that parses it; a script that needs a UTC instant reads a text made on the server (a server action or Data Action output)");
            else if (filler == null && (HasUtcWord(attribute) || marked))
                add(ReactiveClientRules.DateTimeReinterpreted, "warning",
                    $"the script parses the attribute '{attribute}' as UTC (new Date / Date.parse{(marked ? " with a UTC mark" : "")}), and this job does not write it: if it holds a Date Time formatted in client-side code and marked UTC, the parse shifts it a second time",
                    "nothing to change if the attribute holds a UTC text made on the server; if client-side code fills it, show the Date Time in the widget's own expression instead, FormatDateTime(<the Date Time>, \"<display mask>\")");
        }
    }

    /// <summary>The terms of a + concatenation (an argument without one is one term).</summary>
    private static IEnumerable<(int Start, int End)> Terms(Script s, (int Start, int End) range)
    {
        var start = range.Start;
        for (var j = range.Start; j < range.End; j++)
        {
            if (s.Is(j, "(") || s.Is(j, "[") || s.Is(j, "{")) { if (s.Match[j] < 0) break; j = s.Match[j]; continue; }
            if (s.Is(j, "+")) { yield return (start, j); start = j + 1; }
        }
        if (range.End > start) yield return (start, range.End);
    }
}
