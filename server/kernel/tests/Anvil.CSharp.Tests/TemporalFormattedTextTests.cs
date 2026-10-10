using System.Globalization;
using Xunit;

namespace Anvil.CSharp.Tests;

public sealed class TemporalFormattedTextTests
{
    private static string Source => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Cases", "temporal-formatting", "TemporalFormatting.cs.txt"));

    [Theory]
    [InlineData(1, 1, 1)]
    [InlineData(2024, 2, 29)]
    [InlineData(9999, 12, 31)]
    public void CivilLabelIsPresentTextThroughTheSdk(int year, int month, int day)
    {
        var value = new DateOnly(year, month, day);
        using var call = new ReferencePublicGraphTests.Call(Source, "DateLabel");
        Assert.Equal(value.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), call.Invoke(value));
    }

    [Fact]
    public void ClockAndOffsetFormattingKeepFractionalTicks()
    {
        var clock = TimeOnly.MaxValue;
        using var clockCall = new ReferencePublicGraphTests.Call(Source, "ClockLabel");
        Assert.Equal(clock.ToString("O", CultureInfo.InvariantCulture), clockCall.Invoke(clock));
        var offset = new DateTimeOffset(638929543234567891L, TimeSpan.FromMinutes(210));
        using var offsetCall = new ReferencePublicGraphTests.Call(Source, "OffsetLabel");
        Assert.Equal(offset.ToString("O", CultureInfo.InvariantCulture), offsetCall.Invoke(offset));
    }

    [Fact]
    public void EmptyFormattingIsAnEmptyStringWithPresence()
    {
        using var call = new ReferencePublicGraphTests.Call(Source, "EmptyLabel");
        Assert.Equal(DateOnly.MinValue.ToString("''", CultureInfo.InvariantCulture), call.Invoke(DateOnly.MinValue));
        Assert.NotNull(call.Invoke(DateOnly.MinValue));
    }
}
