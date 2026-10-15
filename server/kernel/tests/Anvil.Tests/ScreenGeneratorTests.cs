using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>Screens from entities and blocks (gen-screen/1, ScreenGenerator): the planner over a module described by hand (no
/// Studio): the family rules (a list as a table with paging, search, filters, sort and states; a detail table; a typed form),
/// the reads and writes found by signature, the blocks found by signature or created once, the owner's rules on every
/// generated document, the gaps and refusals, and the same request over the module it produced being NO_CHANGE. With the
/// Service Studio: the proof job on the reactive fixture, the C1 fixed point of every generated root, the second run, and the
/// offline render of the list (a table, never cards).</summary>
public sealed class ScreenGeneratorTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenGeneratorTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "screen-generator-tests");

    // ---- a module by hand ------------------------------------------------------------------------------------------------
    private static GenEntity Status => new("CustomerStatus", null, true, "Id", "CustomerStatus Identifier",
        [new("Id", "Integer", true), new("Label", "Text", false, 50), new("Order", "Integer")], false, "Label", "Order");
    private static GenEntity Company => new("Company", null, false, "Id", "Company Identifier",
        [new("Id", "Long Integer", true, 0, true), new("Name", "Text", true, 100), new("Website", "Text", false, 200)], true);
    private static GenEntity Customer(string? producer = null, bool writable = true) => new("Customer", producer, false, "Id", "Customer Identifier",
        [new("Id", "Long Integer", true, 0, true), new("Name", "Text", true, 100), new("Email", "Email", false, 250), new("StatusId", "CustomerStatus Identifier", true, 0, false, "CustomerStatus"),
         new("CompanyId", "Company Identifier", false, 0, false, "Company"), new("BirthDate", "Date"), new("IsVip", "Boolean"), new("Notes", "Text", false, 2000)], writable);
    private static GenBlock Layout => new("LayoutTopMenu", "MobileBlock:LayoutTopMenu", null, [], [], ["Header", "Breadcrumbs", "Title", "Actions", "MainContent", "Footer"]);

    private static GenModule Module(IEnumerable<GenEntity>? entities = null, IEnumerable<GenAction>? actions = null, IEnumerable<GenBlock>? blocks = null,
        IEnumerable<GenRootFact>? roots = null, string runtime = "Reactive") =>
        new("Shop_UI", "o11", runtime, (entities ?? [Status, Company, Customer()]).ToList(), (actions ?? []).ToList(), (blocks ?? [Layout]).ToList(),
            (roots ?? [new GenRootFact("block", "LayoutTopMenu", null, null, null, "MainFlow")]).ToList(), ["MainFlow", "Common"],
            new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Customer", "Company", "CustomerStatus", "LayoutTopMenu", "MainFlow", "Common" },
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Registered"] = "RoleSignature:Registered" });

    private static JsonObject Request(string json) => JsonNode.Parse(json)!.AsObject();

    [Fact]
    public void AnEntityGetsItsListDetailAndFormAndTheMissingBlocksOnce()
    {
        var plan = ScreenGenerator.Plan(Request("""{"generate":{"entities":["Customer","Company"]}}"""), Module());
        var names = plan.Create.Select(r => r.Kind + ":" + r.Name).ToList();
        foreach (var expected in new[] { "screen:CustomerList", "screen:CustomerDetail", "screen:CustomerEdit", "screen:CompanyList", "screen:CompanyDetail", "screen:CompanyEdit",
                     "block:Pager", "block:ConfirmDialog", "block:FilterBar", "action:SaveCustomer", "action:RemoveCustomer", "action:SaveCompany", "action:RemoveCompany" })
            Assert.Contains(expected, names);
        // The layout has Title and Actions: no header block.
        Assert.DoesNotContain("block:PageHeader", names);
        Assert.Equal(1, plan.Create.Count(r => r.Name == "Pager"));
        var list = plan.Create.Single(r => r.Name == "CustomerList").Html;
        // A table: a header row and one row per record (a List with tag tbody), paging by the Pager block, sortable headers.
        Assert.Contains("<table class=\"table\">", list);
        Assert.Contains("<tbody list=\"GetCustomerList.List\"", list);
        Assert.Contains("<Block name=\"MobileBlock:Pager\" :StartIndex=\"StartIndex\" :MaxRecords=\"20\"", list);
        Assert.Contains("os-IsDynamic=\"True\"", list);
        Assert.Contains("SortOnClick(Column = \"{CustomerStatus}.[Label]\")", list);
        // Search over the text attributes, a dropdown for the static reference, the states.
        Assert.Contains("Customer.Name like \"%\" + SearchKeyword + \"%\"", list);
        Assert.Contains("FilterStatusId = NullIdentifier() or Customer.StatusId = FilterStatusId", list);
        Assert.Contains("GetCustomerList.HasFetchError", list);
        Assert.Contains("not GetCustomerList.IsDataFetched", list);
        Assert.Contains("GetCustomerList.List.Empty", list);
        // The form: typed inputs, a dropdown per reference, the built-in validations, the save through the server action.
        var form = plan.Create.Single(r => r.Name == "CustomerEdit");
        foreach (var expected in new[] { "type=\"email\"", "type=\"date\"", "type=\"checkbox\"", "<textarea id=\"Input_Notes\"", "<select id=\"Input_StatusId\"", "<select id=\"Input_CompanyId\"",
                     "required=\"True\"", "maxlength=\"100\"", "os-onclick.BuiltInValidations=\"ValidateAndContinue\"" })
            Assert.Contains(expected, form.Html);
        Assert.Contains(form.Flows, f => f.Contains("SaveRecord = SaveCustomer(Source=GetCustomer.List.Current.Customer)", StringComparison.Ordinal));
        Assert.Contains(plan.Create.Single(r => r.Name == "SaveCustomer").Flows, f => f.Contains("Result = CreateOrUpdateCustomer(Source=Source)", StringComparison.Ordinal));
        // Every root carries its marker; the roles are the module's.
        foreach (var root in plan.Create.Where(r => r.Kind != "action")) Assert.Contains(ScreenGenerator.Marker + " " + root.Sha, root.Html);
        Assert.Contains("roles=\"RoleSignature:Registered\"", list);
        Assert.Null(plan.Receipt["code"]);
    }

    [Fact]
    public void EveryGeneratedDocumentPassesTheOwnersRulesAndEveryFlowTextReads()
    {
        var plan = ScreenGenerator.Plan(Request("""{"generate":{"entities":["Customer","Company"],"texts":"pt"}}"""), Module());
        foreach (var root in plan.Create)
        {
            if (root.Html.Length > 0)
            {
                // The document form's rules without a module (no Visible, script, foreign iteration, JSON; bindings, CSS).
                ScreenDocument.Preflight(root.Html, "/data/html");
                Assert.DoesNotContain("os-Visible", root.Html);
                Assert.DoesNotContain("<script", root.Html);
                Assert.DoesNotContain("card", root.Html);
            }
            foreach (var flow in root.Flows)
            {
                var item = ModuleFlow.Read(flow);
                Assert.DoesNotContain("foreach", flow);
                Assert.DoesNotContain("javascript", flow);
                Assert.True(item.Owner.Length > 0 || item.Kind is "ServerAction", root.Name + ": " + flow);
            }
        }
        Assert.Contains("Buscar", plan.Create.Single(r => r.Name == "CustomerList").Html);
    }

    [Fact]
    public void TheSameRequestOverTheModuleItProducedIsNoChange()
    {
        var request = Request("""{"generate":{"entities":["Customer","Company"]}}""");
        var first = ScreenGenerator.Plan(request, Module());
        // The module after the first run: the roots with their description, the blocks with their signature, the actions.
        var roots = new List<GenRootFact> { new("block", "LayoutTopMenu", null, null, null, "MainFlow") };
        var blocks = new List<GenBlock> { Layout };
        var actions = new List<GenAction>();
        foreach (var r in first.Create)
        {
            var description = r.Html.Length > 0 ? System.Text.RegularExpressions.Regex.Match(r.Html, "description=\"([^\"]*)\"").Groups[1].Value : null;
            // Registered in a module with a role of its own is stored as Registered and every role: the generated screens,
            // the most screens of the module now, never vote for the roles of the next run.
            if (r.Kind == "screen") roots.Add(new GenRootFact("screen", r.Name, description, "LayoutTopMenu", "Role:Manager, RoleSignature:Registered", "MainFlow"));
            if (r.Kind == "block") roots.Add(new GenRootFact("block", r.Name, description, null, null, "Common"));
        }
        blocks.Add(new GenBlock("Pager", "MobileBlock:Pager", null, [new("StartIndex", "Integer", true), new("MaxRecords", "Integer", true), new("TotalCount", "Integer", true)],
            [new GenEvent("OnNavigate", true, [new GenParam("NewStartIndex", "Integer", true)])], []));
        blocks.Add(new GenBlock("ConfirmDialog", "MobileBlock:ConfirmDialog", null, [new("IsOpen", "Boolean", true), new("Title", "Text"), new("Message", "Text", true), new("ConfirmLabel", "Text")],
            [new GenEvent("OnConfirm", true, []), new GenEvent("OnCancel", true, [])], []));
        blocks.Add(new GenBlock("FilterBar", "MobileBlock:FilterBar", null, [], [], ["Search", "Filters", "Actions"]));
        foreach (var e in new[] { "Customer", "Company" })
        {
            actions.Add(new GenAction("Save" + e, "server", null, [new("Source", e, true)], [new("Id", e + " Identifier")]));
            actions.Add(new GenAction("Remove" + e, "server", null, [new("Id", e + " Identifier", true)], []));
        }
        var again = ScreenGenerator.Plan(request, Module(actions: actions, blocks: blocks, roots: roots));
        Assert.Empty(again.Create);
        Assert.Equal("NO_CHANGE", again.Receipt["code"]?.ToString());
        Assert.Equal(6, again.Unchanged.Count);
        Assert.All(again.Receipt["blocks"]!.AsArray(), b => Assert.Contains(b!["source"]!.ToString(), new[] { "module", "layout" }));
    }

    [Fact]
    public void AReadOnlyReferencedEntityGetsNoFormAndTheGapSaysWhichActionToExpose()
    {
        var plan = ScreenGenerator.Plan(Request("""{"generate":{"entities":["Customer"]}}"""), Module(entities: [Status, Company, Customer("Shop_CS", writable: false)]));
        Assert.DoesNotContain(plan.Create, r => r.Name == "CustomerEdit");
        Assert.DoesNotContain(plan.Create, r => r.Kind == "action");
        var gaps = plan.Receipt["gaps"]!.AsArray().Select(g => g!["code"]!.ToString()).ToList();
        Assert.Contains("GEN_SCREEN_NO_WRITE", gaps);
        Assert.Contains("GEN_SCREEN_NO_DELETE", gaps);
        Assert.Contains("SaveCustomer", plan.Receipt["gaps"]!.ToJsonString());
        // No delete: no confirmation block, no delete link.
        Assert.DoesNotContain("DeleteOnClick", plan.Create.Single(r => r.Name == "CustomerList").Html);
        Assert.DoesNotContain(plan.Create, r => r.Name == "ConfirmDialog");
        // The aggregate reads the reference's entity by its signature.
        Assert.Contains("os-Source=\"ServerEntitySignature:Customer\"", plan.Create.Single(r => r.Name == "CustomerList").Html);
    }

    [Fact]
    public void ActionsFoundByTheirSignatureReadAndWriteTheEntity()
    {
        GenAction Act(string name, GenParam[] inputs, GenParam[] outputs) => new(name, "server", "Shop_CS", inputs, outputs);
        var actions = new[]
        {
            Act("Customer_GetList", [new("StartIndex", "Integer", true), new("MaxRecords", "Integer", true), new("SearchKeyword", "Text")], [new("List", "Customer List"), new("Total", "Long Integer")]),
            Act("Customer_GetById", [new("CustomerId", "Customer Identifier", true)], [new("Customer", "Customer")]),
            Act("Customer_Store", [new("Customer", "Customer", true)], [new("CustomerId", "Customer Identifier")]),
            Act("Customer_Remove", [new("CustomerId", "Customer Identifier", true)], []),
            // Not a save: two mandatory inputs the screen cannot give.
            Act("Customer_SaveForTenant", [new("Customer", "Customer", true), new("TenantId", "Integer", true)], []),
        };
        var plan = ScreenGenerator.Plan(Request("""{"generate":{"entities":["Customer"]}}"""), Module(entities: [Status, Company, Customer("Shop_CS", writable: false)], actions: actions));
        var list = plan.Create.Single(r => r.Name == "CustomerList");
        Assert.Contains("data-actions=\"GetCustomerList\"", list.Html);
        Assert.Contains(list.Flows, f => f.Contains("Result = Shop_CS.Customer_GetList(StartIndex=StartIndex, MaxRecords=20, SearchKeyword=SearchKeyword)", StringComparison.Ordinal));
        Assert.Contains(list.Flows, f => f.Contains("Total = LongIntegerToInteger(Result.Total)", StringComparison.Ordinal));
        Assert.Contains(list.Flows, f => f.Contains("Shop_CS.Customer_Remove(CustomerId=DeleteId)", StringComparison.Ordinal));
        var form = plan.Create.Single(r => r.Name == "CustomerEdit");
        Assert.Contains(form.Flows, f => f.Contains("SaveRecord = Shop_CS.Customer_Store(Customer=GetCustomer.Record)", StringComparison.Ordinal));
        Assert.Contains(form.Flows, f => f.Contains("navigate CustomerDetail(CustomerId=SaveRecord.CustomerId)", StringComparison.Ordinal));
        Assert.Contains(form.Flows, f => f.Contains("Result = Shop_CS.Customer_GetById(CustomerId=CustomerId)", StringComparison.Ordinal));
        Assert.DoesNotContain(plan.Create, r => r.Kind == "action");
        var report = plan.Receipt["entities"]![0]!;
        Assert.Equal("Shop_CS.Customer_GetList", report["read"]!["list"]!.ToString());
        Assert.Equal("Shop_CS.Customer_Store", report["write"]!["save"]!.ToString());
    }

    [Fact]
    public void TheModulesOwnBlocksArePickedByTheirSignatureNotByTheirName()
    {
        var blocks = new[]
        {
            Layout,
            new GenBlock("Paginacao", "MobileBlock:Paginacao", null, [new("Inicio", "Integer", true), new("Limite", "Integer", true), new("TotalRegistros", "Integer", true)],
                [new GenEvent("AoNavegar", true, [new GenParam("NovoInicio", "Integer", true)])], []),
            new GenBlock("Confirmacao", "MobileBlock:Confirmacao", null, [new("Mostrar", "Boolean", true), new("Mensagem", "Text", true)],
                [new GenEvent("AoConfirmar", true, []), new GenEvent("AoCancelar", true, [])], []),
        };
        var plan = ScreenGenerator.Plan(Request("""{"generate":{"entities":["Customer"]}}"""), Module(blocks: blocks));
        var list = plan.Create.Single(r => r.Name == "CustomerList").Html;
        Assert.Contains("<Block name=\"MobileBlock:Paginacao\" :Inicio=\"StartIndex\" :Limite=\"20\" :TotalRegistros=", list);
        Assert.Contains("@AoNavegar=\"PaginationOnNavigate(NewStartIndex = NovoInicio)\"", list);
        Assert.Contains("<Block name=\"MobileBlock:Confirmacao\" :Mostrar=\"IsDeleteConfirmOpen\" :Mensagem=", list);
        Assert.DoesNotContain(plan.Create, r => r.Name is "Pager" or "ConfirmDialog");
        Assert.Contains(plan.Receipt["blocks"]!.AsArray(), b => b!["role"]!.ToString() == "pagination" && b["source"]!.ToString() == "module");
        // blocks:"inline" never creates a block: plain markup where no block plays the role.
        var inline = ScreenGenerator.Plan(Request("""{"generate":{"entities":["Customer"],"blocks":"inline"}}"""), Module());
        Assert.DoesNotContain(inline.Create, r => r.Kind == "block");
        Assert.Contains("class=\"pagination ", inline.Create.Single(r => r.Name == "CustomerList").Html);
        Assert.Contains("<popup show=\"IsDeleteConfirmOpen\">", inline.Create.Single(r => r.Name == "CustomerList").Html);
    }

    [Fact]
    public void EveryProblemOfTheRequestComesInOneRefusal()
    {
        var roots = new[] { new GenRootFact("block", "LayoutTopMenu", null, null, null, "MainFlow"), new GenRootFact("screen", "CompanyList", "made by hand", "LayoutTopMenu", null, "MainFlow") };
        var refusal = Assert.Throws<KernelRefusalException>(() => ScreenGenerator.Plan(
            Request("""{"generate":{"entities":["Custmer","CustomerStatus",{"name":"Company","columns":["Nme"]}],"pageSize":0,"colour":"red"}}"""), Module(roots: roots)));
        Assert.Equal("GEN_SCREEN_REFUSED", refusal.Code);
        var codes = refusal.Problems!.Select(p => p!["code"]!.ToString()).ToList();
        foreach (var code in new[] { "GEN_SCREEN_ENTITY_UNKNOWN", "GEN_SCREEN_ENTITY_STATIC", "GEN_SCREEN_ATTRIBUTE_UNKNOWN", "GEN_SCREEN_NAME_TAKEN", "GEN_SCREEN_INVALID" })
            Assert.Contains(code, codes);
        var text = refusal.Problems!.ToJsonString();
        Assert.Contains("nearest: Customer", text);
        Assert.Contains("nearest: Name", text);
        Assert.Contains("CompanyList2", text);
        // The request alone (no module): closed keys and values.
        Assert.Contains(ScreenGenerator.Preflight(Request("""{"generate":{"entities":["A"],"blocks":"maybe"}}""")), p => p["code"]!.ToString() == "GEN_SCREEN_INVALID");
    }

    [Fact]
    public void AnEntityWithATextIdentifierUsesTheTextNullAndTypesItsIdentifierOnANewRecordOnly()
    {
        // FloodQuotes (corpus, 2026-10-13): statics with a Text Id, and an entity whose Id references one; NullIdentifier() is an
        // Integer Identifier there (Verify: ExpressionUnexpectedExpresssionType, ExpressionComparingDifferentIdentifiers), and a
        // dropdown of the referenced ids bound to the entity's own Id is refused (ExpressionInvalidVariableType).
        var questions = new GenEntity("Question", null, true, "Id", "Question Identifier", [new("Id", "Text", true, 20), new("Label", "Text", false, 50), new("Order", "Integer")], false, "Label", "Order");
        var kind = new GenEntity("AnswerKind", null, true, "Id", "AnswerKind Identifier", [new("Id", "Text", true, 20), new("Label", "Text", false, 50)], false, "Label");
        var code = new GenEntity("Code", null, false, "Id", "Code Identifier", [new("Id", "Text", true, 10), new("Name", "Text", true, 80), new("KindId", "AnswerKind Identifier", false, 0, false, "AnswerKind")], true);
        var answer = new GenEntity("Answer", null, false, "Id", "Answer Identifier",
            [new("Id", "Question Identifier", true, 0, false, "Question"), new("KindId", "AnswerKind Identifier", true, 0, false, "AnswerKind"), new("Text", "Text", false, 200)], true);
        var plan = ScreenGenerator.Plan(Request("""{"generate":{"entities":["Code","Answer"]}}"""), Module(entities: [questions, kind, code, answer]));
        var all = string.Join("\n", plan.Create.SelectMany(r => r.Flows.Append(r.Html)));
        Assert.DoesNotContain("NullIdentifier()", all);
        Assert.Contains("FilterKindId = NullTextIdentifier() or Answer.KindId = FilterKindId", all);
        // A Text identifier the person types: a field of the form, enabled on a new record only.
        Assert.Contains("navigate CodeEdit(CodeId=NullTextIdentifier())", all);
        var form = plan.Create.Single(r => r.Name == "CodeEdit").Html;
        Assert.Contains("<input id=\"Input_Id\" bind=\"GetCode.List.Current.Code.Id\" maxlength=\"10\" required=\"True\" enabled=\"CodeId = NullTextIdentifier()\"", form);
        Assert.Contains("default=\"NullTextIdentifier()\"", form);
        // An identifier that references another entity: no New, the form edits the existing ones, the gap says why.
        Assert.DoesNotContain("NewOnClick", plan.Create.Single(r => r.Name == "AnswerList").Html);
        Assert.DoesNotContain("Input_Id", plan.Create.Single(r => r.Name == "AnswerEdit").Html);
        Assert.Contains(plan.Receipt["gaps"]!.AsArray(), g => g!["code"]!.ToString() == "GEN_SCREEN_ID_REFERENCE" && g["entity"]!.ToString() == "Answer");
    }
    [Fact]
    public void ALibraryTakesTheBlocksOnlyAndATraditionalModuleIsRefused()
    {
        var library = ScreenGenerator.Plan(Request("""{"generate":{"patterns":true}}"""), Module(blocks: [], roots: [], runtime: "Library"));
        Assert.Equal(["ConfirmDialog", "FilterBar", "PageHeader", "Pager"], library.Create.Select(r => r.Name).Order(StringComparer.Ordinal).ToArray());
        Assert.All(library.Create, r => Assert.Equal("block", r.Kind));
        var refusal = Assert.Throws<KernelRefusalException>(() => ScreenGenerator.Plan(Request("""{"generate":{"entities":["Customer"]}}"""), Module(runtime: "WebResponsive")));
        Assert.Contains("GEN_SCREEN_RUNTIME", refusal.Problems!.ToJsonString());
    }

    // ---- with the Service Studio: the proof job, the fixed point, the second run and the render -------------------------
    [Fact]
    public void TheProofJobCompilesWithoutNewMessagesIsAFixedPointAndTheSecondRunIsNoChange()
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(Work, "proof");
        Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        var output1 = Path.Combine(dir, "out.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, Path.Combine(Root, "tests", "jobs", "screen-generate-reactive.json"), output1))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        Assert.Empty(result["validation"]!["new"]!.AsArray());
        Assert.Null(result["highWarnings"]);
        var generate = result["results"]!.AsArray().Select(r => r!["result"]?["generate"]).OfType<JsonObject>().Single();
        var roots = generate["create"]!.AsArray().Where(c => c!["kind"]!.ToString() != "action").Select(c => c!["name"]!.ToString()).ToList();
        Assert.Equal(12, roots.Count);
        // C1: every generated root reads back as a fixed point (the text compiled again changes nothing), deterministically.
        var check = host.HtmlCheck(File.ReadAllBytes(output1), null);
        foreach (var name in roots)
        {
            var doc = check["documents"]!.AsArray().Select(d => d!.AsObject()).Single(d => d["root"]!.ToString() == name);
            Assert.True(doc["ops"]!.GetValue<int>() == 0 && doc["problemCount"]!.GetValue<int>() == 0 && doc["deterministic"]!.GetValue<bool>(), name + ": " + doc.ToJsonString());
        }
        // The roles hold in a module with a role of its own (the job creates CustomerManager): a new screen is born with
        // Registered and every role, and removing a role unticks Registered, so roles="Registered" once came out with none.
        foreach (var name in generate["create"]!.AsArray().Where(c => c!["kind"]!.ToString() == "screen").Select(c => c!["name"]!.ToString()))
        {
            var html = host.HtmlRead(File.ReadAllBytes(output1), name)["documents"]![0]!["html"]!.ToString();
            var head = html[..html.IndexOf('>')];
            Assert.Matches("roles=\"[^\"]*Registered", head);
        }
        // The same request over the module it produced: NO_CHANGE.
        var job2 = Path.Combine(dir, "again.json");
        File.WriteAllText(job2, """{"description":"again","ops":[{"op":"screen","data":{"generate":{"entities":["Customer","Company","Product"]}}}]}""");
        var again = JsonSerializer.SerializeToNode(JobRunner.Run(host, output1, job2, Path.Combine(dir, "out2.oml")))!.AsObject();
        var second = again["results"]!.AsArray().Select(r => r!["result"]?["generate"]).OfType<JsonObject>().Single();
        Assert.Equal("NO_CHANGE", second["code"]?.ToString());
        Assert.Equal(9, second["unchanged"]!.AsArray().Count);
        // Offline render of the list (the importer's renderer over the saved module, seed rows of the capture): a table with a
        // header and a row per record, never cards or tiles.
        var capture = JsonNode.Parse("""
            {"views":[{"key":"CustomerList"}],
             "nativeRows":{"Customer":[{"Id":1,"Name":"Ana","Email":"ana@x.io","StatusId":1,"CompanyId":1},{"Id":2,"Name":"Bruno","Email":"b@x.io","StatusId":2,"CompanyId":1}],
                           "CustomerStatus":[{"Id":1,"Label":"Active","Order":1},{"Id":2,"Label":"Inactive","Order":2}],
                           "Company":[{"Id":1,"Name":"Acme","Website":""}]}}
            """)!.AsObject();
        var render = PrototypeRender.RenderOml(host, output1, capture, "o11", new Dictionary<string, string> { ["v:CustomerList"] = "MobileScreen:CustomerList" });
        File.WriteAllText(Path.Combine(dir, "render.json"), render.ToJsonString());
        var dom = render["states"]![0]!["root"]!.ToJsonString();
        output.WriteLine("render: " + dom.Length + " bytes, unevaluable " + render["unevaluable"]!.AsArray().Count);
        Assert.Contains("\"t\":\"table\"", dom);
        Assert.Contains("\"t\":\"tbody\"", dom);
        Assert.Contains("\"t\":\"tr\"", dom);
        Assert.DoesNotContain("card", dom);
        Assert.DoesNotContain("tile", dom);
    }

    [Fact]
    public void TheModulesActionsFoundByTheirSignatureReadAndWriteAndTheProofIsAFixedPoint()
    {
        if (!StudioAvailable()) return;
        var (_, receipt) = ScreenGeneratorCorpus.Proof(new ModelHost(Path.Combine(Work, "actions")), null, Path.Combine(Root, "tests", "jobs", "screen-generate-actions-reactive.json"),
            Path.Combine(Work, "actions"), new JsonArray("Ticket"), output);
        var ticket = receipt["entities"]![0]!;
        Assert.Equal("GetTicketList", ticket["read"]!["list"]!.ToString());
        Assert.Equal("GetTicketById", ticket["read"]!["record"]!.ToString());
        Assert.Equal("StoreTicket", ticket["write"]!["save"]!.ToString());
        Assert.Equal("RemoveTicketById", ticket["write"]!["delete"]!.ToString());
        // No server action around the entity actions: the module's own do the writes.
        Assert.DoesNotContain(receipt["create"]!.AsArray(), c => c!["kind"]!.ToString() == "action");
    }

    [Fact]
    public void ScreensAreGeneratedOverTheO11Corpus()
    {
        if (!StudioAvailable()) return;
        ScreenGeneratorCorpus.Check(ScreenHtmlCoverage.Manifest(Root), "o11", new ModelHost(Path.Combine(Work, "corpus")), Path.Combine(Work, "corpus"), output);
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
