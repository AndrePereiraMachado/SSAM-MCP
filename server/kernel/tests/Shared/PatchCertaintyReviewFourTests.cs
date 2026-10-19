using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

/// <summary>The two lows of the X3 review 4 (C:\t\revisoes\x3-4\REVISAO.md), fixed in the marco-a6 integration.
/// R1b: an html op in the expander's page form (data.screen with a whole HTML page in data.html) is a valid op and no
/// ssam-html document; the literal scope reads the names the expander creates from it, never "the job could not be read".
/// I1: a served certainty reason never names a kernel type (licensed mode serves no internal names).</summary>
public sealed class PatchCertaintyReviewFourTests
{
    private const string PageHtml = "<!doctype html>\n<html lang=\"pt-BR\">\n<head>\n<meta charset=\"utf-8\">\n<title>Visão geral</title>\n"
        + "<style>\n.mix > .banner { color: #333 }\n</style>\n</head>\n<body>\n<div class=\"mix\"><div class=\"banner\" data-av=\"banner\">Destaques</div>"
        + "<div id=\"ResultList\">Resultados</div></div>\n</body>\n</html>";

    private static JsonObject PageOp(string screen) => new() { ["op"] = "html", ["data"] = new JsonObject {
        ["screen"] = screen, ["title"] = "Visão geral", ["layout"] = "blank", ["html"] = PageHtml } };

    private static HashSet<string>? LiteralJobNames(params JsonObject[] ops)
    {
        var method = typeof(Anvil.Core.ModelSession).GetMethod("LiteralJobNames", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);
        Assert.NotNull(method);
        return (HashSet<string>?)method!.Invoke(null, [new JsonArray(ops.Select(o => (JsonNode)o).ToArray())]);
    }

    [Fact]
    public void ThePageFormOfTheExpanderIsReadableAndDeclaresTheNamesItCreates()
    {
        var names = LiteralJobNames(PageOp("MixPage"));
        Assert.NotNull(names);
        Assert.Contains("MixPage", names!);
        Assert.Contains("Banner", names!);
    }

    [Fact]
    public void AnSsamHtmlDocumentNextToThePageFormStaysReadable()
    {
        var names = LiteralJobNames(PageOp("MixPage"), PatchCertaintyJobProbe.Screen("MixProbe", "MixFlow",
            "<var name='MixValue' type='Text'/><input bind='MixValue' placeholder=\"Buscar por nome\"/>"));
        Assert.NotNull(names);
        Assert.Contains("MixValue", names!);
        Assert.Contains("Banner", names!);
    }

    /// <summary>The review's repro (inputs\x-mixed.json), small: a page-form op in the same job as a document whose literal is
    /// neutral prose. The literal is the certain TEXT_LITERAL_QUOTED, as without the page op, never a choice.</summary>
    [Fact]
    public void ALiteralOfADocumentNextToThePageFormIsACertainLiteral()
    {
        var (result, _) = PatchCertaintyJobProbe.Run("page-form-scope", PatchCertaintyJobProbe.Flow("MixFlow"), PageOp("MixPage"),
            PatchCertaintyJobProbe.Screen("MixProbe", "MixFlow", "<var name='MixValue' type='Text'/><input bind='MixValue' placeholder=\"Buscar por nome\"/>"));
        var literals = (result["patchesApplied"] as JsonArray ?? []).Concat(result["problems"] as JsonArray ?? []).OfType<JsonObject>()
            .Where(p => p["patchRule"]?.ToString() is "TEXT_LITERAL_QUOTED" or "TEXT_LITERAL_CHOICE").ToList();
        Assert.True(literals.Count > 0, result.ToJsonString());
        Assert.All(literals, p => Assert.Equal("TEXT_LITERAL_QUOTED", p["patchRule"]?.ToString()));
    }

    [Fact]
    public void AnSsamHtmlDocumentThatDoesNotParseStillMakesTheScopeUnreadable()
        => Assert.Null(LiteralJobNames(PatchCertaintyJobProbe.Screen("Broken", "MixFlow", "<input bind='X' placeholder=\"a\"")));

    [Fact]
    public void NoCertaintyReasonNamesAKernelType()
    {
        var types = typeof(PatchCertainty).Assembly.GetTypes().Select(t => t.Name.Split('`')[0])
            .Where(n => n.Length > 3 && char.IsUpper(n[0]) && n.Skip(1).Any(char.IsUpper) && n.Any(char.IsLower)).ToHashSet(StringComparer.Ordinal);
        var reasons = PatchCertainty.Rules.Select(r => (Rule: r.Key, r.Value.Reason)).Append(("unknown", PatchCertainty.UnknownReason));
        foreach (var (rule, reason) in reasons) {
            var named = Regex.Matches(reason, @"\b[A-Z][A-Za-z0-9]*\b").Select(m => m.Value).Where(types.Contains).Distinct().ToList();
            Assert.True(named.Count == 0, rule + " names kernel types: " + string.Join(", ", named) + " in \"" + reason + "\"");
            Assert.DoesNotMatch(@"\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\.[A-Z][A-Za-z0-9]*\b", reason);
        }
    }
}
