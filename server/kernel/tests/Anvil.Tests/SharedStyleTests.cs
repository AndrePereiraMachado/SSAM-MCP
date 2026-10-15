using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>Delivery-wide CSS sharing: pure corpus checks and one offline model round trip.</summary>
public sealed class SharedStyleTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(SharedStyleTests).Assembly.Location)!)!;

    [Fact]
    public void T1_RepeatedRulesHaveOneContentAddressedThemePartAndAreIdempotent()
    {
        var ops = Docs(".a{color:red}", ".a{color:red}");
        var entries = JobNormalizer.Pure(ops, "/ops", "o11");
        var part = Assert.Single(Styles(ops[0]!), s => s.Theme);
        Assert.Matches("^shared-[0-9a-f]{8}$", part.Id!);
        Assert.Equal(".a{color:red}", part.Css.Trim());
        Assert.Empty(Styles(ops[1]!));
        Assert.All(entries.Where(e => e["rule"]?.ToString() == "CSS_MOVED_TO_THEME"), e =>
        {
            Assert.True(e["bytesBefore"]!.GetValue<int>() > 0);
            Assert.NotNull(e["bytesAfter"]);
            Assert.Contains("/data/html", e["path"]!.ToString());
        });
        Assert.Equal(2, entries.Count(e => e["rule"]?.ToString() == "CSS_MOVED_TO_THEME"));
        var after = ops.ToJsonString();
        Assert.Empty(JobNormalizer.Pure(ops, "/ops", "o11"));
        Assert.Equal(after, ops.ToJsonString());
        var single = Docs(".a{color:red}");
        var before = single.ToJsonString();
        Assert.Empty(Normalize(single));
        Assert.Equal(before, single.ToJsonString());
    }

    [Theory]
    [InlineData(".x{color:blue}", ".y{color:red}", true)]
    [InlineData(".x{margin:0}", ".y{color:red}", false)]
    [InlineData(".x.x{color:blue}", ":where(.p) .y{color:red}", false)]
    [InlineData(".x{color:blue}", ":where(.p .y){color:red}", false)]
    [InlineData(".x{color:blue}", ":where(.p) .y{color:red}", true)]
    [InlineData(".x{background:blue}", ".y{background-color:red}", true)]
    [InlineData(".x{inset:0}", ".y{top:1px}", true)]
    [InlineData(".x{--a:blue}", ".y{--b:red}", false)]
    public void T2_LocalPredecessorsKeepOnlyRulesWhoseCascadeWouldChange(string own, string repeated, bool remains)
    {
        var ops = Docs(own + repeated, repeated);
        Normalize(ops);
        Assert.Equal(remains, Own(ops[0]!).Contains(repeated, StringComparison.Ordinal));
        Assert.DoesNotContain(repeated, Own(ops[1]!));
        Assert.Contains(own, Own(ops[0]!));
        Assert.Contains(repeated, Theme(ops));
    }

    [Fact]
    public void T2_ConflictingSharedRulesKeepReverseLocalOrder()
    {
        const string a = ".a{color:red}";
        const string b = ".b{color:blue}";
        var ops = Docs(a + b, b + a);
        Normalize(ops);
        Assert.Equal(b + a, Own(ops[1]!).Trim());
        Assert.Contains(a, Theme(ops));
        Assert.Contains(b, Theme(ops));
    }

    [Theory]
    [InlineData("@media(min-width:600px){.x{color:blue}}", "@media(min-width:600px){.y{color:red}}", true)]
    [InlineData("@media(min-width:600px){.x{color:blue}}", "@media(max-width:300px){.y{color:red}}", false)]
    [InlineData(".x{color:blue}", "@media(min-width:600px){.y{color:red}}", true)]
    [InlineData("@supports(display:grid){.x{gap:2px}}", "@supports(display:grid){.y{row-gap:4px}}", true)]
    [InlineData("@container panel (min-width:600px){.x{overflow:hidden}}", "@container panel (min-width:600px){.y{overflow-x:scroll}}", true)]
    public void T2_ConditionalContextsCompeteOnlyWhenTheirContextsAndPropertiesOverlap(string own, string repeated, bool remains)
    {
        var ops = Docs(own + repeated, repeated);
        Normalize(ops);
        Assert.Equal(remains, Own(ops[0]!).Contains(repeated, StringComparison.Ordinal));
        Assert.DoesNotContain(repeated, Own(ops[1]!));
        Assert.Contains(own, Own(ops[0]!));
    }

    [Fact]
    public void T2_DataCssRemainsVerbatimOutsideSharing()
    {
        var ops = Docs(".a{color:red}", ".a{color:red}");
        foreach (var op in ops) op!["data"]!["css"] = ".a{color:blue}";
        Normalize(ops);
        Assert.All(ops, op => Assert.Equal(".a{color:blue}", op!["data"]!["css"]!.ToString()));
        Assert.DoesNotContain("color:blue", Theme(ops));
    }

    [Fact]
    public void T3_GlobalSelectorsAndDeadImportsStayLocalWhileFontFacesAreShared()
    {
        const string global = "body{margin:0}*{box-sizing:border-box}";
        const string import = "@import url('late.css');";
        const string font = "@font-face{font-family:Demo;src:url('demo.woff2')}";
        var ops = Docs(global + import + font, global + import + font);
        Normalize(ops);
        foreach (var op in ops)
        {
            Assert.Contains(global, Own(op!));
            Assert.Contains(import, Own(op!));
            Assert.DoesNotContain(font, Own(op!));
        }
        Assert.Contains(font, Theme(ops));
        Assert.DoesNotContain(import, Theme(ops));
        Assert.DoesNotContain("body", Theme(ops));
    }

    [Fact]
    public void T3_LiveImportsMoveButCharsetsAndMixedGlobalSelectorListsStayLocal()
    {
        const string charset = "@charset \"UTF-8\";";
        const string import = "@import url('base.css');";
        const string mixed = ".a, h1{color:red}";
        var ops = Docs(charset + import + mixed, charset + import + mixed);
        Normalize(ops);
        Assert.Contains(import, Theme(ops));
        foreach (var op in ops)
        {
            Assert.Contains(charset, Own(op!));
            Assert.Contains(mixed, Own(op!));
            Assert.DoesNotContain(import, Own(op!));
        }
    }

    [Theory]
    [InlineData("@import url('broken;\n.a{color:red}")]
    [InlineData(".a{color:red")]
    [InlineData(".a{color:red}}")]
    public void T4_UnreadableCssLeavesTheWholeDocumentUntouched(string css)
    {
        var ops = Docs(css, css);
        var original = ops.Select(o => Html(o!)).ToArray();
        var entries = Normalize(ops);
        Assert.Equal(original, ops.Select(o => Html(o!)));
        Assert.Equal(2, entries.Count(e => e["rule"]?.ToString() == "CSS_NOT_SHARED"));
        Assert.DoesNotContain(entries, e => e["rule"]?.ToString() == "CSS_MOVED_TO_THEME");
    }

    [Fact]
    public void T4_LenientParserProbeRecordsTheTruncatedImportBehavior()
    {
        var fixture = Load("blocks-cut");
        var css = Own(fixture[0]!);
        Assert.Contains("@import", css);
        try
        {
            var parsed = CssStylesheet.Parse(css, lenient: true);
            output.WriteLine($"Truncated import probe: lenient Parse returned {parsed.Rules.Count} rules, {parsed.Statements.Count} statements, {parsed.Blocks.Count} blocks.");
        }
        catch (Exception error)
        {
            output.WriteLine($"Truncated import probe: lenient Parse throws {error.GetType().Name}: {error.Message}");
        }
        var before = Html(fixture[0]!);
        var entries = Normalize(fixture);
        Assert.Equal(before, Html(fixture[0]!));
        Assert.Contains(entries, e => e["rule"]?.ToString() == "CSS_NOT_SHARED" && e["path"]?.ToString() == "/ops/0/data/html");
    }

    [Fact]
    public void T5_ExplicitNamedPartsAreSharedAndInvalidNamesAreRefused()
    {
        var ops = new JsonArray(Op("<screen name=\"First\"><style scope=\"theme\" id=\"base\">.a{color:red}</style><style scope=\"theme\" id=\"base\">.b{margin:0}</style></screen>"), Op(Document("Second", ".a{color:red}.b{margin:0}")));
        var parts = ScreenDocument.ThemeParts(Styles(ops[0]!), "First");
        var part = Assert.Single(parts);
        Assert.Equal("style:base", part.Key);
        Assert.Contains(".a{color:red}", part.Css);
        Assert.Contains(".b{margin:0}", part.Css);
        Normalize(ops);
        Assert.Equal("", Own(ops[1]!));
        Assert.DoesNotContain("shared-", Html(ops[0]!));
        var invalid = "<screen name=\"Bad\"><style scope=\"theme\" id=\"bad name\">.a{color:red}</style></screen>";
        var refusal = Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(invalid, "/data/html"));
        Assert.Contains(refusal.Problems!, p => p!["code"]?.ToString() == "HTML_STYLE_UNPLACED");
    }

    [Fact]
    public void T6_OfflineModelCompilationWritesTheNamedThemePartOnce()
    {
        if (!StudioAvailable()) { output.WriteLine("Offline model round trip skipped: Studio assemblies unavailable."); return; }
        var dir = Path.Combine(Root, ".local", "shared-style-tests");
        Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        var ops = new JsonArray(Op(Screen("SharedOne")), Op(Screen("SharedTwo")));
        var jobPath = Path.Combine(dir, "job.json");
        File.WriteAllText(jobPath, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = ops }.ToJsonString());
        var first = Path.Combine(dir, "first.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, jobPath, first))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        Check(first);
        var second = Path.Combine(dir, "second.oml");
        var replay = JsonNode.Parse(File.ReadAllText(jobPath))!.AsObject();
        replay.Remove("base");
        // Creation documents cannot overwrite existing screens. Recreate the two roots,
        // keeping the module theme, then replay the exact same HTML documents.
        replay["ops"]!.AsArray().Insert(0, new JsonObject { ["op"] = "delete", ["target"] = "IMobileScreen:SharedTwo" });
        replay["ops"]!.AsArray().Insert(0, new JsonObject { ["op"] = "delete", ["target"] = "IMobileScreen:SharedOne" });
        File.WriteAllText(jobPath, replay.ToJsonString());
        var again = JsonSerializer.SerializeToNode(JobRunner.Run(host, first, jobPath, second))!;
        Assert.True(again["accepted"]!.GetValue<bool>(), again.ToJsonString());
        Check(second);

        static string Screen(string name) => $"<screen name=\"{name}\" roles=\"Registered\"><style>.shared-card{{padding:8px}}</style><Block name=\"LayoutBlank\"><slot name=\"Content\"><div class=\"shared-card\">x</div></slot></Block></screen>";
        void Check(string model)
        {
            var get = Path.Combine(dir, "theme-get.json");
            File.WriteAllText(get, """{"ops":[{"op":"get","target":"IMobileTheme:Headless_UI"}]}""");
            var read = JsonSerializer.SerializeToNode(JobRunner.Run(host, model, get, Path.Combine(dir, "theme-get.oml")))!;
            var theme = read["results"]![0]!["result"]!;
            var css = theme["UserStyleSheet"]?.ToString() ?? theme["properties"]?["UserStyleSheet"]?.ToString() ?? theme["StyleSheet"]?.ToString() ?? theme["properties"]?["StyleSheet"]?.ToString() ?? "";
            Assert.Single(Regex.Matches(css, @"/\* anvil:html style:shared-"));
            foreach (var name in new[] { "SharedOne", "SharedTwo" })
            {
                var html = host.HtmlRead(File.ReadAllBytes(model), "MobileScreen:" + name, withKeys: false)["documents"]![0]!["html"]!.ToString();
                Assert.DoesNotContain(".shared-card", html);
                Assert.DoesNotContain("scope=\"theme\"", html);
            }
        }
    }

    [Theory]
    [InlineData("blocks-full")]
    [InlineData("blocks-cut")]
    public void T7_CorpusSavingsPreserveEveryRuleAndReportPerDocument(string name)
    {
        var ops = Load(name);
        var before = (JsonArray)ops.DeepClone();
        var entries = Normalize(ops);
        var dump = Environment.GetEnvironmentVariable("SSAM_CSS_SHARED_DUMP");
        if (!string.IsNullOrWhiteSpace(dump))
        {
            Directory.CreateDirectory(dump);
            File.WriteAllText(Path.Combine(dump, name + ".before.json"), new JsonObject { ["ops"] = before.DeepClone() }.ToJsonString());
            File.WriteAllText(Path.Combine(dump, name + ".after.json"), new JsonObject { ["ops"] = ops.DeepClone() }.ToJsonString());
        }
        var beforeCss = before.Sum(o => Bytes(Styles(o!).Select(s => s.Css)));
        var afterCss = ops.Sum(o => Bytes(Styles(o!).Select(s => s.Css)));
        output.WriteLine($"{name}: html bytes {before.Sum(o => Encoding.UTF8.GetByteCount(Html(o!)))} -> {ops.Sum(o => Encoding.UTF8.GetByteCount(Html(o!)))}; CSS bytes (local + theme) {beforeCss} -> {afterCss}; reduction {1d - (double)afterCss / beforeCss:P2}");
        for (var i = 0; i < ops.Count; i++)
        {
            var localBefore = Own(before[i]!);
            var localAfter = Own(ops[i]!);
            var entry = entries.SingleOrDefault(e => e["path"]?.ToString() == $"/ops/{i}/data/html");
            output.WriteLine($"  document {i}: local bytes {Encoding.UTF8.GetByteCount(localBefore)} -> {Encoding.UTF8.GetByteCount(localAfter)}; rules {RuleCount(localBefore)} -> {RuleCount(localAfter)}; {entry?.ToJsonString() ?? "unchanged"}");
            if (entry?["rule"]?.ToString() == "CSS_NOT_SHARED") Assert.Equal(Html(before[i]!), Html(ops[i]!));
            else
            {
                // Independent loss check: every original local item survives verbatim modulo the
                // specified key normalization in this document or the delivery's named theme.
                var original = Keys(localBefore);
                var available = Keys(localAfter).Concat(ops.SelectMany(op => Styles(op!).Where(s => s.Theme)).SelectMany(s => Keys(s.Css))).ToHashSet(StringComparer.Ordinal);
                Assert.All(original, key => Assert.Contains(key, available));
            }
        }
        if (name == "blocks-cut")
        {
            Assert.Equal(before.ToJsonString(), ops.ToJsonString());
            Assert.Equal(6, entries.Count(e => e["rule"]?.ToString() == "CSS_NOT_SHARED"));
            Assert.DoesNotContain(entries, e => e["rule"]?.ToString() == "CSS_MOVED_TO_THEME");
        }
        if (name == "blocks-full")
        {
            Assert.Contains(entries, e => e["rule"]?.ToString() == "CSS_MOVED_TO_THEME");
        }
        if (name == "blocks-full")
        {
            Assert.True(afterCss <= beforeCss * .60, "The full corpus must save at least 40% of its CSS bytes.");
            // The repeated import is dead in earlier documents; B.4 requires it to
            // remain local everywhere. These two roots retain only that statement.
            foreach (var op in new[] { ops[^1]!, ops[^2]! })
            {
                var own = Own(op);
                var item = Assert.Single(CssStylesheet.SplitTopLevel(own));
                Assert.StartsWith("@import", own[item.Start..item.End]);
                Assert.Empty(CssStylesheet.Parse(own, lenient: true).Rules);
            }
        }
    }

    private static List<JsonObject> Normalize(JsonArray ops) { var entries = new List<JsonObject>(); SharedStyleNormalizer.Normalize(ops, "/ops", entries); return entries; }
    private static JsonArray Docs(params string[] sheets) => new(sheets.Select((css, i) => (JsonNode)Op(Document("Page" + i, css))).ToArray());
    private static string Document(string name, string css) => $"<screen name=\"{name}\"><style>{css}</style><div class=\"a b x y p\">example</div></screen>";
    private static JsonObject Op(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };
    private static string Html(JsonNode op) => op["data"]!["html"]!.ToString();
    private static List<ScreenDocument.StyleBlock> Styles(JsonNode op) => ScreenDocument.Styles(ScreenHtml.Parse(Html(op)).Children.First(n => !n.IsText));
    private static string Own(JsonNode op) => string.Join("\n", Styles(op).Where(s => !s.Theme).Select(s => s.Css));
    private static string Theme(JsonArray ops) => string.Join("\n", ops.SelectMany(o => Styles(o!)).Where(s => s.Theme).Select(s => s.Css));
    private static int Bytes(IEnumerable<string> texts) => texts.Sum(Encoding.UTF8.GetByteCount);
    private static int RuleCount(string css) { try { return CssStylesheet.CountRules(css); } catch { return -1; } }
    private static IEnumerable<string> Keys(string css) => CssStylesheet.SplitTopLevel(css).Select(r => CssStylesheet.SharedRuleKey(css[r.Start..r.End]));
    private static JsonArray Load(string name) => JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "tests", "fixtures", "css-shared", name + ".json")))!["ops"]!.AsArray();
    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
