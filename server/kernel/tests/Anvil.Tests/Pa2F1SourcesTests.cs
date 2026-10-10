using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Lane F1 of the atritos 2 package (docs/PACOTE-ATRITOS-2.md), A23, kernel part: a path the SSAM itself returned is always a
/// valid source. o11_environment writes &lt;lane.local&gt;/environment/&lt;action&gt;/&lt;time&gt; (download, download-app), and the
/// kernel refused its own download as a producer on 2026-10-06: "producer '...\kernel\.local\environment\download\
/// 20261006T162952193Z\Users.oml' points to an OML outside tests/fixtures and outside the SSAM capture folders".
/// </summary>
public sealed class Pa2F1SourcesTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Pa2F1SourcesTests).Assembly.Location)!)!;
    private static readonly string JobDir = Path.Combine(Root, "tests", "jobs");

    [Theory]
    [InlineData(".local/environment/download/20261006T162952193Z/Users.oml")]
    [InlineData(".local/lane-ss5/environment/download/20261006T162952193Z/Users.oml")]
    [InlineData(".local/environment/download-app/20261006T162952193Z/Cardapio/Cardapio_CS.oml")]
    [InlineData(".local/lane-ss5/environment/download-app/20261006T162952193Z/Cardapio_UI.oml")]
    public void TheDownloadsOfTheSsamAreSources(string relative)
    {
        var full = Path.GetFullPath(Path.Combine(Root, relative));
        Assert.True(JobSources.IsCapturePath(full, Root));
        Assert.Equal(full, JobSources.FixturePath(full, JobDir, "producer"));
        Assert.Equal(full, JobSources.FixturePath(relative, JobDir, "base"));
    }

    [Theory]
    [InlineData(".local/environment/Users.oml")]
    [InlineData(".local/Users.oml")]
    [InlineData(".local/environment/download/20261006T162952193Z/Users.txt")]
    [InlineData(".local/environment/downloaded/Users.oml")]
    public void ALooseFileStaysRefusedAndTheRefusalNamesTheDownloadFolders(string relative)
    {
        var full = Path.GetFullPath(Path.Combine(Root, relative));
        Assert.False(JobSources.IsCapturePath(full, Root));
        var error = Assert.Throws<ArgumentException>(() => JobSources.FixturePath(full, JobDir, "producer")).Message;
        Assert.Contains("download|download-app", error);
        Assert.Contains("o11_environment download", error);
    }
}
