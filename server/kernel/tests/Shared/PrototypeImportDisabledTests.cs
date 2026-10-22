using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>The prototype import is turned off (PrototypeImport, owner decision of 2026-10-22), the same on both lanes: a job
/// with the op prototype is refused with PROTOTYPE_IMPORT_DISABLED before the base, a producer or the apply is touched, one
/// problem per op, and no surface of the kernel (api --op, the verb table) offers the op any more.</summary>
public sealed class PrototypeImportDisabledTests
{
    private static string Kernel => JobSources.KernelRoot()!;
    private static string Lane => typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc") == null ? "o11" : "odc";
    private static string Work() { var dir = Path.Combine(Kernel, ".local", "prototype-off", Lane, Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir); return dir; }
    private static JsonObject Proto() => new() { ["op"] = "prototype", ["data"] = new JsonObject { ["source"] = "C:/protos/shop", ["capture"] = "C:/protos/shop/capture.json" } };

    [Fact]
    public void AJobWithThePrototypeOpIsRefusedBeforeTheBaseIsLoadedWithOneProblemPerOp()
    {
        var dir = Work();
        // A base that does not exist: a kernel that went on to load it would answer a file error, never this refusal.
        var job = new JsonObject { ["base"] = Path.Combine(dir, "missing-base.oml"), ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray() } }, Proto(), Proto()) };
        var path = Path.Combine(dir, "job.json"); File.WriteAllText(path, job.ToJsonString());
        var output = Path.Combine(dir, "candidate.oml");
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "runtime")), null, path, output));
        var envelope = Errors.Envelope("apply", error, 0);
        Assert.Equal(PrototypeImport.DisabledCode, envelope["code"]!.GetValue<string>());
        Assert.StartsWith("The prototype import is turned off: the op prototype is no longer supported, and nothing ran", error.Message);
        var problems = envelope["problems"]!.AsArray().OfType<JsonObject>().ToList();
        Assert.Equal(["/ops/1", "/ops/2"], problems.Select(p => p["pointer"]!.GetValue<string>()));
        Assert.All(problems, p => Assert.Equal(PrototypeImport.DisabledCode, p["code"]!.GetValue<string>()));
        Assert.All(problems, p => Assert.Contains("ssam_code (part html", p["fix"]!.GetValue<string>()));
        Assert.False(File.Exists(output), "nothing is written");
    }

    [Fact]
    public void ACompositeJobWithThePrototypeOpInAPartIsRefusedTheSameWay()
    {
        var dir = Work();
        File.WriteAllText(Path.Combine(dir, "screens.json"), new JsonObject { ["ops"] = new JsonArray(Proto()) }.ToJsonString());
        var path = Path.Combine(dir, "all.json");
        File.WriteAllText(path, new JsonObject { ["base"] = Path.Combine(dir, "missing-base.oml"), ["jobs"] = new JsonArray("job:screens") }.ToJsonString());
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "runtime")), null, path, Path.Combine(dir, "candidate.oml")));
        Assert.Equal(PrototypeImport.DisabledCode, Errors.FindCoded(error)?.Code);
    }

    [Fact]
    public void TheJobAloneCheckRefusesTheOpWithTheSameCodeWithoutReadingItsData()
    {
        var result = JobPreflight.Analyze(new JsonArray(new JsonObject { ["op"] = "prototype", ["data"] = new JsonObject { ["nonsense"] = new JsonArray(1, 2) } }));
        Assert.False(result["valid"]!.GetValue<bool>());
        var problem = Assert.Single(result["problems"]!.AsArray().OfType<JsonObject>());
        Assert.Equal(PrototypeImport.DisabledCode, problem["code"]!.GetValue<string>());
        Assert.Equal("/ops/0", problem["pointer"]!.GetValue<string>());
    }

    [Fact]
    public void NoKernelSurfaceOffersThePrototypeOp()
    {
        Assert.DoesNotContain("prototype", CommandSurface.OperationNames);
        Assert.DoesNotContain("prototype", VerbSurface.Names);
        Assert.Throws<ArgumentException>(() => CommandSurface.Schema("prototype"));
    }
}
