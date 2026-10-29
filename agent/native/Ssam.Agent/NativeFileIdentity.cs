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

    // What file.upload needs of an opened file (UploadKinds.cs): folder or file, its links, its size and its identity.
    internal sealed record Facts(bool Directory, bool Regular, long Links, long Size, string Identity);

    internal static Facts Of(SafeFileHandle handle)
    {
        if (OperatingSystem.IsWindows())
        {
            if (!GetFileInformationByHandle(handle, out var info)) throw new IOException("Cannot read the file identity");
            var directory = (info.Attributes & 0x10) != 0;
            return new(directory, !directory, info.Links, ((long)info.SizeHigh << 32) | info.SizeLow, $"{info.Volume:X8}:{info.IndexHigh:X8}{info.IndexLow:X8}");
        }
        var stat = new byte[256];
        if (FStat(handle, stat) != 0) throw new IOException("Cannot read the file identity");
        return FromStat(stat);
    }

    // The real path of the object a handle has open (Windows: GetFinalPathNameByHandleW, without the \\?\ prefix; a
    // network share comes back as \\server\share\...).
    internal static string FinalPath(SafeFileHandle handle)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("FinalPath is the Windows check; macOS compares identities");
        var buffer = new char[1024];
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Length, 0);
            if (length == 0) throw new IOException("Cannot read the final path of the file");
            if (length < buffer.Length) return Strip(new string(buffer, 0, (int)length));
            buffer = new char[length + 1];
        }
        throw new IOException("Cannot read the final path of the file");
    }

    private static string Strip(string path) => path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase) ? @"\\" + path[8..]
        : path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path[4..] : path;

    // The real path of an existing folder, read through a handle on Windows (junctions, subst and mapped drives resolved);
    // on macOS the link-by-link resolution of MacPlatform.
    internal static string RealDirectory(string folder)
    {
        if (!OperatingSystem.IsWindows()) return MacPlatform.RealPath(folder);
        using var handle = CreateFile(folder, 0x80, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if (handle.IsInvalid) throw new IOException("The folder cannot be opened");
        return FinalPath(handle);
    }

    // The real path of a file or folder by name, through a handle (Windows).
    internal static string FinalPathOf(string file)
    {
        using var handle = CreateFile(file, 0x80, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if (handle.IsInvalid) throw new IOException("The file cannot be opened");
        return FinalPath(handle);
    }

    // The identity of a path by name, the same form as Of() (macOS: stat).
    internal static string IdentityOf(string file)
    {
        if (OperatingSystem.IsWindows())
        {
            using var handle = CreateFile(file, 0x80, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
            if (handle.IsInvalid) throw new IOException("The file cannot be opened");
            return Of(handle).Identity;
        }
        var stat = new byte[256];
        if (Stat(file, stat) != 0) throw new IOException("Cannot read the file identity");
        return FromStat(stat).Identity;
    }

    // struct stat of macOS (64-bit inodes, arm64 and x86_64): st_dev int32 @0, st_mode uint16 @4, st_nlink uint16 @6,
    // st_ino uint64 @8, st_size int64 @96.
    private static Facts FromStat(byte[] stat)
    {
        var mode = BitConverter.ToUInt16(stat, 4) & 0xF000;
        return new(mode == 0x4000, mode == 0x8000, BitConverter.ToUInt16(stat, 6), BitConverter.ToInt64(stat, 96),
            $"{BitConverter.ToInt32(stat, 0):X8}:{BitConverter.ToUInt64(stat, 8):X16}");
    }
    private static int FStat(SafeFileHandle handle, byte[] stat)
    {
        var added = false;
        try
        {
            handle.DangerousAddRef(ref added);
            var fd = (int)handle.DangerousGetHandle();
            return RuntimeInformation.ProcessArchitecture == Architecture.X64 ? FStatX64(fd, stat) : FStatArm64(fd, stat);
        }
        finally { if (added) handle.DangerousRelease(); }
    }
    private static int Stat(string file, byte[] stat) => RuntimeInformation.ProcessArchitecture == Architecture.X64 ? StatX64(file, stat) : StatArm64(file, stat);

    [StructLayout(LayoutKind.Sequential)] private struct FileInformation
    {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation info);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetFinalPathNameByHandleW")]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, [Out] char[] buffer, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateFileW")]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("libc", EntryPoint = "fstat", SetLastError = true)] private static extern int FStatArm64(int fd, [Out] byte[] stat);
    [DllImport("libc", EntryPoint = "fstat$INODE64", SetLastError = true)] private static extern int FStatX64(int fd, [Out] byte[] stat);
    [DllImport("libc", EntryPoint = "stat", SetLastError = true, CharSet = CharSet.Ansi)] private static extern int StatArm64(string file, [Out] byte[] stat);
    [DllImport("libc", EntryPoint = "stat$INODE64", SetLastError = true, CharSet = CharSet.Ansi)] private static extern int StatX64(string file, [Out] byte[] stat);
}
