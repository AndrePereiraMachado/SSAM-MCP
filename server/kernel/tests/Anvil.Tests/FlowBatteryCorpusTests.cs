using System.Runtime.CompilerServices;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>The LG2 battery (FlowBatteryCorpus) over the O11 modules of the plan's corpus: edits of real actions written back
/// through the logic op's text form and read again. Needs the Service Studio assemblies and the captures the manifest names;
/// without the captures it warns and returns.</summary>
public class FlowBatteryCorpusTests(ITestOutputHelper output)
{
    private static readonly string Work = Path.Combine(Path.GetTempPath(), "flow-battery-o11");

    [Fact]
    public void EditsOfTheO11CorpusReadBackAsTheirText()
    {
        Directory.CreateDirectory(Work);
        var bound = false;
        FlowBatteryCorpus.Run("o11", () => {
            if (!bound) { StudioAssemblies.Bind(null); bound = true; }
            return Host();
        }, output);
    }

    /// <summary>The O11 mapping battery: in every action of the corpus with a record or list of a record type, a new local of
    /// another record type filled by a new step with a mapping (assign ... mapTo, or ListAppendAll with SourceList ... mapTo),
    /// then that mapping edited (remap) and everything undone; each write is the native TypeConversion and reads back as its
    /// text (FlowEdits.Map). The floor is flow-battery-expected.json "o11Map".</summary>
    [Fact]
    public void MappingEditsOfTheO11CorpusReadBackAsTheirText()
    {
        Directory.CreateDirectory(Work);
        var bound = false;
        FlowBatteryCorpus.Run("o11", () => {
            if (!bound) { StudioAssemblies.Bind(null); bound = true; }
            return Host();
        }, output, expectedKey: "o11Map", kinds: ["map"]);
    }

    // Screen and data actions born from texts without @key on the screens and blocks of the corpus (FlowCreateBattery).
    [Fact]
    public void NewScreenAndDataActionsOfTheO11CorpusReadBackAsTheirText()
    {
        Directory.CreateDirectory(Work);
        var bound = false;
        FlowBatteryCorpus.RunCreate("o11", () => {
            if (!bound) { StudioAssemblies.Bind(null); bound = true; }
            return Host();
        }, output);
    }

    // An owner whose every screen action runs a JavaScript is created through the refusal's patch (DcipsLogin).
    [Fact]
    public void AnOwnerWhoseScreenActionsRunAScriptIsCreatedThroughThePatch()
    {
        Directory.CreateDirectory(Work);
        var bound = false;
        FlowBatteryCorpus.RunCreatePatched("DCIPS_Staff_Common", () => {
            if (!bound) { StudioAssemblies.Bind(null); bound = true; }
            return Host();
        }, output);
    }

    // The model types load only after StudioAssemblies.Bind: they live in a method of their own (not inlined).
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static ModelHost Host() => new(Work);
}
