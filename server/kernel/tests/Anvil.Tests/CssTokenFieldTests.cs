using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R2-D, round 4 of the review: a token is equal to another only when every field CSS Syntax 3 gives it is: a hash's type flag
/// (id or unrestricted), a number's sign and type (integer or number), a dimension's unit (ASCII case-insensitive), the kind
/// itself. A generative test pairs tokens that differ in exactly one field (and pairs that differ in none) and checks the keys.
/// Synthetic names.
/// </summary>
public sealed class CssTokenFieldTests
{
    private static string Normal(string css) => CssPipeline.Normalize(css, new CssPipeline.Context("test")).Css;
    private static string KeyOf(string text) => CssTokenizer.Key(CssTokenizer.Tokenize(text).Tokens);

    [Theory]
    // "#\31 a" is an id hash (the id selector "1a"); "#1a" an unrestricted one (no id selector: the browser drops the rule).
    [InlineData("#\\31 a{color:red}\n#1a{color:red}")]
    [InlineData(".x#\\31 a{color:red}\n.x#1a{color:red}")]
    public void AHashOfAnotherTypeIsAnotherToken(string css)
    {
        Assert.Equal(css, Normal(css));
    }

    [Theory]
    [InlineData("#a{color:red}\n#\\61{color:red}", "#\\61{color:red}")]
    [InlineData(".a{color:#fff}\n.a{color:#fff}", ".a{color:#fff}")]
    [InlineData(".a{width:10px}\n.a{width:10PX}", ".a{width:10PX}")]
    public void TheSameTokensGo(string css, string expected)
    {
        Assert.Equal(expected, Normal(css));
    }

    // Pairs of texts whose single token differs in exactly one field, built over generated names and numbers.
    private static IEnumerable<(string A, string B, string Field)> OneField(Random random)
    {
        string Name() => new string(Enumerable.Range(0, random.Next(1, 6)).Select(_ => (char)('a' + random.Next(26))).ToArray());
        var digit = random.Next(1, 10);
        var name = Name();
        yield return ("#\\3" + digit + " " + name, "#" + digit + name, "hash type flag (id / unrestricted)");
        yield return ("+" + digit, digit.ToString(), "number sign");
        yield return (digit + ".0", digit.ToString(), "number type (number / integer)");
        yield return (digit + "px", digit + "em", "dimension unit");
        yield return (digit + "%", digit.ToString(), "kind (percentage / number)");
        yield return (digit + "px", digit + "%", "kind (dimension / percentage)");
        yield return ("\"" + name + "\"", name, "kind (string / ident)");
        yield return (name + "(", name, "kind (function / ident)");
        yield return ("@" + name, name, "kind (at-keyword / ident)");
        yield return ("url(" + name + ")", "url(\"" + name + "\")", "kind (url / function and string)");
        yield return (name, name + "x", "ident value");
        yield return ("\"" + name + "\"", "\"" + name + " \"", "string value");
    }

    // Pairs that differ in no field: the same tokens however written.
    private static IEnumerable<(string A, string B)> NoField(Random random)
    {
        var letter = (char)('a' + random.Next(26));
        var digit = random.Next(1, 10);
        yield return ("#" + letter, "#\\" + ((int)letter).ToString("x"));
        yield return (digit + "px", digit + "PX");
        yield return ("\"" + letter + "\"", "'" + letter + "'");
        yield return ("." + letter, ".\\" + ((int)letter).ToString("x") + " ");
    }

    [Fact]
    public void TokensThatDifferInOneFieldHaveDifferentKeys()
    {
        var random = new Random(20261029);
        var failures = new List<string>();
        for (var n = 0; n < 500; n++)
        {
            foreach (var (a, b, field) in OneField(random))
                if (KeyOf(a) == KeyOf(b) && failures.Count < 10) failures.Add(field + ": " + a + " == " + b);
            foreach (var (a, b) in NoField(random))
                if (KeyOf(a) != KeyOf(b) && failures.Count < 10) failures.Add("no field: " + a + " != " + b);
        }
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }
}
