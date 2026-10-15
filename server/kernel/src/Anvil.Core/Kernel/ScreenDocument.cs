using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core;

/// <summary>
/// The document form of the html op (B1 of the plan "Texto do SSAM", sections 1, 2 and 8): <c>data.html</c> starting with
/// <c>&lt;screen</c> or <c>&lt;block</c> is one whole screen or block in ssam-html/1, the text the reading (ScreenHtml, C1)
/// writes, compiled straight into the model by ModelSession.DocumentCompiler. This half holds what needs no module: the
/// recognition of the form, the module-free preflight (parse, one root, the owner's rules on new elements) and the nearest
/// name of a refusal. Every problem of a document comes in one refusal, each with its line and column and, when the fix is
/// unique, the corrected document as a patch of the op.
/// </summary>
public static partial class ScreenDocument
{
    public const string Invalid = "HTML_INVALID";
    public const string NameUnknown = "HTML_NAME_UNKNOWN";
    public const string NameAmbiguous = "HTML_NAME_AMBIGUOUS";
    public const string Script = "HTML_SCRIPT";
    public const string Visible = "HTML_VISIBLE";
    public const string Json = "HTML_JSON";
    public const string KeyForeign = "HTML_KEY_FOREIGN";
    public const string OpaqueTouched = "HTML_OPAQUE_TOUCHED";
    public const string RootExists = "HTML_ROOT_EXISTS";
    public const string Traditional = "HTML_TRADITIONAL";

    private static readonly Regex Leading = new(@"^\s*(?:<!--.*?-->\s*)*<(screen|block)[\s/>]", RegexOptions.Singleline | RegexOptions.Compiled);

    /// <summary>The html of a document form: one &lt;screen&gt; or &lt;block&gt; (comments and spaces before it allowed).</summary>
    public static bool IsDocument(string? html) => html != null && Leading.IsMatch(html);

    /// <summary>The contract of the document form for `api --op html` (key "document"): the text is the one the reading
    /// writes (its elements, attributes and names: ScreenHtml.Contract(), ssam_map view html), plus what an author writes new.</summary>
    public static JsonObject Schema() => new()
    {
        ["form"] = "data.html that starts with <screen name=\"...\"> or <block name=\"...\">: one whole new screen or block in ssam-html/1, the text ssam_map view html reads; no parent",
        ["root"] = "<screen name flow? title roles actions data-actions description os-*> or <block name ...>; flow defaults to the module's one UI flow (or MainFlow); the content goes inside the layout block: <Block name=\"LayoutTopMenu\"><slot name=\"MainContent\">...</slot></Block>",
        ["data"] = "<input name type default/>, <var name type default/>, <aggregate name from=\"Entity\" join=\"Other on <condition>; ...\" where=\"<condition>\" sort=\"Entity.Attr desc, ...\" max=\"50\"/> (or the long form the reading writes: os-AliasedSource, os-Join, os-Filter, os-Sort), <event name> in a block; types by name (Text, Pedido Identifier, Pedido List)",
        ["widgets"] = "the reading's table (ScreenHtml.Contract().elements): div, form, a, button, input, textarea, select (empty, options, value, label), radio-group, switch, button-group/button-group-item, label (for), img (src), i (icon), upload, popup, <x list=\"Source\">, <div if> + <div else>, <Block name :Input @Event> + <slot name>, {{ expression }}, text; any other tag of the platform is an HTML Element; os-<Property> for any other property",
        ["events"] = "on<event>=\"Destination(Param = expression, ...)\" or Destination(expression, ...) by position over its inputs: onclick, onchange, onready... and HTML events (onblur, onkeypress) of an HTML Element or a Container; @Event on a <Block>; os-on<event>.<Property>",
        ["actions"] = "actions=\"A, B\" names the screen actions; a logic op of the same job, after this op, declares each one (a flow text \"action <Name>.A\", or kind screen with owner IMobileScreen:<Name>): born before the content so the events bind, filled in place; data-actions=\"D\" with \"data action <Name>.D\" (or kind data)",
        ["names"] = "every name resolves as the reading's: the page, the module and its references, the other screens, the types; Kind:Name or Owner.Name when one is not enough",
        ["css"] = "every <style> of the document, wherever it is, then data.css: the screen's or block's own style sheet, as written (the reading writes it back as one <style>); <style scope=\"theme\">: the module's default theme, between the markers of the root, as written; <style scope=\"theme\" id=\"name\"> is a named theme part: written once to the module theme, any document of any delivery may send it; the others leave those rules out; a <style> with another attribute (media...) is refused, a media one with the patch that moves it to data.css as its @media block; CSS the theme does not render (light-dark(), color-mix()) is refused with the rendered stylesheet as the patch",
        ["bindings"] = "a line of text with bindings (\"Hoje · {{ X }}\", \"{{ N }} dias\") is one Expression, their concatenation (\"Hoje · \" + X), read back as {{ \"Hoje · \" + X }}; an attribute the same (class=\"a {{ X }}\"); a {{ that never closes, a }} with no {{ and {{ }} are refused (literal braces go in <text>)",
        ["checks"] = "before the op answers, the model it wrote is read again: the style sheet is the CSS of the document, no text keeps {{ or }}, no new Expression is empty (else nothing is written, one refusal); a class no rule defines (the page's CSS, the module themes, OutSystems UI) is the warning HTML_CLASS_NO_RULE, with the patch that puts another document's <style> in the theme when it has them",
        ["native"] = "what has one native reading is written in it and listed in normalized: an inline <svg> in currentColor or one color (nothing written is the SVG's black, #000) is a span.ssam-icon with its mask class (the rule in the page's style sheet; the svg and span selectors widened to it), any other svg (two colors, currentColor beside a color: noted, it is black in an image) the External image of its markup, a <use> of an element of the page copied in; <img src> with a URL with its scheme, a data URL or an absolute path is the External image of that Url, a file name (logo.png) the module image of its base name, a {{ }} by its type (Binary Data: Type Binary with that content; a text: External); style with a binding on a widget is the attribute style (ext:style); a constant binding in a property that takes a literal is the literal; an inline number with a fraction is calc(n) (the runtime keeps it); the whitespace beside an inline element on its line is kept; an event inside a Popup is at the Popup's Transition (Fade)",
        ["refusals"] = new JsonObject
        {
            [StyleUnplaced] = "a <style> that cannot go to the style sheet as written (media, an unknown scope, another attribute): media gets the patch that moves its CSS to data.css as its @media block",
            [StyleDropped] = "the style sheet or the theme does not hold the CSS of the document after the write (nothing is written)",
            [BindingInvalid] = "a {{ that never closes, a }} with no {{, {{ }} with no expression, in a line of text or an attribute",
            [BindingLeft] = "a text widget keeps {{ or }} after the write (nothing is written)",
            [ExpressionEmpty] = "{{ }} or <expr> with no value on a new element",
            [BindingLiteral] = "a binding that names something in a property that takes a literal (text, number, enum: its Model API type): the page would show the braces",
            [Anvil.Reading.ScreenHtmlNative.ImageContradiction] = "<img> with a URL in src and another os-Type, or two sources (src and url)",
            [Anvil.Reading.ScreenHtmlNative.ImageFileUnknown] = "<img src> with a file name (logo.png) whose base name is no image of the module: the nearest names, the patch when one is nearest",
            [Anvil.Reading.ScreenHtmlNative.ImageBindingType] = "<img src=\"{{ }}\"> whose expression is neither a text nor a Binary Data this side knows: url + os-Type External, or os-Type Binary + os-ImageContent",
            [Anvil.Reading.ScreenHtmlNative.SvgInnerCss] = "a CSS rule for the inside of an svg (path, circle, g...) in the page or the theme, when an svg becomes a native icon or image: it would style nothing",
            [Anvil.Reading.ScreenHtmlNative.SvgUseExternal] = "an svg <use> of another file or of no element of the document: the native icon or image would be empty",
            [CssCompat.Code] = "CSS the OutSystems theme does not render, in a <style> or data.css: the patch writes the rendered stylesheet",
            [NameUnknown] = "a name that does not exist (types, blocks, placeholders, inputs, events, destinations, images, entities, and the names inside expressions): the 3 nearest of the same kind and, when one is certain, the corrected document as the patch",
            [NameAmbiguous] = "a name of two elements: Kind:Name or Owner.Name",
            [Visible] = "a new os-Visible (U1): the patch wraps the element in <div if=\"...\">",
            [Script] = "<script>, javascript:, JavaScript in an event (L5): the patch removes it; JavaScript lives only in an isolated, named client action",
            [ForEach] = "the iteration of another framework (v-for, x-for, ng-repeat, *ngFor, th:each, foreach): the patch writes list=\"Source\" with the row as Source.Current",
            [Json] = "JSONSerialize/JSONDeserialize in a binding (L6)",
            [RecordLiteral] = "a record literal { A: x } in an O11 expression (the O11 parser does not read it)",
            [RootExists] = "the screen or block already exists: the document form creates; a change goes by the reading and the edit by k",
            [KeyForeign] = "k on an element that is not of the reading basedOn names",
            [OpaqueTouched] = "<os-opaque> outside a reading",
            [Traditional] = "a Traditional Web flow (D2)",
        },
        ["kept"] = "an element with k of a reading (basedOn {capture, html}) keeps its Visible, JavaScript and JSON: listed in preserved[], never refused",
        ["once"] = "every problem of the document comes in one refusal, each with its line and column",
    };

