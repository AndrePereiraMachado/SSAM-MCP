using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

public class CSharpContractTests
{
    private static string Root => JobRunner.RepoRoot(Path.GetDirectoryName(typeof(CSharpContractTests).Assembly.Location)!)!;
    private static string Domain => File.ReadAllText(Path.Combine(Root, "tests/csharp/DataModel.cs.txt"));
    [Fact]
    public void SourceEntryFreezesCSharpAndUsesTheExistingModuleSchema()
    {
        var work = Path.Combine(Root, ".local/data-logic-translator/entry", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var path = Path.Combine(work, "Domain.cs"); File.WriteAllText(path, Domain);
        var source = ModuleSpecification.Read(path);
        Assert.NotNull(source["csharpSource"]); Assert.NotNull(ModuleSpecification.Schema()["csharpSource"]);
        Assert.Empty(ModuleSpecification.SourceDocument(path));
        var files = DeliveryReceipt.Sources(path); Assert.Single(files); Assert.Empty(DeliveryReceipt.Changed(files));
        DeliveryReceipt.RequireFrozenSource(path, source);
        File.AppendAllText(path, "\n// changed after acceptance");
        Assert.Single(DeliveryReceipt.Changed(files));
        Assert.Contains("C# source changed", Assert.Throws<InvalidOperationException>(() => DeliveryReceipt.RequireFrozenSource(path, source)).Message);
    }
    [Fact]
    public void FrozenCSharpBundleCannotHideAnEditedFileOrAcceptOperationalOverrides()
    {
        var work = Path.Combine(Root, ".local/data-logic-translator/bundle", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var path = Path.Combine(work, "bundle.json");
        var source = new JsonObject { ["csharpSource"] = new JsonObject { ["files"] = new JsonObject { ["first.cs"] = "public record First(Second Value);", ["second.cs"] = "public record Second(string Name);" } } };
        File.WriteAllText(path, source.ToJsonString()); var accepted = ModuleSpecification.Read(path);
        DeliveryReceipt.RequireFrozenSource(path, accepted);
        source["csharpSource"]!["files"]!["second.cs"] = "public record Second(int Name);"; File.WriteAllText(path, source.ToJsonString());
        Assert.Throws<InvalidOperationException>(() => DeliveryReceipt.RequireFrozenSource(path, accepted));
        accepted["data"] = new JsonObject(); Assert.Throws<ArgumentException>(() => ModuleSpecification.Normalize(accepted));
        Assert.Throws<ArgumentException>(() => ModuleSpecification.CompileCSharpSource(accepted));
    }
    [Fact]
    public void CSharpDataVerifiesReloadsAndEvolvesThroughTheNativeDelta()
    {
        StudioAssemblies.Bind(); var work = Path.Combine(Root, ".local/data-logic-translator/native-data"); Directory.CreateDirectory(work);
        var host = new ModelHost(work); var fixture = Path.Combine(Root, "tests/fixtures/blank-service.oml");
        JsonObject Source(string text) => new() { ["csharpSource"] = text };
        var initial = Source(Domain); var first = Path.Combine(work, "first.oml"); Apply(fixture, initial, first);
        var proof = host.CheckModuleSpecification(first, initial); Assert.True(proof["accepted"]!.GetValue<bool>(), proof.ToJsonString());
        var revised = Source(Domain.Replace("[MaxLength(120)]", "[MaxLength(180)]").Replace("Received = 10, Catalogued = 40, Quarantine = 90", "Quarantine = 90, Received = 10, Catalogued = 40, Archived = 150"));
        var second = Path.Combine(work, "second.oml"); Apply(first, revised, second);
        var after = host.CheckModuleSpecification(second, revised); Assert.True(after["accepted"]!.GetValue<bool>(), after.ToJsonString());
        var originalIdentities = proof["assertions"]!.AsArray().OfType<JsonObject>().Where(a => a["property"]?.ToString() == "$exists")
            .GroupBy(a => a["element"]!.ToString()).ToDictionary(g => g.Key, g => Assert.Single(g.Select(a => a["key"]!.ToString()).Distinct()));
        var currentIdentities = after["assertions"]!.AsArray().OfType<JsonObject>().Where(a => a["property"]?.ToString() == "$exists")
            .GroupBy(a => a["element"]!.ToString()).ToDictionary(g => g.Key, g => Assert.Single(g.Select(a => a["key"]!.ToString()).Distinct()));
        foreach (var identity in originalIdentities) Assert.Equal(identity.Value, currentIdentities[identity.Key]);
        var stable = host.PlanModuleSpecification(second, revised);
        File.WriteAllText(Path.Combine(work, "unchanged-plan.json"), stable.ToJsonString());
        Assert.DoesNotContain(stable, op => op?["op"]?.ToString() is "spec" or "create" or "delete" or "set");
        File.WriteAllText(Path.Combine(work, "proof.json"), new JsonObject { ["source"] = "C#", ["verifyReload"] = true, ["additiveDelta"] = true, ["idempotent"] = true, ["liveExecution"] = false }.ToJsonString());
        void Apply(string basis, JsonObject contract, string output)
        {
            var job = Path.Combine(work, "apply.json"); var ops = host.PlanModuleSpecification(basis, contract);
            File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, output))!;
            File.WriteAllText(output + ".json", result.ToJsonString()); Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        }
    }
}
