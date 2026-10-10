using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Atritos 3, pre-release battery: the rules the offline replay of the refused DCIPS deliveries proved wrong. Each case is
/// the real one with synthetic names.
/// </summary>
public sealed class Pa3BateriaTests
{
    public Pa3BateriaTests() { try { StudioAssemblies.Bind(); } catch { /* no Studio: the checked-in catalogs answer */ } }

    private static JsonObject[] Unknown(string actions)
    {
        var job = JsonNode.Parse("""{"ops":[{"op":"spec","data":{"entities":[{"name":"AarStatus","attributes":[{"name":"Label","type":"Text"}]}]}},{"op":"logic","data":{"actions":[""" + actions + "]}}]}")!;
        return JobPreflight.Analyze(job["ops"]!.AsArray(), job, [])["problems"]!.AsArray().OfType<JsonObject>()
            .Where(p => p["code"]!.GetValue<string>() == "EXPR_UNKNOWN_IDENTIFIER").ToArray();
    }

    private static string Find(string list, string condition) => $$$"""
        {"name":"FindStatus","inputs":[{"name":"Status","type":"Text"}],"outputs":[{"name":"Position","type":"Integer"}],"steps":[
          {"get":"AarStatus","as":"GetAarStates"},
          {"call":"ListIndexOf","as":"FindRequested","args":{"List":"{{{list}}}","Condition":"{{{condition}}}"}},
          {"assign":{"Position":"FindRequested.Position"}}]}
        """;

    /// <summary>The Condition (and By) of a list action reads the current element's members bare: the Verify of the same
    /// delivery accepted `ListIndexOf(GetAarStates.List, FuneralHonorsAarStatus.Label = Status)`, and the closed scope of
    /// server logic refused 'FuneralHonorsAarStatus' as a type and not a value. Outside the lambda the rule still holds.</summary>
    [Fact]
    public void AListActionConditionReadsTheElementBareAndTheClosedScopeHoldsElsewhere()
    {
        Assert.Empty(Unknown(Find("GetAarStates.List", "AarStatus.Label = Status")));
        Assert.Empty(Unknown(Find("GetAarStates.List", "Label = Status")));

        var list = Assert.Single(Unknown(Find("Missing.List", "AarStatus.Label = Status")));
        Assert.EndsWith("/args/List", list["pointer"]!.GetValue<string>());

        var assign = Assert.Single(Unknown("""{"name":"ReadStatus","outputs":[{"name":"Label","type":"Text"}],"steps":[{"assign":{"Label":"AarStatus.Label"}}]}"""));
        Assert.Contains("a type and not a value", assign["message"]!.GetValue<string>());
    }
}
