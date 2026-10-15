using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

public sealed class SharedStyleSafetyTests
{
    [Theory]
    [InlineData("<div class=\"a\"></div>")]
    [InlineData("<div class=\"{{ RuntimeClass }}\"></div>")]
    [InlineData("<Block name=\"Child\"></Block>")]
    public void ANewThemeRuleCannotStyleAnotherDocumentThatNeverCarriedIt(string content)
    {
        var ops = Documents("<style>.a{color:red}</style>", "<style>.a{color:red}</style>", content);
        var before = ops.ToJsonString();
        Normalize(ops);
        Assert.Equal(before, ops.ToJsonString());
    }

    [Theory]
    [InlineData("<style>")]
    [InlineData("<style scope=theme>")]
    public void UnreadableDocumentsCannotAcquireNewRulesFromAnotherDocumentsTheme(string opening)
    {
        var ops = Documents("<style>.a{color:red}</style>", "<style>.a{color:red}</style>",
            opening + "@import url('cut;</style>");
        var before = ops.ToJsonString();
        Normalize(ops);
        Assert.Equal(before, ops.ToJsonString());
    }

    [Theory]
    [InlineData(".a{col/**/or:red}", ".a{color:red}")]
    [InlineData(".a{color:re/**/d}", ".a{color:red}")]
    public void RemovingCommentsNeverJoinsSeparateCssTokens(string first, string second)
    {
        Assert.NotEqual(CssStylesheet.SharedRuleKey(first), CssStylesheet.SharedRuleKey(second));
        var ops = Documents("<style>" + first + "</style>", "<style>" + second + "</style>");
        var before = ops.ToJsonString();
        Normalize(ops);
        Assert.Equal(before, ops.ToJsonString());
    }

    [Fact]
    public void AnImportDeadInAnyDocumentIsNeverActivatedByTheTheme()
    {
        const string import = "@import url('https://example.test/theme.css');";
        var ops = Documents("<style>.x{color:red}" + import + "</style>", "<style>" + import + ".y{padding:0}</style>");
        Normalize(ops);
        Assert.All(ops, op => Assert.Contains(import, Own(op!)));
        Assert.DoesNotContain(import, string.Join("\n", ops.SelectMany(op => Styles(op!).Where(s => s.Theme).Select(s => s.Css))));
    }

    [Fact]
    public void RemovingAnExistingThemeCopyMustRespectLaterCompetingThemeRules()
    {
        const string rule = ".a{color:red}";
        var ops = Documents("<style scope=\"theme\" id=\"base\">" + rule + ".b{color:blue}</style><style>" + rule + "</style>");
        Normalize(ops);
        Assert.Contains(rule, Own(ops[0]!));
    }

    [Fact]
    public void AnUnnamedThemePartCannotOverrideARuleMovedAheadOfIt()
    {
        const string rule = ".a{color:red}";
        var ops = Documents("<style scope=\"theme\">.b{color:blue}</style><style>" + rule + "</style>",
            "<style>" + rule + "</style>");
        Normalize(ops);
        // The generated part is installed before the existing unnamed part. The local copy must still win for .a.b.
        Assert.Contains(rule, Own(ops[0]!));
    }

    [Fact]
    public void AReplacedNamedPartDoesNotSupplyRulesOfItsPreviousVersion()
    {
        const string rule = ".a{color:red}";
        var ops = Documents("<style scope=\"theme\" id=\"base\">" + rule + "</style>",
            "<style scope=\"theme\" id=\"base\">.b{color:blue}</style><style>" + rule + "</style>");
        Normalize(ops);
        Assert.Contains(rule, Own(ops[1]!));
    }

    [Fact]
    public void EscapedNewlinesDoNotEraseSignificantStringWhitespaceFromRuleKeys()
    {
        var spaced = ".a{content:\"x\\\n  y\"}";
        var unspaced = ".a{content:\"x\\\ny\"}";
        Assert.NotEqual(CssStylesheet.SharedRuleKey(spaced), CssStylesheet.SharedRuleKey(unspaced));
    }

    [Theory]
    [InlineData(":not(.excluded){color:red}")]
    [InlineData(":is(.a,body){margin:0}")]
    [InlineData(":where(.a,h1){padding:0}")]
    public void SelectorsWithAnUnanchoredBranchRemainLocal(string rule)
    {
        var ops = Documents("<style>" + rule + "</style>", "<style>" + rule + "</style>");
        Normalize(ops);
        Assert.All(ops, op => Assert.Contains(rule, Own(op!)));
    }

    [Theory]
    [InlineData(".a,.\\62 {color:red}", "b")]
    [InlineData(".a,.💠{color:red}", "💠")]
    public void NonliteralAnchorsCannotBypassAnotherDocumentsReachGuard(string rule, string className)
    {
        var ops = Documents("<style>" + rule + "</style>", "<style>" + rule + "</style>");
        ops.Add(new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
            ["html"] = $"<screen name=\"Other\"><div class=\"{className}\">x</div></screen>" } });
        var before = ops.ToJsonString();
        Normalize(ops);
        Assert.Equal(before, ops.ToJsonString());
    }
    private static JsonArray Documents(params string[] styles) => new(styles.Select((css, i) => (JsonNode)new JsonObject
    {
        ["op"] = "html", ["data"] = new JsonObject { ["html"] = $"<screen name=\"Safety{i}\">{css}<div class=\"a b\">x</div></screen>" }
    }).ToArray());

    private static List<ScreenDocument.StyleBlock> Styles(JsonNode op) => ScreenDocument.Styles(
        ScreenHtml.Parse(op["data"]!["html"]!.ToString()).Children.First(n => !n.IsText));

    private static string Own(JsonNode op) => ScreenDocument.OwnSheet(Styles(op), null) ?? "";
    private static void Normalize(JsonArray ops) => SharedStyleNormalizer.Normalize(ops, "/ops", []);
}
