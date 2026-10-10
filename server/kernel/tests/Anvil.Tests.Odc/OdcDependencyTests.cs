using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model;
using OutSystems.Model.Enumerations;
using OutSystems.ModelAPILoader;
using ServiceStudio.Framework.ReferencesManager;
using ServiceStudio.Model;
using Xunit;

namespace Anvil.Tests.Odc;

public class OdcDependencyTests
{
    [Fact]
    public void PublicBlockAndItsTypesCanBeAcquiredWithoutOpeningTheProducerDuringImport()
    {
        StudioAssembliesOdc.Bind();
        RunImport();
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void RunImport()
    {
        var work = Path.Combine(Path.GetTempPath(), "ssam-odc-dependency", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work); // the runtime creates its work folder only on the first Ensure of the process
        var host = new ModelHost(work);
        NativeReferenceSnapshot snapshot;
        using (var producer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, "DependencyFixture",
                   targetPlatform: PlatformServerVersion.Neo, enableTransactions: true))
        {
            new ModelSession((ESpace)producer).Apply(JsonNode.Parse("""
            [
              {"op":"create","parent":"@espace","type":"IStructure","name":"Option","as":"$s"},
              {"op":"set","target":"$s","prop":"Public","value":true},
              {"op":"create","parent":"$s","type":"IStructureAttribute","name":"Label","as":"$label"},
              {"op":"set","target":"$label","prop":"DataType","value":"Text"},
              {"op":"create","parent":"@espace","type":"IMobileFlow","name":"Widgets","as":"$flow"},
              {"op":"create","parent":"$flow","type":"IMobileBlock","name":"Choice","as":"$block"},
              {"op":"set","target":"$block","prop":"Public","value":true},
              {"op":"create","parent":"$block","type":"IInputParameter","name":"Option","as":"$input"},
              {"op":"set","target":"$input","prop":"DataType","value":"$s"},
              {"op":"create","parent":"@espace","type":"IClientAction","name":"ClearChoice","as":"$clear"},
              {"op":"set","target":"$clear","prop":"Public","value":true},
              {"op":"create","parent":"$clear","type":"IStartNode","as":"$start"},
              {"op":"create","parent":"$clear","type":"IEndNode","as":"$end"},
              {"op":"link","from":"$start","to":"$end"}
            ]
            """)!.AsArray());
            producer.Save();
            var info = ReferenceInfo.ConvertToReferenceInfo(producer);
            snapshot = NativeReferenceSnapshot.Create(new NativeReferenceSnapshot {
                FormatVersion = 2, Environment = "lab.test", ModuleKey = info.Key.ToString(),
                ApplicationKey = info.AppKey?.ToString() ?? "", ModuleKind = ReferenceKind.eSpace,
                ModuleType = SegmentationKind.ReactiveLibrary, Name = info.Name,
                // Test-only identity: the fixture is deliberately not published to a tenant.
                SignatureHash = Guid.Parse("ab111111-2222-3333-4444-555555555555"), SignatureBinary = info.SignatureBinary,
                Elements = OdcPublicSignature.Read(info.SignatureBinary).Elements.Select(e => new NativeReferenceElement(e.Kind, e.Name, e.Key)).ToArray()
            });
        }
        Assert.Contains(snapshot.Elements, e => e.Kind == "block" && e.Name == "Choice");
        Assert.Contains(snapshot.Elements, e => e.Kind == "structure" && e.Name == "Option");
        Assert.Contains(snapshot.Elements, e => e.Kind == "client-action" && e.Name == "ClearChoice");
        using var consumer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.CrossDevice, "DependencyConsumer",
            targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        var target = (ESpace)consumer;
        var beforeErrors = ModelHost.Messages(target).Count(m => m.IsError);
        var basePath = Path.Combine(work, "base.oml");
        File.WriteAllBytes(basePath, consumer.Save());
        var block = snapshot.Select("IMobileBlock:Choice");
        var acquired = OdcReferenceImporter.Import(target, snapshot, [block]);
        Assert.Equal(snapshot.SignatureHash, acquired.ReferenceHash);
        var first = consumer.Save();
        var refs = consumer.Dependencies.Count();
        var count = consumer.GetAllDescendantsOfType<OutSystems.Model.IObjectSignature>().Count();
        OdcReferenceImporter.Import(target, snapshot, [block]);
        Assert.Equal(refs, consumer.Dependencies.Count());
        Assert.Equal(count, consumer.GetAllDescendantsOfType<OutSystems.Model.IObjectSignature>().Count());
        OdcReferenceImporter.Import(target, snapshot, [snapshot.Select("IClientAction:ClearChoice")]);
        Assert.NotNull(new ModelSession(target).Resolve("IMobileBlock:Choice")); // incremental acquisition preserves existing elements
        Assert.NotNull(new ModelSession(target).Resolve("IClientAction:ClearChoice"));
        var reload = host.Load(first);
        try {
            var session = new ModelSession(reload);
            Assert.NotNull(session.Resolve("IMobileBlock:Choice"));
            Assert.NotNull(session.Resolve("IStructure:Option")); // native transitive type dependency
            Assert.Equal(beforeErrors, ModelHost.Messages(reload).Count(m => m.IsError));
        } finally { ModelHost.Release(reload); }
        static byte[] Capture(ESpace module) { using var stream = module.SaveToMemoryStream(); return stream.ToArray(); }
        var unchanged = Capture(target);
        Assert.Equal(unchanged, Capture(target));
        Assert.Throws<InvalidOperationException>(() => OdcReferenceImporter.Import(target,
            snapshot with { Elements = [block with { Name = "ForgedName" }] }, [block with { Name = "ForgedName" }]));
        Assert.Equal(unchanged, Capture(target));
        Assert.Throws<InvalidOperationException>(() => OdcReferenceImporter.Import(target,
            snapshot with { SignatureHash = Guid.NewGuid() }, [block]));
        Assert.Equal(unchanged, Capture(target));
        Assert.Throws<InvalidOperationException>(() => snapshot.RequireEnvironment("other.test"));
        Assert.Throws<ArgumentException>(() => snapshot.Select("IMobileBlock:Missing"));

        var signaturePath = Path.Combine(work, "producer.avsig");
        snapshot.Write(signaturePath);
        var jobPath = Path.Combine(work, "acquire.json");
        File.WriteAllText(jobPath, """
        {"ops":[
          {"op":"reference","producer":"DependencyFixture","elements":["IMobileBlock:Choice","IClientAction:ClearChoice"]},
          {"op":"create","parent":"@espace","type":"IMobileFlow","name":"Main","as":"$flow"},
          {"op":"create","parent":"$flow","type":"IMobileBlock","name":"Consumer","as":"$container"},
          {"op":"create","parent":"$container","type":"ILocalVariable","name":"Selected","as":"$selected"},
          {"op":"set","target":"$selected","prop":"DataType","value":"Option"},
          {"op":"create","parent":"$container","type":"IMobileBlockInstanceWidget","name":"ImportedChoice","as":"$widget"},
          {"op":"set","target":"$widget","prop":"SourceBlock","value":"IMobileBlock:Choice"},
          {"op":"set","target":"$widget/Option","prop":"Value","value":"Selected"}
        ]}
        """);
        var output = Path.Combine(work, "candidate.oml");
        var result = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, output,
            bindings: new Dictionary<string,string> { ["DependencyFixture"] = signaturePath }))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var candidate = host.Load(output);
        try {
            var session = new ModelSession(candidate);
            Assert.NotNull(session.Resolve("IMobileBlockInstanceWidget:ImportedChoice"));
            Assert.NotNull(session.Resolve("IClientAction:ClearChoice"));
        } finally { ModelHost.Release(candidate); }
    }

    // The External Library counterpart of the test above would build its producer offline. The ODC model creates an
    // External Library only from a package compiled against OutSystems.ExternalLibraries.SDK
    // (IModelServices.CreateExternalLibrary(byte[] package, out validationMessages)): that needs dotnet publish and a NuGet
    // restore, so no headless probe builds the producer here and this test does not pretend to. The envelope rule is
    // OdcExternalLibraryTests'; the import into a consumer and the runtime call are the live proof of the lane.
    [Fact(Skip = "No offline External Library producer: CreateExternalLibrary needs a package built with the SDK (dotnet publish + NuGet); live proof of lane extlib.")]
    public void ExternalLibraryProducerIsImportedIntoAConsumerCandidate()
    {
    }
}
