using Anvil.Core;
using Anvil.Tests;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>The logic op's text form through a real ODC job (FlowApplyScenarios, linked into both test projects), on the
/// blank mobile fixture.</summary>
public sealed class FlowApplyOdcTests
{
    [Fact] public void ListMappingsWorkInTextAndJson() => Run(FlowApplyScenarios.ListMappingsWorkInTextAndJson);
    [Fact] public void JsonForEachRefusalsCarryIndividualCheckedPatches() => Run(FlowApplyScenarios.JsonForEachRefusalsCarryIndividualCheckedPatches);
    [Fact] public void JsonMappingValuesKeepTheirRelativeScope() => Run(FlowApplyScenarios.JsonMappingValuesKeepTheirRelativeScope);
    private const string Fixture = "tests/fixtures/odc/blank-mobile.oml";
    [Fact] public void PaginationSqlAndExceptionHandlersReadBackExactly() => Run(FlowApplyScenarios.PaginationSqlAndExceptionHandlersReadBackExactly);

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(FlowApplyOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static void Run(Action<string, string, string> scenario)
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "flow-apply-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        scenario(dir, Fixture, "odc");
    }

    [Fact] public void AnEditedTextWritesOnlyWhatChangedAndReadsBackAsTheText() => Run(FlowApplyScenarios.AnEditedTextWritesOnlyWhatChangedAndReadsBackAsTheText);
    [Fact] public void TheRulesRefuseTheTextOnceWithEveryProblem() => Run(FlowApplyScenarios.TheRulesRefuseTheTextOnceWithEveryProblem);
    [Fact] public void ATextWithoutKeyCreatesTheAction() => Run(FlowApplyScenarios.ATextWithoutKeyCreatesTheAction);
    [Fact] public void ThePacketExamplesApplyInOneJob() => Run(FlowApplyScenarios.ThePacketExamplesApplyInOneJob);
    [Fact] public void SeveralTextsAreCheckedTogetherAndANewCalleeComesFirst() => Run(FlowApplyScenarios.SeveralTextsAreCheckedTogetherAndANewCalleeComesFirst);
    [Fact] public void AServiceActionTextReadsBackWithoutTheStudioTemplate() => Run(FlowApplyScenarios.AServiceActionTextReadsBackWithoutTheStudioTemplate);
    [Fact] public void AnEditOfAnOlderReadIsMergedWithWhatChangedSince() => Run(FlowApplyScenarios.AnEditOfAnOlderReadIsMergedWithWhatChangedSince);
    [Fact] public void AnOlderReadThatBreaksARuleIsRefusedWithThePatchOfTheMergedText() => Run(FlowApplyScenarios.AnOlderReadThatBreaksARuleIsRefusedWithThePatchOfTheMergedText);
    [Fact] public void DataStatementsOfAnOlderReadAreMergedWithWhatChangedSince() => Run(FlowApplyScenarios.DataStatementsOfAnOlderReadAreMergedWithWhatChangedSince);
    [Fact] public void ATextOfAnActionNeedsTheReadItWasWrittenOn() => Run(FlowApplyScenarios.ATextOfAnActionNeedsTheReadItWasWrittenOn);
    [Fact] public void ARenameAMappingWouldReadAsAnAttributeIsRefused() => Run(FlowApplyScenarios.ARenameAMappingWouldReadAsAnAttributeIsRefused);
    [Fact] public void AListAssignedAcrossTypesReadsAsTheValueWritten() => Run(FlowApplyScenarios.AListAssignedAcrossTypesReadsAsTheValueWritten);
    [Fact] public void AListMappingThatReadsItsListsCurrentMapsTheItem() => Run(FlowApplyScenarios.AListMappingThatReadsItsListsCurrentMapsTheItem);
    [Fact] public void AMappingThePlatformKeepsInItsOwnFormIsListedAndOneThatSaysSomethingElseIsRefused() => Run(FlowApplyScenarios.AMappingThePlatformKeepsInItsOwnFormIsListedAndOneThatSaysSomethingElseIsRefused);
    [Fact] public void APlatformMappingThatLeavesAnAttributeEmptyIsRefusedWhateverItsNames() => Run(FlowApplyScenarios.APlatformMappingThatLeavesAnAttributeEmptyIsRefusedWhateverItsNames);
    [Fact] public void AnEditThatLeavesAnExistingCursorMappingAsItWasKeepsIt() => Run(FlowApplyScenarios.AnEditThatLeavesAnExistingCursorMappingAsItWasKeepsIt);
    [Fact] public void DataStatementsNeedTheirReadAndGiveTheNext() => Run(FlowApplyScenarios.DataStatementsNeedTheirReadAndGiveTheNext);

