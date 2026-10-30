using System.Text.Json.Nodes;
using Ssam.Agent;
using Xunit;

public class StudioBuildTests
{
    [Theory]
    [InlineData("odc", "1.7.30.10980")]
    [InlineData("o11", "11.55.93.65333")]
    public void LocalBridgeRequiresExactHostBuild(string lane, string version)
    {
        var pack = new JsonObject { ["studioBuilds"] = new JsonObject { [lane] = new JsonObject { ["version"] = version } } };
        StudioKinds.CheckExactBuild(pack, lane, version);
        Assert.Throws<AgentFault>(() => StudioKinds.CheckExactBuild(pack, lane, version[..version.LastIndexOf('.')]+".99999"));
        Assert.Throws<AgentFault>(() => StudioKinds.CheckExactBuild(pack, lane, null));
        Assert.Throws<AgentFault>(() => StudioKinds.CheckExactBuild(pack, lane == "odc" ? "o11" : "odc", version));
    }

    [Fact]
    public void LegacyPackKeepsItsExistingCompatibilityPolicy()
        => StudioKinds.CheckExactBuild(new JsonObject(), "o11", "11.55.93.65333");
}
