using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// The pure part of the op entity-actions (EntityActionsExpander): the closed contract, determinism, the texts the text form
// parses, the decisions it names and the safety of existing names, on a synthetic data model (no Studio). The real modules
// are EntityActionsCorpusTests (both lanes) and the jobs entity-actions (tests/jobs, tests/jobs-odc).
public sealed class EntityActionsExpanderTests
{
    private static EntityActionsExpander.Model Model(string lane = "o11", bool odcApp = false, Func<string, EntityActionsExpander.Existing?>? existing = null)
    {
        var customer = new EntityActionsExpander.Entity("Customer", "ServerEntity", true, "Id",
            [new("Id", "Long Integer", true, null, null, null, true), new("Name", "Text", true, 120, null, null, false), new("Email", "Email", true, 250, null, null, false),
             new("IsActive", "Boolean", true, null, null, null, false), new("CreatedBy", "User Identifier", false, null, "User", "Ignore", false)],
            [new("UX_Customer_Email", true, ["Email"])], "Name", "IsActive");
        var order = new EntityActionsExpander.Entity("Order", "ServerEntity", false, "Id",
            [new("Id", "Long Integer", true, null, null, null, true), new("CustomerId", "Customer Identifier", true, null, "Customer", "Protect", false),
             new("Status", "Status Identifier", true, null, "Status", "Protect", false), new("PlacedOn", "Date", true, null, null, null, false)],
            [new("IX_Order_PlacedOn", false, ["PlacedOn"])], null, null);
        return new EntityActionsExpander.Model
        {
            Lane = lane, OdcApplication = odcApp, Entities = [customer, order],
            Reference = name => name switch
            {
                "Customer" => new(true, false, true, "Id", true),
                "Order" => new(true, false, false, "Id", true),
                "Status" => new(true, true, true, "Id", true),
                "User" => new(true, false, true, "Id", false),
                _ => new(false, false, false, "Id", false),
            },
            Existing = existing ?? (_ => null),
        };
    }

    private static JsonObject Data(string json = """{"entities":"all","owner":{"attribute":"CreatedBy"},"expose":{"server":true,"service":true}}""") => JsonNode.Parse(json)!.AsObject();

    [Fact]
    public void TheContractIsClosedAndEveryProblemComesAtOnce()
    {
        var problems = EntityActionsExpander.Validate(Data("""{"entities":"some","bogus":1,"list":{"sort":"-1x","paging":"yes"},"names":{"save":"Save"},"language":"fr"}"""));
        var pointers = problems.Select(p => p["pointer"]!.ToString()).ToList();
        Assert.Contains("/bogus", pointers);
        Assert.Contains("/entities", pointers);
        Assert.Contains("/list/sort", pointers);
        Assert.Contains("/list/paging", pointers);
        Assert.Contains("/names/save", pointers);
        Assert.Contains("/language", pointers);
        Assert.Empty(EntityActionsExpander.Validate(Data()));
        Assert.Empty(EntityActionsExpander.Validate(new JsonObject()));
        var unknown = EntityActionsExpander.CheckAgainstModel(Data("""{"entities":["Customer","Status","Nope"]}"""), Model());
        Assert.Equal(new[] { "ENTITY_ACTIONS_NOT_SERVER_ENTITY", "ENTITY_ACTIONS_UNKNOWN_ENTITY" }, unknown.Select(p => p["code"]!.ToString()).ToArray());
    }

