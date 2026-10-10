using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Atritos 3, lane kl, C24 (D3): the job reader never leaks a raw System.Text.Json exception. A job written as a bare array
/// of ops is {ops:[...]} for every reader (DCIPS: "The node must be of type 'JsonObject'" on validate-job); a field of the
/// wrong JSON type is a JSON_SHAPE problem with its pointer, the shape expected and, when unambiguous, the patch (Davi: 4x
/// "The node must be of type JsonValue" for record:{}; DCIPS: SPEC_INVALID 'JsonArray').
/// </summary>
public sealed class Pa3KlJsonTests
{
    private static readonly string Root = PacoteBPolicyTests.FindRoot();

    private static JsonObject Analyze(string json)
    {
        var job = JsonNode.Parse(json)!;
        return JobPreflight.Analyze(job is JsonArray a ? a : job["ops"]!.AsArray(), job, []);
    }

    private static JsonObject[] Shapes(JsonObject result) => result["problems"]!.AsArray().OfType<JsonObject>().Where(p => p["code"]!.GetValue<string>() == "JSON_SHAPE").ToArray();

    [Fact]
    public void AFieldOfTheWrongJsonTypeIsAJsonShapeProblemWithItsPointerAndPatch()
    {
        var result = Analyze("""
            {"ops":[
              {"op":"logic","data":{"actions":[{"name":"A","outputs":[{"name":"X","type":"Integer"}],"steps":[{"assign":{"X":1}},{"if":"True","then":{"assign":{"X":"2"}}}]}]}},
              {"op":"spec","data":{"entities":{"name":"E"}}},
              {"op":"create","parent":"@espace","type":"IStructure","name":"S","empty":"true"}]}
            """);
        var shapes = Shapes(result);
        Assert.Equal(["/ops/0/data/actions/0/steps/0/assign/X", "/ops/0/data/actions/0/steps/1/then", "/ops/1/data/entities", "/ops/2/empty"],
            shapes.Select(s => s["pointer"]!.GetValue<string>()).Order(StringComparer.Ordinal));
        Assert.Equal("1", shapes.Single(s => s["pointer"]!.GetValue<string>().EndsWith("/X", StringComparison.Ordinal))["patch"]![0]!["value"]!.GetValue<string>());
        Assert.True(shapes.Single(s => s["pointer"]!.GetValue<string>().EndsWith("/empty", StringComparison.Ordinal))["patch"]![0]!["value"]!.GetValue<bool>());
        Assert.IsType<JsonArray>(shapes.Single(s => s["pointer"]!.GetValue<string>() == "/ops/1/data/entities")["patch"]![0]!["value"]);
        Assert.All(result["errors"]!.AsArray(), e => Assert.DoesNotContain("must be of type", e!.GetValue<string>()));
    }

    [Fact]
    public void ARecordObjectIsAcceptedAndARecordArrayIsAShape()
    {
        var accepted = Analyze("""{"ops":[{"op":"logic","data":{"actions":[{"name":"A","steps":[{"create":"Product","record":{"Name":"\"x\""}}]}]}}]}""");
        Assert.Empty(Shapes(accepted));
        var refused = Analyze("""{"ops":[{"op":"logic","data":{"actions":[{"name":"A","steps":[{"create":"Product","record":["x"]}]}]}}]}""");
        var shape = Assert.Single(Shapes(refused));
        Assert.Equal("/ops/0/data/actions/0/steps/0/record", shape["pointer"]!.GetValue<string>());
        Assert.Contains("object {\"Field\": \"expression\"}", shape["fix"]!.GetValue<string>());
    }

    [Fact]
    public void AnArrayJobIsTheOpsOfAnObjectForEveryReader()
    {
        var dir = Path.Combine(Root, ".local", "pa3-kl-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "array.json");
        File.WriteAllText(path, """[{"op":"create","parent":"@espace","type":"IStructure","name":"Pa3ArrayJob","as":"$s"},{"op":"create","parent":"$s","type":"IStructureAttribute","name":"Code","as":"$a"},{"op":"set","target":"$a","prop":"DataType","value":"Text"}]""");
        var document = ModuleSpecification.SourceDocument(path);
        Assert.Equal(3, document["ops"]!.AsArray().Count);
        Assert.Null(document["expectedMessages"]);
        Assert.Empty(MessageExpectations.Read(document, path));
        var check = JobPreflight.Check(path);
        Assert.True(check["valid"]!.GetValue<bool>(), check["errors"]!.ToJsonString());
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        // The whole O11 path: apply and the provenance stamp read it (the stamp read it as an object before).
        var result = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), Path.Combine(Root, "tests", "fixtures", "blank-service.oml"), path, Path.Combine(dir, "array.oml")))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]!.ToJsonString());
        Assert.Equal("tests/fixtures/blank-service.oml", JobProvenance.Stamp("Anvil.Tests", path, null)["base"]!.GetValue<string>());
    }

    [Fact]
    public void ARawCastInsideACompilerBecomesAShapeNeverItsText()
    {
        // A value the shape table does not know (a step key of the wrong type deep in a native node) still never leaks.
        var result = Analyze("""{"ops":[{"op":"logic","data":{"actions":[{"name":"A","steps":[{"node":"IJSONSerializeNode","as":{"x":1},"properties":{"Data":"1"}}]}]}}]}""");
        Assert.False(result["valid"]!.GetValue<bool>());
        Assert.All(result["errors"]!.AsArray(), e => Assert.DoesNotContain("The node must be of type", e!.GetValue<string>()));
        Assert.Contains(Shapes(result), s => s["pointer"]!.GetValue<string>() == "/ops/0/data/actions/0/steps/0/as");
    }
}
