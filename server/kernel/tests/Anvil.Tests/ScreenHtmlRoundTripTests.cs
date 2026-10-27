using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>F2 on the O11 lane (read -> edit -> read is a faithful round trip): the generated sweep (ModelHost.HtmlRoundTripSweep)
/// over the Reactive and Mobile fixtures, every case derived from the property model of the element. A Traditional Web module
/// reads as os-opaque on this base (its widgets have no ssam-html/1 form before D2): its roots are counted, never swept. Needs the
/// Service Studio.</summary>
public class ScreenHtmlRoundTripTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenHtmlRoundTripTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "screen-html-round-trip");

    [Theory]
    [InlineData("reactive-ui.oml")]
    [InlineData("mobile-ui.oml")]
    [InlineData("traditional-ui.oml")]
    public void EveryPropertyTheModelLetsAnEditWriteReadsBackAsWritten(string fixture)
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the F2 sweep is skipped."); return; }
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        var sweep = host.HtmlRoundTripSweep(File.ReadAllBytes(Path.Combine(Root, "tests", "fixtures", fixture)), log: output.WriteLine);
        File.WriteAllText(Path.Combine(Work, fixture + ".sweep.json"), sweep.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        ScreenHtmlRoundTripReport.Check(sweep, fixture, output);
    }

    // ---- the four problems of the owner's audit (22/10), on the neutral Reactive fixture --------------------------------------

    // 1. One property model, one comparison: a value written explicitly at the default equals the value left out, and a value is the
    // same whatever type letter the decoder gave it (maxlength="51" on an input whose MaxLength was null decoded as an expression
    // and read back as the number it is: refused HTML_EDIT_NOT_APPLIED before F2).
    [Fact]
    public void AValueIsComparedByItsEffectiveValueBothWays()
    {
        if (!StudioAvailable()) return;
        var (host, bytes, read, html, sha) = Login();
        var tree = ScreenHtml.Parse(html);
        Attribute(Element(tree, "w21"), "maxlength", "51");
        Attribute(Element(tree, "w31"), "os-IsDefault", "False");
        var answer = host.HtmlEdit(bytes, Data(sha, read, [ScreenHtmlText.Write(Element(tree, "w21")), ScreenHtmlText.Write(Element(tree, "w31"))]), Path.Combine(Work, "effective.oml"));
        Assert.True(answer["accepted"]!.GetValue<bool>(), answer.ToJsonString());
        var after = ScreenHtml.Parse(Html(host, Path.Combine(Work, "effective.oml")));
        Assert.Equal("51", Element(after, "w21").Get("maxlength"));
        // The default written explicitly reads back as the text that left it out (the fixed point).
        Assert.Null(Element(after, "w31").Get("os-IsDefault"));
    }

    // 2. A property the page does not keep (DesignMode: the Studio's design-time preview) is refused before anything is written,
    // named with the element, the property, expected and actual and one next call (before F2: written, then HTML_EDIT_NOT_APPLIED
    // "p:DesignMode is absent, the edit says 'e:ShowFalse'" with no element).
    [Fact]
    public void APropertyThePageDoesNotKeepIsRefusedBeforeAnythingIsWritten()
    {
        if (!StudioAvailable()) return;
        var (host, bytes, read, html, sha) = Login();
        var tree = ScreenHtml.Parse(html);
        Attribute(Element(tree, "w15"), "os-DesignMode", "ShowFalse");
        var answer = host.HtmlEdit(bytes, Data(sha, read, [ScreenHtmlText.Write(Element(tree, "w15"))]));
        Assert.False(answer["accepted"]!.GetValue<bool>());
        var problem = answer["problems"]!.AsArray().Single()!;
        Assert.Equal("HTML_PROPERTY_NOT_KEPT", problem["code"]!.ToString());
        Assert.Equal("w15", problem["k"]!.ToString());
        Assert.Equal("DesignMode", problem["property"]!.ToString());
        Assert.Equal("ShowFalse", problem["actual"]!.ToString());
        Assert.StartsWith("absent", problem["expected"]!.ToString());
        Assert.Equal("remove os-DesignMode and send the edit again", problem["next"]!.ToString());
    }

    // 3. A keyed widget moved into a new container keeps what the edit says of it and of everything inside it (the platform's move
    // recreates the subtree with the Width and MarginLeft it gives a widget there: HTML_EDIT_NOT_APPLIED before F2), its references
    // follow it (a label's for= its input) and the module has no new Verify error.
    [Fact]
    public void AKeyedWidgetMovedIntoANewContainerKeepsItsFactsAndItsReferences()
    {
        if (!StudioAvailable()) return;
        var (host, bytes, read, html, sha) = Login();
        var tree = ScreenHtml.Parse(html);
        var form = Element(tree, "w7");
        var holder = ScreenHtmlText.Parents(tree)[form];
        var wrapper = new ScreenHtml.Node { Tag = "div" }; wrapper.Attributes.Add(new("class", "login-frame"));
        holder.Children[holder.Children.IndexOf(form)] = wrapper; wrapper.Children.Add(form);
        var answer = host.HtmlEdit(bytes, Data(sha, read, [ScreenHtmlText.Write(Element(tree, "w6"))]), Path.Combine(Work, "move.oml"));
        Assert.True(answer["accepted"]!.GetValue<bool>(), answer.ToJsonString()[..Math.Min(3000, answer.ToJsonString().Length)]);
        var result = answer["result"]!;
        Assert.Equal(1, result["counts"]!["move"]!.GetValue<int>());
        // The identity of the moved form: the change of ObjectKey the platform's move gives is said, never hidden.
        Assert.Contains(result["keyChanged"]!.AsArray(), c => c!["k"]!.ToString() == "w7");
        var after = Html(host, Path.Combine(Work, "move.oml"));
        Assert.Equal(ScreenHtmlText.WithoutKeys(ScreenHtmlText.Write(tree)), ScreenHtmlText.WithoutKeys(after));
        Assert.Contains("for=\"Input_UsernameVal\"", after);
        Assert.Contains("for=\"Input_PasswordVal\"", after);
    }

    // 4. Every refusal names the element, the property, expected and actual, and one next call: a value outside the enumeration of
    // a property, before anything is written (before F2: the setter's exception at apply time, without expected).
    [Fact]
    public void AValueOutsideItsEnumerationIsRefusedWithTheElementThePropertyAndTheMembers()
    {
        if (!StudioAvailable()) return;
        var (host, bytes, read, html, sha) = Login();
        var tree = ScreenHtml.Parse(html);
        Attribute(Element(tree, "w10"), "os-Type", "Statc");
        var answer = host.HtmlEdit(bytes, Data(sha, read, [ScreenHtmlText.Write(Element(tree, "w10"))]));
        Assert.False(answer["accepted"]!.GetValue<bool>());
        var problem = answer["problems"]!.AsArray().Single()!;
        Assert.Equal("HTML_PROPERTY_VALUE", problem["code"]!.ToString());
        Assert.Equal("w10", problem["k"]!.ToString());
        Assert.Equal("Type", problem["property"]!.ToString());
        Assert.Equal("Statc", problem["actual"]!.ToString());
        Assert.StartsWith("one of ", problem["expected"]!.ToString());
        Assert.StartsWith("write os-Type=\"Static\"", problem["next"]!.ToString());
    }

    // The F1 stylesheet touch (StyleSheetTouch, integracao/marco-a6 942746c6) keeps the round trip: a widget whose class the touch
    // changed (+ "" on a reactive Style Classes; a trailing space in a Traditional Style, the same class names) reads back as it
    // is, the text read and written again is a fixed point, and an edit that writes the class without the touch, beside another
    // change, applies and reads back with the same class names (the Verify compares a class by its list of names).
    [Fact]
    public void AClassTheStylesheetTouchChangedKeepsTheRoundTrip()
    {
        if (!StudioAvailable()) return;
        var (host, bytes, read, html, sha) = Login();
        foreach (var (name, touched) in new[] {
                ("expression", "{{ " + StyleSheetTouch.ExpressionToggle("\"btn btn-primary\"") + " }}"),
                ("literal", StyleSheetTouch.LiteralToggle("btn btn-primary")) }) {
            // The touch, as F1 writes it, on the Login button w31.
            var tree = ScreenHtml.Parse(html);
            Attribute(Element(tree, "w31"), "class", touched);
            var touchedPath = Path.Combine(Work, "touch-" + name + ".oml");
            var touch = host.HtmlEdit(bytes, Data(sha, read, [ScreenHtmlText.Write(Element(tree, "w31"))]), touchedPath);
            Assert.True(touch["accepted"]!.GetValue<bool>(), name + ": " + touch.ToJsonString());
            var touchedBytes = File.ReadAllBytes(touchedPath);
            var touchedRead = host.HtmlRead(touchedBytes, "Login", withKeys: false);
            var touchedHtml = touchedRead["documents"]![0]!["html"]!.ToString();
            var touchedSha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(touchedBytes)).ToLowerInvariant();
            var button = Element(ScreenHtml.Parse(touchedHtml), "w31");
            Assert.Equal("btn btn-primary", ScreenHtmlModule<OutSystems.Model.IObjectSignature>.EditPlan.ClassTokens(
                button.Get("class")!.StartsWith("{{", StringComparison.Ordinal) ? "e:" + button.Get("class")![3..^3] : "t:" + button.Get("class")));
            // Read and written again: nothing to write, the same text.
            var same = host.HtmlEdit(touchedBytes, Data(touchedSha, touchedRead, [ScreenHtmlText.Write(button)]), Path.Combine(Work, "touch-" + name + "-same.oml"));
            Assert.True(same["accepted"]!.GetValue<bool>(), name + ": " + same.ToJsonString());
            Assert.Equal(touchedHtml, Html(host, Path.Combine(Work, "touch-" + name + "-same.oml")));
            // The class written without the touch, beside another change of the same element: applied, the same class names.
            var edit = ScreenHtml.Parse(touchedHtml);
            Attribute(Element(edit, "w31"), "class", "btn btn-primary");
            Attribute(Element(edit, "w31"), "os-IsDefault", "True");
            var plain = host.HtmlEdit(touchedBytes, Data(touchedSha, touchedRead, [ScreenHtmlText.Write(Element(edit, "w31"))]), Path.Combine(Work, "touch-" + name + "-plain.oml"));
            Assert.True(plain["accepted"]!.GetValue<bool>(), name + ": " + plain.ToJsonString());
            var after = Element(ScreenHtml.Parse(Html(host, Path.Combine(Work, "touch-" + name + "-plain.oml"))), "w31");
            Assert.Equal("btn btn-primary", after.Get("class"));
            Assert.Equal("True", after.Get("os-IsDefault"));
        }
    }

    // A refusal of the Verify says each difference as the reading prints it (the attribute as written and as the module read again
    // has it: no ObjectKey, no outside name, no canonical expression), and its next names only values an edit may write (review of
    // F2, finding 5). The case: os-MarginTop, which the platform keeps inside the element's inline style.
    [Fact]
    public void AVerifyRefusalSaysEachDifferenceAsTheReadingPrintsIt()
    {
        if (!StudioAvailable()) return;
        var (host, bytes, read, html, sha) = Login();
        var tree = ScreenHtml.Parse(html);
        Attribute(Element(tree, "w10"), "os-MarginTop", "3 col");
        var answer = host.HtmlEdit(bytes, Data(sha, read, [ScreenHtmlText.Write(Element(tree, "w10"))]));
        Assert.False(answer["accepted"]!.GetValue<bool>());
        var problem = answer["problems"]!.AsArray().Single()!;
        Assert.Equal(ScreenHtmlEdit.NotApplied, problem["code"]!.ToString());
        Assert.Equal("w10", problem["k"]!.ToString());
        var differences = problem["differences"]!.AsArray();
        Assert.Contains(differences, d => d!["attribute"]!.ToString() == "os-MarginTop" && d["expected"]!.ToString() == "3 col" && d["actual"] == null);
        Assert.Contains(differences, d => d!["attribute"]!.ToString() == "style" && d["actual"]!.ToString().Contains("margin-top", StringComparison.Ordinal));
        Assert.All(differences, d => Assert.Null(d!["actualText"]));
        var text = problem.ToJsonString();
        var keys = host.HtmlRead(bytes, "Login", withKeys: true)["documents"]![0]!["keys"]!.AsObject().Select(p => p.Value?.ToString()).ToList();
        Assert.NotEmpty(keys);
        foreach (var key in keys) if (key is { Length: > 8 }) Assert.DoesNotContain(key, text);
        Assert.DoesNotContain("\"~", text);
        var next = problem["next"]!.ToString();
        Assert.Contains("style=\"", next);
        Assert.Contains("without os-MarginTop", next);
    }

    // A stale edit of an element the platform's move gave a new key is refused saying it was moved and where it is now, never that it
    // was removed (the review of F2, finding 6).
    [Fact]
    public void AnElementMovedSinceTheReadingIsSaidToHaveMovedNotRemoved()
    {
        var old = "<screen name=\"S\">\n<div k=\"w1\" class=\"a\">\n <form k=\"w2\" id=\"LoginForm\" class=\"f\"/>\n</div>\n</screen>\n";
        var now = "<screen name=\"S\">\n<div k=\"w1\" class=\"a\">\n <div k=\"w2\" class=\"frame\">\n  <form k=\"w3\" id=\"LoginForm\" class=\"f\"/>\n </div>\n</div>\n</screen>\n";
        var moved = ModelSession.MovedSince(old, "w2", now);
        Assert.NotNull(moved);
        Assert.Equal("w3", moved!.Value.K);
        Assert.Contains("k=\"w2\"", moved.Value.Parent);
        // Removed: no element of that name and text now.
        Assert.Null(ModelSession.MovedSince(old, "w2", "<screen name=\"S\">\n<div k=\"w1\" class=\"a\"/>\n</screen>\n"));
        // A twin is never taken for it.
        var twins = "<screen name=\"S\">\n<div k=\"w1\"><i k=\"w2\" class=\"x\"/></div>\n<i k=\"w3\" class=\"x\"/>\n</screen>\n";
        Assert.Null(ModelSession.MovedSince(twins, "w2", "<screen name=\"S\">\n<div k=\"w1\"/>\n<div k=\"w2\"><i k=\"w3\" class=\"x\"/></div>\n</screen>\n"));
    }

    private (ModelHost Host, byte[] Bytes, JsonObject Read, string Html, string Sha) Login()
    {
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        var bytes = File.ReadAllBytes(Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml"));
        var read = host.HtmlRead(bytes, "Login", withKeys: false);
        return (host, bytes, read, read["documents"]![0]!["html"]!.ToString(), Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant());
    }
    private static JsonObject Data(string sha, JsonObject read, IEnumerable<string> edits) => new() {
        ["screen"] = "Login", ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = read["documents"]![0]!["htmlSha256"]!.DeepClone() },
        ["edit"] = new JsonArray(edits.Select(e => (JsonNode)e).ToArray()) };
    private static string Html(ModelHost host, string oml) => host.HtmlRead(File.ReadAllBytes(oml), "Login", withKeys: false)["documents"]![0]!["html"]!.ToString();
    private static ScreenHtml.Node Element(ScreenHtml.Node tree, string k) => ScreenHtmlText.Elements(tree).First(x => x.Node.Get("k") == k).Node;
    private static void Attribute(ScreenHtml.Node node, string name, string value)
    {
        var i = node.Attributes.FindIndex(a => a.Key == name);
        if (i >= 0) node.Attributes[i] = new(name, value); else node.Attributes.Add(new(name, value));
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
