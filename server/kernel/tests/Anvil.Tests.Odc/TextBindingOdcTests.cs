using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>T1 on the ODC lane, through the job: the fragment op writes a label, a placeholder and a named binding as their
/// bindings say, and the invariant after the apply refuses a literal that keeps a binding (LITERAL_BINDING_REMNANT) and an
/// Expression that would show markup (HTML_IN_EXPRESSION), named, in one refusal. Needs the ODC Studio.</summary>
public class TextBindingOdcTests(ITestOutputHelper output)
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "text-binding");
    private static readonly string Fixture = Path.Combine(Root, "tests", "fixtures", "odc", "insurance-reactive-r8.oml");

    [Fact]
    public void AFragmentWritesItsLabelAndPlaceholderAsTheirBindingsSay()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var (host, screen, container, variable) = Page();
        var fragment = $"<div class=\"t1-box\"><label for=\"T1Input\">{{{{ \"Search\" }}}}</label>"
            + $"<input id=\"T1Input\" bind=\"{variable}\" placeholder=\"{{{{ &quot;Search by name&quot; }}}}\"/>"
            + $"<label>Name: {{{{ {variable} }}}}</label><span title=\"{{{{ {variable} }}}}\">x</span></div>";
        var result = Run(host, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["parent"] = "@" + container, ["html"] = fragment }) }, "fragment");
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString()[..Math.Min(3000, result.ToJsonString().Length)]);
        var html = host.HtmlRead(File.ReadAllBytes(Path.Combine(Work, "fragment.oml")), screen, withKeys: false)["documents"]![0]!["html"]!.ToString();
        Assert.Contains(">Search</label>", html);
        Assert.Contains("placeholder='\"Search by name\"'", html);
        Assert.Contains("{{ " + variable + " }}", html);
        Assert.Contains("title=\"{{ " + variable + " }}\"", html);
        Assert.DoesNotContain("<text>{{", html);
    }

    [Fact]
    public void ALiteralThatKeepsABindingAndAnExpressionThatShowsMarkupAreRefusedTogether()
    {
        if (!StudioAvailable()) return;
        var (host, _, container, _) = Page();
        var job = new JsonObject { ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = "@" + container, ["type"] = "ITextWidget", ["as"] = "$t" },
            new JsonObject { ["op"] = "set", ["target"] = "$t", ["prop"] = "Text", ["value"] = "{{ \"Status\" }}" },
            new JsonObject { ["op"] = "create", ["parent"] = "@" + container, ["type"] = "IExpression", ["as"] = "$e" },
            new JsonObject { ["op"] = "set", ["target"] = "$e", ["prop"] = "Value", ["value"] = "\"<span class=\"\"icon\"\"></span>\"" }) };
        var result = Run(host, job, "remnant");
        Assert.NotEqual(true, result["accepted"]?.GetValue<bool>());
        var problems = result["problems"] as JsonArray ?? new JsonArray();
        var text = problems.Single(p => p!["code"]!.ToString() == BindingText.Remnant)!;
        // The text of a Text widget: its Value on this lane (Text on O11), named as the text.
        Assert.Equal("TextWidget", text["kind"]!.ToString());
        Assert.Contains(text["property"]!.ToString(), new[] { "Text", "Value" });
        Assert.Equal("the text", text["attribute"]!.ToString());
        Assert.Contains("write the text as Status", text["next"]!.ToString());
        Assert.Contains(problems, p => p!["code"]!.ToString() == BindingText.HtmlInExpression && p["op"]!.GetValue<int>() == 3);
    }

    // A screen of the fixture with a Text variable and a keyed container: the screen, the container's ObjectKey and the variable.
    private (ModelHost Host, string Screen, string Container, string Variable) Page()
    {
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        var read = host.HtmlRead(File.ReadAllBytes(Fixture), null, withKeys: true);
        foreach (var document in read["documents"]!.AsArray().OfType<JsonObject>())
        {
            var html = document["html"]?.ToString() ?? "";
            var tree = ScreenHtml.Parse(html);
            var top = tree.Children.FirstOrDefault(c => !c.IsText && c.Tag == "screen");
            if (top == null) continue;
            var variable = top.Children.FirstOrDefault(c => !c.IsText && c.Tag == "var" && c.Get("type") == "Text")?.Get("name");
            var container = ScreenHtmlText.Elements(tree).FirstOrDefault(e => e.Node.Tag == "div" && e.Node.Get("k") != null && e.Node.Get("if") == null && e.Node.Get("list") == null).Node;
            if (variable == null || container == null || document["keys"] is not JsonObject keys) continue;
            output.WriteLine("screen " + top.Get("name") + ", container " + container.Get("k") + ", variable " + variable);
            return (host, top.Get("name")!, keys[container.Get("k")!]!.ToString(), variable);
        }
        throw new InvalidOperationException("the fixture has no screen with a Text variable and a container");
    }

    private JsonObject Run(ModelHost host, JsonObject job, string name)
    {
        var jobPath = Path.Combine(Work, name + ".json"); File.WriteAllText(jobPath, job.ToJsonString());
        try { return JsonSerializer.SerializeToNode(JobRunner.Run(host, Fixture, jobPath, Path.Combine(Work, name + ".oml")))!.AsObject(); }
        catch (Exception error) {
            var coded = Errors.FindCoded(error);
            output.WriteLine(name + " refused: " + Errors.Text(error)[..Math.Min(3000, Errors.Text(error).Length)]);
            return new JsonObject { ["accepted"] = false, ["code"] = coded?.Code, ["problems"] = coded?.Problems?.DeepClone() };
        }
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(TextBindingOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
