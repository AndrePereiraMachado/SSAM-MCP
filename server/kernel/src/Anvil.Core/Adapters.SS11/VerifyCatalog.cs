namespace Anvil.Core;

// VerifyDefinition lives in Kernel/Adapter/VerifyDefinition.cs since WS0.

/// <summary>Public IDs and embedded resources from the installed IDE. No vendor prose in the repository.</summary>
public static class VerifyCatalog
{
    private static readonly Lazy<IReadOnlyList<VerifyDefinition>> Definitions = new(Extract);
    public static IReadOnlyList<VerifyDefinition> All => Definitions.Value;

    private static IReadOnlyList<VerifyDefinition> Extract()
    {
        string studio;
        try { studio = StudioAssemblies.Directory; }
        catch (InvalidOperationException) { StudioAssemblies.Bind(); studio = StudioAssemblies.Directory; }
        // The reader is shared with ODC (Kernel/VerifyResources.cs); SS11 declares VerifyMessageId in ServiceStudio.Framework.dll.
        return VerifyResources.Extract(Path.Combine(studio, "ServiceStudio.Framework.dll"), StudioAssemblies.IdeVersion);
    }
}