    /// <summary>The html op in the document form: no parent, data.html is a document, and not the edit of a reading
    /// (ScreenHtmlEdit.IsEdit: a whole document with basedOn and screen edits that screen). The same op is never both.</summary>
    public static bool IsDocumentOp(JsonNode? op) =>
        op is JsonObject o && o["parent"] == null && o["data"] is JsonObject data && data["html"] is JsonValue v && v.TryGetValue<string>(out var text) && IsDocument(text)
        && !ScreenHtmlEdit.IsEdit(o);

    // ---- the owner's rules on what a document writes new (decisions of 2026-10-11) -------------------------------------
    // Visible, JavaScript and JSON already in a screen that was read are kept and listed; a new element never writes them:
    // the refusal brings the pattern (an If around it; the native event; the record or list passed as it is).
    private static readonly Regex JsonCall = new(@"\bJSON(Serialize|Deserialize)\s*\(", RegexOptions.Compiled);

    public const string ForEach = "HTML_FOREACH";
    public const string RecordLiteral = "HTML_RECORD_LITERAL";

    /// <summary>The correction of a problem in the text of the document (the corrected document is the patch of the op):
    /// a name replaced in one attribute; an attribute removed (with the element wrapped in an If, for a new Visible); the
    /// element removed; an iteration of another framework turned into the List of the language.</summary>
    internal abstract record Correction;
    internal sealed record ReplaceName(string Attribute, string Wrong, string Right) : Correction;
    internal sealed record RemoveAttribute(string Attribute, string? WrapIf = null) : Correction;
    internal sealed record RemoveElement : Correction;
    internal sealed record IterateAsList(string Attribute, string Source, string? Alias) : Correction;
    /// <summary>The value of one attribute written again whole (an expression that does not parse, as its string literal).</summary>
    internal sealed record SetAttribute(string Attribute, string Value) : Correction;
    /// <summary>A &lt;style&gt; the document cannot place as written leaves the html and its CSS (<paramref name="Css"/>, what it
    /// means written plain: a media attribute becomes its @media block) goes to the end of data.css.</summary>
    internal sealed record MoveStyle(string Css) : Correction;
    /// <summary>The CSS of a &lt;style&gt; written again (the rendered stylesheet of CssCompat).</summary>
    internal sealed record RewriteStyle(string Css) : Correction;
    /// <summary>data.css written again (the rendered stylesheet of CssCompat); the html stays.</summary>
    internal sealed record RewriteDataCss(string Css) : Correction;

    internal sealed record Problem(string Code, int Line, int Column, string Message, string? Fix,
        IReadOnlyList<string>? Candidates = null, (string Attribute, string Wrong, string Right)? Replace = null, JsonArray? Patch = null,
        Correction? Correct = null, bool InCss = false)
    {
        public Correction? Correction => Correct ?? (Replace is { } r ? new ReplaceName(r.Attribute, r.Wrong, r.Right) : null);
    }

    // The iterations other frameworks write on an element (v-for, x-for, ng-repeat, *ngFor, th:each, foreach): the language
    // has one, the List (<x list="Source">, the row is Source.Current).
    private static readonly string[] IterationAttributes = ["v-for", "x-for", "ng-repeat", "*ngFor", "th:each", "foreach", "for-each"];
    /// <summary>Whether the attribute is another framework's iteration (v-for, x-for, ng-repeat, *ngFor, th:each, foreach).</summary>
    internal static bool IsIterationAttribute(string name) => IterationAttributes.Contains(name, StringComparer.OrdinalIgnoreCase);

    /// <summary>The source and the alias of an iteration's value ("n in Nomes": Nomes, n); plain when the source is a name.</summary>
    internal static (string Source, string? Alias, bool Plain) ParseIteration(string value)
    {
        var parsed = Iteration.Match(value);
        var source = parsed.Success ? parsed.Groups[2].Value.Trim() : value.Trim();
        return (source, parsed.Success ? parsed.Groups[1].Value : null, source.Length > 0 && Regex.IsMatch(source, @"^[A-Za-z_][A-Za-z0-9_.]*$"));
    }

    /// <summary>What a rewritten iteration names, for the check of its patch: whether the source is data of the page (an
    /// aggregate, a variable or an input of the document, or an output of one of its data actions), the record its row reads
    /// (the aggregate's one entity, the record type of a list variable), whether the list holds values (Text List...), the
    /// members of the row it reads and whether it reads the row whole. Output: the source is an output of a data action of the
    /// page (CartCards.Cards), whose record the reading does not write: its members are the Verify's to judge.</summary>
    internal sealed record IterationUse(bool Declared, string? Record, bool Values, IReadOnlyList<string> Members, bool Whole, bool Output = false);

