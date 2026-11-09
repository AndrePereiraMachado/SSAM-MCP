using System.Text.Json.Nodes;
using Ssam.Agent;
using Xunit;

// Mac app 0.2.8: the macOS pack carries one O11 thin bridge per served Service Studio build (pack.json o11Builds, the same
// DLLs as Windows), and the native core picks the one of the Service Studio installed on the Mac. The version comes from the
// Studio's bundle (MacPlatform.Inspect: the managed ServiceStudio.dll, else Info.plist), the same value the hello
// (MacPlatform.Installed) and o11.connect (MacPlatform.Processes -> O11Connection) give O11Builds.PackFor. An unknown build
// falls back exactly as on Windows: the pack's default bridge, a warning when the server serves the default and the Studio
// is newer than every served build, and STUDIO_VERSION_MISMATCH otherwise. The class name has "Mac" so the macOS CI filter
// (agent-native-release.yml, FullyQualifiedName~Mac) runs it on the Apple Silicon runner too.
public sealed class MacO11BuildSelectionTests
{
    private static readonly string D95 = new('5', 64), D94 = new('4', 64), D93 = new('3', 64), D92 = new('2', 64);

    // The Mac pack of agent-pack.ps1 -Platform mac with -O11Studios (or <prebuilt>\o11\builds): the newest build is the default.
    private static JsonObject MacPack() => new()
    {
        ["platform"] = "darwin", ["lanes"] = new JsonArray("odc", "o11"), ["o11BuiltFor"] = "11.55.95", ["o11Hook"] = "dev",
        ["o11Bridge"] = new JsonObject { ["path"] = "bin/o11/bridge/Anvil.Bridge.dll", ["sha256"] = D95 },
        ["o11Builds"] = new JsonArray(
            new JsonObject { ["version"] = "11.55.95", ["runtime"] = "net10.0", ["path"] = "bin/o11/bridge/Anvil.Bridge.dll", ["sha256"] = D95 },
            new JsonObject { ["version"] = "11.55.94", ["runtime"] = "net10.0", ["path"] = "bin/o11/bridges/11.55.94/Anvil.Bridge.dll", ["sha256"] = D94 },
            new JsonObject { ["version"] = "11.55.93", ["runtime"] = "net8.0", ["path"] = "bin/o11/bridges/11.55.93/Anvil.Bridge.dll", ["sha256"] = D93 },
            new JsonObject { ["version"] = "11.55.92", ["runtime"] = "net8.0", ["path"] = "bin/o11/bridges/11.55.92/Anvil.Bridge.dll", ["sha256"] = D92 }),
        ["files"] = new JsonArray(
            new JsonObject { ["path"] = "bin/o11/bridge/Anvil.Bridge.dll", ["sha256"] = D95 },
            new JsonObject { ["path"] = "bin/o11/bridges/11.55.94/Anvil.Bridge.dll", ["sha256"] = D94 },
            new JsonObject { ["path"] = "bin/o11/bridges/11.55.93/Anvil.Bridge.dll", ["sha256"] = D93 },
            new JsonObject { ["path"] = "bin/o11/bridges/11.55.92/Anvil.Bridge.dll", ["sha256"] = D92 })
    };

    private static readonly JsonObject Served = new() { ["o11"] = "11.55.95", ["servedVersions"] = new JsonObject { ["o11"] = new JsonArray("11.55.92", "11.55.93", "11.55.94", "11.55.95") } };

    // A Service Studio bundle as the OutSystems Mac installer lays it out (the launcher wraps a same-named bundle with the
    // managed files): the managed ServiceStudio.dll here carries no version resource, so the version is Info.plist's.
    private static (string Folder, string Outer, string Executable) StudioBundle(string version, string tfm)
    {
        var folder = Path.Combine(Path.GetTempPath(), "ssam-mac-o11-" + Guid.NewGuid().ToString("N"));
        var outer = Path.Combine(folder, "Service Studio 11.app");
        Directory.CreateDirectory(Path.Combine(outer, "Contents", "MacOS"));
        File.WriteAllText(Path.Combine(outer, "Contents", "Info.plist"), "<plist><dict><key>CFBundleExecutable</key><string>Service Studio 11</string></dict></plist>");
        File.WriteAllText(Path.Combine(outer, "Contents", "MacOS", "Service Studio 11"), "launcher placeholder");
        var inner = Path.Combine(outer, "Contents", "Resources", "app", "Service Studio 11.app");
        var bin = Path.Combine(inner, "Contents", "MacOS");
        Directory.CreateDirectory(bin);
        File.WriteAllText(Path.Combine(inner, "Contents", "Info.plist"), $"<plist><dict><key>CFBundleExecutable</key><string>ServiceStudio</string><key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>");
        var executable = Path.Combine(bin, "ServiceStudio");
        File.WriteAllText(executable, "apphost placeholder");
        File.WriteAllText(Path.Combine(bin, "ServiceStudio.dll"), "managed entry placeholder without a version resource");
        File.WriteAllText(Path.Combine(bin, "ServiceStudio.runtimeconfig.json"), $"{{\"runtimeOptions\":{{\"tfm\":\"{tfm}\"}}}}");
        return (folder, outer, executable);
    }

