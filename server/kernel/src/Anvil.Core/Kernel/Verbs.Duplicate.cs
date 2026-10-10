using System.Diagnostics;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>
/// Where the paste of a duplicate goes and why the platform would refuse it. The copy itself is the Studio's
/// (IObject.Duplicate = ClipboardManager.Serialize + DeserializeInto, the same native copy and paste); this only picks
/// the destination and names the refusal, because ClipboardManager.CanPasteObjectsInto answers only "Condition is false".
/// The order of the checks is the platform's (ClipboardManager.InnerCanPasteObjectsInto, read in both Studios, and
/// measured on the phase 1 refusals of the tested coverage, 2026-10-03).
/// </summary>
public sealed partial class ModelSession
{
    /// <summary>The platform copies only what can be the root of an import: a source, join, sort or operation of an
    /// aggregate, a connector, a table row or cell, a REST callback and its parameters travel only inside their owner (the
    /// Studio's Copy is off for them) and their clipboard is empty. No destination changes that.</summary>
    private static string? NotCopyable(AbstractObject source)
    {
        if (source.AbstractObjectKind.CanBeRootOfImport(source)) return null;
        AbstractObject? owner = null;
        for (var at = source.GetParent(); at != null && at is not ESpace; at = at.GetParent())
            if (((IObjectSignature)at).GetInterface() != null && at.AbstractObjectKind.CanBeRootOfImport(at)) { owner = at; break; }
        return $"duplicate: {Describe(source)} cannot be copied on its own: the platform copies this kind only inside its owner " +
            "(CanBeRootOfImport is false, the Studio's Copy is off for it), so no parent changes that; " +
            (owner != null ? $"duplicate {Describe(owner)} instead (its copy brings this {ShortType(source)}) or " : "") + $"create another {ShortType(source)}";
    }

    /// <summary>The destination of the paste: the Model API parent, or the author's `parent`. When that object does not
    /// take the kind (ModelExtensions.AcceptsKind), the paste goes into the one native container directly inside it that
    /// does (the Flows.Decision the Model API hides under a process decision, the content placeholder of a container);
    /// without `parent` that container is the source's own native owner.</summary>
    private AbstractObject PasteDestination(AbstractObject source, AbstractObject apiParent, AbstractObject? chosen)
    {
        var kind = source.AbstractObjectKind;
        var parent = chosen ?? apiParent;
        AbstractObject destination;
        if (Takes(parent, kind)) destination = parent;
        else if (chosen == null && source.GetParent() is { } owner && Takes(owner, kind)) destination = owner;
        else
        {
            var inside = parent.DirectChildren.Where(c => Takes(c, kind)).ToList();
            if (inside.Count > 1)
                throw new InvalidOperationException($"duplicate: more than one native container inside {Describe(parent)} takes {ShortType(source)} (" +
                    string.Join(", ", inside.Take(12).Select(Reference)) + "); pass one of them as `parent`");
            if (inside.Count == 1) destination = inside[0];
            else if (chosen == null) destination = apiParent;   // the paste refusal says why
            else throw new InvalidOperationException($"duplicate: {Describe(chosen)} does not take {ShortType(source)} (neither it nor a native " +
                "container directly inside it accepts that kind); a compatible parent is " +
                (apiParent is ESpace ? "the module itself (@espace)" : $"another {ShortType(apiParent)} like {Where(apiParent)}"));
        }
        if (TakenSlot(source, destination) is { } taken)
            throw new InvalidOperationException($"duplicate: {Describe(destination)} keeps only one {ShortType(source)} and already has {Describe(taken)}" +
                (chosen == null ? " (the original)" : "") + $"; pass `parent` with another {ShortType(destination)} that has none yet");
        return destination;
    }

    private static bool Takes(AbstractObject container, AbstractObjectKind kind)
    {
        try { return ServiceStudio.Model.ModelExtensions.AcceptsKind(container, kind); }
        catch (Exception) { return false; }   // a container without collections for this question is not a destination
    }

    /// <summary>A kind its parent keeps only once (the Preparation of a screen or block, the OnException of a UI flow):
    /// the paste fails half-way ("Object should be null") when the destination already has one, so it is refused before.</summary>
    private static AbstractObject? TakenSlot(AbstractObject source, AbstractObject destination)
    {
        try { if (!source.IsSingleton) return null; }
        catch (Exception) { return null; }   // the module itself has no collection
        return destination.DirectChildren.FirstOrDefault(c => c.AbstractObjectKind == source.AbstractObjectKind && c.IsSingleton);
    }

