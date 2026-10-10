using System.Runtime.InteropServices;

namespace Anvil.Core;

/// <summary>Reads the existing per-host credential privately; never returns secrets to CLI output.</summary>
public static class O11CredentialVault
{
    public static HeadlessCredentials Read(string host)
    {
        host = HeadlessCredentials.HostOnly(host);
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows Credential Manager required");
        if (!CredRead("SSAM/O11/" + host + "/ServiceStudio", 1, 0, out var pointer))
            throw new InvalidOperationException("No stored Service Studio credential for " + host + ". Connect/store credentials through the private credential prompt.");
        try
        {
            var entry = Marshal.PtrToStructure<Credential>(pointer);
            return new HeadlessCredentials { Host = host, Username = entry.UserName,
                Password = Marshal.PtrToStringUni(entry.Blob, (int)entry.BlobSize / 2) ?? "" };
        }
        finally { CredFree(pointer); }
    }
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
