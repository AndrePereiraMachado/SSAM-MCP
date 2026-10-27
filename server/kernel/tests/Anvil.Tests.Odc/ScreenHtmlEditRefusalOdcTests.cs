using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>L3d on the ODC lane (the mirror of ScreenHtmlEditRefusalTests): relato 9540e92c (the Menu block of DemoReactive, its
/// div PageLinks with os-GridColumns, os-GridRows and os-Gap, edited with a new link), relato e21fa130 (a new &lt;var type&gt;
/// beside a checkbox bound to it), the class of a new If and enabled of an &lt;upload&gt;. Needs the ODC Studio.</summary>
public class ScreenHtmlEditRefusalOdcTests(ITestOutputHelper output)
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "screen-html-edit-refusals");
    private static readonly string Insurance = Path.Combine(Root, "tests", "fixtures", "odc", "insurance-reactive-r8.oml");

    // Relato 9540e92c: the edit kept the grid the reading wrote and added a link, and the platform received an empty
    // GridColumns ("The input string '' was not in a correct format"): a property the edit left out took the empty value of its
    // type when the Studio's defaults were not measured, which is refused before the plan now (HTML_STUDIO_DEFAULTS). Today: the
    // same edit over a grid of the reading applies; leaving the grid out writes the Studio's default; an empty value is refused
    // before the build with a patch that applies.
    [Fact]
    public void TheGridOfTheMenuKeepsItsValuesAndAnEmptyOneIsRefusedBeforeTheBuild()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var host = Host();
        var bytes = File.ReadAllBytes(Insurance);
        // The reading with a grid of its own (the fixture's PageLinks is at the Studio's default, which the reading leaves out).
        var grid = Apply(host, bytes, Data(host, bytes, "Menu", new JsonObject { ["set"] = "w7", ["attributes"] = new JsonObject { ["os-GridColumns"] = "4", ["os-GridRows"] = "2", ["os-Gap"] = "16px" } }), "grid");
        Assert.True(grid["accepted"]!.GetValue<bool>(), grid.ToJsonString());
        var withGrid = File.ReadAllBytes(Path.Combine(host.WorkDirectory, "grid.oml"));
        var read = host.HtmlRead(withGrid, "Menu");
        Assert.Contains("<div k=\"w7\" id=\"PageLinks\" class=\"app-menu-links\" os-Gap=\"16px\" os-GridColumns=\"4\" os-GridRows=\"2\" role=\"menubar\"/>", read["documents"]![0]!["html"]!.ToString());

        // The edit of the relato: the element whole, its grid as read, a new link inside.
        var relato = Data(host, withGrid, "Menu");
        relato.Remove("edits");
        relato["edit"] = new JsonArray("<div k=\"w7\" id=\"PageLinks\" class=\"app-menu-links\" os-Gap=\"16px\" os-GridColumns=\"4\" os-GridRows=\"2\" role=\"menubar\"><a onclick=\"MobileScreen:Login\" role=\"menuitem\">Conversões</a></div>");
        var kept = Apply(host, withGrid, relato, "relato");
        Assert.True(kept["accepted"]!.GetValue<bool>(), kept.ToJsonString());

        // The grid left out: the Studio's default.
        var dropped = Apply(host, withGrid, Data(host, withGrid, "Menu", new JsonObject { ["set"] = "w7", ["attributes"] = new JsonObject { ["os-GridColumns"] = null, ["os-GridRows"] = null, ["os-Gap"] = null } }), "dropped");
        Assert.True(dropped["accepted"]!.GetValue<bool>(), dropped.ToJsonString());

        // An empty GridColumns: refused before the build, the reading's value named, and the patch applies.
        var data = Data(host, withGrid, "Menu", new JsonObject { ["set"] = "w7", ["attributes"] = new JsonObject { ["os-GridColumns"] = "" } });
        var problem = Assert.Single(Problems(Apply(host, withGrid, data, "empty")));
        Assert.Equal("HTML_VALUE_EMPTY", problem["code"]!.ToString());
        Assert.Contains("os-GridColumns=\"\" on Container k=\"w7\": GridColumns takes a value", problem["message"]!.ToString());
        Assert.Contains("the reading has os-GridColumns=\"4\"", problem["fix"]!.ToString());
        PatchApplies(host, withGrid, data, problem, "empty-patched");

        // On a new container the type is the one the Studio was measured with.
        var fresh = Assert.Single(Problems(Apply(host, withGrid, Data(host, withGrid, "Menu", new JsonObject { ["into"] = "w7", ["insert"] = "<div os-GridColumns=\"\">x</div>" }), "empty-new")));
        Assert.Equal("HTML_VALUE_EMPTY", fresh["code"]!.ToString());
        Assert.Contains("GridColumns takes a value", fresh["message"]!.ToString());
    }

    // The link of the relato written onclick="Login" (the name of the screen): in this module the name resolves first to what
    // an event cannot run, and the platform refused the set after the build ("A OutSystems.Model.IObject cannot be used as the
    // value for the ...Destination property"). Refused before the build, the screen as the reading writes it in the patch.
    [Fact]
    public void ALinkThatNamesWhatNoEventRunsIsRefusedBeforeTheBuild()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var host = Host();
        var bytes = File.ReadAllBytes(Insurance);
        var data = Data(host, bytes, "Menu");
        data.Remove("edits");
        data["edit"] = new JsonArray("<div k=\"w7\" id=\"PageLinks\" class=\"app-menu-links\" role=\"menubar\"><a onclick=\"Login\" role=\"menuitem\">Conversões</a></div>");
        var problem = Assert.Single(Problems(Apply(host, bytes, data, "destination")));
        Assert.Equal(ScreenHtmlEdit.NameUnknown, problem["code"]!.ToString());
        Assert.Contains("which an event cannot run", problem["message"]!.ToString());
        Assert.StartsWith("write onclick=\"MobileScreen:Login\"", problem["fix"]!.ToString());
        PatchApplies(host, bytes, data, problem, "destination-patched");
    }

    // Relato e21fa130: "adding var type Boolean in the edit calls nonexistent native Type setter". The variable is created with
    // its type, and the checkbox bound to it in the same edit.
    [Fact]
    public void ANewVariableAndTheCheckboxBoundToItApply()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var host = Host();
        var bytes = File.ReadAllBytes(Insurance);
        var answer = Apply(host, bytes, Data(host, bytes, "InvalidPermissions",
            new JsonObject { ["before"] = "w1", ["insert"] = "<var name=\"Agree\" type=\"Boolean\"/><var name=\"Count\" type=\"Integer\" default=\"2\"/>" },
            new JsonObject { ["into"] = "w6", ["insert"] = "<input type=\"checkbox\" bind=\"Agree\"/>" }), "vars");
        Assert.True(answer["accepted"]!.GetValue<bool>(), answer.ToJsonString());
        var after = host.HtmlRead(File.ReadAllBytes(Path.Combine(host.WorkDirectory, "vars.oml")), "InvalidPermissions")["documents"]![0]!["html"]!.ToString();
        Assert.Contains("name=\"Agree\" type=\"Boolean\"", after);
        Assert.Contains("name=\"Count\" type=\"Integer\" default=\"2\"", after);
        Assert.Contains("bind=\"Agree\"", after);
    }

    // Receipt 82bf05af (22/10, a block): new variables written before the block's inputs read back in the order the reading
    // writes (the inputs first), "LocalVariable read back as InputParameter". They take their place among them (DATA_ORDER).
    [Fact]
    public void ANewVariableBeforeTheInputsOfABlockTakesItsPlaceAfterThem()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var host = Host();
        var bytes = File.ReadAllBytes(Insurance);
        var answer = Apply(host, bytes, Data(host, bytes, "Menu", new JsonObject { ["before"] = "w1", ["insert"] = "<var name=\"ShowLibrary\" type=\"Boolean\" default=\"False\"/>" }), "data-order");
        Assert.True(answer["accepted"]!.GetValue<bool>(), answer.ToJsonString());
        Assert.Contains(answer["result"]!["normalized"]!.AsArray(), n => n!["code"]?.ToString() == "DATA_ORDER");
        var after = host.HtmlRead(File.ReadAllBytes(Path.Combine(host.WorkDirectory, "data-order.oml")), "Menu")["documents"]![0]!["html"]!.ToString();
        Assert.True(after.IndexOf("name=\"ActiveSubItem\"", StringComparison.Ordinal) < after.IndexOf("name=\"ShowLibrary\"", StringComparison.Ordinal), after);
    }

    // The class of a new If goes on a container of what it shows; enabled of a new <upload> is refused before its facts are
    // written (the ODC Upload has no Enabled either).
    [Fact]
    public void WhatTheLaneHasNoPropertyForIsNormalizedOrRefusedBeforeTheBuild()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var host = Host();
        var bytes = File.ReadAllBytes(Insurance);
        var moved = Apply(host, bytes, Data(host, bytes, "InvalidPermissions", new JsonObject { ["after"] = "w6", ["insert"] = "<div if=\"True\" class=\"card\"><text>x</text></div>" }), "if-class");
        Assert.True(moved["accepted"]!.GetValue<bool>(), moved.ToJsonString());
        Assert.Contains(moved["result"]!["normalized"]!.AsArray(), n => n!["code"]?.ToString() == "IF_CLASS_MOVED");

        var upload = Assert.Single(Problems(Apply(host, bytes, Data(host, bytes, "InvalidPermissions",
            new JsonObject { ["before"] = "w1", ["insert"] = "<var name=\"F\" type=\"Binary Data\"/>" },
            new JsonObject { ["after"] = "w8", ["insert"] = "<upload content=\"F\" enabled=\"False\" aria-label=\"up\"/>" }), "upload")));
        Assert.Equal("HTML_PROPERTY_UNKNOWN", upload["code"]!.ToString());
        Assert.Contains("on a new Upload: Upload has no Enabled", upload["message"]!.ToString());
    }

    // ---- helpers ----------------------------------------------------------------------------------------------------------
    private static ModelHost Host() { Directory.CreateDirectory(Work); return new ModelHost(Work); }

    private static JsonObject Data(ModelHost host, byte[] bytes, string screen, params JsonObject[] edits) => new() {
        ["screen"] = screen,
        ["basedOn"] = new JsonObject { ["capture"] = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant(),
            ["html"] = host.HtmlRead(bytes, screen)["documents"]![0]!["htmlSha256"]!.DeepClone() },
        ["edits"] = new JsonArray(edits.Select(e => (JsonNode)e).ToArray()) };

    private JsonObject Apply(ModelHost host, byte[] bytes, JsonObject data, string name)
    {
        var answer = host.HtmlEdit(bytes, data, Path.Combine(host.WorkDirectory, name + ".oml"));
        output.WriteLine(name + ": " + answer.ToJsonString()[..Math.Min(1500, answer.ToJsonString().Length)]);
        Assert.NotEqual(ScreenHtmlEdit.NotApplied, answer["code"]?.ToString());
        return answer;
    }

    private static List<JsonObject> Problems(JsonObject answer) => (answer["problems"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().ToList();

    private void PatchApplies(ModelHost host, byte[] bytes, JsonObject data, JsonObject problem, string name)
    {
        var patched = data.DeepClone().AsObject();
        foreach (var step in Assert.IsType<JsonArray>(problem["patch"]).OfType<JsonObject>()) {
            var key = step["path"]!.ToString().TrimStart('/');
            if (step["op"]!.ToString() == "remove") patched.Remove(key); else patched[key] = step["value"]!.DeepClone();
        }
        var answer = Apply(host, bytes, patched, name);
        Assert.True(answer["accepted"]!.GetValue<bool>(), answer.ToJsonString());
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ScreenHtmlEditRefusalOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
