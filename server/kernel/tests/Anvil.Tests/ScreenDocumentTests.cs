using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
namespace Anvil.Tests;

/// <summary>B1 of the plan "Texto do SSAM": the document form of the html op (one &lt;screen&gt; or &lt;block&gt; in ssam-html/1,
/// ScreenDocument and ModelSession.DocumentCompiler). The rules that need no module (the form, the owner's rules on what is
/// new with the checked patch, the nearest name, the one table of the language's own rows) run without a Studio; the
/// compile over the reactive fixture (a new screen with data, events, the job's screen action and the short aggregate; every
/// wrong name of a document in one refusal) needs the Service Studio and is skipped without it, like JobTests.</summary>
public sealed class ScreenDocumentTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenDocumentTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "screen-document-tests");

    // ---- the form and the owner's rules (no module) --------------------------------------------------------------------

    [Fact]
    public void TheDocumentFormIsAScreenOrABlockNotAFragmentOrAPage()
    {
        Assert.True(ScreenDocument.IsDocumentOp(Op("<screen name=\"A\"></screen>")));
        Assert.True(ScreenDocument.IsDocumentOp(Op("  <!-- note -->\n<block name=\"B\"/>")));
        Assert.False(ScreenDocument.IsDocumentOp(Op("<div class=\"x\"></div>")));
        var fragment = Op("<screen name=\"A\"></screen>"); fragment["parent"] = "$screen";
        Assert.False(ScreenDocument.IsDocumentOp(fragment));
        Assert.False(ScreenDocument.IsDocumentOp(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "A", ["html"] = "<div></div>" } }));
    }

    // The edit of a reading (C2) and the document form (B1) both may hold a whole <screen>; one rule decides, the same for the
    // preflight and the apply, and an op is never both.
    [Fact]
    public void AnOpIsEitherTheEditOfAReadingOrTheDocumentFormNeverBoth()
    {
        JsonObject With(Action<JsonObject> fill) { var op = Op("<screen name=\"A\"></screen>"); fill(op["data"]!.AsObject()); return op; }
        var basedOn = () => new JsonObject { ["capture"] = new string('a', 64), ["html"] = new string('b', 64) };
        var cases = new (string Name, JsonObject Op, bool Edit)[] {
            ("new screen", Op("<screen name=\"A\"></screen>"), false),
            ("new screen keeping what its read elements had", With(d => d["basedOn"] = basedOn()), false),
            ("whole document as the edit of screen A", With(d => { d["basedOn"] = basedOn(); d["screen"] = "A"; }), true),
            ("edit list", new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "A", ["basedOn"] = basedOn(), ["edit"] = new JsonArray("<div k=\"w1\"></div>") } }, true),
            ("edit list without its base", new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["edit"] = new JsonArray("<div k=\"w1\"></div>") } }, true),
            ("base without a document", new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["basedOn"] = basedOn() } }, true),
        };
        foreach (var (name, op, edit) in cases)
        {
            Assert.True(edit == Anvil.Reading.ScreenHtmlEdit.IsEdit(op), name + ": IsEdit");
            Assert.False(ScreenDocument.IsDocumentOp(op) && Anvil.Reading.ScreenHtmlEdit.IsEdit(op), name + ": both forms");
            Assert.True(!edit == ScreenDocument.IsDocumentOp(op), name + ": IsDocumentOp");
        }
    }

    [Fact]
    public void EveryNewVisibleScriptAndForeignIterationComesInOneRefusalWithACheckedPatch()
    {
        var html = "<screen name=\"Regras\">\n<var name=\"Mostrar\" type=\"Boolean\"/>\n"
            + "<p os-Visible=\"Mostrar\">Oi</p>\n<script>alert(1)</script>\n<a href=\"javascript:void(0)\">x</a>\n"
            + "<ul v-for=\"item in GetProdutos.List\"><li>{{ item.Produto.Nome }}</li></ul>\n<span onclick=\"this.x = 1; go()\">y</span>\n</screen>";
        var refusal = Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(html, "/data/html"));
        var problems = refusal.Problems!.Select(p => p!.AsObject()).ToList();
        Assert.Equal(["HTML_VISIBLE", "HTML_SCRIPT", "HTML_SCRIPT", "HTML_FOREACH", "HTML_SCRIPT"], problems.Select(p => p["code"]!.ToString()));
        Assert.All(problems, p => Assert.Equal("/data/html", p["pointer"]!.ToString()));
        // One corrected document, the same patch on every problem that has a correction; it passes the rules it fixes.
        var corrected = problems[0]["patch"]![0]!["value"]!.ToString();
        Assert.All(problems, p => Assert.Equal(corrected, p["patch"]![0]!["value"]!.ToString()));
        Assert.Contains("<div if=\"Mostrar\"><p>Oi</p></div>", corrected);
        Assert.DoesNotContain("<script", corrected);
        Assert.DoesNotContain("javascript:", corrected);
        Assert.DoesNotContain("onclick", corrected);
        Assert.Contains("<ul list=\"GetProdutos.List\"><li>{{ GetProdutos.List.Current.Produto.Nome }}</li></ul>", corrected);
        Assert.True(ScreenDocument.RulesPass(corrected));
        ScreenDocument.Preflight(corrected, "/data/html");
    }

    [Fact]
    public void WhatAReadElementAlreadyHasIsKeptAndNeverRefused()
    {
        // k comes only from a reading: the Visible and the JavaScript the element already had are listed, not refused.
        var html = "<screen name=\"Lida\">\n<div k=\"w1\" os-Visible=\"False\" onclick=\"javascript:go()\"><a k=\"w2\" href=\"javascript:void(0)\">x</a></div>\n</screen>";
        Assert.Equal("document", ScreenDocument.Preflight(html, "/data/html")["form"]!.ToString());
    }

    [Fact]
    public void TwoSiblingsWrappedAndANameFixedComposeInOneCorrectedDocument()
    {
        var html = "<screen name=\"S\">\n<p os-Visible=\"A\">1</p><p os-Visible=\"B\">2</p>\n<img src=\"Logoo\"/>\n</screen>";
        var problems = new List<ScreenDocument.Problem>
        {
            new(ScreenDocument.Visible, 2, 1, "", null, Correct: new ScreenDocument.RemoveAttribute("os-Visible", "A")),
            new(ScreenDocument.Visible, 2, 24, "", null, Correct: new ScreenDocument.RemoveAttribute("os-Visible", "B")),
            new(ScreenDocument.NameUnknown, 3, 1, "", null, Replace: ("src", "Logoo", "Logo")),
        };
        Assert.Equal("<screen name=\"S\">\n<div if=\"A\"><p>1</p></div><div if=\"B\"><p>2</p></div>\n<img src=\"Logo\"/>\n</screen>", ScreenDocument.Correct(html, problems));
        Assert.Equal(html.IndexOf("\n<img", StringComparison.Ordinal), ScreenDocument.ElementEnd(html, html.IndexOf("<p os-Visible=\"B\"", StringComparison.Ordinal)));
    }

    [Fact]
    public void TheNearestNameIsWithinTwoEditsOrSharesSeventyPercentAndIgnoresCase()
    {
        Assert.Equal(["Buscar"], ScreenDocument.Nearest("Buscr", ["Buscar", "Login", "Pedidos"]));
        Assert.Equal(["LayoutTopMenu"], ScreenDocument.Nearest("LayoutTopMenuu", ["LayoutTopMenu", "LayoutSideMenu", "LayoutBlank"]));
        Assert.Empty(ScreenDocument.Nearest("Zebra", ["Buscar", "Login"]));
        Assert.Empty(ScreenDocument.Nearest("buscar", ["Buscar"])); // only the case differs: the same name, not a candidate
        Assert.Equal(3, ScreenDocument.Nearest("Item", ["Item1", "Item2", "Item3", "Item4"]).Count);
    }

    [Fact]
    public void ACallIsADestinationWithNamedOrPositionalArgumentsAndJavaScriptIsNot()
    {
        Assert.True(ScreenDocument.ParseCall("PedidoDetalhe(PedidoId = Row.Id, Modo = \"a, b\")", out var target, out var args));
        Assert.Equal("PedidoDetalhe", target);
        Assert.Equal([("PedidoId", "Row.Id"), ("Modo", "\"a, b\"")], args.Select(a => (a.Param!, a.Value)));
        Assert.True(ScreenDocument.ParseCall("Salvar(Id, True)", out _, out var positional));
        Assert.All(positional, a => Assert.Null(a.Param));
        Assert.False(ScreenDocument.ParseCall("this.x = 1; go()", out _, out _));
        Assert.True(ScreenDocument.IsRecordLiteral("{ AnimateInitialProgress: False }"));
        Assert.False(ScreenDocument.IsRecordLiteral("If(A, B, C)"));
    }

    [Fact]
    public void TheLanguageRowsAreOneTableForTheReadingTheFragmentAndTheImporter()
    {
        // Switch, Upload, Icon and ButtonGroup: the rows of ElementWidgetMap are the reading's (ScreenHtml.WidgetTags).
        foreach (var (tag, row) in ElementWidgetMap.LanguageElements)
            Assert.Equal(tag, Anvil.Reading.ScreenHtml.WidgetTags[row.Widget[1..]]);
        Assert.Equal("ISwitch", Map("<switch bind=\"Ativo\" class=\"s\"></switch>").Widget);
        Assert.Equal("IUpload", Map("<upload bind=\"Arquivo\"></upload>").Widget);
        Assert.Equal("IButtonGroup", Map("<button-group bind=\"Modo\"></button-group>").Widget);
        var icon = Map("<i icon=\"eye\" aria-label=\"Ver\"></i>");
        Assert.Equal("IIcon", icon.Widget);
        Assert.Contains(("Icon", "eye"), icon.Properties);
        Assert.Contains(("aria-label", "\"Ver\""), icon.ExtendedProperties);
        Assert.Equal("IAdvancedHtml", Map("<i class=\"fa fa-user\"></i>").Widget); // an <i> that names no icon is the HTML Element i
        Assert.DoesNotContain(Map("<switch bind=\"Ativo\"></switch>").ExtendedProperties, e => e.Item1 == "bind");
    }

    // ---- the compile over the reactive fixture (Service Studio) --------------------------------------------------------

    private const string Spec = """
        {"op": "spec", "data": {
          "static": [{"name": "StatusPedido", "records": [{"name": "Novo", "label": "Novo"}, {"name": "Pago", "label": "Pago"}], "public": true}],
          "entities": [{"name": "Pedido", "attributes": [{"name": "Numero", "type": "Text", "length": 20}, {"name": "CriadoEm", "type": "Date Time"},
            {"name": "StatusPedidoId", "type": "StatusPedido Identifier"}, {"name": "Urgente", "type": "Boolean"}], "public": true}]}}
        """;

    [Fact]
    public void ANewScreenCompilesWithItsDataEventsAndTheJobsScreenActionAndReadsBackTheSame()
    {
        if (!StudioAvailable()) return;
        var html = """
            <screen name="Pedidos" title='"Pedidos"' roles="Registered" actions="Buscar, Limpar">
            <input name="ClienteNome" type="Text"/>
            <var name="Busca" type="Text"/>
            <var name="SoUrgentes" type="Boolean" default="False"/>
            <aggregate name="GetPedidos" from="Pedido" join="StatusPedido on Pedido.StatusPedidoId = StatusPedido.Id" where="Busca = &quot;&quot; or Pedido.Numero like &quot;%&quot; + Busca + &quot;%&quot;" sort="Pedido.CriadoEm desc, Pedido.Numero" max="50"/>
            <Block name="LayoutTopMenu">
             <slot name="Title">Pedidos</slot>
             <slot name="MainContent">
              <form id="Filtros" class="toolbar">
               <input id="Input_Busca" bind="Busca" type="search" placeholder='"Buscar"' onchange="Buscar"/>
               <switch id="Urgentes" bind="SoUrgentes" onchange="Buscar"/>
               <button class="btn btn-primary" onclick="Buscar">Buscar</button>
               <a onclick="Limpar"><i icon="times" class="icon"/> Limpar</a>
              </form>
              <div if="GetPedidos.List.Empty">
               <p class="text-neutral-7">Nenhum pedido.</p>
              </div>
              <div else>
               <ul list="GetPedidos.List">
                <li>{{ GetPedidos.List.Current.Pedido.Numero + " - " + GetPedidos.List.Current.StatusPedido.Label }}</li>
               </ul>
              </div>
             </slot>
            </Block>
            </screen>
            """;
        var job = Job(html, """{"op": "logic", "data": {"actions": [{"name": "Buscar", "kind": "screen", "owner": "IMobileScreen:Pedidos", "steps": [{"node": "IRefreshDataNode", "properties": {"DataSource": "IScreenAggregate:GetPedidos"}}]}, {"name": "Limpar", "kind": "screen", "owner": "IMobileScreen:Pedidos", "steps": [{"assign": {"Busca": "\"\""}}]}]}}""");
        var host = Host("create");
        var output = Path.Combine(Work, "create", "out.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, output))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        var report = result["results"]!.AsArray().Select(r => r!["result"]!).First(r => r["form"]?.ToString() == "document").AsObject();
        Assert.Equal("Pedidos", report["root"]!.ToString());
        Assert.Equal(2, report["sameJobScreenActions"]!.AsArray().Count);

        // The page reads back with every element the document wrote: the short aggregate in its long form, the events bound.
        var document = host.HtmlRead(File.ReadAllBytes(output), "MobileScreen:Pedidos", withKeys: false)["documents"]![0]!.AsObject();
        Assert.Null(document["problems"]);
        var text = document["html"]!.ToString();
        foreach (var expected in new[] { "<switch ", "bind=\"SoUrgentes\"", "onchange=\"Buscar\"", "<i ", "icon=\"times\"", "list=\"GetPedidos.List\"", "<div else>",
                     "os-Condition=\"Pedido.StatusPedidoId = StatusPedido.Id\"", "os-SortDirection=\"Descending\"", "max=\"50\"", "onclick=\"Limpar\"" })
            Assert.Contains(expected, text);
    }

    [Fact]
    public void NWrongNamesComeInOneRefusalWithNProblemsEachWithItsNearestName()
    {
        if (!StudioAvailable()) return;
        var html = "<screen name=\"Erros\" roles=\"Registered\" actions=\"Buscar\">\n<var name=\"Busca\" type=\"Txt\"/>\n<var name=\"Contagem\" type=\"Integer\"/>\n"
            + "<Block name=\"LayoutTopMenuu\">\n <slot name=\"MainContent\">\n  <button onclick=\"Buscr\">Buscar</button>\n  <input bind=\"Busca\" onchange=\"Buscarr\"/>\n"
            + "  <span>{{ Contagm + 1 }}</span>\n  <p os-Visible=\"Contagem > 0\">x</p>\n </slot>\n</Block>\n</screen>";
        var job = Job(html, """{"op": "logic", "data": {"actions": [{"name": "Buscar", "kind": "screen", "owner": "IMobileScreen:Erros", "steps": []}]}}""", spec: false);
        var host = Host("wrong");
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, null, job, Path.Combine(Work, "wrong", "out.oml")));
        var problems = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).Select(p => p!.AsObject()).Where(p => p["severity"]?.ToString() != "warning").ToList();
        // Txt, LayoutTopMenuu, Buscr, Buscarr and Contagm: five wrong names, five problems; and the new Visible of the rules
        // (found by the preflight without a module) in the same refusal, once.
        Assert.Equal(6, problems.Count);
        Assert.Equal(5, problems.Count(p => p["code"]!.ToString() == "HTML_NAME_UNKNOWN"));
        Assert.Single(problems, p => p["code"]!.ToString() == "HTML_VISIBLE");
        var fixes = problems.Select(p => p["fix"]!.ToString()).ToList();
        Assert.Contains("type=\"Text\"", fixes);
        Assert.Contains("name=\"LayoutTopMenu\"", fixes);
        Assert.Contains("onclick=\"Buscar\"", fixes);
        Assert.Contains("onchange=\"Buscar\"", fixes);
        Assert.Contains("Contagm -> Contagem", fixes);
        var corrected = problems[0]["patch"]![0]!["value"]!.ToString();
        Assert.Equal("/ops/0/data/html", problems[0]["patch"]![0]!["path"]!.ToString());
        foreach (var right in new[] { "type=\"Text\"", "<Block name=\"LayoutTopMenu\">", "onclick=\"Buscar\"", "onchange=\"Buscar\"", "{{ Contagem + 1 }}",
                     "<div if=\"Contagem > 0\"><p>x</p></div>" }) Assert.Contains(right, corrected);
    }

    [Fact]
    public void AForeignIterationsRowIsTheCurrentItemAndItsPatchIsOfferedOnlyWhenItCompiles()
    {
        // B4 (conferência of 2026-10-12): v-for="n in Nomes" with {{ n }} became list="Nomes" with {{ Id }} (the nearest name of
        // the unknown n), which the Verify refuses. The row is the current item; an aggregate's row names its entity first.
        var values = "<screen name=\"VerifTexto\" roles=\"Registered\">\n<var name=\"Nomes\" type=\"Text List\"/>\n<Block name=\"LayoutBlank\">\n <slot name=\"Content\">\n"
            + "  <div class=\"gs-wrap\">\n   <ul><li v-for=\"n in Nomes\">{{ n }}</li></ul>\n   <p os-Visible=\"Nomes.Length > 0\">Total</p>\n  </div>\n </slot>\n</Block>\n</screen>";
        var preflight = Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(values, "/data/html"));
        var corrected = preflight.Problems![0]!["patch"]![0]!["value"]!.ToString();
        Assert.Contains("<ul><li list=\"Nomes\">{{ Nomes.Current }}</li></ul>", corrected);
        var rows = "<screen name=\"S\">\n<aggregate name=\"GetPedidos\" from=\"Pedido\" max=\"10\"/>\n<ul v-for=\"p in GetPedidos\"><li class=\"p-row\">{{ p.Numero }}</li></ul>\n</screen>";
        var row = Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(rows, "/data/html")).Problems![0]!["patch"]![0]!["value"]!.ToString();
        Assert.Contains("<ul list=\"GetPedidos.List\"><li class=\"p-row\">{{ GetPedidos.List.Current.Pedido.Numero }}</li></ul>", row);
        if (!StudioAvailable()) return;
        // With the module: one refusal (no unknown n beside the iteration), one patch, and the patched document compiles.
        var host = Host("iteration");
        var job = DocumentJob(values, "iteration");
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, null, job, Path.Combine(Work, "iteration", "out.oml")));
        var problems = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).Select(p => p!.AsObject()).ToList();
        Assert.Equal(["HTML_FOREACH", "HTML_VISIBLE"], problems.Select(p => p["code"]!.ToString()).Order());
        var patch = Assert.Single(problems.Select(p => p["patch"]?.ToJsonString()).Distinct());
        var patched = JsonNode.Parse(patch!)![0]!["value"]!.ToString();
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, DocumentJob(patched, "iteration-patched"), Path.Combine(Work, "iteration", "patched.oml")))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        // A source the page does not have: list="itens" would not compile, so that fix is no patch; the others keep a checked one
        // (a script on the click of a span goes; a Button's or a Link's stays: AButtonWhoseClickIsJavaScript... below).
        var wrong = values.Replace("v-for=\"n in Nomes\"", "v-for=\"x in itens\"").Replace("{{ n }}", "{{ x }}").Replace("<p os-Visible", "<span onclick=\"javascript:alert(1)\">x</span>\n   <p os-Visible");
        var refused = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, null, DocumentJob(wrong, "iteration-wrong"), Path.Combine(Work, "iteration", "wrong.oml")));
        var mixed = (Errors.FindCoded(refused)?.Problems ?? new JsonArray()).Select(p => p!.AsObject()).ToList();
        Assert.Null(mixed.Single(p => p["code"]!.ToString() == "HTML_FOREACH")["patch"]);
        Assert.DoesNotContain(mixed, p => p["code"]!.ToString() == "HTML_NAME_UNKNOWN");   // neither x nor 'alert'
        var kept = mixed.Where(p => p["code"]!.ToString() is "HTML_VISIBLE" or "HTML_SCRIPT").ToList();
        Assert.Equal(2, kept.Count);
        Assert.All(kept, p => Assert.NotNull(p["patch"]));
        var rest = JsonNode.Parse(kept[0]["patch"]!.ToJsonString())![0]!["value"]!.ToString();
        var again = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, null, DocumentJob(rest, "iteration-rest"), Path.Combine(Work, "iteration", "rest.oml")));
        Assert.Equal(["HTML_FOREACH"], (Errors.FindCoded(again)?.Problems ?? new JsonArray()).Select(p => p!["code"]!.ToString()).Where(c => c != "HTML_NAME_UNKNOWN").Distinct());
    }

    [Fact]
    public void AButtonWhoseClickIsJavaScriptHasTheFixInWordsAndTheOtherFixesComeCheckedByTheCompile()
    {
        // The review of 2026-10-12 (h3, o1, the conferência's b1): the patch removed javascript: from the click of a button and left a
        // button without On Click, which the Verify refuses (RequiredPropertyValue_Property); B4 did not close. A Button or a Link
        // needs its click: no patch for it, the fix in words; the other fixes of the document still come, compiled with every
        // Verify error on what the document writes.
        var button = "<screen name=\"VerifBotao\" roles=\"Registered\">\n<Block name=\"LayoutBlank\">\n <slot name=\"Content\">\n  <div class=\"wrap\">\n"
            + "   <button onclick=\"javascript:alert(1)\">Ok</button>\n  </div>\n </slot>\n</Block>\n</screen>";
        var alone = Assert.Single(Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(button, "/data/html")).Problems!)!;
        Assert.Equal("HTML_SCRIPT", alone["code"]!.ToString());
        Assert.Null(alone["patch"]);
        Assert.Contains("needs its On Click", alone["fix"]!.ToString());
        Assert.Null(Assert.Single(Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(button.Replace("<button", "<a").Replace("</button>", "</a>"), "/data/html")).Problems!)!["patch"]);
        if (!StudioAvailable()) return;
        var host = Host("button");
        var refused = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, null, DocumentJob(button, "button"), Path.Combine(Work, "button", "out.oml")));
        Assert.Null(Assert.Single(Errors.FindCoded(refused)!.Problems!)!["patch"]);
        var mixed = "<screen name=\"VerifMisto\" roles=\"Registered\">\n<var name=\"Itens\" type=\"Text\"/>\n<Block name=\"LayoutBlank\">\n <slot name=\"Content\">\n"
            + "  <div class=\"wrap\" os-Visible=\"Itens &lt;> &quot;&quot;\">\n   <p>{{ Itens }}</p>\n   <button onclick=\"javascript:alert(1)\">Ok</button>\n"
            + "   <script>console.log(1)</script>\n  </div>\n </slot>\n</Block>\n</screen>";
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, null, DocumentJob(mixed, "button-mixed"), Path.Combine(Work, "button-mixed", "out.oml")));
        var problems = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).Select(p => p!.AsObject()).ToList();
        Assert.Equal(["HTML_SCRIPT", "HTML_SCRIPT", "HTML_VISIBLE"], problems.Select(p => p["code"]!.ToString()).Order());
        Assert.Null(problems.Single(p => p["message"]!.ToString().Contains("javascript:alert(1)", StringComparison.Ordinal))["patch"]);
        var patch = Assert.Single(problems.Where(p => p["patch"] is JsonArray).Select(p => p["patch"]!.ToJsonString()).Distinct());
        var patched = JsonNode.Parse(patch!)![0]!["value"]!.ToString();
        Assert.Contains("<div if=", patched);
        Assert.DoesNotContain("<script", patched);
        Assert.Contains("onclick=\"javascript:alert(1)\"", patched);
        // The patch applied: only the button is left; named after what it runs, the page is written (B4 closes).
        var left = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, null, DocumentJob(patched, "button-patched"), Path.Combine(Work, "button-patched", "out.oml")));
        Assert.Equal(["HTML_SCRIPT"], (Errors.FindCoded(left)?.Problems ?? new JsonArray()).Select(p => p!["code"]!.ToString()));
        var named = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, DocumentJob(patched.Replace("javascript:alert(1)", "MobileScreen:Login"), "button-named"),
            Path.Combine(Work, "button-named", "out.oml")))!.AsObject();
        Assert.True(named["accepted"]!.GetValue<bool>(), named["details"]?.ToJsonString());
    }

    [Fact]
    public void AnIterationOverAnOutputOfADataActionOfThePageIsItsListWithTheRowAsTheCurrentItem()
    {
        // The review of 2026-10-12 (h1): v-for="c in CartCards.Cards" (an output of a data action the page lists) stayed without a
        // patch, though the List over it is certain: the source is data of the page; the row c.X is CartCards.Cards.Current.X.
        var document = ScreenHtml.Parse("<screen name=\"Cart\" data-actions=\"CartCards, Hud\">\n<ul><li v-for=\"c in CartCards.Cards\">{{ c.Title + \" \" + c.Price }}</li></ul>\n</screen>");
        var item = ScreenHtmlText.Elements(document).Select(x => x.Node).First(n => n.Tag == "li");
        var use = ScreenDocument.IterateInTree(item, "v-for", "CartCards.Cards", "c", document)!;
        Assert.True(use.Declared);
        Assert.True(use.Output);
        Assert.False(use.Whole);
        Assert.Equal("CartCards.Cards", item.Get("list"));
        Assert.Contains("{{ CartCards.Cards.Current.Title + \" \" + CartCards.Cards.Current.Price }}", ScreenHtmlText.Write(item));
        // A name the page has no data action of is not data of the page.
        var other = ScreenHtml.Parse("<screen name=\"Cart\" data-actions=\"Hud\">\n<ul><li v-for=\"c in CartCards.Cards\">{{ c.Title }}</li></ul>\n</screen>");
        Assert.False(ScreenDocument.IterateInTree(ScreenHtmlText.Elements(other).Select(x => x.Node).First(n => n.Tag == "li"), "v-for", "CartCards.Cards", "c", other)!.Declared);
        // A screen aggregate as the reading writes it (os-AliasedSource): its row names its source.
        var aggregate = ScreenHtml.Parse("<screen name=\"S\">\n<aggregate k=\"w1\" name=\"GetColabs\" max=\"50\" os-MasterSource=\"AliasedSource:Colaborador\">\n"
            + " <os-CombineSourcesOperation k=\"w2\" name=\"Colaboradors\">\n  <os-AliasedSource k=\"w3\" name=\"Colaborador\" os-Source=\"ServerEntity:Colaborador\"/>\n </os-CombineSourcesOperation>\n</aggregate>\n"
            + "<ul><li v-for=\"x in GetColabs.List\">{{ x.Nome }}</li></ul>\n</screen>");
        var row = ScreenHtmlText.Elements(aggregate).Select(x => x.Node).First(n => n.Tag == "li");
        var read = ScreenDocument.IterateInTree(row, "v-for", "GetColabs.List", "x", aggregate)!;
        Assert.Equal("Colaborador", read.Record);
        Assert.Contains("{{ GetColabs.List.Current.Colaborador.Nome }}", ScreenHtmlText.Write(row));
    }

    // ---- fidelity (the owner's report of 2026-10-12, FolhaPonto_UI) ---------------------------------------------------------

    [Fact]
    public void ALineOfTextWithBindingsIsOneExpressionAndABracePairThatIsNoBindingIsNamed()
    {
        string Run(string line) { var value = ScreenHtml.Run(line, out var expression, out var fault); Assert.Null(fault); Assert.True(expression, line); return value; }
        Assert.Equal("\"Hoje · \" + FormatDateTime(ResumoAtual.Dia.Data,\"dd/MM/yyyy\")", Run("Hoje · {{ FormatDateTime(ResumoAtual.Dia.Data,\"dd/MM/yyyy\") }}"));
        Assert.Equal("\"de \" + FormatarDuracao(EspelhoMes.MinutosPrevistosMes,False)", Run("de {{ FormatarDuracao(EspelhoMes.MinutosPrevistosMes,False) }}"));
        Assert.Equal("IntegerToText(EspelhoMes.DiasPendentes) + \" dias pendentes\"", Run("{{ IntegerToText(EspelhoMes.DiasPendentes) }} dias pendentes"));
        Assert.Equal("A + \" e \" + B", Run("{{ A }} e {{ B }}"));
        Assert.Equal("\"Total: \" + (A + B)", Run("Total: {{ A + B }}"));
        Assert.Equal("\"Diga \"\"oi\"\" \" + Nome", Run("Diga \"oi\" {{ Nome }}"));
        // The reading's own form is its value exactly (spaces inside kept); a string or a record literal does not close it.
        Assert.Equal("X", Run("{{ X }}"));
        Assert.Equal(" X", Run("{{  X }}"));
        Assert.Equal("\"}} {{\"", Run("{{ \"}} {{\" }}"));
        Assert.Equal("{ A: { B: 1 }}", Run("{{ { A: { B: 1 }} }}"));
        Assert.Equal("X", Run("{{X}}"));
        foreach (var malformed in new[] { "Total {{ X", "a }} b", "{{ }}", "x {{ }} y" })
        {
            var value = ScreenHtml.Run(malformed, out var expression, out var fault);
            Assert.False(expression, malformed);
            Assert.Equal(malformed, value);
            Assert.NotNull(fault);
        }
        Assert.Equal("Hoje", ScreenHtml.Run("Hoje", out var plain, out var none));
        Assert.False(plain); Assert.Null(none);
        // An attribute: the same rule; a literal with a brace pair is written as an expression, so it reads back the same.
        Assert.Equal("\"fp-day \" + If(Hoje, \"fp-day-today\", \"\")", ScreenHtml.Unsugar("fp-day {{ If(Hoje, \"fp-day-today\", \"\") }}"));
        Assert.Equal("\"a \"\"b\"\"\"", ScreenHtml.Unsugar("a \"b\""));
        Assert.Equal("{{ \"a {{ b\" }}", ScreenHtml.Sugar("\"a {{ b\""));
        Assert.Equal("\"a {{ b\"", ScreenHtml.Unsugar(ScreenHtml.Sugar("\"a {{ b\"")));
        Assert.False(ScreenHtml.PlainRun("a }} b"));
    }

    [Fact]
    public void TwoBindingsSideBySideAreJoinedNeverAdded()
    {
        // The review of 1d3caa80, proof A: "{{ 1 }}{{ 2 }} itens" was 1 + 2 + " itens", a page showing "3 itens" where the
        // document says "12 itens". The empty text first makes every + a join.
        string Run(string line) { var value = ScreenHtml.Run(line, out var expression, out var fault); Assert.Null(fault); Assert.True(expression, line); return value; }
        Assert.Equal("\"\" + 1 + 2 + \" itens\"", Run("{{ 1 }}{{ 2 }} itens"));
        Assert.Equal("\"\" + Horas + Minutos + \" h\"", Run("{{ Horas }}{{ Minutos }} h"));
        Assert.Equal("\"\" + A + B", Run("{{ A }}{{ B }}"));
        Assert.Equal("\"\" + A + (B + 1) + C", Run("{{ A }}{{ B + 1 }}{{ C }}"));
        Assert.Equal("\"\" + A + B", ScreenHtml.Unsugar("{{ A }}{{ B }}"));
        // Text first, or text between them: already a join, written as before.
        Assert.Equal("\"x \" + A + B", Run("x {{ A }}{{ B }}"));
        Assert.Equal("A + \" \" + B", Run("{{ A }} {{ B }}"));
        Assert.Equal("A + \" itens\"", Run("{{ A }} itens"));
        // The reading writes the Expression back as {{ value }}: the same value again (the fixed point).
        var value = Run("{{ 1 }}{{ 2 }} itens");
        Assert.Equal(value, Run(ScreenHtml.Sugar(value)));
    }

    [Fact]
    public void ABindingThatIsNoBindingInAnyAttributeWrittenAsTextIsInTheFirstRefusalOnce()
    {
        // The review of 1d3caa80, proofs B and B3: data-z="a }} b" and aria-label="x {{ 1" came only from the compile, after a
        // first refusal with everything else. The preflight now checks every attribute the compile writes as text with its
        // bindings joined (ExtendedName, the compile's own rule), with the same problem the compile builds (reported once).
        var html = "<screen name=\"Attrs\">\n<var name=\"N\" type=\"Integer\"/>\n<div>Total {{ N</div>\n"
            + "<div data-z=\"a }} b\">z</div>\n<div aria-label=\"x {{ 1\">a</div>\n<span ext:title=\"{{ }}\">t</span>\n<span class=\"x {{ y\">c</span>\n"
            + "<div data-ok=\"v {{ N }} x\" title=\"{{ N }}{{ N }}\" onclick=\"Save\">ok</div>\n</screen>";
        var refusal = Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(html, "/data/html"));
        var messages = refusal.Problems!.Select(p => (Code: p!["code"]!.ToString(), Message: p["message"]!.ToString())).ToList();
        Assert.All(messages, m => Assert.Equal("HTML_BINDING_INVALID", m.Code));
        Assert.Equal(5, messages.Count);
        foreach (var said in new[] { "Total {{ N", "data-z=\"a }} b\"", "aria-label=\"x {{ 1\"", "ext:title=\"{{ }}\"", "class=\"x {{ y\"" })
            Assert.Single(messages, m => m.Message.Contains(said, StringComparison.Ordinal));
        Assert.DoesNotContain(messages, m => m.Message.Contains("data-ok", StringComparison.Ordinal) || m.Message.Contains("onclick", StringComparison.Ordinal));

        // The rule itself: what each attribute writes on a Container (div), an HTML element (span) and a data element.
        var div = ScreenHtmlTables.Reverse("Container", ScreenHtmlModuleMode.Widget);
        Assert.Equal("data-z", ScreenDocument.ExtendedName("data-z", div, widget: true));
        Assert.Equal("title", ScreenDocument.ExtendedName("ext:title", div, widget: true));
        foreach (var other in new[] { "class", "id", "style", "onclick", "onclick.Id", ":Arg", "@Event", "html:onx", "os-Style", "os-onclick.Id" })
            Assert.Null(ScreenDocument.ExtendedName(other, div, widget: true));
        Assert.Equal("class", ScreenDocument.ExtendedName("class", ScreenHtmlTables.Reverse("AdvancedHtml", ScreenHtmlModuleMode.Widget), widget: true));
        var data = ScreenHtmlTables.Reverse("LocalVariable", ScreenHtmlModuleMode.Data);
        Assert.Null(ScreenDocument.ExtendedName("data-z", data, widget: false));
        Assert.Equal("z", ScreenDocument.ExtendedName("ext:z", data, widget: false));

        // Nothing of the elements the compile writes no attribute of: a <style>, a <text>, an os-opaque, a script.
        var top = ScreenHtml.Parse("<screen name=\"S\" flow=\"MainFlow\"><style media=\"x\">.a{}</style><text>{{ x }}</text><os-opaque kind=\"T\" k=\"1\" data-z=\"}}\"/>"
            + "<Block name=\"L\"><slot name=\"Content\" data-s=\"1\"><div data-in=\"2\"/></slot></Block><div if=\"X\"/><div else=\"\"><a data-e=\"3\"/></div></screen>").Children[0];
        Assert.Equal(["screen", "Block", "slot", "div", "div", "a"], ScreenDocument.FactElements(top).Select(f => f.Node.Tag));
    }

    [Fact]
    public void EveryStyleIsPlacedAndWhatCannotBeComesInTheOneRefusalWithTheCheckedPatch()
    {
        var html = "<screen name=\"Css\">\n<style>.a{color:red}</style>\n<div class=\"a\">\n <style>.b{color:color-mix(in srgb, #ff0000 50%, #0000ff)}</style>\n"
            + " <p>Total {{ Itens</p>\n <p>{{  }}</p>\n <expr/>\n <span class=\"x {{ y\">z</span>\n</div>\n<style media=\"print\">.c{display:none}</style>\n</screen>";
        var refusal = Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(html, "/data/html", ".d{color:light-dark(#000, #fff)}"));
        var problems = refusal.Problems!.Select(p => p!.AsObject()).ToList();
        Assert.Equal(["CSS_FUNCTION_UNSUPPORTED", "CSS_FUNCTION_UNSUPPORTED", "HTML_BINDING_INVALID", "HTML_BINDING_INVALID", "HTML_EXPRESSION_EMPTY", "HTML_EXPRESSION_EMPTY", "HTML_STYLE_UNPLACED"],
            problems.Select(p => p["code"]!.ToString()).Order());
        Assert.Single(problems, p => p["pointer"]!.ToString() == "/data/css");
        // One patch for every correction: the document without the print <style> and with the mixed color written out, and
        // data.css with light-dark() expanded and the print rules as their @media block at its end.
        var patch = problems.First(p => p["code"]!.ToString() == "HTML_STYLE_UNPLACED")["patch"]!.AsArray();
        Assert.All(problems.Where(p => p["patch"] is JsonArray), p => Assert.Equal(patch.ToJsonString(), p["patch"]!.ToJsonString()));
        var corrected = patch.Single(o => o!["path"]!.ToString() == "/data/html")!["value"]!.ToString();
        var css = patch.Single(o => o!["path"]!.ToString() == "/data/css")!["value"]!.ToString();
        Assert.DoesNotContain("media=", corrected);
        Assert.DoesNotContain("color-mix", corrected);
        Assert.Contains("@media print {\n.c{display:none}\n}", css);
        Assert.DoesNotContain("light-dark", css);
        // What nothing corrects stays: the bindings and the empty expressions; no CSS problem is left.
        var again = Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(corrected, "/data/html", css)).Problems!.Select(p => p!["code"]!.ToString()).Order().ToList();
        Assert.Equal(["HTML_BINDING_INVALID", "HTML_BINDING_INVALID", "HTML_EXPRESSION_EMPTY", "HTML_EXPRESSION_EMPTY"], again);
        // Placed: the root's <style>, the nested one and data.css, in that order, each as written.
        var top = ScreenHtml.Parse("<screen name=\"S\"><style>.a{}</style><div><style>.b{}</style></div><style scope=\"theme\">.t{}</style><style type=\"text/css\" id=\"x\">.c{}</style></screen>").Children[0];
        var blocks = ScreenDocument.Styles(top);
        Assert.Equal(".a{}\n.b{}\n.c{}\n.d{}", ScreenDocument.OwnSheet(blocks, ".d{}"));
        Assert.Equal(".t{}", ScreenDocument.ThemeSheet(blocks));
        Assert.Equal([false, true, false, false], blocks.Select(b => b.Nested));
        Assert.Equal(".only{ }", ScreenDocument.OwnSheet(ScreenDocument.Styles(ScreenHtml.Parse("<screen name=\"S\"><style>.only{ }</style></screen>").Children[0]), null));
    }

    [Fact]
    public void TheClassesOfAPageAreTheWordsOfItsClassesAndTheRulesOfAStylesheetAreItsSelectors()
    {
        var top = ScreenHtml.Parse("<screen name=\"S\"><div class=\"a b\"><span class='{{ If(X, \"c d\", \"e\") }}'/><Block name=\"B\" :ExtendedClass='\"f\"'/></div><p class=\"g {{ If(Y, &quot;h&quot;, &quot;&quot;) }}\"/>"
            + "<i class='{{ \"bb-\" + ToLower(B) + \" ok\" }}'/></screen>").Children[0];
        // "bb-" is the start of a class the page computes, not a class.
        Assert.Equal(["a", "b", "c", "d", "e", "f", "g", "h", "ok"], ScreenDocument.UsedClasses(top).Select(u => u.Class));
        var classes = ScreenDocument.CssClasses("/* .no */ .a .b > .c:hover, .md\\:flex{background:url(x.png) .5em; content:\".q\"} @media(min-width:1px){.d{}} @keyframes k{from{}to{}}");
        Assert.Equal(["a", "b", "c", "d", "md:flex"], classes.Order(StringComparer.Ordinal));
        Assert.True(ScreenDocument.OutSystemsUiClass("btn"));
        Assert.True(ScreenDocument.OutSystemsUiClass("margin-top-m"));
        Assert.True(ScreenDocument.OutSystemsUiClass("fa-eye"));
        Assert.False(ScreenDocument.OutSystemsUiClass("fp-app"));
    }

    [Fact]
    public void TheOwnersPageKeepsItsStylesItsJoinedBindingsAndReadsBackAtTheFixedPoint()
    {
        if (!StudioAvailable()) return;
        // The shape of the FolhaPonto_UI documents of 2026-10-12 over the reactive fixture: the CSS in a <style> of the screen
        // (and one nested, and data.css), lines of text with bindings, classes by expression.
        var html = "<screen name=\"Ponto\" roles=\"Registered\">\n<var name=\"Data\" type=\"Date\"/>\n<var name=\"Pendentes\" type=\"Integer\"/>\n<var name=\"Feito\" type=\"Boolean\"/>\n"
            + "<Block name=\"LayoutBlank\"><slot name=\"Content\"><div class=\"fp-app\"><style>.fp-row{display:flex}</style>\n"
            + "<div class=\"fp-section-title\">Hoje · {{ FormatDateTime(Data,\"dd/MM/yyyy\") }}</div>\n"
            + "<div class=\"fp-caption\">{{ IntegerToText(Pendentes) }} dias pendentes</div>\n"
            + "<div class='{{ If(Feito, \"fp-row fp-done\", \"fp-row\") }}'>de {{ IntegerToText(Pendentes + 1) }}</div>\n"
            + "<div class=\"fp-caption\">{{ Pendentes }}{{ Pendentes }} itens</div>\n"
            + "<div class=\"zz-sem-regra btn\">x</div>\n"
            + "</div></slot></Block><style>\n.fp-app{max-width:402px}\n.fp-section-title{font-size:11px}</style></screen>";
        var dir = Path.Combine(Work, "fidelity");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "job.json");
        File.WriteAllText(path, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = new JsonArray(new JsonObject { ["op"] = "html",
            ["data"] = new JsonObject { ["html"] = html, ["css"] = ".fp-caption{opacity:.8}\n.fp-done{font-weight:600}" } }) }.ToJsonString());
        var host = Host("fidelity");
        var output = Path.Combine(dir, "out.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, path, output))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        var report = result["results"]!.AsArray().Select(r => r!["result"]!).First(r => r["form"]?.ToString() == "document").AsObject();
        Assert.Equal(4, report["bindingsJoined"]!.GetValue<int>());
        Assert.Equal(2, report["styleSheet"]!["blocks"]!.GetValue<int>());
        Assert.Equal(1, report["styleSheet"]!["nested"]!.GetValue<int>());
        Assert.True(report["styleSheet"]!["dataCss"]!.GetValue<bool>());
        // Only the class no rule defines is named (btn is OutSystems UI's), in the op's report and in the delivery's warnings.
        Assert.Equal(["zz-sem-regra"], report["classesWithoutRule"]!["classes"]!.AsArray().Select(c => c!["class"]!.ToString()));
        Assert.Contains(result["highWarnings"]!.AsArray(), w => w!["code"]!.ToString() == "HTML_CLASS_NO_RULE" && w["message"]!.ToString().Contains("zz-sem-regra", StringComparison.Ordinal));

        var bytes = File.ReadAllBytes(output);
        var text = host.HtmlRead(bytes, "MobileScreen:Ponto", withKeys: false)["documents"]![0]!["html"]!.ToString();
        Assert.Contains("<style>.fp-row{display:flex}\n\n.fp-app{max-width:402px}\n.fp-section-title{font-size:11px}\n.fp-caption{opacity:.8}\n.fp-done{font-weight:600}</style>", text);
        Assert.Contains("{{ \"Hoje · \" + FormatDateTime(Data,\"dd/MM/yyyy\") }}", text);
        Assert.Contains("{{ IntegerToText(Pendentes) + \" dias pendentes\" }}", text);
        Assert.Contains("{{ \"de \" + IntegerToText(Pendentes + 1) }}", text);
        // Two bindings side by side are joined, never added (the Verify takes Text + Integer).
        Assert.Contains("{{ \"\" + Pendentes + Pendentes + \" itens\" }}", text);
        Assert.DoesNotContain("Hoje · {{", text);
        var check = host.HtmlCheck(bytes)["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == "Ponto")!;
        Assert.Equal(0, check["ops"]!.GetValue<int>());
        Assert.Equal(0, check["problemCount"]!.GetValue<int>());
    }

    [Fact]
    public void AStyleForTheThemeGoesToTheThemeAndADocumentWithBracesThatAreNoBindingsWritesNothing()
    {
        if (!StudioAvailable()) return;
        var host = Host("fidelity-theme");
        var themed = "<screen name=\"Temado\" roles=\"Registered\">\n<style scope=\"theme\">.tm-card{padding:8px}</style>\n<Block name=\"LayoutBlank\"><slot name=\"Content\"><div class=\"tm-card\">x</div></slot></Block>\n</screen>";
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, DocumentJob(themed, "fidelity-theme"), Path.Combine(Work, "fidelity-theme", "out.oml")))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        var report = result["results"]!.AsArray().Select(r => r!["result"]!).First(r => r["form"]?.ToString() == "document").AsObject();
        Assert.True(report["styleSheet"]!["theme"]!["installed"]!.GetValue<bool>());
        Assert.Equal("/* anvil:html Temado */", report["styleSheet"]!["theme"]!["marker"]!.ToString());
        Assert.Null(report["classesWithoutRule"]);   // tm-card is in the theme now
        Assert.DoesNotContain("<style>", host.HtmlRead(File.ReadAllBytes(Path.Combine(Work, "fidelity-theme", "out.oml")), "MobileScreen:Temado", withKeys: false)["documents"]![0]!["html"]!.ToString());

        var broken = "<screen name=\"Quebrado\" roles=\"Registered\">\n<var name=\"N\" type=\"Integer\"/>\n<Block name=\"LayoutBlank\"><slot name=\"Content\">\n"
            + "<p>Total {{ N</p>\n<p>{{  }}</p>\n<expr/>\n<span aria-label=\"x {{ N\">y</span>\n<div data-z=\"a }} b\">w</div>\n</slot></Block>\n</screen>";
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, null, DocumentJob(broken, "fidelity-broken"), Path.Combine(Work, "fidelity-broken", "out.oml")));
        var compiled = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).Select(p => p!["code"]!.ToString() + " " + p["message"]!.ToString()).Order(StringComparer.Ordinal).ToList();
        Assert.Equal(["HTML_BINDING_INVALID", "HTML_BINDING_INVALID", "HTML_BINDING_INVALID", "HTML_EXPRESSION_EMPTY", "HTML_EXPRESSION_EMPTY"], compiled.Select(c => c[..c.IndexOf(' ')]));
        // The preflight (no module) refuses the same problems, so the first refusal already has them all (the review of
        // 1d3caa80: aria-label and data-z came only in a second refusal), and the compile reports each attribute once.
        var preflight = Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(broken, "/data/html")).Problems!
            .Select(p => p!["code"]!.ToString() + " " + p["message"]!.ToString()).Order(StringComparer.Ordinal).ToList();
        Assert.Equal(preflight, compiled);
    }

    // A job of one document op over the reactive fixture.
    private static string DocumentJob(string html, string name)
    {
        var dir = Path.Combine(Work, name);
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "job.json");
        File.WriteAllText(path, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = new JsonArray(Op(html)) }.ToJsonString());
        return path;
    }

    // ---- helpers ---------------------------------------------------------------------------------------------------

    private static JsonObject Op(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };

    private static ElementMapping Map(string element)
    {
        var node = HtmlSource.Parse(element).Elements.First();
        return ElementWidgetMap.Map(ElementWidgetMap.O11, node, clickable: false);
    }

    private static string Job(string html, string logic, bool spec = true)
    {
        var ops = new JsonArray();
        if (spec) ops.Add(JsonNode.Parse(Spec));
        ops.Add(Op(html));
        ops.Add(JsonNode.Parse(logic));
        var job = new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = ops };
        var dir = Path.Combine(Work, Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "job.json");
        File.WriteAllText(path, job.ToJsonString());
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
