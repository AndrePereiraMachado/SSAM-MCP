using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class ModuleSpecificationTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ModuleSpecificationTests).Assembly.Location)!)!;
    private static JsonObject Contract() => JsonNode.Parse("""
    {"roles":[{"name":"Administrator"},{"name":"Requester"}],
     "data":{"entities":[
       {"name":"Entry","public":true,"attributes":[{"name":"Title","type":"Text","length":80},{"name":"OwnerId","type":"User Identifier"},{"name":"AssigneeId","type":"User Identifier"}]},
       {"name":"Audit","attributes":[{"name":"EntryId","type":"Entry Identifier"},{"name":"Note","type":"Text","length":80}]}]},
     "logic":{"actions":[
       {"name":"Entry_Create","public":true,"access":{"authenticated":true,"roles":["Administrator","Requester"],"inputs":{"AssigneeId":{"roles":["Administrator"],"default":"NullIdentifier()"}}},
        "inputs":[{"name":"Title","type":"Text"},{"name":"AssigneeId","type":"User Identifier","mandatory":false}],
        "outputs":[{"name":"Id","type":"Entry Identifier"}],"vars":[{"name":"Row","type":"Entry"}],
        "steps":[
          {"assign":{"Row.Title":"Title","Row.OwnerId":"GetUserId()","Row.AssigneeId":"AssigneeId"},"as":"SetEntry"},
          {"create":"Entry","record":"Row","as":"WriteEntry"},
          {"call":"Audit_Write","as":"WriteAudit","args":{"EntryId":"WriteEntry.Id","Note":"Title"}},
          {"assign":{"Id":"WriteEntry.Id"},"as":"SetId"},{"call":"CommitTransaction","as":"Commit"}]},
       {"name":"Audit_Write","inputs":[{"name":"EntryId","type":"Entry Identifier"},{"name":"Note","type":"Text"}],"vars":[{"name":"Row","type":"Audit"}],
        "steps":[{"assign":{"Row.EntryId":"EntryId","Row.Note":"Note"}},{"create":"Audit","record":"Row","as":"WriteAuditRecord"}]},
       {"name":"Entry_List","public":true,"access":{"authenticated":true,"roles":["Administrator","Requester"],"readScopes":[{"query":"ReadEntries","ownerAttribute":"OwnerId","exceptRoles":["Administrator"]}]},
        "inputs":[{"name":"Limit","type":"Integer"}],"outputs":[{"name":"Items","type":"Entry List"}],
        "steps":[{"get":"Entry","as":"ReadEntries","sort":["Entry.Title","Ascending"],"max":"Limit"},
          {"assign":{"Items":"ReadEntries.List"},"as":"SetItems"}]}]}}
    """)!.AsObject();
    private static (ModelHost Host, string Work, string Output, JsonObject Contract) Seed()
    {
        StudioAssemblies.Bind(null); var work = Path.Combine(Root, ".local", "module-contract-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var host = new ModelHost(work); var contract = Contract(); var fixture = Path.Combine(Root, "tests", "fixtures", "blank-service.oml");
        var output = Apply(host, work, fixture, host.PlanModuleSpecification(fixture, contract), "seed");
        return (host, work, output, contract);
    }
    private static string Apply(ModelHost host, string work, string source, JsonArray ops, string name)
    {
        var job = Path.Combine(work, name + ".json"); var output = Path.Combine(work, name + ".oml");
        File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, source, job, output))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"] + " " + result["policyMessages"]);
        return output;
    }
    [Fact]
    public void ModuleCompilesAndIndependentProofCoversSignaturesGuardsCallsFiltersAndCommit()
    {
        var (host, _, output, contract) = Seed();
        var proof = host.CheckModuleSpecification(output, contract);
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof["differences"]!.ToJsonString());
        Assert.Equal(3, proof["actionSummary"]!.AsArray().Count);
        Assert.DoesNotContain(host.PlanModuleSpecification(output, contract), op => op?["op"]?.ToString() == "logic");
    }
    [Theory]
    [InlineData("authentication")]
    [InlineData("requester-assignment")]
    [InlineData("owner-filter")]
    [InlineData("list-to-count")]
    [InlineData("commit-order")]
    public void ValidButWeakenedActionsFailOriginalContract(string defect)
    {
        var (host, work, output, contract) = Seed();
        var ops = new JsonArray();
        void Set(string target, string property, string value) => ops.Add(new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = property, ["value"] = value });
        void Link(string from, string to) => ops.Add(new JsonObject { ["op"] = "link", ["from"] = from, ["to"] = to });
        if (defect == "authentication") Set("IServerAction:Entry_Create/#IStartNode/Target", "Condition", "False");
        if (defect == "requester-assignment") Set("IServerAction:Entry_Create/#IStartNode/Target/FalseTarget/FalseTarget", "Condition", "False");
        if (defect == "owner-filter") Set("IServerAction:Entry_List/ReadEntries/**IFilter[1]", "Condition", "True");
        if (defect == "list-to-count") { Set("IServerAction:Entry_List/Items", "DataType", "Integer"); Set("IServerAction:Entry_List/#IAssignNode/#IAssignment[1]", "Value", "ReadEntries.List.Length"); }
        if (defect == "commit-order") { Link("IServerAction:Entry_Create/#IStartNode/Target/FalseTarget/FalseTarget/FalseTarget", "IServerAction:Entry_Create/Commit"); Link("IServerAction:Entry_Create/Commit", "IServerAction:Entry_Create/WriteEntry"); Link("IServerAction:Entry_Create/WriteAudit/Target", "IServerAction:Entry_Create/#IEndNode[1]"); }
        var changed = Apply(host, work, output, ops, "changed");
        var proof = host.CheckModuleSpecification(changed, contract);
        Assert.False(proof["accepted"]!.GetValue<bool>(), defect);
        Assert.NotEmpty(proof["differences"]!.AsArray());
    }
    [Fact]
    public void RepairReplacesOnlyTheChangedActionAndPreservesListMeaningAcrossNativeMerge()
    {
        var (host, work, output, contract) = Seed();
        var initial = host.CheckModuleSpecification(output, contract);
        var corrupted = Apply(host, work, output, new JsonArray(new JsonObject {
            ["op"] = "set", ["target"] = "IServerAction:Entry_List/ReadEntries/**IFilter", ["prop"] = "Condition", ["value"] = "True" }), "bad-filter");
        var delta = host.PlanModuleSpecification(corrupted, contract);
        var changes = delta.Single(op => op?["op"]?.ToString() == "logic")!["data"]!["actions"]!.AsArray();
        Assert.Single(changes); Assert.Equal("Entry_List", changes[0]!["name"]!.ToString()); Assert.True(changes[0]!["replace"]!.GetValue<bool>());
        var repaired = Apply(host, work, corrupted, delta, "repair");
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(corrupted), File.ReadAllBytes(repaired), merged);
        Assert.True(merge.LocalIsValid); Assert.False(merge.HasConflicts);
        var proof = host.CheckModuleSpecification(merged, contract, initial["expectedTypes"]!.AsObject());
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof["differences"]!.ToJsonString());
        Assert.DoesNotContain(host.PlanModuleSpecification(merged, contract), op => op?["op"]?.ToString() == "logic");
    }

    [Theory]
    [InlineData("service")]
    [InlineData("client")]
    public void SupportedActionKindsUseTheirOwnExecutionNode(string kind)
    {
        StudioAssemblies.Bind(null); var work = Path.Combine(Root, ".local", "module-contract-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var host = new ModelHost(work); var fixture = Path.Combine(Root, "tests", "fixtures", kind == "client" ? "reactive-ui.oml" : "blank-service.oml");
        var contract = JsonNode.Parse("""{"logic":{"actions":[{"name":"Echo","inputs":[{"name":"N","type":"Integer"}],"outputs":[{"name":"Result","type":"Integer"}],"steps":[{"assign":{"Result":"N"}}]}]}}""")!.AsObject();
        var action = contract["logic"]!["actions"]![0]!; action["kind"] = kind;
        if (kind == "service") action["access"] = new JsonObject { ["authenticated"] = true };
        if (kind == "client") contract["logic"]!["actions"]!.AsArray().Add(JsonNode.Parse("""{"name":"Caller","kind":"client","public":true,"inputs":[{"name":"N","type":"Integer"}],"outputs":[{"name":"Result","type":"Integer"}],"steps":[{"call":"Echo","as":"RunEcho","args":{"N":"N"}},{"assign":{"Result":"RunEcho.Result"}}]}"""));
        var output = Apply(host, work, fixture, host.PlanModuleSpecification(fixture, contract), "kinds");
        var proof = host.CheckModuleSpecification(output, contract); Assert.True(proof["accepted"]!.GetValue<bool>(), proof["differences"]!.ToJsonString());
    }
    [Fact]
    public void QueryAndLoopBodiesAreCheckedIncludingSqlParametersAndCycleEdges()
    {
        var (host, work, output, contract) = Seed();
        var additional = JsonNode.Parse("""
        {"actions":[
          {"name":"Entry_Process","public":true,"access":{"authenticated":true},"inputs":[{"name":"Id","type":"Entry Identifier"},{"name":"Limit","type":"Integer"}],"outputs":[{"name":"Count","type":"Integer"}],"vars":[{"name":"Row","type":"Entry"}],
           "steps":[{"get":"Entry","as":"ReadProcessEntries","where":"Entry.Id = Id","max":"Limit"},
             {"foreach":"ReadProcessEntries.List","as":"ProcessEach","do":[{"assign":{"Row":"ReadProcessEntries.List.Current.Entry","Row.Title":"\"processed\"","Count":"Count + 1"}},{"update":"Entry","record":"Row","as":"UpdateRow"}]},
             {"save":"Entry","record":"Row","as":"SaveRow"},{"delete":"Entry","id":"Id","as":"DeleteRow"}]},
          {"name":"Entry_CountSql","public":true,"access":{"authenticated":true},"inputs":[{"name":"Minimum","type":"Long Integer"}],"outputs":[{"name":"Count","type":"Integer"}],
           "steps":[{"get":"Entry","sql":true,"as":"ReadSql","statement":"SELECT {Entry}.* FROM {Entry} WHERE {Entry}.[Id] >= @Minimum","params":{"Minimum":{"type":"Long Integer","value":"Minimum"}},"max":50},{"assign":{"Count":"ReadSql.List.Length"}}]}]}
        """)!.AsObject();
        foreach (var action in additional["actions"]!.AsArray()) contract["logic"]!["actions"]!.AsArray().Add(action!.DeepClone());
        output = Apply(host, work, output, host.PlanModuleSpecification(output, contract), "queries");
        var proof = host.CheckModuleSpecification(output, contract); Assert.True(proof["accepted"]!.GetValue<bool>(), proof["differences"]!.ToJsonString());
        var changed = Apply(host, work, output, new JsonArray(new JsonObject { ["op"] = "set", ["target"] = "IServerAction:Entry_Process/#IForEachNode", ["prop"] = "MaximumIterations", ["value"] = "1" }), "truncated-loop");
        Assert.False(host.CheckModuleSpecification(changed, contract)["accepted"]!.GetValue<bool>());
    }
    [Theory]
    [InlineData(0, "Administrator", 0, false)]
    [InlineData(1, "", 0, false)]
    [InlineData(1, "Requester", 0, true)]
    [InlineData(1, "Requester", 2, false)]
    [InlineData(1, "Administrator", 2, true)]
    public void CompiledInputGuardsEnforceRoleAndAuthentication(int userId, string role, int assigneeId, bool permitted)
    {
        var (host, _, output, _) = Seed();
        Assert.Equal(permitted, FollowCompiledGuards(host, output, "Entry_Create", userId, role, assigneeId, null));
    }
    [Theory]
    [InlineData(0, "Administrator", 1, false)]
    [InlineData(1, "", 1, false)]
    [InlineData(1, "Requester", 1, true)]
    [InlineData(1, "Requester", 2, false)]
    [InlineData(1, "Administrator", 2, true)]
    public void CompiledAggregateScopePreservesRequesterOwnership(int userId, string role, int ownerId, bool visible)
    {
        var (host, _, output, _) = Seed();
        Assert.Equal(visible, FollowCompiledGuards(host, output, "Entry_List", userId, role, 0, ownerId));
    }
    // Evaluate only the generated boolean predicates read from the compiled module. This is not an O11 runtime emulator.
    private static bool FollowCompiledGuards(ModelHost host, string path, string action, int userId, string role, int assigneeId, int? ownerId)
    {
        var module = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [path])!;
        try
        {
            var session = (ModelSession)Activator.CreateInstance(typeof(ModelSession), module)!;
            var current = "IServerAction:" + action + "/#IStartNode/Target";
            for (var guard = 0; guard < 12; guard++)
            {
                var node = session.Get(session.Resolve(current)); var type = node["type"]!.ToString();
                if (type == "IRaiseExceptionNode") return false;
                if (type == "IIfNode")
                {
                    var condition = Evaluate(node["properties"]!["Condition"]!.ToString());
                    current = node["properties"]![condition ? "TrueTarget" : "FalseTarget"]!.ToString();
                    continue;
                }
                if (ownerId != null)
                {
                    Assert.Equal("IAggregateNode", type);
                    var filter = session.Get(session.Resolve(current + "/**IFilter"));
                    return Evaluate(filter["properties"]!["Condition"]!.ToString());
                }
                Assert.Equal("IAssignNode", type); return true;
            }
            throw new InvalidOperationException("Compiled guard cycle did not reach its body or denial");
        }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]); }
        bool Evaluate(string text)
        {
            var expression = System.Text.RegularExpressions.Regex.Replace(text, @"CheckRole\(Roles\.([A-Za-z0-9_]+),\s*GetUserId\(\)\)", match => match.Groups[1].Value == role ? "True" : "False");
            expression = expression.Replace("GetUserId()", userId.ToString()).Replace("NullIdentifier()", "0")
                .Replace("AssigneeId", assigneeId.ToString()).Replace("Entry.OwnerId", ownerId?.ToString() ?? "0");
            return (bool)new System.Data.DataTable().Compute(expression, "");
        }
    }

    [Fact]
    public void SchemaHasAccessButNoOperationalReplacementFlag()
    {
        var keys = ModuleSpecification.Schema()["logic"]!["action"]!.AsArray().Select(n => n!.ToString()).ToArray();
        Assert.Contains("access", keys); Assert.DoesNotContain("replace", keys);
    }

    [Theory]
    [InlineData("missing-access")]
    [InlineData("anonymous")]
    [InlineData("unknown-role")]
    [InlineData("replace")]
    [InlineData("wrong-section-type")]
    [InlineData("caller-default")]
    [InlineData("unknown-query")]
    public void UnsupportedOrIncompleteContractsFailBeforePreparingTheModule(string defect)
    {
        var contract = Contract(); var action = contract["logic"]!["actions"]![0]!.AsObject();
        if (defect == "missing-access") action.Remove("access");
        if (defect == "anonymous") action["access"]!["authenticated"] = false;
        if (defect == "unknown-role") action["access"]!["roles"]!.AsArray().Add("Unknown");
        if (defect == "replace") action["replace"] = true;
        if (defect == "wrong-section-type") contract["roles"] = new JsonArray("Administrator");
        if (defect == "caller-default") action["access"]!["inputs"]!["AssigneeId"]!["default"] = "AssigneeId";
        if (defect == "unknown-query") contract["logic"]!["actions"]![2]!["access"]!["readScopes"]![0]!["query"] = "AbsentQuery";
        Assert.ThrowsAny<Exception>(() => ModuleSpecification.Validate(contract));
    }
}