    // Screen, block and data actions born from their texts need a Reactive app with a layout (the blank one has no screen).
    private const string Reactive = "tests/fixtures/odc/insurance-reactive-r8.oml";
    private static void RunReactive(Action<string, string, string> scenario)
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "flow-apply-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        scenario(dir, Reactive, "odc");
    }
    [Fact] public void ScreenBlockAndDataActionsAreBornFromTheirTexts() => RunReactive(FlowApplyScenarios.ScreenBlockAndDataActionsAreBornFromTheirTexts);
    [Fact] public void TheDocumentAndTheFlowTextsOfOneJobBindAndFill() => RunReactive(FlowApplyScenarios.TheDocumentAndTheFlowTextsOfOneJobBindAndFill);
    [Fact] public void ThePacketScreenExampleAppliesInOneJob() => RunReactive(FlowApplyScenarios.ThePacketScreenExampleAppliesInOneJob);
    [Fact] public void TheActionsAnEventOrARefreshNamesAreWrittenFirst() => RunReactive(FlowApplyScenarios.TheActionsAnEventOrARefreshNamesAreWrittenFirst);
    [Fact] public void TheRulesBringCheckedPatchesThatWriteTheJob() => Run(FlowApplyScenarios.TheRulesBringCheckedPatchesThatWriteTheJob);
    [Fact] public void TheRowsOfAnAggregateAreT1AndTheRefusalBringsTheVerifyOfTheRest() => Run(FlowApplyScenarios.TheRowsOfAnAggregateAreT1AndTheRefusalBringsTheVerifyOfTheRest);
    [Fact] public void AValueOrAFieldMapIsAMappingWrittenAsThePlatformPrintsIt() => Run(FlowApplyScenarios.AValueOrAFieldMapIsAMappingWrittenAsThePlatformPrintsIt);
    [Fact] public void ANewJavaScriptMovesIntoItsOwnClientActionAndAnExistingOneStaysEditable() => Run(FlowApplyScenarios.ANewJavaScriptMovesIntoItsOwnClientActionAndAnExistingOneStaysEditable);
    // Corrections of the third junction (Corrigir 1).
    [Fact] public void TwoDataTextsOfOneJobOnTheCaptureKeepEachOther() => Run(FlowApplyScenarios.TwoDataTextsOfOneJobOnTheCaptureKeepEachOther);
    [Fact] public void ARawRenameAMappingWouldReadAsAnAttributeIsRefused() => Run(FlowApplyScenarios.ARawRenameAMappingWouldReadAsAnAttributeIsRefused);
    [Fact] public void AMappingFromACallsOutputIsTypedThroughTheAction() => Run(FlowApplyScenarios.AMappingFromACallsOutputIsTypedThroughTheAction);
    [Fact] public void AStudioRenameIsNotReadIntoAMappingAsTheSourcesAttribute() => Run(FlowApplyScenarios.AStudioRenameIsNotReadIntoAMappingAsTheSourcesAttribute);
    [Fact] public void TheT2PatchIntoAnEntityListNamesItsIdentifier() => Run(FlowApplyScenarios.TheT2PatchIntoAnEntityListNamesItsIdentifier);
    [Fact] public void AJavaScriptTheStudioRemovedAndTheDeliveryChangedIsWrittenAgain() => Run(FlowApplyScenarios.AJavaScriptTheStudioRemovedAndTheDeliveryChangedIsWrittenAgain);
    [Fact] public void TheMergeBatteryUndoesAndMergesAnExistingJavaScript() => Run(FlowApplyScenarios.TheMergeBatteryUndoesAndMergesAnExistingJavaScript);
    [Fact] public void ANodeParameterRenamedByTheTextKeepsItsArgument() => Run(FlowApplyScenarios.ANodeParameterRenamedByTheTextKeepsItsArgument);
    [Fact] public void AnExistingMappingIsEditedByItsText() => Run(FlowApplyScenarios.AnExistingMappingIsEditedByItsText);
    [Fact] public void ARecordLiteralIsWrittenParsedAndOnlyAsAnArgument() => Run(FlowApplyScenarios.ARecordLiteralIsWrittenParsedAndOnlyAsAnArgument);
    // Corrections of the third junction (Corrigir 2).
    [Fact] public void TwoLoopsOfOneTextArePatchedAndReadBackAsThePatch() => Run(FlowApplyScenarios.TwoLoopsOfOneTextArePatchedAndReadBackAsThePatch);
    [Fact] public void AnAttributeRenameAMappingWouldReadAsAnotherElementIsRefused() => Run(FlowApplyScenarios.AnAttributeRenameAMappingWouldReadAsAnotherElementIsRefused);
    [Fact] public void AMergeNeverPutsOneSidesValueUnderTheOthersName() => Run(FlowApplyScenarios.AMergeNeverPutsOneSidesValueUnderTheOthersName);
    [Fact] public void AValueThePlatformWouldRefuseIsRefusedInThePlan() => Run(FlowApplyScenarios.AValueThePlatformWouldRefuseIsRefusedInThePlan);
    // The 24.1 fixes (the owner rules and the round trip of the reviews).
    [Fact] public void TheJsonFormOfTheLogicOpIsJudgedByTheOwnersRules() => Run(FlowApplyScenarios.TheJsonFormOfTheLogicOpIsJudgedByTheOwnersRules);
    [Fact] public void AnAttributeRenamedInTheStudioIsNeitherAFixedPointNorMerged() => Run(FlowApplyScenarios.AnAttributeRenamedInTheStudioIsNeitherAFixedPointNorMerged);
    [Fact] public void TwoTextsOfOneOpTradeTheNamesOfTheirActions() => Run(FlowApplyScenarios.TwoTextsOfOneOpTradeTheNamesOfTheirActions);
    [Fact] public void AnHtmlEditAfterALogicOpOfTheSameScreenIsMergedWithIt() => RunReactive(FlowApplyScenarios.AnHtmlEditAfterALogicOpOfTheSameScreenIsMergedWithIt);
    // The re-check of the 24.1 fixes (two screens: the reactive app).
    [Fact] public void TheOwnersRulesJudgeWhatEveryFormWroteWhereItIsAtTheEnd() => RunReactive(FlowApplyScenarios.TheOwnersRulesJudgeWhatEveryFormWroteWhereItIsAtTheEnd);
}
