// The bridge can live in an immutable installation. A packaged bridge waits for
// a local agent to bind its data directory before any command can write there.
internal sealed class AgentDataRoot(string initial, bool requiresBinding)
{
    private string root = Path.GetFullPath(initial);
    private bool frozen;
    private bool bound;
    public string Value => root;
    public bool CanWrite => !requiresBinding || bound;

    public string Bind(string requested)
    {
        if (!Path.IsPathFullyQualified(requested) || requested.Any(char.IsWhiteSpace))
            throw new InvalidOperationException("AGENT_ROOT_INVALID: an absolute data path without spaces is required");
        var target = Path.GetFullPath(requested).TrimEnd(Path.DirectorySeparatorChar);
        var parent = Path.GetDirectoryName(target);
        if (Path.GetFileName(target) != "odc" || parent == null || !Directory.Exists(Path.Combine(parent, "private"))
            || !Directory.Exists(Path.Combine(parent, "inbox")) || !Directory.Exists(Path.Combine(target, "snapshots"))
            || !Directory.Exists(Path.Combine(target, "journal")) || !Directory.Exists(Path.Combine(target, "lab")))
            throw new InvalidOperationException("AGENT_ROOT_INVALID: the agent must prepare its data layout first");
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        if (frozen && !root.Equals(target, comparison))
            throw new InvalidOperationException("AGENT_ROOT_LOCKED: this bridge is already bound to another data directory");
        root = target; bound = true; frozen = true;
        return root;
    }

    public void Use()
    {
        if (!CanWrite) throw new InvalidOperationException("AGENT_ROOT_REQUIRED: bind the packaged bridge data directory first");
        frozen = true;
        Directory.CreateDirectory(Path.Combine(root, "snapshots"));
    }
}
