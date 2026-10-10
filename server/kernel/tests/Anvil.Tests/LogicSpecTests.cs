using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Spec de logica (item 4): esquema fechado e compilacao deterministica. Os testes offline nao precisam do Studio (o
/// LogicExpander e uma funcao pura do JSON); o job tests/jobs/logic-spec-services.json prova o resultado no modelo.
/// </summary>
public class LogicSpecTests
{
    private static readonly string Root = FindRoot();

    private static JsonObject Spec() => JsonNode.Parse("""
        {"actions":[{"name":"Ticket_Cancel","public":true,
          "inputs":[{"name":"TicketId","type":"Ticket Identifier"},{"name":"Reason","type":"Text","mandatory":false}],
          "outputs":[{"name":"Ok","type":"Boolean"}],"vars":[{"name":"T","type":"Ticket"}],
          "steps":[
            {"get":"Ticket","as":"GetTicket","where":"Ticket.Id = TicketId","max":1},
            {"if":"GetTicket.List.Empty","then":[{"raise":"NotFound","message":"\"Ticket not found\""}]},
            {"assign":{"T":"GetTicket.List.Current.Ticket","T.StatusId":"Entities.TicketStatus.Cancelled"}},
            {"save":"Ticket","record":"T","as":"SaveTicket"},
            {"foreach":"GetTicket.List","as":"Each","do":[{"call":"Event_Write","as":"Ev","args":{"TicketId":"TicketId","Note":"Reason"}}]},
            {"assign":{"Ok":"True"}}]}]}
        """)!.AsObject();

    [Fact]
    public void SameSpecSameOps()
    {
        var a = JsonSerializer.Serialize(LogicExpander.Expand(Spec()));
        var b = JsonSerializer.Serialize(LogicExpander.Expand(Spec()));
        Assert.Equal(a, b);
        var ops = LogicExpander.Expand(Spec());
        Assert.Contains(ops, o => o["op"]!.GetValue<string>() == "create" && o["type"]!.GetValue<string>() == "IStartNode");
        Assert.Contains(ops, o => o["op"]!.GetValue<string>() == "create" && o["type"]!.GetValue<string>() == "IEndNode");
        Assert.Contains(ops, o => o["op"]!.GetValue<string>() == "link" && o["connector"]?.GetValue<string>() == "TrueTarget");
        Assert.Contains(ops, o => o["op"]!.GetValue<string>() == "link" && o["connector"]?.GetValue<string>() == "CycleTarget");
        Assert.Contains(ops, o => o["op"]!.GetValue<string>() == "layout");
        // o ramo do raise nao volta ao fluxo: o If tem TrueTarget para o Raise e FalseTarget para o Assign seguinte
        Assert.Contains(ops, o => o["op"]!.GetValue<string>() == "link" && o["connector"]?.GetValue<string>() == "FalseTarget" && o["to"]!.GetValue<string>().EndsWith(".Assign1"));
        Assert.DoesNotContain(ops, o => o["op"]!.GetValue<string>() == "link" && o["from"]!.GetValue<string>().Contains("RaiseNotFound"));
    }

    [Fact]
    public void UnknownKeyIsRejectedWithTheAllowedOnes()
    {
        var bad = JsonNode.Parse("""{"actions":[{"name":"A","inputz":[],"steps":[]}]}""")!.AsObject();
        var ex = Assert.Throws<InvalidOperationException>(() => LogicExpander.Expand(bad));
        Assert.Contains("'inputz'", ex.Message);
        Assert.Contains("inputs", ex.Message);
        Assert.Contains("steps", ex.Message);
    }

    [Fact]
    public void StepWithTwoFormsIsRejected()
    {
        var bad = JsonNode.Parse("""{"actions":[{"name":"A","steps":[{"assign":{"X":"1"},"call":"Y","as":"Z"}]}]}""")!.AsObject();
        var ex = Assert.Throws<InvalidOperationException>(() => LogicExpander.Expand(bad));
        Assert.Contains("UMA forma", ex.Message);
        Assert.Contains("assign, call", ex.Message);
    }

    [Fact]
    public void MissingEntityIsRejectedBeforeTouchingTheModel()
    {
        var spec = JsonNode.Parse("""{"actions":[{"name":"A","steps":[{"get":"Nope","as":"GetNope"}]}]}""")!.AsObject();
        var ex = Assert.Throws<InvalidOperationException>(() => LogicExpander.Expand(spec, _ => null));
        Assert.Contains("'Nope' nao existe", ex.Message);
    }

    [Fact]
    public void DuplicateNodeNameIsNumberedAsTheStudioNamesACopy()
    {
        // atritos 2 (A07): a repeated name is never a refusal; the second node is S2 and the preflight says so (Pa2F3LogicTests).
        var spec = JsonNode.Parse("""{"actions":[{"name":"A","steps":[{"assign":{"X":"1"},"as":"S"},{"assign":{"X":"2"},"as":"S"}]}]}""")!.AsObject();
        var ops = LogicExpander.Expand(spec);
        Assert.Equal(new[] { "S", "S2" }, ops.Where(o => o["type"]?.ToString() == "IAssignNode").Select(o => o["name"]!.ToString()));
    }

    [Fact]
    public void NegativeJobFailsAtCompileTime()
    {
        if (!StudioAvailable()) return;
        var host = new ModelHost(Path.Combine(Root, ".local", "test-work"));
        var jobPath = Path.Combine(Root, "tests", "jobs-negative", "logic-unknown-key.json");
        var basePath = Path.Combine(Root, "tests", "fixtures", "blank-service.oml");
        var ex = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, basePath, jobPath, Path.Combine(Root, ".local", "test-work", "logic-unknown-key.oml")));
        var root = ex; while (root.InnerException != null) root = root.InnerException;
        Assert.Contains("'inputz'", root.Message);
    }

    [Theory]
    [InlineData("max")]
    [InlineData("start")]
    [InlineData("sort")]
    public void InputsUsedOnlyByPaginationOrSortAreAccepted(string property)
    {
        var get = new JsonObject { ["get"] = "Product", ["as"] = "ReadProducts" };
        get[property] = property == "sort" ? new JsonArray("Page", "Ascending") : JsonValue.Create("Page");
        var action = new JsonObject { ["name"] = "ReadPage", ["inputs"] = new JsonArray(new JsonObject { ["name"] = "Page", ["type"] = "Integer" }),
            ["steps"] = new JsonArray(get) };
        Assert.False(LogicUsage.Analyze(action).HasUnused);
        Assert.NotEmpty(LogicExpander.Expand(new JsonObject { ["actions"] = new JsonArray(action) }));
    }

    [Fact]
    public void LiteralMemberAndSourceNamesDoNotConsumeInputs()
    {
        var action = JsonNode.Parse("""{"name":"ScopeProbe","inputs":[{"name":"B","type":"Text"},{"name":"Product","type":"Text"}],"steps":[{"get":"Product","as":"ReadProducts","where":"Product.Name = \"B\""},{"assign":{"Other":"Record.B"}}]}""")!.AsObject();
        Assert.Equal(new[] { "B", "Product" }, LogicUsage.Analyze(action).Inputs);
        // C18 (atritos 3): an unused input is the Verify's warning (A03), a note of the compiler, never a refusal.
        Assert.NotEmpty(LogicExpander.Expand(new JsonObject { ["actions"] = new JsonArray(action.DeepClone()) }));
        Assert.Contains(LogicExpander.Notes(new JsonObject { ["actions"] = new JsonArray(action.DeepClone()) }), n => n.Code == "LOGIC_UNUSED" && n.Message.Contains("B, Product"));
    }

    [Fact]
    public void UsageScanAgreesWithVerifyForUnusedInputAndVariable()
    {
        var spec = JsonNode.Parse("""{"actions":[{"name":"UsageProbe","public":true,"inputs":[{"name":"A","type":"Text"},{"name":"B","type":"Text"}],"outputs":[{"name":"Ok","type":"Boolean"}],"vars":[{"name":"V","type":"Text"}],"steps":[{"assign":{"Ok":"a <> \"B V\""}}]}]}""")!.AsObject();
        var report = LogicUsage.Analyze(spec["actions"]![0]!.AsObject());
        Assert.Equal(new[] { "B" }, report.Inputs);
        Assert.Equal(new[] { "V" }, report.Variables);
        Assert.Empty(report.Outputs);
        // C18 (atritos 3): the compiler no longer refuses them; the note says what the Verify will warn about.
        var note = Assert.Single(LogicExpander.Notes(spec), n => n.Code == "LOGIC_UNUSED");
        Assert.Contains("inputs declared and never used: B", note.Message);
        Assert.Contains("vars never used: V", note.Message);
        if (!StudioAvailable()) return;
        var work = Path.Combine(Root, ".local", "usage-parity"); Directory.CreateDirectory(work);
        var job = Path.Combine(work, "probe.json");
        var ops = new JsonArray(LogicExpander.ExpandForVerification(spec).Select(o => (JsonNode)o).ToArray());
        File.WriteAllText(job, new JsonObject { ["base"] = "blank-service.oml", ["ops"] = ops }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), null, job, Path.Combine(work, "probe.oml")))!;
        var unused = result["validation"]!["new"]!.AsArray().Where(m => m!["id"]!.GetValue<string>() == "UnusedElement")
            .Select(m => m!["path"]!.GetValue<string>().Split(" / ").Last().Split(" (")[0]).OrderBy(x => x);
        Assert.Equal(new[] { "B", "V" }, unused);
    }

    [Fact]
    public void OutputMustBeAssignedAndSqlValuesCountAsInputUse()
    {
        var action = JsonNode.Parse("""{"name":"OutputProbe","inputs":[{"name":"Limit","type":"Integer"}],"outputs":[{"name":"Result","type":"Text"}],"steps":[{"get":"Product","as":"ReadProducts","sql":true,"statement":"SELECT {Product}.* FROM {Product}","params":{"n":{"type":"Integer","value":"Limit"}}}]}""")!.AsObject();
        var report = LogicUsage.Analyze(action);
        Assert.Empty(report.Inputs);
        Assert.Equal(new[] { "Result" }, report.Outputs);
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(LogicSpecTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
