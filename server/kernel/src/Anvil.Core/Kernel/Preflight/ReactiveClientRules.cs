using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>
/// T9 (2026-10-23, review round the same day): client-side code keeps the runtime's semantics. A server evaluates its
/// expressions in the server's time zone (UTC on the cloud); client-side code (O11 Reactive and Mobile, ODC) evaluates them in
/// the browser, where a Date Time holds the browser's local time (the catalog of CurrDateTime: "date times in the server are
/// converted in the device to the device time zone"). An expression or a script carried across the two with no rule for where
/// it runs converts a time twice and fights the runtime's own DOM. The rule of the round: a false refusal is a regression, so
/// what the rule cannot prove is a warning, never an error.
/// <list type="bullet">
/// <item>DATETIME_TZ_REINTERPRETED: a Date Time turned into text in client-side code (the catalog's Text-from-Date-Time
/// built-ins, a Date Time variable, a Date Time built-in, a Date Time literal) and marked UTC ("Z", "UTC", "GMT", "+00:00"
/// concatenated or in the mask), or written into an attribute whose name has the word utc. An error when nothing in the
/// expression can convert it; a warning when a function of the module or an AddX with a computed amount may convert it, or when
/// the type of the value is not known here; never for a Date or a Time (no time zone). The parse of such an attribute by a
/// script: <see cref="ClientScriptLint"/>, judged by what the job fills it with.</item>
/// <item>DOM_MUTATION_OF_RUNTIME, JS_RUNTIME_DUPLICATE: <see cref="ClientScriptLint"/>.</item>
/// <item>ATTRIBUTE_UNREAD (warning): a data-* attribute bound to an expression that no CSS and no script reads, the job's and
/// the module's (only in the module pass, which sees the module; never for data-testid nor an attribute of the UI catalogs).</item>
/// </list>
/// The forms read, with the side each runs on: logic actions in the JSON and in the text form (client actions and Reactive or
/// Mobile screen actions: the client; server, service and data actions, preparations, Traditional screen actions: the server);
/// the html document (its data defaults too), page, edit (whole elements or element edits), and fragment forms; raw sets of
/// Value, Condition and JavaScript, by the parent chain of the element the job creates, or by the base for an @key. What only
/// the module type says (an O11 screen action written as text, an html edit, a fragment, a raw script set) is judged by the
/// module pass (<see cref="Register"/> with the base): a Traditional module is exempt. Not read (so never claimed): a raw set
/// of another property (its kind is the Model API's), a `create` with properties, the components form of html, a screen
/// generator op, the Traditional widget verbs, and an @key raw set where the base cannot say where the element runs (the
/// static check's index).
/// </summary>
public static class ReactiveClientRules
{
    public const string DateTimeReinterpreted = "DATETIME_TZ_REINTERPRETED";
    public const string DomMutation = "DOM_MUTATION_OF_RUNTIME";
    public const string RuntimeDuplicate = "JS_RUNTIME_DUPLICATE";
    public const string AttributeUnread = "ATTRIBUTE_UNREAD";

    /// <summary>Where a piece of code runs: the client, the server, the module type decides (O11 Traditional or not), or the base
    /// says where an @key runs.</summary>
    public enum Side { Client, Server, ByModule, ByBase }

    public sealed record ExpressionSite(int Op, string? Pointer, string Kind, string Element, string? Attribute, string Text, Side Side,
        IReadOnlyDictionary<string, string> Types, string? BaseTarget = null, string? BaseProp = null);

    public sealed record ScriptSite(int Op, string? Pointer, string Kind, string Element, string Script, Side Side);

    /// <summary>A data-* attribute an html element binds to an expression.</summary>
    public sealed record BoundAttribute(int Op, string? Pointer, string Element, string Attribute, Side Side);

    public sealed class Sites
    {
        public List<ExpressionSite> Expressions { get; } = [];
        public List<ScriptSite> Scripts { get; } = [];
        public List<BoundAttribute> Bound { get; } = [];
        /// <summary>Attributes on an element that shows an expression (the runtime writes that element's content).</summary>
        public HashSet<string> Shown { get; } = new(StringComparer.OrdinalIgnoreCase);
        /// <summary>What the job's html fills each attribute with (the strongest).</summary>
        public Dictionary<string, Filler> Fillers { get; } = new(StringComparer.OrdinalIgnoreCase);
        /// <summary>The CSS texts of the job (style elements, data.css, stylesheet sets).</summary>
        public List<string> Styles { get; } = [];
    }

    /// <summary>The rule as PreflightChecks runs it (one line per pass): the pure pass (no base) judges what runs on the client
    /// by its form; the module pass judges what only the module type or the base says, and the attributes nothing reads.</summary>
    public static IEnumerable<(string Rule, Func<List<JsonObject>> Check)> Register(JsonArray ops, string? prefix, string lane, IBaseFacts? model = null, bool modulePass = false)
    {
        yield return (nameof(ReactiveClientRules), () => Judge(ops, prefix, lane, model, modulePass));
    }

    /// <summary>ESpaceType (and digest kind) of a module whose screens run in the browser.</summary>
    public static bool IsClientRuntime(string? moduleType) => moduleType is { Length: > 0 } t
        && (t.Contains("Mobile", StringComparison.OrdinalIgnoreCase) || t.Contains("Reactive", StringComparison.OrdinalIgnoreCase) || t.Equals("CrossDevice", StringComparison.OrdinalIgnoreCase));

    /// <summary>The module pass with only the module type known (no base element is resolved, no module text is read).</summary>
    public static List<JsonObject> Check(JsonArray ops, string? prefix, string lane, string? moduleType, bool modulePass)
        => Judge(ops, prefix, lane, modulePass ? new TypeOnly(moduleType) : null, modulePass);

