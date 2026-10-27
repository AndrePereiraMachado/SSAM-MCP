using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// T9 (Reactive client code keeps runtime semantics): a Date Time in a Reactive or ODC client is already in the browser's
/// time zone (the runtime converts it on the way from the server), so text that formats it on the client and labels it UTC,
/// and a script that parses such text as UTC, convert it a second time. The job of the captured case: a list cell with the
/// time formatted on the client plus "Z" in an attribute named utc, and a layout script that read that attribute with
/// new Date(), rewrote the cell's text, observed the whole body and toggled the device classes and the viewport meta the
/// runtime already owns. Synthetic names; both lanes (this file is compiled into Anvil.Tests and Anvil.Tests.Odc).
/// </summary>
public sealed class ReactiveClientRulesTests
{
    private static JsonObject Analyze(string json)
    {
        var job = JsonNode.Parse(json)!;
        return JobPreflight.Analyze(job["ops"]!.AsArray(), job, []);
    }

    private static JsonObject[] Problems(JsonObject result, string code)
        => result["problems"]!.AsArray().OfType<JsonObject>().Where(p => p["code"]!.GetValue<string>() == code).ToArray();

    private static JsonObject[] Warnings(JsonObject result, string code)
        => result["warnings"]!.AsArray().OfType<JsonObject>().Where(p => p["code"]!.GetValue<string>() == code).ToArray();

    private static string Ops(params string[] ops) => "{\"ops\":[" + string.Join(",", ops) + "]}";

