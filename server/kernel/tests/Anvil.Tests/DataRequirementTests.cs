using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class DataRequirementTests
{
    private static readonly string Spec = """
    {"static":[{"name":"Priority","public":true,"attributes":[{"name":"Minutes","type":"Integer"}],"records":[{"name":"Low","Minutes":4320}]}],
     "entities":[{"name":"Entry","public":true,"attributes":[{"name":"Title","type":"Text","length":120,"mandatory":true},{"name":"Details","type":"Long Text"},{"name":"PriorityId","type":"Priority Identifier"}],"indexes":[{"name":"IX_Title","attributes":["Title"]}]}],
     "structures":[{"name":"Detail","public":true,"attributes":[{"name":"Rows","type":"Entry List"}]}]}
    """;
    private static (ModelHost Host, string Work, string Fixture) Setup()
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(DataRequirementTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "data-requirement-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        return (new ModelHost(work), work, Path.Combine(root, "tests", "fixtures", "blank-service.oml"));
    }
    private static string Apply(ModelHost host, string work, string basis, JsonArray ops, string name)
    {
        var job = Path.Combine(work, name + ".json"); var output = Path.Combine(work, name + ".oml");
        File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, output))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        return output;
    }

    [Fact]
    public void CompleteDeclarationIsProvedAndExistingObjectsAreReused()
    {
        var (host, work, fixture) = Setup(); var spec = JsonNode.Parse(Spec)!.AsObject();
        var initial = Apply(host, work, fixture, host.PlanDataSpecification(fixture, spec), "initial");
        var first = host.CheckDataSpecification(initial, spec);
        Assert.True(first["accepted"]!.GetValue<bool>(), first.ToJsonString());
        Assert.True(first["count"]!.GetValue<int>() > 40);
        var delta = host.PlanDataSpecification(initial, spec);
        Assert.DoesNotContain(delta, o => o!["op"]?.ToString() == "create");
        var repeated = Apply(host, work, initial, delta, "repeated");
        var proof = host.CheckDataSpecification(repeated, spec, first["expectedTypes"]!.AsObject());
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof.ToJsonString());
        var beforeKeys = first["assertions"]!.AsArray().Where(a => a!["property"]!.ToString() == "$exists").Select(a => a!["key"]?.ToString()).ToArray();
        var afterKeys = proof["assertions"]!.AsArray().Where(a => a!["property"]!.ToString() == "$exists").Select(a => a!["key"]?.ToString()).ToArray();
        Assert.Equal(beforeKeys, afterKeys);
    }

    [Theory]
    [InlineData("omitted-field")]
    [InlineData("short-text")]
    [InlineData("missing-index")]
    [InlineData("wrong-record")]
    public void ValidCompilerOutputCannotOmitOrWeakenOriginalRequirements(string fault)
    {
        var (host, work, fixture) = Setup(); var contract = JsonNode.Parse(Spec)!.AsObject(); var candidate = contract.DeepClone().AsObject();
        var entity = candidate["entities"]![0]!;
        if (fault == "omitted-field") entity["attributes"]!.AsArray().RemoveAt(1);
        if (fault == "short-text") { entity["attributes"]![1]!["type"] = "Text"; entity["attributes"]![1]!["length"] = 50; }
        if (fault == "missing-index") entity["indexes"]!.AsArray().Clear();
        if (fault == "wrong-record") candidate["static"]![0]!["records"]![0]!["Minutes"] = 60;
        var output = Apply(host, work, fixture, host.PlanDataSpecification(fixture, candidate), "candidate");
        var proof = host.CheckDataSpecification(output, contract);
        Assert.False(proof["accepted"]!.GetValue<bool>(), proof.ToJsonString());
        Assert.NotEmpty(proof["differences"]!.AsArray());
    }

    [Fact]
    public void PartialExistingDataIsRepairedWithoutCreatingAnotherEntity()
    {
        var (host, work, fixture) = Setup(); var contract = JsonNode.Parse(Spec)!.AsObject(); var partial = contract.DeepClone().AsObject();
        partial["entities"]![0]!["attributes"]!.AsArray().RemoveAt(1);
        var first = Apply(host, work, fixture, host.PlanDataSpecification(fixture, partial), "partial");
        var delta = host.PlanDataSpecification(first, contract);
        Assert.Single(delta, o => o!["op"]?.ToString() == "create");
        var repaired = Apply(host, work, first, delta, "repair");
        var proof = host.CheckDataSpecification(repaired, contract);
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof.ToJsonString());
    }
}
