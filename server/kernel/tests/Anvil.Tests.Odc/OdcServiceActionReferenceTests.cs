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

public class OdcServiceActionReferenceTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PublicServiceSignatureImportsItsContractAndBuildsARemoteCall(bool externalTypes)
    {
        StudioAssembliesOdc.Bind();
        Run(externalTypes);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run(bool externalTypes)
    {
        var work = Path.Combine(Path.GetTempPath(), "svc-ref", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        using var producer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.CrossDevice, "ServiceProducer",
            targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        using var contractProducer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, "ServiceContracts",
            targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        var typeOwner = externalTypes ? contractProducer : producer;
        new ModelSession((ESpace)typeOwner).Apply(JsonNode.Parse("""
        [
          {"op":"create","parent":"@espace","type":"IStructure","name":"Payload","as":"$payload"},
          {"op":"set","target":"$payload","prop":"Public","value":true},
          {"op":"create","parent":"$payload","type":"IStructureAttribute","name":"Value","as":"$value"},
          {"op":"set","target":"$value","prop":"DataType","value":"Text"}
        ]
        """)!.AsArray());
        NativeReferenceSnapshot? contracts = null;
        if (externalTypes) {
            contractProducer.Save();
            var contractInfo = ReferenceInfo.ConvertToReferenceInfo(contractProducer);
            contracts = NativeReferenceSnapshot.Create(new NativeReferenceSnapshot {
                FormatVersion = 2, Environment = "lab.test", ModuleKey = contractInfo.Key.ToString(),
                ApplicationKey = contractInfo.AppKey?.ToString() ?? "", ModuleKind = ReferenceKind.eSpace,
                ModuleType = SegmentationKind.ReactiveLibrary, Name = contractInfo.Name,
                SignatureHash = Guid.Parse("ac222222-2222-3333-4444-555555555555"), SignatureBinary = contractInfo.SignatureBinary,
                Elements = OdcPublicSignature.Read(contractInfo.SignatureBinary).Elements.Select(e => new NativeReferenceElement(e.Kind, e.Name, e.Key)).ToArray()
            });
            OdcReferenceImporter.Import((ESpace)producer, contracts, [contracts.Select("Structure:Payload")]);
        }
        new ModelSession((ESpace)producer).Apply(JsonNode.Parse("""
        [
          {"op":"logic","data":{"actions":[
            {"name":"Echo","kind":"service","public":true,"inputs":[{"name":"Request","type":"Payload"}],
             "outputs":[{"name":"Response","type":"Payload"}],"steps":[{"assign":{"Response":"Request"}}]},
            {"name":"Hidden","kind":"service","public":false,"steps":[]}
          ]}},
          {"op":"set","target":"IServiceAction:Hidden","prop":"Public","value":false}
        ]
        """)!.AsArray());
        producer.Save();
        var info = ReferenceInfo.ConvertToReferenceInfo(producer);
        var catalog = OdcPublicSignature.Read(info.SignatureBinary);
        Assert.Contains(catalog.Elements, e => e.Kind == "service-action" && e.Name == "Echo");
        Assert.DoesNotContain(catalog.Elements, e => e.Name == "Hidden");
        var snapshot = NativeReferenceSnapshot.Create(new NativeReferenceSnapshot {
            FormatVersion = 2, Environment = "lab.test", ModuleKey = info.Key.ToString(),
            ApplicationKey = info.AppKey?.ToString() ?? "", ModuleKind = ReferenceKind.eSpace,
            ModuleType = SegmentationKind.CrossDevice, Name = info.Name,
            SignatureHash = Guid.Parse("ab222222-2222-3333-4444-555555555555"), SignatureBinary = info.SignatureBinary,
            Elements = catalog.Elements.Select(e => new NativeReferenceElement(e.Kind, e.Name, e.Key)).ToArray()
        });
        var selected = snapshot.Select("ServiceAction:Echo");
        Assert.Equal(selected, snapshot.Select("IServiceActionSignature:Echo"));
        Assert.Equal(selected, snapshot.Select("IServiceAction:Echo"));
        Assert.Equal(selected, snapshot.Select("ServiceAction:@" + selected.Key));
        Assert.Throws<ArgumentException>(() => snapshot.Select("ServerAction:Echo"));
        Assert.Throws<ArgumentException>(() => snapshot.Select("ServiceAction:echo"));

        using var consumer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.CrossDevice, "ServiceConsumer",
            targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        var target = (ESpace)consumer;
        var basePath = Path.Combine(work, "base.oml");
        File.WriteAllBytes(basePath, consumer.Save());
        if (contracts != null) {
            var beforeMissingOwner = Capture(target);
            Assert.ThrowsAny<Exception>(() => OdcReferenceImporter.Import(target, snapshot, [selected]));
            Assert.Equal(beforeMissingOwner, Capture(target));
            OdcReferenceImporter.Import(target, contracts, [contracts.Select("Structure:Payload")]);
        }
        OdcReferenceImporter.Import(target, snapshot, [selected]);
        if (contracts != null) {
            var contractReference = (ServiceStudio.Model.Reference)new ModelSession(target).Resolve("IReference:ServiceContracts");
            Assert.Equal(contracts.SignatureHash, contractReference.ReferenceHash);
            OdcReferenceImporter.Import(target, contracts, [contracts.Select("Structure:Payload")]);
        }
        var session = new ModelSession(target);
        Assert.NotNull(session.Resolve("IServiceActionSignature:Echo"));
        Assert.NotNull(session.Resolve("IStructure:Payload"));
        var count = consumer.GetAllDescendantsOfType<IObjectSignature>().Count();
        OdcReferenceImporter.Import(target, snapshot, [selected]);
        Assert.Equal(count, consumer.GetAllDescendantsOfType<IObjectSignature>().Count());
        static byte[] Capture(ESpace module) { using var stream = module.SaveToMemoryStream(); return stream.ToArray(); }
        var saved = Capture(target);
        Assert.Equal(saved, Capture(target));
        Assert.Throws<InvalidOperationException>(() => OdcReferenceImporter.Import(target,
            snapshot with { Elements = [selected with { Name = "Forged" }] }, [selected with { Name = "Forged" }]));
        Assert.Equal(saved, Capture(target));
        Assert.Throws<InvalidOperationException>(() => OdcReferenceImporter.Import(target,
            snapshot with { SignatureHash = Guid.NewGuid() }, [selected]));
        Assert.Equal(saved, Capture(target));
        Assert.Throws<InvalidOperationException>(() => snapshot.RequireEnvironment("other.test"));

        var sigPath = Path.Combine(work, "producer.avsig");
        snapshot.Write(sigPath);
        var jobPath = Path.Combine(work, "call.json");
        File.WriteAllText(jobPath, """
        {"ops":[
          {"op":"reference","producer":"ServiceProducer","elements":["ServiceAction:Echo"]},
          {"op":"logic","data":{"actions":[{"name":"CallEcho","kind":"service","public":true,
            "inputs":[{"name":"Request","type":"Payload"}],"outputs":[{"name":"Response","type":"Payload"}],
            "steps":[{"call":"IServiceActionSignature:Echo","as":"Remote","args":{"Request":"Request"}},
                     {"assign":{"Response":"Remote.Response"}}]}]}}
        ]}
        """);
        var bindings = new Dictionary<string, string> { ["ServiceProducer"] = sigPath };
        if (contracts != null) {
            var contractPath = Path.Combine(work, "contracts.avsig"); contracts.Write(contractPath);
            bindings["ServiceContracts"] = contractPath;
            var job = JsonNode.Parse(File.ReadAllText(jobPath))!;
            job["ops"]!.AsArray().Insert(0, new JsonObject { ["op"] = "reference", ["producer"] = "ServiceContracts",
                ["elements"] = new JsonArray("Structure:Payload") });
            File.WriteAllText(jobPath, job.ToJsonString());
        }
        var output = Path.Combine(work, "candidate.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, output,
            bindings: bindings))!;
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        var reloaded = host.Load(output);
        try {
            var reread = new ModelSession(reloaded);
            Assert.NotNull(reread.Resolve("IServiceActionSignature:Echo"));
            Assert.NotNull(reread.Resolve("IStructure:Payload"));
            Assert.NotNull(reread.Resolve("IServiceAction:CallEcho"));
            Assert.DoesNotContain(ModelHost.Messages(reloaded), m => m.IsError);
        } finally { ModelHost.Release(reloaded); }
    }
}
