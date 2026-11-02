using System.Text.Json.Nodes;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>
/// F1c A2 (owner 2026-11-02, "o ssam deve permitir que o usuario programe junto com ele"): the new TrueChange errors after a
/// merge, each attributed to its element. The person keeps programming in the Studio while a delivery runs; an expression they
/// are typing, or a node they have not connected yet, is an error of their own edit, never of the delivery. Each error is read
/// on the module after the merge (its owner by the message's ObjectKey, then the elements that hold it) and compared, by the
/// identity of MergeContentProof (never a local key alone), with the delivery's base and its candidate:
/// <list type="bullet">
/// <item>delivery: the element, or one that holds it, is one the delivery wrote (a value the candidate holds otherwise than
/// the base, or an element it created), or its
/// owner cannot be read: these refuse as before;</item>
/// <item>outside: the element and every element that holds it are outside what the delivery wrote (the person created or
/// edited it in the Studio after the capture, or it holds a reference the person broke): a note (errorsOutsideDelivery).</item>
/// </list>
/// Pure over the three files; shared by the O11 and ODC kernels (Kernel/**).
/// </summary>
public static class MergeErrorAttribution
{
    public const string Rule = "ssam-merge-errors/2: a new TrueChange error after the merge refuses the delivery when its element, or an element that holds it, is one the delivery wrote (changed against its base, or created), or when its element cannot be read; an error whose element and holders are all outside what the delivery wrote (the person's edit in progress in the Studio, or an element it broke) is a note, never a refusal";
    /// <summary>The errors each class names; the counts are always whole.</summary>
    private const int Named = 10;

