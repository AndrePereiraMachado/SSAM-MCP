using System.Reflection;
using Anvil.Core;
using Anvil.Core.Delivery;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;
using Xunit.Sdk;

namespace Anvil.Tests;

/// <summary>The guard that runs after every other collection of the assembly (GuardLastCollectionOrderer).</summary>
[CollectionDefinition(Name)]
public sealed class ProfileGuardCollection { public const string Name = "Anvil.Tests.ProfileGuard (last)"; }

/// <summary>
/// fix/a5-lows (R4-3, review odc-defaults-4/5): no test of this assembly writes under the user's profile, whatever the calling
/// shell exports. On 2026-10-16 a test run without SSAM_STUDIO_DEFAULTS_ROOT created %USERPROFILE%\.ssam-hybrid\studio-defaults\
/// ss11: the tests of the screen reading measured the Studio's defaults into the profile's cache. The guard is its own oracle:
/// it reads the user's profile from the environment the process started with AND from the account (known folders, which no
/// variable moves), and it reaches the isolation (TestProfileIsolation) and the kernel's write hook only by reflection, so it
/// fails, never stops compiling, on a tree that does not isolate. Forbidden: %USERPROFILE%\.ssam*, %USERPROFILE%\.anvil and
/// %LOCALAPPDATA% outside its Temp folder. Nothing here writes outside the process's private folder.
/// </summary>
[Collection(ProfileGuardCollection.Name)]
public class ProfileIsolationGuardTests(ITestOutputHelper output)
{
    // The roots of the kernel that write: the variable that names each, and how the kernel resolves it in this process.
    private static IEnumerable<(string Variable, Func<string?> Resolved)> KernelRoots() =>
    [
        ("SSAM_STUDIO_DEFAULTS_ROOT", StudioDefaultsCacheDir),
        ("SSAM_MODULE_INDEX_ROOT", () => ModuleIndexStore.Default()?.Root),
        ("ANVIL_AUTHORITY_DIR", () => BridgeAccess.DirectoryPath),
    ];

    private static string? StudioDefaultsCacheDir()
    {
        var method = typeof(StudioDefaults).GetMethod("CacheDir", BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException("StudioDefaults.CacheDir was not found: the guard must follow the kernel's cache folder");
        return (string?)method.Invoke(null, null);
    }

    [Fact]
    public void Every_write_root_of_the_kernel_is_named_and_outside_the_users_profile()
    {
        var problems = new List<string>();
        foreach (var (variable, resolved) in KernelRoots())
        {
            var named = Environment.GetEnvironmentVariable(variable);
            var path = resolved();
            output.WriteLine(variable + " = " + (named ?? "(absent)") + " -> " + (path ?? "(none)"));
            if (string.IsNullOrWhiteSpace(named)) problems.Add(variable + " is not set in the test process: the kernel falls back to " + (path ?? "nothing"));
            if (path != null && ProfileRootOf(path) is { } root) problems.Add(variable + " resolves to " + path + ", under the user's profile (" + root + ")");
        }
        Assert.True(problems.Count == 0, "The test process does not isolate the user's profile by itself:\n" + string.Join("\n", problems));
    }

    [Fact]
    public void A_durable_write_under_the_users_profile_is_refused_before_anything_is_created()
    {
        var hook = typeof(DurableJson).GetField("WritingForTests", BindingFlags.NonPublic | BindingFlags.Static)?.GetValue(null) as Action<string>;
        Assert.True(hook != null, "DurableJson has no write hook set in the test process: a test can write under the user's profile unseen");
        var isolation = Isolation();
        var decoy = (string)isolation.GetProperty("DecoyHome", BindingFlags.NonPublic | BindingFlags.Static)!.GetValue(null)!;
        var privateRoot = (string)isolation.GetProperty("PrivateRoot", BindingFlags.NonPublic | BindingFlags.Static)!.GetValue(null)!;
        // A home the isolation treats as the user's (inside the private folder): the real kernel writer, nothing of the user's.
        var probe = Path.Combine(decoy, ".ssam-hybrid", "studio-defaults", "probe-" + Guid.NewGuid().ToString("N"), "studio-defaults.x.json");
        var refused = Assert.Throws<InvalidOperationException>(() => DurableJson.WriteBytes(probe, [1]));
        Assert.Contains("under the user's profile", refused.Message);
        Assert.False(Directory.Exists(Path.Combine(decoy, ".ssam-hybrid")), "the refused write created its folder");
        Probes.Add(probe);
        // A write in the private folder of the process goes through.
        var allowed = Path.Combine(privateRoot, "probe-" + Guid.NewGuid().ToString("N") + ".json");
        DurableJson.WriteBytes(allowed, [1]);
        Assert.True(File.Exists(allowed));
        File.Delete(allowed);
        // The profile is forbidden to the kernel's writer in the isolation's rule too (asked of the hook's rule only: no file is
        // touched), for every home the guard knows (the variables and the account's own).
        var rule = isolation.GetMethod("ProfileRootOf", BindingFlags.NonPublic | BindingFlags.Static)!;
        foreach (var home in Start.Homes)
        {
            Assert.NotNull(rule.Invoke(null, [Path.Combine(home, ".ssam-hybrid", "studio-defaults", "ss11", "x.json")]));
            Assert.NotNull(rule.Invoke(null, [Path.Combine(home, ".ssam", "x.json")]));
            Assert.NotNull(rule.Invoke(null, [Path.Combine(home, ".anvil", "authority", "bridge.key")]));
        }
        foreach (var local in Start.Locals) Assert.NotNull(rule.Invoke(null, [Path.Combine(local, "Anvil", "authority", "x")]));
        Assert.Null(rule.Invoke(null, [Path.Combine(Path.GetTempPath(), "x.json")]));
        Assert.Null(ProfileRootOf(Path.Combine(Path.GetTempPath(), "x.json")));
    }

    /// <summary>Runs after every other collection: no test of this process wrote under the user's profile through the kernel
    /// (the hook refuses the write; a caller that swallows the refusal, as a cache does, is caught here), and no test left a
    /// root pointing at the profile.</summary>
    [Fact]
    public void After_every_test_no_durable_write_went_under_the_users_profile()
    {
        var refused = ((IEnumerable<string>?)Isolation().GetProperty("Refused", BindingFlags.NonPublic | BindingFlags.Static)?.GetValue(null) ?? [])
            .Where(path => !Probes.Contains(path)).ToList();
        Assert.True(refused.Count == 0, "Tests wrote (and were refused) under the user's profile:\n" + string.Join("\n", refused));
        Every_write_root_of_the_kernel_is_named_and_outside_the_users_profile();
    }

    private static readonly System.Collections.Concurrent.ConcurrentBag<string> Probes = [];

    private static Type Isolation() =>
        typeof(ProfileIsolationGuardTests).Assembly.GetType("Anvil.Tests.TestProfileIsolation")
        ?? throw new Xunit.Sdk.XunitException("No TestProfileIsolation in this test assembly: nothing points the kernel's roots away from the user's profile");

    // The root of the user's profile a path is under (%USERPROFILE%\.ssam*, %USERPROFILE%\.anvil, %LOCALAPPDATA% outside its
    // Temp), or null. The profile is the one the process started with (Start) and the account's known folders.
    internal static string? ProfileRootOf(string path)
    {
        var full = Path.GetFullPath(path);
        foreach (var home in Start.Homes)
        {
            var relative = Path.GetRelativePath(home, full);
            if (relative == "." || relative.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(relative)) continue;
            var first = relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)[0];
            if (first.StartsWith(".ssam", StringComparison.OrdinalIgnoreCase) || first.Equals(".anvil", StringComparison.OrdinalIgnoreCase)) return Path.Combine(home, first);
        }
        foreach (var local in Start.Locals)
        {
            var relative = Path.GetRelativePath(local, full);
            if (relative.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(relative)) continue;
            if (!Under(full, Start.Temp) && !Under(full, Path.Combine(local, "Temp"))) return local;
        }
        return null;
    }

