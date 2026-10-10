using Xunit;
using Lost = NativeMergeVerification.LostDefault;

// The known class of the merge order (Anvil.Core.MergeOrder): the comparison below is native-equivalence.txt of lab 24
// (QuizLiveWeb, 2026-10-04): the ODC Studio removed two identifier defaults on attributes the merge created, and the bridge
// answered "uncertain". Named, those lines are explained and nothing else may differ; any other difference keeps the refusal.
public sealed class LostDefaultVerificationTests {
    private static readonly IReadOnlySet<string> NoOwners = new HashSet<string>();
    private static readonly Lost[] Quiz = { new("Partida", "StatusId", "Entities.PartidaStatus.Aguardando"), new("Quiz", "DificuldadeId", "Entities.Dificuldade.Medio") };

    private static string Dump(string extra = "") => string.Join("\r\n", new[] {
        "(Object App) QuizLive Web [DifferenceInLocalMergeUnit]",
        "+-- (Folder) Database",
        "|    |",
        "|    +-- (Object Entity) Partida [DifferenceInLocalMergeUnit]",
        "|    |    |",
        "|    |    +-- (Object Entity Attribute) StatusId [ChangedInLocal, DifferenceInLocalChildren]",
        "|    |    |    |         >> Default Value[] / Default Value[Entities.PartidaStatus.Aguardando] [RemovedFromLocal]",
        "|    |    |    |",
        "|    |    |    +-- (Object ParsedExpression) Entities.PartidaStatus.Aguardando [RemovedFromLocal]",
        "|    |",
        "|    +-- (Object Entity) Quiz [DifferenceInLocalMergeUnit]",
        "|    |    |",
        "|    |    +-- (Object Entity Attribute) DificuldadeId [ChangedInLocal, DifferenceInLocalChildren]",
        "|    |    |    |         >> Default Value[] / Default Value[Entities.Dificuldade.Medio] [RemovedFromLocal]",
        "|    |    |    |",
        "|    |    |    +-- (Object ParsedExpression) Entities.Dificuldade.Medio [RemovedFromLocal]",
    }) + extra + "\r\n";

    private static void Accepts(string dump, Lost[] lost) =>
        NativeMergeVerification.Validate(dump, Array.Empty<NativeMergeVerification.LayoutAddition>(), NoOwners, null, lost);
    private static InvalidOperationException Refuses(string dump, Lost[] lost) =>
        Assert.Throws<InvalidOperationException>(() => Accepts(dump, lost));

    [Fact]
    public void TheLab24ComparisonIsRefusedAsUnknownWithoutTheNamedDefaults() =>
        Assert.Contains("lost or conflicts", Refuses(Dump(), Array.Empty<Lost>()).Message);

    [Fact]
    public void TheLab24ComparisonIsExplainedByItsTwoLostDefaults() => Accepts(Dump(), Quiz);

    [Fact]
    public void EveryLostDefaultMustBeNamedWithItsElementAndValue() {
        Refuses(Dump(), new[] { Quiz[0] });
        Refuses(Dump(), new[] { Quiz[0], new Lost("Quiz", "DificuldadeId", "Entities.Dificuldade.Facil") });
        Refuses(Dump(), new[] { Quiz[0], new Lost("Partida", "DificuldadeId", "Entities.Dificuldade.Medio") });
    }

