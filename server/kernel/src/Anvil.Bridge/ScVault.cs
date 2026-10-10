using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace Anvil.Bridge;

/// <summary>
/// The Windows vault of the user running the Studio: CredReadW on a generic credential (CRED_TYPE_GENERIC), called inside
/// the Studio process right before a sc_web postback whose secretRefs name it. The blob is the password as UTF-16, as
/// kernel/scripts/service_center/windows-o11-credential.ps1 stores it; UserName is the user name. Nothing here logs or
/// returns a value. The tests never load this file: they use a fake IScVault.
/// </summary>
internal sealed class ScWindowsVault : IScVault
{
    private const uint Generic = 1;
    private const int NotFound = 1168;

    public ScVaultEntry? Read(string target)
    {
        if (!OperatingSystem.IsWindows()) throw Unavailable(target, "Windows Credential Manager is required");
        if (!CredRead(target, Generic, 0, out var pointer))
        {
            var error = Marshal.GetLastWin32Error();
            if (error == NotFound) return null;
            throw Unavailable(target, $"CredReadW error {error}");
        }
        try
        {
            var entry = Marshal.PtrToStructure<Credential>(pointer);
            // A blob that is not UTF-16 text is no password for a form field: reported as missing.
            var password = entry.BlobSize > 0 && entry.BlobSize % 2 == 0 && entry.Blob != IntPtr.Zero
                ? Marshal.PtrToStringUni(entry.Blob, (int)entry.BlobSize / 2) : null;
            return new ScVaultEntry(entry.UserName, password);
        }
        finally { CredFree(pointer); }
    }

    private static ScFailure Unavailable(string target, string why) => new(ScCodes.StudioUnavailable,
        $"the Windows vault could not be read for secretRef target {target} ({why}); nothing was sent",
        details: new JsonObject { ["target"] = target, ["gate"] = "vault_unavailable" });

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
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
