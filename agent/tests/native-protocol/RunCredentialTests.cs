using Ssam.Agent;
using Xunit;

public sealed class RunCredentialTests
{
    [Fact]
    public async Task StdinCredentialDoesNotReadOrCreateAFile()
    {
        var absent = Path.Combine(Path.GetTempPath(), "ssam-credential-" + Guid.NewGuid().ToString("N"));
        var value = "ssam_agent_" + new string('a', 43);
        Assert.Equal(value, await NativeHost.RunCredential(absent, true, new StringReader(value + "\n")));
        Assert.False(Directory.Exists(absent));
    }

    [Theory]
    [InlineData("")]
    [InlineData("bad-value")]
    public async Task InvalidStdinFailsWithoutFallingBackToDisk(string value)
    {
        await Assert.ThrowsAsync<ArgumentException>(() => NativeHost.RunCredential("missing", true, new StringReader(value)));
    }
}
