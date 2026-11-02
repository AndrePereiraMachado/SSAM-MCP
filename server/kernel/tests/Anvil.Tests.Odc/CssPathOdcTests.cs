using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// T18 on the ODC model (a theme with Theme Editor CSS, so the author half and the effective StyleSheet differ): the keyed css
/// op on the theme, a screen and a block derived from the fixture writes the author half through the one path (the @import the
/// edit brings at the top of the effective StyleSheet, before the Theme Editor block; the effective one composed again), its
/// basedOn is the sha256 of the UserStyleSheet the get reads, F1 reports each element; a stale basedOn is THEME_CHANGED with the
/// current hash, and a raw set takes the same check.
/// </summary>
public sealed class CssPathOdcTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "test-work", "t18-css-path");
    private const string Fixture = "tests/fixtures/odc/insurance-reactive-r8.oml";
    private const string Import = "@import url(\"https://fonts.googleapis.com/css2?family=Inter\");";

    [Fact]
    public void TheCssOpEditsTheAuthorHalfOfEveryStylesheetElement()
    {
        if (!StudioAvailable()) return;
        var elements = Elements();
        Assert.Contains(elements, e => e.Kind == "theme" && e.Split);
        foreach (var (target, kind, author, split) in elements)
        {
            var probe = $".t18-{kind}-probe{{color:#123456}}";
            var result = Run("css-" + kind, new JsonArray(
                new JsonObject { ["op"] = "css", ["target"] = target, ["basedOn"] = ThemeCss.Sha256(author),
                    ["edits"] = new JsonArray(new JsonObject { ["append"] = probe + "\n" + Import }) },
                new JsonObject { ["op"] = "get", ["target"] = target }));
            Assert.True(result["accepted"]!.GetValue<bool>(), target + ": " + Clip(result));
            var css = Results(result).OfType<JsonObject>().First(r => r["css"] != null);
            var properties = Results(result).OfType<JsonObject>().Last(r => r["properties"] != null)["properties"]!.AsObject();
            var written = (properties["UserStyleSheet"] ?? properties["StyleSheet"])!.ToString();
            Assert.Contains(probe, written);
            Assert.True(ThemeCss.Matches(css["basedOn"]!.ToString(), written), target);
            var effective = properties["StyleSheet"]!.ToString();
            // The @import goes first in the stylesheet the edit writes (the author's half of a theme with Theme Editor CSS).
            Assert.True(ThemeCss.ImportsFirst(written).Ok && written.Contains(Import, StringComparison.Ordinal) && written.IndexOf(Import, StringComparison.Ordinal) < written.IndexOf(probe, StringComparison.Ordinal), target + ": " + written[..Math.Min(300, written.Length)]);
            if (split)
            {
                // B4: the effective StyleSheet is the platform's composition, the Theme Editor block and then the author's half
                // (what the saved module holds), and the edit says its @import is ignored there (cssImportsIgnored).
                var generated = properties["GeneratedStyleSheet"]!.ToString();
                Assert.Equal(generated + "\r\n" + written, effective);
                Assert.Contains(Import, css["cssImportsIgnored"]!["imports"]!.AsArray().Select(i => i!.ToString()));
            }
            else Assert.Equal(written, effective);
            var entry = Assert.Single(result["styleSheets"]!.AsArray(), e => e!["name"]!.ToString() == target[(target.IndexOf(':') + 1)..])!;
            Assert.Equal(kind, entry["kind"]!.ToString());
            Assert.True(entry["touch"] != null || entry["reason"]?.ToString() is { Length: > 0 }, entry.ToJsonString());
        }
    }

    [Fact]
    public void AStaleBasedOnIsRefusedOnTheCssOpAndOnTheSet()
    {
        if (!StudioAvailable()) return;
        var (target, _, author, _) = Elements().First(e => e.Kind == "theme");
        foreach (var op in new[]
        {
            // F1b: a stale basedOn whose edits all apply is merged (F1bStop3 below); one whose edit no longer applies is refused.
            new JsonObject { ["op"] = "css", ["target"] = target, ["basedOn"] = ThemeCss.Sha256(author + "x"), ["edits"] = new JsonArray(new JsonObject { ["replaceRule"] = ".t18-no-such-rule", ["body"] = "color:red" }) },
            new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = "StyleSheet", ["value"] = ".a{b:c}", ["basedOn"] = ThemeCss.Sha256(author + "x") },
        })
        {
            var error = Assert.ThrowsAny<Exception>(() => Run("stale-" + op["op"], new JsonArray(op)));
            var coded = Assert.IsType<KernelRefusalException>(Errors.FindCoded(error));
            Assert.Equal(ModelSession.ThemeChanged, coded.Code);
            Assert.Equal(ThemeCss.Sha256(author), coded.Problems![0]!["actual"]!.ToString());
        }
    }

    /// <summary>F1b stop 3 on ODC: the person edits a block's CSS in the Studio after the delivery read it; the css op merges
    /// over it (both changes stay) with a THEME_CHANGED note, instead of refusing.</summary>
    [Fact]
    public void F1bStop3_ACssEditOverCssThePersonChangedAfterBasedOnIsMergedWithANote()
    {
        if (!StudioAvailable()) return;
        // A block: its StyleSheet is all author CSS (a theme with Theme Editor CSS keeps the set apart from the author half).
        var (target, _, author, _) = Elements().First(e => e.Kind == "block");
        const string person = ".f1b-person{color:#654321}";
        const string delivery = ".f1b-delivery{color:#123456}";
        var result = Run("f1b-merge", new JsonArray(
            new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = "StyleSheet", ["value"] = author + "\n" + person },
            new JsonObject { ["op"] = "css", ["target"] = target, ["basedOn"] = ThemeCss.Sha256(author), ["edits"] = new JsonArray(new JsonObject { ["append"] = delivery }) },
            new JsonObject { ["op"] = "get", ["target"] = target }));
        Assert.True(result["accepted"]!.GetValue<bool>(), Clip(result));
        var properties = Results(result).OfType<JsonObject>().Last(r => r["properties"] != null)["properties"]!.AsObject();
        var written = (properties["UserStyleSheet"] ?? properties["StyleSheet"])!.ToString();
        Assert.Contains(person, written);
        Assert.Contains(delivery, written);
        // The css op's own result (on this line a set StyleSheet answers its placement under css too).
        var css = Results(result).OfType<JsonObject>().Last(r => r["css"] != null && r["edits"] != null);
        Assert.Equal(ModelSession.ThemeChanged, css["mergedOver"]!["code"]!.ToString());
        Assert.Contains(result["notes"]!.AsArray(), n => n!["code"]!.ToString() == ModelSession.ThemeChanged);
    }

    /// <summary>Review F1b (1, 2) on ODC: the same css op twice appends once (CSS_APPEND_PRESENT); a rule both changed is named
    /// with its earlier text (mergedOver.rules); an edit by position (nth) over a changed CSS is refused THEME_CHANGED.</summary>
    [Fact]
    public void F1bReview_AppendOnceRulesNamedAndNoRebaseByPosition()
    {
        if (!StudioAvailable()) return;
        var (target, _, author, _) = Elements().First(e => e.Kind == "block");
        const string delivery = ".f1b-twice{color:#123456}";
        JsonObject Op() => new() { ["op"] = "css", ["target"] = target, ["basedOn"] = ThemeCss.Sha256(author), ["edits"] = new JsonArray(new JsonObject { ["append"] = delivery }) };
        var twice = Run("f1b-twice", new JsonArray(Op(), Op(), new JsonObject { ["op"] = "get", ["target"] = target }));
        Assert.True(twice["accepted"]!.GetValue<bool>(), Clip(twice));
        var properties = Results(twice).OfType<JsonObject>().Last(r => r["properties"] != null)["properties"]!.AsObject();
        var written = (properties["UserStyleSheet"] ?? properties["StyleSheet"])!.ToString();
        Assert.Equal(1, System.Text.RegularExpressions.Regex.Matches(written, System.Text.RegularExpressions.Regex.Escape(delivery)).Count);
        Assert.Contains(twice["notes"]!.AsArray(), n => n!["code"]!.ToString() == "CSS_APPEND_PRESENT");
        var rules = Run("f1b-rules", new JsonArray(
            new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = "StyleSheet", ["value"] = author + "\n.f1b-card{color:red;border:0}" },
            new JsonObject { ["op"] = "css", ["target"] = target, ["basedOn"] = ThemeCss.Sha256(author), ["edits"] = new JsonArray(new JsonObject { ["replaceRule"] = ".f1b-card", ["body"] = "color:blue" }) }));
        Assert.True(rules["accepted"]!.GetValue<bool>(), Clip(rules));
        var css = Results(rules).OfType<JsonObject>().Last(r => r["css"] != null && r["edits"] != null);
        Assert.Contains("border:0", Assert.Single(css["mergedOver"]!["rules"]!.AsArray())!["was"]!.ToString());
        var error = Assert.ThrowsAny<Exception>(() => Run("f1b-nth", new JsonArray(
            new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = "StyleSheet", ["value"] = author + "\n.f1b-btn{color:red}\n.f1b-btn{color:green}" },
            new JsonObject { ["op"] = "css", ["target"] = target, ["basedOn"] = ThemeCss.Sha256(author), ["edits"] = new JsonArray(new JsonObject { ["replaceRule"] = ".f1b-btn", ["nth"] = 2, ["body"] = "color:blue" }) })));
        Assert.Equal(ModelSession.ThemeChanged, Assert.IsType<KernelRefusalException>(Errors.FindCoded(error)).Code);
    }

    /// <summary>The block whose first widgets are HTML Elements with a class attribute (they have no Style of their own): the
    /// touch of the CSS takes a container of the block, nothing adds a second class, and the answer names the touch. It was
    /// refused with InvalidHTMLAttribute_Replicated (C:/t/r3/ESTUDO-CSSPATH.md); the walk's order hid it in about 1 run of 10.</summary>
    [Fact]
    public void TheCssOpOnABlockWithHtmlElementsTouchesAWidgetWithAStyleOfItsOwn()
    {
        if (!StudioAvailable()) return;
        var (target, _, author, _) = AllElements().Single(e => e.Target == "IMobileBlock:Menu");
        var result = Run("css-menu", new JsonArray(new JsonObject { ["op"] = "css", ["target"] = target, ["basedOn"] = ThemeCss.Sha256(author),
            ["edits"] = new JsonArray(new JsonObject { ["append"] = ".menu-probe{color:#123456}" }) }));
        Assert.True(result["accepted"]!.GetValue<bool>(), Clip(result));
        var entry = Assert.Single(result["styleSheets"]!.AsArray(), e => e!["name"]!.ToString() == "Menu")!;
        Assert.Null(entry["reverted"]);
        var touched = entry["touch"]!["key"]!.ToString();
        var espace = new ModelHost(Work).Load(File.ReadAllBytes(Path.Combine(Work, "css-menu.oml")));
        try
        {
            var menu = ((IObjectSignature)espace).GetAllDescendantsOfType<IObjectSignature>().Single(o => IsA(o, "IMobileBlock") && TypeResolver.Name(o) == "Menu");
            var widgets = menu.GetAllDescendantsOfType<IObjectSignature>().ToList();
            Assert.False(IsA(widgets.Single(w => w.ObjectKey?.ToString() == touched), "IAdvancedHtml"), "the touch took an HTML Element");
            Assert.Contains(widgets, w => IsA(w, "IAdvancedHtml"));
            foreach (var html in widgets.Where(w => IsA(w, "IAdvancedHtml")))
                Assert.True(ClassAttributes(html) <= 1, TypeResolver.Name(html) + " has " + ClassAttributes(html) + " class attributes");
        }
        finally { ModelHost.Release(espace); }
    }

    /// <summary>An element with HTML Elements alone has no widget to touch: it is left as it was, and the answer says so and what
    /// to do. A touch there added a second class, refused by the Verify, and answered that the widget was put back.</summary>
    [Fact]
    public void ABlockOfHtmlElementsAloneIsLeftAloneAndTheAnswerSaysWhatToDo()
    {
        if (!StudioAvailable()) return;
        var made = Run("html-only-base", new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = "IMobileFlow:Common", ["type"] = "IMobileBlock", ["name"] = "HtmlOnly", ["as"] = "$block" },
            new JsonObject { ["op"] = "create", ["parent"] = "$block", ["type"] = "IAdvancedHtml", ["name"] = "Box", ["as"] = "$box" },
            new JsonObject { ["op"] = "set", ["target"] = "$box", ["prop"] = "Tag", ["value"] = "section" },
            new JsonObject { ["op"] = "create", ["parent"] = "$box", ["type"] = "IExtendedProperty", ["as"] = "$class" },
            new JsonObject { ["op"] = "set", ["target"] = "$class", ["prop"] = "Property", ["value"] = "class" },
            new JsonObject { ["op"] = "set", ["target"] = "$class", ["prop"] = "Value", ["value"] = "\"box\"" }));
        Assert.True(made["accepted"]!.GetValue<bool>(), Clip(made));
        var job = Path.Combine(Work, "html-only.json");
        var basis = Path.Combine(Work, "html-only-base.oml");
        File.WriteAllText(job, new JsonObject { ["base"] = basis, ["expectValid"] = true, ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "set", ["target"] = "IMobileBlock:HtmlOnly", ["prop"] = "StyleSheet", ["value"] = ".html-only-probe{color:#123456}" }) }.ToJsonString());
        var output = Path.Combine(Work, "html-only.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Work), basis, job, output))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), Clip(result));
        var entry = Assert.Single(result["styleSheets"]!.AsArray(), e => e!["name"]!.ToString() == "HtmlOnly")!;
        Assert.Null(entry["touch"]);
        Assert.Null(entry["reverted"]);
        Assert.Equal(StyleSheetTouch.NoWidgetReason, entry["reason"]!.ToString());
        var espace = new ModelHost(Work).Load(File.ReadAllBytes(output));
        try
        {
            var box = ((IObjectSignature)espace).GetAllDescendantsOfType<IObjectSignature>().Single(o => IsA(o, "IAdvancedHtml") && TypeResolver.Name(o) == "Box");
            Assert.Equal(1, ClassAttributes(box));
        }
        finally { ModelHost.Release(espace); }
    }

    /// <summary>R3-D (review V101, round 3): Style on an HTML Element is its one class attribute. Class names become their text,
    /// an expression stays one, and a class the element has is written, not doubled. Before: "card" and If(...) wrote the
    /// expression's text as the class in silence (accepted, """card"""), and a class already there was refused by the Verify.</summary>
    [Theory]
    [InlineData("card", "\"card\"", false)]
    [InlineData("card", "\"card\"", true)]
    [InlineData("\"card\"", "\"card\"", false)]
    [InlineData("\"card\"", "\"card\"", true)]
    [InlineData("card big-box md:flex", "\"card big-box md:flex\"", false)]
    [InlineData("card big-box md:flex", "\"card big-box md:flex\"", true)]
    [InlineData("If(True, \"a\", \"b\")", "If(True, \"a\", \"b\")", false)]
    [InlineData("If(True, \"a\", \"b\")", "If(True, \"a\", \"b\")", true)]
    [InlineData("\"a\" + \"b\"", "\"a\" + \"b\"", false)]
    [InlineData("\"a\" + \"b\"", "\"a\" + \"b\"", true)]
    public void StyleOnAnHtmlElementIsItsOneClassAttribute(string written, string expected, bool hasClass)
    {
        if (!StudioAvailable()) return;
        var made = new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = "IMobileFlow:Common", ["type"] = "IMobileBlock", ["name"] = "StyleBox", ["as"] = "$block" },
            new JsonObject { ["op"] = "create", ["parent"] = "$block", ["type"] = "IAdvancedHtml", ["name"] = "Box", ["as"] = "$box" },
            new JsonObject { ["op"] = "set", ["target"] = "$box", ["prop"] = "Tag", ["value"] = "section" });
        if (hasClass)
        {
            made.Add(new JsonObject { ["op"] = "create", ["parent"] = "$box", ["type"] = "IExtendedProperty", ["as"] = "$class" });
            made.Add(new JsonObject { ["op"] = "set", ["target"] = "$class", ["prop"] = "Property", ["value"] = "class" });
            made.Add(new JsonObject { ["op"] = "set", ["target"] = "$class", ["prop"] = "Value", ["value"] = "\"old\"" });
        }
        made.Add(new JsonObject { ["op"] = "set", ["target"] = "$box", ["prop"] = "Style", ["value"] = written });
        // Written twice: still one attribute, with the last value.
        made.Add(new JsonObject { ["op"] = "set", ["target"] = "$box", ["prop"] = "Style", ["value"] = written });
        var name = "style-box-" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(written)))[..8] + (hasClass ? "-c" : "");
        var (result, output) = RunBox(name, made);
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString()[..Math.Min(2000, result.ToJsonString().Length)]);
        Assert.True(result["isValid"]!.GetValue<bool>());
        Assert.Equal([expected], ClassValuesOf(output, "Box"));
    }

    /// <summary>One bare name that is also an input of the element's block reads two ways: refused with both, nothing written.</summary>
    [Fact]
    public void AStyleNameThatIsAlsoAnInputOfTheBlockIsRefusedWithBothReadings()
    {
        if (!StudioAvailable()) return;
        var error = Assert.ThrowsAny<Exception>(() => RunBox("style-two-readings", new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = "IMobileFlow:Common", ["type"] = "IMobileBlock", ["name"] = "StyleTone", ["as"] = "$block" },
            new JsonObject { ["op"] = "create", ["parent"] = "$block", ["type"] = "IInputParameter", ["name"] = "Tone", ["as"] = "$tone" },
            new JsonObject { ["op"] = "create", ["parent"] = "$block", ["type"] = "IAdvancedHtml", ["name"] = "Box", ["as"] = "$box" },
            new JsonObject { ["op"] = "set", ["target"] = "$box", ["prop"] = "Style", ["value"] = "Tone" })));
        var text = error.ToString();
        Assert.Contains("reads two ways", text);
        Assert.Contains("\"Tone\" for the class name", text);
        Assert.Contains("Tone + \"\" for the value", text);
    }

    /// <summary>The continuation of an element with no widget to touch works: the job's own set of Style on its HTML Element is
    /// a change of a widget of the element. A block with nothing in it says to add a widget, not to write one.</summary>
    [Fact]
    public void AnElementWithNoWidgetToTouchHasAContinuationThatWorks()
    {
        if (!StudioAvailable()) return;
        var (made, basis) = RunBox("style-continuation-base", new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = "IMobileFlow:Common", ["type"] = "IMobileBlock", ["name"] = "HtmlBox", ["as"] = "$block" },
            new JsonObject { ["op"] = "create", ["parent"] = "$block", ["type"] = "IAdvancedHtml", ["name"] = "Box", ["as"] = "$box" },
            new JsonObject { ["op"] = "set", ["target"] = "$box", ["prop"] = "Tag", ["value"] = "section" },
            new JsonObject { ["op"] = "create", ["parent"] = "IMobileFlow:Common", ["type"] = "IMobileBlock", ["name"] = "EmptyBox" }));
        Assert.True(made["accepted"]!.GetValue<bool>(), made.ToJsonString()[..Math.Min(2000, made.ToJsonString().Length)]);
        var (empty, _) = RunBox("style-continuation-empty", new JsonArray(
            new JsonObject { ["op"] = "set", ["target"] = "IMobileBlock:EmptyBox", ["prop"] = "StyleSheet", ["value"] = ".empty-probe{color:#123456}" }), basis);
        var emptyEntry = empty["styleSheets"]!.AsArray().OfType<JsonObject>().Single(e => e["name"]!.ToString() == "EmptyBox");
        Assert.Null(emptyEntry["touch"]);
        Assert.Equal(StyleSheetTouch.EmptyElementReason, emptyEntry["reason"]!.ToString());
        var (both, _) = RunBox("style-continuation-both", new JsonArray(
            new JsonObject { ["op"] = "set", ["target"] = "IMobileBlock:HtmlBox", ["prop"] = "StyleSheet", ["value"] = ".html-probe{color:#123456}" },
            new JsonObject { ["op"] = "set", ["target"] = "IMobileBlock:HtmlBox/IAdvancedHtml:Box", ["prop"] = "Style", ["value"] = "card" }), basis);
        Assert.True(both["accepted"]!.GetValue<bool>(), both.ToJsonString()[..Math.Min(2000, both.ToJsonString().Length)]);
        var entry = both["styleSheets"]!.AsArray().OfType<JsonObject>().Single(e => e["name"]!.ToString() == "HtmlBox");
        Assert.Equal("the job changes a widget of this element", entry["reason"]!.ToString());
    }

    /// <summary>R3-D (review V101, round 4): a set of Style replaces the class attribute of an HTML Element. The get shows it, the
    /// result and the note say what it replaced, and the same value written back keeps it (the continuation of NoWidgetReason).</summary>
    [Fact]
    public void ReplacingTheClassOfAnHtmlElementSaysWhatItWasAndTheGetShowsIt()
    {
        if (!StudioAvailable()) return;
        const string old = "\"box \" + If(True, \"on\", \"off\")";
        var (made, basis) = RunBox("style-from-base", new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = "IMobileFlow:Common", ["type"] = "IMobileBlock", ["name"] = "KeepBox", ["as"] = "$block" },
            new JsonObject { ["op"] = "create", ["parent"] = "$block", ["type"] = "IAdvancedHtml", ["name"] = "Box", ["as"] = "$box" },
            new JsonObject { ["op"] = "set", ["target"] = "$box", ["prop"] = "Tag", ["value"] = "section" },
            new JsonObject { ["op"] = "create", ["parent"] = "$box", ["type"] = "IExtendedProperty", ["as"] = "$class" },
            new JsonObject { ["op"] = "set", ["target"] = "$class", ["prop"] = "Property", ["value"] = "class" },
            new JsonObject { ["op"] = "set", ["target"] = "$class", ["prop"] = "Value", ["value"] = old }));
        Assert.True(made["accepted"]!.GetValue<bool>(), made.ToJsonString()[..Math.Min(2000, made.ToJsonString().Length)]);
        const string box = "IMobileBlock:KeepBox/IAdvancedHtml:Box";
        var (read, _) = RunBox("style-from-read", new JsonArray(new JsonObject { ["op"] = "get", ["target"] = box }), basis);
        Assert.Equal(old, Results(read).OfType<JsonObject>().First(r => r["properties"] != null)["properties"]!["Style"]?.ToString());

        var (replaced, replacedOml) = RunBox("style-from-replaced", new JsonArray(new JsonObject { ["op"] = "set", ["target"] = box, ["prop"] = "Style", ["value"] = "card" }), basis);
        Assert.True(replaced["accepted"]!.GetValue<bool>(), replaced.ToJsonString()[..Math.Min(2000, replaced.ToJsonString().Length)]);
        Assert.Equal(old, Results(replaced).OfType<JsonObject>().First(r => r["via"] != null)["from"]?.ToString());
        Assert.Contains(replaced["notes"]!.AsArray(), n => n!["code"]!.ToString() == "SET_PROPERTY_MAPPED" && n["message"]!.ToString().Contains("replacing " + old, StringComparison.Ordinal));
        Assert.Equal(["\"card\""], ClassValuesOf(replacedOml, "Box"));

        // The continuation: the value the get shows, written back with the CSS, keeps the class and counts as the widget's change.
        var (kept, keptOml) = RunBox("style-from-kept", new JsonArray(
            new JsonObject { ["op"] = "set", ["target"] = "IMobileBlock:KeepBox", ["prop"] = "StyleSheet", ["value"] = ".keep-probe{color:#123456}" },
            new JsonObject { ["op"] = "set", ["target"] = box, ["prop"] = "Style", ["value"] = old }), basis);
        Assert.True(kept["accepted"]!.GetValue<bool>(), kept.ToJsonString()[..Math.Min(2000, kept.ToJsonString().Length)]);
        Assert.Equal([old], ClassValuesOf(keptOml, "Box"));
        Assert.Equal("the job changes a widget of this element", kept["styleSheets"]!.AsArray().OfType<JsonObject>().Single(e => e["name"]!.ToString() == "KeepBox")["reason"]!.ToString());
        Assert.Contains("set that same value", StyleSheetTouch.NoWidgetReason);
        Assert.Contains("keeping its value", StyleSheetTouch.NoWidgetReason);
    }

    /// <summary>R3-D (round 4): class names the parser refuses as an expression (Tailwind) are told to go in quotes, and in quotes they pass.</summary>
    [Fact]
    public void ClassNamesReadAsAnExpressionAreToldToGoInQuotes()
    {
        if (!StudioAvailable()) return;
        const string tailwind = "[&>*]:flex";
        JsonArray Ops(string block, string value) => new(
            new JsonObject { ["op"] = "create", ["parent"] = "IMobileFlow:Common", ["type"] = "IMobileBlock", ["name"] = block, ["as"] = "$block" },
            new JsonObject { ["op"] = "create", ["parent"] = "$block", ["type"] = "IAdvancedHtml", ["name"] = "Box", ["as"] = "$box" },
            new JsonObject { ["op"] = "set", ["target"] = "$box", ["prop"] = "Tag", ["value"] = "section" },
            new JsonObject { ["op"] = "set", ["target"] = "$box", ["prop"] = "Style", ["value"] = value });
        var (refused, _) = RunBox("style-quotes-refused", Ops("QuoteA", tailwind));
        Assert.False(refused["accepted"]!.GetValue<bool>());
        Assert.Contains(refused["notes"]!.AsArray(), n => n!["message"]!.ToString().Contains("write it in quotes: \"" + tailwind + "\"", StringComparison.Ordinal));
        var (quoted, quotedOml) = RunBox("style-quotes-quoted", Ops("QuoteB", "\"" + tailwind + "\""));
        Assert.True(quoted["accepted"]!.GetValue<bool>(), quoted.ToJsonString()[..Math.Min(2000, quoted.ToJsonString().Length)]);
        Assert.Equal(["\"" + tailwind + "\""], ClassValuesOf(quotedOml, "Box"));
    }

    private static (JsonObject Result, string Output) RunBox(string name, JsonArray ops) => RunBox(name, ops, Path.Combine(Root, Fixture));
    private static (JsonObject Result, string Output) RunBox(string name, JsonArray ops, string basis)
    {
        Directory.CreateDirectory(Work);
        var job = Path.Combine(Work, name + ".json");
        var output = Path.Combine(Work, name + ".oml");
        File.WriteAllText(job, new JsonObject { ["base"] = basis, ["expectValid"] = true, ["ops"] = ops }.ToJsonString());
        return (JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Work), basis, job, output))!.AsObject(), output);
    }

    private static List<string> ClassValuesOf(string oml, string widget)
    {
        var espace = new ModelHost(Work).Load(File.ReadAllBytes(oml));
        try
        {
            var box = ((IObjectSignature)espace).GetAllDescendantsOfType<IObjectSignature>().Single(o => IsA(o, "IAdvancedHtml") && TypeResolver.Name(o) == widget);
            return box.GetAllDescendantsOfType<IObjectSignature>().Where(o => IsA(o, "IExtendedProperty") && string.Equals(ModelHost.Prop(o, "Property")?.ToString(), "class", StringComparison.OrdinalIgnoreCase))
                .Select(o => ModelHost.Prop(o, "Value") is { } value ? ModelHost.Prop(value, "Text")?.ToString() ?? "" : "").ToList();
        }
        finally { ModelHost.Release(espace); }
    }

    private static bool IsA(object o, string type) => o.GetType().GetInterfaces().Any(i => i.Name == type);
    private static int ClassAttributes(IObjectSignature widget) => widget.GetAllDescendantsOfType<IObjectSignature>()
        .Count(o => IsA(o, "IExtendedProperty") && string.Equals(ModelHost.Prop(o, "Property")?.ToString(), "class", StringComparison.OrdinalIgnoreCase));

    // One theme, screen and block of the fixture with a stylesheet of its own, with the author CSS: derived from the model, the
    // first of each kind by name (the walk's order changes from one load of a module to the next).
    private static List<(string Target, string Kind, string Author, bool Split)> Elements()
    {
        var found = new List<(string Target, string Kind, string Author, bool Split)>();
        foreach (var element in AllElements())
        {
            // A theme with Theme Editor CSS first: it is the one whose halves differ.
            var same = found.FindIndex(f => f.Kind == element.Kind);
            if (same >= 0 && (found[same].Split || !element.Split)) continue;
            if (same >= 0) found.RemoveAt(same);
            found.Add(element);
        }
        return found;
    }

    // Every theme, screen and block of the fixture with a stylesheet of its own, in one order whatever the walk's.
    private static List<(string Target, string Kind, string Author, bool Split)> AllElements()
    {
        var all = new List<(string Target, string Kind, string Author, bool Split)>();
        Directory.CreateDirectory(Work);
        var espace = new ModelHost(Work).Load(File.ReadAllBytes(Path.Combine(Root, Fixture)));
        try
        {
            foreach (var o in ((IObjectSignature)espace).GetAllDescendantsOfType<IObjectSignature>())
            {
                var names = o.GetType().GetInterfaces().Select(i => i.Name).ToHashSet();
                var type = new[] { "IMobileTheme", "IMobileScreen", "IMobileBlock" }.FirstOrDefault(names.Contains);
                if (type == null || ThemeCss.AuthorOf(o) is not { } author || TypeResolver.Name(o) is not { Length: > 0 } name) continue;
                var kind = type == "IMobileTheme" ? "theme" : type == "IMobileBlock" ? "block" : "screen";
                all.Add((type + ":" + name, kind, author, ThemeCss.Of(o) is { } sheet && ThemeCss.IsSplit(sheet)));
            }
        }
        finally { ModelHost.Release(espace); }
        return all.OrderBy(e => e.Target, StringComparer.Ordinal).ToList();
    }

    private static JsonObject Run(string name, JsonArray ops)
    {
        Directory.CreateDirectory(Work);
        var job = Path.Combine(Work, name + ".json");
        File.WriteAllText(job, new JsonObject { ["base"] = Path.Combine(Root, Fixture), ["expectValid"] = true, ["ops"] = ops }.ToJsonString());
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Work), Path.Combine(Root, Fixture), job, Path.Combine(Work, name + ".oml")))!.AsObject();
    }

    private static IEnumerable<JsonNode?> Results(JsonObject result) => (result["results"] as JsonArray ?? new JsonArray()).Select(r => r is JsonObject o && o["result"] is { } inner ? inner : r);
    private static string Clip(JsonObject result) { var s = result.ToJsonString(); return s[..Math.Min(4000, s.Length)]; }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(CssPathOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
