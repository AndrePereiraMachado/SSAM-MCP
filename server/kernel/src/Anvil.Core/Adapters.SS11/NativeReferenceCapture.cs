using OutSystems.Communication.ServiceCenter;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// SS11 side of the frozen producer signature: captures it from the Service Center's ReferenceInfo and wraps the
/// platform-neutral record as the IModuleSignature the SS11 Model API expects (was inside NativeReferenceSnapshot
/// before WS0; the record itself no longer knows the Studio).
/// </summary>
public static class NativeReferenceCapture
{
    public static NativeReferenceSnapshot Capture(ReferenceInfo info, string environment, IEnumerable<NativeReferenceElement> elements)
        => NativeReferenceSnapshot.Create(Envelope(info, environment, elements, null));

    /// <summary>Attested capture (FormatVersion 2): extension or eSpace, including system producers, with the
    /// server observations the delivery re-checks before merging.</summary>
    public static NativeReferenceSnapshot Capture(ReferenceInfo info, string environment, IEnumerable<NativeReferenceElement> elements,
        NativeReferenceAttestation attestation)
        => NativeReferenceSnapshot.Create(Envelope(info, environment, elements, attestation) with {
            FormatVersion = NativeReferenceSnapshot.AttestedFormatVersion });

    private static NativeReferenceSnapshot Envelope(ReferenceInfo info, string environment, IEnumerable<NativeReferenceElement> elements,
        NativeReferenceAttestation? attestation) => new() {
            Environment=environment, ModuleKey=info.Key, ApplicationKey=info.AppKey ?? "", Name=info.Name,
            ModuleKind=string.Equals(info.Kind,"Extension",StringComparison.OrdinalIgnoreCase)
                ? OutSystems.Model.Enumerations.ReferenceKind.Extension : OutSystems.Model.Enumerations.ReferenceKind.eSpace,
            ModuleType=Enum.TryParse<OutSystems.Model.Enumerations.SegmentationKind>(info.RuntimeKind.ToString(),true,out var kind) ? kind : default,
            Description=info.Description ?? "", Icon=info.Icon?.ToArray() ?? [], JQueryVersion=info.JQueryVersion ?? "",
            ExtensibilityConfigurations=info.ExtensibilityConfiguration ?? "", SignatureHash=info.SignatureHash,
            SignatureBinary=info.SignatureBinary.ToArray(), Elements=elements.ToArray(), Attestation=attestation
        };

    /// <summary>The record seen as the SS11 module signature (same members the record used to implement directly).</summary>
    public sealed class SnapshotSignature(NativeReferenceSnapshot snapshot) : IModuleSignature
    {
        public string ModuleKey => snapshot.ModuleKey;
        public string ApplicationKey => snapshot.ApplicationKey;
        public OutSystems.Model.Enumerations.ReferenceKind ModuleKind => snapshot.ModuleKind;
        public OutSystems.Model.Enumerations.SegmentationKind ModuleType => snapshot.ModuleType;
        public string Name => snapshot.Name;
        public string Description => snapshot.Description;
        public byte[] Icon => snapshot.Icon;
        public string JQueryVersion => snapshot.JQueryVersion;
        public string ExtensibilityConfigurations => snapshot.ExtensibilityConfigurations;
        public string DatabaseName => snapshot.DatabaseName;
        public Guid SignatureHash => snapshot.SignatureHash;
        public byte[] SignatureBinary => snapshot.SignatureBinary;
    }
}
