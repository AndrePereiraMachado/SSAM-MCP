using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// L3a, ODC mirror of NativeProbeTests: `api --op native --types` (NativeProbe) answers every type as `api --op native --type` (NativeSurface) does, in
/// one process: the same JSON per type, in the order asked, a repeated name once. Compared here only for full names: a short
/// name several assemblies share (IImage) answers what a FRESH process answers, which is what the batch keeps, and this test
/// process has loaded more by then (the batch itself loads the model plugins). Against fresh processes, plugin types first and
/// short names among them, the facade test discovery-index-native-batch.test.mjs compares 20 types per lane byte for byte.
/// </summary>
public class NativeProbeOdcTests
{
    private static readonly string[] Types = ["INoSuchNativeType", "ServiceStudio.Plugin.REST.IRestAction", "OutSystems.Model.Logic.IServerAction", "OutSystems.Model.UI.Mobile.IMobileScreen", "ServiceStudio.Plugin.RESTService.IRestService"];

    [Fact]
    public void EachTypeAnswersAsItsOwnProbe()
    {
        StudioAssembliesOdc.Bind(null);
        var batch = NativeProbe.DescribeMany([.. Types, Types[2]]);
        var results = batch["results"]!.AsObject();
        Assert.Equal(Types, results.Select(r => r.Key));
        Assert.Equal(Types.Length, batch["types"]!.GetValue<int>());
        foreach (var type in Types)
        {
            Assert.True(results[type]!["ok"]!.GetValue<bool>(), type);
            Assert.Equal(NativeSurface.Describe(type).ToJsonString(), results[type]!["data"]!.ToJsonString());
        }
        Assert.Empty(results["INoSuchNativeType"]!["data"]!["candidates"]!.AsArray());
        Assert.Equal("OutSystems.Model.Plugin.REST.dll", results["ServiceStudio.Plugin.REST.IRestAction"]!["data"]!["candidates"]![0]!["assembly"]!["file"]!.GetValue<string>());
    }

    [Fact]
    public void NamesAreTheCommaListOnceEachInOrder()
    {
        Assert.Equal(["IEntity", "IAction"], NativeProbe.Names(" IEntity, ,IAction,IEntity "));
        Assert.Throws<ArgumentException>(() => NativeProbe.Names(" , "));
    }
}
