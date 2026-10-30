using System.Text.Json.Nodes;
using Ssam.Agent;
using Xunit;

public class BridgeVersionChoiceTests
{
    private static readonly JsonNode Both = JsonNode.Parse("""{"odcBridge":"v101","odcBridgeAccepted":["v98"]}""")!;
    private static readonly JsonNode Newest = JsonNode.Parse("""{"odcBridge":"v101"}""")!;

    [Theory]
    [InlineData("v98", "v101", true)]
    [InlineData("v101", "v98", true)]
    [InlineData("v34", "v101", false)]
    [InlineData("v98", "v34", false)]
    public void BothVersionsMustBeServed(string asked, string loaded, bool expected) => Assert.Equal(expected, StudioKinds.ServedTogether(Both, asked, loaded));

    [Fact]
    public void ABridgeTheKernelNoLongerServesIsNotAnswered() => Assert.False(StudioKinds.ServedTogether(Newest, "v101", "v98"));

    [Fact]
    public void WithoutAKernelNothingIsServed() => Assert.False(StudioKinds.ServedTogether(null, "v98", "v98"));
}
