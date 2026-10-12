using System.Runtime.InteropServices;
using Refusal = PortalCore.Refusal;

// The vault reader of the portal lane (secretRefs, v32): CredRead of one generic credential of the user's Windows vault,
// inside the Studio process, for a write that names it. PortalCore checks the target (SSAM/ODC3/<session host>/<kind>/
// <name>, never the sign-in entries) before calling this and puts the value straight into the body being sent; the
// value is never logged, stored or answered. The entries are those windows-portal-credential.ps1 writes (password as
// UTF-16 in the blob). HTTP tests use a fake reader; the isolated Windows fixture
// test exercises write/read/delete without touching tenant sign-in entries.
internal static class PortalVault {
    private const uint GenericCredential = 1;
    private const int NotFound = 1168;
    private static bool IsApiClientFixture(string target) => System.Text.RegularExpressions.Regex.IsMatch(target,
        @"^SSAM/ODC3/[A-Za-z0-9.\-]+/APIClientFixture/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$");

    // New per-operation fixtures only; never overwrite the tenant's APIClient
    // login or any credential selected by the user.
    public static bool StoreNewApiClient(string target, string clientId, string secret) {
        if (!OperatingSystem.IsWindows() || !IsApiClientFixture(target)
            || string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(secret) || secret.Length > 512)
            return false;
        if (Read(target) != null) return false;
        var pointer = Marshal.StringToCoTaskMemUni(secret);
        try {
            var entry = new Credential { Type=GenericCredential, TargetName=target, UserName=clientId,
                Comment="SSAM own API Client fixture", Blob=pointer, BlobSize=(uint)System.Text.Encoding.Unicode.GetByteCount(secret), Persist=2 };
            if (!CredWrite(ref entry,0)) return false;
            var current=Read(target);
            return current?.UserName == clientId && current.Secret == secret;
        } finally { Marshal.ZeroFreeCoTaskMemUnicode(pointer); }
    }
    // Internal fixture cleanup; not a command and never accepts sign-in entries.
    // Remote-client cleanup must be verified before production callers use it.
    internal static bool DeleteApiClientFixture(string target) {
        if (!OperatingSystem.IsWindows() || !IsApiClientFixture(target)) return false;
        if (!CredDelete(target,GenericCredential,0) && Marshal.GetLastWin32Error() != NotFound) return false;
        return Read(target) == null;
    }

    public static PortalCore.VaultEntry? Read(string target) {
        if (!OperatingSystem.IsWindows()) throw new Refusal("BAD_REQUEST", "secretRefs need the Windows vault; nothing was sent.", "secret_ref_vault");
        if (!CredRead(target, GenericCredential, 0, out var pointer)) {
            var error = Marshal.GetLastWin32Error();
            if (error == NotFound) return null;
            throw new Refusal("BAD_REQUEST", "The Windows vault could not be read inside the Studio (Win32 error " + error + "); nothing was sent.", "secret_ref_vault");
        }
        try {
            var entry = Marshal.PtrToStructure<Credential>(pointer);
            var secret = entry.BlobSize == 0 || entry.Blob == IntPtr.Zero ? null : Marshal.PtrToStringUni(entry.Blob, (int)entry.BlobSize / 2);
            return new PortalCore.VaultEntry(entry.UserName, secret);
        } finally { CredFree(pointer); }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
        public uint Flags, Type;
        public string TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint BlobSize;
        public IntPtr Blob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref Credential credential, uint flags);
    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, uint type, uint flags);
    [DllImport("advapi32.dll")] private static extern void CredFree(IntPtr credential);
}
