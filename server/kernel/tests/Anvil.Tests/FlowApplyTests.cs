using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>The logic op's text form through a real O11 job (FlowApplyScenarios, linked into both test projects), on the
/// blank service fixture; the kernel's textSha is the facade's (module-flow.test.mjs pins the same value).</summary>
public sealed class FlowApplyTests
{
    /// <summary>F13 (proto 760bc130, the owner's six rounds of 26/10/2026), adapted to the line: a bare call of the one action a
    /// referenced producer (module Sonnet_IS) has under that name binds to it (the line resolves it by its kind before its scope,
    /// where the proto refused it with a patch), and so does the qualified Sonnet_IS.ObterPokemon. Without the reference the call
    /// is refused (CALL_UNKNOWN before the build, FLOW_NAME_UNKNOWN in the apply), and the fix writes the producer's module name bare: only the System module is written (System),
    /// never "(Producer.Action, (System).Action)", which the session read as `(Sonnet_IS).ObterPokemon`.</summary>
    [Fact]
    public void AReferencedProducersCallBindsBareOrQualifiedAndTheUnknownOneSaysHowToWriteAProducer() => Run((dir, fixture, lane) =>
    {
        var root = PacoteBPolicyTests.FindRoot();
        var basis = Path.Combine(root, "tests", "fixtures", fixture);
        var host = new Anvil.Core.ModelHost(Path.Combine(dir, "work"));
        _ = host.Inspect(basis);
        // An official blank fixture with a new module identity (Sonnet_IS): the consumer cannot reference itself.
        var clone = System.Reflection.Assembly.Load("ServiceStudio.Framework").GetType("ServiceStudio.Model.ESpace")!.GetMethods()
            .Single(m => m.Name == "Clone" && m.IsStatic && m.GetParameters().Length == 9);
        Action<object> rename = m => m.GetType().GetMethod("SetName", [typeof(string)])!.Invoke(m, ["Sonnet_IS"]);
        var callback = Delegate.CreateDelegate(clone.GetParameters()[5].ParameterType, rename.Target, rename.Method);
        using var bytes = new MemoryStream(File.ReadAllBytes(basis));
        var module = clone.Invoke(null, [bytes, null, null, null, false, callback, null, false, false])!;
        var producerBase = Path.Combine(dir, "producer-base.oml");
        try { File.WriteAllBytes(producerBase, (byte[])typeof(Anvil.Core.ModelHost).GetMethod("Save")!.Invoke(host, [module])!); }
        finally { typeof(Anvil.Core.ModelHost).GetMethod("Release")!.Invoke(null, [module]); }
        string Apply(string name, string from, System.Text.Json.Nodes.JsonObject job, Dictionary<string, string>? bindings = null)
        {
            var file = Path.Combine(dir, name + ".json"); File.WriteAllText(file, job.ToJsonString());
            var output = Path.Combine(dir, name + ".oml");
            var result = System.Text.Json.JsonSerializer.SerializeToNode(Anvil.Core.JobRunner.Run(host, from, file, output, bindings: bindings))!;
            Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
            return output;
        }
        System.Text.Json.Nodes.JsonObject Flow(string text) => new() { ["ops"] = new System.Text.Json.Nodes.JsonArray(new System.Text.Json.Nodes.JsonObject {
            ["op"] = "logic", ["data"] = new System.Text.Json.Nodes.JsonObject { ["flow"] = text } }) };
        var producer = Apply("producer", producerBase, Flow("server action ObterPokemon public\n  in IdOuNome: Text\n  out Nome: Text\n  assign Nome = IdOuNome\n  end\n"));
        var import = System.Text.Json.Nodes.JsonNode.Parse("""{"ops":[{"op":"reference","producer":"Pokemon","elements":["IServerAction:ObterPokemon"]}]}""")!.AsObject();
        var consumer = Apply("consumer", basis, import, new() { ["Pokemon"] = producer });
        var text = "server action BuscarPorCep\n  in NomePokemon: Text\n  out Result: Text\n  ConsultaPokemon = ObterPokemon(IdOuNome=NomePokemon)\n  assign Result = ConsultaPokemon.Nome\n  end\n";
        Apply("bare", consumer, Flow(text));
        Apply("qualified", consumer, Flow(text.Replace("= ObterPokemon(", "= Sonnet_IS.ObterPokemon(")));
        var absent = Assert.ThrowsAny<Exception>(() => Apply("absent", basis, Flow(text)));
        // The scope phase refuses it before the build (CALL_UNKNOWN); the apply's FLOW_NAME_UNKNOWN says the same form.
        var coded = Anvil.Core.Errors.FindCoded(absent);
        Assert.True(coded?.Problems != null, Anvil.Core.Errors.Text(absent));
        var fix = coded!.Problems!.OfType<System.Text.Json.Nodes.JsonObject>().Single(p => p["code"]!.ToString() is "CALL_UNKNOWN" or "FLOW_NAME_UNKNOWN")["fix"]!.ToString();
        Assert.Contains("called as Producer.Action(args), with the producer's module name", fix);
        Assert.Contains("only the System module is written (System).Action(args)", fix);
        Assert.DoesNotContain("(Producer.Action, (System).Action)", fix);
    });

