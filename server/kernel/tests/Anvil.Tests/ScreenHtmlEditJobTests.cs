using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>C2 of the plan "Texto do SSAM" on the O11 lane: the html op in its edit form inside a job (the same apply a delivery
/// runs), the battery of synthetic edits over the fixtures and over the plan's corpus, an edit of an older reading rebased by
/// key, and the two correction requests of the 2026-10-10 transcript (plan 4.5) repeated as C. Needs the Service Studio; the
/// corpus and the transcript's captures are read by absolute path and skipped with a warning when absent.</summary>
public class ScreenHtmlEditJobTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenHtmlEditJobTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "screen-html-edit");
    private static string Fixture(string name) => Path.Combine(Root, "tests", "fixtures", name);

    [Fact]
    public void CssAlongsideAKeyedEditSurvivesTheNativeJobAndReadback()
    {
        var host = Host("css-with-edit");
        var source = Fixture("reactive-ui.oml");
        var (reading, html, sha) = Read(host, source, "Login");
        var element = Element(ScreenHtml.Parse(html), "w8");
        Attribute(element, "class", "login-logo audit-css");
        var job = Job(sha, reading, "Login", [ScreenHtmlText.Write(element)]);
        const string css = ".audit-css { color: var(--audit-color, #123456); }";
        job["ops"]![0]!["data"]!["css"] = css;
        var result = Run(host, source, job, "css-readback");
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var (_, after, _) = Read(host, Path.Combine(host.WorkDirectory, "css-readback.oml"), "Login");
        Assert.Contains(css, after);
        Assert.Contains("login-logo audit-css", after);
        var candidate = Path.Combine(host.WorkDirectory, "css-readback.oml");
        var lost = MergeContentProof.Check(host, candidate, source);
        Assert.False(lost["accepted"]!.GetValue<bool>());
        Assert.Contains(lost["differences"]!.AsArray(), difference => difference!["property"]!.ToString() == "StyleSheet");
        Assert.True(MergeContentProof.Check(host, candidate, candidate)["accepted"]!.GetValue<bool>());
    }

    [Fact]
    public void EverySyntheticEditOfTheReactiveAndMobileFixturesReadsBack()
    {
        if (!StudioAvailable()) return;
        var host = Host("fixtures");
        ScreenHtmlEditCorpus.Fixture(Fixture("reactive-ui.oml"), 40, bytes => host.HtmlEditBattery(bytes, seed: 1, perKind: 2), output);
        ScreenHtmlEditCorpus.Fixture(Fixture("mobile-ui.oml"), 30, bytes => host.HtmlEditBattery(bytes, seed: 2, perKind: 2), output);
    }

    // Review of 3ab12209, finding 7: the battery skipped every WebScreen and WebBlock, so the Traditional edits were proven on
    // no root of the Traditional fixture (0 roots, 0 edits). Its screens and blocks are in the battery now: each edit reads back.
    [Fact]
    public void EverySyntheticEditOfTheTraditionalFixtureReadsBack()
    {
        if (!StudioAvailable()) return;
        var host = Host("traditional-fixture");
        var report = ScreenHtmlEditCorpus.Fixture(Fixture("traditional-ui.oml"), 1, bytes => host.HtmlEditBattery(bytes, seed: 4, perKind: 2), output);
        var rows = report["rows"]!.AsArray().Select(r => r!.AsObject()).ToList();
        var traditional = rows.Where(r => r["rootKind"]!.GetValue<string>() is "WebScreen" or "WebBlock").ToList();
        output.WriteLine("Traditional roots " + traditional.Select(r => r["root"]!.GetValue<string>()).Distinct().Count() + ", edits " + traditional.Count
            + ": " + string.Join(", ", traditional.GroupBy(r => r["kind"]!.GetValue<string>()).Select(g => g.Key + " " + g.Count())));
        Assert.True(traditional.Select(r => r["root"]!.GetValue<string>()).Distinct().Count() > 0, "no Traditional root in the battery");
        Assert.True(traditional.Count > 0, "no edit of a Traditional root");
        Assert.All(traditional, r => Assert.Equal("ok", r["outcome"]!.GetValue<string>()));
    }

    [CorpusFact(CorpusFactAttribute.Screens, "o11")]
    public void EverySyntheticEditOfTheO11CorpusReadsBack()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the C2 battery is skipped."); return; }
        var host = Host("corpus");
        var c2 = JsonNode.Parse(File.ReadAllText(ScreenHtmlCoverage.Manifest(Root)))!["c2"]!;
        ScreenHtmlEditCorpus.Check(ScreenHtmlCoverage.Manifest(Root), "o11",
            bytes => host.HtmlEditBattery(bytes, c2["seed"]!.GetValue<int>(), c2["perKind"]!.GetValue<int>()), output);
    }

    [Fact]
    public void AnEditOpInAJobWritesOnlyWhatChangedWrapsInAnIfAndRefusesANewVisibleWithItsPatch()
    {
        if (!StudioAvailable()) return;
        var host = Host("job");
        var basePath = Fixture("reactive-ui.oml");
        var (reading, html, sha) = Read(host, basePath, "Login");
        var tree = ScreenHtml.Parse(html);
        // A class, a new paragraph before the inputs, the remember checkbox and its label wrapped in an If, a link to another action.
        var form = Element(tree, "w7");
        Attribute(Element(tree, "w8"), "class", "login-logo compact");
        var inputs = Element(tree, "w13");
        var hint = ScreenHtml.Parse("<p class=\"login-hint\">{{ \"Use your company account\" }}</p>").Children[0];
        var formChildren = form.Children; formChildren.Insert(formChildren.IndexOf(inputs), hint);
        var slot = Element(tree, "w24").Children.First(c => c.Tag == "slot");
        var wrap = new ScreenHtml.Node { Tag = "div" }; wrap.Attributes.Add(new("if", "not IsExecuting"));
        foreach (var k in new[] { "w25", "w26" }) { var element = Element(tree, k); slot.Children.Remove(element); wrap.Children.Add(element); }
        slot.Children.Add(wrap);
        Attribute(Element(tree, "w28"), "onclick", "OnInitialize");
        var job = Job(sha, reading, "Login", [ScreenHtmlText.Write(form)]);
        var result = Run(host, basePath, job, "edit-login");
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var answer = Answer(result);
        Assert.True(answer["applied"]!.GetValue<bool>());
        var counts = answer["counts"]!.AsObject();
        Assert.Equal(2, counts["move"]!.GetValue<int>());
        Assert.False(counts.ContainsKey("delete") && counts["delete"]!.GetValue<int>() > 1, answer.ToJsonString());
        Assert.Equal(2, answer["keyChanged"]!.AsArray().Count);
        // Read back: the edited text, the keys of everything else unchanged.
        var (_, after, _) = Read(host, Path.Combine(Work, "job", "edit-login.oml"), "Login");
        Assert.Contains("class=\"login-logo compact\"", after);
        Assert.Contains("<p k=\"w13\" class=\"login-hint\">{{ \"Use your company account\" }}</p>", after);
        Assert.Contains("if=\"not IsExecuting\"", after);
        Assert.Contains("onclick=\"OnInitialize\"", after);

        // A new Visible is refused once, with the edit that wraps the element in an If as the patch; the patch applies.
        var tree2 = ScreenHtml.Parse(html);
        Attribute(Element(tree2, "w27"), "os-Visible", "not IsExecuting");
        var refused = Run(host, basePath, Job(sha, reading, "Login", [ScreenHtmlText.Write(Element(tree2, "w27"))]), "visible");
        Assert.False(refused["accepted"]?.GetValue<bool>() ?? false);
        var problem = Problems(refused).Single(p => p!["code"]!.ToString() == ScreenHtmlEdit.Visible)!;
        Assert.Equal("/ops/0/data/edit/0", problem["pointer"]!.ToString());
        var patched = problem["patch"]![0]!["value"]!.AsArray().Select(v => v!.ToString()).ToList();
        var fixedRun = Run(host, basePath, Job(sha, reading, "Login", patched), "visible-patched");
        Assert.True(fixedRun["accepted"]!.GetValue<bool>(), fixedRun.ToJsonString());
    }

    [Fact]
    public void AnEditThatBreaksTheRulesIsRefusedOnceWithEveryProblemAndOneCheckedPatch()
    {
        // B3 (conferência of 2026-10-12): the refusal came in three rounds (the <script> alone, then the javascript: event, an
        // invalid event and two Visible, then the unknown function at the Verify), HTML_SCRIPT had no patch and v-for passed as an
        // attribute. Now one refusal brings them all, the certain fixes in one checked edit list.
        if (!StudioAvailable()) return;
        var host = Host("rules");
        var basePath = Fixture("reactive-ui.oml");
        var (reading, html, sha) = Read(host, basePath, "Login");
        var tree = ScreenHtml.Parse(html);
        var screen = tree.Children.First(c => !c.IsText);
        screen.Children.Insert(screen.Children.IndexOf(Element(tree, "w4")) + 1, ScreenHtml.Parse("<var name=\"Hints\" type=\"Text List\"/>").Children[0]);
        var form = Element(tree, "w7");
        form.Children.Add(ScreenHtml.Parse("<ul class=\"login-hints\"><li v-for=\"h in Hints\">{{ h }}</li></ul>").Children[0]);
        form.Children.Add(ScreenHtml.Parse("<script>console.log(1)</script>").Children[0]);
        form.Children.Add(ScreenHtml.Parse("<p class=\"login-json\">{{ JSONSerialize(Username) }}</p>").Children[0]);
        Attribute(Element(tree, "w28"), "onclick", "javascript:alert(1)");
        Attribute(Element(tree, "w27"), "os-Visible", "not IsExecuting");
        var refused = Run(host, basePath, Job(sha, reading, "Login", [ScreenHtmlText.Write(tree)]), "rules");
        Assert.False(refused["accepted"]?.GetValue<bool>() ?? false);
        var problems = Problems(refused).Select(p => p!.AsObject()).ToList();
        var codes = problems.Select(p => p["code"]!.ToString()).ToList();
        Assert.Equal(2, codes.Count(c => c == ScreenHtmlEdit.Script));
        Assert.Contains(ScreenHtmlEdit.ForEach, codes);
        Assert.Contains(ScreenHtmlEdit.Visible, codes);
        Assert.Contains(ScreenHtmlEdit.Json, codes);
        // One patch, on every problem whose fix is certain; the JSON has none.
        var fixable = problems.Where(p => p["code"]!.ToString() is "HTML_SCRIPT" or "HTML_FOREACH" or "HTML_VISIBLE").ToList();
        Assert.All(fixable, p => Assert.NotNull(p["patch"]));
        Assert.Single(fixable.Select(p => p["patch"]!.ToJsonString()).Distinct());
        Assert.Null(problems.First(p => p["code"]!.ToString() == ScreenHtmlEdit.Json)["patch"]);
        // The patch applied: what is left is only what nothing corrects (the JSON in the binding).
        var edits = fixable[0]["patch"]![0]!["value"]!.AsArray().Select(v => v!.ToString()).ToList();
        var left = Run(host, basePath, Job(sha, reading, "Login", edits), "rules-patched");
        Assert.All(Problems(left), p => Assert.True(p!["code"]!.ToString() is "HTML_JSON" or "FUNCTION_UNKNOWN", p!.ToJsonString()));
        // The scripts and the Visible alone: the patch is written, the reading's event back, the If around, no script.
        var scripts = ScreenHtml.Parse(html);
        Element(scripts, "w7").Children.Add(ScreenHtml.Parse("<script>console.log(1)</script>").Children[0]);
        Attribute(Element(scripts, "w28"), "onclick", "javascript:alert(1)");
        Attribute(Element(scripts, "w27"), "os-Visible", "not IsExecuting");
        var refusedScripts = Run(host, basePath, Job(sha, reading, "Login", [ScreenHtmlText.Write(Element(scripts, "w7"))]), "scripts");
        var scriptPatch = Problems(refusedScripts).Select(p => p!["patch"]).OfType<JsonArray>().Select(p => p.ToJsonString()).Distinct().Single();
        var scriptEdits = JsonNode.Parse(scriptPatch)![0]!["value"]!.AsArray().Select(v => v!.ToString()).ToList();
        var written = Run(host, basePath, Job(sha, reading, "Login", scriptEdits), "scripts-patched");
        Assert.True(written["accepted"]!.GetValue<bool>(), written.ToJsonString());
        var (_, after, _) = Read(host, Path.Combine(Work, "rules", "scripts-patched.oml"), "Login");
        Assert.Contains("onclick=\"ForgotPassword\"", after);
        Assert.Contains("if=\"not IsExecuting\"", after);
        Assert.DoesNotContain("<script", after);
        Assert.DoesNotContain("javascript:", after);
        // A v-for over a list of the page (a screen made by the document form, then edited): the List patch is written.
        var documentJob = Path.Combine(host.WorkDirectory, "hints-create.json");
        const string dicas = """
            <screen name="Dicas" roles="Registered">
            <var name="Hints" type="Text List"/>
            <Block name="LayoutBlank">
             <slot name="Content">
              <div class="hints">
               <p>{{ "Hints" }}</p>
              </div>
             </slot>
            </Block>
            </screen>
            """;
        File.WriteAllText(documentJob, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = dicas } }) }.ToJsonString());
        var created = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, documentJob, Path.Combine(host.WorkDirectory, "hints.oml")))!.AsObject();
        Assert.True(created["accepted"]!.GetValue<bool>(), created.ToJsonString());
        var hintsBase = Path.Combine(host.WorkDirectory, "hints.oml");
        var (hintsRead, hintsHtml, hintsSha) = Read(host, hintsBase, "Dicas");
        var hints = ScreenHtml.Parse(hintsHtml);
        var box = ScreenHtmlText.Elements(hints).First(x => x.Node.Get("class") == "hints").Node;
        box.Children.Add(ScreenHtml.Parse("<ul class=\"hint-list\"><li v-for=\"h in Hints\">{{ h }}</li></ul>").Children[0]);
        var iteration = Run(host, hintsBase, Job(hintsSha, hintsRead, "Dicas", [ScreenHtmlText.Write(box)]), "hints-vfor");
        var forEach = Problems(iteration).Single(p => p!["code"]!.ToString() == ScreenHtmlEdit.ForEach)!;
        var listEdits = forEach["patch"]![0]!["value"]!.AsArray().Select(v => v!.ToString()).ToList();
        var listed = Run(host, hintsBase, Job(hintsSha, hintsRead, "Dicas", listEdits), "hints-list");
        Assert.True(listed["accepted"]!.GetValue<bool>(), listed.ToJsonString());
        var (_, hintsAfter, _) = Read(host, Path.Combine(Work, "rules", "hints-list.oml"), "Dicas");
        Assert.Contains("list=\"Hints\"", hintsAfter);
        Assert.Contains("{{ Hints.Current }}", hintsAfter);
    }

    [Fact]
    public void ANewButtonWithJavaScriptHasTheFixInWordsAndTheRefusalOfARuleBringsTheVerifyOfTheRestOfTheEdit()
    {
        // The review of 2026-10-12. h4: the patch removed javascript: from the click of a new button and left a button without On
        // Click (the Verify refused it). h5: a refusal for a new Visible hid the Verify of another element of the same edit (an
        // unknown name), a second round after the patch. Now the button keeps the fix in words, and the Verify of the edit with its
        // patch applied comes in the same refusal (afterPatch).
        if (!StudioAvailable()) return;
        var host = Host("review");
        var basePath = Fixture("reactive-ui.oml");
        var (reading, html, sha) = Read(host, basePath, "Login");
        var tree = ScreenHtml.Parse(html);
        Element(tree, "w6").Children.Add(ScreenHtml.Parse("<button class=\"help\" onclick=\"javascript:alert(2)\">Help</button>").Children[0]);
        Attribute(Element(tree, "w27"), "os-Visible", "not IsExecuting");
        var refused = Run(host, basePath, Job(sha, reading, "Login", [ScreenHtmlText.Write(tree)]), "button");
        var problems = Problems(refused).Select(p => p!.AsObject()).ToList();
        var click = problems.Single(p => p["code"]!.ToString() == ScreenHtmlEdit.Script);
        Assert.Null(click["patch"]);
        Assert.Contains("needs its On Click", click["fix"]!.ToString());
        var visible = problems.Single(p => p["code"]!.ToString() == ScreenHtmlEdit.Visible);
        var edits = visible["patch"]![0]!["value"]!.AsArray().Select(v => v!.ToString()).ToList();
        Assert.Contains(edits, e => e.Contains("javascript:alert(2)", StringComparison.Ordinal));
        var left = Run(host, basePath, Job(sha, reading, "Login", edits), "button-patched");
        Assert.Equal([ScreenHtmlEdit.Script], Problems(left).Select(p => p!["code"]!.ToString()));
        var named = Run(host, basePath, Job(sha, reading, "Login", edits.Select(e => e.Replace("javascript:alert(2)", "OnInitialize"))), "button-named");
        Assert.True(named["accepted"]!.GetValue<bool>(), named.ToJsonString());
        // A new Visible and an unknown name in another element of the same edit: both in the first refusal.
        var hidden = ScreenHtml.Parse(html);
        Element(hidden, "w7").Children.Add(ScreenHtml.Parse("<p class=\"typo\">{{ Usernam }}</p>").Children[0]);
        Attribute(Element(hidden, "w27"), "os-Visible", "not IsExecuting");
        var both = Problems(Run(host, basePath, Job(sha, reading, "Login", [ScreenHtmlText.Write(hidden)]), "visible-and-verify")).Select(p => p!.AsObject()).ToList();
        Assert.NotNull(both.Single(p => p["code"]!.ToString() == ScreenHtmlEdit.Visible)["patch"]);
        var unknown = both.Single(p => p["phase"]?.ToString() == "verify");
        Assert.Contains("Usernam", unknown["message"]!.ToString());
        Assert.Equal("/ops/0", unknown["pointer"]!.ToString());
        Assert.True(unknown["afterPatch"]!.GetValue<bool>());
    }

    [Fact]
    public void AForeignIterationOverAScreenAggregateBecomesItsListWithTheRowsEntity()
    {
        // The review of 2026-10-12: a v-for over an aggregate of the screen (the reading writes it in its long form, os-AliasedSource)
        // had no patch, though the List is certain. The row x.Field is GetX.List.Current.Entity.Field.
        if (!StudioAvailable()) return;
        var host = Host("aggregate");
        var spec = """{"op":"spec","data":{"entities":[{"name":"Pedido","attributes":[{"name":"Numero","type":"Text","length":20}],"public":true}]}}""";
        const string pedidos = """
            <screen name="Pedidos" roles="Registered">
            <aggregate name="GetPedidos" from="Pedido" max="10"/>
            <Block name="LayoutBlank">
             <slot name="Content">
              <div class="lista">
               <p>{{ "Pedidos" }}</p>
              </div>
             </slot>
            </Block>
            </screen>
            """;
        var createJob = Path.Combine(host.WorkDirectory, "pedidos-create.json");
        File.WriteAllText(createJob, new JsonObject { ["ops"] = new JsonArray(JsonNode.Parse(spec), new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = pedidos } }) }.ToJsonString());
        var created = JsonSerializer.SerializeToNode(JobRunner.Run(host, Fixture("reactive-ui.oml"), createJob, Path.Combine(host.WorkDirectory, "pedidos.oml")))!.AsObject();
        Assert.True(created["accepted"]!.GetValue<bool>(), created.ToJsonString());
        var basePath = Path.Combine(host.WorkDirectory, "pedidos.oml");
        var (reading, html, sha) = Read(host, basePath, "Pedidos");
        Assert.Contains("os-AliasedSource", html);
        var tree = ScreenHtml.Parse(html);
        var box = ScreenHtmlText.Elements(tree).First(x => x.Node.Get("class") == "lista").Node;
        box.Children.Add(ScreenHtml.Parse("<ul class=\"numeros\"><li v-for=\"p in GetPedidos.List\">{{ p.Numero }}</li></ul>").Children[0]);
        var refused = Run(host, basePath, Job(sha, reading, "Pedidos", [ScreenHtmlText.Write(box)]), "aggregate-vfor");
        var forEach = Problems(refused).Single(p => p!["code"]!.ToString() == ScreenHtmlEdit.ForEach)!;
        var edits = forEach["patch"]![0]!["value"]!.AsArray().Select(v => v!.ToString()).ToList();
        var listed = Run(host, basePath, Job(sha, reading, "Pedidos", edits), "aggregate-list");
        Assert.True(listed["accepted"]!.GetValue<bool>(), listed.ToJsonString());
        var (_, after, _) = Read(host, Path.Combine(host.WorkDirectory, "aggregate-list.oml"), "Pedidos");
        Assert.Contains("list=\"GetPedidos.List\"", after);
        Assert.Contains("{{ GetPedidos.List.Current.Pedido.Numero }}", after);
    }

    [Fact]
    public void AnAggregateEditedWithItsShortFormIsRefusedWithoutAPatchThatEmptiesIt()
    {
        // C-01 (b), F-FitBody-40 (27/10): an edit sent <aggregate k name from join where sort max/> for an aggregate of the
        // reading. from, join, where and sort came back as HTML_PROPERTY_UNKNOWN with a "verified" patch that removed them and
        // left <aggregate k name max/>: an aggregate without source, filter or sort. Now one HTML_DATA_EDIT on the aggregate, with
        // the supported route in its fix and no patch; no problem patches those attributes away.
        if (!StudioAvailable()) return;
        var host = Host("aggregate-short-edit");
        var spec = """{"op":"spec","data":{"entities":[{"name":"Pedido","attributes":[{"name":"Numero","type":"Text","length":20},{"name":"Ativo","type":"Boolean"}],"public":true},{"name":"Nota","attributes":[{"name":"PedidoId","type":"Pedido Identifier"},{"name":"Texto","type":"Text","length":50}],"public":true}]}}""";
        const string pedidos = """
            <screen name="Pedidos" roles="Registered">
            <aggregate name="GetPedidos" from="Pedido" sort="Pedido.Numero" max="10"/>
            <Block name="LayoutBlank">
             <slot name="Content">
              <div class="lista">
               <p>{{ "Pedidos" }}</p>
              </div>
             </slot>
            </Block>
            </screen>
            """;
        var createJob = Path.Combine(host.WorkDirectory, "pedidos-create.json");
        File.WriteAllText(createJob, new JsonObject { ["ops"] = new JsonArray(JsonNode.Parse(spec), new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = pedidos } }) }.ToJsonString());
        var created = JsonSerializer.SerializeToNode(JobRunner.Run(host, Fixture("reactive-ui.oml"), createJob, Path.Combine(host.WorkDirectory, "pedidos.oml")))!.AsObject();
        Assert.True(created["accepted"]!.GetValue<bool>(), created.ToJsonString());
        var basePath = Path.Combine(host.WorkDirectory, "pedidos.oml");
        var (reading, html, sha) = Read(host, basePath, "Pedidos");
        var aggregate = ScreenHtmlText.Elements(ScreenHtml.Parse(html)).First(x => x.Node.Tag == "aggregate").Node;
        var k = aggregate.Get("k")!;
        // The short form of a document, written on the aggregate of the reading (the shape of the FitBody edit).
        var edit = "<aggregate k=\"" + k + "\" name=\"GetPedidos\" from=\"Pedido\" join=\"Nota on Nota.PedidoId = Pedido.Id\" where=\"Pedido.Ativo\" sort=\"Pedido.Numero desc\" max=\"10\"/>";
        var refused = Run(host, basePath, Job(sha, reading, "Pedidos", [edit]), "aggregate-short-edit");
        Assert.False(refused["accepted"]?.GetValue<bool>() ?? false);
        var problems = Problems(refused).Select(p => p!.AsObject()).ToList();
        var data = Assert.Single(problems, p => p["code"]!.ToString() == "HTML_DATA_EDIT");
        Assert.Null(data["patch"]);
        foreach (var attribute in new[] { "from", "join", "where", "sort" }) Assert.Contains(attribute, data["message"]!.ToString());
        Assert.Contains("os-Filter", data["fix"]!.ToString());
        // No problem of the edit removes the aggregate's data attributes (the patch that emptied it).
        Assert.DoesNotContain(problems, p => p["code"]!.ToString() == "HTML_PROPERTY_UNKNOWN" && System.Text.RegularExpressions.Regex.IsMatch(p["message"]!.ToString(), @"^(from|join|where|sort)="));
        foreach (var patch in problems.Select(p => p["patch"]).OfType<JsonArray>())
            Assert.DoesNotContain("<aggregate k=\\\"" + k + "\\\" name=\\\"GetPedidos\\\" max=", patch.ToJsonString());
        // The route the fix names: the aggregate as the reading writes it, a part changed by its k.
        var sort = ScreenHtmlText.Elements(aggregate).First(x => x.Node.Tag == "os-Sort").Node;
        Attribute(sort, "os-SortDirection", "Descending");
        var routed = Run(host, basePath, Job(sha, reading, "Pedidos", [ScreenHtmlText.Write(aggregate)]), "aggregate-long-edit");
        Assert.True(routed["accepted"]!.GetValue<bool>(), routed.ToJsonString());
        var (_, after, _) = Read(host, Path.Combine(host.WorkDirectory, "aggregate-long-edit.oml"), "Pedidos");
        Assert.Contains("os-SortDirection=\"Descending\"", after);
    }

    [Fact]
    public void AnEditOfAnOlderReadingIsRebasedByKeyAndKeepsWhatChangedSince()
    {
        if (!StudioAvailable()) return;
        var host = Host("rebase");
        var store = ModuleIndexStore.Default();
        if (store == null) { output.WriteLine("WARNING: no module index store (SSAM_MODULE_INDEX_ROOT or a workspace): the rebase test is skipped."); return; }
        var basePath = Fixture("reactive-ui.oml");
        var (read, html, sha) = Read(host, basePath, "Login", keys: true);
        // The key table of that reading, as ssam_map view html keeps it.
        var document = read["documents"]![0]!;
        Directory.CreateDirectory(Path.GetDirectoryName(store.HtmlKeysPathOf(sha, document["htmlSha256"]!.ToString()))!);
        File.WriteAllText(store.HtmlKeysPathOf(sha, document["htmlSha256"]!.ToString()), new JsonObject {
            ["schema"] = ScreenHtml.Schema, ["extractor"] = ScreenHtml.Extractor, ["lane"] = store.Lane, ["sourceSha256"] = sha, ["root"] = "Login",
            ["rootKey"] = document["rootKey"]!.DeepClone(), ["rootKind"] = document["rootKind"]!.DeepClone(), ["htmlSha256"] = document["htmlSha256"]!.DeepClone(),
            ["keys"] = document["keys"]!.DeepClone(), ["html"] = html }.ToJsonString());
        // Meanwhile the screen changed in the Studio: a new element at its top (every k after it renumbers) and the text of the
        // link the older edit is about to change.
        var tree = ScreenHtml.Parse(html);
        var screenSlot = Element(tree, "w5").Children.First(c => c.Tag == "slot");
        var login = Element(tree, "w6");
        screenSlot.Children.Insert(screenSlot.Children.IndexOf(login), ScreenHtml.Parse("<div class=\"banner\">{{ \"Maintenance tonight\" }}</div>").Children[0]);
        var link = Element(tree, "w28");
        link.Children.Clear(); link.Children.Add(new ScreenHtml.Node { Text = "Recover password" });
        var changed = Run(host, basePath, Job(sha, read, "Login", [ScreenHtmlText.Write(Element(tree, "w5"))]), "changed");
        Assert.True(changed["accepted"]!.GetValue<bool>(), changed.ToJsonString());
        // The edit written on the first reading: the link whole (its old text) with a class. Three ways: the class is the edit's,
        // the text the Studio's, the banner stays; nothing conflicts.
        var older = ScreenHtml.Parse(html);
        Attribute(Element(older, "w28"), "class", "forgot");
        var rebased = Run(host, Path.Combine(Work, "rebase", "changed.oml"), Job(sha, read, "Login", [ScreenHtmlText.Write(Element(older, "w28"))]), "rebased");
        Assert.True(rebased["accepted"]!.GetValue<bool>(), rebased.ToJsonString());
        var note = Answer(rebased)["rebased"]![0]!;
        Assert.Equal("three-way", note["merge"]!.ToString());
        Assert.Null(note["conflicts"]);
        var (_, after, _) = Read(host, Path.Combine(Work, "rebase", "rebased.oml"), "Login");
        Assert.Contains("Maintenance tonight", after);
        Assert.Contains("class=\"forgot\" onclick=\"ForgotPassword\"", after);
        Assert.Contains(">Recover password</a>", after);
        // The same link's text changed in the older edit too: a conflict, the delivery's version, listed.
        var both = ScreenHtml.Parse(html);
        var mine = Element(both, "w28");
        mine.Children.Clear(); mine.Children.Add(new ScreenHtml.Node { Text = "Lost password?" });
        var conflicted = Run(host, Path.Combine(Work, "rebase", "changed.oml"), Job(sha, read, "Login", [ScreenHtmlText.Write(mine)]), "conflicted");
        Assert.True(conflicted["accepted"]!.GetValue<bool>(), conflicted.ToJsonString());
        var conflicts = Answer(conflicted)["rebased"]![0]!["conflicts"]!.AsArray();
        Assert.Equal("children", Assert.Single(conflicts)!["what"]!.ToString());
        var (_, last, _) = Read(host, Path.Combine(Work, "rebase", "conflicted.oml"), "Login");
        Assert.Contains(">Lost password?</a>", last);
        Assert.Contains("Maintenance tonight", last);
    }

    // ---- the transcript of 2026-10-10 (plan 4.5): the two correction requests of the FarmaVirtual screen, as C -------------
    [Fact]
    public void TheTwoCorrectionsOfTheTranscriptAreTwoCallsEachWithNoRefusalUnderAMinute()
    {
        if (!StudioAvailable()) return;
        var c2 = JsonNode.Parse(File.ReadAllText(ScreenHtmlCoverage.Manifest(Root)))!["c2"]!;
        var limitMs = c2["transcriptLimits"]!["secondsPerCall"]!.GetValue<int>() * 1000;
        foreach (var correction in c2["transcript"]!.AsArray().Select(c => c!.AsObject())) {
            var name = correction["name"]!.ToString();
            var basePath = correction["base"]!.ToString(); var casePath = correction["job"]!.ToString();
            if (!File.Exists(basePath) || !File.Exists(casePath)) { output.WriteLine("WARNING: the capture of " + name + " is absent: skipped (" + basePath + ")"); continue; }
            Assert.Equal(correction["baseSha256"]!.ToString(), Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(basePath))).ToLowerInvariant());
            var host = Host("transcript-" + name);
            // Call 1: ssam_map view html (the reading of the screen).
            var clock = Stopwatch.StartNew();
            var (read, html, sha) = Read(host, basePath, "FarmaVirtual");
            var readMs = clock.ElapsedMilliseconds;
            var session = JsonNode.Parse(File.ReadAllText(casePath))!["ops"]!.AsArray();
            var job = name.StartsWith("0280", StringComparison.Ordinal) ? Correction0280(read, html, sha, session) : Correction0285(read, sha, session);
            // Call 2: the delivery's apply of the job (Verify included).
            clock.Restart();
            var result = Run(host, basePath, job, "c-" + name);
            var applyMs = clock.ElapsedMilliseconds;
            output.WriteLine($"{name}: 2 calls; read {readMs} ms, apply {applyMs} ms; job {job.ToJsonString().Length} B; accepted {result["accepted"]}");
            Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString()[..Math.Min(4000, result.ToJsonString().Length)]);
            Assert.True(readMs <= limitMs && applyMs <= limitMs, $"read {readMs} ms, apply {applyMs} ms (limit {limitMs} ms a call)");
            Assert.True(Answer(result)["applied"]!.GetValue<bool>());
            var (_, after, _) = Read(host, Path.Combine(Work, "transcript-" + name, "c-" + name + ".oml"), "FarmaVirtual");
            if (name.StartsWith("0280", StringComparison.Ordinal)) {
                Assert.Contains("if='Client.FvPage = \"carrinho\" and (Client.FvUser = 1 or Client.FvUser = 2)'", after);
                Assert.Contains("{{ If(Client.FvCreating, \"Novo produto\", \"Editar produto\") }}", after);
                Assert.Contains("class=\"fields fv-edit-fields\"", after);
                Assert.Contains("if=\"not Client.FvCreating\"", after);
                Assert.DoesNotContain("os-Visible", after);
            } else Assert.Contains("<style>", after);
        }
    }

    // The 20:48 adjustment: the screen part as one html edit (the session's raw ops 8-19, Visible written as If), the logic part
    // (a client variable and two assignments) and the theme as the session wrote them.
    private static JsonObject Correction0280(JsonObject read, string html, string sha, JsonArray session)
    {
        var tree = ScreenHtml.Parse(html);
        var edits = new List<string>();
        // The two header links show only for users 1 and 2: an If around them.
        var links = Element(tree, "w23");
        var wrap = new ScreenHtml.Node { Tag = "div" }; wrap.Attributes.Add(new("if", "Client.FvUser = 1 or Client.FvUser = 2"));
        var first = Element(tree, "w24"); var second = Element(tree, "w27");
        links.Children.Insert(links.Children.IndexOf(first), wrap);
        links.Children.Remove(first); links.Children.Remove(second); wrap.Children.Add(first); wrap.Children.Add(second);
        edits.Add(ScreenHtmlText.Write(links));
        // The four nav items already sit in an If each: the condition takes the user too.
        foreach (var k in new[] { "w51", "w55", "w59", "w63" }) {
            var item = Element(tree, k);
            Attribute(item, "if", item.Get("if") + " and (Client.FvUser = 1 or Client.FvUser = 2)");
            edits.Add(ScreenHtmlText.Write(item));
        }
        var title = Element(tree, "w1937");
        title.Children.Clear(); title.Children.Add(new ScreenHtml.Node { Text = "{{ If(Client.FvCreating, \"Novo produto\", \"Editar produto\") }}" });
        edits.Add(ScreenHtmlText.Write(title));
        var body = Element(tree, "w1940");
        Attribute(Element(tree, "w1941"), "class", "fields fv-edit-fields");
        Attribute(Element(tree, "w1954"), "class", "field fv-edit-half");
        Attribute(Element(tree, "w1958"), "class", "field fv-edit-half");
        body.Children.Add(ScreenHtml.Parse("""
            <div if="not Client.FvCreating">
             <div class="form-preview fv-edit-preview">
              <div id="FvEditPreviewPhoto" class='{{ "product-photo tile-" + IntegerToText(Client.FvProdutoId - 1) }}'/>
              <div>
               <h3>{{ Client.FvEditNome }}</h3>
               <p>{{ "Produto #" + If(Client.FvProdutoId &lt; 10, "00", "0") + IntegerToText(Client.FvProdutoId) }}</p>
              </div>
             </div>
            </div>
            """).Children.First(c => !c.IsText));
        edits.Add(ScreenHtmlText.Write(body));
        var ops = new JsonArray();
        for (var i = 0; i < 8; i++) ops.Add(session[i]!.DeepClone());
        ops.Add(EditOp(sha, read, "FarmaVirtual", edits));
        for (var i = 20; i < session.Count; i++) ops.Add(session[i]!.DeepClone());
        return new JsonObject { ["ops"] = ops };
    }

    // "ta tudo sem css": the stylesheet of the screen is its <style>; the theme as the session wrote it.
    private static JsonObject Correction0285(JsonObject read, string sha, JsonArray session)
    {
        var css = session[0]!["value"]!.ToString();
        var ops = new JsonArray(EditOp(sha, read, "FarmaVirtual", ["<style>" + css + "</style>"]));
        for (var i = 1; i < session.Count; i++) ops.Add(session[i]!.DeepClone());
        return new JsonObject { ["ops"] = ops };
    }

    /// <summary>C-14 (F-FigmaMobile-03, F-FitBody-07/16/31/44/51): the CSS a document wrote in the theme is edited by the edit of
    /// its root. The reading of FB_Launch did not print its &lt;style scope="theme" id="fitbody"&gt; (no basedOn to edit it), and
    /// &lt;style scope="theme" id="ewallet-r2"&gt; sent inside an element of the Home edit was refused HTML_EDIT_NOT_APPLIED (it
    /// became an HTML Element); a &lt;style scope="theme"&gt; edit replaced the root's own style sheet. The sessions created 10
    /// blocks that only carried CSS. Now the reading prints the root's own part and the named parts it owns, the edit replaces a
    /// part by its id and adds a new one (nested or not, HTML_THEME_STYLE_LIFTED), the theme holds each part once, the root's own
    /// style sheet stays, and another root's part is never printed here.</summary>
    [Fact]
    public void TheThemePartsOfARootAreReadAndEditedThroughItsEdit()
    {
        if (!StudioAvailable()) return;
        var host = Host("theme-parts");
        var created = Path.Combine(host.WorkDirectory, "created.oml");
        JsonObject Document(string name, string body) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = $"<screen name=\"{name}\" roles=\"Registered\">" + body
            + "<Block name=\"LayoutBlank\"><slot name=\"Content\"><div class=\"fb-app\"><div class=\"fb-logo\">FitBody</div></div></slot></Block></screen>" } };
        var first = Run(host, Fixture("reactive-ui.oml"), new JsonObject { ["ops"] = new JsonArray(
            Document("FbLaunch", "<style>.fb-own{margin:0}</style><style scope=\"theme\" id=\"fitbody\">.fb-app .fb-logo{width:120px}\n.fb-app .lg{font-size:32px}</style><style scope=\"theme\">.fb-app{padding:0}</style>"),
            Document("FbOther", "<style scope=\"theme\" id=\"fitbodyl2\">.fb-app .fbn-tabs{position:absolute}</style>")) }, "created");
        Assert.True(first["accepted"]!.GetValue<bool>(), first.ToJsonString());

        var (reading, html, sha) = Read(host, created, "FbLaunch");
        output.WriteLine(html);
        // The reading prints the parts FbLaunch wrote (named and own), never FbOther's.
        Assert.Contains("<style scope=\"theme\" id=\"fitbody\">\n.fb-app .fb-logo{width:120px}\n.fb-app .lg{font-size:32px}\n</style>", html.Replace("\r\n", "\n"));
        Assert.Contains("<style scope=\"theme\">\n.fb-app{padding:0}\n</style>", html.Replace("\r\n", "\n"));
        Assert.DoesNotContain("fitbodyl2", html);

        // The edit: the part fitbody corrected, and a new part sent inside the element it styles (the F-FigmaMobile-03 shape).
        var tree = ScreenHtml.Parse(html);
        var logo = ScreenHtmlText.Elements(tree).First(x => x.Node.Get("class") == "fb-logo").Node;
        var holder = ScreenHtmlText.Elements(tree).First(x => x.Node.Children.Contains(logo)).Node;
        holder.Children.Add(ScreenHtml.Parse("<style scope=\"theme\" id=\"ewallet-r2\">.fb-app .ew-balance{color:#c6f432}</style>").Children[0]);
        var edits = new[] { "<style scope=\"theme\" id=\"fitbody\">.fb-app .fb-logo{width:147px}\n.fb-app .lg{font-size:32px}</style>", ScreenHtmlText.Write(holder) };
        var result = Run(host, created, Job(sha, reading, "FbLaunch", edits), "edited");
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Contains("HTML_THEME_STYLE_LIFTED", result.ToJsonString());
        var parts = Answer(result)["themeParts"]!.AsArray();
        Assert.Equal(["ewallet-r2", "fitbody"], parts.Select(p => p!["part"]!.ToString()).Order(StringComparer.Ordinal));
        Assert.True(parts.Single(p => p!["part"]!.ToString() == "ewallet-r2")!["created"]!.GetValue<bool>());

        var edited = Path.Combine(host.WorkDirectory, "edited.oml");
        var css = ThemeAuthor(host, edited);
        Assert.Equal(1, css.Split("/* anvil:html style:fitbody */").Length - 1);
        Assert.Contains(".fb-app .fb-logo{width:147px}", css);
        Assert.DoesNotContain("width:120px", css);
        Assert.Contains("/* anvil:html style:ewallet-r2 */ /* anvil:owner FbLaunch */", css);
        Assert.Contains(".fb-app .fbn-tabs{position:absolute}", css);
        var (_, again, _) = Read(host, edited, "FbLaunch");
        Assert.Contains("<style scope=\"theme\" id=\"ewallet-r2\">\n.fb-app .ew-balance{color:#c6f432}\n</style>", again.Replace("\r\n", "\n"));
        Assert.Contains("width:147px", again);
        Assert.Contains(".fb-own{margin:0}", again);
        Assert.DoesNotContain("<style scope=\"theme\" id=\"ewallet-r2\">", again[again.IndexOf("<Block", StringComparison.Ordinal)..]);
        // The next edit is based on this reading (result.next.html): the same text, read from the edited capture.
        Assert.Equal(Answer(result)["next"]!["html"]!.ToString(), host.HtmlRead(File.ReadAllBytes(edited), "FbLaunch", withKeys: false)["documents"]![0]!["htmlSha256"]!.ToString());
    }

    /// <summary>B15 (the proto line's C-10, 968d5605; F-FigmaReactive-01, F-FT-01, F-FigmaMobile-09): the image files of a write are
    /// module images (ssam_code files: the facade writes create IImage with the bytes of fm-hero.png as fm_hero), the screen of the
    /// same job shows the one its src names (<c>&lt;img src="fm-hero.png"&gt;</c>), and the same file sent again (a new photo) fills
    /// the image it already is: one image, the new content, never fm_hero2 nor the collision refusal.</summary>
    [Fact]
    public void AnImageFileOfTheWriteIsTheModuleImageItsScreenShows()
    {
        Assert.True(StudioAvailable(), "this test needs the Service Studio's assemblies (headless)");
        var host = Host("module-images");
        const string png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        const string gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        // The op module-images.mjs writes for an image file of ssam_code files; the facade passes the grant of that file
        // (--image-fill fm_hero=<sha256 of its bytes>, ImageFills) outside the job.
        JsonObject Image(string binary, string file) => new() { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IImage", ["name"] = "fm_hero", ["args"] = new JsonObject { ["binary"] = binary, ["originalPath"] = file } };
        var first = Run(host, Fixture("reactive-ui.oml"), new JsonObject { ["ops"] = new JsonArray(Image(png, "fm-hero.png"),
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen name=\"Fitmaker\" roles=\"Registered\"><Block name=\"LayoutBlank\"><slot name=\"Content\"><img src=\"fm-hero.png\" alt=\"Hero\"/></slot></Block></screen>" } }) }, "images-first");
        Assert.True(first["accepted"]!.GetValue<bool>(), first.ToJsonString());
        var (_, html, _) = Read(host, Path.Combine(host.WorkDirectory, "images-first.oml"), "Fitmaker");
        Assert.Contains("src=\"fm_hero\"", html);
        // The same file again, another photo: the image takes the new content.
        var replace = Image(gif, "fm-hero.gif"); replace["as"] = "$hero";
        var job = new JsonObject { ["ops"] = new JsonArray(replace, new JsonObject { ["op"] = "get", ["target"] = "$hero" }) };
        JsonObject again;
        using (ImageFills.For(("fm_hero", Convert.ToHexString(SHA256.HashData(Convert.FromBase64String(gif))))))
            again = Run(host, Path.Combine(host.WorkDirectory, "images-first.oml"), job, "images-again");
        Assert.True(again["accepted"]!.GetValue<bool>(), again.ToJsonString());
        var results = again["results"]!.AsArray();
        Assert.True(results[0]!["result"]!["contentReplaced"]!.GetValue<bool>(), results[0]!.ToJsonString());
        Assert.Contains("Gif", results[1]!["result"]!.ToJsonString());
        Assert.Contains(again["normalized"]!.AsArray(), n => n!["code"]?.ToString() == "IMAGE_CONTENT_REPLACED");
        // Review of W3-CSS (correction 2): the replacement reaches the answer, as a high warning the facades of both lanes relay.
        var warning = Assert.Single(again["highWarnings"]!.AsArray(), w => w!["code"]?.ToString() == "IMAGE_CONTENT_REPLACED")!;
        Assert.Equal("high", warning["severity"]!.ToString());
        Assert.Equal("fm_hero", warning["image"]!.ToString());
        Assert.Contains("fm_hero", warning["message"]!.ToString());
        Assert.Contains("fm-hero.gif", warning["message"]!.ToString());
        var (_, still, _) = Read(host, Path.Combine(host.WorkDirectory, "images-again.oml"), "Fitmaker");
        Assert.Contains("src=\"fm_hero\"", still);
    }

    /// <summary>Review of W3-CSS (S1, the Integradora's decision): only a create an image FILE made fills an image of the same name.
    /// A create IImage written by hand with the name of an image the module has (Logo, the app's own icon in the fixture) is still
    /// NAME_COLLISION, as on the base: nothing is replaced and nothing is saved.</summary>
    [Fact]
    public void AHandWrittenCreateOfAnExistingImageIsStillANameCollision()
    {
        Assert.True(StudioAvailable(), "this test needs the Service Studio's assemblies (headless)");
        var host = Host("module-images-hand");
        const string png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        var saved = Path.Combine(host.WorkDirectory, "image-by-hand.oml");
        var pngSha = Convert.ToHexString(SHA256.HashData(Convert.FromBase64String(png)));
        // R2-1 (round 3 of the review): no field of the job authorizes the fill. Without a grant, with the _from "file" an
        // earlier generated job carried, and with a grant of another image or of other bytes: NAME_COLLISION, nothing saved.
        foreach (var (from, grant) in new (string? From, (string, string)[] Grant)[] { (null, []), ("file", []), ("file", [("fm_hero", pngSha)]), (null, [("Logo", new string('0', 64))]) })
        {
            var op = new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IImage", ["name"] = "Logo", ["args"] = new JsonObject { ["binary"] = png, ["originalPath"] = "logo.png" } };
            if (from != null) op["_from"] = from;
            if (File.Exists(saved)) File.Delete(saved);
            JsonObject refused;
            using (ImageFills.For(grant)) refused = Run(host, Fixture("reactive-ui.oml"), new JsonObject { ["ops"] = new JsonArray(op) }, "image-by-hand");
            Assert.False(refused["accepted"]!.GetValue<bool>(), (from ?? "-") + ": " + refused.ToJsonString());
            Assert.Contains(Problems(refused), p => p!["code"]?.ToString() == "NAME_COLLISION" && p["existing"]?.ToString() == "IImage:Logo");
            Assert.False(File.Exists(saved), "a refused job saves nothing");
        }
    }

    private static string ThemeAuthor(ModelHost host, string oml)
    {
        var dir = host.WorkDirectory;
        var job = Path.Combine(dir, "theme-get.json");
        File.WriteAllText(job, """{"ops":[{"op":"get","target":"IMobileTheme:Headless_UI"}]}""");
        var got = JsonSerializer.SerializeToNode(JobRunner.Run(host, oml, job, Path.Combine(dir, "theme-get.oml")))!["results"]![0]!["result"]!;
        return (got["properties"]?["UserStyleSheet"]?.ToString() ?? got["UserStyleSheet"]?.ToString() ?? got["properties"]?["StyleSheet"]?.ToString() ?? got["StyleSheet"]?.ToString() ?? "").Replace("\r\n", "\n");
    }

    // ---- helpers ----------------------------------------------------------------------------------------------------------
    private ModelHost Host(string name) { var dir = Path.Combine(Work, name); Directory.CreateDirectory(dir); return new ModelHost(dir); }

    private static (JsonObject Read, string Html, string Sha) Read(ModelHost host, string oml, string screen, bool keys = false)
    {
        var bytes = File.ReadAllBytes(oml);
        var read = host.HtmlRead(bytes, screen, withKeys: keys);
        return (read, read["documents"]![0]!["html"]!.ToString(), Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
    }

    private static JsonObject EditOp(string sha, JsonObject read, string screen, IEnumerable<string> edits) => new() {
        ["op"] = "html", ["data"] = new JsonObject { ["screen"] = screen,
            ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = read["documents"]![0]!["htmlSha256"]!.DeepClone() },
            ["edit"] = new JsonArray(edits.Select(e => (JsonNode)e).ToArray()) } };
    private static JsonObject Job(string sha, JsonObject read, string screen, IEnumerable<string> edits) => new() { ["ops"] = new JsonArray(EditOp(sha, read, screen, edits)) };

    private JsonObject Run(ModelHost host, string basePath, JsonObject job, string name)
    {
        var dir = host.WorkDirectory;
        var jobPath = Path.Combine(dir, name + ".json"); File.WriteAllText(jobPath, job.ToJsonString());
        try { return JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, Path.Combine(dir, name + ".oml")))!.AsObject(); }
        catch (Exception error) {
            var coded = Errors.FindCoded(error);
            output.WriteLine(name + " refused: " + Errors.Text(error)[..Math.Min(2000, Errors.Text(error).Length)]);
            return new JsonObject { ["accepted"] = false, ["code"] = coded?.Code, ["problems"] = coded?.Problems?.DeepClone() };
        }
    }

    private static JsonObject Answer(JsonObject result) => result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().Last(r => r["mode"]?.ToString() == "edit");
    private static JsonArray Problems(JsonObject result) => result["problems"] as JsonArray ?? new JsonArray();
    private static ScreenHtml.Node Element(ScreenHtml.Node tree, string k) => ScreenHtmlText.Elements(tree).First(x => x.Node.Get("k") == k).Node;
    private static void Attribute(ScreenHtml.Node node, string name, string value)
    {
        var i = node.Attributes.FindIndex(a => a.Key == name);
        if (i >= 0) node.Attributes[i] = new(name, value); else node.Attributes.Add(new(name, value));
    }
    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
