using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>The logic op's text form through a real O11 job (FlowApplyScenarios, linked into both test projects), on the
/// blank service fixture; the kernel's textSha is the facade's (module-flow.test.mjs pins the same value).</summary>
public sealed class FlowApplyTests
{
    private const string Fixture = "blank-service.oml";
    [Fact] public void PaginationSqlAndExceptionHandlersReadBackExactly() => Run(FlowApplyScenarios.PaginationSqlAndExceptionHandlersReadBackExactly);

    private static string Scratch()
    {
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "flow-apply-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir); return dir;
    }

    private static void Run(Action<string, string, string> scenario)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        scenario(Scratch(), Fixture, "o11");
    }

    [Fact] public void AnEditedTextWritesOnlyWhatChangedAndReadsBackAsTheText() => Run(FlowApplyScenarios.AnEditedTextWritesOnlyWhatChangedAndReadsBackAsTheText);
    [Fact] public void TheRulesRefuseTheTextOnceWithEveryProblem() => Run(FlowApplyScenarios.TheRulesRefuseTheTextOnceWithEveryProblem);
    [Fact] public void ListMappingsWorkInTextAndJson() => Run(FlowApplyScenarios.ListMappingsWorkInTextAndJson);
    [Fact] public void JsonForEachRefusalsCarryIndividualCheckedPatches() => Run(FlowApplyScenarios.JsonForEachRefusalsCarryIndividualCheckedPatches);
    [Fact] public void JsonMappingValuesKeepTheirRelativeScope() => Run(FlowApplyScenarios.JsonMappingValuesKeepTheirRelativeScope);
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

    // Screen, block and data actions born from their texts need a Reactive module (the blank service has no screen).
    private const string Reactive = "reactive-ui.oml";
    private static void RunReactive(Action<string, string, string> scenario)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        scenario(Scratch(), Reactive, "o11");
    }
    [Fact] public void ScreenBlockAndDataActionsAreBornFromTheirTexts() => RunReactive(FlowApplyScenarios.ScreenBlockAndDataActionsAreBornFromTheirTexts);
    [Fact] public void TheDocumentAndTheFlowTextsOfOneJobBindAndFill() => RunReactive(FlowApplyScenarios.TheDocumentAndTheFlowTextsOfOneJobBindAndFill);
    [Fact] public void ThePacketScreenExampleAppliesInOneJob() => RunReactive(FlowApplyScenarios.ThePacketScreenExampleAppliesInOneJob);
    [Fact] public void TheActionsAnEventOrARefreshNamesAreWrittenFirst() => RunReactive(FlowApplyScenarios.TheActionsAnEventOrARefreshNamesAreWrittenFirst);

    [Fact]
    public void ATraditionalOwnerIsNotWrittenByText()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        FlowApplyScenarios.ATraditionalOwnerIsNotWrittenByText(Scratch(), "traditional-ui.oml", "o11");
    }
    [Fact] public void TheRulesBringCheckedPatchesThatWriteTheJob() => Run(FlowApplyScenarios.TheRulesBringCheckedPatchesThatWriteTheJob);
    [Fact] public void TheRowsOfAnAggregateAreT1AndTheRefusalBringsTheVerifyOfTheRest() => Run(FlowApplyScenarios.TheRowsOfAnAggregateAreT1AndTheRefusalBringsTheVerifyOfTheRest);
    [Fact] public void AValueOrAFieldMapIsAMappingWrittenAsThePlatformPrintsIt() => Run(FlowApplyScenarios.AValueOrAFieldMapIsAMappingWrittenAsThePlatformPrintsIt);
    // A client action needs a module with client logic: the mobile fixture (the blank one is a service module).
    [Fact] public void ANewJavaScriptMovesIntoItsOwnClientActionAndAnExistingOneStaysEditable()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        FlowApplyScenarios.ANewJavaScriptMovesIntoItsOwnClientActionAndAnExistingOneStaysEditable(Scratch(), "mobile-ui.oml", "o11");
    }

    // A screen with screen actions: the reactive fixture's Login.
    [Fact]
    public void AScriptMovedOutOfAScreenActionTakesANameNoActionOrScreenHas()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        FlowApplyScenarios.AScriptMovedOutOfAScreenActionTakesANameNoActionOrScreenHas(Scratch(), "reactive-ui.oml", "o11");
    }

    // Corrections of the third junction (Corrigir 1).
    [Fact] public void TwoDataTextsOfOneJobOnTheCaptureKeepEachOther() => Run(FlowApplyScenarios.TwoDataTextsOfOneJobOnTheCaptureKeepEachOther);
    [Fact] public void ARawRenameAMappingWouldReadAsAnAttributeIsRefused() => Run(FlowApplyScenarios.ARawRenameAMappingWouldReadAsAnAttributeIsRefused);
    [Fact] public void AMappingFromACallsOutputIsTypedThroughTheAction() => Run(FlowApplyScenarios.AMappingFromACallsOutputIsTypedThroughTheAction);
    [Fact] public void AStudioRenameIsNotReadIntoAMappingAsTheSourcesAttribute() => Run(FlowApplyScenarios.AStudioRenameIsNotReadIntoAMappingAsTheSourcesAttribute);
    [Fact] public void TheT2PatchIntoAnEntityListNamesItsIdentifier() => Run(FlowApplyScenarios.TheT2PatchIntoAnEntityListNamesItsIdentifier);
    [Fact] public void AnExistingMappingIsEditedByItsText() => Run(FlowApplyScenarios.AnExistingMappingIsEditedByItsText);
    private static void RunMobile(Action<string, string, string> scenario)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        scenario(Scratch(), "mobile-ui.oml", "o11");
    }
    [Fact] public void AJavaScriptTheStudioRemovedAndTheDeliveryChangedIsWrittenAgain() => RunMobile(FlowApplyScenarios.AJavaScriptTheStudioRemovedAndTheDeliveryChangedIsWrittenAgain);
    [Fact] public void TheMergeBatteryUndoesAndMergesAnExistingJavaScript() => RunMobile(FlowApplyScenarios.TheMergeBatteryUndoesAndMergesAnExistingJavaScript);
    [Fact] public void ANodeParameterRenamedByTheTextKeepsItsArgument() => RunMobile(FlowApplyScenarios.ANodeParameterRenamedByTheTextKeepsItsArgument);

    // Corrections of the third junction (Corrigir 2).
    [Fact] public void TwoLoopsOfOneTextArePatchedAndReadBackAsThePatch() => Run(FlowApplyScenarios.TwoLoopsOfOneTextArePatchedAndReadBackAsThePatch);
    [Fact] public void AnAttributeRenameAMappingWouldReadAsAnotherElementIsRefused() => Run(FlowApplyScenarios.AnAttributeRenameAMappingWouldReadAsAnotherElementIsRefused);
    [Fact] public void AMergeNeverPutsOneSidesValueUnderTheOthersName() => Run(FlowApplyScenarios.AMergeNeverPutsOneSidesValueUnderTheOthersName);
    [Fact] public void AValueThePlatformWouldRefuseIsRefusedInThePlan() => Run(FlowApplyScenarios.AValueThePlatformWouldRefuseIsRefusedInThePlan);

    // The 24.1 fixes (the owner rules and the round trip of the reviews).
    [Fact] public void TheJsonFormOfTheLogicOpIsJudgedByTheOwnersRules() => RunMobile(FlowApplyScenarios.TheJsonFormOfTheLogicOpIsJudgedByTheOwnersRules);
    [Fact] public void TwoTextsOfOneOpTradeTheNamesOfTheirActions() => Run(FlowApplyScenarios.TwoTextsOfOneOpTradeTheNamesOfTheirActions);
    [Fact] public void AnHtmlEditAfterALogicOpOfTheSameScreenIsMergedWithIt() => RunReactive(FlowApplyScenarios.AnHtmlEditAfterALogicOpOfTheSameScreenIsMergedWithIt);

    [Fact] public void AnAttributeRenamedInTheStudioIsNeitherAFixedPointNorMerged() => Run(FlowApplyScenarios.AnAttributeRenamedInTheStudioIsNeitherAFixedPointNorMerged);
    // The re-check of the 24.1 fixes (two screens: the reactive fixture).
    [Fact] public void TheOwnersRulesJudgeWhatEveryFormWroteWhereItIsAtTheEnd() => RunReactive(FlowApplyScenarios.TheOwnersRulesJudgeWhatEveryFormWroteWhereItIsAtTheEnd);
    [Fact] public void TheTextShaIsTheFacadesHash() => Assert.Equal("ba7816bf8f01cfea", ModuleFlow.TextSha("abc"));
}
