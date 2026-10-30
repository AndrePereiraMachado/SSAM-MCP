using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model;
using ServiceStudio.Model;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R3-C (K2): the content proof and the names the Studio gives on its own. An aggregate named "Get" + the plural of its entity
/// that has a filter by an attribute is renamed by the Studio when a merge sets that filter (the native
/// OnFilterConditionChanged: Get + plural + By + the attribute); the candidate the kernel built keeps the author's name. The
/// proof saw a lost element and an added one (a false MERGE_CONTENT_MISMATCH on an applied merge). Here the merged module is a
/// second, independent build (every local key regenerated, as after the merge) on which the Studio's OWN method renamed the
/// aggregate: the proof accepts it and names the rename. Controls, on the same pair: a rename the registry does not predict
/// still refuses, and the predicted name over different content still refuses; an aggregate of another name is never renamed
/// by the Studio nor predicted.
/// </summary>
public class NativeNamesContentProofTests
{
    private const string Job = """
        {"base": "tests/fixtures/blank-service.oml", "ops": [
          {"op": "spec", "data": {"entities": [
            {"name": "Shipment", "description": "A parcel on its way.",
             "attributes": [{"name": "CarrierId", "type": "Integer"}, {"name": "Code", "type": "Text", "length": 50}]}]}},
          {"op": "logic", "data": {"actions": [
            {"name": "Shipment_CountByCarrier", "kind": "server", "description": "How many shipments a carrier has.",
             "inputs": [{"name": "CarrierId", "type": "Integer"}], "outputs": [{"name": "Total", "type": "Integer"}],
             "steps": [
               {"get": "Shipment", "as": "GetShipments", "where": "Shipment.CarrierId = CarrierId"},
               {"assign": {"Total": "GetShipments.Count"}, "as": "Counted"}]},
            {"name": "Shipment_CodesOfCarrier", "kind": "server", "description": "The shipments of a carrier, by another name.",
             "inputs": [{"name": "CarrierId", "type": "Integer"}], "outputs": [{"name": "Total", "type": "Integer"}],
             "steps": [
               {"get": "Shipment", "as": "ShipmentsOfCarrier", "where": "Shipment.CarrierId = CarrierId"},
               {"assign": {"Total": "ShipmentsOfCarrier.Count"}, "as": "Counted"}]}]}}]}
        """;

