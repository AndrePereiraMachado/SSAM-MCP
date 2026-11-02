using Ssam.Agent;
using Xunit;

public sealed class AuthenticodeTests
{
    [Fact]
    public async Task RealClientInvalidDllIsAnAttemptedBridgeFailure()
    {
        // The Windows attach client against this machine's fixture Studio (C:/t/vigia-auto): Windows only.
        if (!OperatingSystem.IsWindows()) return;
        var baseDir = "C:/t/vigia-auto/round2-e2e";
        using var host = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Path.Combine(baseDir, "host/bin/Release/net10.0/ODCStudio.exe")) { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, CreateNoWindow = true })!;
        var file = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"), "ODC3.Bridge.v100.dll"); Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        try {
            await host.StandardOutput.ReadLineAsync(); File.WriteAllBytes(file, Enumerable.Repeat((byte)65, 4096).ToArray());
            var failure = await Assert.ThrowsAsync<AgentFault>(() => StudioKinds.Helper(Path.Combine(baseDir, "v100/bin/Release/net10.0/ODC3.Bridge.Client.dll"), [host.Id.ToString(), "attach", file], 30000, true, CancellationToken.None));
            Assert.True(failure.AttachAttempted); Assert.True(failure.BridgeLoadFailure);
        } finally { host.StandardInput.Close(); await host.WaitForExitAsync(); Directory.Delete(Path.GetDirectoryName(file)!, true); }
    }
    [Theory]
    [InlineData(true, "owner", "owner", "Microsoft Corporation", true, "root", true)]
    [InlineData(true, "owner", "other", "Microsoft Corporation", true, "root", false)]
    [InlineData(true, "microsoft", "other", "Microsoft Corporation", true, "root", true)]
    [InlineData(true, "microsoft", "owner", "Owner", true, "root", false)]
    [InlineData(true, "microsoft", "other", "Microsoft Corporation Fake", true, "root", false)]
    [InlineData(true, "microsoft", "other", "Microsoft Corporation", false, "root", false)]
    [InlineData(true, "microsoft", "other", "Microsoft Corporation", true, "untrusted", false)]
    [InlineData(false, "microsoft", "other", "Microsoft Corporation", true, "root", false)]
    public void SignerPolicyRequiresExactOrganizationEkuAndPinnedRoot(bool valid, string signer, string leaf, string organization, bool eku, string root, bool accepted)
        => Assert.Equal(accepted, AuthenticodeTrust.Accept(new(valid, leaf, organization, eku, root), signer, "owner", ["root"]));

    [Theory]
    [InlineData("Microsoft.Diagnostics.NETCore.Client.dll")]
    [InlineData("Microsoft.Extensions.DependencyInjection.Abstractions.dll")]
    [InlineData("Microsoft.Extensions.Logging.Abstractions.dll")]
    public void RealMicrosoftDependencyUsesProviderChain(string name)
    {
        // Real Authenticode chains of this machine's fixture DLLs: Windows only (elsewhere Inspect refuses, UnsignedFileIsRefused).
        if (!OperatingSystem.IsWindows()) return;
        var file = Path.Combine("C:/t/vigia-auto/round2-e2e/v100/bin/Release/net10.0", name);
        var evidence = AuthenticodeTrust.Inspect(file);
        Assert.True(AuthenticodeTrust.Accept(evidence, "microsoft", "not-the-owner", BridgeTrust.MicrosoftRoots));
        Assert.False(AuthenticodeTrust.Accept(evidence, "owner", "not-the-owner", BridgeTrust.MicrosoftRoots));
    }

    [Fact]
    public void UnsignedFileIsRefused()
    {
        var file = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".dll");
        try {
            File.WriteAllText(file, "not signed");
            // Outside Windows there is no Authenticode: the file is refused by the inspection itself.
            if (!OperatingSystem.IsWindows()) { Assert.Equal("Authenticode requires Windows", Assert.Throws<IOException>(() => AuthenticodeTrust.Inspect(file)).Message); return; }
            Assert.False(AuthenticodeTrust.Inspect(file).Valid);
        }
        finally { File.Delete(file); }
    }

    [Fact]
    public void CacheIdentityChangesWhenSameSizeAndMtimeFileIsReplaced()
    {
        var file = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".dll");
        try {
            File.WriteAllText(file, "one");
            // Downloaded bridge identities are a Windows feature: elsewhere the read refuses instead of answering a weaker identity.
            if (!OperatingSystem.IsWindows()) { Assert.Throws<IOException>(() => NativeFileIdentity.Read(file)); return; }
            var stamp = File.GetLastWriteTimeUtc(file); var before = NativeFileIdentity.Read(file);
            File.WriteAllText(file + ".new", "two"); File.SetLastWriteTimeUtc(file + ".new", stamp); File.Move(file + ".new", file, true);
            Assert.NotEqual(before, NativeFileIdentity.Read(file)); Assert.Equal(stamp, File.GetLastWriteTimeUtc(file));
        } finally { File.Delete(file); File.Delete(file + ".new"); }
    }
}
