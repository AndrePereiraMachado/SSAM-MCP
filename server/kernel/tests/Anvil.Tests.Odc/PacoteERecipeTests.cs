using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// Lane E of the 2026-10-05 package (C07): `ssam_reference recipe` answered nothing for "default screen" and "screen
/// roles" (sessions dd2b79c0 and 62a884e8), because only the curated table of AGENTS.md was searched, by the whole
/// phrase. A query of several words now reaches every suite job whose name, description or ops hold all the words; the
/// curated table still comes first and an exact job name still answers only that job.
/// </summary>
public class PacoteERecipeTests
{
    private static readonly string Root = FindRoot();
    private static JsonArray Recipes(string query) => JsonNode.Parse(JsonSerializer.Serialize(CommandSurface.Recipes(Root, query)))!.AsArray();

    [Fact]
    public void DefaultScreenFindsTheJobsThatSetIt()
    {
        var rows = Recipes("default screen");
        Assert.NotEmpty(rows);
        Assert.Contains(rows, r => File.ReadAllText(Path.Combine(Root, r!["path"]!.GetValue<string>())).Contains("\"DefaultScreen\"", StringComparison.Ordinal));
        Assert.All(rows, r => Assert.True(File.Exists(Path.Combine(Root, r!["path"]!.GetValue<string>()))));
    }

    [Fact]
    public void ScreenRolesFindsJobsAndCuratedRowsComeFirst()
    {
        var rows = Recipes("screen roles");
        Assert.NotEmpty(rows);
        Assert.All(rows, r => { var text = File.ReadAllText(Path.Combine(Root, r!["path"]!.GetValue<string>())).ToLowerInvariant(); Assert.Contains("screen", text); Assert.Contains("roles", text); });
        var entity = Recipes("entidade");
        var firstPlain = entity.Select((r, i) => (r, i)).FirstOrDefault(x => x.r!["rows"]!.AsArray().Count == 0).i;
        Assert.True(entity.Take(firstPlain).All(r => r!["rows"]!.AsArray().Count > 0), "curated rows first");
    }

    [Fact]
    public void AnExactJobNameAnswersOnlyThatJob()
    {
        var rows = Recipes("delete-default-screen");
        var only = Assert.Single(rows);
        Assert.Equal("delete-default-screen", only!["name"]!.GetValue<string>());
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(PacoteERecipeTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
