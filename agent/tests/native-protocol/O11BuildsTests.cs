using System.Text.Json.Nodes;
using Ssam.Agent;
using Xunit;

// One O11 thin bridge per Service Studio version in one pack (pack.json o11Builds, 0.4.4-native, the Node agent's
// o11-builds.mjs): the build of the Studio the customer has decides o11BuiltFor (hello), the bridge file the hook loads and the
// sha256 of the handshake. A build the integrity list does not confirm is ignored, and a pack built without the trust anchors
// (bridgeOffer false) never asks for offers.
public class O11BuildsTests
{
    private static readonly string A = new('a', 64), B = new('b', 64), C = new('c', 64);
    private static JsonObject Pack(string hook = "dev") => new()
    {
        ["o11BuiltFor"] = "11.55.94", ["o11Hook"] = hook,
        ["o11Bridge"] = new JsonObject { ["path"] = "bin/o11/bridge/Anvil.Bridge.dll", ["sha256"] = A },
        ["o11Builds"] = new JsonArray(
            new JsonObject { ["version"] = "11.55.94", ["runtime"] = "net10.0", ["path"] = "bin/o11/bridge/Anvil.Bridge.dll", ["sha256"] = A },
            new JsonObject { ["version"] = "11.55.93", ["runtime"] = "net8.0", ["path"] = "bin/o11/bridges/11.55.93/Anvil.Bridge.dll", ["sha256"] = B },
            new JsonObject { ["version"] = "11.55.92", ["runtime"] = "net8.0", ["path"] = "bin/o11/bridges/11.55.92/Anvil.Bridge.dll", ["sha256"] = C },
            new JsonObject { ["version"] = "11.55.91", ["path"] = "agent/lib/x.dll", ["sha256"] = C }),
        ["files"] = new JsonArray(
            new JsonObject { ["path"] = "bin/o11/bridge/Anvil.Bridge.dll", ["sha256"] = A },
            new JsonObject { ["path"] = "bin/o11/bridges/11.55.93/Anvil.Bridge.dll", ["sha256"] = B },
            new JsonObject { ["path"] = "bin/o11/bridges/11.55.92/Anvil.Bridge.dll", ["sha256"] = C },
            new JsonObject { ["path"] = "agent/lib/x.dll", ["sha256"] = C })
    };

    [Theory]
    [InlineData("11.55.94.65328", "11.55.94", "net10.0", "bin/o11/bridge/Anvil.Bridge.dll", 'a')]
    [InlineData("11.55.93.65289", "11.55.93", "net8.0", "bin/o11/bridges/11.55.93/Anvil.Bridge.dll", 'b')]
    [InlineData("11.55.92.65269", "11.55.92", "net8.0", "bin/o11/bridges/11.55.92/Anvil.Bridge.dll", 'c')]
    public void EachServedStudioGetsItsOwnBuild(string studio, string builtFor, string runtime, string bridge, char sha)
    {
        var view = O11Builds.PackFor(Pack(), studio);
        Assert.Equal(builtFor, StudioKinds.Text(view["o11BuiltFor"]));
        Assert.Equal(runtime, StudioKinds.Text(view["o11Runtime"]));
        Assert.Equal(bridge, StudioKinds.Text(view["o11Bridge"]?["path"]));
        Assert.Equal(new string(sha, 64), StudioKinds.Text(view["o11Bridge"]?["sha256"]));
        Assert.Equal(Path.Combine("R", bridge), O11Builds.BridgeFile("R", view));
    }

    [Fact]
    public void AnotherVersionTheH1HookOrAnUnlistedBuildLeaveThePackAsItIs()
    {
        var pack = Pack();
        Assert.Same(pack, O11Builds.PackFor(pack, "11.55.91.1"));
        Assert.Same(pack, O11Builds.PackFor(pack, null));
        var h1 = Pack("h1");
        Assert.Same(h1, O11Builds.PackFor(h1, "11.55.93"));
        Assert.Equal(new[] { "11.55.94", "11.55.93", "11.55.92" }, O11Builds.Versions(pack).Select(n => StudioKinds.Text(n)).ToArray());
        var changed = Pack(); ((JsonObject)((JsonArray)changed["files"]!)[1]!)["sha256"] = C;
        Assert.Null(O11Builds.For(changed, "11.55.93"));
        Assert.Equal(Path.Combine("R", O11Builds.DefaultBridge), O11Builds.BridgeFile("R", new JsonObject { ["o11Bridge"] = new JsonObject { ["path"] = "studio/o11/bridge/b1/Anvil.Bridge.dll" } }));
    }

    [Fact]
    public void BundledSupportFollowsTheBuildOfEachStudio()
    {
        var pack = Pack();
        Assert.True(BridgeUpdates.BundledSupports(pack, "R", "o11", "11.55.94.65328", "net10.0"));
        Assert.True(BridgeUpdates.BundledSupports(pack, "R", "o11", "11.55.93.65289", "net8.0"));
        Assert.True(BridgeUpdates.BundledSupports(pack, "R", "o11", "11.55.92.65269", "net8.0"));
        Assert.False(BridgeUpdates.BundledSupports(pack, "R", "o11", "11.55.93.65289", "net10.0"));
        Assert.False(BridgeUpdates.BundledSupports(pack, "R", "o11", "11.55.91.1", "net8.0"));
    }

    [Fact]
    public void CheckO11BuildMatchesTheEffectiveBuild()
    {
        var pack = Pack();
        var kinds = new StudioKinds("R", "R", pack, () => new JsonObject { ["o11"] = "11.55.93" });
        Assert.Null(kinds.CheckO11Build("11.55.93.65289", O11Builds.PackFor(pack, "11.55.93.65289")));
        Assert.Throws<AgentFault>(() => kinds.CheckO11Build("11.55.93.65289"));
    }

    [Fact]
    public void APackWithoutTrustAnchorsNeverAsksForOffers()
    {
        Assert.True(AgentChannel.NoAnchors(new JsonObject { ["bridgeOffer"] = false }));
        Assert.False(AgentChannel.NoAnchors(new JsonObject()));
        Assert.False(AgentChannel.NoAnchors(new JsonObject { ["bridgeOffer"] = true }));
        Assert.False(AgentChannel.NoAnchors(null));
    }

    // Review B1 of F5: a pack with no integrity list has no valid build (refused closed).
    [Fact]
    public void APackWithoutItsFilesListHasNoValidBuild()
    {
        var pack = Pack(); pack.Remove("files");
        Assert.Empty(O11Builds.All(pack));
        Assert.Null(O11Builds.For(pack, "11.55.93"));
        Assert.Same(pack, O11Builds.PackFor(pack, "11.55.93"));
    }

    // Review B3 of F5: the hello's o11BuiltFor follows the connected (attached) Service Studio before the installed one.
    [Fact]
    public void TheHelloPrefersTheConnectedStudio()
    {
        var root = AppContext.BaseDirectory;
        while (root != null && !File.Exists(Path.Combine(root, "native", "Ssam.Agent", "AgentChannel.cs"))) root = Path.GetDirectoryName(root);
        Assert.NotNull(root);
        var source = File.ReadAllText(Path.Combine(root!, "native", "Ssam.Agent", "AgentChannel.cs"));
        Assert.Contains("O11Builds.PackFor(pack, StudioKinds.Text(versions[\"o11Connection\"]?[\"studioVersion\"]) ?? StudioKinds.Text(installed?[\"o11\"]?[\"installed\"]?[\"version\"]))", source);
    }
}