    private static readonly HashSet<string> ValueTypes = new(StringComparer.OrdinalIgnoreCase)
        { "Text", "Integer", "Long Integer", "Decimal", "Boolean", "Date", "Date Time", "DateTime", "Time", "Currency", "Email", "Phone Number" };

    /// <summary>The iteration of an element of a parsed tree turned into the List, in place (the edit form's correction, as
    /// Correct does on a document's text): the attribute becomes list="..." and the alias in the element's expressions the
    /// current item. <paramref name="document"/> holds the data the source may name (an aggregate of the page). Null when the
    /// element has no such attribute.</summary>
    internal static IterationUse? IterateInTree(ScreenHtml.Node element, string attribute, string source, string? alias, ScreenHtml.Node document)
    {
        var at = element.Attributes.FindIndex(a => a.Key == attribute);
        if (at < 0) return null;
        var (list, row, member) = IterationShape(source, document);
        element.Attributes[at] = new("list", list);
        var name = source.EndsWith(".List", StringComparison.Ordinal) ? source[..^5] : source;
        var data = Descendants(document).FirstOrDefault(n => n.Tag is "aggregate" or "var" or "input" && n.Get("name") == name && (n.Tag != "input" || n.Get("bind") == null));
        var type = data?.Tag == "aggregate" ? null : data?.Get("type");
        var values = type != null && type.EndsWith(" List", StringComparison.Ordinal) && ValueTypes.Contains(type[..^5]);
        var record = data?.Tag == "aggregate" ? (AggregateSources(data) is { Count: 1 } one && !Joined(data) ? one[0].Record : null)
            : type != null && type.EndsWith(" List", StringComparison.Ordinal) && !values ? type[..^5] : null;
        // An output of a data action the page lists (data-actions="CartCards": CartCards.Cards), the row read as Source.Current.
        var output = data == null && source.IndexOf('.') is var dot and > 0 && DataActions(document).Contains(source[..dot]);
        var members = new List<string>(); var whole = false;
        if (alias != null)
        {
            var use = new Regex(@"(?<![A-Za-z0-9_.])" + Regex.Escape(alias) + @"(?:\.([A-Za-z_][A-Za-z0-9_]*))?(?![A-Za-z0-9_])");
            string Rewrite(string expression) => use.Replace(expression, m => {
                if (m.Groups[1].Success) { members.Add(m.Groups[1].Value); return member(m.Groups[1].Value); }
                whole = true; return row;
            });
            string InRuns(string text) => Regex.Replace(text, @"\{\{(.*?)\}\}", m => "{{" + Rewrite(m.Groups[1].Value) + "}}", RegexOptions.Singleline);
            foreach (var (node, _) in ScreenHtmlText.Elements(element))
            {
                for (var i = 0; i < node.Attributes.Count; i++)
                {
                    var (key, value) = node.Attributes[i];
                    if (ReferenceEquals(node, element) && i == at) continue;
                    var expression = key is "if" or "list" || key.StartsWith("on", StringComparison.Ordinal) || key.StartsWith("html:on", StringComparison.Ordinal)
                        || key.StartsWith(':') || key.StartsWith('@') || key.StartsWith("os-", StringComparison.Ordinal);
                    node.Attributes[i] = new(key, expression ? Rewrite(value) : InRuns(value));
                }
                foreach (var child in node.Children.Where(c => c.IsText)) child.Text = InRuns(child.Text ?? "");
            }
        }
        return new(data != null || output, record, values, members, whole, output);
    }

