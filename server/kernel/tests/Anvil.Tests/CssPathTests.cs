using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.PreflightRules;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// T18, pure half (no model): the keyed css edit engine, the one normalization and its extension point, the hygiene lints with
/// the same verdict on every write path (a generated sweep: every code of the pipeline's table on every path), and the token
/// rule of HTML_THEME_TOKEN_SCOPED.
/// </summary>
public sealed class CssPathTests
{
    // ---- the edit engine ------------------------------------------------------------------------------------------

    private static JsonArray Edits(string json) => JsonNode.Parse(json)!.AsArray();

    [Fact]
    public void AppendReplaceDeleteAndFindApplyInOrderOnTheText()
    {
        const string css = ".a { color: red; }\n.b , .c { margin: 0 }\n@media (max-width: 767px) {\n  .a { color: blue; }\n}\n.d{x:y}\n";
        var plan = CssEdits.Apply(css, Edits("""
            [{"replaceRule":".b,.c","body":"margin: 4px"},
             {"deleteRule":".d"},
             {"replaceRule":".a","in":"@media (max-width:767px)","body":"color: green"},
             {"find":"color: red","with":"color: #222"},
             {"append":".e { padding: 1px; }"}]
            """));
        Assert.Empty(plan.Problems);
        Assert.Equal(".a { color: #222; }\n.b , .c { margin: 4px }\n@media (max-width: 767px) {\n  .a { color: green }\n}\n.e { padding: 1px; }\n", plan.Css);
        Assert.All(plan.Applied, a => Assert.True(a["applied"]!.GetValue<bool>()));
    }

    [Fact]
    public void ReplaceRuleNeverMovesOrMergesRules()
    {
        const string css = ".x{a:1}\n.y{b:2}\n.x{a:3;c:4}\n";
        var plan = CssEdits.Apply(css, Edits("""[{"replaceRule":".x","body":"a:5"}]"""));
        Assert.Equal(CssEdits.Ambiguous, Assert.Single(plan.Problems)["code"]!.ToString());
        Assert.Equal(css, plan.Css);
        var first = CssEdits.Apply(css, Edits("""[{"deleteRule":".x","nth":1}]"""));
        Assert.Equal(".y{b:2}\n.x{a:3;c:4}\n", first.Css);
    }

    [Fact]
    public void EveryProblemOfTheEditsIsSaidAtOnceWithTheElementAndTheNextCall()
    {
        const string css = ".a{color:red}\n.a2{color:red}\n";
        var plan = CssEdits.Apply(css, Edits("""
            [{"replaceRule":".missing","body":"x:y"},
             {"find":"color:red","with":"color:blue"},
             {"find":"color : red","with":"z"},
             {"deleteRule":".a","body":"x"},
             {"append":".ok{}"}]
            """), "/ops/3");
        var codes = plan.Problems.Select(p => p["code"]!.ToString()).ToList();
        Assert.Equal([CssEdits.NotFound, CssEdits.FindAmbiguous, CssEdits.FindNotFound, CssEdits.Invalid], codes);
        Assert.All(plan.Problems, p => { Assert.StartsWith("/ops/3/edits/", p["pointer"]!.ToString()); Assert.False(string.IsNullOrWhiteSpace(p["fix"]?.ToString())); });
        Assert.Contains("lines 1, 2", plan.Problems[1]["message"]!.ToString());
        // the edits that apply still apply (the append), so a THEME_CHANGED refusal can say which do
        Assert.True(plan.Applied[4]["applied"]!.GetValue<bool>());
    }

    [Fact]
    public void TheEditShapeIsClosed()
    {
        Assert.Null(CssEdits.Shape(JsonNode.Parse("""{"append":".a{}"}""")!.AsObject()));
        Assert.Contains("more than one action", CssEdits.Shape(JsonNode.Parse("""{"append":".a{}","find":"x","with":"y"}""")!.AsObject()));
        Assert.Contains("needs body", CssEdits.Shape(JsonNode.Parse("""{"replaceRule":".a"}""")!.AsObject()));
        Assert.Contains("unknown key", CssEdits.Shape(JsonNode.Parse("""{"deleteRule":".a","with":"x"}""")!.AsObject()));
        Assert.Contains("no action", CssEdits.Shape(JsonNode.Parse("""{"body":"x"}""")!.AsObject()));
    }

    [Fact]
    public void TheRuleSpansSeeThroughCommentsStringsAndNestedAtRules()
    {
        const string css = "/* .fake{} */ .a{content:\"}\"}\n@supports (display:grid){ @media print { .b{c:d} } }\n@font-face{font-family:x}\n";
        var rules = CssEdits.Rules(css);
        Assert.Equal([".a", ".b"], rules.Select(r => r.Normal));
        Assert.Equal("@supports (display:grid) @media print", rules[1].Context);
    }

