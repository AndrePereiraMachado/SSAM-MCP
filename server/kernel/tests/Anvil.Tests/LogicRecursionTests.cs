using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class LogicRecursionTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(LogicRecursionTests).Assembly.Location)!)!;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void RecursiveSignaturesAreCompleteBeforeBodiesAndConstructionUsesEachOrdinalOnce(bool mutual)
    {
        var logic = ModuleSpecification.Logic(Contract(mutual));
        var plan = LogicExpander.PlanConstructionForVerification(logic);
        var ops = plan.Operations;
        var firstBody = ops.FindIndex(op => op["type"]?.ToString() == "IStartNode");
        var groupNames = mutual ? new[] { "$A", "$B" } : new[] { "$A" };
        foreach (var name in groupNames)
            foreach (var parameter in new[] { "N", "Rows", "Result", "RowsOut" })
                Assert.InRange(ops.FindIndex(op => op["target"]?.ToString() == name + "." + parameter && op["prop"]?.ToString() == "DataType"), 0, firstBody - 1);
        var scheduled = plan.Batches().SelectMany(batch => batch.OriginalOrdinals).ToArray();
        Assert.Equal(Enumerable.Range(0, ops.Count), scheduled.Order());
        Assert.Equal(plan.BodyExpressionOrdinals.Order(), scheduled.Where(plan.BodyExpressionOrdinals.Contains));
        Assert.True(JobPreflight.Analyze(new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = logic.DeepClone() }))["valid"]!.GetValue<bool>());
    }

    [Fact]
    public void AcyclicExpansionKeepsThePreviousDependencyOrderAndOperationSequence()
    {
        var logic = ModuleSpecification.Logic(Contract(true));
        var actions = logic["actions"]!.AsArray();
        actions[1]!["steps"] = JsonNode.Parse("""[{"assign":{"Result":"N + Rows.Length","RowsOut":"Rows"}}]""");
        var ordered = LogicOrder.Sort(actions);
        Assert.Equal(new[] { "B", "A", "Facade" }, ordered.Select(action => action["name"]!.ToString()));
        var independentlyExpanded = ordered.SelectMany(action => LogicExpander.Expand(new JsonObject { ["actions"] = new JsonArray(action.DeepClone()) })).ToArray();
        Assert.Equal(JsonSerializer.Serialize(independentlyExpanded), JsonSerializer.Serialize(LogicExpander.Expand(logic)));
    }

    [Theory]
    [InlineData("missing-target")]
    [InlineData("missing-type")]
    [InlineData("wrong-kind")]
    public void RecursiveComponentsStillValidateEverySignatureAndCall(string defect)
    {
        var logic = ModuleSpecification.Logic(Contract(true));
        if (defect == "missing-target") logic["actions"]![1]!["steps"]!.AsArray().Add(new JsonObject { ["call"] = "Missing", ["as"] = "Absent" });
        if (defect == "missing-type") logic["actions"]![1]!["inputs"]![0]!.AsObject().Remove("type");
        if (defect == "wrong-kind") logic["actions"]![1]!["kind"] = "client";
        // atritos 2 (A07): every problem of the spec comes out at once, so the defect is one of them (the resolver of this
        // test knows no exception either).
        var expected = defect switch { "missing-target" => "'Missing' does not exist", "missing-type" => "'type' is required", _ => "cannot be called by a server" };
        Assert.Contains(expected, Assert.ThrowsAny<InvalidOperationException>(() => LogicExpander.Expand(logic, _ => null)).Message);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void NativeRecursiveCallsKeepCompleteBindingsThroughReplacementReloadMergeAndRepeat(bool mutual)
    {
        StudioAssemblies.Bind(); RunNative(mutual);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void RunNative(bool mutual)
    {
        var work = Path.Combine(Root, ".local/data-logic-translator/logic-recursion-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work); var basis = Path.Combine(Root, "tests/fixtures/blank-service.oml");
        var contract = Contract(mutual); var first = Apply("first", basis, contract);
        var proof = host.CheckModuleSpecification(first, contract);
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof.ToJsonString());
        var before = Bindings(host, first, mutual);
        var changed = Contract(mutual, increment: 2); var second = Apply("replaced", first, changed);
        var reloaded = Path.Combine(work, "reloaded.oml");
        var reload = host.RoundTrip(File.ReadAllBytes(second), reloaded);
        Save("reload.json", JsonSerializer.SerializeToNode(reload)!);
        Assert.True(reload.Original.IsValid && reload.Reloaded.IsValid && reload.SameKey && reload.SameObjectCount && reload.SameValidation);
        var after = Bindings(host, reloaded, mutual);
        Assert.Equal(before["facadeKey"]!.ToString(), after["facadeKey"]!.ToString());
        Assert.Equal(before["facadeCallKey"]!.ToString(), after["facadeCallKey"]!.ToString());
        Assert.Equal(before["facadeExpression"]!.ToString(), after["facadeExpression"]!.ToString());
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(first), File.ReadAllBytes(reloaded), merged);
        Save("merge.json", JsonSerializer.SerializeToNode(merge)!);
        Assert.False(merge.HasConflicts); Assert.True(merge.LocalIsValid);
        var finalProof = host.CheckModuleSpecification(merged, changed, proof["expectedTypes"]!.AsObject());
        Save("proof-after.json", finalProof);
        Assert.True(finalProof["accepted"]!.GetValue<bool>(), finalProof.ToJsonString());
        Save("bindings-after.json", Bindings(host, merged, mutual));
        Assert.Empty(host.PlanModuleSpecification(merged, changed));

        string Apply(string label, string input, JsonObject declaration)
        {
            var job = Path.Combine(work, label + ".json"); var output = Path.Combine(work, label + ".oml");
            Save(label + ".json", new JsonObject { ["ops"] = host.PlanModuleSpecification(input, declaration) });
            var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, input, job, output))!;
            Save(label + "-apply.json", applied);
            Assert.True(applied["accepted"]!.GetValue<bool>(), applied["validation"]!.ToJsonString());
            Assert.True(applied["isValid"]!.GetValue<bool>());
            return output;
        }
        void Save(string name, JsonNode value) => File.WriteAllText(Path.Combine(work, name), value.ToJsonString());
    }

    private static JsonObject Bindings(ModelHost host, string path, bool mutual)
    {
        var module = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [path])!;
        try
        {
            var session = (ModelSession)Activator.CreateInstance(typeof(ModelSession), [module])!;
            var calls = new JsonArray();
            foreach (var (caller, callee) in (mutual ? new[] { ("A", "B"), ("B", "A"), ("Facade", "A") } : new[] { ("A", "A"), ("Facade", "A") }))
            {
                var node = session.Resolve("IServerAction:" + caller + "/Run");
                var target = session.Resolve("IServerAction:" + callee);
                Assert.Equal(Key(target), Key(ModelHost.Prop(node, "Action")!));
                foreach (var parameter in new[] { "N", "Rows" })
                {
                    var argument = session.Resolve("IServerAction:" + caller + "/Run/arg:" + parameter);
                    Assert.Equal(Key(session.Resolve("IServerAction:" + callee + "/" + parameter)), Key(ModelHost.Prop(argument, "Parameter")!));
                    Assert.Equal(true, ModelHost.Prop(ModelHost.Prop(argument, "Value")!, "IsValid"));
                }
                calls.Add(new JsonObject { ["caller"] = caller, ["callee"] = callee, ["targetKey"] = Key(target) });
            }
            return new JsonObject { ["calls"] = calls, ["facadeKey"] = Key(session.Resolve("IServerAction:Facade")),
                ["facadeCallKey"] = Key(session.Resolve("IServerAction:Facade/Run")),
                ["facadeExpression"] = ModelHost.Prop(ModelHost.Prop(session.Resolve("IServerAction:Facade/Run/arg:N"), "Value")!, "Text")?.ToString() };
        }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]); }
        static string Key(object value) => ModelHost.Prop(value, "ObjectKey")!.ToString()!;
    }

    private static JsonObject Contract(bool mutual, int increment = 1)
    {
        var actions = new JsonArray(Recursive("A", mutual ? "B" : "A"));
        if (mutual) actions.Add(Recursive("B", "A"));
        var facade = Recursive("Facade", "A"); facade["public"] = true;
        facade["access"] = new JsonObject { ["authenticated"] = true };
        facade["steps"] = JsonNode.Parse("""[{"call":"A","as":"Run","args":{"N":"N","Rows":"Rows"}},{"assign":{"Result":"Run.Result","RowsOut":"Run.RowsOut"}}]""");
        actions.Add(facade);
        return new JsonObject {
            ["data"] = JsonNode.Parse("""{"structures":[{"name":"FutureEnvelope","public":true,"attributes":[{"name":"Items","type":"FutureItem List"}]},{"name":"FutureItem","public":true,"attributes":[{"name":"Value","type":"Integer"}]}]}"""),
            ["logic"] = new JsonObject { ["actions"] = actions }
        };
        JsonObject Recursive(string name, string callee) => new() {
            ["name"] = name, ["kind"] = "server",
            ["inputs"] = JsonNode.Parse("""[{"name":"N","type":"Integer","mandatory":false,"default":"0"},{"name":"Rows","type":"FutureEnvelope List"}]"""),
            ["outputs"] = JsonNode.Parse("""[{"name":"Result","type":"Integer"},{"name":"RowsOut","type":"FutureEnvelope List"}]"""),
            ["steps"] = new JsonArray(new JsonObject { ["if"] = "N <= 0",
                ["then"] = JsonNode.Parse("""[{"assign":{"Result":"Rows.Length","RowsOut":"Rows"}}]"""),
                ["else"] = new JsonArray(new JsonObject { ["call"] = callee, ["as"] = "Run", ["args"] = new JsonObject { ["N"] = "N - 1", ["Rows"] = "Rows" } },
                    new JsonObject { ["assign"] = new JsonObject { ["Result"] = "Run.Result + " + increment, ["RowsOut"] = "Run.RowsOut" } }) })
        };
    }
}
