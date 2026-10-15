using System.Runtime.CompilerServices;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>The fixed point of the logic text (ssam-flow/1) over the O11 modules of the plan's corpus
/// (TextRoundTripCorpus). Needs the Service Studio assemblies (ANVIL_STUDIO_DIR) and the captures the manifest names;
/// without the captures it warns and returns, without the Studio it returns.</summary>
public class TextRoundTripCorpusTests(ITestOutputHelper output)
{
    private static readonly string Work = Path.Combine(Path.GetTempPath(), "text-roundtrip-o11");

    [Fact]
    public void EveryActionOfTheO11CorpusIsAFixedPoint()
    {
        Directory.CreateDirectory(Work);
        var bound = false;
        TextRoundTripCorpus.Run("o11", (bytes, sha256, visit) => {
            if (!bound) { StudioAssemblies.Bind(null); bound = true; }
            return Build(bytes, sha256, visit);
        }, output);
    }

    // The model types load only after StudioAssemblies.Bind: they live in a method of their own (not inlined).
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static ModuleFlow Build(byte[] bytes, string sha256, Action<FlowItem> visit) => new ModelHost(Work).BuildFlow(bytes, sha256, "o11", visit);
}
