using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>C-22 (F-FigmaMobile-06, F-FT-03; 27/10): what the readers print, the writer reads. The digest printed
/// `navigate ()` (the Previous Screen) and `ajax refresh PlansArea`, and the parser refused both (FLOW_SYNTAX "expected a name
/// at column 10", x20 "expected '('"); the sessions rewrote them by hand (a fixed screen instead of "back", the generic node
/// form). The corpus is every action of the three O11 template fixtures: the flow reader's text of each one parses back, and
/// every node line the digest prints in a form of the language (navigate, ajax refresh, refresh, trigger, raise, message)
/// parses as a step of an action. The digest's summary forms (an assign without the word, no end) are its own and are not
/// judged here.</summary>
public sealed class DigestFlowRoundTripTests(ITestOutputHelper output)
{
    private static readonly string Kernel = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(DigestFlowRoundTripTests).Assembly.Location)!)!;
    private static readonly string[] NodeForms = ["navigate ", "ajax refresh ", "refresh ", "trigger ", "raise ", "message "];

    [Theory]
    [InlineData("reactive-ui.oml")]
    [InlineData("mobile-ui.oml")]
    [InlineData("traditional-ui.oml")]
    public void EveryActionTheReadersPrintParsesBack(string fixture)
    {
        StudioAssemblies.Bind();
        var bytes = File.ReadAllBytes(Path.Combine(Kernel, "tests", "fixtures", fixture));
        var host = new ModelHost(Path.Combine(Kernel, ".local", "digest-roundtrip", Path.GetFileNameWithoutExtension(fixture)));
        var failures = new List<string>();
        var lines = 0;
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        var digest = host.BuildDigest(bytes, sha, "o11");
        foreach (var (key, text) in digest.Sections.Where(x => x.Id is "actions" or "ui").SelectMany(x => x.Blocks.Select(b => (x.Id, b))))
            foreach (var raw in text.Replace("\r\n", "\n").Split('\n'))
            {
                var line = raw.Trim();
                var comment = line.IndexOf("  # ", StringComparison.Ordinal);
                if (comment > 0) line = line[..comment];
                if (!NodeForms.Any(f => line.StartsWith(f, StringComparison.Ordinal)) || line.Contains('?')) continue;
                lines++;
                var terminal = line.StartsWith("navigate ", StringComparison.Ordinal) || line.StartsWith("raise ", StringComparison.Ordinal);
                try { FlowParser.Parse("client action Probe\n  " + line + (terminal ? "" : "\n  end") + "\n"); }
                catch (FormatException error) { failures.Add("digest " + key + ": " + line + " -> " + error.Message); }
            }
        var flow = host.BuildFlow(bytes, sha, "o11");
        var printed = flow.Actions.Where(a => a.Text.Length > 0 && a.FixedPoint).ToList();
        foreach (var action in printed)
        {
            try { FlowParser.Parse(action.Text); }
            catch (FormatException error) { failures.Add("flow " + action.Key + ": " + error.Message + "\n" + action.Text); }
        }
        output.WriteLine($"{lines} digest node lines, {printed.Count} printed flow actions of {flow.Actions.Count}, {failures.Count} that do not parse");
        foreach (var f in failures.Take(40)) output.WriteLine(f + "\n---");
        Assert.Empty(failures);
        Assert.True(lines > 0);
    }

    /// <summary>The two forms of the evidence, written and applied: `navigate ()` is the Previous Screen (mobile fixture) and
    /// `ajax refresh W` the Ajax Refresh of W (Traditional fixture).</summary>
    [Fact]
    public void ThePreviousScreenAndTheAjaxRefreshTheDigestPrintsAreWritten()
    {
        StudioAssemblies.Bind();
        var navigate = FlowParser.Parse("client action GoBack\n  navigate ()\n");
        Assert.Contains(All(navigate), n => n.Kind == "DestinationNode" && n.Prop("Destination") == "PreviousScreen");
        var refresh = FlowParser.Parse("action Home.Toggle\n  ajax refresh PlansArea\n  end\n");
        Assert.Contains(All(refresh), n => n.Kind == "AjaxRefreshNode" && n.Prop("WidgetOrWebBlock") == "PlansArea");

        var work = Path.Combine(Kernel, ".local", "digest-roundtrip", "apply-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work); output.WriteLine(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        // Mobile: a block's client action that goes back (the template's MenuIcon/OnBack form).
        var mobile = Path.Combine(work, "mobile.json");
        File.WriteAllText(mobile, new System.Text.Json.Nodes.JsonObject { ["ops"] = new System.Text.Json.Nodes.JsonArray(
            new System.Text.Json.Nodes.JsonObject { ["op"] = "html", ["data"] = new System.Text.Json.Nodes.JsonObject { ["html"] = "<screen name=\"BackProbe\" roles=\"Registered\" actions=\"GoBack\"><button onclick=\"GoBack\">Back</button></screen>" } },
            new System.Text.Json.Nodes.JsonObject { ["op"] = "logic", ["data"] = new System.Text.Json.Nodes.JsonObject { ["flow"] = "action BackProbe.GoBack\n  navigate ()\n" } }) }.ToJsonString());
        var applied = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(host, Path.Combine(Kernel, "tests/fixtures/mobile-ui.oml"), mobile, Path.Combine(work, "mobile.oml")))!;
        File.WriteAllText(Path.Combine(work, "mobile-result.json"), applied.ToJsonString());
        Assert.True(applied["accepted"]?.GetValue<bool>() == true, applied.ToJsonString());
        var flow = host.BuildFlow(File.ReadAllBytes(Path.Combine(work, "mobile.oml")), "mobile", "o11");
        var back = Assert.Single(flow.Actions, a => a.Name.EndsWith("/GoBack", StringComparison.Ordinal));
        output.WriteLine(back.Text);
        Assert.Contains("navigate PreviousScreen()", back.Text);
        Assert.True(back.FixedPoint);
        // Traditional: a screen action that refreshes a container by Ajax, written in the digest's form.
        var traditional = Path.Combine(work, "traditional.json");
        File.WriteAllText(traditional, new System.Text.Json.Nodes.JsonObject { ["ops"] = new System.Text.Json.Nodes.JsonArray(
            new System.Text.Json.Nodes.JsonObject { ["op"] = "html", ["data"] = new System.Text.Json.Nodes.JsonObject { ["html"] = "<screen name=\"AjaxProbe\" roles=\"Registered\" actions=\"Toggle\"><var name=\"Open\" type=\"Boolean\"/><div id=\"PlansArea\">{{ Open }}</div><a onclick=\"Toggle\" method=\"Ajax\">Toggle</a></screen>" } },
            new System.Text.Json.Nodes.JsonObject { ["op"] = "logic", ["data"] = new System.Text.Json.Nodes.JsonObject { ["flow"] = "action AjaxProbe.Toggle\n  assign Open = not Open\n  ajax refresh PlansArea\n  end\n" } }) }.ToJsonString());
        var ajax = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(host, Path.Combine(Kernel, "tests/fixtures/traditional-ui.oml"), traditional, Path.Combine(work, "traditional.oml")))!;
        File.WriteAllText(Path.Combine(work, "traditional-result.json"), ajax.ToJsonString());
        Assert.True(ajax["accepted"]?.GetValue<bool>() == true, ajax.ToJsonString());
        var toggle = Assert.Single(host.BuildFlow(File.ReadAllBytes(Path.Combine(work, "traditional.oml")), "traditional", "o11").Actions, a => a.Name.EndsWith("/Toggle", StringComparison.Ordinal));
        output.WriteLine(toggle.Text);
        Assert.Contains("AjaxRefreshNode", toggle.Text);
        Assert.Contains("PlansArea", toggle.Text);
    }

    private static IEnumerable<FlowItem> All(FlowItem item) => item.Items.SelectMany(i => All(i).Prepend(i));
}
