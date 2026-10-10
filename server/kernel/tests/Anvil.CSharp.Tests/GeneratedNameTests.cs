using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public class GeneratedNameTests
{
    [Fact]
    public void GeneratedReferenceImplementationNamesStayBoundedAndTheirCallsUseThoseNames()
    {
        var name = "BusinessMethodWithAnIntentionallyLongDescriptiveNameThatMustRemainNatural";
        var source = "public static class Rules { public static int " + name + "() { var values = new List<int>(); values.Add(7); return values.Count; } }";
        var compiled = CSharpCompiler.CompileReferenceGraph(new Dictionary<string,string> { ["LongName.cs"] = source });
        var actions = compiled.Specification["logic"]!["actions"]!.AsArray();
        Assert.All(actions, action => Assert.InRange(action!["name"]!.ToString().Length, 1, 48));
        var mapping = Assert.Single(compiled.SourceMap.OfType<JsonObject>(), entry => entry.ContainsKey("implementation"));
        var implementation = mapping["implementation"]!.ToString();
        Assert.Contains(actions, action => action!["name"]!.ToString() == implementation);
        var entry = Assert.Single(actions, action => action!["name"]!.ToString() == mapping["native"]!.ToString());
        Assert.Contains(entry!["steps"]!.AsArray(), step => step?["call"]?.ToString() == implementation);
        Assert.Equal(1m, new ReferenceGraphProbe(compiled.Specification).Run(mapping["native"]!.ToString())["AvResult"]);
    }

    [Fact]
    public void RepeatedGeneratedNameCollisionsDoNotGrowPastTheNativeLimit()
    {
        var occupied = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var preferred = new string('A', 48);
        for (var i = 0; i < 100; i++)
        {
            var value = SymbolNames.Allocate(preferred, occupied.Contains);
            Assert.InRange(value.Length, 1, 48); Assert.True(occupied.Add(value));
        }
    }
}
