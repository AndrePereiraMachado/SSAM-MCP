using System.Diagnostics;
using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// The recreation proof of B1 (plan "Texto do SSAM", section 8): a screen or block read by C1 is compiled again by the
/// document form in a copy of the module without it, and must come back the same. In one command on the loaded copy:
/// the original is renamed out of the way; the document compiles a new root with the original's name in the same flow,
/// its actions moved into it before the content (the platform's move, the stand-in for the logic ops of a job: the
/// document names actions, their bodies are logic); every reference to an element of the original (from the moved
/// actions, the other screens, the callers) is repointed to the element of the same k (ReplaceReferences, the Studio's
/// own); the original is deleted. The caller reads the new root again and compares the texts (the keys mapped by k) and
/// the Verify. Never a delivery path: it runs on a disposable copy.
/// </summary>
public sealed partial class ModelSession
{
    public JsonObject RecreateFromReading(ScreenHtmlDocument document)
    {
        JsonObject answer = new();
        StudioAdapter.Runtime.Mutate(_espace, "Anvil: recreate " + document.Root, _ => answer = Recreate(document));
        _byKey = null;
        return answer;
    }

    private JsonObject Recreate(ScreenHtmlDocument document)
    {
        var watch = Stopwatch.StartNew();
        var old = (IObjectSignature)Resolve("@" + document.RootKey);
        var flow = (IObjectSignature)old.Parent!;
        var name = TypeResolver.Name(old)!;
        FindProperty(old, "Name")!.SetValue(old, name + "_B1Original");
        var oldByKey = new Dictionary<string, IObjectSignature>(StringComparer.Ordinal);
        foreach (var o in new[] { old }.Concat(old.GetAllDescendantsOfType<IObjectSignature>()))
            if (o.ObjectKey?.ToString() is { } key) oldByKey.TryAdd(key, o);
        var keys = document.Keys.Where(k => !k.Key.StartsWith("action:", StringComparison.Ordinal) && !k.Key.StartsWith("data-action:", StringComparison.Ordinal))
            .ToDictionary(k => k.Key, k => k.Value, StringComparer.Ordinal);
        var moved = 0;
        // The references the bodies of the actions hold by object (a Refresh Data's aggregate, a destination) into the
        // original: the move brings an expression along as text (it binds again by name in the new root), an object
        // reference out of its reach is lost; each one is written again on the moved node once the new root exists.
        var held = new List<(IObjectSignature Node, System.Reflection.PropertyInfo Property, IObjectSignature Target)>();
        var options = new DocumentOptions
        {
            Flow = flow,
            Exclude = old,
            ReadKeys = keys,
            Opaque = k => keys.TryGetValue(k, out var key) && oldByKey.TryGetValue(key, out var o) ? o : null,
            MoveOpaque = true,
            BeforeContent = root =>
            {
                // The actions of the original, by the platform's move (their consumers follow them).
                foreach (var action in old.Children.OfType<IObjectSignature>().Where(c => Implements(c, "IScreenAction") || Implements(c, "IDataAction")).ToList())
                {
                    foreach (var node in new[] { action }.Concat(action.GetAllDescendantsOfType<IObjectSignature>()))
                        foreach (var property in AllProperties(node).Where(p => p.CanWrite && p.GetIndexParameters().Length == 0 && !p.PropertyType.IsValueType && p.PropertyType != typeof(string)).DistinctBy(p => p.Name))
                        {
                            object? value;
                            try { value = property.GetValue(node); } catch { continue; }
                            if (value is IObjectSignature target && (ReferenceEquals(target, old) || IsInside(target, old)) && !ReferenceEquals(target, action) && !IsInside(target, action))
                                held.Add((node, property, target));
                        }
                    StudioAdapter.Runtime.MoveObject((IObject)action, (IObject)root);
                    moved++;
                }
            },
        };
        JsonObject report;
        try { report = CompileDocument(document.Html, "/html", options); }
        catch (KernelRefusalException refusal)
        {
            return new JsonObject { ["recreated"] = false, ["code"] = refusal.Code, ["message"] = refusal.Message, ["problems"] = refusal.Problems?.DeepClone(), ["ms"] = watch.ElapsedMilliseconds };
        }
        var compileMs = watch.ElapsedMilliseconds;
        // Every element of the original that the document re-created (same k): its consumers outside the original now point
        // at the new one.
        var created = (JsonObject)report["keys"]!;
        var newRoot = (IObjectSignature)Resolve("@" + report["key"]!.ToString());
        var newByKey = new Dictionary<string, IObjectSignature>(StringComparer.Ordinal);
        foreach (var o in new[] { newRoot }.Concat(newRoot.GetAllDescendantsOfType<IObjectSignature>()))
            if (o.ObjectKey?.ToString() is { } key) newByKey.TryAdd(key, o);
        int repointed = 0, unmatched = 0, rewritten = 0;
        var newOf = new Dictionary<string, IObjectSignature>(StringComparer.Ordinal);
        foreach (var (k, oldKey) in keys)
            if (created[k]?.ToString() is { } newKey && newByKey.TryGetValue(newKey, out var now)) newOf[oldKey] = now;
        foreach (var (node, property, target) in held)
        {
            var current = node.WasDeleted ? (node as ServiceStudio.Model.AbstractObject)?.TryGetReplacement() as IObjectSignature : node;
            if (current == null || target.ObjectKey?.ToString() is not { } targetKey || !newOf.TryGetValue(targetKey, out var replacement)) continue;
            try { if (!ReferenceEquals(property.GetValue(current), replacement)) { property.SetValue(current, replacement); rewritten++; } } catch { }
        }
        foreach (var (k, oldKey) in keys)
        {
            if (!oldByKey.TryGetValue(oldKey, out var before) || created[k]?.ToString() is not { } newKey || !newByKey.TryGetValue(newKey, out var after)) { unmatched++; continue; }
            if (before is not ServiceStudio.Model.AbstractObject a || after is not ServiceStudio.Model.AbstractObject b || !a.HasReferers) continue;
            foreach (var referer in a.Referers.ToList())
            {
                if (referer == null || ReferenceEquals(referer, a) || IsInside((IObjectSignature)referer, old)) continue;
                referer.ReplaceReferences(a, b);
                repointed++;
            }
        }
        old.Delete();
        _byKey = null;
        report["recreated"] = true;
        report["actionsMoved"] = moved;
        report["repointed"] = repointed;
        report["rewrittenInActions"] = rewritten;
        report["unmatchedKeys"] = unmatched;
        report["compileMs"] = compileMs;
        report["ms"] = watch.ElapsedMilliseconds;
        return report;
    }
}
