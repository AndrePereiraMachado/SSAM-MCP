namespace Ssam.Agent;

// FileShare.Read excludes write and delete handles, including replacement while a Studio loads dependencies.
internal sealed class BridgeFileLease : IDisposable
{
    private readonly List<FileStream> handles = [];
    internal static BridgeFileLease Acquire(string root, string directory)
    {
        root = Path.GetFullPath(root); directory = Path.GetFullPath(directory);
        var allowed = Path.Combine(root, "private", "bridge-loads") + Path.DirectorySeparatorChar;
        if (!directory.StartsWith(allowed, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            throw new IOException("Bridge snapshot is outside the private load directory");
        var lease = new BridgeFileLease();
        try
        {
            void Check(string file) { if (File.GetAttributes(file).HasFlag(FileAttributes.ReparsePoint)) throw new IOException("Bridge snapshot cannot contain links"); }
            var at = root;
            foreach (var part in Path.GetRelativePath(root, directory).Split(Path.DirectorySeparatorChar)) { at = Path.Combine(at, part); Check(at); }
            void Walk(string folder)
            {
                foreach (var file in Directory.EnumerateFileSystemEntries(folder))
                {
                    Check(file);
                    if (Directory.Exists(file)) Walk(file);
                    else lease.handles.Add(new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read));
                }
            }
            Walk(directory); return lease;
        }
        catch { lease.Dispose(); throw; }
    }
    public void Dispose() { foreach (var handle in handles) handle.Dispose(); handles.Clear(); }
}

internal sealed class BridgeLease(InstalledBridge bridge, BridgeFileLease files, Action? released = null) : IDisposable
{
    internal InstalledBridge Bridge { get; } = bridge;
    internal bool PreserveDirectory { get; set; }
    private bool disposed;
    public void Dispose() { if (disposed) return; disposed = true; files.Dispose(); released?.Invoke(); }
}
