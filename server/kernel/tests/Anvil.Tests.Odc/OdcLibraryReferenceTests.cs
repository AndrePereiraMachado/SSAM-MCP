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

/// <summary>An ODC library references only Libraries and External Libraries: any element of an app (its Service
/// Action, Structure, Entity) is refused in words for both library kinds, before any model change, by the importer and by a
/// job; a library still references a library, also from a capture that carries no ModuleType.</summary>
public class OdcLibraryReferenceTests
{
    [Theory]
    [InlineData(SegmentationKind.ReactiveLibrary, "ServiceAction:Echo", "Service Action Echo")]
    [InlineData(SegmentationKind.MobileLibrary, "ServiceAction:Echo", "Service Action Echo")]
    [InlineData(SegmentationKind.ReactiveLibrary, "Structure:Payload", "Structure Payload")]
    [InlineData(SegmentationKind.MobileLibrary, "Structure:Payload", "Structure Payload")]
    [InlineData(SegmentationKind.ReactiveLibrary, "ServerEntity:Item", "Entity Item")]
    [InlineData(SegmentationKind.MobileLibrary, "ServerEntity:Item", "Entity Item")]
    public void ALibraryCannotReferenceAnyElementOfAnApp(SegmentationKind library, string selector, string named)
    {
        StudioAssembliesOdc.Bind();
        RefuseAppElement(library, selector, named);
    }

    [Theory]
    [InlineData(SegmentationKind.ReactiveLibrary)]
    [InlineData(SegmentationKind.MobileLibrary)]
    public void AJobOnALibraryBaseIsRefusedBeforeTheModelChanges(SegmentationKind library)
    {
        StudioAssembliesOdc.Bind();
        RefuseInJob(library);
    }

    [Theory]
    [InlineData(SegmentationKind.ReactiveLibrary)]
    [InlineData(SegmentationKind.MobileLibrary)]
    public void ALibraryStillReferencesALibrary(SegmentationKind library)
    {
        StudioAssembliesOdc.Bind();
        ReferenceLibrary(library);
    }

