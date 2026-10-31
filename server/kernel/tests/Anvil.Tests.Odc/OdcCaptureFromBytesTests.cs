using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model.Enumerations;
using OutSystems.ModelAPILoader;
using ServiceStudio.Framework.ReferencesManager;
using ServiceStudio.Model;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// The gate of 2026-10-30: the capture of a producer with 20 public service actions, written by a v98 bridge: Elements has its entity
/// list and no service action, SignatureBinary has them all. A capture is read from its bytes, so the job that references one builds,
/// whatever bridge wrote it. Runs headless, with no Studio open.
/// </summary>
public sealed class OdcCaptureFromBytesTests
{
    private static string Producer(string work, out byte[] binary, out string key)
    {
        using var producer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.CrossDevice, "ProducerApp", targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        new ModelSession((ESpace)producer).Apply(JsonNode.Parse("""
        [
          {"op":"logic","data":{"actions":[
            {"name":"ValidarUf","kind":"service","public":true,"inputs":[{"name":"Uf","type":"Text"}],"outputs":[{"name":"Ok","type":"Boolean"}],"steps":[{"assign":{"Ok":"Uf <> \"\""}}]}
          ]}}
        ]
        """)!.AsArray());
        producer.Save();
        var info = ReferenceInfo.ConvertToReferenceInfo(producer);
        binary = info.SignatureBinary; key = info.Key.ToString()!;
        var path = Path.Combine(work, "ProducerApp.avsig");
        // The list a bridge before the one reader writes: the service action is not in it. The second element is what an older capture
        // may claim beside the bytes.
        var envelope = NativeReferenceSnapshot.Create(new NativeReferenceSnapshot {
            FormatVersion = 2, Environment = "lab.test", ModuleKey = key, ApplicationKey = info.AppKey?.ToString() ?? "", ModuleKind = ReferenceKind.eSpace,
            ModuleType = SegmentationKind.CrossDevice, Name = info.Name, SignatureHash = Guid.Parse("ab222222-2222-3333-4444-555555555555"), SignatureBinary = binary,
            Elements = [new NativeReferenceElement("entity", "OnlyInTheList", "BH7IhXmk5EiXrIXyy4pHWQ")] });
        envelope.Write(path);
        return path;
    }

    [Fact]
    public void ACaptureIsReadFromItsBytesAndItsFileStaysAsTheBridgeWroteIt()
    {
        StudioAssembliesOdc.Bind();
        Read();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Read()
    {
        var work = Path.Combine(Path.GetTempPath(), "capture-bytes", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        _ = new ModelHost(work);
        var path = Producer(work, out _, out _);
        var before = SHA256.HashData(File.ReadAllBytes(path));
        var snapshot = NativeReferenceSnapshot.Read(path);
        Assert.Equal("ValidarUf", snapshot.Select("ServiceAction:ValidarUf").Name);
        Assert.Equal(snapshot.Select("ServiceAction:ValidarUf"), snapshot.Select("IServiceActionSignature:ValidarUf"));
        Assert.Throws<ArgumentException>(() => snapshot.Select("ServerEntity:OnlyInTheList"));   // the bytes do not hold what the list says
        Assert.Equal(before, SHA256.HashData(File.ReadAllBytes(path)));                          // the identity of the capture never moves
    }

    [Fact]
    public void AJobReferencingAServiceActionOfSuchACaptureBuildsAndCallsIt()
    {
        StudioAssembliesOdc.Bind();
        Build();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Build()
    {
        var work = Path.Combine(Path.GetTempPath(), "capture-bytes", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var signature = Producer(work, out _, out _);
        using var consumer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.CrossDevice, "ConsumerApp", targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        var basePath = Path.Combine(work, "base.oml");
        File.WriteAllBytes(basePath, consumer.Save());
        var jobPath = Path.Combine(work, "job.json");
        File.WriteAllText(jobPath, """
        {"ops":[
          {"op":"reference","producer":"ProducerApp","elements":["ServiceAction:ValidarUf"]},
          {"op":"logic","data":{"actions":[{"name":"Checar","kind":"server","outputs":[{"name":"Ok","type":"Boolean"}],
            "steps":[{"call":"IServiceActionSignature:ValidarUf","as":"Remote","args":{"Uf":"\"SP\""}},{"assign":{"Ok":"Remote.Ok"}}]}]}}
        ]}
        """);
        var output = Path.Combine(work, "candidate.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, output, bindings: new Dictionary<string, string> { ["ProducerApp"] = signature }))!;
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        var reloaded = host.Load(output);
        try { Assert.NotNull(new ModelSession(reloaded).Resolve("IServiceActionSignature:ValidarUf")); }
        finally { ModelHost.Release(reloaded); }
    }
}
