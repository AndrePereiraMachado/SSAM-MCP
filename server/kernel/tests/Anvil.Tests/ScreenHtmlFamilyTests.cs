using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>The families of the owner's session of 2026-10-12 (VisitaCerta_UI: 22 writes, 13 refused, 9 defects after the
/// publication), each fixed by one rule of the engine for any element, screen and module (ScreenHtmlNative, ScreenHtml.Runs, the
/// Popup's Transition, the native widgets' CSS): the rules over generated cases without a module, the compile and the edit over
/// the reactive fixture and over every Reactive/Mobile module of the plan's corpus (ScreenHtmlFamilyCorpus; the ODC lane in
/// ScreenHtmlFamilyOdcTests). The module parts need the Service Studio and are skipped without it.</summary>
public sealed class ScreenHtmlFamilyTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenHtmlFamilyTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "screen-html-families");

    private static List<string> RunsOf(string html, string tag = "p")
    {
        var element = ScreenHtmlText.Elements(ScreenHtml.Parse(html)).Select(x => x.Node).First(n => n.Tag == tag);
        return ScreenHtml.Runs(element).Select(r => r.Text).ToList();
    }

    // ---- (5) whitespace beside inline elements -------------------------------------------------------------------------------

    [Fact]
    public void TheWhitespaceBesideAnInlineElementOnTheSameLineIsKeptAndIndentationIsNot()
    {
        Assert.Equal(["Reordene a agenda por ", " para começar."], RunsOf("<p>Reordene a agenda por <b>menor risco climático</b> para começar.</p>"));
        Assert.Equal([" "], RunsOf("<div><b>a</b> <em>b</em></div>", "div"));
        // Indentation and line breaks are the reading's layout: one run per line, trimmed.
        Assert.Equal(["a", "z"], RunsOf("<div>\n a\n <div>y</div>\n z\n</div>", "div"));
        Assert.Equal(["a "], RunsOf("<p>\n  a <b>b</b>\n</p>"));
        // Beside a block element nothing is kept (a flex container would take it as an item).
        Assert.Equal(["x", "y"], RunsOf("<div>x <div>b</div> y</div>", "div"));
        // A binding beside an inline element: the space is part of the expression.
        Assert.Equal("\" \" + X", ScreenHtml.Run(RunsOf("<p><b>T</b> {{ X }}</p>")[0], out var expression, out _));
        Assert.True(expression);
        // Generated: every inline element of the language, on both sides, never a block one.
        foreach (var inline in new[] { "span", "b", "strong", "em", "i class=\"x\"", "a", "button", "code", "small", "label", "expr value=\"1\"" })
        {
            var tag = inline.Split(' ')[0];
            var runs = RunsOf($"<p>left <{inline}>m</{tag}> right</p>");
            Assert.True(runs.SequenceEqual(["left ", " right"]), inline + ": [" + string.Join("|", runs) + "]");
        }
        foreach (var block in new[] { "div", "p", "ul", "section", "popup", "Block name=\"B\"" })
        {
            var tag = block.Split(' ')[0];
            var runs = RunsOf($"<div>left <{block}>m</{tag}> right</div>", "div");
            Assert.True(runs.SequenceEqual(["left", "right"]), block + ": [" + string.Join("|", runs) + "]");
        }
    }

    [Fact]
    public void TheTextOfAnEditIsWrittenSoEveryRunReadsBackTheSame()
    {
        // The corrected edits and the merge write each run on its own line: a run with spaces at its ends is <text> or its {{ }}.
        // The runs of an element as the decoder reads them: each text run (value, expression) and each <text> exactly.
        static List<(string, bool)> Canonical(ScreenHtml.Node element)
        {
            var runs = ScreenHtml.Runs(element).ToList();
            var list = new List<(string, bool)>();
            foreach (var child in element.Children)
                if (child.IsText) list.AddRange(runs.Where(r => ReferenceEquals(r.Source, child)).Select(r => (ScreenHtml.Run(r.Text, out var e, out _), e)));
                else if (child.Tag == "text" && child.Get("k") == null) list.Add((string.Concat(child.Children.Select(c => c.Text)), false));
            return list;
        }
        foreach (var html in new[] {
                     "<p>Reordene por <b>menor</b> para <em>x</em> <b>y</b>.</p>", "<p><b>Total:</b> {{ N }} itens</p>", "<p>{{ A }} <b>b</b></p>",
                     "<div k=\"w1\">\n<span k=\"w2\">a</span>\n<text> b </text>\n</div>\n" })
        {
            var element = ScreenHtml.Parse(html).Children.First(c => !c.IsText);
            var written = ScreenHtmlText.Write(ScreenHtml.Parse(html));
            var reparsed = ScreenHtml.Parse(written).Children.First(c => !c.IsText);
            Assert.True(Canonical(element).SequenceEqual(Canonical(reparsed)), html + "\n" + written);
            Assert.Equal(written, ScreenHtmlText.Write(ScreenHtml.Parse(written)));
        }
        // The reading's own text is written as it is (no run of a reading touches an element on its line).
        Assert.Equal("<div k=\"w1\">\n<span k=\"w2\">a</span>\n<text> b </text>\n</div>\n", ScreenHtmlText.Write(ScreenHtml.Parse("<div k=\"w1\">\n<span k=\"w2\">a</span>\n<text> b </text>\n</div>\n")));
    }

    // ---- (5) inline decimals -------------------------------------------------------------------------------------------------

    [Fact]
    public void AnInlineNumberWithAFractionIsWrittenCalcAndEverythingElseAsWritten()
    {
        var cases = new (string From, string To)[] {
            ("opacity:0.7", "opacity:calc(0.7)"), ("opacity: .85", "opacity: calc(.85)"), ("line-height:1.4;flex:0.5", "line-height:calc(1.4);flex:calc(0.5)"),
            ("flex:1;z-index:2;opacity:1.0", "flex:1;z-index:2;opacity:1.0"), ("font-size:11.5px;letter-spacing:.1em", "font-size:11.5px;letter-spacing:.1em"),
            ("opacity:{{ X }};line-height:1.5", "opacity:{{ X }};line-height:calc(1.5)"), ("background:url(\"a;b.png\");opacity:0.5", "background:url(\"a;b.png\");opacity:calc(0.5)"),
            ("transform:scale(1.5)", "transform:scale(1.5)"), ("opacity:1e-1", "opacity:calc(1e-1)"), ("opacity:calc(0.7)", "opacity:calc(0.7)"),
        };
        foreach (var (from, to) in cases)
        {
            Assert.Equal(to, ScreenHtmlNative.Survive(from));
            Assert.Equal(to, ScreenHtmlNative.Survive(to));   // idempotent
        }
        // Generated: every unitless property with a fraction, every integer kept.
        foreach (var property in new[] { "opacity", "line-height", "flex", "flex-grow", "flex-shrink", "order", "z-index", "font-weight", "zoom", "fill-opacity" })
        {
            Assert.Equal(property + ":calc(0.25)", ScreenHtmlNative.Survive(property + ":0.25"));
            Assert.Equal(property + ":3", ScreenHtmlNative.Survive(property + ":3"));
        }
    }

    // ---- (2) svg and images --------------------------------------------------------------------------------------------------

    private static (ScreenHtml.Node Top, ScreenHtmlNative.Outcome Outcome) Normalize(string body, Func<string, bool>? isReference = null, string? sheet = null)
    {
        var top = ScreenHtml.Parse("<screen name=\"S\">" + body + "</screen>").Children.First(c => !c.IsText);
        return (top, ScreenHtmlNative.Apply(top, _ => true, _ => null, isReference ?? (_ => false), sheet));
    }

    [Fact]
    public void AnInlineSvgIsANativeIconSpanOrTheImageOfItsMarkup()
    {
        // Generated: the paints of an svg decide; an icon is any svg in currentColor or one color.
        var icons = new[] {
            "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\"><path d=\"M1 1h2\"/></svg>",
            "<svg viewBox=\"0 0 24 24\"><path fill=\"currentColor\" d=\"M1 1h2\"/></svg>",
            "<svg viewBox=\"0 0 24 24\" stroke=\"currentColor\"><g><circle cx=\"1\" cy=\"1\" r=\"1\" fill=\"none\"/></g></svg>",
            "<svg viewBox=\"0 0 24 24\"><path fill=\"#0F1A14\" d=\"M1 1h2\"/><path fill=\"#0F1A14\" d=\"M3 3h2\"/></svg>",
        };
        var images = new[] {
            "<svg viewBox=\"0 0 20 20\"><defs><linearGradient id=\"g\"><stop offset=\"0\" stop-color=\"#f00\"/></linearGradient></defs><rect width=\"2\" height=\"2\" fill=\"url(#g)\"/></svg>",
            "<svg viewBox=\"0 0 20 20\"><path fill=\"#f00\" d=\"M1 1h2\"/><path fill=\"#00f\" d=\"M3 3h2\"/></svg>",
            "<svg viewBox=\"0 0 20 20\"><text x=\"1\" y=\"1\">A</text></svg>",
            "<svg viewBox=\"0 0 20 20\"><path style=\"fill:red\" d=\"M1 1h2\"/></svg>",
        };
        foreach (var svg in icons)
        {
            var (top, outcome) = Normalize("<div class=\"a\">" + svg.Replace("<svg ", "<svg class=\"ico\" width=\"18\" height=\"18\" aria-hidden=\"true\" ") + "</div>");
            var span = top.Children[0].Children[0];
            Assert.Equal("span", span.Tag);
            var classes = span.Get("class")!.Split(' ');
            Assert.Contains("ico", classes); Assert.Contains("ssam-icon", classes);
            var mask = Assert.Single(classes, c => c.StartsWith("ssam-icon-svg-", StringComparison.Ordinal));
            Assert.StartsWith("width:18px;height:18px", span.Get("style"));
            Assert.Equal("true", span.Get("aria-hidden"));
            Assert.Contains(outcome.Css, rule => rule.StartsWith("." + mask + "{", StringComparison.Ordinal) && rule.Contains("mask:url(\"data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22", StringComparison.Ordinal));
            Assert.Contains(ScreenHtmlNative.IconBase, outcome.Css);
            Assert.Equal(ScreenHtmlNative.SvgMask, outcome.Normalized[0]["code"]!.ToString());
        }
        // One color: the span paints with it.
        Assert.Contains("color:#0F1A14", Normalize(icons[3]).Top.Children[0].Get("style"));
        foreach (var svg in images)
        {
            var (top, outcome) = Normalize(svg.Replace("<svg ", "<svg width=\"20\" height=\"20\" "));
            var img = top.Children[0];
            Assert.Equal("img", img.Tag);
            Assert.Equal("External", img.Get("os-Type"));
            Assert.StartsWith("\"data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22", img.Get("url"));
            Assert.Equal("width:20px;height:20px", img.Get("style"));
            Assert.Empty(outcome.Css);
        }
        // The same drawing twice is one mask rule; a sheet that has it already gets none.
        var twice = Normalize(icons[0] + icons[0]);
        Assert.Equal(2, twice.Outcome.Css.Count);
        Assert.Empty(Normalize(icons[0], sheet: string.Join("\n", twice.Outcome.Css)).Outcome.Css);
    }

    [Fact]
    public void AnImageByUrlOrBindingIsExternalAndAModuleImageStays()
    {
        // A file name (logo.svg) is the module image of its base name, and a binding is chosen by its type (FamiliasRevisaoTests).
        foreach (var (src, url) in new[] { ("https://x.com/a.png", "\"https://x.com/a.png\""), ("data:image/png;base64,AAA", "\"data:image/png;base64,AAA\""),
                     ("/img/a.jpg", "\"/img/a.jpg\""), ("{{ \"https://x.com/\" + Id }}.png", "(\"https://x.com/\" + Id) + \".png\"") })
        {
            var img = Normalize($"<img src=\"{System.Net.WebUtility.HtmlEncode(src)}\" class=\"c\"/>").Top.Children[0];
            Assert.Null(img.Get("src"));
            Assert.Equal("External", img.Get("os-Type"));
            Assert.Equal(url, img.Get("url"));
        }
        // A module image (a name that resolves, the reading's Kind:Name and Owner.Name) stays as it is.
        foreach (var name in new[] { "Logo", "Image:User", "Common.Logo" })
            Assert.Equal(name, Normalize($"<img src=\"{name}\"/>", n => n == name).Top.Children[0].Get("src"));
        // os-Type="External" with a module image: the platform keeps no Image there, src goes.
        var external = Normalize("<img src=\"VCIcon3\" os-Type=\"External\" url='\"a.png\"'/>", n => n == "VCIcon3");
        Assert.Null(external.Top.Children[0].Get("src"));
        Assert.Equal(ScreenHtmlNative.ImageSourceDropped, external.Outcome.Normalized[0]["code"]!.ToString());
        // A URL with another Type is a contradiction: refused with its fix.
        Assert.Equal(ScreenHtmlNative.ImageContradiction, Normalize("<img src=\"https://x.com/a.png\" os-Type=\"Static\"/>").Outcome.Problems[0].Code);
    }

    [Fact]
    public void TheSvgAndSpanSelectorsOfAStyleSheetAlsoMatchTheIconSpansOnce()
    {
        var css = ".nav-item svg{width:18px}\n.badge span, .x > svg:hover{margin:0}\n@media (max-width:600px){svg{display:none}}\n#a .b{color:red}\n@import url(x.css);";
        var widened = ScreenHtmlNative.WidenIconSelectors(css);
        Assert.Contains(".nav-item :is(svg, :where(.ssam-icon)){width:18px}", widened);
        Assert.Contains(".badge span:not(:where(.ssam-icon)), .x > :is(svg, :where(.ssam-icon)):hover{margin:0}", widened);
        Assert.Contains("@media (max-width:600px){:is(svg, :where(.ssam-icon)){display:none}}", widened);
        Assert.Contains("#a .b{color:red}", widened);       // ids, imports: as written
        Assert.Contains("@import url(x.css);", widened);
        Assert.Equal(widened, ScreenHtmlNative.WidenIconSelectors(widened));
    }

    // ---- (5) attributes with bindings ----------------------------------------------------------------------------------------

    [Fact]
    public void AStyleWithABindingIsTheAttributeThatTakesAnExpressionAndAConstantBindingIsItsLiteral()
    {
        // On every widget whose style is its Custom Style (a text), never on an HTML element (whose style is already an attribute).
        foreach (var tag in new[] { "div", "button onclick=\"X\"", "a onclick=\"X\"", "img src=\"https://x/a.png\"", "label", "input bind=\"V\"" })
        {
            var name = tag.Split(' ')[0];
            var html = ScreenHtml.VoidTags.Contains(name) ? $"<{tag} style=\"color:{{{{ C }}}};opacity:0.5\"/>" : $"<{tag} style=\"color:{{{{ C }}}};opacity:0.5\"></{name}>";
            var element = Normalize(html).Top.Children[0];
            Assert.Null(element.Get("style"));
            Assert.Equal("color:{{ C }};opacity:calc(0.5)", element.Get("ext:style"));
        }
        Assert.Equal("color:{{ C }}", Normalize("<span style=\"color:{{ C }}\"></span>").Top.Children[0].Get("style"));
        Assert.Equal("abc", ScreenHtml.ConstantText("{{ \"abc\" }}"));
        Assert.Equal("a 1 b", ScreenHtml.ConstantText("a {{ 1 }} b"));
        Assert.Equal("True", ScreenHtml.ConstantText("{{ True }}"));
        Assert.Null(ScreenHtml.ConstantText("{{ X }}"));
        Assert.Equal("say \"hi\"", ScreenHtml.ConstantText("{{ \"say \"\"hi\"\"\" }}"));
    }

    [Fact]
    public void ProseWhereAnExpressionGoesIsNeverAnExpression()
    {
        foreach (var prose in new[] { "Buscar por nome", "Buscar por nome, cidade, rua…", "Olá!", "Qual?", "a; b", "Total de 3 itens" })
            Assert.True(ScreenHtml.NotAnExpression(prose), prose);
        foreach (var expression in new[] { "Buscar", "\"Buscar por nome\"", "If(A and not B, \"x\", \"y\")", "A.B + 1", "Busca = \"\" or X like \"%a%\"", "#2026-10-12#", "-1.5",
                     "GetPedidos.List.Current.Pedido.Numero + \" - \" + Status", "ListAny(L, X > 0)", "\"a\" + B", "Foo()" })
            Assert.False(ScreenHtml.NotAnExpression(expression), expression);
    }

    [Fact]
    public void WhatTheLanguageSyntaxRefusesIsNoExpressionEither()
    {
        // Integration 24-1 familias: a ':' or an integer with a leading zero reached only the final Verify (no patch).
        foreach (var prose in new[] { "Ex: 123, s/n", "00000-000", "Ex: \"Cliente\", \"Obra\"", "Nota: ver", "07" })
            Assert.True(ScreenHtml.NotAnExpression(prose), prose);
        foreach (var expression in new[] { "0", "0.5", "10 - 2", "X - 0.07", "#2026-01-07#", "\"00000-000\"" })
            Assert.False(ScreenHtml.NotAnExpression(expression), expression);
        Assert.NotNull(Anvil.Core.Preflight.ExpressionSyntax.Check("00000-000"));
        Assert.Null(Anvil.Core.Preflight.ExpressionSyntax.Check("0.07 + 10"));
    }

    // ---- with a module (the Service Studio) ----------------------------------------------------------------------------------

    [Fact]
    public void EveryAttributeTheSyntaxRefusesIsInTheOneRefusalNamedByItsPropertyWithTheCheckedLiteral()
    {
        if (!StudioAvailable()) return;
        // Bound inputs with style and class beside: the Verify's message is on the property object (Prompt), never on style.
        var html = "<screen name=\"ProsaSintaxe\" roles=\"Registered\">\n<var name=\"Cep\" type=\"Text\"/>\n<var name=\"Numero\" type=\"Text\"/>\n"
            + "<input class=\"input mono\" placeholder=\"00000-000\" style=\"max-width:200px;letter-spacing:0.04em\" bind=\"Cep\"/>\n"
            + "<input class=\"input\" placeholder=\"Ex: 123, s/n\" style=\"max-width:200px\" bind=\"Numero\"/>\n</screen>";
        var job = Job(new JsonArray(Op(html)));
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(Host("prose-syntax"), null, job, Path.Combine(Work, "prose-syntax", "out.oml")));
        var problems = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).Select(p => p!.AsObject()).Where(p => p["severity"]?.ToString() != "warning").ToList();
        Assert.Equal(2, problems.Count);
        Assert.All(problems, p => Assert.Contains(": placeholder:", p["message"]!.ToString()));
        Assert.All(problems, p => Assert.NotNull(p["patch"]));
        var corrected = problems[^1]["patch"]![0]!["value"]!.ToString();
        Assert.Contains("placeholder='\"00000-000\"'", corrected);
        Assert.Contains("placeholder='\"Ex: 123, s/n\"'", corrected);
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(Host("prose-syntax-fixed"), null, Job(new JsonArray(Op(corrected))), Path.Combine(Work, "prose-syntax-fixed", "out.oml")))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
    }

    [Fact]
    public void ProseInAnAttributeThatTakesAnExpressionIsRefusedOnceWithTheCheckedLiteralAsThePatch()
    {
        if (!StudioAvailable()) return;
        var html = "<screen name=\"Prosa\" roles=\"Registered\">\n<var name=\"Busca\" type=\"Text\"/>\n<input class=\"input\" bind=\"Busca\" placeholder=\"Buscar por nome, cidade, rua…\"/>\n</screen>";
        var job = Job(new JsonArray(Op(html)));
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(Host("prose"), null, job, Path.Combine(Work, "prose", "out.oml")));
        var problems = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).Select(p => p!.AsObject()).Where(p => p["severity"]?.ToString() != "warning").ToList();
        var problem = Assert.Single(problems);
        Assert.StartsWith("html: line 3 col 1: placeholder:", problem["message"]!.ToString());
        var corrected = problem["patch"]![0]!["value"]!.ToString();
        Assert.Contains("placeholder='\"Buscar por nome, cidade, rua…\"'", corrected);
        // The patch is the next call: accepted.
        var fixedJob = Job(new JsonArray(Op(corrected)));
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(Host("prose-fixed"), null, fixedJob, Path.Combine(Work, "prose-fixed", "out.oml")))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
    }

    [Fact]
    public void ProseInAnAttributeOfAnEditIsRefusedBeforeAnythingIsWrittenWithItsAttributeNamed()
    {
        if (!StudioAvailable()) return;
        var bytes = File.ReadAllBytes(Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml"));
        var host = Host("prose-edit");
        var read = host.HtmlRead(bytes, null, withKeys: false)["documents"]!.AsArray().Select(d => d!.AsObject()).First(d => d["rootKind"]!.ToString() == "MobileScreen" && d["html"]!.ToString().Contains("<div k=", StringComparison.Ordinal));
        var tree = ScreenHtml.Parse(read["html"]!.ToString());
        var container = ScreenHtmlText.Elements(tree).Select(x => x.Node).First(n => n.Tag == "div" && n.Get("k") != null && n.Get("if") == null && n.Get("list") == null);
        var text = ScreenHtmlText.Write(container).TrimEnd('\n');
        var edit = text.EndsWith("/>", StringComparison.Ordinal) ? text[..^2] + "><input placeholder=\"Buscar por nome, cidade\"/></div>" : text[..^"</div>".Length] + "<input placeholder=\"Buscar por nome, cidade\"/></div>";
        var answer = host.HtmlEdit(bytes, new JsonObject { ["screen"] = "@" + read["rootKey"], ["basedOn"] = new JsonObject { ["html"] = read["htmlSha256"]!.ToString() }, ["edit"] = new JsonArray(edit) });
        Assert.False(answer["accepted"]!.GetValue<bool>());
        var problem = Assert.Single(answer["problems"]!.AsArray().Select(p => p!.AsObject()).Where(p => p["severity"]?.ToString() != "warning"));
        Assert.StartsWith("placeholder=\"Buscar por nome, cidade\" on a new Input is no expression", problem["message"]!.ToString());
        Assert.Contains("placeholder='\"Buscar por nome, cidade\"'", problem["fix"]!.ToString());
    }

    [Fact]
    public void AThemeWithNoBaseThemeCarriesTheNativeWidgetsCssOnce()
    {
        if (!StudioAvailable()) return;
        var ops = new JsonArray(
            JsonNode.Parse("""{"op":"create","parent":"@espace","type":"IMobileTheme","name":"SemBase","as":"$t"}"""),
            JsonNode.Parse("""{"op":"set","target":"$t","prop":"BaseTheme","empty":true}"""),
            JsonNode.Parse("""{"op":"set","target":"$t","prop":"StyleSheet","value":".btn{display:inline-flex;gap:8px}"}"""));
        var outPath = Path.Combine(Work, "theme", "out.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(Host("theme"), null, Job(ops), outPath))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        Assert.Contains("THEME_NATIVE_WIDGETS", result.ToJsonString());
        // A second job that writes the base theme again: the block is there, never twice.
        var again = Path.Combine(Work, "theme", "again.oml");
        var second = new JsonArray(JsonNode.Parse("""{"op":"set","target":"MobileTheme:SemBase","prop":"BaseTheme","empty":true}"""));
        var r2 = JsonSerializer.SerializeToNode(JobRunner.Run(Host("theme2"), outPath, Job(second), again))!.AsObject();
        Assert.True(r2["accepted"]!.GetValue<bool>(), r2["details"]?.ToJsonString());
        Assert.DoesNotContain("THEME_NATIVE_WIDGETS", r2.ToJsonString());
        // A theme with its base theme gets nothing.
        var based = new JsonArray(JsonNode.Parse("""{"op":"create","parent":"@espace","type":"IMobileTheme","name":"ComBase","as":"$b"}"""),
            JsonNode.Parse("""{"op":"set","target":"$b","prop":"StyleSheet","value":".a{color:red}"}"""));
        var r3 = JsonSerializer.SerializeToNode(JobRunner.Run(Host("theme3"), null, Job(based), Path.Combine(Work, "theme", "based.oml")))!.AsObject();
        Assert.True(r3["accepted"]!.GetValue<bool>(), r3["details"]?.ToJsonString());
        output.WriteLine("theme with a base: " + (r3.ToJsonString().Contains("THEME_NATIVE_WIDGETS") ? "native widgets written (its base is empty when created)" : "nothing written"));
    }

    [Fact]
    public void EveryFamilyOfTheReactiveAndMobileFixturesReadsBackItsNativeConstruct()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the family battery is skipped."); return; }
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        foreach (var fixture in new[] { "reactive-ui.oml", "mobile-ui.oml" })
            ScreenHtmlFamilyCorpus.Fixture(Path.Combine(Root, "tests", "fixtures", fixture), bytes => host.HtmlFamilyBattery(bytes, maxRoots: 6, log: output.WriteLine), output);
    }

    [Fact]
    public void EveryFamilyOfTheO11CorpusReadsBackItsNativeConstruct()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the family battery is skipped."); return; }
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        ScreenHtmlFamilyCorpus.Check(ScreenHtmlCoverage.Manifest(Root), "o11", bytes => host.HtmlFamilyBattery(bytes, maxRoots: 6), minPerFamily: 60, output);
    }

    private static JsonObject Op(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };

    private static string Job(JsonArray ops)
    {
        var job = new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = ops };
        var dir = Path.Combine(Work, Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "job.json");
        File.WriteAllText(path, job.ToJsonString());
        return path;
    }

    private static ModelHost Host(string name)
    {
        var dir = Path.Combine(Work, name);
        Directory.CreateDirectory(dir);
        return new ModelHost(dir);
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
