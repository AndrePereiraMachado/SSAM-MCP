using OutSystems.Model;
using OutSystems.Model.Signatures;
using OutSystems.ModelAPILoader;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>Consumes public signatures; never opens a protected producer as an editable module.</summary>
public static class OdcReferenceImporter
{
    public static Reference Import(ESpace target, NativeReferenceSnapshot snapshot, IReadOnlyList<NativeReferenceElement> elements)
    {
        NativeReferenceSnapshot.Create(snapshot);
        // Version 2 is shared with the attested O11 captures; only the unattested eSpace, ExternalLibrary or AIModelConnection
        // form is an ODC public signature.
        if (!snapshot.IsOdcPublicSignature) throw new NotSupportedException("ODC dependencies require a version 2 public module, External Library or AI model signature; export it with studio reference-snapshot.");
        if (elements.Count == 0) throw new ArgumentException("reference: select at least one public element");
        var key = Keys.Parse(snapshot.ModuleKey);
        if (target.Key.Equals(key)) throw new ArgumentException("A module cannot reference itself");
        var existing = target.References.SingleOrDefault(r => r.ReferenceKey.Equals(key));
        if (existing == null && target.References.Any(r => r.Name.Equals(snapshot.Name, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("Reference name belongs to another producer: " + snapshot.Name);
        if (existing != null && existing.ReferenceHash != snapshot.SignatureHash)
            // fix/system-reference round 2 (M3): the same capture again gives the same signature; only the Studio's refresh of the
            // consumer's reference moves it (JobRunner.ReferenceProblems: REFERENCE_OUTDATED, studio_refresh_references).
            throw new InvalidOperationException(JobRunner.OutdatedReference + "; refresh the consumer's reference to it in the Studio, then deliver again: " + snapshot.Name);

        var modelKey = Loader.ModelServicesInstance.ParseKey(snapshot.ModuleKey);
        var signature = OdcPublicSignature.Read(snapshot.SignatureBinary);
        // Validate selected identities against the actual signature, not only the envelope supplied by the caller.
        var available = signature.Elements.ToDictionary(x => Keys.Parse(x.Key).ToString());
        foreach (var element in elements)
        {
            if (!snapshot.Elements.Contains(element) || !available.TryGetValue(Keys.Parse(element.Key).ToString(), out var native)
                || native.Name != element.Name || native.Kind != element.Kind)
                throw new InvalidOperationException("Selected element does not match the public signature: " + element.Name);
        }
        // An External Library producer is imported as one: the kind the native service reported and its own segmentation,
        // whatever runtime kind the capture carried (the native reference refuses an External Library typed as a module).
        var information = new BinarySignatureInformation { Key = modelKey,
            AppKey = string.IsNullOrWhiteSpace(snapshot.ApplicationKey) ? null : Loader.ModelServicesInstance.ParseKey(snapshot.ApplicationKey),
            Name = existing?.Name ?? snapshot.Name, Description = snapshot.Description,
            ModuleKind = snapshot.IsExternalLibrary ? OutSystems.Model.Enumerations.ReferenceKind.ExternalLibrary : snapshot.ModuleKind,
            ModuleType = snapshot.IsExternalLibrary ? OutSystems.Model.Enumerations.SegmentationKind.ExternalLibrary : snapshot.ModuleType,
            SignatureBinary = snapshot.SignatureBinary, Icon = snapshot.Icon,
            Digest = snapshot.Digest, Revision = snapshot.Revision, Version = snapshot.Version,
            JQueryVersion = snapshot.JQueryVersion, ExtensibilityConfigurations = snapshot.ExtensibilityConfigurations,
            TargetElementKeys = elements.Select(e => Loader.ModelServicesInstance.ParseKey(e.Key)).ToArray() };
        ((IESpace)target).TransactionsManager.ExecuteTransaction("Acquire public producer dependencies", (_, _) => {
            ((IESpace)target).AddDependency(information);
            var imported = target.References.SingleOrDefault(r => r.ReferenceKey.Equals(key))
                ?? throw new InvalidOperationException("Native dependency import did not create the requested producer");
            var originals = ((OutSystems.Model.IObjectSignature)imported).GetAllDescendantsOfType<OutSystems.Model.IObjectSignature>()
                .Select(x => x.GetType().GetProperty("OriginalKey")?.GetValue(x)?.ToString()).ToHashSet();
            if (elements.Any(e => !originals.Contains(Keys.Parse(e.Key).ToString())))
                throw new InvalidOperationException("Native dependency import omitted a selected element");
            // SignatureInformation has no hash field and the native importer leaves ReferenceHash empty.
            // Preserve the revision identity supplied by the authenticated server alongside its imported bytes.
            imported.ReferenceHash = snapshot.SignatureHash;
            return true;
        });
        var result = target.References.SingleOrDefault(r => r.ReferenceKey.Equals(key))
            ?? throw new InvalidOperationException("Native dependency import did not create the requested producer");
        return result;
    }

}
