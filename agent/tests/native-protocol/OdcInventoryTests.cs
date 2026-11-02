using Ssam.Agent;
using System.Text.Json.Nodes;
using Xunit;

public sealed class OdcInventoryTests
{
    [Fact]
    public void EveryPinnedOdcDllIsNamedOnce()
    {
        JsonObject File(string name) => new() { ["path"] = name, ["sha256"] = new string('a', 64), ["size"] = 1L };
        var pack = new JsonObject { ["files"] = new JsonArray(File("net10/ODC3.Bridge.v109.dll"), File("net8/ODC3.Bridge.v108.dll"), File("copy/ODC3.Bridge.v108.dll"), new JsonObject { ["path"] = "ODC3.Bridge.v999.dll" }) };
        Assert.Equal("[\"v108\",\"v109\"]", StudioKinds.BundledOdcProtocols(pack).ToJsonString());
        Assert.Empty(StudioKinds.BundledOdcProtocols(null));
        var invalid = File("ODC3.Bridge.v109.dll"); invalid["size"] = "1";
        var mixed = new JsonObject { ["files"] = new JsonArray(null, File("ODC3.Bridge.v0108.dll"), invalid,
            File("ODC3.Bridge.v999999999999999999999.dll"), File("ODC3.Bridge.v108.dll")) };
        Assert.Equal("[\"v108\",\"v999999999999999999999\"]", StudioKinds.BundledOdcProtocols(mixed).ToJsonString());
    }
}
