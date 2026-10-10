using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Lane B, C09 and C29: the kernel uses the Studio's defaults, the names people write and binding by name instead of
/// refusing, and warns (never refuses) about logic the Studio accepts but that fails at runtime.
/// </summary>
public sealed class PacoteBLogicTests
{
    private static readonly string Root = PacoteBPolicyTests.FindRoot();
    private static JsonObject Obj(string json) => JsonNode.Parse(json)!.AsObject();
    private static List<JsonObject> Expand(string actions) => LogicExpander.Expand(Obj("{\"actions\":" + actions + "}"));

    [Fact]
    public void TransitionDefaultsToInheritedAndMaxRecordsToTheSourceAndDataSourceTakesAnAlias()
    {
        var destination = LogicNodes.Values(Obj("""{"node":"IDestinationNode","properties":{"Destination":"IMobileScreen:Home"}}"""));
        Assert.Equal("Inherited", destination["Transition"]!.GetValue<string>());
        var refresh = LogicNodes.Values(Obj("""{"node":"IRefreshDataNode","properties":{"DataSource":"$GetOrders"}}"""));
        Assert.Equal(LogicNodes.MaxRecordsOfSource, refresh["MaxRecords"]!.GetValue<string>());
        Assert.Equal("$GetOrders", refresh["DataSource"]!.GetValue<string>());
        // A key is still not a reference here, and the refusal shows the accepted forms.
        var key = Assert.Throws<ArgumentException>(() => LogicNodes.Values(Obj("""{"node":"IRefreshDataNode","properties":{"DataSource":"@k3y"}}""")));
        Assert.Contains("IScreenAggregate:GetOrders", key.Message);
        var transition = Assert.Throws<ArgumentException>(() => LogicNodes.Values(Obj("""{"node":"IDestinationNode","properties":{"Destination":"IMobileScreen:Home","Transition":"Slide"}}""")));
        Assert.Contains("SlideFromLeft", transition.Message);
    }

    [Fact]
    public void HandlersDefaultToAbortAndLogAndSystemExceptionsAreNamedAsWritten()
    {
        var ops = Expand("""
            [{"name":"Guarded","steps":[],"handlers":[
            {"name":"OnAll","exception":"All Exceptions","steps":[]},
            {"name":"OnDb","exception":"DatabaseException","abortTransaction":false,"steps":[]},
            {"name":"OnMine","exception":"NotFound","steps":[]}]}]
            """);
        string Set(string node, string prop) => ops.Single(o => o["op"]!.ToString() == "set" && o["target"]!.ToString() == "$Guarded." + node && o["prop"]!.ToString() == prop)["value"]!.ToString();
        Assert.Equal("ISystemException:All Exceptions", Set("OnAll", "Exception"));
        Assert.Equal("ISystemException:DatabaseException", Set("OnDb", "Exception"));
        Assert.Equal("IUserException:NotFound", Set("OnMine", "Exception"));
        Assert.Equal("true", Set("OnAll", "AbortTransaction"));
        Assert.Equal("true", Set("OnAll", "LogError"));
        Assert.Equal("false", Set("OnDb", "AbortTransaction"));
        Assert.Equal("all", ValueAliases.SystemExceptionKey("AllExceptions"));
        Assert.Equal("notregistered", ValueAliases.SystemExceptionKey("Not Registered"));
    }

    [Fact]
    public void ChangedAttributesIsTheOptimizedUpdateBehavior()
    {
        Assert.Equal("Optimized", ValueAliases.Normalize("UpdateBehavior", "ChangedAttributes"));
        Assert.Equal("Optimized", ValueAliases.Normalize("UpdateBehavior", "Changed Attributes"));
        Assert.Equal("Always", ValueAliases.Normalize("UpdateBehavior", "Always"));
        var spec = SpecExpander.Expand(Obj("""{"entities":[{"name":"Ledger","updateBehavior":"ChangedAttributes","attributes":[{"name":"Note","type":"Text"}]}]}"""));
        Assert.Equal("Optimized", spec.Single(o => o["prop"]?.ToString() == "UpdateBehavior")["value"]!.ToString());
    }

    [Fact]
    public void AnAggregateIsNamedAfterItsSourcesAndFilters()
    {
        var ops = Expand("""
            [{"name":"Count","outputs":[{"name":"N","type":"Long Integer"}],"steps":[
            {"get":"Ticket","as":"GetTickets","where":"Ticket.Status = 1"},{"assign":{"N":"GetTickets.Count"}}]}]
            """);
        var filter = ops.FindIndex(o => o["type"]?.ToString() == "IFilter");
        var name = ops.FindLastIndex(o => o["op"]!.ToString() == "set" && o["target"]?.ToString() == "$Count.GetTickets" && o["prop"]?.ToString() == "Name");
        Assert.True(filter >= 0 && name > filter, "the Name is written after the filter");
        Assert.Equal("GetTickets", ops[name]["value"]!.ToString());
    }

