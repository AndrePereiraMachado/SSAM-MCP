using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Anvil.Core.PreflightRules;
using Xunit;
namespace Anvil.Tests;

/// <summary>The CSS loss guards of StyleSheetRules (docs/PROTOTIPO-NATIVO.md 4.3, lane css), on the real case: call 88 of
/// 2026-10-10 corrected the html op of job 79 (cc36c64b) with <c>css.replace(/@import[^\n]*\n/,"")</c>; the @import shared the
/// first line with 271 rules and the 12 custom properties, and the job 88 (0f7ceafe) carried the CSS without them, accepted
/// without a word. Now the corrected job against the job it corrects is CSS_RULES_DROPPED with 271 rules and the patch that
/// restores them, and the corrected job alone warns CSS_VAR_UNDEFINED with the names it reads and no longer defines.</summary>
public class StyleSheetLossTests
{
    // sha256 of the data.css of the html op #202 of job 0f7ceafe (call 88), read from the replayed job.
    private const string Call88Sha256 = "a8ddf081b7eaf917c71bae045018378f2fc16623459d596e38e794c1fb240f69";

    private static string Call79() => File.ReadAllText(Path.Combine(PrototypeCssTests.Fixtures, "call79-html-css.css"));

    // What the model did in call 88 (the JavaScript replace replaces the first match).
    private static string Call88(string call79) => new Regex("@import[^\n]*\n").Replace(call79, "", 1);

    private static JsonArray Job(string css) => new(new JsonObject
    {
        ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "FarmaVirtual", ["html"] = "<div class=\"fv-prototype\"></div>", ["css"] = css },
    });

    [Fact]
    public void TheCall88PatchIsRulesDroppedWith271RulesAndTheRestoringPatch()
    {
        var call79 = Call79();
        var call88 = Call88(call79);
        Assert.Equal(Call88Sha256, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(call88))).ToLowerInvariant());   // the real job's CSS
        var problems = StyleSheetRules.CheckPatched(Job(call79), Job(call88), "o11").ToList();
        var problem = Assert.Single(problems);
        Assert.Equal("CSS_RULES_DROPPED", problem["code"]!.ToString());
        Assert.Equal("error", problem["severity"]!.ToString());
        Assert.Equal("/ops/0/data/css", problem["pointer"]!.ToString());
        Assert.Equal(271, problem["dropped"]!.GetValue<int>());
        var lost = problem["lostCustomProperties"]!.AsArray().Select(x => x!.ToString()).ToList();
        Assert.Equal(12, lost.Count);
        foreach (var name in new[] { "--green", "--text", "--line", "--shadow" }) Assert.Contains(name, lost);
        Assert.Contains($"without its first {call79.Length - call88.Length} characters", problem["message"]!.ToString());
        var patch = Assert.Single(problem["patch"]!.AsArray())!;
        Assert.Equal("replace", patch["op"]!.ToString());
        Assert.Equal("/ops/0/data/css", patch["path"]!.ToString());
        Assert.Equal(call79, patch["value"]!.ToString());
    }

    [Fact]
    public void RemovingOnlyTheImportDropsNoRule()
    {
        var call79 = Call79();
        var (_, others) = CssCompat.Imports(call79);
        Assert.Empty(StyleSheetRules.CheckPatched(Job(call79), Job(others), "o11"));
        Assert.Empty(StyleSheetRules.CheckPatched(Job(call79), Job(call79 + "\n.extra{color:red}"), "o11"));
        // A set StyleSheet at the same pointer is compared the same way.
        JsonArray Set(string css) => new(new JsonObject { ["op"] = "set", ["target"] = "IMobileTheme:T", ["prop"] = "StyleSheet", ["value"] = css });
        var dropped = Assert.Single(StyleSheetRules.CheckPatched(Set(".a{b:c}.d{e:f}"), Set(".a{b:c}"), "o11"));
        Assert.Equal(1, dropped["dropped"]!.GetValue<int>());
        Assert.Equal("/ops/0/value", dropped["pointer"]!.ToString());
    }

    [Fact]
    public void AnUndefinedCustomPropertyIsAWarningWithItsName()
    {
        var call88 = Call88(Call79());
        var warning = StyleSheetRules.Check(Job(call88), "o11").Single(p => p["code"]!.ToString() == "CSS_VAR_UNDEFINED");
        Assert.Equal("warning", warning["severity"]!.ToString());
        var names = warning["names"]!.AsArray().Select(x => x!.ToString()).ToList();
        foreach (var name in new[] { "--green", "--line", "--shadow", "--text" }) Assert.Contains(name, names);
        Assert.Contains("var(--green)", warning["message"]!.ToString());
        // The job that still defines them, a fallback and the OutSystems UI tokens are no warning.
        Assert.DoesNotContain(StyleSheetRules.Check(Job(Call79()), "o11"), p => p["code"]!.ToString() == "CSS_VAR_UNDEFINED");
        Assert.DoesNotContain(StyleSheetRules.Check(Job(".a{color:var(--green, #18765c);border-color:var(--color-primary)}"), "o11"), p => p["code"]!.ToString() == "CSS_VAR_UNDEFINED");
        // Defined by another CSS of the same job: no warning.
        var two = Job(".a{color:var(--x)}");
        two.Add(new JsonObject { ["op"] = "set", ["target"] = "IMobileTheme:T", ["prop"] = "StyleSheet", ["value"] = ":root{--x:red}" });
        Assert.DoesNotContain(StyleSheetRules.Check(two, "o11"), p => p["code"]!.ToString() == "CSS_VAR_UNDEFINED");
        var simple = Assert.Single(StyleSheetRules.Check(Job(".a{color:var(--green)}"), "o11"));
        Assert.Equal("/ops/0/data/css", simple["pointer"]!.ToString());
    }

    [Fact]
    public void TheJobPreflightRunsTheVarWarningAsAPluggableRule()
    {
        Assert.Contains(typeof(StyleSheetRules), JobPreflight.DiscoveredRules);
    }
}
