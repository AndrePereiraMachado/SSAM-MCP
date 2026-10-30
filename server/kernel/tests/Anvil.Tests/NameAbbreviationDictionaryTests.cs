using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R3-C review: the fixed dictionary of N1_ABBREVIATION (Kernel/Preflight/EnglishWords.txt, embedded in both lanes) holds
/// whole English words, as written or regularly inflected, and never a shortening nor a letter alone: a shortening there
/// would hide a real abbreviation.
/// </summary>
public sealed class NameAbbreviationDictionaryTests
{
    [Fact]
    public void TheDictionaryHoldsWholeWordsAndNoShortening()
    {
        Assert.True(AbbreviationRules.Dictionary.Count > 1000);
        foreach (var word in new[] { "Add", "Log", "Pay", "In", "Order", "Logs", "Closing", "Closed", "Payments" })
            Assert.True(AbbreviationRules.IsEnglishWord(word), word);
        foreach (var shortening in new[] { "Cust", "Cst", "Trk", "Whs", "Gen", "Acc", "Cur", "Ref", "Info", "App", "Admin", "Config", "Max", "Min", "Temp", "Doc", "Calc", "Auto", "Q" })
            Assert.False(AbbreviationRules.IsEnglishWord(shortening), shortening);
        Assert.All(AbbreviationRules.Dictionary, w => Assert.True(w.Length > 1 || w == "a", w));
    }
}
