using Xunit;
using Recreation = NativeMergeVerification.ParameterRecreation;

// The post-merge gate reads the native MatchTree dump. The fragment below is the comparison the Studio produced for
// lab 22 (Escala Viva, screen action SelecionarTurno): the JavaScript node keeps its text, its output parameter Multi
// is removed and added back with a new key, and the If that reads DetectarMulti.Multi keeps its condition text.
public sealed class NativeMergeVerificationTests {
    private const string Js = "$parameters.Multi = !!(window.EscalaViva && EscalaViva.multi());";
    private static readonly IReadOnlySet<string> NoOwners = new HashSet<string>();
    private static readonly Recreation[] Proven = { new("SelecionarTurno", "DetectarMulti", "Output Parameter", "Multi", true) };

    private static string Dump(string localJs = Js, string candidateJs = Js, string added = "Multi", string removed = "Multi",
        string localCondition = "DetectarMulti.Multi", string candidateCondition = "DetectarMulti.Multi", string extra = "") => string.Join("\r\n", new[] {
        "(Object App) Escala Viva [DifferenceInLocalMergeUnit]",
        "+-- (Folder) UI Flows",
        "|    |",
        "|    +-- (Object UI Flow) MainFlow [DifferenceInLocalMergeUnit]",
        "|    |    |",
        "|    |    +-- (Object Screen) Escala [DifferenceInLocalMergeUnit]",
        "|    |    |    |",
        "|    |    |    +-- (Object Client Action) SelecionarTurno [DifferenceInLocalChildren]",
        "|    |    |    |    |",
        "|    |    |    |    +-- (Object JavaScript) DetectarMulti [ChangedInLocal, DifferenceInLocalChildren]",
        "|    |    |    |    |    |         >> JavaScript[" + localJs + "] / JavaScript[" + candidateJs + "] [ChangedInLocal]",
        "|    |    |    |    |    +-- (Folder) Parameters",
        "|    |    |    |    |    |    |",
        "|    |    |    |    |    |    +-- (Object Output Parameter) " + added + " [AddedToLocal, ChangedInLocal]",
        "|    |    |    |    |    |    |",
        "|    |    |    |    |    |    +-- (Object Output Parameter) " + removed + " [RemovedFromLocal, ChangedInLocal]",
        "|    |    |    |    |",
        "|    |    |    |    +-- (Object If) SelecaoMultipla [ChangedInLocal]",
        "|    |    |    |    |    |         >> Condition[" + localCondition + "] / Condition[" + candidateCondition + "] [ChangedInLocal]",
    }) + extra + "\r\n";

    private static void Accepts(string dump, Recreation[] recreated) =>
        NativeMergeVerification.Validate(dump, Array.Empty<NativeMergeVerification.LayoutAddition>(), NoOwners, recreated);
    private static void Refuses(string dump, Recreation[] recreated) =>
        Assert.Throws<InvalidOperationException>(() => Accepts(dump, recreated));

    [Fact]
    public void TheEvidenceFragmentIsAcceptedWhenTheModelProvesTheSameDataType() => Accepts(Dump(), Proven);

    [Fact]
    public void AMultiLineJavaScriptTextThatIsEqualOnBothSidesIsAccepted() {
        var text = "var multi = !!(window.EscalaViva && EscalaViva.multi());\r\n\r\n$parameters.Multi = multi;";
        Accepts(Dump(text, text), Proven);
    }

    [Fact]
    public void WithoutTheModelProofTheRecreationIsStillRefused() {
        Refuses(Dump(), Array.Empty<Recreation>());
        Refuses(Dump(), new[] { new Recreation("OutraAcao", "DetectarMulti", "Output Parameter", "Multi", true) });
        Refuses(Dump(), new[] { new Recreation("SelecionarTurno", "DetectarMulti", "Input Parameter", "Multi", true) });
    }

    [Fact]
    public void ADifferentDataTypeIsRefused() =>
        Refuses(Dump(), new[] { new Recreation("SelecionarTurno", "DetectarMulti", "Output Parameter", "Multi", false) });

    [Fact]
    public void ADifferentParameterNameIsRefused() {
        Refuses(Dump(added: "Multi2"), Proven);
        Refuses(Dump(removed: "Multi2"), Proven);
    }

    [Fact]
    public void ADifferentJavaScriptTextIsRefused() {
        Refuses(Dump(localJs: "$parameters.Multi = true;"), Proven);
        Refuses(Dump("a;\r\nb;", "a;\r\nc;"), Proven);
    }