    // native-equivalence.txt of lab 02 (Escala Viva, 2026-10-03): two lost defaults and two delete rules the Studio forced to
    // Ignore on references to User, each with its automatic index removed.
    private static string EscalaViva(string requested = "Protect") => string.Join("\r\n", new[] {
        "(Object App) Escala Viva [DifferenceInLocalMergeUnit]",
        "+-- (Folder) Database",
        "|    |",
        "|    +-- (Object Entity) Colaborador [DifferenceInLocalMergeUnit]",
        "|    |    |",
        "|    |    +-- (Object Entity Attribute) UserId [ChangedInLocal]",
        "|    |    |    |         >> Delete Rule[Ignore] / Delete Rule[" + requested + "] [ChangedInLocal]",
        "|    |    |",
        "|    |    +-- (Object Index) AutoIndex_UserId [RemovedFromLocal, ChangedInLocal, DifferenceInLocalChildren]",
        "|    |    |    |",
        "|    |    |    +-- (Object Entity Index Attribute) UserId [RemovedFromLocal, ChangedInLocal]",
        "|    |",
        "|    +-- (Object Entity) Escala [DifferenceInLocalMergeUnit]",
        "|    |    |",
        "|    |    +-- (Object Entity Attribute) StatusEscalaId [ChangedInLocal, DifferenceInLocalChildren]",
        "|    |    |    |         >> Default Value[] / Default Value[Entities.StatusEscala.Rascunho] [RemovedFromLocal]",
        "|    |    |    |",
        "|    |    |    +-- (Object ParsedExpression) Entities.StatusEscala.Rascunho [RemovedFromLocal]",
        "|    |    |",
        "|    |    +-- (Object Entity Attribute) AtualizadoPor [ChangedInLocal]",
        "|    |    |    |         >> Delete Rule[Ignore] / Delete Rule[" + requested + "] [ChangedInLocal]",
        "|    |    |",
        "|    |    +-- (Object Index) AutoIndex_AtualizadoPor [RemovedFromLocal, ChangedInLocal, DifferenceInLocalChildren]",
        "|    |    |    |",
        "|    |    |    +-- (Object Entity Index Attribute) AtualizadoPor [RemovedFromLocal, ChangedInLocal]",
        "|    |",
        "|    +-- (Object Entity) SolicitacaoTroca [DifferenceInLocalMergeUnit]",
        "|    |    |",
        "|    |    +-- (Object Entity Attribute) StatusTrocaId [ChangedInLocal, DifferenceInLocalChildren]",
        "|    |    |    |         >> Default Value[] / Default Value[Entities.StatusTroca.Pendente] [RemovedFromLocal]",
        "|    |    |    |",
        "|    |    |    +-- (Object ParsedExpression) Entities.StatusTroca.Pendente [RemovedFromLocal]",
    }) + "\r\n";
    private static readonly Lost[] EscalaDefaults = { new("Escala", "StatusEscalaId", "Entities.StatusEscala.Rascunho"), new("SolicitacaoTroca", "StatusTrocaId", "Entities.StatusTroca.Pendente") };

    [Fact]
    public void TheLab02ComparisonNamesItsForcedDeleteRulesAndIsExplainedWithItsLostDefaults() {
        var forced = NativeMergeVerification.ForcedDeleteRules(EscalaViva());
        Assert.Equal(new[] { new NativeMergeVerification.ForcedDeleteRule("Colaborador", "UserId", "Protect"), new NativeMergeVerification.ForcedDeleteRule("Escala", "AtualizadoPor", "Protect") }, forced);
        NativeMergeVerification.Validate(EscalaViva(), Array.Empty<NativeMergeVerification.LayoutAddition>(), NoOwners, null, EscalaDefaults, forced);
        Assert.Throws<InvalidOperationException>(() => NativeMergeVerification.Validate(EscalaViva(), Array.Empty<NativeMergeVerification.LayoutAddition>(), NoOwners, null, EscalaDefaults));
        Assert.Throws<InvalidOperationException>(() => NativeMergeVerification.Validate(EscalaViva(), Array.Empty<NativeMergeVerification.LayoutAddition>(), NoOwners, null, null, forced));
        // Only a rule forced TO Ignore is that class.
        Assert.Empty(NativeMergeVerification.ForcedDeleteRules(EscalaViva().Replace("Delete Rule[Ignore] / ", "Delete Rule[Delete] / ")));
    }

    [Fact]
    public void AnyOtherDifferenceKeepsTheRefusal() {
        Refuses(Dump("\r\n|    |\r\n|    +-- (Object Entity) Jogador [DifferenceInLocalMergeUnit]\r\n|    |    |\r\n|    |    +-- (Object Entity Attribute) Nome [RemovedFromLocal]"), Quiz);
        // A default the module holds with another value is a different property, not a lost one.
        var changed = Dump().Replace("Default Value[] / Default Value[Entities.Dificuldade.Medio] [RemovedFromLocal]", "Default Value[Entities.Dificuldade.Facil] / Default Value[Entities.Dificuldade.Medio] [ChangedInLocal]");
        Refuses(changed, Quiz);
    }
}
