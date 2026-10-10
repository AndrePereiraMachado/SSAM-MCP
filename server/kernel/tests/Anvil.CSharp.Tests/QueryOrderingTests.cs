using Anvil.CSharp;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public class QueryOrderingTests
{
    [Theory]
    [InlineData(".Select(item => item.Name).OrderBy(name => name, StringComparer.CurrentCulture)")]
    [InlineData(".Join(data.Query<Item>(), left => left.Name, right => right.Name, (left,right) => left.Name, StringComparer.OrdinalIgnoreCase)")]
    public void ACustomComparerIsNeverSilentlyIgnored(string query)
    {
        var source = $$"""
            using Anvil.Authoring;
            [Entity] public sealed record Item(Id<Item> Id, string Name);
            public static class Reports {
                public static List<string> Names(IDataSession data) => data.Query<Item>()
                    {{query}}.ToList();
            }
            """;
        var error = Assert.Throws<SourceCompilationException>(() => CSharpCompiler.Compile(new Dictionary<string,string> { ["Report.cs"] = source }));
        Assert.Contains(error.Diagnostics, diagnostic => diagnostic.File == "Report.cs" && diagnostic.Message.Contains("comparer",StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("ColdQueryProjection","cold-query-projection",5)]
    [InlineData("ColdGrouping","cold-group-authoring",3)]
    [InlineData("ColdAveragePipeline","cold-average-pipeline",2)]
    public void ColdProjectionJoinAndGroupingSourceCompilesWithoutBusinessGraphAuthorship(string fixture,string directory,int count)
    {
        var source = File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Cases",fixture+".cs.txt"));
        var result = CSharpCompiler.Compile(new Dictionary<string,string> { ["Scenario.cs"] = source });
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (!File.Exists(Path.Combine(root.FullName,"MANIFESTO.md"))) root = root.Parent!;
        var work=Path.Combine(root.FullName,".local/data-logic-translator/query-ordering-proofs",Guid.NewGuid().ToString("N"),directory);
        Directory.CreateDirectory(work);
        File.WriteAllText(Path.Combine(work,"translated-contract.json"),result.Specification.ToJsonString());
        File.WriteAllText(Path.Combine(work,"translated-map.json"),result.SourceMap.ToJsonString());
        var authored=result.SourceMap.OfType<JsonObject>().Where(entry=>entry["kind"]?.ToString() is "server" or "service").Select(entry=>entry["native"]!.ToString()).ToHashSet();
        Assert.Equal(count,authored.Count);
        foreach (var action in result.Specification["logic"]!["actions"]!.AsArray().Where(action=>authored.Contains(action!["name"]!.ToString())))
            Assert.Single(action!["steps"]!.AsArray().OfType<JsonObject>(),step=>step["sql"]?.GetValue<bool>()==true);
        Assert.Equal(result.Specification.ToJsonString(), CSharpCompiler.Compile(new Dictionary<string,string> { ["Scenario.cs"] = source }).Specification.ToJsonString());
    }
    [Fact]
    public void PaginationAndOrderingCompileAsDatabaseQueriesWithoutListPrefixCopies()
    {
        var source=File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Cases","QueryOrdering.cs.txt"));
        var compiled=CSharpCompiler.Compile(new Dictionary<string,string> {["Queries.cs"]=source});
        var root=new DirectoryInfo(Path.GetDirectoryName(typeof(QueryOrderingTests).Assembly.Location)!);
        while(!File.Exists(Path.Combine(root.FullName,"MANIFESTO.md")))root=root.Parent!;
        var output=Path.Combine(root.FullName,".local/data-logic-translator/query-ordering-proofs",Guid.NewGuid().ToString("N"),"query-ordering-contract.json");Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        File.WriteAllText(output,compiled.Specification.ToJsonString());
        var actions=compiled.Specification["logic"]!["actions"]!.AsArray();Assert.Equal(18,actions.Count);
        foreach(var action in actions)
        {
            var sql=action!["steps"]!.AsArray().OfType<JsonObject>().Single(s=>s["sql"]?.GetValue<bool>()==true);
            Assert.False(sql.ContainsKey("start"));Assert.False(sql.ContainsKey("max"));
        }
    }
}
