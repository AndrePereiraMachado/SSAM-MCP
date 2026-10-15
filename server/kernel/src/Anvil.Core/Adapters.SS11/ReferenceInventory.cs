using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using ServiceStudio.Model;
using ServiceStudio.Model.Interfaces;

namespace Anvil.Core.Delivery;

/// <summary>
/// Family E (fam-deps): the producer references of an OML as ReferenceClosure reads them, one entry per reference: label,
/// producer key, kind, ReferenceHash and the exports (top-level reference elements: name, native type, original key in the
/// Studio's canonical form). Read-only, on a disposable load. SS11 only (Adapters.SS11, not compiled in Anvil.Core.Odc):
/// Delivery finds it by name, as it finds SignaturePreview, so the shared delivery code has no compile-time dependency on
/// the O11 model.
/// </summary>
public static class ReferenceInventory
{
    /// <summary>The references of the OML at <paramref name="omlPath"/> (ReferenceClosure.ToJson shape), loaded with a model
    /// host in <paramref name="workDirectory"/>; throws when it does not load.</summary>
    public static JsonArray Read(string omlPath, string workDirectory)
    {
        try { return ReadCore(omlPath, workDirectory); }
        catch (Exception ex) when (ex is FileLoadException or TypeLoadException or TypeInitializationException or MissingMethodException)
        { throw new InvalidOperationException("the Studio model runtime is not available here: " + ex.Message, ex); }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static JsonArray ReadCore(string omlPath, string workDirectory)
    {
        var host = new ModelHost(Path.Combine(workDirectory, "reference-inventory"));
        var espace = host.Load(File.ReadAllBytes(omlPath));
        try
        {
            var list = new List<ModuleReferenceEntry>();
            foreach (var reference in espace.References)
            {
                var exports = new List<ReferencedExport>();
                foreach (var export in Exports(reference))
                {
                    var key = ModelHost.Prop(export, "OriginalKey")?.ToString() ?? "";
                    exports.Add(new ReferencedExport(ModelHost.Prop(export, "Name")?.ToString() ?? "", export.GetType().Name, key));
                }
                list.Add(new ModuleReferenceEntry(reference.Name, reference.ReferenceKey?.ToString() ?? "", reference.ReferenceKind.ToString(),
                    reference.ReferenceHash.ToString(), exports));
            }
            return ReferenceClosure.ToJson(list);
        }
        finally { ModelHost.Release(espace); }
    }

    private static IEnumerable<AbstractObject> Exports(AbstractObject root)
    {
        foreach (var child in root.DirectChildren)
        {
            if (child is ITopLevelReferenceElement) yield return child;
            foreach (var nested in Exports(child)) yield return nested;
        }
    }
}
