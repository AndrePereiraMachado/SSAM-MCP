using System.Runtime.InteropServices;
using Refusal = PortalCore.Refusal;

// The vault reader of the portal lane (secretRefs, v32): CredRead of one generic credential of the user's Windows vault,
// inside the Studio process, for a write that names it. PortalCore checks the target (SSAM/ODC3/<session host>/<kind>/
// <name>, never the sign-in entries) before calling this and puts the value straight into the body being sent; the
// value is never logged, stored or answered. The entries are those windows-portal-credential.ps1 writes (password as
// UTF-16 in the blob). Not compiled into studio\bridge\tests, which use a fake reader.
internal static class PortalVault {
    private const uint GenericCredential = 1;
    private const int NotFound = 1168;

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
    [DllImport("advapi32.dll")] private static extern void CredFree(IntPtr credential);
}