    // The sources of an aggregate of a document, by alias with the entity or structure each reads: the short form (from="E",
    // join="Other on ...") and the long one the reading writes (os-AliasedSource name="A" os-Source="ServerEntity:E").
    private static List<(string Alias, string Record)> AggregateSources(ScreenHtml.Node aggregate)
    {
        var sources = new List<(string, string)>();
        if (aggregate.Get("from") is { Length: > 0 } from) sources.Add((from, from));
        foreach (var join in (aggregate.Get("join") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            if (Regex.Match(join, @"^([A-Za-z_][A-Za-z0-9_]*)\s") is { Success: true } other) sources.Add((other.Groups[1].Value, other.Groups[1].Value));
        foreach (var aliased in Descendants(aggregate).Where(n => n.Tag == "os-AliasedSource" && n.Get("name") is { Length: > 0 }))
        {
            var entity = aliased.Get("os-Source") is { } reference ? reference[(reference.IndexOf(':') + 1)..] : aliased.Get("name")!;
            sources.Add((aliased.Get("name")!, entity));
        }
        return sources;
    }

    private static bool Joined(ScreenHtml.Node aggregate) => aggregate.Get("join") != null || Descendants(aggregate).Any(n => n.Tag == "os-Join");

    // The data actions the root of a document lists (data-actions="A, B").
    private static HashSet<string> DataActions(ScreenHtml.Node document)
    {
        var root = document.Tag is "screen" or "block" ? document : document.Children.FirstOrDefault(c => !c.IsText && c.Tag is "screen" or "block");
        return (root?.Get("data-actions") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>The alias of a foreign iteration on the element (v-for="n in Nomes" gives n), or null.</summary>
    internal static string? IterationAlias(ScreenHtml.Node node)
    {
        foreach (var (name, value) in node.Attributes)
            if (IterationAttributes.Contains(name, StringComparer.OrdinalIgnoreCase) && Iteration.Match(value) is { Success: true } m) return m.Groups[1].Value;
        return null;
    }
    private static readonly Regex Iteration = new(@"^\s*(?:let\s+|const\s+|var\s+)?\(?\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*[A-Za-z_][A-Za-z0-9_]*\s*)?\)?\s+(?:in|of|:)\s+(?:\$\{\s*)?(.+?)\s*\}?\s*(?:;.*)?$", RegexOptions.Singleline | RegexOptions.Compiled);

    /// <summary>L5 judged on what an attribute is in the browser, not on how it is spelled (the review of rounds 1 and 2: script
    /// went in through ext:onmouseover, OnMouseOver, an iframe src written as {{ "javascript:..." }} and srcdoc): "event" for an
    /// on* attribute the page writes as it is (ext:on..., or another case: the browser reads OnMouseOver as onmouseover) whatever
    /// its value; "srcdoc" (a page inside the page, its scripts run); "url" for a javascript: or vbscript: URL, written literally
    /// or as a constant of an expression. Null: none of these (a lower-case on* event is the decoder's: Destination(...)).</summary>
    internal static string? ScriptAttribute(string name, string value)
    {
        var bare = name.StartsWith("ext:", StringComparison.Ordinal) ? name[4..] : name;
        if (bare.Equals("srcdoc", StringComparison.OrdinalIgnoreCase)) return "srcdoc";
        if (bare.Length > 2 && bare.StartsWith("on", StringComparison.OrdinalIgnoreCase) && bare.Skip(2).All(char.IsLetter) && !name.StartsWith("on", StringComparison.Ordinal)) return "event";
        return ScriptUrl(value) ? "url" : null;
    }

    /// <summary>Whether a value is a script URL: the text, or (an expression {{ ... }}) one of its string literals or their
    /// concatenation, without the spaces and control characters a browser drops, starts with javascript: or vbscript:.</summary>
    internal static bool ScriptUrl(string value)
    {
        static bool Script(string text)
        {
            var plain = new string(text.Where(c => c > ' ').ToArray());
            return plain.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase) || plain.StartsWith("vbscript:", StringComparison.OrdinalIgnoreCase);
        }
        if (Script(value)) return true;
        var trimmed = value.Trim();
        if (!(trimmed.StartsWith("{{", StringComparison.Ordinal) && trimmed.EndsWith("}}", StringComparison.Ordinal))) return false;
        var literals = Regex.Matches(trimmed[2..^2], "\"((?:[^\"]|\"\")*)\"").Select(m => m.Groups[1].Value.Replace("\"\"", "\"")).ToList();
        return literals.Any(Script) || literals.Count > 1 && Script(string.Concat(literals));
    }

    /// <summary>os-Visible written in another case (OS-VISIBLE, Os-Visible, os-visible): the same property for an author (an
    /// attribute name has no case in HTML), judged as the new Visible it would be (U1), never kept as an inert attribute.</summary>
    internal static bool VisibleInAnotherCase(string name) => name != "os-Visible" && name.Equals("os-Visible", StringComparison.OrdinalIgnoreCase);

    /// <summary>The checks of one element that need no module: the rules on what is new. <paramref name="read"/>: the element
    /// carries the k of the reading the document is based on (it exists, so what it has is kept and listed).</summary>
    internal static IEnumerable<Problem> RuleProblems(ScreenHtml.Node node, bool read, Action<string, string>? keep)
    {
        if (node.Tag == "script")
        {
            yield return new(Script, node.Line, node.Column, $"<script> is not compiled (L5: no new JavaScript in a page)",
                "the patch removes it; an event names a screen action (onclick=\"Save()\"), and JavaScript that has to exist lives only in an isolated, named client action (logic op, kind client, an IJavaScriptNode)",
                Correct: new RemoveElement());
            yield break;
        }
        if (node.Tag is "foreach" or "for-each" or "for")
        {
            yield return new(ForEach, node.Line, node.Column, $"<{node.Tag}> is not an element of the language: a repetition is a List",
                "<div list=\"<Aggregate>.List\"> with the row as <Aggregate>.List.Current inside (or tbody, ul, ol, section...)");
            yield break;
        }
        foreach (var (name, value) in node.Attributes)
        {
            if (ScriptAttribute(name, value) is { } script)
            {
                if (read) { keep?.Invoke(name, "javascript"); continue; }
                var what = script switch {
                    "event" => $"{name}=\"{Clip(value)}\" is the browser's event {(name.StartsWith("ext:", StringComparison.Ordinal) ? name[4..] : name).ToLowerInvariant()} (ext: and another case write the attribute as it is, and HTML reads its name without case): JavaScript (L5)",
                    "srcdoc" => $"{name}=\"{Clip(value)}\" writes a page inside the page, whose scripts run (L5)",
                    _ => $"{name}=\"{Clip(value)}\" runs JavaScript (L5)" };
                // A Button or a Link needs its On Click: without the script it is an invalid widget, so removing it is no fix.
                yield return script == "url" && NeedsItsClick(node, name)
                    ? new(Script, node.Line, node.Column, what, ClickFix(node))
                    : new(Script, node.Line, node.Column, what,
                        "the patch removes it; name a screen action or a screen: onclick=\"Save()\"; JavaScript lives only in an isolated, named client action", Correct: new RemoveAttribute(name));
                continue;
            }
            if (name.Equals("os-Visible", StringComparison.OrdinalIgnoreCase) && (value != "True" || VisibleInAnotherCase(name)))
            {
                if (read) { keep?.Invoke(name, value); continue; }
                var other = VisibleInAnotherCase(name) ? $" ({name} is os-Visible in another case: an attribute name has no case in HTML)" : "";
                yield return value == "True"
                    ? new(Visible, node.Line, node.Column, $"{name}=\"True\"{other}: the Visible every element has, written as an attribute", $"the patch removes {name}", Correct: new RemoveAttribute(name))
                    : new(Visible, node.Line, node.Column, $"{name}=\"{Clip(value)}\" writes a new Visible{other} (U1: a condition is an If)",
                        $"the patch removes {name} and puts the element inside <div if=\"{Clip(value)}\"> ... </div>", Correct: new RemoveAttribute(name, value));
                continue;
            }
            if (IterationAttributes.Contains(name, StringComparer.OrdinalIgnoreCase))
            {
                if (read) { keep?.Invoke(name, value); continue; }
                var parsed = Iteration.Match(value);
                var source = parsed.Success ? parsed.Groups[2].Value.Trim() : value.Trim();
                var alias = parsed.Success ? parsed.Groups[1].Value : null;
                var plain = source.Length > 0 && Regex.IsMatch(source, @"^[A-Za-z_][A-Za-z0-9_.]*$");
                yield return new(ForEach, node.Line, node.Column, $"{name}=\"{Clip(value)}\" is the iteration of another framework: a repetition is a List",
                    plain ? $"list=\"{source}\"" + (alias != null ? $", and the row {alias}.X is {source}.Current.X inside it" : "") : "list=\"<Aggregate>.List\", the row is <Aggregate>.List.Current inside",
                    Correct: plain ? new IterateAsList(name, source, alias) : null);
                continue;
            }
            if (name.StartsWith("on", StringComparison.Ordinal) || name.StartsWith('@') || name.StartsWith("html:", StringComparison.Ordinal))
                if (!name.Contains('.') && !ParseCall(value, out _, out _))
                {
                    if (read) { keep?.Invoke(name, value); continue; }
                    yield return NeedsItsClick(node, name)
                        ? new(Script, node.Line, node.Column, $"{name}=\"{Clip(value)}\" is not Destination(Param = expression, ...): JavaScript in an event is not compiled (L5)", ClickFix(node))
                        : new(Script, node.Line, node.Column, $"{name}=\"{Clip(value)}\" is not Destination(Param = expression, ...): JavaScript in an event is not compiled (L5)",
                            $"{name}=\"<ScreenAction or Screen>(<Input> = <expression>)\"; the patch removes the attribute", Correct: new RemoveAttribute(name));
                    continue;
                }
            if (JsonCall.IsMatch(value) && !name.StartsWith("os-on", StringComparison.Ordinal))
            {
                if (read) { keep?.Invoke(name, "JSON"); continue; }
                yield return new(Json, node.Line, node.Column, $"{name} serializes JSON in a binding (L6)", "pass the record or the list as it is; JSON belongs to an integration, in logic");
            }
        }
    }

    /// <summary>The click of a Button (&lt;button&gt;) or a Link (&lt;a&gt;): the platform requires its On Click
    /// (RequiredPropertyValue_Property), so the attribute cannot just go.</summary>
    internal static bool NeedsItsClick(ScreenHtml.Node node, string attribute)
        => node.Tag is "button" or "a" && attribute.Equals("onclick", StringComparison.OrdinalIgnoreCase);

    /// <summary>The fix of a script on the click of a Button or a Link: no patch (the widget needs its On Click).</summary>
    internal static string ClickFix(ScreenHtml.Node node)
        => $"name what the {(node.Tag == "a" ? "link" : "button")} runs: onclick=\"Save()\" (a screen action) or onclick=\"Home\" (a screen); a {(node.Tag == "a" ? "Link" : "Button")} needs its On Click, "
           + "so removing the script is no fix and there is no patch; JavaScript lives only in an isolated, named client action";

    /// <summary>A record literal ({ Field: expression, ... }) as an expression: the O11 expression parser does not read it (the
    /// Service Studio builds it in its own editor; the ODC parser reads it), so an O11 document never writes one. The structure
    /// goes through a variable of that type, or the optional input stays empty.</summary>
    internal static bool IsRecordLiteral(string expression) => Regex.IsMatch(expression, @"^\s*\{\s*[A-Za-z_][A-Za-z0-9_]*\s*:", RegexOptions.Singleline);

    // A destination with its arguments: Target, Target(), Target(P = expression, ...) as the reading writes it, or
    // Target(expression, ...) by position (the inputs of the target in order, as an author writes a call). The target is a
    // name form of the reading (Name, Kind:Name, Owner.Name, @key); anything else is not a call (JavaScript).
    private static readonly Regex TargetShape = new(@"^[A-Za-z_@~][A-Za-z0-9_:.@#+/=~\-]*$", RegexOptions.Compiled);
    private static readonly Regex NamedArgument = new(@"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*(.*)$", RegexOptions.Singleline | RegexOptions.Compiled);
    internal static bool ParseCall(string text, out string target, out List<(string? Param, string Value)> arguments)
    {
        arguments = [];
        var value = text.Trim();
        if (value.EndsWith(';')) value = value[..^1].TrimEnd();
        var open = value.IndexOf('(');
        target = open < 0 ? value : value[..open].TrimEnd();
        if (value.Length == 0) return true;
        if (!TargetShape.IsMatch(target)) return false;
        if (open < 0) return true;
        if (!value.EndsWith(')')) return false;
        var body = value[(open + 1)..^1];
        if (body.Trim().Length == 0) return true;
        var parts = new List<string>(); var depth = 0; var inString = false; var start = 0;
        for (var at = 0; at < body.Length; at++)
        {
            var c = body[at];
            if (inString) { if (c == '"') { if (at + 1 < body.Length && body[at + 1] == '"') at++; else inString = false; } continue; }
            if (c == '"') inString = true;
            else if (c is '(' or '[' or '{') depth++;
            else if (c is ')' or ']' or '}') { if (--depth < 0) return false; }
            else if (c == ',' && depth == 0) { parts.Add(body[start..at]); start = at + 1; }
        }
        if (inString || depth != 0) return false;
        parts.Add(body[start..]);
        // Named arguments permit optional spaces around '=' just like the expression-span reader (HtmlText.CallArguments).
        var named = parts.Select(p => NamedArgument.Match(p)).ToList();
        if (named.All(m => m.Success)) { arguments.AddRange(named.Select(m => ((string?)m.Groups[1].Value, m.Groups[2].Value))); return true; }
        foreach (var part in parts) { if (part.Trim().Length == 0) return false; arguments.Add((null, part.Trim())); }
        return true;
    }

    private static string Clip(string text) => text.Length > 80 ? text[..80] + "…" : text;

    /// <summary>What check-job proves of a document without a module: it parses, it is one &lt;screen&gt; or &lt;block&gt;
    /// with a name, and no element writes what the owner's rules refuse (new elements: an element with k is checked
    /// against its reading by the apply). Every problem at once.</summary>
    public static JsonObject Preflight(string html, string pointer) => Preflight(html, pointer, null);

    /// <summary>The same with the op's data.css (<paramref name="css"/>): the CSS of the document is its &lt;style&gt; blocks and
    /// data.css, checked here like the html (FidelityProblems: where each one goes, the CSS the theme does not render, the
    /// bindings of the text).</summary>
    public static JsonObject Preflight(string html, string pointer, string? css)
    {
        var problems = new List<Problem>();
        ScreenHtml.Node? document = null;
        try { document = ScreenHtml.Parse(html); }
        catch (FormatException error) { problems.Add(ParseProblem(error)); }
        if (document != null)
        {
            var roots = document.Children.Where(c => !c.IsText || c.Text!.Trim().Length > 0).ToList();
            if (roots.Count != 1 || roots[0].Tag is not ("screen" or "block"))
                problems.Add(new(Invalid, 1, 1, "a document is one <screen> or <block> and nothing around it", "wrap the page in <screen name=\"...\"> ... </screen>"));
            else
            {
                var top = roots[0];
                if (top.Get("name") is not { Length: > 0 } name || !ScreenHtml.IsIdentifier(name))
                    problems.Add(new(Invalid, top.Line, top.Column, $"<{top.Tag}> needs name=\"<Name>\" (letters, digits and _)", null));
                foreach (var node in Descendants(top))
                    problems.AddRange(RuleProblems(node, node.Get("k") != null, null));
                problems.AddRange(FidelityProblems(top, css, null));
            }
        }
        if (problems.Count > 0) throw CssRefusal(problems, html, pointer, css);
        return new JsonObject { ["form"] = "document", ["elements"] = document == null ? 0 : Descendants(document).Count() };
    }

    internal static IEnumerable<ScreenHtml.Node> Descendants(ScreenHtml.Node node)
    {
        foreach (var child in node.Children)
        {
            if (child.IsText) continue;
            yield return child;
            foreach (var inner in Descendants(child)) yield return inner;
        }
    }

    internal static Problem ParseProblem(FormatException error)
    {
        var match = Regex.Match(error.Message, @"line (\d+) col (\d+): (.*)$", RegexOptions.Singleline);
        return match.Success
            ? new(Invalid, int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture), int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture), match.Groups[3].Value, "write the element as ssam-html/1: every element closes, attribute values are quoted, & is &amp;")
            : new(Invalid, 1, 1, error.Message, null);
    }

    /// <summary>One refusal with every problem; the corrected document (every unique fix applied) is the patch of the
    /// problems that have one. <paramref name="pointer"/>: where the html sits in the op ("/data/html").</summary>
    internal static KernelRefusalException Refusal(IReadOnlyList<Problem> problems, string html, string pointer) => CssRefusal(problems, html, pointer, null);

    /// <summary>The same for an op with data.css (<paramref name="css"/>): a correction of the CSS (a &lt;style&gt; moved to
    /// data.css, data.css rewritten) is the patch of data.css, next to the corrected document.</summary>
    internal static KernelRefusalException CssRefusal(IReadOnlyList<Problem> problems, string html, string pointer, string? css)
    {
        var corrected = Correct(html, problems);
        var correctedCss = CorrectCss(css, problems);
        // The patch is checked before it is offered: the corrected document parses and no rule of what is new refuses it. With
        // the module, the apply also compiles it (ModelSession.CheckedDocumentRefusal) and offers only what compiles.
        if ((corrected != null && corrected != html || correctedCss != css) && !RulesPass(corrected ?? html, problems, correctedCss)) { corrected = null; correctedCss = css; }
        return Refusal(problems, html, pointer, corrected, css, correctedCss);
    }

    /// <summary>One refusal with every problem and the corrected document already checked (null: no patch).</summary>
    internal static KernelRefusalException Refusal(IReadOnlyList<Problem> problems, string html, string pointer, string? corrected)
        => Refusal(problems, html, pointer, corrected, null, null);

    /// <summary>The same with data.css and its corrected text (already checked; equal: no patch of data.css). The patch of the
    /// op is one list: the corrected document, then data.css.</summary>
    internal static KernelRefusalException Refusal(IReadOnlyList<Problem> problems, string html, string pointer, string? corrected, string? css, string? correctedCss)
    {
        var patch = new JsonArray();
        if (corrected != null && corrected != html) patch.Add(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = corrected });
        if (correctedCss != null && correctedCss != css) patch.Add(new JsonObject { ["op"] = "add", ["path"] = CssPointer(pointer), ["value"] = correctedCss });
        if (patch.Count == 0) patch = null;
        var list = new JsonArray();
        foreach (var p in problems)
        {
            var message = $"{(p.InCss ? "css" : "html")}: line {p.Line} col {p.Column}: {p.Message}";
            var problem = JobPreflight.Problem(null, p.InCss ? CssPointer(pointer) : pointer, p.Code, "error", message, p.Fix, p.Patch ?? (p.Correction != null ? patch?.DeepClone().AsArray() : null));
            problem["line"] = p.Line; problem["column"] = p.Column;
            if (p.Candidates is { Count: > 0 }) problem["candidates"] = new JsonArray(p.Candidates.Select(c => (JsonNode)c).ToArray());
            list.Add(JobPreflight.PublicProblem(problem));
        }
        var codes = problems.Select(p => p.Code).Distinct().ToList();
        var code = codes.Count == 1 ? codes[0] : Invalid;
        var text = problems.Count == 1
            ? $"{(problems[0].InCss ? "css" : "html")}: line {problems[0].Line} col {problems[0].Column}: {problems[0].Message}" + (problems[0].Fix is { } fix ? " Fix: " + fix : "")
            : $"html: {problems.Count} problems in the document, all reported at once: " + string.Join(" | ", problems.Select((p, i) => $"({i + 1}) {(p.InCss ? "css " : "")}line {p.Line} col {p.Column}: {p.Message}"));
        var refusal = new KernelRefusalException(code, text, list);
        if (corrected != null && corrected != html) refusal.Data["correctedHtml"] = corrected;
        if (correctedCss != null && correctedCss != css) refusal.Data["correctedCss"] = correctedCss;
        return refusal;
    }

