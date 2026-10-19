using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class DataValueParityTests
{
    private static JsonObject Table()
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(DataValueParityTests).Assembly.Location)!)!;
        return JsonNode.Parse(File.ReadAllText(Path.Combine(root, "tests", "fixtures", "data-load", "value-coercion.json")))!.AsObject();
    }

    public static IEnumerable<object[]> Encodings() => Table()["encode"]!.AsArray()
        .Select(x => new object[] { x!["type"]!.ToString(), x["json"]?.ToJsonString() ?? "null", x["written"]?.ToString()! });
    public static IEnumerable<object[]> Canonicals() => Table()["canonical"]!.AsArray()
        .Select(x => new object[] { x!["type"]!.ToString(), x["text"]?.ToString()!, x["canonical"]?.ToString()! });

    [Theory]
    [MemberData(nameof(Encodings))]
    public void SharedEncodingTableMatchesKernel(string type, string json, string? written)
    {
        var attribute = new DataAttribute("Value", "k-value", false, false, type);
        var value = JsonNode.Parse(json);
        if (written != null || value == null) Assert.Equal(written, EnvironmentData.Encode(attribute, value, "Fixture"));
        else
        {
            var error = Assert.Throws<EnvironmentData.DataRequestException>(() => EnvironmentData.Encode(attribute, value, "Fixture"));
            Assert.Equal("DATA_VALUE_INVALID", error.Code);
            Assert.Contains("; accepted: ", error.Message);
        }
    }

    [Theory]
    [MemberData(nameof(Canonicals))]
    public void SharedCanonicalTableMatchesKernel(string type, string? text, string? canonical)
        => Assert.Equal(canonical, EnvironmentData.Canonical(new("Value", "k-value", false, false, type), text));
}
