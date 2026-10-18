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

/// <summary>fix/system-reference round 3 (review C:\t\revisoes\system-ref-2, H1-R) on the ODC lane, through the apply the CLI
/// runs: a library the consumer session lists as "Wright/Flood Lib" is referenced by its exact name and bound by the letters
/// and digits of that listed name (WrightFloodLib), as the delivery binds it; "..\System" bound the same way to a (System)
/// capture is refused. Synthetic producer, blank library consumer.</summary>
public class SystemReferenceRound3OdcTests
{
    [Fact]
    public void AProducerListedWithASlashIsReferencedByItsExactName()
    {
        StudioAssembliesOdc.Bind();
        Run();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run()
    {
        var work = Path.Combine(Path.GetTempPath(), "ssam-odc-system-ref-r3", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        NativeReferenceSnapshot Producer(string moduleName, string listedName)
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
                ModuleType = SegmentationKind.ReactiveLibrary, Name = listedName, SignatureHash = Guid.Parse("c3c3c3c3-0000-1111-2222-333333333333"),
                SignatureBinary = info.SignatureBinary,
                Elements = OdcPublicSignature.Read(info.SignatureBinary).Elements.Select(e => new NativeReferenceElement(e.Kind, e.Name, e.Key)).ToArray() });
        }
        using var consumer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, "FloodQuotesFixture",
            targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        new ModelSession((ESpace)consumer).Apply(JsonNode.Parse("""[{"op":"delete","target":"IReference:(System)","force":true}]""")!.AsArray());
        var basePath = Path.Combine(work, "base.oml");
        File.WriteAllBytes(basePath, consumer.Save());
        var slashed = Path.Combine(work, "WrightFloodLib.avsig"); Producer("WrightFloodLibFixture", "Wright/Flood Lib").Write(slashed);
        var system = Path.Combine(work, "System.avsig"); Producer("SystemFixture", "(System)").Write(system);
        JsonNode Apply(string producer, string key, string file)
        {
            var jobPath = Path.Combine(work, Guid.NewGuid().ToString("N") + ".json");
            File.WriteAllText(jobPath, new JsonObject { ["ops"] = new JsonArray(
                new JsonObject { ["op"] = "reference", ["producer"] = producer, ["elements"] = new JsonArray("ClientAction:ListAppendAll") }) }.ToJsonString());
            try { return JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, Path.ChangeExtension(jobPath, ".oml"), bindings: JobSources.ParseBindings([key + "=" + file])))!; }
            catch (Exception ex) { return Errors.Envelope("apply", ex, 0); }
        }
        var accepted = Apply("Wright/Flood Lib", "WrightFloodLib", slashed);
        Assert.True(accepted["accepted"]?.GetValue<bool>() == true, accepted.ToJsonString());
        Assert.Equal("Wright/Flood Lib", accepted["results"]![0]!["result"]!["producer"]!.ToString());
        var refused = Apply(@"..\System", "System", system);
        Assert.NotEqual(true, refused["accepted"]?.GetValue<bool>());
        Assert.Contains("a name with / or \\ binds only to a capture", refused.ToJsonString().Replace("\\\\", "\\"));
        Assert.DoesNotContain("points to an OML", refused.ToJsonString());
    }
}
