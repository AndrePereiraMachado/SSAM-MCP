using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// F5 (2026-10-25): the Traditional document of a migration, from the NWLoanPortal_TW chain (23/10 01:01Z, 10 rounds) and the
/// HTML_TRADITIONAL receipts (125 problems in 10): what HTML writes under another name is written as the Traditional widget
/// that renders it and listed in migration.adapted/dropped (Traditional → read again → what was expected); what has no widget is
/// refused before the build, every document in one refusal, each problem with the tag to write instead; a link or a block
/// instance may name a root a later document of the same job creates; a root the job created empty is filled by its document.
/// </summary>
public class TraditionalHtmlMigrationTests(ITestOutputHelper output)
{
    private static string Root => JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalHtmlMigrationTests).Assembly.Location)!)!;
    private static string Basis => Path.Combine(Root, "tests", "fixtures", "traditional-ui.oml");

    private (ModelHost Host, string Work) Workspace(string name)
    {
        StudioAssemblies.Bind();
        var work = Path.Combine(Root, ".local", "traditional-html-migration", name + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work); output.WriteLine(work);
        return (new ModelHost(Path.Combine(work, "model")), work);
    }

    private static JsonNode Run(ModelHost host, string work, string basis, JsonArray ops, string name)
    {
        var job = Path.Combine(work, name + ".json");
        File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, Path.Combine(work, name + ".oml")))!;
        File.WriteAllText(Path.Combine(work, name + "-result.json"), result.ToJsonString());
        return result;
    }

    private static JsonObject Html(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };
    private static JsonObject Flow(string text) => new() { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = text } };

    [Fact]
    public void KnownHtmlIsWrittenAsItsTraditionalWidgetsAndTheReceiptSaysWhat()
    {
        var (host, work) = Workspace("adapt");
        var screen = """
          <screen name="MigratedLoans" roles="Registered" actions="Search,Open">
           <var name="Choices" type="Choice List"/>
           <var name="Picked" type="Integer"/>
           <var name="PickedToo" type="Integer"/>
           <var name="Kind" type="Text" default='"a"'/>
           <var name="Row" type="Choice"/>
           <var name="Count" type="Integer"/>
           <section class="loans">
            <h2 class="title">Empréstimos</h2>
            <p>Somente <strong>ativos</strong> <i icon="calendar" size="2"/></p>
            <div title="Painel">{{ Count }}</div>
            <table class="grid" list="Choices">
             <thead><tr><th>Nome</th><th>Id</th></tr></thead>
             <tbody><tr><td>{{ Choices.Current.Name }}</td><td>{{ Choices.Current.Id }}</td></tr></tbody>
            </table>
            <form id="RowForm" os-SourceRecord="Row" os-Editable="True">
             <select id="ByName" bind="Picked" options="Choices" label="Name" value="Choices.Current.Id" onchange="Search" os-onchange.Method="Ajax"/>
             <select id="ByParent" bind="PickedToo" options="Choices" os-SourceAttributeParent="Choice.Name" os-SourceIdentifierAttributeParent="Choice.Id" os-SourceAttributeRecord="Choice" os-SourceIdentifierAttributeRecord="Choice"/>
             <radio bind="Kind" value='"a"'/>
             <radio bind="Kind" value='"b"'/>
            </form>
            <a id="OpenLink" onclick="Open" title="Abrir" if="Count > 0" enabled="Count > 1">Abrir</a>
            <button id="SearchButton" onclick="Search"><i icon="search"/> Buscar</button>
           </section>
          </screen>
          """;
        var result = Run(host, work, Basis, new JsonArray(
            JsonNode.Parse("""{"op":"spec","data":{"structures":[{"name":"Choice","attributes":[{"name":"Id","type":"Integer"},{"name":"Name","type":"Text"}]}]}}"""),
            Html(screen),
            Flow("action MigratedLoans.Search\n  assign Count = Count + 1\n  end\n"),
            Flow("action MigratedLoans.Open\n  assign Count = 0\n  end\n")), "adapt");
        Assert.True(result["accepted"]?.GetValue<bool>() == true, work + "\n" + result);
        var migration = result["results"]!.AsArray().Select(r => r?["result"]?["migration"]).OfType<JsonObject>().Single();
        var adapted = migration["adapted"]!.AsArray().Select(a => a!["from"]!.ToString() + " -> " + a["to"]).ToList();
        output.WriteLine(string.Join("\n", adapted));
        foreach (var from in new[] { "<section>", "<h2>", "<p>", "<strong>", "<i icon=\"calendar\">", "<th>", "<thead>", "<tbody>", "<table list=\"Choices\">",
                     "os-Editable=\"True\"", "os-SourceRecord=\"Row\"", "os-SourceAttributeParent=\"Choice.Name\"", "os-onchange.Method=\"Ajax\"", "<radio>", "<button> with elements", "label=\"Name\"", "value=\"Choices.Current.Id\"", "value=\"Id\"" })
            Assert.Contains(adapted, a => a.StartsWith(from, StringComparison.Ordinal));
        Assert.Contains(migration["dropped"]!.AsArray(), d => d!["from"]!.ToString() == "size=\"2\"");
        // read again: the widgets the receipt names
        var html = host.HtmlRead(File.ReadAllBytes(Path.Combine(work, "adapt.oml")), "MigratedLoans")["documents"]![0]!["html"]!.ToString();
        File.WriteAllText(Path.Combine(work, "read.html"), html);
        Assert.Contains("<table-records", html);
        Assert.Contains("fa fa-calendar", html);
        Assert.Contains("title=\"Painel\"", html);
        Assert.Contains("radio-input", html);
        // the reader's form of a record-list Combo Box: the field and its record
        Assert.Equal(2, System.Text.RegularExpressions.Regex.Matches(html, "os-SourceAttributeParent=\"StructureAttribute:Name\" os-SourceAttributeRecord=\"Choice\"").Count);
        Assert.Equal(2, System.Text.RegularExpressions.Regex.Matches(html, "os-SourceIdentifierAttributeParent=\"StructureAttribute:Id\" os-SourceIdentifierAttributeRecord=\"Choice\"").Count);
        Assert.Contains("class=\"Button\"", html);
        Assert.Contains("onclick=\"Open\"", html);
        Assert.DoesNotContain("os-opaque", html);
    }

    [Fact]
    public void TheReadingOfATraditionalScreenIsWritableAgainAndReadsTheSame()
    {
        // b0b90315: Traditional -> reading -> a new document from that reading -> reading again, equal (selects with record
        // lists, radios, the If around a link, the link button, the table records and the extended title included).
        var (host, work) = Workspace("roundtrip");
        var spec = JsonNode.Parse("""{"op":"spec","data":{"structures":[{"name":"Choice","attributes":[{"name":"Id","type":"Integer"},{"name":"Name","type":"Text"}]}]}}""")!;
        var original = """
          <screen name='Original' roles='Registered' actions='Go'><var name='Choices' type='Choice List'/><var name='Picked' type='Integer'/><var name='Kind' type='Text'/><var name='Count' type='Integer'/>
          <div class='box' title='Caixa'><label for='Pick'>{{ "Escolha " + IntegerToText(Count) }}</label><label for='Pick'>Fixo</label><select id='Pick' bind='Picked' options='Choices' label='Choice.Name' value='Choice.Id' empty='"Nenhum"' onchange='Go'/>
          <radio-input bind='Kind' value='"a"'/><a id='GoLink' onclick='Go' if='Count > 0' title='Ir'>Ir</a>
          <table-records id='Grid' source='Choices'><tr><td>Nome</td></tr><tr><td>{{ Choices.Current.Name }}</td></tr></table-records></div></screen>
          """;
        var first = Run(host, work, Basis, new JsonArray(spec.DeepClone(), Html(original), Flow("action Original.Go\n  assign Count = Count + 1\n  end\n")), "first");
        Assert.True(first["accepted"]?.GetValue<bool>() == true, work + "\n" + first);
        var read = host.HtmlRead(File.ReadAllBytes(Path.Combine(work, "first.oml")), "Original", withKeys: false)["documents"]![0]!["html"]!.ToString();
        // 9a7b8588: the runtime shows the Label's Value: a literal caption is its Value too, an expression caption only its Value
        Assert.Contains("os-Value='\"Fixo\"'", read);
        Assert.Contains("os-Value='\"Escolha \" + IntegerToText(Count)'", read);
        var again = Run(host, work, Path.Combine(work, "first.oml"), new JsonArray(
            Html(read.Replace("name=\"Original\"", "name=\"Copied\"")), Flow("action Copied.Go\n  assign Count = Count + 1\n  end\n")), "again");
        Assert.True(again["accepted"]?.GetValue<bool>() == true, work + "\n" + again);
        var copied = host.HtmlRead(File.ReadAllBytes(Path.Combine(work, "again.oml")), "Copied", withKeys: false)["documents"]![0]!["html"]!.ToString();
        File.WriteAllText(Path.Combine(work, "read.html"), read + "\n" + copied);
        static string Body(string html) => System.Text.RegularExpressions.Regex.Replace(html, @"id=""[A-Za-z]+\d*""", "id").Replace("\"Copied\"", "\"Original\"");
        Assert.Equal(Body(read), Body(copied));
    }

    [Fact]
    public void WhatHasNoTraditionalWidgetIsRefusedBeforeTheBuildEveryDocumentAtOnce()
    {
        var (host, work) = Workspace("refuse");
        var ops = new JsonArray(
            JsonNode.Parse("""{"op":"spec","data":{"structures":[{"name":"Pick","attributes":[{"name":"Id","type":"Integer"},{"name":"Name","type":"Text"}]}]}}"""),
            Html("<screen name='RefusedOne' roles='Registered'><var name='Value' type='Integer'/><pre>a  b</pre><select bind='Value' os-SpecialOptions='[{\"label\":\"A\",\"value\":\"1\"}]'/><placeholder name='Content'/></screen>"),
            Html("<screen name='RefusedTwo' roles='Registered'><var name='Value' type='Integer'/><select bind='Value' label='Name' source-entity='User'/><input bind='Value' os-onchange.Method='Submit'/><var name='Picks' type='Pick List'/><var name='Other' type='Integer'/><select bind='Other' options='Picks' label='Pick.Name' value='Pick.Id' os-SourceEntity='User'/></screen>"));
        var job = Path.Combine(work, "refuse.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, Basis, job, Path.Combine(work, "refuse.oml")));
        var problems = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).OfType<JsonObject>().ToList();
        File.WriteAllText(Path.Combine(work, "refuse-problems.json"), new JsonArray(problems.Select(p => (JsonNode)p.DeepClone()).ToArray()).ToJsonString());
        var traditional = problems.Where(p => p["code"]?.ToString() == ScreenDocument.Traditional).ToList();
        Assert.True(traditional.Count >= 5, string.Join("\n", problems.Select(p => p.ToJsonString())));
        // both documents in the one refusal, before any op was applied, each with what to write instead
        Assert.Contains(traditional, p => p["op"]?.GetValue<int>() == 1 && p["message"]!.ToString().Contains("<pre>") && p["fix"]!.ToString().Contains("white-space: pre"));
        Assert.Contains(traditional, p => p["op"]?.GetValue<int>() == 1 && p["message"]!.ToString().Contains("without options or source-entity"));
        Assert.Contains(traditional, p => p["op"]?.GetValue<int>() == 1 && p["message"]!.ToString().Contains("<placeholder>") && p["fix"]!.ToString().Contains("slot"));
        Assert.Contains(traditional, p => p["op"]?.GetValue<int>() == 2 && p["message"]!.ToString().Contains("label=\"Name\" without options"));
        Assert.Contains(traditional, p => p["op"]?.GetValue<int>() == 2 && p["message"]!.ToString().Contains("os-onchange.Method"));
        Assert.Contains(traditional, p => p["op"]?.GetValue<int>() == 2 && p["message"]!.ToString().Contains("with options and source-entity"));
        // the base phase (before the build) already reads both documents; the diagnosis apply only says the same lines again
        Assert.Contains(traditional, p => p["op"]?.GetValue<int>() == 1 && p["phase"]?.ToString() == "base");
        Assert.Contains(traditional, p => p["op"]?.GetValue<int>() == 2 && p["phase"]?.ToString() == "base");
        Assert.DoesNotContain(problems, p => p["phase"]?.ToString() == "verify");
        Assert.All(traditional, p => Assert.NotEqual(TraditionalDocumentRules.Supported, p["fix"]?.ToString()));
    }

    [Fact]
    public void DocumentsOfOneJobNavigateBothWaysAndUseABlockDeclaredLater()
    {
        var (host, work) = Workspace("mutual");
        var result = Run(host, work, Basis, new JsonArray(
            Html("<screen name='LoanList' roles='Registered'><var name='Active' type='Text' default='\"list\"'/><Block name='LoanMenu' :Active='Active'/><a id='ToDetail' onclick='LoanDetail(LoanId = 7)'>Detalhe</a></screen>"),
            Html("<screen name='LoanDetail' roles='Registered'><input name='LoanId' type='Integer' mandatory='True'/><span>{{ LoanId }}</span><a id='BackToList' onclick='LoanList'>Voltar</a></screen>"),
            Html("<block name='LoanMenu'><input name='Active' type='Text'/><div class='menu'>{{ Active }}</div><placeholder name='Extra'/></block>")), "mutual");
        Assert.True(result["accepted"]?.GetValue<bool>() == true, work + "\n" + result);
        var bytes = File.ReadAllBytes(Path.Combine(work, "mutual.oml"));
        var list = host.HtmlRead(bytes, "LoanList")["documents"]![0]!["html"]!.ToString();
        var detail = host.HtmlRead(bytes, "LoanDetail")["documents"]![0]!["html"]!.ToString();
        var menu = host.HtmlRead(bytes, "LoanMenu")["documents"]![0]!["html"]!.ToString();
        File.WriteAllText(Path.Combine(work, "read.html"), list + "\n" + detail + "\n" + menu);
        Assert.Contains("LoanDetail(LoanId = 7)", list);
        Assert.Matches("<Block[^>]* name=\"LoanMenu\"", list);
        Assert.Contains("onclick=\"LoanList\"", detail);
        Assert.Contains("name=\"LoanId\"", detail);
        Assert.Contains("placeholder", menu);
        // one root each: the later documents filled the shells the earlier one made
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(string.Join(" ", result["results"]!.AsArray().Select(r => r?["result"]?["root"]?.ToString())), "LoanDetail"));
    }

    [Fact]
    public void ARootTheJobCreatedEmptyIsFilledByItsDocumentAndAnyOtherIsStillRefused()
    {
        var (host, work) = Workspace("filled");
        var result = Run(host, work, Basis, new JsonArray(
            JsonNode.Parse("""{"op":"create","parent":"IWebFlow:MainFlow","type":"IWebScreen","name":"Declared"}"""),
            Html("<screen name='Declared' roles='Registered'><var name='Note' type='Text'/><div class='note'>{{ Note }}</div></screen>")), "filled");
        Assert.True(result["accepted"]?.GetValue<bool>() == true, work + "\n" + result);
        Assert.Contains("class=\"note\"", host.HtmlRead(File.ReadAllBytes(Path.Combine(work, "filled.oml")), "Declared")["documents"]![0]!["html"]!.ToString());
        // a root of the base (not made by this job) keeps the refusal: it is the reading's to edit
        var again = Path.Combine(work, "again.json");
        File.WriteAllText(again, new JsonObject { ["ops"] = new JsonArray(Html("<screen name='Declared' roles='Registered'><div>x</div></screen>")) }.ToJsonString());
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, Path.Combine(work, "filled.oml"), again, Path.Combine(work, "again.oml")));
        Assert.Contains("'Declared' already exists", Errors.Text(error));
    }

    /// <summary>The proto refused a prototype into a Traditional module with PROTOTYPE_MODULE_KIND (7678b4c3); the line turned
    /// the prototype import off in every module (714a3369, PrototypeImport): a whole job with a prototype op beside a
    /// Traditional document, with or without a binding, is ONE refusal, PROTOTYPE_IMPORT_DISABLED, before anything ran (no other
    /// problem of the document is reported, no module is written).</summary>
    [Fact]
    public void APrototypeOpInATraditionalModuleIsTheOneImportDisabledRefusal()
    {
        var (host, work) = Workspace("prototype");
        foreach (var bind in new[] { false, true })
        {
            var data = new JsonObject { ["source"] = "C:\\proto" };
            if (bind) data["bind"] = new JsonObject { ["producer"] = "Loans_CS" };
            var ops = new JsonArray(new JsonObject { ["op"] = "prototype", ["data"] = data },
                Html("<screen name='Beside' roles='Registered'><pre>a</pre></screen>"));
            var job = Path.Combine(work, "prototype-" + bind + ".json");
            File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
            var output = Path.Combine(work, "prototype-" + bind + ".oml");
            var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, Basis, job, output));
            var coded = Errors.FindCoded(error);
            Assert.Equal(PrototypeImport.DisabledCode, coded?.Code);
            var problems = (coded?.Problems ?? new JsonArray()).OfType<JsonObject>().ToList();
            var problem = Assert.Single(problems);
            Assert.Equal(PrototypeImport.DisabledCode, problem["code"]!.ToString());
            Assert.Equal(0, problem["op"]!.GetValue<int>());
            Assert.DoesNotContain("PROTOTYPE_MODULE_KIND", Errors.Text(error));
            Assert.False(File.Exists(output));
        }
    }
}
