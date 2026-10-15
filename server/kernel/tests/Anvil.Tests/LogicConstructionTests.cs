using System.Collections;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class LogicConstructionTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(LogicConstructionTests).Assembly.Location)!)!;

    [Theory]
    [InlineData("json")]
    [InlineData("javascript")]
    [InlineData("excel")]
    [InlineData("aggregate")]
    public void SchedulePreservesOperationsOrdinalsAndOpaquePrerequisites(string name)
    {
        var test = Case(name); var logic = ModuleSpecification.Logic(test["contract"]!.AsObject());
        var original = LogicExpander.Expand(logic); var plan = LogicExpander.PlanConstructionForVerification(logic);
        Assert.Equal(JsonSerializer.Serialize(original), JsonSerializer.Serialize(plan.Operations));
        var order = plan.Batches().SelectMany(batch => batch.OriginalOrdinals).ToArray();
        Assert.Equal(Enumerable.Range(0, original.Count), order.Order());
        Assert.NotEmpty(plan.BodyExpressionOrdinals);
        Assert.Equal(plan.BodyExpressionOrdinals.Order(), order.Where(plan.BodyExpressionOrdinals.Contains));
        Assert.All(plan.BodyExpressionOrdinals, ordinal =>
        {
            Assert.Equal("set", original[ordinal]["op"]!.ToString());
            Assert.DoesNotContain(original[ordinal]["prop"]!.ToString(), new[] { "Action", "DataType", "DefaultValue", "IsMandatory", "Exception", "Statement" });
        });
        var opaque = plan.Barriers.Where(barrier => barrier.Reason.EndsWith(".begin", StringComparison.Ordinal)).ToArray();
        Assert.NotEmpty(opaque);
        foreach (var begin in opaque)
        {
            var end = plan.Barriers.First(barrier => barrier.Ordinal > begin.Ordinal && barrier.Reason == begin.Reason.Replace(".begin", ".end"));
            var ordinals = Enumerable.Range(begin.Ordinal, end.Ordinal - begin.Ordinal).ToArray();
            Assert.DoesNotContain(ordinals, plan.BodyExpressionOrdinals.Contains);
            Assert.Equal(ordinals, order.Where(ordinal => ordinal >= begin.Ordinal && ordinal < end.Ordinal));
            Assert.All(order.Take(Array.IndexOf(order, begin.Ordinal)), ordinal => Assert.True(ordinal < begin.Ordinal));
        }
        Assert.Contains(plan.Barriers, barrier => barrier.Reason == "action" && barrier.Ordinal == original.Count);
    }

    [Theory]
    [InlineData("json")]
    [InlineData("javascript")]
    [InlineData("excel")]
    [InlineData("aggregate")]
    public void NativeConstructionMatchesSequentialBindingsReloadMergeAndContract(string name)
    {
        StudioAssemblies.Bind(); RunNative(name);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void RunNative(string name)
    {
        var test = Case(name); var contract = test["contract"]!.AsObject();
        var work = Path.Combine(Root, ".local/data-logic-translator/logic-construction-tests", Guid.NewGuid().ToString("N"), name);
        Directory.CreateDirectory(work); var host = new ModelHost(work);
        var basis = Path.Combine(Root, "tests/fixtures", test["fixture"]!.ToString() + ".oml");
        var plan = host.PlanModuleSpecification(basis, contract); var sequential = new JsonArray();
        foreach (var operation in plan.OfType<JsonObject>())
            if (operation["op"]?.ToString() == "logic")
                foreach (var expanded in LogicExpander.Expand(operation["data"]!.AsObject())) sequential.Add(expanded.DeepClone());
            else sequential.Add(operation.DeepClone());
        var expressionOperations = LogicExpander.Expand(ModuleSpecification.Logic(contract));
        JsonArray? originalBindings = null; string? candidate = null;
        foreach (var (label, operations) in new[] { ("sequential", sequential), ("scheduled", plan) })
        {
            var job = Path.Combine(work, label + ".json"); var output = Path.Combine(work, label + ".oml");
            Save(label + ".json", new JsonObject { ["ops"] = operations });
            var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, output))!;
            Save(label + "-apply.json", applied);
            Assert.True(applied["accepted"]!.GetValue<bool>(), applied["details"] + " " + applied["validation"]);
            Assert.True(applied["isValid"]!.GetValue<bool>());
            var reloadPath = Path.Combine(work, label + "-reloaded.oml");
            var reload = host.RoundTrip(File.ReadAllBytes(output), reloadPath);
            Assert.True(reload.Original.IsValid && reload.Reloaded.IsValid && reload.SameKey && reload.SameObjectCount && reload.SameValidation);
            var proof = host.CheckModuleSpecification(reloadPath, contract); Save(label + "-proof.json", proof);
            Assert.True(proof["accepted"]!.GetValue<bool>(), proof["differences"]!.ToJsonString());
            var bindings = ExpressionBindings(host, reloadPath, applied["handles"]!.AsObject(), expressionOperations);
            Save(label + "-bindings.json", bindings);
            if (originalBindings == null) originalBindings = bindings;
            else Assert.True(JsonNode.DeepEquals(originalBindings, bindings), "Resolved expression types/referents differ: " + work);
            candidate = reloadPath;
        }
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(basis), File.ReadAllBytes(candidate!), merged);
        Save("merge.json", JsonSerializer.SerializeToNode(merge)!);
        Assert.True(merge.LocalIsValid); Assert.False(merge.HasConflicts);
        var after = host.CheckModuleSpecification(merged, contract); Save("proof-after.json", after);
        Assert.True(after["accepted"]!.GetValue<bool>(), after["differences"]!.ToJsonString());
        Assert.Empty(host.PlanModuleSpecification(merged, contract));
        void Save(string file, JsonNode value) => File.WriteAllText(Path.Combine(work, file), value.ToJsonString());
    }

    private static JsonObject Case(string name)
    {
        var template = name switch
        {
            "json" => "blank-service-server-json-nested-structures",
            "javascript" => "reactive-ui-client-javascript",
            "excel" => "blank-service-server-excel-roundtrip",
            "aggregate" => "blank-service-server-aggregate-full",
            _ => throw new ArgumentException(name)
        };
        var test = JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "tests/contracts/action-coverage", template + ".json")))!.AsObject();
        var action = test["contract"]!["logic"]!["actions"]![0]!.AsObject(); var input = action["inputs"]![0]!;
        // The JavaScript case keeps its client action isolated (decision 6, judged since the 24.1 re-check on the raw ops of the
        // sequential job too): the value it prepares is an output the action assigns, not a local.
        if (name == "javascript") action["outputs"]!.AsArray().Add(new JsonObject { ["name"] = "Prepared", ["type"] = input["type"]!.DeepClone() });
        else action["vars"] = new JsonArray(new JsonObject { ["name"] = "Prepared", ["type"] = input["type"]!.DeepClone() });
        var steps = action["steps"]!.AsArray();
        steps.Insert(0, new JsonObject { ["assign"] = new JsonObject { ["Prepared"] = input["name"]!.ToString() } });
        if (name == "json") steps[1]!["properties"]!["Data"] = "Prepared";
        else if (name == "javascript") steps[1]!["args"]!["Value"] = "Prepared";
        else if (name == "excel") steps[1]!["properties"]!["RecordList"] = "Prepared";
        else steps[2]!["where"] = "CoverageRow.Value >= Prepared";
        return test;
    }

    private static JsonArray ExpressionBindings(ModelHost host, string path, JsonObject handles, List<JsonObject> operations)
    {
        var module = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [path])!;
        try
        {
            var session = (ModelSession)Activator.CreateInstance(typeof(ModelSession), [module])!; var result = new JsonArray();
            foreach (var (operation, ordinal) in operations.Select((operation, ordinal) => (operation, ordinal)).Where(pair => pair.operation["op"]?.ToString() == "set"))
            {
                var target = operation["target"]!.ToString(); var property = operation["prop"]!.ToString();
                var alias = handles.Select(pair => pair.Key).Where(key => target == key || target.StartsWith(key + "/", StringComparison.Ordinal)).OrderByDescending(key => key.Length).First();
                var expression = ModelHost.Prop(session.Resolve("@" + handles[alias] + target[alias.Length..]), property);
                if (expression == null || !expression.GetType().GetInterfaces().Any(type => type.FullName == "OutSystems.Model.IExpression")) continue;
                Assert.Equal(true, ModelHost.Prop(expression, "IsValid"));
                var nativeType = ModelHost.Prop(ModelHost.Prop(expression, "Type")!, "Type"); Assert.NotNull(nativeType);
                if (property == "Variable") Assert.Equal(true, ModelHost.Prop(expression, "IsAVariable"));
                var references = (ModelHost.Prop(expression, "ReferedObjects") as IEnumerable)?.Cast<object>().Select(Identity).Order().ToArray() ?? [];
                result.Add(new JsonObject { ["ordinal"] = ordinal, ["property"] = property,
                    ["type"] = ModelHost.Prop(nativeType, "UnderlyingType")?.ToString(), ["references"] = JsonSerializer.SerializeToNode(references) });
            }
            Assert.NotEmpty(result); return result;
        }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]); }
    }

    private static string Identity(object value)
    {
        var path = new List<string>();
        for (object? node = value; node != null; node = node.GetType().GetMethod("GetParent", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, null, Type.EmptyTypes, null)?.Invoke(node, null))
            path.Add(node.GetType().Name + ":" + (ModelHost.Prop(node, "Name")?.ToString() ?? ModelHost.Prop(node, "Label")?.ToString() ?? ""));
        path.Reverse(); return string.Join("/", path);
    }
}
