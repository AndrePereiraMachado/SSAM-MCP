using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class AutoPatchSourceRevisionTests
{
    private static string Kernel => JobSources.KernelRoot()!;
    private static string Lane => typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc") == null ? "o11" : "odc";
    private static string Blank => Lane == "o11" ? "blank-service.oml"
        : Path.Combine(Kernel, "tests", "fixtures", "odc", "blank-mobile.oml");
    private static string Work() { var dir = Path.Combine(Kernel, ".local", "source-revision", Lane, Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir); return dir; }
    private static JsonObject DateJob(string name) => JsonNode.Parse("""
        {"ops":[{"op":"logic","data":{"actions":[{"name":"NAME","outputs":[{"name":"At","type":"Date Time"}],"steps":[{"assign":{"At":"If(True, NullDateTime(), CurrDateTime())"}}]}]}}]}
        """.Replace("NAME", name))!.AsObject();
    private static JsonObject Run(string dir, string job, string output, IReadOnlyDictionary<string,string>? bindings = null)
        => JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "runtime-" + Guid.NewGuid().ToString("N"))), null, job, output, bindings: bindings))!.AsObject();

    [Fact]
    public void RootJobOptOutIsInheritedByItsBaseJobAndIdentifiesTheRefusedSource()
    {
        var dir = Work(); var producer = DateJob("BaseHelper"); producer["base"] = Blank;
        File.WriteAllText(Path.Combine(dir, "vbase.json"), producer.ToJsonString());
        var root = new JsonObject { ["base"] = "job:vbase", ["autoPatch"] = false, ["ops"] = new JsonArray() };
        var job = Path.Combine(dir, "consumer.json"); File.WriteAllText(job, root.ToJsonString());
        var error = Assert.ThrowsAny<Exception>((Action)(() => Run(dir, job, Path.Combine(dir, "candidate.oml"))));
        var envelope = Errors.Envelope("apply", error, 0);
        Assert.Contains("vbase", envelope.ToJsonString(), StringComparison.OrdinalIgnoreCase);
        Assert.Equal("base", envelope["sourceJob"]?["role"]?.ToString());
        Assert.Equal("job:vbase", envelope["sourceJob"]?["spec"]?.ToString());
    }

    [Fact]
    public void CorrectedBaseJobsExposeTheirOwnReceiptsOnTheRootResult()
    {
        var dir = Work(); var producer = DateJob("BaseHelper"); producer["base"] = Blank;
        File.WriteAllText(Path.Combine(dir, "vbase.json"), producer.ToJsonString());
        var job = Path.Combine(dir, "consumer.json"); File.WriteAllText(job, "{\"base\":\"job:vbase\",\"ops\":[]}");
        var result = Run(dir, job, Path.Combine(dir, "candidate.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var source = Assert.Single(result["sourceBuilds"]!.AsArray().OfType<JsonObject>());
        Assert.Equal("base", source["role"]!.ToString()); Assert.Equal("job:vbase", source["spec"]!.ToString());
        Assert.Single(source["patchesApplied"]!.AsArray()); Assert.NotNull(source["normalizations"]); Assert.NotNull(source["patchedJob"]);
    }

    // fix/prototype-off: the case "prototype" (a source build named by a prototype op's data.bind) is gone with the op, which
    // the kernel now refuses before any source is built (PrototypeImportDisabledTests).
    [Theory]
    [InlineData("producer")]
    public void RootOptOutAlsoReachesReferenceSourceBuilds(string role)
    {
        var dir = Work(); var producer = DateJob("SourceHelper"); producer["base"] = Blank;
        File.WriteAllText(Path.Combine(dir, "vproducer.json"), producer.ToJsonString());
        var op = new JsonObject { ["op"] = "reference", ["producer"] = "job:vproducer", ["elements"] = new JsonArray() };
        var job = Path.Combine(dir, "consumer.json"); File.WriteAllText(job, new JsonObject { ["base"] = Blank, ["autoPatch"] = false, ["ops"] = new JsonArray(op) }.ToJsonString());
        var error = Assert.ThrowsAny<Exception>((Action)(() => Run(dir, job, Path.Combine(dir, "candidate.oml"))));
        var envelope = Errors.Envelope("apply", error, 0);
        Assert.Equal(role, envelope["sourceJob"]?["role"]?.ToString()); Assert.Equal("job:vproducer", envelope["sourceJob"]?["spec"]?.ToString());
        Assert.DoesNotContain("patchesApplied", envelope["sourceBuilds"]?.ToJsonString() ?? "");
    }

    [Fact]
    public void CorrectedJobsReplayThroughSourcesWithTheirWrittenBindingsAndBaseJob()
    {
        var dir = Work(); var outputDir = Path.Combine(dir, "output"); Directory.CreateDirectory(outputDir);
        File.WriteAllText(Path.Combine(dir, "base-part.json"), new JsonObject { ["base"] = Blank, ["ops"] = new JsonArray() }.ToJsonString());
        var sent = DateJob("ConsumerDate"); sent["base"] = "job:base-part";
        sent["ops"]!.AsArray().Insert(0, new JsonObject { ["op"] = "reference", ["producer"] = "Primitive",
            ["elements"] = new JsonArray(Lane == "odc" ? "IServiceAction:CovSService" : "IServerActionSignature:CSharpTextCompareOrdinal") });
        var bindings = new Dictionary<string,string> { ["Primitive"] = Lane == "odc"
            ? Path.Combine(Kernel, "tests", "fixtures", "odc", "blank-mobile-producer.oml")
            : Path.Combine(Kernel, "tests", "contracts", "native-reference", "ordinal-primitive.avsig") };
        var job = Path.Combine(dir, "consumer.json"); File.WriteAllText(job, sent.ToJsonString());
        var result = Run(dir, job, Path.Combine(outputDir, "candidate.oml"), bindings);
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var correctedPath = result["patchedJob"]!["path"]!.ToString(); var corrected = JobDocument.Parse(correctedPath);
        Assert.Equal("job:base-part", corrected["base"]!.ToString()); Assert.Equal("Primitive", corrected["ops"]![0]!["producer"]!.ToString());
        var replay = Run(dir, correctedPath, Path.Combine(outputDir, "replay.oml"), bindings);
        Assert.True(replay["accepted"]!.GetValue<bool>(), replay.ToJsonString()); Assert.True(replay["isValid"]!.GetValue<bool>());
        Assert.Null(replay["patchesApplied"]);
    }

    [Fact]
    public void ACorrectedSourceCachedWithAutoOnCannotBypassAnOffDependency()
    {
        var dir = Work(); var common = DateJob("CommonHelper"); common["base"] = Blank;
        File.WriteAllText(Path.Combine(dir, "common.json"), common.ToJsonString());
        File.WriteAllText(Path.Combine(dir, "off-parent.json"), "{\"base\":\"job:common\",\"autoPatch\":false,\"ops\":[]}");
        var job = Path.Combine(dir, "consumer.json"); File.WriteAllText(job, new JsonObject { ["base"] = Blank, ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "reference", ["producer"] = "job:common", ["elements"] = new JsonArray() },
            new JsonObject { ["op"] = "reference", ["producer"] = "job:off-parent", ["elements"] = new JsonArray() }) }.ToJsonString());
        var error = Assert.ThrowsAny<Exception>((Action)(() => Run(dir, job, Path.Combine(dir, "candidate.oml"))));
        Assert.Equal("job:common", Errors.Envelope("apply", error, 0)["sourceJob"]?["spec"]?.ToString());
    }
}
