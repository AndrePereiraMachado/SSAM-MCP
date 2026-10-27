using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
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
        DataTableNativeCases.AssertNativeUnchanged(plan, PrototypeFakes.Widgets(plan).Select(w => w.Node));
    }

    // The base the FarmaVirtual import is proven on (PrototypeBuilderTests: SSAM_PROTOTYPE_REPLAY), read only, copied first.
    // Round 5 (variant 2 of DataTableNativeCases.PrepareSpans, built in the Studio): MeusPedidos (colspan and rowspan left out),
    // GestaoProdutos (spans of 1) and GestaoPedidos (a colspan that explained its shorter header row: an empty <th> for the column it
    // covered) are native Tables whose cells span one column and one row, the reading a <table> and the fixed point.
    // ---- round 6: a data table the importer keeps as HTML elements and a List lays its body out as the table's row group ------

    [Fact]
    public void ADataTableThePrototypeKeepsAsHtmlElementsAndAListHasItsBodyAsTheTablesRowGroupAsTheHtmlOpWritesIt()
    {
        if (!PrototypeFakes.Studio()) return;
        NotNative();
    }

    // Every reason of TABLE_NOT_NATIVE (DataTableNativeCases.PrepareNotNative: an event, a condition, a computed attribute, a
    // different count, a colspan that explains nothing), with a native Table beside them in variant 1.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void NotNative()
    {
        foreach (var variant in new[] { 1, 2 })
        {
            var capture = PrototypeBuilderTests.Bundle("data-table-not-native-" + variant);
            DataTableNativeCases.PrepareNotNative(capture, variant);
            var (plan, _) = PrototypeFakes.Plan(capture);
            Assert.Empty(plan.Problems);
            DataTableNativeCases.AssertNotNative(capture, plan, PrototypeFakes.Widgets(plan).Select(w => (w.Node, w.Owner)), variant);
        }
    }

    // Round 6 (both variants of DataTableNativeCases.PrepareNotNative, built in the Studio over the Haiku_UI replay base with the
    // seams of production, DataTableNativeCases.RegisteredSeams): each table
    // that stays the old form reads back as a <table> of HTML elements whose <tbody list> carries the html op's attributes, the
    // native Table as the <table list> without a marker; in the DOM the runtime will publish the body of each old table is the
    // table's row group (RowGroupsLaidOut); the theme carries the native layout block once; the fixed point.
    // ---- round 7: what the import writes in the theme is said where the job says the theme rules it writes (M1 of review 6) --

    // ---- round 7: every attribute the importer writes is the prototype's value, quoted once (X1 of review 6) -----------------

    [Fact]
    public void EveryAttributeThePrototypeImporterWritesIsThePrototypesValueQuotedOnceInEveryWidget()
    {
        if (!PrototypeFakes.Studio()) return;
        AttributesQuotedOnce();
    }

    // FarmaVirtual (every kind of widget, its native Tables), its old-form tables whose <tbody list> carries a name, a role and a
    // data attribute, and the minimal capture whose <ul list> carries them.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private void AttributesQuotedOnce()
    {
        var farma = PrototypeBuilderTests.Bundle("attributes-farma");
        var (plan, _) = PrototypeFakes.Plan(farma);
        Assert.Empty(plan.Problems);
        Assert.True(DataTableNativeCases.AttributesAsThePrototypeWrites(output, farma, plan).All > 0);
        var bodies = PrototypeBuilderTests.Bundle("attributes-bodies");
        DataTableNativeCases.PrepareTableBodyAttributes(bodies);
        (plan, _) = PrototypeFakes.Plan(bodies);
        Assert.Empty(plan.Problems);
        Assert.True(DataTableNativeCases.AttributesAsThePrototypeWrites(output, bodies, plan).Lists >= 6);
        var minimal = PrototypeBuilderTests.Bundle("attributes-minimal", "minimal.capture.json");
        DataTableNativeCases.PrepareListAttributes(minimal);
        (plan, _) = PrototypeFakes.Plan(minimal);
        Assert.Empty(plan.Problems);
        Assert.True(DataTableNativeCases.AttributesAsThePrototypeWrites(output, minimal, plan).Lists >= 3);
    }

    // ---- round 7: the note of the native layout block stays true when the prototype marks elements itself (B2 of review 6) -----

    [Fact]
    public void WhenThePrototypeWritesMarkersOfTheEngineItselfTheImportSaysThemApartAndItsNoteStaysTrue()
    {
        if (!PrototypeFakes.Studio()) return;
        MarkersOfThePrototype();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void MarkersOfThePrototype()
    {
        foreach (var table in new[] { false, true })
        {
            var capture = PrototypeBuilderTests.Bundle("markers-of-the-prototype-" + table, "minimal.capture.json");
            var keys = DataTableNativeCases.PrepareMarkersOfThePrototype(capture, table);
            var (plan, _) = PrototypeFakes.Plan(capture);
            Assert.Empty(plan.Problems);
            DataTableNativeCases.MarkersOfThePrototypeSaid(output, plan, keys, table ? 1 : 0);
        }
    }
}
