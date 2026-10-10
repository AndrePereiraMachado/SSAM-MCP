using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>O11 lane of the identity-anchored data contract (phase 3, 2026-09-23); the scenarios are shared with the
/// ODC lane (tests/Shared/DataContractIdentityScenarios.cs). The positive path is tests/jobs/data-contract-identity.json.</summary>
public class DataContractIdentityTests
{
    private static string Root => JobRunner.RepoRoot(Path.GetDirectoryName(typeof(DataContractIdentityTests).Assembly.Location)!)!;
    private static (ModelHost Host, string Fixture) Setup()
    {
        StudioAssemblies.Bind();
        var work = Path.Combine(Root, ".local", "data-contract-identity", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        return (new ModelHost(work), Path.Combine(Root, "tests", "fixtures", "blank-service.oml"));
    }

    [Fact]
    public void AWriteThatAlreadyDifferedBeforeARenameStaysADifference()
    {
        var (host, fixture) = Setup();
        DataContractIdentityScenarios.WrongValueStaysRejectedAcrossARename(host, fixture);
    }

    [Fact]
    public void RecordValuesWrittenByPathFollowTheirRecordByIdentity()
    {
        var (host, fixture) = Setup();
        DataContractIdentityScenarios.RecordValuesFollowTheirRecordByIdentity(host, fixture);
    }
}
