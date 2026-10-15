using System.Runtime.CompilerServices;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>The LG2 battery (FlowBatteryCorpus) over the ODC modules of the plan's corpus: edits of real actions written back
/// through the logic op's text form and read again. Needs the ODC Studio assemblies and the captures the manifest names;
/// without the captures it warns and returns.</summary>
public class FlowBatteryCorpusOdcTests(ITestOutputHelper output)
{
    private static readonly string Work = Path.Combine(Path.GetTempPath(), "flow-battery-odc");

    [Fact]
    public void EditsOfTheOdcCorpusReadBackAsTheirText()
    {
        Directory.CreateDirectory(Work);
        var bound = false;
        FlowBatteryCorpus.Run("odc", () => {
            if (!bound) { StudioAssembliesOdc.Bind(null); bound = true; }
            return Host();
        }, output);
    }

    // Screen and data actions born from texts without @key on the screens and blocks of the corpus (FlowCreateBattery).
    [Fact]
    public void NewScreenAndDataActionsOfTheOdcCorpusReadBackAsTheirText()
    {
        Directory.CreateDirectory(Work);
        var bound = false;
        FlowBatteryCorpus.RunCreate("odc", () => {
            if (!bound) { StudioAssembliesOdc.Bind(null); bound = true; }
            return Host();
        }, output);
    }

    // An owner whose every screen action runs a JavaScript is created through the refusal's patch (OpenDialogOnReady).
    [Fact]
    public void AnOwnerWhoseScreenActionsRunAScriptIsCreatedThroughThePatch()
    {
        Directory.CreateDirectory(Work);
        var bound = false;
        FlowBatteryCorpus.RunCreatePatched("FloodQuotes", () => {
            if (!bound) { StudioAssembliesOdc.Bind(null); bound = true; }
            return Host();
        }, output);
    }

    // The model types load only after StudioAssembliesOdc.Bind: they live in a method of their own (not inlined).
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static ModelHost Host() => new(Work);
}
