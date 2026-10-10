using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// K1 of the atritos 3 package (C06, D1): a producer A whose public entity has attributes typed with the identifiers of the
/// entities of producers B and C. The Studio resolves a cross-producer type only against the signatures of the same native
/// refresh (offline proof C:\t\verif-d1), so a frozen import refreshes, in ONE native call, its own signature, every signature
/// already imported into the model in the execution and the linked signatures of the producers that own its foreign types.
/// An element whose owner is not linked is PRODUCER_SIGNATURE_MISSING with cause foreign and the owner, never "publish".
/// Synthetic producers built offline from blank-service.oml; the three references go through JobRunner, that is,
/// ModelSession.PrepareSignatureReference once per reference op.
/// </summary>
public class Pa3K1RefreshTests
{
    [Fact]
    public void ThreeProducersLinkedImportEveryElementInOneRefresh()
    { StudioAssemblies.Bind(); ThreeProducersCase("linked"); }

    [Fact]
    public void OwnersImportedEarlierInTheSameModelJoinTheRefreshOfTheirDependent()
    { StudioAssemblies.Bind(); ThreeProducersCase("owners-first"); }

    [Fact]
    public void AnElementWhoseOwnerIsNotLinkedIsRefusedAsForeignWithTheOwnerAndNoPublishFix()
    { StudioAssemblies.Bind(); ThreeProducersCase("unlinked"); }

    /// <summary>check-job runs without the Studio assemblies bound, and the preflight's rule discovery (JobPreflight.RulesIn)
    /// reads the namespace of every static class of Anvil.Core. The K1 link scope must never add a nested static class (a
    /// cached method group, &lt;&gt;O) to NativeReferenceSnapshot, a type that needs the Studio to load: every delivery would
    /// stop at validate-job. Anvil.Core is loaded here in a context that refuses the Studio, whatever this process bound.</summary>
    [Fact]
    public void ThePreflightRuleDiscoveryNeverNeedsTheStudioAssemblies()
    {
        var bin = Path.GetDirectoryName(typeof(JobRunner).Assembly.Location)!;
        var context = new NoStudioContext();
        try
        {
            var core = context.LoadFromAssemblyPath(Path.Combine(bin, "Anvil.Core.dll"));
            var rulesIn = core.GetType("Anvil.Core.JobPreflight", throwOnError: true)!.GetMethod("RulesIn")!;
            var rules = ((System.Collections.IEnumerable)rulesIn.Invoke(null, [core])!).Cast<Type>().ToList();
            Assert.NotEmpty(rules);
        }
        finally { context.Unload(); }
    }

    private sealed class NoStudioContext() : System.Runtime.Loader.AssemblyLoadContext("pa3-k1-no-studio", isCollectible: true)
    {
        protected override System.Reflection.Assembly? Load(System.Reflection.AssemblyName name)
            => name.Name is { } n && (n.StartsWith("OutSystems", StringComparison.Ordinal) || n.StartsWith("ServiceStudio", StringComparison.Ordinal))
                ? throw new FileNotFoundException("The Studio assemblies are not bound in this context", n)
                : null;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void ThreeProducersCase(string scenario)
    {
        var (root, work) = Work();
        var host = new ModelHost(Path.Combine(work, "model"));
        var blank = Path.Combine(root, "tests/fixtures/blank-service.oml");
        var b = Producer(host, work, blank, "Pa3K1ProdB", Entity("Bee", ("Label", "Text")), new());
        var c = Producer(host, work, blank, "Pa3K1ProdC", Entity("Cee", ("Code", "Text")), new());
        var bSig = Signature(b, "IServerEntity:Bee", Path.Combine(work, "B.avsig"));
        var cSig = Signature(c, "IServerEntity:Cee", Path.Combine(work, "C.avsig"));
        // A references B and C (one signature each, no foreign type) and types its public entity with their identifiers.
        var a = Producer(host, work, blank, "Pa3K1ProdA", new JsonArray(
            Reference("B", "IServerEntity:Bee"), Reference("C", "IServerEntity:Cee"),
            Entity("Aye", ("BeeId", "Bee Identifier"), ("CeeId", "Cee Identifier"))[0]!.DeepClone()),
            new() { { "B", bSig.Path }, { "C", cSig.Path } });
        var aSig = Signature(a, "IServerEntity:Aye", Path.Combine(work, "A.avsig"));
        Assert.Equal(2, aSig.Foreign.Count);
        var bindings = new Dictionary<string, string> { { "A", aSig.Path }, { "B", bSig.Path }, { "C", cSig.Path } };
        var job = Path.Combine(work, scenario + ".json"); var output = Path.Combine(work, scenario + ".oml");
        var ops = scenario switch {
            "owners-first" => new JsonArray(Reference("B", "IServerEntity:Bee"), Reference("C", "IServerEntity:Cee"), Reference("A", "IServerEntity:Aye")),
            "unlinked" => new JsonArray(Reference("A", "IServerEntity:Aye")),
            _ => new JsonArray(Reference("A", "IServerEntity:Aye"), Reference("B", "IServerEntity:Bee"), Reference("C", "IServerEntity:Cee"))
        };
        File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
        if (scenario == "unlinked")
        {
            // Only A is bound and linked: B and C own types of Aye and are in no refresh.
            var only = new Dictionary<string, string> { { "A", aSig.Path } };
            var refused = Assert.Throws<KernelRefusalException>(() => { using (Anvil.Core.Delivery.Delivery.LinkSignatures(only)) JobRunner.Run(host, blank, job, output, bindings: only); });
            Assert.Equal("PRODUCER_SIGNATURE_MISSING", refused.Code);
            var problem = Assert.Single(refused.Problems!.OfType<JsonObject>(), p => p["element"]!.ToString() == "IEntitySignature:Aye");
            Assert.Equal("foreign", problem["cause"]!.ToString());
            Assert.Equal("Pa3K1ProdA", problem["producer"]!.ToString());
            Assert.Contains(problem["owner"]!.ToString(), new[] { bSig.Key, cSig.Key });
            // Every owner at once, in the owners and in the one fix that binds them all.
            Assert.Equal(new[] { bSig.Key, cSig.Key }.Order(), problem["owners"]!.AsArray().Select(o => o!.ToString()).Order());
            Assert.Contains(bSig.Key, problem["fix"]!.ToString()); Assert.Contains(cSig.Key, problem["fix"]!.ToString());
            Assert.DoesNotContain("publish", problem["message"]!.ToString() + problem["fix"], StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("publish", refused.Message, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("Element is absent", refused.Message);
            Assert.False(File.Exists(output));
            return;
        }
        JsonNode result;
        // "owners-first" runs without a link scope: the owners come from the imports already in the model.
        using (scenario == "linked" ? Anvil.Core.Delivery.Delivery.LinkSignatures(bindings) : null)
            result = JsonSerializer.SerializeToNode(JobRunner.Run(host, blank, job, output, bindings: bindings))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        var references = result["results"]!.AsArray().Take(3).Select(r => r!["result"]!).ToList();
        foreach (var reference in references) Assert.Equal(reference["signatureHash"]!.ToString(), reference["referenceHash"]!.ToString());
        // Every element is present in the saved consumer, and Aye's identifiers are typed with B's and C's entities.
        var check = Path.Combine(work, scenario + "-check.json");
        File.WriteAllText(check, new JsonObject { ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "find", ["name"] = "Aye", ["type"] = "IEntitySignature" },
            new JsonObject { ["op"] = "find", ["name"] = "Bee", ["type"] = "IEntitySignature" },
            new JsonObject { ["op"] = "find", ["name"] = "Cee", ["type"] = "IEntitySignature" }) }.ToJsonString());
        var found = JsonSerializer.SerializeToNode(JobRunner.Run(host, output, check, Path.Combine(work, scenario + "-check.oml")))!;
        for (var i = 0; i < 3; i++) Assert.Single(found["results"]![i]!["result"]!.AsArray());
        Assert.True(host.Inspect(output).IsValid);
        Assert.DoesNotContain("Element is absent", result.ToJsonString());
    }