    [Fact]
    public void ListCurrentWithoutAGuardIsAWarningAndAGuardSilencesIt()
    {
        JsonArray Job(string steps) => JsonNode.Parse("""[{"op":"logic","data":{"actions":[{"name":"Read","inputs":[{"name":"Id","type":"Integer"}],"outputs":[{"name":"Title","type":"Text"}],"steps":""" + steps + "}]}}]")!.AsArray();
        var bare = LogicLint.Check(Job("""[{"get":"Ticket","as":"GetTicket","where":"Ticket.Id = Id"},{"assign":{"Title":"GetTicket.List.Current.Ticket.Title"}}]"""), "o11").ToArray();
        var warning = Assert.Single(bare);
        Assert.Equal("LIST_CURRENT_UNGUARDED", warning["code"]!.GetValue<string>());
        Assert.Equal("warning", warning["severity"]!.GetValue<string>());
        Assert.Equal("/ops/0/data/actions/0/steps/1/Title", warning["pointer"]!.GetValue<string>());
        Assert.Contains("not GetTicket.List.Empty", warning["fix"]!.GetValue<string>());
        foreach (var guarded in new[]
        {
            // The input is used in each (C18, atritos 3: an unused input is a LOGIC_UNUSED note of the compiler).
            """[{"get":"Ticket","as":"GetTicket","where":"Ticket.Id = Id"},{"if":"not GetTicket.List.Empty","then":[{"assign":{"Title":"GetTicket.List.Current.Ticket.Title"}}]}]""",
            """[{"get":"Ticket","as":"GetTicket","where":"Ticket.Id = Id"},{"if":"GetTicket.List.Empty","then":[{"return":true}]},{"assign":{"Title":"GetTicket.List.Current.Ticket.Title"}}]""",
            """[{"get":"Ticket","as":"GetTicket","where":"Ticket.Id = Id"},{"assign":{"Title":"If(GetTicket.List.Empty, \"\", GetTicket.List.Current.Ticket.Title)"}}]""",
            """[{"get":"Ticket","as":"GetTicket","where":"Ticket.Id = Id"},{"foreach":"GetTicket.List","do":[{"assign":{"Title":"GetTicket.List.Current.Ticket.Title"}}]}]""",
        })
            Assert.Empty(LogicLint.Check(Job(guarded), "o11"));
        // The preflight carries it as a warning: the job stays valid.
        var result = JobPreflight.Analyze(Job("""[{"get":"Ticket","as":"GetTicket","where":"Ticket.Id = Id"},{"assign":{"Title":"GetTicket.List.Current.Ticket.Title"}}]"""));
        Assert.True(result["valid"]!.GetValue<bool>(), result["errors"]!.ToJsonString());
        Assert.Contains(result["warnings"]!.AsArray(), w => w!["code"]!.GetValue<string>() == "LIST_CURRENT_UNGUARDED");
    }

    [Fact]
    public void ADateComparedWithADateTimeIsAWarning()
    {
        var job = JsonNode.Parse("""
            [{"op":"logic","data":{"actions":[{"name":"Late","inputs":[{"name":"Due","type":"Date"}],"outputs":[{"name":"IsLate","type":"Boolean"}],
            "steps":[{"assign":{"IsLate":"Due < CurrDateTime()"}}]}]}}]
            """)!.AsArray();
        var warning = Assert.Single(LogicLint.Check(job, "o11"));
        Assert.Equal("DATETIME_COMPARED_WITH_DATE", warning["code"]!.GetValue<string>());
        Assert.Contains("DateTimeToDate(CurrDateTime())", warning["fix"]!.GetValue<string>());
        job[0]!["data"]!["actions"]![0]!["steps"]![0]!["assign"]!["IsLate"] = "Due < CurrDate()";
        Assert.Empty(LogicLint.Check(job, "o11"));
    }

