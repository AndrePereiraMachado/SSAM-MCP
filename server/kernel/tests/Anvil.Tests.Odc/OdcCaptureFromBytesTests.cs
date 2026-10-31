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
    private static string Producer(string work, out byte[] binary, out string key, string name = "ProducerApp", string action = "ValidarUf")
    {
        using var producer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.CrossDevice, name, targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        new ModelSession((ESpace)producer).Apply(JsonNode.Parse("""
        [
          {"op":"logic","data":{"actions":[
            {"name":"ACTION","kind":"service","public":true,"inputs":[{"name":"Uf","type":"Text"}],"outputs":[{"name":"Ok","type":"Boolean"}],"steps":[{"assign":{"Ok":"Uf <> \"\""}}]}
          ]}}
        ]
        """.Replace("ACTION", action))!.AsArray());
        producer.Save();
        var info = ReferenceInfo.ConvertToReferenceInfo(producer);
        binary = info.SignatureBinary; key = info.Key.ToString()!;
        var path = Path.Combine(work, name + ".avsig");
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

    // A capture can have any file name: the producers map binds whatever output a session chose (the gate's -sig.avsig), a delivery renews
    // into X.published.avsig. The call is of the producer of the capture, never of the file: one action, one candidate. It was refused
    // CALL_AMBIGUOUS, "ProducerApp.ValidarUf, ProducerApp-sig.ValidarUf", the same action under two names.
    [Theory]
    [InlineData("ProducerApp-sig", "ValidarUf(Uf=\"SP\")")]
    [InlineData("ProducerApp.published", "ValidarUf(Uf=\"SP\")")]
    [InlineData("something-else", "ValidarUf(Uf=\"SP\")")]
    [InlineData("ProducerApp-sig", "ProducerApp.ValidarUf(Uf=\"SP\")")]
    public void ACallToAServiceActionDoesNotDependOnTheFileNameOfTheCapture(string stem, string call)
    {
        StudioAssembliesOdc.Bind();
        Named(stem, call);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Named(string stem, string call)
    {
        var work = Path.Combine(Path.GetTempPath(), "capture-bytes", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var original = Producer(work, out _, out _);
        var signature = Path.Combine(work, stem + ".avsig");
        File.Copy(original, signature);
        using var consumer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.CrossDevice, "ConsumerApp", targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        var basePath = Path.Combine(work, "base.oml");
        File.WriteAllBytes(basePath, consumer.Save());
        var jobPath = Path.Combine(work, "job.json");
        var job = new JsonObject { ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "reference", ["producer"] = "ProducerApp", ["elements"] = new JsonArray("ServiceAction:ValidarUf") },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("server action Checar\n  out Ok: Boolean\n  Remote = " + call + "\n  assign Ok = Remote.Ok\n  end\n") } }) };
        File.WriteAllText(jobPath, job.ToJsonString());
        var output = Path.Combine(work, "candidate.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, output, bindings: new Dictionary<string, string> { ["ProducerApp"] = signature }))!;
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
    }

    // What the rule is for stays: two producers that really both have the action are refused, each with its form (56a39246, 0ff09aa4).
    [Fact]
    public void TwoProducersThatBothHaveTheActionStayAmbiguousWhateverTheirFilesAreNamed()
    {
        StudioAssembliesOdc.Bind();
        Twins();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Twins()
    {
        var work = Path.Combine(Path.GetTempPath(), "capture-bytes", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var one = Producer(work, out _, out var keyOne);
        var two = Producer(work, out _, out var keyTwo, "OtherApp");
        Assert.NotEqual(keyOne, keyTwo);
        var renamed = Path.Combine(work, "OtherApp-sig.avsig"); File.Copy(two, renamed);
        using var consumer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.CrossDevice, "ConsumerApp", targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        var basePath = Path.Combine(work, "base.oml");
        File.WriteAllBytes(basePath, consumer.Save());
        JsonObject Job(string call) => new() { ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "reference", ["producer"] = "ProducerApp", ["elements"] = new JsonArray("ServiceAction:ValidarUf") },
            new JsonObject { ["op"] = "reference", ["producer"] = "OtherApp", ["elements"] = new JsonArray("ServiceAction:ValidarUf") },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("server action Checar\n  out Ok: Boolean\n  Remote = " + call + "\n  assign Ok = Remote.Ok\n  end\n") } }) };
        var bindings = new Dictionary<string, string> { ["ProducerApp"] = one, ["OtherApp"] = renamed };
        var jobPath = Path.Combine(work, "job.json");
        File.WriteAllText(jobPath, Job("ValidarUf(Uf=\"SP\")").ToJsonString());
        var refusal = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, basePath, jobPath, Path.Combine(work, "a.oml"), bindings: bindings));
        Assert.Contains("CALL_AMBIGUOUS", refusal.Message, StringComparison.Ordinal);
        Assert.Contains("ProducerApp.ValidarUf", refusal.Message, StringComparison.Ordinal);
        Assert.Contains("OtherApp.ValidarUf", refusal.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("OtherApp-sig", refusal.Message, StringComparison.Ordinal);
        File.WriteAllText(jobPath, Job("ProducerApp.ValidarUf(Uf=\"SP\")").ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, Path.Combine(work, "b.oml"), bindings: bindings))!;
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
    }

    // An app that references two producers calls each: an action only one of them has, by its bare name.
    [Theory]
    [InlineData("OtherApp.avsig", "ValidarOutra(Uf=\"SP\")")]
    [InlineData("OtherApp-sig.avsig", "ValidarOutra(Uf=\"SP\")")]
    [InlineData("OtherApp.avsig", "OtherApp.ValidarOutra(Uf=\"SP\")")]
    public void AnAppWithTwoProducersCallsAnActionOfTheSecond(string file, string call)
    {
        StudioAssembliesOdc.Bind();
        Second(file, call);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Second(string file, string call)
    {
        var work = Path.Combine(Path.GetTempPath(), "capture-bytes", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var one = Producer(work, out _, out _);
        var original = Producer(work, out _, out _, "OtherApp", "ValidarOutra");
        var two = Path.Combine(work, "b-" + file); File.Copy(original, two);
        var bound = Path.Combine(work, file); if (!File.Exists(bound)) File.Copy(original, bound);
        using var consumer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.CrossDevice, "ConsumerApp", targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        var basePath = Path.Combine(work, "base.oml");
        File.WriteAllBytes(basePath, consumer.Save());
        var jobPath = Path.Combine(work, "job.json");
        File.WriteAllText(jobPath, new JsonObject { ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "reference", ["producer"] = "ProducerApp", ["elements"] = new JsonArray("ServiceAction:ValidarUf") },
            new JsonObject { ["op"] = "reference", ["producer"] = "OtherApp", ["elements"] = new JsonArray("ServiceAction:ValidarOutra") },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("server action Checar\n  out Ok: Boolean\n  Remote = " + call + "\n  assign Ok = Remote.Ok\n  end\n") } }) }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, Path.Combine(work, "o.oml"), bindings: new Dictionary<string, string> { ["ProducerApp"] = one, ["OtherApp"] = bound }))!;
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
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
