using System.Runtime.CompilerServices;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>The batteries of the three-way merge (MergeBatteryCorpus) over the O11 modules of the plan's corpus: a Studio edit
/// and a model edit of the same read, merged, written and read again, for the logic text and the data text. Needs the Service
/// Studio assemblies and the captures the manifest names; without the captures it warns and returns.</summary>
public class MergeBatteryCorpusTests(ITestOutputHelper output)
{
    private static readonly string Work = Path.Combine(Path.GetTempPath(), "merge-battery-o11");
    private static bool bound;

    [Fact]
    public void TheLogicTextOfTheO11CorpusMergesThreeWays() => MergeBatteryCorpus.Flow("o11", Bound, output);

    [Fact]
    public void TheDataTextOfTheO11CorpusMergesThreeWays() => MergeBatteryCorpus.Data("o11", Bound, output);

    private static ModelHost Bound()
    {
        Directory.CreateDirectory(Work);
        if (!bound) { StudioAssemblies.Bind(null); bound = true; }
        return Host();
    }

    // The model types load only after StudioAssemblies.Bind: they live in a method of their own (not inlined).
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static ModelHost Host() => new(Work);
}
