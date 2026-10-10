using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json.Nodes;

namespace Anvil.Bridge;

/// <summary>The Studio and trusted controller share a local credential outside the app workspace. Copy of the kernel's
/// bridge access (same folder ANVIL_AUTHORITY_DIR, same 64-hex bridge.key, same owner-only ACL, constant-time match), so
/// the thin bridge carries no kernel assembly; the thin tests prove the two equal.</summary>
internal static class Authority
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

    /// <summary>The authority a hook passed to Server.Start (absolute, as the release hook's Start(int, string, string)
    /// does), else DirectoryPath. Given one, neither ANVIL_AUTHORITY_DIR nor LocalAppData is read.</summary>
    public static string ResolveDirectory(string? authorityDir) => string.IsNullOrWhiteSpace(authorityDir) ? DirectoryPath
        : Path.IsPathFullyQualified(authorityDir) ? Path.GetFullPath(authorityDir)
        : throw new InvalidOperationException("authorityDir must be an absolute path to the trusted controller's authority directory");

    public static string KeyPath => Path.Combine(DirectoryPath, "bridge.key");

    public static void Initialize() => Initialize(DirectoryPath);

    public static void Initialize(string directoryPath)
    {
        var keyPath = Path.Combine(directoryPath, "bridge.key");
        if (OperatingSystem.IsWindows())
        {
            var owner = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Cannot identify bridge owner");
            var security = new DirectorySecurity();
            security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            security.SetOwner(owner);
            security.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            var directory = new DirectoryInfo(directoryPath);
            if (!directory.Exists) directory.Create(security);
            else directory.SetAccessControl(security);
        }
        else
        {
            Directory.CreateDirectory(directoryPath);
            File.SetUnixFileMode(directoryPath, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        using var gate = DurableJson.Lease(Path.Combine(directoryPath, "initialize.lock"));
        if (!File.Exists(keyPath)) DurableJson.WriteBytes(keyPath, Encoding.ASCII.GetBytes(Convert.ToHexString(RandomNumberGenerator.GetBytes(32))));
    }

    public static string? ReadCredential() => ReadCredential(DirectoryPath);

    public static string? ReadCredential(string directoryPath)
    {
        var keyPath = Path.Combine(directoryPath, "bridge.key");
        return File.Exists(keyPath) ? File.ReadAllText(keyPath).Trim() : null;
    }

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

/// <summary>Durable, checksummed JSON replacement. Callers hold a file lease for read/modify/write. Copy of the kernel's
/// format (format 1, sha256 of the payload), so an operation journal written by either bridge reads in the other.</summary>
internal static class DurableJson
{
    public static FileStream Lease(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException ex) { throw new InvalidOperationException("Operation is already running; inspect its status instead of starting another: " + Path.GetFileName(path), ex); }
    }

    public static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

    public static JsonObject Read(string path)
    {
        var envelope = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        var payload = envelope["payload"]!.GetValue<string>();
        if (envelope["format"]?.GetValue<int>() != 1 || envelope["sha256"]?.ToString() != Hash(payload))
            throw new InvalidDataException("Task checkpoint is corrupt; execution refused: " + path);
        return JsonNode.Parse(payload)!.AsObject();
    }

    public static void Write(string path, JsonObject value)
    {
        var payload = value.ToJsonString();
        var envelope = new JsonObject { ["format"] = 1, ["sha256"] = Hash(payload), ["payload"] = payload };
        WriteBytes(path, Encoding.UTF8.GetBytes(envelope.ToJsonString()));
    }

    public static void WriteBytes(string path, byte[] bytes)
    {
        path = Path.GetFullPath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            { stream.Write(bytes); stream.Flush(flushToDisk: true); }
            File.Move(temporary, path, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}
