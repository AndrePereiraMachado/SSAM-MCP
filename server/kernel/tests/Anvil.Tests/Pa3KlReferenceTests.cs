using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Atritos 3, lane kl, C30: the spellings of a reference the Studio's own tools print are accepted. An alias answers with and
/// without its $ (lab 02: `"as":"scr"` then `$scr/...`, 19 ops "unresolved reference '$scr'" after an 18 s apply); the
/// branches of an If widget answer to True/False and to #IIfBranchWidget[n] ("IIfWidget has no child 'True'").
/// </summary>
public sealed class Pa3KlReferenceTests
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

    [Fact]
    public void TheOtherSpellingOfAnAliasIsTheSameAlias()
    {
        Assert.Equal("$scr", ModelSession.AliasCounterpart("scr"));
        Assert.Equal("scr", ModelSession.AliasCounterpart("$scr"));
        Assert.Equal("$A.S2", ModelSession.AliasCounterpart("A.S2"));
        Assert.Null(ModelSession.AliasCounterpart("IMobileScreen:Home"));
        Assert.Null(ModelSession.AliasCounterpart("@espace"));
        Assert.Null(ModelSession.AliasCounterpart("$scr/Child"));
    }

    [Fact]
    public void AnAliasWithoutItsDollarResolves()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (result, error) = Run("alias", """
            {"base":"reactive-ui.oml","ops":[
              {"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"Pa3Alias","as":"scr"},
              {"op":"set","target":"$scr/#IMobileBlockInstanceWidget","prop":"SourceBlock","value":"IMobileBlock:LayoutTopMenu"},
              {"op":"create","parent":"$scr/#IMobileBlockInstanceWidget/Title","type":"IExpression","as":"$title"},
              {"op":"set","target":"title","prop":"Value","value":"\"Alias\""}]}
            """);
        Assert.True(error == null, error?.ToString());
        Assert.True(result!["isValid"]!.GetValue<bool>(), result["details"]!.ToJsonString());
    }

    [Fact]
    public void TheBranchesOfAnIfWidgetAnswerToTrueAndFalse()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (result, error) = Run("if-widget", """
            {"base":"reactive-ui.oml","ops":[
              {"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"Pa3If","as":"$scr"},
              {"op":"set","target":"$scr/#IMobileBlockInstanceWidget","prop":"SourceBlock","value":"IMobileBlock:LayoutTopMenu"},
              {"op":"create","parent":"$scr","type":"ILocalVariable","name":"Show","as":"$show"},
              {"op":"set","target":"$show","prop":"DataType","value":"Boolean"},
              {"op":"create","parent":"$scr/#IMobileBlockInstanceWidget/MainContent","type":"IIfWidget","name":"IfShow","as":"$if"},
              {"op":"set","target":"$if","prop":"Condition","value":"Show"},
              {"op":"create","parent":"$if/True","type":"IContainer","name":"Shown"},
              {"op":"create","parent":"$if/#IIfBranchWidget[2]","type":"IContainer","name":"Hidden"},
              {"op":"get","target":"$if/False/Hidden"}]}
            """);
        Assert.True(error == null, error?.ToString());
        Assert.Equal("Hidden", result!["results"]!.AsArray().Last()!["result"]!["name"]!.GetValue<string>());
    }
}
