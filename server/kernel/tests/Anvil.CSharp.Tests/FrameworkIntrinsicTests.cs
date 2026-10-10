using System.Text.Json.Nodes;
using Anvil.CSharp;
using Xunit;

namespace Anvil.CSharp.Tests;

public class FrameworkIntrinsicTests
{
    [Theory]
    [InlineData("OrderBy")]
    [InlineData("OrderByDescending")]
    public void OrdinalSourceDeclaresOneTypedRequirementAndBindsWithoutChangingAuthorship(string order)
    {
        var source=Source.Replace("ORDER",order,StringComparison.Ordinal);
        var compiled=CSharpCompiler.Compile(new Dictionary<string,string>{{"Report.cs",source}});
        var requirement=Assert.Single(compiled.RequiredIntrinsics!);
        Assert.Equal(FrameworkIntrinsic.CompareOrdinal,requirement);
        var original=compiled.Specification.ToJsonString();
        Assert.Contains(requirement.Reference,original);
        var bound=FrameworkIntrinsic.Bind(compiled,new Dictionary<string,string>{{requirement.Reference,"IServerActionSignature:@producer/original"}});
        Assert.Equal(original,compiled.Specification.ToJsonString());
        Assert.Equal(compiled.SourceHash,bound.SourceHash);Assert.Same(compiled.SourceMap,bound.SourceMap);
        Assert.Same(compiled.RetiredStructures,bound.RetiredStructures);Assert.Same(compiled.RequiredIntrinsics,bound.RequiredIntrinsics);
        Assert.DoesNotContain(requirement.Reference,bound.Specification.ToJsonString());
        Assert.Contains("IServerActionSignature:@producer/original",bound.Specification.ToJsonString());
        Assert.Throws<ArgumentException>(()=>FrameworkIntrinsic.Bind(compiled,new Dictionary<string,string>()));
        Assert.Throws<ArgumentException>(()=>FrameworkIntrinsic.Bind(compiled,new Dictionary<string,string>{{requirement.Reference,"target"},{"Unexpected","target"}}));
    }

    [Fact]
    public void BinderTraversesLexicalBodiesAndHandlersButNeverRewritesUserValues()
    {
        var intrinsic=FrameworkIntrinsic.CompareOrdinal;var reference=intrinsic.Reference;
        JsonObject Call()=>new(){["call"]=reference,["as"]="Compare",["args"]=new JsonObject{["Left"]="Left",["Right"]="Right"}};
        var callData=new JsonObject{["call"]=reference};
        var literal=new JsonObject{["assign"]=new JsonObject{["Message"]=reference,["Record"]=callData}};
        var contract=new JsonObject{["logic"]=new JsonObject{["actions"]=new JsonArray(new JsonObject{
            ["steps"]=new JsonArray(new JsonObject{["switch"]=new JsonArray(new JsonObject{["when"]="True",["steps"]=new JsonArray(Call())}),
                ["otherwise"]=new JsonArray(new JsonObject{["while"]="True",["do"]=new JsonArray(Call()),["next"]=new JsonArray(Call())})},literal),
            ["handlers"]=new JsonArray(new JsonObject{["steps"]=new JsonArray(new JsonObject{["if"]="True",["then"]=new JsonArray(Call()),["else"]=new JsonArray(Call())})})})}};
        var compiled=new CompilationResult(contract,new JsonArray(),"source",RequiredIntrinsics:[intrinsic]);
        var bound=FrameworkIntrinsic.Bind(compiled,new Dictionary<string,string>{{reference,"NativeTarget"}});
        var actual=bound.Specification["logic"]!["actions"]![0]!;
        Assert.Equal("NativeTarget",actual["steps"]![0]!["switch"]![0]!["steps"]![0]!["call"]!.ToString());
        Assert.Equal("NativeTarget",actual["steps"]![0]!["otherwise"]![0]!["do"]![0]!["call"]!.ToString());
        Assert.Equal("NativeTarget",actual["steps"]![0]!["otherwise"]![0]!["next"]![0]!["call"]!.ToString());
        Assert.Equal("NativeTarget",actual["handlers"]![0]!["steps"]![0]!["then"]![0]!["call"]!.ToString());
        Assert.Equal("NativeTarget",actual["handlers"]![0]!["steps"]![0]!["else"]![0]!["call"]!.ToString());
        Assert.Equal(literal.ToJsonString(),actual["steps"]![1]!.ToJsonString());
        Assert.Throws<ArgumentException>(()=>FrameworkIntrinsic.Bind(compiled with{RequiredIntrinsics=[]},new Dictionary<string,string>()));
    }
    private const string Source="""
        using System;
        using System.Linq;
        using System.Collections.Generic;
        using Anvil.Authoring;
        [Entity] public record Item(Id<Item> Id, string? Name);
        public record Summary(string? Name, int Count);
        public static class Reports {
            public static List<Summary> Read(IDataSession data) => data.Query<Item>()
                .GroupBy(row=>row.Name).Select(group=>new Summary(group.Key,group.Count()))
                .ORDER(row=>row.Name,StringComparer.Ordinal).ToList();
        }
        """;
}
