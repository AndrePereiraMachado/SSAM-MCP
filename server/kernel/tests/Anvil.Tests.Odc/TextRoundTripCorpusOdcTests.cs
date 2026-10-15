using System.Runtime.CompilerServices;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>The fixed point of the logic text (ssam-flow/1) over the ODC modules of the plan's corpus
/// (TextRoundTripCorpus). Needs the ODC Studio assemblies and the captures the manifest names; without the captures it
/// warns and returns.</summary>
public class TextRoundTripCorpusOdcTests(ITestOutputHelper output)
{
    private static readonly string Work = Path.Combine(Path.GetTempPath(), "text-roundtrip-odc");

    [Fact]
    public void EveryActionOfTheOdcCorpusIsAFixedPoint()
    {
        Directory.CreateDirectory(Work);
        var bound = false;
        TextRoundTripCorpus.Run("odc", (bytes, sha256, visit) => {
            if (!bound) { StudioAssembliesOdc.Bind(null); bound = true; }
            return Build(bytes, sha256, visit);
        }, output);
    }

    // The model types load only after StudioAssembliesOdc.Bind: they live in a method of their own (not inlined).
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static ModuleFlow Build(byte[] bytes, string sha256, Action<FlowItem> visit) => new ModelHost(Work).BuildFlow(bytes, sha256, "odc", visit);
}