    private sealed record Captured(string Path, string Key, IReadOnlyList<string> Foreign);

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static Captured Signature(string oml, string element, string path)
    {
        var fixture = SignatureFixtures.FromProducerOml(oml, [element], "lab.example");
        fixture.Snapshot.Write(path);
        return new(path, Keys.ToStudio(fixture.Snapshot.ModuleKey), fixture.Report["foreignDependencies"]!.AsArray().Select(f => f!.ToString()).ToList());
    }

    /// <summary>A producer of its own key and name: blank-service cloned (ESpace.Clone gives a new key), then the job applied.</summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static string Producer(ModelHost host, string work, string blank, string name, JsonArray ops, Dictionary<string, string> bindings)
    {
        var clone = System.Reflection.Assembly.Load("ServiceStudio.Framework").GetType("ServiceStudio.Model.ESpace")!.GetMethods()
            .Single(m => m.Name == "Clone" && m.IsStatic && m.GetParameters().Length == 9);
        Action<object> rename = m => m.GetType().GetMethod("SetName", [typeof(string)])!.Invoke(m, [name]);
        var callback = Delegate.CreateDelegate(clone.GetParameters()[5].ParameterType, rename.Target, rename.Method);
        using var bytes = new MemoryStream(File.ReadAllBytes(blank));
        var module = clone.Invoke(null, [bytes, null, null, null, false, callback, null, false, false])!;
        var basis = Path.Combine(work, name + "-base.oml");
        try { File.WriteAllBytes(basis, (byte[])typeof(ModelHost).GetMethod("Save")!.Invoke(host, [module])!); }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]); }
        var job = Path.Combine(work, name + ".json"); var output = Path.Combine(work, name + ".oml");
        File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
        JsonNode result;
        using (Anvil.Core.Delivery.Delivery.LinkSignatures(bindings))
            result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, output, bindings: bindings))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        return output;
    }

    private static JsonArray Entity(string name, params (string Name, string Type)[] attributes) => new(new JsonObject {
        ["op"] = "spec", ["data"] = new JsonObject { ["entities"] = new JsonArray(new JsonObject { ["name"] = name, ["public"] = true,
            ["attributes"] = new JsonArray(attributes.Select(a => (JsonNode)new JsonObject { ["name"] = a.Name, ["type"] = a.Type }).ToArray()) }) } });

    private static JsonObject Reference(string producer, string element)
        => new() { ["op"] = "reference", ["producer"] = producer, ["elements"] = new JsonArray(element) };

    private static (string Root, string Work) Work()
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Pa3K1RefreshTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local/pa3-k1-refresh-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        return (root, work);
    }
}
