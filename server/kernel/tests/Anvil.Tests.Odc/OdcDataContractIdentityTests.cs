using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>ODC lane of the identity-anchored data contract (phase 3, 2026-09-23); the scenarios are shared with the
/// O11 lane (tests/Shared/DataContractIdentityScenarios.cs). The positive path is tests/jobs-odc/data-contract-identity.json.</summary>
public class OdcDataContractIdentityTests
{
    private static readonly string Root = FindRoot();
    private static (ModelHost Host, string Fixture) Setup()
    {
        var work = Path.Combine(Root, ".local", "lane-odc", "data-contract-identity", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        return (new ModelHost(work), Path.Combine(Root, "tests", "fixtures", "odc", "insurance-reactive-r8.oml"));
    }

    [Fact]
    public void AWriteThatAlreadyDifferedBeforeARenameStaysADifference()
    {
        if (!StudioAvailable()) return;
        var (host, fixture) = Setup();
        DataContractIdentityScenarios.WrongValueStaysRejectedAcrossARename(host, fixture);
    }

    [Fact]
    public void RecordValuesWrittenByPathFollowTheirRecordByIdentity()
    {
        if (!StudioAvailable()) return;
        var (host, fixture) = Setup();
        DataContractIdentityScenarios.RecordValuesFollowTheirRecordByIdentity(host, fixture);
    }

    /// <summary>A12 (atritos 2): the module theme's BaseTheme references the producer theme; re-keyed by a merge, it is equal.</summary>
    [Fact]
    public void AProducerReferenceReKeyedByTheMergeIsEqual()
    {
        if (!StudioAvailable()) return;
        var (host, fixture) = Setup();
        DataContractIdentityScenarios.AProducerReferenceReKeyedByTheMergeIsEqual(host, fixture, "IMobileTheme:InsuranceApp", "BaseTheme");
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(OdcDataContractIdentityTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