    private static string HtmlOp(string html) => new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } }.ToJsonString();

    private static string Set(string target, string prop, string value) => new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = prop, ["value"] = value }.ToJsonString();

    private const string ScreenStart = """<screen name="T9Requests" flow="MainFlow" title="&quot;Requests&quot;" data-actions="T9Load"><var name="T9Seen" type="Date Time"/><Block name="LayoutBlank"><slot name="Content">""";
    private const string ScreenEnd = "</slot></Block></screen>";

    // The cell of the captured case: the time shown with a display mask, and the same time formatted on the client plus "Z"
    // in an attribute a script reads as UTC.
    private const string CapturedCell = """<span id="StartedOnCell" class="mono-cell" data-app-utc="{{ If(T9Load.StartedOn = NullDate(), &quot;&quot;, FormatDateTime(T9Load.StartedOn, &quot;yyyy-MM-ddTHH:mm:ss&quot;) + &quot;Z&quot;) }}">{{ FormatDateTime(T9Load.StartedOn, "MM/dd/yyyy h:mm tt") }}</span>""";

    // The layout script of the captured case, reduced: the viewport meta, the device classes on body, the utc attribute parsed
    // with new Date() and written back as the element's text, and a MutationObserver over the whole body.
    private const string CapturedScript = """
        (function() {
            var m = document.querySelector('meta[name=viewport]');
            if (!m) { m = document.createElement('meta'); m.name = 'viewport'; document.head.appendChild(m); }
            m.content = 'viewport-fit=cover, width=device-width, initial-scale=1';
            function refresh() {
                var w = document.documentElement.clientWidth;
                document.body.classList.toggle('phone', w < 768);
                document.body.classList.toggle('tablet', w >= 768 && w < 1024);
                document.body.classList.toggle('desktop', w >= 1024);
                document.querySelectorAll('[data-app-utc]').forEach(function(e) {
                    var raw = e.getAttribute('data-app-utc');
                    if (!raw) return;
                    var d = new Date(raw);
                    var s = (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
                    if (e.textContent !== s) e.textContent = s;
                });
            }
            function start() { refresh(); window.addEventListener('resize', refresh); new MutationObserver(refresh).observe(document.body, { childList: true, subtree: true }); }
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
        })();
        """;

    private static string ScriptOps(string script) => string.Join(",",
        """{"op":"create","parent":"@espace","type":"IClientAction","name":"T9RefreshAppearance","as":"$appearance"}""",
        """{"op":"create","parent":"$appearance","type":"IStartNode","as":"$start"}""",
        """{"op":"create","parent":"$appearance","type":"IJavaScriptNode","name":"T9RefreshRendered","as":"$script"}""",
        Set("$script", "JavaScript", script),
        """{"op":"create","parent":"$appearance","type":"IEndNode","as":"$end"}""",
        """{"op":"link","from":"$start","to":"$script"}""",
        """{"op":"link","from":"$script","to":"$end"}""");

    [Fact]
    public void TheCapturedCaseIsRefusedWholeInTheFirstPreflight()
    {
        var result = Analyze(Ops(HtmlOp(ScreenStart + CapturedCell + ScreenEnd), ScriptOps(CapturedScript)));
        Assert.False(result["valid"]!.GetValue<bool>());
        // The time formatted on the client and labelled UTC, in the attribute named utc: the element and the attribute named.
        var label = Assert.Single(Problems(result, "DATETIME_TZ_REINTERPRETED"), p => p["op"]!.GetValue<int>() == 0);
        Assert.Contains("StartedOnCell", label["message"]!.GetValue<string>());
        Assert.Contains("data-app-utc", label["message"]!.GetValue<string>());
        Assert.Contains("FormatDateTime(T9Load.StartedOn", label["fix"]!.GetValue<string>());
        // The script that parses the utc attribute as a Date: the same class, the attribute named.
        var parse = Assert.Single(Problems(result, "DATETIME_TZ_REINTERPRETED"), p => p["op"]!.GetValue<int>() == 4);
        Assert.Contains("data-app-utc", parse["message"]!.GetValue<string>());
        // The text written over what the runtime renders, and the observer over the whole body.
        var mutation = Problems(result, "DOM_MUTATION_OF_RUNTIME");
        Assert.Contains(mutation, p => p["message"]!.GetValue<string>().Contains("textContent") && p["message"]!.GetValue<string>().Contains("[data-app-utc]"));
        Assert.Contains(mutation, p => p["message"]!.GetValue<string>().Contains("subtree"));
        // The device classes and the viewport meta the runtime already owns.
        var duplicate = Problems(result, "JS_RUNTIME_DUPLICATE");
        Assert.Contains(duplicate, p => p["message"]!.GetValue<string>().Contains("phone") && p["message"]!.GetValue<string>().Contains("tablet"));
        Assert.Contains(duplicate, p => p["message"]!.GetValue<string>().Contains("viewport"));
        // Every problem names its element and carries one fix; all of them in this one answer.
        foreach (var p in Problems(result, "DATETIME_TZ_REINTERPRETED").Concat(mutation).Concat(duplicate))
        {
            Assert.Equal("error", p["severity"]!.GetValue<string>());
            Assert.False(string.IsNullOrWhiteSpace(p["fix"]?.GetValue<string>()));
            Assert.StartsWith("/ops/", p["pointer"]!.GetValue<string>());
        }
    }

    /// <summary>The captured deliveries themselves, when T9_CASE_DIR names the private folder that holds them (never in a
    /// repository): the first full delivery (entry-155.json: the cells with + "Z" in the utc attribute and the layout script)
    /// and the later script without the date rewrite (entry-774.json, still the observer, the device classes and the viewport).
    /// Nothing runs when the variable is unset.</summary>
    [Fact]
    public void TheCapturedDeliveriesAreRefusedInTheFirstPreflight()
    {
        if (Environment.GetEnvironmentVariable("T9_CASE_DIR") is not { Length: > 0 } folder || !Directory.Exists(folder)) return;
        JsonObject Of(string file) { var job = JsonNode.Parse(File.ReadAllText(Path.Combine(folder, file)))!; return JobPreflight.Analyze(job["ops"]!.AsArray(), job, []); }
        var first = Of("entry-155.json");
        Assert.Contains(Problems(first, "DATETIME_TZ_REINTERPRETED"), p => p["message"]!.GetValue<string>().Contains("utc", StringComparison.OrdinalIgnoreCase) && p["message"]!.GetValue<string>().Contains("FormatDateTime"));
        Assert.Contains(Problems(first, "DATETIME_TZ_REINTERPRETED"), p => p["message"]!.GetValue<string>().Contains("parses as a Date"));
        Assert.Contains(Problems(first, "DOM_MUTATION_OF_RUNTIME"), p => p["message"]!.GetValue<string>().Contains("textContent"));
        Assert.Contains(Problems(first, "DOM_MUTATION_OF_RUNTIME"), p => p["message"]!.GetValue<string>().Contains("subtree"));
        Assert.Equal(2, Problems(first, "JS_RUNTIME_DUPLICATE").Length);
        var later = Of("entry-774.json");
        Assert.Empty(Problems(later, "DATETIME_TZ_REINTERPRETED"));
        Assert.Contains(Problems(later, "DOM_MUTATION_OF_RUNTIME"), p => p["message"]!.GetValue<string>().Contains("subtree"));
        Assert.Equal(2, Problems(later, "JS_RUNTIME_DUPLICATE").Length);
        // Never in the folder of the cases (customer excerpts): a summary in TEMP, deleted at once.
        var summary = Path.Combine(Path.GetTempPath(), "t9-result-" + Guid.NewGuid().ToString("N") + ".json");
        try { File.WriteAllText(summary, new JsonObject { ["first"] = first["problems"]!.AsArray().Count, ["later"] = later["problems"]!.AsArray().Count }.ToJsonString()); }
        finally { File.Delete(summary); }
    }

    // ---- positive: the correct forms pass -------------------------------------------------------------------------------------

    private static string Lane => MessageExpectations.Lane;

    private static string Action(string kind, string expression, string? owner = null)
    {
        var action = new JsonObject
        {
            ["name"] = "T9Show", ["kind"] = kind,
            ["vars"] = new JsonArray(
                new JsonObject { ["name"] = "T9When", ["type"] = "Date Time" }, new JsonObject { ["name"] = "T9Day", ["type"] = "Date" },
                new JsonObject { ["name"] = "T9Hour", ["type"] = "Time" }, new JsonObject { ["name"] = "T9Out", ["type"] = "Text" }),
            ["steps"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { ["T9Out"] = expression } }),
        };
        if (owner != null) action["owner"] = owner;
        return new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(action) } }.ToJsonString();
    }

    [Fact]
    public void ADisplayMaskOnTheClientAndUtcTextFormattedOnTheServerPass()
    {
        // The display mask where the time is shown: the runtime converted it once.
        var shown = Analyze(Ops(HtmlOp(ScreenStart + """<span id="StartedOnCell">{{ FormatDateTime(T9Load.StartedOn, "MM/dd/yyyy h:mm tt") }}</span>""" + ScreenEnd)));
        Assert.Empty(Problems(shown, "DATETIME_TZ_REINTERPRETED"));
        Assert.Empty(Problems(Analyze(Ops(Action("client", "FormatDateTime(T9When, \"yyyy-MM-dd HH:mm\")"))), "DATETIME_TZ_REINTERPRETED"));
        // A UTC instant formatted on the server (a server action, a Data Action, a Traditional screen action, a service action):
        // the side that has the server's time; never judged.
        foreach (var server in new[] { Action("server", "FormatDateTime(T9When, \"yyyy-MM-ddTHH:mm:ss\") + \"Z\""), Action("data", "DateTimeToText(T9When) + \" UTC\"", "IMobileScreen:T9Requests"),
                     Action("screen", "FormatDateTime(T9When, \"yyyy-MM-ddTHH:mm:ss\") + \"Z\"", "IWebScreen:T9Requests"), Action("service", "DateTimeToText(T9When) + \"Z\"") })
            Assert.Empty(Problems(Analyze(Ops(server)), "DATETIME_TZ_REINTERPRETED"));
        // A Date or a Time has no time zone: no conversion to repeat.
        Assert.Empty(Problems(Analyze(Ops(Action("client", "DateToText(T9Day) + \"Z\""))), "DATETIME_TZ_REINTERPRETED"));
        Assert.Empty(Problems(Analyze(Ops(Action("client", "TimeToText(T9Hour) + \" UTC\""))), "DATETIME_TZ_REINTERPRETED"));
        Assert.Empty(Problems(Analyze(Ops(Action("client", "#12:30:00# + \"Z\""))), "DATETIME_TZ_REINTERPRETED"));
        Assert.Empty(Problems(Analyze(Ops(Action("client", "#2026-10-22# + \"Z\""))), "DATETIME_TZ_REINTERPRETED"));
        // A "Z" that is no mark of the time: another text concatenated.
        Assert.Empty(Problems(Analyze(Ops(Action("client", "FormatDateTime(T9When, \"HH:mm\") + \"Zone A\""))), "DATETIME_TZ_REINTERPRETED"));
    }

    [Fact]
    public void AScriptThatWritesOnlyWhatItCreatesAndReadsNoUtcAttributePasses()
    {
        const string script = """
            // a comment that names document.body.classList.toggle('phone') and new Date(e.getAttribute('data-x-utc')) is no code
            var box = document.getElementById($parameters.WidgetId);
            var chart = document.createElement('div');
            chart.innerHTML = '<canvas></canvas>';
            box.appendChild(chart);
            box.classList.add('is-ready');
            var count = document.querySelectorAll('[data-list] tr').length;
            var label = document.querySelector('[data-expression]').textContent;
            new MutationObserver(function () {}).observe(box, { childList: true, subtree: true });
            $parameters.Started = new Date($parameters.StartedText);
            """;
        var result = Analyze(Ops(ScriptOps(script)));
        foreach (var code in new[] { "DATETIME_TZ_REINTERPRETED", "DOM_MUTATION_OF_RUNTIME", "JS_RUNTIME_DUPLICATE" }) Assert.Empty(Problems(result, code));
        // The checked-in client JavaScript example (a JavaScript node and a module Script of a Reactive module) passes too.
        var root = JobSources.KernelRoot()!;
        var example = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "tests", "jobs", "client-js-reactive.json")))!;
        var ops = example["ops"]!.AsArray();
        Assert.Empty(ReactiveClientRules.Check(ops, "/ops", Lane, null, false).Where(p => p["severity"]!.GetValue<string>() == "error"));
        Assert.Empty(ReactiveClientRules.Check(ops, "/ops", Lane, "CrossDevice", true).Where(p => p["severity"]!.GetValue<string>() == "error"));
    }

    // ---- negative: each wrong form is refused with its element and one fix ------------------------------------------------------

    [Fact]
    public void EachClientFormOfTheDefectIsRefusedWithItsElement()
    {
        // The logic JSON form: the pointer of the expression, the action named.
        var logic = Assert.Single(Problems(Analyze(Ops(Action("client", "FormatDateTime(T9When, \"yyyy-MM-ddTHH:mm:ss\") + \"Z\""))), "DATETIME_TZ_REINTERPRETED"));
        Assert.Equal("/ops/0/data/actions/0/steps/0/assign/T9Out", logic["pointer"]!.GetValue<string>());
        Assert.Contains("client action T9Show", logic["message"]!.GetValue<string>());
        Assert.Contains("FormatDateTime(T9When, \"<display mask>\")", logic["fix"]!.GetValue<string>());
        // A Reactive screen action, the mark before, the mark in the mask, a function that returns a Date Time, an implicit
        // conversion of a variable, a Date Time literal.
        foreach (var (kind, owner, expression) in new[] {
                     ("screen", "IMobileScreen:T9Requests", "\"UTC \" + DateTimeToText(T9When)"),
                     ("client", (string?)null, "FormatDateTime(T9When, \"yyyy-MM-ddTHH:mm:ssZ\")"),
                     ("client", null, "AddHours(T9When, 1) + \"+00:00\""),
                     ("client", null, "T9When + \"Z\""),
                     ("client", null, "#2026-10-22 21:34:00# + \".000Z\"") })
        {
            var refused = Assert.Single(Problems(Analyze(Ops(Action(kind, expression, owner))), "DATETIME_TZ_REINTERPRETED"));
            Assert.Equal("error", refused["severity"]!.GetValue<string>());
            Assert.False(string.IsNullOrWhiteSpace(refused["fix"]?.GetValue<string>()));
        }
        // An attribute named utc that holds a Date Time formatted on the client, even with no "Z".
        var attribute = Assert.Single(Problems(Analyze(Ops(HtmlOp(ScreenStart + """<span id="SeenCell" data-seen-utc="{{ FormatDateTime(T9Seen, &quot;yyyy-MM-ddTHH:mm:ss&quot;) }}">{{ T9Seen }}</span>""" + ScreenEnd))), "DATETIME_TZ_REINTERPRETED"));
        Assert.Contains("data-seen-utc", attribute["message"]!.GetValue<string>());
        Assert.Contains("SeenCell", attribute["message"]!.GetValue<string>());
        // The flow text form: a client action whose JavaScript node parses an attribute named utc that the job does not write
        // (what fills it is unknown: a warning), and one that appends "Z" to the text of a client Date Time the job writes (refused).
        var flow = new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "client action T9ParseSeen\n  Parse = javascript\n    | var e = document.getElementById($parameters.Id);\n    | $parameters.Seen = new Date(e.getAttribute('data-x-utc'));\n  end\n" } }.ToJsonString();
        var parsed = Assert.Single(Warnings(Analyze(Ops(flow)), "DATETIME_TZ_REINTERPRETED"));
        Assert.Contains("data-x-utc", parsed["message"]!.GetValue<string>());
        Assert.Contains("T9ParseSeen", parsed["message"]!.GetValue<string>());
        var appended = Analyze(Ops(HtmlOp(ScreenStart + """<span id="SeenCell" data-seen-at="{{ FormatDateTime(T9Seen, &quot;yyyy-MM-ddTHH:mm:ss&quot;) }}">x</span>""" + ScreenEnd),
            ScriptOps("var e = document.getElementById($parameters.Id); $parameters.Seen = new Date(e.getAttribute('data-seen-at') + 'Z');")));
        Assert.Contains(Problems(appended, "DATETIME_TZ_REINTERPRETED"), p => p["message"]!.GetValue<string>().Contains("data-seen-at") && p["message"]!.GetValue<string>().Contains("marks it UTC"));
        // The page form's script: the observer of the whole document.
        var page = new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "T9Page", ["html"] = "<div data-av=\"title\">x</div>",
            ["scripts"] = new JsonArray(new JsonObject { ["name"] = "Watch", ["code"] = "new MutationObserver(function(){}).observe(document.documentElement, {subtree: true, childList: true}); $parameters.Out = 1;",
                ["outputs"] = new JsonArray(new JsonObject { ["name"] = "Out", ["type"] = "Integer" }) }) } }.ToJsonString();
        Assert.Contains(Problems(Analyze(Ops(page)), "DOM_MUTATION_OF_RUNTIME"), p => p["pointer"]!.GetValue<string>() == "/ops/0/data/scripts/0/code");
        // A text written over a marker of the runtime DOM table on the element itself, and the device classes through a
        // variable that holds body.
        var marker = Analyze(Ops(ScriptOps("var b = document.body; b.classList.add('landscape'); document.querySelector('.title [data-expression]').innerHTML = '<b>x</b>';")));
        Assert.Contains(Problems(marker, "DOM_MUTATION_OF_RUNTIME"), p => p["message"]!.GetValue<string>().Contains("innerHTML"));
        Assert.Contains(Problems(marker, "JS_RUNTIME_DUPLICATE"), p => p["message"]!.GetValue<string>().Contains("landscape"));
    }

    // ---- the side the module decides ------------------------------------------------------------------------------------------------

    [Fact]
    public void WhatOnlyTheModuleTypeDecidesIsJudgedByTheModulePassAndTraditionalIsExempt()
    {
        // A screen action written as text names its owner by name only: O11 Traditional or Reactive is the module's answer.
        var ops = JsonNode.Parse(Ops(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "action T9Requests.T9Stamp\n  local Seen: Date Time\n  local Out: Text\n  assign Out = FormatDateTime(Seen, \"yyyy-MM-ddTHH:mm:ss\") + \"Z\"\n  end\n" } }.ToJsonString()))!["ops"]!.AsArray();
        var pure = ReactiveClientRules.Check(ops, "/ops", Lane, null, false);
        if (Lane == "odc")
        {
            // ODC has no Traditional: the pure pass judges it, the module pass adds nothing.
            Assert.Single(pure, p => p["code"]!.GetValue<string>() == ReactiveClientRules.DateTimeReinterpreted);
            Assert.Empty(ReactiveClientRules.Check(ops, "/ops", Lane, "Reactive", true));
            return;
        }
        Assert.Empty(pure);
        Assert.Single(ReactiveClientRules.Check(ops, "/ops", Lane, "CrossDevice", true), p => p["code"]!.GetValue<string>() == ReactiveClientRules.DateTimeReinterpreted);
        Assert.Single(ReactiveClientRules.Check(ops, "/ops", Lane, "Mobile", true), p => p["code"]!.GetValue<string>() == ReactiveClientRules.DateTimeReinterpreted);
        Assert.Empty(ReactiveClientRules.Check(ops, "/ops", Lane, "WebResponsive", true));
        Assert.Empty(ReactiveClientRules.Check(ops, "/ops", Lane, null, true));
        // Two findings in one text: one problem that says both (the base phase keeps one per code and pointer).
        var two = JsonNode.Parse(Ops(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "action T9Requests.T9Stamp\n  local Seen: Date Time\n  local Out: Text\n  assign Out = FormatDateTime(Seen, \"yyyy-MM-ddTHH:mm:ss\") + \"Z\"\n  assign Out = \"UTC \" + DateTimeToText(Seen)\n  end\n" } }.ToJsonString()))!["ops"]!.AsArray();
        var both = Assert.Single(ReactiveClientRules.Check(two, "/ops", Lane, "CrossDevice", true));
        Assert.StartsWith("2 findings here: (1) ", both["message"]!.GetValue<string>());
        // The module pass never says again what the pure pass said (a client action is the pure pass's).
        var client = JsonNode.Parse(Ops(Action("client", "DateTimeToText(T9When) + \"Z\"")))!["ops"]!.AsArray();
        Assert.Single(ReactiveClientRules.Check(client, "/ops", Lane, null, false));
        Assert.Empty(ReactiveClientRules.Check(client, "/ops", Lane, "CrossDevice", true));
    }

    // ---- the generated sweep: the temporal built-ins of the catalog x the UTC marks x the side -----------------------------------

    private static JsonArray Catalog()
    {
        var root = JobSources.KernelRoot()!;
        var path = Directory.GetFiles(Path.Combine(root, "catalog"), "functions-*.json").OrderDescending().First();
        return JsonNode.Parse(File.ReadAllText(path))!["Functions"]!.AsArray();
    }

    [Fact]
    public void TheRulesSetsAreTheCatalogsAndTheFallbackIsTheSame()
    {
        // The rule's sets come from the catalog (return and parameter types); the fallback of a host with no catalog is the same.
        var catalog = Catalog().OfType<JsonObject>().ToDictionary(f => f["Name"]!.GetValue<string>(), f => f, StringComparer.OrdinalIgnoreCase);
        var derived = ReactiveClientRules.Derive(Builtins.For(Lane) ?? Builtins.For("o11"))!;
        Assert.All(derived.ToText, n => Assert.Equal("Text", catalog[n]["ReturnType"]!.GetValue<string>()));
        Assert.All(derived.Valued, n => Assert.Equal("Date Time", catalog[n]["ReturnType"]!.GetValue<string>()));
        Assert.All(derived.NoZone, n => Assert.Contains(catalog[n]["ReturnType"]!.GetValue<string>(), new[] { "Date", "Time" }));
        foreach (var (mine, fallback) in new[] { (derived.ToText, ReactiveClientRules.Fallback.ToText), (derived.Valued, ReactiveClientRules.Fallback.Valued),
                     (derived.NoZone, ReactiveClientRules.Fallback.NoZone), (derived.FromDate, ReactiveClientRules.Fallback.FromDate), (derived.Shifts, ReactiveClientRules.Fallback.Shifts) })
            Assert.Equal(fallback.Order(), mine.Order());
    }

    // ---- regression: the checked-in jobs ------------------------------------------------------------------------------------------

    [Fact]
    public void NoCheckedInJobIsRefusedByTheRules()
    {
        var root = JobSources.KernelRoot()!;
        var tests = Path.Combine(root, "tests");
        var seen = 0; var refused = new List<string>();
        var separator = Path.DirectorySeparatorChar.ToString();
        foreach (var path in Directory.EnumerateFiles(tests, "*.json", SearchOption.AllDirectories))
        {
            if (path.Contains(separator + "bin" + separator) || path.Contains(separator + "obj" + separator)) continue;
            JsonNode? node;
            try { node = JsonNode.Parse(File.ReadAllText(path)); } catch { continue; }
            var ops = node as JsonArray ?? (node as JsonObject)?["ops"] as JsonArray;
            if (ops == null || !ops.OfType<JsonObject>().Any(o => o["op"]?.ToString() is "logic" or "html" or "set")) continue;
            seen++;
            var relative = Path.GetRelativePath(tests, path);
            var lane = relative.Contains("odc", StringComparison.OrdinalIgnoreCase) ? "odc" : "o11";
            var basis = (node as JsonObject)?["base"]?.ToString() ?? "";
            var moduleType = basis.Contains("traditional", StringComparison.OrdinalIgnoreCase) ? "WebResponsive" : basis.Contains("mobile", StringComparison.OrdinalIgnoreCase) ? "Mobile" : "CrossDevice";
            foreach (var p in ReactiveClientRules.Check(ops, "/ops", lane, null, false).Concat(ReactiveClientRules.Check(ops, "/ops", lane, moduleType, true)))
                if (p["severity"]!.GetValue<string>() == "error") refused.Add($"{relative} {p["pointer"]} [{p["code"]}] {p["message"]}");
        }
        Assert.True(seen > 500, $"only {seen} jobs read");
        Assert.True(refused.Count == 0, $"{refused.Count} problems in {seen} jobs:\n" + string.Join("\n", refused.Take(40)));
    }
}