    private const string Fixture = "blank-service.oml";
    [Fact] public void PaginationSqlAndExceptionHandlersReadBackExactly() => Run(FlowApplyScenarios.PaginationSqlAndExceptionHandlersReadBackExactly);
    [Fact] public void RecordTypeIndexIsSharedWithinLogicAndRenewedAfterDataChanges() => Run(FlowApplyScenarios.RecordTypeIndexIsSharedWithinLogicAndRenewedAfterDataChanges);
    [Fact] public void ToleratedShapesApplyAndReadBackAsTheCanonicalText() => Run(FlowApplyScenarios.ToleratedShapesApplyAndReadBackAsTheCanonicalText);
    [Fact] public void SwappingDecisionTargetsKeepsEveryNodeIdentity() => Run(FlowApplyScenarios.SwappingDecisionTargetsKeepsEveryNodeIdentity);
    [Fact] public void MovingNestedLoopToSequencePreservesNodesAndDetachesOldEdges() => Run(FlowApplyScenarios.MovingNestedLoopToSequencePreservesNodesAndDetachesOldEdges);
    [Fact] public void SameNamedUiCallsBindToTheirOwnerAcrossCreateReloadEditAndMerge() => RunReactive((dir, fixture, lane) =>
        FlowApplyScenarios.SameNamedUiCallsBindToTheirOwnerAcrossCreateReloadEditAndMerge(dir, fixture, lane, (host, basis, candidate, merged) => {
            var probe = Anvil.Core.MergeProbe.ThreeWay(host, File.ReadAllBytes(basis), File.ReadAllBytes(candidate), merged);
            Assert.False(probe.HasConflicts); Assert.Equal(0, probe.Errors);
        }));
    [Fact] public void LifecycleDestinationIgnoresSameNamedEntityFields() => RunReactive(FlowApplyScenarios.LifecycleDestinationIgnoresSameNamedEntityFields);
    [Fact] public void ARecordOfAStaticEntityNeverShadowsTheEntityOfASqlOutput() => Run(FlowApplyScenarios.ARecordOfAStaticEntityNeverShadowsTheEntityOfASqlOutput);
    [Fact] public void NewlyCreatedDataSourcesReplaceStaleOwnerLookup() => RunReactive(FlowApplyScenarios.NewlyCreatedDataSourcesReplaceStaleOwnerLookup);

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
    [Fact] public void ADeclarationNamedAfterAnActionOfTheModuleIsItsEditPathNeverADerivedName() => Run(FlowApplyScenarios.ADeclarationNamedAfterAnActionOfTheModuleIsItsEditPathNeverADerivedName);
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
    [Fact] public void ADataRefusalForAMissingBasedOnKeepsEveryStatementOfTheJob() => Run(FlowApplyScenarios.ADataRefusalForAMissingBasedOnKeepsEveryStatementOfTheJob);

    // Screen, block and data actions born from their texts need a Reactive module (the blank service has no screen).
    private const string Reactive = "reactive-ui.oml";
    [Fact] public void ScreenJavaScriptExceptionIsScopedAndAudited() => RunReactive(FlowApplyScenarios.ScreenJavaScriptExceptionIsScopedAndAudited);
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
    public void ATraditionalOwnerRejectsDataActions()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        FlowApplyScenarios.ATraditionalOwnerRejectsDataActions(Scratch(), "traditional-ui.oml", "o11");
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
