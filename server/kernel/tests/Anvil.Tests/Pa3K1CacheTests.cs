using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// K1-c of the atritos 3 package (C06): the published OML of a module version is downloaded once (394 downloads in one
/// session, 289 of a version already downloaded). The CLI `download --cache` resolves the version first and serves a
/// cached version from &lt;cache&gt;/&lt;moduleKey&gt;/&lt;versionId&gt;.oml, checked by the recorded sha256, copied to the call's own
/// folder; the cached file is never overwritten. A fake download stands for the environment.
/// </summary>
public sealed class Pa3K1CacheTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Pa3K1CacheTests).Assembly.Location)!)!;

    // HeadlessSession.SafeFileName lives with the Studio adapter.
    public Pa3K1CacheTests() => StudioAssemblies.Bind();

    private sealed class FakeEnvironment
    {
        public int Downloads;
        public Dictionary<int, byte[]> Versions { get; } = new() { [42] = "oml v42"u8.ToArray(), [41] = "oml v41"u8.ToArray() };
        public DownloadResult Download(ModuleSummary module, string? output, int? version)
        {
            Downloads++;
            var vid = version ?? module.VersionId;
            Directory.CreateDirectory(output!);
            var file = Path.Combine(output!, module.Name + ".oml");
            File.WriteAllBytes(file, Versions[vid]);
            return new DownloadResult(module.Name, module.Key, module.Kind, vid, Versions[vid].Length, file, new DateTime(2026, 10, 7, 1, 2, 3, DateTimeKind.Utc), "dev", vid == 42, 15000, "ok");
        }
    }

    private static readonly ModuleSummary Orders = new("Orders_CS", "57b4b95a-6672-4f3a-b5c4-1b2b3c4d5e6f", "eSpace", "Service", 42, 7, "Orders", null,
        DateTime.UtcNow, "dev", true, true, null);

    [Fact]
    public void TwoDownloadsOfTheSameVersionDownloadOnce()
    {
        var work = Path.Combine(Root, ".local", "pa3-k1-cache-tests", Guid.NewGuid().ToString("N"));
        var cache = Path.Combine(work, "environment", "published");
        var env = new FakeEnvironment();
        var first = PublishedOmlCache.Download(cache, Orders, null, Path.Combine(work, "download", "1"), env.Download);
        Assert.False(first.Cached); Assert.Equal(1, env.Downloads); Assert.Equal(42, first.VersionId);
        var cached = Path.Combine(cache, "57b4b95a-6672-4f3a-b5c4-1b2b3c4d5e6f", "42.oml");
        Assert.Equal(cached, first.CachePath);
        var entry = JsonNode.Parse(File.ReadAllText(Path.ChangeExtension(cached, ".json")))!;
        Assert.Equal(42, entry["versionId"]!.GetValue<int>()); Assert.Equal(first.Sha256, entry["sha256"]!.ToString());
        Assert.Equal("Orders_CS", entry["module"]!.ToString()); Assert.False(string.IsNullOrEmpty(entry["storedAt"]?.ToString()));

        // The same version again: no download, the file copied into the call's own folder, cached:true.
        var second = PublishedOmlCache.Download(cache, Orders, null, Path.Combine(work, "download", "2"), env.Download);
        Assert.True(second.Cached); Assert.Equal(1, env.Downloads); Assert.Equal("ok", second.Status);
        Assert.Equal(Path.Combine(work, "download", "2", "Orders_CS.oml"), second.FilePath);
        Assert.Equal("oml v42"u8.ToArray(), File.ReadAllBytes(second.FilePath!));
        Assert.True(second.IsPublishedVersion);

        // Another version is its own entry; asking for 42 explicitly is the cached one.
        Assert.False(PublishedOmlCache.Download(cache, Orders, 41, Path.Combine(work, "download", "3"), env.Download).Cached);
        Assert.Equal(2, env.Downloads);
        Assert.True(PublishedOmlCache.Download(cache, Orders, 42, Path.Combine(work, "download", "4"), env.Download).Cached);
        Assert.Equal(2, env.Downloads);

        // A cached file whose bytes changed is not served and is never overwritten: the version is downloaded again.
        File.WriteAllText(cached, "tampered");
        var again = PublishedOmlCache.Download(cache, Orders, null, Path.Combine(work, "download", "5"), env.Download);
        Assert.False(again.Cached); Assert.Equal(3, env.Downloads);
        Assert.Equal("tampered", File.ReadAllText(cached));
        Assert.Equal("oml v42"u8.ToArray(), File.ReadAllBytes(again.FilePath!));
    }

    [Fact]
    public void AnExtensionOrAnUnknownVersionIsDownloadedUncached()
    {
        var work = Path.Combine(Root, ".local", "pa3-k1-cache-tests", Guid.NewGuid().ToString("N"));
        var env = new FakeEnvironment();
        var unknown = Orders with { VersionId = 0 };
        env.Versions[0] = "oml v0"u8.ToArray();
        var r = PublishedOmlCache.Download(Path.Combine(work, "cache"), unknown, null, Path.Combine(work, "d"), env.Download, latestVersion: _ => 0);
        Assert.False(r.Cached); Assert.Null(r.CachePath);
        Assert.False(Directory.Exists(Path.Combine(work, "cache")));
    }
}
