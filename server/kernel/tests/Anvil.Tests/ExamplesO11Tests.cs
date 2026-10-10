using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Exemplos provados da faixa O11 (tests/jobs/examples): cada job e aplicado headless sobre o seu fixture, como em
/// <see cref="JobTests"/>, e tem de satisfazer expectValid e o contrato expectedMessages. A matriz de cobertura
/// (tests/jobs/examples/matriz.json, docs/COBERTURA-EXEMPLOS-O11.md) aponta para estes jobs e para os da suite: o teste
/// da matriz recusa job citado que nao existe e exemplo que a matriz nao cita, para o exemplo nunca virar conselho velho.
/// Precisa do Service Studio instalado; sem ele os jobs sao ignorados (a checagem da matriz roda sempre).
/// </summary>
public class ExamplesO11Tests
{
    private static readonly string Root = FindRoot();
    private static readonly string Dir = Path.Combine(Root, "tests", "jobs", "examples");
    private static readonly string Work = Path.Combine(Root, ".local", Environment.GetEnvironmentVariable("ANVIL_LANE") == "ss5" ? "lane-ss5" : "", "test-work", "examples");
    private const string Matrix = "matriz.json";

    public static IEnumerable<object[]> Examples()
    {
        if (!Directory.Exists(Dir)) yield break;
        foreach (var f in Directory.GetFiles(Dir, "*.json").OrderBy(x => x, StringComparer.Ordinal))
            if (!Path.GetFileName(f).Equals(Matrix, StringComparison.OrdinalIgnoreCase))
                yield return new object[] { Path.GetFileNameWithoutExtension(f) };
    }

    [Theory]
    [MemberData(nameof(Examples))]
    public void ExampleAppliesAndVerifies(string jobName)
    {
        if (!StudioAvailable()) return;
        var jobPath = Path.Combine(Dir, jobName + ".json");
        var job = JsonNode.Parse(File.ReadAllText(jobPath))!.AsObject();
        Assert.False(string.IsNullOrWhiteSpace(job["description"]?.GetValue<string>()), $"{jobName}: exemplo sem description");
        Directory.CreateDirectory(Work);
        var outPath = Path.Combine(Work, jobName + ".oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Work), null, jobPath, outPath))!.AsObject();
        var isValid = result["isValid"]?.GetValue<bool>() ?? result["IsValid"]?.GetValue<bool>() ?? false;
        Assert.Equal(job["expectValid"]?.GetValue<bool>() ?? true, isValid);
        var validation = result["validation"]!;
        Assert.Empty(validation["unexpected"]!.AsArray());
        Assert.Empty(validation["missingExpected"]!.AsArray());
        Assert.Empty(validation["ambiguous"]!.AsArray());
        Assert.True(result["accepted"]!.GetValue<bool>(), $"{jobName}: {result["policyMessages"]}");
        Assert.True(File.Exists(outPath) && new FileInfo(outPath).Length > 1000, $"{jobName}: OML de saida ausente");
    }

    /// <summary>A matriz e os arquivos andam juntos: cada entrada cita um job que existe (examples/ para os novos, a
    /// suite tests/jobs para os ja provados), cada exemplo aparece na matriz, e bloqueado traz o motivo.</summary>
    [Fact]
    public void MatrixAndExamplesAgree()
    {
        var path = Path.Combine(Dir, Matrix);
        Assert.True(File.Exists(path), "matriz.json ausente em tests/jobs/examples");
        var entries = JsonNode.Parse(File.ReadAllText(path))!["entries"]!.AsArray().Select(e => e!.AsObject()).ToList();
        var problems = new List<string>();
        var cited = new HashSet<string>(StringComparer.Ordinal);
        string[] kinds = ["widget", "pattern", "capability"], levels = ["minimal", "typical", "rich"], states = ["proven-existing", "new", "blocked"];
        foreach (var e in entries)
        {
            var id = e["id"]?.GetValue<string>() ?? "?";
            var status = e["status"]?.GetValue<string>();
            if (!kinds.Contains(e["kind"]?.GetValue<string>())) problems.Add($"{id}: kind invalido");
            if (!levels.Contains(e["level"]?.GetValue<string>())) problems.Add($"{id}: level invalido");
            if (!states.Contains(status)) problems.Add($"{id}: status invalido");
            var job = e["job"]?.GetValue<string>();
            if (status == "blocked")
            {
                if (string.IsNullOrWhiteSpace(e["notes"]?.GetValue<string>())) problems.Add($"{id}: bloqueado sem motivo em notes");
                continue;
            }
            if (string.IsNullOrWhiteSpace(job)) { problems.Add($"{id}: sem job"); continue; }
            var file = Path.Combine(Root, "tests", "jobs", job.Replace('/', Path.DirectorySeparatorChar) + ".json");
            if (!File.Exists(file)) problems.Add($"{id}: job '{job}' nao existe");
            if (status == "new" && !job.StartsWith("examples/", StringComparison.Ordinal)) problems.Add($"{id}: exemplo novo fora de examples/");
            if (status == "proven-existing" && job.StartsWith("examples/", StringComparison.Ordinal)) problems.Add($"{id}: proven-existing aponta para examples/");
            cited.Add(job);
        }
        foreach (var example in Examples().Select(x => (string)x[0]))
            if (!cited.Contains("examples/" + example)) problems.Add($"exemplo '{example}' nao aparece na matriz");
        Assert.True(problems.Count == 0, string.Join(Environment.NewLine, problems));
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }

    private static string FindRoot()
    {
        // a partir do assembly de testes, nao de AppContext.BaseDirectory: StudioAssemblies.Bind aponta o BaseDirectory para a pasta do Studio
        var dir = Path.GetDirectoryName(typeof(ExamplesO11Tests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
