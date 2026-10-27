using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// T9 review round (2026-10-23): one test per finding of the independent review of 31b6ad0a. The production rule: a false
/// refusal is a regression, so what the rule cannot prove is a warning, never an error. Synthetic names; both lanes.
/// </summary>
public sealed class ReactiveClientRulesReviewTests
{
    private readonly Xunit.Abstractions.ITestOutputHelper output;
    public ReactiveClientRulesReviewTests(Xunit.Abstractions.ITestOutputHelper output) => this.output = output;

    private static readonly string[] Codes = ["DATETIME_TZ_REINTERPRETED", "DOM_MUTATION_OF_RUNTIME", "JS_RUNTIME_DUPLICATE"];
    private static string Lane => MessageExpectations.Lane;

    private static JsonArray OpsOf(string json) => JsonNode.Parse(json)!["ops"]!.AsArray();

    /// <summary>The first preflight (JobPreflight.Analyze) and the module pass (PreflightChecks.WithModule), problems and
    /// warnings together, each with its severity.</summary>
    private static List<JsonObject> Judge(string json, IBaseFacts? module = null)
    {
        var job = JsonNode.Parse(json)!;
        var pure = JobPreflight.Analyze(job["ops"]!.AsArray(), job, []);
        var all = pure["problems"]!.AsArray().OfType<JsonObject>().Concat(pure["warnings"]!.AsArray().OfType<JsonObject>()).ToList();
        if (module != null)
        {
            var found = PreflightChecks.WithModule(OpsOf(json), "/ops", Lane, module);
            all.AddRange(found.Problems); all.AddRange(found.Warnings);
        }
        return all.Where(p => Codes.Contains(p["code"]!.GetValue<string>()) || p["code"]!.GetValue<string>() == "ATTRIBUTE_UNREAD").ToList();
    }

    private static List<JsonObject> Errors(IEnumerable<JsonObject> found) => found.Where(p => p["severity"]!.GetValue<string>() == "error").ToList();
    private static List<JsonObject> Warned(IEnumerable<JsonObject> found) => found.Where(p => p["severity"]!.GetValue<string>() == "warning").ToList();
    private static string Text(JsonObject p) => p["message"]!.GetValue<string>() + " " + p["fix"]?.GetValue<string>();

