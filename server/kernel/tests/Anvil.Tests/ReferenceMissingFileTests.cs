using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>R1 item 2 (2026-10-28): one recipe query of a hosted session answered "Could not find file" for the whole search.
/// A file of a reference lookup that the installation does not have (the guide, a suite job, a part of a composite job, a
/// proof map of where-can) is skipped and named in the answer; the rest of the lookup answers as before.</summary>
public sealed class ReferenceMissingFileTests
{
    private static readonly string Kernel = JobSources.KernelRoot()!;

    private sealed class Folder : IDisposable
    {
        public string Root { get; } = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "anvil-reference-missing-" + Guid.NewGuid().ToString("N"))).FullName;
        public void Write(string relative, string text)
        {
            var file = Path.Combine(Root, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, text);
        }
        public void Dispose() { try { Directory.Delete(Root, true); } catch (IOException) { } }
    }

    private static JsonArray Recipes(string root, string query) => JsonSerializer.SerializeToNode(CommandSurface.Recipes(root, query))!.AsArray();

    [Fact]
    public void ARecipeWhoseFileIsMissingIsSkippedWithItsNoteAndTheSearchStillAnswers()
    {
        using var folder = new Folder();
        folder.Write("tests/jobs/rm-present.json", """{"description":"Replace the screen stylesheet with the html op","ops":[{"op":"set","target":"@k","prop":"StyleSheet","value":".a{}"}]}""");
        folder.Write("tests/jobs/rm-composite.json", """{"description":"Replace the screen stylesheet in two parts","jobs":["job:rm-part-not-in-this-installation"]}""");
        folder.Write("tests/jobs/rm-broken.json", "{ \"description\": ");
        // No guide (AGENTS.md): the suite jobs still answer, and the guide is named as skipped.
        var rows = Recipes(folder.Root, "screen stylesheet replace");
        var found = Assert.Single(rows, r => r!["skipped"] == null)!;
        Assert.Equal("rm-present", found["name"]!.GetValue<string>());
        Assert.Equal(1, found["opCount"]!.GetValue<int>());
        var skipped = rows.Where(r => r!["skipped"] != null).ToDictionary(r => r!["name"]!.GetValue<string>(), r => r!["skipped"]!.GetValue<string>());
        Assert.Equal(["AGENTS.md", "rm-broken", "rm-composite"], skipped.Keys.Order(StringComparer.Ordinal));
        Assert.Contains("guide", skipped["AGENTS.md"]);
        Assert.Contains("rm-part-not-in-this-installation", skipped["rm-composite"]);
        Assert.Contains("JSON", skipped["rm-broken"]);
        // The notes never name the folders of the installation.
        Assert.DoesNotContain(folder.Root, rows.ToJsonString().Replace("\\\\", "\\"), StringComparison.OrdinalIgnoreCase);

        // With the guide: its rows serve the recipe found; the job whose part is missing is still skipped, never the search.
        folder.Write("AGENTS.md", "| Task | When | Recipe |\n|---|---|---|\n| Stylesheet | Replace a screen stylesheet | `rm-present.json`, `rm-composite.json` |\n");
        var guided = Recipes(folder.Root, "screen stylesheet replace");
        Assert.Equal("rm-present", guided[0]!["name"]!.GetValue<string>());
        Assert.Single(guided[0]!["rows"]!.AsArray());
        Assert.Equal(["rm-broken", "rm-composite"], guided.Where(r => r!["skipped"] != null).Select(r => r!["name"]!.GetValue<string>()).Order(StringComparer.Ordinal));
    }

    [Fact]
    public void KernelRefusalsAndUnexpectedErrorsAreNeverSkippedByTheRecipeExpansionBoundary()
    {
        using var folder = new Folder();
        folder.Write("AGENTS.md", "");
        folder.Write("tests/jobs/expansion.json", """{"ops":[]}""");
        var expand = typeof(CommandSurface).GetMethods(System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic)
            .SingleOrDefault(m => m.Name == "Recipes" && m.GetParameters().Length == 5);
        foreach (var error in new Exception[] { new KernelRefusalException("TEST_REFUSAL", "kernel expansion refused"), new InvalidOperationException("kernel expansion failed"), new ArgumentException("invalid expectation contract") })
        {
            // Earlier releases have no injectable expansion: exercise their exact catch filter to expose the swallow.
            if (expand == null)
            {
                var boundary = typeof(CommandSurface).GetMethod("UnreadableRecipe", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!;
                Assert.False((bool)boundary.Invoke(null, [error])!);
                continue;
            }
            Func<JsonNode, string, JsonArray> fail = (_, _) => throw error;
            var thrown = Assert.Throws<System.Reflection.TargetInvocationException>(() => expand.Invoke(null, [folder.Root, "expansion", false, null, fail]));
            Assert.Same(error, thrown.InnerException);
        }
    }

    [Fact]
    public void ACompositeExpansionContractErrorRemainsAnError()
    {
        using var folder = new Folder();
        folder.Write("AGENTS.md", "");
        folder.Write("tests/jobs/contract-root.json", """{"description":"contract expansion","jobs":["job:contract-part"]}""");
        folder.Write("tests/jobs/contract-part.json", """{"expectedMessages":"invalid","ops":[]}""");
        Assert.Throws<ArgumentException>(() => Recipes(folder.Root, "contract-root"));
    }

    [Fact]
    public void ACompositeCycleRemainsAnError()
    {
        using var folder = new Folder();
        folder.Write("AGENTS.md", "");
        folder.Write("tests/jobs/cycle.json", """{"jobs":["job:cycle"]}""");
        var error = Assert.Throws<ArgumentException>(() => Recipes(folder.Root, "cycle"));
        Assert.Contains("cycle", error.Message);
    }

    [Theory]
    [InlineData("{\"jobs\":\"invalid\",\"ops\":[]}")]
    [InlineData("{\"jobs\":[],\"ops\":\"invalid\"}")]
    [InlineData("123")]
    [InlineData("{\"description\":23,\"jobs\":[]}")]
    [InlineData("{\"jobs\":[123]}")]
    [InlineData("{\"jobs\":{}}")]
    [InlineData("{\"jobs\":[],\"ops\":[{}]}")]
    public void InvalidCompositeShapesAreSkipped(string shape)
    {
        using var folder = new Folder();
        folder.Write("AGENTS.md", "");
        folder.Write("tests/jobs/shape.json", shape);
        var row = Assert.Single(Recipes(folder.Root, "shape"))!;
        Assert.NotNull(row["skipped"]);
    }

    [Fact]
    public void InvalidNestedRecipeShapesAreSkippedWithoutChangingTheRunner()
    {
        using var folder = new Folder();
        folder.Write("AGENTS.md", "");
        folder.Write("tests/jobs/outer.json", """{"jobs":["job:inner"]}""");
        folder.Write("tests/jobs/inner.json", """{"jobs":[],"ops":"invalid"}""");
        Assert.NotNull(Assert.Single(Recipes(folder.Root, "outer"))!["skipped"]);
    }

    [Fact]
    public void AnArrayRecipeKeepsItsOps()
    {
        using var folder = new Folder();
        folder.Write("AGENTS.md", "");
        folder.Write("tests/jobs/array.json", """[{"op":"set","target":"@key","prop":"Name","value":"Example"}]""");
        var row = Assert.Single(Recipes(folder.Root, "array"))!;
        Assert.Null(row["skipped"]);
        Assert.Equal(1, row["opCount"]!.GetValue<int>());
    }

    [Fact]
    public void AWhereCanProofMapTheInstallationLacksLeavesThatRuntimeUnprovedAndTheParentsStillAnswer()
    {
        using var folder = new Folder();
        var catalog = Directory.GetFiles(Path.Combine(Kernel, "catalog"), "model-api-*.json").OrderByDescending(f => f).First();
        var answer = JsonSerializer.SerializeToNode(CommandSurface.WhereCan(folder.Root, catalog, "IServerAction"))!;
        Assert.NotEmpty(answer["possibleParents"]!.AsArray());
        var runtimes = answer["runtimes"]!.AsArray();
        Assert.Equal(["Service", "Reactive", "Mobile", "Traditional"], runtimes.Select(r => r!["runtime"]!.GetValue<string>()));
        Assert.All(runtimes, r =>
        {
            Assert.Equal("unproved", r!["status"]!.GetValue<string>());
            Assert.StartsWith("the proof map docs/mapa/criar-", r["skipped"]!.GetValue<string>());
        });
    }
}
