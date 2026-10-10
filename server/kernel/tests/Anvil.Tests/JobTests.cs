using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Cada job em tests/jobs e uma prova executavel: aplica-se headless sobre o seu fixture (campo "base"; "job:<nome>" aplica
/// esse job antes) e tem de satisfazer expectValid e declarar cada mensagem nova com id, elemento e motivo.
/// Precisa do Service Studio instalado (ANVIL_STUDIO_DIR ou a pasta Anvil 4516); sem ele os testes sao ignorados.
///
/// Proveniencia (2026-09-23): os jobs listados em tests/provenance-o11.json deixam &lt;job&gt;.result.json no diretorio de
/// trabalho com o carimbo JobProvenance (o mesmo da faixa ODC), para a descoberta os classificar como atuais ou
/// historicos. E um subconjunto declarado (o piloto de contratos partilhados), nao a suite inteira.
/// </summary>
public class JobTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", Environment.GetEnvironmentVariable("ANVIL_LANE") == "ss5" ? "lane-ss5" : "", "test-work");
    private static readonly HashSet<string> Stamped = LoadStamped();

    private static HashSet<string> LoadStamped()
    {
        var file = Path.Combine(Root, "tests", "provenance-o11.json");
        if (!File.Exists(file)) return new HashSet<string>(StringComparer.Ordinal);
        var list = JsonNode.Parse(File.ReadAllText(file))!["jobs"]?.AsArray().Select(j => j!.GetValue<string>()) ?? Enumerable.Empty<string>();
        return new HashSet<string>(list, StringComparer.Ordinal);
    }

    public static IEnumerable<object[]> Jobs()
    {
        var dir = Path.Combine(Root, "tests", "jobs");
        if (!Directory.Exists(dir)) yield break;
        foreach (var f in Directory.GetFiles(dir, "*.json").OrderBy(x => x)) yield return new object[] { Path.GetFileNameWithoutExtension(f) };
    }

    [Theory]
    [MemberData(nameof(Jobs))]
    public void JobAppliesAndVerifies(string jobName)
    {
        if (!StudioAvailable()) return;
        var jobPath = Path.Combine(Root, "tests", "jobs", jobName + ".json");
        var job = JsonNode.Parse(File.ReadAllText(jobPath))!.AsObject();
        var host = new ModelHost(Work);
        var outPath = Path.Combine(Work, jobName + ".oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, jobPath, outPath))!.AsObject();
        if (Stamped.Contains(jobName))
        {
            // Sem fixture de faixa no O11: a base declarada pelo job e a fixture (baseSha256); fixtureSha256 fica null.
            result["provenance"] = JobProvenance.Stamp("Anvil.Tests", jobPath, null);
            File.WriteAllText(Path.Combine(Work, jobName + ".result.json"), result.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        }
        var isValid = result["isValid"]?.GetValue<bool>() ?? result["IsValid"]?.GetValue<bool>() ?? false;
        var messages = result["messages"]?.GetValue<int>() ?? result["Messages"]?.GetValue<int>() ?? 0;
        var details = result["details"]?.AsArray().Select(x => x!.ToString()) ?? Enumerable.Empty<string>();
        Assert.Equal(job["expectValid"]?.GetValue<bool>() ?? true, isValid);
        var validation = result["validation"]!;
        Assert.Empty(validation["unexpected"]!.AsArray());
        Assert.Empty(validation["missingExpected"]!.AsArray());
        Assert.Empty(validation["ambiguous"]!.AsArray());
        Assert.True(result["accepted"]!.GetValue<bool>(), $"{jobName}: {result["policyMessages"]}");
        Assert.True(File.Exists(outPath) && new FileInfo(outPath).Length > 1000, $"{jobName}: OML de saida ausente");
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }

    private static string FindRoot()
    {
        // a partir do assembly de testes, nao de AppContext.BaseDirectory: StudioAssemblies.Bind aponta o BaseDirectory para a pasta do Studio
        var dir = Path.GetDirectoryName(typeof(JobTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