    // A capture that carries no ModuleType reads the default kind (WebResponsive, 0), which is never taken for an app: the
    // reference keeps the native path it had before the rule (the native import needs the producer's kind either way).
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ACaptureWithoutItsKindIsNeverRefusedAsAnApp(bool appProducer)
    {
        StudioAssembliesOdc.Bind();
        WithoutKind(appProducer);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void RefuseAppElement(SegmentationKind library, string selector, string named)
    {
        using var producer = AppProducer(out var snapshot);
        using var consumer = Create(library, "SharedLibrary");
        var target = (ESpace)consumer;
        var before = Capture(target);
        var error = Assert.Throws<NotSupportedException>(() => OdcReferenceImporter.Import(target, snapshot, [snapshot.Select(selector)]));
        Assert.Contains("can reference only Libraries and External Libraries:", error.Message);
        Assert.DoesNotContain("AI model", error.Message);
        Assert.Contains("ServiceProducer is an app (Reactive app)", error.Message);
        Assert.Contains("SharedLibrary cannot reference its " + named, error.Message);
        Assert.Contains("Move the shared elements into a Library", error.Message);
        Assert.Contains(library == SegmentationKind.MobileLibrary ? "An ODC Mobile Library" : "An ODC Library", error.Message);
        Assert.Equal(selector.StartsWith("ServiceAction:"), error.Message.Contains("call it from an app"));
        Assert.Equal(before, Capture(target));
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void RefuseInJob(SegmentationKind library)
    {
        var work = Work();
        var host = new ModelHost(work);
        using var producer = AppProducer(out var snapshot);
        var sigPath = Path.Combine(work, "producer.avsig");
        snapshot.Write(sigPath);
        using var consumer = Create(library, "SharedLibrary");
        var basePath = Path.Combine(work, "base.oml");
        var baseBytes = consumer.Save();
        File.WriteAllBytes(basePath, baseBytes);
        var jobPath = Path.Combine(work, "job.json");
        File.WriteAllText(jobPath, """{"ops":[{"op":"reference","producer":"ServiceProducer","elements":["Structure:Payload"]}]}""");
        var output = Path.Combine(work, "candidate.oml");
        JsonNode? result = null;
        string text;
        try {
            result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, output,
                bindings: new Dictionary<string, string> { ["ServiceProducer"] = sigPath }));
            text = result!.ToJsonString();
        } catch (Exception e) { text = e.ToString(); }
        Assert.True(result?["accepted"]?.GetValue<bool>() != true, text);
        Assert.Contains("can reference only Libraries and External Libraries:", text);
        Assert.DoesNotContain("AI model", text);
        Assert.Contains("SharedLibrary cannot reference its Structure Payload", text);
        Assert.DoesNotContain("did not create the requested producer", text);
        Assert.False(File.Exists(output), text);
        Assert.Equal(baseBytes, File.ReadAllBytes(basePath));
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void ReferenceLibrary(SegmentationKind library)
    {
        using var contracts = LibraryProducer(out var snapshot);
        using var consumer = Create(library, "SharedLibrary");
        var target = (ESpace)consumer;
        OdcReferenceImporter.Import(target, snapshot, [snapshot.Select("Structure:Payload")]);
        Assert.NotNull(new ModelSession(target).Resolve("IStructure:Payload"));
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void WithoutKind(bool appProducer)
    {
        NativeReferenceSnapshot snapshot;
        using var producer = appProducer ? AppProducer(out snapshot) : LibraryProducer(out snapshot);
        snapshot = snapshot with { ModuleType = default };
        using var consumer = Create(SegmentationKind.ReactiveLibrary, "SharedLibrary");
        var error = Record.Exception(() => OdcReferenceImporter.Import((ESpace)consumer, snapshot, [snapshot.Select("Structure:Payload")]));
        Assert.False(error is NotSupportedException, error?.ToString());
        Assert.DoesNotContain("can reference only Libraries", error?.Message ?? "");
    }

    private static IESpace LibraryProducer(out NativeReferenceSnapshot snapshot)
    {
        var contracts = Create(SegmentationKind.ReactiveLibrary, "ServiceContracts");
        Apply(contracts, """
        [
          {"op":"create","parent":"@espace","type":"IStructure","name":"Payload","as":"$payload"},
          {"op":"set","target":"$payload","prop":"Public","value":true},
          {"op":"create","parent":"$payload","type":"IStructureAttribute","name":"Value","as":"$value"},
          {"op":"set","target":"$value","prop":"DataType","value":"Text"}
        ]
        """);
        contracts.Save();
        snapshot = Snapshot(contracts, out var captured);
        Assert.Equal(SegmentationKind.ReactiveLibrary, captured);
        return contracts;
    }

    // An app producer (Reactive) with a public Service Action, Structure and Entity, captured as studio reference-snapshot
    // captures it: ModuleType is the native RuntimeKind of the producer's reference information.
    private static IESpace AppProducer(out NativeReferenceSnapshot snapshot)
    {
        var producer = Create(SegmentationKind.CrossDevice, "ServiceProducer");
        Apply(producer, """
        [
          {"op":"create","parent":"@espace","type":"IStructure","name":"Payload","as":"$payload"},
          {"op":"set","target":"$payload","prop":"Public","value":true},
          {"op":"create","parent":"$payload","type":"IStructureAttribute","name":"Value","as":"$value"},
          {"op":"set","target":"$value","prop":"DataType","value":"Text"},
          {"op":"create","parent":"@espace","type":"IServerEntity","name":"Item","as":"$item"},
          {"op":"create","parent":"$item","type":"IEntityAttribute","name":"Id","as":"$id"},
          {"op":"set","target":"$id","prop":"DataType","value":"Long Integer"},
          {"op":"set","target":"$id","prop":"IsAutoNumber","value":"Yes"},
          {"op":"set","target":"$item","prop":"IdentifierAttribute","value":"$id"},
          {"op":"create","parent":"$item","type":"IEntityAttribute","name":"Label","as":"$label"},
          {"op":"set","target":"$label","prop":"DataType","value":"Text"},
          {"op":"set","target":"$item","prop":"Public","value":true},
          {"op":"logic","data":{"actions":[
            {"name":"Echo","kind":"service","public":true,"inputs":[{"name":"Request","type":"Payload"}],
             "outputs":[{"name":"Response","type":"Payload"}],"steps":[{"assign":{"Response":"Request"}}]}
          ]}}
        ]
        """);
        producer.Save();
        snapshot = Snapshot(producer, out var captured);
        Assert.Equal(SegmentationKind.CrossDevice, captured);
        Assert.Equal(["entity:Item", "service-action:Echo", "structure:Payload"],
            snapshot.Elements.Select(e => e.Kind + ":" + e.Name).Order(StringComparer.Ordinal).ToArray());
        return producer;
    }

    private static NativeReferenceSnapshot Snapshot(IESpace module, out SegmentationKind captured)
    {
        var info = ReferenceInfo.ConvertToReferenceInfo(module);
        // The same conversion as the bridge's reference-snapshot (platforms/odc/studio/bridge/ReferenceCommands.cs).
        captured = (SegmentationKind)(int)info.RuntimeKind;
        return NativeReferenceSnapshot.Create(new NativeReferenceSnapshot {
            FormatVersion = 2, Environment = "lab.test", ModuleKey = info.Key.ToString(),
            ApplicationKey = info.AppKey?.ToString() ?? "", ModuleKind = ReferenceKind.eSpace,
            ModuleType = captured, Name = info.Name,
            SignatureHash = Guid.NewGuid(), SignatureBinary = info.SignatureBinary,
            Elements = OdcPublicSignature.Read(info.SignatureBinary).Elements.Select(e => new NativeReferenceElement(e.Kind, e.Name, e.Key)).ToArray()
        });
    }

    private static IESpace Create(SegmentationKind kind, string name) =>
        Loader.ModelServicesInstance.CreateESpace(kind, name, targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);

    private static void Apply(IESpace module, string ops) => new ModelSession((ESpace)module).Apply(JsonNode.Parse(ops)!.AsArray());

    private static string Work()
    {
        var work = Path.Combine(Path.GetTempPath(), "lib-ref", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        return work;
    }

    private static byte[] Capture(ESpace module) { using var stream = module.SaveToMemoryStream(); return stream.ToArray(); }
}
