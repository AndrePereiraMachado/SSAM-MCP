using System.Globalization;
using System.Reflection;
using System.Resources;

namespace Anvil.Core;

/// <summary>
/// Reads the public Verify catalog (ids, categories, titles) from the IDE assembly that declares
/// <c>ServiceStudio.Verify.VerifyMessageId</c> and its generated resources. The mechanism is the same on both
/// platforms; only the assembly differs (SS11: ServiceStudio.Framework.dll, ODC: OutSystems.Model.dll), so each
/// adapter passes its own path. No vendor prose is stored in the repository.
/// </summary>
public static class VerifyResources
{
    public static IReadOnlyList<VerifyDefinition> Extract(string assemblyPath, string ideVersion)
    {
        var assembly = Assembly.LoadFrom(assemblyPath);
        var type = assembly.GetType("ServiceStudio.Verify.VerifyMessageId", throwOnError: true)!;
        // ResourcesBaseName is not public in 11.55.73; discover the public manifest instead.
        var resource = assembly.GetManifestResourceNames().Single(n => n.EndsWith("VerifyMessageIdResources.Generated.resources", StringComparison.Ordinal));
        var manager = new ResourceManager(resource[..^".resources".Length], assembly);
        try
        {
            return type.GetFields(BindingFlags.Public | BindingFlags.Static).Where(f => f.FieldType == type).Select(field =>
            {
                var id = (string)type.GetProperty("Id")!.GetValue(field.GetValue(null))!;
                var parts = (manager.GetString(id, CultureInfo.InvariantCulture)
                    ?? throw new InvalidOperationException($"Verify resource missing for {id}")).Split('|');
                if (parts.Length != 13 || parts[0] != id)
                    throw new InvalidOperationException($"Unsupported Verify resource format for {id}; update the adapter for {ideVersion}");
                return new VerifyDefinition(id, parts[1], parts[2], parts[3]);
            }).OrderBy(m => m.Id, StringComparer.Ordinal).ToArray();
        }
        finally { manager.ReleaseAllResources(); }
    }
}
