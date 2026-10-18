using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

// Review english-junction round 1 (F1 with the rule of F2): the suite jobs and the recipe table of AGENTS.md are English
// since 16/10/2026; a Portuguese recipe query keeps finding the jobs it found when they were Portuguese, through the
// search-only aliases of tests/jobs-search-aliases.json. The lists are what the query found on 480672ca (Portuguese).
public class RecipeSearchAliasTests
{
    private static readonly string Root = JobRunner.RepoRoot(Directory.GetCurrentDirectory())!;

    private static string[] Names(string query)
        => JsonSerializer.SerializeToNode(CommandSurface.Recipes(Root, query))!.AsArray().Select(n => n!["name"]!.GetValue<string>()).ToArray();

    [Theory]
    [InlineData("entidade estatica", new[] { "static-entity-lifecycle" })]
    [InlineData("modelo de dados", new[] { "cat-b-theme-resource", "entity-actions", "hire-data-model", "rename-data-propagation", "rename-indexed-attribute", "entity-lifecycle", "entity-refactor", "hire-business-actions" })]
    public void APortugueseQueryFindsTheJobsItFoundBeforeTheTranslation(string query, string[] expected)
        => Assert.Equal(expected, Names(query));

    [Fact]
    public void TheEnglishTableIsReadAndTheDescriptionsServedAreEnglish()
    {
        var all = JsonSerializer.SerializeToNode(CommandSurface.Recipes(Root, "tela detalhe"))!.AsArray();
        Assert.Equal(16, all.Count);
        Assert.Contains(JsonSerializer.SerializeToNode(CommandSurface.Recipes(Root, "data model"))!.AsArray(), n => n!["name"]!.GetValue<string>() == "hire-data-model");
        foreach (var n in all) Assert.DoesNotContain(" nao ", " " + n!["description"]!.GetValue<string>().ToLowerInvariant() + " ");
    }
}