    [Theory]
    [InlineData("11.55.95.65352", "net10.0", "11.55.95", "bin/o11/bridge/Anvil.Bridge.dll", '5')]
    [InlineData("11.55.94.65328", "net10.0", "11.55.94", "bin/o11/bridges/11.55.94/Anvil.Bridge.dll", '4')]
    [InlineData("11.55.93.65289", "net8.0", "11.55.93", "bin/o11/bridges/11.55.93/Anvil.Bridge.dll", '3')]
    [InlineData("11.55.92.65269", "net8.0", "11.55.92", "bin/o11/bridges/11.55.92/Anvil.Bridge.dll", '2')]
    public void TheInstalledMacServiceStudioGetsTheThinBridgeOfItsBuild(string studio, string tfm, string builtFor, string bridge, char sha)
    {
        var (folder, outer, executable) = StudioBundle(studio, tfm);
        try
        {
            var bundle = MacPlatform.Inspect(outer);
            Assert.NotNull(bundle);
            Assert.Equal("o11", bundle!.Lane);
            Assert.Equal(studio, bundle.Version);
            Assert.Equal(tfm, StudioKinds.Text(bundle.RuntimeConfig?["runtimeOptions"]?["tfm"]));
            // o11.connect: the running Studio (ps) carries the bundle's version; the hello uses the installed one, the same value.
            var running = MacPlatform.MatchProcesses([bundle], $"4242 {executable}");
            var version = StudioKinds.Text(Assert.Single(running)!["version"]);
            Assert.Equal(studio, version);
            var pack = MacPack();
            var view = O11Builds.PackFor(pack, version);
            Assert.Equal(builtFor, StudioKinds.Text(view["o11BuiltFor"]));
            Assert.Equal(tfm, StudioKinds.Text(view["o11Runtime"]));
            Assert.Equal(bridge, StudioKinds.Text(view["o11Bridge"]?["path"]));
            Assert.Equal(new string(sha, 64), StudioKinds.Text(view["o11Bridge"]?["sha256"]));
            Assert.Equal(Path.Combine("/Applications/SSAM Agent.app/Contents/Resources/pack", bridge), O11Builds.BridgeFile("/Applications/SSAM Agent.app/Contents/Resources/pack", view));
            // The pack's own bridge serves this Studio (no offer needed, which macOS never takes anyway) and no warning.
            Assert.True(BridgeUpdates.BundledSupports(pack, "R", "o11", version, tfm));
            Assert.Null(new StudioKinds("R", "R", pack, () => Served).CheckO11Build(version, view));
        }
        finally { Directory.Delete(folder, true); }
    }

    // An unknown build: the default bridge (the newest, 11.55.95) as on Windows. Newer than every served build: allowed with the
    // O11_BRIDGE_BUILT_FOR_DIFFERS warning (Windows would also ask for a bridge offer; macOS takes none). Older and not served:
    // refused with STUDIO_VERSION_MISMATCH before anything is attached.
    [Theory]
    [InlineData("11.55.96.65400", true)]
    [InlineData("11.55.91.65200", false)]
    public void AnUnknownMacServiceStudioFallsBackToTheDefaultOrIsRefusedAsOnWindows(string studio, bool allowed)
    {
        var (folder, outer, executable) = StudioBundle(studio, "net10.0");
        try
        {
            var bundle = MacPlatform.Inspect(outer)!;
            var version = StudioKinds.Text(Assert.Single(MacPlatform.MatchProcesses([bundle], $"7 {executable}"))!["version"]);
            Assert.Equal(studio, version);
            var pack = MacPack();
            Assert.Null(O11Builds.For(pack, version));
            var view = O11Builds.PackFor(pack, version);
            Assert.Same(pack, view);
            Assert.Equal("11.55.95", StudioKinds.Text(view["o11BuiltFor"]));
            Assert.Equal(Path.Combine("R", O11Builds.DefaultBridge), O11Builds.BridgeFile("R", view));
            Assert.False(BridgeUpdates.BundledSupports(pack, "R", "o11", version, "net10.0"));
            var kinds = new StudioKinds("R", "R", pack, () => Served);
            if (allowed)
            {
                var warning = kinds.CheckO11Build(version, view);
                Assert.Equal("O11_BRIDGE_BUILT_FOR_DIFFERS", StudioKinds.Text(warning?["code"]));
                Assert.Equal("11.55.95", StudioKinds.Text(warning?["builtFor"]));
            }
            else Assert.Equal("STUDIO_VERSION_MISMATCH", Assert.Throws<AgentFault>(() => kinds.CheckO11Build(version, view)).Code);
        }
        finally { Directory.Delete(folder, true); }
    }

    // A Mac pack whose o11Builds entry is not confirmed by the integrity list (a changed file) never picks it: the default.
    [Fact]
    public void AMacBuildTheIntegrityListDoesNotConfirmIsIgnored()
    {
        var pack = MacPack();
        ((JsonObject)((JsonArray)pack["files"]!)[2]!)["sha256"] = D92;
        Assert.Null(O11Builds.For(pack, "11.55.93.65289"));
        Assert.Same(pack, O11Builds.PackFor(pack, "11.55.93.65289"));
        Assert.Equal(new[] { "11.55.95", "11.55.94", "11.55.92" }, O11Builds.Versions(pack).Select(n => StudioKinds.Text(n)).ToArray());
    }
}
