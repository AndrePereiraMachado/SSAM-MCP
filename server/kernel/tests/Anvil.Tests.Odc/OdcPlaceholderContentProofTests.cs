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

public class OdcPlaceholderContentProofTests
{
    [Fact]
    public void RegeneratedSlotsPreserveContentButRealEditsStillRefuse()
    {
        StudioAssembliesOdc.Bind();
        Run();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run()
    {
        var work = Path.Combine(Path.GetTempPath(), "slot-proof", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        using var producer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, "SlotProducer",
            targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        new ModelSession((ESpace)producer).Apply(JsonNode.Parse("""
        [
          {"op":"create","parent":"@espace","type":"IMobileFlow","name":"Shared","as":"$shared"},
          {"op":"create","parent":"$shared","type":"IMobileBlock","name":"Shell","as":"$shell"},
          {"op":"set","target":"$shell","prop":"Public","value":true},
          {"op":"create","parent":"$shell","type":"IPlaceholderWidget","name":"Content"},
          {"op":"create","parent":"$shell","type":"IPlaceholderWidget","name":"Footer"}
        ]
        """)!.AsArray());
        producer.Save();
        var info = ReferenceInfo.ConvertToReferenceInfo(producer);
        var snapshot = NativeReferenceSnapshot.Create(new NativeReferenceSnapshot {
            FormatVersion = 2, Environment = "lab.test", ModuleKey = info.Key.ToString(),
            ApplicationKey = info.AppKey?.ToString() ?? "", ModuleKind = ReferenceKind.eSpace,
            ModuleType = SegmentationKind.ReactiveLibrary, Name = info.Name,
            SignatureHash = Guid.Parse("ab333333-2222-3333-4444-555555555555"), SignatureBinary = info.SignatureBinary,
            Elements = OdcPublicSignature.Read(info.SignatureBinary).Elements.Select(e => new NativeReferenceElement(e.Kind, e.Name, e.Key)).ToArray()
        });
        var signaturePath = Path.Combine(work, "producer.avsig"); snapshot.Write(signaturePath);
        using var consumer = Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, "SlotConsumer",
            targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        var basis = consumer.Save();
        var basePath = Path.Combine(work, "base.oml"); File.WriteAllBytes(basePath, basis);
        OdcReferenceImporter.Import((ESpace)consumer, snapshot, [snapshot.Select("IMobileBlock:Shell")]);
        new ModelSession((ESpace)consumer).Apply(JsonNode.Parse("""
        [
          {"op":"create","parent":"@espace","type":"IMobileFlow","name":"Main","as":"$main"},
          {"op":"create","parent":"$main","type":"IMobileBlock","name":"Page","as":"$page"},
          {"op":"create","parent":"$page","type":"IMobileBlockInstanceWidget","name":"First","as":"$first"},
          {"op":"set","target":"$first","prop":"SourceBlock","value":"IMobileBlock:Shell"},
          {"op":"html","parent":"$first/Content","html":"<span>Alpha</span><span>Beta</span>"},
          {"op":"html","parent":"$first/Footer","html":"<span>Footer</span>"},
          {"op":"create","parent":"$page","type":"IMobileBlockInstanceWidget","name":"Second","as":"$second"},
          {"op":"set","target":"$second","prop":"SourceBlock","value":"IMobileBlock:Shell"},
          {"op":"html","parent":"$second/Content","html":"<span>Second</span>"},
          {"op":"create","parent":"$page","type":"IScreenAction","name":"Click","as":"$click"},
          {"op":"create","parent":"$click","type":"IStartNode","as":"$start"},
          {"op":"create","parent":"$click","type":"IEndNode","as":"$end"},
          {"op":"link","from":"$start","to":"$end"},
          {"op":"create","parent":"$page","type":"IScreenAction","name":"OtherClick","as":"$other"},
          {"op":"create","parent":"$other","type":"IStartNode","as":"$start2"},
          {"op":"create","parent":"$other","type":"IEndNode","as":"$end2"},
          {"op":"link","from":"$start2","to":"$end2"},
          {"op":"create","parent":"$first/Footer","type":"IButton","name":"ActionButton","as":"$button"},
          {"op":"set","target":"$button/OnClick","prop":"Destination","value":"$click"},
          {"op":"create","parent":"$first/Footer","type":"IExpression","name":"Dynamic","as":"$dynamic"},
          {"op":"set","target":"$dynamic","prop":"Value","value":"\"Original\""}
        ]
        """)!.AsArray());
        var candidate = Path.Combine(work, "candidate.oml"); File.WriteAllBytes(candidate, consumer.Save());
        var merged = Path.Combine(work, "merged.oml");
        using (var local = host.Load(basis))
        using (var foreign = host.Load(candidate))
        using (var ancestor = host.Load(basis)) {
            ((IESpace)local).TransactionsManager.ExecuteTransaction("test: merge referenced slots", (_, _) => {
                using var tree = new MatchTree(local, foreign, ancestor, false, true);
                Assert.False(tree.HasConflicts); tree.Merge(); return true;
            });
            File.WriteAllBytes(merged, host.Save(local));
        }
        // Prove that this fixture exercises regenerated producer placeholder keys, rather than an identity-preserving merge.
        using (var expected = host.Load(candidate))
        using (var actual = host.Load(merged)) {
            var before = Slots(expected); var after = Slots(actual);
            Assert.Equal(before.Length, after.Length);
            Assert.Contains(before.Zip(after), pair => ModelHost.Prop(pair.First, "Placeholder") is IObjectSignature a
                && ModelHost.Prop(pair.Second, "Placeholder") is IObjectSignature b && !a.ObjectKey.Equals(b.ObjectKey));
        }
        var proof = MergeContentProof.Check(host, candidate, merged);
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof["differences"]!.ToJsonString());
        Assert.Empty(proof["differences"]!.AsArray());

        // Preserve the native keys for every intentional edit: only the stated semantic difference changes.
        void Refuses(string name, Action<ModelSession, IObjectSignature[]> edit, string property)
        {
            using var changed = host.Load(merged);
            edit(new ModelSession(changed), Slots(changed));
            var output = Path.Combine(work, name + ".oml"); File.WriteAllBytes(output, host.Save(changed));
            var lost = MergeContentProof.Check(host, candidate, output);
            Assert.False(lost["accepted"]!.GetValue<bool>(), name);
            Assert.Contains(lost["differences"]!.AsArray(), d => d!["property"]!.ToString() == property);
        }
        Refuses("text", (session, slots) => session.Apply(new JsonArray(new JsonObject {
            ["op"] = "set", ["target"] = "@" + Walk(Widgets(slots[0])[0]).Single(n => n.GetInterface()?.Name == "ITextWidget").ObjectKey,
            ["prop"] = "Text", ["value"] = "Changed" })), "api:Text");
        Refuses("removed", (session, slots) => session.Apply(new JsonArray(new JsonObject {
            ["op"] = "delete", ["target"] = "@" + Widgets(slots[0])[0].ObjectKey, ["force"] = true })), "ordered:Widgets");
        Refuses("reordered", (session, slots) => session.Apply(new JsonArray(new JsonObject {
            ["op"] = "move", ["target"] = "@" + Widgets(slots[0])[0].ObjectKey,
            ["last"] = true })), "ordered:Widgets");
        Refuses("other-slot", (session, slots) => session.Apply(new JsonArray(new JsonObject {
            ["op"] = "move", ["target"] = "@" + Widgets(slots[0])[0].ObjectKey,
            ["into"] = "@" + slots[1].ObjectKey })), "$parent");
        Refuses("other-instance", (session, slots) => session.Apply(new JsonArray(new JsonObject {
            ["op"] = "move", ["target"] = "@" + Widgets(slots[0])[0].ObjectKey,
            ["into"] = "@" + slots[2].ObjectKey })), "$parent");
        Refuses("event", (session, _) => session.Apply(JsonNode.Parse("""
            [{"op":"set","target":"IButton:ActionButton/OnClick","prop":"Destination","value":"IMobileBlock:Page/OtherClick"}]
            """)!.AsArray()), "api:Destination");
        Refuses("expression", (session, _) => session.Apply(JsonNode.Parse("""
            [{"op":"set","target":"IExpression:Dynamic","prop":"Value","value":"\"Changed\""}]
            """)!.AsArray()), "$expression");
    }

    private static IObjectSignature[] Widgets(IObjectSignature slot) =>
        ((IEnumerable)ModelHost.Prop(slot, "Widgets")!).OfType<IObjectSignature>().ToArray();

    private static IObjectSignature[] Slots(IObjectSignature model) => Walk(model)
        .Where(n => n.GetInterface()?.Name == "IPlaceholderContentWidget")
        .OrderBy(n => ModelHost.Prop(n.Parent!, "Name")?.ToString(), StringComparer.Ordinal)
        .ThenBy(n => ModelHost.Prop(n, "Name")?.ToString(), StringComparer.Ordinal).ToArray();

    private static IEnumerable<IObjectSignature> Walk(IObjectSignature root)
    {
        yield return root;
        foreach (var child in root.Children.OfType<IObjectSignature>())
            foreach (var nested in Walk(child)) yield return nested;
    }
}
