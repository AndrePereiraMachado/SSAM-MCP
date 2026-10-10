using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Atritos 3, lane kl, C17: the kernel never writes what the Studio normalizes at merge. A Refresh Data of a Data Action keeps
/// no Max. Records (labs 21, 22 and 24: `Max. Records[] / Max. Records[50] [RemovedFromLocal]`, the merge removed the 50 the
/// kernel wrote); the Refresh Data of an aggregate still takes the aggregate's. Icons and the Delete Rule of a reference to
/// another app are ODC rules (Pa3KlOdcTests); here the table is injected and O11 is unchanged without one.
/// </summary>
public sealed class Pa3KlNormalizeTests
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
    public void TheRefreshOfADataActionLeavesMaxRecordsEmpty()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (result, error) = Run("refresh-data-action", """
            {"base":"reactive-ui.oml","ops":[
              {"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"Pa3Kpis","as":"$scr"},
              {"op":"set","target":"$scr/#IMobileBlockInstanceWidget","prop":"SourceBlock","value":"IMobileBlock:LayoutTopMenu"},
              {"op":"logic","data":{"actions":[
                {"name":"GetKpis","kind":"data","owner":"IMobileScreen:Pa3Kpis","fetch":"OnDemand","outputs":[{"name":"Total","type":"Integer"}],"steps":[{"assign":{"Total":"1"}}]},
                {"name":"Reload","kind":"screen","owner":"IMobileScreen:Pa3Kpis","steps":[{"node":"IRefreshDataNode","as":"RefreshKpis","properties":{"DataSource":"IMobileScreen:Pa3Kpis/GetKpis"}}]}]}},
              {"op":"create","parent":"$scr/#IMobileBlockInstanceWidget/MainContent","type":"IButton","name":"BtnReload","as":"$btn"},
              {"op":"set","target":"$btn/OnClick","prop":"Destination","value":"IMobileScreen:Pa3Kpis/Reload"},
              {"op":"get","target":"IMobileScreen:Pa3Kpis/Reload/**IRefreshDataNode"}]}
            """);
        Assert.True(error == null, error?.ToString());
        var refresh = result!["results"]!.AsArray().Last()!["result"]!["properties"]!.AsObject();
        Assert.True(refresh.ContainsKey("MaxRecords"), refresh.ToJsonString());
        Assert.True(string.IsNullOrEmpty(refresh["MaxRecords"]?.ToString()), refresh.ToJsonString());
    }

    [Fact]
    public void WithoutAnIconTableTheIconIsWrittenAsGiven()
    {
        // O11 (no conversion table in this build): nothing changes; the ODC lane converts (Pa3KlOdcTests).
        Assert.Null(IconCatalog.Current);
        var table = new IconCatalog.IconTable("Phosphor2.0", new HashSet<string> { "shopping-cart", "shopping-cart-simple", "x" },
            new Dictionary<string, (string, string?)> { ["cart-plus"] = ("shopping-cart", "fill"), ["times"] = ("x", "") });
        Assert.Equal(("shopping-cart", "fill", true), Verdict("cart-plus"));
        Assert.Equal(("x", null, true), Verdict("times"));
        Assert.Equal(("shopping-cart", null, false), Verdict("shopping-cart"));
        var unknown = IconCatalog.Judge("nao-existe", table);
        Assert.True(unknown.Unknown);
        Assert.NotEmpty(unknown.Closest);

        (string, string?, bool) Verdict(string name) { var v = IconCatalog.Judge(name, table); return (v.Name, v.Weight, v.Converted); }
    }
}
