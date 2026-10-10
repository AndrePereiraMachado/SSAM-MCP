using ServiceStudio.Model;
using NR = ServiceStudio.Model.NewRuntime;

namespace Anvil.Core;

/// <summary>Minimal identities on a disposable consumer. The native refresh fills their
/// actual signatures, types, events and content from the attested producer payload.</summary>
internal static class NativeReferenceStubs
{
    public static AbstractObject? Find(Reference reference, NativeReferenceElement element)
    {
        var tag=NativeReferenceKinds.ForKind(element.Kind).Tag;
        var type="ServiceStudio.Model."+tag;
        return Descendants(reference).SingleOrDefault(o => o.GetType().FullName==type
            && ModelHost.Prop(o,"OriginalKey")?.ToString()==Keys.Parse(element.Key).ToString());
    }
    private static IEnumerable<AbstractObject> Descendants(AbstractObject parent)
    {
        foreach(var child in parent.DirectChildren) {
            yield return child;
            foreach(var nested in Descendants(child))yield return nested;
        }
    }
    /// <summary>A25: every new element a signature cannot import (a theme), each as a problem with cause `theme`.
    /// <paramref name="present"/>: whether the consumer already has the element (an existing theme stub stays).</summary>
    public static List<System.Text.Json.Nodes.JsonObject> Themes(NativeReferenceSnapshot snapshot, IReadOnlyList<NativeReferenceElement> elements,
        Func<NativeReferenceElement, bool>? present = null)
        => elements.Where(e => !NativeReferenceKinds.ForKind(e.Kind).SignatureImport && present?.Invoke(e) != true)
            .Select(e => Preflight.ProducerSignatureMissing.Problem(NativeReferenceSnapshot.InterfaceOf(e.Kind) + ":" + e.Name, snapshot.Name, "theme",
                $"A new theme dependency requires the producer OML binding; native signature refresh does not retain an isolated theme stub: {e.Name} of {snapshot.Name}",
                $"bind the producer OML of {snapshot.Name} (a producer path or job:<name>) for the theme {e.Name} instead of its signature capture"))
            .ToList();

    public static void Add(Reference reference, NativeReferenceSnapshot snapshot, IReadOnlyList<NativeReferenceElement> elements)
    {
        if (Themes(snapshot, elements, e => Find(reference, e) != null) is { Count: > 0 } themes) throw Preflight.ProducerSignatureMissing.Refusal(snapshot.Name, themes);
        var active=new HashSet<string>(StringComparer.Ordinal);
        AbstractObject Ensure(NativeReferenceElement e) {
            if(Find(reference,e) is { } existing)return existing;
            if(!NativeReferenceKinds.ForKind(e.Kind).SignatureImport)
                throw new NotSupportedException("A new theme dependency requires the producer OML binding; native signature refresh does not retain an isolated theme stub: "+e.Name);
            if(!active.Add(e.Key))throw new ArgumentException("Cyclic producer parent: "+e.Name);
            var parent=e.ParentKey is { } p ? Ensure(snapshot.Elements.Single(x=>Keys.Parse(x.Key).Equals(Keys.Parse(p)))) : reference;
            var k=Keys.Parse(e.Key);
            AbstractObject created=e.Kind switch {
                "action" => new ReferenceAction(reference,e.Name,k),
                "entity" => new ReferenceEntity(reference,e.Name,k,e.Name),
                "structure" => new ReferenceStructure(reference,e.Name,k,e.Name),
                "service-action" => new ReferenceServiceAPIMethod(reference,e.Name,k),
                "client-action" => new ReferenceClientAction(reference,e.Name,k),
                "role" => new ReferenceRole(reference,e.Name,k),
                "image" => new ReferenceImage(reference,e.Name,k,0,0,"","",[]),
                "resource" => new ReferenceResource(reference,e.Name,k,[]),
                "script" => new ReferenceScript(reference,e.Name,k),
                "process" => new ReferenceProcess(reference,e.Name,k),
                "web-theme" => new ReferenceTheme(reference,e.Name,k),
                "mobile-theme" => new NR.ReferenceTheme(reference,e.Name,k),
                "web-flow" => new ReferenceWebFlow(reference,e.Name,k),
                "mobile-flow" => new NR.ReferenceWebFlow(reference,e.Name,k),
                "web-block" => new ReferenceWebBlock((ReferenceWebFlow)parent,e.Name,k),
                "mobile-block" => new NR.ReferenceWebBlock((NR.ReferenceWebFlow)parent,e.Name,k),
                "web-screen" => new ReferenceWebScreen((ReferenceWebFlow)parent,e.Name,k),
                "mobile-screen" => new NR.ReferenceWebScreen((NR.ReferenceWebFlow)parent,e.Name,k),
                _ => throw new ArgumentException("Unsupported producer element kind: "+e.Kind)
            };
            active.Remove(e.Key);
            return created;
        }
        foreach(var element in elements)Ensure(element);
    }
}