    // data.css beside the html of the op: "/html" -> "/css", "/data/html" -> "/data/css", "/ops/3/data/html" -> "/ops/3/data/css".
    internal static string CssPointer(string htmlPointer) =>
        htmlPointer.EndsWith("/html", StringComparison.Ordinal) ? htmlPointer[..^"html".Length] + "css" : htmlPointer + "/../css";

    /// <summary>data.css with the CSS corrections of the problems applied: data.css rewritten (RewriteDataCss), then every
    /// &lt;style&gt; moved out of the html (MoveStyle) at its end, in the order of the document. The text itself when none
    /// applies.</summary>
    internal static string? CorrectCss(string? css, IReadOnlyList<Problem> problems)
    {
        var result = css;
        foreach (var p in problems) if (p.Correction is RewriteDataCss rewrite) result = rewrite.Css;
        foreach (var p in problems.Where(p => p.Correction is MoveStyle).OrderBy(p => p.Line).ThenBy(p => p.Column))
        {
            var moved = ((MoveStyle)p.Correction!).Css;
            result = string.IsNullOrEmpty(result) ? moved : result.TrimEnd('\r', '\n') + "\n" + moved;
        }
        return result;
    }

    /// <summary>True when the text parses and no rule of what is new that has a correction still refuses it (the check of a
    /// patch before it is offered).</summary>
    internal static bool RulesPass(string html) => RulesPass(html, [], null);

