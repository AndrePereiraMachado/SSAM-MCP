using System.Runtime.CompilerServices;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>The batteries of the three-way merge (MergeBatteryCorpus) over the ODC modules of the plan's corpus: a Studio edit
/// and a model edit of the same read, merged, written and read again, for the logic text and the data text. Needs the ODC
/// Studio assemblies and the captures the manifest names; without the captures it warns and returns.</summary>
public class MergeBatteryCorpusOdcTests(ITestOutputHelper output)
{
    private static readonly string Work = Path.Combine(Path.GetTempPath(), "merge-battery-odc");
    private static bool bound;

    [Fact]
    public void TheLogicTextOfTheOdcCorpusMergesThreeWays() => MergeBatteryCorpus.Flow("odc", Bound, output);

    [Fact]
    public void TheDataTextOfTheOdcCorpusMergesThreeWays() => MergeBatteryCorpus.Data("odc", Bound, output);

    private static ModelHost Bound()
    {
        Directory.CreateDirectory(Work);
        if (!bound) { StudioAssembliesOdc.Bind(null); bound = true; }
        return Host();
    }

    // The model types load only after StudioAssembliesOdc.Bind: they live in a method of their own (not inlined).
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static ModelHost Host() => new(Work);
}
