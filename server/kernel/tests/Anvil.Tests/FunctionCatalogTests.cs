using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// O catalogo de funcoes built-in e lido do Studio instalado; o JSON do repo tem de ser identico (senao deriva e ensina
/// errado). A checagem de expressoes tem de apontar o no (Label) e sugerir a funcao certa. E o mesmo job aplicado varias
/// vezes tem de dar o mesmo modulo: velocidade so vale se for deterministica.
/// </summary>
public class FunctionCatalogTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "test-work");

    [Fact]
    public void CatalogInRepoMatchesTheStudio()
    {
        if (!StudioAvailable()) return;
        Assert.True(Directory.Exists(Path.Combine(Root, "catalog")), $"raiz do repo nao encontrada: Root={Root} BaseDirectory={AppContext.BaseDirectory} cwd={Directory.GetCurrentDirectory()}");
        var file = Path.Combine(Root, "catalog", $"functions-{FunctionCatalog.StudioVersion}.json");
        Assert.True(File.Exists(file), $"catalog/functions-{FunctionCatalog.StudioVersion}.json ausente: gere com `anvil functions --out catalog/functions-<ver>.json --docs docs/functions.md`");
        var repo = File.ReadAllText(file!).Replace("\r\n", "\n").TrimEnd();
        var live = FunctionCatalog.ToJson().Replace("\r\n", "\n").TrimEnd();
        Assert.True(repo == live, $"{Path.GetFileName(file)} difere do Studio instalado ({FunctionCatalog.StudioVersion}, {FunctionCatalog.All.Count} funcoes): regenere");
        Assert.True(FunctionCatalog.All.Count > 100, "catalogo suspeito: menos de 100 funcoes");
    }

    [Fact]
    public void AliasTargetsExist()
    {
        if (!StudioAvailable()) return;
        var missing = FunctionCatalog.Aliases.SelectMany(a => a.Value).Where(t => !FunctionCatalog.Names.Contains(t)).Distinct().ToList();
        Assert.True(missing.Count == 0, "alvos de alias que nao existem no Studio: " + string.Join(", ", missing));
    }

    [Fact]
    public void UnknownFunctionGetsAHintWithClosestNamesAndTheNodeLabel()
    {
        if (!StudioAvailable()) return;
        var host = new ModelHost(Work);
        var jobPath = Path.Combine(Root, "tests", "jobs-negative", "unknown-function.json");
        var basePath = Path.Combine(Root, "tests", "fixtures", "blank-service.oml");
        var r = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, Path.Combine(Work, "unknown-function.oml")))!.AsObject();
        var details = r["details"]!.AsArray().Select(x => x!.ToString()).ToList();
        Assert.False(r["isValid"]!.GetValue<bool>(), "o job negativo tinha de ser invalido");
        var hint = details.FirstOrDefault(d => d.StartsWith("Hint UnknownFunction: 'Right('", StringComparison.Ordinal));
        Assert.True(hint != null, "sem Hint UnknownFunction para Right(: " + string.Join(" | ", details));
        Assert.Contains("Substr", hint!);
        Assert.Contains("CalculaCauda (AssignNode)", hint);
        Assert.True(details.Any(d => d.StartsWith("Error", StringComparison.Ordinal) && d.Contains("CalculaCauda (AssignNode)")),
            "o erro do Verify nao mostra o Label do Assign: " + string.Join(" | ", details));
        Assert.DoesNotContain(details, d => d.Contains("'Substr('") || d.Contains("'Length('"));
    }

    [Fact]
    public void FiveRunsOfTheSameJobGiveTheSameModule()
    {
        if (!StudioAvailable()) return;
        var host = new ModelHost(Work);
        var jobPath = Path.Combine(Root, "tests", "jobs", "service-action.json");
        var basePath = Path.Combine(Root, "tests", "fixtures", "blank-service.oml");
        var runs = new List<string>();
        var heaps = new List<long>();
        for (var i = 0; i < 5; i++)
        {
            var outPath = Path.Combine(Work, $"determinism-{i}.oml");
            var r = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, outPath))!.AsObject();
            var snap = host.Inspect(outPath);
            // Sample cita ObjectKeys (identidade) e TopObjectTypes e um top-15 com desempate por travessia: ficam fora da assinatura
            var validation = new { snap.Validation.Total, snap.Validation.ByType };
            runs.Add(JsonSerializer.Serialize(new { objects = r["objects"], isValid = r["isValid"], messages = r["messages"], details = r["details"], snap.Objects, validation }));
            // item 01a: o que cada run libertou (segunda raiz de memoria) e nenhum modulo retido no registo do Studio
            var released = r["released"]!.AsObject();
            Assert.True(released["undoHistory"]?.GetValue<int>() == 1, "historico de undo nao limpo: " + released.ToJsonString());
            Assert.True((released["aggregator"]?.GetValue<int>() ?? 0) >= 1 && released["close"]?.GetValue<int>() == 1 && (released["locks"]?.GetValue<int>() ?? 0) >= 1, "release incompleto: " + released.ToJsonString());
            Assert.Equal(0, ModelHost.LoadedModules().Count);
            GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
            heaps.Add(GC.GetTotalMemory(true) >> 20);
        }
        Assert.True(runs.Distinct().Count() == 1, "execucoes diferentes do mesmo job: " + string.Join("\n", runs.Distinct()));
        Assert.True(heaps[^1] - heaps[0] < 16, $"heap apos GC cresceu {heaps[^1] - heaps[0]} MB em 4 runs ({string.Join(", ", heaps)}): fuga por pedido");
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }

    private static string FindRoot()
    {
        // a partir do assembly de testes, nao de AppContext.BaseDirectory: StudioAssemblies.Bind aponta o BaseDirectory para a pasta do Studio
        var dir = Path.GetDirectoryName(typeof(FunctionCatalogTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