    /// <summary>The same, allowing the rule problems the correction left alone (the ones of <paramref name="problems"/> without a
    /// correction, by code and message): only what it corrected must be gone.</summary>
    internal static bool RulesPass(string html, IReadOnlyList<Problem> problems) => RulesPass(html, problems, null);

    /// <summary>The same with the op's data.css: the CSS of the corrected document and data.css pass the rules of the CSS too
    /// (where each &lt;style&gt; goes, what the theme renders).</summary>
    internal static bool RulesPass(string html, IReadOnlyList<Problem> problems, string? css)
    {
        ScreenHtml.Node document;
        try { document = ScreenHtml.Parse(html); }
        catch (FormatException) { return false; }
        var allowed = problems.Where(p => p.Correction == null).Select(p => p.Code + "\u0001" + p.Message).ToList();
        var top = document.Children.FirstOrDefault(c => !c.IsText && c.Tag is "screen" or "block");
        var fidelity = top == null ? [] : FidelityProblems(top, css, null);
        return Descendants(document).SelectMany(node => RuleProblems(node, node.Get("k") != null, null)).Concat(fidelity).Where(p => p.Correction != null)
            .All(p => allowed.Remove(p.Code + "\u0001" + p.Message));
    }

    /// <summary>The document with every correction applied (names in the start tag of their element, attributes removed,
    /// elements wrapped in an If or removed, iterations turned into Lists); null when none applies. The edits are made on the
    /// original text, from the end, so each one keeps the offsets of the others.</summary>
    internal static string? Correct(string html, IReadOnlyList<Problem> problems) => Correct(html, problems, null);