    [Fact]
    public void AChangedConsumerExpressionIsRefused() {
        Refuses(Dump(localCondition: "not DetectarMulti.Multi"), Proven);
        Refuses(Dump(localCondition: "Outro.Multi", candidateCondition: "Outro.Multi"), Proven);
    }

    [Fact]
    public void AnyOtherDifferenceNextToTheRecreationKeepsTheRefusal() {
        Refuses(Dump(extra: "\r\n|    |    |    |    |\r\n|    |    |    |    +-- (Object Assign) Copiar [ChangedInLocal]\r\n|    |    |    |    |    |         >> Label[A] / Label[B] [ChangedInLocal]"), Proven);
        Refuses(Dump(extra: "\r\n|    |    |    |    |\r\n|    |    |    |    +-- (Object Assign) Novo [AddedToLocal]"), Proven);
        // A parameter added without its removed twin is a real addition, not a recreation.
        Refuses(Dump().Replace("|    |    |    |    |    |    +-- (Object Output Parameter) Multi [RemovedFromLocal, ChangedInLocal]\r\n", ""), Proven);
    }

    // ---- Normalizations (pacote D2, C16.5): the two deterministic rewrites of the ODC Studio's merge, with the shapes of
    // native-equivalence.txt of labs 10 and 61 (Refresh Data Max. Records set to the aggregate's 50) and 31 and 35 (an app
    // keeps Structure Public False). Synthetic names; the line shapes are the evidence's.
    private static string RefreshDump(string local = "50", string candidate = "200", string extra = "") => string.Join("\r\n", new[] {
        "(Object App) Sample App [DifferenceInLocalMergeUnit]",
        "+-- (Folder) UI Flows",
        "|    |",
        "|    +-- (Object UI Flow) MainFlow [DifferenceInLocalMergeUnit]",
        "|    |    |",
        "|    |    +-- (Object Screen) Board [DifferenceInLocalMergeUnit]",
        "|    |    |    |",
        "|    |    |    +-- (Object Client Action) LoadWeek [DifferenceInLocalChildren]",
        "|    |    |    |    |",
        "|    |    |    |    +-- (Object Refresh Data) Refresh GetPeople [ChangedInLocal]",
        "|    |    |    |    |    |         >> Max. Records[" + local + "] / Max. Records[" + candidate + "] [ChangedInLocal]",
        "|    |    |    |    |",
        "|    |    |    |    +-- (Object Refresh Data) Refresh GetRules [ChangedInLocal]",
        "|    |    |    |    |    |         >> Max. Records[" + local + "] / Max. Records[" + candidate + "] [ChangedInLocal]",
    }) + extra + "\r\n";
    private static string StructureDump(string local = "False", string candidate = "True", string extra = "") => string.Join("\r\n", new[] {
        "(Object App) Sample App [DifferenceInLocalMergeUnit]",
        "+-- (Folder) Structures",
        "|    |",
        "|    +-- (Object Structure) MatchState [ChangedInLocal]",
        "|    |    |         >> Public[" + local + "] / Public[" + candidate + "] [ChangedInLocal]",
        "|    |",
        "|    +-- (Object Structure) RankingRow [ChangedInLocal]",
        "|    |    |         >> Public[" + local + "] / Public[" + candidate + "] [ChangedInLocal]",
    }) + extra + "\r\n";
    private static void AcceptsNormalized(string dump, NativeMergeVerification.Normalization[] named) =>
        NativeMergeVerification.Validate(dump, Array.Empty<NativeMergeVerification.LayoutAddition>(), NoOwners, null, null, null, named);

    [Fact]
    public void TheRefreshMaxRecordsNormalizationIsNamedAndExplained() {
        var named = NativeMergeVerification.Normalizations(RefreshDump());
        Assert.Equal(new[] {
            new NativeMergeVerification.Normalization("Refresh Data", "LoadWeek", "Refresh GetPeople", "Max. Records", "50", "200"),
            new NativeMergeVerification.Normalization("Refresh Data", "LoadWeek", "Refresh GetRules", "Max. Records", "50", "200") }, named);
        AcceptsNormalized(RefreshDump(), named);
        Assert.Throws<InvalidOperationException>(() => Accepts(RefreshDump(), Array.Empty<Recreation>()));
    }

