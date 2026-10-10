using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class SemanticDataTests
{
    private static string Root => JobRunner.RepoRoot(Path.GetDirectoryName(typeof(SemanticDataTests).Assembly.Location)!)!;

    [Theory]
    [InlineData("Other List")]
    [InlineData("Integer")]
    [InlineData("Child")]
    [InlineData("Child Identifier")]
    public void ListMeaningSurvivesMergeButWrongTypesFail(string replacement)
    {
        StudioAssemblies.Bind();
        var work = Path.Combine(Root, ".local", "semantic-data-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var fixture = Path.Combine(Root, "tests", "fixtures", "blank-service.oml");
        var job = Path.Combine(work, "data.json");
        File.WriteAllText(job, """
        {"base":"blank-service.oml","ops":[{"op":"spec","data":{
          "entities":[{"name":"Child","public":true,"attributes":[{"name":"Name","type":"Text"}]},{"name":"Other","public":true,"attributes":[{"name":"Name","type":"Text"}]}],
          "structures":[{"name":"Detail","public":true,"attributes":[{"name":"Rows","type":"Child List"}]}]
        }}]}
        """);
        var foreign = Path.Combine(work, "foreign.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, fixture, job, foreign))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied["details"]!.ToJsonString());
        var assertions = applied["dataContract"]!["assertions"]!.AsArray();
        var list = assertions.Single(a => a!["element"]!.ToString().Contains("Rows (StructureAttribute)") && a["property"]!.ToString() == "DataType")!;
        Assert.Equal("list", list["expected"]!["kind"]!.ToString());
        Assert.Equal("entity", list["expected"]!["element"]!["kind"]!.ToString());
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(fixture), File.ReadAllBytes(foreign), merged);
        Assert.False(merge.HasConflicts); Assert.Equal(0, merge.Errors);
        var proof = host.CheckDataContract(merged, assertions);
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof.ToJsonString());
        var mutation = Path.Combine(work, "change.json");
        File.WriteAllText(mutation, new JsonObject { ["ops"] = new JsonArray(new JsonObject {
            ["op"] = "set", ["target"] = "IStructure:Detail/Rows", ["prop"] = "DataType", ["value"] = replacement }) }.ToJsonString());
        var changed = Path.Combine(work, "changed.oml");
        JobRunner.Run(host, merged, mutation, changed);
        var rejected = host.CheckDataContract(changed, assertions);
        Assert.False(rejected["accepted"]!.GetValue<bool>());
        Assert.Contains(rejected["differences"]!.AsArray(), a => a!["property"]!.ToString() == "DataType");
    }
}
