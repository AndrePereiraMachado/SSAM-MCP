using System.Reflection;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
namespace Anvil.Tests;
public sealed class ProducerSignatureHashWarningTests
{
    public ProducerSignatureHashWarningTests() => StudioAssemblies.Bind();
    [Theory]
    [InlineData("not-an-order-version")]
    [InlineData("")]
    [InlineData("00000000-0000-0000-0000-000000000000")]
    [InlineData("{fa53c5ad-1249-aec9-f6c4-645de330bd52}")]
    public void MalformedOrderCannotExcuseDivergentHash(string marker)
    {
        var bytes = ProducerSignatureEncodingTests.Payload(1252, "Description", true, true, false, marker);
        Assert.Contains("Native element payload hash differs", Assert.Throws<ArgumentException>(() =>
            NativeDependencyReader.ResolveServerSignature(OutSystems.ObjectKeys.ObjectKey.NewKey().ToString(),
                "EncodingProducer", bytes, ["IServerActionSignature:EncodingExport"])).Message);
    }
    [Fact]
    public void DeliveryMustPreserveHashWarning()
    {
        var method = typeof(Anvil.Core.Delivery.Delivery).GetMethod("CapturedEntry", BindingFlags.NonPublic | BindingFlags.Static)!;
        var receipt = new JsonObject { ["hashUnverified"] = new JsonArray("element-key") };
        var entry = (JsonObject)method.Invoke(null, ["Producer", "C:/signature.avsig", "sha", "environment", receipt])!;
        Assert.NotNull(entry["hashUnverified"]);
        Assert.Contains("PRODUCER_HASH_UNVERIFIED", entry["highWarnings"]!.ToJsonString());
    }
}