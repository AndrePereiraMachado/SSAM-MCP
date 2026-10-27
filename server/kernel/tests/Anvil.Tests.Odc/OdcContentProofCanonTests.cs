using System.Collections;
using System.Runtime.CompilerServices;
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
/// R6: the canonical identity of the content proof, on the ODC MatchTree. Each fact builds the incident's shape headless,
/// merges it as the Studio does (MatchTree over the base), shows the native identity change really happens in the fixture,
/// and then asks the proof twice: the merged module is accepted, and a real loss on the merged module still refuses.
/// </summary>
public class OdcContentProofCanonTests
{
    // Incidents 95/96/120/147/227/233/237/252 (a code-quality and an options module): a job that rewrites an action deletes nodes of
    // the base and creates new ones; the native merge keeps the base node, with the candidate's content, instead of the new
    // key. The proof listed the node as lost and the base node as unexpected (1460 differences in lab 147).
    [Fact]
    public void AFlowNodeTheMergeKeepsFromTheBaseIsTheCandidatesNode()
    {
        StudioAssembliesOdc.Bind();
        FlowNodeRebind();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void FlowNodeRebind()
    {
        var (work, host, candidate, merged) = FlowRebindPair();

        // 1. The merged module holds the candidate's content: accepted, and the receipt names the nodes it paired.
        var same = MergeContentProof.Check(host, candidate, merged);
        Assert.True(same["accepted"]!.GetValue<bool>(), same["differences"]!.ToJsonString());
        // integ/proto-into-product: the proof is the candidate's (merge-identity: an element by its place, never by a local key);
        // it accepts the pair with no canon of its own, so the proto's R6 receipt (summary.ignoredByCanon, canon.rebound) is not
        // asserted. What follows is the behaviour both proofs owe: a real change, and a lost node, still refuse, named.

        // 2. A real change on the kept node still refuses, named by the candidate's element: another assigned value.
        var otherValue = Edit(host, work, merged, "other-value", model => {
            var assignment = Walk(model).Single(n => n.GetInterface()?.Name == "IAssignment");
            return new JsonArray(new JsonObject { ["op"] = "set", ["target"] = "@" + assignment.ObjectKey, ["prop"] = "Value", ["value"] = "Flag" });
        });
        var value = MergeContentProof.Check(host, candidate, otherValue);
        Assert.False(value["accepted"]!.GetValue<bool>());
        Assert.Contains(value["differences"]!.AsArray(), d => (d!["element"]?.ToString() ?? "").Contains("Calc", StringComparison.Ordinal)
            && (d["element"]!.ToString().Contains("Assign", StringComparison.Ordinal) || (d["address"]?.ToString() ?? "").Contains("Assign", StringComparison.Ordinal)));

        // 3. The seventh case: a node deleted from the merged module is a loss (MERGE_CONTENT_LOSS), with the diff.
        var loss = MergeContentProof.Check(host, candidate, LostNode(host, work, merged));
        Assert.False(loss["accepted"]!.GetValue<bool>());
        Assert.Contains(loss["differences"]!.AsArray(), d => (d!["element"]?.ToString() ?? d["address"]?.ToString() ?? "").Contains("AssignNode", StringComparison.Ordinal));
    }

    /// <summary>The merged module of the incident with its assign node deleted: a real loss.</summary>
    internal static string LostNode(ModelHost host, string work, string merged) => Edit(host, work, merged, "lost-node", model => {
        var assign = Walk(model).Single(n => n.GetInterface()?.Name == "IAssignNode");
        return new JsonArray(new JsonObject { ["op"] = "delete", ["target"] = "@" + assign.ObjectKey, ["force"] = true });
    });

    /// <summary>The incident's pair, headless: a base action, a candidate that deletes its assign and end and creates them
    /// again with another value, and the native merge of that candidate, which keeps a base node's key (asserted).</summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    internal static (string Work, ModelHost Host, string Candidate, string Merged) FlowRebindPair()
    {
        var work = Work("flow-rebind"); var host = new ModelHost(work);
        using var module = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, "RebindProbe",
            targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        new ModelSession((ESpace)module).Apply(JsonNode.Parse("""
        [
          {"op":"create","parent":"@espace","type":"IServerAction","name":"Calc","as":"$action"},
          {"op":"create","parent":"$action","type":"IInputParameter","name":"Flag","as":"$flag"},
          {"op":"set","target":"$flag","prop":"DataType","value":"Boolean"},
          {"op":"create","parent":"$action","type":"IOutputParameter","name":"Result","as":"$result"},
          {"op":"set","target":"$result","prop":"DataType","value":"Boolean"},
          {"op":"create","parent":"$action","type":"IStartNode","as":"$start"},
          {"op":"create","parent":"$action","type":"IAssignNode","name":"Answer","as":"$assign"},
          {"op":"create","parent":"$assign","type":"IAssignment","as":"$assignment"},
          {"op":"set","target":"$assignment","prop":"Variable","value":"Result"},
          {"op":"set","target":"$assignment","prop":"Value","value":"Flag"},
          {"op":"create","parent":"$action","type":"IEndNode","as":"$end"},
          {"op":"link","from":"$start","to":"$assign"},
          {"op":"link","from":"$assign","to":"$end"}
        ]
        """)!.AsArray());
        var basePath = Path.Combine(work, "base.oml"); File.WriteAllBytes(basePath, module.Save());
        var baseKeys = NodeKeys(host, basePath, "Calc");
        // The candidate deletes the assign and the end and creates them again (new keys), with another value.
        new ModelSession((ESpace)module).Apply(JsonNode.Parse($$"""
        [
          {"op":"delete","target":"@{{baseKeys["IAssignNode"]}}","force":true},
          {"op":"delete","target":"@{{baseKeys["IEndNode"]}}","force":true},
          {"op":"create","parent":"IServerAction:Calc","type":"IAssignNode","name":"Answer","as":"$assign"},
          {"op":"create","parent":"$assign","type":"IAssignment","as":"$assignment"},
          {"op":"set","target":"$assignment","prop":"Variable","value":"Result"},
          {"op":"set","target":"$assignment","prop":"Value","value":"not Flag"},
          {"op":"create","parent":"IServerAction:Calc","type":"IEndNode","as":"$end"},
          {"op":"link","from":"@{{baseKeys["IStartNode"]}}","to":"$assign"},
          {"op":"link","from":"$assign","to":"$end"}
        ]
        """)!.AsArray());
        var candidate = Path.Combine(work, "candidate.oml"); File.WriteAllBytes(candidate, module.Save());
        var candidateKeys = NodeKeys(host, candidate, "Calc");
        var merged = Merge(host, work, basePath, candidate);
        var mergedKeys = NodeKeys(host, merged, "Calc");
        Assert.NotEqual(baseKeys["IAssignNode"], candidateKeys["IAssignNode"]);
        // The precondition of the incident: the merged module keeps the base key (not the candidate's).
        Assert.True(mergedKeys["IAssignNode"] == baseKeys["IAssignNode"] || mergedKeys["IEndNode"] == baseKeys["IEndNode"],
            "base " + string.Join(",", baseKeys) + " candidate " + string.Join(",", candidateKeys) + " merged " + string.Join(",", mergedKeys));
        return (work, host, candidate, merged);
    }

    // Incidents 112/234/265/268 (options sliders, a coverage consumer): a block instance's handler of a referenced block
    // event and a widget's own event inside a referenced block's slot. The merge recreates the consumer's copy of the producer
    // event (and the records of the slot), so the handler's Event pointed at another local key and the proof listed the
    // handler, the widget event and their arguments as lost and unexpected.
    [Fact]
    public void EventsOfAReferencedBlockAndOfItsSlotWidgetsKeepTheirIdentity()
    {
        StudioAssembliesOdc.Bind();
        Events();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Events()
    {
        var work = Work("events"); var host = new ModelHost(work);
        using var producer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, "EventProducer",
            targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        new ModelSession((ESpace)producer).Apply(JsonNode.Parse("""
        [
          {"op":"create","parent":"@espace","type":"IMobileFlow","name":"Shared","as":"$shared"},
          {"op":"create","parent":"$shared","type":"IMobileBlock","name":"Shell","as":"$shell"},
          {"op":"set","target":"$shell","prop":"Public","value":true},
          {"op":"create","parent":"$shell","type":"IPlaceholderWidget","name":"Content"},
          {"op":"create","parent":"$shell","type":"IBlockEvent","name":"Closed"}
        ]
        """)!.AsArray());
        producer.Save();
        var info = ReferenceInfo.ConvertToReferenceInfo(producer);
        var snapshot = NativeReferenceSnapshot.Create(new NativeReferenceSnapshot {
            FormatVersion = 2, Environment = "lab.test", ModuleKey = info.Key.ToString(),
            ApplicationKey = info.AppKey?.ToString() ?? "", ModuleKind = ReferenceKind.eSpace,
            ModuleType = SegmentationKind.ReactiveLibrary, Name = info.Name,
            SignatureHash = Guid.Parse("ab444444-2222-3333-4444-555555555555"), SignatureBinary = info.SignatureBinary,
            Elements = OdcPublicSignature.Read(info.SignatureBinary).Elements.Select(e => new NativeReferenceElement(e.Kind, e.Name, e.Key)).ToArray()
        });
        using var consumer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, "EventConsumer",
            targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        var basis = consumer.Save();
        var basePath = Path.Combine(work, "base.oml"); File.WriteAllBytes(basePath, basis);
        OdcReferenceImporter.Import((ESpace)consumer, snapshot, [snapshot.Select("IMobileBlock:Shell")]);
        new ModelSession((ESpace)consumer).Apply(JsonNode.Parse("""
        [
          {"op":"create","parent":"@espace","type":"IMobileFlow","name":"Main","as":"$main"},
          {"op":"create","parent":"$main","type":"IMobileBlock","name":"Page","as":"$page"},
          {"op":"create","parent":"$page","type":"IScreenAction","name":"Click","as":"$click"},
          {"op":"create","parent":"$click","type":"IStartNode","as":"$start"},
          {"op":"create","parent":"$click","type":"IEndNode","as":"$end"},
          {"op":"link","from":"$start","to":"$end"},
          {"op":"create","parent":"$page","type":"IScreenAction","name":"OtherClick","as":"$other"},
          {"op":"create","parent":"$other","type":"IStartNode","as":"$start2"},
          {"op":"create","parent":"$other","type":"IEndNode","as":"$end2"},
          {"op":"link","from":"$start2","to":"$end2"},
          {"op":"create","parent":"$page","type":"IMobileBlockInstanceWidget","name":"First","as":"$first"},
          {"op":"set","target":"$first","prop":"SourceBlock","value":"IMobileBlock:Shell"},
          {"op":"set","target":"$first/Closed","prop":"Handler","value":"$click"},
          {"op":"create","parent":"$first/Content","type":"IAdvancedHtml","name":"Clickable","as":"$html"},
          {"op":"set","target":"$html","prop":"Tag","value":"div"},
          {"op":"create","parent":"$html","type":"IEvent","as":"$event"},
          {"op":"set","target":"$event","prop":"Event","value":"onclick"},
          {"op":"set","target":"$event","prop":"Handler","value":"$click"}
        ]
        """)!.AsArray());
        var candidate = Path.Combine(work, "candidate.oml"); File.WriteAllBytes(candidate, consumer.Save());
        var merged = Merge(host, work, basePath, candidate);
        // The precondition of the incident: the merge gave the producer event copy a key of its own.
        Assert.NotEqual(EventKeys(host, candidate).Producer, EventKeys(host, merged).Producer);

        var same = MergeContentProof.Check(host, candidate, merged);
        Assert.True(same["accepted"]!.GetValue<bool>(), same["differences"]!.ToJsonString());

        // Real changes still refuse: the block event handled by another action, the widget event handled by another action.
        IObjectSignature Handler(IObjectSignature model) => Walk(model).Single(n => n.GetInterface()?.Name == "IEventHandler");
        IObjectSignature WidgetEvent(IObjectSignature model) => Walk(model).Single(n => n.GetInterface()?.Name == "IEvent");
        foreach (var (name, pick) in new (string, Func<IObjectSignature, IObjectSignature>)[] { ("handler", Handler), ("widget-event", WidgetEvent) })
        {
            var changed = Edit(host, work, merged, name, model => new JsonArray(new JsonObject {
                ["op"] = "set", ["target"] = "@" + pick(model).ObjectKey, ["prop"] = "Handler", ["value"] = "IMobileBlock:Page/OtherClick" }));
            var proof = MergeContentProof.Check(host, candidate, changed);
            Assert.False(proof["accepted"]!.GetValue<bool>(), name);
            Assert.Contains(proof["differences"]!.AsArray(), d => d!["property"]?.ToString() == "api:Handler");
        }
    }

    private static (string Producer, string Widget) EventKeys(ModelHost host, string path)
    {
        var model = host.Load(File.ReadAllBytes(path));
        try
        {
            var handler = Walk((IObjectSignature)model).Single(n => n.GetInterface()?.Name == "IEventHandler");
            var widget = Walk((IObjectSignature)model).Single(n => n.GetInterface()?.Name == "IEvent");
            return (((IObjectSignature)ModelHost.Prop(handler, "Event")!).ObjectKey.ToString(), widget.ObjectKey.ToString());
        }
        finally { ModelHost.Release(model); }
    }

    internal static string Edit(ModelHost host, string work, string path, string name, Func<IObjectSignature, JsonArray> ops)
    {
        var model = host.Load(File.ReadAllBytes(path));
        try
        {
            new ModelSession(model).Apply(ops((IObjectSignature)model));
            var output = Path.Combine(work, name + ".oml"); File.WriteAllBytes(output, host.Save(model));
            return output;
        }
        finally { ModelHost.Release(model); }
    }

    internal static string Work(string name)
    {
        var work = Path.Combine(Path.GetTempPath(), "ssam-odc-canon", name, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        return work;
    }

    internal static string Merge(ModelHost host, string work, string basePath, string candidate)
    {
        var mergedPath = Path.Combine(work, "merged-" + Guid.NewGuid().ToString("N")[..6] + ".oml");
        var local = host.Load(File.ReadAllBytes(basePath));
        try
        {
            var foreign = host.Load(File.ReadAllBytes(candidate)); var basis = host.Load(File.ReadAllBytes(basePath));
            try { ((IESpace)local).TransactionsManager.ExecuteTransaction("test: native merge", (_, _) => { using var tree = new MatchTree(local, foreign, basis, false, true); Assert.False(tree.HasConflicts); tree.Merge(); return true; }); }
            finally { ModelHost.Release(foreign); ModelHost.Release(basis); }
            File.WriteAllBytes(mergedPath, host.Save(local));
        }
        finally { ModelHost.Release(local); }
        return mergedPath;
    }

    private static Dictionary<string, string> NodeKeys(ModelHost host, string path, string action)
    {
        var model = host.Load(File.ReadAllBytes(path));
        try
        {
            var owner = Walk((IObjectSignature)model).Single(n => n.GetInterface()?.Name == "IServerAction" && ModelHost.Prop(n, "Name")?.ToString() == action);
            return ((IEnumerable)ModelHost.Prop(owner, "Nodes")!).OfType<IObjectSignature>()
                .ToDictionary(n => n.GetInterface()!.Name, n => n.ObjectKey.ToString());
        }
        finally { ModelHost.Release(model); }
    }

    internal static IEnumerable<IObjectSignature> Walk(IObjectSignature root)
    {
        var pending = new Stack<IObjectSignature>(); pending.Push(root);
        while (pending.TryPop(out var node)) { yield return node; foreach (var child in node.Children.OfType<IObjectSignature>()) pending.Push(child); }
    }
}
