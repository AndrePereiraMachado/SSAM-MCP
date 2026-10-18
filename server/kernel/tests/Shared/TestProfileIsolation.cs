using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using Anvil.Core.Delivery;

namespace Anvil.Tests;

/// <summary>
/// fix/a5-lows (R4-3): a test process of the kernel never writes under the user's profile, whatever the calling shell exports
/// (on 2026-10-16 a run without SSAM_STUDIO_DEFAULTS_ROOT created %USERPROFILE%\.ssam-hybrid\studio-defaults\ss11). When the
/// assembly loads, before any test, every write root of the kernel the environment does not name points at a private folder
/// of this process (%TEMP%\ssam-tests\&lt;assembly&gt;-&lt;pid&gt;-&lt;id&gt;, removed when the process exits); a root the runner names is
/// kept. The child processes a test starts (the CLI) inherit the same roots.
///   SSAM_STUDIO_DEFAULTS_ROOT  else %USERPROFILE%\.ssam-hybrid\studio-defaults (StudioDefaults)
///   SSAM_MODULE_INDEX_ROOT     else the workspace's .local\module-index (ModuleIndexStore)
///   ANVIL_AUTHORITY_DIR        else the user's HKCU value or %LOCALAPPDATA%\Anvil\authority (BridgeAccess)
/// Every durable write of the kernel (DurableJson.WriteBytes) under the user's profile (%USERPROFILE%\.ssam*,
/// %USERPROFILE%\.anvil, %LOCALAPPDATA% outside its Temp folder) is refused before its folder is created, and kept in Refused:
/// ProfileIsolationGuardTests fails on it after every other test, also when the caller swallowed the refusal.
/// </summary>
internal static class TestProfileIsolation
{
    internal static readonly string[] Variables = ["SSAM_STUDIO_DEFAULTS_ROOT", "SSAM_MODULE_INDEX_ROOT", "ANVIL_AUTHORITY_DIR"];
    private static readonly ConcurrentQueue<string> refused = new();
    private static string[] homes = [], locals = [];
    private static string temp = "";

    internal static string PrivateRoot { get; private set; } = "";
    /// <summary>A folder the isolation treats as the user's home (inside PrivateRoot), for the guard's own probe.</summary>
    internal static string DecoyHome { get; private set; } = "";
    internal static IReadOnlyCollection<string> Refused => refused.ToArray();

    [ModuleInitializer]
    internal static void Isolate()
    {
        temp = Path.GetFullPath(Path.GetTempPath());
        PrivateRoot = Path.Combine(temp, "ssam-tests", typeof(TestProfileIsolation).Assembly.GetName().Name + "-" + Environment.ProcessId + "-" + Guid.NewGuid().ToString("N")[..8]);
        DecoyHome = Path.Combine(PrivateRoot, "decoy-home");
        var (accountHome, accountLocal) = AccountFolders();
        homes = Folders(Environment.GetEnvironmentVariable("USERPROFILE"), Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), accountHome, DecoyHome);
        locals = Folders(Environment.GetEnvironmentVariable("LOCALAPPDATA"), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), accountLocal);
        foreach (var variable in Variables)
            if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(variable)))
                Environment.SetEnvironmentVariable(variable, Path.Combine(PrivateRoot, variable.ToLowerInvariant().Replace('_', '-')));
        DurableJson.WritingForTests = OnWrite;
        AppDomain.CurrentDomain.ProcessExit += (_, _) => { try { if (Directory.Exists(PrivateRoot)) Directory.Delete(PrivateRoot, recursive: true); } catch (Exception) { /* best effort */ } };
    }

    /// <summary>The kernel's write hook: a path under the user's profile is refused (and kept) before anything is created.</summary>
    internal static void OnWrite(string path)
    {
        if (ProfileRootOf(path) is not { } root) return;
        refused.Enqueue(path);
        throw new InvalidOperationException("Test isolation: a test wrote " + path + " under the user's profile (" + root + "). Point its root at a temporary folder (the test process names "
            + string.Join(", ", Variables) + ").");
    }

    /// <summary>The root of the user's profile a path is under, or null.</summary>
    internal static string? ProfileRootOf(string path)
    {
        var full = Path.GetFullPath(path);
        foreach (var home in homes)
        {
            if (!Under(full, home, out var relative) || relative == ".") continue;
            var first = relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)[0];
            if (first.StartsWith(".ssam", StringComparison.OrdinalIgnoreCase) || first.Equals(".anvil", StringComparison.OrdinalIgnoreCase)) return Path.Combine(home, first);
        }
        foreach (var local in locals)
            if (Under(full, local, out _) && !Under(full, temp, out _) && !Under(full, Path.Combine(local, "Temp"), out _)) return local;
        return null;
    }

    private static bool Under(string path, string folder, out string relative)
    {
        relative = Path.GetRelativePath(folder, path);
        return relative == "." || !(relative.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(relative));
    }

    /// <summary>The account's own profile and local application data, which no variable of the process moves (the known folders
    /// follow USERPROFILE): the profile list of the machine for the account's SID, and Explorer's expanded Shell Folders.</summary>
    internal static (string? Home, string? Local) AccountFolders()
    {
        if (!OperatingSystem.IsWindows()) return (null, null);
        string? home = null, local = null;
        try {
            var sid = System.Security.Principal.WindowsIdentity.GetCurrent().User?.Value;
            using var profile = sid == null ? null : Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + sid);
            home = profile?.GetValue("ProfileImagePath") as string;
        } catch (Exception) { /* not readable: the variables and the known folders stand */ }
        try {
            using var shell = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders");
            local = shell?.GetValue("Local AppData") as string;
        } catch (Exception) { }
        return (home, local ?? (home == null ? null : Path.Combine(home, "AppData", "Local")));
    }

    private static string[] Folders(params string?[] folders) =>
        folders.Where(f => !string.IsNullOrWhiteSpace(f) && Path.IsPathFullyQualified(f)).Select(f => Path.GetFullPath(f!).TrimEnd('\\', '/'))
            .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
}