    [Fact]
    public void TheStructurePublicNormalizationIsNamedAndExplained() {
        var named = NativeMergeVerification.Normalizations(StructureDump());
        Assert.Equal(2, named.Length);
        Assert.All(named, n => { Assert.Equal("Structure", n.Kind); Assert.Equal("Public", n.Property); Assert.Equal("False", n.Local); Assert.Equal("True", n.Candidate); });
        AcceptsNormalized(StructureDump(), named);
        Assert.Throws<InvalidOperationException>(() => Accepts(StructureDump(), Array.Empty<Recreation>()));
    }

    [Fact]
    public void ADumpOutsideTheNormalizationClassesKeepsTheRefusal() {
        // Public made True by the merge (the other direction) is no Studio rewrite.
        Assert.Empty(NativeMergeVerification.Normalizations(StructureDump("True", "False")));
        Assert.Throws<InvalidOperationException>(() => AcceptsNormalized(StructureDump("True", "False"), NativeMergeVerification.Normalizations(StructureDump())));
        // Equal or non-numeric Max. Records is not the class.
        Assert.Empty(NativeMergeVerification.Normalizations(RefreshDump("50", "50")));
        Assert.Empty(NativeMergeVerification.Normalizations(RefreshDump("50", "x")));
        // Any other difference next to the normalized ones keeps the refusal, and naming only one leaves the other unexplained.
        var extra = "\r\n|    |    |    |    |\r\n|    |    |    |    +-- (Object Assign) Copy [ChangedInLocal]\r\n|    |    |    |    |    |         >> Label[A] / Label[B] [ChangedInLocal]";
        Assert.Throws<InvalidOperationException>(() => AcceptsNormalized(RefreshDump(extra: extra), NativeMergeVerification.Normalizations(RefreshDump(extra: extra))));
        Assert.Throws<InvalidOperationException>(() => AcceptsNormalized(RefreshDump(), NativeMergeVerification.Normalizations(RefreshDump()).Take(1).ToArray()));
        // A refresh node with another property changed too is not the class.
        var twoProperties = RefreshDump().Replace("Max. Records[50] / Max. Records[200] [ChangedInLocal]\r\n|    |    |    |    |\r\n",
            "Max. Records[50] / Max. Records[200] [ChangedInLocal]\r\n|    |    |    |    |    |         >> Label[A] / Label[B] [ChangedInLocal]\r\n|    |    |    |    |\r\n");
        Assert.Single(NativeMergeVerification.Normalizations(twoProperties));
        Assert.Throws<InvalidOperationException>(() => AcceptsNormalized(twoProperties, NativeMergeVerification.Normalizations(twoProperties)));
    }

    [Fact]
    public void DivergencesNameEachElementPropertyAndBothValues() {
        var divergences = NativeMergeVerification.Divergences(RefreshDump());
        Assert.Equal(2, divergences.Length);
        Assert.Equal(new NativeMergeVerification.Divergence("MainFlow/Board/LoadWeek/Refresh GetPeople", "Refresh Data", "Max. Records", "50", "200"), divergences[0]);
        var added = NativeMergeVerification.Divergences(Dump(extra: "\r\n|    |    |    |    |\r\n|    |    |    |    +-- (Object Assign) Novo [AddedToLocal]"));
        Assert.Contains(new NativeMergeVerification.Divergence("MainFlow/Escala/SelecionarTurno/Novo", "Assign", null, "present", "absent"), added);
        Assert.Contains(added, d => d.Kind == "JavaScript" && d.Property == "JavaScript" && d.Local == Js && d.Candidate == Js);
        Assert.True(NativeMergeVerification.Divergences(RefreshDump(), max: 1).Length == 1);
    }

    [Fact]
    public void StrictBehaviourIsUnchangedForLayoutAdditions() {
        const string dump = "(Object App) A [DifferenceInLocalMergeUnit]\r\n|    +-- (Object CustomProperty) GridColumns [AddedToLocal]\r\n";
        NativeMergeVerification.Validate(dump, new[] { new NativeMergeVerification.LayoutAddition("k", "GridColumns", null, "Home") }, new HashSet<string> { "Home" });
        Assert.Throws<InvalidOperationException>(() => NativeMergeVerification.Validate(dump, Array.Empty<NativeMergeVerification.LayoutAddition>(), NoOwners));
    }

