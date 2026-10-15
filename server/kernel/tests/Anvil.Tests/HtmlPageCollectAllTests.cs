using System.Security.Cryptography;
using System.Text;
using System.Reflection;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;
namespace Anvil.Tests;

/// <summary>
/// The fixes of the html op (H1-H16 of docs/PROTOTIPO-NATIVO.md, section 5), each with the case the diagnosis cites: the real
/// html op of the FarmaVirtual jobs of 2026-10-10 (79 cc36c64b: the first refusal; 88 0f7ceafe: the duplicated keys; 105
/// cfb79d98: the delivered page) and the FarmaVirtual prototype as the browser renders it. No Studio: the ops and the problems
/// are the proof (HtmlDeltaTests and ElementWidgetMapTests prove the Verify and the theme).
/// </summary>
public sealed class HtmlPageCollectAllTests(ITestOutputHelper output)
{
    private const string Job79 = "job79-cc36c64b", Job88 = "job88-0f7ceafe", Job105 = "job105-cfb79d98";

    // ---- H1 + H2: one refusal with every problem, without a module, in less than a second --------------------------------

    [Fact] public void H1_TheJob79IsOneAnswerWithEveryProblemAndTheNineCausesWithTheirCountsInUnderASecond()
    {
        JobPreflight.Analyze(new JsonArray(JsonNode.Parse("""{"op":"html","data":{"screen":"Warm","html":"<p>x</p>"}}""")), JsonNode.Parse("{}")); // JIT and rule discovery
        // The cost of the preflight, not the load of the machine: the CPU time of this thread, the fastest of three runs over
        // fresh copies of the job (CpuBudget).
        var jobs = Enumerable.Range(0, 3).Select(_ => HtmlPageFixtures.Job(Job79)).ToList();
        var runs = CpuBudget.Measure(jobs.Select(job => (Func<JsonObject>)(() => JobPreflight.Analyze(job["ops"]!.AsArray(), job))));
        output.WriteLine($"preflight of job 79: {CpuBudget.Describe(runs)}");
        Assert.True(CpuBudget.Best(runs) < 1000, $"preflight of job 79 took {CpuBudget.Describe(runs)}");
        var result = runs[0].Result;
        var problems = result["problems"]!.AsArray().OfType<JsonObject>().ToList();
        // The only problems left are the 5 bindings without element the job carried (latent in an\html-compiler.md 2.2), all at
        // once, each with the patch that removes it; the 9 causes of the 10 refusals compile now.
        Assert.Equal(5, problems.Count);
        Assert.All(problems, p => Assert.Equal("HTML_BINDING_ORPHAN", p["code"]!.ToString()));
        Assert.Equal(new[] { "fv.466", "fv.467", "fv.468", "fv.67", "fv.68" }, problems.Select(p => p["pointer"]!.ToString()[("/ops/0/data/bindings/".Length)..]).Order(StringComparer.Ordinal));
        Assert.All(problems, p => Assert.Equal("remove", p["patch"]![0]!["op"]!.ToString()));
        Assert.All(problems, p => Assert.Equal(p["pointer"]!.ToString(), p["patch"]![0]!["path"]!.ToString()));
        // The 9 causes (table 2.2), in the same answer, each with its count.
        var warnings = result["warnings"]!.AsArray().OfType<JsonObject>().ToDictionary(w => w["code"]!.ToString(), w => w["message"]!.ToString());
        Assert.Contains("1 @import", warnings["CSS_IMPORT_HOISTED"]);
        Assert.Contains("18 elements repeat the data-av key", warnings["HTML_KEY_SHARED"]);
        Assert.Contains("61 screen actions", warnings["HTML_SCREEN_ACTION_SAME_JOB"]);
        Assert.Contains("7 elements", warnings["HTML_CLICKABLE_ELEMENT"]); Assert.Contains("div 7", warnings["HTML_CLICKABLE_ELEMENT"]);
        Assert.Contains("tabindex 7", warnings["HTML_ATTRIBUTE_EXTENDED"]); Assert.Contains("disabled is Enabled = False (1)", warnings["HTML_ATTRIBUTE_EXTENDED"]);
        Assert.Contains("22 visible bindings", warnings["HTML_VISIBLE_IF"]); Assert.Contains("tr 19", warnings["HTML_VISIBLE_IF"]); Assert.Contains("span 3", warnings["HTML_VISIBLE_IF"]);
        Assert.Contains("3 tables", warnings["HTML_TABLE_STATIC"]);
        Assert.Contains("15 labels", warnings["HTML_LABEL_CHILDREN"]); Assert.Contains("1 without text", warnings["HTML_LABEL_CHILDREN"]);
        Assert.Contains("16 buttons", warnings["HTML_CONTROL_LABELLED"]);
        Assert.Equal(9, warnings.Count(w => w.Key.StartsWith("HTML_", StringComparison.Ordinal) || w.Key == "CSS_IMPORT_HOISTED"));
    }