    public static List<JsonObject> Judge(JsonArray ops, string? prefix, string lane, IBaseFacts? model, bool modulePass)
    {
        var odc = string.Equals(lane, "odc", StringComparison.OrdinalIgnoreCase);
        var clientModule = odc || IsClientRuntime(model?.ModuleType);
        bool Judged(Side side) => modulePass
            ? side == Side.ByModule && !odc && clientModule
            : side == Side.Client || odc && side == Side.ByModule;
        var sites = Collect(ops, prefix, lane);
        var problems = new List<JsonObject>();
        var functions = Functions(lane);
        foreach (var site in sites.Expressions)
        {
            var judged = site.Side == Side.ByBase
                ? modulePass && model != null && site.BaseTarget != null && model.IsClientSide(site.BaseTarget) == true && (site.BaseProp == null || model.RawExpression(site.BaseTarget, site.BaseProp) != null)
                : Judged(site.Side);
            if (judged && DateTimeFinding(site, functions) is { } finding)
                problems.Add(JobPreflight.Problem(site.Op, site.Pointer, DateTimeReinterpreted, finding.Severity, finding.Message, finding.Fix, null, site.Kind));
        }
        var context = new ScriptContext(RuntimeOwnedMarkers(lane), RuntimeAttributes(lane), sites.Shown,
            sites.Bound.Select(b => b.Attribute).ToHashSet(StringComparer.OrdinalIgnoreCase), sites.Fillers);
        foreach (var script in sites.Scripts.Where(s => Judged(s.Side)))
            foreach (var finding in LogicLint.ClientScript(script.Script, context))
                problems.Add(JobPreflight.Problem(script.Op, script.Pointer, finding.Code, finding.Severity, script.Element + ": " + finding.Message, finding.Fix, null, script.Kind));
        // ATTRIBUTE_UNREAD: only where the module's own CSS and scripts are seen too (the module pass with a base that reads them).
        if (modulePass && model?.StyleSheetsAndScripts is { } moduleTexts && sites.Bound.Count > 0)
        {
            var reads = Reads(sites, moduleTexts);
            var platform = PlatformAttributes();
            var said = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var bound in sites.Bound)
            {
                if (!(bound.Side == Side.Client || bound.Side == Side.ByModule && clientModule)) continue;
                var name = bound.Attribute;
                if (name.StartsWith("data-test", StringComparison.OrdinalIgnoreCase) || platform.Contains(name) || reads.Contains(name)
                    || !said.Add(bound.Op + "|" + bound.Element + "|" + name)) continue;
                problems.Add(JobPreflight.Problem(bound.Op, bound.Pointer, AttributeUnread, "warning",
                    $"{bound.Element}: the attribute '{name}' is bound to an expression, and no CSS and no script of this job or of the module reads it: the runtime evaluates it on every render for nothing",
                    $"remove '{name}' from the element, or keep it if code outside the module reads it", null, "html"));
            }
        }
        // The base phase keeps one problem per code and pointer (JobRunner.CheckAgainstBase): the module pass says every finding
        // of one place in that one problem, so none waits for another round.
        return modulePass ? OnePerPlace(problems) : problems;
    }

    private sealed class TypeOnly(string? moduleType) : IBaseFacts
    {
        public IReadOnlyDictionary<string, string>? Attributes(string record) => null;
        public bool IsClientEntity(string name) => false;
        public CalleeFact? Callee(string target, JsonObject caller) => null;
        public bool HasName(string name) => true;
        public bool NamesOnlyTypes(string name) => false;
        public bool IsFunction(string name) => false;
        public string? ModuleType => moduleType;
        public RawExpressionFact? RawExpression(string target, string prop) => null;
    }

    private static List<JsonObject> OnePerPlace(List<JsonObject> problems) => problems
        .GroupBy(p => p["op"] + "|" + p["pointer"] + "|" + p["code"] + "|" + p["severity"], StringComparer.Ordinal)
        .Select(g =>
        {
            var first = g.First();
            if (g.Count() == 1) return first;
            var all = g.ToList();
            first["message"] = $"{all.Count} findings here: " + string.Join("; ", all.Select((p, n) => $"({n + 1}) {p["message"]}"));
            first["fix"] = string.Join("; ", all.Select(p => p["fix"]?.ToString()).Where(f => !string.IsNullOrEmpty(f)).Distinct());
            return first;
        }).ToList();

    // ---- the Date Time built-ins, from the catalog ---------------------------------------------------------------------------------

    /// <summary>The temporal built-ins, by return and parameter types of the lane's catalog (the Studio's registry, else the
    /// checked-in functions-*.json): ToText (Text from a Date Time), Valued (a Date Time), NoZone (a Date or a Time), FromDate (a
    /// Date Time made from Dates only: no time), Shifts (a Date Time moved by an Integer), Known (every built-in; null when no
    /// catalog is readable). <see cref="Fallback"/> only when no catalog is readable (a test proves it is the catalog's).</summary>
    public sealed record DateTimeFunctions(IReadOnlySet<string> ToText, IReadOnlySet<string> Valued, IReadOnlySet<string> NoZone,
        IReadOnlySet<string> FromDate, IReadOnlySet<string> Shifts, IReadOnlySet<string>? Known);

    private static HashSet<string> Set(params string[] names) => new(names, StringComparer.OrdinalIgnoreCase);

    public static readonly DateTimeFunctions Fallback = new(
        Set("DateTimeToText", "FormatDateTime"),
        Set("AddDays", "AddHours", "AddMinutes", "AddMonths", "AddSeconds", "AddYears", "BuildDateTime", "CurrDateTime", "DateToDateTime", "NewDateTime", "TextToDateTime"),
        Set("CurrDate", "CurrTime", "DateTimeToDate", "DateTimeToTime", "NewDate", "NewTime", "NullDate", "TextToDate", "TextToTime"),
        Set("DateToDateTime"),
        Set("AddDays", "AddHours", "AddMinutes", "AddMonths", "AddSeconds", "AddYears"),
        null);

    public static DateTimeFunctions Functions(string lane) => Derive(Builtins.For(lane)) ?? Derive(Builtins.For("o11")) ?? Fallback;

    public static DateTimeFunctions? Derive(IReadOnlyDictionary<string, BuiltinFact>? builtins)
    {
        if (builtins == null || builtins.Count == 0) return null;
        HashSet<string> toText = Set(), valued = Set(), noZone = Set(), fromDate = Set(), shifts = Set();
        foreach (var f in builtins.Values)
        {
            var types = ParameterTypes(f.Signature).ToList();
            if (IsDateTime(f.ReturnType))
            {
                valued.Add(f.Name);
                if (types.Count > 0 && types.All(IsDate)) fromDate.Add(f.Name);
                if (types.Count == 2 && IsDateTime(types[0]) && Same(types[1], "Integer")) shifts.Add(f.Name);
            }
            else if (IsDate(f.ReturnType) || IsTime(f.ReturnType)) noZone.Add(f.Name);
            else if (Same(f.ReturnType, "Text") && types.Any(IsDateTime)) toText.Add(f.Name);
        }
        return toText.Count == 0 ? null : new DateTimeFunctions(toText, valued, noZone, fromDate, shifts, builtins.Keys.ToHashSet(StringComparer.OrdinalIgnoreCase));
    }

    private static bool Same(string? type, string name) => type != null && Regex.Replace(type, @"\s+", "").Equals(name.Replace(" ", ""), StringComparison.OrdinalIgnoreCase);
    public static bool IsDateTime(string? type) => Same(type, "DateTime");
    public static bool IsDate(string? type) => Same(type, "Date");
    public static bool IsTime(string? type) => Same(type, "Time");

    /// <summary>The parameter types of a signature "Name(a: Type, b: Type): Return".</summary>
    public static IEnumerable<string> ParameterTypes(string signature)
    {
        var open = signature.IndexOf('('); var close = signature.LastIndexOf(')');
        if (open < 0 || close <= open) yield break;
        foreach (var parameter in signature[(open + 1)..close].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            if (parameter.IndexOf(':') is var colon and > 0) yield return parameter[(colon + 1)..].Trim();
    }

    // ---- DATETIME_TZ_REINTERPRETED ---------------------------------------------------------------------------------------------

    /// <summary>A text concatenated after a Date Time text that marks it UTC (".000Z" too).</summary>
    private static readonly Regex UtcAfter = new(@"^\s*(?:\.\d+)?(?:Z|(?i:UTC|GMT)|[+-]00:?00)(?![A-Za-z0-9])", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    /// <summary>A text concatenated before a Date Time text that marks it UTC.</summary>
    private static readonly Regex UtcBefore = new(@"(?<![A-Za-z0-9])(?i:UTC|GMT)\s*:?\s*$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    /// <summary>A UTC mark inside a format mask (Z is no format letter: FormatDateTime writes it as it is).</summary>
    private static readonly Regex UtcInMask = new(@"(?<!\\)Z|(?i:UTC|GMT)|[+-]00:?00", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    /// <summary>A time letter of a format mask (hours, minutes, seconds), not escaped.</summary>
    private static readonly Regex TimeInMask = new(@"(?<!\\)[Hhms]", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    /// <summary>A Date Time literal (#yyyy-MM-dd HH:mm[:ss]#); a Date (#yyyy-MM-dd#) or a Time (#HH:mm:ss#) has no time zone.</summary>
    private static readonly Regex DateTimeLiteral = new(@"^#\s*\d{4}-\d{1,2}-\d{1,2}[\sT]+\d{1,2}:\d{2}", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public sealed record Finding(string Severity, string Message, string Fix);

    private enum Holds { NoZone, Certain, Uncertain }
    private readonly record struct Value(Holds Holds, string Reason = "");

    /// <summary>The DATETIME_TZ_REINTERPRETED finding of one client expression (an error, a warning), or null.</summary>
    public static Finding? DateTimeFinding(ExpressionSite site, DateTimeFunctions functions)
    {
        if (string.IsNullOrWhiteSpace(site.Text) || ExpressionSyntax.Check(site.Text) != null) return null;
        var tokens = ExpressionText.Tokens(site.Text);
        var spans = Spans(site.Text, tokens, functions, site.Types).ToList();
        if (spans.Count == 0) return null;
        var excerpt = Excerpt(site.Text);
        var where = site.Element + (site.Attribute == null ? "" : $", attribute '{site.Attribute}'");
        Finding? best = null;
        void Keep(Finding f) { if (best == null || best.Severity == "warning" && f.Severity == "error") best = f; }
        foreach (var span in spans)
        {
            if (span.Value.Holds == Holds.NoZone) continue;
            string? mark = null;
            if (span.End + 2 < tokens.Count && tokens[span.End + 1] is { Kind: TokenKind.Operator, Text: "+" } && tokens[span.End + 2] is { Kind: TokenKind.Text } after && UtcAfter.IsMatch(Unquote(after.Text)))
                mark = after.Text + " concatenated after it";
            else if (span.Start >= 2 && tokens[span.Start - 1] is { Kind: TokenKind.Operator, Text: "+" } && tokens[span.Start - 2] is { Kind: TokenKind.Text } before && UtcBefore.IsMatch(Unquote(before.Text)))
                mark = before.Text + " concatenated before it";
            else if (span.Masks.FirstOrDefault(m => UtcInMask.IsMatch(Unquote(m))) is { } mask)
                mark = "the mask " + mask;
            if (mark != null)
            {
                Keep(span.Value.Holds == Holds.Certain
                    ? new("error", $"{where}: '{excerpt}' turns the Date Time {span.Text} into text in client-side code and marks it UTC ({mark}): client-side code holds a Date Time in the browser's local time, and nothing in this expression converts {span.Text} to UTC, so the text calls a local time UTC and any reader that parses it as UTC shifts it a second time (expected: the local time shown with a display mask, or a UTC text made on the server; actual: local time marked UTC)",
                        $"write FormatDateTime({span.Text}, \"<display mask>\") with no UTC mark where the time is shown (the runtime converts it once); a UTC text for a script comes from a server action or a Data Action output formatted on the server")
                    : new("warning", $"{where}: '{excerpt}' marks the client-side Date Time {span.Text} UTC ({mark}), and {span.Value.Reason}: if it does not convert to UTC, the text calls a local time UTC and any reader that parses it as UTC shifts it a second time",
                        $"keep it if {span.Value.Reason.Split(',')[0]} gives the UTC time; otherwise write FormatDateTime({span.Text}, \"<display mask>\") with no UTC mark, or make the UTC text on the server"));
                continue;
            }
            // The attribute holds what the expression gives: a Date Time inside another call (DateTimeToDate(x), Year(x)) is not it.
            if (site.Attribute != null && ClientScriptLint.HasUtcWord(site.Attribute) && span.Top)
                Keep(span.Value.Holds == Holds.Certain
                    ? new("error", $"{where}: '{excerpt}' writes the Date Time {span.Text} of client-side code into an attribute named UTC: client-side code holds it in the browser's local time and nothing here converts it, so the name is false and a script that reads the attribute as UTC shifts it a second time (expected: no UTC attribute filled on the client; actual: '{site.Attribute}' holding a local time)",
                        $"show the time in the element's own expression, FormatDateTime({span.Text}, \"<display mask>\"), and remove '{site.Attribute}' and the script that reads it; or fill it with a UTC text made on the server")
                    : new("warning", $"{where}: '{excerpt}' writes the client-side Date Time {span.Text} into an attribute named UTC, and {span.Value.Reason}: if it is not UTC, a script that reads the attribute as UTC shifts it a second time",
                        $"keep it if {span.Value.Reason.Split(',')[0]} gives the UTC time; otherwise fill '{site.Attribute}' with a UTC text made on the server"));
        }
        return best;
    }

    /// <summary>What the job's html fills an attribute with, by the same reading of the expression.</summary>
    public static Filler FillerOf(string text, IReadOnlyDictionary<string, string> types, DateTimeFunctions functions)
    {
        if (string.IsNullOrWhiteSpace(text) || ExpressionSyntax.Check(text) != null) return Filler.Other;
        var tokens = ExpressionText.Tokens(text);
        var spans = Spans(text, tokens, functions, types).Where(s => s.Value.Holds != Holds.NoZone).ToList();
        if (spans.Count == 0) return Filler.Other;
        foreach (var span in spans)
            if (span.End + 2 < tokens.Count && tokens[span.End + 1] is { Kind: TokenKind.Operator, Text: "+" } && tokens[span.End + 2] is { Kind: TokenKind.Text } after && UtcAfter.IsMatch(Unquote(after.Text))
                || span.Masks.Any(m => UtcInMask.IsMatch(Unquote(m))))
                return Filler.ClientDateTimeMarkedUtc;
        return Filler.ClientDateTime;
    }

    /// <summary>A Date Time operand: its tokens, its text, what it holds, its masks, and whether it is the expression's own value
    /// (inside no call but If).</summary>
    private sealed record Span(int Start, int End, string Text, Value Value, IReadOnlyList<string> Masks, bool Top = true);

    /// <summary>The operands of an expression that are a Date Time or its text: a call of a ToText built-in (its first argument is
    /// the value, its Text literal arguments are masks), a call of a Valued built-in, a variable of type Date Time, a Date Time
    /// literal; each with what the value holds.</summary>
    private static IEnumerable<Span> Spans(string text, List<Token> tokens, DateTimeFunctions functions, IReadOnlyDictionary<string, string> types)
    {
        var calls = ExpressionText.Calls(text, tokens).ToDictionary(c => c.NameIndex);
        // The argument lists of the calls other than If: what is inside one is not the expression's own value.
        var inside = new List<(int Open, int Close)>();
        foreach (var (at, c) in calls)
            if (!c.Name.Equals("If", StringComparison.OrdinalIgnoreCase) && CloseOf(tokens, at + 1) is var end and > 0) inside.Add((at + 1, end));
        bool Top(int k) => !inside.Any(r => k > r.Open && k < r.Close);
        for (var k = 0; k < tokens.Count; k++)
        {
            var t = tokens[k];
            if (t.Kind == TokenKind.Name && calls.TryGetValue(k, out var call))
            {
                var close = CloseOf(tokens, k + 1);
                if (close < 0) continue;
                if (functions.ToText.Contains(t.Text) && call.Arguments.Count > 0)
                {
                    var masks = call.ArgumentTokens.Skip(1).Where(a => a.Count == 1 && a[0].Kind == TokenKind.Text).Select(a => a[0].Text).ToArray();
                    var showsTime = t.Text.Equals("DateTimeToText", StringComparison.OrdinalIgnoreCase) || masks.Any(m => TimeInMask.IsMatch(Unquote(m)));
                    yield return new(k, close, call.Arguments[0], ValueOf(call.Arguments[0], types, functions, showsTime, 0), masks, Top(k));
                }
                else if (functions.Valued.Contains(t.Text))
                {
                    var whole = text[t.Start..(tokens[close].Start + 1)];
                    yield return new(k, close, whole, ValueOf(whole, types, functions, true, 0), [], Top(k));
                }
                continue;
            }
            if (t.Kind == TokenKind.Name && ExpressionText.IsRoot(tokens, k) && types.TryGetValue(t.Text, out var type) && IsDateTime(type)) yield return new(k, k, t.Text, new(Holds.Certain), [], Top(k));
            else if (t.Kind == TokenKind.Date && DateTimeLiteral.IsMatch(t.Text)) yield return new(k, k, t.Text, new(Holds.Certain), [], Top(k));
        }
    }

    /// <summary>What a value given to a Date Time slot holds: no time zone (a Date or a Time), a time nothing here converts, or
    /// a time something may have converted (a function of the module, an AddX with a computed amount, a value of unknown type).</summary>
    private static Value ValueOf(string text, IReadOnlyDictionary<string, string> types, DateTimeFunctions functions, bool showsTime, int depth)
    {
        var tokens = ExpressionText.Tokens(text);
        if (tokens.Count == 0 || depth > 6) return new(Holds.Uncertain, "its value is not known here");
        if (tokens.Count == 1)
        {
            var t = tokens[0];
            if (t.Kind == TokenKind.Date) return DateTimeLiteral.IsMatch(t.Text) ? new(Holds.Certain) : new(Holds.NoZone);
            if (t.Kind == TokenKind.Name && !t.Text.StartsWith('.'))
            {
                if (types.TryGetValue(t.Text, out var type))
                    return IsDate(type) || IsTime(type) ? new(Holds.NoZone) : IsDateTime(type) ? new(Holds.Certain) : new(Holds.Uncertain, $"{t.Text} is a {type}");
                return showsTime ? new(Holds.Certain) : new(Holds.Uncertain, $"the type of {t.Text} is not known here (a Date has no time zone, a Date Time has)");
            }
            return new(Holds.Uncertain, "its value is not known here");
        }
        var call = ExpressionText.Calls(text, tokens).FirstOrDefault(c => c.NameIndex == 0);
        if (call != null && CloseOf(tokens, 1) == tokens.Count - 1)
        {
            var name = call.Name;
            if (functions.NoZone.Contains(name) || functions.FromDate.Contains(name)) return new(Holds.NoZone);
            if (functions.Shifts.Contains(name) && call.Arguments.Count == 2)
            {
                var moved = ValueOf(call.Arguments[0], types, functions, showsTime, depth + 1);
                if (moved.Holds == Holds.NoZone) return moved;
                var amount = call.ArgumentTokens[1];
                var literal = amount.Count == 1 && amount[0].Kind == TokenKind.Number || amount.Count == 2 && amount[0] is { Kind: TokenKind.Operator, Text: "-" } && amount[1].Kind == TokenKind.Number;
                return literal ? moved : new(Holds.Uncertain, $"{name} adds a computed amount ({call.Arguments[1]}), which may be the offset to UTC");
            }
            if (functions.Valued.Contains(name)) return new(Holds.Certain);
            if (name.Equals("If", StringComparison.OrdinalIgnoreCase) && call.Arguments.Count == 3)
            {
                var a = ValueOf(call.Arguments[1], types, functions, showsTime, depth + 1);
                var b = ValueOf(call.Arguments[2], types, functions, showsTime, depth + 1);
                if (a.Holds == Holds.NoZone && b.Holds == Holds.NoZone) return a;
                return a.Holds == Holds.Uncertain ? a : b.Holds == Holds.Uncertain ? b : new(Holds.Certain);
            }
            if (functions.Known?.Contains(name) != true) return new(Holds.Uncertain, $"the function {name} gives it, which may convert it to UTC");
            return new(Holds.Uncertain, $"{name} gives it");
        }
        // A longer expression: a function of the module anywhere in it may convert it.
        var own = ExpressionText.Calls(text, tokens).FirstOrDefault(c => functions.Known?.Contains(c.Name) != true);
        return own != null ? new(Holds.Uncertain, $"the function {own.Name} takes part in it, which may convert it to UTC") : new(Holds.Uncertain, "its value is not known here");
    }

    private static int CloseOf(List<Token> tokens, int open)
    {
        var depth = 0;
        for (var j = open; j < tokens.Count; j++)
        {
            if (tokens[j].Kind is TokenKind.Open or TokenKind.OpenIndex) depth++;
            else if (tokens[j].Kind is TokenKind.Close or TokenKind.CloseIndex && --depth == 0) return j;
        }
        return -1;
    }

    private static string Unquote(string literal) => literal.Length >= 2 ? literal[1..^1].Replace("\"\"", "\"") : literal;

    private static string Excerpt(string text)
    {
        var one = Regex.Replace(text.Trim(), @"\s+", " ");
        return one.Length <= 160 ? one : one[..157] + "...";
    }

    // ---- the runtime DOM, the platform's attributes, what reads an attribute --------------------------------------------------------

    /// <summary>The markers of the elements whose content the runtime writes (an expression, a list, a block instance), from
    /// the runtime DOM table of the lane.</summary>
    public static IReadOnlyList<string> RuntimeOwnedMarkers(string lane) => RuntimeDomTable.Rows(lane)
        .Where(r => r.Widget is "IExpression" or "IList" or "IMobileBlockInstanceWidget")
        .SelectMany(r => r.Attributes.Select(a => a.Name)).Where(n => n.StartsWith("data-", StringComparison.Ordinal)).Distinct().ToArray();

    /// <summary>Every data-* attribute the runtime itself writes (rows and wrappers of the table): never an authored attribute.</summary>
    public static IReadOnlySet<string> RuntimeAttributes(string lane) => RuntimeDomTable.Rows(lane)
        .SelectMany(r => r.Attributes.Select(a => a.Name).Concat(r.Wrappers.SelectMany(w => w.Attributes.Select(a => a.Name))))
        .Where(n => n.StartsWith("data-", StringComparison.Ordinal)).ToHashSet(StringComparer.OrdinalIgnoreCase);

    private static readonly Lazy<HashSet<string>> Platform = new(() =>
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var root = JobRunner.RepoRoot(Environment.CurrentDirectory) ?? JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ReactiveClientRules).Assembly.Location)!);
            var folder = root == null ? null : Path.Combine(root, "catalog", "ui");
            if (folder != null && Directory.Exists(folder))
                foreach (var file in Directory.GetFiles(folder, "*.json"))
                    foreach (Match m in Regex.Matches(File.ReadAllText(file), @"\bdata-[a-z][a-z0-9-]*", RegexOptions.CultureInvariant)) names.Add(m.Value);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        return names;
    });

    /// <summary>The data-* attributes the UI catalogs of the platform name (what OutSystems UI and its components read and write).</summary>
    public static IReadOnlySet<string> PlatformAttributes() => Platform.Value;

    private static readonly Regex Word = new(@"[A-Za-z_][\w-]*", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex DatasetKey = new(@"dataset\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['""`]([^'""`]+)['""`]\s*\])", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>Every name a CSS or a script of the job or of the module mentions (selectors with or without values, attribute
    /// calls, dataset keys as their data-* attribute), read once.</summary>
    private static HashSet<string> Reads(Sites sites, IEnumerable<string> module)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Read(string text)
        {
            foreach (Match m in Word.Matches(text)) names.Add(m.Value);
            foreach (Match m in DatasetKey.Matches(text)) names.Add("data-" + ClientScriptLint.Kebab(m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value));
        }
        foreach (var css in sites.Styles) Read(css);
        foreach (var script in sites.Scripts) Read(script.Script);
        foreach (var text in module) Read(text);
        return names;
    }

    // ---- where the code of a job is, and where it runs -----------------------------------------------------------------------------

    /// <summary>The properties a raw set writes an expression into (Value of an assignment, an argument or an Expression widget;
    /// Condition of an If): the Model API's kind of the others is not read here.</summary>
    private static readonly HashSet<string> RawExpressionProps = new(StringComparer.Ordinal) { "Value", "Condition" };

    public static Sites Collect(JsonArray ops, string? prefix, string lane)
    {
        var odc = string.Equals(lane, "odc", StringComparison.OrdinalIgnoreCase);
        var sites = new Sites();
        string? Pointer(int op, string suffix) => prefix == null ? null : $"{prefix}/{op}{suffix}";
        var empty = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var runtime = RuntimeAttributes(lane);
        var functions = Functions(lane);

        // The logic ops in the JSON form.
        var job = JobFacts.From(ops);
        foreach (var action in job.Actions)
        {
            var side = action.Kind switch
            {
                "client" => Side.Client,
                "screen" => OwnerSide(action.Owner, odc),
                _ => Side.Server,
            };
            var element = $"{(action.Kind == "screen" ? "screen" : action.Kind)} action {(action.IsScreen ? OwnerName(action.Owner) + "." : "")}{action.Name}";
            var at = $"/data/actions/{action.Index}";
            var types = action.Locals.Where(p => p.Type != null).GroupBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First().Type!, StringComparer.OrdinalIgnoreCase);
            var scan = LogicScan.Of(action.Declaration);
            foreach (var e in scan.Expressions) sites.Expressions.Add(new(action.Op, Pointer(action.Op, at + e.Pointer), "logic", element, null, e.Text, side, types));
            foreach (var (step, pointer) in scan.Steps)
                if (step["node"]?.ToString() == "IJavaScriptNode" && step["properties"]?["JavaScript"] is JsonValue js && js.TryGetValue<string>(out var code))
                    sites.Scripts.Add(new(action.Op, Pointer(action.Op, at + pointer + "/properties/JavaScript"), "logic",
                        $"{element}, JavaScript node {step["as"]?.ToString() ?? step["name"]?.ToString() ?? pointer}", code, side));
        }

        // The raw ops: what the job creates (alias -> type, parent, name) and the types of the variables it creates in each.
        var created = new Dictionary<string, (string Type, string Parent, string? Name)>(StringComparer.Ordinal);
        var declared = new Dictionary<string, (string Owner, string Name)>(StringComparer.Ordinal);
        var rawTypes = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            if (op["op"]?.ToString() == "create" && op["as"]?.ToString() is { Length: > 0 } alias && op["type"]?.ToString() is { } createdType)
            {
                var type = createdType.Split('.').Last();
                created[alias] = (type, op["parent"]?.ToString() ?? "", op["name"]?.ToString());
                if (type is "ILocalVariable" or "IInputParameter" or "IOutputParameter" && op["name"]?.ToString() is { Length: > 0 } variable)
                    declared[alias] = (op["parent"]?.ToString() ?? "", variable);
            }
            if (op["op"]?.ToString() == "set" && op["prop"]?.ToString() == "DataType" && op["value"]?.ToString() is { Length: > 0 } dataType
                && op["target"]?.ToString() is { } typed && declared.TryGetValue(typed, out var v))
                (rawTypes.TryGetValue(v.Owner, out var map) ? map : rawTypes[v.Owner] = new(StringComparer.OrdinalIgnoreCase))[v.Name] = dataType;
        }
        string? baseKey = null;
        (Side Side, string? Owner) Chain(string target)
        {
            baseKey = null;
            var at = target;
            string? owner = null;
            for (var guard = 0; guard < 64; guard++)
            {
                var root = at.Split('/')[0];
                if (root.StartsWith('$') && created.TryGetValue(root, out var c))
                {
                    if (c.Type is "IClientAction" or "IServerAction" or "IServiceAction" or "IScreenAction" or "IDataAction") owner ??= root;
                    switch (c.Type)
                    {
                        case "IClientAction" or "IMobileScreen" or "IMobileBlock": return (Side.Client, owner);
                        case "IServerAction" or "IServiceAction" or "IDataAction" or "IWebScreen" or "IWebBlock" or "IWebEmail": return (Side.Server, owner);
                    }
                    at = c.Parent;
                    continue;
                }
                if (root.Contains(':'))
                {
                    var kind = KindNames.Normalize(root[..root.IndexOf(':')]);
                    return kind switch
                    {
                        "IClientAction" or "IMobileScreen" or "IMobileBlock" => (Side.Client, owner),
                        "IServerAction" or "IServiceAction" or "IDataAction" or "IWebScreen" or "IWebBlock" or "IWebEmail" => (Side.Server, owner),
                        // A screen action, a node or a widget named by its kind: on a screen or in logic whose runtime the
                        // module type says (ODC: the client). Data, settings and the rest hold no client code.
                        var other when other.StartsWith("I", StringComparison.Ordinal) && (other.EndsWith("Node", StringComparison.Ordinal) || other is "IScreenAction"
                            || RuntimeDomTable.Rows(odc ? "odc" : "o11").Any(r => r.Widget == other)) => (odc ? Side.Client : Side.ByModule, owner),
                        _ => (Side.Server, owner),
                    };
                }
                if (root.StartsWith('@') && root != "@espace") { baseKey = root; return (Side.ByBase, owner); }
                return (Side.Server, owner);
            }
            return (Side.Server, owner);
        }

        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            var kind = op["op"]?.ToString();
            if (kind == "logic" && op["data"] is JsonObject flowData && flowData.ContainsKey("flow")) FlowSites(sites, i, flowData, odc, Pointer);
            if (kind == "html") HtmlSites(sites, i, op, odc, Pointer, runtime, empty, functions);
            if (kind == "set" && op["value"] is JsonValue sv && sv.TryGetValue<string>(out var value) && op["target"]?.ToString() is { } target && op["prop"]?.ToString() is { } prop)
            {
                var root = target.Split('/')[0];
                if (prop == "JavaScript")
                {
                    var known = created.TryGetValue(root, out var c) ? c : ((string Type, string Parent, string? Name)?)null;
                    // A JavaScript node runs only in client logic; a module Script and any other target: what the module is.
                    var side = known?.Type == "IJavaScriptNode" ? Side.Client : odc ? Side.Client : Side.ByModule;
                    var element = known is { } k ? $"{(k.Type == "IJavaScriptNode" ? "JavaScript node" : k.Type)} {k.Name ?? target}" : $"the JavaScript of {target}";
                    sites.Scripts.Add(new(i, Pointer(i, "/value"), "set", element, value, side));
                }
                else if (prop is "StyleSheet" or "Style" or "CSS") sites.Styles.Add(value);
                else if (RawExpressionProps.Contains(prop))
                {
                    var (side, owner) = Chain(target);
                    var direct = side == Side.ByBase && baseKey == root;
                    if (side == Side.Server) continue;
                    var types = owner != null && rawTypes.TryGetValue(owner, out var t) ? t : empty;
                    var name = created.TryGetValue(root, out var c) ? $"{c.Type.TrimStart('I')} {c.Name ?? root}" : target;
                    sites.Expressions.Add(new(i, Pointer(i, "/value"), "set", $"{prop} of {name}", null, value, side, types,
                        side == Side.ByBase ? (direct ? target : baseKey) : null, direct ? prop : null));
                }
            }
            // A CSS text anywhere else in the op (data.css of html ops, a theme or css op).
            if (kind != "set" && op["data"]?["css"] is JsonValue cssValue && cssValue.TryGetValue<string>(out var css)) sites.Styles.Add(css);
        }
        return sites;
    }

    private static Side OwnerSide(string owner, bool odc)
    {
        if (owner.StartsWith("IMobileScreen:", StringComparison.Ordinal) || owner.StartsWith("IMobileBlock:", StringComparison.Ordinal)) return Side.Client;
        if (owner.StartsWith("IWebScreen:", StringComparison.Ordinal) || owner.StartsWith("IWebBlock:", StringComparison.Ordinal) || owner.StartsWith("IWebEmail:", StringComparison.Ordinal)) return Side.Server;
        return odc ? Side.Client : Side.ByModule;
    }

    private static string OwnerName(string owner) => owner.Contains(':') ? owner[(owner.IndexOf(':') + 1)..] : owner;

    private static void FlowSites(Sites sites, int op, JsonObject data, bool odc, Func<int, string, string?> pointer)
    {
        List<(string Text, string? BasedOn, string Pointer)> texts;
        try { texts = FlowTextForm.Texts(data); } catch { return; }
        foreach (var (text, _, at) in texts)
        {
            FlowItem action;
            try { action = ModuleFlow.Read(text); } catch (FormatException) { continue; }
            var side = action.Kind switch
            {
                "ClientAction" => Side.Client,
                "ScreenAction" => odc ? Side.Client : Side.ByModule,
                _ => Side.Server,
            };
            var label = FlowPrinter.Labels.TryGetValue(action.Kind, out var l) ? l : "action";
            var element = $"{label} {(action.Owner.Length > 0 ? action.Owner + "." : "")}{action.Name}";
            var types = action.Items.Where(p => p.Role is "in" or "out" or "local" && p.Prop("DataType") is not null)
                .GroupBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First().Prop("DataType")!, StringComparer.OrdinalIgnoreCase);
            void Visit(FlowItem item, string? node)
            {
                var name = item.Role == "node" ? (item.Name.Length > 0 ? item.Name : item.Kind) : node;
                foreach (var (_, value) in item.Props)
                    if (value.Type == 'e') sites.Expressions.Add(new(op, pointer(op, "/data" + at), "logic", element + (name == null ? "" : $", node {name}"), null, value.Text, side, types));
                if (item.Role == "node" && item.Kind == "JavaScriptNode" && item.Prop("JavaScript") is { } code)
                    sites.Scripts.Add(new(op, pointer(op, "/data" + at), "logic", $"{element}, JavaScript node {name}", code, side));
                foreach (var child in item.Items) Visit(child, name);
            }
            Visit(action, null);
        }
    }

    private static readonly Regex Run = new(@"\{\{(.*?)\}\}", RegexOptions.Compiled | RegexOptions.Singleline);

    private static void HtmlSites(Sites sites, int op, JsonObject html, bool odc, Func<int, string, string?> pointer, IReadOnlySet<string> runtime,
        Dictionary<string, string> empty, DateTimeFunctions functions)
    {
        var data = html["data"] as JsonObject;
        var texts = new List<(string At, string Text, Side Side)>();
        if (html["parent"] != null)
        {
            if (html["html"] is JsonValue fragment && fragment.TryGetValue<string>(out var f)) texts.Add(("/html", f, odc ? Side.Client : Side.ByModule));
        }
        else if (data == null) return;
        else if (ScreenHtmlEdit.IsEdit(html))
        {
            var side = odc ? Side.Client : Side.ByModule;
            if (data["edits"] is JsonArray edits) { ElementEdits(sites, op, data, edits, side, pointer, runtime, functions); return; }
            if (data["edit"] is JsonArray list)
            {
                for (var j = 0; j < list.Count; j++) if (list[j] is JsonValue v && v.TryGetValue<string>(out var t)) texts.Add(($"/data/edit/{j}", t, side));
            }
            else if (data["html"] is JsonValue whole && whole.TryGetValue<string>(out var document)) texts.Add(("/data/html", document, side));
        }
        else if (ScreenDocument.IsDocumentOp(html))
            // The document form is Reactive and Mobile only (a Traditional flow is refused at apply, HTML_TRADITIONAL).
            texts.Add(("/data/html", data["html"]!.GetValue<string>(), Side.Client));
        else if (data["components"] == null)
        {
            // The page form (HtmlExpander): Reactive and Mobile only; its bindings and its scripts.
            var screen = data["screen"]?.ToString() ?? "page";
            foreach (var (at, text) in HtmlExpander.Expressions(data))
                sites.Expressions.Add(new(op, pointer(op, "/data" + at), "html", $"page {screen}", null, text, Side.Client, empty));
            if (data["scripts"] is JsonArray scripts)
                for (var s = 0; s < scripts.Count; s++)
                    if (scripts[s]?["code"] is JsonValue c && c.TryGetValue<string>(out var code))
                        sites.Scripts.Add(new(op, pointer(op, $"/data/scripts/{s}/code"), "html", $"page {screen}, script {scripts[s]?["name"]}", code, Side.Client));
            return;
        }
        foreach (var (at, text, side) in texts)
        {
            ScreenHtml.Node root;
            try { root = ScreenHtml.Parse(text); } catch (FormatException) { continue; }
            Document(sites, op, pointer(op, at), root, null, side, runtime, functions, Types(root));
        }
    }

    /// <summary>The data the document declares, by name and type (its variables and inputs).</summary>
    private static Dictionary<string, string> Types(ScreenHtml.Node root)
    {
        var types = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (node, _) in ScreenHtmlText.Elements(root))
            if (node.Tag is "var" or "input" && node.Get("name") is { } n && node.Get("type") is { } t && !types.ContainsKey(n)) types[n] = t;
        return types;
    }

    private static string Owner(ScreenHtml.Node root)
    {
        var top = root.Children.FirstOrDefault(c => !c.IsText);
        return top != null && top.Tag is "screen" or "block" && top.Get("name") is { } name ? $" of {top.Tag} {name}" : "";
    }

    private static string Label(ScreenHtml.Node node, string owner) =>
        $"<{node.Tag}{(node.Get("id") is { } id ? $" id=\"{id}\"" : node.Get("name") is { } nm ? $" name=\"{nm}\"" : node.Get("k") is { } k ? $" k=\"{k}\"" : "")}> (line {node.Line}){owner}";

    /// <summary>Every expression of an ssam-html tree: the {{ }} runs of attributes and text, if, list, os-Visible, block inputs,
    /// event arguments and the defaults of its data; the bound data-* attributes, the shown ones, what fills each, its CSS.</summary>
    private static void Document(Sites sites, int op, string? at, ScreenHtml.Node root, string? ownerLabel, Side side, IReadOnlySet<string> runtime,
        DateTimeFunctions functions, IReadOnlyDictionary<string, string> types)
    {
        var owner = ownerLabel ?? Owner(root);
        foreach (var (node, _) in ScreenHtmlText.Elements(root))
        {
            if (node.Tag == "#document") continue;
            if (node.Tag == "style") { foreach (var child in node.Children.Where(c => c.IsText)) sites.Styles.Add(child.Text!); continue; }
            var element = Label(node, owner);
            var shows = node.Children.Any(c => c.IsText && c.Text!.Contains("{{", StringComparison.Ordinal)) || node.Get("data-expression") != null;
            foreach (var (name, value) in node.Attributes)
                Attribute(sites, op, at, element, node.Tag, name, value, shows, side, runtime, functions, types);
            foreach (var child in node.Children.Where(c => c.IsText))
                foreach (Match run in Run.Matches(child.Text!)) sites.Expressions.Add(new(op, at, "html", element, null, run.Groups[1].Value, side, types));
        }
    }

    private static void Attribute(Sites sites, int op, string? at, string element, string tag, string name, string value, bool shows, Side side,
        IReadOnlySet<string> runtime, DateTimeFunctions functions, IReadOnlyDictionary<string, string> types)
    {
        if (name is "if" or "list" or "os-Visible" || name.StartsWith(':') || name == "default" && tag is "var" or "input")
            sites.Expressions.Add(new(op, at, "html", element, name, value, side, types));
        else if ((name.StartsWith("on", StringComparison.Ordinal) || name.StartsWith('@')) && ScreenDocument.ParseCall(value, out _, out var arguments))
            foreach (var (_, argument) in arguments) sites.Expressions.Add(new(op, at, "html", element, name, argument, side, types));
        var bound = false;
        foreach (Match run in Run.Matches(value))
        {
            sites.Expressions.Add(new(op, at, "html", element, name, run.Groups[1].Value, side, types));
            bound = true;
            var filler = FillerOf(run.Groups[1].Value, types, functions);
            if (!sites.Fillers.TryGetValue(name, out var had) || filler > had) sites.Fillers[name] = filler;
        }
        if (!name.StartsWith("data-", StringComparison.OrdinalIgnoreCase) || runtime.Contains(name)) return;
        if (shows) sites.Shown.Add(name);
        if (bound) sites.Bound.Add(new(op, at, element, name, side));
    }

    /// <summary>The element edits of a reading (data.edits): what each edit writes is judged where it is written (its pointer),
    /// in the context of the reading when the store keeps it (the element a set changes, the document's data types), the way
    /// ScreenHtmlEdit.Preflight rebuilds the document.</summary>
    private static void ElementEdits(Sites sites, int op, JsonObject data, JsonArray edits, Side side, Func<int, string, string?> pointer,
        IReadOnlySet<string> runtime, DateTimeFunctions functions)
    {
        ScreenHtml.Node? reading = null;
        try
        {
            if (data["basedOn"] is JsonObject on && on["capture"]?.ToString() is { Length: > 0 } capture && on["html"]?.ToString() is { Length: > 0 } read
                && ModuleIndexStore.Default()?.LoadHtmlKeys(capture, read) is { } kept && kept["html"] is JsonValue keptHtml && keptHtml.TryGetValue<string>(out var baseText))
            {
                var keys = (kept["keys"] as JsonObject)?.Where(p => p.Value is JsonValue).ToDictionary(p => p.Key, p => p.Value!.ToString(), StringComparer.Ordinal);
                var applied = HtmlElementEdits.Apply(baseText, edits, keys);
                reading = ScreenHtml.Parse(applied.Problems.Count == 0 ? applied.Document : baseText);
            }
        }
        catch (Exception ex) when (ex is FormatException or IOException or InvalidOperationException) { reading = null; }
        var types = reading != null ? Types(reading) : new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var owner = reading != null ? Owner(reading) : $" of {data["screen"]}";
        var byKey = new Dictionary<string, ScreenHtml.Node>(StringComparer.Ordinal);
        if (reading != null) foreach (var (node, _) in ScreenHtmlText.Elements(reading)) if (node.Get("k") is { } k) byKey.TryAdd(k, node);
        for (var j = 0; j < edits.Count; j++)
        {
            if (edits[j] is not JsonObject edit) continue;
            if (edit["set"]?.ToString() is { Length: > 0 } key && edit["attributes"] is JsonObject attributes)
            {
                var node = byKey.TryGetValue(key, out var n) ? n : null;
                var element = node != null ? Label(node, owner) : $"the element {key}{owner}";
                var shows = node != null && (node.Children.Any(c => c.IsText && c.Text!.Contains("{{", StringComparison.Ordinal)) || node.Get("data-expression") != null);
                foreach (var (name, value) in attributes)
                    if (value is JsonValue av && av.TryGetValue<string>(out var text))
                        Attribute(sites, op, pointer(op, $"/data/edits/{j}/attributes/{name.Replace("~", "~0").Replace("/", "~1")}"), element, node?.Tag ?? "", name, text, shows, side, runtime, functions, types);
            }
            foreach (var field in new[] { "insert", "with" })
            {
                if (edit[field] is not JsonValue fv || !fv.TryGetValue<string>(out var markup) || !markup.Contains("{{", StringComparison.Ordinal) && !markup.Contains('<')) continue;
                var at = pointer(op, $"/data/edits/{j}/{field}");
                try { Document(sites, op, at, ScreenHtml.Parse(markup), owner, side, runtime, functions, types); }
                catch (FormatException)
                {
                    // A find/with text that is no element: its {{ }} runs.
                    foreach (Match run in Run.Matches(markup)) sites.Expressions.Add(new(op, at, "html", $"the text of edit {j}{owner}", null, run.Groups[1].Value, side, types));
                }
            }
        }
    }
}
