using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.PreflightRules;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// T18 reproduction, written against the APIs that existed before the fix (codes as text): the Traditional migration's theme
/// (a whole theme of 105-111 KB resent ten times) carried a font of another module from the environment host and selectors on
/// generated widget ids, and no check said so; and there was no op to change one rule without resending the sheet.
/// </summary>
public sealed class CssPathReproTests
{
    private const string Theme = """
        :root { --color-primary: #2e86c1; }
        @font-face { font-family: Icons; src: url("https://tenant-dev.outsystemscloud.com/LegacyPortal/fonts/icons.woff2?x1") format("woff2"); }
        .app-login-info > div[id$="Div14"] { display: contents; }
        .card { padding: 8px; }
        """;

    [Fact]
    public void TheThemeOfTheMigrationIsJudgedOnEveryPath()
    {
        var job = new JsonArray(new JsonObject { ["op"] = "set", ["target"] = "IMobileTheme:Portal", ["prop"] = "StyleSheet", ["value"] = Theme });
        var codes = StyleSheetRules.Check(job, "o11").Select(p => p["code"]!.ToString() + ":" + p["severity"]).ToList();
        // A whole sheet may hold what the element already has: judged at apply (only what the write brings is an error).
        Assert.Contains("CSS_ENV_URL:warning", codes);
        Assert.Contains("CSS_GENERATED_ID_SELECTOR:warning", codes);
        Assert.Contains("CSS_DISPLAY_CONTENTS:warning", codes);
    }

    [Fact]
    public void OneRuleChangesWithoutResendingTheSheet()
    {
        var op = JsonNode.Parse("""{"op":"css","target":"IMobileTheme:Portal","basedOn":"00","edits":[{"replaceRule":".card","body":"padding:12px"}]}""")!.AsObject();
        VerbSurface.Check(op);   // before T18: unknown op: css
        Assert.Contains("css", VerbSurface.Names);
    }
}
