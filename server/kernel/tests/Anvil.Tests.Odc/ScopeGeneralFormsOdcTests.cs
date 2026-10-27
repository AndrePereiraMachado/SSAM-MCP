using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// R7 wired in the job path (JobNormalizer.FlowTexts and WithBase, escopo-kernel 2026-10-24), the mirror on ODC of
/// ScopeGeneralFormsTests, on the blank mobile fixture: a `context` between two actions of one op, a `let` typed by an
/// attribute of an entity of the base, and `mapTo { * }` from a structure of the base into an entity of the base; the scope
/// phase refuses none of the names a context introduces.
/// </summary>
public sealed class ScopeGeneralFormsOdcTests
{
    private const string Fixture = "tests/fixtures/odc/blank-mobile.oml";
    private const string Lane = "odc";

    private const string Records = """
        {"op":"spec","data":{"entities":[
          {"name":"GsOrder","attributes":[{"name":"Code","type":"Text","length":40},{"name":"Total","type":"Decimal"},{"name":"Status","type":"Integer"}]}],
          "structures":[{"name":"GsRow","attributes":[{"name":"Code","type":"Text","length":40},{"name":"Total","type":"Decimal"}]}]}}
        """;

    [Fact]
    public void AContextReachesTheOtherActionsOfTheOp()
    {
        if (!StudioAvailable()) return;
        var dir = Dir();
        var result = Run(dir, "context", $$"""{"base":"{{Fixture}}","ops":[{{Texts(
            "context Tenant: Integer\n\nserver action GsTenantTotal\n  out Total: Integer\n  assign Total = Tenant * 2\n  end\n",
            "server action GsTenantRun\n  out Total: Integer\n  Inner = GsTenantTotal()\n  assign Total = Inner.Total\n  end\n")}}]}""");
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Contains(FlowGeneral.Context, Rules(result));
        Assert.Contains("in Tenant: Integer", Read(dir, "context", "GsTenantRun"));
        Assert.Contains("in Tenant: Integer", Read(dir, "context", "GsTenantTotal"));
    }

    [Fact]
    public void ALetTypedByAnAttributeOfTheBaseAndAProjectionIntoAnEntityOfTheBaseExpandWithTheBase()
    {
        if (!StudioAvailable()) return;
        var dir = Dir();
        var built = Run(dir, "records", $$"""{"base":"{{Fixture}}","ops":[{{Records}}]}""");
        Assert.True(built["accepted"]!.GetValue<bool>(), built.ToJsonString());
        var result = Run(dir, "typed", "{\"ops\":[" + Texts(
            "server action GsFirstTotal\n  in Rows: GsRow List\n  out Total: Decimal\n  out Orders: GsOrder List\n  let First = Rows.Current.Total\n"
            + "  assign Orders = Rows mapTo { *, Status: 1, Id: NullIdentifier() }\n  assign Total = First\n  end\n") + "]}", Path.Combine(dir, "records.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var rules = Rules(result);
        Assert.Contains(FlowGeneral.Let, rules);
        Assert.Contains(FlowGeneral.Projection, rules);
        var text = Read(dir, "typed", "GsFirstTotal");
        Assert.Contains("local First: Decimal", text);
        Assert.DoesNotContain("mapTo { *", text);
    }

    private static HashSet<string> Rules(JsonNode result)
        => (result["normalizations"] as JsonArray ?? []).OfType<JsonObject>().SelectMany(n => n["rule"]!.ToString().Split('+')).ToHashSet();

    private static string Texts(params string[] texts) =>
        new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(texts.Select(t => (JsonNode)t).ToArray()) } }.ToJsonString();

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ScopeGeneralFormsOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string Dir()
    {
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "scope-general-forms", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static JsonNode Run(string dir, string name, string job, string? basePath = null)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), basePath, path, Path.Combine(dir, name + ".oml")))!;
    }

    private static string Read(string dir, string name, string action)
    {
        var bytes = File.ReadAllBytes(Path.Combine(dir, name + ".oml"));
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        return new ModelHost(Path.Combine(dir, "work")).BuildFlow(bytes, sha, Lane).Actions.Single(a => a.Name == action).Text;
    }
}