    /// <summary>The same; <paramref name="moved"/> receives where the element of each problem starts in the corrected document
    /// (line and column), so a fault the compile of the corrected document finds there is that correction's, or that problem's
    /// again when nothing corrects it.</summary>
    internal static string? Correct(string html, IReadOnlyList<Problem> problems, Dictionary<(int Line, int Column), (int Line, int Column)>? moved)
    {
        var fixes = problems.Where(p => p.Correction != null).ToList();
        if (fixes.Count == 0) return null;
        // The data the document declares: the shape of an iteration's source (an aggregate's row, a list of values).
        ScreenHtml.Node? declared = null;
        try { declared = ScreenHtml.Parse(html); } catch (FormatException) { }
        var lineStarts = new List<int> { 0 };
        for (var i = 0; i < html.Length; i++) if (html[i] == '\n') lineStarts.Add(i + 1);
        var edits = new List<(int At, int Length, string Text, int Order)>();
        foreach (var p in fixes)
        {
            // data.css is not the html (CorrectCss).
            if (p.InCss || p.Correction is RewriteDataCss) continue;
            if (p.Line < 1 || p.Line > lineStarts.Count) continue;
            var start = lineStarts[p.Line - 1] + p.Column - 1;
            if (p.Correction is ReplaceName { Attribute.Length: 0 } inText)
            {
                // A name in the text of a run ({{ expression }}): its first whole word from the run's start to the next tag.
                var stop = html.IndexOf('<', start);
                var run = html[start..(stop < 0 ? html.Length : stop)];
                var word = Regex.Match(run, @"(?<![A-Za-z0-9_.])" + Regex.Escape(inText.Wrong) + @"(?![A-Za-z0-9_])");
                if (word.Success) edits.Add((start + word.Index, word.Length, inText.Right, 1));
                continue;
            }
            var end = StartTagEnd(html, start);
            if (end < 0) continue;
            var tag = html[start..end];
            switch (p.Correction)
            {
                case ReplaceName(var attribute, var wrong, var right):
                {
                    if (AttributeValue(tag, attribute) is not var (valueStart, valueEnd)) continue;
                    var value = tag[valueStart..valueEnd];
                    var hit = Regex.Match(value, @"(?<![A-Za-z0-9_])" + Regex.Escape(wrong) + @"(?![A-Za-z0-9_])");
                    if (!hit.Success) continue;
                    edits.Add((start + valueStart + hit.Index, hit.Length, right, 1));
                    break;
                }
                case RemoveAttribute(var attribute, var wrapIf):
                {
                    if (AttributeSpan(tag, attribute) is not var (from, to)) continue;
                    edits.Add((start + from, to - from, "", 1));
                    if (wrapIf != null && ElementEnd(html, start) is var close and > 0)
                    {
                        edits.Add((start, 0, "<div if=" + QuoteAttribute(wrapIf) + ">", 0));
                        edits.Add((close, 0, "</div>", 2));
                    }
                    break;
                }
                case SetAttribute(var attribute, var value):
                {
                    if (AttributeSpan(tag, attribute) is not var (from, to)) continue;
                    edits.Add((start + from, to - from, " " + attribute + "=" + QuoteAttribute(value), 1));
                    break;
                }
                case RemoveElement:
                case MoveStyle:
                {
                    if (ElementEnd(html, start) is var close and > 0) edits.Add((start, close - start, "", 1));
                    break;
                }
                case RewriteStyle(var css):
                {
                    // The text between the start tag and its </style>.
                    var close = html.IndexOf("</style>", end, StringComparison.Ordinal);
                    if (close >= 0) edits.Add((end, close - end, css, 1));
                    break;
                }
                case IterateAsList(var attribute, var source, var alias):
                {
                    if (AttributeSpan(tag, attribute) is not var (from, to)) continue;
                    var (list, row, member) = IterationShape(source, declared);
                    edits.Add((start + from, to - from, " list=" + QuoteAttribute(list), 1));
                    // The row in the element and everything inside it, in its expressions only ({{ }}, if, list, events, block
                    // inputs, os-*): alias is the current item (Source.Current), alias.X its member (an aggregate's row names its
                    // entity first: GetPedidos.List.Current.Pedido.X).
                    if (alias != null && ElementEnd(html, start) is var close and > 0)
                        foreach (var (segment, length) in ExpressionSegments(html, start, close))
                            foreach (Match use in Regex.Matches(html.Substring(segment, length), @"(?<![A-Za-z0-9_.])" + Regex.Escape(alias) + @"(?:\.([A-Za-z_][A-Za-z0-9_]*))?(?![A-Za-z0-9_])"))
                            {
                                var at = segment + use.Index;
                                if (at >= start + from && at < start + to) continue;
                                edits.Add((at, use.Length, use.Groups[1].Success ? member(use.Groups[1].Value) : row, 1));
                            }
                    break;
                }
            }
        }
        if (edits.Count == 0) return null;
        var unique = edits.DistinctBy(e => (e.At, e.Length, e.Text)).ToList();
        // Where the element of each problem starts once every edit is made: every edit before it moves it, and an If opened
        // at its start too (the element goes inside it).
        var offsets = new Dictionary<(int Line, int Column), int>();
        if (moved != null)
            foreach (var p in problems)
            {
                if (p.Line < 1 || p.Line > lineStarts.Count) continue;
                var start = lineStarts[p.Line - 1] + p.Column - 1;
                offsets[(p.Line, p.Column)] = start + unique.Where(e => e.At < start || e.At == start && e.Length == 0 && e.Order == 0).Sum(e => e.Text.Length - e.Length);
            }
        var sb = new StringBuilder(html);
        // From the end. At one offset: what replaces text first, then the insertions; an insertion made later lands before
        // the earlier one, so the opening <div if> of an element goes in before the </div> that closes the element before it.
        foreach (var (at, length, text, _) in unique.OrderByDescending(e => e.At).ThenBy(e => e.Length > 0 ? 0 : 1).ThenBy(e => e.Order == 0 ? 0 : 1))
            sb.Remove(at, length).Insert(at, text);
        var result = sb.ToString();
        foreach (var (position, offset) in offsets) moved![position] = Position(result, offset);
        return result;
    }

    // The line and column (1-based) of an offset of a text.
    private static (int Line, int Column) Position(string text, int offset)
    {
        var line = 1; var column = 1;
        for (var i = 0; i < offset && i < text.Length; i++) { if (text[i] == '\n') { line++; column = 1; } else column++; }
        return (line, column);
    }

    /// <summary>motor2 (LIST_ALIAS_REWRITTEN, HtmlDocumentRules): the row of a List for the alias of &lt;x list="Source"
    /// as="a"&gt;, read as the iteration's correction reads it (<see cref="IterationShape"/>): the current item and an item's
    /// member. Certain is false for an aggregate of the document whose sources it does not write (from=, join=,
    /// os-AliasedSource): its row names an entity this reading cannot tell.</summary>
    internal static (string Row, Func<string, string> Member, bool Certain) AliasRow(string source, ScreenHtml.Node? document)
    {
        var (_, row, member) = IterationShape(source, document);
        var name = source.EndsWith(".List", StringComparison.Ordinal) ? source[..^5] : source;
        var aggregate = document == null ? null : Descendants(document).FirstOrDefault(n => n.Tag == "aggregate" && n.Get("name") == name);
        return (row, member, aggregate == null || AggregateSources(aggregate).Count > 0);
    }

    // The list an iteration's source names, the current item, and an item's member: an aggregate of the document is iterated by its
    // List and its row names its entity (GetPedidos.List.Current.Pedido.Nome, a source of the aggregate as it is); anything else
    // (a list variable of values or records, a list of the module) is Source.Current.
    private static (string List, string Row, Func<string, string> Member) IterationShape(string source, ScreenHtml.Node? document)
    {
        var name = source.EndsWith(".List", StringComparison.Ordinal) ? source[..^5] : source;
        var aggregate = document == null ? null : Descendants(document).FirstOrDefault(n => n.Tag == "aggregate" && n.Get("name") == name);
        if (aggregate == null) return (source, source + ".Current", m => source + ".Current." + m);
        var row = name + ".List.Current";
        var all = AggregateSources(aggregate);
        var sources = all.Select(a => a.Alias).ToHashSet(StringComparer.Ordinal);
        var single = all.Count == 1 && !Joined(aggregate);
        var alias = single ? all[0].Alias : null;
        return (name + ".List", row, m => !single || sources.Contains(m) ? row + "." + m : row + "." + alias + "." + m);
    }

