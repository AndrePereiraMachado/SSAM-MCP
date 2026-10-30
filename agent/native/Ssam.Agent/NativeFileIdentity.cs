using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;

namespace Ssam.Agent;

internal static class NativeFileIdentity
{
    internal static string Read(string file)
    {
        if (!OperatingSystem.IsWindows()) throw new IOException("Downloaded bridge file identities require Windows");
        using var handle = File.OpenHandle(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        if (!GetFileInformationByHandle(handle, out var info)) throw new IOException("Cannot read bridge file identity");
        return $"{info.Volume:X8}:{info.IndexHigh:X8}{info.IndexLow:X8}";
    }
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation
    {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation info);
}
