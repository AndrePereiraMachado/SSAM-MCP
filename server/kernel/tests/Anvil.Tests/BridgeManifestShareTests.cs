using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>CX14 follow-up (owner rule: fewer rounds): one bridge_manifest per client, shared by the pre-probe of the
/// watched writes and the kernel's own capability checks (Delivery.HasCapability/Offers call bridge_manifest). The real
/// BridgeClient against a loopback fake Studio. Synthetic values only.</summary>
public class BridgeManifestShareTests
{
    [Fact]
    public void ACapabilityCheckAfterAPreProbeUsesTheManifestTheClientAlreadyRead()
    {
        using var test = new StallCase(); var studio = test.Studio; // a private authority folder: no real bridge key is read
        var client = new BridgeClient(studio.Port, probeMs: 100);
        client.Call("open_module", new JsonObject { ["name"] = "Probe" });
        Assert.Equal(1, studio.Count("bridge_manifest"));
        Assert.NotNull(client.Call("bridge_manifest")["capabilities"]);
        client.Call("bridge_manifest");
        client.Call("close_module", new JsonObject { ["name"] = "Probe" });
        Assert.Equal(1, studio.Count("bridge_manifest"));
    }

    [Fact]
    public void APreProbeAfterACapabilityCheckUsesTheManifestTheClientAlreadyRead()
    {
        using var test = new StallCase(); var studio = test.Studio; // a private authority folder: no real bridge key is read
        var client = new BridgeClient(studio.Port, probeMs: 100);
        Assert.NotNull(client.Call("bridge_manifest")["capabilities"]);
        client.Call("open_module", new JsonObject { ["name"] = "Probe" });
        client.Call("open_module", new JsonObject { ["name"] = "Probe" });
        Assert.Equal(1, studio.Count("bridge_manifest"));
        // Another client (another kernel command) reads its own.
        new BridgeClient(studio.Port, probeMs: 100).Call("bridge_manifest");
        Assert.Equal(2, studio.Count("bridge_manifest"));
    }
}
