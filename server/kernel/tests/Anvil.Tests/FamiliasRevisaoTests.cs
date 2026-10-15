using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The review of integration 24-1 familias (2026-10-13), each finding fixed by one rule for its family, judged here without a
/// module (the module parts, both lanes: FamiliasRevisaoScenarios):
/// (1) one patch per document: the corrections of one html composed into one text, proved, or no patch with the reason;
/// (2) a literal is the patch only for prose by the conservative rule, never for an expression typed wrong;
/// (5) what an svg paints by the SVG's own rules (no paint is black; currentColor beside a color is an image, noted), a rule for the
///     inside of an svg is a problem, a use of another file is a problem and of an element of the page is copied in;
/// (6) a src with a scheme is External, a file name is the module image of its base name (or the nearest, with the patch), a
///     binding is chosen by the type of its expression.
/// </summary>
public sealed class FamiliasRevisaoTests
{
    // ---- (1) one patch per document --------------------------------------------------------------------------------------

    private const string Sent = "<screen name=\"S\" roles=\"Registered\">\n<var name=\"X\" type=\"Text\"/>\n<var name=\"Y\" type=\"Text\"/>\n"
        + "<input placeholder=\"Buscar por nome\" bind=\"X\"/>\n<input placeholder=\"Nota: ver\" bind=\"Y\"/>\n</screen>";

