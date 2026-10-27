using System.Text.Json;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>F2 on the ODC lane: the generated round-trip sweep (ModelHost.HtmlRoundTripSweep) over the committed Reactive fixture,
/// every case derived from the property model of the element. Needs the ODC Studio.</summary>
public class ScreenHtmlRoundTripOdcTests(ITestOutputHelper output)
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "screen-html-round-trip");

    [Fact]
    public void EveryPropertyTheModelLetsAnEditWriteReadsBackAsWritten()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: the F2 sweep is skipped."); return; }
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        // One case per kind and property (the kinds x properties are the same; the fixture is large).
        var sweep = host.HtmlRoundTripSweep(File.ReadAllBytes(Path.Combine(Root, "tests", "fixtures", "odc", "insurance-reactive-r8.oml")), perProperty: 1, log: output.WriteLine);
        File.WriteAllText(Path.Combine(Work, "insurance-reactive.sweep.json"), sweep.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Anvil.Tests.ScreenHtmlRoundTripReport.Check(sweep, "insurance-reactive-r8.oml", output, Known);
    }

    // Each matched exactly (the root by its key), each with why it is out of F2.
    private static readonly Anvil.Tests.ScreenHtmlRoundTripReport.Known[] Known = [
        // The name of an icon is never empty: its default ("") is no icon of the icon set; refused at the set, named (k, Icon).
        new("insurance-reactive-r8.oml", "f5P6ln_BbUOEXW8abHQ4Ag", "default", "Icon", "Icon", "refused", "HTML_EDIT_NOT_APPLIED", "the empty default of an icon's name is no icon (the platform refuses it at the set, with the element and the property named)"),
        // A new container <div> inside the placeholder of a ButtonGroup or a RadioGroup, which takes only its own items: refused by the
        // platform at the create ("Container is not allowed as a child of CustomPlaceholderWidget"), named as a new element.
        new("insurance-reactive-r8.oml", "JPyrqAEaSkCMoTYMAnlb+g", "move", "ButtonGroupItem", null, "refused", "HTML_EDIT_NOT_APPLIED", "a new container is not allowed inside a ButtonGroup's placeholder"),
        new("insurance-reactive-r8.oml", "BKpBJ76GZUChtvVF7PiIDg", "move", "RadioButton", null, "refused", "HTML_EDIT_NOT_APPLIED", "a new container is not allowed inside a RadioGroup's placeholder"),
        new("insurance-reactive-r8.oml", "eHG6HDR53kqsyS57EmXiiQ", "move", "ButtonGroupItem", null, "refused", "HTML_EDIT_NOT_APPLIED", "a new container is not allowed inside a ButtonGroup's placeholder"),
    ];

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ScreenHtmlRoundTripOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
