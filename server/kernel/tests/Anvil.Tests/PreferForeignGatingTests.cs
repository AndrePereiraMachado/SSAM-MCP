using System.Text.Json.Nodes;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>Review A6 of REVISAO-PREFER-FOREIGN: merge_from_oml:prefer_foreign is an optional capability. A bridge_manifest that
/// fails in any way (a transport error, not only a BridgeCallException) means "not offered" and never stops the delivery, and
/// the manifest is read once per bridge connection, not once per merge.</summary>
public sealed class PreferForeignGatingTests
{
    private sealed class Bridge(Func<JsonObject> manifest) : IBridgeClient
    {
        public int Manifests { get; private set; }
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            if (method != "bridge_manifest") throw new InvalidOperationException("unexpected " + method);
            Manifests++;
            return manifest();
        }
    }

    [Fact]
    public void ATransportErrorReadingTheManifestIsNotOfferedAndNeverThrows()
    {
        var bridge = new Bridge(() => throw new IOException("test: the agent's socket closed"));
        Assert.False(Delivery.OffersPreferForeign(bridge));
        // Not cached: the next merge asks again.
        Assert.False(Delivery.OffersPreferForeign(bridge));
        Assert.Equal(2, bridge.Manifests);
    }

    [Fact]
    public void TheManifestIsReadOncePerConnection()
    {
        var offering = new Bridge(() => new JsonObject { ["capabilities"] = new JsonArray("thin", Delivery.PreferForeignCapability) });
        Assert.True(Delivery.OffersPreferForeign(offering));
        Assert.True(Delivery.OffersPreferForeign(offering));
        Assert.Equal(1, offering.Manifests);
        var old = new Bridge(() => new JsonObject { ["capabilities"] = new JsonArray("thin") });
        Assert.False(Delivery.OffersPreferForeign(old));
        Assert.False(Delivery.OffersPreferForeign(old));
        Assert.Equal(1, old.Manifests);
    }
}