    // ---- the one normalization and its extension point ----------------------------------------------------------

    [Fact]
    public void TheNormalizationHoistsImportsOnceAndSelectsInTheCanvas()
    {
        const string imp = "@import url(\"https://fonts.googleapis.com/css2?family=Inter\");";
        Assert.False(CssPipeline.Normalize("#reactContainer .x{y:z}", new("test")).Changed);   // never unasked
        var outcome = CssPipeline.Normalize(".a{b:c}\n" + imp + "\n#reactContainer .x{y:z}\n" + imp + "\n", new("test"), canvas: true);
        Assert.True(outcome.Changed);
        Assert.StartsWith(imp + "\n.a{b:c}", outcome.Css);
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(outcome.Css, "@import"));
        Assert.Contains(":is(#reactContainer, body) .x", outcome.Css);
        Assert.Equal(1, outcome.ImportsMerged);
        // Idempotent: a second pass changes nothing (every path settles the same text the same way).
        Assert.False(CssPipeline.Normalize(outcome.Css, new("test"), canvas: true).Changed);
        // The verbatim write keeps #reactContainer.
        Assert.Contains("#reactContainer .x", CssPipeline.Normalize("#reactContainer .x{y:z}", new("test"), canvas: false).Css);
    }

    [Fact]
    public void ARegisteredStageRunsOnEveryWriteAndAThrowingOneIsSkipped()
    {
        try
        {
            CssPipeline.Register("t18-test-rename", (css, _, changes) => { changes.Add(new JsonObject { ["stage"] = "t18-test-rename" }); return css.Replace(".legacy-", ".new-"); },
                (css, _) => css.Contains(".forbidden") ? [new CssPipeline.Finding("CSS_TEST_STAGE", "warning", 1, ".forbidden", "test", "test")] : []);
            CssPipeline.Register("t18-test-throws", (_, _, _) => throw new InvalidOperationException("boom"), (_, _) => throw new InvalidOperationException("boom"));
            var outcome = CssPipeline.Normalize(".legacy-a{b:c}", new("test"));
            Assert.Equal(".new-a{b:c}", outcome.Css);
            Assert.Contains(outcome.StageChanges, c => c["skipped"]?.GetValue<bool>() == true && !c.ToJsonString().Contains("boom"));
            Assert.Contains(CssPipeline.Lint(".forbidden{a:b}", new("test")), f => f.Code == "CSS_TEST_STAGE");
            // The stage reaches the preflight of every path.
            var job = new JsonArray(new JsonObject { ["op"] = "set", ["target"] = "IMobileTheme:T", ["prop"] = "StyleSheet", ["value"] = ".forbidden{a:b}" });
            Assert.Contains(StyleSheetRules.Check(job, "odc"), p => p["code"]!.ToString() == "CSS_TEST_STAGE");
        }
        finally { CssPipeline.Unregister("t18-test-rename"); CssPipeline.Unregister("t18-test-throws"); }
    }

    // ---- the lints ------------------------------------------------------------------------------------------------

    /// <summary>One CSS that each code of the pipeline's table must find, and one close to it that it must not.</summary>
    private static readonly Dictionary<string, (string Finds, string Passes)> Samples = new()
    {
        [CssPipeline.EnvUrl] = ("@font-face{font-family:I;src:url(\"https://acme-dev.outsystemscloud.com/Legacy/fonts/i.woff2\")}",
                                "@font-face{font-family:I;src:url(\"https://fonts.gstatic.com/s/i.woff2\")}"),
        [CssPipeline.GeneratedIdSelector] = (".bar > div[id$=\"Div14\"]{padding:0}", ".bar > div[id$=\"AvatarBox\"]{padding:0}"),
        [CssPipeline.ImportantFlood] = ("table > tbody{width:auto!important}", ".grid table > tbody{width:auto!important}"),
        [CssPipeline.DisplayContents] = ("[data-block=\"MainFlow.Layout\"]{display:contents}", ".chip-group{display:contents}"),
        [CssPipeline.DeadSelector] = (".gone{}", ".kept{color:red}"),
        [CssPipeline.DuplicateRule] = (".twice{color:red}\n.twice{margin:0}", ".once{color:red}\n.other{margin:0}"),
        [CssPipeline.VarRedefined] = (":root{--brand:#111}\n:root{--brand:#222}", ":root{--brand:#111}\n[data-theme=dark]{--brand:#222}"),
    };

    [Fact]
    public void EachLintFindsItsCaseAndNotTheCaseBesideIt()
    {
        Assert.Equal(CssPipeline.Codes.Keys.Order(), Samples.Keys.Order());
        foreach (var (code, (finds, passes)) in Samples)
        {
            var found = CssPipeline.Lint(finds, new("test"));
            var f = Assert.Single(found, x => x.Code == code);
            Assert.Equal(CssPipeline.Codes[code], f.Severity);
            Assert.False(string.IsNullOrWhiteSpace(f.Fix));
            Assert.DoesNotContain(CssPipeline.Lint(passes, new("test")), x => x.Code == code);
        }
    }

    [Fact]
    public void AnEnvironmentUrlComesWithThePatchThatDropsTheHost()
    {
        var css = Samples[CssPipeline.EnvUrl].Finds;
        var found = CssPipeline.Lint(css, new("test")).Where(x => x.Code == CssPipeline.EnvUrl).ToList();
        var written = CssPipeline.WithoutHosts(css, found);
        Assert.Contains("url(\"/Legacy/fonts/i.woff2\")", written);
        // A path of the module without the host is never flagged.
        Assert.DoesNotContain(CssPipeline.Lint(written, new("test")), x => x.Code == CssPipeline.EnvUrl);
    }

    [Fact]
    public void TheImportantFloodCountsFromItsThreshold()
    {
        var many = string.Join("\n", Enumerable.Range(0, CssPipeline.ImportantFloodAt).Select(i => $".c{i}{{margin:0!important}}"));
        Assert.Contains(CssPipeline.Lint(many, new("test")), f => f.Code == CssPipeline.ImportantFlood);
        Assert.DoesNotContain(CssPipeline.Lint(string.Join("\n", many.Split('\n').Skip(1)), new("test")), f => f.Code == CssPipeline.ImportantFlood);
    }

    // ---- generated sweep: every code on every write path gives the same verdict --------------------------------------

    /// <summary>The write paths of a stylesheet, each as the op that carries the CSS (the paths of StyleSheetRules.Texts).</summary>
    private static readonly (string Path, Func<string, JsonObject> Op)[] Paths =
    [
        ("set theme", css => Set("IMobileTheme:App", css)),
        ("set web theme", css => Set("IWebTheme:App", css)),
        ("set screen", css => Set("IMobileScreen:Home", css)),
        ("set block", css => Set("IWebBlock:Menu", css)),
        ("html <style>", css => new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen name=\"Home\">\n<style scope=\"theme\">\n" + css + "\n</style>\n<div class=\"card\">x</div>\n</screen>" } }),
        ("html fragment <style>", css => new JsonObject { ["op"] = "html", ["parent"] = "IMobileScreen:Home", ["html"] = "<div><style>" + css + "</style></div>" }),
        ("html data.css", css => new JsonObject { ["op"] = "html-visual", ["data"] = new JsonObject { ["css"] = css } }),
        ("css append", css => new JsonObject { ["op"] = "css", ["target"] = "IMobileTheme:App", ["basedOn"] = new string('0', 64), ["edits"] = new JsonArray(new JsonObject { ["append"] = css }) }),
    ];

    private static JsonObject Set(string target, string css) => new() { ["op"] = "set", ["target"] = target, ["prop"] = "StyleSheet", ["value"] = css };

    [Fact]
    public void EveryCodeOnEveryPathGivesTheSameVerdict()
    {
        var cases = 0;
        foreach (var code in CssPipeline.Codes.Keys)
        {
            var (finds, passes) = Samples[code];
            var verdicts = new List<string>();
            foreach (var (path, op) in Paths)
            {
                var found = StyleSheetRules.Check(new JsonArray(op(finds)), "odc").Where(p => p["code"]!.ToString() == code).ToList();
                var problem = Assert.Single(found);
                Assert.Equal(0, problem["op"]!.GetValue<int>());
                Assert.True(problem["line"]!.GetValue<int>() >= 1, path);
                // An absolute environment url is an error only where the job certainly brings it (the CSS a css op adds); in a
                // whole sheet the element may already have it (judged at apply). Every other code: the same severity everywhere.
                var expected = code == CssPipeline.EnvUrl && path != "css append" ? "warning" : CssPipeline.Codes[code];
                Assert.Equal(expected, problem["severity"]!.ToString());
                verdicts.Add(code + ":" + (code == CssPipeline.EnvUrl ? CssPipeline.Codes[code] : problem["severity"]));
                Assert.DoesNotContain(StyleSheetRules.Check(new JsonArray(op(passes)), "o11"), p => p["code"]!.ToString() == code);
                cases++;
            }
            Assert.Single(verdicts.Distinct());
            Assert.Equal(code + ":" + CssPipeline.Codes[code], verdicts[0]);
        }
        Assert.Equal(CssPipeline.Codes.Count * Paths.Length, cases);
        // A replaceRule is judged on what it adds (its declarations), never on the selector the sheet already has.
        var body = new JsonObject { ["op"] = "css", ["target"] = "IWebBlock:Menu", ["basedOn"] = new string('0', 64), ["edits"] = new JsonArray(new JsonObject { ["replaceRule"] = "[data-block=\"MainFlow.Layout\"] > div[id$=\"Div3\"]", ["body"] = "background:url(\"https://acme-dev.outsystemscloud.com/M/img/a.png\")" }) };
        var judged = StyleSheetRules.Check(new JsonArray(body), "o11").ToList();
        Assert.Contains(judged, p => p["code"]!.ToString() == CssPipeline.EnvUrl && p["severity"]!.ToString() == "error" && p["pointer"]!.ToString() == "/ops/0/edits/0/body");
        Assert.DoesNotContain(judged, p => p["code"]!.ToString() == CssPipeline.GeneratedIdSelector);
    }

    [Fact]
    public void TheLineOfAFindingIsTheLineOfTheJobText()
    {
        var html = "<screen name=\"Home\">\n<div>a</div>\n<style scope=\"theme\">\n.ok{a:b}\n.gone{}\n</style>\n</screen>";
        var problem = StyleSheetRules.Check(new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } }), "odc").Single(p => p["code"]!.ToString() == CssPipeline.DeadSelector);
        Assert.Equal(5, problem["line"]!.GetValue<int>());
        Assert.Equal("/ops/0/data/html", problem["pointer"]!.ToString());
    }

    [Fact]
    public void TheCssOpShapeIsCheckedBeforeAnyBuild()
    {
        var job = JsonNode.Parse("""
            [{"op":"css","target":"IMobileTheme:App","basedOn":"abc","edits":[{"append":".a{}","find":"x"},{"replaceRule":".b"}]},
             {"op":"css","target":"IMobileTheme:App","edits":[]}]
            """)!.AsArray();
        var problems = StyleSheetRules.Check(job, "odc").Where(p => p["severity"]!.ToString() == "error").Select(p => p["code"] + "@" + p["pointer"]).ToList();
        Assert.Contains($"{CssEdits.Invalid}@/ops/0/edits/0", problems);
        Assert.Contains($"{CssEdits.Invalid}@/ops/0/edits/1", problems);
        Assert.Contains("CSS_BASED_ON_INVALID@/ops/0/basedOn", problems);
        Assert.Contains($"{CssEdits.Invalid}@/ops/1/edits", problems);
    }

    [Fact]
    public void TheCssOpIsAVerbOfTheContractAndAStylesheetWriteForF1()
    {
        VerbSurface.Check(JsonNode.Parse("""{"op":"css","target":"IMobileTheme:App","basedOn":"00","edits":[]}""")!.AsObject());
        Assert.Contains("unknown key(s) 'value'", Assert.Throws<InvalidOperationException>(() => VerbSurface.Check(JsonNode.Parse("""{"op":"css","target":"T","edits":[],"value":"x"}""")!.AsObject())).Message);
        VerbSurface.Check(JsonNode.Parse("""{"op":"set","target":"T","prop":"StyleSheet","value":"","basedOn":"00"}""")!.AsObject());
        Assert.True(StyleSheetTouch.Writes(new JsonArray(JsonNode.Parse("""{"op":"css","target":"T","edits":[]}"""))));
    }

    [Fact]
    public void TheAppendOfACssOpTakesTheSameColorNormalizationAsASet()
    {
        var job = JsonNode.Parse("""[{"op":"css","target":"IMobileTheme:App","basedOn":"00","edits":[{"append":".a{color:light-dark(#111,#eee)}"}]}]""")!.AsArray();
        var done = new List<JsonObject>();
        Anvil.Core.Preflight.StyleSheetNormalizer.Normalize(job, "/ops", done);
        var appended = job[0]!["edits"]![0]!["append"]!.ToString();
        Assert.DoesNotContain("light-dark", appended);
        Assert.Contains("prefers-color-scheme: dark", appended);
        Assert.Contains(done, d => d["rule"]?.ToString() == Anvil.Core.Preflight.StyleSheetNormalizer.Rule || d.ToJsonString().Contains(Anvil.Core.Preflight.StyleSheetNormalizer.Rule));
    }

    [Fact]
    public void TheBasedOnIsTheSha256OfTheAuthorCssInEitherLineBreak()
    {
        const string css = ".a{b:c}\r\n.d{e:f}";
        var hash = ThemeCss.Sha256(css);
        Assert.Matches("^[0-9a-f]{64}$", hash);
        Assert.True(ThemeCss.Matches(hash, css));
        Assert.True(ThemeCss.Matches(ThemeCss.Sha256(css.Replace("\r\n", "\n")), css));
        Assert.False(ThemeCss.Matches(ThemeCss.Sha256(css + " "), css));
        Assert.False(ThemeCss.Matches(null, css));
    }

    /// <summary>The theme of the migration that motivated T18 (a private capture, never in the repo): set T18_THEME_CASE to its
    /// path. Does nothing when unset.</summary>
    [Fact]
    public void TheCapturedMigrationThemeIsJudgedByEveryCode()
    {
        var path = Environment.GetEnvironmentVariable("T18_THEME_CASE");
        if (string.IsNullOrEmpty(path) || !File.Exists(path)) return;
        var css = File.ReadAllText(path);
        var found = StyleSheetRules.Check(new JsonArray(Set("IMobileTheme:Portal", css)), "o11").Select(p => p["code"]!.ToString()).ToHashSet();
        foreach (var code in new[] { CssPipeline.EnvUrl, CssPipeline.GeneratedIdSelector, CssPipeline.ImportantFlood, CssPipeline.DisplayContents, CssPipeline.VarRedefined })
            Assert.Contains(code, found);
        // Every captured theme of the folder sent whole again: what it already holds is never an error before the build.
        foreach (var file in Directory.GetFiles(Path.GetDirectoryName(path)!, "*.css"))
            Assert.DoesNotContain(StyleSheetRules.Check(new JsonArray(Set("IMobileTheme:Portal", File.ReadAllText(file))), "o11"), p => p["severity"]!.ToString() == "error");
        // The same theme through the css op: the whole sheet need not travel; a rule changes alone.
        var rules = CssEdits.Rules(css);
        var rule = rules.First(r => r.Context == null && r.Normal.StartsWith('.') && !r.HasNested && rules.Count(o => o.Normal == r.Normal && o.Context == null) == 1);
        var plan = CssEdits.Apply(css, Edits($$"""[{"replaceRule":{{System.Text.Json.JsonSerializer.Serialize(rule.Selector)}},"body":"outline:0"}]"""));
        Assert.Empty(plan.Problems);
        Assert.Equal(rules.Count, CssEdits.Rules(plan.Css).Count);   // in place: no rule moved, none merged
        // The whole theme sent again over itself brings no offender: nothing of it is an error.
        Assert.Empty(CssPipeline.Introduced(css, css, new("test")));
    }

    // ---- HTML_THEME_TOKEN_SCOPED -------------------------------------------------------------------------------

    private static CssRule Rule(string css) => CssStylesheet.Parse(css).Rules[0];

    [Fact]
    public void ATokenUnderTheWholePageOrABodyStateIsNotScoped()
    {
        foreach (var css in new[] { "body{--color-primary:#123}", ":is(#reactContainer, body){--color-primary:#123}", ".phone{--header-size:48px}", "body.tablet.landscape{--space-m:8px}" })
            Assert.True(ScreenVisual.TokenScopeIsIntended(Rule(css), css), css);
        foreach (var css in new[] { ".card{--color-primary:#123}", ".phone .card{--color-primary:#123}", "main{--space-m:8px}" })
            Assert.False(ScreenVisual.TokenScopeIsIntended(Rule(css), css), css);
    }

    [Fact]
    public void ARuleByteEqualToTheInstalledBaseIsTheBasesOwn()
    {
        const string rule = ".layout-native .header{--header-size:56px}";
        Assert.False(ScreenVisual.TokenScopeIsIntended(Rule(rule), rule));
        var keys = ScreenVisual.BaseRuleKeys([":root{--color-primary:#1068eb}\n" + rule + "\n.x{color:red}"]);
        Assert.True(ScreenVisual.TokenScopeIsIntended(Rule(rule), rule, keys));
        // per page: another page (no base) still says it; a copy with another value is the author's: still news
        Assert.False(ScreenVisual.TokenScopeIsIntended(Rule(rule), rule));
        const string changed = ".layout-native .header{--header-size:60px}";
        Assert.False(ScreenVisual.TokenScopeIsIntended(Rule(changed), changed, keys));
    }
}
