using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>A data table is the native Table on the ODC lane (the owner's VpBookings bug of 2026-10-18), over the fixture
/// insurance-reactive-r8: the same document as the O11 lane gives two native Tables of seven aligned columns, the card list a
/// List, the reading the &lt;table&gt; and the fixed point. The prototype importer plans FarmaVirtual's tables as the native
/// Table on ODC too. Needs the ODC Studio.</summary>
public sealed class ScreenHtmlDataTableOdcTests(ITestOutputHelper output)
{
    private const string Fixture = "tests/fixtures/odc/insurance-reactive-r8.oml";

    [Fact]
    public void ADataTableIsTheNativeTableByItsShapeAndAListThatIsNoTableIsNot() => DataTableNativeCases.Shapes();

    [Fact]
    public void TheDocumentFormWritesADataTableAsTheNativeTableWithItsColumnsAlignedAndACardListStaysAList()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "screen-html-data-table", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject
        {
            ["base"] = Fixture,
            ["expectedMessages"] = new JsonArray(new JsonObject { ["id"] = "AnonymousAccess_NoPermissions", ["all"] = true, ["why"] = "a test screen without a role" }),
            ["ops"] = DataTableNativeCases.Ops(),
        }.ToJsonString());
        var outPath = Path.Combine(dir, "out.oml");
        var host = new ModelHost(Path.Combine(dir, "work"));
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, outPath))!.AsObject();
        DataTableNativeCases.Compiled(output, host, outPath, result);
    }

    [Fact]
    public void WhatADocumentWritesOnThePartsOfADataTableIsTakenOrRefusedOnceWithItsPatch() => DataTableNativeCases.DocumentRules();

    [Fact]
    public void AnEditWritesANewDataTableAndTheOldFormRewrittenWithoutKeysBecomesTheNativeTable()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        DataTableNativeCases.Edits(output, Fixture,
            new JsonArray(new JsonObject { ["id"] = "AnonymousAccess_NoPermissions", ["all"] = true, ["why"] = "a test screen without a role" }),
            Path.Combine(FindRoot(), ".local", "lane-odc", "screen-html-data-table", "edits-" + Guid.NewGuid().ToString("N")[..8]));
    }

    [Fact]
    public void TwoHtmlOpsOfOneJobKeepBothChangesAndColspanAndAPartAttributeOfAnEditAreOneRefusalWhosePatchPasses()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        DataTableNativeCases.EditRules(output, Fixture,
            new JsonArray(new JsonObject { ["id"] = "AnonymousAccess_NoPermissions", ["all"] = true, ["why"] = "a test screen without a role" }),
            Path.Combine(FindRoot(), ".local", "lane-odc", "screen-html-data-table", "rules-" + Guid.NewGuid().ToString("N")[..8]));
    }

    [Fact]
    public void ACellOfANativeTableSpansOneColumnAndOneRowAndADocumentThatSpansIsOneRefusalWhosePatchPasses() => DataTableNativeCases.DocumentSpans();

    [Fact]
    public void ACellThatSpansIsOneRefusalWhosePatchPassesInTheDocumentAndEveryFormOfTheEditAndWhatTheReadingHasStays()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        DataTableNativeCases.SpanRules(output, Fixture,
            new JsonArray(new JsonObject { ["id"] = "AnonymousAccess_NoPermissions", ["all"] = true, ["why"] = "a test screen without a role" }),
            Path.Combine(FindRoot(), ".local", "lane-odc", "screen-html-data-table", "spans-" + Guid.NewGuid().ToString("N")[..8]));
    }

    [Fact]
    public void ThePrototypeImporterPlansEveryDataTableAsTheNativeTable()
    {
        if (!StudioAvailable()) return;
        var plan = PrototypeExpanderOdcTests.PlanFarmaVirtual();
        Assert.Empty(plan.Problems);
        DataTableNativeCases.Prototype(plan.Steps.Select(s => s.Widgets).OfType<PrototypeWidgetsJob>().SelectMany(j => Walk(j.Roots).Select(n => (n, j.OwnerName))));
        DataTableNativeCases.AssertNativeUnchanged(plan, plan.Steps.Select(s => s.Widgets).OfType<PrototypeWidgetsJob>().SelectMany(j => Walk(j.Roots)));
    }

    [Fact]
    public void ADataTableOfThePrototypeWhoseCellSpansIsTheNativeTableOfCellsOfOneColumnAndOneRowAndSaysWhatItLeftOut()
    {
        if (!StudioAvailable()) return;
        foreach (var variant in new[] { 1, 2, 3 })
        {
            var capture = DataTableNativeCases.FarmaVirtualCopy(Path.Combine(FindRoot(), "tests", "Anvil.Tests", "Fixtures", "prototype"),
                Path.Combine(FindRoot(), ".local", "lane-odc", "screen-html-data-table", "spans-" + variant + "-" + Guid.NewGuid().ToString("N")[..8]));
            DataTableNativeCases.PrepareSpans(capture, variant);
            var plan = PrototypeExpanderOdcTests.PlanCapture(capture);
            Assert.Empty(plan.Problems);
            DataTableNativeCases.AssertSpans(capture, plan, plan.Steps.Select(s => s.Widgets).OfType<PrototypeWidgetsJob>().SelectMany(j => Walk(j.Roots).Select(n => (n, j.OwnerName))), variant);
        }
    }

    // ---- round 6: a data table the importer keeps as HTML elements and a List lays its body out as the table's row group ------

    [Fact]
    public void ADataTableThePrototypeKeepsAsHtmlElementsAndAListHasItsBodyAsTheTablesRowGroupAsTheHtmlOpWritesIt()
    {
        if (!StudioAvailable()) return;
        foreach (var variant in new[] { 1, 2 })
        {
            var capture = DataTableNativeCases.FarmaVirtualCopy(Path.Combine(FindRoot(), "tests", "Anvil.Tests", "Fixtures", "prototype"),
                Path.Combine(FindRoot(), ".local", "lane-odc", "screen-html-data-table", "not-native-" + variant + "-" + Guid.NewGuid().ToString("N")[..8]));
            DataTableNativeCases.PrepareNotNative(capture, variant);
            var plan = PrototypeExpanderOdcTests.PlanCapture(capture);
            Assert.Empty(plan.Problems);
            DataTableNativeCases.AssertNotNative(capture, plan, plan.Steps.Select(s => s.Widgets).OfType<PrototypeWidgetsJob>().SelectMany(j => Walk(j.Roots).Select(n => (n, j.OwnerName))), variant);
        }
    }

    // ---- round 7: what the import writes in the theme is said where the job says the theme rules it writes (M1 of review 6) --

    // ---- round 7: every attribute the importer writes is the prototype's value, quoted once (X1 of review 6) -----------------

    [Fact]
    public void EveryAttributeThePrototypeImporterWritesIsThePrototypesValueQuotedOnceInEveryWidget()
    {
        if (!StudioAvailable()) return;
        var work = Path.Combine(FindRoot(), ".local", "lane-odc", "screen-html-data-table", "attributes-" + Guid.NewGuid().ToString("N")[..8]);
        var fixtures = Path.Combine(FindRoot(), "tests", "Anvil.Tests", "Fixtures", "prototype");
        var farma = DataTableNativeCases.FarmaVirtualCopy(fixtures, Path.Combine(work, "farma"));
        var plan = PrototypeExpanderOdcTests.PlanCapture(farma);
        Assert.Empty(plan.Problems);
        Assert.True(DataTableNativeCases.AttributesAsThePrototypeWrites(output, farma, plan).All > 0);
        var bodies = DataTableNativeCases.FarmaVirtualCopy(fixtures, Path.Combine(work, "bodies"));
        DataTableNativeCases.PrepareTableBodyAttributes(bodies);
        plan = PrototypeExpanderOdcTests.PlanCapture(bodies);
        Assert.Empty(plan.Problems);
        Assert.True(DataTableNativeCases.AttributesAsThePrototypeWrites(output, bodies, plan).Lists >= 6);
        var minimal = Path.Combine(Path.GetDirectoryName(DataTableNativeCases.FarmaVirtualCopy(fixtures, Path.Combine(work, "minimal")))!, "minimal.capture.json");
        DataTableNativeCases.PrepareListAttributes(minimal);
        plan = PrototypeExpanderOdcTests.PlanCapture(minimal);
        Assert.Empty(plan.Problems);
        Assert.True(DataTableNativeCases.AttributesAsThePrototypeWrites(output, minimal, plan).Lists >= 3);
    }

    // ---- round 7: the note of the native layout block stays true when the prototype marks elements itself (B2 of review 6) -----

    [Fact]
    public void WhenThePrototypeWritesMarkersOfTheEngineItselfTheImportSaysThemApartAndItsNoteStaysTrue()
    {
        if (!StudioAvailable()) return;
        foreach (var table in new[] { false, true })
        {
            var work = Path.Combine(FindRoot(), ".local", "lane-odc", "screen-html-data-table", "markers-" + table + "-" + Guid.NewGuid().ToString("N")[..8]);
            var farma = DataTableNativeCases.FarmaVirtualCopy(Path.Combine(FindRoot(), "tests", "Anvil.Tests", "Fixtures", "prototype"), work);
            var capture = Path.Combine(Path.GetDirectoryName(farma)!, "minimal.capture.json");
            var keys = DataTableNativeCases.PrepareMarkersOfThePrototype(capture, table);
            var plan = PrototypeExpanderOdcTests.PlanCapture(capture);
            Assert.Empty(plan.Problems);
            DataTableNativeCases.MarkersOfThePrototypeSaid(output, plan, keys, table ? 1 : 0);
        }
    }

    private static IEnumerable<WidgetNode> Walk(IEnumerable<WidgetNode> roots)
    {
        foreach (var node in roots)
        {
            yield return node;
            foreach (var inner in Walk(node.Children.Concat(node.Else ?? []))) yield return inner;
        }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ScreenHtmlDataTableOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }
}