    [Fact] public void H1_EveryElementKeyAndStatementIsCheckedOnItsOwnAndOneProblemNeverHidesTheNext()
    {
        var data = Page("""
            <div><marquee>a</marquee></div>
            <button class="dead"><span data-av="ghost">x</span></button>
            <div onclick="go()">y</div>
            <label></label>
            """, """{"orphan":{"kind":"text","value":"1"}}""");
        data["css"] = "#x{color:red} .a{color:color-mix(in srgb, red 50%, blue)}";
        var ex = Assert.Throws<KernelRefusalException>(() => HtmlExpander.Preflight(data));
        Assert.Equal("HTML_INVALID", ex.Code);
        var codes = ex.Problems!.Select(p => p!["code"]!.ToString()).ToList();
        foreach (var code in new[] { "HTML_TAG_NOT_ALLOWED", "HTML_CONTROL_DEAD", "HTML_KEY_UNBOUND", "HTML_ATTRIBUTE_SCRIPT", "HTML_CONTENT_EMPTY", "HTML_BINDING_ORPHAN", "HTML_CSS_ID_SELECTOR", "CSS_FUNCTION_UNSUPPORTED" })
            Assert.Contains(code, codes);
        // the unbound key inside the dead button is its own problem: the refusal of the button did not hide it
        Assert.Contains(ex.Problems!, p => p!["message"]!.ToString().Contains("data-av \"ghost\""));
    }