    private static string Ops(params string[] ops) => "{\"ops\":[" + string.Join(",", ops) + "]}";
    private static string HtmlOp(string html) => new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } }.ToJsonString();
    private static string Set(string target, string prop, string value) => new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = prop, ["value"] = value }.ToJsonString();

    private const string ScreenStart = """<screen name="T9Review" flow="MainFlow" title="&quot;Review&quot;" data-actions="T9Load"><var name="T9Seen" type="Date Time"/><var name="T9Day" type="Date"/><Block name="LayoutBlank"><slot name="Content">""";
    private const string ScreenEnd = "</slot></Block></screen>";
    private static string Screen(string body) => HtmlOp(ScreenStart + body + ScreenEnd);

    private static string Script(string script) => string.Join(",",
        """{"op":"create","parent":"@espace","type":"IClientAction","name":"T9Paint","as":"$paint"}""",
        """{"op":"create","parent":"$paint","type":"IJavaScriptNode","name":"T9PaintScript","as":"$paintScript"}""",
        Set("$paintScript", "JavaScript", script));

    private static string Action(string kind, string expression, string? owner = null)
    {
        var action = new JsonObject
        {
            ["name"] = "T9Show", ["kind"] = kind,
            ["vars"] = new JsonArray(
                new JsonObject { ["name"] = "T9When", ["type"] = "Date Time" }, new JsonObject { ["name"] = "T9Day", ["type"] = "Date" },
                new JsonObject { ["name"] = "T9Offset", ["type"] = "Integer" }, new JsonObject { ["name"] = "T9Out", ["type"] = "Text" }),
            ["steps"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { ["T9Out"] = expression } }),
        };
        if (owner != null) action["owner"] = owner;
        return new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(action) } }.ToJsonString();
    }

    /// <summary>The base as the module pass reads it: the module type, where an @key runs, the module's own CSS and scripts.</summary>
    private sealed class Module(string? moduleType, bool? clientSide = null, IReadOnlyList<string>? texts = null) : IBaseFacts
    {
        public IReadOnlyDictionary<string, string>? Attributes(string record) => null;
        public bool IsClientEntity(string name) => false;
        public CalleeFact? Callee(string target, JsonObject caller) => null;
        public bool HasName(string name) => true;
        public bool NamesOnlyTypes(string name) => false;
        public bool IsFunction(string name) => false;
        public string? ModuleType => moduleType;
        public RawExpressionFact? RawExpression(string target, string prop) => prop is "Value" or "Condition" ? new RawExpressionFact(null, [], [], false) : null;
        public bool? IsClientSide(string target) => clientSide;
        public IReadOnlyList<string>? StyleSheetsAndScripts => texts;
    }

    private static IBaseFacts ClientModule(IReadOnlyList<string>? texts = null, bool? clientSide = null) => new Module(Lane == "odc" ? "Reactive" : "CrossDevice", clientSide, texts);

    // ---- 1 (HIGH): the parse of an attribute is judged by what fills it, never by its name ------------------------------------

    [Fact]
    public void R01_AScriptThatParsesServerTextIsNotRefused()
    {
        const string parse = "var e = document.getElementById($parameters.Id); $parameters.Shown = new Date(e.getAttribute('data-started-utc')).toLocaleString();";
        // Text built on the server in an attribute named utc, parsed by the script: the fix the rule recommends.
        var server = Judge(Ops(Screen("""<span id="StartedCell" data-started-utc="{{ T9Load.StartedOnUtcText }}">{{ T9Load.Title }}</span>"""), Script(parse)), ClientModule([]));
        Assert.Empty(Errors(server));
        // The job fills the attribute with a Date Time of the client marked UTC: the parse converts it twice (refused).
        var client = Judge(Ops(Screen("""<span id="StartedCell" data-started-at="{{ FormatDateTime(T9Seen, &quot;yyyy-MM-ddTHH:mm:ss&quot;) + &quot;Z&quot; }}">x</span>"""),
            Script(parse.Replace("data-started-utc", "data-started-at"))));
        Assert.Contains(Errors(client), p => p["code"]!.GetValue<string>() == "DATETIME_TZ_REINTERPRETED" && p["pointer"]!.GetValue<string>() == "/ops/3/value");
        // The job leaves the attribute unwritten: what fills it is unknown, a warning at most.
        var unknown = Judge(Ops(Script(parse)));
        Assert.Empty(Errors(unknown));
        Assert.Single(Warned(unknown), p => p["code"]!.GetValue<string>() == "DATETIME_TZ_REINTERPRETED");
    }

    // ---- 2 (MEDIUM): utc is a whole word of the name ---------------------------------------------------------------------------

    [Fact]
    public void R02_UtcIsAWholeWordOfTheNameAndArithmeticIsNoParse()
    {
        var found = Judge(Ops(Screen("""<span id="OutcomeCell" data-outcome-date="{{ FormatDateTime(T9Seen, &quot;yyyy-MM-dd HH:mm&quot;) }}">x</span>"""),
            Script("var e = document.getElementById($parameters.Id); $parameters.A = new Date(e.dataset.outcomeDate); $parameters.B = new Date(Date.now() + Number(e.dataset.utcOffset) * 60000);")));
        Assert.DoesNotContain(found, p => p["code"]!.GetValue<string>() == "DATETIME_TZ_REINTERPRETED");
        // A whole word still counts: data-seen-utc holding a Date Time of the client.
        var named = Judge(Ops(Screen("""<span id="SeenCell" data-seen-utc="{{ FormatDateTime(T9Seen, &quot;yyyy-MM-ddTHH:mm:ss&quot;) }}">x</span>""")));
        Assert.Single(Errors(named), p => p["code"]!.GetValue<string>() == "DATETIME_TZ_REINTERPRETED");
    }

    // ---- 3 (MEDIUM): a Date has no time zone -----------------------------------------------------------------------------------

    [Fact]
    public void R03_ADateFormattedWithAUtcMaskIsNotRefused()
    {
        foreach (var expression in new[] {
                     "FormatDateTime(T9Day, \"yyyy-MM-ddT00:00:00Z\")", "FormatDateTime(CurrDate(), \"yyyy-MM-ddT00:00:00Z\")",
                     "FormatDateTime(NewDate(2026, 1, 2), \"yyyy-MM-dd\") + \"Z\"", "DateTimeToText(TextToDate(\"2026-01-02\")) + \"Z\"",
                     "FormatDateTime(DateTimeToDate(T9When), \"yyyy-MM-ddT00:00:00Z\")", "FormatDateTime(#2026-01-02#, \"yyyy-MM-ddT00:00:00Z\")" })
            Assert.Empty(Errors(Judge(Ops(Action("client", expression)))));
        Assert.Empty(Errors(Judge(Ops(Screen("""<span id="DayCell" data-day="{{ FormatDateTime(T9Day, &quot;yyyy-MM-ddT00:00:00Z&quot;) }}">x</span>""")))));
    }

    // ---- 4 (MEDIUM): every form that writes client code is judged ------------------------------------------------------------------

    [Fact]
    public void R04a_ARawClientAssignmentIsJudgedByItsParentChain()
    {
        string Raw(string actionType) => Ops(
            "{\"op\":\"create\",\"parent\":\"@espace\",\"type\":\"" + actionType + "\",\"name\":\"T9Stamp\",\"as\":\"$stamp\"}",
            """{"op":"create","parent":"$stamp","type":"ILocalVariable","name":"T9When","as":"$when"}""",
            Set("$when", "DataType", "Date Time"),
            """{"op":"create","parent":"$stamp","type":"IAssignNode","name":"T9SetStamp","as":"$assign"}""",
            """{"op":"create","parent":"$assign","type":"IAssignment","as":"$a1"}""",
            Set("$a1", "Variable", "T9Out"),
            Set("$a1", "Value", "FormatDateTime(T9When, \"yyyy-MM-ddTHH:mm:ss\") + \"Z\""));
        Assert.Single(Errors(Judge(Raw("IClientAction"))), p => p["code"]!.GetValue<string>() == "DATETIME_TZ_REINTERPRETED" && p["pointer"]!.GetValue<string>() == "/ops/6/value");
        Assert.Empty(Errors(Judge(Raw("IServerAction"))));
    }

    [Fact]
    public void R04b_ARawSetOnAKeyIsJudgedByWhereTheBaseSaysItRuns()
    {
        var ops = Ops(Set("@AbCdEfGhIjKlMnOpQrStUv", "Value", "DateTimeToText(CurrDateTime()) + \"Z\""));
        Assert.Empty(Errors(Judge(ops)));                                                     // no base: unknown
        Assert.Single(Errors(Judge(ops, ClientModule(clientSide: true))), p => p["code"]!.GetValue<string>() == "DATETIME_TZ_REINTERPRETED");
        Assert.Empty(Errors(Judge(ops, ClientModule(clientSide: false))));                    // server logic of the base
    }

    [Fact]
    public void R04c_TheElementEditsFormIsJudged()
    {
        var edits = new JsonObject
        {
            ["op"] = "html",
            ["data"] = new JsonObject
            {
                ["screen"] = "T9Review", ["basedOn"] = new JsonObject { ["capture"] = new string('0', 64), ["html"] = new string('1', 64) },
                ["edits"] = new JsonArray(
                    new JsonObject { ["set"] = "w3", ["attributes"] = new JsonObject { ["data-seen-utc"] = "{{ FormatDateTime(T9Seen, \"yyyy-MM-ddTHH:mm:ss\") + \"Z\" }}" } },
                    new JsonObject { ["into"] = "w5", ["insert"] = "<span>{{ DateTimeToText(T9Seen) + \" UTC\" }}</span>" }),
            },
        }.ToJsonString();
        var found = Errors(Judge(Ops(edits), ClientModule()));
        Assert.Equal(2, found.Count(p => p["code"]!.GetValue<string>() == "DATETIME_TZ_REINTERPRETED"));
        Assert.All(found, p => Assert.StartsWith("/ops/0/data/edits/", p["pointer"]!.GetValue<string>()));
    }

    [Fact]
    public void R04d_TheDefaultOfADocumentVariableIsJudged()
    {
        var found = Errors(Judge(Ops(HtmlOp("""<screen name="T9Review" flow="MainFlow" title="&quot;Review&quot;"><var name="T9Stamp" type="Text" default="FormatDateTime(CurrDateTime(), &quot;yyyy-MM-ddTHH:mm:ss&quot;) + &quot;Z&quot;"/><Block name="LayoutBlank"><slot name="Content"><span>{{ T9Stamp }}</span></slot></Block></screen>"""))));
        Assert.Single(found, p => p["code"]!.GetValue<string>() == "DATETIME_TZ_REINTERPRETED" && Text(p).Contains("T9Stamp"));
    }

    // ---- 5 (MEDIUM): a conversion the client code makes itself is a warning ------------------------------------------------------

    [Fact]
    public void R05_AClientSideConversionToUtcIsAWarningWithItsReason()
    {
        var shifted = Judge(Ops(Action("client", "FormatDateTime(AddMinutes(T9When, T9Offset), \"yyyy-MM-ddTHH:mm:ss\") + \"Z\"")));
        Assert.Empty(Errors(shifted));
        Assert.Contains(Warned(shifted), p => p["code"]!.GetValue<string>() == "DATETIME_TZ_REINTERPRETED" && Text(p).Contains("AddMinutes"));
        var function = Judge(Ops(Action("client", "FormatDateTime(T9ToUtc(T9When), \"yyyy-MM-ddTHH:mm:ssZ\")")));
        Assert.Empty(Errors(function));
        Assert.Contains(Warned(function), p => p["code"]!.GetValue<string>() == "DATETIME_TZ_REINTERPRETED" && Text(p).Contains("T9ToUtc"));
        // A literal shift is still no conversion the rule can see: refused, and the message says what it proves, no more.
        var literal = Errors(Judge(Ops(Action("client", "FormatDateTime(AddHours(T9When, 3), \"yyyy-MM-ddTHH:mm:ss\") + \"Z\""))));
        var refused = Assert.Single(literal);
        Assert.DoesNotContain("is already in the browser's time zone", Text(refused));
    }

    // ---- 6 (LOW): what reads an attribute: value selectors, the module, the platform ------------------------------------------------

    [Fact]
    public void R06_ValueSelectorsTheModuleAndThePlatformReadAttributes()
    {
        var html = Screen("""<span id="StateCell" data-row-state="{{ T9Load.State }}">x</span><span id="KeyCell" data-testid="{{ T9Load.Key }}">y</span>""");
        // Without the module nothing proves an attribute unread.
        Assert.DoesNotContain(Judge(Ops(html)), p => p["code"]!.GetValue<string>() == "ATTRIBUTE_UNREAD");
        // The module's stylesheet reads it with a value selector.
        Assert.DoesNotContain(Judge(Ops(html), ClientModule(["[data-row-state=\"late\"] { color: red; }"])), p => p["code"]!.GetValue<string>() == "ATTRIBUTE_UNREAD");
        // A value selector of the job's own CSS and a querySelector of its script read it too.
        Assert.DoesNotContain(Judge(Ops(Screen("""<style>[data-row-state="late"] { color: red; }</style><span id="StateCell" data-row-state="{{ T9Load.State }}">x</span>""")), ClientModule([])),
            p => p["code"]!.GetValue<string>() == "ATTRIBUTE_UNREAD");
        Assert.DoesNotContain(Judge(Ops(html, Script("var late = document.querySelectorAll('[data-row-state=\"late\"]').length;")), ClientModule([])),
            p => p["code"]!.GetValue<string>() == "ATTRIBUTE_UNREAD" && Text(p).Contains("data-row-state"));
        // Nothing reads it: one warning, never for data-testid.
        var unread = Judge(Ops(html), ClientModule([]));
        Assert.Single(unread, p => p["code"]!.GetValue<string>() == "ATTRIBUTE_UNREAD" && Text(p).Contains("data-row-state"));
        Assert.DoesNotContain(unread, p => Text(p).Contains("data-testid"));
    }

    // ---- 7 (LOW): a name is resolved in its scope -------------------------------------------------------------------------------------

    [Fact]
    public void R07_ABindingIsResolvedInItsOwnScope()
    {
        var scoped = Judge(Ops(Script("""
            function measure() { var e = document.querySelector('[data-expression]'); return e.textContent.length; }
            function build() { var e = document.createElement('span'); e.textContent = 'x'; document.getElementById($parameters.Id).appendChild(e); }
            """)));
        Assert.DoesNotContain(scoped, p => p["code"]!.GetValue<string>() == "DOM_MUTATION_OF_RUNTIME");
        // Two values for one name in one scope: ambiguous, a warning.
        var ambiguous = Judge(Ops(Script("var e = document.querySelector('[data-expression]'); if ($parameters.Own) { e = document.createElement('span'); } e.textContent = 'y';")));
        Assert.Empty(Errors(ambiguous));
        Assert.Single(Warned(ambiguous), p => p["code"]!.GetValue<string>() == "DOM_MUTATION_OF_RUNTIME");
    }

    // ---- 8 (LOW): the viewport rule needs a write on the viewport meta ---------------------------------------------------------------

    [Fact]
    public void R08_AReadOfTheViewportAndAnotherContentWriteAreNoRewrite()
    {
        var found = Judge(Ops(Script("var vp = document.querySelector('meta[name=\"viewport\"]').getAttribute('content'); var card = {}; card.content = vp;")));
        Assert.DoesNotContain(found, p => p["code"]!.GetValue<string>() == "JS_RUNTIME_DUPLICATE");
    }

    // ---- 9 (LOW): what is legitimate is a warning; strings and comments are never code -----------------------------------------------

    [Fact]
    public void R09_LegitimatePatternsAreWarningsAndStringsAreNoCode()
    {
        foreach (var (script, code) in new[] {
                     ("var obs = new MutationObserver(function () { if (document.querySelector('.ready-marker')) obs.disconnect(); }); obs.observe(document.body, { childList: true, subtree: true });", "DOM_MUTATION_OF_RUNTIME"),
                     ("document.querySelector('[data-block=\"Charts.Host\"] .chart-host').innerHTML = '<canvas></canvas>';", "DOM_MUTATION_OF_RUNTIME"),
                     ("document.querySelectorAll('[data-list] tr').forEach(function (row) { row.setAttribute('tabindex', '0'); });", "DOM_MUTATION_OF_RUNTIME"),
                     ("document.querySelector('meta[name=viewport]').setAttribute('content', 'width=device-width, initial-scale=1, user-scalable=no');", "JS_RUNTIME_DUPLICATE") })
        {
            var found = Judge(Ops(Script(script)));
            Assert.True(Errors(found).Count == 0, script + ": " + string.Join(" | ", Errors(found).Select(Text)));
            Assert.Single(Warned(found), p => p["code"]!.GetValue<string>() == code);
        }
        var quoted = Judge(Ops(Script("""
            var help = "document.body.classList.toggle('phone'); new MutationObserver(f).observe(document.body, {subtree: true})";
            /* document.querySelector('[data-expression]').textContent = 'x'; document.querySelector('meta[name=viewport]').content = 'x'; */
            $parameters.Help = help;
            """)));
        Assert.Empty(quoted);
    }

    // ---- 10 (LOW): large inputs stay under a second ----------------------------------------------------------------------------------

    [Fact]
    public void R10_LargeInputsStayUnderASecond()
    {
        var selectors = new StringBuilder();
        for (var i = 0; selectors.Length < 397_000; i++) selectors.Append("document.querySelectorAll('[data-x-").Append(i).Append("] .item').forEach(function (e").Append(i).Append(") { e").Append(i).Append(".classList.add('a').toString(); });\n");
        var reads = new StringBuilder("var out = []; var e = document.getElementById($parameters.Id);\n");
        for (var i = 0; i < 2000; i++) reads.Append("var r").Append(i).Append(" = e.getAttribute('data-t").Append(i).Append("-utc'); if (r").Append(i).Append(") out.push(new Date(r").Append(i).Append("));\n");
        var cells = new StringBuilder();
        for (var i = 0; i < 800; i++) cells.Append("<span id=\"C").Append(i).Append("\" data-k").Append(i).Append("=\"{{ T9Load.K").Append(i).Append(" }}\">{{ T9Load.T }}</span>");
        foreach (var (name, job) in new[] { ("selectors", Ops(Script(selectors.ToString()))), ("utc reads", Ops(Script(reads.ToString()))), ("bound attributes", Ops(Screen(cells.ToString()))) })
        {
            var ops = OpsOf(job);
            ReactiveClientRules.Check(OpsOf(Ops(Script("var a = 1;"))), "/ops", Lane, null, false);   // warm
            var clock = Stopwatch.StartNew();
            ReactiveClientRules.Check(ops, "/ops", Lane, null, false);
            PreflightChecks.WithModule(ops, "/ops", Lane, ClientModule([]));
            clock.Stop();
            output.WriteLine($"{name}: {clock.ElapsedMilliseconds} ms for {job.Length / 1024} KB");
            Assert.True(clock.ElapsedMilliseconds < 1000, $"{name}: {clock.ElapsedMilliseconds} ms for {job.Length / 1024} KB");
        }
    }

    // ---- 11 (LOW): legitimate client code, the independent table, the captured files -------------------------------------------------

    [Fact]
    public void R11a_LegitimateClientCodeHasNoErrors()
    {
        var scripts = new[] {
            // OutSystems UI and component patterns: an own container, own children, classes and ARIA on own elements.
            "var host = document.getElementById($parameters.WidgetId); var chart = document.createElement('canvas'); host.appendChild(chart); host.classList.add('chart-ready'); host.setAttribute('aria-busy', 'false');",
            "var tabs = document.querySelectorAll('.osui-tabs__header-item'); tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === $parameters.Active); });",
            "var panel = document.querySelector('.my-panel'); panel.style.height = window.innerHeight + 'px';",
            // Date handling that is right on the client.
            "$parameters.Iso = new Date().toISOString();",
            "$parameters.Local = new Date($parameters.Year, $parameters.Month - 1, $parameters.Day).toLocaleDateString();",
            "$parameters.Shown = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date($parameters.Epoch));",
            "var d = new Date($parameters.IsoText); $parameters.Minutes = d.getTimezoneOffset();",
            "var picker = document.getElementById($parameters.InputId); picker.value = $parameters.LocalText; picker.type = 'datetime-local';",
            // Observers and listeners on own elements.
            "var box = document.getElementById($parameters.Id); new ResizeObserver(function () { box.classList.add('measured'); }).observe(box); new MutationObserver(function () {}).observe(box, { subtree: true, childList: true });",
            "window.addEventListener('resize', function () { document.getElementById($parameters.Id).classList.toggle('narrow', window.innerWidth < 600); });",
            // Reading what the runtime renders, without writing it.
            "$parameters.Count = document.querySelectorAll('[data-list] [data-expression]').length; $parameters.Text = document.querySelector('[data-expression]').textContent;",
            "var rows = document.querySelectorAll('[data-list] tr'); $parameters.Height = rows.length ? rows[0].getBoundingClientRect().height : 0;",
            // A date library: its own parse and format.
            "var m = window.dayjs($parameters.Text); $parameters.Shown = m.format('DD/MM/YYYY HH:mm');",
            // Strings that name runtime things.
            "$parameters.Hint = 'set meta[name=viewport] content in the theme, never in code; document.body.classList.toggle(\"phone\") is the runtime\\'s';",
        };
        foreach (var script in scripts)
        {
            var found = Errors(Judge(Ops(Script(script)), ClientModule([])));
            Assert.True(found.Count == 0, script + ": " + string.Join(" | ", found.Select(Text)));
        }
        // Bound data-* attributes that CSS reads, and a time shown with a display mask.
        var html = Judge(Ops(Screen("""<style>[data-row-state="late"] .badge { color: red; }</style><div id="Card" data-row-state="{{ T9Load.State }}"><span id="When">{{ FormatDateTime(T9Seen, "dd MMM yyyy HH:mm") }}</span><span id="Day">{{ FormatDateTime(T9Day, "yyyy-MM-dd") }}</span></div>""")), ClientModule([]));
        Assert.Empty(html);
    }

    /// <summary>An independent table: what each temporal built-in of the catalog gives, written here by hand from the platform's
    /// documentation, never from the rule. A built-in the catalog adds fails the test until the table says what it is.</summary>
    private static readonly Dictionary<string, string> Temporal = new(StringComparer.Ordinal)
    {
        // Text of a Date Time.
        ["DateTimeToText"] = "datetime-text", ["FormatDateTime"] = "datetime-text",
        // A Date Time.
        ["AddDays"] = "datetime", ["AddHours"] = "datetime", ["AddMinutes"] = "datetime", ["AddMonths"] = "datetime", ["AddSeconds"] = "datetime",
        ["AddYears"] = "datetime", ["BuildDateTime"] = "datetime", ["CurrDateTime"] = "datetime",
        ["NewDateTime"] = "datetime", ["TextToDateTime"] = "datetime",
        // A Date Time made from a Date: its time is midnight, no time zone to repeat.
        ["DateToDateTime"] = "datetime-of-date",
        // No time zone: a Date, a Time, their texts.
        ["CurrDate"] = "date", ["CurrTime"] = "time", ["DateTimeToDate"] = "date", ["DateTimeToTime"] = "time", ["DateToText"] = "date-text",
        ["NewDate"] = "date", ["NewTime"] = "time", ["NullDate"] = "date", ["TextToDate"] = "date", ["TextToTime"] = "time", ["TimeToText"] = "time-text",
        // Numbers of a Date Time (no text, no Date Time).
        ["Day"] = "number", ["DayOfWeek"] = "number", ["DiffDays"] = "number", ["DiffHours"] = "number", ["DiffMinutes"] = "number", ["DiffSeconds"] = "number",
        ["Hour"] = "number", ["Minute"] = "number", ["Month"] = "number", ["Second"] = "number", ["Year"] = "number",
    };

    [Fact]
    public void R11b_TheSweepAnswersFromAnIndependentTableWithDatesInDateTimeParameters()
    {
        var path = Directory.GetFiles(Path.Combine(JobSources.KernelRoot()!, "catalog"), "functions-*.json").OrderDescending().First();
        var catalog = JsonNode.Parse(File.ReadAllText(path))!["Functions"]!.AsArray().OfType<JsonObject>()
            .Select(f => (Name: f["Name"]!.GetValue<string>(), Return: f["ReturnType"]!.GetValue<string>(),
                Parameters: f["Parameters"]!.AsArray().OfType<JsonObject>().Select(p => (Type: p["Type"]!.GetValue<string>(), Optional: p["Optional"]?.GetValue<bool>() == true)).ToArray(),
                Client: f["ClientSide"]?.GetValue<bool>() == true))
            .Where(f => new[] { "Date Time", "Date", "Time" }.Contains(f.Return) || f.Parameters.Any(p => p.Type is "Date Time" or "Date" or "Time")).ToArray();
        var missing = catalog.Select(f => f.Name).Where(n => !Temporal.ContainsKey(n)).ToArray();
        Assert.True(missing.Length == 0, "the table does not say what these temporal built-ins give: " + string.Join(", ", missing));
        // A Date Time argument written as a Date Time, a Date (no time zone: nothing to repeat) and an untyped attribute.
        static string Argument(string type, string dateTime) => type.Replace(" ", "") switch
        {
            "DateTime" => dateTime, "Date" => "T9Day", "Time" => "#10:30:00#", "Text" => "\"yyyy-MM-ddTHH:mm:ss\"", "Integer" or "LongInteger" or "Decimal" => "1", "Boolean" => "True", _ => "",
        };
        var wrong = new List<string>(); var cases = 0;
        foreach (var f in catalog.Where(f => f.Client && Temporal[f.Name] is not "number" && f.Parameters.All(p => Argument(p.Type, "T9When").Length > 0)))
            foreach (var dateTime in new[] { "T9When", "T9Day", "CurrDate()" })
                foreach (var mark in new[] { "Z", "UTC", "+00:00", "" })
                    foreach (var (kind, owner, client) in new (string, string?, bool)[] { ("client", null, true), ("screen", "IMobileScreen:T9Review", true), ("server", null, false), ("screen", "IWebScreen:T9Review", false) })
                    {
                        cases++;
                        var call = f.Name + "(" + string.Join(", ", f.Parameters.Where(p => !p.Optional).Select(p => Argument(p.Type, dateTime))) + ")";
                        var expression = mark.Length == 0 ? call : call + " + \"" + mark + "\"";
                        // Independent: a Date Time (of the table) whose value is a Date Time variable, marked UTC, on the client.
                        var takesTheValue = f.Parameters.Any(p => p.Type == "Date Time");
                        var holdsATime = Temporal[f.Name] is "datetime" or "datetime-text" && (!takesTheValue || dateTime == "T9When");
                        var expected = holdsATime && mark.Length > 0 && client;
                        var refused = Errors(Judge(Ops(Action(kind, expression, owner)))).Any(p => p["code"]!.GetValue<string>() == "DATETIME_TZ_REINTERPRETED");
                        if (refused != expected) wrong.Add($"{kind}{(owner == null ? "" : " " + owner)}: {expression}: refused {refused}, expected {expected}");
                    }
        // The same calls in an attribute whose name has the word utc, on a screen (T9Seen a Date Time, T9Day a Date), and in another.
        foreach (var f in catalog.Where(f => f.Client && Temporal[f.Name] is not "number" && f.Parameters.All(p => Argument(p.Type, "T9Seen").Length > 0)))
            foreach (var dateTime in new[] { "T9Seen", "T9Day" })
            {
                var call = f.Name + "(" + string.Join(", ", f.Parameters.Where(p => !p.Optional).Select(p => Argument(p.Type, dateTime))) + ")";
                var holdsATime = Temporal[f.Name] is "datetime" or "datetime-text" && (!f.Parameters.Any(p => p.Type == "Date Time") || dateTime == "T9Seen");
                var encoded = System.Net.WebUtility.HtmlEncode(call);
                foreach (var (attribute, expected) in new[] { ("data-sweep-utc", holdsATime), ("data-sweep", false) })
                {
                    cases++;
                    var refused = Errors(Judge(Ops(Screen($"<span id=\"SweepCell\" {attribute}=\"{{{{ {encoded} }}}}\">x</span>")))).Any(p => p["code"]!.GetValue<string>() == "DATETIME_TZ_REINTERPRETED");
                    if (refused != expected) wrong.Add($"{attribute}=\"{{{{ {call} }}}}\": refused {refused}, expected {expected}");
                }
            }
        Assert.True(wrong.Count == 0, $"{wrong.Count} of {cases} cases:\n" + string.Join("\n", wrong.Take(60)));
    }

    [Fact]
    public void R11c_TheCapturedCasesFolderIsNeverWritten()
    {
        if (Environment.GetEnvironmentVariable("T9_CASE_DIR") is not { Length: > 0 } folder || !Directory.Exists(folder)) return;
        foreach (var stale in Directory.GetFiles(folder, "t9-result*.json")) File.Delete(stale);
        var before = Directory.GetFiles(folder).Order().ToArray();
        new ReactiveClientRulesTests().TheCapturedDeliveriesAreRefusedInTheFirstPreflight();
        Assert.Equal(before, Directory.GetFiles(folder).Order().ToArray());
    }

    // ---- 12 (NIT): the texts name no lane ---------------------------------------------------------------------------------------------

    [Fact]
    public void R12_TheTextsAreLaneNeutral()
    {
        var found = Judge(Ops(Screen("""<span id="StartedCell" data-started-utc="{{ FormatDateTime(T9Seen, &quot;yyyy-MM-ddTHH:mm:ss&quot;) + &quot;Z&quot; }}">{{ T9Seen }}</span><span data-k="{{ T9Load.K }}">x</span>"""),
            Script("var m = document.querySelector('meta[name=viewport]'); m.content = 'width=device-width'; document.body.classList.toggle('phone', true); new MutationObserver(function () {}).observe(document.body, { subtree: true }); document.querySelectorAll('[data-started-utc]').forEach(function (e) { e.textContent = String(new Date(e.getAttribute('data-started-utc'))); });")),
            ClientModule([]));
        Assert.True(found.Count >= 6, string.Join(" | ", found.Select(Text)));
        Assert.All(found, p => Assert.DoesNotMatch("Reactive|OutSystems UI|Traditional", Text(p)));
    }
}