    [Fact]
    public void TheSameModelAndDataGiveTheSameTextsAndEveryTextParses()
    {
        var first = EntityActionsExpander.Expand(Data(), Model());
        var second = EntityActionsExpander.Expand(Data(), Model());
        Assert.Equal(first.Create.Select(g => g.Text), second.Create.Select(g => g.Text));
        Assert.Equal(first.Ops.Select(o => o.ToJsonString()), second.Ops.Select(o => o.ToJsonString()));
        // Customer is public: 4 server actions and 4 service actions; Order is not: 4 private server actions, no service.
        Assert.Equal(12, first.Create.Count);
        Assert.All(first.Create, g => Assert.Matches("^(Get|Save|Remove)[A-Z]", g.Name));
        Assert.Equal(4, first.Create.Count(g => g.Kind == "ServiceAction"));
        Assert.All(first.Create.Where(g => g.Entity == "Order"), g => Assert.False(g.Public));
        Assert.Contains(first.Notes.OfType<JsonObject>(), n => n["code"]!.ToString() == "ENTITY_NOT_PUBLIC");
        foreach (var g in first.Create)
        {
            var item = ModuleFlow.Read(g.Text);
            Assert.Equal(g.Name, item.Name);
            Assert.DoesNotContain("foreach", g.Text);
            Assert.DoesNotContain("javascript", g.Text);
        }
        // The exceptions the texts raise are created, the row structures too, and the one structure the pages count into.
        Assert.Equal(new[] { "AccessDenied", "NotFound", "ValidationFailed" }, first.Ops.Where(o => o["type"]?.ToString() == "IUserException").Select(o => o["name"]!.ToString()).Order().ToArray());
        Assert.Equal(3, first.Ops.Count(o => o["op"]?.ToString() == "spec"));
    }

    [Fact]
    public void TheTextsCarryTheRulesOfTheDataModel()
    {
        var plan = EntityActionsExpander.Expand(Data(), Model());
        string Text(string name) => plan.Create.Single(g => g.Name == name).Text;
        // List without paging: one aggregate with the join to the references, the filters, the owner, the active attribute and
        // the date range of an index.
        var whole = EntityActionsExpander.Expand(Data("""{"entities":"all","owner":{"attribute":"CreatedBy"},"expose":{"server":true,"service":true},"list":{"paging":false}}"""), Model());
        string Whole(string name) => whole.Create.Single(g => g.Name == name).Text;
        Assert.Contains("JOIN Inner Order~Customer ON Customer.Id = Order.CustomerId", Whole("GetOrderList"));
        Assert.Contains("(PlacedOnFrom = NullDate() or Order.PlacedOn >= PlacedOnFrom)", Whole("GetOrderList"));
        Assert.Contains("(Customer.CreatedBy = GetUserId())", Whole("GetCustomerList"));
        Assert.Contains("(IsInactiveIncluded or Customer.IsActive)", Whole("GetCustomerList"));
        // T3: a server aggregate never pages by START (the runtime ignores it there); the page is an SQL with OFFSET and the
        // total an aggregate of the same filters.
        Assert.DoesNotContain(" START ", Text("GetCustomerList"));
        Assert.DoesNotContain(" START ", Text("GetOrderList"));
        Assert.Contains("| OFFSET @Skip ROWS FETCH NEXT @Take ROWS ONLY", Text("GetCustomerList"));
        Assert.Contains("| ORDER BY {Customer}.[Name], {Customer}.[Id]", Text("GetCustomerList"));
        Assert.Contains("(@InactiveIncluded = 1 OR {Customer}.[IsActive] = @ActiveValue)", Text("GetCustomerList"));
        Assert.Contains("{Customer}.[CreatedBy] = @SignedInUser", Text("GetCustomerList"));
        Assert.Contains("| INNER JOIN {Customer} ON {Customer}.[Id] = {Order}.[CustomerId]", Text("GetOrderList"));
        Assert.Contains("(@NoPlacedOnFrom = 1 OR {Order}.[PlacedOn] >= @PlacedOnFrom)", Text("GetOrderList"));
        // The total is COUNT(*) OVER() of the same query (one query, the same filters), and the page size is never 0.
        Assert.Contains("TotalCount = If(ReadCustomerPage.List.Empty, 0, ReadCustomerPage.List.Current.List_3.Total)", Text("GetCustomerList"));
        Assert.Contains("ReadCustomerPage = sql -> Customer, User, PagedRowCount max If(MaxRecords <= 0, 50, MaxRecords)", Text("GetCustomerList"));
        Assert.Contains("in Take: Integer = If(MaxRecords <= 0, 50, MaxRecords)", Text("GetCustomerList"));
        Assert.Contains(", COUNT(*) OVER()", Text("GetCustomerList"));
        Assert.DoesNotContain("CountCustomerRows", Text("GetCustomerList"));
        Assert.Contains(plan.Structures.OfType<JsonObject>(), x => x["name"]!.ToString() == "PagedRowCount");
        // Save: required, length, unique key, reference, owner; Delete: the referencing records, or the active attribute.
        Assert.Contains("FindCustomerByEmail = aggregate FROM Customer WHERE (Customer.Email = CustomerRecord.Email) AND (Customer.Id <> CustomerRecord.Id) MAX 1", Text("SaveCustomer"));
        Assert.Contains("CheckCustomerId = aggregate FROM Customer", Text("SaveOrder"));
        Assert.Contains("If(ReadCustomer.List.Empty, GetUserId(), ReadCustomer.List.Current.Customer.CreatedBy)", Text("SaveCustomer"));
        Assert.Contains("raise ValidationFailed(\"Customer: Name is required.\")", Text("SaveCustomer"));
        Assert.Contains("assign ReadCustomer.List.Current.Customer.IsActive = False", Text("RemoveCustomer"));
        Assert.DoesNotContain("DeleteCustomer(", Text("RemoveCustomer"));
        Assert.Contains("DeleteOrder(Id)", Text("RemoveOrder"));
        Assert.Contains("SaveCustomer(CustomerRecord)", Text("SaveCustomerService"));
    }