    public static JsonObject Attribute(ModelHost host, string candidatePath, string basePath, string livePath, IReadOnlyList<MessageInfo> errors)
    {
        ESpace? candidate = null, basis = null, live = null;
        try
        {
            candidate = host.Load(File.ReadAllBytes(candidatePath));
            basis = host.Load(File.ReadAllBytes(basePath));
            live = host.Load(File.ReadAllBytes(livePath));
            var candidateIds = new Dictionary<IObjectSignature, string>(ReferenceEqualityComparer.Instance);
            var baseIds = new Dictionary<IObjectSignature, string>(ReferenceEqualityComparer.Instance);
            var liveIds = new Dictionary<IObjectSignature, string>(ReferenceEqualityComparer.Instance);
            var liveLabels = new Dictionary<string, string>(StringComparer.Ordinal);
            var candidateValues = MergeContentProof.Read(candidate, null, null, candidateIds);
            var baseValues = MergeContentProof.Read(basis, null, null, baseIds);
            var liveValues = MergeContentProof.Read(live, null, liveLabels, liveIds);
            var written = Changed(baseValues, candidateValues);
            var edited = Changed(baseValues, liveValues);
            var inBase = new HashSet<string>(baseValues.Keys.Where(f => f.Property == "$kind").Select(f => f.Key), StringComparer.Ordinal);
            // An element the job created, by its local key too: the merge keeps the candidate's key for what it adds, so an
            // element whose identity moved in the merge (a position in an ordered slot) is still the delivery's.
            var baseKeys = new HashSet<string>(baseIds.Keys.Select(KeyOf).OfType<string>(), StringComparer.Ordinal);
            var created = new HashSet<string>(candidateIds.Keys.Select(KeyOf).OfType<string>().Where(k => !baseKeys.Contains(k)), StringComparer.Ordinal);
            // The owner of a message, by its key, else by its readable path (ModelHost.PathOf, the one the Verify's messages carry):
            // the owner may be a node the proof does not read (an assignment), whose holders it does.
            var byKey = new Dictionary<string, IObjectSignature>(StringComparer.Ordinal);
            var byPath = new Dictionary<string, List<IObjectSignature>>(StringComparer.Ordinal);
            var pending = new Stack<IObjectSignature>(); pending.Push((IObjectSignature)live);
            var seen = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
            while (pending.TryPop(out var node))
            {
                if (!seen.Add(node)) continue;
                if (KeyOf(node) is { } k) byKey.TryAdd(k, node);
                string? at = null; try { at = ModelHost.PathOf(node); } catch { at = null; }
                if (at != null) { if (!byPath.TryGetValue(at, out var same)) byPath[at] = same = []; same.Add(node); }
                if (node is ServiceStudio.Model.Interfaces.ITopLevelReferenceElement) continue;
                IEnumerable<IObjectSignature> children;
                try { children = node.Children.OfType<IObjectSignature>().ToList(); } catch { continue; }
                foreach (var child in children) pending.Push(child);
            }
            IObjectSignature? OwnerOf(MessageInfo message)
            {
                if (message.OwnerKey is { Length: > 0 } ownerKey && byKey.TryGetValue(ownerKey, out var found)) return found;
                // By path, only when one element answers it (two twins of the same path are no attribution); an owner that is
                // no child of its holder (an assignment) is attributed by the nearest holder its path names.
                for (var p = message.Path; !string.IsNullOrEmpty(p); p = p.LastIndexOf(" / ", StringComparison.Ordinal) is var cut and > 0 ? p[..cut] : null)
                    if (byPath.TryGetValue(p, out var nodes))
                        return nodes.Select(n => KeyOf(n) ?? "").Distinct(StringComparer.Ordinal).Count() == 1 ? nodes[0] : null;
                return null;
            }

            var delivery = new JsonArray(); var outside = new JsonArray(); var outsideKeys = new JsonArray();
            int deliveryTotal = 0, outsideTotal = 0;
            foreach (var message in errors.Where(m => m.IsError))
            {
                string verdict, reason; string? element = null;
                if (OwnerOf(message) is not { } owner)
                { verdict = "delivery"; reason = "element-not-read"; }
                else
                {
                    var chain = new List<(IObjectSignature Node, string Id)>();
                    for (var n = owner; n != null && n is not IESpace; n = n.Parent as IObjectSignature)
                        if (liveIds.TryGetValue(n, out var id) && !IsModule(id)) chain.Add((n, id));
                    element = chain.Count > 0 ? liveLabels.GetValueOrDefault(chain[0].Id) ?? chain[0].Id : null;
                    if (chain.Count == 0) { verdict = "delivery"; reason = "element-not-read"; }
                    else if (chain.Any(c => written.Contains(c.Id) || (KeyOf(c.Node) is { } key && created.Contains(key))))
                    { verdict = "delivery"; reason = "on-an-element-the-delivery-wrote"; }
                    else if (chain.Any(c => edited.Contains(c.Id) || !inBase.Contains(c.Id)))
                    { verdict = "outside"; reason = "on-an-element-edited-in-the-studio"; }
                    // C1 (the Integradora, 2026-11-02): outside what the delivery wrote is a note, also on an element that did not
                    // change itself (an assignment whose variable the person deleted).
                    else { verdict = "outside"; reason = "outside-what-the-delivery-wrote"; }
                }
                var entry = new JsonObject { ["id"] = message.Id, ["path"] = message.Path, ["detail"] = message.Detail, ["element"] = element, ["reason"] = reason };
                if (verdict == "outside")
                {
                    outsideKeys.Add(message.Key);
                    if (outsideTotal++ < Named) outside.Add(entry);
                }
                else if (deliveryTotal++ < Named) delivery.Add(entry);
            }
            return new JsonObject { ["rule"] = Rule, ["delivery"] = new JsonObject { ["total"] = deliveryTotal, ["errors"] = delivery },
                ["outside"] = new JsonObject { ["total"] = outsideTotal, ["errors"] = outside, ["keys"] = outsideKeys } };
        }
        finally { ModelHost.Release(candidate); ModelHost.Release(basis); ModelHost.Release(live); }
    }

    /// <summary>The module itself (its identity holds no element below it): it holds everything, so it attributes nothing.</summary>
    private static bool IsModule(string identity) => identity.StartsWith("module:", StringComparison.Ordinal) && identity.IndexOf('/') < 0;

    private static string? KeyOf(IObjectSignature node) { try { return node.ObjectKey?.ToString(); } catch { return null; } }

    /// <summary>The elements whose own content differs between two reads: a value, its kind, its parent, its expressions.
    /// Collections (ordered:/set:) say that a child came or went, which is the child's own difference, never the holder's;
    /// editor state is no content.</summary>
    private static HashSet<string> Changed(Dictionary<(string Key, string Property), string> before, Dictionary<(string Key, string Property), string> after)
    {
        var changed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var field in before.Keys.Union(after.Keys))
        {
            if (IsModule(field.Key) || changed.Contains(field.Key)) continue;
            if (field.Property.StartsWith("ordered:", StringComparison.Ordinal) || field.Property.StartsWith("set:", StringComparison.Ordinal)) continue;
            if (field.Property.StartsWith("api:", StringComparison.Ordinal) && MergeContentProof.EditorState.Contains(field.Property[4..])) continue;
            var a = before.TryGetValue(field, out var x); var b = after.TryGetValue(field, out var y);
            if (a != b || (a && x!.Replace("\r\n", "\n") != y!.Replace("\r\n", "\n"))) changed.Add(field.Key);
        }
        return changed;
    }
}
