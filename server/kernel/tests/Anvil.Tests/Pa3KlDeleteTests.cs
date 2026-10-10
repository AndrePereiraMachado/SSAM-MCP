using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Atritos 3, lane kl, C36: a delete counts the consumers that will really be there. Empty placeholder contents that fill the
/// placeholder go with it (lab 43: "IPlaceholderWidget HeaderActions is used by 3 consumer(s)", all empty), and a consumer a
/// later op of the same job removes is not counted: the delete waits for the end of the apply (DCIPS: DELETE_HAS_CONSUMERS 2x).
/// </summary>
public sealed class Pa3KlDeleteTests
{
    private static readonly string Root = PacoteBPolicyTests.FindRoot();

    private static (JsonNode? Result, Exception? Error) Run(string name, string job)
    {
        var dir = Path.Combine(Root, ".local", "pa3-kl-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        try { return (JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, Path.Combine(dir, name + ".oml"))), null); }
        catch (Exception ex) { return (null, ex); }
    }

    private static string Screen(int n) => $$"""
        {"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"Pa3Use{{n}}","as":"$s{{n}}"},
        {"op":"set","target":"$s{{n}}/#IMobileBlockInstanceWidget","prop":"SourceBlock","value":"IMobileBlock:LayoutTopMenu"},
        {"op":"create","parent":"$s{{n}}/#IMobileBlockInstanceWidget/MainContent","type":"IMobileBlockInstanceWidget","name":"Card{{n}}","as":"$i{{n}}","source":"IMobileBlock:Pa3Card"}
        """;

    [Fact]
    public void APlaceholderWithThreeEmptyContentsGoesWithThem()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (result, error) = Run("cascade", """
            {"base":"reactive-ui.oml","ops":[
              {"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileBlock","name":"Pa3Card","as":"$card"},
              {"op":"create","parent":"$card","type":"IPlaceholderWidget","name":"HeaderActions","as":"$ph"},
            """ + string.Join(",", Enumerable.Range(1, 3).Select(Screen)) + """
              ,{"op":"delete","target":"IMobileBlock:Pa3Card/HeaderActions"}]}
            """);
        Assert.True(error == null, error?.ToString());
        Assert.True(result!["isValid"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        var delete = result["results"]!.AsArray().Last()!["result"]!;
        Assert.Equal(3, delete["cascaded"]!.AsArray().Count);
        Assert.Equal(0, delete["brokenConsumers"]!.GetValue<int>());
        Assert.Equal(3, result["notes"]!.AsArray().Count(n => n!["code"]!.GetValue<string>() == "DELETE_CASCADED"));
    }

    [Fact]
    public void AConsumerRemovedLaterInTheSameJobIsNotCounted()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        const string actions = """
            {"op":"logic","data":{"actions":[
              {"name":"Pa3Old","outputs":[{"name":"R","type":"Integer"}],"steps":[{"assign":{"R":"1"}}]},
              {"name":"Pa3UsesOld","outputs":[{"name":"R","type":"Integer"}],"steps":[{"call":"Pa3Old","as":"Old"},{"assign":{"R":"Old.R"}}]}]}}
            """;
        var (result, error) = Run("later", "{\"base\":\"blank-service.oml\",\"ops\":[" + actions
            + ",{\"op\":\"delete\",\"target\":\"IServerAction:Pa3Old\"},{\"op\":\"delete\",\"target\":\"IServerAction:Pa3UsesOld\"}]}");
        Assert.True(error == null, error?.ToString());
        Assert.True(result!["isValid"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        Assert.Contains(result["results"]!.AsArray(), r => r!["result"]?["pending"]?.GetValue<bool>() == true);
        Assert.Contains(result["results"]!.AsArray(), r => r!["pendingOf"]?.GetValue<int>() == 1);
        // A consumer the job keeps still refuses it.
        var (_, kept) = Run("kept", "{\"base\":\"blank-service.oml\",\"ops\":[" + actions + ",{\"op\":\"delete\",\"target\":\"IServerAction:Pa3Old\"}]}");
        Assert.Equal("DELETE_HAS_CONSUMERS", Errors.FindCoded(Assert.IsAssignableFrom<Exception>(kept))?.Code);
    }
}
