using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public class RepresentationReachabilityTests
{
    private static CompilationResult Compile(string source) => CSharpCompiler.Compile(new Dictionary<string, string> { ["Representations.cs"] = source });
    private static string[] Structures(CompilationResult result) => (result.Specification["data"]?["structures"] as JsonArray)?.Select(s => s!["name"]!.ToString()).ToArray() ?? [];

    [Fact]
    public void PrivateTransportAndItsOptionalChildrenAreNotEmittedForArenaOnlyObjects()
    {
        const string source = """
            public static class Rules
            {
                private sealed class Node { public Node? Next; public int Value; }
                public static int Run() { var node = new Node(); node.Next = node; node.Value = 7; return node.Next.Value; }
            }
            """;
        var compiled = Compile(source);
        Assert.DoesNotContain("Node", Structures(compiled));
        Assert.DoesNotContain(compiled.SourceMap, entry => entry?["native"]?.ToString().StartsWith("Node.", StringComparison.Ordinal) == true);
        Assert.DoesNotContain(compiled.Specification["data"]!["structures"]!.AsArray(), structure => structure!["attributes"]!.AsArray().Any(attribute => attribute!["type"]!.ToString() == "Node"));
        Assert.Equal(7m, new ReferenceGraphProbe(compiled.Specification).Run("Run", new Dictionary<string, object>())["AvResult"]);
    }

    [Fact]
    public void PrivateDtoAndTransitiveMembersRemainWhenInternalMethodsUseTheirTransport()
    {
        var compiled = Compile("""
            public static class Rules
            {
                private sealed record Leaf(int Value);
                private sealed record Box(Leaf? Child);
                private static Box Make(int value) => new(new Leaf(value));
                public static int Read(int value) => Make(value).Child!.Value;
            }
            """);
        Assert.Contains("Box", Structures(compiled));
        Assert.Contains("Leaf", Structures(compiled));
        Assert.Contains(Structures(compiled), name => name.StartsWith("AvOptional_", StringComparison.Ordinal));
        Assert.Contains(compiled.SourceMap, entry => entry?["native"]?.ToString() == "Leaf.Value");
    }

    [Fact]
    public void PublicAuthoredContractsAndExplicitEntitiesRemainEvenWithoutACaller()
    {
        var compiled = Compile("""
            public sealed record Exported(int Value);
            public static class Rules
            {
                [Anvil.Authoring.Entity] private sealed class Stored { public int Id {get;set;} public string Name {get;set;} = ""; }
                public static int One() => 1;
            }
            """);
        Assert.Contains("Exported", Structures(compiled));
        Assert.Contains(compiled.Specification["data"]!["entities"]!.AsArray(), entity => entity!["name"]!.ToString() == "Stored");
    }

    [Fact]
    public void DataOnlyCompilationKeepsTheDeclaredShapeWithoutInventingLogicRoots()
    {
        const string source = "public static class Container { private sealed record Detail(string Name); }";
        var full = Compile(source);
        var data = CSharpCompiler.CompileData(new Dictionary<string, string> { ["Representations.cs"] = source });
        Assert.Contains("Detail", Structures(full));
        Assert.Equal(data.Specification.ToJsonString(), full.Specification.ToJsonString());
    }
}