    // The expressions inside an element (offset, length): every {{ ... }} and the values of the attributes that hold one (if, list,
    // events, block inputs :X and @Event, os-*). Plain text and literal attributes (class, id, title) are never a name.
    private static IEnumerable<(int Start, int Length)> ExpressionSegments(string html, int start, int end)
    {
        var part = html[start..end];
        foreach (Match run in Regex.Matches(part, @"\{\{(.*?)\}\}", RegexOptions.Singleline)) yield return (start + run.Groups[1].Index, run.Groups[1].Length);
        foreach (Match attribute in Regex.Matches(part, @"\s(if|list|on[A-Za-z]+|html:on[A-Za-z]+|:[A-Za-z_][A-Za-z0-9_]*|@[A-Za-z_][A-Za-z0-9_]*|os-[A-Za-z0-9_.\-]+)\s*=\s*(?:""([^""]*)""|'([^']*)')"))
        {
            var value = attribute.Groups[2].Success ? attribute.Groups[2] : attribute.Groups[3];
            yield return (start + value.Index, value.Length);
        }
    }

    // The value of an attribute inside a start tag: its offsets (relative to the tag), without the quotes.
    private static (int Start, int End)? AttributeValue(string tag, string attribute)
    {
        var at = Regex.Match(tag, @"\s" + Regex.Escape(attribute) + @"\s*=\s*(""|')");
        if (!at.Success) return null;
        var quote = at.Groups[1].Value[0];
        var valueStart = at.Index + at.Length;
        var valueEnd = tag.IndexOf(quote, valueStart);
        return valueEnd < 0 ? null : (valueStart, valueEnd);
    }

    // The whole attribute inside a start tag, with the space before it: its offsets (relative to the tag).
    private static (int Start, int End)? AttributeSpan(string tag, string attribute)
    {
        var at = Regex.Match(tag, @"\s+" + Regex.Escape(attribute) + @"(?=[\s=/>])");
        if (!at.Success) return null;
        var rest = Regex.Match(tag[(at.Index + at.Length)..], @"^\s*=\s*(""|')");
        if (!rest.Success) return (at.Index, at.Index + at.Length);
        var quote = rest.Groups[1].Value[0];
        var valueStart = at.Index + at.Length + rest.Length;
        var valueEnd = tag.IndexOf(quote, valueStart);
        return valueEnd < 0 ? null : (at.Index, valueEnd + 1);
    }

    // An attribute value as the reading quotes it: double quotes, single when the value has double ones, &quot; with both.
    internal static string QuoteAttribute(string value)
    {
        var escaped = value.Replace("&", "&amp;").Replace("<", "&lt;");
        if (!escaped.Contains('"')) return "\"" + escaped + "\"";
        if (!escaped.Contains('\'')) return "'" + escaped + "'";
        return "\"" + escaped.Replace("\"", "&quot;") + "\"";
    }

    // The end (exclusive) of the element whose start tag begins at offset: its end tag, or the start tag itself when it is
    // self-closed or void. A <style> is raw text; comments are skipped. -1 when the text does not close it.
    internal static int ElementEnd(string html, int offset)
    {
        var stack = new List<string>();
        var i = offset;
        while (i < html.Length)
        {
            var open = html.IndexOf('<', i);
            if (open < 0) return -1;
            if (string.CompareOrdinal(html, open, "<!--", 0, 4) == 0) { var e = html.IndexOf("-->", open + 4, StringComparison.Ordinal); if (e < 0) return -1; i = e + 3; continue; }
            if (open + 1 < html.Length && html[open + 1] == '/')
            {
                var gt = html.IndexOf('>', open);
                if (gt < 0) return -1;
                var closing = html[(open + 2)..gt].Trim();
                if (stack.Count > 0 && stack[^1] == closing) stack.RemoveAt(stack.Count - 1);
                if (stack.Count == 0) return gt + 1;
                i = gt + 1;
                continue;
            }
            var end = StartTagEnd(html, open);
            if (end < 0) return -1;
            var name = Regex.Match(html[(open + 1)..end], @"^[^\s/>]+").Value;
            var selfClosed = html[end - 2] == '/' || ScreenHtml.VoidTags.Contains(name);
            if (name == "style" && !selfClosed)
            {
                var close = html.IndexOf("</style>", end, StringComparison.Ordinal);
                if (close < 0) return -1;
                if (stack.Count == 0) return close + "</style>".Length;
                i = close + "</style>".Length;
                continue;
            }
            if (!selfClosed) stack.Add(name);
            else if (stack.Count == 0) return end;
            i = end;
        }
        return -1;
    }

    // The end (exclusive) of the start tag that begins at offset: the first '>' outside a quoted value.
    private static int StartTagEnd(string html, int offset)
    {
        if (offset < 0 || offset >= html.Length || html[offset] != '<') return -1;
        char? quote = null;
        for (var i = offset + 1; i < html.Length; i++)
        {
            var c = html[i];
            if (quote != null) { if (c == quote) quote = null; continue; }
            if (c is '"' or '\'') quote = c;
            else if (c == '>') return i + 1;
        }
        return -1;
    }

    // ---- the nearest name (plan 2.3): same kind; edit distance at most 2, or a common prefix or suffix of at least 70% ------
    internal static List<string> Nearest(string wanted, IEnumerable<string> names)
    {
        var scored = new List<(string Name, int Distance)>();
        foreach (var name in names.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (string.Equals(name, wanted, StringComparison.OrdinalIgnoreCase)) continue;
            var distance = Distance(wanted.ToLowerInvariant(), name.ToLowerInvariant());
            var longest = Math.Max(wanted.Length, name.Length);
            var common = Math.Max(Prefix(wanted, name), Suffix(wanted, name));
            if (distance <= 2 || longest > 0 && common >= 0.7 * longest) scored.Add((name, distance));
        }
        return scored.OrderBy(s => s.Distance).ThenBy(s => s.Name, StringComparer.Ordinal).Take(3).Select(s => s.Name).ToList();
    }

    private static int Prefix(string a, string b) { var n = 0; while (n < a.Length && n < b.Length && char.ToLowerInvariant(a[n]) == char.ToLowerInvariant(b[n])) n++; return n; }
    private static int Suffix(string a, string b) { var n = 0; while (n < a.Length && n < b.Length && char.ToLowerInvariant(a[^(n + 1)]) == char.ToLowerInvariant(b[^(n + 1)])) n++; return n; }

    internal static int Distance(string a, string b)
    {
        var previous = new int[b.Length + 1];
        var current = new int[b.Length + 1];
        for (var j = 0; j <= b.Length; j++) previous[j] = j;
        for (var i = 1; i <= a.Length; i++)
        {
            current[0] = i;
            for (var j = 1; j <= b.Length; j++)
                current[j] = Math.Min(Math.Min(current[j - 1] + 1, previous[j] + 1), previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
            (previous, current) = (current, previous);
        }
        return previous[b.Length];
    }
}
