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

/// <summary>fix/system-reference (owner, 2026-10-15): the job shape of the incident, an ODC module that adds the client action
/// ListAppendAll of (System) through a reference op, accepted in one run. The producer is synthetic: a library with a public
/// client action ListAppendAll whose capture envelope carries the name the ODC Studio lists the system producer by,
/// "(System)" (ReferencesService.ListReferenceable); the consumer is a blank library. Before the fix the kernel read "(System)" as a
/// path and refused it ("points to an OML outside tests/fixtures and outside the SSAM capture folders"). With
/// SSAM_SYSTEM_REF_REPLAY_DIR set, the base, the capture and the job are also written there for the CLI replay.</summary>
public class SystemProducerReferenceOdcTests
{
    [Fact]
    public void AnOdcAppReferencingSystemListAppendAllIsAcceptedInEachSpelling()
    {
        StudioAssembliesOdc.Bind();
        Run();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run()
    {
        var work = Path.Combine(Path.GetTempPath(), "ssam-odc-system-ref", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work); // the runtime creates its work folder only on the first Ensure of the process
        var host = new ModelHost(work);
        NativeReferenceSnapshot snapshot;
        using (var producer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, "SystemFixture",
                   targetPlatform: PlatformServerVersion.Neo, enableTransactions: true))
        {
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
            snapshot = NativeReferenceSnapshot.Create(new NativeReferenceSnapshot {
                FormatVersion = 2, Environment = "lab.test", ModuleKey = info.Key.ToString(),
                ApplicationKey = info.AppKey?.ToString() ?? "", ModuleKind = ReferenceKind.eSpace,
                ModuleType = SegmentationKind.ReactiveLibrary, Name = "(System)",
                // Test-only identity: the fixture is deliberately not published to a tenant.
                SignatureHash = Guid.Parse("5e5e5e5e-0000-1111-2222-333333333333"), SignatureBinary = info.SignatureBinary,
                Elements = OdcPublicSignature.Read(info.SignatureBinary).Elements.Select(e => new NativeReferenceElement(e.Kind, e.Name, e.Key)).ToArray()
            });
        }
        Assert.Contains(snapshot.Elements, e => e.Kind == "client-action" && e.Name == "ListAppendAll");
        using var consumer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, "FloodQuotesFixture",
            targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        // A blank module already references the real (System) (key uXCIR2Atc0+es3zYuZSnNw, ListAppendAll included): the
        // synthetic producer stands for it, so the consumer starts without it, as a module whose (System) lacks the element.
        // The consumer is a library: an app without (System) loses its AppRole's User Identifier type and is invalid, and the
        // kernel accepts only a valid candidate; the producer name, its binding and the import are the same for an app.
        new ModelSession((ESpace)consumer).Apply(JsonNode.Parse("""[{"op":"delete","target":"IReference:(System)","force":true}]""")!.AsArray());
        var basePath = Path.Combine(work, "base.oml");
        File.WriteAllBytes(basePath, consumer.Save());
        var signaturePath = Path.Combine(work, "System.avsig");
        snapshot.Write(signaturePath);
        // The incident's element form (no "I") and the interface form; each spelling of the producer; both binding forms.
        var cases = new[] { ("(System)", "System", "ClientAction:ListAppendAll"), ("System", "System", "IClientAction:ListAppendAll"),
            ("system", "(System)", "IClientActionSignature:ListAppendAll"), ("(System)", "(System)", "ClientAction:ListAppendAll") };
        string? replayJob = null;
        foreach (var (spec, binding, element) in cases)
        {
            var jobPath = Path.Combine(work, Guid.NewGuid().ToString("N") + ".json");
            var job = new JsonObject { ["ops"] = new JsonArray(
                new JsonObject { ["op"] = "reference", ["producer"] = spec, ["elements"] = new JsonArray(element) },
                new JsonObject { ["op"] = "find", ["name"] = "ListAppendAll", ["type"] = "IClientActionSignature" }) }.ToJsonString();
            File.WriteAllText(jobPath, job);
            replayJob ??= job;
            var output = Path.ChangeExtension(jobPath, ".oml");
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, output,
                bindings: new Dictionary<string, string> { [binding] = signaturePath }))!;
            Assert.True(result["accepted"]!.GetValue<bool>(), spec + " / " + binding + " / " + element + ": " + result.ToJsonString());
            var reference = result["results"]![0]!["result"]!;
            Assert.Equal("(System)", reference["producer"]!.ToString());
            Assert.Equal(1, reference["requested"]!.GetValue<int>());
            Assert.Equal(snapshot.SignatureHash.ToString(), reference["referenceHash"]!.ToString());
            Assert.Contains("(System)", reference["references"]!.AsArray().Select(r => r!.ToString()));
            var candidate = host.Load(output);
            try { Assert.NotNull(new ModelSession(candidate).Resolve("IClientAction:ListAppendAll")); }
            finally { ModelHost.Release(candidate); }
        }
        // For the replay through the CLI and the facade (C:\t\fix-system-ref): the same base, capture and job.
        if (Environment.GetEnvironmentVariable("SSAM_SYSTEM_REF_REPLAY_DIR") is { Length: > 0 } replay)
        {
            Directory.CreateDirectory(replay);
            File.Copy(basePath, Path.Combine(replay, "base.oml"), overwrite: true);
            File.Copy(signaturePath, Path.Combine(replay, "System.avsig"), overwrite: true);
            File.WriteAllText(Path.Combine(replay, "job.json"), replayJob);
        }
    }
}
