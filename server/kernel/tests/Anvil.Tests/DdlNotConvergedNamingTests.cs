using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>Goal list of 2026-10-20, item 8 (report 875d39c3): DDL_NOT_CONVERGED said only "the platform named it otherwise" for an
/// index of 32 to 36 characters. The problem now names what the platform made of it and, when the name came back cut, the
/// length the platform keeps, with that name as the corrected value (ModelSession.Renamed, pure).</summary>
public sealed class DdlNotConvergedNamingTests
{
    private static DdlElement Index(string name, int line = 52) => new() { Kind = "EntityIndex", Name = name, Line = line };

    [Fact]
    public void ACutNameSaysTheLengthThePlatformKeepsAndCorrectsToIt()
    {
        var problem = ModelSession.Renamed(Index("UQ_TechnicalMetric_ProgramExternal"), Index("UQ_TechnicalMetric_ProgramExte"));
        Assert.Equal("DDL_NOT_CONVERGED", problem.Code);
        Assert.Equal(52, problem.Line);
        Assert.Contains("the platform named it UQ_TechnicalMetric_ProgramExte", problem.Message);
        Assert.Contains("30 characters; the name sent has 34: the platform keeps at most 30 for a EntityIndex", problem.Message);
        Assert.Contains("at most 30 characters", problem.Fix);
        Assert.Equal("UQ_TechnicalMetric_ProgramExte", problem.Corrected);
    }

    // Live on 20/10 (SSAM_DumpProbe, ProbeLongNames): the patch of /ddl carried the bare name and the corrected op was DDL_SYNTAX
    // ("unknown statement ''"). With the text, the corrected value is the statements with that name as the platform kept it.
    [Fact]
    public void WithTheTextTheCorrectedValueIsTheStatementsWithTheCutName()
    {
        const string text = "create entity ProbeLongNames (\n  Id Long Integer identifier auto required,\n  ThisAttributeNameIsDefinitelyLongerThanTwentyEightChars Text(50),\n  Short Text(20)\n);";
        var element = new DdlElement { Kind = "EntityAttribute", Name = "ThisAttributeNameIsDefinitelyLongerThanTwentyEightChars", Line = 4 };
        var problem = ModelSession.Renamed(element, new DdlElement { Kind = "EntityAttribute", Name = "ThisAttributeNameIsDefinitel", Line = 4 }, text);
        Assert.Equal(text.Replace("ThisAttributeNameIsDefinitelyLongerThanTwentyEightChars", "ThisAttributeNameIsDefinitel"), problem.Corrected);
        Assert.Contains("28 characters; the name sent has 55", problem.Message);
        // Another name, not a cut: no corrected value, with or without the text; a prefix of another word is left alone.
        Assert.Null(ModelSession.Renamed(Index("IX_A"), Index("IX_A_1"), "create unique index IX_A on T (A);").Corrected);
        Assert.Equal("Short Short2 ShortName", ModelSession.RenamedText("Short Short2 ShortName", "Short2", "Short2"));
        Assert.Equal("X Y XY", ModelSession.RenamedText("X Y XY", "X", "X"));
    }

    [Fact]
    public void AnotherNameIsNamedWithoutALengthAndNoCandidateKeepsTheOldWords()
    {
        var other = ModelSession.Renamed(Index("IX_A"), Index("IX_A_1"));
        Assert.Contains("the platform named it IX_A_1", other.Message);
        Assert.DoesNotContain("keeps at most", other.Message);
        Assert.Contains("write IX_A_1 in the text", other.Fix);
        Assert.Null(other.Corrected);
        var none = ModelSession.Renamed(Index("IX_B"), null);
        Assert.Contains("the platform named it otherwise", none.Message);
        Assert.Equal("give it another name", none.Fix);
    }
}
