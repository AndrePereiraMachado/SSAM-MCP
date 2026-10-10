using System.Text.RegularExpressions;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// O AGENTS.md e o ponto de entrada de qualquer LLM: cada job que ele cita tem de existir, e cada job de tests/jobs tem de
/// estar citado nele (senao e uma prova que ninguem encontra). Os exemplos do guia sao os proprios jobs testados.
/// </summary>
public class GuideTests
{
    private static readonly string Root = FindRoot();

    [Fact]
    public void EveryJobMentionedInTheGuideExists()
    {
        var guide = File.ReadAllText(Path.Combine(Root, "AGENTS.md"));
        var mentioned = Regex.Matches(guide, @"(?<![\w.\-])([a-z][a-z0-9-]*)\.json\b").Select(m => m.Groups[1].Value).Distinct().ToList();
        // Todas as pastas de job das DUAS faixas: um job so do ODC (theme-css-halves) tambem e citavel pelo nome.
        var folders = new[] { "jobs", "jobs-live", "jobs-negative", "jobs-odc", "jobs-odc-negative" };
        var missing = mentioned.Where(n => !folders.Any(f => File.Exists(Path.Combine(Root, "tests", f, n + ".json"))) && n != "result" /* generated delivery artifact, not a job */ && !n.StartsWith("model-api") && !n.StartsWith("verify-messages") && !n.StartsWith("functions-") && !n.Contains("OutSystems")).ToList();
        Assert.True(missing.Count == 0, "jobs citados no AGENTS.md que nao existem: " + string.Join(", ", missing));
    }

    [Fact]
    public void EveryTestJobIsMentionedInTheGuide()
    {
        var guide = File.ReadAllText(Path.Combine(Root, "AGENTS.md"));
        var jobs = Directory.GetFiles(Path.Combine(Root, "tests", "jobs"), "*.json").Select(Path.GetFileNameWithoutExtension).ToList();
        var orphans = jobs.Where(j => !guide.Contains(j + ".json", StringComparison.Ordinal)).ToList();
        Assert.True(orphans.Count == 0, "jobs sem referencia no AGENTS.md (uma LLM fria nao os encontra): " + string.Join(", ", orphans));
    }

    [Fact]
    public void NoJobIsAVersionedCopy()
    {
        var bad = new List<string>();
        foreach (var dir in new[] { "jobs", "jobs-negative", "jobs-live" })
        {
            var d = Path.Combine(Root, "tests", dir);
            if (!Directory.Exists(d)) continue;
            foreach (var f in Directory.GetFiles(d, "*.json"))
            {
                try { JobRunner.CheckJobName(f); } catch (ArgumentException ex) { bad.Add(ex.Message); }
            }
        }
        Assert.True(bad.Count == 0, "jobs com sufixo de versao (um job = um ficheiro; o git guarda as versoes): " + string.Join(" | ", bad));
    }

    [Fact]
    public void NoJobPointsAtMutableOml()
    {
        var bad = new List<string>();
        foreach (var dir in Directory.GetDirectories(Path.Combine(Root, "tests"), "jobs*"))
            foreach (var path in Directory.GetFiles(dir, "*.json", SearchOption.AllDirectories))
                Check(System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(path)), path);
        Assert.True(bad.Count == 0, string.Join(Environment.NewLine, bad));

        void Check(System.Text.Json.Nodes.JsonNode? node, string path)
        {
            if (node is System.Text.Json.Nodes.JsonObject obj)
                foreach (var kv in obj)
                {
                    if (kv.Key is "base" or "producer" && kv.Value is System.Text.Json.Nodes.JsonValue value
                        && value.TryGetValue<string>(out var spec))
                    {
                        if (!JobSources.IsBindingName(spec) && !spec.StartsWith("job:", StringComparison.Ordinal))
                            try { JobSources.FixturePath(spec, Path.GetDirectoryName(path)!, kv.Key); }
                            catch (ArgumentException ex) { bad.Add(path + ": " + ex.Message); }
                    }
                    else Check(kv.Value, path);
                }
            else if (node is System.Text.Json.Nodes.JsonArray array)
                foreach (var item in array) Check(item, path);
        }
    }

    [Fact]
    public void EveryJobHasAValidMessageContract()
    {
        // Each job declares the Verify ids of the lane that runs it: the ODC folders against catalog/odc, the rest
        // against the O11 manifests (MessageExpectations.Lane in each build).
        foreach (var dir in Directory.GetDirectories(Path.Combine(Root, "tests"), "jobs*"))
            foreach (var path in Directory.GetFiles(dir, "*.json", SearchOption.AllDirectories))
                JobRunner.ValidateJob(path, IsOdcJob(path) ? "odc" : "o11");
    }

    private static bool IsOdcJob(string path)
    {
        var relative = Path.GetRelativePath(Path.Combine(Root, "tests"), path).Replace('\\', '/');
        // the coverage folders of every phase (jobs-coverage, jobs-coverage-f2...) keep the ODC jobs under odc/
        return relative.StartsWith("jobs-odc", StringComparison.Ordinal) || Regex.IsMatch(relative, @"^jobs-coverage[^/]*/odc/");
    }

    [Theory]
    [InlineData("tickets-01-data", true)]
    [InlineData("rest-consume-get", true)]
    [InlineData("osui-patterns-mobile", true)]
    [InlineData("rest-consume-api2", true)]
    [InlineData("virtual-game-store-all-sql-v2", false)]
    [InlineData("store_v3", false)]
    [InlineData("store (1)", false)]
    public void JobNameRuleAcceptsIntentAndRefusesVersions(string stem, bool ok)
    {
        var path = Path.Combine(Root, "tests", "jobs", stem + ".json");
        if (ok) JobRunner.CheckJobName(path);
        else Assert.Contains("version suffix", Assert.Throws<ArgumentException>(() => JobRunner.CheckJobName(path)).Message);
    }

    [Fact]
    public void GuideCommandsPointToTheDevBuild()
    {
        var guide = File.ReadAllText(Path.Combine(Root, "AGENTS.md"));
        Assert.DoesNotContain("bin/Release/net8.0/anvil.dll", guide);
        Assert.Contains(".local/cli", guide);
    }

    private static string FindRoot()
    {
        // a partir do assembly de testes, nao de AppContext.BaseDirectory: StudioAssemblies.Bind aponta o BaseDirectory para a pasta do Studio
        var dir = Path.GetDirectoryName(typeof(GuideTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
