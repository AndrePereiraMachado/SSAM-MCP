using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Plano, item 17 (fidelidade do merge): um job que instancia um bloco cuja referencia e OCULTA no fixture tem de (a) desocultar
/// a referencia, e (b) sobreviver ao merge de 3 vias automatico sem perder objetos nem ganhar erros. Reproduz headless, com o
/// mesmo MatchTree da bridge, o incidente das 08:42 (2 erros e 56 objetos perdidos no Headless_UI).
/// </summary>
public class MergeFidelityTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "test-work");

    [Fact]
    public void HiddenReferenceBlockSurvivesTheAutomaticThreeWayMerge()
    {
        if (!StudioAvailable()) return;
        var host = new ModelHost(Work);
        var basePath = Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml");
        var jobPath = Path.Combine(Root, "tests", "jobs", "hidden-reference-block.json");
        var baseBytes = File.ReadAllBytes(basePath);

        // precondicao: no fixture a referencia ao bloco e oculta (dependencia indireta); senao o teste nao prova nada
        var refs = ModelHost.HiddenReferences(baseBytes, "IMobileBlockSignature");
        var hiddenNames = refs.Where(kv => kv.Value == true).Select(kv => kv.Key).OrderBy(x => x).ToList();
        Assert.True(refs.TryGetValue("MouseEvents", out var hiddenBefore) && hiddenBefore == true,
            $"o fixture reactive-ui.oml devia ter MouseEvents como referencia oculta (Hidden={(refs.TryGetValue("MouseEvents", out var h) ? h : null)}); blocos ocultos no fixture: {string.Join(", ", hiddenNames.Take(20))} (de {refs.Count})");

        var outPath = Path.Combine(Work, "hidden-reference-block.oml");
        var r = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, outPath))!.AsObject();
        Assert.True(r["isValid"]!.GetValue<bool>(), "job invalido: " + string.Join(" | ", r["details"]!.AsArray().Select(x => x!.ToString())));
        // o get devolve as propriedades da interface do Model API (sem Hidden): ler o estado da referencia no OML de saida
        var after = ModelHost.HiddenReferences(File.ReadAllBytes(outPath), "IMobileBlockSignature");
        Assert.True(after.TryGetValue("MouseEvents", out var hiddenAfter) && hiddenAfter == false,
            $"a referencia MouseEvents devia ter sido desocultada ao ligar SourceBlock (Hidden={(after.TryGetValue("MouseEvents", out var ha) ? ha : null)})");

        var probe = MergeProbe.ThreeWay(host, baseBytes, File.ReadAllBytes(outPath));
        Assert.False(probe.HasConflicts, "merge com conflitos");
        Assert.Equal(0, probe.Errors);
        Assert.True(probe.LocalObjects == probe.ForeignObjects,
            $"o merge perdeu objetos: local {probe.LocalObjects} vs foreign {probe.ForeignObjects}: {string.Join(" | ", probe.Details)}");
    }

    [Fact]
    public void TicketsHelpersMergeCreatesSevenMessagesAndFixesTwo()
    {
        if (!StudioAvailable()) return;
        var host = new ModelHost(Work);
        var job = Path.Combine(Root, "tests", "jobs", "tickets-02-helpers.json");
        var basePath = JobRunner.ResolveBase(host, job);
        var output = Path.Combine(Work, "tickets-helper-delta.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, job, output))!;
        Assert.True(applied["accepted"]!.GetValue<bool>());
        var probe = MergeProbe.ThreeWay(host, File.ReadAllBytes(basePath), File.ReadAllBytes(output));
        Assert.True(probe.LocalIsValid);
        Assert.Equal(7, probe.Delta.New.Count);
        Assert.Equal(2, probe.Delta.Fixed.Count);
        Assert.Equal(4, probe.Delta.Preexisting.Count);
        Assert.All(probe.Delta.Fixed, m => Assert.Equal("UnusedElement", m.Id));
        Assert.Equal(5, probe.Delta.New.Count - probe.Delta.Fixed.Count);
        Assert.Equal(applied["validation"]!["new"]!.AsArray().Select(m => m!["key"]!.GetValue<string>()).OrderBy(x => x),
            probe.Delta.New.Select(m => m.Key).OrderBy(x => x));
    }

    [Fact]
    public void NoChangeMergeKeepsAllMobileMessagesPreexisting()
    {
        if (!StudioAvailable()) return;
        var host = new ModelHost(Work);
        var bytes = File.ReadAllBytes(Path.Combine(Root, "tests", "fixtures", "mobile-ui.oml"));
        var probe = MergeProbe.ThreeWay(host, bytes, bytes);
        Assert.Empty(probe.Delta.New);
        Assert.Empty(probe.Delta.Fixed);
        Assert.Equal(6, probe.Delta.Preexisting.Count);
        Assert.Equal(0, probe.Errors);
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(MergeFidelityTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
