using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>The Studio and trusted controller share a local credential outside the app workspace.</summary>
public static class BridgeAccess
{
    public static string DirectoryPath => ResolveDirectory(Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR") ??
        (OperatingSystem.IsWindows() ? Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR", EnvironmentVariableTarget.User) : null),
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));

    public static string ResolveDirectory(string? configured, string localAppData)
    {
        if (string.IsNullOrWhiteSpace(configured)) return Path.Combine(localAppData, "Anvil", "authority");
        if (!Path.IsPathFullyQualified(configured)) throw new InvalidOperationException("ANVIL_AUTHORITY_DIR must be an absolute path to the trusted controller's authority directory");
        return Path.GetFullPath(configured);
    }
    public static string KeyPath => Path.Combine(DirectoryPath, "bridge.key");

    public static void Initialize()
    {
        if (OperatingSystem.IsWindows())
        {
            var owner = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Cannot identify bridge owner");
            var security = new DirectorySecurity();
            security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            security.SetOwner(owner);
            security.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            var directory = new DirectoryInfo(DirectoryPath);
            if (!directory.Exists) directory.Create(security);
            else directory.SetAccessControl(security);
        }
        else
        {
            Directory.CreateDirectory(DirectoryPath);
            File.SetUnixFileMode(DirectoryPath, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        using var gate = DurableJson.Lease(Path.Combine(DirectoryPath, "initialize.lock"));
        if (!File.Exists(KeyPath)) DurableJson.WriteBytes(KeyPath, Encoding.ASCII.GetBytes(Convert.ToHexString(RandomNumberGenerator.GetBytes(32))));
    }

    public static string? ReadCredential() => File.Exists(KeyPath) ? File.ReadAllText(KeyPath).Trim() : null;

    public static bool Matches(string? supplied, string? expected)
    {
        if (string.IsNullOrEmpty(supplied) || string.IsNullOrEmpty(expected)) return false;
        return CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(supplied)), SHA256.HashData(Encoding.UTF8.GetBytes(expected)));
    }

    public static void Require(JsonObject request, string? credential)
    {
        if (!Matches(request["authorization"]?.GetValue<string>(), credential))
            throw new UnauthorizedAccessException("Bridge operation requires the trusted Hybrid controller");
    }
}
