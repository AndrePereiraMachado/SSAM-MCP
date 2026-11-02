using System.Reflection;

namespace Ssam.Agent;

// Shared private UI resources are shipped with the agent, never downloaded from a caller.
internal static class PrivateHelperResources
{
    internal static string Write(string directory, string resource)
    {
        using var source = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource)
            ?? throw new AgentFault("USERS_PRIVATE_REQUEST_FAILED", "The private helper resource is missing from this agent.");
        using var memory = new MemoryStream();
        source.CopyTo(memory);
        var bytes = memory.ToArray();
        Directory.CreateDirectory(directory);
        var file = Path.Combine(directory, resource);
        if (!File.Exists(file) || !File.ReadAllBytes(file).AsSpan().SequenceEqual(bytes))
        {
            var temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllBytes(temporary, bytes);
            File.Move(temporary, file, true);
        }
        return file;
    }
}
