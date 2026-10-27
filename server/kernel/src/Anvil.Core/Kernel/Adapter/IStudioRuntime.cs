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

    /// <summary>The record mappings a platform keeps beside the expression of an assignment or an argument (O11: the
    /// TypeConversion and its AttributeMappings in ServiceStudio.Framework); null where the mapping is part of the
    /// expression text itself (ODC: "Source mapTo { Field: value }" is what the expression parses).</summary>
    IRecordMappings? Mappings => null;

    /// <summary>Before a module loaded from its OML gives elements to another as a dependency (the reference op): the platform
    /// imports each element through the producer's signature manager, which must know it. ODC Studio 1.7.29 (model 13.1451)
    /// loads a module whose signature manager knows none of its top-level referenceable elements, and the import then fails
    /// inside the platform on the element's key; the ODC lane makes them known, as the platform's own load did, only when an
    /// element it gives is unknown. Nothing on SS11.</summary>
    void PrepareProducer(ESpace producer, IReadOnlyList<object> elements) { }
}

/// <summary>
/// The native record mapping of a value (O11): an assignment "Target = Source" or an argument "Parameter = Source" whose
/// source type is not the target type keeps a TypeConversion with one AttributeMapping per attribute of the target type; each
/// mapping holds the source expression of that attribute, relative to the source record (or item, for a list). The Studio
/// creates the conversion itself as soon as the two types differ (empty: Verify refuses it until one attribute is mapped) and
/// keeps its mappings while the value keeps its type. ssam-flow writes it as "Source mapTo { Field: value, ... }".
/// </summary>
public interface IRecordMappings
{
    /// <summary>Whether the element keeps its mapping beside its Value (an assignment or an argument).</summary>
    bool Owns(object element);

    /// <summary>The mapping the element holds: null without a type conversion; Authored false for the automatic one.</summary>
    Anvil.Reading.NativeMapping? Read(object element);

    /// <summary>Writes the fields over the element's conversion: each named attribute gets its source, every other attribute
    /// of the target is left empty. Null when written; otherwise why it cannot be written now, with nothing written: no
    /// conversion yet (a new assignment before its Variable is set), an attribute the target type does not have (the
    /// Variable is about to change), a value that converts by itself, an attribute named twice. The caller writes it again
    /// once the other side is set, and refuses with this reason when it still cannot.</summary>
    string? Write(object element, IReadOnlyList<(string Field, string Value)> fields);

    /// <summary>The fields the platform writes the same mapping with, when the text's fields copy every attribute of the
    /// target from the same-named attribute of one record of the source item (VisitaCerta 2026-10-12): none (the plain value)
    /// when the conversion is the Studio's automatic one, which has no mapping (a row of one entity narrowed to it);
    /// `Value: Record` when the conversion maps the target element whole and the Studio's own choice is that record (a row
    /// of several entities to one of them). Null: the fields are written as the text has them.</summary>
    IReadOnlyList<(string Field, string Value)>? Equivalent(object element, IReadOnlyList<(string Field, string Value)> fields) => null;
}
