using Anvil.Core;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.Tests;
public sealed class MigrationTemporalRegressionTests
{
    [Fact] public void CalendarDateDoesNotShiftInNegativeOffsetZone()
        => Assert.Equal("#2026-10-23#", TemporalContract.NativeLiteral("2026-10-23", "date", "America/Sao_Paulo"));
    [Theory]
    [InlineData("2026-10-23T12:00:00")]
    [InlineData("2026-10-23T12:00:00Z")]
    public void ClientLocalComponentsArePreservedEvenWithO11TransportZ(string text)
        => Assert.Equal("#2026-10-23 12:00:00#", TemporalContract.NativeLiteral(text, "client-local", "America/Sao_Paulo"));
    [Fact] public void InstantConvertsExactlyOnce()
    {
        var shown = TemporalContract.Display(TemporalContract.Parse("2026-10-23T12:00:00Z", "instant"), "America/Sao_Paulo");
        Assert.Equal(9, shown.WallClock.Hour);
        Assert.Equal(shown, TemporalContract.Display(shown, "America/Sao_Paulo"));
    }
    [Theory]
    [InlineData("2026-03-08T06:59:00Z", "01:59")]
    [InlineData("2026-03-08T07:01:00Z", "03:01")]
    public void ExplicitInstantRespectsDstBoundary(string text, string expected)
        => Assert.Equal(expected, TemporalContract.Display(TemporalContract.Parse(text, "instant"), "America/New_York").WallClock.ToString("HH:mm"));
    [Theory]
    [InlineData("2026-10-23T12:00:00", "instant")]
    [InlineData("2026-10-23T12:00:00-03:00", "client-local")]
    [InlineData("2026-02-30", "date")]
    [InlineData("2026-10-23", "unknown")]
    public void AmbiguousOrInvalidTemporalValuesFailBeforeGeneration(string text, string semantics)
        => Assert.Throws<ArgumentException>(() => TemporalContract.Parse(text, semantics));
    [Fact] public void NativeCaptureFieldUsesItsDeclaredTemporalContract()
    {
        var field = new PrototypeDataModel.Field("Due", "DateTime", null, null, "client-local");
        Assert.Equal("#2026-10-23 12:00:00#", PrototypeDataModel.FieldLiteral(field, JsonValue.Create("2026-10-23T12:00:00Z")));
    }
}