    [Theory]
    [InlineData("o11", "| OUTER APPLY (SELECT {User}.* FROM {User} WHERE {User}.[Id] = {Ticket}.[AssignedTo]) User2")]
    [InlineData("odc", "| LEFT JOIN LATERAL (SELECT {User}.* FROM {User} WHERE {User}.[Id] = {Ticket}.[AssignedTo]) User2 ON TRUE")]
    public void ASecondReferenceToTheSameEntityKeepsItsJoinAndItsRecord(string lane, string apply)
    {
        // T3 review: the page keeps every join of the aggregate form; the second reference is its own lookup, so its columns
        // come in the entity's order and the item structure is the same as before (Ticket, User, User2).
        var ticket = new EntityActionsExpander.Entity("Ticket", "ServerEntity", true, "Id",
            [new("Id", "Long Integer", true, null, null, null, true), new("Title", "Text", true, 80, null, null, false),
             new("OpenedBy", "User Identifier", true, null, "User", "Protect", false), new("AssignedTo", "User Identifier", false, null, "User", "Ignore", false)],
            [], "Title", null);
        var model = new EntityActionsExpander.Model
        {
            Lane = lane, Entities = [ticket],
            Reference = name => name switch { "Ticket" => new(true, false, true, "Id", true), "User" => new(true, false, true, "Id", false), _ => new(false, false, false, "Id", false) },
            Existing = _ => null,
        };
        var plan = EntityActionsExpander.Expand(JsonNode.Parse("""{"entities":"all","actions":["list"],"expose":{"server":true}}""")!.AsObject(), model);
        var text = plan.Create.Single(g => g.Name == "GetTicketList").Text;
        Assert.Contains("| INNER JOIN {User} ON {User}.[Id] = {Ticket}.[OpenedBy]", text);
        Assert.Contains(apply, text);
        Assert.Contains("| SELECT {Ticket}.*, {User}.*, User2.*, COUNT(*) OVER()", text);
        Assert.Contains("ReadTicketPage = sql -> Ticket, User, User, PagedRowCount max", text);
        Assert.Contains("List = ReadTicketPage.List mapTo { Ticket: List, User: List_2, User2: List_3 }", text);
        Assert.Contains("ReadTicketPage.List.Current.List_4.Total", text);
        Assert.DoesNotContain(plan.Notes.OfType<JsonObject>(), n => n["code"]!.ToString() == "JOIN_REPEATED_NOT_PAGED");
        var item = plan.Ops.OfType<JsonObject>().Select(o => o["data"]?["structures"]?[0]).OfType<JsonObject>().Single(x => x["name"]!.ToString() == "TicketListItem");
        Assert.Equal(["Ticket", "User", "User2"], item["attributes"]!.AsArray().Select(a => a!["name"]!.ToString()));
    }

