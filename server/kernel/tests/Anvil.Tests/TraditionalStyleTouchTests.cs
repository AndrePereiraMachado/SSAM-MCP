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
        var read = RunJob(host, Path.Combine(work, "revert.oml"), new JsonArray(new JsonObject { ["op"] = "get", ["target"] = "@" + container }), Path.Combine(work, "revert-read.oml"));
        Assert.Equal(original, Results(read).OfType<JsonObject>().First()["properties"]!["Style"]?.ToString() ?? "");
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
