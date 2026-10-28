using Ssam.Agent;
using Xunit;

public sealed class BridgeTrustTests
{
    [Fact]
    public void Rfc8032EmptyMessageVectorAndNoncanonicalScalar()
    {
        var key = Convert.FromHexString("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        var der = Convert.FromHexString("302a300506032b6570032100").Concat(key).ToArray();
        var pem = "-----BEGIN PUBLIC KEY-----\n" + Convert.ToBase64String(der) + "\n-----END PUBLIC KEY-----";
        var signature = Convert.FromHexString("e5564300c360ac729086e2cc806e828a" + "84877f1eb8e5d974d873e06522490155" +
            "5fb8821590a33bacc61e39701cf9b46bd" + "25bf5f0595bbe24655141438e7a100b");
        Assert.True(BridgeTrust.Verify([], signature, pem));
        Assert.False(BridgeTrust.Verify([1], signature, pem));
        signature[63] = 255;
        Assert.False(BridgeTrust.Verify([], signature, pem));
        Assert.False(BridgeTrust.Verify([], new byte[64], pem));
    }

    [Theory]
    [InlineData("net8.0")]
    [InlineData("net10.0")]
    public void StudioRuntimeUsesTheTargetFramework(string framework)
    {
        var config = new System.Text.Json.Nodes.JsonObject { ["runtimeOptions"] = new System.Text.Json.Nodes.JsonObject { ["tfm"] = framework } };
        Assert.Equal(framework, BridgeUpdates.Runtime(config));
        Assert.Null(BridgeUpdates.Runtime(null));
    }
}