    [Fact]
    public void FrozenReferencesAfterAnEditAreHoistedInsteadOfRefused()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch();
        var job = Path.Combine(dir, "hoist.json");
        File.WriteAllText(job, """{"base":"blank-service.oml","ops":[{"op":"logic","data":{"actions":[{"name":"PacoteBHoistProbe","steps":[]}]}},{"op":"reference","producer":"Runtime","elements":["IServerAction:CSharpTextCompareOrdinal"]}]}""");
        var bindings = new Dictionary<string, string> { ["Runtime"] = Path.Combine(Root, "tests", "contracts", "native-reference", "ordinal-primitive.avsig") };
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, Path.Combine(dir, "hoist.oml"), null, bindings))!;
        Assert.Equal(new[] { 1 }, result["hoistedReferences"]!.AsArray().Select(i => i!.GetValue<int>()));
        Assert.True(result["isValid"]!.GetValue<bool>(), result["details"]!.ToJsonString());
    }

    [Fact]
    public void ANewActionKeepsTheArgumentsByNameAndDropsTheOthers()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var result = Run("""
        {"base":"blank-service.oml","ops":[
          {"op":"logic","data":{"actions":[
            {"name":"PacoteBFirst","inputs":[{"name":"X","type":"Integer"},{"name":"Y","type":"Text"}],"outputs":[{"name":"R","type":"Text"}],"steps":[{"assign":{"R":"Y + IntegerToText(X)"}}]},
            {"name":"PacoteBSecond","inputs":[{"name":"X","type":"Integer"},{"name":"Z","type":"Text","mandatory":false}],"outputs":[{"name":"R","type":"Text"}],"steps":[{"assign":{"R":"Z + IntegerToText(X)"}}]},
            {"name":"PacoteBCaller","outputs":[{"name":"Out","type":"Text"}],"steps":[{"call":"PacoteBFirst","as":"RunIt","args":{"X":"41 + 1","Y":"\"y\""}},{"assign":{"Out":"RunIt.R"}}]}]}},
          {"op":"set","target":"$PacoteBCaller.RunIt","prop":"Action","value":"IServerAction:PacoteBSecond"},
          {"op":"get","target":"$PacoteBCaller.RunIt/X"}]}
        """);
        Assert.True(result["isValid"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        var arguments = result["results"]![1]!["result"]!["arguments"];
        Assert.True(arguments != null, result["results"]![1]!.ToJsonString());
        Assert.DoesNotContain(arguments!["removed"]?.AsArray() ?? new JsonArray(), n => n!.GetValue<string>() == "X");
        Assert.True(arguments["removed"]!.AsArray().Any(n => n!.GetValue<string>() == "Y"), arguments.ToJsonString());
        Assert.True(arguments["droppedValues"]!.AsArray().Any(n => n!.GetValue<string>() == "Y"), arguments.ToJsonString());
        Assert.Equal("41 + 1", result["results"]![2]!["result"]!["properties"]!["Value"]!.GetValue<string>());
    }

    [Fact]
    public void DeleteWithReconnectRejoinsTheFlow()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var result = Run("""
        {"base":"blank-service.oml","ops":[
          {"op":"logic","data":{"actions":[{"name":"PacoteBSteps","public":true,"outputs":[{"name":"Out","type":"Integer"}],"steps":[
            {"assign":{"Out":"1"},"as":"First"},{"assign":{"Out":"Out + 1"},"as":"Middle"},{"assign":{"Out":"Out * 2"},"as":"Last"}]}]}},
          {"op":"delete","target":"$PacoteBSteps.Middle","reconnect":true}]}
        """);
        Assert.True(result["isValid"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        var reconnected = result["results"]![1]!["result"]!["reconnected"]!;
        Assert.True(reconnected["next"]!.GetValue<string>().Contains("Last"), reconnected.ToJsonString());
        Assert.True(reconnected["relinked"]!.AsArray().Any(r => r!.GetValue<string>().Contains("First")), reconnected.ToJsonString());
    }

    [Fact]
    public void AnArgNoParameterConsumesIsRefusedWithTheAcceptedOnes()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var error = Assert.ThrowsAny<Exception>(() => Run("""{"base":"blank-service.oml","ops":[{"op":"create","parent":"@espace","type":"IServerAction","name":"PacoteBArgs","args":{"bogus":"1"}}]}"""));
        var text = Errors.Text(error);
        Assert.Contains("'bogus'", text);
        Assert.Contains("accepted args", text);
    }

    [Fact]
    public void IEntityIndexIsCreatedWithItsAttributes()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var result = Run("""
        {"base":"blank-service.oml","ops":[
          {"op":"spec","data":{"entities":[{"name":"PacoteBIdx","attributes":[{"name":"Code","type":"Text","length":20}]}]}},
          {"op":"create","parent":"IServerEntity:PacoteBIdx","type":"IEntityIndex","name":"IX_PacoteBIdx_Code","args":{"attributes":["IServerEntity:PacoteBIdx/Code"],"unique":true},"as":"$ix"},
          {"op":"get","target":"$ix"}]}
        """);
        var index = result["results"]![2]!["result"]!.ToJsonString();
        Assert.Contains("\"Code\"", index);
        Assert.Contains("\"Unique\":true", index);
    }

    [Fact]
    public void ARefreshWithoutMaxRecordsTakesTheOneOfItsAggregate()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var result = Run("""
        {"base":"job:screen-search-refresh-reactive","ops":[
          {"op":"logic","data":{"actions":[{"name":"PacoteBRefreshAgain","kind":"screen","owner":"IMobileScreen:UserSearch","steps":[
            {"node":"IRefreshDataNode","as":"Again","properties":{"DataSource":"IScreenAggregate:GetUsers"}}]}]}},
          {"op":"get","target":"$PacoteBRefreshAgain.Again"},
          {"op":"get","target":"IScreenAggregate:GetUsers"}]}
        """);
        string? MaxRecords(int i) => result["results"]![i]!["result"]!["properties"]?["MaxRecords"]?.ToString();
        var expected = string.IsNullOrWhiteSpace(MaxRecords(2)) ? "50" : MaxRecords(2);
        Assert.Equal(expected, MaxRecords(1));
    }

    private static JsonNode Run(string json)
    {
        var dir = Scratch();
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, json);
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, Path.Combine(dir, "job.oml")))!;
    }
    private static string Scratch()
    {
        var dir = Path.Combine(Root, ".local", "pacote-b-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir); return dir;
    }
}
