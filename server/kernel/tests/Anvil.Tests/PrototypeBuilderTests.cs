using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// The direct builder of the prototype lanes (PrototypeBuilder), shared with the html op: the widget defaults table the
/// installed Model API gives each widget type, and the bundles the planner tests copy. The prototype import is turned off
/// (PrototypeImport): its end-to-end applies through JobRunner are gone with it (PrototypeImportDisabledTests).
/// </summary>
public class PrototypeBuilderTests(ITestOutputHelper output)
{
    private static readonly string Work = Path.Combine(Path.GetTempPath(), "proto-builder-tests");

    /// <summary>A private copy of the fixture bundles (the kernel writes prototype-dom.json and prototype-keys.json beside the
    /// capture); returns the copy of <paramref name="capture"/>.</summary>
    internal static string Bundle(string name, string capture = "farmavirtual.capture.json")
    {
        var dir = Path.Combine(Work, name + "-bundle");
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        Directory.CreateDirectory(dir);
        var source = PrototypeFakes.Fixtures;
        foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(dir, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, true);
        }
        return Path.Combine(dir, capture);
    }

    // ---- 10 and 6: the minimal capture over the Reactive fixture, an HTML element's onclick, reimport in place ----------------

    // ---- 8: the direct builder within 15 s on the base of the replay of job 105, next to job 105's html op ---------------------

    // ---- 9: Haiku_UI-20261010202559: 0 Verify errors, the read-back of every explored state ------------------------------------

    // ---- 11: the defaults table equals the installed Model API ---------------------------------------------------------------

    [Fact]
    public void TheWidgetDefaultsTableEqualsWhatTheInstalledModelApiCreates()
    {
        if (!PrototypeFakes.Studio()) return;
        Defaults();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void Defaults()
    {
        var dir = Path.Combine(Work, "defaults");
        Directory.CreateDirectory(dir);
        var copy = Path.Combine(dir, "reactive-ui.oml");
        File.Copy(Path.Combine(PrototypeFakes.Root, "tests", "fixtures", "reactive-ui.oml"), copy, true);
        var observed = PrototypeWidgetDefaults.Observe(copy, dir, "o11");
        output.WriteLine(observed.ToJsonString(PrototypeFakes.Indented));
        var diff = PrototypeWidgetDefaults.Diff(observed, "o11");
        Assert.True(diff.Count == 0, "PrototypeWidgetDefaults differs from the installed Model API:\n" + string.Join("\n", diff));
    }
}
