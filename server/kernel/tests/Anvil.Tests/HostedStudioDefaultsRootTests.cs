using System.Reflection;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>servidor/fase4-26 a7 (SD): the hosted server gives the processes it shares between customers (the resident ODC worker
/// and builder) SSAM_STUDIO_DEFAULTS_ROOT=memory, a root that is not absolute, so they keep no Studio defaults on disk (the
/// cache file names the module and flow measured); each customer process gets its own absolute folder. No Studio needed.</summary>
[Collection(StudioDefaultsCollection.Name)]
public class HostedStudioDefaultsRootTests
{
    private static readonly MethodInfo CacheDir = typeof(StudioDefaults).GetMethod("CacheDir", BindingFlags.NonPublic | BindingFlags.Static)!;

    [Theory]
    [InlineData("memory")]
    [InlineData("relative/studio-defaults")]
    public void ARootThatIsNotAbsoluteKeepsNothingOnDisk(string root)
    {
        try
        {
            StudioDefaults.ResetForTests(root);
            Assert.Null(CacheDir.Invoke(null, null));
        }
        finally { StudioDefaults.ResetForTests(); }
    }

    [Fact]
    public void TheVariableOfTheHostedServerIsReadTheSameWay()
    {
        var saved = Environment.GetEnvironmentVariable("SSAM_STUDIO_DEFAULTS_ROOT");
        try
        {
            StudioDefaults.ResetForTests();
            Environment.SetEnvironmentVariable("SSAM_STUDIO_DEFAULTS_ROOT", "memory");
            Assert.Null(CacheDir.Invoke(null, null));
        }
        finally { Environment.SetEnvironmentVariable("SSAM_STUDIO_DEFAULTS_ROOT", saved); StudioDefaults.ResetForTests(); }
    }
}
