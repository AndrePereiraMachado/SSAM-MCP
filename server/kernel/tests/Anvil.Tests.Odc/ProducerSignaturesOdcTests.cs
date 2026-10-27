using System.Collections;
using System.Reflection;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>The reference op gives a consumer the elements of a producer loaded from its OML: the platform imports each one
/// through the producer's signature manager. ODC Studio 1.7.29 (model 13.1451) loads a module whose signature manager knows
/// none of its top-level referenceable elements (1.7.28 knows them after the load), and the import then failed inside the
/// platform with a KeyNotFoundException on the element's key (OdcJobTests workflow-nodes and agent-definition-tools). The
/// kernel makes them known first, as the platform's own load did, only when an element it gives is unknown. The state 1.7.29
/// leaves is made here on any ODC Studio by emptying what the producer's signature manager knows. Needs the ODC Studio.</summary>
public sealed class ProducerSignaturesOdcTests(ITestOutputHelper output)
{
    private const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Instance;

    [Fact]
    public void AProducerWhoseSignaturesItsLoadLeftUnknownStillGivesItsElementsAsADependency()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var root = FindRoot();
        var host = new ModelHost(Path.Combine(root, ".local", "lane-odc", "producer-signatures", Guid.NewGuid().ToString("N")));
        var consumer = host.Load(Path.Combine(root, "tests", "fixtures", "odc", "blank-workflow.oml"));
        var producer = host.Load(Path.Combine(root, "tests", "fixtures", "odc", "blank-mobile-producer.oml"));
        try
        {
            var manager = typeof(ServiceStudio.Model.ESpace).GetField("signatureManager", Private)!.GetValue(producer)!;
            // What 1.7.29 leaves after the load: the valid signatures empty (their store itself; the manager's own clear is for
            // the Model Versioning strategy only).
            var valid = manager.GetType().GetField("validSignatures", Private)!.GetValue(manager)!;
            foreach (var store in valid.GetType().GetFields(Private).Select(f => f.GetValue(valid)).OfType<IDictionary>()) store.Clear();
            Assert.Equal(0, Known(manager));
            var session = new ModelSession(consumer) { ProducerLoader = _ => producer };
            JsonNode? result = null;
            StudioAdapter.Runtime.Mutate(consumer, "test: reference", _ => result = session.ApplyOne(JsonNode.Parse(
                """{"op":"reference","producer":"tests/fixtures/odc/blank-mobile-producer.oml","elements":["IServiceAction:CovSService"]}""")!.AsObject()));
            output.WriteLine(result?.ToJsonString());
            var reference = Assert.Single(((OutSystems.Model.IESpace)consumer).References, r => r.Name == "CovBlankMobile");
            Assert.Contains(((OutSystems.Model.IObjectSignature)reference).Children, c => TypeResolver.Name(c) == "CovSService");
            Assert.True(Known(manager) > 0);
        }
        finally { ModelHost.Release(producer); ModelHost.Release(consumer); }
    }

    private static int Known(object manager)
    {
        var valid = manager.GetType().GetField("validSignatures", Private)!.GetValue(manager)!;
        return ((IDictionary)valid.GetType().GetMethod("GetAllWithSignatureInfos", Type.EmptyTypes)!.Invoke(valid, null)!).Count;
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ProducerSignaturesOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }
}
