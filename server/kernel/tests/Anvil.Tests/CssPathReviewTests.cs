using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.PreflightRules;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// T18 correction round: one test per finding of the review of 95d2047d, written against what both commits expose, so each
/// fails there and passes after. The owner's rule: a normalization never changes what the CSS selects nor the cascade; it
/// changes bytes only where the meaning is provably the same, else it leaves the text and at most warns. An existing offender
/// is never an error: only what a write brings.
/// </summary>
public sealed class CssPathReviewTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(CssPathReviewTests).Assembly.Location)!)!;
    private const string Font = "@import url(\"https://fonts.googleapis.com/css2?family=Inter\");";
    private const string EnvA = "https://acme-dev.outsystemscloud.com/LegacyPortal/img/a.png";
    private const string EnvB = "https://acme-dev.outsystemscloud.com/LegacyPortal/img/b.png";

    // ---- 1 (critical): the document form writes its <style> as given, and the reading comes back -------------------------

    public static TheoryData<string, string> OwnStyles => new()
    {
        { "rc", "#reactContainer .rv-x{color:red}" },
        { "rcchild", "#reactContainer > div{min-height:10px}\n.rv-x{color:red}" },
        { "imp", ".rv-x{color:red}\n" + Font },
        { "dupimp", Font + "\n.rv-x{color:red}\n" + Font },
    };

    [Theory]
    [MemberData(nameof(OwnStyles))]
    public void TheDocumentFormWritesItsStyleAndTheReadingComesBackAccepted(string name, string css)
    {
        if (!StudioAvailable()) return;
        var (host, work) = Host("own-style-" + name);
        var screen = "T18Own" + char.ToUpperInvariant(name[0]) + name[1..];
        var document = $"<screen name=\"{screen}\" roles=\"Registered\">\n<style>\n{css}\n</style>\n<div class=\"rv-x\">x</div>\n</screen>";
        var output = Path.Combine(work, "out.oml");
        var result = Run(host, Fixture, new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = document } }), output);
        Assert.True(result["accepted"]!.GetValue<bool>(), Clip(result));
        // What the selector selects is kept: #reactContainer stays as written on a screen's own sheet.
        var read = host.HtmlRead(File.ReadAllBytes(output), "MobileScreen:" + screen, withKeys: false)["documents"]![0]!["html"]!.ToString();
        if (css.Contains("#reactContainer", StringComparison.Ordinal)) Assert.Contains("#reactContainer", read);
        Assert.DoesNotContain(":is(#reactContainer, body)", read);
        // read -> resend -> accepted, the stylesheet the same: the reading with its keys, sent back whole on its basedOn.
        ResendTheReading(host, work, output, screen);
    }

    /// <summary>The reading of a screen (with keys) sent back whole on its basedOn is accepted and gives the same reading.</summary>
    internal static void ResendTheReading(ModelHost host, string work, string oml, string screen)
    {
        var store = new Anvil.Reading.ModuleIndexStore(Path.Combine(work, "index-" + Guid.NewGuid().ToString("N")[..8]), "o11", "kernel");
        using var scope = Anvil.Reading.ModuleIndexStore.Use(store);
        var bytes = File.ReadAllBytes(oml);
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        var reading = host.HtmlRead(bytes, "MobileScreen:" + screen, withKeys: true);
        var document = reading["documents"]![0]!;
        var keys = store.HtmlKeysPathOf(sha, document["htmlSha256"]!.ToString());
        Directory.CreateDirectory(Path.GetDirectoryName(keys)!);
        File.WriteAllText(keys, new JsonObject { ["schema"] = ScreenHtml.Schema, ["extractor"] = ScreenHtml.Extractor, ["lane"] = store.Lane, ["sourceSha256"] = sha, ["root"] = screen,
            ["rootKey"] = document["rootKey"]!.DeepClone(), ["rootKind"] = document["rootKind"]!.DeepClone(), ["htmlSha256"] = document["htmlSha256"]!.DeepClone(),
            ["keys"] = document["keys"]!.DeepClone(), ["html"] = document["html"]!.DeepClone() }.ToJsonString());
        var again = Path.Combine(work, "again-" + Guid.NewGuid().ToString("N")[..8] + ".oml");
        var resent = Run(host, oml, new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = screen,
            ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = document["htmlSha256"]!.DeepClone() }, ["html"] = document["html"]!.DeepClone() } }), again);
        Assert.True(resent["accepted"]!.GetValue<bool>(), Clip(resent));
        Assert.Equal(host.HtmlRead(bytes, "MobileScreen:" + screen, withKeys: false)["documents"]![0]!["html"]!.ToString(),
            host.HtmlRead(File.ReadAllBytes(again), "MobileScreen:" + screen, withKeys: false)["documents"]![0]!["html"]!.ToString());
    }

    // ---- 2: only the offenders a write brings count; only an introduced environment url is an error -----------------------

    [Fact]
    public void DeletingOnePreexistingOffenderIsAcceptedWhileAnotherStays()
    {
        if (!StudioAvailable()) return;
        var (host, work) = Host("delete-one-offender");
        var (target, seeded) = Seed(host, work, ".a{background:url(\"" + EnvA + "\")}\n.b{background:url(\"" + EnvB + "\")}\n");
        var result = Run(host, seeded, new JsonArray(new JsonObject { ["op"] = "css", ["target"] = target, ["basedOn"] = BasedOn(host, seeded, target),
            ["edits"] = new JsonArray(new JsonObject { ["deleteRule"] = ".a" }) }), Path.Combine(work, "out.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), Clip(result));
    }

    [Fact]
    public void ABodyChangeOfAnExistingOffenderAndTheRecommendedFindWithAreNotRefused()
    {
        var job = JsonNode.Parse("""
            [{"op":"css","target":"IMobileTheme:App","basedOn":"0000000000000000000000000000000000000000000000000000000000000000","edits":[
              {"replaceRule":".x > div[id$=\"Div14\"]","body":"color:blue"},
              {"find":".f{background:url(\"https://acme-dev.outsystemscloud.com/LegacyPortal/img/a.png\")}","with":".f{background:url(\"https://acme-dev.outsystemscloud.com/LegacyPortal/img/a.png\");color:red}"}]}]
            """)!.AsArray();
        Assert.DoesNotContain(StyleSheetRules.Check(job, "o11"), p => p["severity"]!.ToString() == "error");
    }

    [Fact]
    public void AWholeSheetWithPreexistingOffendersIsAcceptedAndANewEnvironmentUrlIsRefused()
    {
        if (!StudioAvailable()) return;
        var (host, work) = Host("whole-sheet");
        var old = ".a{background:url(\"" + EnvA + "\")}\n";
        var (target, seeded) = Seed(host, work, old);
        // Preflight: a whole sheet may hold urls the element already has: never an error there.
        var set = new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = "StyleSheet", ["value"] = old + ".c{color:red}\n" };
        Assert.DoesNotContain(StyleSheetRules.Check(new JsonArray(set.DeepClone()), "o11"), p => p["severity"]!.ToString() == "error");
        var kept = Run(host, seeded, new JsonArray(set.DeepClone()), Path.Combine(work, "kept.oml"));
        Assert.True(kept["accepted"]!.GetValue<bool>(), Clip(kept));
        // A url the element did not have is refused at apply, with the patch that writes it without the host.
        var error = Assert.ThrowsAny<Exception>(() => Run(host, seeded, new JsonArray(new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = "StyleSheet",
            ["value"] = old + ".d{background:url(\"" + EnvB + "\")}\n" }), Path.Combine(work, "new.oml")));
        var coded = Assert.IsType<KernelRefusalException>(Errors.FindCoded(error));
        Assert.Equal(CssPipeline.EnvUrl, coded.Code);
        var problem = coded.Problems![0]!;
        Assert.Contains(EnvB, problem["message"]!.ToString());
        Assert.DoesNotContain(EnvA, problem["message"]!.ToString());
        Assert.Contains("url(\"/LegacyPortal/img/b.png\")", problem["patch"]![0]!["value"]!.ToString());
        Assert.Contains(EnvA, problem["patch"]![0]!["value"]!.ToString());   // the existing url is the element's: kept
    }

    [Fact]
    public void AGeneratedIdIsAWarningAndAModulesOwnPathIsNeverFlagged()
    {
        var job = new JsonArray(Set(".bar > div[id$=\"Div14\"]{padding:0}\n.logo{background:url(\"/MyOwnModule/img/logo.png\")}"));
        var problems = StyleSheetRules.Check(job, "o11").ToList();
        Assert.Equal("warning", Assert.Single(problems, p => p["code"]!.ToString() == CssPipeline.GeneratedIdSelector)["severity"]!.ToString());
        Assert.DoesNotContain(problems, p => p["code"]!.ToString() == CssPipeline.EnvUrl);
        Assert.DoesNotContain("changes when a widget is added", Assert.Single(problems, p => p["code"]!.ToString() == CssPipeline.GeneratedIdSelector)["message"]!.ToString());
    }

    // ---- 3: every offender of every <style> of a document in one answer -------------------------------------------------

    [Fact]
    public void EveryOffenderOfEveryStyleBlockComesInOneAnswer()
    {
        var html = "<screen name=\"Two\">\n<style>\n.gone{}\n</style>\n<div class=\"a\">x</div>\n<style>\n.empty{}\n</style>\n</screen>";
        var job = new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } }) };
        var analysis = JobPreflight.Analyze(job["ops"]!.AsArray(), job);
        var dead = Assert.Single(analysis["warnings"]!.AsArray().OfType<JsonObject>(), w => w["code"]!.ToString() == CssPipeline.DeadSelector);
        Assert.Contains("line 3", dead["message"]!.ToString());
        Assert.Contains("line 7", dead["message"]!.ToString());
    }

    // ---- 4: one finding per fault, and one usable patch per place -------------------------------------------------------

    [Fact]
    public void AnHtmlIdSelectorIsTheHtmlOpsOwnFindingOnly()
    {
        var html = "<screen name=\"Ids\">\n<style>\n#Div14{color:red}\n</style>\n<div class=\"a\">x</div>\n</screen>";
        Assert.DoesNotContain(StyleSheetRules.Check(new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } }), "odc"),
            p => p["code"]!.ToString() == CssPipeline.GeneratedIdSelector);
    }

    [Fact]
    public void TwoFixesOfOneValueComeAsOneCombinedPatch()
    {
        var css = ".a{color:color-mix(in srgb, #ff0000 50%, #0000ff)}\n.b{background:url(\"" + EnvA + "\")}";
        var problems = StyleSheetRules.Check(new JsonArray(Set(css)), "o11").Where(p => p["patch"] is JsonArray { Count: > 0 }).ToList();
        Assert.True(problems.Count >= 2, string.Join(" | ", problems.Select(p => p.ToJsonString())));
        var values = problems.Select(p => p["patch"]![0]!["value"]!.ToString()).Distinct().ToList();
        var combined = Assert.Single(values);
        Assert.DoesNotContain("color-mix", combined);
        Assert.DoesNotContain("outsystemscloud.com", combined);
    }

    // ---- 5: the normalization never changes what the CSS selects nor the cascade ----------------------------------------

    [Fact]
    public void TheCanvasRewriteIsOnlyTheDescendantFormAndOnlyWhenAsked()
    {
        const string css = "#reactContainer > div{a:b}\n#reactContainer{c:d}\n#reactContainer .x{e:f}\n";
        Assert.Equal(css, CssPipeline.Normalize(css, new("test")).Css);
        var asked = CssPipeline.Normalize(css, new("test"), canvas: true).Css;
        Assert.Contains("#reactContainer > div{a:b}", asked);
        Assert.Contains("#reactContainer{c:d}", asked);
        Assert.Contains(":is(#reactContainer, body) .x{e:f}", asked);
    }

    [Fact]
    public void ImportsKeepTheirOrderTheLastOfTwoStaysAndNothingCrossesALayer()
    {
        var css = "@import url(a.css);\n.x{c:d}\n@import url(b.css);\n@import url(a.css);\n";
        var written = CssPipeline.Normalize(css, new("test")).Css;
        Assert.True(written.IndexOf("@import url(b.css);", StringComparison.Ordinal) < written.IndexOf("@import url(a.css);", StringComparison.Ordinal), written);
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(written, "a\\.css"));
        Assert.True(written.IndexOf("@import", written.IndexOf(".x{", StringComparison.Ordinal), StringComparison.Ordinal) < 0, written);
        const string layered = "@layer base;\n.x{c:d}\n@import url(a.css);\n";
        Assert.Equal(layered, CssPipeline.Normalize(layered, new("test")).Css);
        const string first = "@import url(a.css);\n@import url(b.css);\n.x{c:d}\n";
        Assert.Equal(first, CssPipeline.Normalize(first, new("test")).Css);
    }

    [Fact]
    public void ATraditionalSheetKeepsReactContainerAsWritten()
    {
        if (!StudioAvailable()) return;
        var (host, work) = Host("traditional-canvas");
        var fixture = Path.Combine(Root, "tests/fixtures/traditional-ui.oml");
        var (target, _, _) = CssPathModelTests.Elements(host, fixture).First(e => e.Kind == "theme");
        var result = Run(host, fixture, new JsonArray(new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = "StyleSheet", ["value"] = "#reactContainer .t18-x{color:red}" },
            new JsonObject { ["op"] = "get", ["target"] = target }), Path.Combine(work, "out.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), Clip(result));
        var properties = Results(result).OfType<JsonObject>().Last(r => r["properties"] != null)["properties"]!;
        Assert.Contains("#reactContainer .t18-x", properties["StyleSheet"]!.ToString());
        Assert.DoesNotContain(":is(", properties["StyleSheet"]!.ToString());
    }

    // ---- 6: an edit by rule never moves a rule, never drops what it does not name --------------------------------------

    private static JsonArray Edits(string json) => JsonNode.Parse(json)!.AsArray();

    [Fact]
    public void ADuplicatedSelectorIsRefusedNamingEveryRuleAndNthEditsOneInPlace()
    {
        const string css = ".x{a:1}\n.y{b:2}\n.x{a:3}\n";
        var refused = CssEdits.Apply(css, Edits("""[{"replaceRule":".x","body":"a:5"}]"""));
        var problem = Assert.Single(refused.Problems);
        Assert.Contains("lines 1, 3", problem["message"]!.ToString());
        var placed = CssEdits.Apply(css, Edits("""[{"replaceRule":".x","nth":2,"body":"a:5"}]"""));
        Assert.Empty(placed.Problems);
        Assert.Equal(".x{a:1}\n.y{b:2}\n.x{ a:5 }\n", placed.Css);
    }

    [Fact]
    public void ANestedRuleIsRefusedExplicitly()
    {
        var plan = CssEdits.Apply(".a{color:red; &:hover{color:blue}}\n", Edits("""[{"replaceRule":"&:hover","body":"color:green"}]"""));
        var problem = Assert.Single(plan.Problems);
        Assert.Equal(CssEdits.Invalid, problem["code"]!.ToString());
        Assert.Contains("nested", problem["message"]!.ToString());
        var holder = CssEdits.Apply(".a{color:red; &:hover{color:blue}}\n", Edits("""[{"replaceRule":".a","body":"color:green"}]"""));
        Assert.Contains("nested", Assert.Single(holder.Problems)["message"]!.ToString());
    }

    [Fact]
    public void AnUnbalancedSheetIsRefusedBeforeAnyEdit()
    {
        const string css = ".a{color:red\n.b{margin:0}\n";
        var plan = CssEdits.Apply(css, Edits("""[{"append":".c{d:e}"}]"""));
        Assert.NotEmpty(plan.Problems);
        Assert.Equal(css, plan.Css);
    }

    [Fact]
    public void DeleteRuleInMatchesTheExactQueryAndRemovesTheBlockItEmptied()
    {
        const string css = "@media screen and (max-width: 767px) {\n  .a { x: y; }\n}\n@media (max-width: 767px) {\n  .a { x: z; }\n}\n.b { c: d; }\n";
        var plan = CssEdits.Apply(css, Edits("""[{"deleteRule":".a","in":"@media (max-width:767px)"}]"""));
        Assert.Empty(plan.Problems);
        Assert.Equal("@media screen and (max-width: 767px) {\n  .a { x: y; }\n}\n.b { c: d; }\n", plan.Css);
    }

    // ---- 7 -----------------------------------------------------------------------------------------------------------------

    [Fact]
    public void ThePrototypeStylesheetSettlesOnEveryThemeAndTheBaseRulesAreNoProcessState()
    {
        var source = File.ReadAllText(Path.Combine(Root, "src", "Anvil.Core", "Kernel", "Verbs.Prototype.cs"));
        Assert.DoesNotContain("ThemeCss.IsSplit(sheet)) ThemeCss.Recompute(sheet)", source);
        var statics = typeof(ScreenVisual).GetFields(System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public)
            .Where(f => !f.IsInitOnly && !f.IsLiteral).Select(f => f.Name).ToList();
        Assert.DoesNotContain(statics, n => n.Contains("Base", StringComparison.OrdinalIgnoreCase));
        Assert.Null(typeof(ScreenVisual).GetMethod("RegisterOutSystemsUiBase"));
    }

    [Fact]
    public void TheCssOpIsAnApiOperationOfTheFacade()
    {
        Assert.Contains("css", CommandSurface.OperationNames);
        Assert.Equal("css", CommandSurface.Schema("css")["op"]!.ToString());
        foreach (var file in new[] { "catalog.mjs", "discovery.mjs" })
        {
            var text = File.ReadAllText(Path.Combine(Root, "..", "platforms", "odc", "facade", file));
            Assert.Matches(@"const API_OPS = \[[^\]]*'css'", text);
        }
    }

    [Fact]
    public void AThemePartOfTheHtmlOpReturnsTheBasedOnOfTheTheme()
    {
        if (!StudioAvailable()) return;
        var (host, work) = Host("theme-part-basedon");
        var document = "<screen name=\"T18Part\" roles=\"Registered\">\n<style scope=\"theme\" id=\"t18-part\">\n.t18-part{color:red}\n</style>\n<div class=\"t18-part\">x</div>\n</screen>";
        var result = Run(host, Fixture, new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = document } }), Path.Combine(work, "out.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), Clip(result));
        Assert.Matches("\"basedOn\":\"[0-9a-f]{64}\"", result["results"]!.ToJsonString());
    }

    [Fact]
    public void WriteErrorsAndStageFailuresNameNoInternals()
    {
        var error = Assert.ThrowsAny<InvalidOperationException>(() => ThemeCss.Write(new object(), "x"));
        Assert.DoesNotContain("Object", error.Message);
        try
        {
            CssPipeline.Register("t18-review-throws", (_, _, _) => throw new InvalidOperationException("internal detail 42"));
            var outcome = CssPipeline.Normalize(".a{b:c}", new("test"));
            Assert.DoesNotContain("internal detail 42", JsonSerializer.Serialize(outcome.StageChanges.Select(c => c.ToJsonString())));
        }
        finally { CssPipeline.Unregister("t18-review-throws"); }
    }

    // ---- helpers ---------------------------------------------------------------------------------------------------------

    private static readonly string Fixture = Path.Combine(Root, "tests/fixtures/reactive-ui.oml");

    private static JsonObject Set(string css) => new() { ["op"] = "set", ["target"] = "IMobileTheme:App", ["prop"] = "StyleSheet", ["value"] = css };

    // The default theme of the reactive fixture with this author CSS, written as it is (the state of a sheet an earlier delivery
    // left), saved as the base of the next job.
    private static (string Target, string Path) Seed(ModelHost host, string work, string css)
    {
        var (target, _, _) = CssPathModelTests.Elements(host, Fixture).First(e => e.Kind == "theme");
        var module = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [Fixture])!;
        try
        {
            var theme = ModelHost.Prop(module, "DefaultMobileTheme")!;
            typeof(IStudioRuntime).GetMethod("Mutate")!.Invoke(StudioAdapter.Runtime, [module, "t18 seed", (Action<object>)(_ => ThemeCss.WriteThemeVerbatim(theme, css))]);
            var path = Path.Combine(work, "seeded.oml");
            File.WriteAllBytes(path, (byte[])typeof(ModelHost).GetMethod("Save")!.Invoke(host, [module])!);
            return ("IMobileTheme:" + TypeResolver.Name(theme), path);
        }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]); }
    }

    private static string BasedOn(ModelHost host, string basis, string target)
    {
        var (_, _, author) = CssPathModelTests.Elements(host, basis).First(e => e.Target == target);
        return ThemeCss.Sha256(author);
    }

    private static (ModelHost Host, string Work) Host(string name)
    {
        StudioAssemblies.Bind(null);
        var work = Path.Combine(Root, ".local/lane-ss5/proofs/t18-review", name);
        Directory.CreateDirectory(work);
        return (new ModelHost(work), work);
    }

    private static JsonObject Run(ModelHost host, string basis, JsonArray ops, string output)
    {
        var job = output + ".job.json";
        File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
        return JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, output))!.AsObject();
    }

    private static IEnumerable<JsonNode?> Results(JsonObject result) => (result["results"] as JsonArray ?? new JsonArray()).Select(r => r is JsonObject o && o["result"] is { } inner ? inner : r);
    private static string Clip(JsonObject result) { var s = result.ToJsonString(); return s[..Math.Min(4000, s.Length)]; }
    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
