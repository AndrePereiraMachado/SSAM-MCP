using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>CX16 W2 on the ODC lane: the battery of synthetic edits (ScreenHtmlEditBattery, today's parameters: the committed
/// fixture insurance-reactive-r8, seed 3, one a kind) written as element edits (data.edits: each element whole as
/// {replace: k}, the &lt;style&gt; by {find, with}, the document as {replace: "/"}) gives the document and the ops of the edit
/// form; and the engine reads the ODC reading of the fixture as positions. Needs the ODC Studio.</summary>
public class HtmlElementEditOdcTests(ITestOutputHelper output)
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "html-element-edits");

    [Fact]
    public void EveryBatteryEditInTheEditsFormIsTheEditForm()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: the equivalence battery is skipped."); return; }
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        var totals = new Dictionary<string, (int Edits, int Same)>(StringComparer.Ordinal);
        foreach (var row in HtmlElementEditsBattery.Equivalence(host, File.ReadAllBytes(Path.Combine(Root, "tests", "fixtures", "odc", "insurance-reactive-r8.oml")), seed: 3, perKind: 1)) {
            var t = totals.GetValueOrDefault(row.Kind); totals[row.Kind] = (t.Edits + 1, t.Same + (row.Same ? 1 : 0));
            if (!row.Same) output.WriteLine($"DIFFERS {row.Root} {row.Kind}: {row.Detail}");
        }
        foreach (var (kind, t) in totals.OrderBy(x => x.Key)) output.WriteLine($"{kind}: {t.Same}/{t.Edits}");
        output.WriteLine($"total: {totals.Values.Sum(t => t.Same)}/{totals.Values.Sum(t => t.Edits)}");
        Assert.True(totals.Count > 0);
        Assert.All(totals, t => Assert.Equal(t.Value.Edits, t.Value.Same));
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(HtmlElementEditOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
