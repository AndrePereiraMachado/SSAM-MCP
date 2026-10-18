using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>CX17 F8: the visual check of a page (ScreenVisual.Check, a static function the edit form calls too) over the author's
/// DOM, the predicted runtime DOM and the CSS, and its warnings in one answer: one per family per job, before the other high
/// warnings, with the checked patch inside suggestion. The shapes are the families of the owner's DemoLATAM test reduced to
/// synthetic documents (no text of the owner's app).</summary>
public sealed class ScreenVisualCheckTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenVisualCheckTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "screen-visual-check");

    // ---- the static check: author DOM + predicted DOM + CSS -> findings by family ---------------------------------------------

    private static (ScreenVisual.CheckInput Input, Dictionary<string, DomNode> Author) Input(string html, Func<Dictionary<string, DomNode>, (DomNode Root, Dictionary<DomNode, DomNode> Map)> predict, params ScreenVisual.Sheet[] sheets)
    {
        var top = ScreenHtml.Parse(html).Children.First(c => !c.IsText);
        var map = new Dictionary<ScreenHtml.Node, DomNode>(ReferenceEqualityComparer.Instance);
        var author = ScreenVisual.AuthorDom(top, map);
        var nodes = new Dictionary<DomNode, ScreenHtml.Node>(ReferenceEqualityComparer.Instance);
        foreach (var (node, element) in map) nodes[element] = node;
        var byId = map.Values.Where(e => e.Attr("id") != null).ToDictionary(e => e.Attr("id")!, e => e, StringComparer.Ordinal);
        var (root, counterparts) = predict(byId);
        var prediction = new ScreenVisual.Prediction { Root = root };
        return (new ScreenVisual.CheckInput("Page", author, nodes, prediction, counterparts, sheets, "o11", html), byId);
    }

    private static DomNode El(DomNode parent, string tag, string? cls = null, string? runtime = null, params (string, string)[] attributes)
    {
        var e = parent.Add(DomNode.Element(tag));
        if (cls != null) e.SetAttr("class", cls);
        foreach (var (n, v) in attributes) e.SetAttr(n, v);
        e.Runtime = runtime;
        return e;
    }

    [Fact]
    public void ASelectorThatMissesTheRuntimeElementComesWithTheSelectorThePredictedDomMatches()
    {
        var html = "<screen name=\"Page\"><div class=\"app\"><div id=\"bar\" class=\"toolbar\"><input id=\"q\"/><select id=\"s\"/></div>"
            + "<div id=\"m\" class=\"metric\"><strong id=\"st\">{{ N }}</strong><span id=\"lb\">rides</span></div>"
            + "<label id=\"l\"><input id=\"c\" type=\"checkbox\"/> Ok</label></div></screen>";
        var css = ".app .toolbar>input{flex:1;min-width:180px}\n.app select{height:48px;border-radius:10px}\n.app .metric span{color:gray}\n.app input[type=checkbox]{width:18px;height:18px}";
        var (input, _) = Input(html, a =>
        {
            var fragment = DomNode.Fragment();
            var map = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
            var app = El(fragment, "div", "app", null, ("data-container", ""));
            var bar = El(app, "div", "toolbar", null, ("data-container", "")); map[a["bar"]] = bar;
            var span = El(bar, "span", "input-search", "IInput"); span.RuntimeSelector = "span:has(> input[data-input])";
            map[a["q"]] = El(span, "input", "form-control OSFillParent", null, ("data-input", ""), ("type", "search"));
            var box = El(bar, "div", "dropdown-container", "IDropdown", ("data-dropdown", "")); box.RuntimeSelector = "div.dropdown-container[data-dropdown]";
            var select = El(box, "select", "dropdown-display dropdown"); select.Widget = "IDropdown"; map[a["s"]] = select;
            var metric = El(app, "div", "metric", null, ("data-container", "")); map[a["m"]] = metric;
            var strong = El(metric, "strong", null, null, ("data-advancedhtml", "")); map[a["st"]] = strong;
            El(strong, "span", null, "IExpression", ("data-expression", "")).Add(DomNode.TextNode("12"));
            map[a["lb"]] = El(metric, "span", null, null, ("data-advancedhtml", ""));
            var label = El(app, "label", "OSFillParent", null, ("data-label", "")); map[a["l"]] = label;
            var wrap = El(label, "span", null, "ICheckbox");
            var check = El(wrap, "input", "checkbox", null, ("data-checkbox", ""), ("type", "checkbox")); check.Widget = "ICheckbox"; map[a["c"]] = check;
            return (fragment, map);
        }, new ScreenVisual.Sheet(css, "page"));
        var findings = ScreenVisual.Check(input);
        foreach (var f in findings) output.WriteLine($"{f.Code} {f.Kind} {f.Subject} -> {f.Right ?? "(candidates " + string.Join(" | ", f.Candidates) + ")"} append={f.Append}: {f.Why}");
        // The metric's </strong><span> is glued too (F7); every other finding is a selector.
        Assert.Single(findings, f => f.Code == ScreenVisual.TextJoined);
        findings = findings.Where(f => f.Code == ScreenVisual.SelectorMissesRuntime).ToList();
        Assert.Equal(5, findings.Count);
        // The child combinator through the input's span, and the layout item that is the span.
        var wrapper = Assert.Single(findings, f => f.Kind == "wrapper");
        Assert.Contains(":where(span:has(> input[data-input])) > input", wrapper.Right);
        var item = Assert.Single(findings, f => f.Kind == "layout-item");
        Assert.Equal(".app .toolbar>span:has(> input)", item.Right);
        Assert.Contains("flex:1", item.Append);
        // The select OutSystems UI styles with (0,2,1).
        var specificity = Assert.Single(findings, f => f.Kind == "specificity");
        Assert.Equal(".app .dropdown-container > select.dropdown-display", specificity.Right);
        // The span of the {{ }} the author never wrote.
        var spans = Assert.Single(findings, f => f.Kind == "runtime-element");
        Assert.Contains("span:not(:where(", spans.Right);
        Assert.Contains("[data-expression]", spans.Right);
        // The check box OutSystems UI draws: candidates, no patch.
        var drawn = Assert.Single(findings, f => f.Kind == "drawn-control");
        Assert.Null(drawn.Right);
        Assert.Contains(".app input[type=checkbox]::before", drawn.Candidates);
    }

    [Fact]
    public void TokensOutsideRootTextGluedAndAListAloneInAGridAreFoundAndPlainCasesAreNot()
    {
        var html = "<screen name=\"Page\"><div class=\"app\">\n<p id=\"e\"><strong id=\"v\">R$ {{ X }}</strong><span id=\"w\">estimate</span></p>\n"
            + "<p id=\"ok\"><strong>a</strong> <span>b</span></p>\n<div class=\"row\"><strong>a</strong><span>b</span></div>\n<p>{{ N }}%</p>\n<p>{{ N }}days</p>\n"
            + "<div id=\"g\" class=\"grid\"><div id=\"li\" list=\"Rows\" as=\"r\"><p>x</p></div></div>\n"
            + "<div class=\"plain\"><div list=\"Rows\"><p>x</p></div></div>\n</div></screen>";
        var css = ".app{--color-primary:#234c3e;--brand-own:#111;color:#123}\n:root{--color-secondary:#000}\n.row{display:flex}\n.grid{display:grid}";
        var (input, _) = Input(html, _ => (DomNode.Fragment(), new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance)), new ScreenVisual.Sheet(css, "page"));
        var findings = ScreenVisual.Check(input);
        foreach (var f in findings) output.WriteLine($"{f.Code} {f.Kind} {f.Subject} -> {f.Right} {string.Join(" ; ", f.Edits.Select(e => e.Find + " => " + e.Replace))}");
        var token = Assert.Single(findings, f => f.Code == ScreenVisual.ThemeTokenScoped);
        Assert.Equal(":root{--color-primary:#234c3e}", token.Append);           // only the OutSystems UI token
        var joined = findings.Where(f => f.Code == ScreenVisual.TextJoined).ToList();
        Assert.Equal(2, joined.Count);                                         // </strong><span> and }}days; not the spaced, the flex row nor %
        var inline = Assert.Single(joined, f => f.Kind == "inline");
        var edit = Assert.Single(inline.Edits);
        Assert.Contains("/strong> <span", edit.Replace);
        Assert.Contains("{{ N }} days", Assert.Single(joined, f => f.Kind == "binding").Edits.Single().Replace);
        var alone = Assert.Single(findings, f => f.Code == ScreenVisual.ListNotLayoutContainer);
        Assert.Empty(alone.Edits);      // the List has an id of its own: moving list= would leave it on a plain element, no patch
        Assert.Null(alone.Right);
    }

    [Fact]
    public void AListAloneInAGridIsMovedWhenItHasNothingButListAndAs()
    {
        var html = "<screen name=\"Page\"><div class=\"grid\"><div list=\"Rows\" as=\"r\"><p>x</p></div></div></screen>";
        var (input, _) = Input(html, _ => (DomNode.Fragment(), new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance)), new ScreenVisual.Sheet(".grid{display:grid}", "page"));
        var alone = Assert.Single(ScreenVisual.Check(input), f => f.Code == ScreenVisual.ListNotLayoutContainer);
        var (find, replace) = Assert.Single(alone.Edits);
        Assert.Equal("<div class=\"grid\"><div list=\"Rows\" as=\"r\">", find);
        Assert.Equal("<div class=\"grid\" list=\"Rows\" as=\"r\"><div>", replace);
    }

    // ---- one answer: the warnings of a job over the reactive fixture -----------------------------------------------------------

    private const string Page = "<screen name=\"VisualCheck\" roles=\"Registered\" actions=\"Go\">\n<var name=\"Rows\" type=\"Text List\"/>\n<var name=\"Q\" type=\"Text\"/>\n<var name=\"Ok\" type=\"Boolean\"/>\n<var name=\"N\" type=\"Integer\"/>\n"
        + "<style scope=\"theme\">.vc-app{--color-primary:#234c3e}\n.vc-app .vc-bar>input{flex:1}\n.vc-app .vc-metric span{color:gray}\n.vc-grid{display:grid}</style>\n"
        + "<Block name=\"LayoutBlank\"><slot name=\"Content\"><div class=\"vc-app\">\n"
        + "<div class=\"vc-bar\"><input bind=\"Q\" type=\"search\"/><button onclick=\"Go\">Go</button></div>\n"
        + "<div class=\"vc-metric\"><strong>{{ N }}</strong><span>rides</span></div>\n"
        + "<p><strong>R$ {{ N }}</strong><span>estimate</span></p>\n"
        + "<div class=\"vc-grid\"><div list=\"Rows\" as=\"r\"><p>{{ Rows.Current }}</p></div></div>\n"
        + "</div></slot></Block>\n</screen>";

    [Fact]
    public void OneApplyBringsOneWarningPerFamilyWithItsCheckedPatchBeforeTheOtherHighWarnings()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        var host = Host("one");
        var outPath = Path.Combine(Work, "one", "out.oml");
        var ops = new JsonArray(Op(Page), Logic("VisualCheck"), Op(Page.Replace("VisualCheck", "VisualCheckTwo").Replace("<style scope=\"theme\">", "<style>")), Logic("VisualCheckTwo"));
        var watch = Stopwatch.StartNew();
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, Job(ops, "one"), outPath))!.AsObject();
        output.WriteLine($"apply {watch.ElapsedMilliseconds} ms");
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        var warnings = result["highWarnings"]!.AsArray().Select(w => w!.AsObject()).ToList();
        output.WriteLine(new JsonArray(warnings.Select(w => (JsonNode)w.DeepClone()).ToArray()).ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        var visual = warnings.Where(w => w["code"]!.ToString() is ScreenVisual.SelectorMissesRuntime or ScreenVisual.ThemeTokenScoped or ScreenVisual.TextJoined or ScreenVisual.ListNotLayoutContainer).ToList();
        // One per family, all of them, before every other high warning.
        Assert.Equal(4, visual.Count);
        Assert.Equal(visual.Count, visual.Select(w => w["code"]!.ToString()).Distinct().Count());
        Assert.True(warnings.Take(visual.Count).All(w => visual.Contains(w)));
        // Both pages counted in the one warning of a family found on both.
        var joined = visual.Single(w => w["code"]!.ToString() == ScreenVisual.TextJoined);
        Assert.Equal(2, joined["suggestion"]!["roots"]!.AsObject().Count);
        foreach (var w in visual) Assert.NotEmpty(w["suggestion"]!["patch"]!.AsArray());
        var reports = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().Where(r => r["form"]?.ToString() == "document").ToList();
        foreach (var report in reports) output.WriteLine(report["root"] + ": visual " + report["visual"]?.ToJsonString());
        Assert.All(reports, r => Assert.True(r["visual"]!["checkMs"]!.GetValue<long>() < 2000));

        // The receipt of the O11 delivery keeps the examples and the patch whole (QueryInLoopRule.HighWarnings).
        var kept = QueryInLoopRule.HighWarnings(new JsonArray(visual.Select(w => (JsonNode)w.DeepClone()).ToArray()));
        output.WriteLine(kept.ToJsonString());
        Assert.Contains("\"patch\"", kept.ToJsonString());
        Assert.Contains("\"examples\"", kept.ToJsonString());

        // Every patch applied: the same job has none of these warnings.
        var patched = (JsonArray)ops.DeepClone();
        foreach (var w in visual)
            foreach (var p in w["suggestion"]!["patch"]!.AsArray().Select(p => p!.AsObject()).Where(p => p["op"] != null))
            {
                var index = p["op"]!.GetValue<int>();
                var html = patched[index]!["data"]!["html"]!.ToString();
                var find = p["find"]!.ToString();
                if (html.Contains(find, StringComparison.Ordinal)) patched[index]!["data"]!["html"] = html.Replace(find, p["replace"]!.ToString(), StringComparison.Ordinal);
            }
        var again = JsonSerializer.SerializeToNode(JobRunner.Run(Host("one-patched"), null, Job(patched, "one-patched"), Path.Combine(Work, "one-patched", "out.oml")))!.AsObject();
        Assert.True(again["accepted"]!.GetValue<bool>(), again["details"]?.ToJsonString());
        var left = (again["highWarnings"] as JsonArray ?? []).Select(w => w!["code"]!.ToString()).Where(c => c is ScreenVisual.SelectorMissesRuntime or ScreenVisual.ThemeTokenScoped or ScreenVisual.TextJoined or ScreenVisual.ListNotLayoutContainer).ToList();
        output.WriteLine("after the patches: " + (again["highWarnings"]?.ToJsonString() ?? "none"));
        Assert.Empty(left);
    }

    [Fact]
    public void FifteenRootsWithClassesWithoutRuleStillLeaveTheVisualWarningsInsideTheFirstTen()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        var ops = new JsonArray();
        for (var i = 0; i < 15; i++)
        {
            var name = "NoRule" + i;
            ops.Add(Op($"<screen name=\"{name}\" roles=\"Registered\"><Block name=\"LayoutBlank\"><slot name=\"Content\"><div class=\"zz-none-{i}\"><p><strong>a</strong><span>b</span></p></div></slot></Block></screen>"));
        }
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(Host("fifteen"), null, Job(ops, "fifteen"), Path.Combine(Work, "fifteen", "out.oml")))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        var codes = result["highWarnings"]!.AsArray().Select(w => w!["code"]!.ToString()).ToList();
        output.WriteLine(string.Join(", ", codes));
        Assert.Equal(16, codes.Count);
        Assert.Equal(ScreenVisual.TextJoined, codes[0]);
        Assert.Equal(15, codes.Count(c => c == ScreenDocument.ClassNoRule));
    }

    [Fact]
    public void TheDataAndOwnerRuleWarningsRankAboveTheVisualOnesAndTheClassWithoutRuleOnesComeLast()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        // Review 1, M2 (verify-2): a legacy QUERY_IN_LOOP of the module, 6 pages with a class without rule and one page with the
        // four visual families: the facade keeps 10, and the QUERY_IN_LOOP was the 11th.
        var legacy = JsonNode.Parse("""
            {"ops":[
             {"op":"spec","data":{"entities":[
               {"name":"QrOrder","attributes":[{"name":"Title","type":"Text","length":50}]},
               {"name":"QrLine","attributes":[{"name":"OrderId","type":"QrOrder Identifier","mandatory":true},{"name":"Qty","type":"Integer"}]}]}},
             {"op":"logic","allowQueryInLoop":{"why":"legacy module built before the rule existed"},"data":{"actions":[{"name":"QrLegacy","outputs":[{"name":"Total","type":"Long Integer"}],"steps":[
               {"get":"QrOrder","as":"GetOrders"},
               {"foreach":"GetOrders.List","do":[{"get":"QrLine","as":"GetLines","where":"QrLine.OrderId = GetOrders.List.Current.QrOrder.Id"},{"assign":{"Total":"Total + 1"}}]}]}]}}
            ]}
            """)!["ops"]!.AsArray();
        var basePath = Path.Combine(Work, "m2", "legacy.oml");
        var built = JsonSerializer.SerializeToNode(JobRunner.Run(Host("m2"), null, Job((JsonArray)legacy.DeepClone(), "m2"), basePath))!.AsObject();
        Assert.True(built["accepted"]!.GetValue<bool>(), built["details"]?.ToJsonString());
        var ops = new JsonArray();
        for (var i = 0; i < 6; i++) ops.Add(Op($"<screen name=\"NoRule{i}\" roles=\"Registered\"><Block name=\"LayoutBlank\"><slot name=\"Content\"><div class=\"zz-none-{i}\"><p>x</p></div></slot></Block></screen>"));
        ops.Add(Op(Page)); ops.Add(Logic("VisualCheck"));
        ops.Add(new JsonObject { ["op"] = "set", ["target"] = "IServerAction:QrLegacy/GetOrders", ["prop"] = "MaxRecords", ["value"] = "100" });
        var dir = Path.Combine(Work, "m2-job");
        Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(Host("m2-run"), basePath, job, Path.Combine(dir, "out.oml")))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        var codes = result["highWarnings"]!.AsArray().Select(w => w!["code"]!.ToString()).ToList();
        output.WriteLine(string.Join(", ", codes));
        var visual = new[] { ScreenVisual.SelectorMissesRuntime, ScreenVisual.ThemeTokenScoped, ScreenVisual.TextJoined, ScreenVisual.ListNotLayoutContainer };
        var loop = codes.IndexOf("QUERY_IN_LOOP");
        Assert.True(loop >= 0, "the legacy QUERY_IN_LOOP is a high warning");
        Assert.True(loop < 10, "the facade keeps the first 10: the QUERY_IN_LOOP is one of them");
        Assert.True(codes.Select((c, i) => (c, i)).Where(x => visual.Contains(x.c)).All(x => x.i > loop), "data and owner-rule warnings rank above the visual ones");
        var lastVisual = codes.FindLastIndex(c => visual.Contains(c));
        Assert.True(codes.Select((c, i) => (c, i)).Where(x => x.c == ScreenDocument.ClassNoRule).All(x => x.i > lastVisual), "a class without rule comes after the visual ones");
    }
    // ---- helpers ------------------------------------------------------------------------------------------------------------

    private static JsonObject Op(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };
    private static JsonObject Logic(string root) => new() { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("action " + root + ".Go\n  end\n") } };

    private static string Job(JsonArray ops, string name)
    {
        var dir = Path.Combine(Work, name);
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "job.json");
        File.WriteAllText(path, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = ops }.ToJsonString());
        return path;
    }

    private static ModelHost Host(string name)
    {
        var dir = Path.Combine(Work, name);
        Directory.CreateDirectory(dir);
        return new ModelHost(dir);
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
