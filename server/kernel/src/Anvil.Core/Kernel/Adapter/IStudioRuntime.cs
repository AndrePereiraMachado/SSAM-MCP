using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>
/// The platform boundary: everything the kernel needs from a Studio installation and nothing more (WS0 inventory,
/// docs/tasks/2026-09-17-ws0-inventario.md). SS11 implements it with the headless prologue, the mock presenter and
/// the Service Center; ODC implements it with the ModelAPILoader and the ODC Studio bridge. Kernel code reaches it
/// only through <see cref="StudioAdapter.Runtime"/>.
/// </summary>
public interface IStudioRuntime
{
    /// <summary>"ss11" or "odc".</summary>
    string Platform { get; }

    /// <summary>Installation directory the process is bound to (was StudioAssemblies.Directory; ModelApiMetadata).</summary>
    string StudioDirectory { get; }

    /// <summary>IDE version the installation reports (was StudioAssemblies.IdeVersion; ProofGenerator).</summary>
    string IdeVersion { get; }

    /// <summary>Binds the process to a Studio installation without copying DLLs (was StudioAssemblies.Bind).</summary>
    void Bind(string? studioDirectory = null);

    /// <summary>Headless prologue, idempotent, one per process (was HeadlessRuntime.Ensure; ModelHost constructor).</summary>
    void Ensure(string workDirectory);

    /// <summary>Loads a module from OML bytes (was ModelHost.Load).</summary>
    ESpace Load(byte[] oml);

    /// <summary>The same load through the Studio's cancellable overload: the worker's base prefetch (BaseModelCache)
    /// gives up when a request needs another base.</summary>
    ESpace Load(byte[] oml, CancellationToken cancellationToken);

    /// <summary>The load parameters that shape a loaded instance besides its bytes (developer id, flags); part of the
    /// base cache key.</summary>
    string LoadProfile { get; }

    /// <summary>Serializes a module to OML bytes (was ModelHost.Save).</summary>
    byte[] Save(ESpace espace);

    /// <summary>Releases a loaded module and the Studio statics that retain it (was ModelHost.Release).</summary>
    Dictionary<string, int> Release(ESpace? espace);

    /// <summary>Runs a mutation inside one native command: all or nothing (was Publisher.Mutate; Verbs, FlowLayout, probes).</summary>
    void Mutate(ESpace espace, string description, Action<ESpace> mutation);

    /// <summary>Imports a frozen producer signature as a reference of the module (was ReferenceRefresher.ImportSnapshot; Verbs).</summary>
    Reference ImportReference(ESpace espace, NativeReferenceSnapshot snapshot, IReadOnlyList<NativeReferenceElement> elements);

    /// <summary>Public Verify message ids of the installed IDE (was VerifyCatalog.All).</summary>
    IReadOnlyList<VerifyDefinition> VerifyDefinitions { get; }

    /// <summary>The platform's own test for a drop (ObjectCloner.CloneAllowed, the check the Studio drag runs): null when
    /// `newParent` does not take `source` as a child; "" when it takes it as it is; otherwise the kind it would convert
    /// `source` into. The cloner lives in another namespace on each platform (move into, Reparent.cs).</summary>
    string? ImportsChild(AbstractObject newParent, AbstractObject source);

    /// <summary>The platform's own reparent (IModelServices.MoveObject, what the Studio drag does): recreates `source`
    /// under `newParent`, rewires its consumers to the recreated object and deletes the original; returns the new object.</summary>
    OutSystems.Model.IObject MoveObject(OutSystems.Model.IObject source, OutSystems.Model.IObject newParent);
}