    [Fact] public void H2_ThePreflightRunsTheWidgetPassAndChecksCallAgainstTheLogicOpsOfTheJob()
    {
        // a structural fault the former preflight (CSS, bindings, shape) never saw: it appeared only after the build
        var structural = Page("""<div data-av="t"><b>x</b></div>""", """{"t":{"kind":"text","value":"1"}}""", source: false);
        Assert.Contains("must not contain child elements", Assert.Throws<InvalidOperationException>(() => HtmlExpander.Preflight(structural)).Message);
        // call names a client action a later logic op declares: one problem, with the move of that op as the patch
        var job = new JsonObject { ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "html", ["data"] = Page("""<button data-av="go">Ir</button>""", """{"go":{"kind":"call","action":"Ir"}}""", source: false) },
            JsonNode.Parse("""{"op":"logic","data":{"actions":[{"name":"Ir","kind":"client","steps":[]}]}}"""),
            JsonNode.Parse("""{"op":"logic","data":{"actions":[{"name":"Outra","kind":"screen","owner":"IMobileScreen:Outra","steps":[]}]}}""")) };
        var result = JobPreflight.Analyze(job["ops"]!.AsArray(), job);
        var order = result["problems"]!.AsArray().OfType<JsonObject>().Single(p => p["code"]!.ToString() == "HTML_CALL_ORDER");
        Assert.Equal("/ops/0/data/bindings/go", order["pointer"]!.ToString());
        Assert.Equal("""[{"op":"move","from":"/ops/1","path":"/ops/0"}]""", order["patch"]!.ToJsonString());
        // the same call with the logic op first is resolved without a module; a screen action of another screen is refused
        var fixedJob = new JsonObject { ["ops"] = new JsonArray(job["ops"]![1]!.DeepClone(), job["ops"]![0]!.DeepClone()) };
        Assert.DoesNotContain(JobPreflight.Analyze(fixedJob["ops"]!.AsArray(), fixedJob)["problems"]!.AsArray(), p => p!["code"]!.ToString().StartsWith("HTML_", StringComparison.Ordinal));
        var other = Page("""<button data-av="go">Ir</button>""", """{"go":{"kind":"call","action":"Outra"}}""", source: false);
        var otherProblem = Assert.Throws<InvalidOperationException>(() => HtmlExpander.Preflight(other, HtmlJob.From(job["ops"]!.AsArray(), 0)));
        Assert.Equal("HTML_CALL_OTHER_SCREEN", Errors.FindCoded(otherProblem)!.Code);
    }

    [Fact] public void ACutStylesheetRefusesWithASingleCssLabelNotADoubledOne()
    {
        // the 2026-10-10 session's cut CSS: a stylesheet that starts in the middle of a statement. The parser labels its
        // errors "css: ...", and the page form must prefix "html: " once, not produce "html: css: css: ...".
        var data = Page("<div class=\"a\">x</div>", source: false);
        data["css"] = "450;";
        var (_, refusal) = HtmlExpander.Analyze(data, null);
        var problem = Errors.FindCoded(refusal!)!.Problems!.Single();
        Assert.Equal("HTML_CSS_INVALID", problem["code"]!.ToString());
        var message = problem["message"]!.ToString();
        Assert.StartsWith("html: css: ", message);
        Assert.DoesNotContain("css: css:", message);
        Assert.Contains("is not a rule", message);
    }

    [Fact] public void InlineCssCustomPropertiesRefuseWithTheCssCodeNotTheGenericOne()
    {
        var data = Page("<div style=\"--amount:20%\">x</div>", source: false);
        var (_, refusal) = HtmlExpander.Analyze(data, null);
        var problem = Assert.Single(Errors.FindCoded(refusal!)!.Problems!, p => p!["message"]!.ToString().Contains("inline CSS custom properties"))!;
        Assert.Equal("HTML_CSS_INVALID", problem["code"]!.ToString());
    }

    // ---- H3: the op refused in the preflight is not applied again ---------------------------------------------------------

    [Fact] public void H3_AnHtmlOpTheStructuralPassRefusedIsSkippedAtApply()
    {
        var refusedWhole = typeof(JobRunner).GetMethod("RefusedWhole", BindingFlags.NonPublic | BindingFlags.Static)!;
        var job = HtmlPageFixtures.Job(Job79);
        var preflight = JobPreflight.Analyze(job["ops"]!.AsArray(), job);
        var skip = (IReadOnlySet<int>?)refusedWhole.Invoke(null, [preflight]);
        Assert.NotNull(skip);
        Assert.Contains(0, skip!);
        Assert.DoesNotContain(1, skip); // the logic op the html op calls is not refused
        // a warning of the html op (what it compiled) never skips it
        var clean = HtmlPageFixtures.Job(Job79);
        foreach (var key in new[] { "fv.67", "fv.68", "fv.466", "fv.467", "fv.468" }) clean["ops"]![0]!["data"]!["bindings"]!.AsObject().Remove(key);
        Assert.Null(refusedWhole.Invoke(null, [JobPreflight.Analyze(clean["ops"]!.AsArray(), clean)]));
    }

    // ---- H4-H9, H13: through the one table --------------------------------------------------------------------------------

    [Fact] public void H4_TheFiftySevenAttributesOfThePrototypeAreCarried()
    {
        var counted = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var (key, html) in HtmlPageFixtures.Views())
        {
            var root = HtmlSource.Parse(html);
            var elements = root.Descendants().Where(n => !n.IsText);
            if (key != "catalogo" && !key.StartsWith("modal", StringComparison.Ordinal)) elements = elements.Where(n => Ancestors(root, n).Any(a => a.Tag == "main"));
            foreach (var node in elements)
                foreach (var (name, _) in node.Attributes)
                    if (!ElementWidgetMap.LegacyAttributes.Contains(name) && !name.StartsWith("aria-", StringComparison.Ordinal) && !name.StartsWith("data-", StringComparison.Ordinal))
                        counted[name] = counted.GetValueOrDefault(name) + 1;
            // the page form refuses none of them (it refuses the dead controls and unbound inputs of a page without bindings)
            var problems = Problems(PageOf(html));
            Assert.DoesNotContain(problems, p => p.Contains("attribute '", StringComparison.Ordinal) && !p.Contains("attribute 'on", StringComparison.Ordinal));
        }
        Assert.Equal(57, counted.Values.Sum());
        Assert.Equal(new Dictionary<string, int> { ["name"] = 20, ["tabindex"] = 7, ["min"] = 7, ["selected"] = 5, ["max"] = 5, ["step"] = 4, ["disabled"] = 3, ["checked"] = 3, ["minlength"] = 2, ["form"] = 1 }, counted);
        // as the page form compiles them: extended properties with their literal value, disabled the Enabled of a control
        var ops = Expand(Page("""<div class="qty"><span tabindex="0" name="q" min="1" max="9" step="1" minlength="2" form="f">x</span><button data-av="b" disabled>Ir</button></div>""",
            """{"b":{"kind":"refresh"}}""")).Ops;
        foreach (var (property, value) in new[] { ("tabindex", "0"), ("name", "q"), ("min", "1"), ("max", "9"), ("step", "1"), ("minlength", "2"), ("form", "f") })
            Assert.True(ExtendedValue(ops, property) == "\"" + value + "\"", property);
        Assert.Contains(ops, o => Sets(o, "Enabled", "False") && o["target"]!.ToString() == ops.Single(c => Is(c, "IButton"))["as"]!.ToString());
    }

    [Fact] public void H5_TheEightSwitchesOfThePrototypeAndTheSixteenOfTheJobAreButtonsNamedByTheirAriaLabel()
    {
        var gestao = HtmlPageFixtures.Views()["gestao-produtos"];
        var switches = HtmlSource.Parse(gestao).Descendants().Where(n => n.Tag == "button" && (n.Attribute("class") ?? "").Contains("switch")).ToList();
        Assert.Equal(8, switches.Count);
        Assert.All(switches, s => Assert.Equal("", s.InnerText()));
        var html = string.Concat(switches.Select((s, i) => $"<button class=\"{s.Attribute("class")}\" role=\"switch\" aria-label=\"{s.Attribute("aria-label")}\" data-av=\"sw{i}\"></button>"));
        var bindings = new JsonObject(switches.Select((_, i) => KeyValuePair.Create("sw" + i, (JsonNode?)JsonNode.Parse("""{"kind":"refresh"}"""))));
        var ops = Expand(Page(html, bindings.ToJsonString())).Ops;
        var buttons = ops.Where(o => Is(o, "IButton")).Select(o => o["as"]!.ToString()).ToList();
        Assert.Equal(8, buttons.Count);
        Assert.All(buttons, b => Assert.Contains(ops, o => o["op"]!.ToString() == "delete" && o["target"]!.ToString() == b + "/#ITextWidget"));
        Assert.Equal(8, ops.Count(o => Sets(o, "Property", "aria-label")));
        // without aria-label or title, an empty control is still refused, with the fix that names it
        var bare = Assert.Throws<InvalidOperationException>(() => Expand(Page("""<button data-av="b"></button>""", """{"b":{"kind":"refresh"}}""")));
        Assert.Equal("HTML_CONTENT_EMPTY", Errors.FindCoded(bare)!.Code);
        Assert.Contains("aria-label", Errors.FindCoded(bare)!.Problems![0]!["fix"]!.ToString());
        Assert.Equal(16, Job79Compiled().Report["rewrites"]!["labelledEmptyControls"]!.GetValue<int>());
    }

    [Fact] public void H6_TheLabelInputSearchKeepsItsIconAndItsInputAndTheFifteenLabelsOfTheJobKeepTheirControls()
    {
        var gestao = HtmlSource.Parse(HtmlPageFixtures.Views()["gestao-produtos"]);
        var label = gestao.Descendants().Single(n => n.Tag == "label" && (n.Attribute("class") ?? "") == "input-search");
        Assert.Equal(new[] { "i", "input" }, label.Elements.Select(e => e.Tag));
        var input = label.Elements.Last();
        var ops = Expand(Page($"""<label class="input-search"><i data-lucide="search" class="icon" aria-hidden="true"></i><input id="{input.Attribute("id")}" type="search" placeholder="{input.Attribute("placeholder")}" data-av="search"></label>""")).Ops;
        var wrapper = ops.Single(o => Is(o, "IAdvancedHtml") && ops.Any(s => s["target"]?.ToString() == o["as"]!.ToString() && Sets(s, "Tag", "label")))["as"]!.ToString();
        Assert.Contains(ops, o => Is(o, "IAdvancedHtml") && o["parent"]!.ToString() == wrapper + "/Content");
        Assert.Contains(ops, o => Is(o, "IInput", "Search") && o["parent"]!.ToString() == wrapper + "/Content");
        Assert.Contains(ops, o => Sets(o, "Value", "\"input-search\""));
        // job 79: the 15 labels around a span and a mount keep both; the 15 mounts inside them are containers named by id
        var compiled = Job79Compiled();
        var labels = compiled.Ops.Where(o => Is(o, "IAdvancedHtml") && compiled.Ops.Any(s => s["target"]?.ToString() == o["as"]!.ToString() && Sets(s, "Tag", "label"))).Select(o => o["as"]!.ToString()).ToList();
        Assert.Equal(15, labels.Count);
        Assert.All(labels, l => Assert.Contains(compiled.Ops, o => Is(o, "IContainer") && o["parent"]!.ToString() == l + "/Content" && o["name"]?.ToString().StartsWith("Fv") == true));
        Assert.DoesNotContain(compiled.Ops, o => Is(o, "ILabel"));
    }

    [Fact] public void H7_TheThreeSpansAndNineteenRowsBoundVisibleAreNativeIfsAroundTheElement()
    {
        var compiled = Job79Compiled();
        var ops = compiled.Ops;
        var ifs = ops.Where(o => Is(o, "IIfWidget")).ToDictionary(o => o["as"]!.ToString(), o => o);
        var wrapped = ops.Where(o => Is(o, "IAdvancedHtml") && o["parent"]!.ToString().EndsWith("/TrueBranch") && ifs.ContainsKey(o["parent"]!.ToString()[..^"/TrueBranch".Length]))
            .Select(o => ops.Single(s => s["target"]?.ToString() == o["as"]!.ToString() && s["prop"]?.ToString() == "Tag")["value"]!.ToString()).ToList();
        Assert.Equal(19, wrapped.Count(t => t == "tr"));
        Assert.Equal(3, wrapped.Count(t => t == "span"));
        Assert.DoesNotContain(ops, o => o["prop"]?.ToString() == "Visible");
        Assert.Equal(19, compiled.Report["rewrites"]!["visibleWrapped"]!["tr"]!.GetValue<int>());
        // the If takes the name of the element's key, and a hidden attribute stays with the binding
        var page = Expand(Page("""<p>a</p><span class="badge" hidden data-av="b">x</span>""", """{"b":{"kind":"visible","condition":"Show"}}""", source: false, vars: """[{"name":"Show","type":"Boolean"}]""")).Ops;
        var branch = page.Single(o => Is(o, "IIfWidget", "IfB"))["as"]!.ToString();
        Assert.Contains(page, o => Is(o, "IAdvancedHtml", "B") && o["parent"]!.ToString() == branch + "/TrueBranch");
        Assert.DoesNotContain(page, o => Sets(o, "Property", "hidden"));
    }

    [Fact] public void H8_TheSevenClickableDivsKeepTheirTagWithAnOnclickEvent()
    {
        var ops = Job79Compiled().Ops;
        var divs = ops.Where(o => Is(o, "IAdvancedHtml") && ops.Any(s => s["target"]?.ToString() == o["as"]!.ToString() && Sets(s, "Tag", "div"))).Select(o => o["as"]!.ToString()).ToList();
        Assert.Equal(7, divs.Count);
        foreach (var div in divs)
        {
            var ev = ops.Single(o => Is(o, "IEvent") && o["parent"]!.ToString() == div)["as"]!.ToString();
            Assert.Contains(ops, o => Sets(o, "Event", "onclick") && o["target"]!.ToString() == ev);
            var handler = ops.Single(o => o["target"]?.ToString() == ev && o["prop"]?.ToString() == "Handler")["value"]!.ToString();
            Assert.Contains(ops, o => Is(o, "IScreenAction") && o["as"]!.ToString() == handler);
            Assert.Contains(ops, o => o["target"]?.ToString() == ev + "/Id"); // AbrirProduto(Id)
            Assert.Contains(ops, o => Sets(o, "Property", "role") && ops.Single(c => c["as"]?.ToString() == o["target"]!.ToString())["parent"]!.ToString() == div);
        }
        Assert.DoesNotContain(ops, o => Is(o, "IButton") && ops.Any(s => s["target"]?.ToString() == o["as"]!.ToString() && Sets(s, "Style", "\"product-image-wrap\"")));
    }

    [Fact] public void H9_TheThreeStaticTablesAreHtmlElementsOfTheirTags()
    {
        var compiled = Job79Compiled();
        var tags = compiled.Ops.Where(o => o["prop"]?.ToString() == "Tag").Select(o => o["value"]!.ToString()).ToList();
        Assert.Equal(3, tags.Count(t => t == "table")); Assert.Equal(3, tags.Count(t => t == "thead")); Assert.Equal(3, tags.Count(t => t == "tbody"));
        Assert.Equal(22, tags.Count(t => t == "tr")); Assert.Equal(20, tags.Count(t => t == "th")); Assert.Equal(127, tags.Count(t => t == "td"));
        Assert.DoesNotContain(compiled.Ops, o => Is(o, "ITableRecords"));
        Assert.Equal(3, compiled.Report["rewrites"]!["staticTables"]!.GetValue<int>());
        // the rows of the prototype: 3 tables and 19 rows outside thead
        var rows = HtmlPageFixtures.Views().Values.SelectMany(v => HtmlSource.Parse(v).Descendants()).Count(n => n.Tag == "tr");
        Assert.True(rows >= 19);
    }

    [Fact] public void H10_TheSixtyOneScreenActionsTheJobDeclaresAfterThePageAreCreatedFirstAndCalledDirectly()
    {
        var compiled = Job79Compiled();
        var ops = compiled.Ops;
        var shells = compiled.Report["sameJobScreenActions"]!.AsArray().Select(s => s!.ToString()).ToList();
        Assert.Equal(61, shells.Count);
        Assert.Contains("Pagina_catalogo", shells); Assert.Contains("AbrirProduto", shells);
        // born before the content, with their inputs, and called without a handler wrapper
        var firstWidget = ops.FindIndex(o => Is(o, "IContainer", "Page"));
        foreach (var name in shells) Assert.True(ops.FindIndex(o => Is(o, "IScreenAction", name)) < firstWidget, name);
        var abrir = ops.Single(o => Is(o, "IScreenAction", "AbrirProduto"))["as"]!.ToString();
        Assert.Contains(ops, o => Is(o, "IInputParameter", "Id") && o["parent"]!.ToString() == abrir);
        Assert.DoesNotContain(ops, o => Is(o, "IExecuteClientActionNode") || Is(o, "IExecuteServerActionNode"));
        var catalogo = ops.Single(o => Is(o, "IScreenAction", "Pagina_catalogo"))["as"]!.ToString();
        Assert.Contains(ops, o => o["target"]?.ToString().EndsWith("/OnClick") == true && Sets(o, "Destination", catalogo));
    }

    [Fact] public void H11_AListRepeatsOverAListVariableOfThePage()
    {
        var data = Page("""<ul data-av="l"><li data-av="f">x</li></ul>""", """{"l":{"kind":"list","source":{"variable":"Opcoes"}},"f":{"kind":"field","field":"Label"}}""", source: false, vars: """[{"name":"Opcoes","type":"FvOption List"}]""");
        var ops = Expand(data).Ops;
        Assert.Contains(ops, o => Is(o, "IList", "L")); Assert.Contains(ops, o => Sets(o, "Source", "Opcoes"));
        Assert.Contains(ops, o => Sets(o, "Value", "Opcoes.Current.Label"));
        var undeclared = Page("""<ul data-av="l"><li>x</li></ul>""", """{"l":{"kind":"list","source":{"variable":"Nada"}}}""", source: false);
        Assert.Contains("is not declared in vars", Assert.Throws<InvalidOperationException>(() => Expand(undeclared)).Message);
        var scalar = Page("""<ul data-av="l"><li>x</li></ul>""", """{"l":{"kind":"list","source":{"variable":"Texto"}}}""", source: false, vars: """[{"name":"Texto","type":"Text"}]""");
        Assert.Contains("not a List", Assert.Throws<InvalidOperationException>(() => Expand(scalar)).Message);
    }

    [Fact] public void H12_TheEighteenRepeatedKeysOfJob88AreTheSameBindingOnEachElement()
    {
        var ops = HtmlPageFixtures.Ops(Job88);
        var (index, data) = HtmlPageFixtures.Html(ops);
        var (report, refusal) = HtmlExpander.Analyze(data, HtmlJob.From(ops, index));
        Assert.Equal(18, report["rewrites"]!["sharedKeys"]!.GetValue<int>());
        Assert.Equal(18, report["rewrites"]!["sharedKeyCount"]!.GetValue<int>());
        Assert.DoesNotContain("used twice", refusal?.Message ?? "");
        // job 88 carries the 5 orphan bindings of job 79 too: the refusal names them alone, and their patch compiles the page
        Assert.Equal(5, Errors.FindCoded(refusal!)!.Problems!.Count);
        foreach (var key in new[] { "fv.67", "fv.68", "fv.466", "fv.467", "fv.468" }) ops[index]!["data"]!["bindings"]!.AsObject().Remove(key);
        var compiled = Compile(ops);
        Assert.Contains(compiled.Ops, o => Is(o, "IAdvancedHtml", "Fv284"));
        Assert.Contains(compiled.Ops, o => Is(o, "IAdvancedHtml", "Fv284_2"));
        // the same binding on each: the class expression of key fv.284 is set on both
        var first = compiled.Ops.Single(o => Is(o, "IAdvancedHtml", "Fv284"))["as"]!.ToString();
        var second = compiled.Ops.Single(o => Is(o, "IAdvancedHtml", "Fv284_2"))["as"]!.ToString();
        string ClassOf(string alias) => compiled.Ops.Where(o => o["parent"]?.ToString() == alias && Is(o, "IExtendedProperty")).Select(o => o["as"]!.ToString())
            .Select(ep => compiled.Ops.Single(s => s["target"]?.ToString() == ep && s["prop"]?.ToString() == "Value")["value"]!.ToString()).First();
        Assert.Equal(ClassOf(first), ClassOf(second));
    }

    [Fact] public void H13_TheTwentySevenMountContainersAreNamedByTheirIdAndTheSkipNoteReadsTheCreatedNames()
    {
        var ops = Job79Compiled().Ops;
        var mounts = ops.Where(o => Is(o, "IContainer") && o["name"]?.ToString() is { } n && n.StartsWith("Fv") && !n.StartsWith("Fv0") && char.IsUpper(n[2])).Select(o => o["name"]!.ToString()).ToList();
        Assert.Equal(27, mounts.Count);
        Assert.Contains("FvAvailable", mounts); Assert.Contains("FvDeliveryName", mounts); Assert.Contains("FvNewStatus", mounts);
        Assert.Contains(ops, o => Is(o, "IContainer", "header_search"));
        // the skip heuristic of the apply: what the page op creates, not every word of its JSON (ModelSession needs the Model API)
        try { StudioAssemblies.Bind(null); } catch { return; }
        var blockedType = typeof(ModelSession).GetNestedType("Blocked", BindingFlags.NonPublic)!;
        var blocked = Activator.CreateInstance(blockedType, nonPublic: true)!;
        blockedType.GetMethod("Mark")!.Invoke(blocked, [HtmlPageFixtures.Ops(Job79)[0]!.AsObject(), 202]);
        int? Mentioned(string name) => (int?)blockedType.GetMethod("Mentioned")!.Invoke(blocked, [name]);
        Assert.Equal(202, Mentioned("FvAvailable"));
        Assert.Equal(202, Mentioned("FarmaVirtual"));
        Assert.Null(Mentioned("Pagina_catalogo")); // a word of the bindings (the action it calls), not a name the page creates
    }

    // ---- H14: @import hoisted in both forms --------------------------------------------------------------------------------

    [Fact] public void H14_TheImportOfTheFarmaVirtualStylesheetLeadsTheScopedCssInBothForms()
    {
        var styles = HtmlPageFixtures.Styles();
        var page = Expand(Page("<div class=\"a\">x</div>", source: false, css: styles));
        Assert.StartsWith("@import url('https://fonts.googleapis.com/css2?family=DM+Sans", page.ScopedCss);
        Assert.Single(page.Report["stylesheet"]!["cssImportsHoisted"]!.AsArray());
        Assert.Equal(1, page.ScopedCss!.Split("@import").Length - 1);
        var fragment = HtmlVisual.Expand("<style>" + styles + "</style><div class=\"app\"><span>x</span></div>", "$screen",
            new HtmlVisualScope([], HtmlVisualScope.Map(), HtmlVisualScope.Map(), HtmlVisualScope.Map(), _ => null));
        Assert.StartsWith("@import url('https://fonts.googleapis.com/css2?family=DM+Sans", fragment.ScopedCss);
        Assert.Single(fragment.Report["css"]!["cssImportsHoisted"]!.AsArray());
        // job 79's css (the @import on the first line of 27,632 characters): every rule stays
        var compiled = Job79Compiled();
        Assert.StartsWith("@import url('https://fonts.googleapis.com/", compiled.ScopedCss);
        Assert.Contains("--green:", compiled.ScopedCss!.Replace(" ", ""));
    }

    // ---- H15, H16: per-code fix and patch; the published contract ----------------------------------------------------------

    [Fact] public void H15_EachCodeOfThePageHasItsOwnFixAndNoneSendsThePageToTheFragmentForm()
    {
        Assert.DoesNotContain("html-visual", JobPreflight.DefaultFix("html"));
        Assert.Contains("api --op html", JobPreflight.DefaultFix("html"));
        var data = Page("""<div onclick="x()">a</div><button>b</button>""", """{"orphan":{"kind":"text","value":"1"}}""", source: false);
        var ex = Assert.Throws<KernelRefusalException>(() => HtmlExpander.Preflight(data));
        var fixes = ex.Problems!.ToDictionary(p => p!["code"]!.ToString(), p => p!["fix"]!.ToString());
        Assert.Contains("data-av", fixes["HTML_ATTRIBUTE_SCRIPT"]);
        Assert.Contains("navigate, call, refresh or page", fixes["HTML_CONTROL_DEAD"]);
        Assert.Contains("remove the binding", fixes["HTML_BINDING_ORPHAN"]);
        Assert.All(fixes.Values, f => Assert.DoesNotContain("html-visual", f));
        Assert.Equal("""[{"op":"remove","path":"/bindings/orphan"}]""", ex.Problems!.Single(p => p!["code"]!.ToString() == "HTML_BINDING_ORPHAN")!["patch"]!.ToJsonString());
        // a fragment problem without a fix of its own points at the fragment syntax
        var fragment = new JsonObject { ["ops"] = new JsonArray(JsonNode.Parse("""{"op":"html","parent":"$s","html":"<div><p>x"}""")) };
        var fragmentProblem = JobPreflight.Analyze(fragment["ops"]!.AsArray(), fragment)["problems"]![0]!;
        Assert.Contains("html-visual", fragmentProblem["fix"]!.ToString());
    }

    [Fact] public void H16_TheSchemaPublishesTheRulesAndThePlatformTags()
    {
        var schema = HtmlExpander.Schema();
        Assert.Equal(103, schema["platformTags"]!["o11"]!.AsArray().Count);
        Assert.Equal(100, schema["platformTags"]!["odc"]!.AsArray().Count);
        foreach (var key in new[] { "kindTags", "extendedAttributes", "names", "call", "css", "unsupported" }) Assert.NotNull(schema[key]);
        Assert.Contains("any element", schema["kindTags"]!["visible"]!.ToString());
        Assert.Contains("onclick", schema["kindTags"]!["navigate|call|refresh|page"]!.ToString());
        Assert.Contains("tabindex", schema["extendedAttributes"]!.ToString());
        Assert.Contains("id", schema["names"]!.ToString());
        Assert.Contains("@import", schema["css"]!.ToString());
        Assert.Contains("screen action of this screen", schema["call"]!.ToString());
        Assert.Contains("table", schema["tags"]!.AsArray().Select(t => t!.ToString()));
    }

    [Fact] public void TheSubmitRuleOfTheOneTableHoldsInBothForms()
    {
        // never type=submit: the default button, with ssam-submit (the CSS of [type=submit] is rewritten to reach it)
        var page = Expand(Page("""<button type="submit" class="primary" data-av="send">Enviar</button>""", """{"send":{"kind":"refresh"}}""")).Ops;
        var button = page.Single(o => Is(o, "IButton"))["as"]!.ToString();
        Assert.Contains(page, o => o["target"]?.ToString() == button && Sets(o, "IsDefault", "true"));
        Assert.Contains(page, o => o["target"]?.ToString() == button && Sets(o, "Style", "\"primary ssam-submit\""));
        Assert.DoesNotContain(page, o => Sets(o, "Property", "type"));
        var plain = Expand(Page("""<button type="button" data-av="send">Enviar</button>""", """{"send":{"kind":"refresh"}}""")).Ops;
        Assert.DoesNotContain(plain, o => o["prop"]?.ToString() == "IsDefault");
        var fragment = HtmlVisual.Expand("""<form class="f"><button type="submit" onclick="Go">Enviar</button></form>""", "$screen",
            new HtmlVisualScope([], new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Go"] = "@go" }, HtmlVisualScope.Map(), HtmlVisualScope.Map(), _ => null)).Ops;
        Assert.Contains(fragment, o => Is(o, "IForm"));
        var fb = fragment.Single(o => Is(o, "IButton"))["as"]!.ToString();
        Assert.Contains(fragment, o => o["target"]?.ToString() == fb && Sets(o, "IsDefault", "true"));
        Assert.Contains(fragment, o => o["target"]?.ToString() == fb && Sets(o, "Style", "\"ssam-submit\""));
    }

    // ---- job 105: the delivered page compiles to the same ops ---------------------------------------------------------------

    [Fact] public void TheDeliveredJob105CompilesToTheSameOpsExceptTheThreeElementsItsIdsNowName()
    {
        var compiled = Compile(Job105);
        Assert.Equal(10478, compiled.Ops.Count);
        // H13: the elements without data-av take their id (the only difference from the compiler of cd7e4f11)
        var named = compiled.Ops.Where(o => o["name"]?.ToString() is "header_search" or "cart_count" or "main_content").ToList();
        Assert.Equal(3, named.Count);
        var normalized = compiled.Ops.Select(o => o.DeepClone().AsObject()).ToList();
        foreach (var op in normalized.Where(o => o["name"]?.ToString() is "header_search" or "cart_count" or "main_content")) op["name"] = null;
        // the sha256 of the dump the compiler of aff07abf (= cd7e4f11 for this file) wrote for the same op
        Assert.Equal("50c7cd44899fd553f97d168c1179a6d5dcd46c94a9b9058ac3543c6d54277ee0", HtmlPageFixtures.Sha(HtmlPageFixtures.Dump(normalized)));
    }

    // ---- fixtures ----------------------------------------------------------------------------------------------------------

    private static HtmlCompilation? job79;
    /// <summary>Job 79 compiled with the module simulated from the job, the 5 orphan bindings removed (the patch of its refusal).</summary>
    private static HtmlCompilation Job79Compiled()
    {
        if (job79 != null) return job79;
        var ops = HtmlPageFixtures.Ops(Job79);
        foreach (var key in new[] { "fv.67", "fv.68", "fv.466", "fv.467", "fv.468" }) ops[0]!["data"]!["bindings"]!.AsObject().Remove(key);
        return job79 = Compile(ops);
    }
    private static HtmlCompilation Compile(string fixture) => Compile(HtmlPageFixtures.Ops(fixture));
    private static HtmlCompilation Compile(JsonArray ops)
    {
        var (index, data) = HtmlPageFixtures.Html(ops);
        var (tryRef, contract) = HtmlPageFixtures.Module(ops);
        return HtmlExpander.Expand(data.DeepClone().AsObject(), tryRef, contract, "Reactive", null, HtmlJob.From(ops, index));
    }

    private static IEnumerable<HtmlNode> Ancestors(HtmlNode root, HtmlNode node)
    {
        var path = new List<HtmlNode>();
        bool Find(HtmlNode at) { if (ReferenceEquals(at, node)) return true; foreach (var c in at.Children) { if (Find(c)) { path.Add(at); return true; } } return false; }
        Find(root);
        return path;
    }

    private static JsonObject PageOf(string body) => new() { ["screen"] = "Prototipo", ["html"] = body };
    private static List<string> Problems(JsonObject data)
    {
        var (_, refusal) = HtmlExpander.Analyze(data, null);
        return refusal == null ? [] : Errors.FindCoded(refusal)!.Problems!.Select(p => p!["message"]!.ToString()).ToList();
    }

    private static readonly string[] Known = ["IMobileFlow:MainFlow", "IMobileBlock:LayoutBlank", "IMobileBlock:LayoutTopMenu", "IServerEntity:Incident"];
    private static ScreenContract Contract(string reference)
    {
        var name = reference.Split(':')[1];
        string[] placeholders = name switch { "LayoutTopMenu" => ["Title", "MainContent"], "LayoutBlank" => ["Content"], _ => [] };
        UiParam[] fields = [new("Id", "Incident Identifier", false, null, null), new("Title", "Text", false, null, null)];
        return new(reference, [], [], fields, [], placeholders.Select(p => new UiPlaceholder(p, null, p, [])).ToArray(), new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>());
    }
    private static HtmlCompilation Expand(JsonObject data) => HtmlExpander.Expand(data, refs => refs.FirstOrDefault(Known.Contains), Contract, "Reactive");
    private static JsonObject Page(string body, string? bindings = null, bool source = true, string? vars = null, string? css = null)
    {
        var data = JsonNode.Parse("""{"screen":"Prototipo","title":"Protótipo","layout":"blank","html":""}""")!.AsObject();
        data["html"] = body;
        if (source) data["source"] = JsonNode.Parse("""{"entity":"Incident","as":"GetIncidents","max":20}""");
        if (body.Contains("data-av=\"search\"")) data["search"] = JsonNode.Parse("""{"key":"search","field":"Title"}""");
        if (bindings != null) data["bindings"] = JsonNode.Parse(bindings);
        if (vars != null) data["vars"] = JsonNode.Parse(vars);
        if (css != null) data["css"] = css;
        return data;
    }
    private static string? ExtendedValue(List<JsonObject> ops, string property)
    {
        var ep = ops.FirstOrDefault(o => Sets(o, "Property", property))?["target"]?.ToString();
        return ep == null ? null : ops.First(o => o["target"]?.ToString() == ep && o["prop"]?.ToString() == "Value")["value"]!.ToString();
    }
    private static bool Is(JsonObject o, string type, string? name = null) => o["type"]?.ToString() == type && (name == null || o["name"]?.ToString() == name);
    private static bool Sets(JsonObject o, string prop, string value) => o["op"]?.ToString() == "set" && o["prop"]?.ToString() == prop && o["value"]?.ToString() == value;
}

/// <summary>The html op data of the real jobs of 2026-10-10 (FarmaVirtual into Haiku_UI: calls 79, 88 and 105) and the
/// FarmaVirtual prototype rendered by the UI-Mockup session (views.json: the 6 views and 5 modals as the browser builds them,
/// 922 elements without repeating the shell), with a module simulated from the job itself: the layouts, and the actions the
/// logic ops of the job declare (the harness of an\html-compiler.md, section 1).</summary>
internal static class HtmlPageFixtures
{
    public static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(HtmlPageFixtures).Assembly.Location)!)!;
    public static string Folder => Path.Combine(Root, "tests", "Anvil.Tests", "Fixtures", "html-page");

    /// <summary>The ops of a fixture job: html (and logic) in their original relative order.</summary>
    public static JsonArray Ops(string name) => JsonNode.Parse(File.ReadAllText(Path.Combine(Folder, name + ".json")))!["ops"]!.AsArray();

    public static JsonObject Job(string name) => new() { ["ops"] = Ops(name).DeepClone() };

    public static (int Index, JsonObject Data) Html(JsonArray ops)
    {
        for (var i = 0; i < ops.Count; i++) if (ops[i]?["op"]?.ToString() == "html") return (i, ops[i]!["data"]!.AsObject());
        throw new InvalidOperationException("no html op");
    }

    /// <summary>The rendered prototype: view or modal key -> its HTML.</summary>
    public static IReadOnlyDictionary<string, string> Views()
        => JsonNode.Parse(File.ReadAllText(Path.Combine(Folder, "farmavirtual", "views.json")))!.AsObject().ToDictionary(p => p.Key, p => p.Value!.ToString());

    public static string Styles() => File.ReadAllText(Path.Combine(Folder, "farmavirtual", "styles.css"));

    private static UiParam Param(string name, string type, bool required = false) => new(name, type, required, null, null);

    /// <summary>The module the job runs against: MainFlow, the OutSystems UI layouts and the module actions the logic ops of
    /// the job declare (client, server, service), with their inputs.</summary>
    public static (Func<string[], string?> TryRef, Func<string, ScreenContract?> Contract) Module(JsonArray ops)
    {
        var known = new HashSet<string>(StringComparer.Ordinal) { "IMobileFlow:MainFlow", "IMobileBlock:LayoutBlank", "IMobileBlock:LayoutTopMenu", "IMobileBlock:Layout" };
        var inputs = new Dictionary<string, UiParam[]>(StringComparer.Ordinal);
        foreach (var op in ops.OfType<JsonObject>().Where(o => o["op"]?.ToString() == "logic"))
            foreach (var action in op["data"]?["actions"]?.AsArray().OfType<JsonObject>() ?? [])
            {
                var kind = action["kind"]?.ToString() ?? "server";
                if (kind == "screen") continue; // a screen action is not a module action
                var type = kind switch { "client" => "IClientAction", "service" => "IServiceAction", _ => "IServerAction" };
                var reference = type + ":" + action["name"];
                known.Add(reference);
                inputs[reference] = (action["inputs"]?.AsArray().OfType<JsonObject>() ?? []).Select(i => Param(i["name"]!.ToString(), i["type"]?.ToString() ?? "Text", i["mandatory"]?.GetValue<bool>() ?? false)).ToArray();
            }
        string? TryRef(string[] references) => references.FirstOrDefault(known.Contains);
        ScreenContract? Contract(string reference)
        {
            var name = reference.Split(':')[1];
            string[] placeholders = name switch { "LayoutTopMenu" => ["Title", "MainContent"], "LayoutBlank" => ["Content"], "Layout" => ["Title", "Content"], _ => [] };
            return new(reference, inputs.GetValueOrDefault(reference) ?? [], [], [], [], placeholders.Select(p => new UiPlaceholder(p, null, p, [])).ToArray(),
                new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>());
        }
        return (TryRef, Contract);
    }

    public static string Dump(IEnumerable<JsonObject> ops) => string.Join("\n", ops.Select(o => o.ToJsonString()));
    public static string Sha(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
}
