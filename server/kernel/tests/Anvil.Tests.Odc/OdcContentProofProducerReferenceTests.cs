using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model;
using OutSystems.Model.Enumerations;
using OutSystems.Model.Merge;
using OutSystems.ModelAPILoader;
using ServiceStudio.Framework.ReferencesManager;
using ServiceStudio.Model;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// A candidate that references a producer action for the first time (ProducerApp.SaveAction) and calls it from ConsumerAction.
/// The native merge (MatchTree, as the Studio's CompareAndMerge) adds the consumer's copy of that producer element, and the
/// reference record itself, with keys of its own, so the call's Action, its Arguments (addressed by their Parameter) and the
/// expressions that read its outputs pointed at other local keys: the content proof refused the same, unchanged, content
/// (MERGE_CONTENT_LOSS before any live merge). The rule: an element of a producer reference is the producer's element
/// (GlobalKey = producer module key * producer object key) and a reference record is its producer module (ReferenceKey),
/// never the local key of the consumer's copy. Real changes still refuse: another argument value, or the call bound to
/// another producer action, each named by its element and its readable values./// </summary>
public class OdcContentProofProducerReferenceTests
{
    [Fact]
    public void AProducerReferenceTheMergeRecreatesIsTheSameContentAndRealChangesStillRefuse()
    {
        StudioAssembliesOdc.Bind();
        Run();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run()
    {
        var work = Path.Combine(Path.GetTempPath(), "ssam-odc-proof-producer-ref", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        JsonNode Apply(string basePath, JsonArray ops, string output, IReadOnlyDictionary<string, string>? bindings = null)
        {
            var jobPath = Path.Combine(work, Guid.NewGuid().ToString("N") + ".json");
            File.WriteAllText(jobPath, new JsonObject { ["ops"] = ops }.ToJsonString());
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, output, bindings: bindings))!;
            Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
            return result;
        }
        string Blank(string name)
        {
            using var module = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, name,
                targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
            new ModelSession((ESpace)module).Apply(JsonNode.Parse("""[{"op":"delete","target":"IReference:(System)","force":true}]""")!.AsArray());
            var file = Path.Combine(work, name + "-blank.oml");
            File.WriteAllBytes(file, module.Save());
            return file;
        }

        // The producer: two public server actions of the same signature (the second one is the "other target" below).
        static JsonObject ProducerAction(string name) => new() {
            ["name"] = name, ["kind"] = "server", ["public"] = true, ["description"] = "Fixture producer action " + name,
            ["inputs"] = new JsonArray(new JsonObject { ["name"] = "Code", ["type"] = "Text" }, new JsonObject { ["name"] = "Holder", ["type"] = "Text" }),
            ["outputs"] = new JsonArray(new JsonObject { ["name"] = "Success", ["type"] = "Boolean" }, new JsonObject { ["name"] = "ErrorMessage", ["type"] = "Text" }),
            ["steps"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { ["Success"] = "Code <> \"\"", ["ErrorMessage"] = "Holder" }, ["as"] = "Answer" }) };
        var producerPath = Path.Combine(work, "producer.oml");
        Apply(Blank("ProducerApp"), new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject {
            ["actions"] = new JsonArray(ProducerAction("SaveAction"), ProducerAction("SaveOtherAction")) } }), producerPath);
        var producer = host.Load(File.ReadAllBytes(producerPath));
        string signaturePath;
        try
        {
            var info = ReferenceInfo.ConvertToReferenceInfo(producer);
            var snapshot = NativeReferenceSnapshot.Create(new NativeReferenceSnapshot {
                FormatVersion = 2, Environment = "lab.test", ModuleKey = info.Key.ToString(),
                ApplicationKey = info.AppKey?.ToString() ?? "", ModuleKind = ReferenceKind.eSpace,
                ModuleType = SegmentationKind.ReactiveLibrary, Name = "ProducerApp", SignatureHash = Guid.Parse("c3c3c3c3-0000-1111-2222-333333333333"),
                SignatureBinary = info.SignatureBinary,
                Elements = OdcPublicSignature.Read(info.SignatureBinary).Elements.Select(e => new NativeReferenceElement(e.Kind, e.Name, e.Key)).ToArray() });
            signaturePath = Path.Combine(work, "ProducerApp.avsig");
            snapshot.Write(signaturePath);
        }
        finally { ModelHost.Release(producer); }
        var bindings = new Dictionary<string, string> { ["ProducerApp"] = signaturePath };

        // The consumer base has no reference to the producer; each candidate adds it and one action that calls it.
        var basePath = Blank("ConsumerApp");
        string Candidate(string name, string called, string code)
        {
            var output = Path.Combine(work, name + ".oml");
            Apply(basePath, new JsonArray(
                new JsonObject { ["op"] = "reference", ["producer"] = "ProducerApp",
                    ["elements"] = new JsonArray("ServerAction:SaveAction", "ServerAction:SaveOtherAction") },
                new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(new JsonObject {
                    ["name"] = "ConsumerAction", ["kind"] = "server", ["public"] = true, ["description"] = "Calls the producer save action",
                    ["inputs"] = new JsonArray(new JsonObject { ["name"] = "Code", ["type"] = "Text" }, new JsonObject { ["name"] = "Holder", ["type"] = "Text" }),
                    ["outputs"] = new JsonArray(new JsonObject { ["name"] = "Saved", ["type"] = "Boolean" }, new JsonObject { ["name"] = "Message", ["type"] = "Text" }),
                    ["steps"] = new JsonArray(
                        new JsonObject { ["call"] = called, ["as"] = "Save", ["args"] = new JsonObject { ["Code"] = code, ["Holder"] = "Holder" } },
                        new JsonObject { ["assign"] = new JsonObject { ["Saved"] = "Save.Success", ["Message"] = "Save.ErrorMessage" }, ["as"] = "Answer" }) }) } }),
                output, bindings);
            return output;
        }
        var candidate = Candidate("candidate", "SaveAction", "Code");
        // The real changes are made over the candidate itself (same keys everywhere else): one argument value, one target.
        var (callKey, codeArgumentKey) = CallKeys(host, candidate);
        string Variant(string name, JsonObject op) { var output = Path.Combine(work, name + ".oml"); Apply(candidate, new JsonArray(op), output, bindings); return output; }
        var otherValue = Variant("other-value", new JsonObject { ["op"] = "set", ["target"] = "@" + codeArgumentKey, ["prop"] = "Value", ["value"] = "Holder" });
        var otherTarget = Variant("other-target", new JsonObject { ["op"] = "set", ["target"] = "@" + callKey, ["prop"] = "Action", ["value"] = "IServerActionSignature:SaveOtherAction" });

        // The Studio's merge of the candidate over the base, headless (OdcMergeOrderTests.Merge): the merged module.
        var mergedPath = Path.Combine(work, "merged.oml");
        var local = host.Load(File.ReadAllBytes(basePath));
        try
        {
            var foreign = host.Load(File.ReadAllBytes(candidate)); var basis = host.Load(File.ReadAllBytes(basePath));
            try { ((IESpace)local).TransactionsManager.ExecuteTransaction("test: native merge", (_, _) => { using var tree = new MatchTree(local, foreign, basis, false, true); Assert.False(tree.HasConflicts); tree.Merge(); return true; }); }
            finally { ModelHost.Release(foreign); ModelHost.Release(basis); }
            File.WriteAllBytes(mergedPath, host.Save(local));
        }
        finally { ModelHost.Release(local); }

        // The precondition of the incident: the merge gave the producer copy keys of its own (same producer element).
        var (candidateKey, candidateGlobal) = SignatureKeys(host, candidate);
        var (mergedKey, mergedGlobal) = SignatureKeys(host, mergedPath);
        Assert.Equal(candidateGlobal, mergedGlobal);
        Assert.NotEqual(candidateKey, mergedKey);

        // 1. The merged module holds exactly the candidate: accepted, nothing listed.
        var same = MergeContentProof.Check(host, candidate, mergedPath);
        Assert.True(same["accepted"]!.GetValue<bool>(), same["differences"]!.ToJsonString());
        Assert.Empty(same["differences"]!.AsArray());

        // 2. Another argument value is a real change: refused, the argument of Save named by its producer parameter.
        var value = MergeContentProof.Check(host, candidate, otherValue);
        Assert.False(value["accepted"]!.GetValue<bool>());
        var valueDiffs = value["differences"]!.AsArray().OfType<JsonObject>().ToArray();
        Assert.Contains(valueDiffs, d => d["property"]!.ToString() == "$expression" && d["element"]!.ToString().Contains("Save", StringComparison.Ordinal)
            && d["element"]!.ToString().Contains("Code", StringComparison.Ordinal));
        Assert.All(valueDiffs, d => Assert.Contains("ExecuteServerActionNode:Save/Argument:Code", d["element"]!.ToString()));
        Assert.Contains(valueDiffs, d => d["property"]!.ToString() == "$expression" && d["expectedValue"]?.ToString() == "Code" && d["actualValue"]?.ToString() == "Holder");

        // 3. The call bound to another producer action is a real change: refused on the call's Action, both actions named.
        var target = MergeContentProof.Check(host, candidate, otherTarget);
        Assert.False(target["accepted"]!.GetValue<bool>());
        var actions = target["differences"]!.AsArray().OfType<JsonObject>().Where(d => d["property"]!.ToString() == "api:Action").ToArray();
        Assert.True(actions.Length == 1, target["differences"]!.ToJsonString());
        var action = actions[0];
        Assert.Contains("ConsumerAction", action["element"]!.ToString());
        Assert.Contains("SaveAction", action["expectedValue"]!.ToString());
        Assert.Contains("SaveOtherAction", action["actualValue"]!.ToString());
    }

    private static IObjectSignature Call(IObjectSignature model)
    {
        var calls = Walk(model).Where(n => n.GetInterface()?.Name == "IExecuteServerActionNode" && ModelHost.Prop(n, "Name")?.ToString() == "Save").ToArray();
        return calls.Length == 1 ? calls[0] : throw new InvalidOperationException(calls.Length + " Save calls: " + string.Join(", ", calls.Select(c => c.ObjectKey + " in " + ModelHost.Prop(c.Parent!, "Name"))));
    }

    private static (string Key, string Global) SignatureKeys(ModelHost host, string path)
    {
        var model = host.Load(File.ReadAllBytes(path));
        try
        {
            var signature = (IObjectSignature)ModelHost.Prop(Call(model), "Action")!;
            return (signature.ObjectKey.ToString(), ModelHost.Prop(signature, "GlobalKey")!.ToString()!);
        }
        finally { ModelHost.Release(model); }
    }

    private static (string Call, string CodeArgument) CallKeys(ModelHost host, string path)
    {
        var model = host.Load(File.ReadAllBytes(path));
        try
        {
            var call = Call(model);
            var argument = ((System.Collections.IEnumerable)ModelHost.Prop(call, "Arguments")!).OfType<IObjectSignature>()
                .Single(a => ModelHost.Prop(ModelHost.Prop(a, "Parameter")!, "Name")?.ToString() == "Code");
            return (call.ObjectKey.ToString(), argument.ObjectKey.ToString());
        }
        finally { ModelHost.Release(model); }
    }

    private static IEnumerable<IObjectSignature> Walk(IObjectSignature root)
    {
        var pending = new Stack<IObjectSignature>(); pending.Push(root);
        while (pending.TryPop(out var node)) { yield return node; foreach (var child in node.Children.OfType<IObjectSignature>()) pending.Push(child); }
    }
}