    /// <summary>ClipboardManager.PasteObjectsInto starts with CanPasteObjectsInto(...).MustBeTrue(): that assertion, and only
    /// it, is the platform refusing before it touches the model.</summary>
    private static bool IsPasteRefusal(Exception ex) => new StackTrace(ex, false).GetFrames().Take(2)
        .Any(f => f.GetMethod() is { Name: "PasteObjectsInto" } m && m.DeclaringType?.Name == "ClipboardManager");

    /// <summary>Why CanPasteObjectsInto said no, in the order it checks: the model features the copy carries
    /// (ContainsValidVersion), the destination (CanBePasteTarget, AcceptsKind, IsPasteSupported), then the destination's own
    /// import rule (AllowImportOf: a diagram shows each entity once).</summary>
    private static string PasteRefusal(AbstractObject source, AbstractObject destination)
    {
        var kind = source.AbstractObjectKind;
        var unloadable = UnloadableFeatures(source);
        if (unloadable.Count > 0)
            return $"duplicate: the copy of {Describe(source)} carries model feature(s) this Studio does not load (ModelFeatures.CanBeLoaded is false): " +
                string.Join("; ", unloadable.Select(u => u.Text)) + ", so the platform pastes it nowhere (ClipboardManager.ContainsValidVersion); " +
                (unloadable.All(u => u.ByProperty)
                    ? "clear that property in the original before duplicating it, or create the copy"
                    : $"the kind itself needs that feature: create another {ShortType(source)} instead");
        if (destination.IsReadOnly)
            return $"duplicate: {Describe(destination)} is read-only (it belongs to a referenced module); pass `parent` with an element of this module";
        if (!Takes(destination, kind))
            return $"duplicate: {Describe(destination)} does not take {ShortType(source)}; pass `parent` with a parent that does";
        if (!kind.IsPasteSupported(destination))
            return $"duplicate: the platform does not paste {ShortType(source)} into {Describe(destination)} (the kind's IsPasteSupported is false for it)";
        // An entity diagram takes a pasted node only with its entity's origin in the clipboard (SimpleRecordOrigin, written
        // when an entity is copied) and once per entity: a node copied alone is refused by every diagram.
        return $"duplicate: {Describe(destination)} refuses this {ShortType(source)} by its own import rule (AllowImportOf of {ShortType(destination)})" +
            (ShortType(source) == "IEntityDiagramNode"
                ? "; a diagram takes a pasted node only together with its entity and shows each entity once, so no diagram takes this copy: " +
                  "put the entity on the diagram with create IEntityDiagramNode (args.entity) instead"
                : $"; pass `parent` with another {ShortType(destination)}, or create the {ShortType(source)}");
    }

    /// <summary>The model features the clipboard of this copy would carry (the source and everything inside it) that the
    /// installed Studio cannot load: "Feature (Status) by Element.Property", and whether a property (not the kind) uses it.</summary>
    private static List<(string Text, bool ByProperty)> UnloadableFeatures(AbstractObject source)
    {
        var found = new List<(string Text, bool ByProperty)>();
        var pending = new Stack<AbstractObject>(new[] { source });
        while (pending.Count > 0 && found.Count < 8)
        {
            var at = pending.Pop();
            foreach (var use in global::ServiceStudio.ModelFeatures.ModelFeatures.GetModelFeaturesUsages(at))
                if (use.Feature != null && !global::ServiceStudio.ModelFeatures.ModelFeatures.CanBeLoaded(use.Feature))
                    found.Add(($"{use.Feature.Id} ({use.Feature.Status}) by {Describe(at)}" + (string.IsNullOrEmpty(use.PropertyName) ? "" : "." + use.PropertyName),
                        !string.IsNullOrEmpty(use.PropertyName)));
            foreach (var child in at.DirectChildren) pending.Push(child);
        }
        return found.Distinct().ToList();
    }

    private static string Where(AbstractObject o) => PathOf(o) is { Length: > 0 } path ? path : Describe(o);

    /// <summary>A reference the author can pass back as `parent`: Tipo:Nome when the object has both, its key otherwise.</summary>
    private static string Reference(AbstractObject o) =>
        ((IObjectSignature)o).GetInterface() is { } face && TypeResolver.Name(o) is { Length: > 0 } name ? $"{face.Name}:{name}" : $"@{((IObjectSignature)o).ObjectKey}";
}
