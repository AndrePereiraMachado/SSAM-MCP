using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model;
using OutSystems.Model.Enumerations;
using OutSystems.ModelAPILoader;
using ServiceStudio.Framework.ReferencesManager;
using ServiceStudio.Model;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>fix/system-reference round 2 (review C:\t\revisoes\system-ref). H1 on the ODC lane: a producer named with spaces,
/// a hyphen or outer spaces ("Flood Utilities", "Flood-Utils", "(System) ") is a NAME bound by its key, never a path; before,
/// the kernel refused it with the incident's text "points to an OML outside tests/fixtures ...". M3: a consumer whose
/// existing reference to the producer is at another signature hash than the capture is refused with its own code,
/// REFERENCE_OUTDATED, whose fix is the Studio's refresh of that reference (studio_refresh_references), never "capture again"
/// (a capture of the same published producer gives the same hash again: a loop). Synthetic producer, blank library consumer.</summary>
public class SystemReferenceRound2OdcTests
{
    [Fact]
    public void SpacedProducerNamesBindByTheirKey()
    {
        StudioAssembliesOdc.Bind();
        Run(h1: true);
    }

    [Fact]
    public void AnOutdatedReferenceIsRefreshedNotCapturedAgain()
    {
        StudioAssembliesOdc.Bind();
        Run(h1: false);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run(bool h1)
    {
        var work = Path.Combine(Path.GetTempPath(), "ssam-odc-system-ref-r2", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        NativeReferenceSnapshot Producer(string moduleName, string listedName, Guid hash)
        {
            using var producer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, moduleName,
                targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
            new ModelSession((ESpace)producer).Apply(JsonNode.Parse("""
            [
              {"op":"delete","target":"IReference:(System)","force":true},
              {"op":"create","parent":"@espace","type":"IClientAction","name":"ListAppendAll","as":"$append"},
              {"op":"set","target":"$append","prop":"Public","value":true},
              {"op":"create","parent":"$append","type":"IStartNode","as":"$start"},
              {"op":"create","parent":"$append","type":"IEndNode","as":"$end"},
              {"op":"link","from":"$start","to":"$end"}
            ]
            """)!.AsArray());
            producer.Save();
            var info = ReferenceInfo.ConvertToReferenceInfo(producer);
            return NativeReferenceSnapshot.Create(new NativeReferenceSnapshot {
                FormatVersion = 2, Environment = "lab.test", ModuleKey = info.Key.ToString(),
                ApplicationKey = info.AppKey?.ToString() ?? "", ModuleKind = ReferenceKind.eSpace,
                ModuleType = SegmentationKind.ReactiveLibrary, Name = listedName, SignatureHash = hash, SignatureBinary = info.SignatureBinary,
                Elements = OdcPublicSignature.Read(info.SignatureBinary).Elements.Select(e => new NativeReferenceElement(e.Kind, e.Name, e.Key)).ToArray() });
        }
        var hashA = Guid.Parse("a1a1a1a1-0000-1111-2222-333333333333");
        var hashB = Guid.Parse("b2b2b2b2-0000-1111-2222-333333333333");
        var system = Producer("SystemFixture", "(System)", hashA);
        var utilities = Producer("FloodUtilitiesFixture", "Flood Utilities", hashA);
        using var consumer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, "FloodQuotesFixture",
            targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        new ModelSession((ESpace)consumer).Apply(JsonNode.Parse("""[{"op":"delete","target":"IReference:(System)","force":true}]""")!.AsArray());
        var basePath = Path.Combine(work, "base.oml");
        File.WriteAllBytes(basePath, consumer.Save());
        string Write(NativeReferenceSnapshot snapshot, string name) { var file = Path.Combine(work, name); snapshot.Write(file); return file; }
        var systemA = Write(system, "System-A.avsig");
        var utilitiesA = Write(utilities, "FloodUtilities-A.avsig");
        JsonNode Apply(string basePath, string producer, IReadOnlyDictionary<string, string> bindings, string output)
        {
            var jobPath = Path.Combine(work, Guid.NewGuid().ToString("N") + ".json");
            File.WriteAllText(jobPath, new JsonObject { ["ops"] = new JsonArray(
                new JsonObject { ["op"] = "reference", ["producer"] = producer, ["elements"] = new JsonArray("ClientAction:ListAppendAll") }) }.ToJsonString());
            try { return JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, output, bindings: bindings))!; }
            catch (Exception ex) { return Errors.Envelope("apply", ex, 0); }
        }

        // H1: each spelling is a name, bound by the key the facade passes.
        if (h1) foreach (var (spec, key, file) in new[] { ("(System) ", "System", systemA), ("System ", "System", systemA),
                     ("Flood Utilities", "FloodUtilities", utilitiesA), ("(Flood Utilities)", "FloodUtilities", utilitiesA), ("Flood-Utilities", "FloodUtilities", utilitiesA) })
        {
            var result = Apply(basePath, spec, new Dictionary<string, string> { [key] = file }, Path.Combine(work, Guid.NewGuid().ToString("N") + ".oml"));
            Assert.True(result["accepted"]?.GetValue<bool>() == true, spec + ": " + result.ToJsonString());
        }
        if (h1) return;

        // M3: the consumer now references (System) at hash A; the capture of the producer is at hash B.
        var withA = Path.Combine(work, "with-system-A.oml");
        Assert.True(Apply(basePath, "(System)", new Dictionary<string, string> { ["System"] = systemA }, withA)["accepted"]?.GetValue<bool>() == true);
        var systemB = Write(system with { SignatureHash = hashB }, "System-B.avsig");
        var refused = Apply(withA, "(System)", new Dictionary<string, string> { ["System"] = systemB }, Path.Combine(work, "refused.oml"));
        var text = refused.ToJsonString();
        Assert.NotEqual(true, refused["accepted"]?.GetValue<bool>());
        var problems = (refused["problems"] ?? refused["data"]?["problems"]) as JsonArray;
        Assert.True(problems is { Count: > 0 }, text);
        var problem = problems!.OfType<JsonObject>().Single(p => p["code"]?.ToString() is "REFERENCE_OUTDATED" or "REFERENCE_IMPORT_FAILED");
        Assert.Equal("REFERENCE_OUTDATED", problem["code"]!.ToString());
        Assert.Contains("studio_refresh_references", problem["fix"]!.ToString());
        Assert.Contains("producer: \"(System)\"", problem["fix"]!.ToString());
        Assert.DoesNotContain(".avsig", problem["fix"]!.ToString());
        Assert.DoesNotContain("capture again", problem["fix"]!.ToString(), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("capture the producer again", problem["fix"]!.ToString(), StringComparison.OrdinalIgnoreCase);
        // The same capture at the hash the consumer holds is accepted: after the refresh the same delivery goes through.
        Assert.True(Apply(withA, "(System)", new Dictionary<string, string> { ["System"] = systemA }, Path.Combine(work, "again.oml"))["accepted"]?.GetValue<bool>() == true);
        if (Environment.GetEnvironmentVariable("SSAM_SYSTEM_REF_REPLAY_DIR") is { Length: > 0 } replay)
        {
            Directory.CreateDirectory(replay);
            File.Copy(withA, Path.Combine(replay, "with-system-A.oml"), overwrite: true);
            File.Copy(systemB, Path.Combine(replay, "System-B.avsig"), overwrite: true);
            File.Copy(systemA, Path.Combine(replay, "System-A.avsig"), overwrite: true);
            File.Copy(utilitiesA, Path.Combine(replay, "FloodUtilities-A.avsig"), overwrite: true);
            File.Copy(basePath, Path.Combine(replay, "base.oml"), overwrite: true);
        }
    }
}