    [Fact]
    public void DerivedHashesAreAcceptedOnlyOnUnchangedReferencedSignatures() {
        var dump = "(Object App) Lab [None]\n+-- (Folder) Dependencies\n|    +-- (Object Reference) Model [None]\n|    |    +-- (Folder) AIModels\n|    |    |    +-- (Object Server Action) CallModel [None]\n|    |    |    |         >> CompatibilitySignatureHash[3f23df4d-e240-84ec-efcc-c952fb8c5a00] / CompatibilitySignatureHash[64a21475-f933-ab6f-9a22-60fe459d3d2e] [ChangedInLocal] [Not Visible]\n";
        NativeMergeVerification.Validate(dump, Array.Empty<NativeMergeVerification.LayoutAddition>(), NoOwners);
        foreach (var invalid in new[] { dump.Replace("Object Reference", "Object Folder"), dump.Replace("[Not Visible]", ""), dump.Replace("CompatibilitySignatureHash", "SignatureHash"), dump.Replace("Model [None]", "Model [ChangedInLocal]"), dump.Replace("CallModel [None]", "CallModel [ChangedInLocal]") })
            Assert.Throws<InvalidOperationException>(() => NativeMergeVerification.Validate(invalid, Array.Empty<NativeMergeVerification.LayoutAddition>(), NoOwners));
    }

    [Fact]
    public void ActualAgentImportDumpRetainsAllNodesAfterHiddenProperties() {
        var dump = @"(Object App) SSAMAgentLab [None]
+-- (Folder) Dependencies
|    |
|    +-- (Object Reference) TrialAmazonNovaPro [None]
|    |    +-- (Folder) AIModels
|    |    |    |
|    |    |    +-- (Object Server Action) CallTrialAmazonNovaPro [None]
|    |    |    |    |         >> CompatibilitySignatureHash[3f23df4d-e240-84ec-efcc-c952fb8c5a00] / CompatibilitySignatureHash[64a21475-f933-ab6f-9a22-60fe459d3d2e] [ChangedInLocal] [Not Visible]
|    |    |    |    |         >> FullSignatureHash[89671351-33d1-79de-ec22-9a69afe395f5] / FullSignatureHash[4f44c2dd-3c7a-ea5d-305e-6425450d1edc] [ChangedInLocal] [Not Visible]
|    |    |
|    |    +-- (Folder) Structures
|    |    |    |
|    |    |    +-- (Object Structure) ModelUsage2 [None]
|    |    |    |    |         >> CompatibilitySignatureHash[b0e7b3d9-b431-1474-30ea-b14eea54d361] / CompatibilitySignatureHash[fbeffff1-ef43-e66a-f4c8-f6299a8ef7fe] [ChangedInLocal] [Not Visible]
|    |    |    |
|    |    |    +-- (Object Structure) Request2 [None]
|    |    |    |    |         >> CompatibilitySignatureHash[69e9aebc-f650-5a54-2a42-8e36371e2c42] / CompatibilitySignatureHash[c12e8544-bcca-063b-9f0e-fe64f742e884] [ChangedInLocal] [Not Visible]
|    |    |    |
|    |    |    +-- (Object Structure) RequestContent [None]
|    |    |    |    |         >> CompatibilitySignatureHash[bf36705f-e189-ab4f-b9e0-90048350a77b] / CompatibilitySignatureHash[d62d5bcf-f598-98d7-99e7-75c300dcb9c6] [ChangedInLocal] [Not Visible]
|    |    |    |
|    |    |    +-- (Object Structure) RequestMessages [None]
|    |    |    |    |         >> CompatibilitySignatureHash[0b46a6f5-174b-460a-3cb0-e2ee14c0d282] / CompatibilitySignatureHash[8ea362bf-933b-4758-5b00-5f0beef9fb95] [ChangedInLocal] [Not Visible]
|    |    |    |
|    |    |    +-- (Object Structure) Response2 [None]
|    |    |    |    |         >> CompatibilitySignatureHash[105631be-cdf7-78e2-0cf6-c87449a93e05] / CompatibilitySignatureHash[2314dc9b-0d66-bab5-af93-fc22d174e008] [ChangedInLocal] [Not Visible]
|    |    |    |
|    |    |    +-- (Object Structure) ResponseMessages [None]
|    |    |    |    |         >> CompatibilitySignatureHash[b1671613-a8a4-545f-884c-2bc7db944bc7] / CompatibilitySignatureHash[212fd9a6-dc66-ccf0-ef9b-3b0f10dc7733] [ChangedInLocal] [Not Visible]
";
        NativeMergeVerification.Validate(dump, Array.Empty<NativeMergeVerification.LayoutAddition>(), NoOwners);
        Assert.Throws<InvalidOperationException>(() => NativeMergeVerification.Validate(dump.Replace("FullSignatureHash[", "Name["), Array.Empty<NativeMergeVerification.LayoutAddition>(), NoOwners));
    }
}
