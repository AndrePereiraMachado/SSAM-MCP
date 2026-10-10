using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
namespace Anvil.Tests;
public sealed class CurrentHintTests
{
    [Theory]
    [InlineData("dataaction-list-scope", "Name", "CurrentGame")]
    [InlineData("aggregate-list-scope", "User", "an aggregate")]
    [InlineData("structure-list-scope", "Name", "Kpi List")]
    [InlineData("aggregate-group-list-scope", "Orders", "an aggregate")]
    public void InvalidMemberShowsActualCurrentFields(string job, string field, string type)
    {
        if (!Available()) return;
        var result = Run("jobs-negative", job);
        Assert.False(result["isValid"]!.GetValue<bool>());
        var hints = result["details"]!.AsArray().Select(x => x!.ToString()).Where(s => s.StartsWith("Hint Current:")).ToArray();
        Assert.True(hints.Length > 0, result["details"]!.ToJsonString());
        Assert.Contains(hints, s => s.Contains("Current has:") && s.Contains(field) && s.Contains(type));
    }
    [Theory]
    [InlineData("dropdown-prompt", "EmptyValue", "see anvil api --name IDropdown")]
    [InlineData("reference-static-not-public", "is not Public", "IStaticEntity:ReferenceStatus in elements")]
    public void ContractErrorsGiveTheCorrection(string job, string first, string second)
    {
        if (!Available()) return;
        var ex = Assert.ThrowsAny<Exception>(() => Run("jobs-negative", job));
        Assert.Contains(first, Errors.Text(ex)); Assert.Contains(second, Errors.Text(ex));
    }
    [Theory]
    [InlineData("data-action-entity-list-reactive")]
    [InlineData("data-action-reactive")]
    [InlineData("consume-reference-static")]
    public void CorrectContractsVerifyWithoutHints(string job)
    {
        if (!Available()) return;
        var result = Run("jobs", job);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        Assert.DoesNotContain(result["details"]!.AsArray(), x => x!.ToString().StartsWith("Hint Current:"));
    }
    private static JsonNode Run(string folder, string job)
    {
        var root = Path.GetDirectoryName(typeof(CurrentHintTests).Assembly.Location);
        while (root != null && !File.Exists(Path.Combine(root, "MANIFESTO.md"))) root = Path.GetDirectoryName(root);
        var work = Path.Combine(root!, ".local", "current-hints"); Directory.CreateDirectory(work);
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), null, Path.Combine(root!, "tests", folder, job + ".json"), Path.Combine(work, job + ".oml")))!;
    }
    private static bool Available() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