    [Fact]
    public void ThePredictedNativeRenameIsAcceptedAndAnyOtherDifferenceStillRefuses()
    {
        if (!StudioAvailable()) return;
        Run();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run()
    {
        var root = MergeIdentitySweep.Root;
        var work = Path.Combine(root, ".local", "native-names-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = JsonNode.Parse(Job)!.AsObject();
        job["base"] = Path.Combine(root, "tests", "fixtures", "blank-service.oml");
        var jobPath = Path.Combine(work, "job.json"); File.WriteAllText(jobPath, job.ToJsonString());

        var candidate = MergeIdentitySweep.Build(jobPath, Path.Combine(work, "candidate.oml"), null);
        Assert.True(candidate.Error == null, candidate.Error);
        var second = MergeIdentitySweep.Build(jobPath, Path.Combine(work, "second.oml"), null);
        Assert.True(second.Error == null, second.Error);
        var host = new ModelHost(Path.Combine(work, "proof-model"));

        // The premise: the kernel's build keeps the author's name (the Model API never fires the Studio's rename).
        var built = host.Load(candidate.Path!);
        try { Assert.Single(Aggregates(built, "GetShipments")); }
        finally { ModelHost.Release(built); }

        // The merged module: the second build, the Studio's own OnFilterConditionChanged on each aggregate with a filter, then
        // (per case) one more change.
        string Merged(string name, Action<ESpace>? more)
        {
            var model = host.Load(second.Path!);
            try
            {
                StudioAdapter.Runtime.Mutate(model, "test: the merge sets the filters", _ => { foreach (var aggregate in Aggregates(model, null)) NativeFilterChanged(aggregate); });
                more?.Invoke(model);
                var path = Path.Combine(work, name + ".oml");
                File.WriteAllBytes(path, host.Save(model));
                return path;
            }
            finally { ModelHost.Release(model); }
        }

        // 1. The Studio renamed GetShipments (Get + plural + By + the attribute) and left ShipmentsOfCarrier: accepted, named.
        var renamed = Merged("renamed", null);
        var check = host.Load(renamed);
        try
        {
            Assert.Single(Aggregates(check, "GetShipmentsByCarrierId"));
            Assert.Empty(Aggregates(check, "GetShipments"));
            Assert.Single(Aggregates(check, "ShipmentsOfCarrier"));
        }
        finally { ModelHost.Release(check); }
        var proof = MergeContentProof.Check(host, candidate.Path!, renamed);
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof["differences"]?.ToJsonString());
        var renames = proof["nativeNames"]!["renames"]!.AsArray();
        var only = Assert.Single(renames);
        Assert.Equal("GetShipments", only!["from"]!.ToString());
        Assert.Equal("GetShipmentsByCarrierId", only["to"]!.ToString());
        Assert.Equal("aggregate-filter-by-attribute", only["rule"]!.ToString());
        Assert.True(proof["nativeNames"]!["differencesWithoutRenames"]!.GetValue<int>() > 0);

        // 2. A rename no rule predicts (the same aggregate, another name): refused, naming the aggregate.
        var other = Merged("unpredicted", model => SetName(model, Aggregates(model, "GetShipmentsByCarrierId").Single(), "GetShipmentsOfCarrier"));
        var refused = MergeContentProof.Check(host, candidate.Path!, other);
        Assert.False(refused["accepted"]!.GetValue<bool>());
        Assert.Contains(refused["differences"]!.AsArray(), d => d!["element"]!.ToString().Contains("GetShipments", StringComparison.Ordinal));

        // 3. The predicted name over other content (a max records the candidate does not have): refused, naming it.
        var changed = Merged("changed", model => new ModelSession(model).Apply(new JsonArray(new JsonObject {
            ["op"] = "set", ["target"] = "@" + Aggregates(model, "GetShipmentsByCarrierId").Single().ObjectKey, ["prop"] = "MaxRecords", ["value"] = "7" })));
        var different = MergeContentProof.Check(host, candidate.Path!, changed);
        Assert.False(different["accepted"]!.GetValue<bool>());
        Assert.Contains(different["differences"]!.AsArray(), d => d!["element"]!.ToString().Contains("GetShipmentsByCarrierId", StringComparison.Ordinal));
        Assert.Equal("GetShipmentsByCarrierId", different["nativeNames"]!["renames"]![0]!["to"]!.ToString());

        // 4. The merged module renamed ShipmentsOfCarrier too (no rule of the Studio does that): refused.
        var both = Merged("both", model => SetName(model, Aggregates(model, "ShipmentsOfCarrier").Single(), "GetShipmentsOfCarrier"));
        Assert.False(MergeContentProof.Check(host, candidate.Path!, both)["accepted"]!.GetValue<bool>());
    }

    private static List<IObjectSignature> Aggregates(ESpace model, string? name) =>
        MergeIdentitySweep.Walk(model).Where(n => MergeIdentitySweep.Kind(n) == "IAggregateNode"
            && (name == null || ModelHost.Prop(n, "Name")?.ToString() == name)).ToList();

    // The Studio's own reaction to a filter set by a merge: AbstractDataSet.OnFilterConditionChanged(filter) for each filter.
    private static void NativeFilterChanged(IObjectSignature aggregate)
    {
        var method = typeof(ServiceStudio.Model.Nodes.AbstractDataSet).GetMethod("OnFilterConditionChanged", BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException("this Studio has no AbstractDataSet.OnFilterConditionChanged");
        foreach (var filter in MergeIdentitySweep.Walk(aggregate).OfType<ServiceStudio.Model.Filter>().ToList())
            method.Invoke(aggregate, [filter]);
    }

    private static void SetName(ESpace model, IObjectSignature element, string name) => StudioAdapter.Runtime.Mutate(model, "test: rename", _ =>
        element.GetType().GetMethod("SetName", BindingFlags.Public | BindingFlags.Instance, null, [typeof(string)], null)!.Invoke(element, [name]));

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }
}
