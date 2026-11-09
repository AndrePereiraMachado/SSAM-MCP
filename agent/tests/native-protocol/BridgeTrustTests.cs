using Ssam.Agent;
using Xunit;

public sealed class BridgeTrustTests
{
    [Fact]
    public void ActiveProtocolIsTrackedPerStudioProcess()
    {
        var root = Path.Combine(Path.GetTempPath(), "bridge-process-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            using var store = new BridgeUpdates(root, root);
            var manifest = new System.Text.Json.Nodes.JsonObject { ["lane"] = "odc", ["studioVersion"] = "1.7.30", ["protocol"] = "v100", ["sequence"] = 1L };
            var bridge = new InstalledBridge(manifest, root, "test-digest");
            var first = new System.Text.Json.Nodes.JsonObject { ["pid"] = 1, ["startedUtc"] = "first" };
            var second = new System.Text.Json.Nodes.JsonObject { ["pid"] = 2, ["startedUtc"] = "second" };
            store.MarkActive(bridge, first); store.MarkActive(bridge, second);
            Assert.Equal("v100", store.ProtocolFor("odc", "1.7.30", first));
            Assert.Equal("v100", store.ProtocolFor("odc", "1.7.30", second));
        }
        finally { Directory.Delete(root, true); }
    }
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

    // 0.4.14-native: the Ed25519 key is the only anchor, generated from the build input; the source build carries none.
    [Fact]
    public void EmptyAnchorIsFeatureOffAndTheKeyDigestIsOfItsSpki()
    {
        Assert.Equal("", BridgeTrust.ManifestPublicKey);
        Assert.False(BridgeTrust.Configured(BridgeTrust.ManifestPublicKey));
        Assert.Equal("", BridgeTrust.SpkiSha256(""));
        var key = Convert.FromHexString("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        var der = Convert.FromHexString("302a300506032b6570032100").Concat(key).ToArray();
        var expected = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(der));
        Assert.Equal(expected, BridgeTrust.SpkiSha256(Convert.ToBase64String(der)));
        Assert.Equal(expected, BridgeTrust.SpkiSha256("-----BEGIN PUBLIC KEY-----\n" + Convert.ToBase64String(der) + "\n-----END PUBLIC KEY-----"));
        var root = Path.Combine(Path.GetTempPath(), "bridge-anchor-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            using (var none = new BridgeUpdates(root, root)) Assert.False(none.HasAnchor);
            using (var some = new BridgeUpdates(root, root, Convert.ToBase64String(der))) Assert.True(some.HasAnchor);
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public void BareBase64SpkiVerifiesLikeThePem()
    {
        var key = Convert.FromHexString("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        var der = Convert.FromHexString("302a300506032b6570032100").Concat(key).ToArray();
        var signature = Convert.FromHexString("e5564300c360ac729086e2cc806e828a" + "84877f1eb8e5d974d873e06522490155" +
            "5fb8821590a33bacc61e39701cf9b46bd" + "25bf5f0595bbe24655141438e7a100b");
        Assert.True(BridgeTrust.Verify([], signature, Convert.ToBase64String(der)));
        Assert.False(BridgeTrust.Verify([], signature, ""));
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
