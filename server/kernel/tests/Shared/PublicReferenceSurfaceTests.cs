using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

// Compiled and executed against both native adapters; these are product placeholders,
// not names read from a user's module or accepted input aliases.
public sealed class PublicReferenceSurfaceTests
{
    [Fact]
    public void ReferenceFormsUseEnglishPlaceholders()
    {
        var schema = VerbSurface.Schema();
        var references = Assert.IsType<JsonObject>(schema["references"]);
        Assert.Equal("interface name plus object name, e.g. IServerEntity:Booking, IMobileScreen:Home; elements of referenced modules resolve through their *Signature interface",
            references["Type:Name"]?.GetValue<string>());
        Assert.Equal("element of an imported producer by original key (compiler-bound references)",
            references["Type:@producerKey/elementKey"]?.GetValue<string>());
        Assert.False(references.ContainsKey("Tipo:Nome"));
        Assert.False(references.ContainsKey("Tipo:@producerKey/elementKey"));
    }

    [Fact]
    public void ReferenceVerbEffectUsesEnglishPlaceholder()
    {
        var effect = VerbSurface.Schema()["verbs"]!["reference"]!["effect"]!.GetValue<string>();
        Assert.StartsWith("Imports public elements (`Type:Name` list) of a producer module", effect);
        Assert.DoesNotContain("Tipo:Nome", effect);
    }
}