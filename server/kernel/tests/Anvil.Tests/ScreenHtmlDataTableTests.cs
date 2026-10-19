using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>A data table is the native Table on the O11 lane (the owner's VpBookings bug of 2026-10-18): the document form
/// (ssam-html) and the prototype importer give one native Table of aligned columns, a card list stays a List, the reading gives
/// back the &lt;table&gt; and the fixed point holds. The compile and the import need the Service Studio.</summary>
public sealed class ScreenHtmlDataTableTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenHtmlDataTableTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "screen-html-data-table");

    [Fact]
    public void ADataTableIsTheNativeTableByItsShapeAndAListThatIsNoTableIsNot() => DataTableNativeCases.Shapes();

    [Fact]
    public void TheDocumentFormWritesADataTableAsTheNativeTableWithItsColumnsAlignedAndACardListStaysAList()
    {
        if (!PrototypeFakes.Studio()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        var dir = Path.Combine(Work, "document-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = DataTableNativeCases.Ops() }.ToJsonString());
        var outPath = Path.Combine(dir, "out.oml");
        var host = new ModelHost(dir);
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, outPath))!.AsObject();
        DataTableNativeCases.Compiled(output, host, outPath, result);
    }

    [Fact]
    public void WhatADocumentWritesOnThePartsOfADataTableIsTakenOrRefusedOnceWithItsPatch() => DataTableNativeCases.DocumentRules();

    [Fact]
    public void AnEditWritesANewDataTableAndTheOldFormRewrittenWithoutKeysBecomesTheNativeTable()
    {
        if (!PrototypeFakes.Studio()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        DataTableNativeCases.Edits(output, "reactive-ui.oml", null, Path.Combine(Work, "edits-" + Guid.NewGuid().ToString("N")[..8]));
    }

    [Fact]
    public void TwoHtmlOpsOfOneJobKeepBothChangesAndColspanAndAPartAttributeOfAnEditAreOneRefusalWhosePatchPasses()
    {
        if (!PrototypeFakes.Studio()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        DataTableNativeCases.EditRules(output, "reactive-ui.oml", null, Path.Combine(Work, "rules-" + Guid.NewGuid().ToString("N")[..8]));
    }

    [Fact]
    public void ACellOfANativeTableSpansOneColumnAndOneRowAndADocumentThatSpansIsOneRefusalWhosePatchPasses() => DataTableNativeCases.DocumentSpans();

    [Fact]
    public void ACellThatSpansIsOneRefusalWhosePatchPassesInTheDocumentAndEveryFormOfTheEditAndWhatTheReadingHasStays()
    {
        if (!PrototypeFakes.Studio()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        DataTableNativeCases.SpanRules(output, "reactive-ui.oml", null, Path.Combine(Work, "spans-" + Guid.NewGuid().ToString("N")[..8]));
    }

    [Fact]
    public void ADataTableTheImporterCannotMakeNativeIsSaidAndASectionClassJoinsItsRow()
    {
        if (!PrototypeFakes.Studio()) return;
        Degraded();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Degraded()
    {
        var capture = PrototypeBuilderTests.Bundle("data-table-degraded");
        DataTableNativeCases.PrepareDegraded(capture);
        var (plan, _) = PrototypeFakes.Plan(capture);
        DataTableNativeCases.AssertDegraded(plan, PrototypeFakes.Widgets(plan).Select(w => (w.Node, w.Spec, w.Owner)));
    }

    [Fact]
    public void ADataTableOfThePrototypeWhoseCellSpansIsTheNativeTableOfCellsOfOneColumnAndOneRowAndSaysWhatItLeftOut()
    {
        if (!PrototypeFakes.Studio()) return;
        Spans();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Spans()
    {
        foreach (var variant in new[] { 1, 2, 3 })
        {
            var capture = PrototypeBuilderTests.Bundle("data-table-spans-" + variant);
            DataTableNativeCases.PrepareSpans(capture, variant);
            var (plan, _) = PrototypeFakes.Plan(capture);
            Assert.Empty(plan.Problems);
            DataTableNativeCases.AssertSpans(capture, plan, PrototypeFakes.Widgets(plan).Select(w => (w.Node, w.Owner)), variant);
        }
    }

    [Fact]
    public void ThePrototypeImporterPlansEveryDataTableAsTheNativeTable()
    {
        if (!PrototypeFakes.Studio()) return;
        Plan();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Plan()
    {
        var (plan, _) = PrototypeFakes.Plan(PrototypeFakes.FarmaVirtual);
        Assert.Empty(plan.Problems);
        DataTableNativeCases.Prototype(PrototypeFakes.Widgets(plan).Select(w => (w.Node, w.Owner)));
    }

    // The base the FarmaVirtual import is proven on (PrototypeBuilderTests: SSAM_PROTOTYPE_REPLAY), read only, copied first.
    private static string? HaikuBase()
    {
        var root = Environment.GetEnvironmentVariable("SSAM_PROTOTYPE_REPLAY")
            ?? @"C:\Users\andre\AppData\Local\Temp\claude\C--Users-andre-SSAM-Hybrid-integracao-wt-ui-mockup\a67c1e7c-769c-40b3-8471-cccb151c5834\scratchpad\replay";
        var path = Path.Combine(root, "captures", "Haiku_UI-20261010202559.oml");
        return File.Exists(path) ? path : null;
    }

    [Fact]
    public void ThePrototypeImporterBuildsEachDataTableAsTheNativeTableAndItsReadingIsATable()
    {
        if (!PrototypeFakes.Studio()) return;
        if (HaikuBase() is not { } baseOml) { output.WriteLine("skipped: no Haiku_UI replay base (SSAM_PROTOTYPE_REPLAY)"); return; }
        Import(baseOml);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void Import(string baseOml)
    {
        var capture = PrototypeBuilderTests.Bundle("data-table");
        var result = PrototypeBuilderTests.Run("data-table", baseOml, new JsonArray(PrototypeBuilderTests.PrototypeOp(capture)), out var candidate);
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString()[..Math.Min(4000, result.ToJsonString().Length)]);
        var builder = result["results"]!.AsArray().OfType<JsonObject>().Single(r => r["op"]?.ToString() == "prototype")["result"]!["prototype"]!["builder"]!;
        Assert.Empty(builder["problems"]!.AsArray());
        var host = new ModelHost(Path.Combine(Work, "import-read"));
        var bytes = File.ReadAllBytes(candidate);
        foreach (var (screen, columns) in new[] { ("MeusPedidos", 6), ("GestaoProdutos", 7), ("GestaoPedidos", 7) })
        {
            var text = host.HtmlRead(bytes, "MobileScreen:" + screen, withKeys: false)["documents"]![0]!["html"]!.ToString();
            var doc = Anvil.Reading.ScreenHtml.Parse(text);
            var table = Assert.Single(DataTableNativeCases.Elements(doc), n => n.Tag == "table");
            Assert.NotNull(table.Get("list"));
            Assert.Equal(columns, DataTableNativeCases.Elements(table).Count(n => n.Tag == "th"));
            Assert.Equal(columns, DataTableNativeCases.Elements(table).Count(n => n.Tag == "td"));
            Assert.DoesNotContain(DataTableNativeCases.Elements(doc), n => n.Tag is "tbody" or "tr" && n.Get("list") != null);
            output.WriteLine(screen + ": " + text.Length + " chars, native table of " + columns + " columns");
        }
        var check = host.HtmlCheck(bytes)["documents"]!.AsArray().Where(d => d!["root"]!.ToString() is "MeusPedidos" or "GestaoProdutos" or "GestaoPedidos").ToList();
        Assert.Equal(3, check.Count);
        Assert.All(check, d => Assert.Equal(0, d!["ops"]!.GetValue<int>()));
    }

    [Fact]
    public void ThePrototypeImporterBuildsADataTableWhoseCellsSpannedAsTheNativeTableOfCellsOfOneColumnAndOneRow()
    {
        if (!PrototypeFakes.Studio()) return;
        if (HaikuBase() is not { } baseOml) { output.WriteLine("skipped: no Haiku_UI replay base (SSAM_PROTOTYPE_REPLAY)"); return; }
        ImportSpans(baseOml);
    }

    // Round 5 (variant 2 of DataTableNativeCases.PrepareSpans, built in the Studio): MeusPedidos (colspan and rowspan left out),
    // GestaoProdutos (spans of 1) and GestaoPedidos (a colspan that explained its shorter header row: an empty <th> for the column it
    // covered) are native Tables whose cells span one column and one row, the reading a <table> and the fixed point.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private void ImportSpans(string baseOml)
    {
        var capture = PrototypeBuilderTests.Bundle("data-table-spans-build");
        DataTableNativeCases.PrepareSpans(capture, 2);
        var result = PrototypeBuilderTests.Run("data-table-spans", baseOml, new JsonArray(PrototypeBuilderTests.PrototypeOp(capture)), out var candidate);
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString()[..Math.Min(4000, result.ToJsonString().Length)]);
        var builder = result["results"]!.AsArray().OfType<JsonObject>().Single(r => r["op"]?.ToString() == "prototype")["result"]!["prototype"]!["builder"]!;
        Assert.Empty(builder["problems"]!.AsArray());
        var host = new ModelHost(Path.Combine(Work, "import-spans-read"));
        var bytes = File.ReadAllBytes(candidate);
        foreach (var (screen, columns) in new[] { ("MeusPedidos", 6), ("GestaoProdutos", 7), ("GestaoPedidos", 7) })
        {
            var text = host.HtmlRead(bytes, "MobileScreen:" + screen, withKeys: false)["documents"]![0]!["html"]!.ToString();
            var table = Assert.Single(DataTableNativeCases.Elements(Anvil.Reading.ScreenHtml.Parse(text)), n => n.Tag == "table");
            Assert.NotNull(table.Get("list"));
            var headers = DataTableNativeCases.Elements(table).Where(n => n.Tag == "th").ToList();
            Assert.Equal(columns, headers.Count);
            Assert.Equal(columns, DataTableNativeCases.Elements(table).Count(n => n.Tag == "td"));
            Assert.DoesNotContain(DataTableNativeCases.Elements(table), n => n.Tag is "th" or "td"
                && n.Attributes.Any(a => a.Key.ToLowerInvariant() is "colspan" or "rowspan" && a.Value.Trim() != "1"));
            if (screen == "GestaoPedidos") Assert.Empty(headers[^1].Children);
            output.WriteLine(screen + ": native table of " + columns + " columns, no cell spans");
        }
        var check = host.HtmlCheck(bytes)["documents"]!.AsArray().Where(d => d!["root"]!.ToString() is "MeusPedidos" or "GestaoProdutos" or "GestaoPedidos").ToList();
        Assert.Equal(3, check.Count);
        Assert.All(check, d => Assert.Equal(0, d!["ops"]!.GetValue<int>()));
    }
}
