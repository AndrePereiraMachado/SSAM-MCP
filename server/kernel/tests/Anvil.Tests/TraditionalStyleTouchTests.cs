using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model;
using Xunit;

namespace Anvil.Tests;

/// <summary>F1 (served proof): the render-preserving touch that makes a publication take a stylesheet-only change of a
/// Traditional Web element. Traditional Web keeps a widget's Style as the literal text of its class names: the
/// expression form ("" or X + "") the touch wrote before is refused by the Verify (InvalidCSSStyle), so the touch of a
/// Traditional widget toggles one trailing space of that text: the same class names, a changed widget.</summary>
public sealed class TraditionalStyleTouchTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalStyleTouchTests).Assembly.Location)!)!;

    [Fact]
    public void TraditionalStyleTakesClassTextNotAnExpressionAndATrailingSpaceToggleIsValid()
    {
        StudioAssemblies.Bind(null);
        var work = Path.Combine(Root, ".local/lane-ss5/proofs/served-proof", "traditional-style-touch");
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var fixture = Path.Combine(Root, "tests/fixtures/traditional-ui.oml");
        var found = Run(fixture, new JsonArray(new JsonObject { ["op"] = "find", ["type"] = "IContainerWidget", ["max"] = 50 }), Path.Combine(work, "find.oml"));
        File.WriteAllText(Path.Combine(work, "find.json"), found.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        var containers = Results(found).SelectMany(r => r is JsonArray a ? a : new JsonArray()).OfType<JsonObject>().ToList();
        Assert.NotEmpty(containers);
        // Each container with its current Style (the literal text of its class names).
        string StyleOf(string basis, string key, string output)
        {
            var read = Run(basis, new JsonArray(new JsonObject { ["op"] = "get", ["target"] = "@" + key }), output);
            return Results(read).OfType<JsonObject>().First()["properties"]!["Style"]?.ToString() ?? "";
        }
        var styles = containers.Take(12).Select((c, i) => (key: c["key"]!.ToString(), style: StyleOf(fixture, c["key"]!.ToString(), Path.Combine(work, "style-" + i + ".oml")))).ToList();
        var key = styles[0].key;
        // The expression form of the earlier touch: refused by the Verify of the candidate (the 2026-10-22 receipt).
        var expression = Run(fixture, Set(key, "\"\""), Path.Combine(work, "expression.oml"));
        Assert.False(expression["accepted"]!.GetValue<bool>(), expression.ToJsonString());
        Assert.Contains("InvalidCSSStyle", expression.ToJsonString());
        // The literal toggle of the widget's own text: one trailing space, the same class names; accepted, kept as written,
        // and toggled back to the original text.
        foreach (var (k, style) in new[] { styles.FirstOrDefault(s => s.style.Trim() != ""), styles.FirstOrDefault(s => s.style == "") }.Where(s => s.key != null))
        {
            var touched = Path.Combine(work, "touched-" + k.Replace('+', '-').Replace('/', '_') + ".oml");
            var spaced = Run(fixture, Set(k, style + " "), touched);
            Assert.True(spaced["accepted"]!.GetValue<bool>(), spaced.ToJsonString());
            Assert.Equal(style + " ", StyleOf(touched, k, touched + ".read.oml"));
            var back = touched + ".back.oml";
            Assert.True(Run(touched, Set(k, style), back)["accepted"]!.GetValue<bool>());
            Assert.Equal(style, StyleOf(back, k, back + ".read.oml"));
        }

        JsonObject Run(string basis, JsonArray ops, string output)
        {
            var job = output + ".job.json";
            File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
            return JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, output))!.AsObject();
        }
    }

    /// <summary>F1 round 2 (H2, M2, M5): the touch is chosen on the candidate after every op resolved, never over a Style the
    /// job wrote nor on a widget it removed, never makes the job fail, and survives the native three-way merge.</summary>
    [Fact]
    public void TheKernelTouchesAfterTheOpsOnlyWhereNoWidgetChangedAndTheMergeKeepsIt()
    {
        StudioAssemblies.Bind(null);
        var work = Path.Combine(Root, ".local/lane-ss5/proofs/served-proof", "kernel-touch");
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var fixture = Path.Combine(Root, "tests/fixtures/traditional-ui.oml");
        // The containers of the block, read on the base: key and name.
        // The first web block of the fixture that holds containers, and its containers (key, name), read on the base.
        var containers = new List<(string Key, string? Name)>();
        string? blockName = null;
        var module = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [fixture])!;
        try
        {
            static bool Is(object o, string name) => o.GetType().GetInterfaces().Any(i => i.Name == name);
            // In name order, and never a layout block (its containers hold the placeholders the screens fill, so deleting one
            // is refused for its consumers): the enumeration order of the model differs from one process to the next.
            foreach (var block in ((IObjectSignature)module).GetAllDescendantsOfType<IObjectSignature>().Where(o => Is(o, "IWebBlock"))
                .OrderBy(o => TypeResolver.Name(o), StringComparer.Ordinal))
            {
                if (block.GetAllDescendantsOfType<IObjectSignature>().Any(o => Is(o, "IPlaceholderWidget"))) continue;
                var inner = block.GetAllDescendantsOfType<IObjectSignature>().Where(o => Is(o, "IContainerWidget")).Select(o => (o.ObjectKey.ToString(), TypeResolver.Name(o))).ToList();
                if (inner.Count < 2) continue;
                blockName = TypeResolver.Name(block); containers = inner; break;
            }
        }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]); }
        Assert.NotNull(blockName);
        var css = new JsonObject { ["op"] = "set", ["target"] = "IWebBlock:" + blockName, ["prop"] = "StyleSheet", ["value"] = ".card-probe{color:#123456}" };

        // A stylesheet-only job: one touch, the literal text toggled, a widget of the base.
        var only = Path.Combine(work, "only.oml");
        var touched = Run(fixture, new JsonArray(css.DeepClone()), only);
        Assert.True(touched["accepted"]!.GetValue<bool>(), touched.ToJsonString());
        var entry = Assert.Single(touched["styleSheets"]!.AsArray())!.AsObject();
        Assert.Equal("block", entry["kind"]!.ToString()); Assert.Equal("traditional", entry["flavor"]!.ToString());
        Assert.Contains(".card-probe", entry["styleSheet"]!.ToString());
        var touch = entry["touch"]!.AsObject();
        Assert.Contains(containers, c => c.Key == touch["key"]!.ToString());
        Assert.Equal(touch["from"]!.ToString() + " ", touch["value"]!.ToString());
        // The native three-way merge (the one o11_deliver runs) keeps the touch.
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(fixture), File.ReadAllBytes(only), merged);
        Assert.False(merge.HasConflicts, JsonSerializer.Serialize(merge)); Assert.True(merge.LocalIsValid, JsonSerializer.Serialize(merge));
        var read = Run(merged, new JsonArray(new JsonObject { ["op"] = "get", ["target"] = "@" + touch["key"] }), Path.Combine(work, "merged-read.oml"));
        Assert.Equal(touch["value"]!.ToString(), Results(read).OfType<JsonObject>().First()["properties"]!["Style"]!.ToString());

        // H2: the job writes the Style of a container itself (any target form): never overwritten, no touch at all.
        var (key, name) = containers[0];
        var target = name != null ? "IWebBlock:" + blockName + "/" + name : "@" + key;
        var own = Run(fixture, new JsonArray(css.DeepClone(), new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = "Style", ["value"] = "brand-wrap" }), Path.Combine(work, "own.oml"));
        Assert.True(own["accepted"]!.GetValue<bool>(), own.ToJsonString());
        var ownEntry = Assert.Single(own["styleSheets"]!.AsArray())!.AsObject();
        Assert.Null(ownEntry["touch"]); Assert.Equal("the job changes a widget of this element", ownEntry["reason"]!.ToString());
        var ownRead = Run(Path.Combine(work, "own.oml"), new JsonArray(new JsonObject { ["op"] = "get", ["target"] = "@" + key }), Path.Combine(work, "own-read.oml"));
        Assert.Equal("brand-wrap", Results(ownRead).OfType<JsonObject>().First()["properties"]!["Style"]!.ToString());

        // H2: a widget the job deletes is never the touch's target; the job is not refused for it.
        var deleted = Run(fixture, new JsonArray(css.DeepClone(), new JsonObject { ["op"] = "delete", ["target"] = "@" + containers[^1].Key }), Path.Combine(work, "deleted.oml"));
        Assert.True(deleted["accepted"]!.GetValue<bool>(), deleted.ToJsonString());
        Assert.NotEqual(containers[^1].Key, Assert.Single(deleted["styleSheets"]!.AsArray())!["touch"]?["key"]?.ToString());

        // A theme has no widget: reported, never a refusal.
        var theme = Run(fixture, new JsonArray(new JsonObject { ["op"] = "set", ["target"] = "IWebTheme:HeadlessTrad_UI", ["prop"] = "StyleSheet", ["value"] = ".theme-probe{margin:0}" }), Path.Combine(work, "theme.oml"));
        Assert.True(theme["accepted"]!.GetValue<bool>(), theme.ToJsonString());
        var themeEntry = Assert.Single(theme["styleSheets"]!.AsArray())!.AsObject();
        Assert.Equal("theme", themeEntry["kind"]!.ToString()); Assert.Null(themeEntry["touch"]);

        JsonObject Run(string basis, JsonArray ops, string output)
        {
            var job = output + ".job.json";
            File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
            return JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, output))!.AsObject();
        }
    }

    /// <summary>F1 round 3 (battery of 942746c6): on a reactive module the touch reads the Style as the kernel's get shows it
    /// (the expression's text) for every form, writes <c>X + ""</c>, and the candidate stays valid; a reactive screen is never
    /// taken for a Traditional one (an O11 mobile screen implements the web screen interface too).</summary>
    [Fact]
    public void AReactiveTouchKeepsEveryStyleFormValidAndTheSameText()
    {
        StudioAssemblies.Bind(null);
        var work = Path.Combine(Root, ".local/lane-ss5/proofs/served-proof", "reactive-forms");
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var fixture = Path.Combine(Root, "tests/fixtures/reactive-ui.oml");
        var (screen, container, _, _) = ReactiveScreens(host, fixture);
        var forms = new[] { "\"qa\"", "\"a \" + If(True, \"b\", \"c\")", "ToLower(\"A\" + \"B\") + \" x\"", "\"\"" };
        for (var i = 0; i < forms.Length; i++)
        {
            var styled = Path.Combine(work, "styled-" + i + ".oml");
            var setStyle = RunJob(host, fixture, new JsonArray(new JsonObject { ["op"] = "set", ["target"] = "@" + container, ["prop"] = "Style", ["value"] = forms[i] }), styled);
            Assert.True(setStyle["accepted"]!.GetValue<bool>(), setStyle.ToJsonString());
            var touched = Path.Combine(work, "touched-" + i + ".oml");
            var css = RunJob(host, styled, new JsonArray(new JsonObject { ["op"] = "set", ["target"] = "IMobileScreen:" + screen, ["prop"] = "StyleSheet", ["value"] = ".probe-" + i + "{color:#123456}" }), touched);
            Assert.True(css["accepted"]!.GetValue<bool>(), forms[i] + ": " + css.ToJsonString()[..Math.Min(3000, css.ToJsonString().Length)]);
            var entry = Assert.Single(css["styleSheets"]!.AsArray())!.AsObject();
            Assert.Equal("reactive", entry["flavor"]!.ToString());
            var touch = entry["touch"]!.AsObject();
            Assert.Equal(container, touch["key"]!.ToString());
            Assert.Equal(StyleSheetTouch.ExpressionToggle(touch["from"]!.ToString()), touch["value"]!.ToString());
            Assert.DoesNotContain("ValueExpression", touch["from"]!.ToString());
            var read = RunJob(host, touched, new JsonArray(new JsonObject { ["op"] = "get", ["target"] = "@" + container }), touched + ".read.oml");
            Assert.Equal(touch["value"]!.ToString(), Results(read).OfType<JsonObject>().First()["properties"]!["Style"]!.ToString());
        }
    }

    /// <summary>F1 round 3: any new error of the Verify after a touch puts every touch back, recorded per element; a job that
    /// expects that error is still delivered, with the widget as it was.</summary>
    [Fact]
    public void AnyNewVerifyErrorPutsTheTouchBackAndSaysSo()
    {
        StudioAssemblies.Bind(null);
        var work = Path.Combine(Root, ".local/lane-ss5/proofs/served-proof", "reactive-revert");
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var fixture = Path.Combine(Root, "tests/fixtures/reactive-ui.oml");
        var (screen, container, _, otherContainer) = ReactiveScreens(host, fixture);
        var before = RunJob(host, fixture, new JsonArray(new JsonObject { ["op"] = "get", ["target"] = "@" + container }), Path.Combine(work, "before.oml"));
        var original = Results(before).OfType<JsonObject>().First()["properties"]!["Style"]?.ToString() ?? "";
        var job = Path.Combine(work, "revert.oml.job.json");
        File.WriteAllText(job, new JsonObject {
            ["expectValid"] = false,
            ["expectedMessages"] = new JsonArray(new JsonObject { ["id"] = "ExpressionUnknownObject", ["element"] = "Container / Style (CustomProperty)", ["all"] = true, ["why"] = "the error of another screen that the job writes on purpose: the touch must be put back" }),
            ["ops"] = new JsonArray(
                new JsonObject { ["op"] = "set", ["target"] = "IMobileScreen:" + screen, ["prop"] = "StyleSheet", ["value"] = ".probe-revert{color:#123456}" },
                new JsonObject { ["op"] = "set", ["target"] = "@" + otherContainer, ["prop"] = "Style", ["value"] = "\"x\" + NoSuchVariableOfThisScreen" }) }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, fixture, job, Path.Combine(work, "revert.oml")))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString()[..Math.Min(3000, result.ToJsonString().Length)]);
        var entry = result["styleSheets"]!.AsArray().OfType<JsonObject>().Single(e => e["name"]!.ToString() == screen);
        Assert.Null(entry["touch"]); Assert.NotNull(entry["reverted"]);
        Assert.Contains("put back", entry["reason"]!.ToString());
        Assert.True(entry["reverted"]!["restored"]!.GetValue<bool>());
        var read = RunJob(host, Path.Combine(work, "revert.oml"), new JsonArray(new JsonObject { ["op"] = "get", ["target"] = "@" + container }), Path.Combine(work, "revert-read.oml"));
        Assert.Equal(original, Results(read).OfType<JsonObject>().First()["properties"]!["Style"]?.ToString() ?? "");
    }

    /// <summary>R3-D (C:/t/r3/ESTUDO-CSSPATH.md), O11: an element with HTML Elements alone has no widget whose own Style the set
    /// writes. It is left as it was, with its one class, and the answer says so and what to do; a touch there added a second
    /// class attribute, which the Verify refuses.</summary>
    [Fact]
    public void ABlockOfHtmlElementsAloneIsLeftAloneAndTheAnswerSaysWhatToDo()
    {
        StudioAssemblies.Bind(null);
        var work = Path.Combine(Root, ".local/lane-ss5/proofs/served-proof", "html-only");
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var basis = Path.Combine(work, "html-only-base.oml");
        var made = RunJob(host, Path.Combine(Root, "tests/fixtures/reactive-ui.oml"), new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = "IMobileFlow:MainFlow", ["type"] = "IMobileBlock", ["name"] = "HtmlOnly", ["as"] = "$block" },
            new JsonObject { ["op"] = "create", ["parent"] = "$block", ["type"] = "IAdvancedHtml", ["name"] = "Box", ["as"] = "$box" },
            new JsonObject { ["op"] = "set", ["target"] = "$box", ["prop"] = "Tag", ["value"] = "section" },
            new JsonObject { ["op"] = "create", ["parent"] = "$box", ["type"] = "IExtendedProperty", ["as"] = "$class" },
            new JsonObject { ["op"] = "set", ["target"] = "$class", ["prop"] = "Property", ["value"] = "class" },
            new JsonObject { ["op"] = "set", ["target"] = "$class", ["prop"] = "Value", ["value"] = "\"box\"" }), basis);
        Assert.True(made["accepted"]!.GetValue<bool>(), made.ToJsonString());
        var output = Path.Combine(work, "html-only.oml");
        var result = RunJob(host, basis, new JsonArray(new JsonObject { ["op"] = "set", ["target"] = "IMobileBlock:HtmlOnly", ["prop"] = "StyleSheet", ["value"] = ".html-only-probe{color:#123456}" }), output);
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString()[..Math.Min(3000, result.ToJsonString().Length)]);
        var entry = result["styleSheets"]!.AsArray().OfType<JsonObject>().Single(e => e["name"]!.ToString() == "HtmlOnly");
        Assert.Null(entry["touch"]);
        Assert.Null(entry["reverted"]);
        Assert.Equal(StyleSheetTouch.NoWidgetReason, entry["reason"]!.ToString());
        var module = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [output])!;
        try
        {
            static bool Is(object o, string name) => o.GetType().GetInterfaces().Any(i => i.Name == name);
            var box = ((IObjectSignature)module).GetAllDescendantsOfType<IObjectSignature>().Single(o => Is(o, "IAdvancedHtml") && TypeResolver.Name(o) == "Box");
            Assert.Equal(1, box.GetAllDescendantsOfType<IObjectSignature>().Count(o => Is(o, "IExtendedProperty") && string.Equals(ModelHost.Prop(o, "Property")?.ToString(), "class", StringComparison.OrdinalIgnoreCase)));
        }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]); }
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
        StudioAssemblies.Bind(null);
        var made = new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = "IMobileFlow:MainFlow", ["type"] = "IMobileBlock", ["name"] = "StyleBox", ["as"] = "$block" },
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
        StudioAssemblies.Bind(null);
        var error = Assert.ThrowsAny<Exception>(() => RunBox("style-two-readings", new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = "IMobileFlow:MainFlow", ["type"] = "IMobileBlock", ["name"] = "StyleTone", ["as"] = "$block" },
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
        StudioAssemblies.Bind(null);
        var (made, basis) = RunBox("style-continuation-base", new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = "IMobileFlow:MainFlow", ["type"] = "IMobileBlock", ["name"] = "HtmlBox", ["as"] = "$block" },
            new JsonObject { ["op"] = "create", ["parent"] = "$block", ["type"] = "IAdvancedHtml", ["name"] = "Box", ["as"] = "$box" },
            new JsonObject { ["op"] = "set", ["target"] = "$box", ["prop"] = "Tag", ["value"] = "section" },
            new JsonObject { ["op"] = "create", ["parent"] = "IMobileFlow:MainFlow", ["type"] = "IMobileBlock", ["name"] = "EmptyBox" }));
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
        StudioAssemblies.Bind(null);
        const string old = "\"box \" + If(True, \"on\", \"off\")";
        var (made, basis) = RunBox("style-from-base", new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = "IMobileFlow:MainFlow", ["type"] = "IMobileBlock", ["name"] = "KeepBox", ["as"] = "$block" },
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
        StudioAssemblies.Bind(null);
        const string tailwind = "[&>*]:flex";
        JsonArray Ops(string block, string value) => new(
            new JsonObject { ["op"] = "create", ["parent"] = "IMobileFlow:MainFlow", ["type"] = "IMobileBlock", ["name"] = block, ["as"] = "$block" },
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

    private static string BoxWork() { var work = Path.Combine(Root, ".local/lane-ss5/proofs/served-proof", "style-box"); Directory.CreateDirectory(work); return work; }
    private static (JsonObject Result, string Output) RunBox(string name, JsonArray ops) => RunBox(name, ops, Path.Combine(Root, "tests/fixtures/reactive-ui.oml"));
    private static (JsonObject Result, string Output) RunBox(string name, JsonArray ops, string basis)
    {
        var output = Path.Combine(BoxWork(), name + ".oml");
        return (RunJob(new ModelHost(BoxWork()), basis, ops, output), output);
    }

    private static List<string> ClassValuesOf(string oml, string widget)
    {
        var host = new ModelHost(BoxWork());
        var module = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [oml])!;
        try
        {
            static bool IsA(object o, string name) => o.GetType().GetInterfaces().Any(i => i.Name == name);
            var box = ((IObjectSignature)module).GetAllDescendantsOfType<IObjectSignature>().Single(o => IsA(o, "IAdvancedHtml") && TypeResolver.Name(o) == widget);
            return box.GetAllDescendantsOfType<IObjectSignature>().Where(o => IsA(o, "IExtendedProperty") && string.Equals(ModelHost.Prop(o, "Property")?.ToString(), "class", StringComparison.OrdinalIgnoreCase))
                .Select(o => (ModelHost.Prop(o, "Value") as IExpression)?.Text ?? "").ToList();
        }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]); }
    }

    /// <summary>R3-D: "put back" is said only of a widget that reads as it did; the empty Style reads as no text or the empty text.</summary>
    [Theory]
    [InlineData("\"a\"", "\"a\"", null, true)]
    [InlineData("", "\"\"", null, true)]
    [InlineData("\"a\"", "\"a\" + \"\"", null, false)]
    [InlineData("\"a\"", null, null, false)]
    [InlineData("\"a\"", "\"a\"", "the set failed", false)]
    public void TheAnswerSaysPutBackOnlyOfAWidgetThatCameBack(string original, string? read, string? writeError, bool cameBack)
    {
        var reason = StyleSheetTouch.PutBackReason("KEY", original, read, writeError);
        Assert.Equal(cameBack, reason.Contains("was put back", StringComparison.Ordinal));
        if (cameBack) return;
        Assert.Contains("@KEY did not come back", reason);
        Assert.Contains("do not deliver it", reason);
        if (writeError != null) Assert.Contains(writeError, reason);
    }

    /// <summary>F1 round 3: a job that writes no stylesheet pays nothing (no walk, no report).</summary>
    [Fact]
    public void AJobWithoutAStyleSheetPaysNothing()
    {
        Assert.False(StyleSheetTouch.Writes(new JsonArray(new JsonObject { ["op"] = "set", ["target"] = "@k", ["prop"] = "Label", ["value"] = "x" },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray() } })));
        Assert.True(StyleSheetTouch.Writes(new JsonArray(new JsonObject { ["op"] = "set", ["target"] = "@k", ["prop"] = "StyleSheet", ["value"] = "" })));
        Assert.True(StyleSheetTouch.Writes(new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen><style>.a{}</style></screen>" } })));
    }

    // Two reactive screens of the fixture with a container each: (screen, its first container, other screen, its container).
    private static (string Screen, string Container, string Other, string OtherContainer) ReactiveScreens(ModelHost host, string fixture)
    {
        var found = new List<(string Screen, string Container)>();
        var module = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [fixture])!;
        try
        {
            static bool Is(object o, string name) => o.GetType().GetInterfaces().Any(i => i.Name == name);
            static bool Styled(object o) => o.GetType().GetInterfaces().Any(i => i.Name.Contains("Container", StringComparison.Ordinal))
                && o.GetType().GetInterfaces().SelectMany(i => i.GetProperties()).Any(p => p.Name == "Style");
            foreach (var screen in ((IObjectSignature)module).GetAllDescendantsOfType<IObjectSignature>().Where(o => Is(o, "IMobileScreen")))
                if (screen.GetAllDescendantsOfType<IObjectSignature>().FirstOrDefault(Styled) is { } c) found.Add((TypeResolver.Name(screen)!, c.ObjectKey.ToString()));
        }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]); }
        Assert.True(found.Count >= 2, "two reactive screens with a container");
        return (found[0].Screen, found[0].Container, found[1].Screen, found[1].Container);
    }

    private static JsonObject RunJob(ModelHost host, string basis, JsonArray ops, string output)
    {
        var job = output + ".job.json";
        File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
        return JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, output))!.AsObject();
    }

    [Fact]
    public void TheTogglesComeBackAndKeepTheirForm()
    {
        Assert.Equal(" ", StyleSheetTouch.LiteralToggle("")); Assert.Equal("a b ", StyleSheetTouch.LiteralToggle("a b")); Assert.Equal("a b", StyleSheetTouch.LiteralToggle("a b "));
        Assert.Equal("\"\"", StyleSheetTouch.ExpressionToggle("")); Assert.Equal("\"x\" + \"\"", StyleSheetTouch.ExpressionToggle("\"x\"")); Assert.Equal("\"x\"", StyleSheetTouch.ExpressionToggle("\"x\" + \"\""));
    }

    private static JsonArray Set(string key, string value) => new(new JsonObject { ["op"] = "set", ["target"] = "@" + key, ["prop"] = "Style", ["value"] = value });
    private static IEnumerable<JsonNode?> Results(JsonObject result) => (result["results"] as JsonArray ?? new JsonArray()).Select(r => r is JsonObject o && o["result"] is { } inner ? inner : r);
}
