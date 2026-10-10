using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class EntityIndexTests
{
    private static string Root {
        get { var p = Path.GetDirectoryName(typeof(EntityIndexTests).Assembly.Location)!;
            while (!File.Exists(Path.Combine(p, "MANIFESTO.md"))) p = Path.GetDirectoryName(p)!;
            return p; }
    }
    private static JsonObject Seed() => JsonNode.Parse("""
    {"base":"tests/fixtures/blank-service.oml","expectValid":true,"expectedMessages":[],"ops":[
      {"op":"spec","data":{"entities":[
        {"name":"IndexOwner","public":true,"attributes":[{"name":"Scope","type":"Text","length":50},{"name":"Code","type":"Text","length":50}]},
        {"name":"OtherOwner","public":true,"attributes":[{"name":"Code","type":"Text","length":50}]}]}},
      {"op":"create","parent":"$IndexOwner","type":"EntityIndex","name":"UQ_Key","as":"$idx","args":{"unique":true,"attributes":["$IndexOwner.Scope","$IndexOwner.Code"]}},
      {"op":"get","target":"$idx"}
    ]}
    """)!.AsObject();

    private static JsonNode Run(JsonObject job, string work, string name, string? source = null)
    {
        Directory.CreateDirectory(work);
        var path=Path.Combine(work,name+".json"); File.WriteAllText(path,job.ToJsonString());
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), source,path,Path.Combine(work,name+".oml")))!;
    }
    private static string Work() { StudioAssemblies.Bind(null); return Path.Combine(Root,".local","index-tests",Guid.NewGuid().ToString("N")); }

    [Fact]
    public void UniqueColumnsAndOrderSurviveSaveReload()
    {
        var work=Work(); var initial=Run(Seed(),work,"seed");
        Assert.True(initial["accepted"]!.GetValue<bool>(),initial.ToJsonString());
        var read=JsonNode.Parse("""{"ops":[{"op":"get","target":"EntityIndex:UQ_Key"},{"op":"find","type":"EntityIndex"}]}""")!.AsObject();
        var loaded=Run(read,work,"reload",Path.Combine(work,"seed.oml"));
        Assert.True(loaded["accepted"]!.GetValue<bool>());
        var before=initial["results"]!.AsArray().Last()!["result"]!;
        var after=loaded["results"]![0]!["result"]!;
        Assert.Equal(before.ToJsonString(),after.ToJsonString());
        Assert.True(after["properties"]!["Unique"]!.GetValue<bool>());
        Assert.Equal(new[]{"Scope","Code"},after["properties"]!["Attributes"]!.AsArray().Select(a=>a!.GetValue<string>()));
        Assert.Single(loaded["results"]![1]!["result"]!.AsArray());
    }

    [Fact]
    public void ForeignKeyAutomaticIndexIsPromotedToUniqueWithoutDuplication()
    {
        var job=Seed();var ops=job["ops"]!.AsArray();
        ops.RemoveAt(2);ops.RemoveAt(1);
        ops.Add(JsonNode.Parse("""{"op":"create","parent":"$IndexOwner","type":"IEntityAttribute","name":"OtherId","as":"$fk"}"""));
        ops.Add(JsonNode.Parse("""{"op":"set","target":"$fk","prop":"DataType","value":"OtherOwner Identifier"}"""));
        ops.Add(JsonNode.Parse("""{"op":"create","parent":"$IndexOwner","type":"EntityIndex","name":"UQ_Other","args":{"unique":true,"attributes":["$fk"]}}"""));
        var work=Work();var initial=Run(job,work,"fk");
        Assert.True(initial["accepted"]!.GetValue<bool>(),initial.ToJsonString());
        var read=JsonNode.Parse("""{"ops":[{"op":"get","target":"EntityIndex:UQ_Other"}]}""")!.AsObject();
        var loaded=Run(read,work,"fk-reload",Path.Combine(work,"fk.oml"));
        Assert.True(loaded["accepted"]!.GetValue<bool>());
        Assert.True(loaded["results"]![0]!["result"]!["properties"]!["Unique"]!.GetValue<bool>());
        var probe=MergeProbe.ThreeWay(new ModelHost(work),File.ReadAllBytes(Path.Combine(Root,"tests","fixtures","blank-service.oml")),File.ReadAllBytes(Path.Combine(work,"fk.oml")));
        Assert.False(probe.HasConflicts);Assert.Equal(0,probe.Errors);Assert.Equal(probe.ForeignObjects,probe.LocalObjects);
    }

    [Theory]
    [InlineData("foreign", "must belong")]
    [InlineData("duplicate", "repeat an attribute")]
    [InlineData("empty", "at least one")]
    [InlineData("unknown", "unknown args")]
    [InlineData("parent", "local server entity")]
    public void InvalidIndexAbortsWithoutSaving(string scenario,string message)
    {
        var job=Seed();var create=job["ops"]![1]!;
        if(scenario=="foreign")create["args"]!["attributes"]![1]="$OtherOwner.Code";
        if(scenario=="duplicate")create["args"]!["attributes"]![1]="$IndexOwner.Scope";
        if(scenario=="empty")create["args"]!["attributes"]=new JsonArray();
        if(scenario=="unknown")create["args"]!["typo"]=true;
        if(scenario=="parent")create["parent"]="@espace";
        var work=Work();var error=Assert.ThrowsAny<Exception>(()=>Run(job,work,"invalid"));
        Assert.Contains(message,Errors.Text(error));Assert.False(File.Exists(Path.Combine(work,"invalid.oml")));
    }
}
