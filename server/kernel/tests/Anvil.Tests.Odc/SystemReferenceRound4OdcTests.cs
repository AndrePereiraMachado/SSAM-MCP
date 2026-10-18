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

/// <summary>fix/system-reference round 4 (review C:\t\revisoes\system-ref-3, M3-R on the prototype path). A prototype op whose
/// data.bind names its producer (no reference op) reads the producer's surface by importing its capture into a scratch copy of
/// the base (PrototypeBindPrepass.Surface). When the module already references that producer at another signature, the native
/// importer refuses there, outside the reference ops' ReferenceProblems: the answer had no code and no continuation. Now it is
/// the coded REFERENCE_OUTDATED with the op's pointer, the same problem a reference op gets. Synthetic producer and consumer.</summary>
public class SystemReferenceRound4OdcTests
{
    [Fact]
    public void AnOutdatedReferenceMetByTheBindPrepassIsTheCodedReferenceOutdated()
    {
        StudioAssembliesOdc.Bind();
        Run();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run()
    {
        var work = Path.Combine(Path.GetTempPath(), "ssam-odc-system-ref-r4", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        NativeReferenceSnapshot producerAt;
        using (var producer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, "FolhaPonto_CS",
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
            producerAt = NativeReferenceSnapshot.Create(new NativeReferenceSnapshot {
                FormatVersion = 2, Environment = "lab.test", ModuleKey = info.Key.ToString(), ApplicationKey = info.AppKey?.ToString() ?? "",
                ModuleKind = ReferenceKind.eSpace, ModuleType = SegmentationKind.ReactiveLibrary, Name = "FolhaPonto_CS",
                SignatureHash = Guid.Parse("a4a4a4a4-0000-1111-2222-333333333333"), SignatureBinary = info.SignatureBinary,
                Elements = OdcPublicSignature.Read(info.SignatureBinary).Elements.Select(e => new NativeReferenceElement(e.Kind, e.Name, e.Key)).ToArray() });
        }
        using var consumer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, "FolhaPonto_UI",
            targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        new ModelSession((ESpace)consumer).Apply(JsonNode.Parse("""[{"op":"delete","target":"IReference:(System)","force":true}]""")!.AsArray());
        var basePath = Path.Combine(work, "base.oml");
        File.WriteAllBytes(basePath, consumer.Save());
        var atA = Path.Combine(work, "FolhaPonto_CS-A.avsig"); producerAt.Write(atA);
        var atB = Path.Combine(work, "FolhaPonto_CS-B.avsig"); (producerAt with { SignatureHash = Guid.Parse("b4b4b4b4-0000-1111-2222-333333333333") }).Write(atB);
        // The module references the producer at A (a delivery of a reference op).
        var referenceJob = Path.Combine(work, "reference.json");
        File.WriteAllText(referenceJob, """{"ops":[{"op":"reference","producer":"FolhaPonto_CS","elements":["ClientAction:ListAppendAll"]}]}""");
        var withA = Path.Combine(work, "with-A.oml");
        var built = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, referenceJob, withA, bindings: JobSources.ParseBindings(["FolhaPonto_CS=" + atA])))!;
        Assert.True(built["accepted"]?.GetValue<bool>() == true, built.ToJsonString());
        // A prototype op whose data.bind names only its producer, bound to the capture at B: the prepass reads its surface.
        // The committed capture of FolhaPonto (with its bundle next to it), read where it is.
        var capture = Path.Combine(FindRoot(), "tests", "Anvil.Tests", "Fixtures", "prototype", "folhaponto-bind.capture.json");
        var source = Path.GetDirectoryName(capture)!;
        var ops = new JsonArray(new JsonObject { ["op"] = "prototype", ["data"] = new JsonObject {
            ["source"] = source, ["capture"] = capture, ["bind"] = new JsonObject { ["producer"] = "FolhaPonto_CS" }, ["_producer"] = atB } });
        var data = (JsonObject)ops[0]!["data"]!;
        Assert.Empty(PrototypeBind.Shape(data));
        var loadProblems = new List<PrototypeCapture.Problem>();
        Assert.True(PrototypeCapture.Load(data, loadProblems) != null && loadProblems.Count == 0, string.Join("; ", loadProblems.Select(p => JsonSerializer.Serialize(p))));
        var loaded = new Dictionary<string, ESpace>();
        try
        {
            var error = Assert.ThrowsAny<Exception>(() => PrototypeBindPrepass.Run(host, File.ReadAllBytes(withA), ops, "/ops",
                spec => loaded.TryGetValue(spec, out var m) ? m : loaded[spec] = host.Load(File.ReadAllBytes(spec)), null));
            var coded = Errors.FindCoded(error);
            Assert.True(coded != null, Errors.Text(error));
            Assert.Equal("REFERENCE_OUTDATED", coded!.Code);
            var problem = Assert.IsType<JsonObject>(Assert.Single(coded.Problems!));
            Assert.Equal("REFERENCE_OUTDATED", problem["code"]!.ToString());
            Assert.Equal("/ops/0", problem["pointer"]!.ToString());
            Assert.Contains("studio_refresh_references", problem["fix"]!.ToString());
            Assert.DoesNotContain("capture the producer again", problem["fix"]!.ToString());
            // The CLI envelope (what the facade reads) carries the code and the problem.
            var envelope = Errors.Envelope("apply", error, 0);
            Assert.Equal("REFERENCE_OUTDATED", envelope["code"]!.ToString());
            Assert.Equal("/ops/0", envelope["problems"]![0]!["pointer"]!.ToString());
        }
        finally { foreach (var m in loaded.Values) ModelHost.Release(m); }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(SystemReferenceRound4OdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir!;
    }
}