    [Fact]
    public void AnOdcAppKeepsServerActionsPrivateAndMapsThePage()
    {
        var plan = EntityActionsExpander.Expand(Data(), Model("odc", odcApp: true));
        Assert.All(plan.Create.Where(g => g.Kind == "ServerAction"), g => Assert.False(g.Public));
        Assert.Contains(plan.Notes.OfType<JsonObject>(), n => n["code"]!.ToString() == "ODC_APP_SERVER_PRIVATE");
        Assert.Contains("List = ReadOrderPage.List mapTo { Order: List, Customer: List_2, Status: List_3 }", plan.Create.Single(g => g.Name == "GetOrderList").Text);
    }

    [Fact]
    public void AnExistingNameIsNeverOverwritten()
    {
        var generated = EntityActionsExpander.Expand(Data(), Model()).Create.Single(g => g.Name == "SaveCustomer").Text;
        // The same text read back (with its ids): unchanged. Another text of that name: kept, with the generated text.
        var read = generated.Replace("server action SaveCustomer public", "server action SaveCustomer public @KEY1").Replace("  end\n", "  end @n9\n");
        var plan = EntityActionsExpander.Expand(Data(), Model(existing: name => name switch
        {
            "SaveCustomer" => new("ServerAction", EntityActionsExpander.Strip(read), "KEY1", "sha"),
            "RemoveCustomer" => new("ServerAction", "server action RemoveCustomer\n  end\n", "KEY2", "sha2"),
            "GetOrderList" => new("Structure", null, null, null),
            _ => null,
        }));
        Assert.Contains(plan.Unchanged, g => g.Name == "SaveCustomer");
        Assert.DoesNotContain(plan.Create, g => g.Name is "SaveCustomer" or "RemoveCustomer" or "GetOrderList");
        var kept = plan.Kept.OfType<JsonObject>().ToDictionary(k => k["name"]!.ToString());
        Assert.Equal("@KEY2", kept["RemoveCustomer"]["edit"]!["key"]!.ToString());
        Assert.NotNull(kept["RemoveCustomer"]["generated"]);
        // The service action of a kept server action would call the module's own action: not generated, listed.
        Assert.DoesNotContain(plan.Create, g => g.Name == "RemoveCustomerService");
        Assert.Contains("is kept", kept["RemoveCustomerService"]["why"]!.ToString());
        Assert.Contains(plan.Create, g => g.Name == "SaveCustomerService");
        Assert.Contains("Structure", kept["GetOrderList"]["why"]!.ToString());
    }

    [Fact]
    public void NodeNamesFitTheStudioAndNamesFollowTheTemplates()
    {
        var model = Model();
        var longName = new string('A', 40);
        model.Entities.Add(new EntityActionsExpander.Entity(longName + "Child", "ServerEntity", true, "Id",
            [new("Id", "Long Integer", true, null, null, null, true), new(longName + "ParentId", "Customer Identifier", false, null, "Customer", "Protect", false)], [], null, null));
        var plan = EntityActionsExpander.Expand(Data("""{"entities":"all","softDelete":false,"names":{"save":"Store{E}","delete":"Purge{E}"},"language":"pt"}"""), model);
        var delete = plan.Create.Single(g => g.Name == "PurgeCustomer").Text;
        foreach (var line in delete.Split('\n').Where(l => l.Contains(" = aggregate ")))
            Assert.True(line.Trim().Split(' ')[0].Length <= 50, line);
        Assert.Contains(plan.Create, g => g.Name == "StoreOrder");
        Assert.Contains("é obrigatório", plan.Create.Single(g => g.Name == "StoreCustomer").Text);
    }
}