    private static JsonObject Problem(string phase, string code, string value)
        => new() { ["phase"] = phase, ["op"] = 0, ["pointer"] = "/ops/0/data/html", ["code"] = code, ["severity"] = "error", ["message"] = code,
            ["patch"] = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = "/ops/0/data/html", ["value"] = value }) };

    private static JsonArray Ops() => new(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = Sent } });

    [Fact]
    public void TheCorrectionsOfOneDocumentAreOnePatchProvedByItsCompile()
    {
        var first = Sent.Replace("placeholder=\"Buscar por nome\"", "placeholder='\"Buscar por nome\"'");
        var second = Sent.Replace("placeholder=\"Nota: ver\"", "placeholder='\"Nota: ver\"'");
        var problems = new List<JsonObject> { Problem("preflight", "RULE_A", first), Problem("verify", "RULE_B", second) };
        string? compiled = null;
        JobRunner.DocumentPatches(problems, Ops(), "/ops", (op, html, css) => { compiled = html; return []; }, null);
        var both = Sent.Replace("placeholder=\"Buscar por nome\"", "placeholder='\"Buscar por nome\"'").Replace("placeholder=\"Nota: ver\"", "placeholder='\"Nota: ver\"'");
        Assert.All(problems, p => Assert.Equal(both, p["patch"]![0]!["value"]!.GetValue<string>()));
        Assert.All(problems, p => Assert.Equal(2, p["patchJoins"]!.GetValue<int>()));
        Assert.Equal(both, compiled);
        // Generated: the two corrections in either order, and with a third problem of the same correction (deduplicated).
        var again = new List<JsonObject> { Problem("verify", "RULE_B", second), Problem("preflight", "RULE_A", first), Problem("apply", "RULE_C", first) };
        JobRunner.DocumentPatches(again, Ops(), "/ops", (_, _, _) => [], null);
        Assert.All(again, p => Assert.Equal(both, p["patch"]![0]!["value"]!.GetValue<string>()));
    }

    [Fact]
    public void TwoCorrectionsOfOnePlaceOrACompileThatFailsLeaveNoPatchAndSayWhy()
    {
        // The same placeholder corrected two ways: two readings.
        var one = Sent.Replace("placeholder=\"Buscar por nome\"", "placeholder='\"Buscar por nome\"'");
        var other = Sent.Replace("placeholder=\"Buscar por nome\"", "placeholder='\"Buscar\"'");
        var problems = new List<JsonObject> { Problem("preflight", "RULE_A", one), Problem("verify", "RULE_B", other) };
        JobRunner.DocumentPatches(problems, Ops(), "/ops", (_, _, _) => [], null);
        Assert.All(problems, p => { Assert.Null(p["patch"]); Assert.Contains("(no patch: two corrections of the html edit the same place differently", p["fix"]!.ToString()); });
        // The composed document does not compile clean: no patch.
        var second = Sent.Replace("placeholder=\"Nota: ver\"", "placeholder='\"Nota: ver\"'");
        var failing = new List<JsonObject> { Problem("preflight", "RULE_A", one), Problem("verify", "RULE_B", second) };
        JobRunner.DocumentPatches(failing, Ops(), "/ops", (_, _, _) => [("HTML_INVALID", "placeholder: still wrong")], null);
        Assert.All(failing, p => { Assert.Null(p["patch"]); Assert.Contains("its compile finds HTML_INVALID", p["fix"]!.ToString()); });
        // Its compile could not run: unproved, no patch.
        var unproved = new List<JsonObject> { Problem("preflight", "RULE_A", one), Problem("verify", "RULE_B", second) };
        JobRunner.DocumentPatches(unproved, Ops(), "/ops", (_, _, _) => null, null);
        Assert.All(unproved, p => Assert.Null(p["patch"]));
        // A problem the compile still finds that nothing corrects (its own problem without a patch) is allowed.
        var open = new List<JsonObject> { Problem("preflight", "RULE_A", one), Problem("verify", "RULE_B", second),
            new() { ["phase"] = "apply", ["op"] = 0, ["code"] = "HTML_INVALID", ["severity"] = "error", ["message"] = "html: line 9 col 1: title: no patch" } };
        JobRunner.DocumentPatches(open, Ops(), "/ops", (_, _, _) => [("HTML_INVALID", "title: no patch")], null);
        Assert.NotNull(open[0]["patch"]);
        Assert.Null(open[2]["patch"]);
        // One patch alone is left as it is.
        var single = new List<JsonObject> { Problem("preflight", "RULE_A", one) };
        JobRunner.DocumentPatches(single, Ops(), "/ops", (_, _, _) => throw new InvalidOperationException("not called"), null);
        Assert.Equal(one, single[0]["patch"]![0]!["value"]!.GetValue<string>());
    }

    [Fact]
    public void TheEditsOfATextAreItsDifferenceAndTwoAtOnePlaceAreRefused()
    {
        var random = new Random(24);
        for (var n = 0; n < 200; n++)
        {
            // Generated: a text and two copies, each with edits at places of its own half; the union holds both.
            var text = new string(Enumerable.Range(0, 300).Select(_ => "abc <>\"=\n"[random.Next(9)]).ToArray());
            string Mutate(string t, int from, int to)
            {
                var chars = t.ToList();
                for (var k = 0; k < 3; k++)
                {
                    var at = random.Next(from, to);
                    switch (random.Next(3)) { case 0: chars.Insert(at, 'X'); break; case 1: chars.RemoveAt(at); break; default: chars[at] = 'Y'; break; }
                }
                return new string(chars.ToArray());
            }
            var left = Mutate(text, 10, 140);
            var right = Mutate(text, 160, 290);
            var edits = TextDiff.Hunks(text, TextDiff.Edits(text, left)!).Concat(TextDiff.Hunks(text, TextDiff.Edits(text, right)!)).ToList();
            var joined = TextDiff.Apply(text, edits);
            Assert.NotNull(joined);
            Assert.Equal(left[..150], joined![..150]);
            Assert.Equal(right[^130..], joined[^130..]);
            Assert.Equal(left, TextDiff.Apply(text, TextDiff.Edits(text, left)!));
        }
        Assert.Null(TextDiff.Apply("abcdef", [new(2, 1, "X"), new(2, 1, "Y")]));
        Assert.Equal("abYdef", TextDiff.Apply("abcdef", [new(2, 1, "Y"), new(2, 1, "Y")]));
    }

    // ---- (2) two readings of what the syntax refuses --------------------------------------------------------------------

    [Fact]
    public void OnlyProseByTheConservativeRuleIsNoExpressionAndAnExpressionTypedWrongIsOne()
    {
        foreach (var prose in new[] { "Buscar por nome", "Ex: 123, s/n", "Nota: ver", "Ex: \"Cliente\", \"Obra\"", "07", "00000-000", "000.000.000-00", "01/05" })
            Assert.True(ScreenHtml.NotAnExpression(prose), prose);
        // An expression typed wrong: a parenthesis or a quote not closed, an operator at the end, a name and its '(' left open, a
        // number with a leading zero in an expression with names.
        foreach (var typo in new[] { "If(IsNew, \"Novo\", \"Editar\"", "Name +", "GetUrl(Id", "\"Total: \" + Count +", "X - 07", "Count * (2 + Y", "If(A, \"x\", \"y\"))" })
        {
            Assert.False(ScreenHtml.NotAnExpression(typo), typo);
            Assert.NotNull(Anvil.Core.Preflight.ExpressionSyntax.Check(typo));
        }
        foreach (var expression in new[] { "0", "0.5", "10.05", "10 - 2", "X - 0.07", "#2026-01-07#", "\"00000-000\"", "\"Ex: 1\"" })
            Assert.False(ScreenHtml.NotAnExpression(expression), expression);
    }

    // ---- (5) svg ------------------------------------------------------------------------------------------------------------

    private static (ScreenHtml.Node Top, ScreenHtmlNative.Outcome Outcome) Normalize(string body, Func<string, bool>? isReference = null, string? sheet = null,
        IEnumerable<string>? images = null, Func<string, IReadOnlyDictionary<string, string>?>? records = null, string? theme = null)
    {
        var top = ScreenHtml.Parse("<screen name=\"S\">" + body + "</screen>").Children.First(c => !c.IsText);
        return (top, ScreenHtmlNative.Apply(top, _ => true, _ => null, isReference ?? (_ => false), sheet, images == null ? null : () => images, records, theme));
    }

    [Fact]
    public void AnSvgPaintsByTheSvgRulesNothingWrittenIsBlackAndCurrentColorBesideAColorIsANotedImage()
    {
        // Generated: every shape with no paint anywhere is the SVG's black (an icon of that color, never currentColor).
        foreach (var shape in new[] { "<path d=\"M1 1h2\"/>", "<circle cx=\"1\" cy=\"1\" r=\"1\"/>", "<rect width=\"2\" height=\"2\"/>", "<g><polygon points=\"0,0 1,1 0,1\"/></g>" })
        {
            Assert.Equal("#000", ScreenHtmlNative.IconColor(ScreenHtml.Parse("<svg viewBox=\"0 0 24 24\">" + shape + "</svg>").Children[0]));
            var span = Normalize("<svg viewBox=\"0 0 24 24\" width=\"16\" height=\"16\">" + shape + "</svg>").Top.Children[0];
            Assert.Equal("span", span.Tag);
            Assert.Contains("color:#000", span.Get("style"));
        }
        // currentColor where a color attribute names it is that color.
        Assert.Equal("#f00", ScreenHtmlNative.IconColor(ScreenHtml.Parse("<svg color=\"#f00\" fill=\"currentColor\"><path d=\"M1 1\"/></svg>").Children[0]));
        // Inherited paints: the root's stroke in currentColor, a child with fill none: currentColor.
        Assert.Equal("", ScreenHtmlNative.IconColor(ScreenHtml.Parse("<svg fill=\"none\" stroke=\"currentColor\"><g><path d=\"M1 1\"/></g></svg>").Children[0]));
        // currentColor beside a literal color: no icon; the image says that currentColor is black there.
        foreach (var mixed in new[] { "<svg viewBox=\"0 0 9 9\"><path stroke=\"currentColor\" fill=\"none\" d=\"M1 1\"/><path fill=\"#f00\" d=\"M2 2\"/></svg>",
                     "<svg viewBox=\"0 0 9 9\" fill=\"currentColor\"><path d=\"M1 1\"/><circle fill=\"#0a0\" r=\"1\"/></svg>" })
        {
            Assert.Null(ScreenHtmlNative.IconColor(ScreenHtml.Parse(mixed).Children[0]));
            var (top, outcome) = Normalize(mixed);
            Assert.Equal("img", top.Children[0].Tag);
            Assert.True(outcome.Normalized.Single(n => n["code"]!.ToString() == ScreenHtmlNative.SvgImage)["currentColorLost"]!.GetValue<bool>());
            Assert.Contains("black in an image", outcome.Normalized[0]["note"]!.ToString());
        }
    }

    [Fact]
    public void ARuleForTheInsideOfAnSvgAndAUseOfAnotherFileAreProblemsAndAUseOfThePageIsCopiedIn()
    {
        var svg = "<svg class=\"icon\" viewBox=\"0 0 9 9\" stroke=\"currentColor\" fill=\"none\"><path d=\"M1 1\"/></svg>";
        // Generated: selectors of the inside of an svg, in the page and in the theme; never a class or an id of that spelling.
        foreach (var css in new[] { ".icon path{stroke:red}", "svg circle, .x{fill:#000}", ".nav g > rect{opacity:.5}", "@media (max-width:9px){.a polyline{stroke:red}}", "svg use{fill:red}" })
        {
            Assert.Contains(Normalize(svg, sheet: css).Outcome.Problems, p => p.Code == ScreenHtmlNative.SvgInnerCss);
            Assert.Contains(Normalize(svg, theme: css).Outcome.Problems, p => p.Code == ScreenHtmlNative.SvgInnerCss && p.Message.StartsWith("the theme's CSS"));
        }
        foreach (var css in new[] { ".path{color:red}", "#circle{x:1}", ".icon{color:red}", "@keyframes g{from{opacity:0}to{opacity:1}}", "a[href=\"path\"]{x:1}", ".g-row{x:1}" })
            Assert.DoesNotContain(Normalize(svg, sheet: css).Outcome.Problems, p => p.Code == ScreenHtmlNative.SvgInnerCss);
        // No svg converted: nothing to say.
        Assert.Empty(Normalize("<div class=\"icon\"></div>", sheet: ".icon path{stroke:red}").Outcome.Problems);
        // <use> of another file, or of an id the page does not have: a problem.
        foreach (var use in new[] { "<use href=\"sprite.svg#home\"/>", "<use xlink:href=\"#nao-existe\"/>" })
            Assert.Contains(Normalize("<svg viewBox=\"0 0 9 9\">" + use + "</svg>").Outcome.Problems, p => p.Code == ScreenHtmlNative.SvgUseExternal);
        // <use> of an element of the page (a sprite): copied into the svg, its image draws it.
        var (top, outcome) = Normalize("<svg style=\"display:none\"><symbol id=\"casa\" viewBox=\"0 0 9 9\"><path d=\"M1 1h7\"/></symbol></svg><svg width=\"9\" height=\"9\"><use href=\"#casa\"/></svg>");
        Assert.Empty(outcome.Problems);
        Assert.Contains(outcome.Normalized, n => n["code"]!.ToString() == ScreenHtmlNative.SvgUseInlined);
        var img = top.Children[1];
        Assert.Equal("img", img.Tag);
        Assert.Contains("symbol", Uri.UnescapeDataString(img.Get("url")!));
    }

    // ---- (6) images ---------------------------------------------------------------------------------------------------------

    [Fact]
    public void AFileNameIsTheModuleImageOfItsBaseNameOrTheNearestWithItsPatch()
    {
        var images = new[] { "Logo", "Avatar", "FamLogo" };
        // Generated: every form of a file name of the prototype.
        foreach (var src in new[] { "logo.png", "assets/logo.png", "./img/Logo.svg", "../a/b/logo.jpg?v=2", "logo.webp#x" })
        {
            var (top, outcome) = Normalize($"<img src=\"{src}\"/>", images: images);
            Assert.Equal("Logo", top.Children[0].Get("src"));
            Assert.Null(top.Children[0].Get("os-Type"));
            Assert.Equal(ScreenHtmlNative.ImageFileName, outcome.Normalized[0]["code"]!.ToString());
        }
        // No image of that name: the problem, with the nearest and its correction when one is nearest.
        var (_, missing) = Normalize("<img src=\"assets/logoo.png\"/>", images: images);
        var problem = Assert.Single(missing.Problems);
        Assert.Equal(ScreenHtmlNative.ImageFileUnknown, problem.Code);
        Assert.Contains("nearest: Logo", problem.Message);
        Assert.Equal(("src", "Logo"), missing.Corrections[(problem.Line, problem.Column)]);
        Assert.Single(Normalize("<img src=\"zzz.png\"/>", images: images).Outcome.Problems);
        // Only a scheme, a network path or an absolute path is a URL (External).
        foreach (var url in new[] { "https://x.com/a.png", "http://x/a", "//cdn.x/a.png", "/img/a.png", "data:image/png;base64,AA", "blob:x" })
        {
            var img = Normalize($"<img src=\"{url}\"/>", images: images).Top.Children[0];
            Assert.Equal("External", img.Get("os-Type"));
            Assert.Equal("\"" + url + "\"", img.Get("url"));
        }
    }

    [Fact]
    public void ABoundSrcIsChosenByTheTypeOfItsExpression()
    {
        var records = new Dictionary<string, IReadOnlyDictionary<string, string>>(StringComparer.OrdinalIgnoreCase)
        {
            ["Produto"] = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Foto"] = "Binary Data", ["FotoUrl"] = "Text", ["Preco"] = "Decimal" },
        };
        IReadOnlyDictionary<string, string>? Records(string name) => records.TryGetValue(name, out var r) ? r : null;
        const string data = "<var name=\"Arquivo\" type=\"Binary Data\"/><var name=\"Endereco\" type=\"Text\"/><var name=\"P\" type=\"Produto\"/><aggregate name=\"GetProdutos\" from=\"Produto\"/>";
        foreach (var (src, kind) in new[] {
                     ("{{ Arquivo }}", "Binary"), ("{{ P.Foto }}", "Binary"), ("{{ GetProdutos.List.Current.Produto.Foto }}", "Binary"), ("{{ GetProdutos.List.Current.Foto }}", "Binary"),
                     ("{{ Endereco }}", "External"), ("{{ P.FotoUrl }}", "External"), ("{{ \"https://x/\" + P.FotoUrl }}", "External"), ("{{ \"data:image/svg+xml,...\" }}", "External") })
        {
            var (top, outcome) = Normalize(data + $"<img src=\"{System.Net.WebUtility.HtmlEncode(src)}\"/>", records: Records);
            var img = top.Children.Last();
            Assert.Empty(outcome.Problems);
            Assert.Equal(kind, img.Get("os-Type"));
            if (kind == "Binary") Assert.Equal(ScreenHtml.Unsugar(src), img.Get("os-ImageContent"));
            else Assert.Equal(ScreenHtml.Unsugar(src), img.Get("url"));
        }
        // The row of a list (list + as).
        var row = Normalize(data + "<div list=\"GetProdutos.List\" as=\"Linha\"><img src=\"{{ Linha.Foto }}\"/></div>", records: Records).Top.Children.Last().Children[0];
        Assert.Equal("Binary", row.Get("os-Type"));
        // Without a type this side knows, or a type that is neither: refused with both forms in the fix.
        foreach (var src in new[] { "{{ Cliente.Foto }}", "{{ GetFoto(Id) }}", "{{ P.Preco }}" })
        {
            var problem = Assert.Single(Normalize(data + $"<img src=\"{src}\"/>", records: Records).Outcome.Problems);
            Assert.Equal(ScreenHtmlNative.ImageBindingType, problem.Code);
            Assert.Contains("os-Type=\"Binary\" os-ImageContent=", problem.Fix);
        }
    }
}