    private static bool Under(string path, string folder)
    {
        var relative = Path.GetRelativePath(folder, path);
        return relative == "." || !(relative.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(relative));
    }

    // Read once, when the class is first used; USERPROFILE and LOCALAPPDATA as the test host has them (a test that moves them
    // later points at a temporary profile of its own), and the account's folders.
    private static class Start
    {
        private static readonly (string? Home, string? Local) Account = AccountFolders();
        internal static readonly string[] Homes = Distinct(Environment.GetEnvironmentVariable("USERPROFILE"), Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), Account.Home);
        internal static readonly string[] Locals = Distinct(Environment.GetEnvironmentVariable("LOCALAPPDATA"), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Account.Local);
        internal static readonly string Temp = Path.GetFullPath(Path.GetTempPath());
        // The account's profile (the machine's profile list for its SID) and Explorer's Local AppData: no variable moves them.
        private static (string? Home, string? Local) AccountFolders()
        {
            if (!OperatingSystem.IsWindows()) return (null, null);
            string? home = null, local = null;
            try {
                var sid = System.Security.Principal.WindowsIdentity.GetCurrent().User?.Value;
                using var key = sid == null ? null : Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + sid);
                home = key?.GetValue("ProfileImagePath") as string;
            } catch (Exception) { }
            try {
                using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders");
                local = key?.GetValue("Local AppData") as string;
            } catch (Exception) { }
            return (home, local ?? (home == null ? null : Path.Combine(home, "AppData", "Local")));
        }
        private static string[] Distinct(params string?[] folders) =>
            folders.Where(f => !string.IsNullOrWhiteSpace(f) && Path.IsPathFullyQualified(f)).Select(f => Path.GetFullPath(f!).TrimEnd('\\', '/'))
                .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }
}

/// <summary>The default order of the collections (xUnit's), with the profile guard last: it sees what every other test did.</summary>
public sealed class GuardLastCollectionOrderer : ITestCollectionOrderer
{
    public IEnumerable<ITestCollection> OrderTestCollections(IEnumerable<ITestCollection> testCollections) =>
        new DefaultTestCollectionOrderer().OrderTestCollections(testCollections)
            .OrderBy(collection => collection.DisplayName == ProfileGuardCollection.Name ? 1 : 0);
}
